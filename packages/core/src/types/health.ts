import type { HealthStatus, SystemComponent } from './enums.js'

export interface ComponentHealth {
  component: SystemComponent
  status: HealthStatus
  percent: number
  detail: string
  measuredAt: string
  metrics: Record<string, number>
}

export interface SystemHealthReport {
  generatedAt: string
  overall: HealthStatus
  components: ComponentHealth[]
  alerts: HealthAlert[]
}

export interface HealthAlert {
  id: string
  component: SystemComponent
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  message: string
  raisedAt: string
  resolvedAt: string | null
}

export interface ResearchJobRun {
  id: string
  startedAt: string
  finishedAt: string
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  sourcesChecked: number
  sourcesFailed: number
  snapshotsCreated: number
  eventsCreated: number
  proposalsCreated: number
  knowledgePublished: number
  error: string | null
}
