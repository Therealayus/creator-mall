import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { stableId } from '@creator-mall/core'
import { ROBOTS_ALLOW_ALL, SEED_HOSTS, html, platformRoutes, startServer, testContext } from './helpers.js'
import { runResearchCycle } from '../src/world-engine/pipeline.js'
import { CLOCK } from './helpers.js'
import type { AppContext } from '../src/context.js'

const CREDENTIALS = { email: 'creator@example.com', password: 'filminginthecloud7' }

interface Client {
  get: (path: string, init?: RequestInit) => Promise<{ status: number; body: string; cookies: string }>
  csrf: string | null
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

async function signUp(
  base: string,
  overrides: Partial<typeof CREDENTIALS & { displayName: string; platformSlugs: string[] }> = {},
): Promise<{ client: Client; accountId: string }> {
  const cookie = { value: '' }
  const state: Client = {
    csrf: null,
    get: async (path, init) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cookie.value) headers.cookie = cookie.value
      if (state.csrf && init?.method && init.method !== 'GET') headers['x-csrf-token'] = state.csrf
      const response = await fetch(base + path, { ...init, headers: { ...headers, ...(init?.headers as object) } })
      const body = await response.text()
      if (response.headers.get('set-cookie')) cookie.value = cookieFrom(response)
      if (state.csrf === null && response.ok) {
        try {
          const parsed = JSON.parse(body) as { csrfToken?: string }
          state.csrf = parsed.csrfToken ?? null
        } catch {
          state.csrf = null
        }
      }
      return { status: response.status, body, cookies: cookie.value }
    },
  }

  const response = await state.get('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'Demo creator', platformSlugs: ['instagram'], ...CREDENTIALS, ...overrides }),
  })
  assert.equal(response.status, 201, response.body)
  const account = JSON.parse(response.body).account as { id: string }
  return { client: state, accountId: account.id }
}

async function world(overrides: Partial<AppContext['config']> = {}): Promise<AppContext> {
  return testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'), overrides)
}

describe('accounts and sessions', () => {
  it('signs a new creator up, signs them in and reads their own session', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      const { client } = await signUp(server.baseUrl)

      const me = await client.get('/api/auth/me')
      assert.equal(me.status, 200)
      const body = JSON.parse(me.body)
      assert.equal(body.account.email, CREDENTIALS.email)
      assert.equal(body.account.role, 'CREATOR')
      assert.equal(body.account.displayName, 'Demo creator')
      assert.equal('passwordHash' in body.account, false)
      assert.equal(me.body.includes('scrypt$'), false)
      assert.ok(body.profile)
      assert.deepEqual(body.profile.platformSlugs, ['instagram'])
      assert.ok(body.csrfToken)
    } finally {
      await server.close()
    }
  })

  it('never stores the password in the control plane', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      await signUp(server.baseUrl)
      const serialized = JSON.stringify(context.control.toState())
      assert.equal(serialized.includes(CREDENTIALS.password), false)
      assert.equal(serialized.includes('scrypt$16384$8$1$'), true, 'the hash itself is stored')
      assert.equal(/sk-/.test(serialized), false)
    } finally {
      await server.close()
    }
  })

  it('rejects a weak password with problems a creator can act on', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      const response = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'weak@example.com', password: 'short', displayName: 'Weak' }),
      })
      assert.equal(response.status, 400)
      const body = JSON.parse(await response.text())
      assert.ok(body.problems.length > 0)
      assert.match(body.problems[0], /at least 10 characters/i)
    } finally {
      await server.close()
    }
  })

  it('refuses a duplicate email without confirming it exists', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      await signUp(server.baseUrl)
      const response = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...CREDENTIALS, displayName: 'Impostor' }),
      })
      assert.equal(response.status, 409)
      assert.equal((await response.text()).includes('already registered'), false)
    } finally {
      await server.close()
    }
  })

  it('locks an account after repeated wrong passwords', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      const { client } = await signUp(server.baseUrl)
      await client.get('/api/auth/logout', { method: 'POST' })

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: CREDENTIALS.email, password: 'wrongpassword1' }),
        })
        assert.equal(response.status, 401)
      }

      // Even the correct password is now refused.
      const locked = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(CREDENTIALS),
      })
      assert.equal(locked.status, 429)

      const account = context.control.getAccountByEmail(CREDENTIALS.email)
      assert.ok(account?.lockedUntil)
    } finally {
      await server.close()
    }
  })

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      await signUp(server.baseUrl)
      const unknown = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever1234' }),
      })
      const wrong = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: CREDENTIALS.email, password: 'whatever1234' }),
      })
      assert.equal(unknown.status, wrong.status)
      assert.equal(await unknown.text(), await wrong.text())
    } finally {
      await server.close()
    }
  })

  it('signs out and invalidates the session immediately', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      const { client } = await signUp(server.baseUrl)
      assert.equal((await client.get('/api/auth/me')).status, 200)

      const out = await client.get('/api/auth/logout', { method: 'POST' })
      assert.equal(out.status, 200)
      assert.equal((await client.get('/api/auth/me')).status, 401)
      assert.equal(context.control.listSessions().every((session) => session.revokedAt !== null), true)
    } finally {
      await server.close()
    }
  })
})

