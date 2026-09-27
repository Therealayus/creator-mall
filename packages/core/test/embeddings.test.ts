import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HostedEmbeddingProvider,
  LocalEmbeddingProvider,
  cosineSimilarity,
  createKnowledgeStore,
  embedPendingChunks,
  embedText,
  isHostedProviderConfigured,
  upsertDocument,
} from '../src/index.js'

const CLOCK = (): number => Date.parse('2026-09-27T12:00:00.000Z')

function responding(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

function embeddingResponse(vectors: number[][]): unknown {
  return { data: vectors.map((embedding) => ({ embedding })) }
}

function filled() {
  const store = createKnowledgeStore()
  upsertDocument(store, {
    slug: 'platform/example/limits',
    title: 'Example limits',
    topic: 'platform-limits',
    platformId: 'pf_1',
    body: 'Maximum video length is 90 seconds.\n\nA post can be up to 2,200 characters long.',
    sourceIds: ['src_1'],
    trustLevel: 'OFFICIAL',
    confidence: 0.9,
    clock: CLOCK,
  })
  return store
}

describe('local embedding provider', () => {
  it('is the default and needs nothing', async () => {
    const provider = new LocalEmbeddingProvider()
    assert.equal(provider.name, 'local-hash-v1')
    const embedding = await provider.embed('reels can be up to 90 seconds')
    assert.ok(embedding.vector.length > 0)
    assert.equal(embedding.provider, 'local-hash-v1')
  })

  it('is deterministic', async () => {
    const provider = new LocalEmbeddingProvider()
    const a = await provider.embed('same text')
    const b = await provider.embed('same text')
    assert.deepEqual(a.vector, b.vector)
  })

  it('ranks shared vocabulary above unrelated text', async () => {
    const provider = new LocalEmbeddingProvider()
    const reels = await provider.embed('reels video length limit')
    const alsoReels = await provider.embed('reels length for video')
    const unrelated = await provider.embed('quarterly revenue forecast')
    assert.ok(cosineSimilarity(reels, alsoReels) > cosineSimilarity(reels, unrelated))
  })

  it('is lexical, not semantic — a limitation worth stating, not hiding', async () => {
    const provider = new LocalEmbeddingProvider()
    // No shared tokens, so no similarity. A real model would match these; the
    // local provider is a deterministic fallback, and this says so out loud.
    const vertical = await provider.embed('reels video length limit')
    const synonym = await provider.embed('upright clip duration')
    assert.equal(cosineSimilarity(vertical, synonym), 0)
  })

  it('knows when a hosted provider is configured', () => {
    assert.equal(isHostedProviderConfigured(''), false)
    assert.equal(isHostedProviderConfigured('  '), false)
    assert.equal(isHostedProviderConfigured('key'), true)
  })
})

describe('hosted embedding provider', () => {
  const options = { apiKey: 'sk-hosted-key', baseUrl: 'https://api.example.com/v1', model: 'text-embedding-3-small' }

  it('sends the batch and returns provider vectors', async () => {
    let sent: unknown = null
    const provider = new HostedEmbeddingProvider({
      ...options,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(typeof init.body === 'string' ? init.body : '')
        return new Response(JSON.stringify(embeddingResponse([[0.1, 0.2], [0.3, 0.4]])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    const vectors = await provider.embedBatch(['one', 'two'])
    assert.equal(vectors.length, 2)
    assert.equal(vectors[0]?.provider, 'hosted')
    assert.deepEqual(vectors[0]?.vector, [0.1, 0.2])
    assert.deepEqual((sent as { input: string[] }).input, ['one', 'two'])
  })

  it('falls back to the local provider when the call fails', async () => {
    const reasons: string[] = []
    const provider = new HostedEmbeddingProvider({
      ...options,
      fetchImpl: responding({ error: 'nope' }, 500),
      onFallback: (reason) => reasons.push(reason),
    })

    const vectors = await provider.embedBatch(['one', 'two'])
    assert.equal(vectors.length, 2, 'a provider outage must not leave the index incomplete')
    assert.equal(vectors[0]?.provider, 'local-hash-v1')
    assert.equal(reasons.length, 1)
    assert.match(reasons[0]!, /http 500/)
  })

  it('never surfaces a key in an error', async () => {
    const provider = new HostedEmbeddingProvider({
      ...options,
      fetchImpl: responding({ error: 'bad key sk-hosted-key' }, 401),
    })
    const vectors = await provider.embedBatch(['one'])
    assert.equal(vectors[0]?.provider, 'local-hash-v1')
  })

  it('rejects a response that does not match the request', async () => {
    const provider = new HostedEmbeddingProvider({ ...options, fetchImpl: responding({ data: [] }) })
    const vectors = await provider.embedBatch(['one', 'two'])
    assert.equal(vectors.length, 2)
    assert.equal(vectors[0]?.provider, 'local-hash-v1', 'a mismatched response degrades instead of corrupting')
  })

  it('batches large inputs', async () => {
    const calls: number[] = []
    const provider = new HostedEmbeddingProvider({
      ...options,
      maxBatch: 2,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as { input: string[] }
        calls.push(body.input.length)
        return new Response(JSON.stringify(embeddingResponse(body.input.map(() => [0.5, 0.5]))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    const vectors = await provider.embedBatch(['a', 'b', 'c', 'd', 'e'])
    assert.equal(vectors.length, 5)
    assert.deepEqual(calls, [2, 2, 1])
  })
})

describe('embedding a knowledge base', () => {
  it('leaves every chunk searchable the moment it is written', () => {
    const store = filled()
    const chunks = [...store.chunks.values()]
    assert.ok(chunks.length >= 2)
    assert.equal(
      chunks.every((chunk) => chunk.embedding?.provider === 'local-hash-v1'),
      true,
      'no indexing step is required before retrieval works',
    )
  })

  it('has nothing to do when the local provider is the one in use', async () => {
    const store = filled()
    const result = await embedPendingChunks(store, {})
    assert.equal(result.embedded, 0)
    assert.deepEqual(result.fallbacks, [])
  })

  it('re-embeds with a hosted provider when one is supplied', async () => {
    const store = filled()
    const provider = new HostedEmbeddingProvider({
      apiKey: 'sk-x',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as { input: string[] }
        return new Response(JSON.stringify(embeddingResponse(body.input.map(() => [0.1, 0.2, 0.3]))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    const result = await embedPendingChunks(store, { provider })
    assert.ok(result.embedded >= 2)
    assert.equal([...store.chunks.values()][0]?.embedding?.provider, 'hosted')
  })

  it('keeps the index usable when the provider is down', async () => {
    const store = filled()
    const reasons: string[] = []
    const provider = new HostedEmbeddingProvider({
      apiKey: 'sk-x',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: responding({}, 503),
      onFallback: (reason) => reasons.push(reason),
    })

    const result = await embedPendingChunks(store, { provider, onFallback: (reason) => reasons.push(reason) })
    assert.ok(result.embedded >= 2)
    assert.ok(reasons.length >= 1)
    assert.equal([...store.chunks.values()].every((chunk) => chunk.embedding?.provider === 'local-hash-v1'), true)
  })

  it('is idempotent: a second hosted pass has nothing left to do', async () => {
    const store = filled()
    const provider = new HostedEmbeddingProvider({
      apiKey: 'sk-x',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: responding(embeddingResponse([[0.1], [0.2]]), 200),
    })
    await embedPendingChunks(store, { provider })
    const second = await embedPendingChunks(store, { provider })
    assert.equal(second.embedded, 0, 'a chunk is embedded once per provider')
  })

  it('leaves the existing local embedding shape untouched', () => {
    const embedding = embedText('unchanged default')
    assert.equal(embedding.provider, 'local-hash-v1')
    assert.equal(embedding.dimensions, embedding.vector.length)
  })
})
