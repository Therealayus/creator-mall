import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CapabilityRegistry,
  DependencyGraph,
  buildReadinessProfile,
  buildPlatformUiConfig,
  emptyPlatformState,
  planEvolution,
  scoreCreatorImpact,
} from '../src/index.js'
import type {
  CreatorProfile,
  EvolutionEvent,
  PlatformState,
  SocialPlatform,
  StateDelta,
} from '../src/index.js'

const registry = new CapabilityRegistry()

function platform(overrides: Partial<SocialPlatform> = {}): SocialPlatform {
  return {
    id: 'pf_example',
    slug: 'example',
    name: 'Example',
    kind: 'CREATOR_NATIVE',
    status: 'ACTIVE',
    regions: ['GLOBAL'],
    capabilityKeys: ['SHORT_VIDEO', 'TEXT_POST', 'SCHEDULING', 'API_PUBLISH', 'API_ANALYTICS'],
    trustLevel: 'OFFICIAL',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    integrationState: 'PREPARING',
    metadata: {},
    ...overrides,
  }
}

function state(overrides: Partial<PlatformState> = {}): PlatformState {
  return {
    ...emptyPlatformState(),
    capabilities: {
      SHORT_VIDEO: { capabilityKey: 'SHORT_VIDEO', state: 'ACTIVE', confidence: 0.95, sourceIds: ['src_1'] },
      TEXT_POST: { capabilityKey: 'TEXT_POST', state: 'ACTIVE', confidence: 0.95, sourceIds: ['src_1'] },
      CAROUSEL: { capabilityKey: 'CAROUSEL', state: 'DEPRECATED', confidence: 0.7, sourceIds: ['src_1'], notes: 'being phased out' },
    },
    ...overrides,
  }
}

function delta(overrides: Partial<StateDelta> = {}): StateDelta {
  return {
    path: 'capabilities.SHORT_VIDEO',
    kind: 'ADDED',
    before: undefined,
    after: { state: 'ACTIVE' },
    category: 'NEW_FEATURE',
    riskLevel: 'MEDIUM',
    capabilityKeys: ['SHORT_VIDEO'],
    rationale: 'test',
    ...overrides,
  }
}

function event(overrides: Partial<EvolutionEvent> = {}): EvolutionEvent {
  return {
    id: 'evt_1',
    platformId: 'pf_example',
    platformName: 'Example',
    eventType: 'NEW_CAPABILITY_DETECTED',
    category: 'NEW_FEATURE',
    title: 'Example added spatial posts',
    creatorSummary: 'A new option is available.',
    detectedAt: '2026-09-27T00:00:00.000Z',
    verifiedAt: '2026-09-27T00:00:00.000Z',
    sourceIds: ['src_1'],
    trustLevel: 'OFFICIAL',
    confidence: 0.95,
    previousState: null,
    newState: null,
    deltas: [delta()],
    impact: '',
    affectedCapabilityKeys: ['SHORT_VIDEO'],
    affectedComponents: [],
    riskLevel: 'MEDIUM',
    status: 'VERIFIED',
    approvedBy: null,
    deployedAt: null,
    evidence: [],
    ...overrides,
  }
}

describe('feature dependency graph', () => {
  const graph = new DependencyGraph()
  graph.linkCapabilityChain({
    platformId: 'pf_example',
    platformLabel: 'Example',
    capabilityKey: 'SHORT_VIDEO',
    capabilityLabel: 'Short video',
    contentType: 'SHORT_VIDEO',
    promptKey: 'example:SHORT_VIDEO:generation',
    templateId: 'example:SHORT_VIDEO:default',
    editor: 'video-editor',
    publisher: 'example-publisher',
    analytics: 'example-analytics',
  })

  it('answers what a capability change affects', () => {
    const impact = graph.impactOfCapability('pf_example', 'SHORT_VIDEO')
    const refs = impact.map((component) => `${component.kind}:${component.ref}`)
    assert.ok(refs.includes('AI_PROMPT:example:SHORT_VIDEO:generation'))
    assert.ok(refs.includes('PUBLISHER:example-publisher'))
    assert.ok(refs.includes('EDITOR:video-editor'))
  })

  it('round-trips through edges', () => {
    const restored = DependencyGraph.fromEdges(graph.toJSON())
    assert.equal(restored.hash(), graph.hash())
  })
})

