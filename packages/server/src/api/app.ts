import cors from 'cors'
import express from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZodError, z } from 'zod'
import { buildHealthReport, scoreSource, summariseCuration } from '@creator-mall/core'
import type { AppContext } from '../context.js'
import {
  applyProposalDecision,
  creatorUpdates,
  evolutionSummary,
  explainCapability,
  knowledgeSearch,
  platformView,
} from './views.js'
import { renderEvolutionCenter } from './evolution-center.js'
import { runResearchCycle, sourceStats } from '../world-engine/pipeline.js'
import {
  creatorOverview,
  creatorTools as creatorToolsView,
  draftForCreator,
  validateForCreator,
  whyForCreator,
} from './creator.js'
import { attachSession, authRoutes, requireAuth } from './auth.js'
import { ASSET_KINDS } from '@creator-mall/core'
import type { AssetKind } from '@creator-mall/core'
import { forgetPreference, resetPersonalization, setPreferenceEnabled } from '@creator-mall/core'
import { assetView, generate, generationRequestSchema } from '../creator-engine.js'
import { observationSchema, personalisationFor, recordCreatorObservation } from './creator.js'

export function createApp(context: AppContext): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(cors())
  app.use(express.json({ limit: '256kb' }))
  // Identity first: every later guard can rely on request.account / request.session.
  app.use(attachSession(context))
  app.use('/api/auth', authRoutes(context))
  // Operator surfaces: platforms directory, source registry, evolution log, knowledge.
  // All of them need the admin role; the creator API below is per-account.
  app.use(['/api/platforms', '/api/sources', '/api/evolution', '/api/knowledge'], adminGuard(context))
  app.use('/api/admin', adminGuard(context))

  app.get('/api/health', (_request, response) => {
    const { control } = context
    const report = buildHealthReport({
      sources: control.listSources(),
      currentVersions: control.currentKnowledgeVersions(),
      events: control.listEvents(),
      proposals: control.listProposals(),
      lastRun: control.listJobRuns(1)[0]
        ? { status: control.listJobRuns(1)[0]!.status, at: control.listJobRuns(1)[0]!.finishedAt }
        : null,
      integrationHealth: {},
    })
    response.json({ status: 'ok', startedAt: context.startedAt, health: report })
  })

  app.get('/api/platforms', (_request, response) => {
    response.json({
      platforms: context.control.listPlatforms().map((platform) => ({
        id: platform.id,
        slug: platform.slug,
        name: platform.name,
        kind: platform.kind,
        status: platform.status,
        trustLevel: platform.trustLevel,
        integrationState: platform.integrationState,
        capabilityCount: platform.capabilityKeys.length,
        lastSnapshotAt: context.control.latestSnapshot(platform.id)?.capturedAt ?? null,
      })),
    })
  })

  app.get('/api/platforms/:platformId', (request, response) => {
    const platform = context.control.getPlatform(request.params.platformId ?? '')
    if (!platform) return response.status(404).json({ error: 'unknown platform' })
    return response.json(platformView(context, platform))
  })

  app.get('/api/platforms/:platformId/timeline', (request, response) => {
    const platform = context.control.getPlatform(request.params.platformId ?? '')
    if (!platform) return response.status(404).json({ error: 'unknown platform' })
    return response.json({ platformId: platform.id, entries: platformView(context, platform).timeline })
  })

  app.get('/api/platforms/:platformId/why', (request, response) => {
    const platform = context.control.getPlatform(request.params.platformId ?? '')
    if (!platform) return response.status(404).json({ error: 'unknown platform' })
    const capabilityKey = queryString(request.query.capability)
    if (!capabilityKey) return response.status(400).json({ error: 'capability query parameter is required' })
    return response.json(explainCapability(context, platform, capabilityKey))
  })

  app.get('/api/sources', (_request, response) => {
    const now = Date.now()
    const sources = context.control.listSources()
    const scored = sources.map((source) => ({ source, score: scoreSource(source, sourceStats(source), now) }))

    response.json({
      curation: summariseCuration(scored),
      sources: scored.map(({ source, score }) => ({
        id: source.id,
        name: source.name,
        url: source.url,
        domain: source.domain,
        sourceType: source.sourceType,
        platform: source.platform,
        trustLevel: source.trustLevel,
        active: source.active,
        lastStatus: source.lastStatus,
        lastCheckedAt: source.lastCheckedAt,
        nextCheckAt: source.nextCheckAt,
        consecutiveFailures: source.consecutiveFailures,
        lastError: source.lastError ?? null,
        tier: score.tier,
        score: score.score,
        action: score.action,
        summary: score.summary,
        reasons: score.reasons,
        stats: sourceStats(source),
      })),
    })
  })

  // Retiring a source stops the requests but keeps the knowledge it produced.
  const curationSchema = z.object({ active: z.boolean() })

  app.post('/api/admin/sources/:sourceId/curation', (request, response, next) => {
    try {
      const body = curationSchema.parse(request.body ?? {})
      const source = context.control.getSource(request.params.sourceId ?? '')
      if (!source) return response.status(404).json({ error: 'unknown source' })

      const updated = context.control.upsertSource({ ...source, active: body.active })
      return response.json({
        sourceId: updated.id,
        active: updated.active,
        score: scoreSource(updated, sourceStats(updated)),
      })
    } catch (error) {
      return next(error)
    }
  })

  app.get('/api/evolution/summary', (_request, response) => {
    response.json(evolutionSummary(context))
  })

  app.get('/api/evolution/events', (request, response) => {
    const platformId = request.query.platform ? queryString(request.query.platform) : undefined
    response.json({ events: context.control.listEvents(platformId ? { platformId } : {}) })
  })

  app.get('/api/evolution/proposals', (request, response) => {
    const status = request.query.status ? queryString(request.query.status) : undefined
    response.json({ proposals: context.control.listProposals(status ? { status } : {}) })
  })

  const decisionSchema = z.object({
    decision: z.enum(['approve', 'reject']),
    actor: z.string().min(1).max(120).default('admin'),
    note: z.string().max(2000).nullish(),
  })

  app.post('/api/evolution/proposals/:proposalId/decision', (request, response, next) => {
    try {
      const body = decisionSchema.parse(request.body ?? {})
      const proposal = applyProposalDecision(
        context,
        request.params.proposalId ?? '',
        body.decision,
        body.actor,
        body.note ?? null,
      )
      if (!proposal) return response.status(404).json({ error: 'unknown proposal' })
      return response.json({ proposal })
    } catch (error) {
      return next(error)
    }
  })

  app.get('/api/knowledge/search', (request, response) => {
    const query = queryString(request.query.q).trim()
    if (!query) return response.status(400).json({ error: 'q query parameter is required' })
    return response.json(knowledgeSearch(context, query, request.query.platform ? queryString(request.query.platform) : undefined))
  })

  app.get('/api/knowledge/documents', (_request, response) => {
    const documents = [...context.control.knowledge.documents.values()].map((document) => {
      const version = document.currentVersionId ? context.control.knowledge.versions.get(document.currentVersionId) : undefined
      return {
        id: document.id,
        slug: document.slug,
        title: document.title,
        topic: document.topic,
        status: document.status,
        version: version?.version ?? null,
        trustLevel: version?.trustLevel ?? null,
        updatedAt: document.updatedAt,
        expiresAt: version?.expiresAt ?? null,
        sourceIds: version?.sourceIds ?? [],
        versionCount: [...context.control.knowledge.versions.values()].filter((entry) => entry.documentId === document.id).length,
      }
    })
    return response.json({ documents })
  })

  app.get('/api/creator/:creatorId/updates', (request, response) => {
    const updates = creatorUpdates(context, request.params.creatorId ?? '')
    if (!updates) return response.status(404).json({ error: 'unknown creator' })
    return response.json(updates)
  })

  // ── Creator-facing surface ──────────────────────────────────────────────────
  // Plain language only: options, limits, reasons, sources.

  app.use('/api/creator', requireAuth(context))

  app.get('/api/creator/overview', (request, response) => {
    response.json(creatorOverview(context, currentProfile(context, request)))
  })

  // ── Personalisation (§31) ───────────────────────────────────────────────
  // The creator can see what was learned, why, turn one off, forget one, or
  // reset everything. None of it can publish anything or change access.

  app.get('/api/creator/personalisation', (request, response) => {
    const creator = currentProfile(context, request)
    if (!creator || !request.account) return response.status(404).json({ error: 'no creator profile' })
    return response.json(personalisationFor(context, creator.id))
  })

  app.post('/api/creator/observations', (request, response, next) => {
    try {
      const creator = currentProfile(context, request)
      if (!creator || !request.account) return response.status(404).json({ error: 'no creator profile' })
      const body = observationSchema.parse(request.body ?? {})
      const result = recordCreatorObservation(context, creator.id, {
        kind: body.kind,
        subject: body.subject,
        detail: body.detail ?? null,
        platformSlug: body.platformSlug ?? null,
      })
      return response.json(result)
    } catch (error) {
      return next(error)
    }
  })

  const preferenceSchema = z.object({ enabled: z.boolean() })

  app.post('/api/creator/preferences/:preferenceId', (request, response, next) => {
    try {
      const creator = currentProfile(context, request)
      if (!creator) return response.status(404).json({ error: 'no creator profile' })
      const body = preferenceSchema.parse(request.body ?? {})
      const updated = setPreferenceEnabled(
        context.control.preferences,
        request.params.preferenceId ?? '',
        body.enabled,
      )
      if (!updated) return response.status(404).json({ error: 'unknown preference' })
      return response.json({ id: updated.id, enabled: updated.enabled })
    } catch (error) {
      return next(error)
    }
  })

  app.delete('/api/creator/preferences/:preferenceId', (request, response) => {
    const creator = currentProfile(context, request)
    if (!creator) return response.status(404).json({ error: 'no creator profile' })
    const forgotten = forgetPreference(context.control.preferences, request.params.preferenceId ?? '')
    if (!forgotten) return response.status(404).json({ error: 'unknown preference' })
    return response.json({ forgotten: true })
  })

  app.post('/api/creator/personalisation/reset', (request, response) => {
    const creator = currentProfile(context, request)
    if (!creator) return response.status(404).json({ error: 'no creator profile' })
    return response.json(resetPersonalization(context.control.preferences, creator.id))
  })

  // ── Creator Engine: generation and the media library ──────────────────────

  app.post('/api/creator/generate', (request, response, next) => {
    void (async () => {
      try {
        const creator = currentProfile(context, request)
        if (!creator || !request.account) return response.status(404).json({ error: 'no creator profile' })

        const body = generationRequestSchema.parse(request.body ?? {})
        const platform = context.control.getPlatform(body.platform)
        if (!platform) return response.status(404).json({ error: 'We do not know that platform yet.' })

        const option = platformView(context, platform).uiConfig.options.find(
          (entry) => entry.capabilityKey === body.option,
        )
        if (!option) return response.status(404).json({ error: 'We do not know that option for this platform.' })
        if (!option.enabled) {
          return response.status(409).json({ error: option.reason ?? 'That option is not available right now.' })
        }

        const output = await generate(
          context,
          {
            platform,
            state: context.control.latestSnapshot(platform.id)?.state ?? null,
            request: {
              brief: body.brief,
              option: body.option,
              ...(body.tone ? { tone: body.tone } : {}),
              ...(body.targetSeconds ? { targetSeconds: body.targetSeconds } : {}),
            },
          },
          context.media,
          creator.id,
        )

        const asset = await context.media.create(
          {
            creatorId: creator.id,
            kind: output.kind,
            origin: 'GENERATED',
            title: output.title,
            mimeType: output.mimeType,
            brief: body.brief,
            platformSlug: platform.slug,
            capabilityKey: body.option,
            producedBy: output.producedBy,
            modelGenerated: output.modelGenerated,
            meta: output.meta,
          },
          output.content,
        )
        await context.persist()

        return response.json({
          asset: assetView(asset),
          content: output.content,
          meta: output.meta,
        })
      } catch (error) {
        return next(error)
      }
    })()
  })

  app.get('/api/creator/assets', (request, response) => {
    const creator = currentProfile(context, request)
    if (!creator) return response.status(404).json({ error: 'no creator profile' })
    const kind = queryString(request.query.kind) as AssetKind | ''
    const assets = context.media.list(creator.id, {
      ...(kind && ASSET_KINDS.includes(kind) ? { kind } : {}),
      limit: 50,
    })
    return response.json({ assets: assets.map(assetView) })
  })

  app.get('/api/creator/assets/:assetId', (request, response, next) => {
    void (async () => {
      try {
        const creator = currentProfile(context, request)
        const asset = context.media.get(request.params.assetId ?? '')
        if (!creator || !asset) return response.status(404).json({ error: 'unknown asset' })
        if (asset.creatorId !== creator.id) return response.status(403).json({ error: 'That is not your asset.' })

        const stored = await context.media.read(asset.id)
        if (!stored) return response.status(410).json({ error: 'The file behind this asset is gone.' })
        // Send the bytes as they were stored. Converting to a string here would
        // quietly corrupt anything that is not text, such as an uploaded image.
        return response
          .type(stored.contentType || asset.mimeType)
          .set('content-disposition', `inline; filename="${safeFilename(asset.title, asset.mimeType)}"`)
          .send(Buffer.from(stored.body))
      } catch (error) {
        return next(error)
      }
    })()
  })

  app.delete('/api/creator/assets/:assetId', (request, response) => {
    void (async () => {
      const creator = currentProfile(context, request)
      const asset = context.media.get(request.params.assetId ?? '')
      if (!creator || !asset) return response.status(404).json({ error: 'unknown asset' })
      if (asset.creatorId !== creator.id) return response.status(403).json({ error: 'That is not your asset.' })
      await context.media.remove(asset.id)
      await context.persist()
      return response.json({ removed: true })
    })()
  })

  /**
   * Upload. The file is the raw request body and its own content type, so the
   * route works for any media type without inventing a multipart parser, and a
   * browser can post a File directly.
   */
  app.post(
    '/api/creator/assets',
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    (request, response, next) => {
      void (async () => {
        try {
          const creator = currentProfile(context, request)
          if (!creator) return response.status(404).json({ error: 'no creator profile' })

          const body: unknown = request.body
          if (!Buffer.isBuffer(body) || body.byteLength === 0) {
            return response.status(400).json({ error: 'Send the file itself as the request body.' })
          }
          if (body.byteLength > MAX_UPLOAD_BYTES) {
            return response.status(413).json({ error: `Files must be under ${MAX_UPLOAD_BYTES} bytes.` })
          }

          const mimeType = (request.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
          const requestedKind = queryString(request.query.kind) as AssetKind | ''
          const kind = requestedKind && ASSET_KINDS.includes(requestedKind) ? requestedKind : kindForMimeType(mimeType)
          const title = (queryString(request.query.title) || defaultTitleFor(mimeType)).slice(0, 160)

          const asset = await context.media.create(
            {
              creatorId: creator.id,
              kind,
              origin: 'UPLOADED',
              title,
              mimeType,
              brief: '',
              platformSlug: null,
              capabilityKey: null,
              producedBy: `uploaded by the creator`,
              modelGenerated: false,
            },
            new Uint8Array(body),
          )
          await context.persist()
          return response.status(201).json({ asset: assetView(asset) })
        } catch (error) {
          return next(error)
        }
      })()
    },
  )

  app.get('/api/creator/tools', (_request, response) => {
    response.json(creatorToolsView(context))
  })

  app.get('/api/creator/coming-soon', (_request, response) => {
    response.json({ comingSoon: creatorOverview(context, undefined).comingSoon })
  })

  app.post('/api/creator/validate', (request, response, next) => {
    void (async () => {
      try {
        const body = z
          .object({
            platform: z.string().min(1),
            option: z.string().min(1),
            text: z.string().max(20_000).default(''),
            mediaCount: z.number().int().min(0).max(100).default(0),
          })
          .parse(request.body ?? {})
        const result = await validateForCreator(context, {
          platformSlug: body.platform,
          optionKey: body.option,
          text: body.text,
          mediaCount: body.mediaCount,
        })
        response.json(result)
      } catch (error) {
        next(error)
      }
    })()
  })

  app.post('/api/creator/draft', (request, response, next) => {
    try {
      const body = z
        .object({
          platform: z.string().min(1),
          option: z.string().min(1),
          brief: z.string().max(400).default(''),
          tone: z.string().max(40).optional(),
        })
        .parse(request.body ?? {})
      response.json(
        draftForCreator(context, {
          platformSlug: body.platform,
          optionKey: body.option,
          brief: body.brief,
          ...(body.tone ? { tone: body.tone } : {}),
        }),
      )
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/creator/platforms/:platformSlug/why', (request, response) => {
    const optionKey = queryString(request.query.option)
    if (!optionKey) return response.status(400).json({ error: 'option query parameter is required' })
    const why = whyForCreator(context, request.params.platformSlug ?? '', optionKey)
    if (!why) return response.status(404).json({ error: 'unknown platform' })
    return response.json(why)
  })

  app.get('/api/creator/:creatorId/impact', (request, response) => {
    const creator = context.control.getCreator(request.params.creatorId ?? '')
    if (!creator) return response.status(404).json({ error: 'unknown creator' })
    return response.json({ creator, impacts: context.control.listImpacts(creator.id) })
  })

  app.post('/api/admin/research/run', (request, response, next) => {
    void (async () => {
      try {
        const body = z
          .object({ ignoreSchedule: z.boolean().default(false), maxSources: z.number().int().min(1).max(50).default(5) })
          .parse(request.body ?? {})
        const result = await runResearchCycle({
          control: context.control,
          fetcher: context.fetcher,
          modelExtractor: context.modelExtractor,
          respectSchedule: !body.ignoreSchedule,
          maxSourcesPerRun: body.maxSources,
        })
        await context.persist()
        response.json({ run: result })
      } catch (error) {
        next(error)
      }
    })()
  })

  app.get('/evolution-center', adminGuard(context), (_request, response) => {
    response.type('html').send(renderEvolutionCenter(context))
  })

  // The creator web app, when it has been built. The API always wins on /api/*.
  mountWebApp(app)

  app.use((_request, response) => response.status(404).json({ error: 'not found' }))

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      return response.status(400).json({ error: 'invalid request', issues: error.issues })
    }
    const message = error instanceof Error ? error.message : 'unexpected error'
    return response.status(500).json({ error: message })
  })

  return app
}

