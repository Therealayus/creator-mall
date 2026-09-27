import type { GeneratedCopy, GenerationRequest, CopyGenerator } from './port.js'
import { limitNumber } from './port.js'
import { DeterministicGenerator } from './deterministic.js'
import type { ModelClient } from '../extract/model.js'

export interface ModelCopyOptions {
  client: ModelClient
  fallback?: CopyGenerator
  maxTokens?: number
  onFallback?: (reason: string) => void
}

const SYSTEM_PROMPT = `You write social posts for a creator who already knows their audience.

Rules:
- Plain language, short sentences, no hype and no filler.
- Return ONLY a JSON object: {"hook": string, "body": string, "cta": string, "hashtags": string[]}
- Respect the platform requirements you are given. If a limit is stated, never exceed it.
- Never invent statistics, quotes, results or brand names.
- The hook is the first line only. The body is plain text, no markdown.

Return nothing else.`

/**
 * Copy generation backed by a model, with the deterministic renderer underneath.
 *
 * The model is a *writer*, not an authority: its output is parsed, validated and
 * checked against the platform's verified limits before it is stored, and any
 * problem falls back to the renderer. The resulting asset records which one
 * actually wrote it.
 */
export class ModelCopyGenerator implements CopyGenerator {
  readonly producedBy: string
  private readonly client: ModelClient
  private readonly fallback: CopyGenerator
  private readonly maxTokens: number
  private readonly onFallback?: (reason: string) => void

  constructor(options: ModelCopyOptions) {
    this.client = options.client
    this.fallback = options.fallback ?? new DeterministicGenerator()
    this.maxTokens = options.maxTokens ?? 900
    this.onFallback = options.onFallback
    this.producedBy = `model:${options.client.name}`
  }

  async generateCopy(request: GenerationRequest): Promise<GeneratedCopy> {
    let completion: string
    try {
      completion = await this.client.complete({
        system: SYSTEM_PROMPT,
        user: this.promptFor(request),
        maxTokens: this.maxTokens,
      })
    } catch (error) {
      // A provider outage is not the creator's problem: write it properly anyway.
      const reason = error instanceof Error ? error.message : 'model call failed'
      this.onFallback?.(reason)
      return this.fallback.generateCopy(request)
    }

    const parsed = parseCopy(completion)
    if (!parsed) {
      this.onFallback?.('model copy was not usable')
      return this.fallback.generateCopy(request)
    }

    const fitted = this.enforceLimits(parsed, request)
    if (!fitted) {
      this.onFallback?.('model copy exceeded a verified limit')
      return this.fallback.generateCopy(request)
    }

    return { ...parsed, ...fitted, producedBy: this.producedBy, modelGenerated: true }
  }

  private promptFor(request: GenerationRequest): string {
    return [
      `Platform: ${request.platformName}`,
      `Format: ${request.capabilityLabel}`,
      `Topic: ${request.brief}`,
      request.tone ? `Tone: ${request.tone}` : '',
      '',
      'Platform requirements:',
      request.limits.length > 0
        ? request.limits.map((limit) => `- ${limit.label}: ${limit.value}`).join('\n')
        : '- we have not confirmed the exact limits for this format yet',
    ]
      .filter(Boolean)
      .join('\n')
  }

  /**
   * Enforces verified limits on the model's words. Returns null when the copy
   * cannot be made to fit, so the caller can fall back rather than ship a
   * silently truncated post.
   */
  private enforceLimits(
    copy: GeneratedCopy,
    request: GenerationRequest,
  ): Pick<GeneratedCopy, 'hook' | 'body' | 'cta' | 'hashtags'> | null {
    const maxHashtags = limitNumber(request, /hashtag/i) ?? Number.POSITIVE_INFINITY
    if (copy.hashtags.length > maxHashtags) return null

    const max = limitNumber(request, /character/i)
    if (max === null) return { hook: copy.hook, body: copy.body, cta: copy.cta, hashtags: copy.hashtags }

    const total = copy.hook.length + copy.body.length + copy.cta.length
    if (total <= max) return { hook: copy.hook, body: copy.body, cta: copy.cta, hashtags: copy.hashtags }

    const roomForCta = Math.min(copy.cta.length, Math.max(0, Math.floor(max * 0.2)))
    const roomForHook = Math.min(copy.hook.length, Math.max(0, Math.floor(max * 0.3)))
    const roomForBody = max - roomForHook - roomForCta
    if (roomForBody < 40) return null

    return {
      hook: cut(copy.hook, roomForHook),
      body: cut(copy.body, roomForBody),
      cta: cut(copy.cta, roomForCta),
      hashtags: copy.hashtags,
    }
  }
}

function parseCopy(completion: string): GeneratedCopy | null {
  const text = completion
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Record<string, unknown>
  const hook = clean(record.hook, 200)
  const body = clean(record.body, 3000)
  const cta = clean(record.cta, 200)
  if (!hook || !body) return null

  const hashtags = Array.isArray(record.hashtags)
    ? record.hashtags
        .filter((tag): tag is string => typeof tag === 'string')
        // Strip to a safe tag body first, then prefix, so a model that omits the
        // hash still produces a valid tag.
        .map((tag) => tag.replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 40))
        .filter((tag) => tag.length > 1)
        .map((tag) => `#${tag}`)
        .slice(0, 10)
    : []

  return { hook, body, cta: cta || 'Save this for later.', hashtags, producedBy: '', modelGenerated: true }
}

/** Social posts are not markdown: strip decoration a model may have added. */
function stripMarkdown(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = stripMarkdown(value.replace(/\s+/g, ' ').trim())
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

function cut(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  const slice = value.slice(0, Math.max(1, max - 1))
  const lastSpace = slice.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`
}
