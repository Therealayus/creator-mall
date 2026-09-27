import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { startServer, testContext } from './helpers.js'
import { buildHealthReport } from '@creator-mall/core'

/**
 * A health endpoint that always answers 200 is not a health check: an
 * orchestrator keeps routing traffic to a broken container. These tests pin the
 * status code, and pin that "we measured nothing" is not "everything is fine".
 */

const noSources = {
  sources: [],
  currentVersions: [],
  events: [],
  proposals: [],
  lastRun: null,
  integrationHealth: {},
}

describe('health reporting', () => {
  it('does not claim health when nothing has ever been measured', () => {
    const report = buildHealthReport(noSources as never)
    assert.notEqual(report.overall, 'HEALTHY', 'absence of evidence is not evidence of health')
  })

  it('is healthy when the things we can see are healthy', () => {
    const report = buildHealthReport({
      ...noSources,
      sources: [
        {
          id: 's1',
          name: 'Docs',
          url: 'https://example.com/',
          domain: 'example.com',
          sourceType: 'OFFICIAL',
          platform: null,
          trustLevel: 'OFFICIAL',
          discoveredVia: 'SEED',
          lastCheckedAt: new Date().toISOString(),
          nextCheckAt: null,
          active: true,
          lastStatus: 'OK',
          consecutiveFailures: 0,
        },
      ],
    } as never)
    assert.equal(report.overall, 'HEALTHY')
  })

  it('separates liveness from readiness', async () => {
    // A world with no sources and no runs: nothing measured, so not ready.
    const context = await testContext({}, { ALLOW_UNAUTHENTICATED_ADMIN: true })
    const server = await startServer(context)
    try {
      // Liveness stays 200: the process is running and must not be restarted
      // because a source is flaky.
      const live = await server.get('/api/health')
      assert.equal(live.status, 200)

      // Readiness is what a load balancer uses, and it tracks the report.
      const ready = await server.get('/api/ready')
      const overall = JSON.parse((await server.get('/api/health')).body).health.overall as string
      assert.equal(ready.status, overall === 'HEALTHY' ? 200 : 503, 'readiness must track the health report')
      assert.equal(JSON.parse(ready.body).overall, overall)
    } finally {
      await server.close()
    }
  })

  it('is not ready when nothing has been verified', async () => {
    // A world with every source failing measures nothing useful, and must not
    // take traffic.
    const context = await testContext({}, { ALLOW_UNAUTHENTICATED_ADMIN: true })
    for (const source of context.control.listSources()) {
      context.control.upsertSource({ ...source, lastStatus: 'FAILED', consecutiveFailures: 5 })
    }
    const server = await startServer(context)
    try {
      assert.equal((await server.get('/api/ready')).status, 503)
      assert.equal((await server.get('/api/health')).status, 200, 'liveness is unaffected')
    } finally {
      await server.close()
    }
  })

  it('echoes a request id so a report can be traced to a log line', async () => {
    const context = await testContext({}, { ALLOW_UNAUTHENTICATED_ADMIN: true })
    const server = await startServer(context)
    try {
      const supplied = 'req_from_the_client'
      const echoed = await server.get('/api/health', { headers: { 'x-request-id': supplied } })
      const generated = await server.get('/api/health')

      const withId = JSON.parse(echoed.body) as Record<string, unknown>
      void withId
      // The id travels as a header, so check the raw response.
      const response = await fetch(`${server.baseUrl}/api/health`, {
        headers: { 'x-request-id': supplied },
      })
      assert.equal(response.headers.get('x-request-id'), supplied, 'a caller id must be echoed back')

      const fresh = await fetch(`${server.baseUrl}/api/health`)
      assert.match(fresh.headers.get('x-request-id') ?? '', /^req_/, 'and one is minted when absent')
      assert.equal(generated.status > 0, true)
    } finally {
      await server.close()
    }
  })
})
