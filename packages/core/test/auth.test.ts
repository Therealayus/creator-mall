import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  can,
  canAll,
  canSignIn,
  checkPasswordPolicy,
  clearSessionCookie,
  csrfMatches,
  findSessionByToken,
  hashPassword,
  hashToken,
  isAccountStatus,
  isRole,
  isValidEmail,
  newSession,
  normalizeEmail,
  parseCookies,
  sessionCookieHeader,
  toPublicAccount,
  verifyPassword,
} from '../src/index.js'
import type { CreatorAccount } from '../src/index.js'

const clock = (): number => Date.parse('2026-09-27T12:00:00.000Z')

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse 42')
    assert.equal(await verifyPassword('correct horse 42', hash), true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse 42')
    assert.equal(await verifyPassword('correct horse 43', hash), false)
    assert.equal(await verifyPassword('', hash), false)
  })

  it('never stores the password', async () => {
    const hash = await hashPassword('correct horse 42')
    assert.equal(hash.includes('correct horse'), false)
    assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/)
  })

  it('salts, so the same password hashes differently', async () => {
    const a = await hashPassword('same password 1')
    const b = await hashPassword('same password 1')
    assert.notEqual(a, b)
    assert.equal(await verifyPassword('same password 1', a), true)
    assert.equal(await verifyPassword('same password 1', b), true)
  })

  it('fails closed on a malformed or empty stored hash', async () => {
    for (const stored of ['', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$10$abc$def', 'scrypt$x$y$z$a$b']) {
      assert.equal(await verifyPassword('anything at all', stored), false, stored)
    }
  })

  it('gives plain-language policy problems', () => {
    assert.deepEqual(checkPasswordPolicy('short1').problems, ['Use at least 10 characters.'])
    assert.ok(checkPasswordPolicy('alllettersonly').problems.includes('Include at least one number.'))
    assert.ok(checkPasswordPolicy('1234567890123').problems.includes('Include at least one letter.'))
    assert.deepEqual(checkPasswordPolicy('longenough1').problems, [])
    assert.deepEqual(checkPasswordPolicy('a1'.repeat(250)).problems, ['Use fewer than 200 characters.'])
  })
})

describe('sessions', () => {
  it('issues a token and stores only its hash', () => {
    const { session, token } = newSession({ accountId: 'acc_1', ttlMs: 3_600_000, clock })
    assert.notEqual(session.tokenHash, token)
    assert.equal(session.tokenHash, hashToken(token))
    assert.ok(token.length >= 40)
    assert.equal(session.expiresAt, '2026-09-27T13:00:00.000Z')
  })

  it('finds a live session by token and ignores others', () => {
    const { session, token } = newSession({ accountId: 'acc_1', ttlMs: 3_600_000, clock })
    const sessions = [session]
    assert.equal(findSessionByToken(sessions, token, clock)?.id, session.id)
    assert.equal(findSessionByToken(sessions, 'someone-elses-token', clock), undefined)
  })

  it('ignores expired and revoked sessions', () => {
    const { session, token } = newSession({ accountId: 'acc_1', ttlMs: 1_000, clock })
    const later = (): number => clock() + 2_000
    assert.equal(findSessionByToken([session], token, later), undefined)

    const live = newSession({ accountId: 'acc_1', ttlMs: 3_600_000, clock })
    const revoked = { ...live.session, revokedAt: '2026-09-27T12:00:01.000Z' }
    assert.equal(findSessionByToken([revoked], live.token, clock), undefined)
  })

  it('compares the csrf token without leaking timing', () => {
    const { session } = newSession({ accountId: 'acc_1', ttlMs: 3_600_000, clock })
    assert.equal(csrfMatches(session, session.csrfToken), true)
    assert.equal(csrfMatches(session, `${session.csrfToken}x`), false)
    assert.equal(csrfMatches(session, 'x'.repeat(session.csrfToken.length)), false)
    assert.equal(csrfMatches(session, undefined), false)
    assert.equal(csrfMatches(session, null), false)
    assert.equal(csrfMatches(session, ''), false)
  })

  it('builds a hardened cookie header', () => {
    const header = sessionCookieHeader('token-value', { maxAgeMs: 3_600_000, secure: true })
    assert.match(header, /^cm_session=token-value;/)
    assert.match(header, /HttpOnly/)
    assert.match(header, /SameSite=Lax/)
    assert.match(header, /Max-Age=3600/)
    assert.match(header, /Secure/)

    const insecure = sessionCookieHeader('t', { maxAgeMs: 1000, secure: false })
    assert.equal(insecure.includes('Secure'), false)
    assert.match(clearSessionCookie(false), /Max-Age=0/)
  })

  it('parses a cookie header', () => {
    assert.deepEqual(parseCookies('a=1; cm_session=abc%2Fdef; flag'), { a: '1', cm_session: 'abc/def' })
    assert.deepEqual(parseCookies(undefined), {})
  })
})

describe('roles and permissions', () => {
  it('recognises valid roles and statuses', () => {
    assert.equal(isRole('CREATOR'), true)
    assert.equal(isRole('SUPERUSER'), false)
    assert.equal(isAccountStatus('ACTIVE'), true)
    assert.equal(isAccountStatus('BANNED'), false)
  })

  it('gives creators only self-service and read access', () => {
    assert.equal(can('CREATOR', 'platform:read'), true)
    assert.equal(can('CREATOR', 'account:self'), true)
    assert.equal(can('CREATOR', 'research:run'), false)
    assert.equal(can('CREATOR', 'proposal:decide'), false)
    assert.equal(can('CREATOR', 'source:write'), false)
  })

  it('gives admins everything', () => {
    assert.equal(can('ADMIN', 'research:run'), true)
    assert.equal(can('ADMIN', 'proposal:decide'), true)
    assert.equal(canAll('ADMIN', ['platform:write', 'evolution:read', 'proposal:decide']), true)
    assert.equal(canAll('CREATOR', ['platform:read', 'proposal:decide']), false)
  })

  it('only signs in active accounts', () => {
    assert.equal(canSignIn('ACTIVE'), true)
    assert.equal(canSignIn('DISABLED'), false)
    assert.equal(canSignIn('PENDING'), false)
  })

  it('normalizes and validates email', () => {
    assert.equal(normalizeEmail('  Creator@Example.COM '), 'creator@example.com')
    assert.equal(isValidEmail('creator@example.com'), true)
    assert.equal(isValidEmail('creator@example'), false)
    assert.equal(isValidEmail('no-at-sign'), false)
  })

  it('never exposes the password hash', () => {
    const account: CreatorAccount = {
      id: 'acc_1',
      email: 'creator@example.com',
      passwordHash: 'scrypt$16384$8$1$abc$def',
      displayName: 'Creator',
      role: 'CREATOR',
      status: 'ACTIVE',
      createdAt: '2026-09-27T12:00:00.000Z',
      lastLoginAt: null,
      consecutiveFailures: 0,
      lockedUntil: null,
    }
    const publicView = toPublicAccount(account)
    assert.equal('passwordHash' in publicView, false)
    assert.equal(JSON.stringify(publicView).includes('scrypt'), false)
  })
})
