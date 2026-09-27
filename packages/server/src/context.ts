import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { AdapterRegistry } from './adapters/registry.js'
import { ControlPlane } from './store/control-plane.js'
import { FilePersistence } from './store/file-persistence.js'
import { MemoryPersistence } from './store/persistence.js'
import type { ControlPlaneState, PersistencePort } from './store/persistence.js'
import { PublicFetcher } from './world-engine/fetcher.js'
import { SEED_PLATFORMS, seedSources } from './world-engine/seed.js'
import { nowIso, stableId } from '@creator-mall/core'
import type { SocialPlatform } from '@creator-mall/core'

export interface AppContext {
  config: Config
  control: ControlPlane
  adapters: AdapterRegistry
  fetcher: PublicFetcher
  persistence: PersistencePort
  startedAt: string
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
  const persistence = config.DATA_DIR ? new FilePersistence(config.DATA_DIR) : new MemoryPersistence()

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
  }
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
  }

  for (const source of seedSources(SEED_PLATFORMS, at)) {
    if (control.getSource(source.id)) continue
    control.upsertSource(source)
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
