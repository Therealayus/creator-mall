import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { listPreferences } from '@creator-mall/core'
import { signedInClient, startServer, testContext } from './helpers.js'
import { platformRoutes } from './helpers.js'

async function signedInWorld() {
  const context = await testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'))
  const server = await startServer(context)
  const client = await signedInClient(server.baseUrl)
  return { context, server, client }
}

async function act(
  client: Awaited<ReturnType<typeof signedInClient>>,
  count: number,
  kind: 'OPTION_CHOSEN' | 'DRAFT_ACCEPTED' | 'PLATFORM_ADDED',
  subject: string,
  detail: string,
  platformSlug = 'instagram',
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const response = await client.get('/api/creator/observations', {
      method: 'POST',
      body: JSON.stringify({ kind, subject, detail, platformSlug }),
    })
    if (response.status !== 200) throw new Error(`${kind} -> ${response.status} ${response.body}`)
  }
}

describe('personalisation api', () => {
  it('starts with an honest empty state', async () => {
    const { server, client } = await signedInWorld()
    try {
      const view = JSON.parse((await client.get('/api/creator/personalisation')).body)
      assert.equal(view.preferences.length, 0)
      assert.equal(view.learningAnything, false)
      assert.equal(view.suggestions.length, 0)
      assert.match(view.notice, /turn any of it off/i)
    } finally {
      await server.close()
    }
  })

  it('learns from repeated behaviour and explains itself', async () => {
    const { server, client } = await signedInWorld()
    try {
      await act(client, 4, 'OPTION_CHOSEN', 'SHORT_VIDEO', 'length:180')
      await act(client, 3, 'DRAFT_ACCEPTED', 'SHORT_VIDEO', 'length:40;hook:result-first')

      const view = JSON.parse((await client.get('/api/creator/personalisation')).body)
      assert.ok(view.preferences.length > 0)

      const favourite = view.preferences.find((preference: { key: string }) => preference.key === 'favourite-option')
      assert.equal(favourite.value, 'SHORT_VIDEO')
      assert.ok(favourite.why.length > 0, 'every preference explains itself')
      assert.ok(favourite.evidence.length > 0, 'every preference shows its evidence')
      assert.ok(favourite.confidence > 0)
      assert.ok(view.suggestions.length > 0)
      for (const suggestion of view.suggestions) assert.ok(suggestion.why.length > 0)
    } finally {
      await server.close()
    }
  })

  it('keeps what it learned inside the account that learned it', async () => {
    const { server, client } = await signedInWorld()
    try {
      await act(client, 4, 'OPTION_CHOSEN', 'SHORT_VIDEO', 'length:180')
      const mine = JSON.parse((await client.get('/api/creator/personalisation')).body)
      assert.ok(mine.preferences.length > 0)

      const other = await signedInClient(server.baseUrl, { email: 'someone-else@example.com' })
      const theirs = JSON.parse((await other.get('/api/creator/personalisation')).body)
      assert.equal(theirs.preferences.length, 0, 'one creator never sees another creator learning')
    } finally {
      await server.close()
    }
  })

  it('stops using a preference the creator turned off, and forgets on request', async () => {
    const { server, client } = await signedInWorld()
    try {
      await act(client, 4, 'OPTION_CHOSEN', 'SHORT_VIDEO', 'length:180')
      const before = JSON.parse((await client.get('/api/creator/personalisation')).body)
      const target = before.preferences.find((preference: { key: string }) => preference.key === 'favourite-option')
      assert.ok(target)

      const off = await client.get(`/api/creator/preferences/${target.id}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: false }),
      })
      assert.equal(off.status, 200)
      const withOff = JSON.parse((await client.get('/api/creator/personalisation')).body)
      assert.equal(
        withOff.suggestions.some((suggestion: { key: string }) => suggestion.key === 'favourite-option'),
        false,
        'a turned-off preference is not used',
      )
      assert.ok(withOff.preferences.some((preference: { id: string }) => preference.id === target.id), 'but it is still visible')

      const forgotten = await client.get(`/api/creator/preferences/${target.id}`, { method: 'DELETE' })
      assert.equal(forgotten.status, 200)
      const afterForget = JSON.parse((await client.get('/api/creator/personalisation')).body)
      assert.equal(
        afterForget.preferences.some((preference: { id: string }) => preference.id === target.id),
        false,
      )

      const unknown = await client.get('/api/creator/preferences/nope', { method: 'DELETE' })
      assert.equal(unknown.status, 404)
    } finally {
      await server.close()
    }
  })

  it('resets everything on request, and says what it removed', async () => {
    const { context, server, client } = await signedInWorld()
    try {
      await act(client, 4, 'OPTION_CHOSEN', 'SHORT_VIDEO', 'length:180')
      assert.ok(listPreferences(context.control.preferences, JSON.parse((await client.get('/api/auth/me')).body).profile.id).length > 0)

      const reset = await client.get('/api/creator/personalisation/reset', { method: 'POST' })
      assert.equal(reset.status, 200)
      const result = JSON.parse(reset.body)
      assert.ok(result.preferences > 0)
      assert.ok(result.observations > 0)

      const after = JSON.parse((await client.get('/api/creator/personalisation')).body)
      assert.equal(after.preferences.length, 0)
      assert.equal(after.suggestions.length, 0)
    } finally {
      await server.close()
    }
  })

  it('rejects an observation it cannot understand', async () => {
    const { server, client } = await signedInWorld()
    try {
      const response = await client.get('/api/creator/observations', {
        method: 'POST',
        body: JSON.stringify({ kind: 'SOMETHING_ELSE', subject: 'x' }),
      })
      assert.equal(response.status, 400)
    } finally {
      await server.close()
    }
  })

  it('requires a session', async () => {
    const context = await testContext(platformRoutes('<p>Reels can be up to 90 seconds long.</p>'))
    const server = await startServer(context)
    try {
      const anonymous = await fetch(`${server.baseUrl}/api/creator/personalisation`)
      assert.equal(anonymous.status, 401)
    } finally {
      await server.close()
    }
  })

  it('never exposes internal vocabulary in creator-facing copy', async () => {
    const { server, client } = await signedInWorld()
    try {
      await act(client, 4, 'OPTION_CHOSEN', 'SHORT_VIDEO', 'length:180')
      const response = await client.get('/api/creator/personalisation')
      const jargon = /capability|adapter|embedding|crawler|observation|confidence score|weight/i
      assert.equal(jargon.test(response.body), false)
    } finally {
      await server.close()
    }
  })
})
