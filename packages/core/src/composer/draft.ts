import type { TemplateDefinition } from '../types/evolution.js'
import { stableId } from '../util.js'

export interface DraftRequest {
  platformId: string
  platformName: string
  platformSlug: string
  capabilityKey: string
  capabilityLabel: string
  brief: string
  /** Optional creator tone, e.g. "direct" or "friendly". */
  tone?: string
}

export interface DraftResult {
  source: 'TEMPLATE' | 'NONE'
  templateId: string | null
  templateName: string | null
  hook: string
  body: string
  cta: string
  notes: string[]
  /** Plain-language explanation of what this draft is and is not. */
  provenance: string
}

const DEFAULT_CTA = 'Save this and come back to it when it is ready.'
const DEFAULT_NOTE = 'This draft follows the structure your platform supports today.'

/**
 * A deterministic, template-driven draft.
 *
 * This is deliberately *not* presented as AI. When a hosted generation provider is
 * configured it will replace this behind the same interface; until then the creator
 * gets a real, structured starting point assembled from the platform's own templates,
 * and the response says exactly that (§43: no pretending).
 */
export function composeDraft(request: DraftRequest, templates: ReadonlyArray<TemplateDefinition>): DraftResult {
  const brief = cleanBrief(request.brief)
  const candidates = templates
    .filter(
      (template) =>
        template.platformId === request.platformId &&
        template.capabilityKey === request.capabilityKey &&
        (template.status === 'ACTIVE' || template.status === 'APPROVED'),
    )
    .sort((a, b) => a.name.localeCompare(b.name))

  const template = candidates[0] ?? null

  if (!template) {
    return {
      source: 'NONE',
      templateId: null,
      templateName: null,
      hook: openingLine(request, brief),
      body: outline(brief, DEFAULT_NOTE),
      cta: DEFAULT_CTA,
      notes: [
        `We do not have a prepared structure for ${request.capabilityLabel.toLowerCase()} on ${request.platformName} yet.`,
        'This outline follows the platform requirements we have verified so far.',
      ],
      provenance: `Generic outline for ${request.platformName}. No prepared template for this format yet.`,
    }
  }

  const notes = [DEFAULT_NOTE]
  if (request.tone) notes.push(`Tone: ${request.tone}.`)

  return {
    source: 'TEMPLATE',
    templateId: template.id,
    templateName: template.name,
    hook: fillHook(template.hook, request, brief),
    body: outline(brief, template.structure),
    cta: template.cta ?? DEFAULT_CTA,
    notes,
    provenance: `Built from the prepared structure “${template.name}” for ${request.platformName}.`,
  }
}

/** One deterministic structure per capability, so seeding needs no content team. */
export function seedTemplateFor(input: {
  platformId: string
  platformSlug: string
  platformName: string
  capabilityKey: string
  capabilityLabel: string
  createdAt: string
}): TemplateDefinition {
  const key = input.capabilityKey
  const isVideo = key === 'SHORT_VIDEO' || key === 'LONG_VIDEO'
  const isText = key === 'TEXT_POST' || key === 'THREAD' || key === 'ARTICLE'
  const isCarousel = key === 'CAROUSEL'
  const isStory = key === 'STORY'
  const isLive = key === 'LIVE'

  const name = `${input.capabilityLabel} · ${input.platformName}`
  const hook = hookFor(isVideo, isText, isCarousel, isStory, isLive, input.capabilityLabel)
  const structure = structureFor(isVideo, isText, isCarousel, isStory, isLive)
  const cta = ctaFor(isVideo, isText, isCarousel, isStory, isLive)

  return {
    id: stableId('tpl', input.platformSlug, key),
    platformId: input.platformId,
    capabilityKey: key,
    name,
    structure,
    hook,
    cta,
    status: 'ACTIVE',
    createdBy: 'SEED',
    createdAt: input.createdAt,
    basedOnEventId: null,
  }
}

function hookFor(
  isVideo: boolean,
  isText: boolean,
  isCarousel: boolean,
  isStory: boolean,
  isLive: boolean,
  label: string,
): string {
  if (isLive) return 'Open with the single reason someone should stay for the whole session.'
  if (isStory) return 'Open with the moment that makes someone tap through to the next one.'
  if (isVideo) return 'Open on the result, not on the setup. First line earns the next three seconds.'
  if (isCarousel) return 'Make the first card the whole reason to swipe.'
  if (isText) return 'Lead with the one sentence you would say out loud.'
  return `Open with why this ${label.toLowerCase()} matters to one specific person.`
}

function structureFor(
  isVideo: boolean,
  isText: boolean,
  isCarousel: boolean,
  isStory: boolean,
  isLive: boolean,
): string {
  if (isLive) return 'Promise → what you will cover → one proof point → what to expect by the end.'
  if (isStory) return 'Moment → context → question for the audience → what happens next.'
  if (isVideo) return 'Hook → the problem in one line → the turn → the takeaway → the ask.'
  if (isCarousel) return 'Card 1 promise → cards 2–5 one idea each → final card summary and call to action.'
  if (isText) return 'Claim → supporting detail → concrete example → what you want the reader to do.'
  return 'Opening → main point → supporting detail → close.'
}

function ctaFor(
  isVideo: boolean,
  isText: boolean,
  isCarousel: boolean,
  isStory: boolean,
  isLive: boolean,
): string {
  if (isLive) return 'Tell people what to ask you while you are live.'
  if (isStory) return 'Ask for a reply so the next story has an answer to build on.'
  if (isVideo) return 'Ask for one specific action, not a vague “engage”.'
  if (isCarousel) return 'Point at the last card and say what to do next.'
  if (isText) return 'Ask one clear question you can answer in the replies.'
  return 'Ask one clear question you can answer in the replies.'
}

function fillHook(hook: string | null, request: DraftRequest, brief: string): string {
  const base = hook ?? openingLine(request, brief)
  return brief ? `${base}\n\nTopic: ${brief}` : base
}

function openingLine(request: DraftRequest, brief: string): string {
  const subject = brief || `your ${request.capabilityLabel.toLowerCase()}`
  return `Write about ${subject} for an audience that follows ${request.platformName}.`
}

function outline(brief: string, structure: string): string {
  const subject = brief || 'your topic'
  return [`Structure: ${structure}`, '', `1. Say the point about ${subject} in one sentence.`, `2. Show it with one concrete example.`, '3. Say what the reader should do next.'].join('\n')
}

function cleanBrief(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 280)
}
