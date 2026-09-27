import { hashString } from '../util.js'
import type { Source } from '../types/source.js'

/**
 * Candidate documentation paths.
 *
 * These are *candidates*, not facts. A landing page rarely states a video length;
 * a documentation page usually does. The engine probes each candidate, keeps the
 * ones that answer and contribute, and retires the ones that do not — so a wrong
 * guess costs a request rather than a wrong belief.
 */
export interface CandidatePath {
  platform: string
  label: string
  url: string
  sourceType: Source['sourceType']
  trustLevel: Source['trustLevel']
}

const DOC = 'DOCUMENTATION' as const
const DEV = 'DEVELOPER' as const
const OFFICIAL = 'OFFICIAL' as const

export const CANDIDATE_PATHS: ReadonlyArray<CandidatePath> = [
  // Instagram
  { platform: 'instagram', label: 'Instagram · reels and videos', url: 'https://creators.instagram.com/instagram-reels', sourceType: DOC, trustLevel: OFFICIAL },
  { platform: 'instagram', label: 'Instagram · getting started', url: 'https://creators.instagram.com/get-started', sourceType: DOC, trustLevel: OFFICIAL },
  { platform: 'instagram', label: 'Instagram · content publishing API', url: 'https://developers.facebook.com/docs/instagram-platform/content-publishing', sourceType: DEV, trustLevel: OFFICIAL },

  // YouTube
  { platform: 'youtube', label: 'YouTube · video length limits', url: 'https://support.google.com/youtube/answer/9314415', sourceType: DOC, trustLevel: OFFICIAL },
  { platform: 'youtube', label: 'YouTube · upload settings', url: 'https://support.google.com/youtube/answer/1722171', sourceType: DOC, trustLevel: OFFICIAL },
  { platform: 'youtube', label: 'YouTube · Data API', url: 'https://developers.google.com/youtube/v3/getting-started', sourceType: DEV, trustLevel: OFFICIAL },

  // TikTok
  { platform: 'tiktok', label: 'TikTok · video specs', url: 'https://support.tiktok.com/en/using-tiktok/creating-videos/video-size', sourceType: DOC, trustLevel: OFFICIAL },
  { platform: 'tiktok', label: 'TikTok · content posting API', url: 'https://developers.tiktok.com/doc/content-posting-api-get-started', sourceType: DEV, trustLevel: OFFICIAL },

  // LinkedIn
  { platform: 'linkedin', label: 'LinkedIn · posting limits', url: 'https://www.linkedin.com/help/linkedin/answer/a522945', sourceType: DOC, trustLevel: OFFICIAL },
  { platform: 'linkedin', label: 'LinkedIn · API documentation', url: 'https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow', sourceType: DEV, trustLevel: OFFICIAL },

  // X
  { platform: 'x', label: 'X · media and posting rules', url: 'https://help.x.com/en/rules-and-policies/media-and-publishing-policies', sourceType: DOC, trustLevel: OFFICIAL },
  { platform: 'x', label: 'X · API v2', url: 'https://developer.x.com/en/docs/x-api', sourceType: DEV, trustLevel: OFFICIAL },

  // Facebook
  { platform: 'facebook', label: 'Facebook · Page posting', url: 'https://developers.facebook.com/docs/pages-api/posts', sourceType: DEV, trustLevel: OFFICIAL },
  { platform: 'facebook', label: 'Facebook · content publishing API', url: 'https://developers.facebook.com/docs/pages-api/posts/#publish', sourceType: DEV, trustLevel: OFFICIAL },
]

/** A source id that is stable across runs, so probing is idempotent. */
export function candidateSourceId(candidate: CandidatePath): string {
  return `src_c_${hashString(candidate.url).slice(0, 16)}`
}

export function toSource(candidate: CandidatePath): Source {
  return {
    id: candidateSourceId(candidate),
    name: candidate.label,
    url: candidate.url,
    domain: hostOf(candidate.url),
    sourceType: candidate.sourceType,
    platform: candidate.platform,
    trustLevel: candidate.trustLevel,
    // Candidates start unverified and inactive: the engine earns the right to
    // read them by showing they work.
    discoveredVia: 'DISCOVERY',
    lastCheckedAt: null,
    nextCheckAt: null,
    active: false,
    lastStatus: 'NEVER_CHECKED',
    consecutiveFailures: 0,
  }
}

export function candidatesFor(platformSlug: string): CandidatePath[] {
  return CANDIDATE_PATHS.filter((candidate) => candidate.platform === platformSlug)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
