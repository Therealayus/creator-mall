import type { ControlPlaneState, PersistencePort, ProfileAccountLink } from './persistence.js'
import type {
  ChangeProposal,
  CreatorAccount,
  CreatorImpact,
  CreatorNotification,
  CreatorObservation,
  CreatorProfile,
  DependencyEdge,
  EvolutionEvent,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeFact,
  MediaAsset,
  KnowledgeVersion,
  LearnedPreference,
  PlatformSnapshot,
  PromptVersion,
  ResearchJobRun,
  Session,
  SocialPlatform,
  Source,
  TemplateDefinition,
} from '@creator-mall/core'
import type { SqlClient } from './sql-client.js'
import { schemaVersion } from './sql-migrate.js'

/**
 * Postgres persistence.
 *
 * The control plane is normalised where rows are queried and stored as JSONB
 * where they are read whole. Writes replace the projection inside one
 * transaction, so a crash mid-write cannot leave a half-saved control plane —
 * the same guarantee the JSON file store gives.
 *
 * Honest scope: the mapping is covered by a contract test against a fake
 * client, not against a live database. Run `npm run db:migrate` and
 * `npm run db:check` to verify it against real Postgres.
 */
export class PostgresPersistence implements PersistencePort {
  private readonly client: SqlClient

  constructor(client: SqlClient) {
    this.client = client
  }

  async load(): Promise<ControlPlaneState | null> {
    const meta = await this.client.query('SELECT schema_version FROM cm_meta WHERE id = 1')
    if (meta.rowCount === 0) return null

    const state = emptyState()

    state.platforms = await this.docs<SocialPlatform>('SELECT doc FROM cm_platform ORDER BY slug')
    state.sources = await this.docs<Source>('SELECT doc FROM cm_source ORDER BY id')
    state.snapshots = await this.docs<PlatformSnapshot>('SELECT doc FROM cm_snapshot ORDER BY captured_at')
    state.events = await this.docs<EvolutionEvent>('SELECT doc FROM cm_event ORDER BY detected_at DESC')
    state.proposals = await this.docs<ChangeProposal>('SELECT doc FROM cm_proposal ORDER BY created_at DESC')
    state.knowledge.documents = await this.docs<KnowledgeDocument>('SELECT doc FROM cm_knowledge_document ORDER BY slug')
    state.knowledge.versions = await this.docs<KnowledgeVersion>('SELECT doc FROM cm_knowledge_version ORDER BY created_at')
    state.knowledge.chunks = await this.docs<KnowledgeChunk>('SELECT doc FROM cm_knowledge_chunk ORDER BY ordinal')
    state.knowledge.facts = await this.docs<KnowledgeFact>('SELECT doc FROM cm_knowledge_fact ORDER BY id')
    state.accounts = await this.docs<CreatorAccount>('SELECT doc FROM cm_account ORDER BY created_at')
    state.sessions = await this.docs<Session>('SELECT doc FROM cm_session ORDER BY id')
    state.assets = await this.docs<MediaAsset>('SELECT doc FROM cm_media_asset ORDER BY created_at DESC')
    for (const link of await this.docs<ProfileAccountLink>(
      'SELECT doc FROM cm_profile_account_link ORDER BY account_id',
    )) {
      state.profileAccountLinks = [...(state.profileAccountLinks ?? []), link]
    }
    state.creators = await this.docs<CreatorProfile>('SELECT doc FROM cm_creator_profile ORDER BY id')
    state.notifications = await this.docs<CreatorNotification>('SELECT doc FROM cm_notification ORDER BY created_at DESC')
    state.impacts = await this.docs<CreatorImpact>('SELECT doc FROM cm_impact ORDER BY id')
    state.prompts = await this.docs<PromptVersion>('SELECT doc FROM cm_prompt_version ORDER BY prompt_key, version')
    state.templates = await this.docs<TemplateDefinition>('SELECT doc FROM cm_template ORDER BY id')
    state.jobRuns = await this.docs<ResearchJobRun>('SELECT doc FROM cm_job_run ORDER BY finished_at DESC')
    state.dependencyEdges = await this.docs<DependencyEdge>('SELECT doc FROM cm_dependency_edge ORDER BY id')
    state.observations = await this.docs<CreatorObservation>('SELECT doc FROM cm_preference_observation ORDER BY at DESC')
    state.preferences = await this.docs<LearnedPreference>('SELECT doc FROM cm_preference ORDER BY id')
    state.preferenceCounters = await this.counters()

    return state
  }

