import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Source } from '@creator-mall/core'
import {
  CapabilityRegistry,
  HeuristicFactExtractor,
  assessSources,
  detectRumour,
  htmlToText,
  isBoilerplate,
  parseDocument,
  verifyFacts,
} from '../src/index.js'

const registry = new CapabilityRegistry()

function source(partial: Partial<Source> & Pick<Source, 'id' | 'sourceType' | 'trustLevel' | 'domain'>): Source {
  return {
    name: partial.id,
    url: `https://${partial.domain}/docs`,
    platform: null,
    discoveredVia: 'SEED',
    lastCheckedAt: null,
    nextCheckAt: null,
    active: true,
    lastStatus: 'OK',
    consecutiveFailures: 0,
    ...partial,
  }
}

describe('html reading', () => {
  it('drops scripts, styles and markup', () => {
    const html = `<html><head><title>Docs</title><style>.a{color:red}</style></head>
      <body><script>alert('x')</script><h1>Reels</h1><p>Reels can be up to 90 seconds long.</p></body></html>`
    const text = htmlToText(html)
    assert.ok(!text.includes('alert'))
    assert.ok(!text.includes('color:red'))
    assert.ok(text.includes('Reels can be up to 90 seconds long.'))
  })

  it('extracts title, headings and absolute links', () => {
    const document = parseDocument(
      '<html><head><title>Creator docs</title></head><body><h2>Limits</h2><a href="/x">x</a></body></html>',
      'https://example.com/docs/index',
      'text/html',
      '2026-09-27T00:00:00.000Z',
    )
    assert.equal(document.title, 'Creator docs')
    assert.deepEqual(document.headings, ['Limits'])
    assert.ok(document.links.includes('https://example.com/x'))
  })
})

describe('fact extraction', () => {
  const extractor = new HeuristicFactExtractor()

  it('extracts numeric limits with their evidence sentence', async () => {
    const text = 'Reels can be up to 90 seconds long. Posts can be up to 2,200 characters including hashtags.'
    const facts = await extractor.extract({
      platformId: 'pf_1',
      platformName: 'Example',
      text,
      sourceId: 'src_1',
      capabilityRegistry: registry,
    })

    const video = facts.find((fact) => fact.path === 'limits.video.maxDurationSeconds')
    assert.equal(video?.value, 90)
    assert.ok(video?.evidence.toLowerCase().includes('90 seconds'))

    const characters = facts.find((fact) => fact.path === 'limits.text.maxCharacters')
    assert.equal(characters?.value, 2200)
  })

  it('converts minutes to seconds', async () => {
    const facts = await extractor.extract({
      platformId: 'pf_1',
      platformName: 'Example',
      text: 'Videos may be up to 3 minutes long for most creators today.',
      sourceId: 'src_1',
      capabilityRegistry: registry,
    })
    assert.equal(facts.find((fact) => fact.path === 'limits.video.maxDurationSeconds')?.value, 180)
  })

  it('flags deprecation sentences', async () => {
    const facts = await extractor.extract({
      platformId: 'pf_1',
      platformName: 'Example',
      text: 'The content publishing API version 1 is deprecated and will be removed in 2027.',
      sourceId: 'src_1',
      capabilityRegistry: registry,
    })
    assert.ok(facts.some((fact) => fact.category === 'API_DEPRECATION'))
  })

  it('detects a newly launched format as a capability signal', async () => {
    const facts = await extractor.extract({
      platformId: 'pf_1',
      platformName: 'Example',
      text: 'We are rolling out a new vertical reels format for all creators this month.',
      sourceId: 'src_1',
      capabilityRegistry: registry,
    })
    const capability = facts.find((fact) => fact.path.startsWith('capabilities.'))
    assert.equal(capability?.path, 'capabilities.SHORT_VIDEO')
  })

  it('never turns page furniture into a platform fact', async () => {
    const noise = [
      'This browser is no longer supported. Please upgrade to a modern browser to continue.',
      'We use cookies to personalise content and analyse traffic on this website.',
      'Sign in to your account to manage your creator profile and preferences.',
      'All rights reserved. Creator Mall is a trademark of Example Inc.',
    ]
    for (const text of noise) {
      const facts = await extractor.extract({
        platformId: 'pf_1',
        platformName: 'Example',
        text,
        sourceId: 'src_1',
        capabilityRegistry: registry,
      })
      assert.deepEqual(facts, [], `should have extracted nothing from: ${text.slice(0, 40)}`)
    }
  })

  it('classifies boilerplate on its own', () => {
    assert.equal(isBoilerplate('This browser is no longer supported.'), true)
    assert.equal(isBoilerplate('Reels can be up to 90 seconds long.'), false)
  })
})

