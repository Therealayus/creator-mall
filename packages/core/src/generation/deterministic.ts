import { hashString } from '../util.js'
import type {
  GeneratedAudio,
  GeneratedCopy,
  GeneratedImage,
  GeneratedStoryboard,
  GenerationRequest,
  CopyGenerator,
  ImageGenerator,
  VideoGenerator,
  AudioGenerator,
  StoryboardShot,
} from './port.js'
import { PRODUCTION_DETERMINISTIC, limitNumber } from './port.js'

/**
 * The deterministic renderer.
 *
 * It writes real, usable output from real inputs: copy that respects the
 * platform's verified limits, a poster a creator can actually post, a shot list
 * a creator can shoot, and narration with timings. It is a renderer, not a
 * model, and every artifact it produces says `producedBy: creator-mall-renderer-v1`
 * so nothing is ever mistaken for generated-by-AI.
 */

const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ['#1b2a4a', '#3b6fd4', '#8fd6ff'],
  ['#3a1b4a', '#8a3fd4', '#ffb3f0'],
  ['#123a2a', '#2f9e6b', '#b8f2c9'],
  ['#4a2a12', '#d47a2f', '#ffd9a8'],
  ['#241b4a', '#5b4bd4', '#b6c4ff'],
]

export class DeterministicGenerator implements CopyGenerator, ImageGenerator, VideoGenerator, AudioGenerator {
  readonly producedBy = PRODUCTION_DETERMINISTIC

  generateCopy(request: GenerationRequest): Promise<GeneratedCopy> {
    const topic = cleanTopic(request.brief)
    const hook = hookFor(request, topic)
    const body = bodyFor(request, topic)
    const cta = ctaFor(request)
    return Promise.resolve({
      hook,
      body: this.fitToLimits(hook, body, cta, request),
      cta,
      hashtags: hashtagsFor(request, topic),
      producedBy: this.producedBy,
      modelGenerated: false,
    })
  }

  generateImage(request: GenerationRequest & { title: string; subtitle?: string }): Promise<GeneratedImage> {
    const seed = hashString(`${request.platformSlug}:${request.brief}:${request.title}`).charCodeAt(0)
    const palette = PALETTES[seed % PALETTES.length]!
    const width = ratioFor(request.capabilityKey) === 'landscape' ? 1200 : 1080
    const height = ratioFor(request.capabilityKey) === 'landscape' ? 675 : 1350

    return Promise.resolve({
      svg: posterSvg({
        width,
        height,
        palette,
        title: request.title,
        subtitle: request.subtitle ?? `${request.platformName} · ${request.capabilityLabel}`,
        footer: request.brief ? truncate(request.brief, 90) : request.capabilityLabel,
      }),
      width,
      height,
      alt: `Generated poster: ${request.title}`,
      producedBy: this.producedBy,
      modelGenerated: false,
    })
  }

