import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createContext } from '../src/context.js'
import type { AppContext } from '../src/context.js'
import { FileAssetStorage } from '../src/store/media-library.js'
import { CLOCK, platformRoutes, signedInClient, signedInExistingClient, startServer, testContext } from './helpers.js'
import { runResearchCycle } from '../src/world-engine/pipeline.js'

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'creator-mall-assets-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A durable context: JSON state and asset bytes both under `dir`. */
async function durableContext(dir: string): Promise<AppContext> {
  return createContext({ DATA_DIR: dir, RESEARCH_ENABLED: false, OPENROUTER_API_KEY: '' })
}

describe('media library: file storage', () => {
  it('round-trips bytes that are not text', async () => {
    await withTempDir(async (dir) => {
      const storage = new FileAssetStorage(join(dir, 'assets'))
      // Bytes that are invalid UTF-8, so a string round-trip would corrupt them.
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x1a, 0x0a])
      const stored = await storage.put('creator/asset', bytes, 'image/png')
      assert.equal(stored.sizeBytes, bytes.byteLength)

      const read = await storage.get('creator/asset')
      assert.ok(read)
      assert.equal(read.contentType, 'image/png')
      assert.deepEqual([...read.body], [...bytes])
    })
  })

  it('reports a missing file instead of throwing', async () => {
    await withTempDir(async (dir) => {
      const storage = new FileAssetStorage(join(dir, 'assets'))
      assert.equal(await storage.get('creator/nothing'), null)
      assert.equal(await storage.delete('creator/nothing'), false)
    })
  })

  it('cannot be walked out of with a traversal key', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'assets')
      const storage = new FileAssetStorage(root)
      await storage.put('../../escape', 'inside', 'text/plain')
      // The file lands under the root, with the traversal flattened away.
      const escaped = await readFile(join(dir, '..', 'escape'), 'utf8').catch(() => null)
      assert.equal(escaped, null)
    })
  })

  it('deletes the bytes as well as the record', async () => {
    await withTempDir(async (dir) => {
      const storage = new FileAssetStorage(join(dir, 'assets'))
      await storage.put('creator/asset', 'bytes', 'text/plain')
      assert.equal(await storage.delete('creator/asset'), true)
      assert.equal(await storage.get('creator/asset'), null)
    })
  })
})

describe('media library: survives a restart', () => {
  it('restores asset records and their bytes from disk', async () => {
    await withTempDir(async (dir) => {
      // First process: generate something and let it persist.
      const first = await durableContext(dir)
      const firstServer = await startServer(first)
      const firstClient = await signedInClient(firstServer.baseUrl)
      let assetId = ''
      let expectedBytes = ''
      try {
        const created = await firstClient.get('/api/creator/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            platform: 'instagram',
            option: 'TEXT_POST',
            brief: 'a poster that should outlive the process',
          }),
        })
        assert.equal(created.status, 200, created.body)
        assetId = (JSON.parse(created.body) as { asset: { id: string } }).asset.id
        expectedBytes = (JSON.parse(created.body) as { content: string }).content
      } finally {
        await firstServer.close()
      }

      // Second process: same data directory, nothing in memory. The account
      // persisted too, so this signs in rather than signing up.
      const second = await durableContext(dir)
      const secondServer = await startServer(second)
      const secondClient = await signedInExistingClient(secondServer.baseUrl, 'creator@example.com')
      try {
        const list = JSON.parse((await secondClient.get('/api/creator/assets')).body) as {
          assets: Array<{ id: string }>
        }
        assert.equal(list.assets.length, 1, 'the asset index came back')
        assert.equal(list.assets[0]?.id, assetId)

        const file = await secondClient.get(`/api/creator/assets/${assetId}`)
        assert.equal(file.status, 200)
        assert.equal(file.body, expectedBytes, 'the bytes came back unchanged')
      } finally {
        await secondServer.close()
      }
    })
  })

  it('keeps the index and the bytes in step when an asset is deleted', async () => {
    await withTempDir(async (dir) => {
      const first = await durableContext(dir)
      const firstServer = await startServer(first)
      const firstClient = await signedInClient(firstServer.baseUrl)
      let assetId = ''
      try {
        const created = await firstClient.get('/api/creator/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'instagram', option: 'TEXT_POST', brief: 'delete me later' }),
        })
        assetId = (JSON.parse(created.body) as { asset: { id: string } }).asset.id
        const removed = await firstClient.get(`/api/creator/assets/${assetId}`, { method: 'DELETE' })
        assert.equal(removed.status, 200)
      } finally {
        await firstServer.close()
      }

      const second = await durableContext(dir)
      const secondServer = await startServer(second)
      const secondClient = await signedInExistingClient(secondServer.baseUrl, 'creator@example.com')
      try {
        const list = JSON.parse((await secondClient.get('/api/creator/assets')).body) as { assets: unknown[] }
        assert.equal(list.assets.length, 0, 'the deletion was persisted, not just applied')
      } finally {
        await secondServer.close()
      }
    })
  })
})

