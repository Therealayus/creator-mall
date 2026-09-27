import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nowIso, stableId } from '@creator-mall/core'
import type { CreatorProfile } from '@creator-mall/core'
import { UnavailablePlatformAdapter, AdapterRegistry } from '../src/adapters/registry.js'
import { runResearchCycle } from '../src/world-engine/pipeline.js'
import { CLOCK, forkContext, platformRoutes, startServer, testContext } from './helpers.js'

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
      assert.equal(health.status, 200)
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
      const updates = JSON.parse((await server.get(`/api/creator/${creator.id}/updates`)).body)
      assert.equal(updates.updates.length, 1)
      assert.ok(updates.updates[0].sources.length > 0)
      const jargon = /capability|adapter|embedding|crawler|RAG|evolution event/i
      assert.equal(jargon.test(updates.updates[0].body), false)
      assert.equal(jargon.test(updates.updates[0].title), false)

      const missing = await server.get('/api/creator/nobody/updates')
      assert.equal(missing.status, 404)
    } finally {
      await server.close()
    }
  })
})

describe('platform adapters', () => {
  it('represents an unknown platform honestly instead of pretending to publish', async () => {
    const adapter = new UnavailablePlatformAdapter('newthing', null, 'no API yet')
    assert.equal(adapter.kind, 'UNAVAILABLE')

    const validation = await adapter.validateContent({ contentType: 'SHORT_VIDEO', mediaRefs: [] })
    assert.equal(validation.valid, false)
    assert.match(validation.issues[0]!.message, /not confirmed/)

    const published = await adapter.publish({ contentType: 'TEXT_POST', mediaRefs: [], accountRef: 'a1', idempotencyKey: 'k' })
    assert.equal(published.ok, false)
    assert.match(String(published.error), /not connected/i)

    const analytics = await adapter.fetchAnalytics({ accountRef: 'a1', since: 'x', until: 'y' })
    assert.equal(analytics.ok, false)
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
    const adapter = new UnavailablePlatformAdapter('newthing', state, 'no API yet')
    const validation = await adapter.validateContent({ contentType: 'TEXT_POST', text: 'a'.repeat(200), mediaRefs: [] })
    assert.equal(validation.valid, false)
    assert.ok(validation.issues.some((issue) => issue.path === 'limits.text.maxCharacters'))
  })

  it('resolves unknown platforms to the unavailable adapter', () => {
    const registry = new AdapterRegistry()
    assert.equal(registry.get('unknown'), undefined)
    assert.equal(registry.resolve('unknown', null).kind, 'UNAVAILABLE')
  })
})
