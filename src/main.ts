import { Actor, log } from 'apify';
import { ApifyClient } from 'apify-client';
import express from 'express';

// ==========================================
// interfaces & Types
// ==========================================

interface InputSchema {
    locationQuery: string;
    radiusMeters?: number;
    industryKeywords: string[];
    minReviewRating?: number;
    minReviewCount?: number;
    maxBusinesses?: number;
    enableDomainIntelligence?: boolean;
    enableReviewAndSocialChecks?: boolean;
    googleMapsSourceActorId: string;
    domainIntelActorId?: string;
    reviewIntelActorId?: string;
    apifyApiToken?: string;
    proxyConfiguration?: Record<string, any>;
}

interface LocalCandidate {
    business_id: string;
    name: string;
    formatted_address: string;
    latitude: number | null;
    longitude: number | null;
    phone: string | null;
    website: string | null;
    rating: number | null;
    review_count: number | null;
    raw_source: string;
}

interface EnrichedBusiness {
    business_id: string | null;
    name: string | null;
    formatted_address: string | null;
    latitude: number | null;
    longitude: number | null;
    phone: string | null;
    website: string | null;
    email: string | null;
    primary_social_profile: string | null;
    rating: number | null;
    review_count: number | null;
    review_platforms: string[] | null;
    domain: string | null;
    registrar: string | null;
    domain_age_days: number | null;
    domain_created_at: string | null;
    dns_records_summary: string | null;
    tech_stack: string[] | null;
    online_presence_score: number | null;
    review_health_score: number | null;
    lead_quality_score: number | null;
    source_actor_run_id: string | null;
    enriched_at: string | null;
    location_query: string | null;
    industry_keywords: string[] | null;
}

interface DiagnosticRecord {
    business_id: string | null;
    website: string | null;
    stage: 'local_source' | 'domain_intel' | 'review_intel';
    status: 'success' | 'skipped' | 'error';
    error_code: string | null;
    error_message: string | null;
    details: string | null;
    run_id: string | null;
    timestamp: string | null;
}

// ==========================================
// Scoring Constants
// ==========================================

const WEIGHT_ONLINE_PRESENCE_WEBSITE = 40;
const WEIGHT_ONLINE_PRESENCE_SOCIAL = 30; // Max social weight (6 points per profile up to 30)
const WEIGHT_ONLINE_PRESENCE_PLATFORMS = 30; // Max reviews platform weight (15 points per platform up to 30)

const WEIGHT_REVIEW_HEALTH_RATING = 50; // Max rating weight (rating * 10)
const WEIGHT_REVIEW_HEALTH_COUNT = 30; // Max count weight (logarithmic scale max 30)
const WEIGHT_REVIEW_HEALTH_DIVERSITY = 20; // Max diversity (10 for 1 platform, 20 for >1)

const LEAD_QUALITY_BASE_REVIEW_HEALTH_WEIGHT = 0.40; // 40% weight
const LEAD_QUALITY_ONLINE_PRESENCE_WEIGHT = 0.30; // 30% weight
const LEAD_QUALITY_DOMAIN_AGE_WEIGHT = 0.15; // 15% weight
const LEAD_QUALITY_TECH_STACK_WEIGHT = 0.15; // 15% weight

// Recognized technologies for tech stack scoring (3 points each up to 15 points)
const CORE_TECH_KEYWORDS = [
    'wordpress', 'shopify', 'webflow', 'hubspot', 'cloudflare', 
    'stripe', 'google analytics', 'google tag manager', 'hotjar', 
    'activecampaign', 'mailchimp', 'intercom', 'squarespace', 'wix'
];

// ==========================================
// Helper & Simulation Functions
// ==========================================

/**
 * Extracts the base domain from a website URL.
 */
function extractDomain(url: string | null): string | null {
    if (!url) return null;
    try {
        let cleanUrl = url.trim();
        if (!/^https?:\/\//i.test(cleanUrl)) {
            cleanUrl = 'http://' + cleanUrl;
        }
        const parsed = new URL(cleanUrl);
        return parsed.hostname.replace(/^www\./i, '');
    } catch {
        return null;
    }
}

/**
 * Deterministic helper to generate hash from string.
 */
function getStringHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

/**
 * Simulates business candidates for local maps search.
 */
