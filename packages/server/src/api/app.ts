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
import { attachSession, authRoutes, isCsrfFailure, limiterFor, requireAuth } from './auth.js'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { ASSET_KINDS } from '@creator-mall/core'
import type { AssetKind } from '@creator-mall/core'
import { forgetPreference, resetPersonalization, setPreferenceEnabled } from '@creator-mall/core'
import { assetView, generate, generationRequestSchema } from '../creator-engine.js'
import { observationSchema, personalisationFor, recordCreatorObservation } from './creator.js'
import { activatePromptVersion, evaluatePromptVersion } from '../evolution/regression-service.js'

export function createApp(context: AppContext): Express {
  const app = express()
  // One limiter for the process, so the same budget applies whichever route is
  // used to reach it.
  const limiter = limiterFor(context)
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false }))
  // CORS is an allowlist, never a wildcard. `cors()` with no options reflects
  // any origin, which lets a page on another site read unauthenticated API
  // responses out of a signed-in operator's browser.
  app.use(
    cors({
      origin: context.config.CORS_ORIGIN_LIST.length > 0 ? [...context.config.CORS_ORIGIN_LIST] : false,
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '256kb' }))

  /**
   * Every request gets an id, and every response echoes it.
   *
   * Without this, a report of "it failed at 3am" cannot be tied to a log line:
   * there are no request ids, no timing, and no path. It is the cheapest
   * observability there is.
   */
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.header('x-request-id')
    const requestId = incoming && incoming.length <= 64 ? incoming : `req_${randomUUID()}`
    response.setHeader('x-request-id', requestId)
    const startedAt = Date.now()
    response.on('finish', () => {
      const ms = Date.now() - startedAt
      // Only slow or failed requests are logged, so the signal is not drowned.
      if (response.statusCode >= 400 || ms > 1000) {
        console.log(`[api] ${request.method} ${request.path} ${response.statusCode} ${ms}ms ${requestId}`)
      }
    })
    next()
  })

  // Identity first: every later guard can rely on request.account / request.session.
  app.use(attachSession(context))
  app.use('/api/auth', authRoutes(context))
  // Operator surfaces: platforms directory, source registry, evolution log, knowledge.
  // All of them need the admin role; the creator API below is per-account.
  app.use(['/api/platforms', '/api/sources', '/api/evolution', '/api/knowledge'], adminGuard(context))
  app.use('/api/admin', adminGuard(context))

  app.get('/api/health', (_request, response) => {
    const { control } = context
    const lastRun = control.listJobRuns(1)[0]
    const report = buildHealthReport({
      sources: control.listSources(),
      currentVersions: control.currentKnowledgeVersions(),
      events: control.listEvents(),
      proposals: control.listProposals(),
      lastRun: lastRun ? { status: lastRun.status, at: lastRun.finishedAt } : null,
      integrationHealth: {},
    })
    // Liveness: the process is up and serving. Deliberately 200 even when
    // degraded — a flaky source must not get a healthy container killed.
    response.json({ status: 'ok', startedAt: context.startedAt, health: report })
  })

  /**
   * Readiness: should this instance receive traffic?
   *
   * Separate from liveness on purpose. A load balancer should stop sending
   * requests to an instance that cannot serve them, but it must not restart a
   * process that is running perfectly well.
   */
  app.get('/api/ready', (_request, response) => {
    const report = buildHealthReport({
      sources: context.control.listSources(),
      currentVersions: context.control.currentKnowledgeVersions(),
      events: context.control.listEvents(),
      proposals: context.control.listProposals(),
      lastRun: context.control.listJobRuns(1)[0]
        ? { status: context.control.listJobRuns(1)[0]!.status, at: context.control.listJobRuns(1)[0]!.finishedAt }
        : null,
      integrationHealth: {},
    })
    response
      .status(report.overall === 'HEALTHY' ? 200 : 503)
      .json({ status: report.overall === 'HEALTHY' ? 'ready' : 'degraded', overall: report.overall })
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
    response.json({ events: context.control.listEvents({ ...(platformId ? { platformId } : {}), limit: pageLimit(request) }) })
  })

  app.get('/api/evolution/proposals', (request, response) => {
    const status = request.query.status ? queryString(request.query.status) : undefined
    response.json({
      proposals: context.control.listProposals(status ? { status } : {}).slice(0, pageLimit(request)),
    })
  })

  const activationSchema = z.strictObject({
  /**
   * A person may overrule a failed or incomplete run, but the override is
   * recorded as an override, never as a pass.
   */
  override: z.boolean().default(false),
  actor: z.string().min(1).max(120).default('admin'),
})

