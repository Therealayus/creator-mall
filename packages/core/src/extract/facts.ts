import type { ChangeCategory } from '../types/enums.js'
import type { JsonValue } from '../types/platform.js'
import type { CapabilityRegistry } from '../capabilities/registry.js'

/**
 * A candidate claim extracted from a page. Extraction is pluggable: the shipped
 * implementation is deterministic and offline, and a model-backed extractor can
 * be dropped in behind the same interface (§48 controlled autonomy).
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
  extract(input: ExtractInput): ExtractedFact[]
}

export interface ExtractInput {
  platformId: string
  platformName: string
  text: string
  sourceId: string
  capabilityRegistry: CapabilityRegistry
}

interface Rule {
  path: string
  category: ChangeCategory
  patterns: RegExp[]
  value: (match: RegExpExecArray) => number
  statement: (value: number) => string
  capabilityKeys?: string[]
  /** Human phrasing per value, for the fact statement. */
  unit?: string
}

const UP_TO = '(?:up to|maximum of|max(?:imum)?(?: of)?|limit(?:ed)? to|no more than)'

/** Documentation writes "2,200 characters"; snapshots store 2200. */
function num(value: string | undefined): number {
  return Number((value ?? '').replace(/[, ]/g, ''))
}


/**
 * Numeric limits are the facts that actually break publishing, so they are
 * extracted deterministically from official documentation text.
 */
const RULES: Rule[] = [
  {
    path: 'limits.video.maxDurationSeconds',
    category: 'CONTENT_LIMIT',
    unit: 'seconds',
    patterns: [
      new RegExp(
        `${UP_TO}\\s*(\\d{1,4}(?:\\.\\d+)?)\\s*(minutes?|mins?|hours?|hrs?)\\b`,
        'gi',
      ),
      new RegExp(`${UP_TO}\\s*(\\d{1,5})\\s*(seconds?|secs?)\\b`, 'gi'),
      /(\d{1,2}):(\d{2})\s*(?:minutes?|mins?)\b/gi,
    ],
    value: (match) => {
      const raw = match[0].trim()
      if (/^\d{1,2}:\d{2}/.test(raw)) {
        const [m = '0', s = '0'] = raw.split(':')
        return Number(m) * 60 + Number(s)
      }
      const amount = Number(match[1])
      const unit = (match[2] ?? 'seconds').toLowerCase()
      if (unit.startsWith('h')) return Math.round(amount * 3600)
      if (unit.startsWith('min')) return Math.round(amount * 60)
      return Math.round(amount)
    },
    statement: (seconds) => `Maximum video length is ${formatDuration(seconds)}.`,
    capabilityKeys: ['VIDEO_MEDIA', 'SHORT_VIDEO', 'LONG_VIDEO'],
  },
  {
    path: 'limits.text.maxCharacters',
    category: 'CHARACTER_LIMIT',
    unit: 'characters',
    patterns: [new RegExp(`${UP_TO}\\s*([\\d,]{2,9})\\s*characters?\\b`, 'gi')],
    value: (match) => num(match[1]),
    statement: (value) => `Maximum post length is ${value} characters.`,
    capabilityKeys: ['TEXT_POST', 'THREAD'],
  },
  {
    path: 'limits.text.maxHashtags',
    category: 'HASHTAG_BEHAVIOR',
    unit: 'hashtags',
    patterns: [new RegExp(`${UP_TO}\\s*(\\d{1,3})\\s*hashtags?\\b`, 'gi')],
    value: (match) => Number(match[1]),
    statement: (value) => `A post may carry up to ${value} hashtags.`,
    capabilityKeys: ['TEXT_POST', 'IMAGE_POST'],
  },
  {
    path: 'limits.media.maxFileSizeMb',
    category: 'FILE_SIZE_LIMIT',
    unit: 'MB',
    patterns: [new RegExp(`${UP_TO}\\s*(\\d{1,4}(?:\\.\\d+)?)\\s*(gb|mb)\\b`, 'gi')],
    value: (match) => (match[2]?.toLowerCase() === 'gb' ? Math.round(Number(match[1]) * 1024) : Number(match[1])),
    statement: (value) => `Maximum upload size is ${value} MB.`,
    capabilityKeys: ['IMAGE_MEDIA', 'VIDEO_MEDIA'],
  },
  {
    path: 'limits.media.maxImages',
    category: 'CONTENT_LIMIT',
    unit: 'items',
    patterns: [new RegExp(`${UP_TO}\\s*(\\d{1,3})\\s*(?:images|photos)\\b`, 'gi')],
    value: (match) => Number(match[1]),
    statement: (value) => `A post may include up to ${value} images.`,
    capabilityKeys: ['IMAGE_POST', 'CAROUSEL'],
  },
]

