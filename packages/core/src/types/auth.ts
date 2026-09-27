/** Identity, roles and sessions. Kept in core so the policy is testable alone. */

export const ROLES = ['CREATOR', 'ADMIN'] as const
export type Role = (typeof ROLES)[number]

export const ACCOUNT_STATUSES = ['ACTIVE', 'DISABLED', 'PENDING'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

/**
 * An account is identity and access. It is deliberately separate from
 * `CreatorProfile`, which is the intelligence side (platforms, goals, learned
 * preferences). Losing an account must not lose what the system learned, and
 * learning must never grant access.
 */
export interface CreatorAccount {
  id: string
  email: string
  passwordHash: string
  displayName: string
  role: Role
  status: AccountStatus
  createdAt: string
  lastLoginAt: string | null
  consecutiveFailures: number
  lockedUntil: string | null
}

/** What the client is allowed to see about itself. Never includes the hash. */
export interface PublicAccount {
  id: string
  email: string
  displayName: string
  role: Role
  status: AccountStatus
  createdAt: string
  lastLoginAt: string | null
}

export interface Session {
  id: string
  /** SHA-256 of the cookie token. The token itself is never stored. */
  tokenHash: string
  /** Double-submit token, compared on state-changing requests. */
  csrfToken: string
  accountId: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  revokedAt: string | null
  userAgent: string | null
}

export function toPublicAccount(account: CreatorAccount): PublicAccount {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    role: account.role,
    status: account.status,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
  }
}
