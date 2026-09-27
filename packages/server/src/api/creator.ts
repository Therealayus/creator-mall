import {
  composeDraft,
  listPreferences,
  limitHintsFor,
  nowIso,
  recordObservation,
  recommendations,
  stableId,
  watchlistOrder,
} from '@creator-mall/core'
import { z } from 'zod'
import type {
  AdapterValidationIssue,
  ObservationKind,
  Recommendation,
  CreatorNotification,
  CreatorProfile,
  JsonValue,
  PlatformState,
  SocialPlatform,
  TrustLevel,
} from '@creator-mall/core'
import type { AppContext } from '../context.js'
import { publishingEnabled } from '../adapters/registry.js'
import { platformView } from './views.js'

/**
 * Everything in this module is creator-facing (§43).
 *
 * No capability keys, adapters, snapshots, trust levels or evolution events are
 * exposed. Creators see options, limits, reasons and sources.
 */

export interface CreatorOption {
  key: string
  label: string
  description: string
  enabled: boolean
  /** Plain-language reason an option is unavailable, or null when it is available. */
  unavailableReason: string | null
  media: 'NONE' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'ANY'
  limits: Array<{ label: string; display: string }>
}

export interface CreatorPlatformCard {
  slug: string
  name: string
  status: string
  /** True only when a verified integration can actually publish. */
  publishing: boolean
  publishingNote: string
  options: CreatorOption[]
  lastCheckedAt: string | null
  knowledgeFreshness: 'CURRENT' | 'STALE' | 'UNKNOWN'
}

export interface CreatorUpdateCard {
  id: string
  platform: string
  title: string
  body: string
  when: string
  read: boolean
  suggested: string[]
  /** Where the claim came from, in words a creator understands. */
  sourceKind: string
  sourceUrl: string | null
  whyUrl: string
}

export interface CreatorOverview {
  creator: { id: string; name: string; platforms: string[] }
  notice: string | null
  platforms: CreatorPlatformCard[]
  updates: CreatorUpdateCard[]
  comingSoon: Array<{ slug: string; name: string; stage: string; readinessPercent: number; note: string }>
  counts: { optionsReady: number; updatesToRead: number; platformsWatched: number }
}

const MEDIA_BY_KEY: Record<string, CreatorOption['media']> = {
  SHORT_VIDEO: 'VIDEO',
  LONG_VIDEO: 'VIDEO',
  IMAGE_POST: 'IMAGE',
  CAROUSEL: 'IMAGE',
  AUDIO: 'AUDIO',
  PODCAST_EPISODE: 'AUDIO',
}

/** Trust levels become words, never internal vocabulary. */
export function sourceKindWords(trustLevel: TrustLevel): string {
  switch (trustLevel) {
    case 'OFFICIAL':
      return "the platform's own documentation"
    case 'VERIFIED':
      return 'more than one independent report'
    case 'REPORTED':
      return 'a single industry report, not yet confirmed by the platform'
    case 'COMMUNITY_SIGNAL':
      return 'community discussion'
    case 'RUMOR':
      return 'an unconfirmed rumour'
    default:
      return 'a source we have not been able to confirm'
  }
}

export function creatorPlatformCard(context: AppContext, platform: SocialPlatform): CreatorPlatformCard {
  const view = platformView(context, platform)
  const state: PlatformState | null = context.control.latestSnapshot(platform.id)?.state ?? null

  const options: CreatorOption[] = view.uiConfig.options.map((option) => ({
    key: option.capabilityKey,
    label: option.label,
    description: option.description,
    enabled: option.enabled,
    unavailableReason: option.enabled ? null : (option.reason ?? 'Not available on this platform right now.'),
    media: MEDIA_BY_KEY[option.capabilityKey] ?? 'NONE',
    limits: limitHintsFor(option.capabilityKey, state).map((hint) => ({ label: hint.label, display: hint.display })),
  }))

  const publishing = view.canPublish
  const knowledge = context.control
    .knowledgeByPlatform(platform.id)
    .reduce<{ fresh: number; total: number }>(
      (acc, entry) => {
        if (!entry.version?.expiresAt) return { ...acc, total: acc.total + 1, fresh: acc.fresh + 1 }
        const fresh = new Date(entry.version.expiresAt).getTime() > Date.now()
        return { fresh: acc.fresh + (fresh ? 1 : 0), total: acc.total + 1 }
      },
      { fresh: 0, total: 0 },
    )

  return {
    slug: platform.slug,
    name: platform.name,
    status: platform.status,
    publishing,
    publishingNote: publishing
      ? 'Connected. We can publish for you.'
      : 'We are still preparing the connection for this platform, so publishing is off. Everything else works.',
    options,
    lastCheckedAt: view.snapshot?.capturedAt ?? null,
    knowledgeFreshness:
      knowledge.total === 0 ? 'UNKNOWN' : knowledge.fresh === knowledge.total ? 'CURRENT' : 'STALE',
  }
}

