import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { CreatorOverview } from '../lib/api.js'
import { groupUpdates, platformHeadline, relativeTime, unreadCount } from '../lib/view-models.js'

export function HomePage(props: { overview: CreatorOverview; platformsOnly?: boolean }): ReactNode {
  const { overview, platformsOnly } = props
  const sections = groupUpdates(overview.updates)

  return (
    <>
      <div className="page-head">
        <h1>{platformsOnly ? 'Platform support' : "What's changed"}</h1>
        <p>
          {platformsOnly
            ? 'Every option we have confirmed for each platform, and what is still on the way.'
            : 'Platforms change quietly. We watch the official sources, verify what changed, and tell you only what affects you.'}
        </p>
      </div>

      {!platformsOnly && (
        <div className="stat-row">
          <div className="stat">
            <div className="value">{overview.counts.optionsReady}</div>
            <div className="label">Options ready</div>
          </div>
          <div className="stat">
            <div className="value">{unreadCount(overview.updates)}</div>
            <div className="label">Updates to read</div>
          </div>
          <div className="stat">
            <div className="value">{overview.counts.platformsWatched}</div>
            <div className="label">Platforms watched</div>
          </div>
        </div>
      )}

      {overview.notice && <div className="notice">{overview.notice}</div>}

      {platformsOnly ? (
        <div className="grid cols-2" style={{ marginTop: 20 }}>
          {overview.platforms.map((platform) => (
            <Link key={platform.slug} to={`/platforms/${platform.slug}`} className="card">
              <div className="row">
                <h2 style={{ margin: 0 }}>{platform.name}</h2>
                <span className={`pill right ${platform.publishing ? 'good' : 'warn'}`}>
                  {platform.publishing ? 'Connected' : 'Preparing connection'}
                </span>
              </div>
              <p style={{ marginTop: 6 }}>{platformHeadline(platform)}</p>
              <p className="mono" style={{ marginTop: 10 }}>
                {platform.options.filter((option) => option.enabled).length} of {platform.options.length} options confirmed
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <>
          <section style={{ marginTop: 22 }}>
            {sections.length === 0 ? (
              <div className="card">
                <h2>Nothing new for you right now</h2>
                <p>
                  We only interrupt you when a change touches the platforms you use. That is
                  currently the case for nothing.
                </p>
              </div>
            ) : (
              <div className="grid cols-2">
                {sections.map((section) => (
                  <div className="card" key={section.platform}>
                    <h2>{prettyPlatform(section.platform)}</h2>
                    {section.updates.map((update) => (
                      <article className={`update ${update.read ? '' : 'unread'}`} key={update.id}>
                        <h3>{update.title}</h3>
                        <p>{update.body}</p>
                        {update.suggested.length > 0 && (
                          <ul>
                            {update.suggested.map((action) => (
                              <li key={action}>{action}</li>
                            ))}
                          </ul>
                        )}
                        <div className="meta">
                          <span>{relativeTime(update.when)}</span>
                          <span>from {update.sourceKind}</span>
                          {update.sourceUrl && (
                            <a href={update.sourceUrl} target="_blank" rel="noreferrer noopener">
                              source
                            </a>
                          )}
                          <Link to={update.whyUrl}>See details</Link>
                        </div>
                      </article>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section style={{ marginTop: 26 }}>
            <div className="section-title">Where you can post</div>
            <div className="grid cols-3">
              {overview.platforms
                .filter((platform) => platform.options.some((option) => option.enabled))
                .slice(0, 6)
                .map((platform) => (
                  <Link key={platform.slug} to={`/create/${platform.slug}`} className="card tight">
                    <h3>{platform.name}</h3>
                    <p>{platformHeadline(platform)}</p>
                  </Link>
                ))}
            </div>
          </section>
        </>
      )}
    </>
  )
}

function prettyPlatform(slug: string): string {
  if (!slug) return 'Everywhere'
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}
