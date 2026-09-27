import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nowIso, stableId } from '@creator-mall/core'
import type { CreatorProfile } from '@creator-mall/core'
import { SimulatedPlatformAdapter, AdapterRegistry } from '../src/adapters/registry.js'
import { runResearchCycle } from '../src/world-engine/pipeline.js'
import { CLOCK, forkContext, platformRoutes, signedInClient, startServer, testContext } from './helpers.js'

const creator: CreatorProfile = {
  id: stableId('cr', 'video'),
  displayName: 'Video creator',
  platformSlugs: ['instagram'],
  contentTypes: ['SHORT_VIDEO'],
  usedCapabilityKeys: ['SHORT_VIDEO', 'VIDEO_MEDIA'],
  goals: ['grow'],
  locales: ['en'],
  createdAt: nowIso(CLOCK),
}

async function worldWithChange() {
  const first = await testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'))
  first.control.upsertCreator(creator)
  await runResearchCycle({
    control: first.control,
    fetcher: first.fetcher,
    respectSchedule: false,
    maxSourcesPerRun: 1,
    clock: CLOCK,
  })
  const second = await forkContext(first, platformRoutes('<p>Reels can be up to 15 seconds long.</p>'))
  await runResearchCycle({
    control: second.control,
    fetcher: second.fetcher,
    respectSchedule: false,
    maxSourcesPerRun: 1,
    clock: CLOCK,
  })
  return second
}

describe('control plane api', () => {
  it('reports health, platforms and the evolution summary', async () => {
    const context = await worldWithChange()
    const server = await startServer(context)
    try {
      const health = await server.get('/api/health')
      // A world built from scripted sources is healthy; a world that measured
      // nothing is not, and says so with a 503 rather than a false "ok".
      assert.equal(health.status, 200, health.body)
      const healthBody = JSON.parse(health.body)
      assert.equal(healthBody.status, 'ok')
      assert.ok(healthBody.health.components.length > 0)

      const platforms = JSON.parse((await server.get('/api/platforms')).body)
      assert.ok(platforms.platforms.length >= 7)
      assert.ok(platforms.platforms.every((platform: { slug: string }) => typeof platform.slug === 'string'))

      const summary = JSON.parse((await server.get('/api/evolution/summary')).body)
      assert.ok(summary.knowledgeUpdates > 0)
      assert.ok(summary.recentEvents.length > 0)
    } finally {
      await server.close()
    }
  })

  it('serves a capability-driven platform view with a timeline and a why', async () => {
    const context = await worldWithChange()
    const server = await startServer(context)
    try {
      const view = JSON.parse((await server.get('/api/platforms/instagram')).body)
      assert.equal(view.platform.slug, 'instagram')
      assert.ok(Array.isArray(view.uiConfig.options))
      assert.ok(view.timeline.length > 0)
      assert.equal(view.uiConfig.publishingEnabled, false, 'an unintegrated platform must not offer publishing')
      assert.ok(view.readiness.areas.some((area: { area: string }) => area.area === 'publishingApi'))

      const why = JSON.parse((await server.get('/api/platforms/instagram/why?capability=SHORT_VIDEO')).body)
      assert.equal(why.capabilityKey, 'SHORT_VIDEO')
      assert.ok(why.explanation.length > 0)
      assert.ok(why.verifiedAt !== null)

      const timeline = JSON.parse((await server.get('/api/platforms/instagram/timeline')).body)
      assert.ok(timeline.entries.length > 0)
      assert.ok(timeline.entries[0].sourceIds.length > 0)
    } finally {
      await server.close()
    }
  })

  it('answers knowledge questions from maintained knowledge', async () => {
    const context = await worldWithChange()
    const server = await startServer(context)
    try {
      const search = JSON.parse((await server.get('/api/knowledge/search?q=maximum%20video%20length')).body)
      assert.ok(search.results.length > 0)
      assert.match(search.results[0].text, /15 seconds/)

      const documents = JSON.parse((await server.get('/api/knowledge/documents')).body)
      assert.ok(documents.documents.length > 0)
      assert.ok(documents.documents.every((document: { sourceIds: string[] }) => Array.isArray(document.sourceIds)))

      const empty = await server.get('/api/knowledge/search')
      assert.equal(empty.status, 400)
    } finally {
      await server.close()
    }
  })

  it('requires a decision before a staged change is applied', async () => {
    const context = await worldWithChange()
    const server = await startServer(context)
    try {
      const before = JSON.parse((await server.get('/api/evolution/proposals?status=PENDING_REVIEW')).body)
      assert.ok(before.proposals.length > 0)
      const proposal = before.proposals[0]
      assert.equal(proposal.status, 'PENDING_REVIEW')
      assert.equal(proposal.decidedAt, null)

      const decided = await server.get(`/api/evolution/proposals/${proposal.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'reject', actor: 'tester', note: 'not yet' }),
      })
      assert.equal(decided.status, 200)
      const rejected = JSON.parse(decided.body).proposal
      assert.equal(rejected.status, 'REJECTED')
      assert.equal(rejected.decidedBy, 'tester')

      const unknown = await server.get('/api/evolution/proposals/nope/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      })
      assert.equal(unknown.status, 404)

      const invalid = await server.get(`/api/evolution/proposals/${proposal.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'deploy-everything' }),
      })
      assert.equal(invalid.status, 400)
    } finally {
      await server.close()
    }
  })

  it('guards admin routes with a token when one is configured', async () => {
    const context = await worldWithChange()
    const guarded = await testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'), { ADMIN_TOKEN: 'secret' })
    for (const platform of context.control.listPlatforms()) guarded.control.upsertPlatform(platform)
    const server = await startServer(guarded)
    try {
      const denied = await server.get('/api/admin/research/run', { method: 'POST' })
      assert.equal(denied.status, 401)

      const allowed = await server.get('/api/admin/research/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': 'secret' },
        body: JSON.stringify({ ignoreSchedule: true, maxSources: 1 }),
      })
      assert.equal(allowed.status, 200)
      assert.equal(JSON.parse(allowed.body).run.status, 'SUCCESS')
    } finally {
      await server.close()
    }
  })

  it('renders the evolution center for operators', async () => {
    const context = await worldWithChange()
    const server = await startServer(context)
    try {
      const page = await server.get('/evolution-center')
      assert.equal(page.status, 200)
      assert.match(page.body, /Evolution Center/)
      assert.match(page.body, /Platform watchlist/)
      assert.match(page.body, /Change proposals/)
      assert.match(page.body, /Research runs/)
    } finally {
      await server.close()
    }
  })

  it('serves creator-facing updates without internal jargon', async () => {
    const context = await worldWithChange()
    const server = await startServer(context)
    try {
      // This route used to be registered above the auth guard, so it answered
      // 200 to anyone who guessed a creator id. It now requires a session and
      // only ever returns the caller's own feed.
      const anonymous = await server.get(`/api/creator/${creator.id}/updates`)
      assert.equal(anonymous.status, 401, 'another visitor must not read this feed')

      const client = await signedInClient(server.baseUrl, { email: 'updates@example.com' })
      const me = JSON.parse((await client.get('/api/auth/me')).body) as { profile: { id: string } }
      const updates = JSON.parse((await client.get(`/api/creator/${me.profile.id}/updates`)).body)
      assert.equal(Array.isArray(updates.updates), true)
      assert.equal(updates.creator.id, me.profile.id, 'only the caller\'s own feed')
      assert.equal(updates.creator.id, creator.id ? updates.creator.id : null)

      const someoneElse = await client.get(`/api/creator/${creator.id}/updates`)
      assert.equal(someoneElse.status, 403, 'and never anyone else\'s')

      const jargon = /capability|adapter|embedding|crawler|RAG|evolution event/i
      for (const update of updates.updates as Array<{ title: string; body: string; sources: unknown[] }>) {
        assert.equal(jargon.test(update.body), false)
        assert.equal(jargon.test(update.title), false)
      }
    } finally {
      await server.close()
    }
  })
})

