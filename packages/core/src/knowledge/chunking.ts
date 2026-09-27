import type { Embedding, KnowledgeChunk } from '../types/knowledge.js'
import { stableId, nowIso } from '../util.js'

/** Rough token estimate; deliberately dependency-free. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export interface ChunkMeta {
  documentId: string
  versionId: string
  sourceIds: string[]
  platformId: string | null
  topic: string
  targetChars?: number
}

/**
 * Paragraph-aligned chunking.
 *
 * Each paragraph becomes its own chunk so retrieval stays precise ("carousel
 * limits" must not drag in unrelated paragraphs); paragraphs longer than the
 * target are split on sentence boundaries, never mid-word.
 */
export function chunkText(body: string, meta: ChunkMeta): KnowledgeChunk[] {
  const target = meta.targetChars ?? 480
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)

  const chunks: KnowledgeChunk[] = []
  let ordinal = 0

  for (const paragraph of paragraphs) {
    if (paragraph.length > target) {
      let buffer = ''
      for (const sentence of splitSentences(paragraph)) {
        if ((`${buffer} ${sentence}`).trim().length > target && buffer.trim()) {
          chunks.push(makeChunk(buffer.trim(), ordinal++, meta))
          buffer = ''
        }
        buffer = buffer.trim() ? `${buffer.trim()} ${sentence}` : sentence
      }
      if (buffer.trim()) chunks.push(makeChunk(buffer.trim(), ordinal++, meta))
      continue
    }
    chunks.push(makeChunk(paragraph, ordinal++, meta))
  }

  return chunks
}

function makeChunk(text: string, ordinal: number, meta: ChunkMeta): KnowledgeChunk {
  return {
    id: stableId('kc', meta.versionId, String(ordinal)),
    versionId: meta.versionId,
    documentId: meta.documentId,
    ordinal,
    text,
    tokenEstimate: estimateTokens(text),
    embedding: embedText(text),
    sourceIds: meta.sourceIds,
    platformId: meta.platformId,
    topic: meta.topic,
  }
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * Offline embedding provider.
 *
 * A real vector model plugs in behind `EmbeddingProvider`; Phase 1 ships a
 * deterministic hashed bag-of-words projection so retrieval, freshness and
 * deactivation paths are fully testable with no API key and no data leaving the
 * machine. Nothing user-private is ever sent to a third party by default.
 */
export class LocalHashEmbeddingProvider {
  readonly name = 'local-hash-v1'
  readonly model = 'hashed-bow-256'
  readonly dimensions = 256

  embed(text: string): Embedding {
    const vector = new Array<number>(this.dimensions).fill(0)
    const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length > 2)
    for (const token of tokens) {
      const bucket = hashBucket(token, this.dimensions)
      vector[bucket] = (vector[bucket] ?? 0) + 1
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
    return {
      provider: this.name,
      model: this.model,
      dimensions: this.dimensions,
      vector: vector.map((value) => Number((value / norm).toFixed(6))),
      createdAt: nowIso(),
    }
  }

  similarity(a: Embedding, b: Embedding): number {
    if (a.dimensions !== b.dimensions) return 0
    let dot = 0
    for (let index = 0; index < a.dimensions; index += 1) {
      dot += (a.vector[index] ?? 0) * (b.vector[index] ?? 0)
    }
    return Number(dot.toFixed(4))
  }
}

export function embedText(text: string): Embedding {
  return new LocalHashEmbeddingProvider().embed(text)
}

function hashBucket(token: string, dimensions: number): number {
  let hash = 2166136261
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % dimensions
}
