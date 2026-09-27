import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clientAddress, RateLimiter } from '../src/api/rate-limit.js'
import { signedInClient, signedInExistingClient, startServer, testContext } from './helpers.js'

/**
 * Auth hardening.
 *
 * The properties under test are the ones an attacker would lean on: find out who
 * has an account, reuse a stolen link, keep a session after a password change,
 * or grind a single address. Each of those has a test here that says it does not
 * work.
 */

function json(body: unknown, csrf?: string) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: JSON.stringify(body),
  }
}

async function app(overrides: Record<string, unknown> = {}) {
  const context = await testContext({}, overrides)
  const server = await startServer(context)
  return { context, server }
}

describe('rate limiting', () => {
  it('allows up to the limit, then refuses and says when to return', () => {
    const limiter = new RateLimiter(() => 1_000)
    const options = { limit: 3, windowMs: 60_000, bucket: 'auth' }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const decision = limiter.check('auth:1.2.3.4', options)
      assert.equal(decision.allowed, true, `attempt ${attempt} should pass`)
      assert.equal(decision.remaining, 3 - attempt)
    }
    const refused = limiter.check('auth:1.2.3.4', options)
    assert.equal(refused.allowed, false)
    assert.equal(refused.retryAfterSeconds > 0, true)
  })

  it('limits each address separately', () => {
    const limiter = new RateLimiter(() => 1_000)
    const options = { limit: 1, windowMs: 60_000, bucket: 'auth' }
    assert.equal(limiter.check('auth:1.1.1.1', options).allowed, true)
    assert.equal(limiter.check('auth:1.1.1.1', options).allowed, false)
    assert.equal(limiter.check('auth:2.2.2.2', options).allowed, true, 'a different address has its own allowance')
  })

  it('keeps buckets apart so one slow route does not block another', () => {
    const limiter = new RateLimiter(() => 1_000)
    assert.equal(limiter.check('auth:1.1.1.1', { limit: 1, windowMs: 60_000, bucket: 'auth' }).allowed, true)
    assert.equal(limiter.check('auth:1.1.1.1', { limit: 1, windowMs: 60_000, bucket: 'auth' }).allowed, false)
    assert.equal(
      limiter.check('password-reset:1.1.1.1', { limit: 1, windowMs: 60_000, bucket: 'password-reset' }).allowed,
      true,
    )
  })

  it('lets the window slide rather than resetting on a boundary', () => {
    let now = 1_000
    const limiter = new RateLimiter(() => now)
    const options = { limit: 2, windowMs: 1_000, bucket: 'auth' }
    limiter.check('auth:1.1.1.1', options)
    limiter.check('auth:1.1.1.1', options)
    assert.equal(limiter.check('auth:1.1.1.1', options).allowed, false)

    now += 1_001
    assert.equal(limiter.check('auth:1.1.1.1', options).allowed, true, 'the old requests have left the window')
  })

  it('clears an allowance for an honest client', () => {
    const limiter = new RateLimiter(() => 1_000)
    const options = { limit: 1, windowMs: 60_000, bucket: 'auth' }
    limiter.check('auth:1.1.1.1', options)
    limiter.reset('auth:1.1.1.1')
    assert.equal(limiter.check('auth:1.1.1.1', options).allowed, true)
  })

  it('does not grow without bound', () => {
    const limiter = new RateLimiter(() => 1_000)
    for (let index = 0; index < 50; index += 1) {
      limiter.check(`auth:10.0.0.${index}`, { limit: 5, windowMs: 60_000, bucket: 'auth' })
    }
    assert.equal(limiter.size(), 50)
    assert.equal(limiter.prune({ bucket: 'auth', windowMs: 0 }), 50)
    assert.equal(limiter.size(), 0)
  })

  it('ignores a forwarded header unless the operator trusts the proxy', () => {
    const request = {
      ip: '10.0.0.1',
      socket: { remoteAddress: '10.0.0.1' },
      get: (name: string) => (name === 'x-forwarded-for' ? '1.2.3.4' : undefined),
    }
    assert.equal(clientAddress(request, false), '10.0.0.1', 'a header anyone can set is not an identity')
    assert.equal(clientAddress(request, true), '1.2.3.4')
    assert.equal(clientAddress({ socket: { remoteAddress: '10.0.0.9' } }, false), '10.0.0.9')
  })

  it('refuses a burst of sign-in attempts over HTTP', async () => {
    const { server } = await app({ AUTH_RATE_LIMIT: 3, AUTH_RATE_WINDOW_MS: 60_000 })
    try {
      const statuses: number[] = []
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await server.get(
          '/api/auth/login',
          json({ email: 'someone@example.com', password: 'not-the-password' }),
        )
        statuses.push(response.status)
      }
      assert.equal(statuses.filter((status) => status === 429).length > 0, true, 'a burst should be cut off')
    } finally {
      await server.close()
    }
  })
})