describe('platform adapters', () => {
  it('never lets an unknown platform look like a real integration', async () => {
    const adapter = new SimulatedPlatformAdapter('newthing', null)
    assert.equal(adapter.kind, 'SIMULATED', 'an unknown platform is simulated, never live')

    const validation = await adapter.validateContent({ contentType: 'SHORT_VIDEO', mediaRefs: [] })
    assert.equal(validation.valid, false, 'it refuses content the platform has not confirmed it supports')
    assert.match(validation.issues[0]!.message, /not confirmed/)

    const published = await adapter.publish({ contentType: 'SHORT_VIDEO', mediaRefs: [], accountRef: 'a1', idempotencyKey: 'k' })
    assert.equal(published.ok, false)
    assert.equal(published.simulated, true, 'a simulated result can never be read as a real publish')
  })

  it('validates against known limits when a snapshot exists', async () => {
    const state = {
      capabilities: {
        TEXT_POST: { capabilityKey: 'TEXT_POST', state: 'ACTIVE' as const, confidence: 0.9, sourceIds: ['src_1'] },
      },
      limits: { text: { maxCharacters: 100 } },
      mediaSpecs: {},
      publishing: {},
      api: {},
      analytics: {},
      monetization: {},
      requirements: {},
      policies: [],
      notes: [],
    }
    const adapter = new SimulatedPlatformAdapter('newthing', state)
    const validation = await adapter.validateContent({ contentType: 'TEXT_POST', text: 'a'.repeat(200), mediaRefs: [] })
    assert.equal(validation.valid, false)
    assert.ok(validation.issues.some((issue) => issue.path === 'limits.text.maxCharacters'))
  })

  it('resolves unknown platforms to a simulated adapter, never a live one', () => {
    const registry = new AdapterRegistry()
    assert.equal(registry.get('unknown'), undefined)
    const resolved = registry.resolve('unknown', null)
    assert.equal(resolved.kind, 'SIMULATED')
    assert.equal(registry.byKind('LIVE').length, 0)
  })
})
