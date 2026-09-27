import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildResourceCatalogue, buildToolCatalogue, creatorTools } from '../src/market/catalogue.js'
import type { KnowledgeFact } from '../src/types/knowledge.js'
import type { SocialPlatform } from '../src/types/platform.js'
import type { Source } from '../src/types/source.js'

/**
 * The Market Engine's only real promise: nothing is shown without evidence.
 *
 * These tests are mostly about refusal. A tool that cannot be traced to an
 * official or verified source must not exist, however plausible it sounds.
 */

const instagram: SocialPlatform = {
  id: 'plt_instagram',
  slug: 'instagram',
  name: 'Instagram',
  kind: 'VIDEO',
  status: 'ACTIVE',
  regions: ['GLOBAL'],
  capabilityKeys: ['SHORT_VIDEO'],
  trustLevel: 'OFFICIAL',
  firstSeenAt: '2026-09-01T00:00:00.000Z',
  integrationState: 'UNPREPARED',
  metadata: {},
}

const labels = new Map([
  ['SHORT_VIDEO', 'Short video'],
  ['IMAGE_POST', 'Photo post'],
])

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src_official',
    name: 'Instagram for creators',
    url: 'https://creators.instagram.com/',
    domain: 'creators.instagram.com',
    sourceType: 'OFFICIAL',
    platform: 'instagram',
    trustLevel: 'OFFICIAL',
    discoveredVia: 'SEED',
    lastCheckedAt: '2026-09-27T00:00:00.000Z',
    nextCheckAt: null,
    active: true,
    lastStatus: 'OK',
    consecutiveFailures: 0,
    ...overrides,
  }
}

function fact(overrides: Partial<KnowledgeFact> = {}): KnowledgeFact {
  return {
    id: 'kf_1',
    key: 'instagram:feature.video.editingTool',
    statement: 'Instagram provides a built-in editing tool for trimming and combining clips.',
    value: true,
    platformId: instagram.id,
    sourceIds: ['src_official'],
    trustLevel: 'OFFICIAL',
    confidence: 0.9,
    observedAt: '2026-09-27T00:00:00.000Z',
    verifiedAt: '2026-09-27T00:00:00.000Z',
    status: 'CURRENT',
    expiresAt: null,
    supersededByFactId: null,
    evidence: 'Trim and combine clips in the editor.',
    ...overrides,
  }
}

const input = (facts: KnowledgeFact[], sources: Source[]) => ({
  platforms: [instagram],
  facts,
  sources,
  capabilityLabels: labels,
})

