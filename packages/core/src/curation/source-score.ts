import type { Source, SourceStats } from '../types/source.js'
import { EMPTY_SOURCE_STATS } from '../types/source.js'

export type { SourceStats }

/**
 * Source curation.
 *
 * A registry that only grows is a liability: sources that answer but never say
 * anything useful cost requests and hide real problems. This scores every source
 * from what it has actually produced, and says what should happen next.
 */

export const SOURCE_TIERS = ['PRIMARY', 'SECONDARY', 'QUIET', 'BROKEN'] as const
export type SourceTier = (typeof SOURCE_TIERS)[number]

export type CurationAction = 'KEEP' | 'WATCH' | 'REPOINT' | 'RETIRE'

export interface SourceScore {
  sourceId: string
  score: number
  tier: SourceTier
  action: CurationAction
  reasons: string[]
  /** In plain language, for the Evolution Center. */
  summary: string
}

export const EMPTY_STATS: SourceStats = EMPTY_SOURCE_STATS

/** A source that has answered this many times is judged, not merely counted. */
const JUDGEMENT_THRESHOLD = 3

/** A source that has not contributed in this long is worth checking less often. */
const RECENCY_WINDOW_MS = 30 * 86_400_000

/**
 * Scoring rules, most decisive first:
 *
 * - blocked by robots.txt → BROKEN, never retried aggressively
 * - repeated failures → BROKEN, the URL is probably wrong
 * - answers but never contributes → QUIET: repoint at a deeper documentation
 *   path, or retire it. This is the case a growing registry hides.
 * - contributes facts, recently → PRIMARY
 * - contributes, but not lately → SECONDARY: still useful, checked less often
 */
export function scoreSource(source: Source, stats: SourceStats, now: number = Date.now()): SourceScore {
  const produced = stats.factsContributed + stats.eventsContributed

  if (!source.active) {
    return {
      sourceId: source.id,
      score: 0,
      tier: 'BROKEN',
      action: 'KEEP',
      reasons: ['Retired by an operator.'],
      summary: 'Retired. The record is kept, the requests have stopped.',
    }
  }

  if (stats.blocked > 0) {
    return {
      sourceId: source.id,
      score: 0,
      tier: 'BROKEN',
      action: 'RETIRE',
      reasons: [`Disallowed by robots.txt (${stats.blocked} time(s)).`],
      summary: 'The site asks automated tools not to read this path.',
    }
  }

  if (source.consecutiveFailures >= 3) {
    return {
      sourceId: source.id,
      score: 0,
      tier: 'BROKEN',
      action: 'REPOINT',
      reasons: [
        `Failed ${source.consecutiveFailures} times in a row.`,
        `Last error: ${source.lastError ?? 'unknown'}`,
      ],
      summary: 'Not answering. The URL is probably wrong or the page moved.',
    }
  }

  if (stats.checks >= JUDGEMENT_THRESHOLD && produced === 0) {
    return {
      sourceId: source.id,
      score: 0.15,
      tier: 'QUIET',
      action: 'REPOINT',
      reasons: [
        `Answered ${stats.checks} times without giving us a single verified fact.`,
        'Landing pages rarely state limits; a documentation page usually does.',
      ],
      summary: 'Answers, but says nothing we can use. Point it at a deeper documentation page.',
    }
  }

  if (produced > 0) {
    // "Lately" is a recency window, not a TTL: a source that last helped a year
    // ago is still useful, it is simply worth checking less often.
    const stale = stats.lastFactAt !== null && now - new Date(stats.lastFactAt).getTime() > RECENCY_WINDOW_MS
    const confidence = Math.min(1, produced / 4)
    const reasons = [
      `Contributed ${stats.factsContributed} fact(s) and ${stats.eventsContributed} change event(s).`,
    ]
    if (stats.lastFactAt) reasons.push(`Last contributed ${stats.lastFactAt.slice(0, 10)}.`)
    if (stats.factsContributed === 0 && stats.eventsContributed > 0) {
      reasons.push('No plain facts, but it caught a real change.')
    }

    const tier: SourceTier = stats.checks < JUDGEMENT_THRESHOLD || stale ? 'SECONDARY' : 'PRIMARY'
    return {
      sourceId: source.id,
      score: Number((0.5 + confidence * 0.5).toFixed(3)),
      tier,
      action: 'KEEP',
      reasons,
      summary: stale ? 'Useful, but has not contributed lately. Checked less often.' : 'Doing its job.',
    }
  }

  return {
    sourceId: source.id,
    score: 0.4,
    tier: 'SECONDARY',
    action: 'WATCH',
    reasons: [`Checked ${stats.checks} time(s), not enough to judge.`],
    summary: 'Too early to tell. Keep watching it.',
  }
}

/** Productive sources are checked first; broken ones are left alone. */
export function schedulePriority(score: SourceScore): number {
  switch (score.tier) {
    case 'PRIMARY':
      return 0
    case 'SECONDARY':
      return 1
    case 'QUIET':
      return 2
    default:
      return 3
  }
}

export interface CurationAttention {
  sourceId: string
  name: string
  platform: string | null
  action: CurationAction
  summary: string
}

export interface CurationSummary {
  total: number
  primary: number
  secondary: number
  quiet: number
  broken: number
  /** What an operator should look at, in plain language. */
  attention: CurationAttention[]
}

export function summariseCuration(
  entries: ReadonlyArray<{ source: Source; score: SourceScore }>,
): CurationSummary {
  const summary: CurationSummary = {
    total: entries.length,
    primary: 0,
    secondary: 0,
    quiet: 0,
    broken: 0,
    attention: [],
  }

  for (const entry of entries) {
    if (entry.score.tier === 'PRIMARY') summary.primary += 1
    else if (entry.score.tier === 'SECONDARY') summary.secondary += 1
    else if (entry.score.tier === 'QUIET') summary.quiet += 1
    else summary.broken += 1

    if (entry.score.action === 'KEEP' || entry.score.action === 'WATCH') continue
    summary.attention.push({
      sourceId: entry.source.id,
      name: entry.source.name,
      platform: entry.source.platform,
      action: entry.score.action,
      summary: entry.score.summary,
    })
  }

  return summary
}
