import type {
  ChangeProposal,
  PlatformReadinessProfile,
  PlatformTimelineEntry,
  SocialPlatform,
} from '@creator-mall/core'
import {
  buildPlatformUiConfig,
  buildReadinessProfile,
  canEnablePublishing,
  nowIso,
  retrieveKnowledge,
  upsertDocument,
  watchlistOrder,
} from '@creator-mall/core'
import type { AppContext } from '../context.js'
import { publishingEnabled } from '../adapters/registry.js'
import { summarizeState } from '../world-engine/state-builder.js'

/** Everything a platform detail view needs, assembled from capability data. */
export function platformView(context: AppContext, platform: SocialPlatform) {
  const { control } = context
  const snapshot = control.latestSnapshot(platform.id)
  const events = control.listEvents({ platformId: platform.id })
  const canPublish = publishingEnabled(control, context.adapters, platform.id)
  const sources = control.sourcesForPlatform(platform.slug)

  const readiness: PlatformReadinessProfile = buildReadinessProfile({
    platform,
    capabilities: control.capabilities.all(),
    adapter: context.adapters.get(platform.slug) ?? null,
    hasApiSource: sources.some((source) => source.sourceType === 'DEVELOPER'),
    hasOfficialSource: sources.some((source) => source.sourceType === 'OFFICIAL'),
    templatesPrepared: control.listTemplates(platform.id).length,
  })

  const uiConfig = buildPlatformUiConfig({
    platform,
    state: snapshot?.state ?? emptyState(),
    capabilities: control.capabilities.all(),
    events,
    publishingEnabled: canPublish && canEnablePublishing(readiness, context.adapters.get(platform.slug) ?? null),
    generatedAt: nowIso(),
  })

  return {
    platform,
    snapshot: snapshot
      ? { id: snapshot.id, capturedAt: snapshot.capturedAt, sourceIds: snapshot.sourceIds, stateHash: snapshot.stateHash }
      : null,
    summary: snapshot ? summarizeState(snapshot.state) : [],
    readiness,
    uiConfig,
    canPublish,
    sources,
    timeline: platformTimeline(context, platform),
    knowledge: control.knowledgeByPlatform(platform.id).map(({ document, version }) => ({
      title: document.title,
      topic: document.topic,
      status: document.status,
      version: version?.version ?? null,
      updatedAt: document.updatedAt,
      expiresAt: version?.expiresAt ?? null,
      trustLevel: version?.trustLevel ?? null,
      sourceIds: version?.sourceIds ?? [],
    })),
  }
}

export function platformTimeline(context: AppContext, platform: SocialPlatform): PlatformTimelineEntry[] {
  return context.control
    .listEvents({ platformId: platform.id })
    .map((event) => ({
      at: event.detectedAt,
      category: event.category,
      title: event.title,
      detail: event.creatorSummary,
      sourceIds: event.sourceIds,
      trustLevel: event.trustLevel,
      riskLevel: event.riskLevel,
    }))
}

/** §35: "why did this change?" answered from the event log. */
export function explainCapability(context: AppContext, platform: SocialPlatform, capabilityKey: string) {
  const events = context.control.eventsForCapability(platform.id, capabilityKey)
  const definition = context.control.capabilities.get(capabilityKey)
  const latest = events[0]
  const proposals = context.control
    .listProposals()
    .filter((proposal) => proposal.eventId && events.some((event) => event.id === proposal.eventId))

  return {
    capabilityKey,
    label: definition?.label ?? capabilityKey,
    description: definition?.description ?? '',
    domain: definition?.domain ?? 'CONTENT',
    currentState: latest ? 'ACTIVE' : 'UNKNOWN',
    explanation: latest
      ? `${latest.title}\n\n${latest.evidence.join(' ')}`
      : 'We have no verified change on record for this option yet.',
    detectedAt: latest?.detectedAt ?? null,
    verifiedAt: latest?.verifiedAt ?? null,
    verifiedThrough: latest?.sourceIds ?? [],
    updatedAt: latest?.verifiedAt ?? latest?.detectedAt ?? null,
    relatedProposals: proposals.map((proposal) => ({
      id: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      riskLevel: proposal.riskLevel,
      decidedAt: proposal.decidedAt,
    })),
  }
}

