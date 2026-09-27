import type { MediaAsset } from '@creator-mall/core'
import { newId, nowIso, stableId } from '@creator-mall/core'
import { createHash } from 'node:crypto'

/**
 * Asset storage.
 *
 * Bytes live behind a port; the control plane only holds the record. The
 * filesystem implementation is real and sufficient for one process, and the
 * interface is what an object store would implement.
 */
export interface AssetStorage {
  put(key: string, body: string | Uint8Array, contentType: string): Promise<{ sizeBytes: number; checksum: string }>
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>
  delete(key: string): Promise<boolean>
}

export class InMemoryAssetStorage implements AssetStorage {
  private readonly items = new Map<string, { body: Uint8Array; contentType: string }>()

  put(key: string, body: string | Uint8Array, contentType: string): Promise<{ sizeBytes: number; checksum: string }> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    this.items.set(key, { body: bytes, contentType })
    return Promise.resolve({ sizeBytes: bytes.byteLength, checksum: checksumOf(bytes) })
  }

  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    return Promise.resolve(this.items.get(key) ?? null)
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(key))
  }

  count(): number {
    return this.items.size
  }
}

export interface AssetInput {
  creatorId: string
  kind: MediaAsset['kind']
  origin: MediaAsset['origin']
  title: string
  mimeType: string
  brief: string
  platformSlug: string | null
  capabilityKey: string | null
  producedBy: string
  modelGenerated: boolean
  meta?: Record<string, unknown>
}

/**
 * Stores an asset and its record together, so a record can never point at bytes
 * that were never written.
 */
export class MediaLibrary {
  private readonly assets = new Map<string, MediaAsset>()
  private readonly storage: AssetStorage
  private readonly clock: () => number

  constructor(storage: AssetStorage, clock: () => number = Date.now) {
    this.storage = storage
    this.clock = clock
  }

  async create(input: AssetInput, body: string | Uint8Array): Promise<MediaAsset> {
    const id = newId('ast', this.clock)
    const key = `${input.creatorId}/${id}`
    const stored = await this.storage.put(key, body, input.mimeType)

    const asset: MediaAsset = {
      id,
      creatorId: input.creatorId,
      kind: input.kind,
      origin: input.origin,
      title: input.title.slice(0, 160),
      mimeType: input.mimeType,
      storageKey: key,
      sizeBytes: stored.sizeBytes,
      brief: input.brief.slice(0, 400),
      platformSlug: input.platformSlug,
      capabilityKey: input.capabilityKey,
      producedBy: input.producedBy,
      modelGenerated: input.modelGenerated,
      createdAt: nowIso(this.clock),
      meta: input.meta ?? {},
    }
    this.assets.set(id, asset)
    return asset
  }

  get(id: string): MediaAsset | undefined {
    return this.assets.get(id)
  }

  read(id: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const asset = this.assets.get(id)
    if (!asset) return Promise.resolve(null)
    return this.storage.get(asset.storageKey)
  }

  list(creatorId: string, options: { kind?: MediaAsset['kind']; limit?: number } = {}): MediaAsset[] {
    return [...this.assets.values()]
      .filter((asset) => asset.creatorId === creatorId)
      .filter((asset) => (options.kind ? asset.kind === options.kind : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit ?? 50)
  }

  async remove(id: string): Promise<boolean> {
    const asset = this.assets.get(id)
    if (!asset) return false
    await this.storage.delete(asset.storageKey)
    return this.assets.delete(id)
  }

  count(): number {
    return this.assets.size
  }

  /** Restores records after a restart; bytes are re-read through the port. */
  hydrate(assets: MediaAsset[]): void {
    for (const asset of assets) this.assets.set(asset.id, asset)
  }

  toJSON(): MediaAsset[] {
    return [...this.assets.values()]
  }
}

/**
 * Content-addressed key for text payloads, so regenerating the same thing does
 * not silently duplicate it.
 */
export function checksumOf(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

export function deterministicKey(creatorId: string, kind: string, brief: string): string {
  return `${creatorId}/${kind}/${stableId('gen', kind, brief).slice(5)}`
}
