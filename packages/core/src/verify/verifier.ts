import type { ExtractedFact } from '../extract/contract.js'
import type { TrustLevel } from '../types/enums.js'
import type { Source } from '../types/source.js'
import { assessSources } from './trust.js'

export type ClaimStatus = 'ACCEPTED' | 'WATCH' | 'REJECTED'

export interface VerifiedClaim {
  key: string
  path: string
  statement: string
  value: ExtractedFact['value']
  category: ExtractedFact['category']
  trustLevel: TrustLevel
  confidence: number
  sourceIds: string[]
  evidence: string[]
  status: ClaimStatus
  rationale: string
  capabilityKeys: string[]
  /** True when the wording itself is hearsay, regardless of source quality. */
  rumour: boolean
}

const RUMOUR_WORDS =
  /\b(rumou?r(?:ed|s)?|allegedly|reportedly|supposedly|leak(?:ed)?|sources say|we hear|unconfirmed|may be|expected to|reported to be|is said to)\b/i

/** Words that turn an otherwise official sentence into a signal, not a fact. */
export function detectRumour(text: string): boolean {
  return RUMOUR_WORDS.test(text)
}

export interface VerifyOptions {
  /** Trust levels that may be written into current knowledge. */
  publishable?: TrustLevel[]
  /** Keep unconfirmed claims in the event log (never in knowledge). */
  retainSignals?: boolean
}

/**
 * §3: the verification gate. Facts are grouped by claim key, judged by the
 * quality and independence of the sources behind them, and only accepted claims
 * are allowed to become platform knowledge.
 */
export function verifyFacts(
  facts: ReadonlyArray<ExtractedFact>,
  sources: ReadonlyArray<Source>,
  options: VerifyOptions = {},
): VerifiedClaim[] {
  const publishable = new Set<TrustLevel>(options.publishable ?? ['OFFICIAL', 'VERIFIED'])
  const retainSignals = options.retainSignals ?? true
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const groups = new Map<string, ExtractedFact[]>()

  for (const fact of facts) {
    const bucket = groups.get(fact.key)
    if (bucket) bucket.push(fact)
    else groups.set(fact.key, [fact])
  }

  const claims: VerifiedClaim[] = []
  for (const [key, group] of groups) {
    const backingSources = [...new Set(group.map((fact) => fact.sourceId))]
      .map((id) => sourceById.get(id))
      .filter((source): source is Source => Boolean(source))

    const assessment = assessSources(backingSources)
    const rumour = group.some((fact) => detectRumour(fact.evidence))
    const trustLevel: TrustLevel = rumour ? 'RUMOR' : assessment.trustLevel
    const confidence = rumour ? Math.min(assessment.confidence, 0.2) : assessment.confidence

    let status: ClaimStatus
    let rationale: string
    if (!publishable.has(trustLevel)) {
      status = 'REJECTED'
      rationale = rumour
        ? 'Wording is hearsay, so this stays a signal until an official source confirms it.'
        : `Trust level ${trustLevel} is below the publishing bar; recorded as a signal only.`
    } else if (confidence < 0.5) {
      status = 'WATCH'
      rationale = 'Accepted provisionally; a second source would raise confidence.'
    } else {
      status = 'ACCEPTED'
      rationale = assessment.rationale
    }

    if (status === 'REJECTED' && !retainSignals) continue

    const strongest = group.reduce((best, fact) => (fact.confidence > best.confidence ? fact : best), group[0]!)
    claims.push({
      key,
      path: strongest.path,
      statement: strongest.statement,
      value: strongest.value,
      category: strongest.category,
      trustLevel,
      confidence,
      sourceIds: backingSources.map((source) => source.id),
      evidence: [...new Set(group.map((fact) => fact.evidence))].slice(0, 5),
      status,
      rationale,
      capabilityKeys: [...new Set(group.flatMap((fact) => fact.capabilityKeys))],
      rumour,
    })
  }

  return claims.sort((a, b) => b.confidence - a.confidence || (a.key < b.key ? -1 : 1))
}

/** §34: capability removals must never be published on weak evidence. */
export function deprecationsRequireOfficialEvidence(claims: ReadonlyArray<VerifiedClaim>): boolean {
  return claims.some((claim) => claim.category === 'API_DEPRECATION' && claim.trustLevel !== 'OFFICIAL')
}
