import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { ModelFactExtractor } from '@creator-mall/core'
import type { CreatorProfile, FactExtractor, SocialPlatform } from '@creator-mall/core'
import { AdapterRegistry } from './adapters/registry.js'
import { isModelConfigured, OpenRouterClient } from './ai/openrouter.js'
import { ControlPlane } from './store/control-plane.js'
import { FilePersistence } from './store/file-persistence.js'
import { PostgresPersistence } from './store/postgres-persistence.js'
import { checkSchema, createPgClient } from './store/sql-migrate.js'
import { MemoryPersistence } from './store/persistence.js'
import type { ControlPlaneState, PersistencePort } from './store/persistence.js'
import { PublicFetcher } from './world-engine/fetcher.js'
import { SEED_PLATFORMS, seedSources } from './world-engine/seed.js'
import { nowIso, seedTemplateFor, stableId } from '@creator-mall/core'

export interface AppContext {
  config: Config
  control: ControlPlane
  adapters: AdapterRegistry
  fetcher: PublicFetcher
  persistence: PersistencePort
  startedAt: string
  /** Model-backed extractor, or null when no provider is configured. */
  modelExtractor: FactExtractor | null
  /**
   * Which creator the web app is acting as when no one is signed in.
   * Phase 3 adds real accounts; this keeps local development usable without a
   * sign-up step, and is never used once a session exists.
   */
  creatorSession: () => CreatorProfile | undefined
}

/**
 * Builds the whole control plane: seed watchlist, seed source registry, wire the
 * capability → component dependency graph, and hydrate from disk when a data
 * directory is configured.
 */
export async function createContext(
  overrides: Partial<Config> = {},
  deps: { fetchImpl?: typeof fetch; seed?: boolean } = {},
): Promise<AppContext> {
  const config = { ...loadConfig(), ...overrides }
  const persistence = await createPersistence(config)

  const stored: ControlPlaneState | null = await persistence.load().catch(() => null)
  const control = new ControlPlane(stored ?? undefined)

  if (deps.seed !== false) seedControlPlane(control)

  const fetcher = new PublicFetcher(config, deps.fetchImpl ?? fetch)
  const adapters = new AdapterRegistry()

  return {
    config,
    control,
    adapters,
    fetcher,
    persistence,
    startedAt: nowIso(),
    modelExtractor: createModelExtractor(config),
    creatorSession: () => {
      if (config.CREATOR_ID) {
        const selected = control.getCreator(config.CREATOR_ID)
        if (selected) return selected
      }
      return control.listCreators()[0]
    },
  }
}

/**
 * Builds the model-backed extractor when a provider is configured.
 *
 * The key is read here and nowhere else. It is never logged, never returned in
 * an API response, and never written to the control-plane snapshot.
 */
function createModelExtractor(config: Config): FactExtractor | null {
  if (!config.MODEL_EXTRACTION) return null
  if (!isModelConfigured(config.OPENROUTER_API_KEY)) return null

  const client = new OpenRouterClient({
    apiKey: config.OPENROUTER_API_KEY,
    model: config.OPENROUTER_MODEL,
    baseUrl: config.OPENROUTER_BASE_URL,
    timeoutMs: config.MODEL_TIMEOUT_MS,
    title: 'Creator Mall World Engine',
  })

  return new ModelFactExtractor({ client, maxInputChars: config.MODEL_MAX_INPUT_CHARS })
}

/**
 * Storage is chosen by configuration, not by code: `PERSISTENCE=postgres` with
 * a `DATABASE_URL` uses the control-plane tables, otherwise the JSON snapshot
 * (or memory when no data directory is set).
 */
