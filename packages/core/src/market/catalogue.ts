import type { KnowledgeFact } from '../types/knowledge.js'
import type { SocialPlatform } from '../types/platform.js'
import type { Source } from '../types/source.js'
import type { TrustLevel } from '../types/enums.js'
import { stableId } from '../util.js'

/**
 * The Market Engine: what a creator can actually use, and why we believe it.
 *
 * The World Engine verifies claims about platforms. The Market Engine turns
 * those verified claims into a catalogue of tools, endpoints and official
 * reading, and it inherits one rule from the whole system:
 *
 *   **nothing appears here without verified evidence.**
 *
 * There is no curated partner list, no affiliate placement and no ranking in
 * this module. A tool exists because an official or verified source documented
 * it; if that source goes away or the claim is retracted, the entry goes with
 * it. That is deliberately a smaller product than a marketplace, and it is the
 * only version of one we are willing to ship.
 */

export type CreatorToolKind = 'FEATURE' | 'ENDPOINT' | 'RESOURCE'

/** How well supported a tool is. Never better than the evidence behind it. */
export type ToolConfidence = 'CONFIRMED' | 'LIKELY'

export interface ToolEvidence {
  sourceName: string
  sourceUrl: string | null
  trustLevel: TrustLevel
  verifiedAt: string | null
  /** Short verbatim support, for the "why do we believe this?" view. */
  excerpt: string | null
}

export interface CreatorTool {
  id: string
  platformSlug: string
  platformName: string
  capabilityKey: string | null
  capabilityLabel: string
  name: string
  whatItDoes: string
  kind: CreatorToolKind
  url: string | null
  evidence: ToolEvidence[]
  confidence: ToolConfidence
  lastCheckedAt: string | null
}

export interface CatalogueInput {
  platforms: SocialPlatform[]
  /** Facts the World Engine has verified, keyed by id. */
  facts: Iterable<KnowledgeFact>
  sources: Source[]
  /** capabilityKey → creator-facing label, from the capability registry. */
  capabilityLabels: Map<string, string>
}

/** Only these source types may back a tool. */
const TRUSTED_SOURCE_TYPES = new Set(['OFFICIAL', 'DOCUMENTATION', 'DEVELOPER', 'API'])

/** Only these trust levels may back a tool. */
const TRUSTED_LEVELS = new Set<TrustLevel>(['OFFICIAL', 'VERIFIED'])

/** Claim shapes we understand well enough to describe to a creator. */
const TOOL_CLAIM = /\b(tool|feature|endpoint|api|studio|business suite|creator studio|analytics|scheduler|editing|editing tool)\b/i

/**
 * Builds the catalogue.
 *
 * Facts arrive already filtered by the World Engine, so this only has to decide
 * what a creator may be shown and how confident we are allowed to sound.
 */
export function buildToolCatalogue(input: CatalogueInput): CreatorTool[] {
  const platformsById = new Map(input.platforms.map((platform) => [platform.id, platform]))
  const sourcesById = new Map(input.sources.map((source) => [source.id, source]))
  const tools: CreatorTool[] = []

  for (const fact of input.facts) {
    // A retracted, superseded or expired claim is not something to recommend.
    if (fact.status !== 'CURRENT') continue
    if (!fact.verifiedAt) continue
    if (!TRUSTED_LEVELS.has(fact.trustLevel)) continue
    if (!TOOL_CLAIM.test(fact.statement)) continue

    const platform = fact.platformId ? platformsById.get(fact.platformId) : null
    if (!platform) continue

    const evidence: ToolEvidence[] = []
    for (const sourceId of fact.sourceIds) {
      const source = sourcesById.get(sourceId)
      if (!source) continue
      if (!TRUSTED_SOURCE_TYPES.has(source.sourceType)) continue
      if (!TRUSTED_LEVELS.has(source.trustLevel)) continue
      if (!source.active) continue
      evidence.push({
        sourceName: source.name,
        sourceUrl: source.url,
        trustLevel: source.trustLevel,
        verifiedAt: source.lastCheckedAt,
        excerpt: fact.evidence ?? null,
      })
    }

    // No verified source behind it means we do not put it in front of anyone.
    if (evidence.length === 0) continue

    const capabilityKey = capabilityFor(fact.key)
    tools.push({
      id: stableId('tool', platform.slug, fact.key),
      platformSlug: platform.slug,
      platformName: platform.name,
      capabilityKey,
      capabilityLabel: capabilityKey ? (input.capabilityLabels.get(capabilityKey) ?? capabilityKey) : 'General',
      name: nameFor(fact),
      whatItDoes: fact.statement,
      kind: kindFor(fact),
      url: evidence[0]?.sourceUrl ?? null,
      evidence,
      confidence: confidenceFor(evidence, fact),
      lastCheckedAt: evidence.map((entry) => entry.verifiedAt).filter(Boolean).sort().at(-1) ?? null,
    })
  }

  return tools
}

