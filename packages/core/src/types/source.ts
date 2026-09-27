import type { SourceType, TrustLevel } from './enums.js'

/**
 * What a source has actually produced, over its whole life.
 *
 * Lives on the record rather than in a parallel counter, so curation can answer
 * "is this source earning its place?" from one place, and the history survives
 * a restart.
 */
export interface SourceStats {
  checks: number
  successes: number
  failures: number
  blocked: number
  /** Accepted claims this source has contributed. */
  factsContributed: number
  /** Change events this source has contributed. */
  eventsContributed: number
  lastFactAt: string | null
}

export const EMPTY_SOURCE_STATS: SourceStats = {
  checks: 0,
  successes: 0,
  failures: 0,
  blocked: 0,
  factsContributed: 0,
  eventsContributed: 0,
  lastFactAt: null,
}

/** §4: every knowledge item keeps its sources, and every source is scheduled. */
export interface Source {
  id: string
  name: string
  url: string
  domain: string
  sourceType: SourceType
  /** Platform slug this source speaks for, when applicable. */
  platform: string | null
  trustLevel: TrustLevel
  /** Who proposed this source; discovered sources start unverified. */
  discoveredVia: 'SEED' | 'DISCOVERY' | 'ADMIN' | 'CREATOR'
  lastCheckedAt: string | null
  nextCheckAt: string | null
  active: boolean
  /** Filled in by the fetcher; drives freshness and failure behaviour (§38). */
  lastStatus: 'NEVER_CHECKED' | 'OK' | 'NOT_MODIFIED' | 'FAILED' | 'BLOCKED'
  lastError?: string
  consecutiveFailures: number
  etag?: string
  lastModified?: string
  contentHash?: string
  /** Lifetime contribution history, used to curate the registry. */
  stats?: SourceStats
}

export interface SourceHealth {
  sourceId: string
  status: 'HEALTHY' | 'DEGRADED' | 'FAILING' | 'UNKNOWN'
  consecutiveFailures: number
  lastCheckedAt: string | null
  message?: string
}

export interface FetchRequest {
  url: string
  sourceId: string
  etag?: string
  lastModified?: string
  timeoutMs: number
  maxBytes: number
}

export type FetchOutcome =
  | { status: 'OK'; url: string; body: string; contentType: string; etag?: string; lastModified?: string; fetchedAt: string; elapsedMs: number }
  | { status: 'NOT_MODIFIED'; url: string; fetchedAt: string; elapsedMs: number }
  | { status: 'FAILED'; url: string; reason: string; retryable: boolean; fetchedAt: string; elapsedMs: number }
  | { status: 'BLOCKED'; url: string; reason: string; fetchedAt: string; elapsedMs: number }

export interface FetchedDocument {
  url: string
  finalUrl: string
  title: string | null
  text: string
  links: string[]
  headings: string[]
  contentType: string
  fetchedAt: string
}
