import { setTimeout as delay } from 'node:timers/promises'
import type { FetchOutcome, FetchRequest, Source } from '@creator-mall/core'
import type { Config } from '../config.js'

export interface RobotsRules {
  disallow: string[]
  allow: string[]
  fetchedAt: string
}

/**
 * Permitted-public-data fetcher.
 *
 * Safety rules that are not optional:
 *  - only hosts on the allowlist are ever read;
 *  - robots.txt is honoured (unless explicitly disabled in dev);
 *  - one request per host per `minHostGapMs`, so the World Engine never looks
 *    like a scraper hammering a documentation site;
 *  - hard timeout, hard byte cap, redirects limited, only text-ish content types;
 *  - conditional requests (ETag / Last-Modified) so unchanged pages cost nothing.
 */
export class PublicFetcher {
  private readonly lastHit = new Map<string, number>()
  private readonly robots = new Map<string, RobotsRules>()
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private inFlight = 0

  constructor(config: Config, fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = defaultSleep) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.sleep = sleep
  }

  private readonly config: Config

  isAllowedHost(host: string): boolean {
    const normalized = host.toLowerCase()
    // Link-local and loopback targets are never a legitimate platform source.
    // Checked before the allowlist, because an empty allowlist allows everything
    // and must not make the metadata endpoint reachable.
    if (normalized === 'localhost' || normalized === '::1' || normalized.endsWith('.localhost')) return false
    if (normalized === '169.254.169.254' || normalized.startsWith('169.254.')) return false
    if (normalized.startsWith('127.') || normalized.startsWith('10.') || normalized.startsWith('192.168.')) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return false
    if (normalized === '[::1]' || normalized.startsWith('fc') || normalized.startsWith('fd')) return false

    if (this.config.allowedHosts.size === 0) return true
    for (const allowed of this.config.allowedHosts) {
      if (normalized === allowed || normalized.endsWith(`.${allowed}`)) return true
    }
    return false
  }

  /**
   * Follows redirects one hop at a time, re-checking the allowlist and the hop
   * count each time. `redirect: 'follow'` would bypass both.
   */
  private async fetchWithCheckedRedirects(
    url: string,
    headers: Record<string, string>,
    request: FetchRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const maxHops = 3
    let current = url

    for (let hop = 0; hop <= maxHops; hop += 1) {
      const response = await this.fetchImpl(current, {
        headers,
        redirect: 'manual',
        signal,
      })

      const location = response.headers.get('location')
      const isRedirect = response.status >= 300 && response.status < 400 && location
      if (!isRedirect) return response

      const next = new URL(location, current).toString()
      const host = new URL(next).hostname
      if (!this.isAllowedHost(host)) {
        throw new Error(`redirect to a host that is not allowed: ${host}`)
      }
      if (hop === maxHops) {
        throw new Error('too many redirects')
      }
      current = next
    }

    throw new Error('too many redirects')
  }

  async fetch(source: Source, conditional: { etag?: string; lastModified?: string } = {}): Promise<FetchOutcome> {
    const started = Date.now()
    let url: string
    try {
      url = new URL(source.url).toString()
    } catch {
      return { status: 'FAILED', url: source.url, reason: 'invalid url', retryable: false, fetchedAt: new Date().toISOString(), elapsedMs: 0 }
    }

    const host = new URL(url).hostname
    if (!this.isAllowedHost(host)) {
      return {
        status: 'BLOCKED',
        url,
        reason: `host not on allowlist: ${host}`,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
      }
    }

    if (this.config.RESPECT_ROBOTS) {
      const rules = await this.robotsFor(host)
      if (rules && isDisallowed(url, rules)) {
        return {
          status: 'BLOCKED',
          url,
          reason: 'disallowed by robots.txt',
          fetchedAt: new Date().toISOString(),
          elapsedMs: Date.now() - started,
        }
      }
    }

    await this.throttle(host)

    const request: FetchRequest = {
      url,
      sourceId: source.id,
      etag: conditional.etag,
      lastModified: conditional.lastModified,
      timeoutMs: this.config.FETCH_TIMEOUT_MS,
      maxBytes: this.config.FETCH_MAX_BYTES,
    }

    this.inFlight += 1
    try {
      const headers: Record<string, string> = {
        'user-agent': this.config.FETCH_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.8,text/plain;q=0.5',
        'accept-language': 'en',
      }
      if (request.etag) headers['if-none-match'] = request.etag
      if (request.lastModified) headers['if-modified-since'] = request.lastModified

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), request.timeoutMs)
      let response: Response
      try {
        // Redirects are followed manually and re-checked, because `follow` would
        // let an allowed host bounce us to an internal address or cloud metadata
        // and the allowlist would never be consulted for that hop.
        response = await this.fetchWithCheckedRedirects(url, headers, request, controller.signal)
      } finally {
        clearTimeout(timer)
      }

      const elapsedMs = Date.now() - started
      const fetchedAt = new Date().toISOString()

      if (response.status === 304) {
        return { status: 'NOT_MODIFIED', url, fetchedAt, elapsedMs }
      }
      if (response.status === 429 || response.status >= 500) {
        return {
          status: 'FAILED',
          url,
          reason: `http ${response.status}`,
          retryable: true,
          fetchedAt,
          elapsedMs,
        }
      }
      if (!response.ok) {
        return { status: 'FAILED', url, reason: `http ${response.status}`, retryable: false, fetchedAt, elapsedMs }
      }

      const contentType = (response.headers.get('content-type') ?? 'text/html').split(';')[0] ?? 'text/html'
      if (!ALLOWED_CONTENT_TYPES.some((type) => contentType.includes(type))) {
        return {
          status: 'FAILED',
          url,
          reason: `unsupported content-type ${contentType}`,
          retryable: false,
          fetchedAt,
          elapsedMs,
        }
      }

      // The signal is still armed here: the headers arrived, but a server that
      // then stalls would otherwise hold the cycle open indefinitely.
      const body = await readCapped(response, request.maxBytes, request.timeoutMs)
      return {
        status: 'OK',
        url,
        body,
        contentType,
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
        fetchedAt,
        elapsedMs,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        status: 'FAILED',
        url,
        reason,
        retryable: true,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
      }
    } finally {
      this.inFlight -= 1
    }
  }

  inflight(): number {
    return this.inFlight
  }

  private async throttle(host: string): Promise<void> {
    const gap = this.config.FETCH_MIN_HOST_GAP_MS
    if (gap <= 0) return
    const last = this.lastHit.get(host) ?? 0
    const wait = last + gap - Date.now()
    if (wait > 0) await this.sleep(wait)
    this.lastHit.set(host, Date.now())
  }

  private async robotsFor(host: string): Promise<RobotsRules | null> {
    const cached = this.robots.get(host)
    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 3_600_000) return cached

    try {
      // Bounded, or one unresponsive host stalls the whole cycle.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.config.FETCH_TIMEOUT_MS)
      let response: Response
      try {
        response = await this.fetchImpl(`https://${host}/robots.txt`, {
          headers: { 'user-agent': this.config.FETCH_USER_AGENT },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        this.robots.set(host, { disallow: [], allow: [], fetchedAt: new Date().toISOString() })
        return this.robots.get(host) ?? null
      }
      const rules = parseRobots(await response.text())
      this.robots.set(host, rules)
      return rules
    } catch {
      return null
    }
  }
}

