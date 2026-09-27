import { createContext } from './context.js'
import { createApp } from './api/app.js'
import { ResearchScheduler } from './world-engine/scheduler.js'

/**
 * Process entry point. The HTTP control plane starts immediately; the World
 * Engine only starts when explicitly enabled, so a developer machine never
 * makes outbound requests without asking.
 */
async function main(): Promise<void> {
  const context = await createContext()
  const app = createApp(context)

  const server = app.listen(context.config.PORT, context.config.HOST, () => {
    console.log(`[creator-mall] api      http://${context.config.HOST}:${context.config.PORT}`)
    console.log(`[creator-mall] evolution center  http://${context.config.HOST}:${context.config.PORT}/evolution-center`)
  })

  let scheduler: ResearchScheduler | null = null
  if (context.config.RESEARCH_ENABLED) {
    scheduler = new ResearchScheduler(
      { control: context.control, fetcher: context.fetcher },
      {
        intervalMs: context.config.RESEARCH_INTERVAL_MS,
        logger: (message, payload) => console.log(`[world-engine] ${message}`, payload ?? ''),
      },
    )
    scheduler.start()
    console.log(`[world-engine] scheduled research every ${context.config.RESEARCH_INTERVAL_MS}ms`)
  } else {
    console.log('[world-engine] disabled (set RESEARCH_ENABLED=true to run the loop)')
  }

  const shutdown = (signal: string): void => {
    console.log(`[creator-mall] ${signal} received, shutting down`)
    scheduler?.stop()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  console.error('[creator-mall] failed to start', error)
  process.exit(1)
})
