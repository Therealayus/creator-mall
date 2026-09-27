import { createContext } from '../context.js'
import { runResearchCycle } from '../world-engine/pipeline.js'

/** Runs exactly one World Engine cycle and prints what it found. */
async function main(): Promise<void> {
  const context = await createContext()
  const result = await runResearchCycle({
    control: context.control,
    fetcher: context.fetcher,
    modelExtractor: context.modelExtractor,
    respectSchedule: false,
    onModelFallback: (reason) => console.log(`[world-engine] model extraction skipped: ${reason}`),
  })

  console.log(
    JSON.stringify(
      {
        status: result.status,
        model: context.modelExtractor ? context.modelExtractor.name : 'deterministic only',
        sourcesChecked: result.sourcesChecked,
        sourcesFailed: result.sourcesFailed,
        snapshotsCreated: result.snapshotsCreated,
        eventsCreated: result.eventsCreated,
        proposalsCreated: result.proposalsCreated,
        knowledgePublished: result.knowledgePublished,
        modelFallbacks: result.modelFallbacks,
      },
      null,
      2,
    ),
  )
  for (const event of result.events) {
    console.log(`- [${event.riskLevel}] ${event.title} (${event.trustLevel})`)
  }
  await context.persistence.save(context.control.toState())
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
