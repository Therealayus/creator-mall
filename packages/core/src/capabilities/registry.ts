import type { CapabilityDefinition } from '../types/platform.js'
import { nowIso, slugify, titleCase } from '../util.js'
import { capabilityDefinitionId, seededCapabilityDefinitions } from './taxonomy.js'

export interface CapabilityMatch {
  key: string
  label: string
  matchedSignals: string[]
  score: number
}

/**
 * §8: the capability registry. It is open — a platform can introduce something
 * genuinely new and the product registers a definition for it at runtime, then
 * asks the Evolution Engine to plan the work (§9).
 */
export class CapabilityRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>()
  private readonly aliases = new Map<string, string>()

  constructor(seed: ReadonlyArray<CapabilityDefinition> = seededCapabilityDefinitions()) {
    for (const definition of seed) this.register(definition, { allowNew: true })
  }

  register(definition: CapabilityDefinition, options: { allowNew: boolean } = { allowNew: true }): CapabilityDefinition {
    const key = normalizeCapabilityKey(definition.key)
    if (!key) throw new Error('capability key must be non-empty')
    if (!options.allowNew && !this.definitions.has(key)) {
      throw new Error(`unknown capability: ${key}`)
    }
    const existing = this.definitions.get(key)
    const stored: CapabilityDefinition = {
      ...definition,
      key,
      createdAt: existing?.createdAt ?? definition.createdAt,
      origin: existing?.origin === 'SEED' ? 'SEED' : definition.origin,
      surfaces: definition.surfaces.length > 0 ? [...definition.surfaces] : (existing?.surfaces ?? []),
    }
    this.definitions.set(key, stored)
    for (const signal of stored.signals ?? []) this.aliases.set(normalizeSignal(signal), key)
    this.aliases.set(key.toLowerCase(), key)
    this.aliases.set(normalizeSignal(stored.label), key)
    return stored
  }

  /** Registers a brand-new capability derived from observed language. */
  proposeFromSignal(key: string, label: string, domain: CapabilityDefinition['domain']): CapabilityDefinition {
    return this.register(
      {
        key,
        label,
        description: `${label} support on this platform.`,
        domain,
        surfaces: ['create-menu'],
        signals: [key.replace(/_/g, ' ')],
        origin: 'DETECTED',
        createdAt: nowIso(),
      },
      { allowNew: true },
    )
  }

  get(key: string): CapabilityDefinition | undefined {
    return this.definitions.get(normalizeCapabilityKey(key))
  }

  has(key: string): boolean {
    return this.definitions.has(normalizeCapabilityKey(key))
  }

  all(): CapabilityDefinition[] {
    return [...this.definitions.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
  }

  byDomain(domain: CapabilityDefinition['domain']): CapabilityDefinition[] {
    return this.all().filter((definition) => definition.domain === domain)
  }

  /** Maps free text ("vertical shorts") onto known capability keys. */
  matchSignals(text: string): CapabilityMatch[] {
    const haystack = normalizeSignal(text)
    if (!haystack) return []
    const scores = new Map<string, { matched: string[]; score: number }>()
    for (const [alias, key] of this.aliases) {
      if (!alias || !haystack.includes(alias)) continue
      const entry = scores.get(key) ?? { matched: [], score: 0 }
      entry.matched.push(alias)
      entry.score += alias.includes(' ') ? 2 : 1
      scores.set(key, entry)
    }
    return [...scores.entries()]
      .map(([key, entry]) => {
        const definition = this.definitions.get(key)
        return {
          key,
          label: definition?.label ?? titleCase(key),
          matchedSignals: entry.matched,
          score: entry.score,
        }
      })
      .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
  }

  /** Derives a stable, readable key from an unknown phrase ("new vertical format"). */
  deriveKey(phrase: string): string {
    const words = phrase
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
      .slice(0, 3)
    return normalizeCapabilityKey(words.join('_')) || normalizeCapabilityKey(slugify(phrase)) || 'UNKNOWN_CAPABILITY'
  }

  ids(): string[] {
    return this.all().map((definition) => capabilityDefinitionId(definition.key))
  }
}

const STOP_WORDS = new Set([
  'new',
  'the',
  'and',
  'for',
  'with',
  'platform',
  'feature',
  'format',
  'support',
  'now',
  'all',
  'any',
])

export function normalizeCapabilityKey(key: string): string {
  return key
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s.+#]/g, ' ').replace(/\s+/g, ' ').trim()
}
