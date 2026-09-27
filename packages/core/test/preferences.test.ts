import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createPreferenceStore,
  forgetPreference,
  listObservations,
  listPreferences,
  recommendations,
  recordObservation,
  recommendations as suggest,
  resetPersonalization,
  setPreferenceEnabled,
} from '../src/index.js'
import type { CreatorObservation, ObservationKind } from '../src/index.js'

const CREATOR = 'cr_1'
const OTHER = 'cr_2'
const at = (index: number): string => new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 3_600_000).toISOString()

function observe(
  store: ReturnType<typeof createPreferenceStore>,
  kind: ObservationKind,
  subject: string,
  detail: string | null = null,
  creatorId = CREATOR,
  platformSlug: string | null = null,
  index = 0,
): void {
  recordObservation(store, {
    id: `obs_${creatorId}_${index}_${kind}`,
    creatorId,
    kind,
    at: at(index),
    subject,
    detail,
    platformSlug,
  })
}

describe('preference learning', () => {
  it('learns nothing from a single observation', () => {
    const store = createPreferenceStore()
    observe(store, 'OPTION_CHOSEN', 'SHORT_VIDEO')
    assert.equal(listPreferences(store, CREATOR).length, 0, 'three examples before believing anything')
  })

  it('learns a preference once a pattern repeats, with its evidence', () => {
    const store = createPreferenceStore()
    for (let index = 1; index <= 4; index += 1) {
      observe(store, 'OPTION_CHOSEN', 'SHORT_VIDEO', null, CREATOR, null, index)
    }

    const preferences = listPreferences(store, CREATOR)
    const favourite = preferences.find((preference) => preference.key === 'favourite-option')
    assert.ok(favourite)
    assert.equal(favourite.value, 'SHORT_VIDEO')
    assert.equal(favourite.occurrences, 4)
    assert.ok(favourite.confidence > 0.5)
    assert.ok(favourite.evidence.length > 0)
    assert.match(favourite.evidence[0]!, /option chosen/i)
    assert.equal(favourite.label, 'The option you reach for')
  })

  it('prefers the more common value and records the switch', () => {
    const store = createPreferenceStore()
    for (let index = 1; index <= 5; index += 1) {
      observe(store, 'OPTION_CHOSEN', 'SHORT_VIDEO', null, CREATOR, null, index)
    }
    for (let index = 6; index <= 12; index += 1) {
      observe(store, 'OPTION_CHOSEN', 'CAROUSEL', null, CREATOR, null, index)
    }

    const favourite = listPreferences(store, CREATOR).find((preference) => preference.key === 'favourite-option')
    assert.equal(favourite?.value, 'CAROUSEL')
    assert.ok(favourite && favourite.confidence < 0.95, 'a recent switch is trusted less than a steady pattern')
  })

  it('learns a hook style and a post length from accepted drafts', () => {
    const store = createPreferenceStore()
    for (let index = 1; index <= 4; index += 1) {
      observe(store, 'DRAFT_ACCEPTED', 'SHORT_VIDEO', 'hook:result-first; length:180', CREATOR, null, index)
    }

    const keys = listPreferences(store, CREATOR).map((preference) => preference.key)
    assert.ok(keys.includes('preferred-hook-style'))
    assert.ok(keys.includes('preferred-length'))

    const style = listPreferences(store, CREATOR).find((preference) => preference.key === 'preferred-hook-style')
    assert.equal(style?.value, 'result-first')
    const length = listPreferences(store, CREATOR).find((preference) => preference.key === 'preferred-length')
    assert.equal(length?.value, 'short')
  })

  it('notices a creator who keeps rewriting openings', () => {
    const store = createPreferenceStore()
    for (let index = 1; index <= 5; index += 1) {
      observe(store, 'DRAFT_EDITED', 'SHORT_VIDEO', 'edited:hook', CREATOR, null, index)
    }
    const preference = listPreferences(store, CREATOR).find((entry) => entry.key === 'hook-editing')
    assert.equal(preference?.value, 'rewrites-hooks')
  })

  it('treats removing a platform as evidence against', () => {
    const store = createPreferenceStore()
    observe(store, 'PLATFORM_ADDED', 'instagram', null, CREATOR, 'instagram', 1)
    observe(store, 'PLATFORM_ADDED', 'instagram', null, CREATOR, 'instagram', 2)
    assert.ok(listPreferences(store, CREATOR).some((entry) => entry.key === 'platform-focus'))

    for (let index = 3; index <= 5; index += 1) {
      observe(store, 'PLATFORM_REMOVED', 'instagram', null, CREATOR, 'instagram', index)
    }
    const focus = listPreferences(store, CREATOR).find((entry) => entry.key === 'platform-focus')
    assert.equal(focus?.occurrences ?? 0, 0)
  })

  it('never mixes two creators', () => {
    const store = createPreferenceStore()
    for (let index = 1; index <= 4; index += 1) {
      observe(store, 'OPTION_CHOSEN', 'SHORT_VIDEO', null, CREATOR, null, index)
    }
    for (let index = 1; index <= 4; index += 1) {
      observe(store, 'OPTION_CHOSEN', 'CAROUSEL', null, OTHER, null, index)
    }

    const mine = listPreferences(store, CREATOR).find((entry) => entry.key === 'favourite-option')
    const theirs = listPreferences(store, OTHER).find((entry) => entry.key === 'favourite-option')
    assert.equal(mine?.value, 'SHORT_VIDEO')
    assert.equal(theirs?.value, 'CAROUSEL')
  })

  it('keeps the observation log bounded', () => {
    const store = createPreferenceStore()
    for (let index = 1; index <= 260; index += 1) {
      observe(store, 'OPTION_CHOSEN', 'SHORT_VIDEO', null, CREATOR, null, index)
    }
    assert.ok(listObservations(store, CREATOR).length <= 200)
  })
})