const decisionSchema = z.strictObject({
    decision: z.enum(['approve', 'reject']),
    actor: z.string().min(1).max(120).default('admin'),
    note: z.string().max(2000).nullish(),
  })

  app.get('/api/evolution/prompts', (_request, response) => {
    const prompts = context.control.prompts.all().map((version) => ({
      promptKey: version.promptKey,
      version: version.version,
      status: version.status,
      platformId: version.platformId,
      basedOnEventId: version.basedOnEventId,
      changeNote: version.changeNote,
      evaluated: version.evaluationScore !== null,
      evaluationScore: version.evaluationScore,
      createdAt: version.createdAt,
      activatedAt: version.activatedAt,
    }))
    response.json({ prompts })
  })

  /**
   * Run a drafted prompt against the checks its change implies, and refuse to
   * activate anything that has not passed them.
   */
  app.post('/api/evolution/prompts/:promptKey/versions/:version/evaluate', (request, response, next) => {
    void (async () => {
      try {
        const promptKey = decodeURIComponent(request.params.promptKey ?? '')
        const versionNumber = Number(request.params.version ?? '')
        if (!Number.isInteger(versionNumber)) {
          return response.status(400).json({ error: 'That version number is not valid.' })
        }
        const result = await evaluatePromptVersion(context, promptKey, versionNumber)
        if (!result) return response.status(404).json({ error: 'We have no such prompt version.' })
        return response.json({
          report: result.report,
          riskLevel: result.riskLevel,
          activation: result.activation,
          cases: result.cases.map((entry) => ({ id: entry.id, expectation: entry.expectation })),
        })
      } catch (error) {
        return next(error)
      }
    })()
  })

  app.post('/api/evolution/prompts/:promptKey/versions/:version/activate', (request, response, next) => {
    try {
      const promptKey = decodeURIComponent(request.params.promptKey ?? '')
      const versionNumber = Number(request.params.version ?? '')
      if (!Number.isInteger(versionNumber)) {
        return response.status(400).json({ error: 'That version number is not valid.' })
      }
      const body = activationSchema.parse(request.body ?? {})
      const result = activatePromptVersion(context, promptKey, versionNumber, {
        override: body.override,
        decidedBy: body.actor,
      })
      if (!result.activation.allowed) {
        return response.status(409).json({
          error: result.activation.reason,
          refusal: result.activation.refusal,
          overridden: false,
        })
      }
      return response.json({
        activated: true,
        overridden: result.activation.overridden,
        reason: result.activation.reason,
        refusal: result.activation.refusal,
        version: result.version?.version ?? versionNumber,
      })
    } catch (error) {
      return next(error)
    }
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

  // ── Creator-facing surface ──────────────────────────────────────────────────
  // Plain language only: options, limits, reasons, sources.
  //
  // Authorization is enforced by this mount, so every route below it can rely on
  // request.account. Routes registered ABOVE this line are unauthenticated by
  // construction; the creator id in the path is never an authorisation check on
  // its own.

  app.use('/api/creator', requireAuth(context))

  app.get('/api/creator/:creatorId/updates', (request, response) => {
    // The id in the path must match the session, otherwise one creator can read
    // another's feed by guessing an id.
    const me = currentProfile(context, request)
    if (!me) return response.status(404).json({ error: 'no creator profile' })
    const requested = request.params.creatorId ?? ''
    if (requested !== me.id) return response.status(403).json({ error: 'That is not your feed.' })

    const updates = creatorUpdates(context, requested)
    if (!updates) return response.status(404).json({ error: 'unknown creator' })
    return response.json(updates)
  })

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

  /**
   * Generation costs money: one model call per request. Without a limit any
   * registered account can loop this and the bill is the attacker's.
   */
  app.post('/api/creator/generate', (request, response, next) => {
    const me = currentProfile(context, request)
    if (me) {
      const allowed = limiter.check(`generate:${me.id}`, {
        limit: context.config.GENERATE_RATE_LIMIT,
        windowMs: context.config.AUTH_RATE_WINDOW_MS,
        bucket: 'generate',
      })
      if (!allowed.allowed) {
        response.setHeader('retry-after', String(allowed.retryAfterSeconds))
        response.status(429).json({ error: 'You have made a lot of these in a short time. Try again shortly.' })
        return
      }
    }
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
        // quietly corrupt anything that is not text, such as an uploaded video.
        //
        // Served as an attachment with nosniff and a sandboxing CSP, so a file a
        // creator uploaded can never execute in the app's origin, whatever it
        // claims to be.
        return response
          .type(stored.contentType || asset.mimeType)
          .set('content-disposition', `attachment; filename="${safeFilename(asset.title, asset.mimeType)}"`)
          .set('x-content-type-options', 'nosniff')
          .set('content-security-policy', "default-src 'none'; sandbox")
          .send(Buffer.from(stored.body))
      } catch (error) {
        return next(error)
      }
    })()
  })

  app.delete('/api/creator/assets/:assetId', (request, response, next) => {
    void (async () => {
      try {
        const creator = currentProfile(context, request)
        const asset = context.media.get(request.params.assetId ?? '')
        if (!creator || !asset) return response.status(404).json({ error: 'unknown asset' })
        if (asset.creatorId !== creator.id) return response.status(403).json({ error: 'That is not your asset.' })
        await context.media.remove(asset.id)
        await context.persist()
        return response.json({ removed: true })
      } catch (error) {
        // Without this, a failing remove() or persist() rejects after the
        // response and becomes an unhandled rejection, which terminates Node.
        return next(error)
      }
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

          const uploadAllowed = limiter.check(`upload:${creator.id}`, {
            limit: context.config.UPLOAD_RATE_LIMIT,
            windowMs: context.config.AUTH_RATE_WINDOW_MS,
            bucket: 'upload',
          })
          if (!uploadAllowed.allowed) {
            response.setHeader('retry-after', String(uploadAllowed.retryAfterSeconds))
            response.status(429).json({ error: 'Too many uploads in a short time. Try again shortly.' })
            return
          }

          const body: unknown = request.body
          if (!Buffer.isBuffer(body) || body.byteLength === 0) {
            return response.status(400).json({ error: 'Send the file itself as the request body.' })
          }
          if (body.byteLength > MAX_UPLOAD_BYTES) {
            return response.status(413).json({ error: `Files must be under ${MAX_UPLOAD_BYTES} bytes.` })
          }

          const mimeType = (request.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase()

          // Declared type, not sniffed type, is the minimum bar. A creator can
          // rename anything, so the download path below is what actually makes
          // this safe; the allowlist keeps the obvious cases out of the library.
          if (!UPLOADABLE_MIME.includes(mimeType as (typeof UPLOADABLE_MIME)[number])) {
            return response.status(415).json({
              error: 'That file type is not one we can store safely.',
              problems: ['Try an image, video, audio file, plain text or a PDF.'],
            })
          }

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
    const me = currentProfile(context, request)
    if (!me) return response.status(404).json({ error: 'no creator profile' })
    const requested = request.params.creatorId ?? ''
    if (requested !== me.id) return response.status(403).json({ error: 'That is not your profile.' })
    const creator = context.control.getCreator(requested)
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

    // An unexpected error can carry a filesystem path, a SQL fragment or a
    // provider message. Log it where an operator can find it; do not hand it to
    // whoever happened to make the request.
    console.error('[api] unhandled error', error)

    // Body-parser rejections (oversize, malformed JSON) already carry a status.
    const status = (error as { status?: number }).status
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return response.status(status).json({ error: 'That request could not be read.' })
    }
    return response.status(500).json({ error: 'Something went wrong on our side.' })
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

  // A source map is a full copy of the application source, and it was being
  // served to anyone who asked. `setHeaders` is the only reliable way to refuse
  // it; `maxAge` alone does not.
  app.use(
    express.static(dist, {
      index: false,
      maxAge: '1h',
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('.map')) {
          response.status(404)
          response.end()
          return
        }
        if (/\.[0-9a-f]{8,}\./.test(filePath)) {
          // Hashed filenames, so the contents can never change under a URL.
          response.setHeader('cache-control', 'public, max-age=31536000, immutable')
        }
      },
    }),
  )
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

/**
 * Page size for list routes, capped so no request can ask for the whole database
 * and so a growing collection cannot silently become a huge response.
 */
function pageLimit(request: Request, fallback = 50): number {
  const raw = Number(queryString(request.query.limit))
  if (!Number.isInteger(raw) || raw < 1) return fallback
  return Math.min(raw, 200)
}

/** Express query values are `string | string[] | undefined`; normalise them. */
function queryString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

/** Uploads are capped so one request cannot exhaust memory or disk. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * Types a creator may upload and get back.
 *
 * Anything that a browser will execute in our origin — HTML, SVG, XML — is
 * refused outright rather than sanitised. Serving a creator's own file from the
 * API origin with a scriptable content type is stored XSS with their session
 * cookie attached, and sanitising user content correctly is a much larger
 * problem than not accepting it.
 */
const UPLOADABLE_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/pdf',
] as const

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
      if (!tokensMatch(provided, token)) {
        response.status(401).json({ error: 'admin access required' })
        return
      }
      // The token is a bearer credential with no CSRF protection of its own, so
      // the double-submit check still applies to a cookie-authenticated browser.
      if (isCsrfFailure(request)) {
        response.status(403).json({ error: 'csrf token missing or invalid' })
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
      if (isCsrfFailure(request)) {
        response.status(403).json({ error: 'csrf token missing or invalid' })
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
      // Development with no token: refuse by default. The Evolution Center and
      // the operator API used to fall open here, which meant a forgotten
      // environment variable silently exposed every internal surface. Opt in
      // explicitly with ALLOW_UNAUTHENTICATED_ADMIN=true.
      if (context.config.ALLOW_UNAUTHENTICATED_ADMIN) {
        next()
        return
      }
      response.status(503).json({
        error: 'admin access is not configured',
        problems: ['Set ADMIN_TOKEN, or set ALLOW_UNAUTHENTICATED_ADMIN=true for local development.'],
      })
      return
    }

    response.status(401).json({ error: 'admin access required' })
  }
}

/**
 * Constant-time comparison.
 *
 * `!==` on a secret leaks its length and its first differing byte through
 * response timing, which is enough to recover a token one byte at a time.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
