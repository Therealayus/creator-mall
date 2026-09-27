/**
 * The generation port.
 *
 * One shape for text, images, video and audio, with two implementations:
 *
 * - `DeterministicGenerator` — no key, no network, always available. It writes
 *   real copy, a real poster, a real shot list and real caption timings. It is
 *   a *renderer*, not a model, and every asset it makes says so.
 * - `ModelTextGenerator` — delegates copy to a model when one is configured.
 *
 * Image, video and audio *models* are deliberately not faked: there is no
 * provider for them here, so the port is exposed and the honest renderer ships
 * instead. `ImageGenerator`, `VideoGenerator` and `AudioGenerator` are the seams
 * where a real provider drops in.
 */

export interface GenerationRequest {
  creatorId: string
  platformSlug: string
  platformName: string
  capabilityKey: string
  capabilityLabel: string
  brief: string
  tone?: string
  /** Verified limits, so generated copy cannot exceed them. */
  limits: Array<{ label: string; value: string }>
}

export interface GeneratedCopy {
  hook: string
  body: string
  cta: string
  hashtags: string[]
  /** Plain-language provenance: what wrote this. */
  producedBy: string
  modelGenerated: boolean
}

export interface GeneratedImage {
  /** SVG source. A real, usable asset: gradients, type, safe margins. */
  svg: string
  width: number
  height: number
  alt: string
  producedBy: string
  modelGenerated: boolean
}

export interface StoryboardShot {
  index: number
  seconds: number
  visual: string
  voiceover: string
  onScreenText: string
}

export interface GeneratedStoryboard {
  format: 'short' | 'long'
  totalSeconds: number
  shots: StoryboardShot[]
  captionCue: Array<{ at: number; text: string }>
  producedBy: string
  modelGenerated: boolean
}

export interface GeneratedAudio {
  /** Plain narration script, segmented with timings. */
  segments: Array<{ at: number; seconds: number; text: string }>
  totalSeconds: number
  /** Suggested delivery, e.g. "conversational, 150 wpm". */
  direction: string
  producedBy: string
  modelGenerated: boolean
}

export interface CopyGenerator {
  generateCopy(request: GenerationRequest): Promise<GeneratedCopy>
}

export interface ImageGenerator {
  generateImage(request: GenerationRequest & { title: string; subtitle?: string }): Promise<GeneratedImage>
}

export interface VideoGenerator {
  generateStoryboard(request: GenerationRequest & { targetSeconds?: number }): Promise<GeneratedStoryboard>
}

export interface AudioGenerator {
  generateAudioScript(request: GenerationRequest & { targetSeconds?: number }): Promise<GeneratedAudio>
}

export const PRODUCTION_DETERMINISTIC = 'creator-mall-renderer-v1'

/**
 * Finds a verified limit by matching its label **or** its rendered value.
 *
 * Real limits are inconsistent: one platform says "Maximum length: 90
 * seconds", another "Characters per post: 3,000". Matching only one field is
 * how a generator silently ignores a limit that exists.
 */
export function limitValue(request: GenerationRequest, pattern: RegExp): string | null {
  const match = request.limits.find((limit) => pattern.test(limit.label) || pattern.test(limit.value))
  return match?.value ?? null
}

export function limitNumber(request: GenerationRequest, pattern: RegExp): number | null {
  const value = limitValue(request, pattern)
  if (value === null) return null
  const numeric = Number(value.replace(/[^0-9.]/g, ''))
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}