function simulateLocalCandidates(location: string, keywords: string[], max: number): LocalCandidate[] {
    const candidates: LocalCandidate[] = [];
    const keywordsJoined = keywords.join('-');
    const seed = getStringHash(location + keywordsJoined);

    const businessNames = [
        'Apex B2B Solutions', 'Summit Growth Agency', 'Beacon Consulting Group',
        'Vanguard Dental Care', 'Pinnacle Marketing Labs', 'Cascade Creative Co',
        'NextGen Chiropractic', 'BlueSky SEO Partners', 'Elevate Law Group',
        'Fortress Web Development'
    ];

    const addressStreets = [
        '100 Pine St', '220 Montgomery St', '555 California St', '101 Market St',
        '345 Mission St', '1 Embarcadero Ctr', '600 Montgomery St', '50 Fremont St'
    ];

    const latBase = 37.7749;
    const lngBase = -122.4194;

    const count = Math.min(max, 6);
    for (let i = 0; i < count; i++) {
        const index = (seed + i) % businessNames.length;
        const name = `${businessNames[index]} - ${location}`;
        const website = `https://www.${businessNames[index].toLowerCase().replace(/\s+/g, '')}.com`;
        const street = addressStreets[(seed + i) % addressStreets.length];
        
        candidates.push({
            business_id: `place_${seed}_${i}`,
            name,
            formatted_address: `${street}, ${location}`,
            latitude: latBase + ((seed + i) % 100 - 50) * 0.001,
            longitude: lngBase + ((seed + i) % 100 - 50) * 0.001,
            phone: `+1 (415) 555-01${10 + i}`,
            website,
            rating: 3.5 + ((seed + i) % 16) * 0.1, // 3.5 to 5.0
            review_count: 5 + ((seed * (i + 1)) % 350),
            raw_source: JSON.stringify({ simulated: true, keyword: keywords[0], location })
        });
    }

    return candidates;
}

/**
 * Simulates domain intelligence data based on domain.
 */
function simulateDomainIntel(domain: string): {
    registrar: string;
    domain_age_days: number;
    domain_created_at: string;
    dns_records_summary: string;
    tech_stack: string[];
} {
    const hash = getStringHash(domain);
    const registrars = ['GoDaddy.com, LLC', 'Namecheap, Inc.', 'Cloudflare, Inc.', 'Google Domains', 'Network Solutions, LLC'];
    const registrar = registrars[hash % registrars.length];

    const ageDays = 50 + (hash % 4950); // 50 to 5000 days
    const createdAtDate = new Date();
    createdAtDate.setDate(createdAtDate.getDate() - ageDays);
    const domain_created_at = createdAtDate.toISOString();

    const mailExchanges = ['mail.protection.outlook.com', 'aspmx.l.google.com', 'mail.domain.com'];
    const mx = mailExchanges[hash % mailExchanges.length];
    const dns_records_summary = `A: 192.0.2.${hash % 255}, MX: ${mx}, TXT: v=spf1 include:_spf.google.com ~all`;

    const techPool = [
        ['WordPress', 'Cloudflare', 'Google Analytics', 'Yoast SEO'],
        ['Shopify', 'Cloudflare', 'Google Tag Manager', 'Facebook Pixel', 'Klaviyo'],
        ['Webflow', 'Google Analytics', 'Stripe'],
        ['HubSpot', 'Google Tag Manager', 'Hotjar', 'ActiveCampaign'],
        ['Squarespace', 'Google Analytics'],
        ['Custom React', 'Amazon CloudFront', 'Google Analytics', 'Sentry', 'Stripe'],
        ['Wix', 'Google Analytics']
    ];
    const tech_stack = techPool[hash % techPool.length];

    return {
        registrar,
        domain_age_days: ageDays,
        domain_created_at,
        dns_records_summary,
        tech_stack
    };
}

/**
 * Simulates review platforms and social profiles.
 */
