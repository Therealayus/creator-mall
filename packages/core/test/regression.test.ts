import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  attachReport,
  buildRegressionCases,
  runRegression,
} from '../src/evolution/regression.js'
import type { RegressionCase } from '../src/evolution/regression.js'
import type { PromptVersion } from '../src/types/evolution.js'
import { PromptLibrary } from '../src/prompts/versioning.js'

/**
 * The regression runner is the only thing standing between a self-drafted
 * prompt and production, so most of these tests are about refusal: it must not
 * approve a draft it could not actually test.
 */

const always = (text: string) => async () => text
const promptBody = 'Write for the creator. Follow the verified requirement.'

function run(cases: RegressionCase[], complete: (() => Promise<string>) | null) {
  return runRegression({ promptKey: 'creator.post', version: 2, promptBody, cases, complete })
}

describe('regression runner', () => {
  it('passes a draft that meets every expectation', async () => {
    const report = await run(
      [{ id: 'c1', expectation: 'Fits the limit.', brief: 'a reel about batching', maxCharacters: 200 }],
      always('A short post about batching your filming week, in under two hundred characters for sure.'),
    )
    assert.equal(report.verdict, 'SAFE')
    assert.equal(report.passed, 1)
    assert.equal(report.failed, 0)
  })

  it('rejects a draft that breaks a verified limit', async () => {
    const report = await run(
      [{ id: 'c1', expectation: 'Fits the limit.', brief: 'a reel', maxCharacters: 50 }],
      always('x'.repeat(200)),
    )
    assert.equal(report.verdict, 'REJECT')
    assert.match(report.reasons.join(' '), /over the verified limit of 50/)
  })

  it('rejects a draft that mentions what it was told to avoid', async () => {
    const report = await run(
      [{ id: 'c1', expectation: 'Avoids it.', brief: 'earnings', mustNotInclude: ['revenue'] }],
      always('My revenue doubled this month.'),
    )
    assert.equal(report.verdict, 'REJECT')
    assert.match(report.reasons.join(' '), /should not have mentioned "revenue"/)
  })

  it('rejects a draft that missed something it was told to include', async () => {
    const report = await run(
      [{ id: 'c1', expectation: 'Mentions it.', brief: 'a collab', mustInclude: ['collab'] }],
      always('Here is my week.'),
    )
    assert.equal(report.verdict, 'REJECT')
  })

  it('rejects an empty output rather than passing it', async () => {
    const report = await run(
      [{ id: 'c1', expectation: 'Writes something.', brief: 'a reel', minCharacters: 40 }],
      always('   '),
    )
    assert.equal(report.verdict, 'REJECT')
    assert.match(report.reasons.join(' '), /produced nothing/)
  })

  it('never approves a run that tested nothing', async () => {
    const report = await run([], always('anything'))
    assert.equal(report.verdict, 'NEEDS_REVIEW')
    assert.match(report.reasons.join(' '), /nothing was proved/)
  })

  it('never approves when no generator is configured', async () => {
    const report = await run(
      [{ id: 'c1', expectation: 'Fits the limit.', brief: 'a reel', maxCharacters: 500 }],
      null,
    )
    assert.equal(report.verdict, 'NEEDS_REVIEW')
    assert.equal(report.skipped, 1)
    assert.equal(report.passed, 0)
  })

  it('never approves when the generator could not be reached', async () => {
    const report = await run([{ id: 'c1', expectation: 'Writes something.', brief: 'a reel' }], async () => {
      throw new Error('provider returned http 500')
    })
    assert.equal(report.verdict, 'NEEDS_REVIEW')
    assert.match(report.cases[0]?.message ?? '', /could not be reached/)
  })

  it('lets one failure sink the whole draft', async () => {
    const report = await run(
      [
        { id: 'c1', expectation: 'ok', brief: 'a', minCharacters: 10 },
        { id: 'c2', expectation: 'ok', brief: 'b', minCharacters: 10 },
        { id: 'c3', expectation: 'ok', brief: 'c', maxCharacters: 5 },
      ],
      always('a perfectly reasonable post that is long enough to read properly.'),
    )
    assert.equal(report.passed, 2)
    assert.equal(report.failed, 1)
    assert.equal(report.verdict, 'REJECT', 'no averaging a failure away')
  })

  it('gives the operator every reason, not just a verdict', async () => {
    const report = await run(
      [{ id: 'c1', expectation: 'Fits the limit.', brief: 'a reel', maxCharacters: 10 }],
      always('y'.repeat(50)),
    )
    assert.equal(report.reasons.length > 1, true)
    assert.equal(report.cases[0]?.expectation, 'Fits the limit.')
  })
})

