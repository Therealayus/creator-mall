import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runResearchCycle } from '../src/world-engine/pipeline.js'
import { CLOCK, forkContext, platformRoutes, signedInClient, startServer, testContext } from './helpers.js'
import type { AppContext } from '../src/context.js'

/** A world where a real change has been detected, so "why" has something to say. */
async function world(): Promise<AppContext> {
  const first = await testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'))
  await runResearchCycle({
    control: first.control,
    fetcher: first.fetcher,
    respectSchedule: false,
    maxSourcesPerRun: 1,
    clock: CLOCK,
  })
  const changed = await forkContext(first, platformRoutes('<p>Reels can be up to 15 seconds long.</p>'))
  await runResearchCycle({
    control: changed.control,
    fetcher: changed.fetcher,
    respectSchedule: false,
    maxSourcesPerRun: 1,
    clock: CLOCK,
  })
  return changed
}

describe('creator-facing api', () => {
  it('returns a plain-language overview of every platform and option', async () => {
    const context = await world()
    const server = await startServer(context)
    const client = await signedInClient(server.baseUrl)
    try {
      const response = await client.get('/api/creator/overview')
      assert.equal(response.status, 200)
      const overview = JSON.parse(response.body)

      // The overview is scoped to the signed-in creator, not the seeded demo profile.
      assert.equal(overview.creator.name, 'Test creator')
      assert.ok(overview.platforms.length >= 7)
      assert.ok(overview.counts.optionsReady > 0)

      const instagram = overview.platforms.find((platform: { slug: string }) => platform.slug === 'instagram')
      assert.ok(instagram)
      assert.equal(instagram.publishing, false, 'an unintegrated platform must not claim it can publish')
      assert.match(instagram.publishingNote, /still preparing/i)

      const shortVideo = instagram.options.find((option: { key: string }) => option.key === 'SHORT_VIDEO')
      assert.equal(shortVideo.enabled, true)
      assert.equal(shortVideo.media, 'VIDEO')
      assert.deepEqual(
        shortVideo.limits.map((limit: { display: string }) => limit.display),
        ['15 seconds'],
      )

      // No internal vocabulary anywhere in the creator surface.
      const jargon = /capability|adapter|embedding|crawler|RAG|evolution|snapshot|trustLevel|proposal/i
      assert.equal(jargon.test(response.body), false)
    } finally {
      await server.close()
    }
  })

  it('explains unavailable options instead of hiding them', async () => {
    const context = await world()
    const server = await startServer(context)
    const client = await signedInClient(server.baseUrl)
    try {
      const overview = JSON.parse((await client.get('/api/creator/overview')).body)
      const instagram = overview.platforms.find((platform: { slug: string }) => platform.slug === 'instagram')

      // An option the platform has not confirmed is offered, but disabled with a reason.
      const unconfirmed = instagram.options.find((option: { key: string }) => option.key === 'AUDIO')
      assert.ok(unconfirmed, 'unknown options are still listed so the gap is visible')
      assert.equal(unconfirmed.enabled, false)
      assert.match(unconfirmed.unavailableReason, /waiting for confirmation|right now/i)

      // A confirmed option explains its own limits.
      const shortVideo = instagram.options.find((option: { key: string }) => option.key === 'SHORT_VIDEO')
      assert.equal(shortVideo.enabled, true)
      assert.equal(shortVideo.unavailableReason, null)
    } finally {
      await server.close()
    }
  })

  it('validates content against verified limits', async () => {
    const context = await world()
    const server = await startServer(context)
    const client = await signedInClient(server.baseUrl)
    try {
      const short = await client.get('/api/creator/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'instagram', option: 'SHORT_VIDEO', text: 'a'.repeat(10), mediaCount: 1 }),
      })
      assert.equal(JSON.parse(short.body).valid, true)

      const unsupported = await client.get('/api/creator/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'instagram', option: 'SPATIAL_POST', text: 'hello', mediaCount: 0 }),
      })
      const unsupportedBody = JSON.parse(unsupported.body)
      assert.equal(unsupportedBody.valid, false)
      assert.match(unsupportedBody.issues[0].message, /not confirmed/i)

      const invalid = await client.get('/api/creator/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'instagram' }),
      })
      assert.equal(invalid.status, 400)
    } finally {
      await server.close()
    }
  })

  it('produces a draft that says where it came from', async () => {
    const context = await world()
    const server = await startServer(context)
    const client = await signedInClient(server.baseUrl)
    try {
      const response = await client.get('/api/creator/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'instagram', option: 'SHORT_VIDEO', brief: 'batch filming a week of content' }),
      })
      const draft = JSON.parse(response.body)
      assert.equal(draft.prepared, true)
      assert.match(draft.provenance, /prepared structure/i)
      assert.match(draft.body, /batch filming a week of content/)
      assert.equal(draft.publishing, false)
      assert.deepEqual(
        draft.limits.map((limit: { display: string }) => limit.display),
        ['15 seconds'],
      )

      const unknownPlatform = JSON.parse(
        (
          await client.get('/api/creator/draft', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platform: 'brandnew', option: 'TEXT_POST', brief: 'x' }),
          })
        ).body,
      )
      assert.equal(unknownPlatform.prepared, false)
      assert.match(unknownPlatform.notes[0], /do not know that platform/i)
    } finally {
      await server.close()
    }
  })

  it('answers "why did this change?" in creator language with sources', async () => {
    const context = await world()
    const server = await startServer(context)
    const client = await signedInClient(server.baseUrl)
    try {
      const response = await client.get('/api/creator/platforms/instagram/why?option=SHORT_VIDEO')
      assert.equal(response.status, 200)
      const why = JSON.parse(response.body)
      assert.equal(why.optionKey, 'SHORT_VIDEO')
      assert.equal(why.available, true)
      assert.ok(why.whatChanged.length > 0)
      assert.match(why.from, /documentation/i)
      assert.ok(why.sources.length > 0)
      assert.ok(why.sources[0].url)

      const missing = await client.get('/api/creator/platforms/instagram/why')
      assert.equal(missing.status, 400)

      const unknown = await client.get('/api/creator/platforms/nope/why?option=SHORT_VIDEO')
      assert.equal(unknown.status, 404)
    } finally {
      await server.close()
    }
  })

  it('lists platforms it is still preparing for', async () => {
    const context = await testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'))
    const platform = context.control.getPlatform('youtube')!
    context.control.upsertPlatform({ ...platform, status: 'COMING_SOON' })

    const server = await startServer(context)
    const client = await signedInClient(server.baseUrl)
    try {
      const comingSoon = JSON.parse((await client.get('/api/creator/coming-soon')).body).comingSoon
      assert.equal(comingSoon.length, 1)
      assert.equal(comingSoon[0].slug, 'youtube')
      assert.equal(comingSoon[0].stage, 'Coming soon')
      assert.ok(comingSoon[0].readinessPercent > 0)
      assert.match(comingSoon[0].note, /ready the day it opens/i)
    } finally {
      await server.close()
    }
  })
})
