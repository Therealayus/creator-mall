import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PromptLibrary, createKnowledgeStore, expireStaleKnowledge, retrieveKnowledge, upsertDocument } from '../src/index.js'
import { buildHealthReport } from '../src/index.js'
import type { EvolutionEvent, ChangeProposal, KnowledgeVersion, Source } from '../src/index.js'

function store() {
  return createKnowledgeStore()
}

const clock = (): number => Date.parse('2026-09-27T12:00:00.000Z')

describe('knowledge versioning', () => {
  it('supersedes the previous version instead of overwriting it', () => {
    const knowledge = store()
    const first = upsertDocument(knowledge, {
      slug: 'platform/example/limits',
      title: 'Example limits',
      topic: 'platform-limits',
      platformId: 'pf_1',
      body: 'Maximum video length is 90 seconds.',
      sourceIds: ['src_1'],
      trustLevel: 'OFFICIAL',
      confidence: 0.9,
      ttlPolicy: 'PLATFORM_LIMIT',
      clock,
    })
    const second = upsertDocument(knowledge, {
      slug: 'platform/example/limits',
      title: 'Example limits',
      topic: 'platform-limits',
      platformId: 'pf_1',
      body: 'Maximum video length is 15 seconds.',
      sourceIds: ['src_1'],
      trustLevel: 'OFFICIAL',
      confidence: 0.95,
      ttlPolicy: 'PLATFORM_LIMIT',
      clock,
    })

    assert.equal(second.version.version, 2)
    assert.equal(first.version.status, 'SUPERSEDED')
    assert.equal(second.version.status, 'CURRENT')
    assert.equal(knowledge.versions.size, 2)
    // Old chunks are dropped from retrieval but the version record survives.
    assert.equal([...knowledge.chunks.values()].filter((chunk) => chunk.versionId === first.version.id).length, 0)
  })

  it('expires stale knowledge without deleting it (§15, §38)', () => {
    const knowledge = store()
    const { version } = upsertDocument(knowledge, {
      slug: 'platform/example/limits',
      title: 'Example limits',
      topic: 'platform-limits',
      platformId: 'pf_1',
      body: 'Maximum video length is 90 seconds.',
      sourceIds: ['src_1'],
      trustLevel: 'OFFICIAL',
      confidence: 0.9,
      ttlPolicy: 'PLATFORM_LIMIT',
      clock,
    })

    assert.equal(expireStaleKnowledge(knowledge, clock), 0)
    const later = (): number => clock() + 30 * 86_400_000
    assert.equal(expireStaleKnowledge(knowledge, later), 1)
    assert.equal(knowledge.versions.get(version.id)?.status, 'EXPIRED')
    assert.equal(knowledge.versions.size, 1)
  })

  it('answers from current knowledge and flags stale fallback', () => {
    const knowledge = store()
    upsertDocument(knowledge, {
      slug: 'platform/example/limits',
      title: 'Example limits',
      topic: 'platform-limits',
      platformId: 'pf_1',
      body: 'Maximum video length is 15 seconds for vertical video uploads.',
      sourceIds: ['src_1'],
      trustLevel: 'OFFICIAL',
      confidence: 0.95,
      ttlPolicy: 'PLATFORM_LIMIT',
      clock,
    })

    const answer = retrieveKnowledge(knowledge, { query: 'how long can a video be', clock })
    assert.equal(answer.degraded, false)
    assert.ok(answer.results.length > 0)
    assert.ok(answer.results[0]!.chunk.text.includes('15 seconds'))

    const staleClock = (): number => clock() + 60 * 86_400_000
    const stale = retrieveKnowledge(knowledge, { query: 'how long can a video be', clock: staleClock })
    assert.equal(stale.degraded, true)
    assert.match(String(stale.notice), /older information/i)
  })

  it('chunks and embeds without any external provider', () => {
    const knowledge = store()
    const { version } = upsertDocument(knowledge, {
      slug: 'platform/example/capabilities',
      title: 'Example capabilities',
      topic: 'platform-capabilities',
      platformId: 'pf_1',
      body: 'Short video is supported.\n\nCarousel posts are supported for up to 10 images.',
      sourceIds: ['src_1'],
      trustLevel: 'OFFICIAL',
      confidence: 0.9,
      clock,
    })
    const chunks = [...knowledge.chunks.values()].filter((chunk) => chunk.versionId === version.id)
    assert.ok(chunks.length >= 2)
    assert.equal(chunks[0]?.embedding?.provider, 'local-hash-v1')
    assert.ok((chunks[0]?.embedding?.vector.length ?? 0) > 0)
  })
})

