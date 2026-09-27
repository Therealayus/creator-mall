import type { ChangeCategory, RiskLevel } from '../types/enums.js'
import type { StateDelta } from '../types/evolution.js'
import type { JsonValue } from '../types/platform.js'

/** A difference between two snapshots before it has been interpreted. */
export interface StateDeltaLike {
  path: string
  kind: 'ADDED' | 'REMOVED' | 'CHANGED'
  before: JsonValue | undefined
  after: JsonValue | undefined
}

/** A difference after classification: category, risk and affected capabilities. */
export type ClassifiedDelta = StateDelta

export type { ChangeCategory, RiskLevel, StateDelta }
