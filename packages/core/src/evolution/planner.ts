import type {
  AffectedComponent,
  ChangeProposal,
  ProposalAction,
  StateDelta,
} from '../types/evolution.js'
import type { AutonomyTier, ChangeCategory, EventType, ProposalKind, RiskLevel } from '../types/enums.js'
import type { JsonValue } from '../types/platform.js'
import type { DependencyGraph } from './dependency-graph.js'
import { newId, stableId, nowIso } from '../util.js'

export interface PlanContext {
  event: {
    id: string
    platformId: string | null
    platformName?: string
    eventType: EventType
    category: ChangeCategory
    title: string
    deltas: StateDelta[]
    riskLevel: RiskLevel
    affectedCapabilityKeys: string[]
    sourceIds: string[]
  }
  graph: DependencyGraph
  /** Change is a knowledge-only refresh: nothing in the product must change. */
  knowledgeOnly?: boolean
  clock?: () => number
}

/**
 * §10 + §11: converts a *verified* ecosystem change into concrete, reviewable
 * work items.
 *
 * The planner never edits production code. It emits proposals containing
 * machine-checkable actions; low-risk knowledge updates may be auto-approved,
 * everything else is staged for a human or CI.
 */
export function planEvolution(context: PlanContext): ChangeProposal[] {
  const clock = context.clock ?? Date.now
  const { event } = context
  const proposals: ChangeProposal[] = []
  const affected = collectAffectedComponents(context)

  if (context.knowledgeOnly || (event.category === 'DOCUMENTATION_CHANGE' && event.riskLevel === 'LOW')) {
    proposals.push(
      makeProposal({
        event,
        kind: 'KNOWLEDGE_UPDATE',
        title: `Refresh platform knowledge: ${event.title}`,
        rationale:
          'Only reference information changed. The product behaviour stays the same, so the update is published automatically.',
        riskLevel: 'LOW',
        autonomyTier: 'AUTOMATIC',
        status: 'AUTO_APPROVED',
        actions: [
          {
            id: 'knowledge',
            type: 'UPSERT_KNOWLEDGE',
            target: `platform:${event.platformId ?? 'unknown'}`,
            payload: deltasPayload(event.deltas),
            autonomyTier: 'AUTOMATIC',
          },
        ],
        testPlan: ['knowledge freshness check', 'retrieval smoke test'],
        affected,
        clock,
      }),
    )
    return proposals
  }

  switch (event.eventType) {
    case 'NEW_CAPABILITY_DETECTED':
    case 'NEW_PLATFORM_DISCOVERED':
      proposals.push(
        makeProposal({
          event,
          kind: 'CAPABILITY_REGISTRATION',
          title: `Register ${event.affectedCapabilityKeys.join(', ') || 'new format'} on ${event.platformName ?? 'platform'}`,
          rationale:
            'A verified capability appeared. Registering it lets Creator Mall represent the platform without waiting for a redesign.',
          riskLevel: event.riskLevel === 'CRITICAL' ? 'HIGH' : event.riskLevel,
          autonomyTier: 'CONTROLLED',
          status: 'PENDING_REVIEW',
          actions: [
            ...event.affectedCapabilityKeys.map((key, index) => action(`capability-${index}`, 'REGISTER_CAPABILITY', `capability:${key}`, { capabilityKey: key, platformId: event.platformId }, 'AUTOMATIC')),
            action('ui', 'UPDATE_UI_CONFIG', `platform:${event.platformId ?? 'unknown'}`, { addCapabilities: event.affectedCapabilityKeys }, 'CONTROLLED'),
            action('prompts', 'BUMP_PROMPT_VERSION', `platform:${event.platformId ?? 'unknown'}`, { capabilities: event.affectedCapabilityKeys }, 'CONTROLLED'),
            action('templates', 'GENERATE_TEMPLATES', `platform:${event.platformId ?? 'unknown'}`, { capabilities: event.affectedCapabilityKeys }, 'CONTROLLED'),
          ],
          testPlan: [
            'capability registry consistency',
            'creation menu renders the new option',
            'prompt version activates cleanly',
            'template set generation',
          ],
          affected,
          clock,
        }),
      )
      break

    case 'CAPABILITY_DEPRECATED':
    case 'API_DEPRECATED':
      proposals.push(
        makeProposal({
          event,
          kind: 'CAPABILITY_DEPRECATION',
          title: `Withdraw ${event.affectedCapabilityKeys.join(', ') || 'capability'} from ${event.platformName ?? 'platform'}`,
          rationale:
            'The platform no longer supports this capability. Leaving the button in place would show creators a dead end.',
          riskLevel: 'HIGH',
          autonomyTier: 'CONTROLLED',
          status: 'PENDING_REVIEW',
          actions: [
            ...event.affectedCapabilityKeys.map((key, index) =>
              action(`deprecate-${index}`, 'DEPRECATE_CAPABILITY', `capability:${key}`, { capabilityKey: key, platformId: event.platformId }, 'CONTROLLED'),
            ),
            action('ui', 'UPDATE_UI_CONFIG', `platform:${event.platformId ?? 'unknown'}`, { removeCapabilities: event.affectedCapabilityKeys }, 'CONTROLLED'),
            action('creator-note', 'UPSERT_KNOWLEDGE', `platform:${event.platformId ?? 'unknown'}`, { note: 'This option is no longer available.' }, 'AUTOMATIC'),
          ],
          testPlan: ['deprecated actions are hidden', 'publishing rejects deprecated payloads', 'creator notification is queued'],
          affected,
          clock,
        }),
      )
      break

    default:
      proposals.push(
        makeProposal({
          event,
          kind: workflowKindFor(event.category),
          title: `Adapt Creator Mall to: ${event.title}`,
          rationale: `A verified ${event.category.replace(/_/g, ' ').toLowerCase()} change affects existing creator workflows.`,
          riskLevel: event.riskLevel,
          autonomyTier: 'CONTROLLED',
          status: 'PENDING_REVIEW',
          actions: buildAdaptationActions(event),
          testPlan: buildTestPlan(event),
          affected,
          clock,
        }),
      )
  }

  if (event.riskLevel === 'CRITICAL') {
    proposals.push(
      makeProposal({
        event,
        kind: 'SECURITY_REVIEW',
        title: `Security and access review: ${event.title}`,
        rationale:
          'Critical changes can lock creators out or break authentication. Affected workflows are paused until a human signs off.',
        riskLevel: 'CRITICAL',
        autonomyTier: 'CONTROLLED',
        status: 'PENDING_REVIEW',
        actions: [
          action('alert', 'ALERT_ADMIN', 'evolution-center', { severity: 'CRITICAL', platformId: event.platformId }, 'AUTOMATIC'),
          action('pause', 'PAUSE_WORKFLOW', `platform:${event.platformId ?? 'unknown'}`, { reason: 'critical change under review' }, 'CONTROLLED'),
          action('review', 'SECURITY_REVIEW', `platform:${event.platformId ?? 'unknown'}`, { scope: event.category }, 'CONTROLLED'),
        ],
        testPlan: ['authentication regression suite', 'publisher integration smoke test', 'rollback rehearsal'],
        affected,
        clock,
      }),
    )
  }

  return proposals
}

