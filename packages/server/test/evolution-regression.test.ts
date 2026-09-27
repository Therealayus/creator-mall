import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runResearchCycle } from '../src/world-engine/pipeline.js'
import { activatePromptVersion, evaluatePromptVersion } from '../src/evolution/regression-service.js'
import { CLOCK, forkContext, platformRoutes, startServer, testContext } from './helpers.js'
import type { AppContext } from '../src/context.js'
import type { EvolutionEvent } from '@creator-mall/core'

/**
 * The self-modifying loop, end to end.
 *
 * The behaviour under test is a chain, and every link has to hold:
 *
 *   verified change → draft → run the checks → only then may it go live
 *
 * A gap anywhere in that chain means the system rewrites itself on the strength
 * of a change it never tested.
 */

const BEFORE = '<p>Reels can be up to 90 seconds long.</p>'
const AFTER = '<p>Reels can be up to 15 seconds long.</p>'

async function cycle(context: AppContext): Promise<void> {
  await runResearchCycle({
    control: context.control,
    fetcher: context.fetcher,
    respectSchedule: false,
    maxSourcesPerRun: 2,
    clock: CLOCK,
  })
}

/** A baseline, then a real change, which is the only thing that drafts anything. */
async function changedWorld(): Promise<{ context: AppContext; event: EvolutionEvent }> {
  const baseline = await testContext(platformRoutes(BEFORE))
  await cycle(baseline)

  const context = await forkContext(baseline, platformRoutes(AFTER))
  await cycle(context)

  const event = context.control.listEvents({ status: 'ACCEPTED' })[0] ?? context.control.listEvents()[0]
  assert.ok(event, 'a tightened limit should produce a change to react to')
  return { context, event }
}

function draftsFor(context: AppContext, event: EvolutionEvent) {
  return context.control.prompts
    .all()
    .filter((version) => version.basedOnEventId === event.id && version.status === 'DRAFT')
}

describe('evolution: a verified change drafts the next prompt', () => {
  it('drafts instead of silently carrying on as before', async () => {
    const { context, event } = await changedWorld()
    const drafts = draftsFor(context, event)
    assert.equal(drafts.length > 0, true, 'a change with affected capabilities should draft something')
  })

  it('never activates a draft on its own', async () => {
    const { context, event } = await changedWorld()
    for (const draft of draftsFor(context, event)) {
      assert.equal(draft.status, 'DRAFT')
      assert.equal(draft.activatedAt, null)
    }
  })

  it('puts the verified requirement into the draft, with a diff to review', async () => {
    const { context, event } = await changedWorld()
    const draft = draftsFor(context, event)[0]!
    assert.match(draft.body, /Current platform requirements/)
    assert.equal(draft.body.length > 40, true)
    assert.match(draft.changeNote ?? '', /Auto-drafted/)
  })

  it('records which change the draft came from', async () => {
    const { context, event } = await changedWorld()
    assert.equal(draftsFor(context, event)[0]?.basedOnEventId, event.id)
  })

  it('does not pile up versions when the same change is processed twice', async () => {
    const { context, event } = await changedWorld()
    const before = draftsFor(context, event).length
    const again = await runResearchCycle({
      control: context.control,
      fetcher: context.fetcher,
      respectSchedule: false,
      maxSourcesPerRun: 2,
      clock: CLOCK,
    })
    assert.equal(typeof again.draftsCreated, 'number')
    // A re-run over unchanged pages finds no new change, so nothing new appears.
    assert.equal(draftsFor(context, event).length, before)
  })
})

