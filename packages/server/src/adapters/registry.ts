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
import { buildReadinessProfile, canEnablePublishing } from '@creator-mall/core'
import type { ControlPlane } from '../store/control-plane.js'

/**
 * §42: a platform nobody has integrated yet still exists in the product.
 *
 * This adapter is the honest representation of that state: it reports the
 * capabilities we know about, validates against known limits, and refuses to
 * publish with a clear explanation instead of pretending to work.
 */
export class UnavailablePlatformAdapter implements PlatformAdapter {
  readonly kind = 'UNAVAILABLE' as const
  readonly platformSlug: string
  private readonly state: PlatformState | null
  private readonly reason: string

  constructor(platformSlug: string, state: PlatformState | null, reason: string) {
    this.platformSlug = platformSlug
    this.state = state
    this.reason = reason
  }

  getCapabilities(): Promise<AdapterCapability[]> {
    if (!this.state) return Promise.resolve([])
    return Promise.resolve(
      Object.values(this.state.capabilities).map((observation) => ({
        key: observation.capabilityKey,
        state: observation.state,
        constraints: (observation.constraints ?? {}) as Record<string, never>,
      })),
    )
  }

  validateContent(input: AdapterContentInput): Promise<AdapterValidationResult> {
    const issues: AdapterValidationResult['issues'] = []
    const observation = this.state?.capabilities[input.contentType.toUpperCase()]

    if (!observation) {
      issues.push({
        path: 'contentType',
        message: `${this.platformSlug} support for "${input.contentType}" is not confirmed yet.`,
        severity: 'ERROR',
        sourceId: null,
      })
      return Promise.resolve({ valid: false, issues })
    }

    if (observation.state === 'DEPRECATED' || observation.state === 'REMOVED') {
      issues.push({
        path: 'contentType',
        message: `${this.platformSlug} no longer supports "${input.contentType}".`,
        severity: 'ERROR',
        sourceId: observation.sourceIds[0] ?? null,
      })
    }

    for (const limit of numericLimits(this.state?.limits ?? {})) {
      if (/character/i.test(limit.path)) {
        const length = input.text?.length ?? 0
        if (length > limit.value) {
          issues.push({
            path: limit.path,
            message: `This post is ${length} characters; ${this.platformSlug} allows ${limit.value}.`,
            severity: 'ERROR',
            sourceId: observation.sourceIds[0] ?? null,
          })
        }
      }
      if (/hashtag/i.test(limit.path)) {
        const hashtags = (input.text?.match(/#\w+/g) ?? []).length
        if (hashtags > limit.value) {
          issues.push({
            path: limit.path,
            message: `This post uses ${hashtags} hashtags; ${this.platformSlug} allows ${limit.value}.`,
            severity: 'ERROR',
            sourceId: observation.sourceIds[0] ?? null,
          })
        }
      }
      if (/maximages/i.test(limit.path) && input.mediaRefs.length > limit.value) {
        issues.push({
          path: limit.path,
          message: `This post has ${input.mediaRefs.length} media files; ${this.platformSlug} allows ${limit.value}.`,
          severity: 'ERROR',
          sourceId: observation.sourceIds[0] ?? null,
        })
      }
    }

    return Promise.resolve({ valid: issues.every((issue) => issue.severity !== 'ERROR'), issues })
  }

  publish(_input: AdapterPublishInput): Promise<AdapterPublishResult> {
    return Promise.resolve({
      ok: false,
      platformContentRef: null,
      error: `Publishing to ${this.platformSlug} is not connected yet. ${this.reason}`,
    })
  }

  async schedule(input: AdapterPublishInput): Promise<AdapterScheduleResult> {
    const result = await this.publish(input)
    return { ...result, scheduledAt: null }
  }

  fetchAnalytics(_input: AdapterAnalyticsInput): Promise<AdapterAnalyticsResult> {
    return Promise.resolve({
      ok: false,
      metrics: [],
      error: `Analytics for ${this.platformSlug} are not connected yet.`,
    })
  }

  fetchEngagement(_input: AdapterAnalyticsInput): Promise<AdapterEngagementResult> {
    return Promise.resolve({
      ok: false,
      comments: 0,
      replies: 0,
      messages: 0,
      error: `Engagement data for ${this.platformSlug} is not connected yet.`,
    })
  }
}

/**
 * §41: adapters are registered by capability contract, not by platform name in
 * application code. Adding an integration means registering an adapter here.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>()

  register(adapter: PlatformAdapter): PlatformAdapter {
    this.adapters.set(adapter.platformSlug, adapter)
    return adapter
  }

  get(platformSlug: string): PlatformAdapter | undefined {
    return this.adapters.get(platformSlug)
  }

  /**
   * Never returns null: unknown platforms resolve to the unavailable adapter so
   * callers cannot accidentally treat "no adapter" as "no platform".
   */
  resolve(platformSlug: string, state: PlatformState | null, reason = 'No verified integration exists yet.'): PlatformAdapter {
    return this.adapters.get(platformSlug) ?? new UnavailablePlatformAdapter(platformSlug, state, reason)
  }

  list(): PlatformAdapter[] {
    return [...this.adapters.values()]
  }
}

/** Flattens the nested limits object into checkable `path → number` pairs. */
function numericLimits(limits: Record<string, unknown>, prefix = 'limits'): Array<{ path: string; value: number }> {
  const result: Array<{ path: string; value: number }> = []
  for (const [key, value] of Object.entries(limits)) {
    const path = `${prefix}.${key}`
    if (typeof value === 'number' && Number.isFinite(value)) {
      result.push({ path, value })
      continue
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result.push(...numericLimits(value as Record<string, unknown>, path))
    }
  }
  return result
}

export function buildRegistryFor(control: ControlPlane): AdapterRegistry {
  const registry = new AdapterRegistry()
  for (const platform of control.listPlatforms()) {
    const snapshot = control.latestSnapshot(platform.id)
    registry.resolve(platform.slug, snapshot?.state ?? null, `${platform.name} has no verified integration yet.`)
  }
  return registry
}

export function publishingEnabled(control: ControlPlane, registry: AdapterRegistry, platformId: string): boolean {
  const platform = control.getPlatform(platformId)
  if (!platform) return false
  const profile = buildReadinessProfile({
    platform,
    capabilities: control.capabilities.all(),
    adapter: registry.get(platform.slug) ?? null,
    hasApiSource: control.sourcesForPlatform(platform.slug).some((source) => source.sourceType === 'DEVELOPER'),
    hasOfficialSource: control.sourcesForPlatform(platform.slug).some((source) => source.sourceType === 'OFFICIAL'),
    templatesPrepared: control.listTemplates(platform.id).length,
  })
  return canEnablePublishing(profile, registry.get(platform.slug) ?? null)
}
