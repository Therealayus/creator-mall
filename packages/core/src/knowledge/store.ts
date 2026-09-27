import type {
  KnowledgeAnswer,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeFact,
  KnowledgeVersion,
  RetrievedChunk,
} from '../types/knowledge.js'
import type { KnowledgeStatus, TtlPolicy } from '../types/enums.js'
import { expiresAtFor } from '../verify/trust.js'
import { chunkText, embedText, estimateTokens } from './chunking.js'
import { LocalEmbeddingProvider } from './embedding-providers.js'
import type { EmbeddingProvider } from './embedding-providers.js'
import { nowIso, stableId } from '../util.js'

export interface UpsertDocumentInput {
  slug: string
  title: string
  topic: string
  platformId: string | null
  body: string
  sourceIds: string[]
  trustLevel: KnowledgeFact['trustLevel']
  confidence: number
  ttlPolicy?: TtlPolicy
  changeNote?: string
  createdBy?: KnowledgeDocument['updatedBy']
  eventId?: string | null
  clock?: () => number
}

export interface KnowledgeStore {
  documents: Map<string, KnowledgeDocument>
  versions: Map<string, KnowledgeVersion>
  chunks: Map<string, KnowledgeChunk>
  facts: Map<string, KnowledgeFact>
}

export function createKnowledgeStore(): KnowledgeStore {
  return {
    documents: new Map(),
    versions: new Map(),
    chunks: new Map(),
    facts: new Map(),
  }
}

/**
 * §14: knowledge is versioned, never overwritten. Publishing a new observation
 * creates version N+1 and marks version N as SUPERSEDED with a pointer back.
 */
export function upsertDocument(
  store: KnowledgeStore,
  input: UpsertDocumentInput,
): { document: KnowledgeDocument; version: KnowledgeVersion; fact: KnowledgeFact } {
  const clock = input.clock ?? Date.now
  const at = nowIso(clock)
  const existing = [...store.documents.values()].find((document) => document.slug === input.slug)
  const currentVersion = existing?.currentVersionId ? store.versions.get(existing.currentVersionId) : undefined
  const ttlPolicy = input.ttlPolicy ?? 'PLATFORM_GENERAL'

  const factId = stableId('fact', input.slug)
  const expiresAt = expiresAtFor(ttlPolicy, at)
  const fact: KnowledgeFact = {
    id: factId,
    key: `${input.slug}`,
    statement: input.title,
    value: input.body,
    platformId: input.platformId,
    sourceIds: input.sourceIds,
    trustLevel: input.trustLevel,
    confidence: input.confidence,
    observedAt: at,
    verifiedAt: input.trustLevel === 'OFFICIAL' || input.trustLevel === 'VERIFIED' ? at : null,
    status: 'CURRENT',
    expiresAt,
    supersededByFactId: null,
    evidence: truncate(input.changeNote ?? '', 200) || undefined,
  }
  const previousFact = store.facts.get(factId)
  if (previousFact) {
    previousFact.status = 'SUPERSEDED'
    previousFact.supersededByFactId = factId
  }
  store.facts.set(factId, fact)

  const versionNumber = (currentVersion?.version ?? 0) + 1
  const versionId = stableId('kv', input.slug, String(versionNumber))
  const version: KnowledgeVersion = {
    id: versionId,
    documentId: existing?.id ?? stableId('kd', input.slug),
    version: versionNumber,
    body: input.body,
    factIds: [factId],
    sourceIds: input.sourceIds,
    trustLevel: input.trustLevel,
    confidence: input.confidence,
    createdAt: at,
    publishedAt: at,
    verifiedAt: fact.verifiedAt,
    expiresAt,
    status: 'CURRENT',
    changeNote: input.changeNote ?? 'Refreshed from verified sources.',
    createdBy: input.createdBy ?? 'WORLD_ENGINE',
  }

  if (currentVersion) {
    currentVersion.status = 'SUPERSEDED'
    store.versions.set(currentVersion.id, currentVersion)
    removeChunksForVersion(store, currentVersion.id)
  }

  store.versions.set(version.id, version)
  for (const chunk of chunkText(input.body, { documentId: version.documentId, versionId: version.id, sourceIds: input.sourceIds, platformId: input.platformId, topic: input.topic })) {
    store.chunks.set(chunk.id, chunk)
  }

  const document: KnowledgeDocument = {
    id: version.documentId,
    slug: input.slug,
    title: input.title,
    topic: input.topic,
    platformId: input.platformId,
    currentVersionId: version.id,
    ttlPolicy,
    status: 'CURRENT',
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    updatedBy: input.createdBy ?? 'WORLD_ENGINE',
  }
  store.documents.set(document.id, document)

  return { document, version, fact }
}

function removeChunksForVersion(store: KnowledgeStore, versionId: string): void {
  for (const [id, chunk] of store.chunks) {
    if (chunk.versionId === versionId) store.chunks.delete(id)
  }
}

