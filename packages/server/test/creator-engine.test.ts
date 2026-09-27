import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runResearchCycle } from '../src/world-engine/pipeline.js'
import { CLOCK, platformRoutes, signedInClient, startServer, testContext } from './helpers.js'

/** A world with one platform researched, but no server yet. */
async function researchedContext() {
  const context = await testContext(platformRoutes('<p>Reels can be up to 15 seconds long.</p>'))
  await runResearchCycle({
    control: context.control,
    fetcher: context.fetcher,
    respectSchedule: false,
    maxSourcesPerRun: 1,
    clock: CLOCK,
  })
  return context
}

/** A researched world with a running server and a signed-in creator. */
async function world() {
  const context = await researchedContext()
  const server = await startServer(context)
  const client = await signedInClient(server.baseUrl)
  return { context, server, client }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('creator engine: generation', () => {
  it('generates copy and a poster for a confirmed option', async () => {
    const { server, client } = await world()
    try {
      const response = await client.get(
        '/api/creator/generate',
        json({ platform: 'instagram', option: 'SHORT_VIDEO', brief: 'batch filming a week of content' }),
      )
      assert.equal(response.status, 200)
      const body = JSON.parse(response.body)
      assert.equal(body.asset.kind, 'STORYBOARD', 'a short video gets a shot list, not a poster')
      assert.match(body.content, /batch filming/i)
      assert.match(body.content, /shot list/)
      assert.ok(body.meta.storyboard.shots.length >= 3)
      assert.equal(body.asset.madeWithAI, false, 'the deterministic renderer never claims to be a model')
      assert.match(body.asset.producedBy, /creator-mall-renderer-v1/)
    } finally {
      await server.close()
    }
  })

  it('generates a poster for a text post', async () => {
    const { server, client } = await world()
    try {
      const response = await client.get(
        '/api/creator/generate',
        json({ platform: 'instagram', option: 'TEXT_POST', brief: 'three mistakes when editing a reel' }),
      )
      const body = JSON.parse(response.body)
      assert.equal(body.asset.kind, 'IMAGE')
      assert.equal(body.asset.producedBy.includes('creator-mall-renderer-v1'), true)
      // The stored bytes are the poster itself, not the copy text.
      assert.match(body.content, /<svg/)
      assert.match(body.content, /<\/svg>/)
      assert.equal(body.meta.poster.producedBy, 'creator-mall-renderer-v1')
      assert.ok(body.meta.copy.hook.length > 0)

      const id = body.asset.id
      const file = await client.get(`/api/creator/assets/${id}`)
      assert.equal(file.status, 200)
      assert.match(file.contentType, /image\/svg\+xml/)
      assert.match(file.body, /<svg/)
    } finally {
      await server.close()
    }
  })

  it('refuses an option the platform does not support', async () => {
    const { server, client } = await world()
    try {
      const unknown = await client.get(
        '/api/creator/generate',
        json({ platform: 'instagram', option: 'SPATIAL_POST', brief: 'hello' }),
      )
      assert.equal(unknown.status, 404)
    } finally {
      await server.close()
    }
  })

  it('refuses an option that is verified as withdrawn', async () => {
    const { context, server, client } = await world()
    try {
      const platform = context.control.getPlatform('instagram')!
      const previous = context.control.latestSnapshot(platform.id)!
      context.control.addSnapshot({
        ...previous,
        id: `${previous.id}_withdrawn`,
        capturedAt: '2026-09-28T12:00:00.000Z',
        stateHash: 'withdrawn',
        state: {
          ...previous.state,
          capabilities: {
            ...previous.state.capabilities,
            SHORT_VIDEO: { ...previous.state.capabilities.SHORT_VIDEO!, state: 'REMOVED' },
          },
        },
      })

      const response = await client.get(
        '/api/creator/generate',
        json({ platform: 'instagram', option: 'SHORT_VIDEO', brief: 'x' }),
      )
      assert.equal(response.status, 409)
      assert.match(JSON.parse(response.body).error, /no longer supports|not available/i)
    } finally {
      await server.close()
    }
  })

  it('requires a session', async () => {
    const context = await researchedContext()
    const server = await startServer(context)
    try {
      const response = await fetch(`${server.baseUrl}/api/creator/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'instagram', option: 'TEXT_POST', brief: 'x' }),
      })
      assert.equal(response.status, 401)
    } finally {
      await server.close()
    }
  })
})

describe('creator engine: media library', () => {
  it('stores what it generated and serves it back', async () => {
    const { server, client } = await world()
    try {
      const created = JSON.parse(
        (await client.get('/api/creator/generate', json({ platform: 'instagram', option: 'TEXT_POST', brief: 'my library test' }))).body,
      )
      const id = created.asset.id

      const list = JSON.parse((await client.get('/api/creator/assets')).body)
      assert.equal(list.assets.length, 1)
      assert.equal(list.assets[0].id, id)
      assert.equal(list.assets[0].madeWithAI, false)

      const file = await client.get(`/api/creator/assets/${id}`)
      assert.equal(file.status, 200)
      assert.match(file.body, /<svg/)

      const removed = await client.get(`/api/creator/assets/${id}`, { method: 'DELETE' })
      assert.equal(removed.status, 200)
      assert.equal(JSON.parse((await client.get('/api/creator/assets')).body).assets.length, 0)
    } finally {
      await server.close()
    }
  })

  it('filters by kind', async () => {
    const { server, client } = await world()
    try {
      await client.get('/api/creator/generate', json({ platform: 'instagram', option: 'SHORT_VIDEO', brief: 'a' }))
      await client.get('/api/creator/generate', json({ platform: 'instagram', option: 'TEXT_POST', brief: 'b' }))

      const images = JSON.parse((await client.get('/api/creator/assets?kind=IMAGE')).body)
      assert.equal(images.assets.length, 1)
      assert.equal(images.assets[0].kind, 'IMAGE')
    } finally {
      await server.close()
    }
  })

  it("never serves another creator's asset", async () => {
    const { server, client } = await world()
    try {
      const mine = JSON.parse(
        (await client.get('/api/creator/generate', json({ platform: 'instagram', option: 'TEXT_POST', brief: 'mine' }))).body,
      )
      const other = await signedInClient(server.baseUrl, { email: 'other@example.com' })

      const read = await other.get(`/api/creator/assets/${mine.asset.id}`)
      assert.equal(read.status, 403)

      const list = JSON.parse((await other.get('/api/creator/assets')).body)
      assert.equal(list.assets.length, 0)

      const removed = await other.get(`/api/creator/assets/${mine.asset.id}`, { method: 'DELETE' })
      assert.equal(removed.status, 403)
    } finally {
      await server.close()
    }
  })

  it('reports a missing file rather than serving a broken asset', async () => {
    const { context, server, client } = await world()
    try {
      const created = JSON.parse(
        (await client.get('/api/creator/generate', json({ platform: 'instagram', option: 'TEXT_POST', brief: 'gone soon' }))).body,
      )
      // Simulate the bytes disappearing while the record remains.
      context.media.get(created.asset.id)!.storageKey = 'missing/key'
      const read = await client.get(`/api/creator/assets/${created.asset.id}`)
      assert.equal(read.status, 410)
    } finally {
      await server.close()
    }
  })

  it('keeps internal vocabulary out of creator-facing copy', async () => {
    const { server, client } = await world()
    try {
      const response = await client.get(
        '/api/creator/generate',
        json({ platform: 'instagram', option: 'TEXT_POST', brief: 'checking the wording' }),
      )
      const jargon = /capability|adapter|embedding|crawler|deterministic renderer|port\b/i
      const body = JSON.parse(response.body)
      assert.equal(jargon.test(body.meta.copy.hook), false)
      assert.equal(jargon.test(body.meta.copy.body), false)
      assert.equal(jargon.test(body.asset.title), false)
      // The renderer is named honestly in provenance, without leaking into copy.
      assert.equal(/creator-mall-renderer-v1/.test(body.asset.producedBy), true)
    } finally {
      await server.close()
    }
  })
})
