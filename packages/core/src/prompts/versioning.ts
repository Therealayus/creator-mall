import type { PromptVersion } from '../types/evolution.js'
import type { ChangeCategory, RiskLevel } from '../types/enums.js'
import { diffLines } from './diff.js'
import { nowIso, stableId } from '../util.js'

/**
 * §23: prompts are versioned configuration, not code.
 *
 * When a platform's requirements change, the engine drafts the next version,
 * evaluates it and activates it only after review. Nothing is ever overwritten
 * in place, so a bad generation can always be traced back to a prompt version.
 */
export class PromptLibrary {
  private readonly prompts = new Map<string, PromptVersion[]>()

  constructor(seed: ReadonlyArray<Omit<PromptVersion, 'id'>> = []) {
    for (const prompt of seed) this.add(prompt)
  }

  add(prompt: Omit<PromptVersion, 'id'>): PromptVersion {
    const stored: PromptVersion = { ...prompt, id: stableId('pv', prompt.promptKey, String(prompt.version)) }
    const versions = this.prompts.get(stored.promptKey) ?? []
    versions.push(stored)
    versions.sort((a, b) => a.version - b.version)
    this.prompts.set(stored.promptKey, versions)
    return stored
  }

  versions(promptKey: string): PromptVersion[] {
    return [...(this.prompts.get(promptKey) ?? [])]
  }

  active(promptKey: string): PromptVersion | undefined {
    return this.prompts.get(promptKey)?.find((prompt) => prompt.status === 'ACTIVE')
  }

  get(promptKey: string, version: number): PromptVersion | undefined {
    return this.prompts.get(promptKey)?.find((prompt) => prompt.version === version)
  }

  all(): PromptVersion[] {
    return [...this.prompts.values()].flat()
  }

  /**
   * Drafts the next version for a platform prompt. The body change is a
   * requirement-aware instruction, not a guess: it states what changed and where
   * the writer must adapt.
   */
  draftNext(input: {
    promptKey: string
    platformId: string | null
    category: ChangeCategory
    changeSummary: string
    requirements: string[]
    basedOnEventId?: string | null
    clock?: () => number
  }): { draft: PromptVersion; previous: PromptVersion | undefined; diff: string } {
    const previous = this.active(input.promptKey)
    const version = (previous?.version ?? 0) + 1
    const requirementBlock = input.requirements.map((requirement) => `- ${requirement}`).join('\n')

    const body = [
      previous?.body.split('\n\n## Current platform requirements')[0]?.trim() ?? basePromptFor(input.category),
      '',
      '## Current platform requirements',
      `Verified change (${input.category.replace(/_/g, ' ').toLowerCase()}): ${input.changeSummary}`,
      requirementBlock,
      '',
      'Follow the requirements above exactly. If a requirement conflicts with the brief, prefer the platform requirement and say so in one short line.',
    ].join('\n')

    const draft: PromptVersion = {
      id: '',
      promptKey: input.promptKey,
      platformId: input.platformId,
      version,
      body,
      variables: previous?.variables ?? ['topic', 'audience', 'brandVoice', 'goal'],
      status: 'DRAFT',
      createdAt: nowIso(input.clock ?? Date.now),
      activatedAt: null,
      createdBy: 'WORLD_ENGINE',
      changeNote: `Auto-drafted after a verified ${input.category.replace(/_/g, ' ').toLowerCase()} change.`,
      basedOnEventId: input.basedOnEventId ?? null,
      evaluationScore: null,
    }

    return {
      draft: this.add(draft),
      previous,
      diff: diffLines(previous?.body ?? '', draft.body),
    }
  }

  /** Prompts only activate through a controlled decision. */
  activate(promptKey: string, version: number): PromptVersion | undefined {
    const target = this.get(promptKey, version)
    if (!target) return undefined
    for (const prompt of this.prompts.get(promptKey) ?? []) {
      if (prompt.status === 'ACTIVE' && prompt.id !== target.id) prompt.status = 'SUPERSEDED'
    }
    target.status = 'ACTIVE'
    target.activatedAt = nowIso()
    return target
  }

  retire(promptKey: string, version: number): void {
    const target = this.get(promptKey, version)
    if (target) target.status = 'RETIRED'
  }
}

function basePromptFor(category: ChangeCategory): string {
  const base = `You are writing for a creator publishing on a social platform.
Match the creator's brand voice, keep the message concrete, and avoid filler.`
  if (category === 'MONETIZATION_CHANGE') {
    return `${base}\n\nWhen describing earnings, never invent figures. Only state what the platform officially documents.`
  }
  if (category === 'POLICY_CHANGE' || category === 'HASHTAG_BEHAVIOR') {
    return `${base}\n\nRespect platform rules on claims, hashtags and disclosure.`
  }
  return base
}

export function promptRiskFor(category: ChangeCategory, riskLevel: RiskLevel): RiskLevel {
  if (riskLevel === 'CRITICAL') return 'HIGH'
  if (category === 'MONETIZATION_CHANGE' || category === 'POLICY_CHANGE') return 'MEDIUM'
  return 'LOW'
}