/** Official reading and documentation, straight from the curated source registry. */
export function buildResourceCatalogue(input: {
  platforms: SocialPlatform[]
  sources: Source[]
  capabilityLabels: Map<string, string>
}): CreatorTool[] {
  const platformsBySlug = new Map(input.platforms.map((platform) => [platform.slug, platform]))
  const resources: CreatorTool[] = []

  for (const source of input.sources) {
    if (!source.platform) continue
    if (!source.active) continue
    if (!TRUSTED_SOURCE_TYPES.has(source.sourceType)) continue
    if (!TRUSTED_LEVELS.has(source.trustLevel)) continue

    const platform = platformsBySlug.get(source.platform)
    if (!platform) continue

    resources.push({
      id: stableId('tool', platform.slug, source.url),
      platformSlug: platform.slug,
      platformName: platform.name,
      capabilityKey: null,
      capabilityLabel: 'Official reading',
      name: source.name,
      whatItDoes: `${source.name} is the ${describeSourceType(source.sourceType)} we check for ${platform.name}.`,
      kind: 'RESOURCE',
      url: source.url,
      evidence: [
        {
          sourceName: source.name,
          sourceUrl: source.url,
          trustLevel: source.trustLevel,
          verifiedAt: source.lastCheckedAt,
          excerpt: null,
        },
      ],
      confidence: source.trustLevel === 'OFFICIAL' ? 'CONFIRMED' : 'LIKELY',
      lastCheckedAt: source.lastCheckedAt,
    })
  }

  return resources
}

/**
 * One catalogue, both kinds. Sorted so the best-supported entry for a platform
 * comes first, and a creator never has to wonder why something is missing: it
 * simply is not verified.
 */
export function creatorTools(input: CatalogueInput): CreatorTool[] {
  const facts = [...input.facts]
  return [...buildToolCatalogue({ ...input, facts }), ...buildResourceCatalogue(input)].sort(
    (a, b) => rankFor(a) - rankFor(b) || a.name.localeCompare(b.name),
  )
}

function rankFor(tool: CreatorTool): number {
  // Confidence first, then usefulness: official reading is a fallback for a
  // creator with nothing else, never the headline.
  const confidence = tool.confidence === 'CONFIRMED' ? 0 : 2
  return confidence + (tool.kind === 'RESOURCE' ? 1 : 0)
}

/** `instagram:limits.video.maxDurationSeconds` → the capability it speaks about. */
function capabilityFor(factKey: string): string | null {
  const match = /^[a-z0-9-]+:(?:limits|policy|feature|api)\.([a-z_]+)/i.exec(factKey)
  if (!match) return null
  const segment = match[1]!
  if (segment === 'video') return 'SHORT_VIDEO'
  if (segment === 'image' || segment === 'photo') return 'IMAGE_POST'
  if (segment === 'carousel') return 'CAROUSEL'
  if (segment === 'story') return 'STORY'
  if (segment === 'text') return 'TEXT_POST'
  if (segment === 'article') return 'ARTICLE'
  return segment.toUpperCase()
}

function kindFor(fact: KnowledgeFact): CreatorToolKind {
  if (/\bendpoint\b|\bapi\b/i.test(fact.statement) || fact.key.includes('.api.')) return 'ENDPOINT'
  return 'FEATURE'
}

/** A short name, preferring the platform's own wording inside the statement. */
function nameFor(fact: KnowledgeFact): string {
  const first = fact.statement.split(/[.;:]/)[0]?.trim() ?? fact.statement
  const words = first.split(/\s+/)
  return (words.length > 9 ? words.slice(0, 9).join(' ') : first).replace(/[.,;:]$/, '')
}

function confidenceFor(evidence: ToolEvidence[], fact: KnowledgeFact): ToolConfidence {
  // Only an official claim from an official source may be stated as confirmed.
  // Everything else is offered as likely, which is what it actually is.
  if (fact.trustLevel === 'OFFICIAL' && evidence.some((entry) => entry.trustLevel === 'OFFICIAL')) {
    return 'CONFIRMED'
  }
  return 'LIKELY'
}

function describeSourceType(sourceType: string): string {
  const descriptions: Record<string, string> = {
    OFFICIAL: 'official page',
    DOCUMENTATION: 'official documentation',
    DEVELOPER: 'developer documentation',
    API: 'official API reference',
  }
  return descriptions[sourceType] ?? 'official page'
}
