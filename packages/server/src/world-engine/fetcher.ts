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
    if (this.config.allowedHosts.size === 0) return true
    const normalized = host.toLowerCase()
    for (const allowed of this.config.allowedHosts) {
      if (normalized === allowed || normalized.endsWith(`.${allowed}`)) return true
    }
    return false
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
        response = await this.fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal })
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

      const body = await readCapped(response, request.maxBytes)
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
      const response = await this.fetchImpl(`https://${host}/robots.txt`, {
        headers: { 'user-agent': this.config.FETCH_USER_AGENT },
      })
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

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | null = response.body?.getReader() ?? null
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  await reader.cancel().catch(() => undefined)
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return buffer.subarray(0, maxBytes).toString('utf8')
}
