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
import { jsonValue, numericLimits, validationIssues } from './validation.js'

/**
 * A publishing integration described entirely by *verified platform knowledge*.
 *
 * The spec of a publishing API — endpoint, method, field names, where the
 * media id comes back — is data, not code. That means:
 *
 * - a platform becomes publishable the moment its API is verified and described,
 *   with no new class and no new branch in the product;
 * - an integration that is not described cannot be constructed at all, so we
 *   cannot accidentally publish into a void;
 * - the same adapter serves every platform, present or future.
 *
 * No live platform integration is claimed here: a definition must be supplied
 * and verified before this class is used for real traffic.
 */
export interface HttpEndpointSpec {
  path: string
  /** GET is allowed for read endpoints such as analytics. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
}

export interface HttpAdapterDefinition {
  platformSlug: string
  baseUrl: string
  publish: HttpEndpointSpec
  schedule?: HttpEndpointSpec
  analytics?: HttpEndpointSpec
  /** Maps our content fields onto the platform's request body. */
  fieldMap: {
    caption?: string
    text?: string
    mediaIds?: string
    scheduledAt?: string
    accountId?: string
  }
  /** JSON pointer-ish path to the published id in the response body. */
  responseIdPath: string
  auth: {
    kind: 'BEARER' | 'QUERY' | 'HEADER'
    /** Environment variable holding the credential. Never stored. */
    envVar: string
    header?: string
    queryParam?: string
  }
  notes: string
}

export interface HttpAdapterOptions {
  definition: HttpAdapterDefinition
  state: PlatformState | null
  declaredCapabilityKeys: readonly string[]
  /** Per-account credentials, resolved at call time and never logged. */
  credentialFor: (accountRef: string) => string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** A credential is a per-account secret; it exists only for the call it makes. */
export class CredentialMissing extends Error {
  readonly envVar: string

