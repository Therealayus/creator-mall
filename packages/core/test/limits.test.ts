import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyPlatformState, limitHintsFor } from '../src/index.js'
import type { PlatformState } from '../src/index.js'

function state(overrides: Partial<PlatformState> = {}): PlatformState {
  return {
    ...emptyPlatformState(),
    limits: {
      video: { maxDurationSeconds: 90 },
      text: { maxCharacters: 2200, maxHashtags: 30 },
      media: { maxImages: 10, maxFileSizeMb: 4096 },
    },
    ...overrides,
  }
}

describe('creator limit hints', () => {
  it('shows the limits that matter for a video option', () => {
    const hints = limitHintsFor('SHORT_VIDEO', state())
    assert.deepEqual(
      hints.map((hint) => hint.display),
      ['90 seconds', '4 GB'],
    )
  })

  it('shows text limits for a text post', () => {
    const hints = limitHintsFor('TEXT_POST', state())
    assert.deepEqual(
      hints.map((hint) => hint.display),
      ['2,200 characters', '30'],
    )
  })

  it('is capability-driven, not platform-driven', () => {
    assert.equal(limitHintsFor('BRANDED_CONTENT', state()).length, 0)
    assert.equal(limitHintsFor('CAROUSEL', state())[0]?.display, '10')
  })

  it('omits limits we have not verified', () => {
    const hints = limitHintsFor('SHORT_VIDEO', { ...emptyPlatformState() })
    assert.equal(hints.length, 0)
  })

  it('tolerates a missing snapshot', () => {
    assert.deepEqual(limitHintsFor('TEXT_POST', null), [])
  })

  it('formats hour and second durations in plain language', () => {
    const hints = limitHintsFor('LONG_VIDEO', {
      ...emptyPlatformState(),
      limits: { video: { maxDurationSeconds: 3600 } },
    })
    assert.equal(hints[0]?.display, '1 hour')
  })
})
