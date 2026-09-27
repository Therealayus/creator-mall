import {
  CapabilityRegistry,
  DependencyGraph,
  PromptLibrary,
  createKnowledgeStore,
  isExpired,
  isRevoked,
  isSessionExpired,
  newId,
  nowIso,
  revokeSession,
} from '@creator-mall/core'
import type { CreatorAccount, KnowledgeStore, Session } from '@creator-mall/core'
import type {
  ChangeProposal,
  CreatorImpact,
  CreatorNotification,
  CreatorProfile,
  DependencyEdge,
  EvolutionEvent,
  KnowledgeDocument,
  KnowledgeVersion,
  PlatformSnapshot,
  PromptVersion,
  ResearchJobRun,
  SocialPlatform,
  Source,
  TemplateDefinition,
} from '@creator-mall/core'
import type { ControlPlaneState } from './persistence.js'

/**
 * The in-process control plane: every record the World Engine and Evolution
 * Engine read or write lives here. Deliberately framework-free so the engines
 * can be tested without HTTP and the API can be tested without a scheduler.
 */
export class ControlPlane {
  readonly capabilities = new CapabilityRegistry()
  readonly graph = new DependencyGraph()
  readonly prompts: PromptLibrary
  knowledge: KnowledgeStore

  private readonly platforms = new Map<string, SocialPlatform>()
  private readonly sources = new Map<string, Source>()
  private readonly snapshots = new Map<string, PlatformSnapshot[]>()
  private readonly events = new Map<string, EvolutionEvent[]>()
  private readonly proposals = new Map<string, ChangeProposal[]>()
  private readonly creators = new Map<string, CreatorProfile>()
  private readonly notifications = new Map<string, CreatorNotification[]>()
  private readonly impacts = new Map<string, CreatorImpact[]>()
  private readonly templates = new Map<string, TemplateDefinition[]>()
  private readonly jobRuns: ResearchJobRun[] = []

  constructor(state?: ControlPlaneState, prompts: PromptLibrary = new PromptLibrary()) {
    this.prompts = prompts
    this.knowledge = createKnowledgeStore()
    if (state) this.hydrate(state)
  }

