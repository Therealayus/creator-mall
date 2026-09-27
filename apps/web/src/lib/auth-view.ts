import type { AuthError } from '../lib/auth.js'

/**
 * Sign-in form logic, kept pure so it can be tested without a browser.
 */

export type AuthMode = 'signin' | 'signup'

export interface AuthFormState {
  mode: AuthMode
  email: string
  password: string
  displayName: string
  platformSlugs: string[]
  submitLabel: string
  busy: boolean
  error: string | null
  problems: string[]
}

export const PLATFORM_CHOICES: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: 'instagram', label: 'Instagram' },
  { slug: 'youtube', label: 'YouTube' },
  { slug: 'tiktok', label: 'TikTok' },
  { slug: 'linkedin', label: 'LinkedIn' },
  { slug: 'x', label: 'X' },
  { slug: 'facebook', label: 'Facebook' },
]

export function initialForm(mode: AuthMode): AuthFormState {
  return {
    mode,
    email: '',
    password: '',
    displayName: '',
    platformSlugs: [],
    submitLabel: mode === 'signin' ? 'Sign in' : 'Create my account',
    busy: false,
    error: null,
    problems: [],
  }
}

export function withMode(state: AuthFormState, mode: AuthMode): AuthFormState {
  return { ...initialForm(mode), email: state.email }
}

export function withField<K extends keyof AuthFormState>(state: AuthFormState, field: K, value: AuthFormState[K]): AuthFormState {
  return { ...state, [field]: value }
}

/** Editing a field clears the previous complaint, so the form feels responsive. */
export function clearFeedback(state: AuthFormState): AuthFormState {
  return { ...state, error: null, problems: [] }
}

export function togglePlatform(state: AuthFormState, slug: string): AuthFormState {
  const selected = state.platformSlugs.includes(slug)
  return {
    ...state,
    platformSlugs: selected ? state.platformSlugs.filter((entry) => entry !== slug) : [...state.platformSlugs, slug],
  }
}

export interface FormValidity {
  valid: boolean
  problems: string[]
}

/** Client-side checks mirror the server's rules, so the form explains itself first. */
export function validateForm(state: AuthFormState): FormValidity {
  const problems: string[] = []

  if (!state.email.includes('@') || state.email.length < 5) problems.push('Enter the email address you use.')
  if (state.mode === 'signup' && state.displayName.trim().length === 0) problems.push('Tell us what to call you.')

  if (state.password.length === 0) {
    problems.push('Enter your password.')
  } else if (state.mode === 'signup') {
    if (state.password.length < 10) problems.push('Use at least 10 characters.')
    if (!/[a-z]/i.test(state.password)) problems.push('Include at least one letter.')
    if (!/\d/.test(state.password)) problems.push('Include at least one number.')
  }

  return { valid: problems.length === 0, problems }
}

export function problemsFrom(error: unknown): { message: string; problems: string[] } {
  const candidate = error as Partial<AuthError> | null
  return {
    message: candidate?.message ?? 'Something went wrong. Try again.',
    problems: candidate?.problems ?? [],
  }
}

export function sessionHeadline(account: { displayName: string } | null): string {
  return account ? `Signed in as ${account.displayName}` : 'Sign in to Creator Mall'
}
