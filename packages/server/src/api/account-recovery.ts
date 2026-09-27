import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { checkPasswordPolicy, hashPassword, normalizeEmail } from '@creator-mall/core'
import type { CreatorAccount } from '@creator-mall/core'
import type { AppContext } from '../context.js'

/**
 * Account recovery and email verification.
 *
 * Both flows follow the same shape, and both are built around the same rule:
 *
 *   **the token is the only secret, and it is stored hashed.**
 *
 * A database leak therefore yields no usable reset link. Tokens are single use,
 * short lived, and consuming one revokes every session the account had, so a
 * stolen link cannot be replayed after the owner has changed their password.
 *
 * There is no mail provider wired up, and pretending otherwise would be worse
 * than saying so. `Delivery` is a port with one real implementation that writes
 * the link to the log for local development, and the link is only ever returned
 * in the API response outside production.
 */

export interface Delivery {
  /** Sends a link to a person. Must never log the token in production. */
  send(input: { to: string; subject: string; link: string; kind: 'PASSWORD_RESET' | 'VERIFY_EMAIL' }): void
}

export const RESET_TOKEN_TTL_MS = 30 * 60_000
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60_000

/**
 * Development delivery: writes the link to the log so a person can follow it.
 *
 * Refuses to run in production outright, rather than quietly logging a live
 * secret, because the failure mode of forgetting this is someone else's account.
 */
export class LogDelivery implements Delivery {
  private readonly isProduction: boolean

  constructor(isProduction: boolean) {
    this.isProduction = isProduction
  }

  send(input: { to: string; subject: string; link: string; kind: string }): void {
    if (this.isProduction) {
      // The fact that this fired is the signal that a mailer is still missing.
      console.error(`[auth] no mail provider configured; a ${input.kind} email could not be sent`)
      return
    }
    console.log(`[auth] ${input.kind} for ${input.to}: ${input.link}`)
  }
}

export function createDelivery(context: AppContext): Delivery {
  return new LogDelivery(context.config.NODE_ENV === 'production')
}

/** True only when it is safe to hand the link back to the caller. */
export function mayExposeLinks(context: AppContext): boolean {
  return context.config.NODE_ENV !== 'production' && context.config.EXPOSE_ACCOUNT_LINKS === true
}

function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function matches(candidate: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false
  const a = Buffer.from(hashToken(candidate), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export interface RequestResetResult {
  /** Always the same message, whether or not the address exists. */
  response: { accepted: true; message: string }
  /** Only set outside production, so a developer can follow the link. */
  link: string | null
  token: string | null
}

export function requestPasswordReset(context: AppContext, rawEmail: string, baseUrl: string): RequestResetResult {
  const email = normalizeEmail(rawEmail)
  const account = context.control.getAccountByEmail(email)
  const message = 'If that address has an account, a reset link is on its way.'

  // No mail provider, so the same generic answer either way. Nothing here
  // reveals whether an account exists.
  if (!account) {
    return { response: { accepted: true, message }, link: null, token: null }
  }

  const { token, hash } = mintToken()
  context.control.upsertAccount({
    ...account,
    passwordResetTokenHash: hash,
    passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
  } satisfies CreatorAccount)

  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`
  createDelivery(context).send({ to: account.email, subject: 'Reset your password', link, kind: 'PASSWORD_RESET' })

  return {
    response: { accepted: true, message },
    link: mayExposeLinks(context) ? link : null,
    token: mayExposeLinks(context) ? token : null,
  }
}

export type ConfirmResult =
  | { ok: true }
  | { ok: false; status: 400 | 410; error: string }

export async function confirmPasswordReset(
  context: AppContext,
  token: string,
  newPassword: string,
): Promise<ConfirmResult> {
  const accounts = context.control.listAccounts()
  const account = accounts.find((entry) => matches(token, entry.passwordResetTokenHash))
  if (!account) {
    return { ok: false, status: 410, error: 'That reset link is not valid any more. Ask for a new one.' }
  }

  if (!account.passwordResetExpiresAt || new Date(account.passwordResetExpiresAt).getTime() < Date.now()) {
    context.control.upsertAccount({ ...account, passwordResetTokenHash: null, passwordResetExpiresAt: null })
    return { ok: false, status: 410, error: 'That reset link has expired. Ask for a new one.' }
  }

  const policy = checkPasswordPolicy(newPassword, context.config.PASSWORD_MIN_LENGTH)
  if (policy.problems.length > 0) {
    return { ok: false, status: 400, error: 'Choose a stronger password.' }
  }

  context.control.upsertAccount({
    ...account,
    passwordHash: await hashPassword(newPassword),
    // Single use: consuming the token retires it.
    passwordResetTokenHash: null,
    passwordResetExpiresAt: null,
    consecutiveFailures: 0,
    lockedUntil: null,
  })

  // Anyone holding an old session loses it, which is the point of a reset.
  revokeSessions(context, account.id)
  return { ok: true }
}

export function requestEmailVerification(
  context: AppContext,
  account: CreatorAccount,
  baseUrl: string,
): { link: string | null; token: string | null } {
  const { token, hash } = mintToken()
  context.control.upsertAccount({
    ...account,
    emailVerifiedAt: account.emailVerifiedAt ?? null,
    emailVerificationTokenHash: hash,
    emailVerificationExpiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString(),
  })

  const link = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`
  createDelivery(context).send({
    to: account.email,
    subject: 'Confirm your email address',
    link,
    kind: 'VERIFY_EMAIL',
  })
  return { link: mayExposeLinks(context) ? link : null, token: mayExposeLinks(context) ? token : null }
}

export function confirmEmailVerification(
  context: AppContext,
  token: string,
): { ok: true; account: CreatorAccount } | { ok: false; status: 400 | 410; error: string } {
  const account = context.control
    .listAccounts()
    .find((entry) => matches(token, entry.emailVerificationTokenHash))
  if (!account) {
    return { ok: false, status: 410, error: 'That confirmation link is not valid any more.' }
  }
  if (!account.emailVerificationExpiresAt || new Date(account.emailVerificationExpiresAt).getTime() < Date.now()) {
    return { ok: false, status: 410, error: 'That confirmation link has expired. Ask for a new one.' }
  }

  const updated: CreatorAccount = {
    ...account,
    status: 'ACTIVE',
    emailVerifiedAt: new Date().toISOString(),
    emailVerificationTokenHash: null,
    emailVerificationExpiresAt: null,
  }
  context.control.upsertAccount(updated)
  return { ok: true, account: updated }
}

function revokeSessions(context: AppContext, accountId: string): void {
  for (const session of context.control.listSessions()) {
    if (session.accountId !== accountId) continue
    if (session.revokedAt) continue
    context.control.addSession({ ...session, revokedAt: new Date().toISOString() })
  }
}
