import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToString } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Shell } from '../src/components/Shell.js'
import { ToolsPage } from '../src/pages/ToolsPage.js'
import { toolGroupHeading, toolKindWords } from '../src/lib/view-models.js'
import type { CreatorToolCard } from '../src/lib/api.js'

/**
 * The tools page and its wording.
 *
 * A catalogue page is where overclaiming hides, so these tests check that a
 * likely tool is never dressed up as a confirmed one, and that internal words
 * never reach a creator.
 */

const confirmed: CreatorToolCard = {
  id: 'tool_1',
  platform: 'instagram',
  platformName: 'Instagram',
  name: 'Built-in clip editor',
  whatItDoes: 'Instagram provides a built-in editing tool for trimming clips.',
  kind: 'FEATURE',
  confidence: 'confirmed',
  howSure: 'The platform documents this itself.',
  url: 'https://creators.instagram.com/',
  appliesTo: 'Short video',
  checkedAt: '2026-09-27T00:00:00.000Z',
  because: [
    { source: 'Instagram for creators', url: 'https://creators.instagram.com/', kind: 'the platform itself', checkedAt: '2026-09-27T00:00:00.000Z' },
  ],
}

const likely: CreatorToolCard = {
  ...confirmed,
  id: 'tool_2',
  name: 'Third-party scheduler',
  confidence: 'likely',
  howSure: 'A source we trust says this, but the platform has not confirmed it directly.',
  because: [{ source: 'A verified guide', url: null, kind: 'a source we have verified', checkedAt: null }],
}

describe('tools wording', () => {
  it('names each kind in creator words, not ours', () => {
    assert.equal(toolKindWords('FEATURE'), 'A feature on the platform')
    assert.equal(toolKindWords('ENDPOINT'), 'An official way to connect your own tools')
    assert.equal(toolKindWords('RESOURCE'), 'Official reading')
  })

  it('groups under the platform name', () => {
    assert.equal(toolGroupHeading([confirmed]), 'Instagram')
    assert.equal(toolGroupHeading([]), 'Tools')
  })

  it('keeps confidence in the creator-facing words the server chose', () => {
    assert.match(confirmed.howSure, /documents this itself/)
    assert.match(likely.howSure, /has not confirmed it directly/)
  })

  it('never uses internal vocabulary in a tool name or description', () => {
    const jargon = /trustLevel|sourceType|snapshot|adapter|embedding|crawler|registry/i
    for (const tool of [confirmed, likely]) {
      assert.equal(jargon.test(tool.name), false)
      assert.equal(jargon.test(tool.whatItDoes), false)
    }
  })
})

function render(node: ReactNode, path: string): string {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <Shell creator="Demo video creator" role="CREATOR" unread={0} onSignOut={() => undefined}>
            {node}
          </Shell>
        ),
        children: [
          { index: true, element: node },
          { path: '*', element: node },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  return renderToString(<RouterProvider router={router} />).replace(/<!-- -->/g, '')
}

describe('the tools page', () => {
  it('explains where every tool comes from before it loads', () => {
    const html = render(<ToolsPage />, '/tools')
    assert.match(html, /Tools/)
    assert.match(html, /official page or a source we have verified/)
    assert.match(html, /Checking what each platform offers/)
  })

  it('is linked in the main navigation', () => {
    const html = render(<ToolsPage />, '/tools')
    assert.match(html, /href="\/tools"/)
  })
})
