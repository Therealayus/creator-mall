import type { SourceType, TrustLevel, TtlPolicy } from '../types/enums.js'
import type { Source as SourceRecord } from '../types/source.js'

/** Relative authority of a source class (§3 ordering). */
const TYPE_WEIGHT: Record<SourceType, number> = {
  OFFICIAL: 1,
  DOCUMENTATION: 0.95,
  DEVELOPER: 0.9,
  API: 0.85,
  RSS: 0.6,
  NEWS: 0.55,
  RESEARCH: 0.6,
  COMMUNITY: 0.25,
}

/** Official platform properties are high trust; everything else is assigned. */
const TRUST_WEIGHT: Record<TrustLevel, number> = {
  OFFICIAL: 1,
  VERIFIED: 0.8,
  REPORTED: 0.55,
  COMMUNITY_SIGNAL: 0.3,
  UNCONFIRMED: 0.2,
  RUMOR: 0.1,
}

/** How fast knowledge of each kind goes stale (§15). */
const TTL_DAYS: Record<TtlPolicy, number> = {
  API_INFO: 7,
  PLATFORM_LIMIT: 14,
  PLATFORM_POLICY: 30,
  PLATFORM_GENERAL: 90,
  TREND_SIGNAL: 5,
  HISTORICAL: 36500,
}

export function sourceWeight(source: Pick<SourceRecord, 'sourceType' | 'trustLevel' | 'active'>): number {
  if (!source.active) return 0
  return Math.max(TYPE_WEIGHT[source.sourceType] ?? 0.2, TRUST_WEIGHT[source.trustLevel] ?? 0.2)
}

export function ttlDaysFor(policy: TtlPolicy): number {
  return TTL_DAYS[policy]
}

export function ttlMsFor(policy: TtlPolicy): number {
  return ttlDaysFor(policy) * 86_400_000
}

export function expiresAtFor(policy: TtlPolicy, fromIso: string): string {
  return new Date(new Date(fromIso).getTime() + ttlMsFor(policy)).toISOString()
}

export function categoryTtlPolicy(category: string): TtlPolicy {
  if (category === 'API_CHANGE' || category === 'API_DEPRECATION' || category === 'PUBLISHING_METHOD') return 'API_INFO'
  if (
    category === 'CONTENT_LIMIT' ||
    category === 'FILE_SIZE_LIMIT' ||
    category === 'VIDEO_SPEC' ||
    category === 'IMAGE_SPEC' ||
    category === 'CHARACTER_LIMIT'
  ) {
    return 'PLATFORM_LIMIT'
  }
  if (category === 'POLICY_CHANGE' || category === 'HASHTAG_BEHAVIOR' || category === 'MONETIZATION_CHANGE') {
    return 'PLATFORM_POLICY'
  }
  if (category === 'CREATOR_TREND' || category === 'TOOL_ECOSYSTEM') return 'TREND_SIGNAL'
  return 'PLATFORM_GENERAL'
}

const OFFICIAL_TYPES: ReadonlySet<SourceType> = new Set<SourceType>(['OFFICIAL', 'DOCUMENTATION', 'DEVELOPER', 'API'])
const REPORTING_TYPES: ReadonlySet<SourceType> = new Set<SourceType>(['NEWS', 'RSS', 'RESEARCH'])

/** True when the source speaks for the platform itself. */
export function isOfficialSource(source: Pick<SourceRecord, 'sourceType'>): boolean {
  return OFFICIAL_TYPES.has(source.sourceType)
}

export function isReportingSource(source: Pick<SourceRecord, 'sourceType'>): boolean {
  return REPORTING_TYPES.has(source.sourceType)
}

/** Domains we treat as first-party documentation for a platform. */
export function looksFirstParty(source: Pick<SourceRecord, 'url'>, platformDomains: readonly string[]): boolean {
  let host = ''
  try {
    host = new URL(source.url).hostname.replace(/^www\./, '')
  } catch {
    return false
  }
  return platformDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export interface TrustAssessment {
  trustLevel: TrustLevel
  confidence: number
  rationale: string
}

/**
 * §3: a single community post is a signal, never a platform fact.
 * A single official source is authoritative but still gets a small confidence
 * haircut until a second observation confirms it.
 */
export function assessSources(sources: ReadonlyArray<SourceRecord>): TrustAssessment {
  const active = sources.filter((source) => source.active)
  if (active.length === 0) {
    return { trustLevel: 'UNCONFIRMED', confidence: 0, rationale: 'No active source backs this claim.' }
  }

  const official = active.filter(isOfficialSource)
  const reporting = active.filter(isReportingSource)
  const community = active.filter((source) => source.sourceType === 'COMMUNITY')
  const independentDomains = new Set(active.map((source) => source.domain)).size

  const weights = active.map(sourceWeight)
  const maxWeight = Math.max(...weights)
  const meanWeight = weights.reduce((sum, weight) => sum + weight, 0) / weights.length
  const corroboration = Math.min(1, (independentDomains - 1) / 2)

  if (official.length > 0) {
    const confidence = clamp01(maxWeight * (0.85 + 0.15 * corroboration))
    return {
      trustLevel: 'OFFICIAL',
      confidence,
      rationale: `Backed by ${official.length} first-party source(s)${
        independentDomains > 1 ? ` across ${independentDomains} domains` : ''
      }.`,
    }
  }

  if (reporting.length >= 2) {
    return {
      trustLevel: 'VERIFIED',
      confidence: clamp01(meanWeight * (0.8 + 0.2 * corroboration)),
      rationale: `Corroborated by ${reporting.length} independent reporting sources.`,
    }
  }

  if (reporting.length === 1) {
    return {
      trustLevel: 'REPORTED',
      confidence: clamp01(maxWeight * 0.6),
      rationale: 'Single reputable report; awaiting confirmation from the platform or a second source.',
    }
  }

  if (community.length > 0) {
    return {
      trustLevel: 'COMMUNITY_SIGNAL',
      confidence: clamp01(Math.max(...weights) * 0.4),
      rationale: 'Community discussion only — treated as a signal to watch, not a platform fact.',
    }
  }

  return {
    trustLevel: 'UNCONFIRMED',
    confidence: clamp01(Math.max(...weights) * 0.3),
    rationale: 'Source quality is too low to publish as fact.',
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(3))))
}