  generateStoryboard(request: GenerationRequest & { targetSeconds?: number }): Promise<GeneratedStoryboard> {
    const isShort = request.capabilityKey === 'SHORT_VIDEO'
    const totalSeconds = clamp(request.targetSeconds ?? (isShort ? 15 : 45), 5, 300)
    const shotCount = Math.max(3, Math.min(8, Math.round(totalSeconds / (isShort ? 5 : 8))))
    const topic = cleanTopic(request.brief)
    const secondsEach = Math.round((totalSeconds / shotCount) * 10) / 10

    const beats = [
      { visual: `Open on the result: ${topic}.`, voiceover: `Here is ${topic}, and it takes less time than you think.`, text: topic },
      { visual: 'Show the messy middle, unedited.', voiceover: 'The part nobody shows you is the setup.', text: 'the honest bit' },
      { visual: 'Close-up of the thing that made it work.', voiceover: 'This is the bit that changed everything.', text: 'what changed it' },
      { visual: 'Before and after, side by side.', voiceover: 'Same effort, different result.', text: 'before / after' },
      { visual: 'You, mid-sentence, mid-laugh.', voiceover: 'That is the whole trick.', text: 'that is it' },
      { visual: 'A single clean frame that holds the message.', voiceover: 'Save this for the next one.', text: 'save this' },
      { visual: 'End card with one instruction.', voiceover: 'Try it once, then decide.', text: 'try it once' },
      { visual: 'The final frame, held.', voiceover: 'That is it.', text: '' },
    ]

    const shots: StoryboardShot[] = Array.from({ length: shotCount }, (_unused, index) => {
      const beat = beats[index % beats.length]!
      return {
        index: index + 1,
        seconds: secondsEach,
        visual: beat.visual,
        voiceover: beat.voiceover,
        onScreenText: beat.text,
      }
    })

    return Promise.resolve({
      format: isShort ? 'short' : 'long',
      totalSeconds: Math.round(totalSeconds * 10) / 10,
      shots,
      captionCue: shots.map((shot) => ({ at: shot.index * secondsEach, text: shot.onScreenText })).filter((cue) => cue.text !== ''),
      producedBy: this.producedBy,
      modelGenerated: false,
    })
  }

  generateAudioScript(request: GenerationRequest & { targetSeconds?: number }): Promise<GeneratedAudio> {
    const totalSeconds = clamp(request.targetSeconds ?? 20, 5, 300)
    const topic = cleanTopic(request.brief)
    const wordsPerMinute = 150
    const budget = Math.floor((totalSeconds / 60) * wordsPerMinute)

    const lines = [
      `If you have been putting off ${topic}, this is the short version.`,
      'Start with the smallest version that still works.',
      'Do it once, badly, then do it again properly.',
      'Save this so the next one takes five minutes to start.',
    ]

    const segments: Array<{ at: number; seconds: number; text: string }> = []
    let at = 0
    for (const line of lines) {
      const trimmed = truncate(line, budget)
      const seconds = Math.max(1.5, Math.round((trimmed.split(/\s+/).length / wordsPerMinute) * 60 * 10) / 10)
      segments.push({ at: Math.round(at * 10) / 10, seconds, text: trimmed })
      at += seconds
    }

    return Promise.resolve({
      segments,
      totalSeconds: Math.round(at * 10) / 10,
      direction: `Conversational, about ${wordsPerMinute} words a minute, one idea per sentence.`,
      producedBy: this.producedBy,
      modelGenerated: false,
    })
  }

  /**
   * Keeps generated copy inside the platform's verified limits. Truncation is
   * stated rather than silent, because a silently shortened caption is worse than
   * a visible one.
   */
  private fitToLimits(hook: string, body: string, cta: string, request: GenerationRequest): string {
    const max = limitNumber(request, /character/i)
    if (max === null) return body

    const full = `${hook}\n\n${body}\n\n${cta}`
    if (full.length <= max) return full
    return `${truncate(full, Math.max(0, max - 1))}…`
  }
}

function hookFor(request: GenerationRequest, topic: string): string {
  switch (request.capabilityKey) {
    case 'SHORT_VIDEO':
      return `Open on the result, not the setup: ${topic}.`
    case 'LONG_VIDEO':
      return `${capitalise(topic)} — the version that actually saved me time.`
    case 'CAROUSEL':
      return `First card, one promise: ${topic}.`
    case 'STORY':
      return `The moment that made me try ${topic}.`
    case 'ARTICLE':
      return `${capitalise(topic)}, explained without the fluff.`
    case 'TEXT_POST':
    default:
      return `Most advice about ${topic} is written by people who never tried it.`
  }
}

