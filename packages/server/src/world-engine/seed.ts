import type { SocialPlatform, Source } from '@creator-mall/core'
import { nowIso, stableId } from '@creator-mall/core'

export interface SeedPlatform {
  slug: string
  name: string
  kind: SocialPlatform['kind']
  status: SocialPlatform['status']
  homepage: string
  regions: string[]
  capabilityKeys: string[]
  docsHost: string
  developerHost: string
  blogHost: string
  newsHost: string | null
}

/**
 * The starting watchlist. This is *seed data*, not a hardcoded platform list in
 * application logic: the engine works identically for a platform nobody has
 * heard of, and anything discovered later is treated the same way (§16, §42).
 */
export const SEED_PLATFORMS: SeedPlatform[] = [
  {
    slug: 'instagram',
    name: 'Instagram',
    kind: 'MAINSTREAM',
    status: 'ACTIVE',
    homepage: 'https://www.instagram.com',
    regions: ['GLOBAL'],
    capabilityKeys: ['TEXT_POST', 'IMAGE_POST', 'IMAGE_MEDIA', 'CAROUSEL', 'SHORT_VIDEO', 'VIDEO_MEDIA', 'STORY', 'LIVE', 'SCHEDULING', 'ANALYTICS', 'COMMENT_REPLIES', 'DM_MESSAGING', 'COLLABORATION', 'BRANDED_CONTENT', 'API_PUBLISH', 'API_ANALYTICS'],
    docsHost: 'creators.instagram.com',
    developerHost: 'developers.facebook.com',
    blogHost: 'about.instagram.com',
    newsHost: null,
  },
  {
    slug: 'youtube',
    name: 'YouTube',
    kind: 'VIDEO',
    status: 'ACTIVE',
    homepage: 'https://www.youtube.com',
    regions: ['GLOBAL'],
    capabilityKeys: ['SHORT_VIDEO', 'LONG_VIDEO', 'VIDEO_MEDIA', 'LIVE', 'THREAD', 'SCHEDULING', 'ANALYTICS', 'COMMENT_REPLIES', 'CREATOR_FUNDING', 'API_PUBLISH', 'API_ANALYTICS', 'SUBTITLES'],
    docsHost: 'support.google.com',
    developerHost: 'developers.google.com',
    blogHost: 'blog.youtube',
    newsHost: null,
  },
  {
    slug: 'tiktok',
    name: 'TikTok',
    kind: 'CREATOR_NATIVE',
    status: 'ACTIVE',
    homepage: 'https://www.tiktok.com',
    regions: ['GLOBAL'],
    capabilityKeys: ['SHORT_VIDEO', 'VIDEO_MEDIA', 'LIVE', 'IMAGE_POST', 'IMAGE_MEDIA', 'CAROUSEL', 'STORY', 'SCHEDULING', 'ANALYTICS', 'COMMENT_REPLIES', 'TREND_SOUND_LIBRARY', 'API_PUBLISH'],
    docsHost: 'support.tiktok.com',
    developerHost: 'developers.tiktok.com',
    blogHost: 'newsroom.tiktok.com',
    newsHost: null,
  },
  {
    slug: 'linkedin',
    name: 'LinkedIn',
    kind: 'PROFESSIONAL',
    status: 'ACTIVE',
    homepage: 'https://www.linkedin.com',
    regions: ['GLOBAL'],
    capabilityKeys: ['TEXT_POST', 'ARTICLE', 'IMAGE_POST', 'IMAGE_MEDIA', 'VIDEO_MEDIA', 'SHORT_VIDEO', 'CAROUSEL', 'POLL', 'SCHEDULING', 'ANALYTICS', 'COMMENT_REPLIES', 'DM_MESSAGING', 'API_PUBLISH'],
    docsHost: 'linkedin.com',
    developerHost: 'learn.microsoft.com',
    blogHost: 'linkedin.com',
    newsHost: null,
  },
  {
    slug: 'x',
    name: 'X',
    kind: 'MAINSTREAM',
    status: 'ACTIVE',
    homepage: 'https://x.com',
    regions: ['GLOBAL'],
    capabilityKeys: ['TEXT_POST', 'IMAGE_POST', 'IMAGE_MEDIA', 'SHORT_VIDEO', 'VIDEO_MEDIA', 'POLL', 'THREAD', 'LIVE', 'SCHEDULING', 'ANALYTICS', 'COMMENT_REPLIES', 'DM_MESSAGING', 'API_PUBLISH', 'API_ANALYTICS'],
    docsHost: 'help.x.com',
    developerHost: 'developer.x.com',
    blogHost: 'blog.x.com',
    newsHost: null,
  },
  {
    slug: 'facebook',
    name: 'Facebook',
    kind: 'MAINSTREAM',
    status: 'ACTIVE',
    homepage: 'https://www.facebook.com',
    regions: ['GLOBAL'],
    capabilityKeys: ['TEXT_POST', 'IMAGE_POST', 'IMAGE_MEDIA', 'CAROUSEL', 'VIDEO_MEDIA', 'LONG_VIDEO', 'SHORT_VIDEO', 'STORY', 'LIVE', 'POLL', 'SCHEDULING', 'ANALYTICS', 'COMMENT_REPLIES', 'DM_MESSAGING', 'COLLABORATION', 'SHOPPING', 'API_PUBLISH'],
    docsHost: 'facebook.com',
    developerHost: 'developers.facebook.com',
    blogHost: 'about.fb.com',
    newsHost: null,
  },
  {
    slug: 'threads',
    name: 'Threads',
    kind: 'MAINSTREAM',
    status: 'ACTIVE',
    homepage: 'https://www.threads.net',
    regions: ['GLOBAL'],
    capabilityKeys: ['TEXT_POST', 'IMAGE_POST', 'IMAGE_MEDIA', 'SHORT_VIDEO', 'THREAD', 'POLL', 'SCHEDULING', 'ANALYTICS', 'COMMENT_REPLIES'],
    docsHost: 'help.instagram.com',
    developerHost: 'developers.facebook.com',
    blogHost: 'about.instagram.com',
    newsHost: null,
  },
]