/**
 * Serves the built creator app from `apps/web/dist` with an SPA fallback.
 * Works from both `src` (tsx) and `dist` (node) because both sit one level
 * below the package root.
 */
function mountWebApp(app: Express): void {
  const dist = fileURLToPath(new URL('../../../../apps/web/dist/', import.meta.url))
  const indexFile = resolve(dist, 'index.html')
  if (!existsSync(indexFile)) return

  app.use(express.static(dist, { index: false, maxAge: '1h' }))
  app.get(/^\/(?!api\/|evolution-center).*/, (_request, response) => {
    response.sendFile(indexFile)
  })
}

/**
 * The profile the request acts as. A signed-in account always wins, so one creator can
 * never see another's alerts. The seeded demo profile is only used with no session.
 */
function currentProfile(context: AppContext, request: Request) {
  if (request.account) return context.control.profileForAccount(request.account.id)
  return context.creatorSession()
}

/** Express query values are `string | string[] | undefined`; normalise them. */
function queryString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

/** Uploads are capped so one request cannot exhaust memory or disk. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const MIME_KINDS: Array<{ match: RegExp; kind: AssetKind }> = [
  { match: /image\/(png|jpe?g|webp|gif|avif|svg\+xml)/, kind: 'IMAGE' },
  { match: /video\//, kind: 'VIDEO' },
  { match: /audio\//, kind: 'AUDIO' },
  { match: /text\//, kind: 'TEXT' },
]

/** A sensible kind for an upload, so the library does not need one from the caller. */
function kindForMimeType(mimeType: string): AssetKind {
  return MIME_KINDS.find((entry) => entry.match.test(mimeType))?.kind ?? 'TEXT'
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'text/plain': 'txt',
  'text/markdown': 'md',
}

