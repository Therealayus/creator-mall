import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyPlatformState } from '@creator-mall/core'
import type { PlatformState } from '@creator-mall/core'
import type { HttpAdapterDefinition } from '../src/adapters/registry.js'
import { AdapterRegistry, HttpPlatformAdapter, SimulatedPlatformAdapter, buildAdapterRegistry, publishingEnabled } from '../src/adapters/registry.js'
import { readPath } from '../src/adapters/http-adapter.js'
import { ControlPlane } from '../src/store/control-plane.js'

function state(overrides: Partial<PlatformState> = {}): PlatformState {
  return {
    ...emptyPlatformState(),
    capabilities: {
      SHORT_VIDEO: { capabilityKey: 'SHORT_VIDEO', state: 'ACTIVE', confidence: 0.9, sourceIds: ['src_1'] },
    },
    limits: { video: { maxDurationSeconds: 15 } },
    ...overrides,
  }
}

const definition: HttpAdapterDefinition = {
  platformSlug: 'example',
  baseUrl: 'https://api.example.com/v2',
  publish: { path: '/me/media', method: 'POST' },
  schedule: { path: '/me/scheduled', method: 'POST' },
  analytics: { path: '/me/insights', method: 'GET' },
  fieldMap: { caption: 'caption', mediaIds: 'media_ids', scheduledAt: 'publish_at', accountId: 'ig_user_id' },
  responseIdPath: 'data.0.id',
  auth: { kind: 'BEARER', envVar: 'EXAMPLE_TOKEN' },
  notes: 'test definition',
}

