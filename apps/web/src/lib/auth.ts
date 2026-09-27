/** Auth-aware client. The session cookie is HttpOnly, so it rides along. */

export interface PublicAccount {
  id: string
  email: string
  displayName: string
  role: 'CREATOR' | 'ADMIN'
  status: string
  createdAt: string
  lastLoginAt: string | null
}

export interface AuthResult {
  account: PublicAccount
  profile: { id: string; platformSlugs: string[] } | null
  csrfToken: string
}

export class AuthError extends Error {
  readonly problems: string[]

  constructor(message: string, problems: string[] = []) {
    super(message)
    this.name = 'AuthError'
    this.problems = problems
  }
}

const CSRF_HEADER = 'x-csrf-token'

let csrfToken: string | null = null

export function currentCsrfToken(): string | null {
  return csrfToken
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text()
  const payload: unknown = text ? (JSON.parse(text) as unknown) : null

  if (!response.ok) {
    const record = (payload ?? {}) as { error?: unknown; problems?: unknown }
    const message = typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
    const problems = Array.isArray(record.problems) ? record.problems.filter((entry): entry is string => typeof entry === 'string') : []
    throw new AuthError(message, problems)
  }
  return payload as T
}

/** Every mutating call carries the CSRF token issued with the session. */
export async function authedFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = csrfToken
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token && init.method && init.method !== 'GET') headers[CSRF_HEADER] = token

  const extra = (init.headers ?? {}) as Record<string, string>
  const response = await fetch(path, { ...init, headers: { ...headers, ...extra } })
  return parse<T>(response)
}

export async function signUp(input: {
  email: string
  password: string
  displayName: string
  platformSlugs: string[]
}): Promise<AuthResult> {
  const result = await authedFetch<AuthResult>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  csrfToken = result.csrfToken
  return result
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const result = await authedFetch<AuthResult>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  csrfToken = result.csrfToken
  return result
}

export async function restoreSession(): Promise<AuthResult | null> {
  try {
    const response = await fetch('/api/auth/me', { headers: { 'content-type': 'application/json' } })
    if (response.status === 401) {
      csrfToken = null
      return null
    }
    const result = await parse<AuthResult>(response)
    csrfToken = result.csrfToken
    return result
  } catch {
    return null
  }
}

export async function signOut(): Promise<void> {
  try {
    await authedFetch('/api/auth/logout', { method: 'POST' })
  } finally {
    csrfToken = null
  }
}