  // ---------------------------------------------------------------- platforms
  listPlatforms(): SocialPlatform[] {
    return [...this.platforms.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  getPlatform(idOrSlug: string): SocialPlatform | undefined {
    return (
      this.platforms.get(idOrSlug) ??
      [...this.platforms.values()].find((platform) => platform.slug === idOrSlug)
    )
  }

  upsertPlatform(platform: SocialPlatform): SocialPlatform {
    this.platforms.set(platform.id, platform)
    return platform
  }

  // ----------------------------------------------------------------- sources
  listSources(): Source[] {
    return [...this.sources.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  getSource(id: string): Source | undefined {
    return this.sources.get(id)
  }

  upsertSource(source: Source): Source {
    this.sources.set(source.id, source)
    return source
  }

  sourcesForPlatform(slug: string): Source[] {
    return this.listSources().filter((source) => source.platform === slug && source.active)
  }

  // --------------------------------------------------------------- snapshots
  addSnapshot(snapshot: PlatformSnapshot): PlatformSnapshot {
    const list = this.snapshots.get(snapshot.platformId) ?? []
    list.push(snapshot)
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    this.snapshots.set(snapshot.platformId, list)
    return snapshot
  }

  snapshotsFor(platformId: string): PlatformSnapshot[] {
    return [...(this.snapshots.get(platformId) ?? [])]
  }

  latestSnapshot(platformId: string): PlatformSnapshot | undefined {
    const list = this.snapshots.get(platformId) ?? []
    return list[list.length - 1]
  }

  // ------------------------------------------------------------------ events
  addEvent(event: EvolutionEvent): EvolutionEvent {
    const key = event.platformId ?? 'global'
    const list = this.events.get(key) ?? []
    list.push(event)
    this.events.set(key, list)
    return event
  }

  listEvents(filter: { platformId?: string; status?: string } = {}): EvolutionEvent[] {
    const all = [...this.events.values()].flat()
    return all
      .filter((event) => (filter.platformId ? event.platformId === filter.platformId : true))
      .filter((event) => (filter.status ? event.status === filter.status : true))
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
  }

  getEvent(id: string): EvolutionEvent | undefined {
    return this.listEvents().find((event) => event.id === id)
  }

  eventsForCapability(platformId: string, capabilityKey: string): EvolutionEvent[] {
    return this.listEvents({ platformId }).filter((event) => event.affectedCapabilityKeys.includes(capabilityKey))
  }

  // --------------------------------------------------------------- proposals
  addProposal(proposal: ChangeProposal): ChangeProposal {
    const list = this.proposals.get(proposal.kind) ?? []
    list.push(proposal)
    this.proposals.set(proposal.kind, list)
    return proposal
  }

  listProposals(filter: { status?: string; riskLevel?: string } = {}): ChangeProposal[] {
    return [...this.proposals.values()]
      .flat()
      .filter((proposal) => (filter.status ? proposal.status === filter.status : true))
      .filter((proposal) => (filter.riskLevel ? proposal.riskLevel === filter.riskLevel : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getProposal(id: string): ChangeProposal | undefined {
    return this.listProposals().find((proposal) => proposal.id === id)
  }

  // ---------------------------------------------------------------- accounts
  /**
   * Accounts and sessions.
   *
   * Identity is kept apart from `CreatorProfile`: learning about a creator must
   * never grant access, and losing an account must not lose what was learned.
   */
  private readonly accounts = new Map<string, CreatorAccount>()
  private readonly sessions = new Map<string, Session>()

  /** accountId → creator profile id. One profile per account, by design. */
  readonly profileAccountLinks = new Map<string, string>()

  listAccounts(): CreatorAccount[] {
    return [...this.accounts.values()]
  }

  getAccount(id: string): CreatorAccount | undefined {
    return this.accounts.get(id)
  }

  getAccountByEmail(email: string): CreatorAccount | undefined {
    const key = email.trim().toLowerCase()
    return [...this.accounts.values()].find((account) => account.email.toLowerCase() === key)
  }

  /** The creator profile that belongs to an account, if it has one. */
  profileForAccount(accountId: string): CreatorProfile | undefined {
    const profileId = this.profileAccountLinks.get(accountId)
    return profileId ? this.creators.get(profileId) : undefined
  }

  linkProfileToAccount(accountId: string, profileId: string): void {
    this.profileAccountLinks.set(accountId, profileId)
  }

  upsertAccount(account: CreatorAccount): CreatorAccount {
    this.accounts.set(account.id, account)
    return account
  }

  addSession(session: Session): Session {
    this.sessions.set(session.id, session)
    return session
  }

  replaceSession(session: Session): Session {
    this.sessions.set(session.id, session)
    return session
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  listSessions(): Session[] {
    return [...this.sessions.values()]
  }

  revokeSessionsForAccount(accountId: string, clock: () => number = Date.now): number {
    let revoked = 0
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId && !isRevoked(session)) {
        this.sessions.set(session.id, revokeSession(session, clock))
        revoked += 1
      }
    }
    return revoked
  }

  pruneSessions(clock: () => number = Date.now): number {
    let removed = 0
    for (const [id, session] of this.sessions) {
      if (isSessionExpired(session, clock) || isRevoked(session)) {
        this.sessions.delete(id)
        removed += 1
      }
    }
    return removed
  }

  // ---------------------------------------------------------------- creators
  listCreators(): CreatorProfile[] {
    return [...this.creators.values()]
  }

  getCreator(id: string): CreatorProfile | undefined {
    return this.creators.get(id)
  }

  upsertCreator(creator: CreatorProfile): CreatorProfile {
    this.creators.set(creator.id, creator)
    return creator
  }

  addNotification(notification: CreatorNotification): CreatorNotification {
    const list = this.notifications.get(notification.creatorId) ?? []
    if (!list.some((existing) => existing.id === notification.id)) list.push(notification)
    this.notifications.set(notification.creatorId, list)
    return notification
  }

  listNotifications(creatorId: string): CreatorNotification[] {
    return [...(this.notifications.get(creatorId) ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  addImpact(impact: CreatorImpact): CreatorImpact {
    const list = this.impacts.get(impact.creatorId) ?? []
    const existing = list.findIndex((entry) => entry.id === impact.id)
    if (existing >= 0) list[existing] = impact
    else list.push(impact)
    this.impacts.set(impact.creatorId, list)
    return impact
  }

  listImpacts(creatorId?: string): CreatorImpact[] {
    if (creatorId) return [...(this.impacts.get(creatorId) ?? [])]
    return [...this.impacts.values()].flat()
  }

  // --------------------------------------------------------------- templates
  addTemplate(template: TemplateDefinition): TemplateDefinition {
    const list = this.templates.get(template.platformId) ?? []
    list.push(template)
    this.templates.set(template.platformId, list)
    return template
  }

  listTemplates(platformId?: string): TemplateDefinition[] {
    if (platformId) return [...(this.templates.get(platformId) ?? [])]
    return [...this.templates.values()].flat()
  }

  // ---------------------------------------------------------------- job runs
  addJobRun(run: ResearchJobRun): ResearchJobRun {
    this.jobRuns.unshift(run)
    this.jobRuns.splice(50)
    return run
  }

  listJobRuns(limit = 20): ResearchJobRun[] {
    return this.jobRuns.slice(0, limit)
  }

  // ------------------------------------------------------------- knowledge
  currentKnowledgeVersions(): KnowledgeVersion[] {
    return [...this.knowledge.versions.values()].filter((version) => version.status === 'CURRENT')
  }

  knowledgeByPlatform(platformId: string): Array<{ document: KnowledgeDocument; version: KnowledgeVersion | null }> {
    return [...this.knowledge.documents.values()]
      .filter((document) => document.platformId === platformId)
      .map((document) => ({
        document,
        version: document.currentVersionId ? (this.knowledge.versions.get(document.currentVersionId) ?? null) : null,
      }))
  }

  // --------------------------------------------------------- (de)hydration
  toState(): ControlPlaneState {
    return {
      platforms: this.listPlatforms(),
      sources: this.listSources(),
      snapshots: [...this.snapshots.entries()].flatMap(([, list]) => list),
      events: this.listEvents(),
      proposals: this.listProposals(),
      prompts: this.prompts.all(),
      templates: this.listTemplates(),
      creators: this.listCreators(),
      accounts: this.listAccounts(),
      notifications: [...this.notifications.values()].flat(),
      impacts: this.listImpacts(),
      knowledge: {
        documents: [...this.knowledge.documents.values()],
        versions: [...this.knowledge.versions.values()],
        chunks: [...this.knowledge.chunks.values()],
        facts: [...this.knowledge.facts.values()],
      },
      dependencyEdges: this.graph.toJSON(),
      jobRuns: this.jobRuns,
    }
  }

  private hydrate(state: ControlPlaneState): void {
    for (const platform of state.platforms) this.platforms.set(platform.id, platform)
    for (const source of state.sources) this.sources.set(source.id, source)
    for (const snapshot of state.snapshots) this.addSnapshot(snapshot)
    for (const event of state.events) this.addEvent(event)
    for (const proposal of state.proposals) this.addProposal(proposal)
    for (const creator of state.creators) this.creators.set(creator.id, creator)
    for (const account of state.accounts ?? []) this.accounts.set(account.id, account)
    for (const notification of state.notifications) this.addNotification(notification)
    for (const impact of state.impacts) this.addImpact(impact)
    for (const template of state.templates) this.addTemplate(template)
    for (const prompt of state.prompts) if (!this.prompts.get(prompt.promptKey, prompt.version)) this.prompts.add(prompt)
    this.knowledge.documents = new Map(state.knowledge.documents.map((document) => [document.id, document]))
    this.knowledge.versions = new Map(state.knowledge.versions.map((version) => [version.id, version]))
    this.knowledge.chunks = new Map(state.knowledge.chunks.map((chunk) => [chunk.id, chunk]))
    this.knowledge.facts = new Map(state.knowledge.facts.map((fact) => [fact.id, fact]))
    if (state.dependencyEdges.length > 0) {
      for (const edge of state.dependencyEdges) this.graph.link(edge.from, edge.to, edge.relation)
    }
    this.jobRuns.push(...state.jobRuns)
  }
}

export function freshnessSummary(control: ControlPlane, clock: () => number = Date.now): { current: number; stale: number } {
  const versions = control.currentKnowledgeVersions()
  const stale = versions.filter((version) => isExpired(version.expiresAt, clock)).length
  return { current: versions.length - stale, stale }
}

export { newId, nowIso }
export type {
  ChangeProposal,
  CreatorImpact,
  CreatorNotification,
  CreatorProfile,
  DependencyEdge,
  EvolutionEvent,
  KnowledgeDocument,
  KnowledgeVersion,
  PlatformSnapshot,
  PromptVersion,
  ResearchJobRun,
  SocialPlatform,
  Source,
  TemplateDefinition,
}
