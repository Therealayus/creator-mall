import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CreatorOption, CreatorPlatformCard, CreatorUpdateCard, LimitHint } from '../src/lib/api.js'
import {
  characterCounter,
  comingSoonSorted,
  enabledOptions,
  freshnessWords,
  groupOptions,
  groupUpdates,
  limitSummary,
  mediaPrompt,
  platformHeadline,
  platformUsable,
  readinessStage,
  relativeTime,
  statusWords,
  unreadCount,
  validationHeadline,
  whyHeadline,
} from '../src/lib/view-models.js'

function option(overrides: Partial<CreatorOption> = {}): CreatorOption {
  return {
    key: 'SHORT_VIDEO',
    label: 'Short video',
    description: 'A short vertical video.',
    enabled: true,
    unavailableReason: null,
    media: 'VIDEO',
    limits: [],
    ...overrides,
  }
}

function platform(overrides: Partial<CreatorPlatformCard> = {}): CreatorPlatformCard {
  return {
    slug: 'example',
    name: 'Example',
    status: 'ACTIVE',
    publishing: false,
    publishingNote: 'We are still preparing the connection for this platform, so publishing is off.',
    options: [option()],
    lastCheckedAt: null,
    knowledgeFreshness: 'CURRENT',
    ...overrides,
  }
}

function update(overrides: Partial<CreatorUpdateCard> = {}): CreatorUpdateCard {
  return {
    id: 'u1',
    platform: 'example',
    title: 'Example changed its video limit',
    body: 'The limits changed, so check your existing content.',
    when: '2026-09-27T12:00:00.000Z',
    read: false,
    suggested: [],
    sourceKind: "the platform's own documentation",
    sourceUrl: 'https://creators.example.com/',
    whyUrl: '/platforms/example',
    ...overrides,
  }
}

describe('option grouping', () => {
  it('groups options by the media a creator has to supply', () => {
    const groups = groupOptions([
      option(),
      option({ key: 'TEXT_POST', label: 'Text post', media: 'NONE' }),
      option({ key: 'CAROUSEL', label: 'Carousel', media: 'IMAGE' }),
    ])
    assert.deepEqual(
      groups.map((group) => group.title),
      ['Words', 'Images', 'Video'],
    )
  })

  it('drops empty groups', () => {
    const groups = groupOptions([option({ key: 'TEXT_POST', media: 'NONE' })])
    assert.equal(groups.length, 1)
  })

  it('describes media in plain language', () => {
    assert.equal(mediaPrompt('VIDEO'), 'Add a video')
    assert.equal(mediaPrompt('NONE'), 'No file needed')
  })
})

describe('limits in creator language', () => {
  it('summarises verified limits', () => {
    assert.equal(limitSummary([{ label: 'Maximum length', display: '90 seconds' }]), 'Maximum length: 90 seconds')
  })

  it('says when limits are unknown instead of inventing one', () => {
    assert.match(limitSummary([]), /not confirmed/i)
  })

  it('counts characters against a verified limit', () => {
    const limits: LimitHint[] = [{ label: 'Maximum length', display: '2,200 characters' }]
    const counter = characterCounter('a'.repeat(100), limits)
    assert.equal(counter.max, 2200)
    assert.equal(counter.over, false)
    assert.equal(counter.message, '2100 characters left')
    assert.ok((counter.percent ?? 0) < 100)
  })

  it('flags an over-limit post', () => {
    const limits: LimitHint[] = [{ label: 'Maximum length', display: '10 characters' }]
    const counter = characterCounter('a'.repeat(12), limits)
    assert.equal(counter.over, true)
    assert.equal(counter.message, '2 characters over the limit')
    assert.equal(counter.percent, 100)
  })

  it('stays quiet when no character limit is known', () => {
    const counter = characterCounter('hello', [])
    assert.equal(counter.max, null)
    assert.equal(counter.message, null)
    assert.equal(counter.over, false)
  })
})

