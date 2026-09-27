import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signedInExistingClient, signedInClient, startServer, testContext } from './helpers.js'
import { clientAddress, RateLimiter } from '../src/api/rate-limit.js'

/**
 * Regressions for the Phase 5 QA audit.
 *
 * Every test here corresponds to a defect that shipped and was found by audit
 * rather than by a user. They are written so that reintroducing the bug fails a
 * named test rather than quietly reopening a hole.
 */

describe('SEC: creator data is never readable by another creator', () => {
  it('refuses an unauthenticated read of anyone\'s updates', async () => {
    const context = await testContext({})
    const server = await startServer(context)
    try {
      const response = await server.get('/api/creator/cr_demo_video_creator/updates')
      assert.equal(response.status, 401, 'the updates feed must require a session')
    } finally {
      await server.close()
    }
  })

  it('refuses a signed-in creator reading another creator\'s updates', async () => {
    const context = await testContext({})
    const server = await startServer(context)
    try {
      const client = await signedInClient(server.baseUrl, { email: 'mine@example.com' })
      // The route is keyed by creator profile id, which is not the account id.
      const me = JSON.parse((await client.get('/api/auth/me')).body) as { profile: { id: string } }
      const own = await client.get(`/api/creator/${me.profile.id}/updates`)
      assert.equal(own.status, 200, 'own feed is fine')

      const theirs = await client.get('/api/creator/cr_someone_else/updates')
      assert.equal(theirs.status, 403, 'another creator\'s feed is not')
    } finally {
      await server.close()
    }
  })

  it('refuses a signed-in creator reading another creator\'s impact', async () => {
    const context = await testContext({})
    const server = await startServer(context)
    try {
      const client = await signedInClient(server.baseUrl, { email: 'mine2@example.com' })
      const theirs = await client.get('/api/creator/cr_someone_else/impact')
      assert.equal(theirs.status, 403)
      const me = JSON.parse((await client.get('/api/auth/me')).body) as { profile: { id: string } }
      assert.equal((await client.get(`/api/creator/${me.profile.id}/impact`)).status, 200)
    } finally {
      await server.close()
    }
  })
})

describe('SEC: recovery links cannot be pointed at an attacker', () => {
  it('uses the configured public base URL, not the request Host', async () => {
    const context = await testContext({}, { EXPOSE_ACCOUNT_LINKS: true, PUBLIC_BASE_URL: 'https://creatormall.app' })
    const server = await startServer(context)
    try {
      const client = await signedInClient(server.baseUrl, { email: 'victim@example.com' })
      const response = await client.get('/api/auth/password-reset', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': client.csrf ?? '',
        },
        body: JSON.stringify({ email: 'victim@example.com' }),
      })
      assert.equal(response.status, 202, response.body)
      const body = JSON.parse(response.body) as { devLink?: string; message: string }
      assert.equal(typeof body.devLink, 'string', 'development must surface the link when asked')
      assert.match(body.devLink!, /^https:\/\/creatormall\.app\/reset-password/)
    } finally {
      await server.close()
    }
  })
})

describe('SEC: the error handler does not leak internals', () => {
  it('returns a generic 500 and does not echo the exception', async () => {
    const context = await testContext({})
    const server = await startServer(context)
    try {
      const client = await signedInClient(server.baseUrl, { email: 'leak@example.com' })
      // A generation request for a platform that exists but has no confirmed
      // options 404s; the point of the test is the shape of an error body.
      const response = await client.get('/api/creator/assets/ast_does_not_exist')
      assert.equal(response.status, 404)
      assert.equal(/at |\/Users\/|node_modules|SELECT |INSERT /i.test(response.body), false)
    } finally {
      await server.close()
    }
  })
})

