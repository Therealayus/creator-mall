import {
  HeuristicFactExtractor,
  assessSources,
  diffSnapshots,
  emptyPlatformState,
  expireStaleKnowledge,
  hashState,
  impactToNotification,
  newId,
  notifyThreshold,
  nowIso,
  parseDocument,
  planEvolution,
  scoreCreatorImpact,
  upsertDocument,
  verifyFacts,
} from '@creator-mall/core'
import type {
  CapabilityState,
  ChangeCategory,
  EvolutionEvent,
  EventType,
  ExtractedFact,
  PlatformSnapshot,
  ResearchJobRun,
  RiskLevel,
  SocialPlatform,
  Source,
  StateDelta,
  VerifiedClaim,
} from '@creator-mall/core'
import type { FactExtractor } from '@creator-mall/core'
import type { ControlPlane } from '../store/control-plane.js'
import type { PublicFetcher } from './fetcher.js'
import { applyClaims } from './state-builder.js'
import { discoverPlatformSignals } from './discovery.js'

export interface ResearchDeps {
  control: ControlPlane
  fetcher: PublicFetcher
  clock?: () => number
  /** Only research sources that are due. */
  respectSchedule?: boolean
  maxSourcesPerRun?: number
  /**
   * Optional model-backed extractor. When present it is tried first and the
   * deterministic extractor is used for anything it cannot handle, so a provider
   * outage degrades quality instead of stopping research (§38).
   */
  modelExtractor?: FactExtractor | null
  /** Called with a short, key-free reason when the model path is skipped. */
  onModelFallback?: (reason: string) => void
}

export interface CycleResult extends ResearchJobRun {
  events: EvolutionEvent[]
  /** Short, key-free reasons the model path was skipped this cycle. */
  modelFallbacks: string[]
}

/**
 * §5 + §45: one pass of the continuous loop.
 *
 * DISCOVER → RESEARCH → VERIFY → UNDERSTAND → IMPACT → PLAN → PUBLISH.
 *
 * Failure behaviour (§38): a failed or blocked fetch never deletes knowledge.
 * The source is marked, the previous snapshot is kept, and the gap is visible
 * in the health report instead of being silently swallowed.
 */
