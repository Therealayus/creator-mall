import type {
  AssetKind,
  AssetSummary,
  ComingSoonCard,
  CreatorOption,
  CreatorPlatformCard,
  CreatorToolCard,
  CreatorUpdateCard,
  LimitHint,
  ValidationResult,
  WhyAnswer,
} from './api.js'

/**
 * Pure view logic.
 *
 * Everything the creator sees is derived here from API data, so it can be tested
 * without a browser. No component computes product rules of its own.
 */

export interface OptionGroup {
  media: CreatorOption['media']
  title: string
  hint: string
  options: CreatorOption[]
}

const MEDIA_SECTIONS: Array<{ media: CreatorOption['media']; title: string; hint: string }> = [
  { media: 'NONE', title: 'Words', hint: 'Posts written for people to read.' },
  { media: 'IMAGE', title: 'Images', hint: 'Posts built from photos or graphics.' },
  { media: 'VIDEO', title: 'Video', hint: 'Posts people watch.' },
  { media: 'AUDIO', title: 'Audio', hint: 'Posts people listen to.' },
]

export function groupOptions(options: ReadonlyArray<CreatorOption>): OptionGroup[] {
  return MEDIA_SECTIONS.map((section) => ({
    ...section,
    options: options.filter((option) => option.media === section.media),
  })).filter((group) => group.options.length > 0)
}

export function mediaPrompt(media: CreatorOption['media']): string {
  switch (media) {
    case 'VIDEO':
      return 'Add a video'
    case 'IMAGE':
      return 'Add images'
    case 'AUDIO':
      return 'Add audio'
    default:
      return 'No file needed'
  }
}

export function limitSummary(limits: ReadonlyArray<LimitHint>): string {
  if (limits.length === 0) return 'We have not confirmed the exact limits for this option yet.'
  return limits.map((limit) => `${limit.label}: ${limit.display}`).join(' · ')
}

export function hasCharacterLimit(limits: ReadonlyArray<LimitHint>): LimitHint | null {
  return limits.find((limit) => /character/i.test(limit.display)) ?? null
}

export interface CharacterCounter {
  used: number
  max: number | null
  over: boolean
  percent: number | null
  message: string | null
}

export function characterCounter(text: string, limits: ReadonlyArray<LimitHint>): CharacterCounter {
  const limit = hasCharacterLimit(limits)
  const used = text.length
  if (!limit) {
    return { used, max: null, over: false, percent: null, message: null }
  }
  const max = Number(limit.display.replace(/[^0-9]/g, ''))
  if (!Number.isFinite(max) || max <= 0) {
    return { used, max: null, over: false, percent: null, message: null }
  }
  const over = used > max
  return {
    used,
    max,
    over,
    percent: Math.min(100, Math.round((used / max) * 100)),
    message: over ? `${used - max} characters over the limit` : `${max - used} characters left`,
  }
}

export function statusWords(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'Live'
    case 'BETA':
      return 'In beta'
    case 'COMING_SOON':
      return 'Coming soon'
    case 'EMERGING':
      return 'Emerging'
    case 'ANNOUNCED':
      return 'Announced'
    case 'REGIONAL':
      return 'Regional'
    case 'DISCOVERED':
      return 'Newly spotted'
    case 'SUNSET':
      return 'Closing down'
    default:
      return status
  }
}

export function freshnessWords(freshness: CreatorPlatformCard['knowledgeFreshness']): string {
  switch (freshness) {
    case 'CURRENT':
      return 'Up to date'
    case 'STALE':
      return 'Being refreshed'
    default:
      return 'Not checked yet'
  }
}

export function platformHeadline(platform: CreatorPlatformCard): string {
  const ready = platform.options.filter((option) => option.enabled).length
  if (ready === 0) return 'We have not confirmed what you can post here yet.'
  if (!platform.publishing) return `${ready} options ready · publishing still being prepared`
  return `${ready} options ready · connected`
}

export function platformUsable(platform: CreatorPlatformCard): boolean {
  return platform.options.some((option) => option.enabled)
}

export function enabledOptions(platform: CreatorPlatformCard): CreatorOption[] {
  return platform.options.filter((option) => option.enabled)
}

export interface FeedSection {
  platform: string
  updates: CreatorUpdateCard[]
}

