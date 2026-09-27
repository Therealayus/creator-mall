import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CapabilityRegistry,
  diffPlatformStates,
  diffSnapshots,
  emptyPlatformState,
  hashState,
} from '../src/index.js'
import type { PlatformSnapshot, PlatformState } from '../src/index.js'

function snapshot(platformId: string, state: PlatformState, id: string): PlatformSnapshot {
  return {
    id,
    platformId,
    capturedAt: `2026-09-27T00:00:0${id.slice(-1)}.000Z`,
    sourceIds: ['src_1'],
    stateHash: hashState(state),
    state,
    capturedBy: 'SEED',
  }
}

describe('snapshot diff', () => {
  it('reports no deltas when nothing changed', () => {
    const state = { ...emptyPlatformState(), limits: { video: { maxDurationSeconds: 90 } } }
    const diff = diffPlatformStates('pf_1', state, structuredClone(state))
    assert.equal(diff.deltas.length, 0)
    assert.equal(diff.highestRisk, 'LOW')
  })

  it('detects a new capability as a medium-risk addition', () => {
    const before = emptyPlatformState()
    const after = structuredClone(before)
    after.capabilities.CAROUSEL = { capabilityKey: 'CAROUSEL', state: 'ACTIVE', confidence: 0.9, sourceIds: ['src_1'] }

    const diff = diffPlatformStates('pf_1', before, after)
    assert.equal(diff.deltas.length, 1)
    assert.equal(diff.deltas[0]?.path, 'capabilities.CAROUSEL')
    assert.equal(diff.deltas[0]?.category, 'NEW_FEATURE')
    assert.equal(diff.deltas[0]?.riskLevel, 'MEDIUM')
    assert.deepEqual(diff.addedPaths, ['capabilities.CAROUSEL'])
  })

  it('rates a tightened limit higher than a loosened one', () => {
    const before = { ...emptyPlatformState(), limits: { video: { maxDurationSeconds: 90 } } }
    const tightened = { ...emptyPlatformState(), limits: { video: { maxDurationSeconds: 15 } } }
    const loosened = { ...emptyPlatformState(), limits: { video: { maxDurationSeconds: 600 } } }

    assert.equal(diffPlatformStates('pf_1', before, tightened).highestRisk, 'HIGH')
    assert.equal(diffPlatformStates('pf_1', before, loosened).highestRisk, 'MEDIUM')
  })

  it('rates a withdrawn capability as high risk', () => {
    const before = emptyPlatformState()
    before.capabilities.LIVE = { capabilityKey: 'LIVE', state: 'ACTIVE', confidence: 1, sourceIds: [] }
    const after = structuredClone(before)
    delete after.capabilities.LIVE

    const diff = diffPlatformStates('pf_1', before, after)
    assert.equal(diff.deltas[0]?.category, 'REMOVED_FEATURE')
    assert.equal(diff.deltas[0]?.riskLevel, 'HIGH')
    assert.deepEqual(diff.removedPaths, ['capabilities.LIVE'])
  })

  it('rates an api deprecation as critical', () => {
    const before = { ...emptyPlatformState(), api: { contentPublishing: { status: 'GA' } } }
    const after = { ...emptyPlatformState(), api: { contentPublishing: { status: 'DEPRECATED' } } }

    const diff = diffPlatformStates('pf_1', before, after)
    assert.equal(diff.deltas[0]?.category, 'API_DEPRECATION')
    assert.equal(diff.deltas[0]?.riskLevel, 'CRITICAL')
    assert.equal(diff.highestRisk, 'CRITICAL')
  })

  it('ignores configured volatile paths', () => {
    const before = { ...emptyPlatformState(), api: { lastFetchedAt: '2026-01-01' } }
    const after = { ...emptyPlatformState(), api: { lastFetchedAt: '2026-09-27' } }
    const diff = diffPlatformStates('pf_1', before, after, { ignorePaths: ['api.lastFetchedAt'] })
    assert.equal(diff.deltas.length, 0)
  })

  it('links snapshots to their previous version', () => {
    const before = snapshot('pf_1', emptyPlatformState(), 'a')
    const after = snapshot('pf_1', emptyPlatformState(), 'b')
    const diff = diffSnapshots('pf_1', before, after)
    assert.equal(diff.previousSnapshotId, 'a')
    assert.equal(diff.currentSnapshotId, 'b')
  })
})

describe('capability registry', () => {
  const registry = new CapabilityRegistry()

  it('ships the seeded taxonomy', () => {
    assert.ok(registry.has('SHORT_VIDEO'))
    assert.ok(registry.has('SCHEDULING'))
    assert.ok(registry.get('SHORT_VIDEO')?.surfaces.includes('composer'))
  })

  it('maps free text onto capability keys', () => {
    const matches = registry.matchSignals('Instagram is rolling out a new vertical reel format')
    assert.equal(matches[0]?.key, 'SHORT_VIDEO')
  })

  it('registers a genuinely new capability at runtime', () => {
    assert.equal(registry.has('SPATIAL_POST'), false)
    registry.proposeFromSignal('SPATIAL_POST', 'Spatial post', 'CONTENT')
    assert.equal(registry.has('SPATIAL_POST'), true)
    assert.equal(registry.get('SPATIAL_POST')?.origin, 'DETECTED')
  })

  it('derives a stable key from an unknown phrase', () => {
    assert.equal(registry.deriveKey('new vertical story format'), 'VERTICAL_STORY')
  })

  it('normalises key casing and separators', () => {
    registry.register({
      key: 'audio-clip',
      label: 'Audio clip',
      description: 'Clip',
      domain: 'CONTENT',
      surfaces: ['composer'],
      origin: 'DETECTED',
      createdAt: '2026-09-27T00:00:00.000Z',
    })
    assert.ok(registry.has('AUDIO_CLIP'))
  })
})