/** A download name that cannot be used to escape a directory or inject a header. */
function safeFilename(title: string, mimeType: string): string {
  const base = title
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 60)
  const extension = MIME_EXTENSIONS[mimeType] ?? 'bin'
  return base.length > 0 ? `${base}.${extension}` : `asset.${extension}`
}

function defaultTitleFor(mimeType: string): string {
  const label = mimeType.split('/')[1] ?? 'file'
  return `Uploaded ${label.replace(/[+.]/g, ' ')}`
}

/**
 * Internal routes need the admin role.
 *
 * Two doors: a session belonging to an admin account, or the bearer token used
 * by operators and CI. Development without a token stays open so the Evolution
 * Center is usable out of the box; production must configure one.
 */
function adminGuard(context: AppContext) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const token = context.config.ADMIN_TOKEN
    const provided = request.header('x-admin-token') ?? request.header('authorization')?.replace(/^Bearer\s+/i, '')

    // An explicit operator token wins, so a signed-in creator can still be given
    // operator access for one call.
    if (token && provided) {
      if (provided !== token) {
        response.status(401).json({ error: 'admin access required' })
        return
      }
      next()
      return
    }

    if (request.account) {
      if (request.account.role !== 'ADMIN') {
        // Signed in, but this surface is not theirs.
        response.status(403).json({ error: 'You do not have access to that.' })
        return
      }
      next()
      return
    }

    if (!token) {
      if (context.config.NODE_ENV === 'production') {
        response.status(503).json({ error: 'ADMIN_TOKEN must be configured in production' })
        return
      }
      next()
      return
    }

    response.status(401).json({ error: 'admin access required' })
  }
}