async function createPersistence(config: Config): Promise<PersistencePort> {
  if (config.PERSISTENCE === 'postgres') {
    if (!config.DATABASE_URL) {
      throw new Error('PERSISTENCE=postgres needs DATABASE_URL. Set it, or use PERSISTENCE=json.')
    }
    const client = await createPgClient({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_SIZE,
    })
    const status = await checkSchema(client)
    if (!status.ready) {
      throw new Error(`database not ready: ${status.reason} (run: npm run db:migrate)`)
    }
    return new PostgresPersistence(client)
  }
  return config.DATA_DIR ? new FilePersistence(config.DATA_DIR) : new MemoryPersistence()
}

/** The demo creator that makes the creator-facing surface usable on first run. */
export const DEMO_CREATOR: CreatorProfile = {
  id: 'cr_demo_video_creator',
  displayName: 'Demo video creator',
  platformSlugs: ['youtube', 'instagram', 'tiktok'],
  contentTypes: ['SHORT_VIDEO', 'LONG_VIDEO'],
  usedCapabilityKeys: ['SHORT_VIDEO', 'LONG_VIDEO', 'VIDEO_MEDIA', 'SCHEDULING', 'ANALYTICS'],
  goals: ['grow reach', 'publish more often'],
  locales: ['en'],
  createdAt: '2026-01-01T00:00:00.000Z',
}

export function seedControlPlane(control: ControlPlane, at: string = nowIso()): void {
  for (const seed of SEED_PLATFORMS) {
    const id = stableId('pf', seed.slug)
    if (control.getPlatform(id)) continue
    const platform: SocialPlatform = {
      id,
      slug: seed.slug,
      name: seed.name,
      kind: seed.kind,
      status: seed.status,
      homepage: seed.homepage,
      regions: seed.regions,
      capabilityKeys: [...seed.capabilityKeys],
      trustLevel: 'OFFICIAL',
      firstSeenAt: at,
      lastReviewedAt: at,
      integrationState: 'PREPARING',
      metadata: { seeded: true, docsHost: seed.docsHost },
    }
    control.upsertPlatform(platform)
    linkPlatformDependencies(control, platform)
    seedTemplates(control, platform, at)
  }

  for (const source of seedSources(SEED_PLATFORMS, at)) {
    if (control.getSource(source.id)) continue
    control.upsertSource(source)
  }

  if (!control.getCreator(DEMO_CREATOR.id)) {
    control.upsertCreator({ ...DEMO_CREATOR, createdAt: at })
  }
}

/**
 * One prepared structure per content capability, so the creation flow is useful on
 * day one. New capabilities get their own structure when a change is verified.
 */
export function seedTemplates(control: ControlPlane, platform: SocialPlatform, at: string): void {
  for (const capabilityKey of platform.capabilityKeys) {
    const definition = control.capabilities.get(capabilityKey)
    if (!definition || definition.domain !== 'CONTENT') continue
    const template = seedTemplateFor({
      platformId: platform.id,
      platformSlug: platform.slug,
      platformName: platform.name,
      capabilityKey,
      capabilityLabel: definition.label,
      createdAt: at,
    })
    if (control.listTemplates(platform.id).some((entry) => entry.id === template.id)) continue
    control.addTemplate(template)
  }
}

/** §25: declare the standard chain once per platform capability. */
export function linkPlatformDependencies(control: ControlPlane, platform: SocialPlatform): void {
  for (const capabilityKey of platform.capabilityKeys) {
    const definition = control.capabilities.get(capabilityKey)
    if (!definition) continue
    control.graph.linkCapabilityChain({
      platformId: platform.id,
      platformLabel: platform.name,
      capabilityKey,
      capabilityLabel: definition.label,
      contentType: capabilityKey,
      promptKey: `${platform.slug}:${capabilityKey}:generation`,
      templateId: `${platform.slug}:${capabilityKey}:default`,
      editor: definition.surfaces.includes('video-editor') ? 'video-editor' : 'composer',
      publisher: `${platform.slug}-publisher`,
      analytics: `${platform.slug}-analytics`,
      documentation: `${platform.slug}-docs`,
    })
  }
}
