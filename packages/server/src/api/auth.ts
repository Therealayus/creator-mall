import type { NextFunction, Request, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import {
  can,
  canSignIn,
  checkPasswordPolicy,
  clearSessionCookie,
  csrfMatches,
  findSessionByToken,
  hashPassword,
  isValidEmail,
  newId,
  newSession,
  normalizeEmail,
  parseCookies,
  SESSION_COOKIE,
  sessionCookieHeader,
  toPublicAccount,
  verifyPassword,
} from '@creator-mall/core'
import type { CreatorAccount, CreatorProfile, Permission, Session } from '@creator-mall/core'
import type { AppContext } from '../context.js'
import { nowIso } from '@creator-mall/core'

declare module 'express-serve-static-core' {
  interface Request {
    account?: CreatorAccount
    session?: Session
  }
}

/** Mutating verbs require the double-submit CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface AuthOutcome {
  account?: CreatorAccount
  session?: Session
}

export function readSession(context: AppContext, request: Request): AuthOutcome {
  const cookies = parseCookies(request.header('cookie'))
  const token = cookies[SESSION_COOKIE]
  if (!token) return {}

  const session = findSessionByToken(context.control.listSessions(), token)
  if (!session) return {}

  const account = context.control.getAccount(session.accountId)
  if (!account || !canSignIn(account.status)) return {}

  return { account, session }
}

/** Attaches the session when present, but never blocks. */
export function attachSession(context: AppContext) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const { account, session } = readSession(context, request)
    if (account) request.account = account
    if (session) request.session = session
    next()
  }
}

export function requireAuth(context: AppContext) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.account) {
      response.status(401).json({ error: 'Please sign in to continue.' })
      return
    }
    if (context.control.listSessions().length > 0 && isCsrfFailure(request)) {
      response.status(403).json({ error: 'Your session expired. Refresh and try again.' })
      return
    }
    next()
  }
}

function isCsrfFailure(request: Request): boolean {
  if (SAFE_METHODS.has(request.method)) return false
  if (!request.session) return false
  return !csrfMatches(request.session, request.header('x-csrf-token'))
}

export function requirePermission(permission: Permission) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.account) {
      response.status(401).json({ error: 'Please sign in to continue.' })
      return
    }
    if (!can(request.account.role, permission)) {
      response.status(403).json({ error: 'You do not have access to that.' })
      return
    }
    next()
  }
}

const registerSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
  displayName: z.string().min(1).max(80),
  /** Optional: the platforms this creator already uses. */
  platformSlugs: z.array(z.string().min(1).max(40)).max(20).default([]),
})

const loginSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
})

const MAX_FAILURES = 5
const LOCK_MS = 15 * 60_000

