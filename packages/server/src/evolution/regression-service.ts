import {
  attachReport,
  buildRegressionCases,
  decideActivation,
  promptRiskFor,
  runRegression,
} from '@creator-mall/core'
import type { ActivationDecision, RegressionCase, RegressionReport } from '@creator-mall/core'
import type { AppContext } from '../context.js'

/**
 * Evaluating a drafted prompt, and deciding whether it may go live.
 *
 * The service is deliberately thin: `runRegression` decides pass or fail, and
 * `decideActivation` decides whether that result is enough. What lives here is
 * only the wiring: turning a verified change into checks, running them with
 * whatever generator is configured, and refusing to activate without evidence.
 */

export interface EvaluationResult {
  report: RegressionReport
  riskLevel: string
  /** Whether the version could be activated right now, and why not. */
  activation: ActivationDecision
  cases: RegressionCase[]
}

export async function evaluatePromptVersion(
  context: AppContext,
  promptKey: string,
  versionNumber: number,
): Promise<EvaluationResult | null> {
  const version = context.control.prompts.get(promptKey, versionNumber)
  if (!version) return null

  const event = version.basedOnEventId ? context.control.getEvent(version.basedOnEventId) : undefined
  const capabilityKey = promptKey.split(':')[1] ?? ''
  const capability = context.control.capabilities.get(capabilityKey)
  const riskLevel = event ? promptRiskFor(event.category, event.riskLevel) : 'MEDIUM'
  const label = capability?.label ?? (capabilityKey === '' ? 'Post' : capabilityKey)

  const limits = verifiedLimitsFor(context, version.platformId)
  const cases = buildRegressionCases({
    brief: `Write a post about ${label}.`,
    limits,
    requirements: requirementsFrom(event),
    capabilityLabel: label,
  })

  // No model configured means every case skips, and the report comes back
  // NEEDS_REVIEW. That is the point: a deterministic renderer is not evidence
  // that a prompt is any good.
  const report = await runRegression({
    promptKey,
    version: versionNumber,
    promptBody: version.body,
    cases,
    complete: context.modelClient
      ? (input) => context.modelClient!.complete(input)
      : null,
    clock: Date.now,
  })
  attachReport(version, report)

  const activation = decideActivation({ version, report, riskLevel })
  rememberReport(context, report)
  return { report, riskLevel, activation, cases }
}

export function activatePromptVersion(
  context: AppContext,
  promptKey: string,
  versionNumber: number,
  options: { override?: boolean; decidedBy?: string } = {},
): { activation: ActivationDecision; report: RegressionReport | null; version: ReturnType<AppContext['control']['prompts']['get']> } {
  const version = context.control.prompts.get(promptKey, versionNumber)
  const stored = lastReportFor(context, promptKey, versionNumber)
  const event = version?.basedOnEventId ? context.control.getEvent(version.basedOnEventId) : undefined
  const riskLevel = event ? promptRiskFor(event.category, event.riskLevel) : 'MEDIUM'

  const activation = decideActivation({ version, report: stored, riskLevel, override: options.override })
  if (!activation.allowed || !version) return { activation, report: stored, version }

  const activated = context.control.prompts.activate(promptKey, versionNumber)
  return { activation, report: stored, version: activated }
}

/** The most recent report for a version, kept in memory by this service. */
const reports = new WeakMap<object, Map<string, RegressionReport>>()

function reportKey(promptKey: string, version: number): string {
  return `${promptKey}@${version}`
}

export function rememberReport(context: AppContext, report: RegressionReport): void {
  let forContext = reports.get(context.control)
  if (!forContext) {
    forContext = new Map()
    reports.set(context.control, forContext)
  }
  forContext.set(reportKey(report.promptKey, report.version), report)
}

function lastReportFor(context: AppContext, promptKey: string, version: number): RegressionReport | null {
  return reports.get(context.control)?.get(reportKey(promptKey, version)) ?? null
}

/** Verified numeric limits, in the shape the case builder expects. */
function verifiedLimitsFor(
  context: AppContext,
  platformId: string | null,
): Array<{ label: string; value: number; unit: string }> {
  if (!platformId) return []
  const state = context.control.latestSnapshot(platformId)?.state
  const limits = (state?.limits ?? {}) as Record<string, unknown>
  const found: Array<{ label: string; value: number; unit: string }> = []

  for (const [group, values] of Object.entries(limits)) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) continue
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value !== 'number') continue
      const label = `${group} ${key}`
      if (/char/i.test(key) || /char/i.test(label)) {
        found.push({ label, value, unit: 'characters' })
        continue
      }
      found.push({ label, value, unit: /duration|seconds|maxLength/i.test(key) ? 'seconds' : 'count' })
    }
  }
  return found
}

function requirementsFrom(event: ReturnType<AppContext['control']['getEvent']>): string[] {
  if (!event) return []
  const requirements: string[] = []
  for (const delta of event.deltas) {
    if (delta.kind === 'REMOVED') {
      requirements.push(`Never mention ${delta.path}.`)
      continue
    }
    if (delta.after === null || delta.after === undefined) continue
    requirements.push(`Adapt to the change at ${delta.path}: it is now ${JSON.stringify(delta.after)}.`)
  }
  return requirements
}