function adapter(options: { credential?: string | null; fetchImpl?: typeof fetch } = {}): HttpPlatformAdapter {
  return new HttpPlatformAdapter({
    definition,
    state: state(),
    declaredCapabilityKeys: ['SHORT_VIDEO', 'TEXT_POST'],
    credentialFor: () => (options.credential === undefined ? 'secret-token' : options.credential),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
}

function responding(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

describe('http publishing adapter', () => {
  it('is a live integration only when a definition exists', () => {
    assert.equal(adapter().kind, 'LIVE')
    const registry = new AdapterRegistry()
    registry.register(adapter())
    assert.equal(registry.get('example')?.kind, 'LIVE')
    assert.equal(new AdapterRegistry().resolve('unknown', null).kind, 'SIMULATED')
  })

  it('maps our content onto the platform body using the definition', async () => {
    let seen: { url: string; body: unknown; headers: Record<string, string> } | null = null
    const http = adapter({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = {
          url,
          body: JSON.parse(typeof init.body === 'string' ? init.body : ''),
          headers: init.headers as Record<string, string>,
        }
        return new Response(JSON.stringify({ data: [{ id: 'media_123' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    const result = await http.publish({
      contentType: 'SHORT_VIDEO',
      text: 'hello world',
      mediaRefs: ['m1', 'm2'],
      accountRef: 'acct_1',
      scheduledAt: '2026-09-28T10:00:00.000Z',
      idempotencyKey: 'k1',
    })

    assert.equal(result.ok, true)
    assert.equal(result.platformContentRef, 'media_123')
    assert.equal(result.simulated, undefined, 'a live result is not marked simulated')
    assert.equal(seen!.url, 'https://api.example.com/v2/me/media')
    assert.deepEqual(seen!.body, {
      caption: 'hello world',
      media_ids: ['m1', 'm2'],
      publish_at: '2026-09-28T10:00:00.000Z',
      ig_user_id: 'acct_1',
    })
    assert.equal(seen!.headers.authorization, 'Bearer secret-token')
  })

  it('refuses to publish when there is no credential, and never echoes one', async () => {
    const http = adapter({ credential: null })
    const result = await http.publish({ contentType: 'SHORT_VIDEO', mediaRefs: [], accountRef: 'a', idempotencyKey: 'k' })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /EXAMPLE_TOKEN/)
    assert.equal((result.error ?? '').includes('secret'), false)
  })

  it('does not surface a platform body that might contain the credential', async () => {
    const http = adapter({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'bad token secret-token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })
    const result = await http.publish({ contentType: 'SHORT_VIDEO', mediaRefs: [], accountRef: 'a', idempotencyKey: 'k' })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /http 401/)
    assert.equal((result.error ?? '').includes('secret-token'), false)
  })

  it('treats a 5xx or a rate limit as retryable, and a 4xx as final', async () => {
    const server = adapter({ fetchImpl: responding({}, 503) })
    assert.match((await server.publish({ contentType: 'SHORT_VIDEO', mediaRefs: [], accountRef: 'a', idempotencyKey: 'k' })).error ?? '', /retry later/)

    const limited = adapter({ fetchImpl: responding({}, 429) })
    assert.match((await limited.publish({ contentType: 'SHORT_VIDEO', mediaRefs: [], accountRef: 'a', idempotencyKey: 'k' })).error ?? '', /retry later/)

    const rejected = adapter({ fetchImpl: responding({}, 400) })
    assert.match((await rejected.publish({ contentType: 'SHORT_VIDEO', mediaRefs: [], accountRef: 'a', idempotencyKey: 'k' })).error ?? '', /rejected the request/)
  })

  it('validates against verified limits, not against platform-specific code', async () => {
    const http = adapter()
    const over = await http.validateContent({ contentType: 'TEXT_POST', text: 'a'.repeat(5000), mediaRefs: [] })
    assert.equal(over.valid, true, 'no verified character limit for this snapshot')

    const withLimit = new HttpPlatformAdapter({
      definition,
      state: state({ limits: { text: { maxCharacters: 100 } } }),
      declaredCapabilityKeys: ['TEXT_POST'],
      credentialFor: () => 'token',
    })
    const result = await withLimit.validateContent({ contentType: 'TEXT_POST', text: 'a'.repeat(200), mediaRefs: [] })
    assert.equal(result.valid, false)
    assert.match(result.issues[0]?.message ?? '', /allows 100/)
  })

  it('warns rather than implying permission when no limits are verified', async () => {
    const bare = new HttpPlatformAdapter({
      definition,
      state: state({ limits: {} }),
      declaredCapabilityKeys: ['SHORT_VIDEO'],
      credentialFor: () => 'token',
    })
    const result = await bare.validateContent({ contentType: 'SHORT_VIDEO', mediaRefs: [] })
    assert.equal(result.valid, true)
    assert.equal(result.issues[0]?.severity, 'WARNING')
    assert.match(result.issues[0]?.message ?? '', /not confirmed/i)
  })

  it('reports honestly when a capability is unsupported or withdrawn', async () => {
    const http = adapter()
    const unsupported = await http.validateContent({ contentType: 'PODCAST_EPISODE', mediaRefs: [] })
    assert.equal(unsupported.valid, false)
    assert.match(unsupported.issues[0]?.message ?? '', /have not confirmed/i)

    const withdrawn = new HttpPlatformAdapter({
      definition,
      state: state({
        capabilities: { SHORT_VIDEO: { capabilityKey: 'SHORT_VIDEO', state: 'REMOVED', confidence: 0.9, sourceIds: ['src_1'] } },
      }),
      declaredCapabilityKeys: [],
      credentialFor: () => 'token',
    })
    const result = await withdrawn.validateContent({ contentType: 'SHORT_VIDEO', mediaRefs: [] })
    assert.equal(result.valid, false)
    assert.match(result.issues[0]?.message ?? '', /no longer supports/i)
  })

  it('says so when the platform has no scheduling or analytics endpoint', async () => {
    const partial = new HttpPlatformAdapter({
      definition: { ...definition, schedule: undefined, analytics: undefined },
      state: state(),
      declaredCapabilityKeys: ['SHORT_VIDEO'],
      credentialFor: () => 'token',
    })
    assert.match((await partial.schedule({ contentType: 'SHORT_VIDEO', mediaRefs: [], accountRef: 'a', idempotencyKey: 'k' })).error ?? '', /no scheduling endpoint/)
    assert.equal((await partial.fetchAnalytics({ accountRef: 'a', since: 'x', until: 'y' })).ok, false)
    assert.match((await partial.fetchEngagement({ accountRef: 'a', since: 'x', until: 'y' })).error ?? '', /no verified engagement mapping/)
  })

  it('reads metrics and the response id from a defined path', async () => {
    assert.equal(readPath({ data: [{ id: 'abc' }] }, 'data.0.id'), 'abc')
    assert.equal(readPath({ data: [] }, 'data.0.id'), null)
    assert.equal(readPath(null, 'data.0.id'), null)

    const analytics = adapter({ fetchImpl: responding({ impressions: 1200, reach: 300 }) })
    const result = await analytics.fetchAnalytics({ accountRef: 'a', since: 'x', until: 'y' })
    assert.equal(result.ok, true)
    assert.deepEqual(
      result.metrics.map((metric) => metric.key).sort(),
      ['impressions', 'reach'],
    )
  })

  it('cannot be built from an incomplete definition', () => {
    const registry = buildAdapterRegistry({ definitions: [{ ...definition, publish: { path: '', method: 'POST' } }] })
    assert.equal(registry.list().length, 0, 'an integration with no endpoint is not registered')
  })

  it('registers only definitions that name an endpoint', () => {
    const registry = buildAdapterRegistry({ definitions: [definition], credentialFor: () => 'token' })
    assert.equal(registry.byKind('LIVE').length, 1)
  })
})

describe('simulated publishing adapter', () => {
  it('behaves like the real thing without a network call', async () => {
    const adapter = new SimulatedPlatformAdapter('example', state(), ['SHORT_VIDEO'])
    const published = await adapter.publish({
      contentType: 'SHORT_VIDEO',
      mediaRefs: [],
      accountRef: 'a',
      idempotencyKey: 'k1',
    })
    assert.equal(published.ok, true)
    assert.equal(published.platformContentRef, 'sim_k1')
    assert.equal(published.simulated, true, 'every simulated result says so')

    const analytics = await adapter.fetchAnalytics({ accountRef: 'a', since: 'x', until: 'y' })
    assert.equal(analytics.ok, true)
    assert.equal(analytics.metrics[0]?.value, 1)
  })

  it('is deterministic, so idempotency is testable rather than claimed', async () => {
    const adapter = new SimulatedPlatformAdapter('example', state(), ['SHORT_VIDEO'])
    const input = { contentType: 'SHORT_VIDEO', mediaRefs: [], accountRef: 'a', idempotencyKey: 'same' }
    const first = await adapter.publish(input)
    const second = await adapter.publish(input)
    assert.equal(first.platformContentRef, second.platformContentRef)
    assert.equal(adapter.published().length, 2)
  })

  it('still refuses content the platform has not confirmed', async () => {
    const adapter = new SimulatedPlatformAdapter('example', state(), ['SHORT_VIDEO'])
    const result = await adapter.publish({ contentType: 'PODCAST_EPISODE', mediaRefs: [], accountRef: 'a', idempotencyKey: 'k' })
    assert.equal(result.ok, false)
    assert.equal(result.simulated, true)
  })
})

describe('publishing is gated on two independent facts', () => {
  it('stays off without a live adapter', () => {
    const control = new ControlPlane()
    const platform = {
      id: 'pf_1',
      slug: 'example',
      name: 'Example',
      kind: 'MAINSTREAM' as const,
      status: 'ACTIVE' as const,
      regions: [],
      capabilityKeys: ['API_PUBLISH'],
      trustLevel: 'OFFICIAL' as const,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      integrationState: 'PREPARING' as const,
      metadata: {},
    }
    control.upsertPlatform(platform)
    control.addSnapshot({
      id: 'snap_1',
      platformId: 'pf_1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      sourceIds: [],
      stateHash: 'h',
      state: state({ capabilities: { API_PUBLISH: { capabilityKey: 'API_PUBLISH', state: 'ACTIVE', confidence: 1, sourceIds: [] } } }),
      capturedBy: 'SEED',
    })

    const registry = buildAdapterRegistry({ credentialFor: () => 'token' })
    assert.equal(publishingEnabled(control, registry, 'pf_1'), false, 'a simulated adapter never enables publishing')

    registry.register(adapter())
    assert.equal(publishingEnabled(control, registry, 'pf_1'), false, 'a live adapter alone is not enough')
  })

  it('turns on only when the adapter is live and the API is verified', () => {
    const control = new ControlPlane()
    control.upsertPlatform({
      id: 'pf_1',
      slug: 'example',
      name: 'Example',
      kind: 'MAINSTREAM',
      status: 'ACTIVE',
      regions: [],
      capabilityKeys: ['API_PUBLISH'],
      trustLevel: 'OFFICIAL',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      integrationState: 'INTEGRATED',
      metadata: {},
    })
    control.addSnapshot({
      id: 'snap_1',
      platformId: 'pf_1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      sourceIds: [],
      stateHash: 'h',
      state: {
        ...state(),
        capabilities: {
          API_PUBLISH: { capabilityKey: 'API_PUBLISH', state: 'ACTIVE', confidence: 1, sourceIds: [] },
        },
        api: { contentPublishing: { status: 'GA' } },
      },
      capturedBy: 'SEED',
    })

    const registry = buildAdapterRegistry({ definitions: [definition], credentialFor: () => 'token' })
    assert.equal(publishingEnabled(control, registry, 'pf_1'), true)
  })
})
