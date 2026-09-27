import { z } from 'zod'
import {
  DeterministicGenerator,
  ModelCopyGenerator,
  limitNumber,
} from '@creator-mall/core'
import type {
  AssetKind,
  AudioGenerator,
  CopyGenerator,
  GeneratedAudio,
  GeneratedCopy,
  GeneratedImage,
  GeneratedStoryboard,
  ImageGenerator,
  MediaAsset,
  PlatformState,
  SocialPlatform,
  VideoGenerator,
} from '@creator-mall/core'
import type { AppContext } from './context.js'
import { limitValue } from '@creator-mall/core'
import type { MediaLibrary } from './store/media-library.js'
import { redactSecrets } from './ai/openrouter.js'

/**
 * The Creator Engine.
 *
 * Copy can come from a model when one is configured; images, storyboards and
 * narration come from the deterministic renderer, which produces real artifacts
 * and labels them honestly. Nothing here invents a capability it has not been
 * told the platform supports, and every generated asset records what produced it.
 */

export const renderer = new DeterministicGenerator()

/** Model-backed when a provider exists, renderer-backed otherwise. */
export function copyGenerator(context: AppContext, promptKey?: string): CopyGenerator {
  const model = context.modelClient
  if (!model) return renderer
  // Feed the activated prompt version in, so an approved prompt change is what
  // actually gets written rather than sitting inert in the library.
  const active = promptKey ? context.control.prompts.active(promptKey) : undefined
  return new ModelCopyGenerator({
    client: model,
    fallback: renderer,
    ...(active ? { systemPrompt: active.body } : {}),
    onFallback: (reason) => console.log(`[creator-engine] copy fell back to the renderer: ${redactSecrets(reason)}`),
  })
}

export interface GenerationContext {
  platform: SocialPlatform
  state: PlatformState | null
  request: { brief: string; option: string; tone?: string; targetSeconds?: number }
}

function limitsFor(context: GenerationContext): Array<{ label: string; value: string }> {
  const limits: Array<{ label: string; value: string }> = []
  const area = context.state?.limits as Record<string, unknown> | undefined
  for (const [group, values] of Object.entries(area ?? {})) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) continue
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value === 'number') limits.push({ label: `${group} ${key}`, value: String(value) })
    }
  }
  return limits
}

function buildRequest(context: GenerationContext, capabilityLabel: string) {
  return {
    creatorId: '',
    platformSlug: context.platform.slug,
    platformName: context.platform.name,
    capabilityKey: context.request.option,
    capabilityLabel,
    brief: context.request.brief,
    ...(context.request.tone ? { tone: context.request.tone } : {}),
    limits: limitsFor(context),
  }
}

export interface GenerateOutput {
  kind: AssetKind
  title: string
  /** Serialized artifact: copy text, SVG, shot list or narration script. */
  content: string
  mimeType: string
  producedBy: string
  modelGenerated: boolean
  meta: Record<string, unknown>
}