/** §26: the Evolution Center counters. */
export function evolutionSummary(context: AppContext) {
  const { control } = context
  const events = control.listEvents()
  const proposals = control.listProposals()
  const pending = proposals.filter((proposal) => proposal.status === 'PENDING_REVIEW')
  const autoApproved = proposals.filter((proposal) => proposal.status === 'AUTO_APPROVED')

  const knowledgeUpdates = autoApproved.length + control.currentKnowledgeVersions().length
  const featureProposals = proposals.filter((proposal) =>
    ['CAPABILITY_REGISTRATION', 'UI_CONFIG', 'TEMPLATE_SET', 'PROMPT_VERSION'].includes(proposal.kind),
  ).length
  const apiChanges = events.filter((event) => event.category === 'API_CHANGE' || event.category === 'API_DEPRECATION').length
  const failures = control.listJobRuns(20).filter((run) => run.status === 'FAILED').length
  const emerging = control
    .listPlatforms()
    .filter((platform) => ['EMERGING', 'COMING_SOON', 'ANNOUNCED', 'BETA', 'DISCOVERED'].includes(platform.status))
    .sort((a, b) => watchlistOrder(a.status) - watchlistOrder(b.status))

  return {
    knowledgeUpdates,
    featureProposals,
    apiChanges,
    failures,
    emergingPlatforms: emerging.map((platform) => ({
      id: platform.id,
      name: platform.name,
      status: platform.status,
      readinessPercent: platformView(context, platform).readiness.overallPercent,
    })),
    pendingApprovals: pending.length,
    criticalPending: pending.filter((proposal) => proposal.riskLevel === 'CRITICAL').length,
    promptVersions: control.prompts.all().length,
    templatesPrepared: control.listTemplates().length,
    recentEvents: events.slice(0, 10).map((event) => ({
      id: event.id,
      title: event.title,
      platformId: event.platformId,
      riskLevel: event.riskLevel,
      trustLevel: event.trustLevel,
      detectedAt: event.detectedAt,
      status: event.status,
    })),
  }
}

/** §30: the concierge answers from maintained knowledge, never from model memory. */
export function knowledgeSearch(context: AppContext, query: string, platformSlug?: string) {
  const platform = platformSlug ? context.control.getPlatform(platformSlug) : undefined
  const answer = retrieveKnowledge(context.control.knowledge, {
    query,
    platformId: platform?.id ?? null,
    limit: 8,
  })
  return {
    query,
    degraded: answer.degraded,
    notice: answer.notice,
    results: answer.results.map((result) => ({
      text: result.chunk.text,
      score: result.score,
      document: result.documentTitle,
      version: result.version,
      status: result.versionStatus,
      stale: result.stale,
      trustLevel: result.trustLevel,
      sourceIds: result.sourceIds,
    })),
  }
}

/** §29: creator-facing updates, in language a creator understands. */
export function creatorUpdates(context: AppContext, creatorId: string) {
  const creator = context.control.getCreator(creatorId)
  if (!creator) return null
  const notifications = context.control.listNotifications(creatorId)
  const impacts = context.control.listImpacts(creatorId)
  return {
    creator: { id: creator.id, name: creator.displayName, platforms: creator.platformSlugs },
    updates: notifications.map((notification) => ({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      when: notification.createdAt,
      read: notification.readAt !== null,
      actions: notification.actions,
      sources: notification.sourceIds.map((id) => {
        const source = context.control.getSource(id)
        return { name: source?.name ?? 'Official source', url: source?.url ?? null, type: source?.sourceType ?? null }
      }),
    })),
    impact: impacts
      .filter((impact) => impact.level !== 'NONE')
      .map((impact) => ({
        platform: impact.platformSlug,
        level: impact.level,
        why: impact.reasons,
        suggested: impact.recommendedActions,
      })),
  }
}

