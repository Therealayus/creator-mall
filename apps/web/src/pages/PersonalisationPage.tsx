import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  buildPersonalisation,
  evidenceSentences,
  preferenceSentence,
} from '../lib/personalisation.js'
import type { PersonalisationViewModel } from '../lib/personalisation.js'

export interface PersonalisationResponse {
  preferences: Array<{
    id: string
    label: string
    value: string
    why: string
    evidence: string[]
    confidence: number
    occurrences: number
    enabled: boolean
  }>
  suggestions: Array<{ key: string; label: string; value: string; why: string; confidence: number }>
  learningAnything: boolean
  notice: string
}

/** §31: why am I seeing this, forget one, or reset everything. */
export function PersonalisationPage(props: { authedFetch: <T>(path: string, init?: RequestInit) => Promise<T> }): ReactNode {
  const [model, setModel] = useState<PersonalisationViewModel | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setModel(buildPersonalisation(await props.authedFetch<PersonalisationResponse>('/api/creator/personalisation')))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load this')
    }
  }, [props])

  useEffect(() => {
    void load()
  }, [load])

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="page-head">
        <h1>What we've learned</h1>
        <div className="notice stop">{error}</div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="ghost" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!model) return <p className="empty">Checking what we have learned…</p>

  return (
    <>
      <div className="page-head">
        <h1>What we've learned</h1>
        <p>{model.headline}</p>
      </div>

      {model.notice && <div className="notice info">{model.notice}</div>}

      {model.empty ? (
        <div className="card" style={{ marginTop: 18 }}>
          <h2>Nothing yet</h2>
          <p>{model.notice}</p>
        </div>
      ) : (
        <>
          <div className="grid cols-2" style={{ marginTop: 18 }}>
            {model.preferences.map((preference) => (
              <div className="card" key={preference.id}>
                <div className="row">
                  <h2 style={{ margin: 0 }}>{preference.label}</h2>
                  <span className={`pill right ${preference.enabled ? 'good' : ''}`}>
                    {preference.enabled ? 'In use' : 'Turned off'}
                  </span>
                </div>
                <p style={{ marginTop: 8 }}>{preferenceSentence(preference)}</p>
                {evidenceSentences(preference).length > 0 && (
                  <ul className="auth-problems" style={{ color: 'var(--text-faint)' }}>
                    {evidenceSentences(preference).map((sentence) => (
                      <li key={sentence}>{sentence}</li>
                    ))}
                  </ul>
                )}
                <div className="row" style={{ marginTop: 12 }}>
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        props.authedFetch(`/api/creator/preferences/${preference.id}`, {
                          method: 'POST',
                          body: JSON.stringify({ enabled: !preference.enabled }),
                        }),
                      )
                    }
                  >
                    {preference.enabled ? 'Turn this off' : 'Use this again'}
                  </button>
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        props.authedFetch(`/api/creator/preferences/${preference.id}`, { method: 'DELETE' }),
                      )
                    }
                  >
                    Forget this
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <h2>Start again</h2>
            <p>
              Forget everything we have learned, including the history behind it. Your posts and
              accounts are untouched.
            </p>
            <button
              className="ghost"
              disabled={busy}
              style={{ marginTop: 12 }}
              onClick={() => void act(() => props.authedFetch('/api/creator/personalisation/reset', { method: 'POST' }))}
            >
              Reset personalisation
            </button>
          </div>
        </>
      )}
    </>
  )
}
