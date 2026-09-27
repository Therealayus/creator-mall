import type { AppContext } from '../src/context.js'
import { createContext } from '../src/context.js'
import { createApp } from '../src/api/app.js'
import { ControlPlane } from '../src/store/control-plane.js'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

export interface RouteResponse {
  status: number
  contentType: string
  body: string
}

/**
 * A scripted fetch. Nothing leaves the machine, so the World Engine is fully
 * testable: routes decide what each host "serves", including robots.txt.
 */
export function scriptedFetch(
  routes: Record<string, { status?: number; body?: string | (() => string); contentType?: string; headers?: Record<string, string> }>,
  fallback?: { status?: number; body?: string; contentType?: string; headers?: Record<string, string> },
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const route = routes[url] ?? routes[new URL(url).host] ?? fallback
    const status = route?.status ?? (route ? 200 : 404)
    const body = typeof route?.body === 'function' ? route.body() : (route?.body ?? '')
    const contentType = route?.contentType ?? 'text/html; charset=utf-8'
    const headers = new Headers(route?.headers ?? {})
    headers.set('content-type', contentType)
    return new Response(status === 304 ? null : body, { status, headers })
  }) as typeof fetch
}

export const ROBOTS_ALLOW_ALL = 'User-agent: *\nAllow: /\n'

/** Every host used by the seeded source registry. */
export const SEED_HOSTS = [
  'creators.instagram.com',
  'developers.facebook.com',
  'about.instagram.com',
  'help.instagram.com',
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
  'about.fb.com',
]

/**
 * Serves the same first-party page for every seeded host, so a test never
 * depends on which of a platform's sources the scheduler picks.
 */
export function platformRoutes(body: string): Record<string, { body: string; contentType: string }> {
  const routes: Record<string, { body: string; contentType: string }> = {}
  for (const host of SEED_HOSTS) {
    routes[`https://${host}/robots.txt`] = { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' }
    routes[`https://${host}/`] = { body: html(body), contentType: 'text/html' }
  }
  return routes
}

export function robotsFor(paths: string[]): string {
  return `User-agent: *\n${paths.map((path) => `Disallow: ${path}`).join('\n')}\n`
}

export function html(body: string): string {
  return `<!doctype html><html><head><title>Creator docs</title></head><body>${body}</body></html>`
}

export async function testContext(
  routes: Parameters<typeof scriptedFetch>[0],
  overrides: Partial<AppContext['config']> = {},
  fallback?: Parameters<typeof scriptedFetch>[1],
): Promise<AppContext> {
  return createContext({ RESEARCH_ENABLED: false, ...overrides }, { fetchImpl: scriptedFetch(routes, fallback) })
}

/**
 * Forks a control plane so a test can run "the next research cycle" against a
 * different world (changed pages, failing sources) without losing history.
 */
export async function forkContext(
  base: AppContext,
  routes: Parameters<typeof scriptedFetch>[0],
  fallback?: Parameters<typeof scriptedFetch>[1],
): Promise<AppContext> {
  const context = await testContext(routes, {}, fallback)
  const forked = new ControlPlane(base.control.toState())
  for (const platform of forked.listPlatforms()) context.control.upsertPlatform(platform)
  for (const source of forked.listSources()) context.control.upsertSource(source)
  for (const platform of forked.listPlatforms()) {
    for (const snapshot of forked.snapshotsFor(platform.id)) context.control.addSnapshot(snapshot)
  }
  for (const creator of forked.listCreators()) context.control.upsertCreator(creator)
  for (const event of forked.listEvents()) context.control.addEvent(event)
  for (const proposal of forked.listProposals()) context.control.addProposal(proposal)
  for (const template of forked.listTemplates()) context.control.addTemplate(template)
  for (const document of forked.knowledge.documents.values()) {
    context.control.knowledge.documents.set(document.id, document)
  }
  for (const version of forked.knowledge.versions.values()) {
    context.control.knowledge.versions.set(version.id, version)
  }
  for (const chunk of forked.knowledge.chunks.values()) {
    context.control.knowledge.chunks.set(chunk.id, chunk)
  }
  for (const fact of forked.knowledge.facts.values()) {
    context.control.knowledge.facts.set(fact.id, fact)
  }
  return context
}

export interface RunningServer {
  server: Server
  baseUrl: string
  close: () => Promise<void>
  get: (path: string, init?: RequestInit) => Promise<RouteResponse>
}

export async function startServer(context: AppContext): Promise<RunningServer> {
  const app = createApp(context)
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    server,
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    get: async (path: string, init?: RequestInit) => {
      const response = await fetch(`${baseUrl}${path}`, init)
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: await response.text(),
      }
    },
  }
}

export const CLOCK = (): number => Date.parse('2026-09-27T12:00:00.000Z')

export interface SignedInClient {
  get: (path: string, init?: RequestInit) => Promise<RouteResponse>
  accountId: string
  csrf: string | null
}

/**
 * Registers a creator and returns a client that carries the session cookie and
 * the CSRF token, so tests exercise the same path a browser does.
 */
export async function signedInClient(
  baseUrl: string,
  overrides: { email?: string; platformSlugs?: string[] } = {},
): Promise<SignedInClient> {
  const cookie = { value: '' }
  const state: SignedInClient = {
    accountId: '',
    csrf: null,
    get: async (path, init) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cookie.value) headers.cookie = cookie.value
      if (state.csrf && init?.method && init.method !== 'GET') headers['x-csrf-token'] = state.csrf

      const response = await fetch(baseUrl + path, {
        ...init,
        headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
      })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie.value = setCookie.split(';')[0] ?? ''
      const body = await response.text()
      if (state.csrf === null && response.ok) {
        try {
          state.csrf = (JSON.parse(body) as { csrfToken?: string }).csrfToken ?? null
        } catch {
          state.csrf = null
        }
      }
      return { status: response.status, contentType: response.headers.get('content-type') ?? '', body }
    },
  }

  const created = await state.get('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: overrides.email ?? 'creator@example.com',
      password: 'filminginthecloud7',
      displayName: 'Test creator',
      platformSlugs: overrides.platformSlugs ?? ['instagram'],
    }),
  })
  if (created.status !== 201) throw new Error(`could not sign up: ${created.status} ${created.body}`)
  state.accountId = (JSON.parse(created.body) as { account: { id: string } }).account.id
  return state
}
