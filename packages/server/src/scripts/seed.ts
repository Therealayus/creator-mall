import { stableId } from '@creator-mall/core'
import type { CreatorProfile } from '@creator-mall/core'
import { createContext } from '../context.js'

/**
 * Seeds the control plane with the starting watchlist plus one demo creator, so
 * the Evolution Center and the creator-facing views have something to show.
 */
async function main(): Promise<void> {
  const context = await createContext()
  const { control } = context

  const creator: CreatorProfile = {
    id: stableId('cr', 'demo-video-creator'),
    displayName: 'Demo video creator',
    platformSlugs: ['youtube', 'instagram', 'tiktok'],
    contentTypes: ['SHORT_VIDEO', 'LONG_VIDEO'],
    usedCapabilityKeys: ['SHORT_VIDEO', 'LONG_VIDEO', 'VIDEO_MEDIA', 'SCHEDULING', 'ANALYTICS', 'THUMBNAIL'],
    goals: ['grow reach', 'publish more often'],
    locales: ['en'],
    createdAt: new Date().toISOString(),
  }
  control.upsertCreator(creator)

  await context.persistence.save(control.toState())

  console.log(
    JSON.stringify(
      {
        platforms: control.listPlatforms().length,
        sources: control.listSources().length,
        capabilityKeys: control.capabilities.all().length,
        creators: control.listCreators().map((entry) => ({ id: entry.id, name: entry.displayName })),
        dataDir: context.config.DATA_DIR || '(memory only)',
      },
      null,
      2,
    ),
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
