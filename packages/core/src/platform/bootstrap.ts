import type { SocialPlatform } from '../types/platform.js'
import type { PlatformKind, PlatformStatus, TrustLevel } from '../types/enums.js'
import type { Source as SourceRecord } from '../types/source.js'
import { newId, nowIso, slugify, stableId } from '../util.js'
import { looksFirstParty } from '../verify/trust.js'

export interface PlatformSignal {
  name: string
  /** A homepage or documentation URL that plausibly belongs to the platform. */
  url?: string
  /** Short description from an announcement or article. */
  description?: string
  sourceIds: string[]
  discoveredAt: string
}

export interface ValidatedPlatform {
  valid: boolean
  reasons: string[]
  slug: string
  name: string
  kind: PlatformKind
  status: PlatformStatus
  trustLevel: TrustLevel
  sourceIds: string[]
}

const GENERIC_NAMES = new Set(['app', 'social', 'platform', 'network', 'beta', 'unknown', 'coming soon', 'new'])
const STATUS_SIGNALS: Array<{ pattern: RegExp; status: PlatformStatus }> = [
  { pattern: /\b(coming soon|launching soon|opening (?:up )?(?:soon|next)|pre-?announce)/i, status: 'COMING_SOON' },
  { pattern: /\b(beta|early access|private beta|closed beta)\b/i, status: 'BETA' },
  { pattern: /\b(announce|announced|unveiled|reveal(ed)?)\b/i, status: 'ANNOUNCED' },
  { pattern: /\b(shut(ting)? down|sunset|closing|discontinu)/i, status: 'SUNSET' },
  { pattern: /\b(now available|live|generally available|ga|launched)\b/i, status: 'ACTIVE' },
]

const KIND_SIGNALS: Array<{ pattern: RegExp; kind: PlatformKind }> = [
  { pattern: /\b(video|streaming|watch)\b/i, kind: 'VIDEO' },
  { pattern: /\b(professional|network for|linkedin|recruiter|hiring)\b/i, kind: 'PROFESSIONAL' },
  { pattern: /\b(community|forum|discussion board|message board)\b/i, kind: 'COMMUNITY' },
  { pattern: /\b(messag|chat|dm\b|inbox)\b/i, kind: 'MESSAGING' },
  { pattern: /\b(decentrali[sz]ed|fediverse|blockchain|protocol|web3)\b/i, kind: 'DECENTRALIZED' },
  { pattern: /\b(creator|influencer|monetiz)\b/i, kind: 'CREATOR_NATIVE' },
  { pattern: /\b(launch(ed)?|new|emerging|beta|region|india|brazil|africa|southeast asia)\b/i, kind: 'EMERGING' },
]

/**
 * §16 + §39 stage 1–3: identity validation and source validation for a platform
 * nobody has heard of before. A platform is only registered once it has a real
 * identity and at least one concrete source; it never becomes publishable here.
 */
export function validatePlatformSignal(signal: PlatformSignal, sources: ReadonlyArray<SourceRecord>): ValidatedPlatform {
  const reasons: string[] = []
  const name = signal.name.trim()
  if (name.length < 2) reasons.push('Name is too short to be a real platform.')
  if (GENERIC_NAMES.has(name.toLowerCase())) reasons.push('Name looks like a placeholder rather than a platform.')
  if (signal.sourceIds.length === 0) reasons.push('No source backs this discovery.')

  const linked = sources.filter((source) => signal.sourceIds.includes(source.id))
  const official = linked.filter((source) => looksFirstParty(source, [hostOf(signal.url)]) && isFirstPartyType(source))
  if (official.length === 0) reasons.push('No first-party source confirms this platform exists.')

  const text = `${name} ${signal.description ?? ''}`
  const status = STATUS_SIGNALS.find((entry) => entry.pattern.test(text))?.status ?? 'DISCOVERED'
  const kind = KIND_SIGNALS.find((entry) => entry.pattern.test(text))?.kind ?? 'UNKNOWN'
  const trustLevel: TrustLevel = official.length > 0 ? 'OFFICIAL' : linked.length > 0 ? 'REPORTED' : 'UNCONFIRMED'

  return {
    valid: reasons.length === 0 || (official.length > 0 && name.length >= 2),
    reasons,
    slug: slugify(name) || stableId('platform', name).slice(8),
    name,
    kind,
    status,
    trustLevel,
    sourceIds: signal.sourceIds,
  }
}

export function createPlatformFromSignal(
  signal: PlatformSignal,
  validated: ValidatedPlatform,
  clock: () => number = Date.now,
): SocialPlatform {
  const at = nowIso(clock)
  return {
    id: stableId('pf', validated.slug),
    slug: validated.slug,
    name: validated.name,
    kind: validated.kind,
    status: validated.status,
    homepage: signal.url,
    regions: [],
    capabilityKeys: [],
    trustLevel: validated.trustLevel,
    firstSeenAt: signal.discoveredAt || at,
    lastReviewedAt: at,
    integrationState: 'UNPREPARED',
    metadata: {
      discovery: {
        description: signal.description ?? null,
        reasons: validated.reasons,
        discoveredVia: 'WORLD_ENGINE',
      },
    },
  }
}

/** §16 watchlist statuses, ordered by how ready the platform is to be built. */
export function watchlistOrder(status: PlatformStatus): number {
  const order: PlatformStatus[] = ['ACTIVE', 'BETA', 'ANNOUNCED', 'COMING_SOON', 'EMERGING', 'REGIONAL', 'DISCOVERED', 'SUNSET']
  const index = order.indexOf(status)
  return index === -1 ? order.length : index
}

function isFirstPartyType(source: SourceRecord): boolean {
  return source.sourceType === 'OFFICIAL' || source.sourceType === 'DOCUMENTATION' || source.sourceType === 'DEVELOPER'
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function newPlatformId(): string {
  return newId('pf')
}