describe('source trust', () => {
  it('treats first-party documentation as official', () => {
    const assessment = assessSources([
      source({ id: 's1', sourceType: 'DOCUMENTATION', trustLevel: 'OFFICIAL', domain: 'creators.example.com' }),
    ])
    assert.equal(assessment.trustLevel, 'OFFICIAL')
    assert.ok(assessment.confidence > 0.8)
  })

  it('requires two independent reports for "verified"', () => {
    const single = assessSources([
      source({ id: 's1', sourceType: 'NEWS', trustLevel: 'REPORTED', domain: 'news-a.example' }),
    ])
    const pair = assessSources([
      source({ id: 's1', sourceType: 'NEWS', trustLevel: 'REPORTED', domain: 'news-a.example' }),
      source({ id: 's2', sourceType: 'RESEARCH', trustLevel: 'REPORTED', domain: 'news-b.example' }),
    ])
    assert.equal(single.trustLevel, 'REPORTED')
    assert.equal(pair.trustLevel, 'VERIFIED')
  })

  it('never promotes a community post to a platform fact', () => {
    const assessment = assessSources([
      source({ id: 's1', sourceType: 'COMMUNITY', trustLevel: 'COMMUNITY_SIGNAL', domain: 'forum.example' }),
    ])
    assert.equal(assessment.trustLevel, 'COMMUNITY_SIGNAL')
    assert.ok(assessment.confidence < 0.4)
  })
})

describe('verification gate', () => {
  const extractor = new HeuristicFactExtractor()
  const text = 'Reels can be up to 90 seconds long in our current documentation.'

  const facts = async (sourceId: string) =>
    await extractor.extract({
      platformId: 'pf_1',
      platformName: 'Example',
      text,
      sourceId,
      capabilityRegistry: registry,
    })

  it('accepts a claim backed by official documentation', async () => {
    const sources = [source({ id: 'src_official', sourceType: 'DOCUMENTATION', trustLevel: 'OFFICIAL', domain: 'creators.example.com' })]
    const claims = verifyFacts(await facts('src_official'), sources)
    const limit = claims.find((claim) => claim.path === 'limits.video.maxDurationSeconds')
    assert.equal(limit?.status, 'ACCEPTED')
    assert.equal(limit?.trustLevel, 'OFFICIAL')
  })

  it('keeps a community-only claim out of knowledge', async () => {
    const sources = [source({ id: 'src_forum', sourceType: 'COMMUNITY', trustLevel: 'COMMUNITY_SIGNAL', domain: 'forum.example' })]
    const claims = verifyFacts(await facts('src_forum'), sources)
    const limit = claims.find((claim) => claim.path === 'limits.video.maxDurationSeconds')
    assert.equal(limit?.status, 'REJECTED')
    assert.equal(limit?.trustLevel, 'COMMUNITY_SIGNAL')
  })

  it('downgrades hearsay wording even on an official page', async () => {
    assert.equal(detectRumour('It is rumoured that the API will be removed soon'), true)
    assert.equal(detectRumour('The API is removed as of March 2027'), false)

    const sources = [source({ id: 'src_official', sourceType: 'OFFICIAL', trustLevel: 'OFFICIAL', domain: 'creators.example.com' })]
    const rumoured = await extractor.extract({
      platformId: 'pf_1',
      platformName: 'Example',
      text: 'Sources say the old publishing endpoint is deprecated and will be removed next year.',
      sourceId: 'src_official',
      capabilityRegistry: registry,
    })
    const claims = verifyFacts(rumoured, sources)
    assert.ok(claims.every((claim) => claim.trustLevel === 'RUMOR' || claim.status === 'REJECTED'))
  })

  it('corroborates the same claim across two sources', async () => {
    const sources = [
      source({ id: 'src_a', sourceType: 'DOCUMENTATION', trustLevel: 'OFFICIAL', domain: 'creators.example.com' }),
      source({ id: 'src_b', sourceType: 'DEVELOPER', trustLevel: 'OFFICIAL', domain: 'developers.example.com' }),
    ]
    const claims = verifyFacts([...(await facts('src_a')), ...(await facts('src_b'))], sources)
    const limit = claims.find((claim) => claim.path === 'limits.video.maxDurationSeconds')
    assert.equal(limit?.sourceIds.length, 2)
  })
})