export async function generate(
  context: AppContext,
  generation: GenerationContext,
  library: MediaLibrary,
  creatorId: string,
): Promise<GenerateOutput> {
  const capabilityLabel = context.control.capabilities.get(generation.request.option)?.label ?? generation.request.option
  const request = { ...buildRequest(generation, capabilityLabel), creatorId }
  const brief = generation.request.brief.trim()

  if (generation.request.option === 'SHORT_VIDEO' || generation.request.option === 'LONG_VIDEO') {
    const copy: GeneratedCopy = await copyGenerator(context, promptKeyFor(generation.platform, generation.request.option)).generateCopy(request)
    const board: GeneratedStoryboard = await (renderer as VideoGenerator).generateStoryboard({
      ...request,
      ...(generation.request.targetSeconds ? { targetSeconds: generation.request.targetSeconds } : {}),
    })
    return {
      kind: 'STORYBOARD',
      title: titleFor(brief, capabilityLabel),
      content: [copy.hook, '', copy.body, '', copy.cta, '', '--- shot list ---', ...board.shots.map((shot) => `${shot.index}. (${shot.seconds}s) ${shot.visual} — "${shot.voiceover}"`)].join('\n'),
      mimeType: 'text/markdown',
      producedBy: `${copy.producedBy} + ${board.producedBy}`,
      modelGenerated: copy.modelGenerated,
      meta: {
        copy: { hook: copy.hook, body: copy.body, cta: copy.cta, hashtags: copy.hashtags },
        storyboard: board,
      },
    }
  }

  if (generation.request.option === 'AUDIO' || generation.request.option === 'PODCAST_EPISODE') {
    const audio: GeneratedAudio = await (renderer as AudioGenerator).generateAudioScript({
      ...request,
      ...(generation.request.targetSeconds ? { targetSeconds: generation.request.targetSeconds } : {}),
    })
    return {
      kind: 'AUDIO',
      title: titleFor(brief, capabilityLabel),
      content: audio.segments.map((segment) => `[${segment.at}s] ${segment.text}`).join('\n'),
      mimeType: 'text/plain',
      producedBy: audio.producedBy,
      modelGenerated: false,
      meta: { audio },
    }
  }

  const copy: GeneratedCopy = await copyGenerator(context, promptKeyFor(generation.platform, generation.request.option)).generateCopy(request)
  const poster: GeneratedImage = await (renderer as ImageGenerator).generateImage({
    ...request,
    title: titleFor(brief, capabilityLabel),
    subtitle: `${generation.platform.name} · ${capabilityLabel}`,
  })

  return {
    kind: 'IMAGE',
    title: titleFor(brief, capabilityLabel),
    // The asset *is* the poster, so the stored bytes are the SVG. The copy the
    // poster was built from travels alongside it in `meta` — serving the text
    // under an image mime type would hand the creator a file that cannot open.
    content: poster.svg,
    mimeType: 'image/svg+xml',
    producedBy: `${copy.producedBy} + ${poster.producedBy}`,
    modelGenerated: copy.modelGenerated,
    meta: {
      copy: { hook: copy.hook, body: copy.body, cta: copy.cta, hashtags: copy.hashtags },
      poster: { width: poster.width, height: poster.height, alt: poster.alt, producedBy: poster.producedBy },
      ...(limitNumber(request, /character/i) ? { characterLimit: limitNumber(request, /character/i) } : {}),
    },
  }
}

/** Matches the key the pipeline drafts prompts under: slug:capability:generation. */
function promptKeyFor(platform: SocialPlatform, option: string): string {
  return `${platform.slug}:${option}:generation`
}

function titleFor(brief: string, fallback: string): string {
  const cleaned = brief.replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return fallback
  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 79)}…`
}

export const generationRequestSchema = z.object({
  platform: z.string().min(1).max(60),
  option: z.string().min(1).max(80),
  brief: z.string().max(600).default(''),
  tone: z.string().max(60).optional(),
  targetSeconds: z.number().int().min(5).max(600).optional(),
})

/** A creator-facing view of one asset. */
export function assetView(asset: {
  id: string
  kind: AssetKind
  title: string
  sizeBytes: number
  producedBy: string
  modelGenerated: boolean
  createdAt: string
  platformSlug: string | null
  origin: MediaAsset['origin']
  mimeType: string
}): Record<string, unknown> {
  return {
    id: asset.id,
    kind: asset.kind,
    title: asset.title,
    sizeBytes: asset.sizeBytes,
    producedBy: asset.producedBy,
    madeWithAI: asset.modelGenerated,
    createdAt: asset.createdAt,
    platformSlug: asset.platformSlug,
    // Whether the creator made this or we did is something they are entitled to
    // see, not an internal detail.
    origin: asset.origin,
    mimeType: asset.mimeType,
  }
}

export { limitValue }
