import { authedFetch } from './auth.js'

/**
 * Typed client for the creator-facing API.
 *
 * The web app only ever talks to `/api/creator/*`, which is written in plain
 * language. Nothing here knows what a capability, snapshot or adapter is.
 */

export interface CreatorOption {
  key: string
  label: string
  description: string
  enabled: boolean
  unavailableReason: string | null
  media: 'NONE' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'ANY'
  limits: LimitHint[]
}

export interface LimitHint {
  label: string
  display: string
}

export interface CreatorPlatformCard {
  slug: string
  name: string
  status: string
  publishing: boolean
  publishingNote: string
  options: CreatorOption[]
  lastCheckedAt: string | null
  knowledgeFreshness: 'CURRENT' | 'STALE' | 'UNKNOWN'
}

export interface CreatorUpdateCard {
  id: string
  platform: string
  title: string
  body: string
  when: string
  read: boolean
  suggested: string[]
  sourceKind: string
  sourceUrl: string | null
  whyUrl: string
}

export interface ComingSoonCard {
  slug: string
  name: string
  stage: string
  readinessPercent: number
  note: string
}

export interface CreatorOverview {
  creator: { id: string; name: string; platforms: string[] }
  notice: string | null
  platforms: CreatorPlatformCard[]
  updates: CreatorUpdateCard[]
  comingSoon: ComingSoonCard[]
  counts: { optionsReady: number; updatesToRead: number; platformsWatched: number }
}

export interface ValidationResult {
  valid: boolean
  issues: Array<{ field: string; message: string; severity: 'ERROR' | 'WARNING' }>
  limits: LimitHint[]
}

export interface DraftResult {
  hook: string
  body: string
  cta: string
  notes: string[]
  provenance: string
  prepared: boolean
  limits: LimitHint[]
  publishing: boolean
  publishingNote: string
}

export interface WhyAnswer {
  optionKey: string
  label: string
  description: string
  available: boolean
  whatChanged: string
  when: string | null
  from: string
  weUpdated: string | null
  sources: Array<{ name: string; url: string | null }>
  pendingReview: string[]
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await globalThis.fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const text = await response.text()
  const payload: unknown = text ? (JSON.parse(text) as unknown) : null
  if (!response.ok) {
    const detail = payload as { error?: unknown }
    const raw = detail.error
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload && raw !== undefined
        ? typeof raw === 'string'
          ? raw
          : JSON.stringify(raw)
        : `Request failed (${response.status})`
    throw new ApiError(message, response.status)
  }
  return payload as T
}

export function fetchOverview(): Promise<CreatorOverview> {
  return request<CreatorOverview>('/api/creator/overview')
}

export function recordObservation(input: {
  kind: string
  subject: string
  detail?: string | null
  platformSlug?: string | null
}): Promise<{ learned: number; changed: string[] }> {
  return authedFetch('/api/creator/observations', { method: 'POST', body: JSON.stringify(input) })
}

export function validateContent(input: {
  platform: string
  option: string
  text: string
  mediaCount: number
}): Promise<ValidationResult> {
  // Mutating calls go through authedFetch so the CSRF token rides with them.
  return authedFetch<ValidationResult>('/api/creator/validate', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function fetchDraft(input: {
  platform: string
  option: string
  brief: string
  tone?: string
}): Promise<DraftResult> {
  return authedFetch<DraftResult>('/api/creator/draft', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function fetchWhy(platform: string, option: string): Promise<WhyAnswer> {
  return request<WhyAnswer>(`/api/creator/platforms/${platform}/why?option=${encodeURIComponent(option)}`)
}