describe('platform status words', () => {
  it('never leaks internal vocabulary', () => {
    for (const status of ['ACTIVE', 'COMING_SOON', 'BETA', 'DISCOVERED', 'ANNOUNCED']) {
      const words = statusWords(status)
      assert.ok(words.length > 0)
      assert.equal(/[_-]/.test(words), false, `${status} should read as words`)
    }
  })

  it('describes freshness honestly', () => {
    assert.equal(freshnessWords('CURRENT'), 'Up to date')
    assert.equal(freshnessWords('STALE'), 'Being refreshed')
    assert.equal(freshnessWords('UNKNOWN'), 'Not checked yet')
  })

  it('summarises a platform without claiming it can publish', () => {
    assert.match(platformHeadline(platform()), /publishing still being prepared/)
    assert.match(platformHeadline(platform({ publishing: true })), /connected/)
    assert.match(platformHeadline(platform({ options: [] })), /not confirmed/i)
  })

  it('knows whether a platform is usable at all', () => {
    assert.equal(platformUsable(platform()), true)
    assert.equal(platformUsable(platform({ options: [option({ enabled: false })] })), false)
    assert.equal(enabledOptions(platform()).length, 1)
  })
})

describe('update feed', () => {
  it('groups updates by platform with the busiest first', () => {
    const sections = groupUpdates([
      update({ id: 'a', platform: 'alpha' }),
      update({ id: 'b', platform: 'beta' }),
      update({ id: 'c', platform: 'beta' }),
    ])
    assert.deepEqual(
      sections.map((section) => [section.platform, section.updates.length]),
      [
        ['beta', 2],
        ['alpha', 1],
      ],
    )
  })

  it('counts unread updates', () => {
    assert.equal(unreadCount([update(), update({ id: 'b', read: true })]), 1)
  })
})

describe('validation and readiness wording', () => {
  it('summarises a validation result', () => {
    assert.equal(validationHeadline(null), '')
    assert.equal(validationHeadline({ valid: true, issues: [], limits: [] }), 'Ready to post')
    assert.equal(
      validationHeadline({
        valid: false,
        issues: [{ field: 'limits.text.maxCharacters', message: 'too long', severity: 'ERROR' }],
        limits: [],
      }),
      'One thing to fix',
    )
    assert.equal(
      validationHeadline({
        valid: true,
        issues: [{ field: 'x', message: 'note', severity: 'WARNING' }],
        limits: [],
      }),
      'Ready to post, with a note',
    )
  })

  it('words readiness stages for creators', () => {
    assert.equal(readinessStage(90), 'Almost ready')
    assert.equal(readinessStage(60), 'Getting ready')
    assert.equal(readinessStage(25), 'Early days')
    assert.equal(readinessStage(5), 'Just spotted')
  })

  it('sorts coming-soon cards by how ready they are', () => {
    const sorted = comingSoonSorted([
      { slug: 'a', name: 'A', stage: 'Coming soon', readinessPercent: 20, note: '' },
      { slug: 'b', name: 'B', stage: 'In beta', readinessPercent: 80, note: '' },
    ])
    assert.deepEqual(
      sorted.map((card) => card.slug),
      ['b', 'a'],
    )
  })
})

describe('time and why wording', () => {
  it('formats relative time', () => {
    const now = Date.parse('2026-09-27T12:00:00.000Z')
    assert.equal(relativeTime('2026-09-27T11:59:30.000Z', now), 'just now')
    assert.equal(relativeTime('2026-09-27T11:30:00.000Z', now), '30 min ago')
    assert.equal(relativeTime('2026-09-27T09:00:00.000Z', now), '3 h ago')
    assert.equal(relativeTime('2026-09-25T12:00:00.000Z', now), '2 d ago')
    assert.equal(relativeTime(null, now), '')
  })

  it('states availability plainly', () => {
    const base = {
      optionKey: 'SHORT_VIDEO',
      label: 'Short video',
      description: '',
      whatChanged: '',
      when: null,
      from: '',
      weUpdated: null,
      sources: [],
      pendingReview: [],
    }
    assert.equal(whyHeadline({ ...base, available: true }), 'Short video is available')
    assert.equal(whyHeadline({ ...base, available: false }), 'Short video is not available right now')
  })
})
