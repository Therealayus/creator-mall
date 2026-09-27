import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Suspense, lazy } from 'react'
import { ApiError, fetchOverview } from './lib/api.js'
import { isPublicPath } from './lib/view-models.js'
import type { CreatorOverview } from './lib/api.js'
import { authedFetch, restoreSession, signOut } from './lib/auth.js'
import type { AuthResult } from './lib/auth.js'
import { Shell } from './components/Shell.js'













// Route-level code splitting. Twelve pages and their view models used to ship as
// one 212 kB chunk, so a first-time visitor downloaded the library page and the
// reset-password page before reading a word of the home feed.
const HomePage = lazy(async () => ({ default: (await import('./pages/HomePage.js')).HomePage }))
const CreatePage = lazy(async () => ({ default: (await import('./pages/CreatePage.js')).CreatePage }))
const PlatformPage = lazy(async () => ({ default: (await import('./pages/PlatformPage.js')).PlatformPage }))
const UpdatesPage = lazy(async () => ({ default: (await import('./pages/UpdatesPage.js')).UpdatesPage }))
const ComingSoonPage = lazy(async () => ({ default: (await import('./pages/ComingSoonPage.js')).ComingSoonPage }))
const SignInPage = lazy(async () => ({ default: (await import('./pages/SignInPage.js')).SignInPage }))
const PersonalisationPage = lazy(async () => ({ default: (await import('./pages/PersonalisationPage.js')).PersonalisationPage }))
const AssetsPage = lazy(async () => ({ default: (await import('./pages/AssetsPage.js')).AssetsPage }))
const ToolsPage = lazy(async () => ({ default: (await import('./pages/ToolsPage.js')).ToolsPage }))
const ResetPasswordPage = lazy(async () => ({ default: (await import('./pages/ResetPasswordPage.js')).ResetPasswordPage }))
const VerifyEmailPage = lazy(async () => ({ default: (await import('./pages/VerifyEmailPage.js')).VerifyEmailPage }))
type Phase = 'checking' | 'signed-out' | 'loading' | 'ready' | 'error'

export function App(): ReactNode {
  const [phase, setPhase] = useState<Phase>('checking')
  const [session, setSession] = useState<AuthResult | null>(null)
  const [overview, setOverview] = useState<CreatorOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  const loadOverview = useCallback(async () => {
    setPhase('loading')
    try {
      setOverview(await fetchOverview())
      setPhase('ready')
    } catch (cause) {
      // Only a 401 means the session went away. Signing a creator out because
      // the server had a bad minute would be both wrong and alarming.
      if (cause instanceof ApiError && cause.status === 401) {
        setSession(null)
        setPhase('signed-out')
        return
      }
      setError(cause instanceof Error ? cause.message : 'Something went wrong.')
      setPhase('error')
      return
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const restored = await restoreSession()
      if (!restored) {
        setPhase('signed-out')
        return
      }
      setSession(restored)
      await loadOverview()
    })()
  }, [loadOverview])

  const handleSignOut = useCallback(async () => {
    await signOut()
    setSession(null)
    setOverview(null)
    setPhase('signed-out')
    navigate('/')
  }, [navigate])

  if (phase === 'checking' || phase === 'loading') {
    return (
      <div className="main">
        <p className="empty">Checking what is happening across the creator ecosystem…</p>
      </div>
    )
  }

  /**
   * Account recovery has to be reachable while signed out — that is the only
   * time anyone needs it. It therefore sits above the session gate rather than
   * inside the route table, which the sign-in page would otherwise swallow.
   */
  if (isPublicPath(location.pathname)) {
    return location.pathname === '/verify-email' ? <VerifyEmailPage /> : <ResetPasswordPage />
  }

  if (phase === 'signed-out' || !session) {
    return <SignInPage onAuthenticated={() => void loadOverview()} />
  }

  if (phase === 'error' || !overview) {
    return (
      <div className="main">
        <div className="notice stop">
          <span>{error ?? 'Something went wrong.'}</span>
          <button className="ghost right" onClick={() => void loadOverview()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <Shell creator={session.account.displayName} role={session.account.role} unread={overview.counts.updatesToRead} onSignOut={() => void handleSignOut()}>
      <Suspense
        fallback={
          <p className="empty" role="status">
            Loading this page…
          </p>
        }
      >
        <Routes>
        <Route path="/" element={<HomePage overview={overview} />} />
        <Route path="/create" element={<CreatePage overview={overview} />} />
        <Route path="/create/:platform" element={<CreatePage overview={overview} />} />
        <Route path="/platforms" element={<HomePage overview={overview} platformsOnly />} />
        <Route path="/platforms/:platform" element={<PlatformPage overview={overview} />} />
        <Route path="/updates" element={<UpdatesPage overview={overview} />} />
        <Route path="/library" element={<AssetsPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/coming-soon" element={<ComingSoonPage overview={overview} />} />
        <Route path="/you" element={<PersonalisationPage authedFetch={authedFetch} />} />
        <Route path="*" element={<HomePage overview={overview} />} />
        </Routes>
      </Suspense>
    </Shell>
  )
}