export function creatorUpdateCard(
  context: AppContext,
  notification: CreatorNotification,
  platformSlug: string,
): CreatorUpdateCard {
  const source = notification.sourceIds[0] ? context.control.getSource(notification.sourceIds[0]) : undefined
  const event = context.control.getEvent(notification.eventId)
  return {
    id: notification.id,
    platform: platformSlug,
    title: notification.title,
    body: notification.body,
    when: notification.createdAt,
    read: notification.readAt !== null,
    suggested: notification.actions,
    sourceKind: event ? sourceKindWords(event.trustLevel) : "the platform's own documentation",
    sourceUrl: source?.url ?? null,
    whyUrl: `/platforms/${platformSlug}`,
  }
}

export function creatorOverview(context: AppContext, creator: CreatorProfile | undefined): CreatorOverview {
  const platforms = context.control
    .listPlatforms()
    .filter((platform) => platform.status !== 'SUNSET')
    .map((platform) => creatorPlatformCard(context, platform))

  const notifications = creator ? context.control.listNotifications(creator.id) : []
  const updates = notifications
    .map((notification) => {
      const event = context.control.getEvent(notification.eventId)
      const platform = event?.platformId ? context.control.getPlatform(event.platformId) : undefined
      return creatorUpdateCard(context, notification, platform?.slug ?? '')
    })
    .sort((a, b) => b.when.localeCompare(a.when))

  const comingSoon = context.control
    .listPlatforms()
    .filter((platform) => platform.status !== 'ACTIVE' && platform.status !== 'SUNSET')
    .sort((a, b) => watchlistOrder(a.status) - watchlistOrder(b.status))
    .map((platform) => {
      const view = platformView(context, platform)
      return {
        slug: platform.slug,
        name: platform.name,
        stage: stageWords(platform.status),
        readinessPercent: view.readiness.overallPercent,
        note: `We already know which formats it supports. We are watching it so Creator Mall is ready the day it opens.`,
      }
    })

  return {
    creator: {
      id: creator?.id ?? '',
      name: creator?.displayName ?? 'Creator',
      platforms: creator?.platformSlugs ?? [],
    },
    notice: noticeFor(context, platforms),
    platforms,
    updates,
    comingSoon,
    counts: {
      optionsReady: platforms.reduce((total, platform) => total + platform.options.filter((option) => option.enabled).length, 0),
      updatesToRead: updates.filter((update) => !update.read).length,
      platformsWatched: platforms.length + comingSoon.length,
    },
  }
}

function noticeFor(context: AppContext, platforms: CreatorPlatformCard[]): string | null {
  const stale = platforms.filter((platform) => platform.knowledgeFreshness === 'STALE')
  if (stale.length === 0) return null
  return `We are refreshing what we know about ${stale.map((platform) => platform.name).join(', ')}. Some limits may be out of date until we finish.`
}

function stageWords(status: SocialPlatform['status']): string {
  switch (status) {
    case 'BETA':
      return 'In beta'
    case 'ANNOUNCED':
      return 'Announced'
    case 'COMING_SOON':
      return 'Coming soon'
    case 'EMERGING':
      return 'Emerging'
    case 'REGIONAL':
      return 'Regional'
    case 'DISCOVERED':
      return 'Newly spotted'
    default:
      return status
  }
}