export function applyProposalDecision(
  context: AppContext,
  proposalId: string,
  decision: 'approve' | 'reject',
  actor: string,
  note: string | null,
): ChangeProposal | undefined {
  const { control } = context
  const proposal = control.getProposal(proposalId)
  if (!proposal) return undefined
  if (proposal.status !== 'PENDING_REVIEW' && proposal.status !== 'DRAFT') return proposal

  proposal.status = decision === 'approve' ? 'APPROVED' : 'REJECTED'
  proposal.decidedAt = nowIso()
  proposal.decidedBy = actor
  proposal.decisionNote = note

  if (decision === 'approve' && proposal.eventId) {
    const event = control.getEvent(proposal.eventId)
    if (event) {
      event.approvedBy = actor
      event.status = 'APPLIED'
      applySafeActions(context, proposal)
    }
  }
  return proposal
}

/**
 * §11 + §33: approving a proposal applies only what is safe to apply by
 * itself — knowledge documents and capability metadata. Anything touching code,
 * migrations, security or publishing is recorded as handed to CI and still
 * requires a controlled deployment.
 */
function applySafeActions(context: AppContext, proposal: ChangeProposal): void {
  const { control } = context
  for (const action of proposal.actions) {
    if (action.type === 'REGISTER_CAPABILITY' && isObject(action.payload)) {
      const capabilityKey = stringField(action.payload, 'capabilityKey')
      if (!capabilityKey) continue
      if (!control.capabilities.has(capabilityKey)) {
        control.capabilities.proposeFromSignal(capabilityKey, labelFor(capabilityKey), 'CONTENT')
      }
      continue
    }

    if (action.type === 'UPSERT_KNOWLEDGE' && isObject(action.payload)) {
      const platform = action.target.startsWith('platform:') ? control.getPlatform(action.target.slice('platform:'.length)) : undefined
      const slug = platform?.slug ?? 'ecosystem'
      upsertDocument(control.knowledge, {
        slug: `platform/${slug}/updates`,
        title: platform ? `${platform.name}: what changed` : 'Creator Mall: what changed',
        topic: 'platform-updates',
        platformId: platform?.id ?? null,
        body: renderDeltaBody(action.payload),
        sourceIds: proposal.actions.flatMap((entry) => (isObject(entry.payload) ? stringArrayField(entry.payload, 'sourceIds') : [])),
        trustLevel: 'OFFICIAL',
        confidence: 0.8,
        changeNote: proposal.title,
      })
    }
  }
}

function renderDeltaBody(payload: Record<string, unknown>): string {
  const entries = Array.isArray(payload) ? payload : []
  const lines = entries
    .map((entry) => {
      if (!isObject(entry)) return null
      const path = stringField(entry, 'path') ?? 'change'
      const after = entry.after
      return `## ${path}\n\nNew value: ${after === null || after === undefined ? 'n/a' : JSON.stringify(after)}`
    })
    .filter((line): line is string => Boolean(line))
  return lines.length > 0 ? lines.join('\n\n') : 'No structured detail recorded for this update.'
}


function emptyState() {
  return {
    capabilities: {},
    limits: {},
    mediaSpecs: {},
    publishing: {},
    api: {},
    analytics: {},
    monetization: {},
    requirements: {},
    policies: [],
    notes: [],
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  return typeof field === 'string' ? field : null
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key]
  return Array.isArray(field) ? field.filter((entry): entry is string => typeof entry === 'string') : []
}

function labelFor(key: string): string {
  return key
    .toLowerCase()
    .split('_')
    .map((part) => (part.length <= 2 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ')
}