  async save(state: ControlPlaneState): Promise<void> {
    await this.client.transaction(async (tx) => {
      // The projection is replaced wholesale: a control plane is small, and a
      // single transaction is easier to reason about than partial upserts.
      for (const table of TABLES) await tx.query(`DELETE FROM ${table}`)

      for (const platform of state.platforms) {
        await tx.query(
          'INSERT INTO cm_platform (id, slug, name, status, doc) VALUES ($1,$2,$3,$4,$5)',
          [platform.id, platform.slug, platform.name, platform.status, json(platform)],
        )
      }

      for (const source of state.sources) {
        await tx.query(
          'INSERT INTO cm_source (id, domain, platform, active, last_status, checked_at, facts, doc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [source.id, source.domain, source.platform, source.active, source.lastStatus, source.lastCheckedAt, source.stats?.factsContributed ?? 0, json(source)],
        )
      }

      for (const snapshot of state.snapshots) {
        await tx.query(
          'INSERT INTO cm_snapshot (id, platform_id, captured_at, state_hash, doc) VALUES ($1,$2,$3,$4,$5)',
          [snapshot.id, snapshot.platformId, snapshot.capturedAt, snapshot.stateHash, json(snapshot)],
        )
      }

      for (const event of state.events) {
        await tx.query(
          'INSERT INTO cm_event (id, platform_id, detected_at, risk_level, status, doc) VALUES ($1,$2,$3,$4,$5,$6)',
          [event.id, event.platformId, event.detectedAt, event.riskLevel, event.status, json(event)],
        )
      }

      for (const proposal of state.proposals) {
        await tx.query(
          'INSERT INTO cm_proposal (id, event_id, kind, status, risk_level, created_at, doc) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [proposal.id, proposal.eventId, proposal.kind, proposal.status, proposal.riskLevel, proposal.createdAt, json(proposal)],
        )
      }

      for (const document of state.knowledge.documents) {
        await tx.query(
          'INSERT INTO cm_knowledge_document (id, slug, topic, status, updated_at, doc) VALUES ($1,$2,$3,$4,$5,$6)',
          [document.id, document.slug, document.topic, document.status, document.updatedAt, json(document)],
        )
      }
      for (const version of state.knowledge.versions) {
        await tx.query(
          'INSERT INTO cm_knowledge_version (id, document_id, version, status, expires_at, created_at, doc) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [version.id, version.documentId, version.version, version.status, version.expiresAt, version.createdAt, json(version)],
        )
      }
      for (const chunk of state.knowledge.chunks) {
        await tx.query(
          'INSERT INTO cm_knowledge_chunk (id, version_id, ordinal, text, doc) VALUES ($1,$2,$3,$4,$5)',
          [chunk.id, chunk.versionId, chunk.ordinal, chunk.text, json(chunk)],
        )
      }
      for (const fact of state.knowledge.facts) {
        await tx.query('INSERT INTO cm_knowledge_fact (id, key, status, doc) VALUES ($1,$2,$3,$4)', [
          fact.id,
          fact.key,
          fact.status,
          json(fact),
        ])
      }

      for (const account of state.accounts) {
        await tx.query('INSERT INTO cm_account (id, email, role, status, created_at, doc) VALUES ($1,$2,$3,$4,$5,$6)', [
          account.id,
          account.email,
          account.role,
          account.status,
          account.createdAt,
          json(account),
        ])
      }
      for (const session of state.sessions ?? []) {
        await tx.query(
          'INSERT INTO cm_session (id, account_id, token_hash, expires_at, revoked_at, doc) VALUES ($1,$2,$3,$4,$5,$6)',
          [session.id, session.accountId, session.tokenHash, session.expiresAt, session.revokedAt, json(session)],
        )
      }
      for (const creator of state.creators) {
        await tx.query('INSERT INTO cm_creator_profile (id, updated_at, doc) VALUES ($1,$2,$3)', [
          creator.id,
          creator.createdAt,
          json(creator),
        ])
      }
      for (const asset of state.assets ?? []) {
        await tx.query('INSERT INTO cm_media_asset (id, creator_id, kind, created_at, doc) VALUES ($1,$2,$3,$4,$5)', [
          asset.id,
          asset.creatorId,
          asset.kind,
          asset.createdAt,
          json(asset),
        ])
      }
      for (const link of state.profileAccountLinks ?? []) {
        await tx.query('INSERT INTO cm_profile_account_link (account_id, doc) VALUES ($1,$2)', [
          link.accountId,
          json(link),
        ])
      }
      for (const notification of state.notifications) {
        await tx.query('INSERT INTO cm_notification (id, creator_id, created_at, doc) VALUES ($1,$2,$3,$4)', [
          notification.id,
          notification.creatorId,
          notification.createdAt,
          json(notification),
        ])
      }
      for (const impact of state.impacts) {
        await tx.query('INSERT INTO cm_impact (id, creator_id, event_id, level, doc) VALUES ($1,$2,$3,$4,$5)', [
          impact.id,
          impact.creatorId,
          impact.eventId,
          impact.level,
          json(impact),
        ])
      }
      for (const prompt of state.prompts) {
        await tx.query(
          'INSERT INTO cm_prompt_version (id, prompt_key, version, status, created_at, doc) VALUES ($1,$2,$3,$4,$5,$6)',
          [prompt.id, prompt.promptKey, prompt.version, prompt.status, prompt.createdAt, json(prompt)],
        )
      }
      for (const template of state.templates) {
        await tx.query(
          'INSERT INTO cm_template (id, platform_id, capability_key, status, doc) VALUES ($1,$2,$3,$4,$5)',
          [template.id, template.platformId, template.capabilityKey, template.status, json(template)],
        )
      }
      for (const run of state.jobRuns) {
        await tx.query('INSERT INTO cm_job_run (id, finished_at, status, doc) VALUES ($1,$2,$3,$4)', [
          run.id,
          run.finishedAt,
          run.status,
          json(run),
        ])
      }
      for (const edge of state.dependencyEdges) {
        await tx.query(
          'INSERT INTO cm_dependency_edge (from_kind, from_ref, to_kind, to_ref, relation, doc) VALUES ($1,$2,$3,$4,$5,$6)',
          [edge.from.kind, edge.from.ref, edge.to.kind, edge.to.ref, edge.relation, json(edge)],
        )
      }
      for (const observation of state.observations ?? []) {
        await tx.query(
          'INSERT INTO cm_preference_observation (id, creator_id, at, kind, doc) VALUES ($1,$2,$3,$4,$5)',
          [observation.id, observation.creatorId, observation.at, observation.kind, json(observation)],
        )
      }
      for (const preference of state.preferences ?? []) {
        await tx.query(
          'INSERT INTO cm_preference (id, creator_id, key, value, enabled, doc) VALUES ($1,$2,$3,$4,$5,$6)',
          [preference.id, preference.creatorId, preference.key, preference.value, preference.enabled, json(preference)],
        )
      }
      for (const counter of state.preferenceCounters ?? []) {
        await tx.query(
          'INSERT INTO cm_preference_counter (id, creator_id, key, value, weight) VALUES ($1,$2,$3,$4,$5)',
          [counter.id, counter.creatorId, counter.key, counter.value, counter.weight],
        )
      }

      await tx.query(
        'INSERT INTO cm_meta (id, schema_version, updated_at) VALUES (1,$1,now()) ON CONFLICT (id) DO UPDATE SET schema_version = $1, updated_at = now()',
        [schemaVersion],
      )
    })
  }