const DEPRECATION_PATTERN =
  /\b(deprecat(?:ed|ion|ing)|sunset|no longer support(?:ed)?|remov(?:ed|ing|al) (?:support|api|endpoint)|end[- ]of[- ]life)\b/i
const NEW_FORMAT_PATTERN =
  /\b(introduc(?:ing|es|ed)|launch(?:es|ed|ing)|rolling out|now available|new format|beta(?: testing)?|early access)\b/i

interface Sentence {
  text: string
  start: number
}

/**
 * Deterministic, offline extractor. Every fact carries the sentence it came
 * from, so the Evolution Center can always show its evidence (§35).
 */
export class HeuristicFactExtractor implements FactExtractor {
  readonly name = 'heuristic-v1'

  extract(input: ExtractInput): ExtractedFact[] {
    const facts: ExtractedFact[] = []
    const sentences = splitSentences(input.text)
    const consumed = new Set<string>()

    for (const rule of RULES) {
      for (const pattern of rule.patterns) {
        pattern.lastIndex = 0
        const match = pattern.exec(input.text)
        if (!match) continue
        const value = rule.value(match)
        if (typeof value === 'number' && !Number.isFinite(value)) continue
        const sentence = sentenceAt(sentences, match.index)
        const key = `${input.platformId}:${rule.path}`
        if (consumed.has(key)) break
        consumed.add(key)
        facts.push({
          key,
          path: rule.path,
          statement: rule.statement(value),
          value,
          category: rule.category,
          evidence: truncate(sentence, 400),
          confidence: 0.7,
          sourceId: input.sourceId,
          capabilityKeys: rule.capabilityKeys ?? [],
        })
        break
      }
    }

    for (const sentence of sentences) {
      if (facts.length >= 60) break
      if (!DEPRECATION_PATTERN.test(sentence.text)) continue
      const matches = input.capabilityRegistry.matchSignals(sentence.text)
      facts.push({
        key: `${input.platformId}:deprecations:${slug(sentence.text).slice(0, 60)}`,
        path: 'policies',
        statement: truncate(sentence.text, 200),
        value: sentence.text,
        category: 'API_DEPRECATION',
        evidence: truncate(sentence.text, 400),
        sourceId: input.sourceId,
        confidence: matches.length > 0 ? 0.6 : 0.4,
        capabilityKeys: matches.slice(0, 3).map((match) => match.key),
      })
    }

    for (const sentence of sentences) {
      if (facts.length >= 80) break
      if (!NEW_FORMAT_PATTERN.test(sentence.text)) continue
      const matches = input.capabilityRegistry.matchSignals(sentence.text)
      if (matches.length === 0) continue
      const best = matches[0]!
      const key = `${input.platformId}:capabilities:${best.key}`
      if (consumed.has(key)) continue
      consumed.add(key)
      facts.push({
        key,
        path: `capabilities.${best.key}`,
        statement: truncate(sentence.text, 200),
        value: { state: 'ACTIVE' },
        category: 'NEW_FEATURE',
        evidence: truncate(sentence.text, 400),
        sourceId: input.sourceId,
        confidence: 0.5,
        capabilityKeys: [best.key],
      })
    }

    return facts
  }
}

function splitSentences(text: string): Sentence[] {
  const result: Sentence[] = []
  const pattern = /[^.!?\n]{25,600}(?:[.!?]|\n)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0].replace(/\s+/g, ' ').trim()
    if (raw.length < 25) continue
    result.push({ text: raw, start: match.index })
  }
  return result
}

function sentenceAt(sentences: Sentence[], index: number): string {
  let best = sentences[0]?.text ?? ''
  let bestDistance = Number.POSITIVE_INFINITY
  for (const sentence of sentences) {
    const distance = Math.abs(sentence.start - index)
    if (distance < bestDistance) {
      bestDistance = distance
      best = sentence.text
    }
  }
  return best
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} ${plural(seconds / 3600, 'hour')}`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} ${plural(seconds / 60, 'minute')}`
  return `${seconds} ${plural(seconds, 'second')}`
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function truncate(value: string, max: number): string {
  const clean = value.trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}
