import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToString } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import {
  buildPersonalisation,
  confidenceWords,
  evidenceSentences,
  preferenceSentence,
} from '../src/lib/personalisation.js'
import { Shell } from '../src/components/Shell.js'

const preference = (overrides: Record<string, unknown> = {}) => ({
  id: 'pref_1',
  key: 'favourite-option',
  label: 'The option you reach for',
  value: 'short-video',
  why: 'The kind of post you make most often.',
  evidence: ['option chosen on short video'],
  confidence: 0.72,
  occurrences: 5,
  enabled: true,
  ...overrides,
})

describe('personalisation view logic', () => {
  it('shows an honest empty state before anything is learned', () => {
    const model = buildPersonalisation(null)
    assert.equal(model.empty, true)
    assert.equal(model.headline, 'Nothing learned yet')
    assert.match(model.notice, /turn that off at any time/i)
  })

  it('counts what was learned and keeps in-use preferences first', () => {
    const model = buildPersonalisation({
      preferences: [preference({ id: 'a', occurrences: 2, enabled: false }), preference({ id: 'b', occurrences: 9 })],
      suggestions: [],
      notice: 'n',
    })
    assert.equal(model.empty, false)
    assert.match(model.headline, /learned 2 things/i)
    assert.equal(model.preferences[0]?.id, 'b')
  })

  it('says a single thing in the singular', () => {
    const model = buildPersonalisation({ preferences: [preference()], suggestions: [], notice: '' })
    assert.match(model.headline, /learned 1 thing from/i)
  })

  it('words confidence without exposing a score', () => {
    assert.equal(confidenceWords(0.9), 'we are confident')
    assert.equal(confidenceWords(0.6), 'we think so')
    assert.equal(confidenceWords(0.2), 'we are still unsure')
    const sentence = preferenceSentence(preference())
    assert.equal(sentence.includes('0.72'), false, 'a number is not an explanation')
    assert.match(sentence, /we think so/)
  })

  it('turns evidence into sentences about the creator', () => {
    const sentences = evidenceSentences(preference())
    assert.deepEqual(sentences, ['You option chosen on short video.'])
    assert.deepEqual(evidenceSentences(preference({ evidence: [] })), [])
  })

  it('passes the creator-facing copy through untouched', () => {
    const model = buildPersonalisation({
      preferences: [preference()],
      suggestions: [{ key: 'favourite-option', label: 'The option you reach for', value: 'short-video', why: 'You keep choosing it.', confidence: 0.7 }],
      notice: 'Suggestions only.',
    })
    const jargon = /capability|adapter|embedding|crawler|weight|observation/i
    assert.equal(jargon.test(JSON.stringify(model)), false)
    assert.equal(model.suggestions[0]?.why, 'You keep choosing it.')
  })
})

describe('shell navigation', () => {
  it('offers the personalisation page', () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <Shell creator="Riya" role="CREATOR" unread={0} onSignOut={() => undefined}>
              <p>content</p>
            </Shell>
          ),
        },
      ],
      { initialEntries: ['/'] },
    )
    const html = renderToString(<RouterProvider router={router} />).replace(/<!-- -->/g, '')
    assert.match(html, /What we&#x27;ve learned/)
  })
})
