import { nowIso } from '@creator-mall/core'
import type { ControlPlane } from '../store/control-plane.js'
import type { ResearchDeps, CycleResult } from './pipeline.js'
import { runResearchCycle } from './pipeline.js'

export interface SchedulerOptions {
  intervalMs: number
  /** Run one cycle immediately on start. */
  runOnStart?: boolean
  maxConsecutiveErrors?: number
  logger?: (message: string, payload?: unknown) => void
}

/**
 * §5 + §45: the loop that runs whether or not anyone is watching.
 *
 * A failing cycle never kills the loop and never deletes state (§38): the error
 * is recorded on the job run, the cadence backs off, and an operator sees it in
 * the health report.
 */
export class ResearchScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private consecutiveErrors = 0
  private stopped = true
  private readonly deps: ResearchDeps
  private readonly options: SchedulerOptions

  constructor(deps: ResearchDeps, options: SchedulerOptions) {
    this.deps = deps
    this.options = options
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    if (this.options.runOnStart) void this.runOnce()
    this.arm(this.options.intervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  isRunning(): boolean {
    return this.running
  }

  async runOnce(): Promise<CycleResult> {
    if (this.running) {
      return {
        id: 'skipped',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        status: 'SUCCESS',
        sourcesChecked: 0,
        sourcesFailed: 0,
        snapshotsCreated: 0,
        eventsCreated: 0,
        proposalsCreated: 0,
        knowledgePublished: 0,
        error: 'a cycle is already running',
        modelFallbacks: [],
        candidatesProbed: 0,
        embeddingsRefreshed: 0,
        events: [],
      }
    }
    this.running = true
    try {
      const result = await runResearchCycle(this.deps)
      this.consecutiveErrors = 0
      this.log('research cycle finished', {
        status: result.status,
        sourcesChecked: result.sourcesChecked,
        events: result.eventsCreated,
        proposals: result.proposalsCreated,
      })
      return result
    } catch (error) {
      this.consecutiveErrors += 1
      const message = error instanceof Error ? error.message : String(error)
      this.log('research cycle failed', { error: message, consecutiveErrors: this.consecutiveErrors })
      this.deps.control.addJobRun({
        id: `run_error_${this.consecutiveErrors}`,
        startedAt: nowIso(),
        finishedAt: nowIso(),
        status: 'FAILED',
        sourcesChecked: 0,
        sourcesFailed: 0,
        snapshotsCreated: 0,
        eventsCreated: 0,
        proposalsCreated: 0,
        knowledgePublished: 0,
        error: message,
      })
      return {
        id: `run_error_${this.consecutiveErrors}`,
        startedAt: nowIso(),
        finishedAt: nowIso(),
        status: 'FAILED',
        sourcesChecked: 0,
        sourcesFailed: 0,
        snapshotsCreated: 0,
        eventsCreated: 0,
        proposalsCreated: 0,
        knowledgePublished: 0,
        error: message,
        modelFallbacks: [],
        candidatesProbed: 0,
        embeddingsRefreshed: 0,
        events: [],
      }
    } finally {
      this.running = false
      if (!this.stopped) {
        const backoff = Math.min(4, this.consecutiveErrors)
        this.arm(this.options.intervalMs * (backoff > 0 ? backoff : 1))
      }
    }
  }

  private arm(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.runOnce(), delayMs)
    this.timer.unref?.()
  }

  private log(message: string, payload?: unknown): void {
    if (this.options.logger) this.options.logger(message, payload)
  }
}

export function startResearchScheduler(
  control: ControlPlane,
  deps: Omit<ResearchDeps, 'control'>,
  options: SchedulerOptions,
): ResearchScheduler {
  const scheduler = new ResearchScheduler({ ...deps, control }, options)
  scheduler.start()
  return scheduler
}
