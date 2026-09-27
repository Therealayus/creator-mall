import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchDraft, validateContent } from '../lib/api.js'
import type { CreatorOption, CreatorOverview, DraftResult, ValidationResult } from '../lib/api.js'
import {
  characterCounter,
  groupOptions,
  limitSummary,
  mediaPrompt,
  platformHeadline,
  validationHeadline,
} from '../lib/view-models.js'
import { WhyCard } from '../components/WhyCard.js'

/**
 * The creation flow.
 *
 * Options come from the platform's confirmed capabilities, limits come from
 * verified platform facts, and anything unavailable explains itself. There is no
 * platform name anywhere in this file — adding a platform adds rows, not code.
 */
export function CreatePage(props: { overview: CreatorOverview }): ReactNode {
  const params = useParams()
  const navigate = useNavigate()
  const { overview } = props

  const usable = useMemo(
    () => overview.platforms.filter((platform) => platform.options.some((option) => option.enabled)),
    [overview.platforms],
  )

  const [platformSlug, setPlatformSlug] = useState<string>(params.platform ?? usable[0]?.slug ?? '')
  const platform = overview.platforms.find((entry) => entry.slug === platformSlug) ?? usable[0]

  const [optionKey, setOptionKey] = useState<string>('')
  const option: CreatorOption | undefined =
    platform?.options.find((entry) => entry.key === optionKey) ??
    platform?.options.find((entry) => entry.enabled)

  const [brief, setBrief] = useState('')
  const [text, setText] = useState('')
  const [mediaCount, setMediaCount] = useState(0)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [draft, setDraft] = useState<DraftResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const limits = option?.limits ?? []
  const counter = characterCounter(text, limits)
  const canDraft = Boolean(platform && option?.enabled && brief.trim().length > 0)

  async function runValidation(): Promise<void> {
    if (!platform || !option) return
    setBusy(true)
    try {
      setValidation(
        await validateContent({
          platform: platform.slug,
          option: option.key,
          text,
          mediaCount,
        }),
      )
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check that just now')
    } finally {
      setBusy(false)
    }
  }

  async function buildDraft(): Promise<void> {
    if (!platform || !option) return
    setBusy(true)
    try {
      setDraft(await fetchDraft({ platform: platform.slug, option: option.key, brief }))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not build a draft just now')
    } finally {
      setBusy(false)
    }
  }

  if (!platform) {
    return (
      <div className="page-head">
        <h1>Create</h1>
        <p className="empty">We have not confirmed any options to create with yet.</p>
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Create</h1>
        <p>
          Pick where you are posting and what you are making. We only show options {platform.name}{' '}
          actually supports, and we check your post against the limits we have verified.
        </p>
      </div>

      {error && <div className="notice stop">{error}</div>}

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <section className="card">
          <div className="field">
            <label htmlFor="platform">Posting to</label>
            <select
              id="platform"
              value={platform.slug}
              onChange={(event) => {
                setPlatformSlug(event.target.value)
                setOptionKey('')
                setDraft(null)
                setValidation(null)
              }}
            >
              {usable.map((entry) => (
                <option key={entry.slug} value={entry.slug}>
                  {entry.name}
                </option>
              ))}
            </select>
            <span className="help">{platformHeadline(platform)}</span>
          </div>

          {groupOptions(platform.options).map((group) => (
            <div key={group.media}>
              <div className="section-title">{group.title}</div>
              <p className="section-hint">{group.hint}</p>
              <div className="option-grid">
                {group.options.map((entry) => {
                  const selected = entry.key === option?.key
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      className={`option ${selected ? 'selected' : ''}`}
                      disabled={!entry.enabled}
                      onClick={() => {
                        setOptionKey(entry.key)
                        setDraft(null)
                        setValidation(null)
                      }}
                    >
                      <span className="name">
                        {entry.label}
                        {entry.enabled ? null : <span className="pill">Not available</span>}
                      </span>
                      <span className="desc">{entry.description}</span>
                      {entry.enabled ? (
                        <span className="meta">
                          {mediaPrompt(entry.media)} · {limitSummary(entry.limits)}
                        </span>
                      ) : (
                        <span className="meta">{entry.unavailableReason}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </section>

        <section className="card">
          {option ? (
            <>
              <h2>{option.label} for {platform.name}</h2>
              <p style={{ marginBottom: 16 }}>{limitSummary(limits)}</p>

              <div className="field">
                <label htmlFor="brief">What is this about?</label>
                <input
                  id="brief"
                  type="text"
                  value={brief}
                  placeholder="e.g. how I batch filmed a week of content"
                  onChange={(event) => setBrief(event.target.value)}
                />
                <span className="help">One line is enough. We use it to shape the draft.</span>
              </div>

              <div className="field">
                <label htmlFor="text">Your post</label>
                <textarea
                  id="text"
                  value={text}
                  placeholder="Write or paste your post…"
                  onChange={(event) => setText(event.target.value)}
                />
                <div className={`counter ${counter.over ? 'over' : ''}`}>
                  <span>{counter.max ? `${counter.used} / ${counter.max} characters` : `${counter.used} characters`}</span>
                  <span>{counter.message ?? 'No character limit confirmed yet'}</span>
                </div>
                {counter.percent !== null && (
                  <div className={`meter ${counter.over ? 'over' : ''}`}>
                    <span style={{ width: `${counter.percent}%` }} />
                  </div>
                )}
              </div>

              {option.media !== 'NONE' && (
                <div className="field">
                  <label htmlFor="media">{mediaPrompt(option.media)} (count)</label>
                  <input
                    id="media"
                    type="text"
                    inputMode="numeric"
                    value={String(mediaCount)}
                    onChange={(event) => setMediaCount(Math.max(0, Number(event.target.value.replace(/\D/g, '')) || 0))}
                  />
                  <span className="help">We check the count against the limits we have verified.</span>
                </div>
              )}

              <div className="row">
                <button className="primary" disabled={busy} onClick={() => void buildDraft()} title={canDraft ? '' : 'Tell us what this is about first'}>
                  {busy ? 'Working…' : 'Build a starting point'}
                </button>
                <button className="ghost" disabled={busy} onClick={() => void runValidation()}>
                  Check my post
                </button>
                <button className="ghost" onClick={() => navigate(`/platforms/${platform.slug}`)}>
                  Platform details
                </button>
              </div>

              {validation && (
                <div style={{ marginTop: 16 }}>
                  <div className={`notice ${validation.valid ? 'good' : 'stop'}`}>
                    <span>{validationHeadline(validation)}</span>
                  </div>
                  {validation.issues.length > 0 && (
                    <ul style={{ marginTop: 10, color: 'var(--text-soft)' }}>
                      {validation.issues.map((issue) => (
                        <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {!platform.publishing && (
                <p className="mono" style={{ marginTop: 14 }}>
                  {platform.publishingNote}
                </p>
              )}
            </>
          ) : (
            <p className="empty">Pick what you are making.</p>
          )}
        </section>
      </div>

      {draft && (
        <section className="card" style={{ marginTop: 18 }}>
          <div className="row">
            <h2 style={{ margin: 0 }}>Your starting point</h2>
            <span className={`pill right ${draft.prepared ? 'good' : 'warn'}`}>
              {draft.prepared ? 'Prepared structure' : 'Generic outline'}
            </span>
          </div>
          <div className="draft-box" style={{ marginTop: 12 }}>
            {draft.hook}

            {draft.body}

            {draft.cta}
          </div>
          <p className="mono" style={{ marginTop: 10 }}>
            {draft.provenance}
          </p>
          {draft.notes.length > 0 && (
            <ul style={{ color: 'var(--text-soft)', marginTop: 8 }}>
              {draft.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {!draft.publishing && <p className="mono">{draft.publishingNote}</p>}
        </section>
      )}

      {option && (
        <div style={{ marginTop: 18 }}>
          <WhyCard platform={platform.slug} optionKey={option.key} />
        </div>
      )}
    </>
  )
}