  private async counters(): Promise<ControlPlaneState['preferenceCounters']> {
    const result = await this.client.query('SELECT id, creator_id, key, value, weight FROM cm_preference_counter ORDER BY id')
    return result.rows.map((row) => ({
      id: String(row.id),
      creatorId: String(row.creator_id),
      key: String(row.key),
      value: String(row.value),
      weight: Number(row.weight ?? 0),
    }))
  }

  /** Rows come back as JSONB; parsing happens in one place. */
  private async docs<T>(text: string): Promise<T[]> {
    const result = await this.client.query(text)
    return result.rows.map((row) => {
      const doc = row.doc
      return (typeof doc === 'string' ? JSON.parse(doc) : doc) as T
    })
  }
}

/** Every table the projection owns, in an order safe to truncate. */
const TABLES = [
  'cm_knowledge_chunk',
  'cm_knowledge_fact',
  'cm_knowledge_version',
  'cm_knowledge_document',
  'cm_session',
  'cm_account',
  'cm_notification',
  'cm_impact',
  'cm_creator_profile',
  'cm_preference_counter',
  'cm_preference',
  'cm_preference_observation',
  'cm_dependency_edge',
  'cm_job_run',
  'cm_template',
  'cm_prompt_version',
  'cm_proposal',
  'cm_event',
  'cm_snapshot',
  'cm_source',
  'cm_platform',
]

function json(value: unknown): string {
  return JSON.stringify(value)
}

function emptyState(): ControlPlaneState {
  return {
    platforms: [],
    sources: [],
    snapshots: [],
    events: [],
    proposals: [],
    prompts: [],
    templates: [],
    creators: [],
    accounts: [],
    sessions: [],
    notifications: [],
    impacts: [],
    knowledge: { documents: [], versions: [], chunks: [], facts: [] },
    dependencyEdges: [],
    jobRuns: [],
    observations: [],
    preferences: [],
    preferenceCounters: [],
    assets: [],
    profileAccountLinks: [],
  }
}
