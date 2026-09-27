import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { assetUrl, fetchDraft, generateAsset, recordObservation, validateContent } from '../lib/api.js'
import type { CreatorOption, CreatorOverview, DraftResult, GenerationResult, ValidationResult } from '../lib/api.js'
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
  const [made, setMade] = useState<GenerationResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const limits = option?.limits ?? []
  const counter = characterCounter(text, limits)
  const canDraft = Boolean(platform && option?.enabled && brief.trim().length > 0)

  async function runValidation(): Promise<void> {
    if (!platform || !option) return
    setBusy(true)
    try {
      const result = await validateContent({
        platform: platform.slug,
        option: option.key,
        text,
        mediaCount,
      })
      setValidation(result)
      setError(null)
      void recordObservation({
        kind: 'OPTION_CHOSEN',
        subject: option.key,
        platformSlug: platform.slug,
        detail: `length:${text.length}`,
      }).catch(() => undefined)
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
      const result = await fetchDraft({ platform: platform.slug, option: option.key, brief })
      setDraft(result)
      setError(null)
      // The draft body is what the creator keeps or rewrites, so it is the
      // honest signal for "what usually works for them".
      void recordObservation({
        kind: 'DRAFT_ACCEPTED',
        subject: option.key,
        platformSlug: platform.slug,
        detail: `length:${brief.length};hook:${brief.length > 0 ? 'result-first' : 'none'}`,
      }).catch(() => undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not build a draft just now')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // Remember the platform a creator reaches for, so the app can suggest it.
    if (platformSlug) {
      void recordObservation({ kind: 'PLATFORM_ADDED', subject: platformSlug, platformSlug }).catch(() => undefined)
    }
  }, [platformSlug])

  /**
   * Produces the real artifact rather than a draft: a poster, a shot list or a
   * narration script, saved to the creator's library. Refused options never
   * reach this, because the option list only offers confirmed ones.
   */
  async function makeIt(): Promise<void> {
    if (!platform || !option) return
    setBusy(true)
    try {
      const result = await generateAsset({ platform: platform.slug, option: option.key, brief })
      setMade(result)
      setDraft(null)
      setError(null)
      void recordObservation({
        kind: 'DRAFT_ACCEPTED',
        subject: option.key,
        platformSlug: platform.slug,
        detail: `made:${result.asset.kind};length:${brief.length}`,
      }).catch(() => undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not make that just now')
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
                <button
                  className="primary"
                  disabled={busy || !canDraft}
                  onClick={() => void makeIt()}
                  title={canDraft ? '' : 'Tell us what this is about first'}
                >
                  {busy ? 'Working…' : 'Make it for me'}
                </button>
                <button className="ghost" disabled={busy} onClick={() => void runValidation()}>
                  Check my post
                </button>
                <button className="ghost" onClick={() => navigate(`/platforms/${platform.slug}`)}>
                  Platform details
                </button>
              </div>

              {made && (
                <div style={{ marginTop: 18 }}>
                  <div className="section-title">Saved to your library</div>
                  <p className="section-hint">
                    {made.asset.madeWithAI
                      ? 'The words were written by a model. The artwork was made here.'
                      : 'Made here on this machine, not by a model.'}
                  </p>

                  {made.meta.poster && (
                    <img
                      src={assetUrl(made.asset.id)}
                      alt={made.meta.poster.alt}
                      style={{ maxWidth: '100%', borderRadius: 8, display: 'block', margin: '12px 0' }}
                    />
                  )}

                  {made.meta.copy && (
                    <div className="card" style={{ marginTop: 12 }}>
                      <p style={{ marginTop: 0 }}>{made.meta.copy.hook}</p>
                      <p>{made.meta.copy.body}</p>
                      <p>{made.meta.copy.cta}</p>
                      {made.meta.copy.hashtags.length > 0 && <p className="help">{made.meta.copy.hashtags.join(' ')}</p>}
                    </div>
                  )}

                  {made.meta.storyboard && (
                    <ol className="shot-list">
                      {made.meta.storyboard.shots.map((shot) => (
                        <li key={shot.order}>
                          <strong>{shot.shot}</strong> ({shot.durationSeconds}s) — {shot.onScreen}
                          <br />
                          <span className="help">{shot.voiceover}</span>
                        </li>
                      ))}
                    </ol>
                  )}

                  {made.meta.audio && (
                    <ol className="shot-list">
                      {made.meta.audio.segments.map((segment) => (
                        <li key={segment.at}>
                          <span className="help">{segment.at}s</span> {segment.text}
                        </li>
                      ))}
                    </ol>
                  )}

                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="ghost" onClick={() => navigate('/library')}>
                      Open your library
                    </button>
                  </div>
                </div>
              )}

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
