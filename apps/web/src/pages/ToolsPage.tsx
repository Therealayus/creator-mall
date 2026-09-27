import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchTools } from '../lib/api.js'
import type { CreatorToolCard, CreatorToolsResponse } from '../lib/api.js'
import { toolGroupHeading, toolKindWords } from '../lib/view-models.js'

/**
 * The Market Engine, as a creator sees it.
 *
 * Every card carries the source it came from and says how sure we are. There is
 * no ranking, no "recommended" badge and nothing we cannot point at a source
 * for, because a catalogue we cannot prove is worse than no catalogue.
 */
export function ToolsPage(): ReactNode {
  const [data, setData] = useState<CreatorToolsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetchTools()
      .then((result) => {
        if (live) setData(result)
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : 'Could not load tools just now')
      })
    return () => {
      live = false
    }
  }, [])

  const grouped = useMemo(() => groupByPlatform(data?.tools ?? []), [data])

  if (error) {
    return (
      <div className="page-head">
        <h1>Tools</h1>
        <div className="notice stop">{error}</div>
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Tools</h1>
        <p>
          What you can use on each platform, and why we believe it. We only list something once an
          official page or a source we have verified says so.
        </p>
      </div>

      {data && <div className="notice good">{data.notice}</div>}

      {!data ? (
        <p className="empty">Checking what each platform offers…</p>
      ) : data.tools.length === 0 ? (
        <p className="empty">{data.notice}</p>
      ) : (
        <>
          <p className="section-hint">
            {data.counts.confirmed} confirmed by the platform itself, {data.counts.likely} likely
            from a source we trust, across {data.counts.platforms}{' '}
            {data.counts.platforms === 1 ? 'platform' : 'platforms'}.
          </p>

          {grouped.map((group) => (
            <div key={group.platform}>
              <div className="section-title">{group.title}</div>
              <div className="grid cols-2">
                {group.tools.map((tool) => (
                  <ToolCard key={tool.id} tool={tool} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  )
}

function ToolCard(props: { tool: CreatorToolCard }): ReactNode {
  const { tool } = props
  return (
    <section className="card">
      <div className="section-title">{tool.name}</div>
      <p className="section-hint">{toolKindWords(tool.kind)}</p>
      <p>{tool.whatItDoes}</p>

      <p className="help">
        {tool.appliesTo} · {tool.howSure}
      </p>

      {tool.url && (
        <p>
          <a href={tool.url} target="_blank" rel="noreferrer">
            Read the source
          </a>
        </p>
      )}

      <details>
        <summary className="help">Why we believe this</summary>
        <ul style={{ color: 'var(--text-soft)' }}>
          {tool.because.map((reason) => (
            <li key={`${tool.id}-${reason.source}`}>
              {reason.source} — {reason.kind}
              {reason.checkedAt ? `, checked ${reason.checkedAt.slice(0, 10)}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}

function groupByPlatform(tools: CreatorToolCard[]): Array<{ platform: string; title: string; tools: CreatorToolCard[] }> {
  const groups = new Map<string, CreatorToolCard[]>()
  for (const tool of tools) {
    const existing = groups.get(tool.platform) ?? []
    existing.push(tool)
    groups.set(tool.platform, existing)
  }
  return [...groups.entries()]
    .map(([platform, grouped]) => ({ platform, title: toolGroupHeading(grouped), tools: grouped }))
    .sort((a, b) => a.title.localeCompare(b.title))
}