  constructor(envVar: string) {
    super(`No credential available for this account (expected ${envVar})`)
    this.name = 'CredentialMissing'
    this.envVar = envVar
  }
}

export class HttpPlatformAdapter implements PlatformAdapter {
  readonly kind = 'LIVE' as const
  readonly platformSlug: string
  private readonly definitionField: HttpAdapterDefinition
  private readonly state: PlatformState | null
  private readonly declared: ReadonlySet<string>
  private readonly credentialFor: (accountRef: string) => string | null
  private readonly injectedFetch: typeof fetch | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: HttpAdapterOptions) {
    this.definitionField = options.definition
    this.platformSlug = options.definition.platformSlug
    this.state = options.state
    this.declared = new Set(options.declaredCapabilityKeys)
    this.credentialFor = options.credentialFor
    this.injectedFetch = options.fetchImpl
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  /**
   * Rebuilding an adapter with fresher verified knowledge uses these, so a
   * long-lived process always validates against the newest snapshot.
   */
  get definition(): HttpAdapterDefinition {
    return this.definitionField
  }

  get credentialResolver(): (accountRef: string) => string | null {
    return this.credentialFor
  }

  get fetchImplementation(): typeof fetch | undefined {
    return this.injectedFetch
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
    return this.send(this.definitionField.publish, input, 'publish')
  }

  async schedule(input: AdapterPublishInput): Promise<AdapterScheduleResult> {
    if (!this.definitionField.schedule) {
      return { ok: false, platformContentRef: null, error: `${this.platformSlug} has no scheduling endpoint.`, scheduledAt: null }
    }
    const result = await this.send(this.definitionField.schedule, input, 'schedule')
    return { ...result, scheduledAt: input.scheduledAt ?? null }
  }

  async fetchAnalytics(input: AdapterAnalyticsInput): Promise<AdapterAnalyticsResult> {
    if (!this.definitionField.analytics) {
      return { ok: false, metrics: [], error: `${this.platformSlug} has no analytics endpoint.` }
    }
    const body = await this.call(this.definitionField.analytics, input.accountRef, {
      from: input.since,
      to: input.until,
    })
    if (!body.ok) return { ok: false, metrics: [], error: body.error }
    return { ok: true, metrics: readMetrics(body.payload), error: null }
  }

  fetchEngagement(_input: AdapterAnalyticsInput): Promise<AdapterEngagementResult> {
    // Engagement requires per-platform mappings that must be verified per
    // integration; reporting honestly beats inventing a shape.
    return Promise.resolve({
      ok: false,
      comments: 0,
      replies: 0,
      messages: 0,
      error: `${this.platformSlug} has no verified engagement mapping yet.`,
    })
  }

  private async send(
    endpoint: HttpEndpointSpec,
    input: AdapterPublishInput,
    operation: 'publish' | 'schedule',
  ): Promise<AdapterPublishResult> {
    const body = this.payloadFor(input)
    const result = await this.call(endpoint, input.accountRef, body)
    if (!result.ok) return { ok: false, platformContentRef: null, error: result.error }
    return { ok: true, platformContentRef: readPath(result.payload, this.definitionField.responseIdPath), error: null, ...(operation === 'schedule' ? {} : {}) }
  }

  private payloadFor(input: AdapterPublishInput): Record<string, unknown> {
    const map = this.definitionField.fieldMap
    const payload: Record<string, unknown> = {}
    if (map.caption && input.text !== undefined) payload[map.caption] = input.text
    if (map.text && input.text !== undefined) payload[map.text] = input.text
    if (map.mediaIds) payload[map.mediaIds] = input.mediaRefs
    if (map.accountId) payload[map.accountId] = input.accountRef
    if (map.scheduledAt && input.scheduledAt) payload[map.scheduledAt] = input.scheduledAt
    return payload
  }

  private async call(
    endpoint: HttpEndpointSpec,
    accountRef: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string }> {
    const credential = this.credentialFor(accountRef)
    if (!credential) return { ok: false, error: new CredentialMissing(this.definitionField.auth.envVar).message }

    const url = resolveUrl(this.definitionField.baseUrl, endpoint.path)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.definitionField.auth.kind === 'BEARER') headers.authorization = `Bearer ${credential}`
    if (this.definitionField.auth.kind === 'HEADER' && this.definitionField.auth.header) {
      headers[this.definitionField.auth.header] = credential
    }
    if (this.definitionField.auth.kind === 'QUERY' && this.definitionField.auth.queryParam) {
      url.searchParams.set(this.definitionField.auth.queryParam, credential)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: endpoint.method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (response.status === 429 || response.status >= 500) {
        return { ok: false, error: `platform returned http ${response.status}; retry later` }
      }
      if (!response.ok) {
        // The body may echo the credential, so it is never surfaced.
        return { ok: false, error: `platform rejected the request (http ${response.status})` }
      }

      const text = await response.text()
      if (!text) return { ok: true, payload: {} }
      const parsed: unknown = JSON.parse(text)
      return { ok: true, payload: (typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed }) as Record<string, unknown> }
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? 'request timed out' : 'request failed'
      return { ok: false, error: `${this.platformSlug} ${reason}` }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Endpoint paths in a definition are **relative to the base URL**, even when
 * written with a leading slash. `baseUrl: https://api.example.com/v2` plus
 * `/me/media` means `https://api.example.com/v2/me/media` — the obvious
 * reading, and the one a definition author intends.
 */
export function resolveUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(/^\/+/, ''), base)
}

/** Dotted path lookup, so a definition can say `data.0.id`. */
export function readPath(payload: unknown, path: string): string | null {
  let current: unknown = payload
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' || typeof current === 'number' ? String(current) : null
}

function readMetrics(payload: Record<string, unknown>): AdapterAnalyticsResult['metrics'] {
  const entries = Object.entries(payload)
  return entries
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => ({
      key,
      label: key.replace(/_/g, ' '),
      value: value as number,
      unit: 'COUNT' as const,
    }))
}

export { jsonValue, numericLimits }
