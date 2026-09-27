/**
 * Live smoke test for the creator journey: sign up → read data → create → sign out.
 * Requires a running server. Run with: node scripts/smoke-auth.mjs
 */
const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4000'
const marker = 'id="root"'

const state = { cookie: '', csrf: null }

const call = async (path, init = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (state.cookie) headers.cookie = state.cookie
  if (state.csrf && init.method && init.method !== 'GET') headers['x-csrf-token'] = state.csrf
  const response = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) state.cookie = setCookie.split(';')[0]
  const body = await response.text()
  return { status: response.status, body }
}

const run = async () => {
  const page = await fetch(base + '/')
  const html = await page.text()
  console.log('app shell        ->', page.status, html.includes(marker) ? 'served' : 'MISSING')

  const anonymous = await call('/api/creator/overview')
  console.log('anonymous access ->', anonymous.status, anonymous.status === 401 ? 'correctly refused' : 'LEAK')

  const email = `smoke-${Date.now()}@example.com`
  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'filminginthecloud7', displayName: 'Smoke creator', platformSlugs: ['instagram'] }),
  })
  const session = JSON.parse(registered.body)
  state.csrf = session.csrfToken
  console.log('sign up          ->', registered.status, session.account?.displayName, '| role', session.account?.role)
  console.log('password leaked? ->', registered.body.includes('scrypt') || registered.body.includes('filminginthecloud7') ? 'YES' : 'no')

  const me = await call('/api/auth/me')
  console.log('session          ->', me.status, JSON.parse(me.body).account.email)

  const overview = JSON.parse((await call('/api/creator/overview')).body)
  console.log('overview         ->', overview.platforms.length, 'platforms,', overview.counts.optionsReady, 'options ready')

  const noCsrf = await fetch(base + '/api/creator/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: state.cookie },
    body: JSON.stringify({ platform: 'instagram', option: 'SHORT_VIDEO', brief: 'batch filming' }),
  })
  console.log('csrf enforced    ->', noCsrf.status, noCsrf.status === 403 ? 'correctly refused' : 'MISSING')

  const draft = JSON.parse(
    (await call('/api/creator/draft', {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram', option: 'SHORT_VIDEO', brief: 'batch filming a week' }),
    })).body,
  )
  console.log('draft            ->', draft.prepared ? 'prepared structure' : 'generic outline')

  const operator = await call('/api/evolution/summary')
  console.log('creator→operator ->', operator.status, operator.status === 401 || operator.status === 403 ? 'correctly refused' : 'LEAK')

  const out = await call('/api/auth/logout', { method: 'POST' })
  console.log('sign out         ->', out.status)
  const after = await call('/api/creator/overview')
  console.log('after sign out   ->', after.status, after.status === 401 ? 'session invalid' : 'STILL ACTIVE')
}

run().catch((error) => {
  console.error('SMOKE FAILED', error)
  process.exit(1)
})
