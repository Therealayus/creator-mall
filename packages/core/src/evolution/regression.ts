import type { PromptVersion } from '../types/evolution.js'
import type { RiskLevel } from '../types/enums.js'
import { nowIso, stableId } from '../util.js'

/**
 * The regression runner.
 *
 * Self-modification is only safe if something checks it. A drafted prompt is a
 * claim about how to write for a platform that has just changed, and the only
 * way to know whether the new version is any good is to run it and look.
 *
 * Three rules, in order of importance:
 *
 *   1. **a failed case rejects the draft** — there is no averaging a failure away;
 *   2. **a run that could not test anything never approves** — an unavailable or
 *      silent runner produces NEEDS_REVIEW, never SAFE;
 *   3. **an empty case set never approves** — "we tested nothing" is not a pass.
 *
 * The runner does not know what a good post is. It checks mechanical, provable
 * things: does the output respect the limits the platform documents, does it
 * echo the requirement it was given, does it avoid what it was told to avoid.
 */

export type CaseStatus = 'PASSED' | 'FAILED' | 'SKIPPED'

export interface RegressionCase {
  id: string
  /** Shown to an operator deciding whether to trust the run. */
  expectation: string
  brief: string
  mustInclude?: string[]
  mustNotInclude?: string[]
  /** A verified platform limit the output must fit inside. */
  maxCharacters?: number
  minCharacters?: number
}

export interface CaseResult {
  caseId: string
  expectation: string
  status: CaseStatus
  message: string
}

export type RegressionVerdict = 'SAFE' | 'NEEDS_REVIEW' | 'REJECT'

export interface RegressionReport {
  promptKey: string
  version: number
  cases: CaseResult[]
  passed: number
  failed: number
  skipped: number
  verdict: RegressionVerdict
  /** Why the verdict is what it is, in words an operator can act on. */
  reasons: string[]
  ranAt: string
}

/** Whatever actually produces text. The model client in production. */
export type CompletionFn = (input: { system: string; user: string; maxTokens: number }) => Promise<string>

export interface RunRegressionInput {
  promptKey: string
  version: number
  promptBody: string
  cases: RegressionCase[]
  complete: CompletionFn | null
  maxTokens?: number
  clock?: () => number
}

export const SYSTEM_PROMPT =
  'You write social posts for a creator. Follow the instructions exactly. Do not invent figures.'

/**
 * Runs every case against the drafted prompt.
 *
 * A case that cannot run is SKIPPED, never passed, and the verdict logic below
 * makes sure a run made entirely of skips cannot be mistaken for a good one.
 */
export async function runRegression(input: RunRegressionInput): Promise<RegressionReport> {
  const cases: CaseResult[] = []

  for (const testCase of input.cases) {
    if (!input.complete) {
      cases.push({
        caseId: testCase.id,
        expectation: testCase.expectation,
        status: 'SKIPPED',
        message: 'No generator is configured, so this could not be tested.',
      })
      continue
    }

    let output = ''
    try {
      output = await input.complete({
        system: `${SYSTEM_PROMPT}\n\n${input.promptBody}`,
        user: testCase.brief,
        maxTokens: input.maxTokens ?? 600,
      })
    } catch (error) {
      cases.push({
        caseId: testCase.id,
        expectation: testCase.expectation,
        status: 'SKIPPED',
        message: `The generator could not be reached: ${error instanceof Error ? error.message : 'unknown failure'}`,
      })
      continue
    }

    const problems = check(testCase, output)
    cases.push({
      caseId: testCase.id,
      expectation: testCase.expectation,
      status: problems.length === 0 ? 'PASSED' : 'FAILED',
      message: problems.length === 0 ? 'Met the expectation.' : problems.join(' '),
    })
  }

  return summarise(input, cases)
}

function check(testCase: RegressionCase, output: string): string[] {
  const problems: string[] = []
  const text = output.trim()

  if (text.length === 0) return ['produced nothing']

  for (const needle of testCase.mustInclude ?? []) {
    if (!text.toLowerCase().includes(needle.toLowerCase())) {
      problems.push(`expected it to mention "${needle}".`)
    }
  }
  for (const needle of testCase.mustNotInclude ?? []) {
    if (text.toLowerCase().includes(needle.toLowerCase())) {
      problems.push(`it should not have mentioned "${needle}".`)
    }
  }
  if (testCase.maxCharacters !== undefined && text.length > testCase.maxCharacters) {
    problems.push(`it came to ${text.length} characters, over the verified limit of ${testCase.maxCharacters}.`)
  }
  if (testCase.minCharacters !== undefined && text.length < testCase.minCharacters) {
    problems.push(`it came to ${text.length} characters, under the ${testCase.minCharacters} needed to be useful.`)
  }
  return problems
}