export interface ValidateInput {
  platformSlug: string
  optionKey: string
  text: string
  mediaCount: number
}

export interface ValidateOutput {
  valid: boolean
  issues: Array<{ field: string; message: string; severity: 'ERROR' | 'WARNING' }>
  limits: Array<{ label: string; display: string }>
}

export async function validateForCreator(
  context: AppContext,
  input: ValidateInput,
): Promise<ValidateOutput> {
  const platform = context.control.getPlatform(input.platformSlug)
  if (!platform) {
    return { valid: false, issues: [{ field: 'platform', message: 'We do not know that platform yet.', severity: 'ERROR' }], limits: [] }
  }

  const snapshot = context.control.latestSnapshot(platform.id)
  const adapter = context.adapters.resolve(platform.slug, snapshot?.state ?? null, platform.capabilityKeys)
  const result = await adapter.validateContent({
    contentType: input.optionKey,
    text: input.text,
    mediaRefs: Array.from({ length: Math.max(0, input.mediaCount) }, (_, index) => `media-${index + 1}`),
  })

  return {
    valid: result.valid,
    issues: result.issues.map(toCreatorIssue),
    limits: limitHintsFor(input.optionKey, snapshot?.state ?? null).map((hint) => ({ label: hint.label, display: hint.display })),
  }
}

function toCreatorIssue(issue: AdapterValidationIssue): { field: string; message: string; severity: 'ERROR' | 'WARNING' } {
  return { field: issue.path, message: issue.message, severity: issue.severity }
}

export interface DraftOutput {
  hook: string
  body: string
  cta: string
  notes: string[]
  provenance: string
  prepared: boolean
  limits: Array<{ label: string; display: string }>
  publishing: boolean
  publishingNote: string
}

export function draftForCreator(
  context: AppContext,
  input: { platformSlug: string; optionKey: string; brief: string; tone?: string },
): DraftOutput {
  const platform = context.control.getPlatform(input.platformSlug)
  if (!platform) {
    return {
      hook: '',
      body: '',
      cta: '',
      notes: ['We do not know that platform yet.'],
      provenance: 'Unknown platform.',
      prepared: false,
      limits: [],
      publishing: false,
      publishingNote: 'Publishing is off for platforms we have not verified.',
    }
  }

  const definition = context.control.capabilities.get(input.optionKey)
  const snapshot = context.control.latestSnapshot(platform.id)
  const draft = composeDraft(
    {
      platformId: platform.id,
      platformName: platform.name,
      platformSlug: platform.slug,
      capabilityKey: input.optionKey,
      capabilityLabel: definition?.label ?? input.optionKey,
      brief: input.brief,
      ...(input.tone ? { tone: input.tone } : {}),
    },
    context.control.listTemplates(platform.id),
  )

  const canPublish = publishingEnabled(context.control, context.adapters, platform.id)

  return {
    hook: draft.hook,
    body: draft.body,
    cta: draft.cta,
    notes: draft.notes,
    provenance: draft.provenance,
    prepared: draft.source === 'TEMPLATE',
    limits: limitHintsFor(input.optionKey, snapshot?.state ?? null).map((hint) => ({ label: hint.label, display: hint.display })),
    publishing: canPublish,
    publishingNote: canPublish
      ? 'Connected. You can publish from here.'
      : 'Publishing is still being prepared for this platform.',
  }
}

export interface WhyOutput {
  optionKey: string
  label: string
  description: string
  available: boolean
  whatChanged: string
  when: string | null
  from: string
  weUpdated: string | null
  sources: Array<{ name: string; url: string | null }>
  pendingReview: string[]
}

