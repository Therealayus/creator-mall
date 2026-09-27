import type { PlatformAdapter, PlatformState } from '@creator-mall/core'
import { HttpPlatformAdapter } from './http-adapter.js'
import type { HttpAdapterDefinition } from './http-adapter.js'
import { SimulatedPlatformAdapter } from './simulated.js'
import type { ControlPlane } from '../store/control-plane.js'

export { SimulatedPlatformAdapter } from './simulated.js'
export { CredentialMissing, HttpPlatformAdapter, readPath } from './http-adapter.js'
export type { HttpAdapterDefinition } from './http-adapter.js'
export { validationIssues } from './validation.js'

/**
 * §41: adapters are registered by contract, not by platform name in
 * application code. Adding an integration means supplying a verified
 * definition; adding a platform means nothing at all.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>()

  register(adapter: PlatformAdapter): PlatformAdapter {
    this.adapters.set(adapter.platformSlug, adapter)
    return adapter
  }

  get(platformSlug: string): PlatformAdapter | undefined {
    return this.adapters.get(platformSlug)
  }

  /**
   * Never returns null: an unknown platform resolves to the simulated adapter,
   * so "no adapter" can never be mistaken for "no platform", and local
   * development exercises the same code path production will.
   */
  resolve(
    platformSlug: string,
    state: PlatformState | null,
    declaredCapabilityKeys: readonly string[] = [],
  ): PlatformAdapter {
    return this.adapters.get(platformSlug) ?? new SimulatedPlatformAdapter(platformSlug, state, declaredCapabilityKeys)
  }

  list(): PlatformAdapter[] {
    return [...this.adapters.values()]
  }

  byKind(kind: PlatformAdapter['kind']): PlatformAdapter[] {
    return this.list().filter((adapter) => adapter.kind === kind)
  }
}

export interface CredentialResolver {
  (platformSlug: string, accountRef: string): string | null
}

export interface BuildRegistryOptions {
  /** Verified integration definitions, keyed by platform slug. */
  definitions?: readonly HttpAdapterDefinition[]
  credentialFor?: CredentialResolver
  fetchImpl?: typeof fetch
}

/**
 * Builds the registry from verified knowledge.
 *
 * A platform becomes `LIVE` only when a definition exists that names a real
 * endpoint. Everything else is `SIMULATED`, which is honest about what can
 * actually publish.
 */
export function buildAdapterRegistry(options: BuildRegistryOptions = {}): AdapterRegistry {
  const registry = new AdapterRegistry()

  for (const definition of options.definitions ?? []) {
    if (!definition.baseUrl || !definition.publish?.path) continue
    registry.register(
      new HttpPlatformAdapter({
        definition,
        state: null,
        declaredCapabilityKeys: [],
        credentialFor: (accountRef) => options.credentialFor?.(definition.platformSlug, accountRef) ?? null,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    )
  }
  return registry
}

/**
 * Wires adapters against live control-plane state so validation always checks
 * the newest verified limits, not the snapshot the adapter was built with.
 */
export function attachRegistryToControlPlane(control: ControlPlane, registry: AdapterRegistry): AdapterRegistry {
  for (const platform of control.listPlatforms()) {
    const snapshot = control.latestSnapshot(platform.id)
    const state = snapshot?.state ?? null
    const existing = registry.get(platform.slug)

    if (existing instanceof HttpPlatformAdapter) {
      registry.register(
        new HttpPlatformAdapter({
          definition: existing.definition,
          state,
          declaredCapabilityKeys: platform.capabilityKeys,
          credentialFor: existing.credentialResolver,
          ...(existing.fetchImplementation ? { fetchImpl: existing.fetchImplementation } : {}),
        }),
      )
      continue
    }
    registry.resolve(platform.slug, state, platform.capabilityKeys)
  }
  return registry
}

/**
 * A platform can publish only when a live integration exists *and* our own
 * verified knowledge says the publishing API is there. Two independent checks,
 * because being wrong in either direction is expensive.
 */
export function publishingEnabled(control: ControlPlane, registry: AdapterRegistry, platformId: string): boolean {
  const platform = control.getPlatform(platformId)
  if (!platform) return false

  const adapter = registry.get(platform.slug)
  if (!adapter || adapter.kind !== 'LIVE') return false

  const state = control.latestSnapshot(platform.id)?.state
  if (state?.capabilities.API_PUBLISH?.state !== 'ACTIVE') return false
  return Boolean(state?.api?.contentPublishing)
}

export function adapterSummary(registry: AdapterRegistry): Array<{ slug: string; kind: string }> {
  return registry.list().map((adapter) => ({ slug: adapter.platformSlug, kind: adapter.kind }))
}