function source(input: {
  platform: string
  name: string
  url: string
  sourceType: Source['sourceType']
  trustLevel: Source['trustLevel']
  checkHours: number
  at: string
}): Source {
  const host = new URL(input.url).hostname.replace(/^www\./, '')
  return {
    id: stableId('src', input.url),
    name: input.name,
    url: input.url,
    domain: host,
    sourceType: input.sourceType,
    platform: input.platform,
    trustLevel: input.trustLevel,
    discoveredVia: 'SEED',
    lastCheckedAt: null,
    nextCheckAt: null,
    active: true,
    lastStatus: 'NEVER_CHECKED',
    consecutiveFailures: 0,
  }
}

/**
 * §4 source registry, seeded with first-party documentation for the starting
 * watchlist. Sources are data, not code: adding a platform adds rows here and
 * nothing else changes anywhere in the system.
 */
export function seedSources(platforms: ReadonlyArray<SeedPlatform>, at: string = nowIso()): Source[] {
  const sources: Source[] = []
  for (const platform of platforms) {
    sources.push(
      source({
        platform: platform.slug,
        name: `${platform.name} creator help`,
        url: `https://${platform.docsHost}/`,
        sourceType: 'DOCUMENTATION',
        trustLevel: 'OFFICIAL',
        checkHours: 12,
        at,
      }),
      source({
        platform: platform.slug,
        name: `${platform.name} developer docs`,
        url: `https://${platform.developerHost}/`,
        sourceType: 'DEVELOPER',
        trustLevel: 'OFFICIAL',
        checkHours: 24,
        at,
      }),
      source({
        platform: platform.slug,
        name: `${platform.name} official news`,
        url: `https://${platform.blogHost}/`,
        sourceType: 'OFFICIAL',
        trustLevel: 'OFFICIAL',
        checkHours: 12,
        at,
      }),
    )
    if (platform.newsHost) {
      sources.push(
        source({
          platform: platform.slug,
          name: `${platform.name} press coverage`,
          url: `https://${platform.newsHost}/`,
          sourceType: 'NEWS',
          trustLevel: 'REPORTED',
          checkHours: 24,
          at,
        }),
      )
    }
  }
  return sources
}
