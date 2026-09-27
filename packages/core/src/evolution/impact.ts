import type { CreatorImpact, CreatorNotification, CreatorProfile, ImpactSignal } from '../types/creator.js'
import type { ChangeCategory, RiskLevel } from '../types/enums.js'
import { clamp, stableId } from '../util.js'

/** Category weight: how much a change of this kind usually matters to a creator. */
const CATEGORY_WEIGHT: Record<ChangeCategory, number> = {
  NEW_FEATURE: 0.8,
  REMOVED_FEATURE: 0.9,
  CONTENT_FORMAT: 0.7,
  PUBLISHING_METHOD: 0.6,
  API_CHANGE: 0.5,
  API_DEPRECATION: 0.9,
  ANALYTICS_CHANGE: 0.4,
  MONETIZATION_CHANGE: 0.8,
  CREATOR_PROGRAM: 0.7,
  ALGORITHM_CHANGE: 0.6,
  DOCUMENTATION_CHANGE: 0.2,
  CONTENT_LIMIT: 0.9,
  FILE_SIZE_LIMIT: 0.7,
  VIDEO_SPEC: 0.8,
  IMAGE_SPEC: 0.6,
  CHARACTER_LIMIT: 0.5,
  HASHTAG_BEHAVIOR: 0.5,
  SCHEDULING_CHANGE: 0.5,
  COLLABORATION_CHANGE: 0.4,
  COMMENT_CHANGE: 0.4,
  MESSAGING_CHANGE: 0.4,
  ACCOUNT_REQUIREMENT: 0.9,
  VERIFICATION_REQUIREMENT: 0.9,
  POLICY_CHANGE: 0.7,
  CREATOR_TREND: 0.5,
  TOOL_ECOSYSTEM: 0.3,
  NEW_PLATFORM: 0.6,
  UNKNOWN: 0.3,
}

const RISK_WEIGHT: Record<RiskLevel, number> = { LOW: 0.2, MEDIUM: 0.5, HIGH: 0.8, CRITICAL: 1 }

/**
 * §28: "Does this matter to *this* creator?"
 *
 * A YouTube Shorts launch is HIGH for a video creator and LOW for a writer who
 * has never touched that platform. Impact is therefore computed per creator
 * from actual platform and capability usage, not broadcast globally.
 */
export function scoreCreatorImpact(profile: CreatorProfile, signal: ImpactSignal): CreatorImpact {
  const reasons: string[] = []
  let score = 0

  const usesPlatform = profile.platformSlugs.includes(signal.platformSlug)
  if (usesPlatform) {
    score += 0.35
    reasons.push(`You publish on ${signal.platformSlug}.`)
  } else {
    reasons.push(`You do not publish on ${signal.platformSlug}.`)
  }

  const overlapping = signal.affectedCapabilityKeys.filter((key) => profile.usedCapabilityKeys.includes(key))
  if (overlapping.length > 0) {
    score += Math.min(0.35, 0.18 * overlapping.length)
    reasons.push(`It affects ${overlapping.join(', ')}, which you use.`)
  }

  score += CATEGORY_WEIGHT[signal.category] * RISK_WEIGHT[signal.riskLevel] * 0.5
  score = clamp(score, 0, 1)

  const level = score >= 0.7 ? 'HIGH' : score >= 0.45 ? 'MEDIUM' : score >= 0.2 ? 'LOW' : 'NONE'

  return {
    id: stableId('imp', profile.id, signal.platformSlug, signal.category, ...signal.affectedCapabilityKeys),
    creatorId: profile.id,
    eventId: '',
    platformSlug: signal.platformSlug,
    level,
    score: Number(score.toFixed(3)),
    reasons,
    recommendedActions: recommendActions(level, signal),
    notifiedAt: null,
    dismissedAt: null,
  }
}

function recommendActions(level: CreatorImpact['level'], signal: ImpactSignal): string[] {
  if (level === 'NONE') return []
  const actions: string[] = []
  if (level === 'HIGH') {
    actions.push(`Review your ${signal.platformSlug} publishing setup.`)
    if (signal.affectedCapabilityKeys.length > 0) {
      actions.push(`Try the new ${signal.affectedCapabilityKeys[0]!.replace(/_/g, ' ').toLowerCase()} option.`)
    }
  } else if (level === 'MEDIUM') {
    actions.push(`Read what changed on ${signal.platformSlug}.`)
  } else {
    actions.push(`No action needed yet for ${signal.platformSlug}.`)
  }
  return actions
}

/** Only creators above the noise floor are notified (§29: do not spam). */
export function notifyThreshold(): number {
  return 0.45
}

export function impactToNotification(
  impact: CreatorImpact,
  event: { id: string; title: string; creatorSummary: string; sourceIds: string[] },
  createdAt: string,
): CreatorNotification {
  return {
    id: stableId('ntf', impact.creatorId, event.id),
    creatorId: impact.creatorId,
    eventId: event.id,
    title: event.title,
    body: event.creatorSummary,
    sourceIds: event.sourceIds,
    createdAt,
    readAt: null,
    actions: impact.recommendedActions,
  }
}

export function impactSummary(impacts: ReadonlyArray<CreatorImpact>): Record<string, number> {
  const summary: Record<string, number> = { NONE: 0, LOW: 0, MEDIUM: 0, HIGH: 0 }
  for (const impact of impacts) summary[impact.level] = (summary[impact.level] ?? 0) + 1
  return summary
}
