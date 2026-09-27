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

// -------------------------------------------------------- account recovery

export interface ResetRequestResult {
  accepted: boolean
  message: string
  /** Only ever present outside production, where no mail provider is wired up. */
  devToken?: string
  devLink?: string
}

/**
 * Recovery calls are deliberately unauthenticated: a person who cannot sign in
 * is the entire reason these exist, so they carry no session and no CSRF token.
 * The single-use token in the link is what authorises them.
 */
export function requestPasswordReset(email: string): Promise<ResetRequestResult> {
  return request<ResetRequestResult>('/api/auth/password-reset', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export function confirmPasswordReset(token: string, password: string): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
}

export function verifyEmail(token: string): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

// ------------------------------------------------------------------- market

export interface ToolReason {
  source: string
  url: string | null
  /** Already in creator words: "the platform itself". */
  kind: string
  checkedAt: string | null
}

export interface CreatorToolCard {
  id: string
  platform: string
  platformName: string
  name: string
  whatItDoes: string
  kind: 'FEATURE' | 'ENDPOINT' | 'RESOURCE'
  confidence: 'confirmed' | 'likely'
  howSure: string
  url: string | null
  appliesTo: string
  checkedAt: string | null
  because: ToolReason[]
}

export interface CreatorToolsResponse {
  tools: CreatorToolCard[]
  notice: string
  counts: { confirmed: number; likely: number; platforms: number }
}

export function fetchTools(): Promise<CreatorToolsResponse> {
  return request<CreatorToolsResponse>('/api/creator/tools')
}

// ---------------------------------------------------------------- media library

export type AssetKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'STORYBOARD'

export interface AssetSummary {
  id: string
  kind: AssetKind
  title: string
  sizeBytes: number
  producedBy: string
  /** True only when a model actually wrote it. A rendered poster is not AI. */
  madeWithAI: boolean
  createdAt: string
  platformSlug: string | null
  origin: 'GENERATED' | 'UPLOADED'
  mimeType: string
}

export interface GenerationResult {
  asset: AssetSummary
  /** The artifact itself: poster SVG, shot list, narration script or copy. */
  content: string
  meta: {
    copy?: { hook: string; body: string; cta: string; hashtags: string[] }
    poster?: { width: number; height: number; alt: string; producedBy: string }
    storyboard?: { shots: Array<{ order: number; durationSeconds: number; shot: string; onScreen: string; voiceover: string }> }
    audio?: { totalSeconds: number; segments: Array<{ at: number; text: string }> }
  }
}

export function generateAsset(input: {
  platform: string
  option: string
  brief: string
  tone?: string
}): Promise<GenerationResult> {
  return authedFetch<GenerationResult>('/api/creator/generate', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function fetchAssets(kind?: AssetKind): Promise<{ assets: AssetSummary[] }> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return request<{ assets: AssetSummary[] }>(`/api/creator/assets${query}`)
}

/** Where an asset's bytes are served from, for a preview or a download link. */
export function assetUrl(assetId: string): string {
  return `/api/creator/assets/${encodeURIComponent(assetId)}`
}

export function deleteAsset(assetId: string): Promise<{ removed: boolean }> {
  return authedFetch<{ removed: boolean }>(`/api/creator/assets/${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
  })
}

/**
 * Uploads a file as the request body, with its own content type. The server does
 * the same, so no multipart encoding is involved on either side.
 */
export function uploadAsset(file: File, title?: string): Promise<{ asset: AssetSummary }> {
  const query = title ? `?title=${encodeURIComponent(title)}` : ''
  return authedFetch<{ asset: AssetSummary }>(`/api/creator/assets${query}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
}
