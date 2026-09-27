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

/**
 * A preference the system believes, with the evidence that produced it.
 *
 * Every field here exists so the creator can answer "why am I seeing this?",
 * forget one preference, or reset all of them (§31). Nothing learned here ever
 * changes what is published or grants access.
 */
export interface LearnedPreference {
  id: string
  creatorId: string
  key: string
  value: string
  /** Creator-facing name, e.g. "Opening line style". */
  label: string
  description: string
  /** The behaviour that led here, in plain language. */
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
