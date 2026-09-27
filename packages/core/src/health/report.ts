import type { ComponentHealth, HealthAlert, SystemHealthReport } from '../types/health.js'
import type { Source } from '../types/source.js'
import type { KnowledgeVersion } from '../types/knowledge.js'
import type { ChangeProposal, EvolutionEvent } from '../types/evolution.js'
import type { HealthStatus, SystemComponent } from '../types/enums.js'
import { nowIso } from '../util.js'

export interface HealthInput {
  sources: ReadonlyArray<Source>
  currentVersions: ReadonlyArray<KnowledgeVersion>
  events: ReadonlyArray<EvolutionEvent>
  proposals: ReadonlyArray<ChangeProposal>
  lastRun: { status: 'SUCCESS' | 'PARTIAL' | 'FAILED'; at: string } | null
  integrationHealth: Partial<Record<SystemComponent, { percent: number; detail: string }>>
  clock?: () => number
}

/**
 * §37: one honest health number per subsystem.
 *
 * The most important rule is §38: a failing crawl never deletes knowledge, it
 * only marks it stale, so "freshness" degrades visibly instead of silently.
 */
export function buildHealthReport(input: HealthInput): SystemHealthReport {
  const clock = input.clock ?? Date.now
  const at = nowIso(clock)
  const components: ComponentHealth[] = []
  const alerts: HealthAlert[] = []

  const active = input.sources.filter((source) => source.active)
  const healthy = active.filter((source) => source.lastStatus === 'OK' || source.lastStatus === 'NOT_MODIFIED')
  const failing = active.filter((source) => source.lastStatus === 'FAILED' || source.lastStatus === 'BLOCKED')
  const neverChecked = active.length > 0 && healthy.length === 0 && failing.length === 0
  components.push({
    component: 'SOURCE_AVAILABILITY',
    status: neverChecked ? 'UNKNOWN' : statusFor(active.length === 0 ? 0 : healthy.length / active.length, 0.9, 0.6),
    percent: percent(active.length === 0 ? 0 : healthy.length / active.length),
    detail: neverChecked
      ? `${active.length} sources registered, none checked yet`
      : `${healthy.length}/${active.length} sources responding`,
    measuredAt: at,
    metrics: { total: active.length, healthy: healthy.length, failing: failing.length },
  })

  const now = clock()
  const fresh = input.currentVersions.filter(
    (version) => !version.expiresAt || new Date(version.expiresAt).getTime() > now,
  )
  const freshness = input.currentVersions.length === 0 ? 1 : fresh.length / input.currentVersions.length
  components.push({
    component: 'PLATFORM_KNOWLEDGE_FRESHNESS',
    status: statusFor(freshness, 0.9, 0.6),
    percent: percent(freshness),
    detail: `${fresh.length}/${input.currentVersions.length} knowledge items current`,
    measuredAt: at,
    metrics: { current: input.currentVersions.length, fresh: fresh.length, expired: input.currentVersions.length - fresh.length },
  })

  const researchOk = input.lastRun?.status === 'SUCCESS'
  components.push({
    component: 'RESEARCH_JOBS',
    status: input.lastRun === null ? 'UNKNOWN' : researchOk ? 'HEALTHY' : input.lastRun.status === 'PARTIAL' ? 'DEGRADED' : 'FAILING',
    percent: input.lastRun === null ? 100 : researchOk ? 100 : input.lastRun.status === 'PARTIAL' ? 60 : 0,
    detail: input.lastRun ? `Last run ${input.lastRun.status.toLowerCase()} at ${input.lastRun.at}` : 'No research run yet',
    measuredAt: at,
    metrics: { lastRunPercent: input.lastRun === null ? 100 : researchOk ? 100 : 50 },
  })

  for (const extra of ['PUBLISHING_INTEGRATIONS', 'AI_PROVIDERS', 'TEMPLATE_GENERATION', 'KNOWLEDGE_INDEXING', 'EMBEDDING_JOBS', 'ANALYTICS_SYNC'] as const) {
    const value = input.integrationHealth[extra]
    components.push({
      component: extra,
      status: value ? statusFor(value.percent / 100, 0.9, 0.6) : 'UNKNOWN',
      percent: value?.percent ?? 100,
      detail: value?.detail ?? 'Not configured in this environment',
      measuredAt: at,
      metrics: {},
    })
  }

  const critical = input.proposals.filter((proposal) => proposal.status === 'PENDING_REVIEW' && proposal.riskLevel === 'CRITICAL')
  const pending = input.proposals.filter((proposal) => proposal.status === 'PENDING_REVIEW')
  if (critical.length > 0) {
    alerts.push({
      id: `alert-critical-${critical.length}`,
      component: 'SOURCE_AVAILABILITY',
      severity: 'CRITICAL',
      message: `${critical.length} critical change(s) are waiting for approval.`,
      raisedAt: at,
      resolvedAt: null,
    })
  }
  if (failing.length > 0) {
    alerts.push({
      id: `alert-sources-${failing.length}`,
      component: 'SOURCE_AVAILABILITY',
      severity: failing.some((source) => source.consecutiveFailures >= 3) ? 'WARNING' : 'INFO',
      message: `${failing.length} source(s) are not responding. Existing knowledge is retained and marked stale.`,
      raisedAt: at,
      resolvedAt: null,
    })
  }
  if (input.currentVersions.length > 0 && freshness < 0.6) {
    alerts.push({
      id: 'alert-freshness',
      component: 'PLATFORM_KNOWLEDGE_FRESHNESS',
      severity: 'WARNING',
      message: 'Most platform knowledge is past its freshness window.',
      raisedAt: at,
      resolvedAt: null,
    })
  }

  const overall = overallStatus(components)

  return {
    generatedAt: at,
    overall,
    components,
    alerts: [...alerts, ...pending.slice(0, 10).map((proposal) => pendingAlert(proposal, at))],
  }
}

function pendingAlert(proposal: ChangeProposal, at: string): HealthAlert {
  return {
    id: `alert-proposal-${proposal.id}`,
    component: 'RESEARCH_JOBS',
    severity: proposal.riskLevel === 'CRITICAL' ? 'CRITICAL' : 'INFO',
    message: `Pending review: ${proposal.title}`,
    raisedAt: at,
    resolvedAt: null,
  }
}

function statusFor(ratio: number, healthy: number, degraded: number): HealthStatus {
  if (ratio >= healthy) return 'HEALTHY'
  if (ratio >= degraded) return 'DEGRADED'
  if (ratio > 0) return 'STALE'
  return 'FAILING'
}

function overallStatus(components: ReadonlyArray<ComponentHealth>): HealthStatus {
  if (components.some((component) => component.status === 'FAILING')) return 'DEGRADED'
  if (components.some((component) => component.status === 'STALE' || component.status === 'DEGRADED')) return 'DEGRADED'
  if (components.every((component) => component.status === 'HEALTHY')) return 'HEALTHY'
  return 'HEALTHY'
}

function percent(ratio: number): number {
  return Math.round(ratio * 100)
}