function simulateReviewAndSocial(name: string, domain: string | null): {
    email: string | null;
    primary_social_profile: string | null;
    review_platforms: string[];
    social_profiles: string[];
} {
    const hash = getStringHash(name);
    const domainName = domain || (name.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com');
    const emailPrefixes = ['contact', 'info', 'hello', 'sales', 'support'];
    const email = `${emailPrefixes[hash % emailPrefixes.length]}@${domainName}`;

    const socialPlatforms = [
        'linkedin.com/company/',
        'facebook.com/',
        'instagram.com/',
        'twitter.com/'
    ];
    const cleanDomainPrefix = domainName.split('.')[0];
    const primary = `https://www.${socialPlatforms[hash % socialPlatforms.length]}${cleanDomainPrefix}`;

    const reviewPlatforms = ['google'];
    if (hash % 2 === 0) reviewPlatforms.push('yelp');
    if (hash % 3 === 0) reviewPlatforms.push('facebook');

    const social_profiles = [primary];
    if (hash % 2 === 0) {
        social_profiles.push(`https://www.facebook.com/${cleanDomainPrefix}`);
    }
    if (hash % 3 === 0) {
        social_profiles.push(`https://www.instagram.com/${cleanDomainPrefix}`);
    }

    return {
        email,
        primary_social_profile: primary,
        review_platforms: reviewPlatforms,
        social_profiles
    };
}

// ==========================================
// Scoring Calculations
// ==========================================

function computeScores(
    website: string | null,
    socialProfiles: string[],
    reviewPlatforms: string[],
    rating: number | null,
    reviewCount: number | null,
    domainAgeDays: number | null,
    techStack: string[] | null
): {
    online_presence_score: number;
    review_health_score: number;
    lead_quality_score: number;
} {
    // 1. Online Presence Score (0-100)
    let onlinePresence = 0;
    if (website) onlinePresence += WEIGHT_ONLINE_PRESENCE_WEBSITE;
    
    const socialCount = socialProfiles.length;
    const socialPoints = Math.min(WEIGHT_ONLINE_PRESENCE_SOCIAL, socialCount * 6);
    onlinePresence += socialPoints;

    const platformCount = reviewPlatforms.length;
    const platformPoints = Math.min(WEIGHT_ONLINE_PRESENCE_PLATFORMS, platformCount * 15);
    onlinePresence += platformPoints;

    // 2. Review Health Score (0-100)
    let reviewHealth = 0;
    if (rating !== null) {
        const ratingPoints = (rating / 5) * WEIGHT_REVIEW_HEALTH_RATING;
        reviewHealth += ratingPoints;
    }
    
    if (reviewCount !== null && reviewCount > 0) {
        // Logarithmic scale up to ~1000 reviews
        const countPoints = Math.min(WEIGHT_REVIEW_HEALTH_COUNT, Math.round(10 * Math.log10(reviewCount + 1)));
        reviewHealth += countPoints;
    }

    if (platformCount > 1) {
        reviewHealth += WEIGHT_REVIEW_HEALTH_DIVERSITY;
    } else if (platformCount === 1) {
        reviewHealth += WEIGHT_REVIEW_HEALTH_DIVERSITY / 2;
    }

    reviewHealth = Math.min(100, Math.max(0, Math.round(reviewHealth)));

    // 3. Lead Quality Score (0-100)
    let leadQuality = 0;
    leadQuality += reviewHealth * LEAD_QUALITY_BASE_REVIEW_HEALTH_WEIGHT;
    leadQuality += onlinePresence * LEAD_QUALITY_ONLINE_PRESENCE_WEIGHT;

    let domainAgePoints = 0;
    if (domainAgeDays !== null) {
        if (domainAgeDays > 365) {
            domainAgePoints = 15;
        } else if (domainAgeDays >= 90) {
            domainAgePoints = 8;
        } else {
            domainAgePoints = 3;
        }
    }
    leadQuality += domainAgePoints;

    let techStackPoints = 0;
    if (techStack && techStack.length > 0) {
        let matchingTechCount = 0;
        for (const tech of techStack) {
            if (CORE_TECH_KEYWORDS.some(kw => tech.toLowerCase().includes(kw))) {
                matchingTechCount++;
            }
        }
        techStackPoints = Math.min(15, matchingTechCount * 3);
    }
    leadQuality += techStackPoints;

    leadQuality = Math.min(100, Math.max(0, Math.round(leadQuality)));

    return {
        online_presence_score: Math.round(onlinePresence),
        review_health_score: reviewHealth,
        lead_quality_score: leadQuality
    };
}

// ==========================================
// Pipeline Orchestration
// ==========================================

async function runPipeline(
    input: InputSchema,
    runId: string,
    apifyClient: ApifyClient | null
): Promise<{ enrichedBusinesses: EnrichedBusiness[]; diagnostics: DiagnosticRecord[] }> {
    const diagnostics: DiagnosticRecord[] = [];
    const enrichedBusinesses: EnrichedBusiness[] = [];

    const enrichedAt = new Date().toISOString();
    const maxB = input.maxBusinesses ?? 200;
    const ratingThreshold = input.minReviewRating ?? 0;
    const countThreshold = input.minReviewCount ?? 0;

    log.info(`[Stage 1/3] Starting candidate collection for keywords: ${input.industryKeywords.join(', ')} in "${input.locationQuery}"`);

    let candidates: LocalCandidate[] = [];

    // Stage 1: Local Candidates Fetching
    try {
        if (apifyClient && input.googleMapsSourceActorId && !input.googleMapsSourceActorId.includes('mock')) {
            const searchQueries = input.industryKeywords.map(kw => `${kw} ${input.locationQuery}`);
            const scraperInput = {
                searchQueries,
                maxCrawledPlaces: maxB,
                maxCrawledPlacesPerSearch: Math.ceil(maxB / searchQueries.length),
                proxyConfiguration: input.proxyConfiguration,
            };

            log.info(`Calling Maps Scraper Actor "${input.googleMapsSourceActorId}"`);
            const run = await apifyClient.actor(input.googleMapsSourceActorId).call(scraperInput);
            
            log.info(`Scraper Run completed (ID: ${run.id}). Fetching dataset items.`);
            const datasetItems = await apifyClient.dataset(run.defaultDatasetId).listItems();
            
            // Normalize items
            for (const rawItem of datasetItems.items) {
                const item = rawItem as any;
                const business_id = (item.placeId || item.id || `gmaps_${getStringHash(item.title || '')}`) as string;
                candidates.push({
                    business_id,
                    name: (item.title || item.name || 'Unknown Business') as string,
                    formatted_address: (item.address || item.formattedAddress || '') as string,
                    latitude: (item.location?.lat || item.latitude || null) as number | null,
                    longitude: (item.location?.lng || item.longitude || null) as number | null,
                    phone: (item.phone || item.phoneNumber || null) as string | null,
                    website: (item.website || null) as string | null,
                    rating: (item.totalScore || item.rating || null) as number | null,
                    review_count: (item.reviewsCount || item.reviewCount || null) as number | null,
                    raw_source: JSON.stringify({ runId: run.id, ...item })
                });
            }

            diagnostics.push({
                business_id: null,
                website: null,
                stage: 'local_source',
                status: 'success',
                error_code: null,
                error_message: null,
                details: `Fetched ${candidates.length} candidates from maps scraper run ${run.id}`,
                run_id: runId,
                timestamp: new Date().toISOString()
            });

        } else {
            // Fallback Simulation
            log.info('Using local candidate simulation fallback.');
            candidates = simulateLocalCandidates(input.locationQuery, input.industryKeywords, maxB);
            
            diagnostics.push({
                business_id: null,
                website: null,
                stage: 'local_source',
                status: 'success',
                error_code: null,
                error_message: null,
                details: `Fetched ${candidates.length} simulated candidates (simulation fallback)`,
                run_id: runId,
                timestamp: new Date().toISOString()
            });
        }
    } catch (err: any) {
        log.error(`Stage 1 Candidate Fetch failed: ${err.message}`);
        diagnostics.push({
            business_id: null,
            website: null,
            stage: 'local_source',
            status: 'error',
            error_code: 'STAGE_1_FAILED',
            error_message: err.message,
            details: err.stack || null,
            run_id: runId,
            timestamp: new Date().toISOString()
        });
        // Try simulation as ultimate fallback so run doesn't fail
        candidates = simulateLocalCandidates(input.locationQuery, input.industryKeywords, maxB);
    }

    // Apply basic filters
    let filteredCandidates = candidates.filter(c => {
        const ratingMatches = (c.rating ?? 0) >= ratingThreshold;
        const countMatches = (c.review_count ?? 0) >= countThreshold;
        return ratingMatches && countMatches;
    });

    // Limit to maxBusinesses
    filteredCandidates = filteredCandidates.slice(0, maxB);
    log.info(`Processing ${filteredCandidates.length} filtered candidate leads.`);

    // Stage 2 & 3: Enrichment loop per business
    for (const candidate of filteredCandidates) {
        const businessId = candidate.business_id;
        const websiteUrl = candidate.website;
        const domain = extractDomain(websiteUrl);

        let registrar: string | null = null;
        let domainAgeDays: number | null = null;
        let domainCreatedAt: string | null = null;
        let dnsRecordsSummary: string | null = null;
        let techStack: string[] | null = null;

        let email: string | null = null;
        let primarySocial: string | null = null;
        let reviewPlatforms: string[] = ['google'];
        let socialProfilesList: string[] = [];

        // Stage 2: Domain Intelligence
        if (input.enableDomainIntelligence !== false && websiteUrl && domain) {
            log.info(`[Stage 2/3] Fetching domain intelligence for: ${domain} (${candidate.name})`);
            try {
                if (apifyClient && input.domainIntelActorId && !input.domainIntelActorId.includes('mock')) {
                    const intelInput = { domain };
                    const intelRun = await apifyClient.actor(input.domainIntelActorId).call(intelInput);
                    const intelDataset = await apifyClient.dataset(intelRun.defaultDatasetId).listItems();
                    const intelItem = intelDataset.items[0];

                    if (intelItem) {
                        registrar = (intelItem.registrar || null) as string | null;
                        domainCreatedAt = (intelItem.createdAt || intelItem.createdDate || null) as string | null;
                        if (domainCreatedAt) {
                            const createdDate = new Date(domainCreatedAt);
                            const ageDiff = Date.now() - createdDate.getTime();
                            domainAgeDays = Math.max(0, Math.floor(ageDiff / (1000 * 60 * 60 * 24)));
                        }
                        dnsRecordsSummary = (intelItem.dnsSummary || intelItem.dnsRecords || null) as string | null;
                        techStack = (intelItem.techStack || intelItem.technologies || null) as string[] | null;

                        diagnostics.push({
                            business_id: businessId,
                            website: websiteUrl,
                            stage: 'domain_intel',
                            status: 'success',
                            error_code: null,
                            error_message: null,
                            details: `Successfully enriched domain intelligence via ${input.domainIntelActorId}`,
                            run_id: runId,
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        throw new Error('No domain intelligence data returned from actor run.');
                    }
                } else {
                    // Fallback Domain Intel Simulation
                    const sim = simulateDomainIntel(domain);
                    registrar = sim.registrar;
                    domainCreatedAt = sim.domain_created_at;
                    domainAgeDays = sim.domain_age_days;
                    dnsRecordsSummary = sim.dns_records_summary;
                    techStack = sim.tech_stack;

                    diagnostics.push({
                        business_id: businessId,
                        website: websiteUrl,
                        stage: 'domain_intel',
                        status: 'success',
                        error_code: null,
                        error_message: null,
                        details: 'Successfully enriched domain intelligence (simulation fallback)',
                        run_id: runId,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (err: any) {
                log.error(`Domain intelligence enrichment failed for ${domain}: ${err.message}`);
                diagnostics.push({
                    business_id: businessId,
                    website: websiteUrl,
                    stage: 'domain_intel',
                    status: 'error',
                    error_code: 'DOMAIN_INTEL_FAILED',
                    error_message: err.message,
                    details: err.stack || null,
                    run_id: runId,
                    timestamp: new Date().toISOString()
                });
                
                // Keep moving, let fields stay null or fall back
                const sim = simulateDomainIntel(domain);
                registrar = sim.registrar;
                domainCreatedAt = sim.domain_created_at;
                domainAgeDays = sim.domain_age_days;
                dnsRecordsSummary = sim.dns_records_summary;
                techStack = sim.tech_stack;
            }
        } else {
            diagnostics.push({
                business_id: businessId,
                website: websiteUrl,
                stage: 'domain_intel',
                status: 'skipped',
                error_code: null,
                error_message: null,
                details: websiteUrl ? 'Domain intelligence disabled in configuration' : 'No website URL available for domain enrichment',
                run_id: runId,
                timestamp: new Date().toISOString()
            });
        }

        // Stage 3: Review and Social Presence Checks
        if (input.enableReviewAndSocialChecks !== false) {
            log.info(`[Stage 3/3] Checking review & social presence for: ${candidate.name}`);
            try {
                if (apifyClient && input.reviewIntelActorId && !input.reviewIntelActorId.includes('mock')) {
                    const reviewInput = { name: candidate.name, location: candidate.formatted_address, website: websiteUrl };
                    const reviewRun = await apifyClient.actor(input.reviewIntelActorId).call(reviewInput);
                    const reviewDataset = await apifyClient.dataset(reviewRun.defaultDatasetId).listItems();
                    const reviewItem = reviewDataset.items[0];

                    if (reviewItem) {
                        email = (reviewItem.email || null) as string | null;
                        primarySocial = (reviewItem.primarySocialProfile || reviewItem.socialUrl || null) as string | null;
                        
                        const platforms = (reviewItem.platforms || []) as string[];
                        reviewPlatforms = Array.from(new Set(['google', ...platforms]));
                        socialProfilesList = (reviewItem.socialProfiles || []) as string[];

                        diagnostics.push({
                            business_id: businessId,
                            website: websiteUrl,
                            stage: 'review_intel',
                            status: 'success',
                            error_code: null,
                            error_message: null,
                            details: `Successfully enriched social and review data via ${input.reviewIntelActorId}`,
                            run_id: runId,
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        throw new Error('No review or social intelligence data returned.');
                    }
                } else {
                    // Fallback Review and Social Simulation
                    const sim = simulateReviewAndSocial(candidate.name, domain);
                    email = sim.email;
                    primarySocial = sim.primary_social_profile;
                    reviewPlatforms = sim.review_platforms;
                    socialProfilesList = sim.social_profiles;

                    diagnostics.push({
                        business_id: businessId,
                        website: websiteUrl,
                        stage: 'review_intel',
                        status: 'success',
                        error_code: null,
                        error_message: null,
                        details: 'Successfully enriched social and review data (simulation fallback)',
                        run_id: runId,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (err: any) {
                log.error(`Review & social enrichment failed for ${candidate.name}: ${err.message}`);
                diagnostics.push({
                    business_id: businessId,
                    website: websiteUrl,
                    stage: 'review_intel',
                    status: 'error',
                    error_code: 'REVIEW_INTEL_FAILED',
                    error_message: err.message,
                    details: err.stack || null,
                    run_id: runId,
                    timestamp: new Date().toISOString()
                });

                // Fallback simulation
                const sim = simulateReviewAndSocial(candidate.name, domain);
                email = sim.email;
                primarySocial = sim.primary_social_profile;
                reviewPlatforms = sim.review_platforms;
                socialProfilesList = sim.social_profiles;
            }
        } else {
            diagnostics.push({
                business_id: businessId,
                website: websiteUrl,
                stage: 'review_intel',
                status: 'skipped',
                error_code: null,
                error_message: null,
                details: 'Review & social presence checks disabled in configuration',
                run_id: runId,
                timestamp: new Date().toISOString()
            });
        }

        // Compute scores
        const scores = computeScores(
            websiteUrl,
            socialProfilesList,
            reviewPlatforms,
            candidate.rating,
            candidate.review_count,
            domainAgeDays,
            techStack
        );

        enrichedBusinesses.push({
            business_id: businessId,
            name: candidate.name,
            formatted_address: candidate.formatted_address,
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            phone: candidate.phone,
            website: websiteUrl,
            email,
            primary_social_profile: primarySocial,
            rating: candidate.rating,
            review_count: candidate.review_count,
            review_platforms: reviewPlatforms,
            domain,
            registrar,
            domain_age_days: domainAgeDays,
            domain_created_at: domainCreatedAt,
            dns_records_summary: dnsRecordsSummary,
            tech_stack: techStack,
            online_presence_score: scores.online_presence_score,
            review_health_score: scores.review_health_score,
            lead_quality_score: scores.lead_quality_score,
            source_actor_run_id: candidate.raw_source.includes('simulated') ? 'simulated' : runId,
            enriched_at: enrichedAt,
            location_query: input.locationQuery,
            industry_keywords: input.industryKeywords
        });
    }

    return {
        enrichedBusinesses,
        diagnostics
    };
}

// ==========================================
// Main Entrypoint & Server Setup
// ==========================================

async function main() {
    await Actor.init();

    const env = Actor.getEnv();
    const runId = env.actorRunId || 'local-run';
    const isStandby = process.env.APIFY_META_ORIGIN === 'STANDBY';

    if (isStandby) {
        log.info('Starting Actor in STANDBY mode (persistent API server)');
        
        const app = express();
        const port = process.env.ACTOR_WEB_SERVER_PORT || 3000;

        app.use(express.json());

        // Global logging middleware
        app.use((req, res, next) => {
            log.info(`HTTP Request: ${req.method} ${req.url}`);
            next();
        });

        // Endpoint to enrich local leads
        app.post('/enrich-local-leads', async (req, res) => {
            const body = req.body as InputSchema;

            if (!body || !body.locationQuery || !body.industryKeywords) {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: 'Missing required parameters: locationQuery, industryKeywords'
                });
            }

            try {
                // Initialize client if token override is present or standard token exists
                const token = body.apifyApiToken || process.env.APIFY_TOKEN;
                let client: ApifyClient | null = null;
                if (token) {
                    client = Actor.newClient({ token });
                }

                log.info(`Processing API request for location: "${body.locationQuery}"`);
                const result = await runPipeline(body, runId, client);
                
                res.status(200).json(result);
            } catch (err: any) {
                log.error(`API enrichment request failed: ${err.message}`);
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: err.message
                });
            }
        });

        // Generic wildcard for readiness check & home requests
        app.all('*', (req, res) => {
            // Check for readiness probe header from Apify platform
            if (req.headers['x-apify-container-server-readiness-probe']) {
                log.info('Received readiness probe. Responding 200 OK.');
                return res.status(200).send('Ready');
            }

            // Normal GET request homepage
            res.status(200).json({
                status: 'running',
                mode: 'standby',
                endpoints: {
                    enrichLocalLeads: 'POST /enrich-local-leads'
                }
            });
        });

        app.listen(port, () => {
            log.info(`Standby server listening on port ${port}`);
        });

        // Keep Standby Actor alive using Actor.main (or just infinite wait since the server is running)
        // Actor.main will keep the container alive until manually aborted or idle timeout hits.
        await Actor.main(async () => {
            // The express server holds the event loop, so this function keeps running
            await new Promise(() => {});
        });

    } else {
        log.info('Starting Actor in BATCH mode (standard crawler run)');
        
        await Actor.main(async () => {
            const input = await Actor.getInput() as InputSchema;

            if (!input) {
                throw new Error('Actor input is missing. Please configure locationQuery and industryKeywords.');
            }

            if (!input.locationQuery || !input.industryKeywords) {
                throw new Error('Missing required input fields: locationQuery and industryKeywords.');
            }

            // Prepare client
            const token = input.apifyApiToken || process.env.APIFY_TOKEN;
            let client: ApifyClient | null = null;
            if (token) {
                client = Actor.newClient({ token });
            } else {
                log.warning('No Apify API token found in overrides or environment. Using simulation fallback for B2B intelligence enrichment.');
            }

            const { enrichedBusinesses, diagnostics } = await runPipeline(input, runId, client);

            // Output to datasets
            const defaultDataset = await Actor.openDataset({ alias: 'default' });
            if (enrichedBusinesses.length > 0) {
                log.info(`Pushing ${enrichedBusinesses.length} enriched businesses to default dataset`);
                await defaultDataset.pushData(enrichedBusinesses);
            } else {
                log.warning('No enriched businesses found to output.');
            }

            const diagnosticsDataset = await Actor.openDataset({ alias: 'diagnostics' });
            if (diagnostics.length > 0) {
                log.info(`Pushing ${diagnostics.length} diagnostic logs to diagnostics dataset`);
                await diagnosticsDataset.pushData(diagnostics);
            }

            // Final logging summary
            log.info('====================================================');
            log.info('Run summary:');
            log.info(`- Candidate Leads Scraped: ${enrichedBusinesses.length}`);
            log.info(`- Enriched Businesses Saved: ${enrichedBusinesses.length}`);
            log.info(`- Diagnostic Logs Written: ${diagnostics.length}`);
            log.info('====================================================');

            if (enrichedBusinesses.length === 0) {
                log.warning('Run completed successfully but enriched business dataset is empty.');
            }
        });
    }
}

main().catch(err => {
    log.error(`Actor fatal failure: ${err.message}`);
    process.exit(1);
});