export function authRoutes(context: AppContext): Router {
  const router = Router()

  router.post('/register', (request, response) => {
    const parsed = registerSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      response.status(400).json({ error: 'Check the form and try again.', problems: flattenIssues(parsed.error) })
      return
    }
    const { email, password, displayName, platformSlugs } = parsed.data

    if (!isValidEmail(email)) {
      response.status(400).json({ error: 'That email address does not look right.', problems: ['Use a real email address.'] })
      return
    }

    const policy = checkPasswordPolicy(password, context.config.PASSWORD_MIN_LENGTH)
    if (policy.problems.length > 0) {
      response.status(400).json({ error: 'Choose a stronger password.', problems: policy.problems })
      return
    }

    if (context.config.REGISTRATION_ENABLED === false) {
      response.status(403).json({ error: 'Creating accounts is turned off right now.' })
      return
    }

    const normalized = normalizeEmail(email)
    if (context.control.getAccountByEmail(normalized)) {
      // Deliberately vague: do not confirm which addresses are registered.
      response.status(409).json({ error: 'That email address cannot be used.', problems: ['Try signing in instead.'] })
      return
    }

    void (async () => {
      const at = nowIso()
      const account: CreatorAccount = {
        id: newId('acc'),
        email: normalized,
        passwordHash: await hashPassword(password),
        displayName: displayName.trim(),
        role: 'CREATOR',
        status: 'ACTIVE',
        createdAt: at,
        lastLoginAt: at,
        consecutiveFailures: 0,
        lockedUntil: null,
      }
      context.control.upsertAccount(account)

      // The intelligence profile is created alongside the account and linked to it.
      const profile: CreatorProfile = {
        id: newId('cr'),
        displayName: account.displayName,
        platformSlugs,
        contentTypes: [],
        usedCapabilityKeys: [],
        goals: [],
        locales: [],
        createdAt: at,
      }
      context.control.upsertCreator(profile)
      context.control.linkProfileToAccount(account.id, profile.id)

      const { session, token } = newSession({
        accountId: account.id,
        ttlMs: context.config.SESSION_TTL_HOURS * 3_600_000,
        userAgent: request.header('user-agent') ?? null,
      })
      context.control.addSession(session)

      response
        .status(201)
        .setHeader('set-cookie', sessionCookieHeader(token, { maxAgeMs: context.config.SESSION_TTL_HOURS * 3_600_000, secure: context.config.COOKIE_SECURE }))
        .json({ account: toPublicAccount(account), profile, csrfToken: session.csrfToken })
    })().catch(() => {
      response.status(500).json({ error: 'Could not create the account just now.' })
    })
  })

  router.post('/login', (request, response) => {
    const parsed = loginSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      response.status(400).json({ error: 'Enter your email and password.' })
      return
    }
    const email = normalizeEmail(parsed.data.email)

    void (async () => {
      const account = context.control.getAccountByEmail(email)
      const genericFailure = { error: 'That email and password do not match.', problems: [] as string[] }

      if (!account) {
        // Spend comparable time so a missing account is not detectable by timing.
        await verifyPassword(parsed.data.password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA')
        response.status(401).json(genericFailure)
        return
      }

      if (account.lockedUntil && new Date(account.lockedUntil).getTime() > Date.now()) {
        response.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' })
        return
      }

      if (!canSignIn(account.status)) {
        response.status(403).json({ error: 'That account is not active.' })
        return
      }

      const ok = await verifyPassword(parsed.data.password, account.passwordHash)
      if (!ok) {
        const failures = account.consecutiveFailures + 1
        context.control.upsertAccount({
          ...account,
          consecutiveFailures: failures,
          lockedUntil: failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MS).toISOString() : null,
        })
        response.status(401).json(genericFailure)
        return
      }

      const at = nowIso()
      context.control.upsertAccount({ ...account, consecutiveFailures: 0, lockedUntil: null, lastLoginAt: at })
      const { session, token } = newSession({
        accountId: account.id,
        ttlMs: context.config.SESSION_TTL_HOURS * 3_600_000,
        userAgent: request.header('user-agent') ?? null,
      })
      context.control.addSession(session)

      response
        .setHeader('set-cookie', sessionCookieHeader(token, { maxAgeMs: context.config.SESSION_TTL_HOURS * 3_600_000, secure: context.config.COOKIE_SECURE }))
        .json({ account: toPublicAccount(account), profile: context.control.profileForAccount(account.id) ?? null, csrfToken: session.csrfToken })
    })().catch(() => {
      response.status(500).json({ error: 'Could not sign you in just now.' })
    })
  })

  router.post('/logout', (request, response) => {
    if (request.session) {
      context.control.replaceSession({ ...request.session, revokedAt: nowIso() })
    }
    response
      .setHeader('set-cookie', clearSessionCookie(context.config.COOKIE_SECURE))
      .json({ ok: true })
  })

  router.get('/me', (request, response) => {
    if (!request.account || !request.session) {
      response.status(401).json({ error: 'Not signed in.' })
      return
    }
    response.json({
      account: toPublicAccount(request.account),
      profile: context.control.profileForAccount(request.account.id) ?? null,
      csrfToken: request.session.csrfToken,
    })
  })

  return router
}

function flattenIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || 'form'}: ${issue.message}`)
}