describe('creator control', () => {
  function learned() {
    const store = createPreferenceStore()
    for (let index = 1; index <= 4; index += 1) {
      observe(store, 'OPTION_CHOSEN', 'SHORT_VIDEO', null, CREATOR, null, index)
    }
    return store
  }

  it('explains every recommendation', () => {
    const store = learned()
    const all = suggest(store, CREATOR)
    assert.ok(all.length > 0)
    for (const recommendation of all) {
      assert.ok(recommendation.why.length > 0, `${recommendation.key} must explain itself`)
      assert.ok(recommendation.confidence > 0)
    }
  })

  it('stops using a preference the creator turned off, without deleting it', () => {
    const store = learned()
    const preference = listPreferences(store, CREATOR).find((entry) => entry.key === 'favourite-option')!

    setPreferenceEnabled(store, preference.id, false)
    assert.equal(
      suggest(store, CREATOR).some((entry) => entry.key === 'favourite-option'),
      false,
      'a disabled preference is not used',
    )
    assert.equal(listPreferences(store, CREATOR).length, 1, 'but it is still visible and re-enableable')

    setPreferenceEnabled(store, preference.id, true)
    assert.equal(suggest(store, CREATOR).some((entry) => entry.key === 'favourite-option'), true)
  })

  it('forgets one preference on request', () => {
    const store = learned()
    const preference = listPreferences(store, CREATOR).find((entry) => entry.key === 'favourite-option')!

    assert.equal(forgetPreference(store, preference.id), true)
    assert.equal(
      listPreferences(store, CREATOR).some((entry) => entry.key === 'favourite-option'),
      false,
    )
    assert.equal(forgetPreference(store, 'nope'), false)
  })

  it('resets everything, including the observations behind it', () => {
    const store = learned()
    const before = listPreferences(store, CREATOR).length
    assert.ok(before > 0)

    const result = resetPersonalization(store, CREATOR)
    assert.equal(result.preferences, before)
    assert.equal(result.observations > 0, true)
    assert.equal(listPreferences(store, CREATOR).length, 0)
    assert.equal(listObservations(store, CREATOR).length, 0)
    assert.equal(suggest(store, CREATOR).length, 0)
  })

  it('leaves another creator untouched when one resets', () => {
    const store = learned()
    for (let index = 1; index <= 4; index += 1) {
      observe(store, 'OPTION_CHOSEN', 'CAROUSEL', null, OTHER, null, index)
    }

    resetPersonalization(store, CREATOR)
    assert.equal(listPreferences(store, OTHER).length > 0, true)
  })

  it('recommends nothing before it has learned anything', () => {
    assert.deepEqual(recommendations(createPreferenceStore(), CREATOR), [])
  })

  it('records a typed observation for inspection', () => {
    const store = createPreferenceStore()
    const observation: CreatorObservation = {
      id: 'obs_1',
      creatorId: CREATOR,
      kind: 'LIMIT_WARNING_HIT',
      at: at(1),
      subject: 'limits.text.maxCharacters',
      detail: 'overflowed by 12',
      platformSlug: 'instagram',
    }
    recordObservation(store, observation)
    assert.deepEqual(listObservations(store, CREATOR), [observation])
  })
})
