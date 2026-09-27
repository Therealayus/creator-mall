import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CANDIDATE_PATHS,
  EMPTY_STATS,
  candidateSourceId,
  candidatesFor,
  schedulePriority,
  scoreSource,
  summariseCuration,
  toSource,
} from '../src/index.js'
import type { Source, SourceStats } from '../src/index.js'

const NOW = Date.parse('2026-09-27T12:00:00.000Z')

function source(overrides: Partial<Source> = {}): Source {
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
    ...overrides,
  }
}

function stats(overrides: Partial<SourceStats> = {}): SourceStats {
  return { ...EMPTY_STATS, ...overrides }
}

describe('source scoring', () => {
  it('promotes a source that keeps producing facts', () => {
    const score = scoreSource(
      source(),
      stats({ checks: 8, successes: 8, factsContributed: 5, eventsContributed: 2, lastFactAt: '2026-09-26T00:00:00.000Z' }),
      NOW,
    )
    assert.equal(score.tier, 'PRIMARY')
    assert.equal(score.action, 'KEEP')
    assert.ok(score.score > 0.9)
    assert.ok(score.reasons.some((reason) => reason.includes('5 fact(s)')))
  })

  it('flags a source that answers but never yields anything', () => {
    const score = scoreSource(source(), stats({ checks: 6, successes: 6 }), NOW)
    assert.equal(score.tier, 'QUIET')
    assert.equal(score.action, 'REPOINT')
    assert.match(score.summary, /deeper documentation page/i)
  })

  it('does not judge a source that has barely been checked', () => {
    const score = scoreSource(source(), stats({ checks: 1, successes: 1 }), NOW)
    assert.equal(score.tier, 'SECONDARY')
    assert.equal(score.action, 'WATCH')
    assert.match(score.summary, /too early/i)
  })

  it('marks repeated failures as broken and suggests a new path', () => {
    const score = scoreSource(
      source({ consecutiveFailures: 4, lastError: 'http 404' }),
      stats({ checks: 4, failures: 4 }),
      NOW,
    )
    assert.equal(score.tier, 'BROKEN')
    assert.equal(score.action, 'REPOINT')
    assert.ok(score.reasons.some((reason) => reason.includes('http 404')))
  })

  it('retires a source a site asked us not to read', () => {
    const score = scoreSource(source(), stats({ checks: 2, successes: 1, blocked: 1 }), NOW)
    assert.equal(score.tier, 'BROKEN')
    assert.equal(score.action, 'RETIRE')
    assert.match(score.summary, /asks automated tools not to read/i)
  })

  it('keeps a retired source out of the schedule without judging it', () => {
    const score = scoreSource(source({ active: false }), stats({ checks: 9, successes: 9, factsContributed: 4 }), NOW)
    assert.equal(score.tier, 'BROKEN')
    assert.equal(score.action, 'KEEP')
    assert.equal(score.score, 0)
  })

  it('demotes a source that has not contributed lately', () => {
    const score = scoreSource(
      source(),
      stats({ checks: 10, successes: 10, factsContributed: 3, lastFactAt: '2025-01-01T00:00:00.000Z' }),
      NOW,
    )
    assert.equal(score.tier, 'SECONDARY')
    assert.match(score.summary, /not contributed lately/i)
  })

  it('schedules productive sources first and broken ones last', () => {
    const tiers = [
      scoreSource(source(), stats({ checks: 5, successes: 5, factsContributed: 3, lastFactAt: '2026-09-27T00:00:00.000Z' }), NOW),
      scoreSource(source({ id: 'src_2' }), stats({ checks: 1, successes: 1 }), NOW),
      scoreSource(source({ id: 'src_3' }), stats({ checks: 6, successes: 6 }), NOW),
      scoreSource(source({ id: 'src_4', consecutiveFailures: 3, lastError: 'http 503' }), stats({ checks: 5, failures: 5 }), NOW),
    ]
    const priorities = tiers.map(schedulePriority)
    assert.deepEqual(priorities, [0, 1, 2, 3])
  })

  it('summarises what an operator should look at', () => {
    const good = source()
    const quiet = source({ id: 'src_2', name: 'Landing page' })
    const entries = [
      { source: good, score: scoreSource(good, stats({ checks: 5, successes: 5, factsContributed: 2, lastFactAt: '2026-09-27T00:00:00.000Z' }), NOW) },
      { source: quiet, score: scoreSource(quiet, stats({ checks: 5, successes: 5 }), NOW) },
    ]
    const summary = summariseCuration(entries)
    assert.equal(summary.total, 2)
    assert.equal(summary.primary, 1)
    assert.equal(summary.quiet, 1)
    assert.equal(summary.attention.length, 1)
    assert.equal(summary.attention[0]?.name, 'Landing page')
  })
})

describe('candidate documentation paths', () => {
  it('offers deeper paths than the landing pages we start with', () => {
    assert.ok(CANDIDATE_PATHS.length >= 10)
    for (const candidate of CANDIDATE_PATHS) {
      assert.notEqual(candidate.url, `https://${candidate.platform}.com/`)
      assert.ok(candidate.url.startsWith('https://'))
    }
  })

  it('is deterministic, so probing is idempotent', () => {
    const candidate = CANDIDATE_PATHS[0]!
    assert.equal(candidateSourceId(candidate), candidateSourceId(candidate))
    assert.equal(toSource(candidate).id, candidateSourceId(candidate))
  })

  it('starts candidates inactive and unverified', () => {
    const candidate = candidatesFor('youtube')[0]!
    const source = toSource(candidate)
    assert.equal(source.active, false, 'the engine earns the right to read it')
    assert.equal(source.discoveredVia, 'DISCOVERY')
    assert.equal(source.lastStatus, 'NEVER_CHECKED')
    assert.equal(source.domain, 'support.google.com')
  })

  it('has candidates for every seeded platform', () => {
    for (const platform of ['instagram', 'youtube', 'tiktok', 'linkedin', 'x', 'facebook']) {
      assert.ok(candidatesFor(platform).length > 0, `${platform} has no documentation candidates`)
    }
  })
})