export function groupUpdates(updates: ReadonlyArray<CreatorUpdateCard>): FeedSection[] {
  const sections = new Map<string, CreatorUpdateCard[]>()
  for (const update of updates) {
    const key = update.platform || 'general'
    const bucket = sections.get(key)
    if (bucket) bucket.push(update)
    else sections.set(key, [update])
  }
  return [...sections.entries()]
    .map(([platform, items]) => ({ platform, updates: items }))
    .sort((a, b) => b.updates.length - a.updates.length || (a.platform < b.platform ? -1 : 1))
}

export function unreadCount(updates: ReadonlyArray<CreatorUpdateCard>): number {
  return updates.filter((update) => !update.read).length
}

export function readinessStage(percent: number): string {
  if (percent >= 80) return 'Almost ready'
  if (percent >= 50) return 'Getting ready'
  if (percent >= 20) return 'Early days'
  return 'Just spotted'
}

export function comingSoonSorted(cards: ReadonlyArray<ComingSoonCard>): ComingSoonCard[] {
  return [...cards].sort((a, b) => b.readinessPercent - a.readinessPercent)
}

export function validationHeadline(result: ValidationResult | null): string {
  if (!result) return ''
  if (result.valid && result.issues.length === 0) return 'Ready to post'
  const errors = result.issues.filter((issue) => issue.severity === 'ERROR')
  if (errors.length === 0) return 'Ready to post, with a note'
  return errors.length === 1 ? 'One thing to fix' : `${errors.length} things to fix`
}

export function whyHeadline(why: WhyAnswer): string {
  return why.available ? `${why.label} is available` : `${why.label} is not available right now`
}

export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

/** What an asset is, in the creator's words rather than ours. */
export function assetKindLabel(kind: AssetKind): string {
  const labels: Record<AssetKind, string> = {
    IMAGE: 'Poster',
    VIDEO: 'Video',
    AUDIO: 'Audio',
    TEXT: 'Text',
    STORYBOARD: 'Shot list',
  }
  return labels[kind]
}

/**
 * One honest line about an asset: what made it, and whether a model was
 * involved. A rendered artifact must never be described as AI output.
 */
export function assetHeadline(asset: AssetSummary, now: number = Date.now()): string {
  const kind = assetKindLabel(asset.kind)
  const made = asset.origin === 'UPLOADED' ? 'You added this' : 'We made this for you'
  const author = asset.madeWithAI ? 'Written by a model' : 'Made here, not by a model'
  return `${kind} · ${made} · ${author} · ${relativeTime(asset.createdAt, now)}`
}

/** Only image types get an inline preview; anything else gets a link. */
export function isPreviewable(asset: AssetSummary): boolean {
  return asset.mimeType.startsWith('image/')
}

export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** What sort of thing this is, in words a creator would use. */
export function toolKindWords(kind: CreatorToolCard['kind']): string {
  const words: Record<CreatorToolCard['kind'], string> = {
    FEATURE: 'A feature on the platform',
    ENDPOINT: 'An official way to connect your own tools',
    RESOURCE: 'Official reading',
  }
  return words[kind]
}

/** A platform heading for a group of tools. */
export function toolGroupHeading(tools: ReadonlyArray<CreatorToolCard>): string {
  return tools[0]?.platformName ?? 'Tools'
}

/**
 * The password rule, in one place.
 *
 * The server enforces this too. Saying it here means a creator is told what is
 * wrong before they submit, rather than after a round trip.
 */
export const PASSWORD_HELP = 'At least 10 characters, with a letter and a number.'

export function passwordProblems(password: string): string[] {
  const problems: string[] = []
  if (password.length < 10) problems.push('Use at least 10 characters.')
  if (!/[A-Za-z]/.test(password)) problems.push('Include at least one letter.')
  if (!/[0-9]/.test(password)) problems.push('Include at least one number.')
  return problems
}

/**
 * Paths that must work without a session.
 *
 * `App` renders the sign-in page for *every* route once nobody is signed in, so
 * account recovery cannot live in the route table or it becomes unreachable
 * exactly when it is needed. It is matched here instead, above the gate.
 */
export const PUBLIC_PATHS: ReadonlyArray<string> = ['/reset-password', '/verify-email']

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname)
}
