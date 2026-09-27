import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { FilePersistence } from '../src/store/file-persistence.js'
import { MemoryPersistence } from '../src/store/persistence.js'
import { PostgresPersistence } from '../src/store/postgres-persistence.js'
import { FakeSql } from './fake-sql.js'
import type { ControlPlaneState, PersistencePort } from '../src/store/persistence.js'

/**
 * One contract, three stores.
 *
 * The Postgres store is exercised through a fake client that records every
 * statement: this proves the mapping is self-consistent and that the right rows
 * are written. It is **not** a test against a live database — that is what
 * `npm run db:migrate` and `npm run db:check` are for.
 */
const state = (): ControlPlaneState => ({
  platforms: [
    {
      id: 'pf_1',
      slug: 'example',
      name: 'Example',
      kind: 'CREATOR_NATIVE',
      status: 'ACTIVE',
      regions: ['GLOBAL'],
      capabilityKeys: ['SHORT_VIDEO'],
      trustLevel: 'OFFICIAL',
      firstSeenAt: '2026-09-01T00:00:00.000Z',
      integrationState: 'PREPARING',
      metadata: { seeded: true },
    },
  ],
  sources: [
    {
      id: 'src_1',
      name: 'Example docs',
      url: 'https://creators.example.com/',
      domain: 'creators.example.com',
      sourceType: 'DOCUMENTATION',
      platform: 'example',
      trustLevel: 'OFFICIAL',
      discoveredVia: 'SEED',
      lastCheckedAt: null,
      nextCheckAt: null,
      active: true,
      lastStatus: 'NEVER_CHECKED',
      consecutiveFailures: 0,
      stats: { checks: 2, successes: 2, failures: 0, blocked: 0, factsContributed: 1, eventsContributed: 0, lastFactAt: null },
    },
  ],
  snapshots: [],
  events: [],
  proposals: [],
  prompts: [],
  templates: [],
  creators: [],
  accounts: [
    {
      id: 'acc_1',
      email: 'creator@example.com',
      passwordHash: 'scrypt$16384$8$1$abc$def',
      displayName: 'Creator',
      role: 'CREATOR',
      status: 'ACTIVE',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: null,
      consecutiveFailures: 0,
      lockedUntil: null,
    },
  ],
  sessions: [
    {
      id: 'ses_1',
      tokenHash: 'hash-1',
      csrfToken: 'csrf-1',
      accountId: 'acc_1',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z',
      revokedAt: null,
      userAgent: null,
    },
  ],
  notifications: [],
  impacts: [],
  knowledge: {
    documents: [
      {
        id: 'kd_1',
        slug: 'platform/example/capabilities',
        title: 'Example: what creators can do',
        topic: 'platform-capabilities',
        platformId: 'pf_1',
        currentVersionId: 'kv_1',
        ttlPolicy: 'PLATFORM_GENERAL',
        status: 'CURRENT',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        updatedBy: 'WORLD_ENGINE',
      },
    ],
    versions: [
      {
        id: 'kv_1',
        documentId: 'kd_1',
        version: 1,
        body: 'Maximum video length is 15 seconds.',
        factIds: [],
        sourceIds: ['src_1'],
        trustLevel: 'OFFICIAL',
        confidence: 0.9,
        createdAt: '2026-09-01T00:00:00.000Z',
        publishedAt: '2026-09-01T00:00:00.000Z',
        verifiedAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-12-01T00:00:00.000Z',
        status: 'CURRENT',
        changeNote: 'first',
        createdBy: 'WORLD_ENGINE',
      },
    ],
    chunks: [
      {
        id: 'kc_1',
        versionId: 'kv_1',
        documentId: 'kd_1',
        ordinal: 0,
        text: 'Maximum video length is 15 seconds.',
        tokenEstimate: 8,
        embedding: null,
        sourceIds: ['src_1'],
        platformId: 'pf_1',
        topic: 'platform-capabilities',
      },
    ],
    facts: [],
  },
  dependencyEdges: [],
  jobRuns: [],
  observations: [],
  preferences: [],
  preferenceCounters: [],
})

const directories: string[] = []
after(async () => {
  for (const dir of directories) await rm(dir, { recursive: true, force: true })
})

async function fileStore(): Promise<FilePersistence> {
  const dir = await mkdtemp(join(tmpdir(), 'creator-mall-store-'))
  directories.push(dir)
  return new FilePersistence(dir)
}

