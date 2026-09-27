import type { SourceType, TrustLevel } from './enums.js'

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
