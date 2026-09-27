import type { PlatformAdapter } from '../types/adapter.js'
import type { SocialPlatform, PlatformReadinessProfile, ReadinessArea } from '../types/platform.js'
import type { JsonValue } from '../types/platform.js'
import type { CapabilityDefinition } from '../types/platform.js'
import { nowIso } from '../util.js'

export interface ReadinessInput {
  platform: SocialPlatform
  capabilities: ReadonlyArray<CapabilityDefinition>
  adapter: PlatformAdapter | null
  hasApiSource: boolean
  hasOfficialSource: boolean
  templatesPrepared: number
  clock?: () => number
}

/**
 * §17: a newly discovered platform gets an internal readiness profile *before*
 * any integration exists, so the product is ready the day the platform opens
 * its API. Publishing stays disabled until it is genuinely verified (§39).
 */
export function buildReadinessProfile(input: ReadinessInput): PlatformReadinessProfile {
  const clock = input.clock ?? Date.now
  const areas: ReadinessArea[] = []
  const keys = new Set(input.platform.capabilityKeys)

  const textCapability = [...keys].some((key) =>
    ['TEXT_POST', 'ARTICLE', 'THREAD', 'SHORT_VIDEO', 'LONG_VIDEO', 'IMAGE_POST', 'AUDIO'].includes(key),
  )
  const imageCapability = keys.has('IMAGE_MEDIA') || keys.has('IMAGE_POST') || keys.has('CAROUSEL')
  const videoCapability = keys.has('VIDEO_MEDIA') || keys.has('SHORT_VIDEO') || keys.has('LONG_VIDEO')

  areas.push(
    area(
      'contentGeneration',
      textCapability ? 'READY' : 'PARTIAL',
      textCapability
        ? 'We can write and format content for this platform today.'
        : 'Content formats are not confirmed yet, so generation is generic.',
      textCapability ? [] : ['Confirm supported formats from official sources'],
    ),
  )
  areas.push(
    area(
      'imageGeneration',
      imageCapability ? 'READY' : 'BLOCKED',
      imageCapability ? 'Image content is supported.' : 'No confirmed image support.',
      imageCapability ? [] : ['Confirm image support'],
    ),
  )
  areas.push(
    area(
      'videoGeneration',
      videoCapability ? 'READY' : 'BLOCKED',
      videoCapability ? 'Video content is supported.' : 'No confirmed video support.',
      videoCapability ? [] : ['Confirm video support'],
    ),
  )

  const adapterKind = input.adapter?.kind ?? null
  areas.push(
    area(
      'platformAdapter',
      adapterKind === 'LIVE' ? 'READY' : adapterKind === 'SIMULATED' ? 'PARTIAL' : 'NOT_YET',
      adapterKind === 'LIVE'
        ? 'A live integration is connected.'
        : adapterKind === 'SIMULATED'
          ? 'A simulated adapter exists; it cannot publish yet.'
          : 'No adapter exists yet, so the platform is represented but not connected.',
      adapterKind === 'LIVE' ? [] : ['Build the platform adapter once the API is verified'],
    ),
  )

  areas.push(
    area(
      'publishingApi',
      keys.has('API_PUBLISH') && adapterKind === 'LIVE' ? 'READY' : keys.has('API_PUBLISH') ? 'PARTIAL' : 'NOT_YET',
      keys.has('API_PUBLISH')
        ? 'A publishing API is documented; the adapter still needs verification.'
        : 'No publishing API is documented yet. Publishing stays disabled.',
      keys.has('API_PUBLISH') ? ['Verify credentials flow end to end'] : ['Watch the developer documentation'],
    ),
  )

  areas.push(
    area(
      'analyticsApi',
      keys.has('API_ANALYTICS') && adapterKind === 'LIVE' ? 'READY' : keys.has('API_ANALYTICS') ? 'PARTIAL' : 'NOT_YET',
      keys.has('API_ANALYTICS')
        ? 'An analytics API is documented.'
        : 'No analytics API is documented yet, so performance data cannot be imported.',
      keys.has('API_ANALYTICS') ? ['Map documented metrics to internal metrics'] : ['Watch for an insights API'],
    ),
  )

  areas.push(
    area(
      'knowledgeCoverage',
      input.hasOfficialSource ? 'READY' : 'PARTIAL',
      input.hasOfficialSource
        ? 'We read this platform directly from official sources.'
        : 'No official source yet; information is community-sourced only.',
      input.hasOfficialSource ? [] : ['Locate official documentation or announcements'],
    ),
  )

  areas.push(
    area(
      'templateLibrary',
      input.templatesPrepared > 0 ? 'PARTIAL' : 'NOT_YET',
      input.templatesPrepared > 0
        ? `${input.templatesPrepared} templates are prepared for this platform.`
        : 'No platform-specific templates yet.',
      input.templatesPrepared > 0 ? ['Review and approve the prepared templates'] : ['Generate templates once formats are confirmed'],
    ),
  )

  const weights: Record<ReadinessArea['state'], number> = { READY: 1, PARTIAL: 0.5, BLOCKED: 0.1, NOT_YET: 0 }
  const overallPercent = Math.round(
    (areas.reduce((sum, entry) => sum + weights[entry.state], 0) / areas.length) * 100,
  )

  return {
    platformId: input.platform.id,
    computedAt: nowIso(clock),
    overallPercent,
    areas,
    generationReady: [...keys].filter((key) => domainOf(input.capabilities, key) === 'CONTENT'),
    remainingWork: areas.flatMap((entry) => entry.blockers),
  }
}

function domainOf(capabilities: ReadonlyArray<CapabilityDefinition>, key: string): string {
  return capabilities.find((capability) => capability.key === key)?.domain ?? ''
}

function area(
  name: string,
  state: ReadinessArea['state'],
  reason: string,
  blockers: string[],
): ReadinessArea {
  return { area: name, state, reason, blockers }
}

/** §39: publishing is never enabled automatically for an unverified platform. */
export function canEnablePublishing(profile: PlatformReadinessProfile, adapter: PlatformAdapter | null): boolean {
  const publishing = profile.areas.find((entry) => entry.area === 'publishingApi')
  return publishing?.state === 'READY' && adapter?.kind === 'LIVE'
}

export function readinessJson(profile: PlatformReadinessProfile): JsonValue {
  return profile as unknown as JsonValue
}
