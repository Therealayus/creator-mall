import type { Embedding } from '../types/knowledge.js'
import { LocalHashEmbeddingProvider as LocalHashProvider } from './chunking.js'
import { nowIso } from '../util.js'

/**
 * Embedding providers.
 *
 * The local provider is the default and always available: no key, no network,
 * no data leaving the machine. A hosted provider is opt-in and sits behind the
 * same interface, so retrieval, freshness and deactivation paths are identical
 * whichever one is in use.
 */

export interface EmbeddingProvider {
  readonly name: string
  readonly model: string
  readonly dimensions: number
  embed(text: string): Promise<Embedding>
  embedBatch(texts: readonly string[]): Promise<Embedding[]>
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-hash-v1'

  private readonly inner: LocalHashProvider = new LocalHashProvider()

  constructor(inner: LocalHashProvider = new LocalHashProvider()) {
    this.inner = inner
  }

  get model(): string {
    return this.inner.model
  }

  get dimensions(): number {
    return this.inner.dimensions
  }

  embed(text: string): Promise<Embedding> {
    return Promise.resolve(this.inner.embed(text))
  }

  embedBatch(texts: readonly string[]): Promise<Embedding[]> {
    return Promise.resolve(texts.map((text) => this.inner.embed(text)))
  }

  similarity(a: Embedding, b: Embedding): number {
    return this.inner.similarity(a, b)
  }
}

export interface HostedProviderOptions {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs?: number
  maxBatch?: number
  fetchImpl?: typeof fetch
  /** Called with a short, key-free reason when a call fails. */
  onFallback?: (reason: string) => void
}

export class HostedEmbeddingError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'HostedEmbeddingError'
    this.status = status
  }
}

/**
 * An OpenAI-compatible embeddings endpoint (OpenRouter and most hosted
 * embedding services speak this shape).
 *
 * Failure is never fatal: `embed` falls back to the local provider so a
 * knowledge base is never left unindexed because a provider is down.
 */
export class HostedEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hosted'
  readonly model: string
  private readonly config: HostedProviderOptions
  private readonly fallback = new LocalEmbeddingProvider()
  private readonly fetchImpl: typeof fetch
  private dimensionsCache: number | null = null

  constructor(options: HostedProviderOptions) {
    this.config = options
    this.model = options.model
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get dimensions(): number {
    return this.dimensionsCache ?? 0
  }

  async embed(text: string): Promise<Embedding> {
    const [embedding] = await this.embedBatch([text])
    return embedding ?? this.fallback.embed(text)
  }

  async embedBatch(texts: readonly string[]): Promise<Embedding[]> {
    if (texts.length === 0) return []
    const batchSize = this.config.maxBatch ?? 64
    const results: Embedding[] = []

    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize)
      try {
        results.push(...(await this.call(batch)))
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'embedding call failed'
        this.config.onFallback?.(reason)
        // Degrade rather than lose: the local provider keeps the index usable.
        results.push(...(await this.fallback.embedBatch(batch)))
      }
    }
    return results
  }

  private async call(batch: readonly string[]): Promise<Embedding[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000)

    try {
      const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: this.config.model, input: [...batch] }),
      })

      if (!response.ok) {
        // The body can echo the key, so only the status is surfaced.
        throw new HostedEmbeddingError(`embedding call returned http ${response.status}`, response.status)
      }

      const payload: unknown = await response.json().catch(() => null)
      const data = (payload as { data?: Array<{ embedding?: unknown }> } | null)?.data
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new HostedEmbeddingError('embedding response did not match the request')
      }

      this.dimensionsCache = Array.isArray(data[0]?.embedding) ? data[0].embedding.length : null
      const at = nowIso()
      return data.map((entry) => ({
        provider: this.name,
        model: this.config.model,
        dimensions: Array.isArray(entry.embedding) ? entry.embedding.length : 0,
        vector: (Array.isArray(entry.embedding) ? entry.embedding : []).map((value) => Number(value)),
        createdAt: at,
      }))
    } catch (error) {
      if (error instanceof HostedEmbeddingError) throw error
      throw new HostedEmbeddingError(
        error instanceof Error && error.name === 'AbortError' ? 'embedding call timed out' : 'embedding call failed',
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

export function isHostedProviderConfigured(apiKey: string): boolean {
  return apiKey.trim().length > 0
}

/** Cosine similarity across providers, used for ranking and for tests. */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.dimensions !== b.dimensions || a.dimensions === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.dimensions; index += 1) {
    const left = a.vector[index] ?? 0
    const right = b.vector[index] ?? 0
    dot += left * right
    normA += left * left
    normB += right * right
  }
  if (normA === 0 || normB === 0) return 0
  return Number((dot / (Math.sqrt(normA) * Math.sqrt(normB))).toFixed(4))
}
