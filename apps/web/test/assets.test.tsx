import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToString } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Shell } from '../src/components/Shell.js'
import { AssetsPage } from '../src/pages/AssetsPage.js'
import { assetHeadline, assetKindLabel, fileSize, isPreviewable } from '../src/lib/view-models.js'
import type { AssetSummary } from '../src/lib/api.js'

/**
 * The library page and the wording around assets.
 *
 * The rule these tests protect: an artifact rendered here must never be
 * described as though a model made it, and a creator must always be able to
 * tell the two apart.
 */

const generatedPoster: AssetSummary = {
  id: 'ast_1',
  kind: 'IMAGE',
  title: 'how I batch filmed a week of content',
  sizeBytes: 1391,
  producedBy: 'creator-mall-renderer-v1 + creator-mall-renderer-v1',
  madeWithAI: false,
  createdAt: '2026-09-27T12:00:00.000Z',
  platformSlug: 'instagram',
  origin: 'GENERATED',
  mimeType: 'image/svg+xml',
}

const modelCopy: AssetSummary = {
  ...generatedPoster,
  id: 'ast_2',
  kind: 'TEXT',
  title: 'a caption a model drafted',
  producedBy: 'openrouter/stealth/space-bunny-alpha',
  madeWithAI: true,
  mimeType: 'text/plain',
}

const upload: AssetSummary = {
  ...generatedPoster,
  id: 'ast_3',
  kind: 'IMAGE',
  title: 'my-logo',
  origin: 'UPLOADED',
  mimeType: 'image/png',
}

const now = Date.parse('2026-09-27T13:00:00.000Z')

describe('asset wording', () => {
  it('never calls a rendered artifact AI', () => {
    const line = assetHeadline(generatedPoster)
    assert.match(line, /Made here, not by a model/)
    assert.equal(/by a model\b/.test(line.replace('not by a model', '')), false)
  })

  it('says plainly when a model wrote it', () => {
    assert.match(assetHeadline(modelCopy), /Written by a model/)
  })

  it('distinguishes an upload from something we made', () => {
    assert.match(assetHeadline(upload), /You added this/)
    assert.match(assetHeadline(generatedPoster), /We made this for you/)
  })

  it('names each kind in creator words', () => {
    assert.equal(assetKindLabel('IMAGE'), 'Poster')
    assert.equal(assetKindLabel('STORYBOARD'), 'Shot list')
    assert.equal(assetKindLabel('AUDIO'), 'Audio')
  })

  it('previews images only', () => {
    assert.equal(isPreviewable(generatedPoster), true)
    assert.equal(isPreviewable(upload), true)
    assert.equal(isPreviewable(modelCopy), false)
  })

  it('sizes files for a person', () => {
    assert.equal(fileSize(512), '512 B')
    assert.equal(fileSize(1391), '1.4 kB')
    assert.equal(fileSize(3 * 1024 * 1024), '3.0 MB')
    assert.equal(fileSize(-1), '')
  })

  it('keeps the time honest rather than vague', () => {
    assert.match(assetHeadline({ ...generatedPoster, createdAt: '2026-09-27T12:55:00.000Z' }, now), /5 min ago/)
    assert.match(assetHeadline({ ...generatedPoster, createdAt: '2026-09-25T12:00:00.000Z' }, now), /2 d ago/)
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

describe('the library page', () => {
  it('renders without a browser or data', () => {
    // The list arrives after mount, so the first paint is a loading state and
    // it must say so. It used to claim the library was empty, which made a slow
    // load indistinguishable from a creator with nothing.
    const html = render(<AssetsPage />, '/library')
    assert.match(html, /Your library/)
    assert.match(html, /Add a file/)
    assert.match(html, /Loading your library/)
    assert.equal(/Nothing here yet/.test(html), false, 'a loading library is not an empty one')
  })

  it('offers a filter for each kind it can show', () => {
    const html = render(<AssetsPage />, '/library')
    for (const label of ['Everything', 'Posters', 'Shot lists', 'Videos', 'Audio', 'Text']) {
      assert.match(html, new RegExp(label))
    }
  })

  it('links the library into the main navigation', () => {
    const html = render(<AssetsPage />, '/library')
    assert.match(html, /href="\/library"/)
  })
})

