import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import { fetchOverview } from './lib/api.js'
import type { CreatorOverview } from './lib/api.js'
import { restoreSession, signOut } from './lib/auth.js'
import type { AuthResult } from './lib/auth.js'
import { Shell } from './components/Shell.js'
import { HomePage } from './pages/HomePage.js'
import { CreatePage } from './pages/CreatePage.js'
import { PlatformPage } from './pages/PlatformPage.js'
import { UpdatesPage } from './pages/UpdatesPage.js'
import { ComingSoonPage } from './pages/ComingSoonPage.js'
import { SignInPage } from './pages/SignInPage.js'

type Phase = 'checking' | 'signed-out' | 'loading' | 'ready' | 'error'

export function App(): ReactNode {
  const [phase, setPhase] = useState<Phase>('checking')
  const [session, setSession] = useState<AuthResult | null>(null)
  const [overview, setOverview] = useState<CreatorOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const loadOverview = useCallback(async () => {
    setPhase('loading')
    try {
      setOverview(await fetchOverview())
      setPhase('ready')
    } catch (cause) {
      // A 401 means the session went away; anything else is a real problem.
      if (cause instanceof Error && cause.name === 'ApiError') {
        setSession(null)
        setPhase('signed-out')
        return
      }
      setError(cause instanceof Error ? cause.message : 'Could not reach Creator Mall')
      setPhase('error')
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
      <Routes>
        <Route path="/" element={<HomePage overview={overview} />} />
        <Route path="/create" element={<CreatePage overview={overview} />} />
        <Route path="/create/:platform" element={<CreatePage overview={overview} />} />
        <Route path="/platforms" element={<HomePage overview={overview} platformsOnly />} />
        <Route path="/platforms/:platform" element={<PlatformPage overview={overview} />} />
        <Route path="/updates" element={<UpdatesPage overview={overview} />} />
        <Route path="/coming-soon" element={<ComingSoonPage overview={overview} />} />
        <Route path="*" element={<HomePage overview={overview} />} />
      </Routes>
    </Shell>
  )
}
