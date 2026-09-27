import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Source } from '@creator-mall/core'
import { loadConfig } from '../src/config.js'
import { PublicFetcher, isDisallowed, parseRobots } from '../src/world-engine/fetcher.js'
import { ROBOTS_ALLOW_ALL, html, robotsFor, scriptedFetch } from './helpers.js'

function source(partial: Partial<Source> = {}): Source {
  return {
    id: 'src_1',
    name: 'Example docs',
    url: 'https://creators.example.com/limits',
    domain: 'creators.example.com',
    sourceType: 'DOCUMENTATION',
    platform: 'example',
    trustLevel: 'OFFICIAL',
    discoveredVia: 'SEED',
    lastCheckedAt: null,
    nextCheckAt: null,
    active: true,
    lastStatus: 'NEVER_CHECKED',
    consecutiveFailures: 0,
    ...partial,
  }
}

function config(overrides: Record<string, string> = {}) {
  return loadConfig({ ALLOWED_HOSTS: '', FETCH_MIN_HOST_GAP_MS: '0', ...overrides } as NodeJS.ProcessEnv)
}

describe('permitted public data fetcher', () => {
  it('fetches html and reports validators', async () => {
    const fetchImpl = scriptedFetch({
      'https://creators.example.com/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
      'https://creators.example.com/limits': {
        body: html('<p>Reels can be up to 90 seconds long.</p>'),
        headers: { etag: 'W/"abc"' },
      },
    })
    const fetcher = new PublicFetcher(config(), fetchImpl)
    const outcome = await fetcher.fetch(source())

    assert.equal(outcome.status, 'OK')
    if (outcome.status !== 'OK') return
    assert.equal(outcome.etag, 'W/"abc"')
    assert.match(outcome.body, /90 seconds/)
  })

  it('refuses hosts that are not on the allowlist', async () => {
    const fetcher = new PublicFetcher(config({ ALLOWED_HOSTS: 'creators.example.com' }), scriptedFetch({}))
    const outcome = await fetcher.fetch(source({ url: 'https://elsewhere.example.org/limits' }))
    assert.equal(outcome.status, 'BLOCKED')
    assert.match(outcome.reason, /allowlist/)
  })

  it('honours robots.txt', async () => {
    const fetchImpl = scriptedFetch({
      'https://creators.example.com/robots.txt': { body: robotsFor(['/limits']), contentType: 'text/plain' },
      'https://creators.example.com/limits': { body: html('<p>secret</p>') },
    })
    const fetcher = new PublicFetcher(config(), fetchImpl)
    const outcome = await fetcher.fetch(source())
    assert.equal(outcome.status, 'BLOCKED')
    assert.match(outcome.reason, /robots/)
  })

  it('treats 304 as no change so unchanged pages cost nothing', async () => {
    const fetchImpl = scriptedFetch({
      'https://creators.example.com/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
      'https://creators.example.com/limits': { status: 304, body: '' },
    })
    const fetcher = new PublicFetcher(config(), fetchImpl)
    const outcome = await fetcher.fetch(source({ etag: 'W/"abc"' }))
    assert.equal(outcome.status, 'NOT_MODIFIED')
  })

  it('marks server errors as retryable and client errors as final', async () => {
    const retryable = new PublicFetcher(
      config(),
      scriptedFetch({
        'https://creators.example.com/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
        'https://creators.example.com/limits': { status: 503, body: '' },
      }),
    )
    const first = await retryable.fetch(source())
    assert.equal(first.status, 'FAILED')
    if (first.status === 'FAILED') assert.equal(first.retryable, true)

    const final = new PublicFetcher(
      config(),
      scriptedFetch({
        'https://creators.example.com/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
        'https://creators.example.com/limits': { status: 404, body: '' },
      }),
    )
    const second = await final.fetch(source())
    assert.equal(second.status, 'FAILED')
    if (second.status === 'FAILED') assert.equal(second.retryable, false)
  })

  it('rejects binary and oversized payloads', async () => {
    const binary = new PublicFetcher(
      config(),
      scriptedFetch({
        'https://creators.example.com/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
        'https://creators.example.com/limits': { body: 'x'.repeat(5000), contentType: 'image/png' },
      }),
    )
    const outcome = await binary.fetch(source())
    assert.equal(outcome.status, 'FAILED')
    if (outcome.status === 'FAILED') assert.match(outcome.reason, /content-type/)

    const capped = new PublicFetcher(
      config({ FETCH_MAX_BYTES: '10000' }),
      scriptedFetch({
        'https://creators.example.com/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
        'https://creators.example.com/limits': { body: 'a'.repeat(50_000), contentType: 'text/html' },
      }),
    )
    const cappedOutcome = await capped.fetch(source())
    assert.equal(cappedOutcome.status, 'OK')
    if (cappedOutcome.status === 'OK') assert.ok(cappedOutcome.body.length <= 10_000)
  })
})

describe('robots parsing', () => {
  it('reads disallow rules for the wildcard agent only', () => {
    const rules = parseRobots('User-agent: BadBot\nDisallow: /\nUser-agent: *\nDisallow: /private\nAllow: /public\n')
    assert.deepEqual(rules.disallow, ['/private'])
    assert.deepEqual(rules.allow, ['/public'])
  })

  it('applies longest-match precedence through allow', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /docs\nAllow: /docs/public\n')
    assert.equal(isDisallowed('https://x.example.com/docs/other', rules), true)
    assert.equal(isDisallowed('https://x.example.com/docs/public/page', rules), false)
  })
})