const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml', 'text/plain', 'application/xml', 'text/xml', 'application/json', 'application/rss']

async function defaultSleep(ms: number): Promise<void> {
  await delay(ms)
}

export function parseRobots(body: string): RobotsRules {
  const lines = body.split('\n').map((line) => line.replace(/#.*$/, '').trim())
  const disallow: string[] = []
  const allow: string[] = []
  let appliesToUs = false

  for (const line of lines) {
    const [rawField, ...rest] = line.split(':')
    const field = (rawField ?? '').trim().toLowerCase()
    const value = rest.join(':').trim()

    if (field === 'user-agent') {
      appliesToUs = value === '*' || value.toLowerCase().includes('creatormall')
      continue
    }
    if (!appliesToUs) continue
    if (field === 'disallow' && value) disallow.push(value)
    if (field === 'allow' && value) allow.push(value)
  }
  return { disallow, allow, fetchedAt: new Date().toISOString() }
}

export function isDisallowed(url: string, rules: RobotsRules): boolean {
  let path: string
  try {
    const parsed = new URL(url)
    path = `${parsed.pathname}${parsed.search}`
  } catch {
    return true
  }
  const matches = (rule: string): boolean => {
    if (rule === '/') return true
    if (rule.endsWith('$')) return path === rule.slice(0, -1)
    if (rule.includes('*')) {
      const pattern = new RegExp(`^${rule.split('*').map(escapeRegExp).join('.*')}$`)
      return pattern.test(path)
    }
    return path.startsWith(rule)
  }
  if (rules.allow.some(matches)) return false
  return rules.disallow.some(matches)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Reads at most `maxBytes`, and gives up if the stream stalls.
 *
 * Without the deadline, a server that sends headers and then never sends a body
 * hangs the research cycle forever, and the scheduler's "already running" guard
 * means the World Engine never runs again.
 */
async function readCapped(response: Response, maxBytes: number, timeoutMs = 15_000): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | null = response.body?.getReader() ?? null
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const next = reader.read()
    const raced = await Promise.race([
      next,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs).unref()
      }),
    ])
    if (raced === null) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`response body stalled for more than ${timeoutMs}ms`)
    }
    const { done, value } = raced
    if (done) break
    if (!value) continue
    chunks.push(value)
    total += value.byteLength
  }
  await reader.cancel().catch(() => undefined)
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return buffer.subarray(0, maxBytes).toString('utf8')
}
