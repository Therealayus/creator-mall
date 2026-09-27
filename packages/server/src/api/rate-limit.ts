/**
 * Per-IP rate limiting for the endpoints worth limiting.
 *
 * Account lockout already stops one account being ground down, but it does
 * nothing about a spray across many addresses, or about a single address
 * hammering one endpoint with valid credentials. This is the outer layer.
 *
 * Three deliberate choices:
 *
 *  1. **the client address is not taken on trust.** `X-Forwarded-For` is only
 *     read when the operator has said they run behind a proxy, because a header
 *     anyone can set is not a rate limit;
 *  2. **a limited request says when to come back**, so a client can wait rather
 *     than guess;
 *  3. **the window slides**, so a fixed window's boundary burst cannot double
 *     the allowed rate.
 */

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number
  windowMs: number
  /** Namespaces keep "/login slow" from blocking "/register". */
  bucket: string
  now?: () => number
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  /** Seconds until the oldest request leaves the window. Zero when allowed. */
  retryAfterSeconds: number
  limit: number
}

interface Window {
  /** Epoch millis of each request still inside the window. */
  hits: number[]
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  check(key: string, options: RateLimitOptions): RateLimitDecision {
    const now = this.now()
    const window = this.windows.get(key) ?? { hits: [] }
    const cutoff = now - options.windowMs
    window.hits = window.hits.filter((hit) => hit > cutoff)

    if (window.hits.length >= options.limit) {
      this.windows.set(key, window)
      const oldest = window.hits[0] ?? now
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000)),
        limit: options.limit,
      }
    }

    window.hits.push(now)
    this.windows.set(key, window)
    return {
      allowed: true,
      remaining: options.limit - window.hits.length,
      retryAfterSeconds: 0,
      limit: options.limit,
    }
  }

  /** Called when a request succeeds, so honest clients are not punished. */
  reset(key: string): void {
    this.windows.delete(key)
  }

  /** Keeps a long-running process from growing without bound. */
  prune(options: { bucket: string; windowMs: number }): number {
    const cutoff = this.now() - options.windowMs
    let removed = 0
    for (const [key, window] of this.windows) {
      if (!key.startsWith(`${options.bucket}:`)) continue
      const live = window.hits.filter((hit) => hit > cutoff)
      if (live.length === 0) {
        this.windows.delete(key)
        removed += 1
      } else if (live.length !== window.hits.length) {
        this.windows.set(key, { hits: live })
      }
    }
    return removed
  }

  size(): number {
    return this.windows.size
  }
}

/**
 * The address to limit on.
 *
 * `req.ip` is only as trustworthy as the proxy in front of it, which is why the
 * forwarded header is opt-in rather than automatic.
 */
export function clientAddress(request: { ip?: string; socket?: { remoteAddress?: string } }, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = headerOf(request, 'x-forwarded-for')
    const first = forwarded?.split(',')[0]?.trim()
    if (first) return first
  }
  return request.ip ?? request.socket?.remoteAddress ?? 'unknown'
}

function headerOf(request: unknown, name: string): string | undefined {
  const getter = (request as { get?: (key: string) => string | undefined }).get
  if (typeof getter !== 'function') return undefined
  return getter.call(request, name)
}
