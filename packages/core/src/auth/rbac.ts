import type { AccountStatus, Role } from '../types/auth.js'
import { ACCOUNT_STATUSES, ROLES } from '../types/auth.js'

/**
 * Authorisation policy, in one place.
 *
 * Routes ask "may this role do this?" instead of scattering role comparisons, so
 * the answer to "who can see what?" is a table rather than a grep.
 */
export const PERMISSIONS = [
  'platform:read',
  'platform:write',
  'knowledge:read',
  'research:run',
  'proposal:decide',
  'source:write',
  'evolution:read',
  'account:self',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const CREATOR_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'platform:read',
  'knowledge:read',
  'account:self',
])

const ADMIN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(PERMISSIONS)

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

export function isAccountStatus(value: string): value is AccountStatus {
  return (ACCOUNT_STATUSES as readonly string[]).includes(value)
}

export function can(role: Role, permission: Permission): boolean {
  return role === 'ADMIN' ? ADMIN_PERMISSIONS.has(permission) : CREATOR_PERMISSIONS.has(permission)
}

export function canAll(role: Role, permissions: ReadonlyArray<Permission>): boolean {
  return permissions.every((permission) => can(role, permission))
}

export function canSignIn(status: AccountStatus): boolean {
  return status === 'ACTIVE'
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidEmail(value: string): boolean {
  const email = normalizeEmail(value)
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254
}
