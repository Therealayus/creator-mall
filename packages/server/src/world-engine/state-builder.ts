import type { JsonObject, JsonValue, PlatformState } from '@creator-mall/core'
import type { VerifiedClaim } from '@creator-mall/core'
import { emptyPlatformState } from '@creator-mall/core'

/**
 * Builds the next platform state from the previous state plus newly verified
 * claims.
 *
 * Design rule: claims are *merged*, never subtracted. If a fact stops appearing
 * on a page we do not delete it — that would be an inference from absence.
 * Capabilities are only withdrawn when a source explicitly states a removal or
 * deprecation, which keeps the product from hiding options because a page moved.
 */
export function applyClaims(previous: PlatformState | null, claims: ReadonlyArray<VerifiedClaim>): PlatformState {
  const state: PlatformState = previous ? cloneState(previous) : emptyPlatformState()

  for (const claim of claims) {
    if (claim.status !== 'ACCEPTED' && claim.status !== 'WATCH') continue
    applyClaim(state, claim)
  }

  return state
}

function applyClaim(state: PlatformState, claim: VerifiedClaim): void {
  const [area, ...rest] = claim.path.split('.')
  const key = rest.join('.')

  if (area === 'capabilities' && key) {
    const existing = state.capabilities[key]
    const incoming = claim.value
    const value = typeof incoming === 'object' && incoming !== null && !Array.isArray(incoming) ? incoming : {}
    state.capabilities[key] = {
      capabilityKey: key,
      state: typeof value.state === 'string' ? (value.state as PlatformState['capabilities'][string]['state']) : 'ACTIVE',
      confidence: Math.max(existing?.confidence ?? 0, claim.confidence),
      sourceIds: [...new Set([...(existing?.sourceIds ?? []), ...claim.sourceIds])],
      notes: claim.statement,
      ...(Object.keys(value).length > 0 ? { constraints: withoutState(value) } : {}),
    }
    return
  }

  if (area === 'policies') {
    const text = typeof claim.value === 'string' ? claim.value : claim.statement
    if (!state.policies.includes(text)) state.policies.push(text)
    return
  }

  if (area === 'notes') {
    const text = typeof claim.value === 'string' ? claim.value : claim.statement
    if (!state.notes.includes(text)) state.notes.push(text)
    return
  }

  const container = area ? observationArea(state, area) : null
  if (!container) return
  setPath(container, rest, claim.value)
}

/** Resolves a claim's top-level area to a writable JSON object. */
function observationArea(state: PlatformState, area: string): JsonObject | null {
  switch (area) {
    case 'limits':
      return state.limits
    case 'mediaSpecs':
      return state.mediaSpecs
    case 'publishing':
      return state.publishing
    case 'api':
      return state.api
    case 'analytics':
      return state.analytics
    case 'monetization':
      return state.monetization
    case 'requirements':
      return state.requirements
    default:
      return null
  }
}

function setPath(container: JsonObject, path: string[], value: JsonValue): void {
  if (path.length === 0) return
  if (path.length === 1) {
    container[path[0]!] = value
    return
  }
  const [head, ...tail] = path
  const existing = container[head!]
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    const created: JsonObject = {}
    setPath(created, tail, value)
    container[head!] = created
    return
  }
  setPath(existing, tail, value)
}

function withoutState(value: JsonObject): JsonObject {
  const { state: _state, ...rest } = value
  return rest
}

export function cloneState(state: PlatformState): PlatformState {
  return structuredClone(state)
}

const OBSERVATION_AREAS = [
  'limits',
  'mediaSpecs',
  'publishing',
  'api',
  'analytics',
  'monetization',
  'requirements',
] as const satisfies ReadonlyArray<keyof PlatformState>

/** Human-readable summary of what a snapshot says, used by the timeline view. */
export function summarizeState(state: PlatformState): string[] {  const lines: string[] = []
  const active = Object.values(state.capabilities).filter((entry) => entry.state === 'ACTIVE')
  if (active.length > 0) {
    lines.push(`Supports: ${active.map((entry) => entry.capabilityKey.toLowerCase().replace(/_/g, ' ')).join(', ')}.`)
  }
  const retired = Object.values(state.capabilities).filter((entry) => entry.state === 'DEPRECATED' || entry.state === 'REMOVED')
  if (retired.length > 0) {
    lines.push(`No longer supported: ${retired.map((entry) => entry.capabilityKey.toLowerCase().replace(/_/g, ' ')).join(', ')}.`)
  }
  for (const area of OBSERVATION_AREAS) {
    for (const [key, value] of Object.entries(state[area])) {
      if (value === null || value === undefined) continue
      if (isEmptyContainer(value)) continue
      lines.push(`${area}.${key} = ${describeValue(value)}`)
    }
  }
  for (const policy of state.policies) {
    if (typeof policy === 'string') lines.push(`Policy: ${policy}`)
  }
  return lines
}

function isEmptyContainer(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function describeValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}