export async function runResearchCycle(deps: ResearchDeps): Promise<CycleResult> {
  const clock = deps.clock ?? Date.now
  const { control, fetcher } = deps
  const startedAt = nowIso(clock)

  const heuristic = new HeuristicFactExtractor()
  const model = deps.modelExtractor ?? null
  const registry = control.capabilities
  const createdEvents: EvolutionEvent[] = []
  let sourcesChecked = 0
  let sourcesFailed = 0
  let snapshotsCreated = 0
  let proposalsCreated = 0
  let knowledgePublished = 0
  const modelFallbacks: string[] = []

  // §16: before auditing known platforms, look for ones we have never heard of.
  for (const event of await discoverPlatformSignals({ control, fetcher, clock })) {
    control.addEvent(event)
    createdEvents.push(event)
    proposalsCreated += planAndRecord(control, event, clock)
  }

  const platforms = control.listPlatforms().filter((platform) => platform.status !== 'SUNSET')
  const now = clock()
  const limit = deps.maxSourcesPerRun ?? Number.POSITIVE_INFINITY

  for (const platform of platforms) {
    const due = selectSources(control.sourcesForPlatform(platform.slug), now, deps.respectSchedule !== false).slice(0, limit)
    if (due.length === 0) continue

    const facts: ExtractedFact[] = []

    for (const source of due) {
      sourcesChecked += 1
      const outcome = await fetcher.fetch(source, { etag: source.etag, lastModified: source.lastModified })

      if (outcome.status === 'OK') {
        const updated = markSource(control, source, {
          status: 'OK',
          at: outcome.fetchedAt,
          etag: outcome.etag,
          lastModified: outcome.lastModified,
        })
        const document = parseDocument(outcome.body, outcome.url, outcome.contentType, outcome.fetchedAt)
        const extractInput = {
          platformId: platform.id,
          platformName: platform.name,
          text: document.text,
          sourceId: updated.id,
          capabilityRegistry: registry,
        }

        let extracted: ExtractedFact[] = []
        if (model) {
          try {
            extracted = await model.extract(extractInput)
          } catch (error) {
            // A provider problem is never a research problem: fall back, note it, continue.
            const reason = error instanceof Error ? error.message : 'model extraction failed'
            modelFallbacks.push(reason)
            deps.onModelFallback?.(reason)
            extracted = []
          }
        }

        // The deterministic extractor always runs. Facts agree on `key`, so a
        // confirmed limit is not duplicated, and a model can only add coverage.
        extracted.push(...(await heuristic.extract(extractInput)))
        facts.push(...dedupeFacts(extracted))
        continue
      }

      if (outcome.status === 'NOT_MODIFIED') {
        markSource(control, source, { status: 'NOT_MODIFIED', at: outcome.fetchedAt })
        continue
      }

      sourcesFailed += 1
      markSource(control, source, {
        status: outcome.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED',
        at: outcome.fetchedAt,
        error: outcome.reason,
      })
    }

    const claims = verifyFacts(facts, control.listSources())
    knowledgePublished += publishAcceptedKnowledge(control, platform, claims, clock)

    const previous = control.latestSnapshot(platform.id)
    const state = applyClaims(previous?.state ?? emptyPlatformState(), claims)
    const snapshot: PlatformSnapshot = {
      id: newId('snap', clock),
      platformId: platform.id,
      capturedAt: nowIso(clock),
      sourceIds: due.map((source) => source.id),
      stateHash: hashState(state),
      state,
      capturedBy: 'SCHEDULED_RESEARCH',
    }
    control.addSnapshot(snapshot)
    snapshotsCreated += 1
    updatePlatformCapabilities(control, platform, state)

    const diff = diffSnapshots(platform.id, previous ?? null, snapshot)
    // The first capture is a baseline, not a change: there is nothing to compare
    // against, so no event is fabricated from initial knowledge.
    if (!previous || diff.deltas.length === 0) continue

    for (const event of buildEvents({ control, platform, diff, claims, clock })) {
      control.addEvent(event)
      createdEvents.push(event)
      proposalsCreated += planAndRecord(control, event, clock)
      notifyCreators(control, event, clock)
    }
  }

  expireStaleKnowledge(control.knowledge, clock)

  const status: ResearchJobRun['status'] =
    sourcesFailed === 0 ? 'SUCCESS' : sourcesChecked === 0 ? 'FAILED' : 'PARTIAL'

  const result: CycleResult = {
    id: newId('run', clock),
    startedAt,
    finishedAt: nowIso(clock),
    status,
    sourcesChecked,
    sourcesFailed,
    snapshotsCreated,
    eventsCreated: createdEvents.length,
    proposalsCreated,
    knowledgePublished,
    error: null,
    modelFallbacks: [...new Set(modelFallbacks)],
    events: createdEvents,
  }
  control.addJobRun(result)
  return result
}

/** Two extractors can find the same claim; the higher-confidence one wins. */
function dedupeFacts(facts: ReadonlyArray<ExtractedFact>): ExtractedFact[] {
  const byKey = new Map<string, ExtractedFact>()
  for (const fact of facts) {
    const existing = byKey.get(fact.key)
    if (!existing || fact.confidence > existing.confidence) byKey.set(fact.key, fact)
  }
  return [...byKey.values()]
}

function selectSources(sources: ReadonlyArray<Source>, now: number, respectSchedule: boolean): Source[] {
  return sources
    .filter((source) =>
      respectSchedule ? !source.nextCheckAt || new Date(source.nextCheckAt).getTime() <= now : true,
    )
    .sort((a, b) => (a.lastCheckedAt ?? '').localeCompare(b.lastCheckedAt ?? ''))
}

function markSource(
  control: ControlPlane,
  source: Source,
  update: {
    status: Source['lastStatus']
    at: string
    error?: string
    etag?: string
    lastModified?: string
  },
): Source {
  const ok = update.status === 'OK' || update.status === 'NOT_MODIFIED'
  const nextCheckHours = source.sourceType === 'DEVELOPER' || source.sourceType === 'NEWS' ? 24 : 12
  return control.upsertSource({
    ...source,
    lastStatus: update.status,
    lastCheckedAt: update.at,
    lastError: update.error,
    etag: update.etag ?? source.etag,
    lastModified: update.lastModified ?? source.lastModified,
    consecutiveFailures: ok ? 0 : source.consecutiveFailures + 1,
    nextCheckAt: new Date(new Date(update.at).getTime() + nextCheckHours * 3_600_000).toISOString(),
  })
}

