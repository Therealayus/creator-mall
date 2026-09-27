import { createContext } from '../context.js'
import { nowIso } from '@creator-mall/core'

/**
 * Seeds the control plane with the starting watchlist, source registry, prepared
 * structures and the demo creator, then persists it when a data directory is set.
 */
async function main(): Promise<void> {
  const context = await createContext()
  const { control } = context
  await context.persistence.save(control.toState())

  console.log(
    JSON.stringify(
      {
        platforms: control.listPlatforms().length,
        sources: control.listSources().length,
        capabilities: control.capabilities.all().length,
        templates: control.listTemplates().length,
        creators: control.listCreators().map((creator) => ({ id: creator.id, name: creator.displayName })),
        seededAt: nowIso(),
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
