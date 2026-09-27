import type { ChangeCategory, RiskLevel } from './enums.js'

/**
 * §28: impact is computed per creator, from what they actually use.
 * The product learns preferences from behaviour, but every learned preference
 * is inspectable and resettable (§31).
 */
export interface CreatorProfile {
  id: string
  displayName: string
  platformSlugs: string[]
  contentTypes: string[]
  usedCapabilityKeys: string[]
  goals: string[]
  locales: string[]
  createdAt: string
}

export interface LearnedPreference {
  id: string
  creatorId: string
  key: string
  value: string
  /** Why the system believes this, shown in the "why am I seeing this?" view. */
  evidence: string[]
  confidence: number
  learnedAt: string
  occurrences: number
  enabled: boolean
}

export interface CreatorImpact {
  id: string
  creatorId: string
  eventId: string
  platformSlug: string
  level: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'
  score: number
  reasons: string[]
  recommendedActions: string[]
  notifiedAt: string | null
  dismissedAt: string | null
}

export interface ImpactSignal {
  category: ChangeCategory
  riskLevel: RiskLevel
  platformSlug: string
  affectedCapabilityKeys: string[]
  title: string
}

export interface CreatorNotification {
  id: string
  creatorId: string
  eventId: string
  title: string
  body: string
  sourceIds: string[]
  createdAt: string
  readAt: string | null
  actions: string[]
}
