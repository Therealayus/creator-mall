import type { LearnedPreference } from '../types/creator.js'
import { stableId } from '../util.js'

/**
 * Preference learning.
 *
 * §31: the system may learn from behaviour, but the creator stays in control.
 * Every learned preference therefore carries its own evidence, can be inspected
 * ("why am I seeing this?"), forgotten individually, or reset entirely.
 *
 * What it deliberately does *not* do: touch anything about the account, change
 * what is published, or learn from content the creator did not act on. It
 * adjusts defaults and recommendations, nothing else.
 */

export const MIN_OBSERVATIONS = 3
export const MAX_OBSERVATIONS = 200

export type ObservationKind =
  | 'OPTION_CHOSEN'
  | 'DRAFT_ACCEPTED'
  | 'DRAFT_EDITED'
  | 'DRAFT_REJECTED'
  | 'PLATFORM_ADDED'
  | 'PLATFORM_REMOVED'
  | 'LIMIT_WARNING_HIT'
  | 'UPDATE_OPENED'
  | 'UPDATE_DISMISSED'

export interface CreatorObservation {
  id: string
  creatorId: string
  kind: ObservationKind
  at: string
  /** What was acted on: an option key, a platform slug, a prompt hint… */
  subject: string
  detail: string | null
  platformSlug: string | null
}

/**
 * The behaviours worth learning from, and what they say.
 *
 * A weight above 1 means the signal is strong; below 1 means it is weak. An
 * observation that contradicts a learned preference is evidence *against* it.
 */
const PATTERNS: Array<{
  key: string
  label: string
  description: string
  kinds: readonly ObservationKind[]
  /** The signal to record from one observation, or null to ignore it. */
  derive: (observation: CreatorObservation) => { value: string; weight: number } | null
  /** Contradicting observation. */
  contradicts?: (observation: CreatorObservation) => boolean
  /** The minimum occurrences before the preference is worth surfacing. */
  threshold: number
}> = [
  {
    key: 'preferred-hook-style',
    label: 'Opening line style',
    description: 'Which way you open your posts, learned from what you keep.',
    kinds: ['DRAFT_ACCEPTED', 'DRAFT_EDITED'],
    derive: (observation) => {
      const style = /hook:([^;]+)/i.exec(observation.detail ?? '')?.[1]?.trim()
      return style ? { value: style, weight: 1 } : null
    },
    threshold: 3,
  },
  {
    key: 'preferred-length',
    label: 'Post length',
    description: 'How long your posts usually run.',
    kinds: ['DRAFT_ACCEPTED'],
    derive: (observation) => {
      const length = Number(/length:(\d+)/i.exec(observation.detail ?? '')?.[1] ?? '')
      if (!Number.isFinite(length) || length <= 0) return null
      return { value: length <= 400 ? 'short' : length <= 1500 ? 'medium' : 'long', weight: 1 }
    },
    threshold: 3,
  },
  {
    key: 'favourite-option',
    label: 'The option you reach for',
    description: 'The kind of post you make most often.',
    kinds: ['OPTION_CHOSEN'],
    derive: (observation) => (observation.subject ? { value: observation.subject, weight: 1 } : null),
    threshold: 3,
  },
  {
    key: 'hook-editing',
    label: 'You rewrite the opening',
    description: 'You often replace the suggested opening line.',
    kinds: ['DRAFT_EDITED'],
    derive: (observation) =>
      /edited:(hook|opening)/i.test(observation.detail ?? '') ? { value: 'rewrites-hooks', weight: 1 } : null,
    threshold: 4,
  },
  {
    key: 'platform-focus',
    label: 'Where you actually post',
    description: 'The platform you use most, learned from your own choices.',
    kinds: ['PLATFORM_ADDED', 'PLATFORM_REMOVED'],
    derive: (observation) =>
      observation.kind === 'PLATFORM_ADDED' && observation.platformSlug
        ? { value: observation.platformSlug, weight: 1 }
        : null,
    contradicts: (observation) => observation.kind === 'PLATFORM_REMOVED',
    threshold: 2,
  },
]

export interface PreferenceCounter {
  /** Stable identity: creator, pattern and value. */
  id: string
  creatorId: string
  key: string
  value: string
  weight: number
}

export interface PreferenceStore {
  observations: Map<string, CreatorObservation[]>
  preferences: Map<string, LearnedPreference>
  /**
   * Running tallies, kept flat so they survive serialisation.
   *
   * Counters are maintained incrementally rather than replayed from history:
   * replaying would let an old "yes" resurrect a belief we have since dropped
   * because of newer "no"s.
   */
  counters: PreferenceCounter[]
}

export function createPreferenceStore(): PreferenceStore {
  return { observations: new Map(), preferences: new Map(), counters: [] }
}

function counterId(creatorId: string, key: string, value: string): string {
  return `${creatorId}::${key}::${value}`
}

function countersFor(store: PreferenceStore, creatorId: string, key: string): PreferenceCounter[] {
  return store.counters.filter((counter) => counter.creatorId === creatorId && counter.key === key)
}

function adjustCounter(
  store: PreferenceStore,
  creatorId: string,
  key: string,
  value: string,
  delta: number,
): void {
  const id = counterId(creatorId, key, value)
  const existing = store.counters.find((counter) => counter.id === id)
  const weight = Math.max(0, (existing?.weight ?? 0) + delta)
  if (weight === 0) {
    store.counters = store.counters.filter((counter) => counter.id !== id)
    return
  }
  if (existing) {
    existing.weight = weight
    return
  }
  store.counters.push({ id, creatorId, key, value, weight })
}

function counterWeight(store: PreferenceStore, creatorId: string, key: string, value: string): number {
  return store.counters.find((counter) => counter.id === counterId(creatorId, key, value))?.weight ?? 0
}

