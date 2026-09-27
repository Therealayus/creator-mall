import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EMPTY_SOURCE_STATS, candidateSourceId, candidatesFor } from '@creator-mall/core'
import type { Source } from '@creator-mall/core'
import { runResearchCycle, sourceStats } from '../src/world-engine/pipeline.js'
import { probeCandidatePaths } from '../src/world-engine/curation.js'
import { ROBOTS_ALLOW_ALL, SEED_HOSTS, html, platformRoutes, signedInClient, startServer, testContext } from './helpers.js'
import { CLOCK } from './helpers.js'

/** Serves a real limit on one documentation path and nothing anywhere else. */
function routesWithDocPath(limitSeconds: number, docPath: string) {
  const routes: Record<string, { body: string | (() => string); contentType: string }> = {}
  for (const host of SEED_HOSTS) {
    routes[`https://${host}/robots.txt`] = { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' }
    routes[`https://${host}/`] = { body: html('<p>Creator hub. Nothing specific here.</p>'), contentType: 'text/html' }
  }
  const url = new URL(docPath)
  routes[`https://${url.host}${url.pathname}`] = {
    body: html(`<p>Reels can be up to ${limitSeconds} seconds long.</p>`),
    contentType: 'text/html',
  }
  routes[`https://${url.host}/robots.txt`] = { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' }
  return routes
}

const DOC_PATH = candidatesFor('instagram')[0]!.url

describe('source curation in the research cycle', () => {
  it('credits a source with the facts it actually produced', async () => {
    const context = await testContext(routesWithDocPath(90, DOC_PATH))
    for (const platform of context.control.listPlatforms()) {
      if (platform.slug !== 'instagram') context.control.upsertPlatform({ ...platform, status: 'SUNSET' })
    }

    // Point Instagram's creator-help source at the documentation path, then run.
    const help = context.control.sourcesForPlatform('instagram').find((source) => source.sourceType === 'DOCUMENTATION')!
    context.control.upsertSource({ ...help, url: DOC_PATH, domain: new URL(DOC_PATH).hostname })

    await runResearchCycle({
      control: context.control,
      fetcher: context.fetcher,
      respectSchedule: false,
      maxSourcesPerRun: 5,
      clock: CLOCK,
    })

    const source = context.control.getSource(help.id)!
    const stats = sourceStats(source)
    assert.ok(stats.checks >= 1, 'the check was recorded')
    assert.ok(stats.factsContributed > 0, 'the accepted fact was credited to the source that produced it')
    assert.equal(stats.lastFactAt, '2026-09-27T12:00:00.000Z')
  })

  it('marks a source that answers but yields nothing as quiet', async () => {
    const context = await testContext(platformRoutes('<p>Creator hub. Nothing specific here.</p>'), {
      ADMIN_TOKEN: 'operator-token',
    })
    for (const platform of context.control.listPlatforms()) {
      if (platform.slug !== 'instagram') context.control.upsertPlatform({ ...platform, status: 'SUNSET' }
      )
    }
    const help = context.control.sourcesForPlatform('instagram').find((source) => source.sourceType === 'DOCUMENTATION')!

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await runResearchCycle({
        control: context.control,
        fetcher: context.fetcher,
        respectSchedule: false,
        maxSourcesPerRun: 3,
        clock: () => CLOCK() + cycle * 86_400_000,
      })
    }

    const stats = sourceStats(context.control.getSource(help.id)!)
    assert.ok(stats.checks >= 3, `expected repeated checks, saw ${stats.checks}`)
    assert.equal(stats.factsContributed, 0)

    const server = await startServer(context)
    try {
      const admin = await signedInClient(server.baseUrl)
      const body = JSON.parse(
        (await admin.get('/api/sources', { headers: { 'x-admin-token': 'operator-token' } })).body,
      )
      const entry = body.sources.find((item: { id: string }) => item.id === help.id)
      assert.equal(entry.tier, 'QUIET')
      assert.equal(entry.action, 'REPOINT')
      assert.match(entry.summary, /deeper documentation page/i)
      assert.ok(body.curation.quiet >= 1)
    } finally {
      await server.close()
    }
  })
})

describe('candidate documentation paths', () => {
  it('activates a candidate that earns its place and leaves the rest inactive', async () => {
    const context = await testContext(routesWithDocPath(90, DOC_PATH))
    for (const platform of context.control.listPlatforms()) {
      if (platform.slug !== 'instagram') context.control.upsertPlatform({ ...platform, status: 'SUNSET' })
    }

    const probed = await probeCandidatePaths(context.control, context.fetcher, CLOCK)
    assert.ok(probed > 0, 'candidates were probed')

    const candidate = candidatesFor('instagram').find((entry) => entry.url === DOC_PATH)!
    const record = context.control.getSource(candidateSourceId(candidate))
    assert.ok(record, 'the candidate was recorded')
    assert.equal(record!.active, true, 'a candidate that yields a real limit is activated')
    assert.equal(sourceStats(record!).factsContributed > 0, true)

    // Nothing else got activated without evidence.
    const otherCandidates = candidatesFor('instagram').filter((entry) => entry.url !== DOC_PATH)
    for (const other of otherCandidates) {
      const otherRecord = context.control.getSource(candidateSourceId(other))
      if (otherRecord) assert.equal(otherRecord.active, false)
    }
  })

  it('never activates a candidate that a site asks us not to read', async () => {
    const routes = routesWithDocPath(90, DOC_PATH)
    // Every host asks automated tools not to read it, candidates included.
    for (const host of SEED_HOSTS) {
      routes[`https://${host}/robots.txt`] = { body: 'User-agent: *\nDisallow: /\n', contentType: 'text/plain' }
    }
    const context = await testContext(routes)
    for (const platform of context.control.listPlatforms()) {
      if (platform.slug !== 'instagram') context.control.upsertPlatform({ ...platform, status: 'SUNSET' })
    }

    await probeCandidatePaths(context.control, context.fetcher, CLOCK)

    for (const candidate of candidatesFor('instagram')) {
      const record = context.control.getSource(candidateSourceId(candidate))
      if (!record) continue
      assert.equal(record.active, false, 'a blocked candidate never becomes active')
      if (record.lastStatus === 'BLOCKED') assert.equal(sourceStats(record).blocked, 1)
    }
  })

  it('probes each candidate once, then treats it as an ordinary source', async () => {
    const context = await testContext(routesWithDocPath(90, DOC_PATH))
    for (const platform of context.control.listPlatforms()) {
      if (platform.slug !== 'instagram') context.control.upsertPlatform({ ...platform, status: 'SUNSET' })
    }

    // Probing is budgeted, so a cycle may not finish the list. Repeating must
    // never probe the same path twice.
    for (let round = 0; round < 4; round += 1) {
      await probeCandidatePaths(context.control, context.fetcher, CLOCK)
    }

    const probed = candidatesFor('instagram').map((entry) => context.control.getSource(candidateSourceId(entry)))
    assert.ok(probed.length === candidatesFor('instagram').length, 'every candidate is eventually known')
    for (const record of probed) {
      assert.ok(sourceStats(record!).checks <= 1, 'a candidate is probed exactly once')
    }
  })
})

describe('curation controls', () => {
  it('retires a source without losing what it produced', async () => {
    const context = await testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'), { ADMIN_TOKEN: 'operator-token' })
    await runResearchCycle({
      control: context.control,
      fetcher: context.fetcher,
      respectSchedule: false,
      maxSourcesPerRun: 1,
      clock: CLOCK,
    })

    const before = context.control.knowledge.documents.size
    assert.ok(before > 0)

    const server = await startServer(context)
    try {
      const admin = await signedInClient(server.baseUrl)
      const sources = JSON.parse(
        (await admin.get('/api/sources', { headers: { 'x-admin-token': 'operator-token' } })).body,
      )
      const target = sources.sources.find((item: { lastStatus: string }) => item.lastStatus === 'OK')
      assert.ok(target)

      const retired = await admin.get(`/api/admin/sources/${target.id}/curation`, {
        method: 'POST',
        headers: { 'x-admin-token': 'operator-token' },
        body: JSON.stringify({ active: false }),
      })
      assert.equal(retired.status, 200)
      assert.equal(JSON.parse(retired.body).active, false)
      assert.equal(context.control.getSource(target.id)?.active, false)
      // Knowledge is never deleted by a curation decision.
      assert.equal(context.control.knowledge.documents.size, before)

      const restored = await admin.get(`/api/admin/sources/${target.id}/curation`, {
        method: 'POST',
        headers: { 'x-admin-token': 'operator-token' },
        body: JSON.stringify({ active: true }),
      })
      assert.equal(JSON.parse(restored.body).active, true)

      const unknown = await admin.get('/api/admin/sources/nope/curation', {
        method: 'POST',
        headers: { 'x-admin-token': 'operator-token' },
        body: JSON.stringify({ active: false }),
      })
      assert.equal(unknown.status, 404)
    } finally {
      await server.close()
    }
  })

  it('is not reachable by a plain creator', async () => {
    const context = await testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'), { ADMIN_TOKEN: 'operator-token' })
    const server = await startServer(context)
    try {
      const creator = await signedInClient(server.baseUrl)
      const blocked = await creator.get('/api/admin/sources/x/curation', {
        method: 'POST',
        headers: { 'x-csrf-token': creator.csrf ?? '' },
        body: JSON.stringify({ active: false }),
      })
      assert.equal(blocked.status, 403)
    } finally {
      await server.close()
    }
  })
})

describe('source stats', () => {
  it('defaults to an empty history for a source that has never run', () => {
    const bare: Source = {
      id: 'src_x',
      name: 'x',
      url: 'https://example.com/',
      domain: 'example.com',
      sourceType: 'DOCUMENTATION',
      platform: null,
      trustLevel: 'OFFICIAL',
      discoveredVia: 'SEED',
      lastCheckedAt: null,
      nextCheckAt: null,
      active: true,
      lastStatus: 'NEVER_CHECKED',
      consecutiveFailures: 0,
    }
    assert.deepEqual(sourceStats(bare), EMPTY_SOURCE_STATS)
  })
})