function buildAdaptationActions(event: PlanContext['event']): ProposalAction[] {
  const actions: ProposalAction[] = [
    action('knowledge', 'UPSERT_KNOWLEDGE', `platform:${event.platformId ?? 'unknown'}`, deltasPayload(event.deltas), 'AUTOMATIC'),
  ]

  if (event.category === 'MONETIZATION_CHANGE') {
    actions.push(action('docs', 'WRITE_DOCUMENTATION', `monetization:${event.platformId ?? 'unknown'}`, { reason: 'monetization terms changed' }, 'CONTROLLED'))
  }
  if (event.category === 'POLICY_CHANGE' || event.category === 'HASHTAG_BEHAVIOR') {
    actions.push(action('prompts', 'BUMP_PROMPT_VERSION', `platform:${event.platformId ?? 'unknown'}`, { reason: event.category }, 'CONTROLLED'))
  }
  if (event.category === 'NEW_PLATFORM') {
    actions.push(action('integration', 'CREATE_INTEGRATION_TASK', `platform:${event.platformId ?? 'unknown'}`, { stage: 'readiness' }, 'CONTROLLED'))
  }
  return actions
}

function buildTestPlan(event: PlanContext['event']): string[] {
  const tests = ['content generation for the platform', 'media requirement validation', 'publishing payload shape']
  if (event.riskLevel === 'HIGH' || event.riskLevel === 'CRITICAL') tests.push('integration regression suite', 'rollback rehearsal')
  if (event.category === 'ANALYTICS_CHANGE') tests.push('metric mapping')
  if (event.category === 'NEW_FEATURE' || event.category === 'CONTENT_FORMAT') tests.push('creation menu rendering', 'template generation')
  return tests
}