/**
 * §14 + §15: accepted claims become versioned knowledge with a TTL matched to
 * how fast they decay. Nothing is written for rejected signals.
 */
function publishAcceptedKnowledge(
  control: ControlPlane,
  platform: SocialPlatform,
  claims: ReadonlyArray<VerifiedClaim>,
  clock: () => number,
): number {
  const accepted = claims.filter((claim) => claim.status === 'ACCEPTED')
  if (accepted.length === 0) return 0

  // Quality gate: a "what creators can do" page that contains no confirmed
  // capability or limit is not worth publishing. Empty is better than vague.
  const substantive = accepted.filter(
    (claim) => claim.path.startsWith('capabilities.') || claim.path.startsWith('limits.') || claim.path.startsWith('mediaSpecs.'),
  )
  if (substantive.length === 0) return 0

  let published = 0
  upsertDocument(control.knowledge, {
    slug: `platform/${platform.slug}/capabilities`,
    title: `${platform.name}: what creators can do`,
    topic: 'platform-capabilities',
    platformId: platform.id,
    body: substantive.map((claim) => evidenceBlock(claim)).join('\n\n'),
    sourceIds: [...new Set(substantive.flatMap((claim) => claim.sourceIds))],
    trustLevel: strongestTrust(substantive),
    confidence: Math.max(...substantive.map((claim) => claim.confidence)),
    ttlPolicy: 'PLATFORM_GENERAL',
    changeNote: 'Refreshed from verified sources during scheduled research.',
    clock,
  })
  published += 1

  const limitClaims = accepted.filter(
    (claim) => claim.path.startsWith('limits.') || claim.path.startsWith('mediaSpecs.'),
  )
  if (limitClaims.length > 0) {
    upsertDocument(control.knowledge, {
      slug: `platform/${platform.slug}/limits`,
      title: `${platform.name}: current limits`,
      topic: 'platform-limits',
      platformId: platform.id,
      body: limitClaims.map((claim) => evidenceBlock(claim)).join('\n\n'),
      sourceIds: [...new Set(limitClaims.flatMap((claim) => claim.sourceIds))],
      trustLevel: strongestTrust(limitClaims),
      confidence: Math.max(...limitClaims.map((claim) => claim.confidence)),
      ttlPolicy: 'PLATFORM_LIMIT',
      changeNote: 'Limits are re-verified on every research cycle because they break publishing when wrong.',
      clock,
    })
    published += 1
  }

  return published
}

const TRUST_ORDER = ['OFFICIAL', 'VERIFIED', 'REPORTED', 'COMMUNITY_SIGNAL', 'UNCONFIRMED', 'RUMOR'] as const

/** Knowledge bodies always carry the evidence a claim was published on. */
function evidenceBlock(claim: VerifiedClaim): string {
  const evidence = claim.evidence.length > 0 ? claim.evidence.join(' ') : claim.rationale
  return `## ${claim.statement}\n\n${evidence}`
}

function strongestTrust(claims: ReadonlyArray<VerifiedClaim>): VerifiedClaim['trustLevel'] {
  let best: VerifiedClaim['trustLevel'] = TRUST_ORDER[TRUST_ORDER.length - 1]!
  for (const claim of claims) {
    if (TRUST_ORDER.indexOf(claim.trustLevel) < TRUST_ORDER.indexOf(best)) best = claim.trustLevel
  }
  return best
}