function bodyFor(request: GenerationRequest, topic: string): string {
  const structure = {
    SHORT_VIDEO: `The problem: ${topic} takes longer than it should.\nThe turn: I stopped starting from scratch.\nThe takeaway: build the first version in ten minutes, then improve it once.`,
    LONG_VIDEO: `${capitalise(topic)}, start to finish.\n\nWhat I did, what broke, and what I would do differently.`,
    CAROUSEL: `Card 1: the promise.\nCards 2–5: one idea each, one line.\nCard 6: what to do next.`,
    STORY: `The setup, the surprise, and what I am going to try next.`,
    ARTICLE: `A claim about ${topic}, one worked example, and a number you can check.`,
  }[request.capabilityKey] ?? `Here is what worked for ${topic}, and the part that surprised me.`
  return structure
}

function ctaFor(request: GenerationRequest): string {
  if (request.capabilityKey === 'STORY') return 'Reply with your version and I will read it.'
  if (request.capabilityKey === 'CAROUSEL') return 'Save this, then swipe back to the last card.'
  if (request.capabilityKey === 'LONG_VIDEO' || request.capabilityKey === 'SHORT_VIDEO') return 'Try it once, then tell me what broke.'
  return 'Ask one question in the replies and I will answer it properly.'
}

function hashtagsFor(request: GenerationRequest, topic: string): string[] {
  const base = topic
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 2)
  const max = limitNumber(request, /hashtag/i) ?? 3
  const tags = ['#' + slugTag(request.platformName), ...base.map((word) => `#${slugTag(word)}`), '#creator']
  return [...new Set(tags)].filter((tag) => tag.length > 1).slice(0, Math.max(1, max))
}



export interface PosterSpec {
  width: number
  height: number
  palette: readonly [string, string, string]
  title: string
  subtitle: string
  footer: string
}

/**
 * A real, postable poster: gradient background, wrapped title, safe margins.
 * Rendered as SVG so it needs no image library and scales to any size.
 */
export function posterSvg(spec: PosterSpec): string {
  const [dark, mid, light] = spec.palette
  const margin = Math.round(spec.width * 0.09)
  const titleSize = Math.round(spec.width / 13)
  const lines = wrap(spec.title, Math.floor((spec.width - margin * 2) / (titleSize * 0.56)))
  const titleTop = Math.round(spec.height * 0.42)
  const lineHeight = Math.round(titleSize * 1.22)

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}" role="img" aria-label="${escapeXml(spec.title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${dark}"/>
      <stop offset="55%" stop-color="${mid}"/>
      <stop offset="100%" stop-color="${light}"/>
    </linearGradient>
  </defs>
  <rect width="${spec.width}" height="${spec.height}" fill="url(#bg)"/>
  <rect x="${margin}" y="${Math.round(spec.height * 0.08)}" width="${Math.round((spec.width - margin * 2) * 0.16)}" height="${Math.max(4, Math.round(spec.height * 0.006))}" fill="#ffffff" opacity="0.85"/>
  <text x="${margin}" y="${Math.round(spec.height * 0.17)}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${Math.round(spec.width / 42)}" fill="#ffffff" opacity="0.9" letter-spacing="1">${escapeXml(spec.subtitle.toUpperCase())}</text>
  ${lines
    .map(
      (line, index) =>
        `<text x="${margin}" y="${titleTop + index * lineHeight}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${titleSize}" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`,
    )
    .join('\n  ')}
  <text x="${margin}" y="${spec.height - margin}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${Math.round(spec.width / 46)}" fill="#ffffff" opacity="0.82">${escapeXml(truncate(spec.footer, 64))}</text>
</svg>`
}

function ratioFor(capabilityKey: string): 'portrait' | 'landscape' {
  return capabilityKey === 'LONG_VIDEO' || capabilityKey === 'ARTICLE' ? 'landscape' : 'portrait'
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > maxChars && current) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, 4)
}

function cleanTopic(brief: string): string {
  const cleaned = brief.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  return truncate(cleaned || 'this', 90)
}

function slugTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

function truncate(value: string, max: number): string {
  if (max <= 0) return ''
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