describe('password reset', () => {
  it('gives the same answer whether or not the address exists', async () => {
    const { server } = await app({ EXPOSE_ACCOUNT_LINKS: true })
    try {
      const known = await testContext({})
      void known
      const context = known
      const s = await startServer(context)
      try {
        const client = await signedInClient(s.baseUrl, { email: 'real@example.com' })
        void client
        const existing = await s.get('/api/auth/password-reset', json({ email: 'real@example.com' }))
        const unknown = await s.get('/api/auth/password-reset', json({ email: 'nobody@example.com' }))
        assert.equal(existing.status, 202)
        assert.equal(unknown.status, 202)
        assert.equal(JSON.parse(existing.body).message, JSON.parse(unknown.body).message)
        assert.equal('devToken' in JSON.parse(unknown.body), false, 'a made-up address gets no token')
      } finally {
        await s.close()
      }
    } finally {
      await server.close()
    }
  })

  it('changes the password and revokes every existing session', async () => {
    const { context, server } = await app({ EXPOSE_ACCOUNT_LINKS: true })
    try {
      const client = await signedInClient(server.baseUrl, { email: 'reset@example.com' })
      const request = await client.get('/api/auth/password-reset', json({ email: 'reset@example.com' }))
      const { devToken } = JSON.parse(request.body) as { devToken: string }
      assert.equal(typeof devToken, 'string')

      const confirmed = await server.get(
        '/api/auth/password-reset/confirm',
        json({ token: devToken, password: 'a-brand-new-password-9' }),
      )
      assert.equal(confirmed.status, 200)

      // The old session must be dead, and the new password must work.
      assert.equal((await client.get('/api/auth/me')).status, 401)
      const signIn = await server.get('/api/auth/login', json({ email: 'reset@example.com', password: 'a-brand-new-password-9' }))
      assert.equal(signIn.status, 200)
      void context
    } finally {
      await server.close()
    }
  })

  it('will not accept the same link twice', async () => {
    const { server } = await app({ EXPOSE_ACCOUNT_LINKS: true })
    try {
      const client = await signedInClient(server.baseUrl, { email: 'once@example.com' })
      const request = await client.get('/api/auth/password-reset', json({ email: 'once@example.com' }))
      const { devToken } = JSON.parse(request.body) as { devToken: string }

      const first = await server.get(
        '/api/auth/password-reset/confirm',
        json({ token: devToken, password: 'first-new-password-9' }),
      )
      assert.equal(first.status, 200)
      const second = await server.get(
        '/api/auth/password-reset/confirm',
        json({ token: devToken, password: 'second-new-password-9' }),
      )
      assert.equal(second.status, 410, 'a reset link is single use')
    } finally {
      await server.close()
    }
  })

  it('never stores the token itself', async () => {
    const { context, server } = await app({ EXPOSE_ACCOUNT_LINKS: true })
    try {
      const client = await signedInClient(server.baseUrl, { email: 'hashed@example.com' })
      const request = await client.get('/api/auth/password-reset', json({ email: 'hashed@example.com' }))
      const { devToken } = JSON.parse(request.body) as { devToken: string }
      const account = context.control.getAccountByEmail('hashed@example.com')!
      assert.equal(account.passwordResetTokenHash === devToken, false)
      assert.equal(typeof account.passwordResetTokenHash, 'string')
    } finally {
      await server.close()
    }
  })

  it('refuses a weak new password', async () => {
    const { server } = await app({ EXPOSE_ACCOUNT_LINKS: true })
    try {
      const client = await signedInClient(server.baseUrl, { email: 'weak@example.com' })
      const request = await client.get('/api/auth/password-reset', json({ email: 'weak@example.com' }))
      const { devToken } = JSON.parse(request.body) as { devToken: string }
      const response = await server.get(
        '/api/auth/password-reset/confirm',
        json({ token: devToken, password: 'abc' }),
      )
      assert.equal(response.status, 400)
    } finally {
      await server.close()
    }
  })

  it('rejects a token it never issued', async () => {
    const { server } = await app()
    try {
      const response = await server.get(
        '/api/auth/password-reset/confirm',
        json({ token: 'not-a-real-token-at-all', password: 'a-strong-password-9' }),
      )
      assert.equal(response.status, 410)
    } finally {
      await server.close()
    }
  })

  it('never hands back a link in production', async () => {
    const { server } = await app({ EXPOSE_ACCOUNT_LINKS: true, NODE_ENV: 'production' })
    try {
      const client = await signedInClient(server.baseUrl, { email: 'prod@example.com' })
      const request = await client.get('/api/auth/password-reset', json({ email: 'prod@example.com' }))
      const body = JSON.parse(request.body) as Record<string, unknown>
      assert.equal('devToken' in body, false, 'a production response must never carry a reset token')
      assert.equal('devLink' in body, false)
    } finally {
      await server.close()
    }
  })

  it('needs no session, because the token is the guard', async () => {
    const { server } = await app()
    try {
      // A person who cannot sign in is the whole reason this flow exists, so it
      // must not require a session. What stands in for one is the single-use
      // token, which is checked above and cannot be replayed.
      const response = await server.get(
        '/api/auth/password-reset/confirm',
        json({ token: 'whatever-the-token-is', password: 'a-strong-password-9' }),
      )
      assert.equal(response.status, 410)
      assert.match(JSON.parse(response.body).error, /not valid any more/i)
    } finally {
      await server.close()
    }
  })
})