describe('media library: upload', () => {
  async function uploadable() {
    const context = await testContext(platformRoutes('<p>Reels can be up to 15 seconds long.</p>'))
    await runResearchCycle({
      control: context.control,
      fetcher: context.fetcher,
      respectSchedule: false,
      maxSourcesPerRun: 1,
      clock: CLOCK,
    })
    const server = await startServer(context)
    const client = await signedInClient(server.baseUrl)
    return { server, client }
  }

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80])

  it('stores an upload and serves the exact bytes back', async () => {
    const { server, client } = await uploadable()
    try {
      const created = await client.get('/api/creator/assets?title=my%20logo', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-csrf-token': client.csrf ?? '' },
        body: png,
      })
      assert.equal(created.status, 201, created.body)
      const asset = (JSON.parse(created.body) as { asset: { id: string; kind: string; origin: string } }).asset
      assert.equal(asset.kind, 'IMAGE', 'the kind is inferred from the content type')
      assert.equal(asset.origin, 'UPLOADED')

      const file = await client.getBytes(`/api/creator/assets/${asset.id}`)
      assert.equal(file.status, 200)
      assert.match(file.contentType, /image\/png/)
      // Byte-for-byte: an upload is not text and must not be treated as it.
      assert.deepEqual([...file.body], [...png])
    } finally {
      await server.close()
    }
  })

  it('labels an upload as the creator\'s own work, not a model', async () => {
    const { server, client } = await uploadable()
    try {
      const created = await client.get('/api/creator/assets', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-csrf-token': client.csrf ?? '' },
        body: png,
      })
      const asset = (JSON.parse(created.body) as { asset: { madeWithAI: boolean; producedBy: string } }).asset
      assert.equal(asset.madeWithAI, false)
      assert.match(asset.producedBy, /uploaded/i)
    } finally {
      await server.close()
    }
  })

  it('refuses an empty body and an unknown kind', async () => {
    const { server, client } = await uploadable()
    try {
      const empty = await client.get('/api/creator/assets', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-csrf-token': client.csrf ?? '' },
        body: new Uint8Array(0),
      })
      assert.equal(empty.status, 400)

      const odd = await client.get('/api/creator/assets?kind=NOT_A_KIND', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-csrf-token': client.csrf ?? '' },
        body: png,
      })
      assert.equal(odd.status, 201, 'an unknown kind falls back to one inferred from the file')
      const asset = (JSON.parse(odd.body) as { asset: { kind: string } }).asset
      assert.equal(asset.kind, 'IMAGE')
    } finally {
      await server.close()
    }
  })

  it('requires a session', async () => {
    const { server } = await uploadable()
    try {
      const response = await fetch(`${server.baseUrl}/api/creator/assets`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: png,
      })
      assert.equal(response.status, 401)
    } finally {
      await server.close()
    }
  })

  it("keeps one creator's upload out of another creator's library", async () => {
    const { server, client } = await uploadable()
    try {
      const created = await client.get('/api/creator/assets', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-csrf-token': client.csrf ?? '' },
        body: png,
      })
      const id = (JSON.parse(created.body) as { asset: { id: string } }).asset.id

      const other = await signedInClient(server.baseUrl, { email: 'other@example.com' })
      assert.equal((JSON.parse((await other.get('/api/creator/assets')).body) as { assets: unknown[] }).assets.length, 0)
      assert.equal((await other.get(`/api/creator/assets/${id}`)).status, 403)
      assert.equal((await other.get(`/api/creator/assets/${id}`, { method: 'DELETE' })).status, 403)
    } finally {
      await server.close()
    }
  })
})
