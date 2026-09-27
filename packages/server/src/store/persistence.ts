import type {
  CreatorImpact,
  CreatorNotification,
  CreatorProfile,
} from '@creator-mall/core'
import type {
  ChangeProposal,
  DependencyEdge,
  EvolutionEvent,
  PlatformSnapshot,
  PromptVersion,
  TemplateDefinition,
} from '@creator-mall/core'
import type { ResearchJobRun } from '@creator-mall/core'
import type { SocialPlatform } from '@creator-mall/core'
import type { Source } from '@creator-mall/core'
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeFact, KnowledgeVersion } from '@creator-mall/core'

export interface SerializedKnowledge {
  documents: KnowledgeDocument[]
  versions: KnowledgeVersion[]
  chunks: KnowledgeChunk[]
  facts: KnowledgeFact[]
}

export interface ControlPlaneState {
  platforms: SocialPlatform[]
  sources: Source[]
  snapshots: PlatformSnapshot[]
  events: EvolutionEvent[]
  proposals: ChangeProposal[]
  prompts: PromptVersion[]
  templates: TemplateDefinition[]
  creators: CreatorProfile[]
  notifications: CreatorNotification[]
  impacts: CreatorImpact[]
  knowledge: SerializedKnowledge
  dependencyEdges: DependencyEdge[]
  jobRuns: ResearchJobRun[]
}

export interface PersistencePort {
  load(): Promise<ControlPlaneState | null>
  save(state: ControlPlaneState): Promise<void>
}

/** Phase 1 keeps the control plane in memory; Phase 2 moves it to Postgres. */
export class MemoryPersistence implements PersistencePort {
  private state: ControlPlaneState | null = null

  load(): Promise<ControlPlaneState | null> {
    return Promise.resolve(this.state)
  }

  save(state: ControlPlaneState): Promise<void> {
    this.state = state
    return Promise.resolve()
  }
}
