/**
 * Closed vocabularies for the Creator Mall intelligence layer.
 *
 * Every list here is *open for extension at runtime* (the registries accept new
 * members), but the constants below define the vocabulary the engine reasons
 * with today. Nothing in the system branches on a platform name.
 */

export const SOURCE_TYPES = [
  'OFFICIAL',
  'DOCUMENTATION',
  'DEVELOPER',
  'NEWS',
  'RESEARCH',
  'COMMUNITY',
  'RSS',
  'API',
] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** Evidence strength assigned to a claim (§3: never treat a rumor as a fact). */
export const TRUST_LEVELS = [
  'OFFICIAL',
  'VERIFIED',
  'REPORTED',
  'COMMUNITY_SIGNAL',
  'UNCONFIRMED',
  'RUMOR',
] as const
export type TrustLevel = (typeof TRUST_LEVELS)[number]

export const PLATFORM_STATUSES = [
  'DISCOVERED',
  'ANNOUNCED',
  'BETA',
  'COMING_SOON',
  'ACTIVE',
  'EMERGING',
  'REGIONAL',
  'SUNSET',
] as const
export type PlatformStatus = (typeof PLATFORM_STATUSES)[number]

export const PLATFORM_KINDS = [
  'MAINSTREAM',
  'REGIONAL',
  'EMERGING',
  'PROFESSIONAL',
  'COMMUNITY',
  'DECENTRALIZED',
  'MESSAGING',
  'VIDEO',
  'CREATOR_NATIVE',
  'UNKNOWN',
] as const
export type PlatformKind = (typeof PLATFORM_KINDS)[number]

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export const CAPABILITY_STATES = ['ACTIVE', 'DEPRECATED', 'REMOVED', 'PROPOSED', 'UNKNOWN'] as const
export type CapabilityState = (typeof CAPABILITY_STATES)[number]

/** Capability families used for UI grouping, adapters and impact scoring. */
export const CAPABILITY_DOMAINS = [
  'CONTENT',
  'PUBLISHING',
  'ANALYTICS',
  'ENGAGEMENT',
  'MONETIZATION',
  'DISTRIBUTION',
  'CREATOR_TOOLS',
] as const
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number]

/**
 * Change taxonomy (§2 "Platform changes" + "Creator ecosystem").
 * Detection never invents a category: unknown shapes fall back to `UNKNOWN`.
 */
export const CHANGE_CATEGORIES = [
  'NEW_FEATURE',
  'REMOVED_FEATURE',
  'CONTENT_FORMAT',
  'PUBLISHING_METHOD',
  'API_CHANGE',
  'API_DEPRECATION',
  'ANALYTICS_CHANGE',
  'MONETIZATION_CHANGE',
  'CREATOR_PROGRAM',
  'ALGORITHM_CHANGE',
  'DOCUMENTATION_CHANGE',
  'CONTENT_LIMIT',
  'FILE_SIZE_LIMIT',
  'VIDEO_SPEC',
  'IMAGE_SPEC',
  'CHARACTER_LIMIT',
  'HASHTAG_BEHAVIOR',
  'SCHEDULING_CHANGE',
  'COLLABORATION_CHANGE',
  'COMMENT_CHANGE',
  'MESSAGING_CHANGE',
  'ACCOUNT_REQUIREMENT',
  'VERIFICATION_REQUIREMENT',
  'POLICY_CHANGE',
  'CREATOR_TREND',
  'TOOL_ECOSYSTEM',
  'NEW_PLATFORM',
  'UNKNOWN',
] as const
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number]

export const EVENT_TYPES = [
  'NEW_CAPABILITY_DETECTED',
  'CAPABILITY_DEPRECATED',
  'LIMIT_CHANGED',
  'SPEC_CHANGED',
  'POLICY_CHANGED',
  'API_DEPRECATED',
  'MONETIZATION_CHANGED',
  'ANALYTICS_CHANGED',
  'NEW_PLATFORM_DISCOVERED',
  'PLATFORM_STATUS_CHANGED',
  'SOURCE_UNAVAILABLE',
  'SOURCE_RECOVERED',
  'KNOWLEDGE_STALE',
  'KNOWLEDGE_REFRESHED',
  'TREND_SIGNAL',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** §11 / §48: what the system may do on its own, and what needs a human. */
export const AUTONOMY_TIERS = ['AUTOMATIC', 'CONTROLLED'] as const
export type AutonomyTier = (typeof AUTONOMY_TIERS)[number]

export const PROPOSAL_KINDS = [
  'KNOWLEDGE_UPDATE',
  'CAPABILITY_REGISTRATION',
  'CAPABILITY_DEPRECATION',
  'PROMPT_VERSION',
  'TEMPLATE_SET',
  'UI_CONFIG',
  'WORKFLOW_UPDATE',
  'INTEGRATION_TASK',
  'DOCUMENTATION',
  'DATABASE_MIGRATION',
  'SECURITY_REVIEW',
  'DEPLOYMENT',
] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

export const PROPOSAL_STATUSES = [
  'DRAFT',
  'AUTO_APPROVED',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'STAGED',
  'DEPLOYED',
  'FAILED',
  'SUPERSEDED',
] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export const EVENT_STATUSES = ['DETECTED', 'VERIFIED', 'REJECTED', 'SUPERSEDED', 'APPLIED'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export const KNOWLEDGE_STATUSES = ['DRAFT', 'CURRENT', 'SUPERSEDED', 'EXPIRED', 'RETRACTED'] as const
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

/** §15: facts decay at different speeds. */
export const TTL_POLICIES = [
  'API_INFO',
  'PLATFORM_LIMIT',
  'PLATFORM_POLICY',
  'PLATFORM_GENERAL',
  'TREND_SIGNAL',
  'HISTORICAL',
] as const
export type TtlPolicy = (typeof TTL_POLICIES)[number]

export const READINESS_STATES = ['READY', 'PARTIAL', 'BLOCKED', 'NOT_YET'] as const
export type ReadinessState = (typeof READINESS_STATES)[number]

export const IMPACT_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const
export type ImpactLevel = (typeof IMPACT_LEVELS)[number]

export const DEPENDENCY_KINDS = [
  'PLATFORM',
  'CAPABILITY',
  'CONTENT_TYPE',
  'AI_PROMPT',
  'TEMPLATE',
  'EDITOR',
  'PUBLISHER',
  'ANALYTICS',
  'DOCUMENTATION',
  'WORKFLOW',
  'UI_COMPONENT',
] as const
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number]

export const HEALTH_STATUSES = ['HEALTHY', 'DEGRADED', 'STALE', 'FAILING', 'UNKNOWN'] as const
export type HealthStatus = (typeof HEALTH_STATUSES)[number]

export const SYSTEM_COMPONENTS = [
  'SOURCE_AVAILABILITY',
  'PLATFORM_KNOWLEDGE_FRESHNESS',
  'RESEARCH_JOBS',
  'PUBLISHING_INTEGRATIONS',
  'AI_PROVIDERS',
  'TEMPLATE_GENERATION',
  'KNOWLEDGE_INDEXING',
  'EMBEDDING_JOBS',
  'ANALYTICS_SYNC',
] as const
export type SystemComponent = (typeof SYSTEM_COMPONENTS)[number]

export function isRiskLevel(value: string): value is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(value)
}

export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level)
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b
}
