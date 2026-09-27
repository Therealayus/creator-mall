import type { PlatformState, JsonObject, JsonValue, PlatformSnapshot } from '../types/platform.js'
import type { RiskLevel, StateDelta, StateDeltaLike } from './types.js'
import { canonicalJson, hashString } from '../util.js'
import { classifyDelta } from './classify.js'

/** Generic structural diff over JSON-ish values. Returns leaf-level deltas. */
export function diffValues(before: JsonValue | undefined, after: JsonValue | undefined, path: string): StateDeltaLike[] {
  if (canonicalJson(before) === canonicalJson(after)) return []

  const beforeIsObject = isPlainObject(before)
  const afterIsObject = isPlainObject(after)

  if (beforeIsObject && afterIsObject) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    const deltas: StateDeltaLike[] = []
    for (const key of [...keys].sort()) {
      deltas.push(...diffValues(before[key], after[key], path ? `${path}.${key}` : key))
    }
    return deltas
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (canonicalJson([...before].sort()) === canonicalJson([...after].sort())) return []
    return [{ path, kind: 'CHANGED', before, after }]
  }

  const kind = before === undefined ? 'ADDED' : after === undefined ? 'REMOVED' : 'CHANGED'
  return [{ path, kind, before, after }]
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function emptyPlatformState(): PlatformState {
  return {
    capabilities: {},
    limits: {},
    mediaSpecs: {},
    publishing: {},
    api: {},
    analytics: {},
    monetization: {},
    requirements: {},
    policies: [],
    notes: [],
  }
}

export function hashState(state: PlatformState): string {
  return hashString(canonicalJson(state))
}

export interface DiffOptions {
  /** Paths to ignore entirely (e.g. volatile "lastFetchedAt" style fields). */
  ignorePaths?: readonly string[]
}

/**
 * §6: previous snapshot + current snapshot → difference.
 * Old knowledge is never destroyed; the diff is the only way change is described.
 */
export function diffPlatformStates(
  platformId: string,
  previous: PlatformState | null,
  current: PlatformState,
  options: DiffOptions = {},
): {
  previousSnapshotId: string | null
  currentSnapshotId: string
  deltas: StateDelta[]
  addedPaths: string[]
  removedPaths: string[]
  changedPaths: string[]
  highestRisk: RiskLevel
} {
  const ignore = new Set(options.ignorePaths ?? [])
  const raw = diffValues((previous ?? emptyPlatformState()) as unknown as JsonValue, current as unknown as JsonValue, '')
  const deltas: StateDelta[] = []

  for (const delta of raw) {
    if (ignore.has(delta.path)) continue
    const classified = classifyDelta(delta)
    if (!classified) continue
    deltas.push({ ...delta, ...classified })
  }

  const rank: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }
  const highestRisk = deltas.reduce<RiskLevel>(
    (acc, delta) => (rank[delta.riskLevel] > rank[acc] ? delta.riskLevel : acc),
    'LOW',
  )

  return {
    previousSnapshotId: null,
    currentSnapshotId: '',
    deltas,
    addedPaths: deltas.filter((d) => d.kind === 'ADDED').map((d) => d.path),
    removedPaths: deltas.filter((d) => d.kind === 'REMOVED').map((d) => d.path),
    changedPaths: deltas.filter((d) => d.kind === 'CHANGED').map((d) => d.path),
    highestRisk,
  }
}

export function diffSnapshots(
  platformId: string,
  previous: PlatformSnapshot | null,
  current: PlatformSnapshot,
  options: DiffOptions = {},
): ReturnType<typeof diffPlatformStates> & { previousSnapshotId: string | null; currentSnapshotId: string } {
  const result = diffPlatformStates(platformId, previous?.state ?? null, current.state, options)
  return {
    ...result,
    previousSnapshotId: previous?.id ?? null,
    currentSnapshotId: current.id,
  }
}

/** Convenience for tests and manual verification commands. */
export function describeDelta(delta: StateDelta): string {
  const value = (input: JsonValue | undefined): string => (input === undefined ? '—' : JSON.stringify(input))
  return `${delta.path}: ${value(delta.before)} → ${value(delta.after)} (${delta.category}, ${delta.riskLevel})`
}
