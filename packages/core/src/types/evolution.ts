import type {
  AutonomyTier,
  ChangeCategory,
  DependencyKind,
  EventStatus,
  EventType,
  ProposalKind,
  ProposalStatus,
  RiskLevel,
  TrustLevel,
} from './enums.js'
import type { JsonValue } from './platform.js'

/** One structural difference between two snapshots (§6). */
export interface StateDelta {
  path: string
  kind: 'ADDED' | 'REMOVED' | 'CHANGED'
  before: JsonValue | undefined
  after: JsonValue | undefined
  category: ChangeCategory
  riskLevel: RiskLevel
  /** Capability keys implicated by this delta. */
  capabilityKeys: string[]
  /** Why the engine assigned this risk, in plain language. */
  rationale: string
}

export interface SnapshotDiff {
  platformId: string
  previousSnapshotId: string | null
  currentSnapshotId: string
  deltas: StateDelta[]
  addedPaths: string[]
  removedPaths: string[]
  changedPaths: string[]
  highestRisk: RiskLevel
}

/** §36: the internal change log. One event per meaningful ecosystem change. */
export interface EvolutionEvent {
  id: string
  platformId: string | null
  platformName?: string
  eventType: EventType
  category: ChangeCategory
  title: string
  /** Creator-facing summary (no jargon, §43). */
  creatorSummary: string
  detectedAt: string
  verifiedAt: string | null
  sourceIds: string[]
  trustLevel: TrustLevel
  confidence: number
  previousState: JsonValue | null
  newState: JsonValue | null
  deltas: StateDelta[]
  impact: string
  affectedCapabilityKeys: string[]
  affectedComponents: AffectedComponent[]
  riskLevel: RiskLevel
  status: EventStatus
  approvedBy: string | null
  deployedAt: string | null
  /** Why the system believes this change happened at all. */
  evidence: string[]
}

export interface AffectedComponent {
  kind: DependencyKind
  ref: string
  relation: 'REQUIRES' | 'GENERATES' | 'VALIDATES' | 'CONSUMES' | 'SUPERSEDES'
  depth: number
}

export interface DependencyNode {
  kind: DependencyKind
  ref: string
  label: string
}

export interface DependencyEdge {
  from: DependencyNode
  to: DependencyNode
  relation: 'REQUIRES' | 'GENERATES' | 'VALIDATES' | 'CONSUMES' | 'SUPERSEDES'
}

/** §11 + §33: the only way the system changes itself. */
export interface ChangeProposal {
  id: string
  eventId: string | null
  kind: ProposalKind
  title: string
  rationale: string
  riskLevel: RiskLevel
  autonomyTier: AutonomyTier
  status: ProposalStatus
  /** Concrete machine-checkable steps an operator or CI job can execute. */
  actions: ProposalAction[]
  affectedComponents: AffectedComponent[]
  testPlan: string[]
  diffPreview: JsonValue | null
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  decisionNote: string | null
  deployedAt: string | null
  supersedesProposalId: string | null
}

export interface ProposalAction {
  id: string
  type:
    | 'UPSERT_KNOWLEDGE'
    | 'REGISTER_CAPABILITY'
    | 'DEPRECATE_CAPABILITY'
    | 'BUMP_PROMPT_VERSION'
    | 'GENERATE_TEMPLATES'
    | 'UPDATE_UI_CONFIG'
    | 'CREATE_INTEGRATION_TASK'
    | 'WRITE_DOCUMENTATION'
    | 'PROPOSE_MIGRATION'
    | 'SECURITY_REVIEW'
    | 'PAUSE_WORKFLOW'
    | 'ALERT_ADMIN'
    | 'STAGE_CHANGESET'
  target: string
  payload: JsonValue
  /** AUTO / CONTROLLED per action; the strictest action wins for the proposal. */
  autonomyTier: AutonomyTier
}

export interface PromptVersion {
  id: string
  promptKey: string
  platformId: string | null
  version: number
  body: string
  variables: string[]
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'RETIRED'
  createdAt: string
  activatedAt: string | null
  createdBy: 'WORLD_ENGINE' | 'ADMIN' | 'SEED'
  changeNote: string
  basedOnEventId: string | null
  evaluationScore: number | null
}

export interface TemplateDefinition {
  id: string
  platformId: string
  capabilityKey: string
  name: string
  structure: string
  hook: string | null
  cta: string | null
  status: 'PROPOSED' | 'APPROVED' | 'ACTIVE' | 'RETIRED'
  createdBy: 'WORLD_ENGINE' | 'ADMIN' | 'SEED'
  createdAt: string
  basedOnEventId: string | null
}

export interface TestOutcome {
  id: string
  proposalId: string
  suite: string
  status: 'PASSED' | 'FAILED' | 'SKIPPED'
  message: string
  ranAt: string
}