function contract(name: string, build: () => Promise<{ port: PersistencePort; extra?: () => void }>): void {
  describe(`persistence contract: ${name}`, () => {
    it('returns null when there is nothing stored', async () => {
      const { port } = await build()
      assert.equal(await port.load(), null)
    })

    it('round-trips a full control plane', async () => {
      const { port, extra } = await build()
      const original = state()
      await port.save(original)
      const loaded = await port.load()
      extra?.()

      assert.ok(loaded)
      assert.equal(loaded.platforms.length, 1)
      assert.equal(loaded.platforms[0]?.slug, 'example')
      assert.equal(loaded.sources[0]?.stats?.factsContributed, 1)
      assert.equal(loaded.accounts[0]?.email, 'creator@example.com')
      assert.equal(loaded.sessions[0]?.tokenHash, 'hash-1')
      assert.equal(loaded.knowledge.documents[0]?.slug, 'platform/example/capabilities')
      assert.equal(loaded.knowledge.versions[0]?.body, 'Maximum video length is 15 seconds.')
      assert.equal(loaded.knowledge.chunks[0]?.text, 'Maximum video length is 15 seconds.')
    })

    it('replaces rather than merges, so deletions are not resurrected', async () => {
      const { port } = await build()
      await port.save(state())
      const reduced = state()
      reduced.knowledge.documents = []
      reduced.knowledge.versions = []
      reduced.knowledge.chunks = []
      await port.save(reduced)

      const loaded = await port.load()
      assert.equal(loaded?.knowledge.documents.length, 0)
      assert.equal(loaded?.knowledge.versions.length, 0)
      assert.equal(loaded?.platforms.length, 1, 'untouched collections survive')
    })

    it('survives being written twice', async () => {
      const { port } = await build()
      await port.save(state())
      await port.save(state())
      const loaded = await port.load()
      assert.equal(loaded?.platforms.length, 1)
      assert.equal(loaded?.accounts.length, 1)
    })
  })
}

contract('memory', async () => ({ port: new MemoryPersistence() }))
contract('json file', async () => ({ port: await fileStore() }))

describe('persistence contract: postgres (fake client)', () => {
  it('returns null when the schema has never been applied', async () => {
    const sql = new FakeSql()
    const port = new PostgresPersistence(sql)
    assert.equal(await port.load(), null)
  })

  it('round-trips a full control plane through the mapping', async () => {
    const sql = new FakeSql()
    const port = new PostgresPersistence(sql)
    await port.save(state())
    const loaded = await port.load()

    assert.equal(loaded?.platforms[0]?.slug, 'example')
    assert.equal(loaded?.sources[0]?.stats?.factsContributed, 1)
    assert.equal(loaded?.accounts[0]?.passwordHash, 'scrypt$16384$8$1$abc$def')
    assert.equal(loaded?.sessions[0]?.csrfToken, 'csrf-1')
    assert.equal(loaded?.knowledge.versions[0]?.status, 'CURRENT')
    assert.equal(loaded?.knowledge.chunks.length, 1)
  })

  it('writes inside one transaction and records a schema version', async () => {
    const sql = new FakeSql()
    const port = new PostgresPersistence(sql)
    await port.save(state())

    const statements = sql.statements().map((entry) => entry.text)
    assert.ok(statements.includes('BEGIN'))
    assert.ok(statements.includes('COMMIT'))
    assert.ok(!statements.includes('ROLLBACK'))
    assert.ok(statements.some((text) => text.includes('INSERT INTO cm_meta')))
    assert.ok(statements.some((text) => text.includes('INSERT INTO cm_preference_counter')) === false, 'no counters when none exist')
  })

  it('rolls back and rethrows when a write fails', async () => {
    const sql = new FakeSql()
    const port = new PostgresPersistence(sql)
    sql.failOnFragment('INSERT INTO cm_platform')

    await assert.rejects(() => port.save(state()))
    const statements = sql.statements().map((entry) => entry.text)
    assert.ok(statements.includes('ROLLBACK'))
    assert.ok(!statements.includes('COMMIT'))
  })

  it('clears the projection before writing, so a delete really deletes', async () => {
    const sql = new FakeSql()
    const port = new PostgresPersistence(sql)
    await port.save(state())
    const deletes = sql.statements().filter((entry) => entry.text.startsWith('DELETE FROM'))
    assert.ok(deletes.length > 10, 'every owned table is cleared')
    assert.ok(deletes.some((entry) => entry.text.includes('cm_knowledge_version')))
  })

  it('never writes a password hash into a column a reader might log', async () => {
    const sql = new FakeSql()
    const port = new PostgresPersistence(sql)
    await port.save(state())
    const accountInsert = sql
      .statements()
      .find((entry) => entry.text.includes('INSERT INTO cm_account'))
    assert.ok(accountInsert)
    // The hash travels inside the jsonb document, not as a queryable column.
    assert.equal(accountInsert.text.includes('password_hash'), false)
  })
})
