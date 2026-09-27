import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { CreatorOverview } from '../lib/api.js'
import { freshnessWords, platformHeadline, relativeTime, statusWords } from '../lib/view-models.js'
import { WhyCard } from '../components/WhyCard.js'

export function PlatformPage(props: { overview: CreatorOverview }): ReactNode {
  const params = useParams()
  const platform = props.overview.platforms.find((entry) => entry.slug === params.platform)

  if (!platform) {
    return (
      <div className="page-head">
        <h1>Platform not found</h1>
        <p className="empty">We do not know that platform yet.</p>
        <p style={{ marginTop: 12 }}>
          <Link to="/platforms">Back to platform support</Link>
        </p>
      </div>
    )
  }

  const confirmed = platform.options.filter((option) => option.enabled)
  const unconfirmed = platform.options.filter((option) => !option.enabled)

  return (
    <>
      <div className="page-head">
        <div className="row">
          <h1 style={{ margin: 0 }}>{platform.name}</h1>
          <span className="pill">{statusWords(platform.status)}</span>
          <span className="pill">{freshnessWords(platform.knowledgeFreshness)}</span>
        </div>
        <p style={{ marginTop: 8 }}>{platformHeadline(platform)}</p>
        <p className="mono" style={{ marginTop: 6 }}>
          {platform.lastCheckedAt ? `Last checked ${relativeTime(platform.lastCheckedAt)}` : 'Not checked yet'}
        </p>
      </div>

      <div className={`notice ${platform.publishing ? 'good' : 'info'}`}>
        <span>{platform.publishingNote}</span>
      </div>

      <div className="grid cols-2" style={{ marginTop: 20 }}>
        <section className="card">
          <h2>You can make</h2>
          <p>Confirmed against {platform.name}&rsquo;s own sources.</p>
          <div className="option-grid" style={{ marginTop: 14 }}>
            {confirmed.map((option) => (
              <Link key={option.key} to={`/create/${platform.slug}`} className="option">
                <span className="name">{option.label}</span>
                <span className="desc">{option.description}</span>
                <span className="meta">
                  {option.limits.length > 0
                    ? option.limits.map((limit) => `${limit.label}: ${limit.display}`).join(' · ')
                    : 'Limits not confirmed yet'}
                </span>
              </Link>
            ))}
            {confirmed.length === 0 && <p className="empty">Nothing confirmed yet.</p>}
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <Link className="pill accent" to={`/create/${platform.slug}`}>
              Create for {platform.name}
            </Link>
          </div>
        </section>

        <section className="card">
          <h2>Not available</h2>
          <p>Shown so you know the gap exists, and why.</p>
          <div className="stack" style={{ marginTop: 14 }}>
            {unconfirmed.map((option) => (
              <div key={option.key} className="card tight flat">
                <div className="row">
                  <strong>{option.label}</strong>
                  <span className="pill right">Unavailable</span>
                </div>
                <p style={{ marginTop: 4 }}>{option.unavailableReason}</p>
              </div>
            ))}
            {unconfirmed.length === 0 && <p className="empty">Everything we know about is available.</p>}
          </div>
        </section>
      </div>

      <div style={{ marginTop: 18 }}>
        <WhyCard platform={platform.slug} optionKey={confirmed[0]?.key ?? unconfirmed[0]?.key ?? ''} />
      </div>
    </>
  )
}