describe('evolution planner', () => {
  const graph = new DependencyGraph()
  graph.linkCapabilityChain({
    platformId: 'pf_example',
    platformLabel: 'Example',
    capabilityKey: 'SHORT_VIDEO',
    capabilityLabel: 'Short video',
    publisher: 'example-publisher',
  })

  it('auto-approves knowledge-only refreshes', () => {
    const proposals = planEvolution({
      event: event({ eventType: 'KNOWLEDGE_REFRESHED', category: 'DOCUMENTATION_CHANGE', riskLevel: 'LOW', deltas: [delta({ category: 'DOCUMENTATION_CHANGE', riskLevel: 'LOW' })] }),
      graph,
    })
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]?.status, 'AUTO_APPROVED')
    assert.equal(proposals[0]?.autonomyTier, 'AUTOMATIC')
    assert.equal(proposals[0]?.kind, 'KNOWLEDGE_UPDATE')
  })

  it('stages a new capability for review instead of shipping it', () => {
    const proposals = planEvolution({ event: event(), graph })
    assert.equal(proposals.length, 1)
    const proposal = proposals[0]!
    assert.equal(proposal.status, 'PENDING_REVIEW')
    assert.equal(proposal.autonomyTier, 'CONTROLLED')
    assert.ok(proposal.actions.some((action) => action.type === 'REGISTER_CAPABILITY'))
    assert.ok(proposal.actions.some((action) => action.type === 'UPDATE_UI_CONFIG'))
    assert.ok(proposal.testPlan.length > 0)
  })

  it('never lets a critical change skip review', () => {
    const proposals = planEvolution({
      event: event({ eventType: 'API_DEPRECATED', category: 'API_DEPRECATION', riskLevel: 'CRITICAL', deltas: [delta({ category: 'API_DEPRECATION', riskLevel: 'CRITICAL' })] }),
      graph,
    })
    assert.ok(proposals.length >= 2)
    assert.ok(proposals.every((proposal) => proposal.status === 'PENDING_REVIEW'))
    assert.ok(proposals.some((proposal) => proposal.kind === 'SECURITY_REVIEW'))
    const security = proposals.find((proposal) => proposal.kind === 'SECURITY_REVIEW')!
    assert.ok(security.actions.some((action) => action.type === 'PAUSE_WORKFLOW'))
  })

  it('lists the affected components so CI knows what to test', () => {
    const proposals = planEvolution({ event: event(), graph })
    const refs = proposals[0]!.affectedComponents.map((component) => component.ref)
    assert.ok(refs.includes('example-publisher'))
  })
})

describe('creator impact', () => {
  const videoCreator: CreatorProfile = {
    id: 'cr_video',
    displayName: 'Video creator',
    platformSlugs: ['youtube', 'instagram'],
    contentTypes: ['SHORT_VIDEO'],
    usedCapabilityKeys: ['SHORT_VIDEO', 'VIDEO_MEDIA'],
    goals: ['grow'],
    locales: ['en'],
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const writer: CreatorProfile = { ...videoCreator, id: 'cr_writer', platformSlugs: ['linkedin'], usedCapabilityKeys: ['TEXT_POST', 'ARTICLE'] }

  const signal = {
    category: 'CONTENT_LIMIT' as const,
    riskLevel: 'HIGH' as const,
    platformSlug: 'youtube',
    affectedCapabilityKeys: ['SHORT_VIDEO'],
    title: 'YouTube shortened Shorts',
  }

  it('rates a change high for a creator who uses it', () => {
    const impact = scoreCreatorImpact(videoCreator, signal)
    assert.equal(impact.level, 'HIGH')
    assert.ok(impact.recommendedActions.length > 0)
  })

  it('rates the same change low for an unrelated creator', () => {
    const impact = scoreCreatorImpact(writer, signal)
    assert.ok(['LOW', 'NONE'].includes(impact.level))
    assert.ok(impact.score < 0.45)
  })
})

describe('config-driven UI', () => {
  it('only offers options the platform currently supports', () => {
    const config = buildPlatformUiConfig({
      platform: platform(),
      state: state(),
      capabilities: registry.all(),
      events: [event()],
      publishingEnabled: false,
      generatedAt: '2026-09-27T00:00:00.000Z',
    })

    const carousel = config.options.find((option) => option.capabilityKey === 'CAROUSEL')
    assert.equal(carousel?.enabled, false)
    assert.match(String(carousel?.reason), /phasing this out|no longer/i)

    const short = config.options.find((option) => option.capabilityKey === 'SHORT_VIDEO')
    assert.equal(short?.enabled, true)
    assert.equal(short?.requiredMedia, 'VIDEO')
  })

  it('explains why an option changed', () => {
    const config = buildPlatformUiConfig({
      platform: platform(),
      state: state(),
      capabilities: registry.all(),
      events: [event()],
      publishingEnabled: false,
      generatedAt: '2026-09-27T00:00:00.000Z',
    })
    const attribution = config.attribution.find((entry) => entry.capabilityKey === 'SHORT_VIDEO')
    assert.match(String(attribution?.explanation), /verified from official sources/i)
  })
})

describe('platform readiness', () => {
  it('keeps an unverified platform away from publishing', () => {
    const profile = buildReadinessProfile({
      platform: platform({ status: 'COMING_SOON', capabilityKeys: ['SHORT_VIDEO'] }),
      capabilities: registry.all(),
      adapter: null,
      hasApiSource: false,
      hasOfficialSource: false,
      templatesPrepared: 0,
    })
    assert.ok(profile.overallPercent < 100)
    assert.ok(profile.remainingWork.length > 0)
    const publishing = profile.areas.find((area) => area.area === 'publishingApi')
    assert.notEqual(publishing?.state, 'READY')
  })

  it('marks a documented API as partial until it is integrated', () => {
    const profile = buildReadinessProfile({
      platform: platform(),
      capabilities: registry.all(),
      adapter: null,
      hasApiSource: true,
      hasOfficialSource: true,
      templatesPrepared: 4,
    })
    const publishing = profile.areas.find((area) => area.area === 'publishingApi')
    assert.equal(publishing?.state, 'PARTIAL')
  })
})
