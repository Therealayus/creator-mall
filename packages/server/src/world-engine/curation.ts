import { candidatesFor, parseDocument, toSource } from '@creator-mall/core'
import type { ExtractedFact } from '@creator-mall/core'
import type { ControlPlane } from '../store/control-plane.js'
import type { PublicFetcher } from './fetcher.js'
import { HeuristicFactExtractor } from '@creator-mall/core'

/** How many candidate paths one cycle may probe. */
const MAX_PROBES_PER_CYCLE = 2

/**
 * Documentation curation.
 *
 * Landing pages rarely state a video length; documentation pages usually do.
 * Rather than guessing which URLs are real, the engine *probes* a small number of
 * candidate paths per cycle and keeps only the ones that earn their place:
 *
 * - a candidate that answers and yields a verified fact is **activated**;
 * - a candidate that 404s or says nothing useful is left inactive;
 * - a candidate that is disallowed by robots.txt is retired immediately.
 *
 * A wrong guess costs one request. It never costs a wrong belief.
 */
export async function probeCandidatePaths(
  control: ControlPlane,
  fetcher: PublicFetcher,
  clock: () => number = Date.now,
): Promise<number> {
  const known = new Set(control.listSources().map((source) => source.id))
  const extractor = new HeuristicFactExtractor()

  const pending: Array<{ source: ReturnType<typeof toSource>; platformId: string }> = []
  for (const platform of control.listPlatforms()) {
    if (platform.status === 'SUNSET') continue
    for (const candidate of candidatesFor(platform.slug)) {
      const source = toSource(candidate)
      if (known.has(source.id)) continue
      known.add(source.id)
      pending.push({ source, platformId: platform.id })
    }
  }

  if (pending.length === 0) return 0

  // Probe the platforms whose current sources are doing the least, so curation
  // spends its budget where knowledge is thinnest.
  const priority = [...pending].sort((a, b) => a.source.url.length - b.source.url.length).slice(0, MAX_PROBES_PER_CYCLE)

  let probed = 0
  for (const entry of priority) {
    const record = control.upsertSource(entry.source)
    probed += 1

    const outcome = await fetcher.fetch(record)
    const at = new Date(clock()).toISOString()
    const nextCheck = new Date(clock() + 86_400_000).toISOString()

    if (outcome.status === 'FAILED' || outcome.status === 'BLOCKED') {
      const blocked = outcome.status === 'BLOCKED'
      control.upsertSource({
        ...record,
        lastStatus: blocked ? 'BLOCKED' : 'FAILED',
        lastCheckedAt: at,
        lastError: outcome.reason,
        consecutiveFailures: blocked ? 1 : 1,
        nextCheckAt: nextCheck,
        // A site that asks us not to read it never becomes active.
        active: false,
        stats: {
          ...(record.stats ?? { checks: 0, successes: 0, failures: 0, blocked: 0, factsContributed: 0, eventsContributed: 0, lastFactAt: null }),
          checks: 1,
          failures: blocked ? 0 : 1,
          blocked: blocked ? 1 : 0,
        },
      })
      continue
    }

    if (outcome.status === 'NOT_MODIFIED') {
      control.upsertSource({ ...record, lastStatus: 'NOT_MODIFIED', lastCheckedAt: at, nextCheckAt: nextCheck })
      continue
    }

    const document = parseDocument(outcome.body, outcome.url, outcome.contentType, outcome.fetchedAt)
    const facts: ExtractedFact[] = await extractor.extract({
      platformId: entry.platformId,
      platformName: control.getPlatform(entry.platformId)?.name ?? entry.source.platform ?? 'platform',
      text: document.text,
      sourceId: record.id,
      capabilityRegistry: control.capabilities,
    })

    const useful = facts.filter((fact) => fact.path.startsWith('limits.') || fact.path.startsWith('mediaSpecs.') || fact.path.startsWith('capabilities.'))
    const earnedItsPlace = useful.length > 0

    control.upsertSource({
      ...record,
      active: earnedItsPlace,
      lastStatus: 'OK',
      lastCheckedAt: at,
      etag: outcome.etag,
      lastModified: outcome.lastModified,
      nextCheckAt: earnedItsPlace ? nextCheck : null,
      stats: {
        checks: 1,
        successes: 1,
        failures: 0,
        blocked: 0,
        factsContributed: useful.length,
        eventsContributed: 0,
        lastFactAt: earnedItsPlace ? at : null,
      },
    })
  }

  return probed
}