describe('market engine: verified tools', () => {
  it('lists a tool an official source documented', () => {
    const tools = buildToolCatalogue(input([fact()], [source()]))
    assert.equal(tools.length, 1)
    const tool = tools[0]!
    assert.equal(tool.platformSlug, 'instagram')
    assert.equal(tool.name.includes('editing tool'), true)
    assert.equal(tool.confidence, 'CONFIRMED')
    assert.equal(tool.url, 'https://creators.instagram.com/')
    assert.equal(tool.evidence[0]?.sourceName, 'Instagram for creators')
    assert.equal(tool.evidence[0]?.excerpt, 'Trim and combine clips in the editor.')
  })

  it('refuses a tool whose only source is a rumour', () => {
    const tools = buildToolCatalogue(
      input(
        [fact({ sourceIds: ['src_blog'], trustLevel: 'COMMUNITY_SIGNAL' })],
        [source({ id: 'src_blog', sourceType: 'COMMUNITY', trustLevel: 'COMMUNITY_SIGNAL' })],
      ),
    )
    assert.deepEqual(tools, [], 'an unverified claim is not a tool')
  })

  it('refuses a tool backed by a source we no longer trust', () => {
    const tools = buildToolCatalogue(
      input(
        [fact({ sourceIds: ['src_stale'], trustLevel: 'VERIFIED' })],
        [source({ id: 'src_stale', trustLevel: 'VERIFIED', sourceType: 'DOCUMENTATION', active: false })],
      ),
    )
    assert.deepEqual(tools, [], 'a deactivated source backs nothing')
  })

  it('refuses a retracted or superseded claim', () => {
    for (const status of ['RETRACTED', 'SUPERSEDED', 'EXPIRED', 'DRAFT'] as const) {
      const tools = buildToolCatalogue(input([fact({ status })], [source()]))
      assert.deepEqual(tools, [], `${status} is not something to show a creator`)
    }
  })

  it('refuses a claim nobody has verified yet', () => {
    assert.deepEqual(buildToolCatalogue(input([fact({ verifiedAt: null })], [source()])), [])
  })

  it('refuses a claim whose sources we cannot find', () => {
    assert.deepEqual(buildToolCatalogue(input([fact({ sourceIds: ['src_missing'] })], [source()])), [])
  })

  it('never states a non-official claim as confirmed', () => {
    const tools = buildToolCatalogue(
      input(
        [fact({ trustLevel: 'VERIFIED' })],
        [source({ trustLevel: 'VERIFIED', sourceType: 'DOCUMENTATION' })],
      ),
    )
    assert.equal(tools[0]?.confidence, 'LIKELY')
  })

  it('calls an api claim an endpoint and a feature claim a feature', () => {
    const endpoint = buildToolCatalogue(
      input(
        [fact({ key: 'instagram:api.video.uploadEndpoint', statement: 'The content publishing endpoint accepts a video upload.' })],
        [source()],
      ),
    )
    assert.equal(endpoint[0]?.kind, 'ENDPOINT')

    const feature = buildToolCatalogue(input([fact()], [source()]))
    assert.equal(feature[0]?.kind, 'FEATURE')
  })

  it('names the capability a claim belongs to', () => {
    const video = buildToolCatalogue(input([fact({ key: 'instagram:limits.video.maxDurationSeconds' })], [source()]))
    assert.equal(video[0]?.capabilityKey, 'SHORT_VIDEO')
    assert.equal(video[0]?.capabilityLabel, 'Short video')

    const photo = buildToolCatalogue(input([fact({ key: 'instagram:feature.image.filterTool' })], [source()]))
    assert.equal(photo[0]?.capabilityKey, 'IMAGE_POST')
  })

  it('ignores a claim that is not about something a creator could use', () => {
    const tools = buildToolCatalogue(
      input([fact({ statement: 'The recommended maximum is 15 seconds.' })], [source()]),
    )
    assert.deepEqual(tools, [], 'a limit is not a tool')
  })
})

describe('market engine: official resources', () => {
  it('lists the official pages we check', () => {
    const resources = buildResourceCatalogue({
      platforms: [instagram],
      sources: [source()],
      capabilityLabels: labels,
    })
    assert.equal(resources.length, 1)
    assert.equal(resources[0]?.kind, 'RESOURCE')
    assert.equal(resources[0]?.capabilityLabel, 'Official reading')
    assert.match(resources[0]?.whatItDoes ?? '', /official page/)
  })

  it('leaves out sources for platforms we do not track, and community pages', () => {
    const resources = buildResourceCatalogue({
      platforms: [instagram],
      sources: [
        source({ platform: 'loopwave' }),
        source({ id: 'src_community', sourceType: 'COMMUNITY', trustLevel: 'COMMUNITY_SIGNAL' }),
      ],
      capabilityLabels: labels,
    })
    assert.deepEqual(resources, [])
  })
})

describe('market engine: the whole catalogue', () => {
  it('puts confirmed tools before likely ones and reading last', () => {
    const tools = creatorTools(
      input(
        [fact()],
        [
          source(),
          source({ id: 'src_dev', name: 'Meta for Developers', sourceType: 'DEVELOPER', trustLevel: 'VERIFIED', url: 'https://developers.facebook.com/' }),
        ],
      ),
    )
    assert.equal(tools[0]?.kind, 'FEATURE', 'a confirmed tool leads')
    assert.equal(tools.at(-1)?.kind, 'RESOURCE', 'reading is the fallback, not the headline')
  })

  it('is empty rather than wrong when nothing is verified', () => {
    assert.deepEqual(creatorTools(input([], [])), [])
  })

  it('gives every entry a stable id, so a creator does not see it twice', () => {
    const first = creatorTools(input([fact()], [source()]))
    const second = creatorTools(input([fact()], [source()]))
    assert.deepEqual(
      first.map((tool) => tool.id),
      second.map((tool) => tool.id),
    )
  })
})