describe('evolution: activation needs evidence', () => {
  it('refuses a draft that has never been run', async () => {
    const { context, event } = await changedWorld()
    const draft = draftsFor(context, event)[0]!
    const result = activatePromptVersion(context, draft.promptKey, draft.version)
    assert.equal(result.activation.allowed, false)
    assert.equal(result.activation.refusal, 'NEVER_EVALUATED')
    assert.equal(context.control.prompts.get(draft.promptKey, draft.version)?.status, 'DRAFT')
  })

  it('refuses a run that could not test anything, because nothing is configured', async () => {
    const { context, event } = await changedWorld()
    const draft = draftsFor(context, event)[0]!

    const evaluation = await evaluatePromptVersion(context, draft.promptKey, draft.version)
    assert.ok(evaluation)
    // testContext passes no provider key, so every case must skip.
    assert.equal(evaluation.report.skipped, evaluation.report.cases.length)
    assert.equal(evaluation.report.passed, 0)
    assert.equal(evaluation.report.verdict, 'NEEDS_REVIEW')

    const activation = activatePromptVersion(context, draft.promptKey, draft.version)
    assert.equal(activation.activation.allowed, false)
    assert.equal(activation.activation.refusal, 'INCOMPLETE')
  })

  it('reports the reason a creator or operator would need, not just a code', async () => {
    const { context, event } = await changedWorld()
    const draft = draftsFor(context, event)[0]!
    await evaluatePromptVersion(context, draft.promptKey, draft.version)
    const result = activatePromptVersion(context, draft.promptKey, draft.version)
    assert.equal(result.activation.reason.length > 20, true)
    assert.equal(result.activation.overridden, false)
  })

  it('lets a person overrule it, but records that they did', async () => {
    const { context, event } = await changedWorld()
    const draft = draftsFor(context, event)[0]!
    const result = activatePromptVersion(context, draft.promptKey, draft.version, { override: true })
    assert.equal(result.activation.allowed, true)
    assert.equal(result.activation.overridden, true)
    assert.equal(result.activation.refusal, 'NEVER_EVALUATED')
    assert.equal(context.control.prompts.get(draft.promptKey, draft.version)?.status, 'ACTIVE')
  })

  it('activates a draft that passed every check', async () => {
    const { context, event } = await changedWorld()
    const draft = draftsFor(context, event)[0]!

    // The generator has to actually honour the verified change. The old stub
    // ignored it and the run still passed, which is exactly the hole this
    // assertion is now there to close.
    const stub = {
      complete: async () =>
        'Keep it to 15 seconds and here is why that length holds attention while you film a week of content in one go.',
    }
    const original = context.modelClient
    ;(context as { modelClient: unknown }).modelClient = stub

    try {
      const evaluation = await evaluatePromptVersion(context, draft.promptKey, draft.version)
      assert.ok(evaluation)
      assert.equal(evaluation.report.failed, 0)
      assert.equal(evaluation.report.verdict, 'SAFE')
      assert.equal(evaluation.activation.allowed, true)

      const activation = activatePromptVersion(context, draft.promptKey, draft.version)
      assert.equal(activation.activation.allowed, true)
      assert.equal(activation.activation.overridden, false)
      assert.equal(context.control.prompts.get(draft.promptKey, draft.version)?.status, 'ACTIVE')
    } finally {
      ;(context as { modelClient: unknown }).modelClient = original
    }
  })

  it('refuses a draft whose output failed a check, and an override says so', async () => {
    const { context, event } = await changedWorld()
    const draft = draftsFor(context, event)[0]!
    const original = context.modelClient
    // Too short to be a real post, which the floor check catches.
    ;(context as { modelClient: unknown }).modelClient = { complete: async () => 'Reels.' }

    try {
      const evaluation = await evaluatePromptVersion(context, draft.promptKey, draft.version)
      assert.ok(evaluation)
      assert.equal(evaluation.report.failed > 0, true)
      assert.equal(evaluation.report.verdict, 'REJECT')

      const refused = activatePromptVersion(context, draft.promptKey, draft.version)
      assert.equal(refused.activation.allowed, false)
      assert.equal(refused.activation.refusal, 'FAILED')

      const overridden = activatePromptVersion(context, draft.promptKey, draft.version, { override: true })
      assert.equal(overridden.activation.overridden, true)
      assert.equal(overridden.activation.refusal, 'FAILED')
    } finally {
      ;(context as { modelClient: unknown }).modelClient = original
    }
  })

  it('leaves an active prompt alone when another version is activated', async () => {
    const { context, event } = await changedWorld()
    const draft = draftsFor(context, event)[0]!
    activatePromptVersion(context, draft.promptKey, draft.version, { override: true })

    const versions = context.control.prompts.versions(draft.promptKey)
    const active = versions.filter((version) => version.status === 'ACTIVE')
    assert.equal(active.length, 1, 'exactly one version of a prompt is ever active')
  })
})

describe('evolution: the operator surface', () => {
  it('lists drafts with whether they have been evaluated', async () => {
    const { context } = await changedWorld()
    const server = await startServer(context)
    try {
      const response = await server.get('/api/evolution/prompts')
      assert.equal(response.status, 200)
      const body = JSON.parse(response.body)
      assert.equal(Array.isArray(body.prompts), true)
      for (const prompt of body.prompts) {
        assert.equal(typeof prompt.evaluated, 'boolean')
      }
    } finally {
      await server.close()
    }
  })

  it('refuses activation over HTTP without evidence, and reports why', async () => {
    const { context, event } = await changedWorld()
    const server = await startServer(context)
    try {
      const draft = draftsFor(context, event)[0]!
      const key = encodeURIComponent(draft.promptKey)
      const response = await server.get(`/api/evolution/prompts/${key}/versions/${draft.version}/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ override: false }),
      })
      assert.equal(response.status, 409)
      const body = JSON.parse(response.body)
      assert.equal(body.overridden, false)
      assert.equal(body.error.length > 10, true)
    } finally {
      await server.close()
    }
  })

  it('runs the checks over HTTP and comes back needing review', async () => {
    const { context, event } = await changedWorld()
    const server = await startServer(context)
    try {
      const draft = draftsFor(context, event)[0]!
      const key = encodeURIComponent(draft.promptKey)
      const response = await server.get(`/api/evolution/prompts/${key}/versions/${draft.version}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, 200)
      const body = JSON.parse(response.body)
      assert.equal(body.report.verdict, 'NEEDS_REVIEW')
      assert.equal(body.activation.allowed, false)
      assert.equal(body.cases.length > 0, true, 'it says what it tried to check')
    } finally {
      await server.close()
    }
  })

  it('404s a prompt version that does not exist', async () => {
    const { context } = await changedWorld()
    const server = await startServer(context)
    try {
      const response = await server.get('/api/evolution/prompts/nope/versions/9/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, 404)
    } finally {
      await server.close()
    }
  })
})