function workflowKindFor(category: ChangeCategory): ProposalKind {
  if (category === 'NEW_FEATURE' || category === 'CONTENT_FORMAT') return 'UI_CONFIG'
  if (category === 'MONETIZATION_CHANGE' || category === 'POLICY_CHANGE') return 'DOCUMENTATION'
  return 'WORKFLOW_UPDATE'
}

function collectAffectedComponents(context: PlanContext): AffectedComponent[] {
  const { event, graph } = context
  const seen = new Set<string>()
  const result: AffectedComponent[] = []

  for (const capabilityKey of event.affectedCapabilityKeys) {
    if (!event.platformId) continue
    for (const component of graph.impactOfCapability(event.platformId, capabilityKey)) {
      push(component)
    }
  }
  for (const delta of event.deltas) {
    for (const capabilityKey of delta.capabilityKeys) {
      if (!event.platformId) continue
      for (const component of graph.impactOfCapability(event.platformId, capabilityKey)) push(component)
    }
  }
  if (result.length === 0 && event.platformId) {
    for (const component of graph.impactOfPlatform(event.platformId)) push(component)
  }

  function push(component: AffectedComponent): void {
    const key = `${component.kind}:${component.ref}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(component)
  }

  return result
}

function deltasPayload(deltas: ReadonlyArray<StateDelta>): JsonValue {
  return deltas.map((delta) => ({
    path: delta.path,
    before: delta.before ?? null,
    after: delta.after ?? null,
    category: delta.category,
    riskLevel: delta.riskLevel,
  }))
}

function action(
  id: string,
  type: ProposalAction['type'],
  target: string,
  payload: JsonValue,
  autonomyTier: AutonomyTier,
): ProposalAction {
  return { id, type, target, payload, autonomyTier }
}

function makeProposal(input: {
  event: PlanContext['event']
  kind: ProposalKind
  title: string
  rationale: string
  riskLevel: RiskLevel
  autonomyTier: AutonomyTier
  status: ChangeProposal['status']
  actions: ProposalAction[]
  testPlan: string[]
  affected: AffectedComponent[]
  clock: () => number
}): ChangeProposal {
  const createdAt = nowIso(input.clock)
  return {
    id: stableId('prop', input.event.id, input.kind, input.title),
    eventId: input.event.id,
    kind: input.kind,
    title: input.title,
    rationale: input.rationale,
    riskLevel: input.riskLevel,
    autonomyTier: input.autonomyTier,
    status: input.status,
    actions: input.actions,
    affectedComponents: input.affected,
    testPlan: input.testPlan,
    diffPreview: deltasPayload(
      input.event.deltas.map((delta) => ({
        path: delta.path,
        kind: delta.kind,
        before: delta.before,
        after: delta.after,
        category: delta.category,
        riskLevel: delta.riskLevel,
        capabilityKeys: delta.capabilityKeys,
        rationale: delta.rationale,
      })),
    ),
    createdAt,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    deployedAt: null,
    supersedesProposalId: null,
  }
}

export function newProposalId(): string {
  return newId('prop')
}
