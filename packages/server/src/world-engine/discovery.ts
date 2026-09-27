import { createPlatformFromSignal, nowIso, stableId, validatePlatformSignal } from '@creator-mall/core'
import type { EvolutionEvent, PlatformSignal } from '@creator-mall/core'
import type { ControlPlane } from '../store/control-plane.js'
import type { PublicFetcher } from './fetcher.js'

export interface DiscoveryDeps {
  control: ControlPlane
  fetcher: PublicFetcher
  clock?: () => number
  /** Cap on how many discovery pages are read per cycle. */
  maxPages?: number
}

/** Text shapes that suggest a *new* platform is being announced. */
const ANNOUNCEMENT_PATTERNS: RegExp[] = [
  /\b(?:announc(?:e|ed|ing)|unveil(?:s|ed|ing)|launch(?:es|ed|ing)|introduc(?:e|es|ing)|coming soon|pre-?announce(?:d|ment)|rolling out)\b/i,
  /\b(?:new|upcoming)\s+(?:social\s+)?(?:app|platform|network)\b/i,
  /\bbeta\b.{0,40}\b(?:creators?|users?|audience)\b/i,
]

const PLATFORM_NAME_PATTERNS: RegExp[] = [
  /\b([A-Z][A-Za-z0-9]{2,20})\s+(?:is|has been|will be)\s+(?:launching|rolling out|coming|an?)\b/,
  /\b(?:announc(?:e|ed|ing)|unveil(?:s|ed)|launch(?:es|ed))\s+(?:a\s+)?(?:new\s+)?([A-Z][A-Za-z0-9]{2,20})\b/,
]

/**
 * §16: continuous discovery of platforms Creator Mall has never seen.
 *
 * Signals are only *registered* after identity + source validation, and a
 * discovered platform is never publishable from this code path (§39). The
 * purpose is preparation, not integration.
 */
export async function discoverPlatformSignals(deps: DiscoveryDeps): Promise<EvolutionEvent[]> {
  const clock = deps.clock ?? Date.now
  const { control, fetcher } = deps
  const events: EvolutionEvent[] = []

  const known = new Set(control.listPlatforms().map((platform) => platform.slug))
  const discoverySources = control
    .listSources()
    .filter((source) => source.active && (source.sourceType === 'NEWS' || source.sourceType === 'COMMUNITY'))
    .filter((source) => source.lastStatus !== 'BLOCKED')
    .slice(0, deps.maxPages ?? 2)

  for (const source of discoverySources) {
    const outcome = await fetcher.fetch(source, { etag: source.etag, lastModified: source.lastModified })
    if (outcome.status !== 'OK') continue

    const text = outcome.body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
    if (!ANNOUNCEMENT_PATTERNS.some((pattern) => pattern.test(text))) continue

    for (const name of candidateNames(text)) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      if (!slug || known.has(slug)) continue
      if (isAlreadyKnown(control, name)) continue

      const signal: PlatformSignal = {
        name,
        description: excerptAround(text, name),
        sourceIds: [source.id],
        discoveredAt: nowIso(clock),
      }
      const validated = validatePlatformSignal(signal, control.listSources())
      if (!validated.valid && validated.trustLevel !== 'REPORTED') continue

      const platform = createPlatformFromSignal(signal, validated, clock)
      if (control.getPlatform(platform.slug)) continue
      control.upsertPlatform(platform)
      known.add(platform.slug)

      events.push(discoveryEvent(platform.name, platform.id, source.id, validated.trustLevel, validated.reasons, clock))
    }
  }

  return events
}

function isAlreadyKnown(control: ControlPlane, name: string): boolean {
  const normalized = name.trim().toLowerCase()
  return control
    .listPlatforms()
    .some((platform) => platform.name.toLowerCase() === normalized || platform.slug === normalized.replace(/\s+/g, '-'))
}

function candidateNames(text: string): string[] {
  const names = new Set<string>()
  for (const pattern of PLATFORM_NAME_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let match: RegExpExecArray | null
    while ((match = global.exec(text)) !== null) {
      for (let index = 1; index < match.length; index += 1) {
        const candidate = match[index]?.trim()
        if (candidate && candidate.length >= 3 && candidate.length <= 24) names.add(candidate)
      }
    }
  }
  return [...names]
}

function excerptAround(text: string, name: string): string {
  const index = text.toLowerCase().indexOf(name.toLowerCase())
  if (index < 0) return ''
  return text.slice(Math.max(0, index - 120), index + 280).replace(/\s+/g, ' ').trim()
}

function discoveryEvent(
  platformName: string,
  platformId: string,
  sourceId: string,
  trustLevel: EvolutionEvent['trustLevel'],
  reasons: string[],
  clock: () => number,
): EvolutionEvent {
  return {
    id: stableId('evt', platformId, sourceId),
    platformId,
    platformName,
    eventType: 'NEW_PLATFORM_DISCOVERED',
    category: 'NEW_PLATFORM',
    title: `${platformName} is a platform Creator Mall is watching`,
    creatorSummary: `We are watching ${platformName} so Creator Mall can be ready the day it opens up.`,
    detectedAt: nowIso(clock),
    verifiedAt: null,
    sourceIds: [sourceId],
    trustLevel,
    confidence: trustLevel === 'OFFICIAL' ? 0.6 : 0.3,
    previousState: null,
    newState: { status: 'DISCOVERED' },
    deltas: [],
    impact: 'No creator impact yet: the platform is not connected.',
    affectedCapabilityKeys: [],
    affectedComponents: [],
    riskLevel: 'LOW',
    status: 'DETECTED',
    approvedBy: null,
    deployedAt: null,
    evidence: reasons.length > 0 ? reasons : ['Announced publicly; awaiting first-party confirmation.'],
  }
}
