/**
 * Personalisation view logic. Pure, so the wording and the rules are tested
 * without a browser.
 */

export interface PreferenceView {
  id: string
  label: string
  value: string
  why: string
  evidence: string[]
  confidence: number
  occurrences: number
  enabled: boolean
}

export interface PersonalisationViewModel {
  headline: string
  notice: string
  preferences: PreferenceView[]
  suggestions: Array<{ key: string; label: string; value: string; why: string; confidence: number }>
  /** Whether the creator is seeing the empty state or the real thing. */
  empty: boolean
}

function humanise(value: string): string {
  return value
    .replace(/-/g, ' ')
    .replace(/^\w/, (character) => character.toUpperCase())
}

export function confidenceWords(confidence: number): string {
  if (confidence >= 0.8) return 'we are confident'
  if (confidence >= 0.5) return 'we think so'
  return 'we are still unsure'
}

export function buildPersonalisation(
  view: {
    preferences: PreferenceView[]
    suggestions: Array<{ key: string; label: string; value: string; why: string; confidence: number }>
    notice: string
  } | null,
): PersonalisationViewModel {
  if (!view || view.preferences.length === 0) {
    return {
      headline: 'Nothing learned yet',
      notice: 'Once you create a few posts, we may suggest defaults based on what you keep doing. You can turn that off at any time.',
      preferences: [],
      suggestions: [],
      empty: true,
    }
  }

  const sorted = [...view.preferences].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return b.occurrences - a.occurrences
  })

  return {
    headline: `We learned ${sorted.length} thing${sorted.length === 1 ? '' : 's'} from how you work`,
    notice: view.notice,
    preferences: sorted,
    suggestions: view.suggestions,
    empty: false,
  }
}

export function preferenceSentence(preference: PreferenceView): string {
  const state = preference.enabled ? 'In use' : 'Turned off'
  return `${preference.label}: ${humanise(preference.value)} · ${state} · ${confidenceWords(preference.confidence)}`
}

export function evidenceSentences(preference: PreferenceView): string[] {
  if (preference.evidence.length === 0) return []
  return preference.evidence.map((entry) => `You ${entry}.`)
}
