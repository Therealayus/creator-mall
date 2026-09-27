import type { CapabilityDefinition } from '../types/platform.js'
import type { SocialPlatform, PlatformState } from '../types/platform.js'
import type { CapabilityState } from '../types/enums.js'
import type { EvolutionEvent } from '../types/evolution.js'

export interface CreatorActionOption {
  /** Capability key — the single source of truth for what the UI may offer. */
  capabilityKey: string
  label: string
  description: string
  icon: string
  /** Which composer surface renders this option. */
  surface: string
  /** True when the platform is verified to support it right now. */
  enabled: boolean
  /** Populated when the option is disabled or newly added. */
  reason: string | null
  /** Media the creator must attach. */
  requiredMedia: 'NONE' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'ANY'
  constraints: Record<string, unknown>
}

export interface PlatformUiConfig {
  platformId: string
  platformName: string
  platformSlug: string
  status: string
  /** All creation options the platform could offer, enabled or not. */
  options: CreatorActionOption[]
  enabledCapabilityKeys: string[]
  disabledCapabilityKeys: string[]
  schedulingEnabled: boolean
  analyticsAvailable: boolean
  publishingEnabled: boolean
  generatedAt: string
  /** §35 attribution: why the current option set looks the way it does. */
  attribution: UiAttribution[]
}

export interface UiAttribution {
  capabilityKey: string
  state: CapabilityState
  explanation: string
  detectedAt: string | null
  verifiedAt: string | null
  sourceIds: string[]
  eventId: string | null
}

export interface BuildUiConfigInput {
  platform: SocialPlatform
  state: PlatformState
  capabilities: ReadonlyArray<CapabilityDefinition>
  events: ReadonlyArray<EvolutionEvent>
  /** Platforms without a live adapter must not show a "Publish" affordance. */
  publishingEnabled: boolean
  generatedAt: string
}

const MEDIA_FOR_DOMAIN: Record<string, CreatorActionOption['requiredMedia']> = {
  SHORT_VIDEO: 'VIDEO',
  LONG_VIDEO: 'VIDEO',
  VIDEO_MEDIA: 'VIDEO',
  AUDIO: 'AUDIO',
  PODCAST_EPISODE: 'AUDIO',
  IMAGE_POST: 'IMAGE',
  CAROUSEL: 'IMAGE',
  IMAGE_MEDIA: 'IMAGE',
}

const ICONS: Record<string, string> = {
  TEXT_POST: 'text',
  IMAGE_POST: 'image',
  CAROUSEL: 'layers',
  SHORT_VIDEO: 'play',
  LONG_VIDEO: 'film',
  STORY: 'clock',
  LIVE: 'radio',
  POLL: 'bar-chart',
  THREAD: 'link',
  ARTICLE: 'file-text',
  AUDIO: 'music',
  PODCAST_EPISODE: 'mic',
}

/**
 * §19 + §20: the UI is rendered from capability data, never from
 * `if (platform === 'instagram')`. A new verified capability appears as a new
 * option; a withdrawn one disappears with an explanation.
 */
export function buildPlatformUiConfig(input: BuildUiConfigInput): PlatformUiConfig {
  const observation = input.state.capabilities
  const keys = new Set<string>([
    ...input.capabilities
      .filter((capability) => capability.domain === 'CONTENT')
      .map((capability) => capability.key),
    ...Object.keys(observation),
    ...input.platform.capabilityKeys,
  ])

  const attributionByKey = new Map<string, UiAttribution>()
  for (const event of input.events) {
    for (const key of event.affectedCapabilityKeys) {
      const state = event.deltas.find((delta) => delta.capabilityKeys.includes(key))?.kind === 'REMOVED' ? 'REMOVED' : 'ACTIVE'
      attributionByKey.set(key, {
        capabilityKey: key,
        state,
        explanation:
          state === 'REMOVED'
            ? `${event.title} — the platform stopped supporting this.`
            : `${event.title} — verified from official sources.`,
        detectedAt: event.detectedAt,
        verifiedAt: event.verifiedAt,
        sourceIds: event.sourceIds,
        eventId: event.id,
      })
    }
  }

  const options: CreatorActionOption[] = []
  for (const key of [...keys].sort()) {
    const definition = input.capabilities.find((capability) => capability.key === key)
    if (!definition) continue
    if (definition.domain !== 'CONTENT' && !observation[key]) continue

    const observed = observation[key]
    const state: CapabilityState = observed?.state ?? 'UNKNOWN'
    const enabled = state === 'ACTIVE'

    options.push({
      capabilityKey: key,
      label: definition.label,
      description: definition.description,
      icon: ICONS[key] ?? 'sparkles',
      surface: definition.surfaces.includes('create-menu') ? 'create-menu' : 'composer',
      enabled,
      reason: enabled ? null : disabledReason(state, attributionByKey.get(key)),
      requiredMedia: MEDIA_FOR_DOMAIN[key] ?? 'NONE',
      constraints: (observed?.constraints as Record<string, unknown> | undefined) ?? {},
    })
  }

  const enabledCapabilityKeys = options.filter((option) => option.enabled).map((option) => option.capabilityKey)
  const disabledCapabilityKeys = options.filter((option) => !option.enabled).map((option) => option.capabilityKey)

  return {
    platformId: input.platform.id,
    platformName: input.platform.name,
    platformSlug: input.platform.slug,
    status: input.platform.status,
    options,
    enabledCapabilityKeys,
    disabledCapabilityKeys,
    schedulingEnabled: observation.SCHEDULING?.state === 'ACTIVE',
    analyticsAvailable: observation.ANALYTICS?.state === 'ACTIVE',
    publishingEnabled: input.publishingEnabled,
    generatedAt: input.generatedAt,
    attribution: [...attributionByKey.values()],
  }
}

function disabledReason(state: CapabilityState, attribution: UiAttribution | undefined): string {
  if (state === 'DEPRECATED') return 'The platform is phasing this out.'
  if (state === 'REMOVED') return attribution?.explanation ?? 'The platform no longer supports this.'
  if (state === 'PROPOSED') return 'Not available yet — we are preparing it.'
  return 'Waiting for confirmation from the platform.'
}

/** §43: creator-facing copy. No registry, adapter, crawler or embedding jargon. */
export const CREATOR_FACING_TERMS: Record<string, string> = {
  capability: 'option',
  capabilities: 'options',
  capabilityRegistry: 'platform support',
  adapter: 'connection',
  crawler: 'research',
  embedding: 'index',
  RAG: 'our knowledge',
  evolutionEvent: 'update',
  trustLevel: 'source',
  knowledgeDocument: 'platform guide',
  snapshot: 'record',
  deprecation: 'no longer supported',
  proposal: 'suggested change',
}
