import type { CapabilityState, PlatformStatus, TrustLevel } from './enums.js'
import type { JsonValue } from './platform.js'

/**
 * §41: every platform integration is an adapter. Platforms without a verified
 * integration are represented by `UnavailablePlatformAdapter`, so an unknown
 * platform can exist in the product long before it can publish (§42).
 */
export interface PlatformAdapter {
  readonly platformSlug: string
  readonly kind: 'LIVE' | 'SIMULATED' | 'UNAVAILABLE'
  getCapabilities(): Promise<AdapterCapability[]>
  validateContent(input: AdapterContentInput): Promise<AdapterValidationResult>
  publish(input: AdapterPublishInput): Promise<AdapterPublishResult>
  schedule(input: AdapterPublishInput): Promise<AdapterScheduleResult>
  fetchAnalytics(input: AdapterAnalyticsInput): Promise<AdapterAnalyticsResult>
  fetchEngagement(input: AdapterAnalyticsInput): Promise<AdapterEngagementResult>
}

export interface AdapterCapability {
  key: string
  state: CapabilityState
  constraints: Record<string, JsonValue>
}

export interface AdapterContentInput {
  contentType: string
  text?: string
  mediaRefs: string[]
  metadata?: Record<string, JsonValue>
}

export interface AdapterValidationIssue {
  path: string
  message: string
  severity: 'ERROR' | 'WARNING'
  sourceId: string | null
}

export interface AdapterValidationResult {
  valid: boolean
  issues: AdapterValidationIssue[]
}

export interface AdapterPublishInput extends AdapterContentInput {
  accountRef: string
  scheduledAt?: string
  idempotencyKey: string
}

export interface AdapterPublishResult {
  ok: boolean
  platformContentRef: string | null
  error: string | null
  /**
   * True when the result came from a simulated adapter. A caller must never
   * present this to a creator as a real publish.
   */
  simulated?: boolean
}

export interface AdapterScheduleResult extends AdapterPublishResult {
  scheduledAt: string | null
}

export interface AdapterAnalyticsInput {
  accountRef: string
  since: string
  until: string
}

export interface AdapterMetric {
  key: string
  label: string
  value: number
  unit: 'COUNT' | 'PERCENT' | 'MILLISECONDS' | 'CURRENCY' | 'DURATION'
}

export interface AdapterAnalyticsResult {
  ok: boolean
  metrics: AdapterMetric[]
  error: string | null
}

export interface AdapterEngagementResult {
  ok: boolean
  comments: number
  replies: number
  messages: number
  error: string | null
}

export interface AdapterRegistration {
  platformId: string
  platformSlug: string
  platformName: string
  status: PlatformStatus
  trustLevel: TrustLevel
  kind: PlatformAdapter['kind']
  registeredAt: string
  notes: string
}
