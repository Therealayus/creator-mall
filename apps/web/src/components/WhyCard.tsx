import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchWhy } from '../lib/api.js'
import type { WhyAnswer } from '../lib/api.js'
import { relativeTime, whyHeadline } from '../lib/view-models.js'

/** §35: "why did this change?" — what changed, when, from where, and what we did. */
export function WhyCard(props: { platform: string; optionKey: string }): ReactNode {
  const [why, setWhy] = useState<WhyAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setWhy(null)
    setError(null)
    fetchWhy(props.platform, props.optionKey)
      .then((answer) => {
        if (active) setWhy(answer)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load the details')
      })
    return () => {
      active = false
    }
  }, [props.platform, props.optionKey])

  if (error) {
    return (
      <div className="card">
        <h2>Why is this here?</h2>
        <p>{error}</p>
      </div>
    )
  }

  if (!why) {
    return (
      <div className="card">
        <p className="empty">Checking whether this option changed recently…</p>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Why is this here?</h2>
        <span className={`pill right ${why.available ? 'good' : 'warn'}`}>{whyHeadline(why)}</span>
      </div>
      <p style={{ marginTop: 10 }}>{why.whatChanged}</p>
      <div className="row" style={{ marginTop: 12 }}>
        {why.when && <span className="pill">Confirmed {relativeTime(why.when)}</span>}
        <span className="pill">From {why.from}</span>
        {why.weUpdated && <span className="pill accent">{why.weUpdated}</span>}
      </div>
      {why.pendingReview.length > 0 && (
        <div className="notice info" style={{ marginTop: 12 }}>
          <span>
            Still being reviewed before we finish: {why.pendingReview.join(' · ')}
          </span>
        </div>
      )}
      {why.sources.length > 0 && (
        <div className="row" style={{ marginTop: 12 }}>
          {why.sources.map((source) => (
            <a
              key={source.name}
              className="pill"
              href={source.url ?? '#'}
              target="_blank"
              rel="noreferrer noopener"
            >
              {source.name}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
