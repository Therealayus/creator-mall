import cors from 'cors'
import express from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZodError, z } from 'zod'
import { buildHealthReport } from '@creator-mall/core'
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
import { runResearchCycle } from '../world-engine/pipeline.js'
import {
  creatorOverview,
  draftForCreator,
  validateForCreator,
  whyForCreator,
} from './creator.js'

export function createApp(context: AppContext): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(cors())
  app.use(express.json({ limit: '256kb' }))

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
    const events = context.control.listEvents()
    const versions = [...context.control.knowledge.versions.values()]
    response.json({
      sources: context.control.listSources().map((source) => {
        // How much this source has actually contributed, so an operator can see
        // which registry entries are earning their place.
        const signalCount =
          events.filter((event) => event.sourceIds.includes(source.id)).length +
          versions.filter((version) => version.sourceIds.includes(source.id)).length
        return {
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
          signalCount,
          yield: signalCount > 0 ? 'PRODUCING' : source.lastStatus === 'NEVER_CHECKED' ? 'UNKNOWN' : 'QUIET',
        }
      }),
    })
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

  app.get('/api/creator/overview', (_request, response) => {
    response.json(creatorOverview(context, context.creatorSession()))
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
          respectSchedule: !body.ignoreSchedule,
          maxSourcesPerRun: body.maxSources,
        })
        await context.persistence.save(context.control.toState())
        response.json({ run: result })
      } catch (error) {
        next(error)
      }
    })()
  })

  app.get('/evolution-center', (_request, response) => {
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

/** Express query values are `string | string[] | undefined`; normalise them. */
function queryString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

/** Admin routes are token-guarded whenever a token is configured. */
function adminGuard(context: AppContext) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const token = context.config.ADMIN_TOKEN
    if (!token) {
      if (context.config.NODE_ENV === 'production') {
        response.status(503).json({ error: 'ADMIN_TOKEN must be configured in production' })
        return
      }
      next()
      return
    }
    const provided = request.header('x-admin-token') ?? request.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (provided !== token) {
      response.status(401).json({ error: 'admin token required' })
      return
    }
    next()
  }
}
