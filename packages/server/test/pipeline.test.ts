import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nowIso, stableId } from '@creator-mall/core'
import type { Source } from '@creator-mall/core'
import { runResearchCycle } from '../src/world-engine/pipeline.js'
import { CLOCK, ROBOTS_ALLOW_ALL, forkContext, html, testContext } from './helpers.js'

const HOSTS = [
  'creators.instagram.com',
  'support.google.com',
  'developers.google.com',
  'blog.youtube',
  'support.tiktok.com',
  'developers.tiktok.com',
  'newsroom.tiktok.com',
  'linkedin.com',
  'learn.microsoft.com',
  'help.x.com',
  'developer.x.com',
  'blog.x.com',
  'facebook.com',
  'developers.facebook.com',
  'about.fb.com',
  'help.instagram.com',
  'about.instagram.com',
]

/**
 * Every seeded host answers robots.txt. All first-party pages for a platform
 * carry the same published facts, so the test does not depend on which of a
 * platform's sources the scheduler happens to pick (least-recently-checked
 * first, by design).
 */
function routesFor(platformBody: string): Record<string, { body: string; contentType: string }> {
  const routes: Record<string, { body: string; contentType: string }> = {}
  for (const host of HOSTS) {
    routes[`https://${host}/robots.txt`] = { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' }
    routes[`https://${host}/`] = { body: html(platformBody), contentType: 'text/html' }
  }
  return routes
}

function videoLimit(snapshot: { state: { limits: unknown } } | undefined): unknown {
  const limits = snapshot?.state.limits as { video?: { maxDurationSeconds?: unknown } } | undefined
  return limits?.video?.maxDurationSeconds
}

function textLimit(snapshot: { state: { limits: unknown } } | undefined): unknown {
  const limits = snapshot?.state.limits as { text?: { maxCharacters?: unknown } } | undefined
  return limits?.text?.maxCharacters
}

async function cycle(context: Awaited<ReturnType<typeof testContext>>) {
  return runResearchCycle({
    control: context.control,
    fetcher: context.fetcher,
    respectSchedule: false,
    maxSourcesPerRun: 1,
    clock: CLOCK,
  })
}

describe('world engine research cycle', () => {
  it('captures a first baseline snapshot and publishes knowledge', async () => {
    const context = await testContext(
      routesFor('<p>Reels can be up to 90 seconds long.</p><p>Posts can be up to 2,200 characters including hashtags.</p>'),
    )
    const result = await cycle(context)

    assert.equal(result.status, 'SUCCESS')
    assert.ok(result.snapshotsCreated > 0)
    assert.ok(result.knowledgePublished > 0)

    const platform = context.control.getPlatform('instagram')
    assert.ok(platform)
    const snapshot = context.control.latestSnapshot(platform!.id)
    assert.equal(videoLimit(snapshot), 90)
    assert.equal(textLimit(snapshot), 2200)

    const documents = context.control.knowledgeByPlatform(platform!.id)
    assert.ok(documents.some((entry) => entry.document.slug.endsWith('/limits')))

    // A baseline is not a change: no event is fabricated from initial knowledge.
    assert.equal(context.control.listEvents({ platformId: platform!.id }).length, 0)
  })

  it('detects a tightened limit, rates it high and stages a reviewable change', async () => {
    const first = await testContext(routesFor('<p>Reels can be up to 90 seconds long.</p>'))
    await cycle(first)

    const second = await forkContext(first, routesFor('<p>Reels can be up to 15 seconds long.</p>'))
    const result = await cycle(second)

    const platformId = second.control.getPlatform('instagram')!.id
    const events = second.control.listEvents({ platformId })
    assert.equal(events.length, 1)
    const event = events[0]!
    assert.equal(event.category, 'CONTENT_LIMIT')
    assert.equal(event.riskLevel, 'HIGH')
    assert.equal(event.status, 'VERIFIED')
    assert.ok(event.sourceIds.length > 0)
    assert.equal(event.deltas[0]?.before, 90)
    assert.equal(event.deltas[0]?.after, 15)
    assert.match(event.creatorSummary, /limits/i)

    const proposals = second.control.listProposals({ status: 'PENDING_REVIEW' })
    assert.ok(proposals.length >= 1)
    assert.ok(proposals.every((proposal) => proposal.autonomyTier === 'CONTROLLED'))
    assert.ok(proposals.every((proposal) => proposal.testPlan.length > 0))
    assert.ok(result.proposalsCreated >= 1)

    // Old knowledge survives as a superseded version (§14).
    const versions = [...second.control.knowledge.versions.values()].filter((version) =>
      version.body.includes('Maximum video length'),
    )
    assert.ok(versions.length >= 2)
    assert.ok(versions.some((version) => version.status === 'SUPERSEDED'))
  })

  it('keeps knowledge and marks the source when research fails (§38)', async () => {
    const first = await testContext(routesFor('<p>Reels can be up to 90 seconds long.</p>'))
    await cycle(first)
    const documentsBefore = first.control.knowledge.documents.size
    assert.ok(documentsBefore > 0)

    const broken = await forkContext(first, {}, { status: 503, body: '', contentType: 'text/html' })
    const result = await cycle(broken)

    assert.equal(result.status, 'PARTIAL')
    assert.ok(result.sourcesFailed > 0)
    assert.equal(broken.control.knowledge.documents.size, documentsBefore)

    const snapshot = broken.control.latestSnapshot(broken.control.getPlatform('instagram')!.id)
    assert.equal(videoLimit(snapshot), 90)
    assert.equal(broken.control.listEvents({ platformId: broken.control.getPlatform('instagram')!.id }).length, 0)
    assert.ok(broken.control.listSources().some((source) => source.lastStatus === 'FAILED'))
  })

  it('only notifies the creators a change actually affects', async () => {
    const first = await testContext(routesFor('<p>Reels can be up to 90 seconds long.</p>'))
    await cycle(first)

    const videoCreator = {
      id: stableId('cr', 'video'),
      displayName: 'Video creator',
      platformSlugs: ['instagram'],
      contentTypes: ['SHORT_VIDEO'],
      usedCapabilityKeys: ['SHORT_VIDEO', 'VIDEO_MEDIA'],
      goals: ['grow'],
      locales: ['en'],
      createdAt: nowIso(CLOCK),
    }
    // A creator on a platform Creator Mall has never heard of is not disturbed.
    const elsewhere = {
      ...videoCreator,
      id: stableId('cr', 'elsewhere'),
      platformSlugs: ['mastodon'],
      usedCapabilityKeys: ['TEXT_POST'],
    }
    first.control.upsertCreator(videoCreator)
    first.control.upsertCreator(elsewhere)

    const second = await forkContext(first, routesFor('<p>Reels can be up to 15 seconds long.</p>'))
    await cycle(second)

    assert.equal(second.control.listNotifications(videoCreator.id).length, 1)
    assert.equal(second.control.listNotifications(elsewhere.id).length, 0)
    const notification = second.control.listNotifications(videoCreator.id)[0]!
    assert.match(notification.title, /Instagram/)
    assert.ok(notification.sourceIds.length > 0)
  })

  it('registers an announced platform on the watchlist without enabling publishing', async () => {
    const announcement =
      '<p>Loopwave is announcing a new social app for creators. Loopwave will be rolling out a new video format soon.</p>'
    const routes: Record<string, { body: string; contentType: string }> = {
      'https://techwire.example/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
      'https://techwire.example/': { body: html(announcement), contentType: 'text/html' },
    }
    const context = await testContext(routes)
    const newsSource: Source = {
      id: stableId('src', 'techwire'),
      name: 'TechWire',
      url: 'https://techwire.example/',
      domain: 'techwire.example',
      sourceType: 'NEWS',
      platform: null,
      trustLevel: 'REPORTED',
      discoveredVia: 'DISCOVERY',
      lastCheckedAt: null,
      nextCheckAt: null,
      active: true,
      lastStatus: 'NEVER_CHECKED',
      consecutiveFailures: 0,
    }
    context.control.upsertSource(newsSource)

    const result = await cycle(context)

    const discovered = context.control.getPlatform('loopwave')
    assert.ok(discovered, 'the announced platform should be registered')
    assert.equal(discovered!.status, 'DISCOVERED')
    assert.equal(discovered!.integrationState, 'UNPREPARED')
    assert.ok(result.events.some((event) => event.eventType === 'NEW_PLATFORM_DISCOVERED'))
  })
})
