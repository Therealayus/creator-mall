import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Route, Routes } from 'react-router-dom'
import { fetchOverview } from './lib/api.js'
import type { CreatorOverview } from './lib/api.js'
import { Shell } from './components/Shell.js'
import { HomePage } from './pages/HomePage.js'
import { CreatePage } from './pages/CreatePage.js'
import { PlatformPage } from './pages/PlatformPage.js'
import { UpdatesPage } from './pages/UpdatesPage.js'
import { ComingSoonPage } from './pages/ComingSoonPage.js'

export interface OverviewContextValue {
  overview: CreatorOverview
  refresh: () => Promise<void>
}

export function App(): ReactNode {
  const [overview, setOverview] = useState<CreatorOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setOverview(await fetchOverview())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach Creator Mall')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (error) {
    return (
      <div className="main">
        <div className="notice stop">
          <span>{error}</span>
          <button className="ghost right" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!overview) {
    return (
      <div className="main">
        <p className="empty">Checking what is happening across the creator ecosystem…</p>
      </div>
    )
  }

  return (
    <Shell creator={overview.creator.name} unread={overview.counts.updatesToRead}>
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