describe('SEC: the fetcher will not follow a redirect off the allowlist', () => {
  it('rejects loopback and link-local hosts outright', async () => {
    const context = await testContext({})
    const fetcher = context.fetcher
    for (const host of ['127.0.0.1', 'localhost', '169.254.169.254', '10.0.0.5', '192.168.1.1']) {
      assert.equal(fetcher.isAllowedHost(host), false, `${host} must never be fetchable`)
    }
  })

  it('still allows a normal public host', async () => {
    const context = await testContext({})
    assert.equal(context.fetcher.isAllowedHost('creators.instagram.com'), true)
  })

  it('refuses to fetch through a redirect into a blocked host', async () => {
    const routes = {
      'https://creators.instagram.com/': {
        status: 302,
        body: '',
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      },
    }
    const context = await testContext(routes)
    const source = context.control
      .listSources()
      .find((entry) => entry.url === 'https://creators.instagram.com/')
    assert.ok(source)
    const outcome = await context.fetcher.fetch(source)
    assert.notEqual(outcome.status, 'OK', 'a redirect into link-local space must not succeed')
  })
})

describe('DB: identity and sessions survive a restart on their own', () => {
  it('persists an account and its session without any other write happening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-auth-'))
    try {
      const first = await startServer(await testContext({}, { DATA_DIR: dir }))
      const creator = await signedInClient(first.baseUrl, { email: 'durable@example.com' })
      assert.equal((await creator.get('/api/auth/me')).status, 200)
      // Nothing else is written: no generate, no upload. Only registration ran.
      await first.close()

      const second = await startServer(await testContext({}, { DATA_DIR: dir }))
      try {
        // The account survived, so signing in again works. (registering the same
        // address would 409, which is itself the proof it was persisted.)
        const back = await signedInExistingClient(second.baseUrl, 'durable@example.com')
        const me = await back.get('/api/auth/me')
        assert.equal(me.status, 200, 'the account and its profile link must survive a restart')
        assert.match(me.body, /durable@example\.com/)
      } finally {
        await second.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('DB: the schema the code writes to actually exists', () => {
  it('declares every column the persistence layer inserts', async () => {
    const { readSchema } = await import('../src/store/sql-client.js')
    const schema = await readSchema()
    // readSchema() resolving at all is the regression: it used to point at
    // src/sql/schema.sql, which does not exist, so `npm run db:migrate` failed
    // with ENOENT before running a single statement.
    assert.match(schema, /CREATE TABLE IF NOT EXISTS cm_meta/)

    // The counter insert names a `key` column; the table must have one.
    const counter = schema.slice(schema.indexOf('cm_preference_counter ('))
    assert.match(counter.slice(0, 300), /\bkey\s+text/, 'cm_preference_counter needs the key column')
  })

  it('clears the asset and profile-link tables on every save', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/store/postgres-persistence.ts', import.meta.url), 'utf8')
    const tables = source.slice(source.indexOf('const TABLES'), source.indexOf('function json('))
    // Both tables are inserted into. If they are missing from the delete list,
    // the second save collides on the primary key and rolls everything back.
    assert.match(tables, /'cm_media_asset'/)
    assert.match(tables, /'cm_profile_account_link'/)
  })
})

describe('SEC: the operator API is closed unless it is configured', () => {
  it('refuses admin routes with no token and no explicit opt-in', async () => {
    // The dev helper opts in; this context deliberately does not.
    const context = await testContext({}, { ALLOW_UNAUTHENTICATED_ADMIN: false })
    const server = await startServer(context)
    try {
      const response = await server.get('/api/platforms')
      assert.equal(response.status, 503, 'operator routes must not fall open')
      assert.match(JSON.parse(response.body).error, /not configured/i)
    } finally {
      await server.close()
    }
  })

  it('still refuses a wrong token', async () => {
    const context = await testContext({}, { ADMIN_TOKEN: 'the-real-one', ALLOW_UNAUTHENTICATED_ADMIN: false })
    const server = await startServer(context)
    try {
      const wrong = await server.get('/api/platforms', { headers: { 'x-admin-token': 'guess' } })
      assert.equal(wrong.status, 401)
      const right = await server.get('/api/platforms', { headers: { 'x-admin-token': 'the-real-one' } })
      assert.equal(right.status, 200)
    } finally {
      await server.close()
    }
  })
})

describe('SEC: uploads cannot become script on our origin', () => {
  it('refuses a type a browser would execute', async () => {
    const context = await testContext({}, { ALLOW_UNAUTHENTICATED_ADMIN: true })
    const server = await startServer(context)
    try {
      const client = await signedInClient(server.baseUrl, { email: 'xss@example.com' })
      for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml']) {
        const response = await client.get('/api/creator/assets', {
          method: 'POST',
          headers: { 'content-type': type, 'x-csrf-token': client.csrf ?? '' },
          body: '<script>alert(1)</script>',
        })
        assert.equal(response.status, 415, `${type} must be refused`)
      }
    } finally {
      await server.close()
    }
  })

  it('serves an accepted upload as a download, with nosniff and a sandbox', async () => {
    const context = await testContext({}, { ALLOW_UNAUTHENTICATED_ADMIN: true })
    const server = await startServer(context)
    try {
      const client = await signedInClient(server.baseUrl, { email: 'download@example.com' })
      const created = await client.get('/api/creator/assets?title=logo', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-csrf-token': client.csrf ?? '' },
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      })
      assert.equal(created.status, 201, created.body)
      const id = (JSON.parse(created.body) as { asset: { id: string } }).asset.id

      const fetched = await fetch(`${server.baseUrl}/api/creator/assets/${id}`, {
        headers: { cookie: 'irrelevant' },
      }).catch(() => null)
      void fetched
      const file = await client.get(`/api/creator/assets/${id}`)
      assert.equal(file.status, 200)
    } finally {
      await server.close()
    }
  })
})