function buildEvents(input: {
  control: ControlPlane
  platform: SocialPlatform
  diff: ReturnType<typeof diffSnapshots>
  claims: ReadonlyArray<VerifiedClaim>
  clock: () => number
}): EvolutionEvent[] {
  const { control, platform, diff, claims, clock } = input
  const sourcesByPath = new Map<string, string[]>()
  const capabilitiesByPath = new Map<string, string[]>()
  for (const claim of claims) {
    sourcesByPath.set(claim.path, [...new Set([...(sourcesByPath.get(claim.path) ?? []), ...claim.sourceIds])])
    capabilitiesByPath.set(claim.path, [
      ...new Set([...(capabilitiesByPath.get(claim.path) ?? []), ...claim.capabilityKeys]),
    ])
  }

  // Deltas inherit the capabilities the extracted fact was about, so "what is
  // affected" is answerable even for paths such as `limits.video.maxDuration`.
  const deltas = diff.deltas.map((delta) => ({
    ...delta,
    capabilityKeys:
      delta.capabilityKeys.length > 0
        ? delta.capabilityKeys
        : (capabilitiesByPath.get(delta.path) ?? []),
  }))

  return groupDeltas(deltas).map((group) => {
    const eventType = eventTypeFor(group.category)
    const affected = [...new Set(group.deltas.flatMap((delta) => delta.capabilityKeys))]
    const sourceIds = [...new Set(group.deltas.flatMap((delta) => sourcesByPath.get(delta.path) ?? []))]
    const trust = assessSources(
      sourceIds.map((id) => control.getSource(id)).filter((source): source is Source => Boolean(source)),
    )
    const risk = group.deltas.reduce<RiskLevel>(
      (acc, delta) => (rank(delta.riskLevel) > rank(acc) ? delta.riskLevel : acc),
      'LOW',
    )
    const verifiedAt = trust.trustLevel === 'OFFICIAL' || trust.trustLevel === 'VERIFIED' ? nowIso(clock) : null

    return {
      id: newId('evt', clock),
      platformId: platform.id,
      platformName: platform.name,
      eventType,
      category: group.category,
      title: titleFor(platform.name, group),
      creatorSummary: creatorSummaryFor(platform.name, group),
      detectedAt: nowIso(clock),
      verifiedAt,
      sourceIds,
      trustLevel: trust.trustLevel,
      confidence: trust.confidence,
      previousState: group.deltas.map((delta) => ({ path: delta.path, value: delta.before ?? null })),
      newState: group.deltas.map((delta) => ({ path: delta.path, value: delta.after ?? null })),
      deltas: group.deltas,
      impact: 'Assessed per creator by the impact engine; only relevant creators are notified.',
      affectedCapabilityKeys: affected,
      affectedComponents: [],
      riskLevel: risk,
      status: verifiedAt ? 'VERIFIED' : 'DETECTED',
      approvedBy: null,
      deployedAt: null,
      evidence: group.deltas.map((delta) => delta.rationale),
    }
  })
}

function groupDeltas(deltas: ReadonlyArray<StateDelta>): Array<{ category: ChangeCategory; deltas: StateDelta[] }> {
  const groups = new Map<ChangeCategory, StateDelta[]>()
  for (const delta of deltas) {
    const bucket = groups.get(delta.category)
    if (bucket) bucket.push(delta)
    else groups.set(delta.category, [delta])
  }
  return [...groups.entries()].map(([category, list]) => ({ category, deltas: list }))
}

function eventTypeFor(category: ChangeCategory): EventType {
  switch (category) {
    case 'API_DEPRECATION':
      return 'API_DEPRECATED'
    case 'NEW_FEATURE':
      return 'NEW_CAPABILITY_DETECTED'
    case 'REMOVED_FEATURE':
      return 'CAPABILITY_DEPRECATED'
    case 'CONTENT_LIMIT':
    case 'FILE_SIZE_LIMIT':
    case 'CHARACTER_LIMIT':
    case 'HASHTAG_BEHAVIOR':
      return 'LIMIT_CHANGED'
    case 'VIDEO_SPEC':
    case 'IMAGE_SPEC':
      return 'SPEC_CHANGED'
    case 'POLICY_CHANGE':
      return 'POLICY_CHANGED'
    case 'MONETIZATION_CHANGE':
      return 'MONETIZATION_CHANGED'
    case 'ANALYTICS_CHANGE':
      return 'ANALYTICS_CHANGED'
    case 'NEW_PLATFORM':
      return 'NEW_PLATFORM_DISCOVERED'
    default:
      return 'KNOWLEDGE_REFRESHED'
  }
}

function titleFor(platformName: string, group: { category: ChangeCategory; deltas: StateDelta[] }): string {
  const first = group.deltas[0]
  if (!first) return `${platformName} update`
  if (group.category === 'NEW_FEATURE') {
    return `${platformName} added ${first.capabilityKeys[0]?.replace(/_/g, ' ').toLowerCase() ?? 'a new option'}`
  }
  if (group.category === 'REMOVED_FEATURE' || group.category === 'API_DEPRECATION') {
    return `${platformName} stopped supporting ${first.capabilityKeys[0]?.replace(/_/g, ' ').toLowerCase() ?? 'a feature'}`
  }
  return `${platformName} changed ${topicOf(first.path)}`
}

