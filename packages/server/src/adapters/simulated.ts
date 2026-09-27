import type {
  AdapterAnalyticsInput,
  AdapterAnalyticsResult,
  AdapterCapability,
  AdapterContentInput,
  AdapterEngagementResult,
  AdapterPublishInput,
  AdapterPublishResult,
  AdapterScheduleResult,
  AdapterValidationResult,
  PlatformAdapter,
  PlatformState,
} from '@creator-mall/core'
import { validationIssues } from './validation.js'

/**
 * A publishing adapter that behaves correctly without touching a platform.
 *
 * This is what local development and end-to-end tests use: the composer,
 * validation, idempotency and scheduling all behave as they will in
 * production, and the only thing missing is the network call. It is labelled
 * `SIMULATED` everywhere, so nothing can mistake it for a real integration.
 */
export class SimulatedPlatformAdapter implements PlatformAdapter {
  readonly kind = 'SIMULATED' as const
  readonly platformSlug: string
  private readonly state: PlatformState | null
  private readonly declared: ReadonlySet<string>
  private readonly sent: AdapterPublishResult[] = []

  constructor(platformSlug: string, state: PlatformState | null, declaredCapabilityKeys: readonly string[] = []) {
    this.platformSlug = platformSlug
    this.state = state
    this.declared = new Set(declaredCapabilityKeys)
  }

  /** Everything this adapter has "published", for tests and the operator view. */
  published(): AdapterPublishResult[] {
    return [...this.sent]
  }

  getCapabilities(): Promise<AdapterCapability[]> {
    const observed = new Map(
      Object.values(this.state?.capabilities ?? {}).map((observation) => [observation.capabilityKey, observation]),
    )
    for (const key of this.declared) {
      if (!observed.has(key)) observed.set(key, { capabilityKey: key, state: 'ACTIVE', confidence: 0, sourceIds: [] })
    }
    return Promise.resolve(
      [...observed.values()].map((observation) => ({
        key: observation.capabilityKey,
        state: observation.state,
        constraints: (observation.constraints ?? {}) as Record<string, never>,
      })),
    )
  }

  validateContent(input: AdapterContentInput): Promise<AdapterValidationResult> {
    return Promise.resolve(validationIssues(this.platformSlug, input, this.state, [...this.declared]))
  }

  async publish(input: AdapterPublishInput): Promise<AdapterPublishResult> {
    const validation = await this.validateContent(input)
    if (!validation.valid) {
      const result: AdapterPublishResult = {
        ok: false,
        platformContentRef: null,
        error: validation.issues.find((issue) => issue.severity === 'ERROR')?.message ?? 'content rejected',
        simulated: true,
      }
      this.sent.push(result)
      return result
    }

    // Deterministic id: the same content always yields the same reference, so
    // idempotency is testable rather than claimed. The `sim_` prefix and the
    // flag mean this can never be mistaken for a real publish.
    const result: AdapterPublishResult = {
      ok: true,
      platformContentRef: `sim_${input.idempotencyKey}`,
      error: null,
      simulated: true,
    }
    this.sent.push(result)
    return result
  }

  async schedule(input: AdapterPublishInput): Promise<AdapterScheduleResult> {
    const result = await this.publish(input)
    return { ...result, scheduledAt: input.scheduledAt ?? null }
  }

  fetchAnalytics(_input: AdapterAnalyticsInput): Promise<AdapterAnalyticsResult> {
    return Promise.resolve({
      ok: true,
      metrics: [
        { key: 'published', label: 'published', value: this.sent.filter((entry) => entry.ok).length, unit: 'COUNT' },
      ],
      error: null,
    })
  }

  fetchEngagement(_input: AdapterAnalyticsInput): Promise<AdapterEngagementResult> {
    return Promise.resolve({ ok: false, comments: 0, replies: 0, messages: 0, error: 'simulated adapter has no engagement data' })
  }
}
