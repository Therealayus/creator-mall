import { createContext } from './context.js'
import { createApp } from './api/app.js'
import { limiterFor } from './api/auth.js'
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
      {
        control: context.control,
        fetcher: context.fetcher,
        modelExtractor: context.modelExtractor,
        embeddingProvider: context.embeddingProvider,
        onModelFallback: (reason) => console.log(`[world-engine] model extraction skipped: ${reason}`),
        // Autonomous research that is never written down is wasted work.
        onCycleComplete: () => context.persist(),
      },
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
    // Flush before closing: everything the World Engine and the auth routes
    // learned is only in memory until this runs.
    void context
      .persist()
      .catch((error: unknown) => {
        console.error('[creator-mall] could not flush state on shutdown', error)
      })
      .finally(() => {
        server.close(() => process.exit(0))
        // Do not let a stuck connection hold the process open forever.
        setTimeout(() => process.exit(0), 15_000).unref()
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // A rejection that reaches here is otherwise silent, and Node exits on an
  // unhandled rejection without anything in the logs saying why.
  process.on('unhandledRejection', (reason) => {
    console.error('[creator-mall] unhandled rejection', reason)
  })
  process.on('uncaughtException', (error) => {
    console.error('[creator-mall] uncaught exception', error)
    shutdown('uncaughtException')
  })

  /**
   * Housekeeping.
   *
   * Sessions and rate-limit windows are keyed by something the process does not
   * control, and both have a prune method that nothing was calling. Without this
   * tick both grow for the lifetime of the process.
   */
  const housekeeping = setInterval(() => {
    const sessions = context.control.pruneSessions()
    const windows = limiterFor(context).prune({
      bucket: '',
      windowMs: context.config.AUTH_RATE_WINDOW_MS,
    })
    if (sessions > 0 || windows > 0) {
      console.log(`[creator-mall] housekeeping: pruned ${sessions} sessions, ${windows} rate-limit windows`)
    }
  }, 10 * 60_000)
  housekeeping.unref()
}

main().catch((error: unknown) => {
  console.error('[creator-mall] failed to start', error)
  process.exit(1)
})
