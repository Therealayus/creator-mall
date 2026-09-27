import { createHash, randomBytes } from 'node:crypto'
import type { Session } from '../types/auth.js'
import { newId, nowIso } from '../util.js'

export const SESSION_COOKIE = 'cm_session'
export const CSRF_HEADER = 'x-csrf-token'

/**
 * Opaque server-side sessions.
 *
 * The cookie carries 32 random bytes; only its SHA-256 is stored, so a leaked
 * database does not hand out live sessions. Tokens are revocable by design,
 * which is why this is not a self-contained JWT.
 */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function createCsrfToken(): string {
  return randomBytes(24).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface CreateSessionInput {
  accountId: string
  ttlMs: number
  userAgent?: string | null
  clock?: () => number
}

export function newSession(input: CreateSessionInput): { session: Session; token: string } {
  const clock = input.clock ?? Date.now
  const now = clock()
  const token = createSessionToken()

  return {
    token,
    session: {
      id: newId('ses', clock),
      tokenHash: hashToken(token),
      csrfToken: createCsrfToken(),
      accountId: input.accountId,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      revokedAt: null,
      userAgent: input.userAgent ?? null,
    },
  }
}

export function findSessionByToken(sessions: ReadonlyArray<Session>, token: string, clock: () => number = Date.now): Session | undefined {
  const hash = hashToken(token)
  return sessions.find(
    (session) => session.tokenHash === hash && session.revokedAt === null && !isExpired(session, clock),
  )
}

export function isExpired(session: Session, clock: () => number = Date.now): boolean {
  return new Date(session.expiresAt).getTime() <= clock()
}

export function isRevoked(session: Session): boolean {
  if (!session.revokedAt) return false
  return true
}

export function revokeSession(session: Session, clock: () => number = Date.now): Session {
  return { ...session, revokedAt: nowIso(clock) }
}

export function touchSession(session: Session, clock: () => number = Date.now): Session {
  return { ...session, lastSeenAt: nowIso(clock) }
}

/** Constant-time comparison for the CSRF double-submit token. */
export function csrfMatches(session: Session, provided: string | undefined | null): boolean {
  if (!provided || provided.length !== session.csrfToken.length) return false
  let mismatch = 0
  for (let index = 0; index < provided.length; index += 1) {
    mismatch |= provided.charCodeAt(index) ^ session.csrfToken.charCodeAt(index)
  }
  return mismatch === 0
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const result: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) result[key] = decodeURIComponent(value)
  }
  return result
}

export function sessionCookieHeader(token: string, options: { maxAgeMs: number; secure: boolean; sameSite?: 'Lax' | 'Strict' }): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor(options.maxAgeMs / 1000)}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'Max-Age=0', 'SameSite=Lax']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
