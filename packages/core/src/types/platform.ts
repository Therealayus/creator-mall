import type {
  CapabilityDomain,
  CapabilityState,
  PlatformKind,
  PlatformStatus,
  ReadinessState,
  TrustLevel,
} from './enums.js'

/** JSON-safe value used inside snapshots, so diffs stay structural. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/**
 * A capability is a *product-level* concept ("short-form vertical video"),
 * never a platform concept. Platforms declare which capabilities they have.
 * New capabilities are created at runtime by the capability registry.
 */
export interface CapabilityDefinition {
  key: string
  label: string
  /** Creator-facing description. No jargon (§43). */
  description: string
  domain: CapabilityDomain
  /** Where a creator would find this capability in the product. */
  surfaces: readonly string[]
  /** Capability keys that typically must exist for this one to be usable. */
  requires?: readonly string[]
  /** Strong signals that a source text refers to this capability. */
  signals?: readonly string[]
  /** Set when the definition was produced by the Evolution Engine. */
  origin: 'SEED' | 'DETECTED' | 'PROPOSED'
  createdAt: string
  deprecatedAt?: string
}

/** What a platform can do, as observed in one snapshot. */
export interface PlatformCapabilityObservation {
  capabilityKey: string
  state: CapabilityState
  /** How confident the observation is, given its sources. */
  confidence: number
  sourceIds: string[]
  notes?: string
  /** Restrictions attached to the capability (duration, ratio, count...). */
  constraints?: JsonObject
}

export interface SourceRef {
  sourceId: string
  url: string
  trustLevel: TrustLevel
}

/**
 * Normalized observation of a platform at a point in time (§7).
 * Deliberately a bag of JSON values grouped by area: adding a new observation
 * area never requires a schema migration, and diffs work on any depth.
 */
export interface PlatformState {
  capabilities: Record<string, PlatformCapabilityObservation>
  limits: JsonObject
  mediaSpecs: JsonObject
  publishing: JsonObject
  api: JsonObject
  analytics: JsonObject
  monetization: JsonObject
  requirements: JsonObject
  policies: JsonValue[]
  /** Free-form, source-backed notes ("verification requires government ID"). */
  notes: JsonValue[]
}

export interface PlatformSnapshot {
  id: string
  platformId: string
  capturedAt: string
  sourceIds: string[]
  /** Hash of the normalized state; used for cheap "did anything change?" checks. */
  stateHash: string
  state: PlatformState
  /** Free-form provenance for humans reading the timeline. */
  capturedBy: 'SCHEDULED_RESEARCH' | 'MANUAL' | 'SEED' | 'IMPORT'
}

export interface SocialPlatform {
  id: string
  /** Stable machine slug (e.g. "instagram"). Unknown platforms get one too. */
  slug: string
  name: string
  kind: PlatformKind
  status: PlatformStatus
  homepage?: string
  /** Regions the platform operates in, when known. */
  regions: string[]
  /** Capability keys the platform is believed to support. */
  capabilityKeys: string[]
  trustLevel: TrustLevel
  firstSeenAt: string
  lastReviewedAt?: string
  /** Set once a verified integration exists (§39). */
  integrationState: 'UNPREPARED' | 'PREPARING' | 'ADAPTER_READY' | 'INTEGRATED' | 'SUNSET'
  metadata: JsonObject
}

export interface ReadinessArea {
  area: string
  state: ReadinessState
  reason: string
  blockers: string[]
}

export interface PlatformReadinessProfile {
  platformId: string
  computedAt: string
  overallPercent: number
  areas: ReadinessArea[]
  /** Capability keys we can already generate content for. */
  generationReady: string[]
  /** Integration work still required before creators can publish. */
  remainingWork: string[]
}

/** §27: the creator-visible evolution timeline for one platform. */
export interface PlatformTimelineEntry {
  at: string
  category: string
  title: string
  detail: string
  sourceIds: string[]
  trustLevel: TrustLevel
  riskLevel: string
}