/** §35 in creator language: what changed, when, from where, and what we did. */
export function whyForCreator(
  context: AppContext,
  platformSlug: string,
  optionKey: string,
): WhyOutput | null {
  const platform = context.control.getPlatform(platformSlug)
  if (!platform) return null

  const events = context.control.eventsForCapability(platform.id, optionKey)
  const latest = events[0]
  const definition = context.control.capabilities.get(optionKey)
  const view = platformView(context, platform)
  const option = view.uiConfig.options.find((entry) => entry.capabilityKey === optionKey)
  const sources = (latest?.sourceIds ?? [])
    .map((id) => context.control.getSource(id))
    .filter((source): source is NonNullable<typeof source> => Boolean(source))
    .map((source) => ({ name: source.name, url: source.url }))

  const proposals = context.control
    .listProposals({ status: 'PENDING_REVIEW' })
    .filter((proposal) => proposal.eventId && events.some((event) => event.id === proposal.eventId))

  return {
    optionKey,
    label: definition?.label ?? optionKey,
    description: definition?.description ?? '',
    available: option?.enabled ?? false,
    whatChanged: latest ? latest.creatorSummary : 'We have not seen a confirmed change for this option yet.',
    when: latest?.verifiedAt ?? latest?.detectedAt ?? null,
    from: latest ? sourceKindWords(latest.trustLevel) : 'no confirmed source yet',
    weUpdated: latest?.approvedBy ? `Updated after review by ${latest.approvedBy}.` : latest?.verifiedAt ? `Updated automatically on ${latest.verifiedAt.slice(0, 10)}.` : null,
    sources,
    pendingReview: proposals.map((proposal) => proposal.title),
  }
}

// ── Personalisation (§31) ───────────────────────────────────────────────────

export const observationSchema = z.object({
  kind: z.enum([
    'OPTION_CHOSEN',
    'DRAFT_ACCEPTED',
    'DRAFT_EDITED',
    'DRAFT_REJECTED',
    'PLATFORM_ADDED',
    'PLATFORM_REMOVED',
    'LIMIT_WARNING_HIT',
    'UPDATE_OPENED',
    'UPDATE_DISMISSED',
  ]),
  subject: z.string().max(200).default(''),
  detail: z.string().max(400).nullish(),
  platformSlug: z.string().max(60).nullish(),
})

export interface PersonalisationView {
  /** What the system believes, and why, in the creator's own words. */
  preferences: Array<{
    id: string
    key: string
    label: string
    value: string
    why: string
    evidence: string[]
    confidence: number
    occurrences: number
    enabled: boolean
  }>
  suggestions: Recommendation[]
  /** Whether anything has been learned at all. */
  learningAnything: boolean
  notice: string
}

const NO_LEARNING_NOTICE =
  'We only learn from what you do here, and only to suggest defaults. You can turn any of it off, forget it, or reset everything.'

export function personalisationFor(context: AppContext, creatorId: string): PersonalisationView {
  const store = context.control.preferences
  const preferences = listPreferences(store, creatorId).map((preference) => ({
    id: preference.id,
    key: preference.key,
    label: preference.label,
    value: preference.value,
    why: preference.description,
    evidence: preference.evidence,
    confidence: preference.confidence,
    occurrences: preference.occurrences,
    enabled: preference.enabled,
  }))

  const suggestions = recommendations(store, creatorId)
  return {
    preferences,
    suggestions,
    learningAnything: preferences.length > 0,
    notice:
      preferences.length > 0
        ? 'These are suggestions only. Nothing is published or changed without you.'
        : NO_LEARNING_NOTICE,
  }
}

export function recordCreatorObservation(
  context: AppContext,
  creatorId: string,
  input: { kind: ObservationKind; subject: string; detail?: string | null; platformSlug?: string | null },
): { learned: number; changed: string[] } {
  const result = recordObservation(context.control.preferences, {
    id: stableId('obs', creatorId, input.kind, input.subject, nowIso()),
    creatorId,
    kind: input.kind,
    at: nowIso(),
    subject: input.subject,
    detail: input.detail ?? null,
    platformSlug: input.platformSlug ?? null,
  })
  return { learned: result.learned.length, changed: result.changed.map((preference) => preference.key) }
}

export function stateSummary(state: PlatformState | null): JsonValue {
  return (state ?? null) as unknown as JsonValue
}
