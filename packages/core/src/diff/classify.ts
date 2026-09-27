import type { ChangeCategory, RiskLevel } from '../types/enums.js'
import type { JsonValue } from '../types/platform.js'
import type { StateDeltaLike } from './types.js'

export interface Classification {
  category: ChangeCategory
  riskLevel: RiskLevel
  capabilityKeys: string[]
  rationale: string
}

/**
 * Turns a raw path/value difference into a typed, risk-rated change.
 *
 * The classifier is intentionally rule based and explainable: every risk
 * decision carries a human-readable rationale, because §35 requires the product
 * to be able to answer "why did this change?".
 */
export function classifyDelta(delta: StateDeltaLike): Classification | null {
  const path = delta.path
  const [area, ...rest] = path.split('.')
  const leaf = rest.join('.').toLowerCase()
  const text = `${path} ${stringify(delta.before)} ${stringify(delta.after)}`.toLowerCase()

  if (area === 'capabilities') {
    const key = rest.join('.')
    if (delta.kind === 'REMOVED') {
      return {
        category: 'REMOVED_FEATURE',
        riskLevel: text.includes('api') ? 'CRITICAL' : 'HIGH',
        capabilityKeys: [key],
        rationale: `${key} is no longer listed as supported; actions relying on it must be withdrawn.`,
      }
    }
    const state = readCapabilityState(delta.after)
    if (state === 'REMOVED' || state === 'DEPRECATED') {
      return {
        category: 'API_DEPRECATION',
        riskLevel: text.includes('api') || text.includes('publish') ? 'CRITICAL' : 'HIGH',
        capabilityKeys: [key],
        rationale: `${key} moved to ${state}; publishing and UI must stop offering it.`,
      }
    }
    return {
      category: 'NEW_FEATURE',
      riskLevel: text.includes('api') || text.includes('publish') ? 'HIGH' : 'MEDIUM',
      capabilityKeys: [key],
      rationale:
        delta.kind === 'ADDED'
          ? `${key} is newly supported and can be offered to creators.`
          : `${key} support changed and needs re-verification.`,
    }
  }

  if (area === 'limits') {
    return {
      category: limitCategory(leaf),
      riskLevel: riskForLimit(delta),
      capabilityKeys: [],
      rationale: `A published limit changed (${leaf}); content that used to pass validation may now fail.`,
    }
  }

  if (area === 'mediaSpecs') {
    const category: ChangeCategory = /video|mp4|mov|resolution|fps/.test(leaf)
      ? 'VIDEO_SPEC'
      : /image|photo|jpeg|png|webp/.test(leaf)
        ? 'IMAGE_SPEC'
        : 'VIDEO_SPEC'
    return {
      category,
      riskLevel: 'HIGH',
      capabilityKeys: ['VIDEO_MEDIA'],
      rationale: `Media requirements changed (${leaf}); the editor and validator need new limits.`,
    }
  }

  if (area === 'api') {
    const deprecated = /(deprecat|remov|retire|sunset|end.of.life)/.test(text)
    const authRelated = /(auth|oauth|token|scope|permission|credential|verif)/.test(text)
    return {
      category: deprecated ? 'API_DEPRECATION' : 'API_CHANGE',
      riskLevel: deprecated ? 'CRITICAL' : 'HIGH',
      capabilityKeys: deprecated ? ['API_PUBLISH', 'API_ANALYTICS'] : ['API_PUBLISH'],
      rationale: deprecated
        ? `A published API behaviour is being withdrawn${authRelated ? ', and it affects authentication and permissions' : ''}; integrations can break without warning.`
        : 'API surface changed; the publishing adapter and its tests must be reviewed.',
    }
  }

  if (area === 'analytics') {
    return {
      category: 'ANALYTICS_CHANGE',
      riskLevel: 'MEDIUM',
      capabilityKeys: ['ANALYTICS'],
      rationale: 'Available metrics changed; reporting and dashboards may show gaps.',
    }
  }

  if (area === 'monetization') {
    return {
      category: 'MONETIZATION_CHANGE',
      riskLevel: /payout|revenue|fund|threshold/.test(text) ? 'HIGH' : 'MEDIUM',
      capabilityKeys: ['CREATOR_FUNDING'],
      rationale: 'Monetization terms changed; earnings guidance given to creators must be corrected.',
    }
  }

  if (area === 'requirements') {
    const verification = /(verif|identity|government|kyc|document)/.test(text)
    return {
      category: verification ? 'VERIFICATION_REQUIREMENT' : 'ACCOUNT_REQUIREMENT',
      riskLevel: 'HIGH',
      capabilityKeys: [],
      rationale: verification
        ? 'Account verification requirements changed; sign-up and eligibility copy must be updated.'
        : 'Account requirements changed; the platform can become unusable for some creators.',
    }
  }

  if (area === 'publishing') {
    const scheduling = /schedule/.test(text)
    return {
      category: scheduling ? 'SCHEDULING_CHANGE' : 'PUBLISHING_METHOD',
      riskLevel: 'MEDIUM',
      capabilityKeys: scheduling ? ['SCHEDULING'] : [],
      rationale: 'How content reaches the audience changed; the composer flow may need adjusting.',
    }
  }

  if (area === 'policies') {
    return {
      category: /hashtag/.test(text) ? 'HASHTAG_BEHAVIOR' : 'POLICY_CHANGE',
      riskLevel: /ban|suspend|monetiz|restricted/.test(text) ? 'HIGH' : 'MEDIUM',
      capabilityKeys: [],
      rationale: 'A platform policy changed; guidance and automation must respect the new rule.',
    }
  }

  if (area === 'notes') {
    return {
      category: 'DOCUMENTATION_CHANGE',
      riskLevel: 'LOW',
      capabilityKeys: [],
      rationale: 'Reference notes were refreshed; knowledge stays accurate with no product change.',
    }
  }

  return {
    category: 'UNKNOWN',
    riskLevel: 'LOW',
    capabilityKeys: [],
    rationale: 'Unrecognised observation changed; kept for the record and reviewed by an admin.',
  }
}

function limitCategory(leaf: string): ChangeCategory {
  if (/character/.test(leaf)) return 'CHARACTER_LIMIT'
  if (/file|size|megabyte|gigabyte|\bmb\b|\bgb\b/.test(leaf)) return 'FILE_SIZE_LIMIT'
  if (/hashtag/.test(leaf)) return 'HASHTAG_BEHAVIOR'
  return 'CONTENT_LIMIT'
}

function riskForLimit(delta: StateDeltaLike): RiskLevel {
  const before = toNumber(delta.before)
  const after = toNumber(delta.after)
  if (before !== null && after !== null) return after < before ? 'HIGH' : 'MEDIUM'
  return /(hard|ban|suspend|restrict|remov)/.test(stringify(delta.after).toLowerCase()) ? 'HIGH' : 'MEDIUM'
}

function readCapabilityState(value: JsonValue | undefined): string | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const state = (value as Record<string, JsonValue>).state
    if (typeof state === 'string') return state.toUpperCase()
  }
  if (typeof value === 'string') return value.toUpperCase()
  return null
}

function toNumber(value: JsonValue | undefined): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const match = /-?\d+(\.\d+)?/.exec(value)
    if (match) return Number(match[0])
  }
  return null
}

function stringify(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