function observationsFor(store: PreferenceStore, creatorId: string): CreatorObservation[] {
  const list = store.observations.get(creatorId) ?? []
  if (list.length === 0) store.observations.set(creatorId, list)
  return list
}

/** Records an observation and folds it into that creator's preferences. */
export function recordObservation(
  store: PreferenceStore,
  observation: CreatorObservation,
): { learned: LearnedPreference[]; changed: LearnedPreference[] } {
  const list = observationsFor(store, observation.creatorId)
  list.push(observation)
  if (list.length > MAX_OBSERVATIONS) list.splice(0, list.length - MAX_OBSERVATIONS)

  const changed: LearnedPreference[] = []

  for (const pattern of PATTERNS) {
    if (!pattern.kinds.includes(observation.kind)) continue

    const id = preferenceId(observation.creatorId, pattern.key)
    const previous = store.preferences.get(id)

    if (pattern.contradicts?.(observation)) {
      // A contradiction withdraws support from whatever we currently believe.
      const target = previous?.value ?? leadingValue(countersFor(store, observation.creatorId, pattern.key))
      if (target !== null) adjustCounter(store, observation.creatorId, pattern.key, target, -1)
    } else {
      const derived = pattern.derive(observation)
      if (derived) adjustCounter(store, observation.creatorId, pattern.key, derived.value, derived.weight)
    }

    const value = leadingValue(countersFor(store, observation.creatorId, pattern.key))
    const occurrences = value === null ? 0 : counterWeight(store, observation.creatorId, pattern.key, value)

    // The pattern no longer holds often enough to trust: stop believing it.
    if (value === null || occurrences < pattern.threshold) {
      if (store.preferences.delete(id) && previous) changed.push({ ...previous, occurrences })
      continue
    }

    const supporting = list
      .filter((entry) => pattern.kinds.includes(entry.kind) && pattern.derive(entry)?.value === value)
      .slice(-3)
      .map((entry) => `${entry.kind.replace(/_/g, ' ').toLowerCase()} on ${entry.subject}`)

    const switched = previous !== undefined && previous.value !== value
    const next: LearnedPreference = {
      id,
      creatorId: observation.creatorId,
      key: pattern.key,
      value,
      label: pattern.label,
      description: pattern.description,
      evidence: supporting,
      confidence: confidenceFor(occurrences, switched),
      learnedAt: previous?.learnedAt ?? observation.at,
      occurrences,
      enabled: previous?.enabled ?? true,
    }
    store.preferences.set(id, next)
    if (switched) changed.push(next)
  }

  return { learned: listPreferences(store, observation.creatorId), changed }
}

function leadingValue(counters: ReadonlyArray<{ value: string; weight: number }>): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const counter of counters) {
    if (counter.weight > bestCount || (counter.weight === bestCount && best !== null && counter.value < best)) {
      best = counter.value
      bestCount = counter.weight
    }
  }
  return best
}

/** More examples means more confidence; a recent reversal means less. */
function confidenceFor(occurrences: number, switched: boolean): number {
  const base = Math.min(0.95, occurrences / (occurrences + MIN_OBSERVATIONS))
  return Number(Math.max(0.05, switched ? base * 0.7 : base).toFixed(2))
}

function preferenceId(creatorId: string, key: string): string {
  return stableId('pref', creatorId, key)
}

export function listPreferences(store: PreferenceStore, creatorId: string): LearnedPreference[] {
  return [...store.preferences.values()]
    .filter((preference) => preference.creatorId === creatorId)
    .sort((a, b) => b.occurrences - a.occurrences || a.key.localeCompare(b.key))
}

export function listObservations(store: PreferenceStore, creatorId: string): CreatorObservation[] {
  return [...(store.observations.get(creatorId) ?? [])].sort((a, b) => b.at.localeCompare(a.at))
}

/** §31: "forget this one". The record goes; the behaviour starts again. */
export function forgetPreference(store: PreferenceStore, preferenceId: string): boolean {
  return store.preferences.delete(preferenceId)
}

export function setPreferenceEnabled(
  store: PreferenceStore,
  preferenceId: string,
  enabled: boolean,
): LearnedPreference | undefined {
  const preference = store.preferences.get(preferenceId)
  if (!preference) return undefined
  const next = { ...preference, enabled }
  store.preferences.set(preferenceId, next)
  return next
}

/** §31: "reset personalization". Wipes preferences *and* the observations. */
export function resetPersonalization(store: PreferenceStore, creatorId: string): { preferences: number; observations: number } {
  const preferences = listPreferences(store, creatorId).length
  const observations = (store.observations.get(creatorId) ?? []).length
  store.observations.set(creatorId, [])
  for (const preference of listPreferences(store, creatorId)) {
    store.preferences.delete(preference.id)
    // Counters go too: a reset means we start learning from scratch.
    store.counters = store.counters.filter((counter) => counter.creatorId !== creatorId)
  }
  return { preferences, observations }
}

export interface Recommendation {
  key: string
  label: string
  value: string
  why: string
  confidence: number
}

/**
 * What the system would suggest, and why. A disabled preference is never used,
 * which is what makes the "turn it off" control meaningful.
 */
export function recommendations(store: PreferenceStore, creatorId: string): Recommendation[] {
  return listPreferences(store, creatorId)
    .filter((preference) => preference.enabled)
    .map((preference) => ({
      key: preference.key,
      label: preference.label,
      value: preference.value,
      why: preference.evidence.length > 0 ? `You ${preference.evidence[0]}.` : preference.description,
      confidence: preference.confidence,
    }))
}

export function isLearningEnabled(store: PreferenceStore, creatorId: string): boolean {
  return listPreferences(store, creatorId).length > 0
}