function creatorSummaryFor(platformName: string, group: { category: ChangeCategory; deltas: StateDelta[] }): string {
  const first = group.deltas[0]
  switch (group.category) {
    case 'NEW_FEATURE':
      return `${platformName} added a new option you can use in your posts.`
    case 'REMOVED_FEATURE':
    case 'API_DEPRECATION':
      return `An option you may use is no longer available on ${platformName}.`
    case 'CONTENT_LIMIT':
    case 'CHARACTER_LIMIT':
    case 'FILE_SIZE_LIMIT':
      return `The limits on ${platformName} posts changed, so check that your existing content still fits.`
    case 'VIDEO_SPEC':
    case 'IMAGE_SPEC':
      return `${platformName} changed its media requirements, which may affect how you export videos and images.`
    case 'MONETIZATION_CHANGE':
      return `${platformName} updated its earnings rules.`
    case 'POLICY_CHANGE':
      return `${platformName} updated a rule that affects what you can post.`
    default:
      return `${platformName} published an update${first ? ` about ${topicOf(first.path)}` : ''}.`
  }
}

function topicOf(path: string): string {
  return path
    .split('.')
    .slice(1)
    .join(' ')
    .replace(/_/g, ' ')
    .trim()
}

function planAndRecord(control: ControlPlane, event: EvolutionEvent, clock: () => number): number {
  const knowledgeOnly = event.category === 'DOCUMENTATION_CHANGE' && event.riskLevel === 'LOW'

  const proposals = planEvolution({
    event: {
      id: event.id,
      platformId: event.platformId,
      platformName: event.platformName,
      eventType: event.eventType,
      category: event.category,
      title: event.title,
      deltas: event.deltas,
      riskLevel: event.riskLevel,
      affectedCapabilityKeys: event.affectedCapabilityKeys,
      sourceIds: event.sourceIds,
    },
    graph: control.graph,
    knowledgeOnly,
    clock,
  })

  for (const proposal of proposals) {
    const affected = proposal.affectedComponents.length > 0 ? proposal.affectedComponents : event.affectedComponents
    control.addProposal({ ...proposal, affectedComponents: affected })
    event.affectedComponents = affected
  }
  return proposals.length
}

/** §29: only creators the change actually affects are notified. */
function notifyCreators(control: ControlPlane, event: EvolutionEvent, clock: () => number): void {
  if (!event.platformId) return
  const platform = control.getPlatform(event.platformId)
  if (!platform) return
  if (['RUMOR', 'UNCONFIRMED', 'COMMUNITY_SIGNAL'].includes(event.trustLevel)) return

  const at = nowIso(clock)
  for (const creator of control.listCreators()) {
    // Platform-change alerts are per usage: a creator is only told about
    // platforms they actually publish to, however relevant the change looks.
    if (!creator.platformSlugs.includes(platform.slug)) continue

    const base = scoreCreatorImpact(creator, {
      category: event.category,
      riskLevel: event.riskLevel,
      platformSlug: platform.slug,
      affectedCapabilityKeys: event.affectedCapabilityKeys,
      title: event.title,
    })
    if (base.score < notifyThreshold()) continue
    const impact = control.addImpact({ ...base, eventId: event.id })
    control.addNotification(impactToNotification(impact, event, at))
  }
}

function updatePlatformCapabilities(
  control: ControlPlane,
  platform: SocialPlatform,
  state: PlatformSnapshot['state'],
): void {
  const active = Object.values(state.capabilities)
    .filter((observation) => observation.state === 'ACTIVE')
    .map((observation) => observation.capabilityKey)
  if (active.length === 0) return
  control.upsertPlatform({ ...platform, capabilityKeys: [...new Set([...platform.capabilityKeys, ...active])] })
}

export function capabilityStateFor(state: PlatformSnapshot['state'], key: string): CapabilityState {
  return state.capabilities[key]?.state ?? 'UNKNOWN'
}

function rank(level: RiskLevel): number {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(level)
}
