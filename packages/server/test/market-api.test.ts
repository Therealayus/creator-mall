import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runResearchCycle } from '../src/world-engine/pipeline.js'
import { CLOCK, platformRoutes, signedInClient, startServer, testContext } from './helpers.js'
import type { KnowledgeFact, Source } from '@creator-mall/core'

/**
 * The Market Engine over HTTP.
 *
 * The point of these tests is what a creator is *not* shown: a world with no
 * verified tools must come back empty with an explanation, not with a
 * plausible-looking catalogue.
 */

async function researched(overrides: Partial<Parameters<typeof testContext>[1]> = {}) {
  const context = await testContext(
    platformRoutes(
      '<p>Instagram provides a built-in editing tool for trimming and combining clips in the app.</p>' +
        '<p>The content publishing endpoint accepts a video upload of up to 15 seconds.</p>',
    ),
    overrides,
  )
  await runResearchCycle({
    control: context.control,
    fetcher: context.fetcher,
    respectSchedule: false,
    maxSourcesPerRun: 4,
    clock: CLOCK,
  })
  const server = await startServer(context)
  const client = await signedInClient(server.baseUrl)
  return { context, server, client }
}

describe('market engine api', () => {
  it('answers honestly when nothing has been verified', async () => {
    const context = await testContext(platformRoutes('<p>Nothing useful here.</p>'))
    const server = await startServer(context)
    const client = await signedInClient(server.baseUrl)
    try {
      const response = await client.get('/api/creator/tools')
      assert.equal(response.status, 200)
      const body = JSON.parse(response.body)
      // Resources come from the curated source registry, so a seeded world can
      // still show official reading; what it must never do is invent a tool.
      for (const tool of body.tools) {
        assert.equal(tool.because.length > 0, true, 'every tool carries its evidence')
        assert.match(tool.because[0].source, /\S/)
      }
      assert.equal(typeof body.notice, 'string')
      assert.match(body.notice, /verified|prove/i)
    } finally {
      await server.close()
    }
  })

  it('shows only tools that can be traced to a source', async () => {
    const { server, client } = await researched()
    try {
      const body = JSON.parse((await client.get('/api/creator/tools')).body)
      for (const tool of body.tools) {
        assert.equal(tool.because.length > 0, true, `${tool.name} has no evidence`)
        for (const reason of tool.because) {
          assert.equal(typeof reason.source, 'string')
          assert.equal(reason.source.length > 0, true)
        }
      }
      assert.equal(body.counts.confirmed + body.counts.likely, body.tools.length)
    } finally {
      await server.close()
    }
  })

  it('drops a tool the moment its claim is retracted', async () => {
    const { context, server, client } = await researched()
    try {
      const before = JSON.parse((await client.get('/api/creator/tools')).body)
      const toolCount = before.tools.length

      // Retract every current fact, as a correction would.
      for (const fact of context.control.knowledge.facts.values()) {
        context.control.knowledge.facts.set(fact.id, { ...fact, status: 'RETRACTED' } as KnowledgeFact)
      }
      const after = JSON.parse((await client.get('/api/creator/tools')).body)
      const toolKinds = after.tools.filter((tool: { kind: string }) => tool.kind !== 'RESOURCE')
      assert.deepEqual(toolKinds, [], 'a retracted claim is no longer offered as a tool')
      assert.equal(after.tools.length <= toolCount, true)
    } finally {
      await server.close()
    }
  })

  it('drops a tool when its source is deactivated', async () => {
    const { context, server, client } = await researched()
    try {
      for (const source of context.control.listSources()) {
        context.control.upsertSource({ ...source, active: false } as Source)
      }
      const body = JSON.parse((await client.get('/api/creator/tools')).body)
      assert.deepEqual(body.tools, [], 'no active source means nothing to offer')
      assert.equal(body.counts.confirmed, 0)
    } finally {
      await server.close()
    }
  })

  it('never overstates how sure it is', async () => {
    const { server, client } = await researched()
    try {
      const body = JSON.parse((await client.get('/api/creator/tools')).body)
      for (const tool of body.tools) {
        assert.equal(['confirmed', 'likely'].includes(tool.confidence), true)
        assert.equal(tool.howSure.length > 10, true, 'each tool explains its own confidence')
      }
    } finally {
      await server.close()
    }
  })

  it('speaks plain language, with no internal vocabulary', async () => {
    const { server, client } = await researched()
    try {
      const body = JSON.parse((await client.get('/api/creator/tools')).body)
      const jargon = /snapshot|trustLevel|sourceType|adapter|embedding|crawler|registry|capability\b/i
      for (const tool of body.tools) {
        assert.equal(jargon.test(tool.name), false, tool.name)
        assert.equal(jargon.test(tool.whatItDoes), false, tool.whatItDoes)
        assert.equal(jargon.test(tool.howSure), false)
      }
      for (const tool of body.tools) {
        for (const reason of tool.because) {
          assert.equal(/the platform itself|a source we have verified/.test(reason.kind), true)
        }
      }
    } finally {
      await server.close()
    }
  })

  it('asks anonymous callers to sign in, like every other creator surface', async () => {
    const { server } = await researched()
    try {
      assert.equal((await server.get('/api/creator/tools')).status, 401)
      const other = await signedInClient(server.baseUrl, { email: 'other@creator-mall.test' })
      assert.equal((await other.get('/api/creator/tools')).status, 200)
    } finally {
      await server.close()
    }
  })
})