describe('email verification', () => {
  it('confirms an address with the token it issued', async () => {
    const { context, server } = await app({ EXPOSE_ACCOUNT_LINKS: true })
    try {
      await signedInClient(server.baseUrl, { email: 'verify@example.com' })
      const account = context.control.getAccountByEmail('verify@example.com')!
      assert.equal(account.emailVerifiedAt ?? null, null, 'nothing is confirmed until it is')

      const { requestEmailVerification } = await import('../src/api/account-recovery.js')
      const { token } = requestEmailVerification(context, account, 'http://localhost:4000')
      assert.equal(typeof token, 'string')

      const response = await server.get('/api/auth/verify-email', json({ token: token! }))
      assert.equal(response.status, 200)
      assert.equal(typeof context.control.getAccountByEmail('verify@example.com')?.emailVerifiedAt, 'string')
    } finally {
      await server.close()
    }
  })

  it('holds sign-in back until the address is confirmed, when asked to', async () => {
    const { context, server } = await app({ REQUIRE_EMAIL_VERIFICATION: true, EXPOSE_ACCOUNT_LINKS: true })
    try {
      const created = await server.get(
        '/api/auth/register',
        json({ email: 'pending@example.com', password: 'filminginthecloud7', displayName: 'Pending' }),
      )
      assert.equal(created.status, 201)
      assert.equal(context.control.getAccountByEmail('pending@example.com')?.status, 'PENDING')

      const blocked = await server.get(
        '/api/auth/login',
        json({ email: 'pending@example.com', password: 'filminginthecloud7' }),
      )
      assert.equal(blocked.status, 403)
      assert.match(JSON.parse(blocked.body).error, /Confirm your email/i)

      // Registration hands back the token outside production, the way the reset
      // flow does, so the loop can be closed without a mail provider.
      const { devVerifyToken } = JSON.parse(created.body) as { devVerifyToken?: string }
      assert.equal(typeof devVerifyToken, 'string')
      const confirmed = await server.get('/api/auth/verify-email', json({ token: devVerifyToken! }))
      assert.equal(confirmed.status, 200)

      const allowed = await server.get(
        '/api/auth/login',
        json({ email: 'pending@example.com', password: 'filminginthecloud7' }),
      )
      assert.equal(allowed.status, 200)
    } finally {
      await server.close()
    }
  })

  it('leaves sign-in alone when verification is not required', async () => {
    const { server } = await app()
    try {
      const client = await signedInClient(server.baseUrl, { email: 'normal@example.com' })
      assert.equal((await client.get('/api/auth/me')).status, 200)
    } finally {
      await server.close()
    }
  })

  it('rejects a confirmation token twice', async () => {
    const { context, server } = await app({ EXPOSE_ACCOUNT_LINKS: true })
    try {
      await signedInClient(server.baseUrl, { email: 'twice@example.com' })
      const account = context.control.getAccountByEmail('twice@example.com')!
      const { requestEmailVerification } = await import('../src/api/account-recovery.js')
      const { token } = requestEmailVerification(context, account, 'http://localhost:4000')

      assert.equal((await server.get('/api/auth/verify-email', json({ token: token! }))).status, 200)
      assert.equal((await server.get('/api/auth/verify-email', json({ token: token! }))).status, 410)
    } finally {
      await server.close()
    }
  })
})

describe('sessions after recovery', () => {
  it('lets the owner back in on a new password and keeps the old one out', async () => {
    const { server } = await app({ EXPOSE_ACCOUNT_LINKS: true })
    try {
      await signedInClient(server.baseUrl, { email: 'rotate@example.com' })
      const request = await server.get('/api/auth/password-reset', json({ email: 'rotate@example.com' }))
      const { devToken } = JSON.parse(request.body) as { devToken: string }
      await server.get('/api/auth/password-reset/confirm', json({ token: devToken, password: 'rotated-password-99' }))

      const old = await server.get('/api/auth/login', json({ email: 'rotate@example.com', password: 'filminginthecloud7' }))
      assert.equal(old.status, 401, 'the old password must stop working')

      const fresh = await signedInExistingClient(server.baseUrl, 'rotate@example.com', 'rotated-password-99')
      assert.equal((await fresh.get('/api/auth/me')).status, 200)
    } finally {
      await server.close()
    }
  })
})
