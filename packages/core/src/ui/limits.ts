import type { JsonObject, JsonValue, PlatformState } from '../types/platform.js'
import { normalizeCapabilityKey } from '../capabilities/registry.js'

export interface LimitHint {
  path: string
  label: string
  /** Creator-facing rendering of the value, e.g. "90 seconds". */
  display: string
  value: JsonValue
}

/**
 * Which verified limits matter for which creation option.
 *
 * This is product knowledge, not platform knowledge: it maps an option to the
 * fields of a platform snapshot that a creator needs to see before writing.
 * Adding a platform never requires editing this table.
 */
const HINTS: Record<string, ReadonlyArray<{ path: string; label: string; format?: 'duration' | 'characters' | 'size' | 'count' }>> = {
  SHORT_VIDEO: [
    { path: 'limits.video.maxDurationSeconds', label: 'Maximum length', format: 'duration' },
    { path: 'limits.media.maxFileSizeMb', label: 'Maximum file size', format: 'size' },
  ],
  LONG_VIDEO: [
    { path: 'limits.video.maxDurationSeconds', label: 'Maximum length', format: 'duration' },
    { path: 'limits.media.maxFileSizeMb', label: 'Maximum file size', format: 'size' },
  ],
  VIDEO_MEDIA: [{ path: 'limits.media.maxFileSizeMb', label: 'Maximum file size', format: 'size' }],
  TEXT_POST: [
    { path: 'limits.text.maxCharacters', label: 'Maximum length', format: 'characters' },
    { path: 'limits.text.maxHashtags', label: 'Hashtags allowed', format: 'count' },
  ],
  THREAD: [{ path: 'limits.text.maxCharacters', label: 'Characters per post', format: 'characters' }],
  ARTICLE: [{ path: 'limits.text.maxCharacters', label: 'Maximum length', format: 'characters' }],
  CAROUSEL: [{ path: 'limits.media.maxImages', label: 'Maximum items', format: 'count' }],
  IMAGE_POST: [
    { path: 'limits.media.maxImages', label: 'Maximum items', format: 'count' },
    { path: 'limits.media.maxFileSizeMb', label: 'Maximum file size', format: 'size' },
  ],
  STORY: [{ path: 'limits.text.maxCharacters', label: 'Maximum length', format: 'characters' }],
  POLL: [{ path: 'limits.text.maxCharacters', label: 'Maximum length', format: 'characters' }],
}

export function limitHintsFor(capabilityKey: string, state: PlatformState | null): LimitHint[] {
  if (!state) return []
  const hints = HINTS[normalizeCapabilityKey(capabilityKey)]
  if (!hints) return []
  const result: LimitHint[] = []
  for (const hint of hints) {
    const value = readPath(state, hint.path)
    if (value === null) continue
    result.push({ path: hint.path, label: hint.label, value, display: formatValue(value, hint.format) })
  }
  return result
}

function readPath(state: PlatformState, path: string): JsonValue | null {
  let current: unknown = state
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null
    const value = (current as JsonObject)[segment]
    if (value === undefined || value === null) return null
    current = value
  }
  return current as JsonValue
}

function formatValue(value: JsonValue, format?: 'duration' | 'characters' | 'size' | 'count'): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return typeof value === 'string' ? value : JSON.stringify(value) ?? ''

  switch (format) {
    case 'duration':
      return formatDuration(numeric)
    case 'characters':
      return `${numeric.toLocaleString('en-US')} characters`
    case 'size':
      return numeric >= 1024 ? `${Math.round(numeric / 102.4) / 10} GB` : `${numeric} MB`
    case 'count':
      return String(numeric)
    default:
      return String(numeric)
  }
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} ${plural(seconds / 3600, 'hour')}`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} ${plural(seconds / 60, 'minute')}`
  return `${seconds} ${plural(seconds, 'second')}`
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}