describe('regression cases from verified limits', () => {
  it('builds a case for each verified character limit', () => {
    const cases = buildRegressionCases({
      brief: 'a reel about batching',
      limits: [{ label: 'Caption length', value: 2200, unit: 'characters' }],
      requirements: [],
      capabilityLabel: 'Short video',
    })
    assert.equal(cases.length, 1)
    assert.equal(cases[0]?.maxCharacters, 2200)
    assert.match(cases[0]?.expectation ?? '', /2200 characters/)
  })

  it('builds a case per stated requirement', () => {
    const cases = buildRegressionCases({
      brief: 'earnings',
      limits: [],
      requirements: ['Never invent earnings figures.', 'Disclose paid partnerships.'],
      capabilityLabel: 'Post',
    })
    assert.equal(cases.length, 2)
    const forbids = cases.find((entry) => /earnings figures/.test(entry.expectation))
    assert.deepEqual(forbids?.mustNotInclude, ['earnings figures'])
  })

  it('gives every case at least one thing to assert', () => {
    const cases = buildRegressionCases({
      brief: 'anything',
      limits: [
        { label: 'Caption length', value: 2200, unit: 'characters' },
        { label: 'Maximum length', value: 15, unit: 'seconds' },
      ],
      requirements: ['Adapt to the change at limits.video.maxDurationSeconds.', 'Never invent earnings figures.'],
      capabilityLabel: 'Post',
    })
    // A case with no constraint can never fail, which would let a stub pass.
    for (const entry of cases) {
      const constrains =
        (entry.mustInclude?.length ?? 0) > 0 ||
        (entry.mustNotInclude?.length ?? 0) > 0 ||
        entry.maxCharacters !== undefined ||
        entry.minCharacters !== undefined
      assert.equal(constrains, true, `case "${entry.expectation}" asserts nothing`)
    }
  })

  it('never builds an empty suite', () => {
    const cases = buildRegressionCases({
      brief: 'anything',
      limits: [],
      requirements: [],
      capabilityLabel: 'Post',
    })
    assert.equal(cases.length, 1)
    assert.equal(cases[0]?.minCharacters, 40)
  })

  it('falls back to a real-post check when only non-character limits exist', () => {
    const cases = buildRegressionCases({
      brief: 'a reel',
      limits: [{ label: 'Maximum length', value: 15, unit: 'seconds' }],
      requirements: [],
      capabilityLabel: 'Short video',
    })
    assert.equal(cases.length, 1)
    assert.equal(cases[0]?.minCharacters, 40)
  })
})

describe('reports against prompt versions', () => {
  function draft(): PromptVersion {
    const library = new PromptLibrary([
      {
        promptKey: 'creator.post',
        platformId: 'plt_instagram',
        version: 1,
        body: 'Write for the creator.',
        variables: ['topic'],
        status: 'ACTIVE',
        createdAt: '2026-09-01T00:00:00.000Z',
        activatedAt: '2026-09-01T00:00:00.000Z',
        createdBy: 'SEED',
        changeNote: 'Seeded prompt.',
        basedOnEventId: null,
        evaluationScore: null,
      },
    ])
    return library.draftNext({
      promptKey: 'creator.post',
      platformId: 'plt_instagram',
      category: 'POLICY_CHANGE',
      changeSummary: 'Instagram now requires a disclosure label',
      requirements: ['Disclose paid partnerships.'],
    }).draft
  }

  it('marks a version as evaluated only after a real pass', async () => {
    const version = draft()
    assert.equal(version.evaluationScore, null, 'a fresh draft has no score')

    const passing = await runRegression({
      promptKey: version.promptKey,
      version: version.version,
      promptBody: version.body,
      cases: [{ id: 'c1', expectation: 'ok', brief: 'a reel', minCharacters: 10 }],
      complete: always('A perfectly reasonable post that is long enough.'),
    })
    assert.equal(attachReport(version, passing).evaluationScore, 1)

    const failing = await runRegression({
      promptKey: version.promptKey,
      version: version.version,
      promptBody: version.body,
      cases: [{ id: 'c1', expectation: 'ok', brief: 'a reel', maxCharacters: 5 }],
      complete: always('A perfectly reasonable post that is long enough.'),
    })
    assert.equal(attachReport(version, failing).evaluationScore, 0)
  })

  it('does not award a score to an untested draft', async () => {
    const version = draft()
    const skipped = await runRegression({
      promptKey: version.promptKey,
      version: version.version,
      promptBody: version.body,
      cases: [{ id: 'c1', expectation: 'ok', brief: 'a reel' }],
      complete: null,
    })
    assert.equal(attachReport(version, skipped).evaluationScore, 0, 'a run that tested nothing scores nothing')
  })
})

describe('regression cases actually assert their requirement', () => {
  it('forbids the thing a "never mention" requirement names', () => {
    const cases = buildRegressionCases({
      brief: 'a reel',
      limits: [],
      requirements: ['Never mention limits.video.maxDurationSeconds.'],
      capabilityLabel: 'Short video',
    })
    assert.deepEqual(cases[0]?.mustNotInclude, ['limits.video.maxDurationSeconds'])
    assert.deepEqual(cases[0]?.mustInclude, undefined)
  })

  it('requires the new value when a requirement states one', () => {
    const cases = buildRegressionCases({
      brief: 'a reel',
      limits: [],
      requirements: ['Adapt to the change at limits.video.maxDurationSeconds: it is now 15.'],
      capabilityLabel: 'Short video',
    })
    assert.deepEqual(cases[0]?.mustInclude, ['15'])
  })

  it('fails a draft that ignores the requirement it was given', async () => {
    // This is the whole point: a prompt that says "always answer in French"
    // used to pass, because the runner only counted characters.
    const cases = buildRegressionCases({
      brief: 'a reel',
      limits: [],
      requirements: ['Adapt to the change at limits.video.maxDurationSeconds: it is now 15.'],
      capabilityLabel: 'Short video',
    })
    const ignored = await runRegression({
      promptKey: 'k',
      version: 2,
      promptBody: 'Write a post. Always answer in French.',
      cases,
      complete: async () => 'Voici une publication de plus de quinze mots pour tester ce point precis.',
    })
    assert.equal(ignored.verdict, 'REJECT', 'a prompt that ignores the verified change must not pass')

    const honoured = await runRegression({
      promptKey: 'k',
      version: 2,
      promptBody: 'Write a post.',
      cases,
      complete: async () => 'Keep it to 15 seconds, and here is why that length holds attention.',
    })
    assert.equal(honoured.verdict, 'SAFE')
  })
})