describe('prompt versioning', () => {
  it('drafts the next version and never overwrites the active one', () => {
    const library = new PromptLibrary()
    library.add({
      promptKey: 'instagram:SHORT_VIDEO:generation',
      platformId: 'pf_1',
      version: 1,
      body: 'Write a short vertical video script.',
      variables: ['topic'],
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      activatedAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'SEED',
      changeNote: 'initial',
      basedOnEventId: null,
      evaluationScore: null,
    })

    const { draft, previous, diff } = library.draftNext({
      promptKey: 'instagram:SHORT_VIDEO:generation',
      platformId: 'pf_1',
      category: 'CONTENT_LIMIT',
      changeSummary: 'Reel duration reduced to 15 seconds',
      requirements: ['Maximum length 15 seconds'],
      basedOnEventId: 'evt_1',
      clock,
    })

    assert.equal(draft.version, 2)
    assert.equal(draft.status, 'DRAFT')
    assert.equal(previous?.status, 'ACTIVE')
    assert.match(diff, /\+ ## Current platform requirements/)
    assert.match(draft.body, /Maximum length 15 seconds/)

    library.activate('instagram:SHORT_VIDEO:generation', 2)
    assert.equal(library.active('instagram:SHORT_VIDEO:generation')?.version, 2)
    assert.equal(library.get('instagram:SHORT_VIDEO:generation', 1)?.status, 'SUPERSEDED')
  })
})

describe('system health', () => {
  const sources: Source[] = [
    {
      id: 'src_ok',
      name: 'docs',
      url: 'https://creators.example.com/',
      domain: 'creators.example.com',
      sourceType: 'DOCUMENTATION',
      platform: 'example',
      trustLevel: 'OFFICIAL',
      discoveredVia: 'SEED',
      lastCheckedAt: '2026-09-27T00:00:00.000Z',
      nextCheckAt: null,
      active: true,
      lastStatus: 'OK',
      consecutiveFailures: 0,
    },
    {
      id: 'src_bad',
      name: 'news',
      url: 'https://news.example.com/',
      domain: 'news.example.com',
      sourceType: 'NEWS',
      platform: 'example',
      trustLevel: 'REPORTED',
      discoveredVia: 'SEED',
      lastCheckedAt: '2026-09-27T00:00:00.000Z',
      nextCheckAt: null,
      active: true,
      lastStatus: 'FAILED',
      consecutiveFailures: 4,
    },
  ]

  const currentVersion: KnowledgeVersion = {
    id: 'kv_1',
    documentId: 'kd_1',
    version: 1,
    body: 'text',
    factIds: [],
    sourceIds: ['src_ok'],
    trustLevel: 'OFFICIAL',
    confidence: 0.9,
    createdAt: '2026-09-27T00:00:00.000Z',
    publishedAt: '2026-09-27T00:00:00.000Z',
    verifiedAt: '2026-09-27T00:00:00.000Z',
    expiresAt: '2026-12-27T00:00:00.000Z',
    status: 'CURRENT',
    changeNote: '',
    createdBy: 'WORLD_ENGINE',
  }

  const proposal: ChangeProposal = {
    id: 'prop_1',
    eventId: 'evt_1',
    kind: 'SECURITY_REVIEW',
    title: 'Auth change',
    rationale: '',
    riskLevel: 'CRITICAL',
    autonomyTier: 'CONTROLLED',
    status: 'PENDING_REVIEW',
    actions: [],
    affectedComponents: [],
    testPlan: [],
    diffPreview: null,
    createdAt: '2026-09-27T00:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    deployedAt: null,
    supersedesProposalId: null,
  }

  const event = { riskLevel: 'CRITICAL' } as EvolutionEvent

  it('degrades visibly when a source stops responding', () => {
    const report = buildHealthReport({
      sources,
      currentVersions: [currentVersion],
      events: [event],
      proposals: [proposal],
      lastRun: { status: 'PARTIAL', at: '2026-09-27T00:00:00.000Z' },
      integrationHealth: {},
      clock,
    })

    const availability = report.components.find((component) => component.component === 'SOURCE_AVAILABILITY')
    assert.equal(availability?.percent, 50)
    assert.notEqual(availability?.status, 'HEALTHY')
    assert.equal(report.overall, 'DEGRADED')
    assert.ok(report.alerts.some((alert) => alert.severity === 'CRITICAL'))
    assert.ok(report.alerts.some((alert) => alert.message.includes('retained and marked stale')))
  })

  it('reports healthy when everything is current', () => {
    const report = buildHealthReport({
      sources: [sources[0]!],
      currentVersions: [currentVersion],
      events: [],
      proposals: [],
      lastRun: { status: 'SUCCESS', at: '2026-09-27T00:00:00.000Z' },
      integrationHealth: {
        PUBLISHING_INTEGRATIONS: { percent: 100, detail: 'all connected' },
        AI_PROVIDERS: { percent: 100, detail: 'ok' },
        TEMPLATE_GENERATION: { percent: 100, detail: 'ok' },
        KNOWLEDGE_INDEXING: { percent: 100, detail: 'ok' },
        EMBEDDING_JOBS: { percent: 100, detail: 'ok' },
        ANALYTICS_SYNC: { percent: 100, detail: 'ok' },
      },
      clock,
    })
    assert.equal(report.overall, 'HEALTHY')
    assert.ok(report.components.every((component) => component.status === 'HEALTHY'))
  })
})
