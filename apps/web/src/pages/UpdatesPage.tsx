import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { CreatorOverview } from '../lib/api.js'
import { groupUpdates, relativeTime, unreadCount } from '../lib/view-models.js'

export function UpdatesPage(props: { overview: CreatorOverview }): ReactNode {
  const { updates } = props.overview
  const sections = groupUpdates(updates)

  return (
    <>
      <div className="page-head">
        <h1>Your updates</h1>
        <p>
          Only the changes that touch platforms you use. Everything else stays out of your way, and
          every item tells you where it came from.
        </p>
      </div>

      {updates.length === 0 ? (
        <div className="card">
          <h2>Nothing needs your attention</h2>
          <p>
            When a platform you use changes something that affects your work, it will appear here
            with the source and the date.
          </p>
        </div>
      ) : (
        <div className="row" style={{ marginBottom: 16 }}>
          <span className="pill accent">{unreadCount(updates)} unread</span>
          <span className="pill">{updates.length} in total</span>
        </div>
      )}

      <div className="grid cols-2">
        {sections.map((section) => (
          <div className="card" key={section.platform}>
            <h2>{pretty(section.platform)}</h2>
            {section.updates.map((update) => (
              <article className={`update ${update.read ? '' : 'unread'}`} key={update.id}>
                <h3>{update.title}</h3>
                <p>{update.body}</p>
                <div className="meta">
                  <span>{relativeTime(update.when)}</span>
                  <span>from {update.sourceKind}</span>
                  {update.sourceUrl && (
                    <a href={update.sourceUrl} target="_blank" rel="noreferrer noopener">
                      source
                    </a>
                  )}
                  <Link to={update.whyUrl}>Why?</Link>
                </div>
              </article>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

function pretty(slug: string): string {
  if (!slug) return 'Everywhere'
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}