/** §15: TTL sweep. Expired knowledge is marked, never deleted. */
export function expireStaleKnowledge(store: KnowledgeStore, clock: () => number = Date.now): number {
  const now = new Date(clock()).getTime()
  let expired = 0
  for (const version of store.versions.values()) {
    if (version.status !== 'CURRENT' || !version.expiresAt) continue
    if (new Date(version.expiresAt).getTime() > now) continue
    version.status = 'EXPIRED'
    expired += 1
    const document = store.documents.get(version.documentId)
    if (document && document.currentVersionId === version.id) document.status = 'EXPIRED'
  }
  for (const fact of store.facts.values()) {
    if (fact.status !== 'CURRENT' || !fact.expiresAt) continue
    if (new Date(fact.expiresAt).getTime() > now) continue
    fact.status = 'EXPIRED'
  }
  return expired
}

export interface RetrieveInput {
  query: string
  limit?: number
  platformId?: string | null
  topic?: string
  clock?: () => number
}

/**
 * §13 + §30: the assistant answers from maintained knowledge, not from model
 * memory. Retrieval prefers CURRENT, non-expired chunks; stale knowledge is
 * returned only as a clearly-labelled fallback (§38 safe degradation).
 */
export function retrieveKnowledge(store: KnowledgeStore, input: RetrieveInput): KnowledgeAnswer {
  const clock = input.clock ?? Date.now
  const now = new Date(clock()).getTime()
  const limit = input.limit ?? 6
  const terms = tokenize(input.query)

  const scored: RetrievedChunk[] = []
  for (const chunk of store.chunks.values()) {
    const version = store.versions.get(chunk.versionId)
    if (!version) continue
    if (input.platformId && chunk.platformId && chunk.platformId !== input.platformId) continue
    if (input.topic && chunk.topic.toLowerCase() !== input.topic.toLowerCase()) continue

    const status: KnowledgeStatus = version.status
    const stale = status === 'EXPIRED' || (version.expiresAt ? new Date(version.expiresAt).getTime() <= now : false)
    if (status === 'RETRACTED') continue

    const base = lexicalScore(terms, chunk.text)
    if (base <= 0) continue
    const freshnessBoost = stale ? 0.6 : 1
    const statusBoost = status === 'CURRENT' ? 1.15 : status === 'SUPERSEDED' ? 0.75 : 0.7
    const trustBoost = version.trustLevel === 'OFFICIAL' ? 1.1 : version.trustLevel === 'VERIFIED' ? 1.05 : 1

    const document = store.documents.get(chunk.documentId)
    scored.push({
      chunk,
      score: Number((base * freshnessBoost * statusBoost * trustBoost).toFixed(4)),
      documentTitle: document?.title ?? 'Platform knowledge',
      version: version.version,
      versionStatus: version.status,
      stale,
      trustLevel: version.trustLevel,
      sourceIds: version.sourceIds,
    })
  }

  scored.sort((a, b) => b.score - a.score)

  const fresh = scored.filter((entry) => !entry.stale).slice(0, limit)
  const degraded = fresh.length === 0 && scored.length > 0
  const results = degraded ? scored.slice(0, limit) : fresh

  return {
    query: input.query,
    results,
    degraded,
    notice: degraded
      ? 'This answer uses older information we have not been able to re-verify yet.'
      : null,
  }
}

function lexicalScore(terms: string[], text: string): number {
  if (terms.length === 0) return 0
  const haystack = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (haystack.includes(term)) score += 1
  }
  return score / terms.length
}

/**
 * Embedding a knowledge base.
 *
 * A provider is optional: without one, the deterministic local provider keeps
 * retrieval, freshness and deactivation fully working offline. A provider
 * failure degrades to local rather than leaving the index incomplete.
 */
export async function embedPendingChunks(
  store: KnowledgeStore,
  options: { provider?: EmbeddingProvider; batchSize?: number; onFallback?: (reason: string) => void },
): Promise<{ embedded: number; skipped: number; fallbacks: string[] }> {
  const provider = options.provider ?? new LocalEmbeddingProvider()
  const batchSize = options.batchSize ?? 32
  const fallbacks: string[] = []

  const pending = [...store.chunks.values()]
    .filter((chunk) => chunk.embedding === null || chunk.embedding.provider !== provider.name)
    .sort((a, b) => (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : a.ordinal - b.ordinal))

  let embedded = 0
  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize)
    let vectors
    try {
      vectors = await provider.embedBatch(batch.map((chunk) => chunk.text))
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'embedding failed'
      fallbacks.push(reason)
      options.onFallback?.(reason)
      const local = new LocalEmbeddingProvider()
      vectors = await local.embedBatch(batch.map((chunk) => chunk.text))
    }
    batch.forEach((chunk, index) => {
      const vector = vectors[index]
      if (!vector) return
      chunk.embedding = vector
      embedded += 1
    })
  }

  return { embedded, skipped: pending.length - embedded, fallbacks: [...new Set(fallbacks)] }
}

export function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 2),
    ),
  ]
}

export { chunkText, embedText, estimateTokens }

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}
