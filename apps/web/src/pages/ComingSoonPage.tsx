import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { CreatorOverview } from '../lib/api.js'
import { comingSoonSorted, readinessStage } from '../lib/view-models.js'

export function ComingSoonPage(props: { overview: CreatorOverview }): ReactNode {
  const cards = comingSoonSorted(props.overview.comingSoon)

  return (
    <>
      <div className="page-head">
        <h1>Coming soon</h1>
        <p>
          Platforms we are watching. We learn what they support while they are still closed, so
          Creator Mall is ready on day one instead of catching up afterwards.
        </p>
      </div>

      {cards.length === 0 ? (
        <div className="card">
          <h2>Nothing new on the horizon</h2>
          <p>We have not spotted a platform worth preparing for yet. We will tell you when we do.</p>
        </div>
      ) : (
        <div className="grid cols-2">
          {cards.map((card) => (
            <div className="card" key={card.slug}>
              <div className="row">
                <h2 style={{ margin: 0 }}>{card.name}</h2>
                <span className="pill right accent">{card.stage}</span>
              </div>
              <p style={{ marginTop: 8 }}>{card.note}</p>
              <div className="meter-track" style={{ marginTop: 14 }}>
                <div className="bar">
                  <span style={{ width: `${card.readinessPercent}%` }} />
                </div>
                <span className="mono">{card.readinessPercent}%</span>
              </div>
              <p className="mono" style={{ marginTop: 8 }}>
                {readinessStage(card.readinessPercent)}
              </p>
              <div className="row" style={{ marginTop: 12 }}>
                <Link className="pill" to="/platforms">
                  See what we support today
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