function summarise(input: RunRegressionInput, cases: CaseResult[]): RegressionReport {
  const passed = cases.filter((entry) => entry.status === 'PASSED').length
  const failed = cases.filter((entry) => entry.status === 'FAILED').length
  const skipped = cases.filter((entry) => entry.status === 'SKIPPED').length
  const reasons: string[] = []

  let verdict: RegressionVerdict
  if (cases.length === 0) {
    verdict = 'NEEDS_REVIEW'
    reasons.push('There was nothing to test, so nothing was proved.')
  } else if (failed > 0) {
    verdict = 'REJECT'
    reasons.push(`${failed} of ${cases.length} checks failed.`)
    for (const entry of cases.filter((c) => c.status === 'FAILED')) reasons.push(entry.message)
  } else if (skipped > 0) {
    verdict = 'NEEDS_REVIEW'
    reasons.push(`${skipped} of ${cases.length} checks could not run, so this is not a pass.`)
  } else {
    verdict = 'SAFE'
    reasons.push(`All ${cases.length} checks passed.`)
  }

  return {
    promptKey: input.promptKey,
    version: input.version,
    cases,
    passed,
    failed,
    skipped,
    verdict,
    reasons,
    ranAt: nowIso(input.clock ?? Date.now),
  }
}

/**
 * Builds the cases for a prompt from what the platform actually documents.
 *
 * Every case traces back to a verified limit or a stated requirement, so the
 * suite cannot drift into testing things nobody asked about.
 */
export function buildRegressionCases(input: {
  brief: string
  /** "Maximum length: 15 seconds" style hints, already verified. */
  limits: Array<{ label: string; value: number; unit: string }>
  requirements: string[]
  capabilityLabel: string
}): RegressionCase[] {
  const cases: RegressionCase[] = []

  for (const limit of input.limits) {
    if (limit.unit === 'characters' && limit.value > 0) {
      cases.push({
        id: stableId('case', input.brief, 'characters', String(limit.value)),
        expectation: `Fits inside the verified limit of ${limit.value} characters.`,
        brief: input.brief,
        maxCharacters: limit.value,
      })
      continue
    }
    if (limit.unit === 'characters' || limit.value <= 0) {
      cases.push({
        id: stableId('case', input.brief, 'length', limit.label),
        expectation: `Is a real post, not a stub, for ${input.capabilityLabel}.`,
        brief: input.brief,
        minCharacters: 40,
      })
    }
  }

  for (const requirement of input.requirements) {
    const forbidden = forbiddenTerm(requirement)
    // A requirement that names something to avoid gets mustNotInclude. A
    // requirement that states a new fact gets mustInclude, so the runner
    // actually asserts the requirement rather than only counting characters —
    // otherwise "always answer in French" or "invent statistics" would pass and
    // a draft built on it would be allowed to go live.
    const required = requiredTerm(requirement)
    cases.push({
      id: stableId('case', input.brief, 'requirement', requirement),
      expectation: `Handles the new requirement: ${requirement}`,
      brief: input.brief,
      ...(forbidden ? { mustNotInclude: [forbidden] } : {}),
      ...(required ? { mustInclude: [required] } : {}),
      // And it still has to be a real post. Without this a case could assert
      // nothing at all, and a case that asserts nothing always passes.
      minCharacters: 40,
    })
  }

  if (cases.length === 0) {
    // Never an empty suite: a bare "did it write something" check is the floor.
    cases.push({
      id: stableId('case', input.brief, 'floor'),
      expectation: 'Produces a real post rather than a stub.',
      brief: input.brief,
      minCharacters: 40,
    })
  }

  return cases
}

/**
 * The thing a requirement forbids, if it forbids one.
 *
 * "Never invent earnings figures", "Do not mention the old format" and
 * "Never mention limits.video.maxDurationSeconds" all name something. The
 * previous pattern only matched "invent/make up/fabricate", so every real
 * requirement produced an empty constraint and the case degraded to a length
 * check.
 */