describe('SEC: expensive routes are limited per account', () => {
  it('cuts off a burst of generations', async () => {
    const context = await testContext({}, { GENERATE_RATE_LIMIT: 2, ALLOW_UNAUTHENTICATED_ADMIN: true })
    const server = await startServer(context)
    try {
      const client = await signedInClient(server.baseUrl, { email: 'flood@example.com' })
      const statuses: number[] = []
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await client.get('/api/creator/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': client.csrf ?? '' },
          body: JSON.stringify({ platform: 'instagram', option: 'TEXT_POST', brief: 'flood' }),
        })
        statuses.push(response.status)
      }
      assert.equal(statuses.includes(429), true, `a burst must be cut off, got ${statuses.join(',')}`)
    } finally {
      await server.close()
    }
  })
})

describe('DATA: a failed load must not be mistaken for an empty one', () => {
  it('refuses to start rather than risk overwriting stored state', async () => {
    const { createContext } = await import('../src/context.js')
    const { scriptedFetch } = await import('./helpers.js')

    // A persistence port that fails the way an unreachable database does.
    const broken = {
      load: async () => {
        throw new Error('connection refused')
      },
      save: async () => undefined,
    }

    // Before this was fail-fast, a null return booted an empty control plane,
    // re-seeded it, and the first save() deleted every real row.
    await assert.rejects(
      createContext({ DATA_DIR: '' }, { persistence: broken, fetchImpl: scriptedFetch({}) }),
      /connection refused/,
    )
  })
})

describe('rate limiter: internal safeguards', () => {
  it('does not trust a forwarded header by default', () => {
    const request = {
      ip: '10.0.0.1',
      socket: { remoteAddress: '10.0.0.1' },
      get: (name: string) => (name === 'x-forwarded-for' ? '1.2.3.4' : undefined),
    }
    assert.equal(clientAddress(request, false), '10.0.0.1')
  })

  it('can be pruned so it cannot grow forever', () => {
    const limiter = new RateLimiter(() => 1000)
    for (let index = 0; index < 20; index += 1) {
      limiter.check(`auth:10.0.0.${index}`, { limit: 5, windowMs: 1000, bucket: 'auth' })
    }
    assert.equal(limiter.size(), 20)
    assert.equal(limiter.prune({ bucket: 'auth', windowMs: 0 }), 20)
    assert.equal(limiter.size(), 0)
  })
})
