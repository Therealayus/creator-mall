/** Generated and uploaded assets, and what produced them. */

export const ASSET_KINDS = ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'STORYBOARD'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

export const ASSET_ORIGINS = ['GENERATED', 'UPLOADED'] as const
export type AssetOrigin = (typeof ASSET_ORIGINS)[number]

export interface MediaAsset {
  id: string
  creatorId: string
  kind: AssetKind
  origin: AssetOrigin
  /** Short, creator-facing title, e.g. the first line of the post. */
  title: string
  mimeType: string
  /** Where the bytes live, resolved through the storage port. */
  storageKey: string
  sizeBytes: number
  /** The brief the creator gave, kept so the asset can be regenerated. */
  brief: string
  platformSlug: string | null
  capabilityKey: string | null
  /**
   * What actually made this. A hosted model, the deterministic renderer, or an
   * upload — never left blank, so nothing is ever passed off as something it is
   * not.
   */
  producedBy: string
  /** True when a model was involved, so the creator is never misled. */
  modelGenerated: boolean
  createdAt: string
  /** Optional structural payload: shot list, caption timing, poster spec. */
  meta: Record<string, unknown>
}

export interface AssetSummary {
  id: string
  kind: AssetKind
  title: string
  sizeBytes: number
  producedBy: string
  modelGenerated: boolean
  createdAt: string
  platformSlug: string | null
}