export function forbiddenTerm(requirement: string): string | null {
  const match =
    /\b(?:never|do not|don't|avoid)\s+(?:invent(?:ing|ed)?|making up|fabricat(?:e|ing)|mention(?:ing)?|stat(?:ing|e)|guess(?:ing)?)\s+([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+){0,2})/i.exec(
      requirement,
    )
  return cleanTerm(match?.[1] ?? null)
}

/**
 * The thing a requirement introduces, if it states one.
 *
 * "Adapt to the change at limits.video.maxDurationSeconds: it is now 15" has to
 * produce output that mentions 15, otherwise nothing verifies that the draft
 * actually adopted the new requirement.
 */
export function requiredTerm(requirement: string): string | null {
  if (/\b(?:never|do not|don't|avoid)\b/i.test(requirement)) return null
  const stated = /(?:is now|now|becomes|changed to|set to)\s+([0-9][0-9.,_]*\s*[a-z%]*)/i.exec(requirement)
  if (stated) return cleanTerm(stated[1] ?? null)
  const path = /at\s+([a-z0-9_.]+)/i.exec(requirement)
  if (!path) return null
  // "limits.video.maxDurationSeconds" -> "duration", the human part of the name.
  const leaf = (path[1] ?? '').split('.').pop() ?? ''
  const words = leaf.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\s]+/).filter(Boolean)
  return cleanTerm(words.join(' '))
}

function cleanTerm(value: string | null): string | null {
  if (!value) return null
  // Cut at the first dot that ends a sentence. A dot inside an identifier is
  // kept, so "limits.video.maxDurationSeconds." survives whole while
  // "earnings figures. Only state..." stops at "earnings figures".
  const firstSentence = value.split(/\.(?:\s|$)/)[0] ?? value
  const trimmed = firstSentence.trim().replace(/^["'`]|["'`]$/g, '').replace(/[.,;]+$/, '')
  if (trimmed.length < 2) return null
  return trimmed
}

/** Records a run against the prompt version it tested. */
export function attachReport(version: PromptVersion, report: RegressionReport): PromptVersion {
  version.evaluationScore = report.failed === 0 && report.skipped === 0 && report.passed > 0 ? 1 : 0
  return version
}

export type ActivationRefusal =
  | 'NOT_FOUND'
  | 'NOT_A_DRAFT'
  | 'NEVER_EVALUATED'
  | 'FAILED'
  | 'INCOMPLETE'
  | 'CRITICAL_RISK'

export interface ActivationDecision {
  allowed: boolean
  refusal: ActivationRefusal | null
  /** Why activation was refused, in words an operator can act on. */
  reason: string
  /** True only when a person deliberately overrode a refusal. */
  overridden: boolean
}

/**
 * Whether a prompt version may go live.
 *
 * A version that has never been tested, failed its tests, or could not be
 * tested is refused. So is anything touching a CRITICAL risk change, which no
 * run of a prompt can earn back — that one needs a person, every time.
 *
 * An override is permitted, because a person may know something a test cannot,
 * but it must be explicit and is reported back as an override rather than a
 * pass.
 */
export function decideActivation(input: {
  version: PromptVersion | undefined
  report: RegressionReport | null
  riskLevel: RiskLevel
  override?: boolean
}): ActivationDecision {
  const { version, report, riskLevel, override } = input
  const refuse = (refusal: ActivationRefusal, reason: string): ActivationDecision =>
    override
      ? { allowed: true, refusal, reason, overridden: true }
      : { allowed: false, refusal, reason, overridden: false }

  if (!version) return { allowed: false, refusal: 'NOT_FOUND', reason: 'There is no such prompt version.', overridden: false }
  if (version.status !== 'DRAFT') {
    return { allowed: false, refusal: 'NOT_A_DRAFT', reason: 'Only a draft can be activated.', overridden: false }
  }
  if (!report) {
    return refuse('NEVER_EVALUATED', 'This version has not been run against the checks yet.')
  }
  if (report.failed > 0) {
    return refuse('FAILED', `${report.failed} of ${report.cases.length} checks failed.`)
  }
  if (report.skipped > 0 || report.passed === 0) {
    return refuse('INCOMPLETE', `${report.skipped} of ${report.cases.length} checks could not run, so this is not a pass.`)
  }
  if (riskLevel === 'CRITICAL') {
    return refuse('CRITICAL_RISK', 'This touches a critical change, so a person has to approve it.')
  }
  return { allowed: true, refusal: null, reason: `All ${report.passed} checks passed.`, overridden: false }
}
