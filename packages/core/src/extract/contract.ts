import type { ChangeCategory } from '../types/enums.js'
import type { JsonValue } from '../types/platform.js'
import type { CapabilityRegistry } from '../capabilities/registry.js'

/**
 * A candidate claim extracted from a page. Extraction is pluggable: the shipped
 * default is deterministic and offline, and a model-backed extractor implements
 * the same contract (§48 controlled autonomy).
 */
export interface ExtractedFact {
  /** Stable claim key, e.g. "instagram:limits.video.maxDurationSeconds". */
  key: string
  statement: string
  value: JsonValue
  path: string
  category: ChangeCategory
  evidence: string
  confidence: number
  capabilityKeys: string[]
  /** The source this observation came from; verification groups by source. */
  sourceId: string
}

export interface FactExtractor {
  readonly name: string
  extract(input: ExtractInput): Promise<ExtractedFact[]>
}

export interface ExtractInput {
  platformId: string
  platformName: string
  text: string
  sourceId: string
  capabilityRegistry: CapabilityRegistry
}

/** One deterministic limit rule, used by the heuristic extractor. */
export interface Rule {
  path: string
  category: ChangeCategory
  patterns: RegExp[]
  value: (match: RegExpExecArray) => number
  statement: (value: number) => string
  capabilityKeys?: string[]
  /** Human phrasing per value, for the fact statement. */
  unit?: string
}