describe('access control', () => {
  it('requires a session for creator data', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      const anonymous = await fetch(`${server.baseUrl}/api/creator/overview`)
      assert.equal(anonymous.status, 401)
      assert.match((await anonymous.text()).toLowerCase(), /sign in/)

      const { client } = await signUp(server.baseUrl)
      const signedIn = await client.get('/api/creator/overview')
      assert.equal(signedIn.status, 200)
    } finally {
      await server.close()
    }
  })

  it('rejects a mutating request without the csrf token', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      const { client } = await signUp(server.baseUrl)
      const savedCsrf = client.csrf
      client.csrf = null

      const blocked = await client.get('/api/creator/draft', {
        method: 'POST',
        body: JSON.stringify({ platform: 'instagram', option: 'TEXT_POST', brief: 'hello' }),
      })
      assert.equal(blocked.status, 403)

      client.csrf = savedCsrf
      const allowed = await client.get('/api/creator/draft', {
        method: 'POST',
        body: JSON.stringify({ platform: 'instagram', option: 'TEXT_POST', brief: 'hello' }),
      })
      assert.equal(allowed.status, 200)
    } finally {
      await server.close()
    }
  })

  it('keeps one creator out of another creator\'s data', async () => {
    // The docs change between the two cycles, so a real event is detected. Every
    // seeded host serves the same page, so the cycle cannot miss it by picking a
    // different source.
    let fetchCount = 0
    const body = (): string =>
      html(
        fetchCount++ === 0
          ? '<p>Reels can be up to 90 seconds long.</p>'
          : '<p>Reels can be up to 15 seconds long.</p>',
      )

    const routes: Record<string, { body: string | (() => string); contentType: string }> = {}
    for (const host of SEED_HOSTS) {
      routes[`https://${host}/robots.txt`] = { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' }
      routes[`https://${host}/`] = { body, contentType: 'text/html' }
    }
    const context = await testContext(routes)
    // Isolate the test to one platform, so a shared documentation host cannot
    // deliver the change to a platform another creator uses.
    for (const platform of context.control.listPlatforms()) {
      if (platform.slug !== 'instagram') context.control.upsertPlatform({ ...platform, status: 'SUNSET' })
    }
    const server = await startServer(context)
    try {
      const a = await signUp(server.baseUrl, { email: 'a@example.com' })
      // Creator B uses a platform no change will touch.
      const b = await signUp(server.baseUrl, { email: 'b@example.com', platformSlugs: ['mastodon'] })

      const cycle = () =>
        runResearchCycle({
          control: context.control,
          fetcher: context.fetcher,
          respectSchedule: false,
          maxSourcesPerRun: 1,
          clock: CLOCK,
        })

      await cycle() // baseline
      await cycle() // the limit changes, so A is notified

      const aOverview = JSON.parse((await a.client.get('/api/creator/overview')).body)
      assert.equal(aOverview.updates.length, 1)
      assert.equal(aOverview.updates[0].platform, 'instagram')

      const bOverview = JSON.parse((await b.client.get('/api/creator/overview')).body)
      assert.equal(bOverview.updates.length, 0)
      assert.notEqual(bOverview.creator.id, aOverview.creator.id)
    } finally {
      await server.close()
    }
  })

  it('does not let a creator reach operator data', async () => {
    const context = await world({ ADMIN_TOKEN: 'operator-token' })
    const server = await startServer(context)
    try {
      const { client } = await signUp(server.baseUrl)

      for (const path of ['/api/evolution/summary', '/api/sources', '/api/platforms', '/api/knowledge/documents', '/evolution-center']) {
        const response = await client.get(path)
        assert.equal(response.status, 403, `${path} should be closed to creators`)
      }

      const withToken = await client.get('/api/sources', { headers: { 'x-admin-token': 'operator-token' } })
      assert.equal(withToken.status, 200)
    } finally {
      await server.close()
    }
  })

  it('lets an admin session through without a token', async () => {
    const context = await world({ ADMIN_TOKEN: 'operator-token' })
    const server = await startServer(context)
    try {
      const { client, accountId } = await signUp(server.baseUrl)
      const account = context.control.getAccount(accountId)!
      context.control.upsertAccount({ ...account, role: 'ADMIN' })

      const response = await client.get('/api/evolution/summary')
      assert.equal(response.status, 200)
    } finally {
      await server.close()
    }
  })

  it('keeps health open for monitoring but does not leak creator data', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      const response = await fetch(`${server.baseUrl}/api/health`)
      assert.equal(response.status, 200)
      const body = await response.text()
      assert.equal(body.includes(CREDENTIALS.email), false)
      assert.equal(body.includes('scrypt'), false)
    } finally {
      await server.close()
    }
  })

  it('can turn registration off', async () => {
    const context = await world({ REGISTRATION_ENABLED: false })
    const server = await startServer(context)
    try {
      const response = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...CREDENTIALS, displayName: 'Late' }),
      })
      assert.equal(response.status, 403)
    } finally {
      await server.close()
    }
  })

  it('ignores a forged session cookie', async () => {
    const context = await world()
    const server = await startServer(context)
    try {
      const response = await fetch(`${server.baseUrl}/api/creator/overview`, {
        headers: { cookie: `cm_session=${stableId('fake')}` },
      })
      assert.equal(response.status, 401)
    } finally {
      await server.close()
    }
  })
})

describe('seeded demo access', () => {
  it('keeps the demo creator available in development only', async () => {
    const context = await world()
    assert.equal(context.control.listAccounts().length, 0, 'no demo account is created with a real password')

    const server = await startServer(context)
    try {
      const response = await fetch(`${server.baseUrl}/api/creator/overview`)
      assert.equal(response.status, 401, 'creator data still requires a session')
    } finally {
      await server.close()
    }
  })
})
