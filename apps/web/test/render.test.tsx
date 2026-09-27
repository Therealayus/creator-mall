import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToString } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Shell } from '../src/components/Shell.js'
import { HomePage } from '../src/pages/HomePage.js'
import { PlatformPage } from '../src/pages/PlatformPage.js'
import { ComingSoonPage } from '../src/pages/ComingSoonPage.js'
import { UpdatesPage } from '../src/pages/UpdatesPage.js'
import type { CreatorOverview } from '../src/lib/api.js'

/**
 * Server-render smoke tests.
 *
 * `renderToString` exercises the real component tree with no DOM and no browser,
 * which is enough to catch broken imports, bad hooks, crashes on real data and
 * accidental jargon in creator-facing copy.
 */

const overview: CreatorOverview = {
  creator: { id: 'cr_demo', name: 'Demo video creator', platforms: ['instagram'] },
  notice: null,
  counts: { optionsReady: 4, updatesToRead: 1, platformsWatched: 8 },
  platforms: [
    {
      slug: 'instagram',
      name: 'Instagram',
      status: 'ACTIVE',
      publishing: false,
      publishingNote: 'We are still preparing the connection for this platform, so publishing is off.',
      lastCheckedAt: '2026-09-27T11:00:00.000Z',
      knowledgeFreshness: 'CURRENT',
      options: [
        {
          key: 'SHORT_VIDEO',
          label: 'Short video',
          description: 'A short vertical video.',
          enabled: true,
          unavailableReason: null,
          media: 'VIDEO',
          limits: [{ label: 'Maximum length', display: '15 seconds' }],
        },
        {
          key: 'AUDIO',
          label: 'Audio',
          description: 'An audio clip attached to a post.',
          enabled: false,
          unavailableReason: 'Waiting for confirmation from the platform.',
          media: 'AUDIO',
          limits: [],
        },
      ],
    },
  ],
  updates: [
    {
      id: 'u1',
      platform: 'instagram',
      title: 'Instagram changed how long a Reel can be',
      body: 'The limits on Instagram posts changed, so check that your existing content still fits.',
      when: '2026-09-27T12:00:00.000Z',
      read: false,
      suggested: ['Review your Instagram publishing setup.'],
      sourceKind: "the platform's own documentation",
      sourceUrl: 'https://creators.instagram.com/',
      whyUrl: '/platforms/instagram',
    },
  ],
  comingSoon: [
    {
      slug: 'loopwave',
      name: 'Loopwave',
      stage: 'Coming soon',
      readinessPercent: 63,
      note: 'We already know which formats it supports.',
    },
  ],
}

function render(node: ReactNode, path: string): string {
  // React inserts comment separators between text nodes when server rendering.
  const raw = renderTree(node, path)
  return raw.replace(/<!-- -->/g, '')
}

function renderTree(node: ReactNode, path: string): string {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Shell creator={overview.creator.name} unread={overview.counts.updatesToRead}>{node}</Shell>,
        children: [
          { index: true, element: node },
          { path: '*', element: node },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  return renderToString(<RouterProvider router={router} />)
}

describe('creator pages render from real data', () => {
  it('renders the home feed with the change and the call to action', () => {
    const html = render(<HomePage overview={overview} />, '/')
    assert.match(html, /What&#x27;s changed|What’s changed/)
    assert.match(html, /Instagram changed how long a Reel can be/)
    assert.match(html, /from the platform&#x27;s own documentation|from the platform’s own documentation/)
    assert.match(html, /4<\/div>/)
  })

  it('renders platform support with confirmed and unavailable options', () => {
    const html = render(<HomePage overview={overview} platformsOnly />, '/platforms')
    assert.match(html, /Platform support/)
    assert.match(html, /1 of 2 options confirmed/)
    assert.match(html, /Preparing connection/)
  })

  it('renders the per-creator updates page', () => {
    const html = render(<UpdatesPage overview={overview} />, '/updates')
    assert.match(html, /Your updates/)
    assert.match(html, /1 unread/)
  })

  it('renders coming-soon platforms with readiness', () => {
    const html = render(<ComingSoonPage overview={overview} />, '/coming-soon')
    assert.match(html, /Coming soon/)
    assert.match(html, /Loopwave/)
    assert.match(html, /63%/)
  })

  it('never leaks internal vocabulary into creator pages', () => {
    const jargon = /capability|adapter|embedding|crawler|\bRAG\b|evolution event|snapshot|trustLevel|proposal|registry/i
    for (const page of [
      render(<HomePage overview={overview} />, '/'),
      render(<HomePage overview={overview} platformsOnly />, '/platforms'),
      render(<UpdatesPage overview={overview} />, '/updates'),
      render(<ComingSoonPage overview={overview} />, '/coming-soon'),
    ]) {
      assert.equal(jargon.test(page), false)
    }
  })

  it('shows an empty state rather than a broken feed', () => {
    const empty: CreatorOverview = { ...overview, updates: [], comingSoon: [] }
    assert.match(render(<HomePage overview={empty} />, '/'), /Nothing new for you right now/)
    assert.match(render(<UpdatesPage overview={empty} />, '/updates'), /Nothing needs your attention/)
    assert.match(render(<ComingSoonPage overview={empty} />, '/coming-soon'), /Nothing new on the horizon/)
  })

  it('has a platform detail page that renders for an unknown slug', () => {
    const html = render(<PlatformPage overview={overview} />, '/platforms/nope')
    assert.match(html, /Platform not found/)
  })

  it('routes every nav destination without crashing', () => {
    const routes = (
      <Routes>
        <Route path="/" element={<HomePage overview={overview} />} />
        <Route path="/platforms" element={<HomePage overview={overview} platformsOnly />} />
        <Route path="/updates" element={<UpdatesPage overview={overview} />} />
        <Route path="/coming-soon" element={<ComingSoonPage overview={overview} />} />
      </Routes>
    )
    for (const path of ['/', '/platforms', '/updates', '/coming-soon']) {
      const html = render(routes, path)
      assert.ok(html.length > 200, `${path} rendered almost nothing`)
    }
  })
})
