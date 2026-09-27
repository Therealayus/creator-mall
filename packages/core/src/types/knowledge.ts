import type { JsonValue } from './platform.js'
import type { KnowledgeStatus, TtlPolicy, TrustLevel } from './enums.js'

/**
 * A single verifiable statement about the ecosystem (§14).
 * Facts are never overwritten: a new observation creates a new fact version and
 * the previous one becomes SUPERSEDED.
 */
export interface KnowledgeFact {
  id: string
  /** Stable identity of the claim across versions (e.g. "instagram:limits.video.maxDurationSeconds"). */
  key: string
  statement: string
  value: JsonValue
  platformId: string | null
  sourceIds: string[]
  trustLevel: TrustLevel
  confidence: number
  observedAt: string
  verifiedAt: string | null
  status: KnowledgeStatus
  expiresAt: string | null
  supersededByFactId: string | null
  /** Short verbatim evidence supporting the claim, for the "why?" view. */
  evidence?: string
}

export interface KnowledgeDocument {
  id: string
  slug: string
  title: string
  topic: string
  platformId: string | null
  currentVersionId: string | null
  ttlPolicy: TtlPolicy
  status: KnowledgeStatus
  createdAt: string
  updatedAt: string
  updatedBy: 'WORLD_ENGINE' | 'ADMIN' | 'CREATOR' | 'IMPORT'
}

export interface KnowledgeVersion {
  id: string
  documentId: string
  version: number
  body: string
  factIds: string[]
  sourceIds: string[]
  trustLevel: TrustLevel
  confidence: number
  createdAt: string
  publishedAt: string | null
  verifiedAt: string | null
  expiresAt: string | null
  status: KnowledgeStatus
  changeNote: string
  createdBy: 'WORLD_ENGINE' | 'ADMIN' | 'CREATOR' | 'IMPORT'
}

export interface KnowledgeChunk {
  id: string
  versionId: string
  documentId: string
  ordinal: number
  text: string
  tokenEstimate: number
  embedding: Embedding | null
  sourceIds: string[]
  platformId: string | null
  topic: string
}

export interface Embedding {
  provider: string
  model: string
  dimensions: number
  vector: number[]
  createdAt: string
}

export interface KnowledgeChange {
  id: string
  documentId: string
  fromVersionId: string | null
  toVersionId: string
  changeType: 'CREATED' | 'UPDATED' | 'EXPIRED' | 'RETRACTED' | 'SUPERSEDED'
  at: string
  reason: string
  sourceIds: string[]
  eventId: string | null
}

export interface RetrievedChunk {
  chunk: KnowledgeChunk
  score: number
  documentTitle: string
  version: number
  versionStatus: KnowledgeStatus
  stale: boolean
  trustLevel: TrustLevel
  sourceIds: string[]
}

export interface KnowledgeAnswer {
  query: string
  results: RetrievedChunk[]
  /** True when nothing current was found and stale knowledge was used instead. */
  degraded: boolean
  notice: string | null
}
