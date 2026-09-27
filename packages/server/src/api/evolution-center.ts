import type { AppContext } from '../context.js'
import { evolutionSummary, platformView } from './views.js'
import { escapeHtml } from '../util/html.js'

/**
 * §26: the Evolution Center.
 *
 * Internal-only surface, so technical vocabulary is expected here (§43 exempts
 * admin tooling). It is server-rendered on purpose: Phase 1 ships one HTML
 * document and zero frontend dependencies.
 */
export function renderEvolutionCenter(context: AppContext): string {
  const summary = evolutionSummary(context)
  const proposals = context.control.listProposals().slice(0, 25)
  const events = context.control.listEvents().slice(0, 25)
  const platforms = context.control.listPlatforms()
  const runs = context.control.listJobRuns(5)
  const health = context.control

  const cards = [
    { label: '🟢 Knowledge updates', value: summary.knowledgeUpdates, hint: 'auto-published, versioned' },
    { label: '🟡 Feature proposals', value: summary.featureProposals, hint: 'awaiting review' },
    { label: '🟠 API changes', value: summary.apiChanges, hint: 'require action' },
    { label: '🔴 Integration failures', value: summary.failures, hint: 'last 20 research runs' },
    { label: '🚀 Emerging platforms', value: summary.emergingPlatforms.length, hint: 'watching' },
    { label: '⏳ Pending approvals', value: summary.pendingApprovals, hint: `${summary.criticalPending} critical` },
  ]

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Creator Mall · Evolution Center</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#141824; --line:#222a3a; --text:#e8ecf5; --muted:#8b96ad; --accent:#6ea8fe; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  header { padding:28px 32px 8px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 4px; font-size:22px; letter-spacing:-0.01em; }
  h2 { font-size:15px; margin:0 0 12px; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; }
  p.sub { margin:0 0 20px; color:var(--muted); }
  main { padding:24px 32px 64px; display:grid; gap:28px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .label { color:var(--muted); font-size:12px; }
  .card .value { font-size:26px; font-weight:600; margin-top:4px; }
  .card .hint { color:var(--muted); font-size:11px; margin-top:2px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--muted); font-weight:600; padding:6px 10px 6px 0; border-bottom:1px solid var(--line); }
  td { padding:8px 10px 8px 0; border-bottom:1px solid #1b2130; vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid var(--line); color:var(--muted); }
  .LOW { color:#6ee7a8; } .MEDIUM { color:#f5d06b; } .HIGH { color:#f5a25b; } .CRITICAL { color:#ff7b7b; }
  .empty { color:var(--muted); font-style:italic; }
  a { color:var(--accent); text-decoration:none; }
  code { background:#0f1420; padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>🧬 Evolution Center</h1>
  <p class="sub">World Engine status · change log · controlled proposals · control plane started ${escapeHtml(context.startedAt)}</p>
</header>
<main>
  <div class="cards">
    ${cards.map((card) => `<div class="card"><div class="label">${card.label}</div><div class="value">${card.value}</div><div class="hint">${card.hint}</div></div>`).join('\n    ')}
  </div>

  <section>
    <h2>Platform watchlist</h2>
    <table>
      <thead><tr><th>Platform</th><th>Status</th><th>Readiness</th><th>Integration</th><th>Options enabled</th></tr></thead>
      <tbody>
      ${platforms
        .map((platform) => {
          const view = platformView(context, platform)
          return `<tr>
            <td><a href="/api/platforms/${escapeHtml(platform.slug)}">${escapeHtml(platform.name)}</a><br /><code>${escapeHtml(platform.slug)}</code></td>
            <td>${escapeHtml(platform.status)}</td>
            <td>${view.readiness.overallPercent}% · ${escapeHtml(view.uiConfig.publishingEnabled ? 'publishing' : 'no publishing')}</td>
            <td>${escapeHtml(platform.integrationState)}</td>
            <td>${view.uiConfig.enabledCapabilityKeys.length}</td>
          </tr>`
        })
        .join('\n      ')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Change proposals (${proposals.length})</h2>
    ${
      proposals.length === 0
        ? '<p class="empty">No proposals yet. Run a research cycle to detect change.</p>'
        : `<table>
      <thead><tr><th>Proposal</th><th>Kind</th><th>Risk</th><th>Autonomy</th><th>Status</th></tr></thead>
      <tbody>
      ${proposals
        .map(
          (proposal) => `<tr>
          <td>${escapeHtml(proposal.title)}<br /><span class="pill">${proposal.actions.length} actions · ${proposal.testPlan.length} tests</span></td>
          <td>${escapeHtml(proposal.kind)}</td>
          <td class="${proposal.riskLevel}">${escapeHtml(proposal.riskLevel)}</td>
          <td>${escapeHtml(proposal.autonomyTier)}</td>
          <td>${escapeHtml(proposal.status)}</td>
        </tr>`,
        )
        .join('\n      ')}
      </tbody></table>`
    }
  </section>

  <section>
    <h2>Platform changes (${events.length})</h2>
    ${
      events.length === 0
        ? '<p class="empty">No changes recorded yet.</p>'
        : `<table>
      <thead><tr><th>Detected</th><th>Change</th><th>Risk</th><th>Source</th></tr></thead>
      <tbody>
      ${events
        .map(
          (event) => `<tr>
          <td>${escapeHtml(event.detectedAt)}</td>
          <td>${escapeHtml(event.title)}<br /><span class="pill">${escapeHtml(event.category)}</span></td>
          <td class="${event.riskLevel}">${escapeHtml(event.riskLevel)}</td>
          <td>${escapeHtml(event.trustLevel)} · ${event.sourceIds.length} source(s)</td>
        </tr>`,
        )
        .join('\n      ')}
      </tbody></table>`
    }
  </section>

  <section>
    <h2>Research runs</h2>
    ${
      runs.length === 0
        ? '<p class="empty">No research run yet.</p>'
        : `<table>
      <thead><tr><th>Finished</th><th>Status</th><th>Sources</th><th>Snapshots</th><th>Events</th><th>Proposals</th></tr></thead>
      <tbody>
      ${runs
        .map(
          (run) => `<tr>
          <td>${escapeHtml(run.finishedAt)}</td>
          <td>${escapeHtml(run.status)}</td>
          <td>${run.sourcesChecked} checked / ${run.sourcesFailed} failed</td>
          <td>${run.snapshotsCreated}</td>
          <td>${run.eventsCreated}</td>
          <td>${run.proposalsCreated}</td>
        </tr>`,
        )
        .join('\n      ')}
      </tbody></table>`
    }
  </section>

  <section>
    <h2>Source registry (${context.control.listSources().length})</h2>
    <p class="sub">A source that keeps answering but never produces a verified fact is shown as quiet, so the registry can be curated instead of growing forever.</p>
    <table>
      <thead><tr><th>Source</th><th>Platform</th><th>Type</th><th>Status</th><th>Yield</th></tr></thead>
      <tbody>
      ${context.control
        .listSources()
        .slice(0, 40)
        .map((source) => {
          const signals =
            context.control.listEvents().filter((event) => event.sourceIds.includes(source.id)).length +
            [...context.control.knowledge.versions.values()].filter((version) => version.sourceIds.includes(source.id))
              .length
          const yieldWord = signals > 0 ? 'producing' : source.lastStatus === 'NEVER_CHECKED' ? 'not checked' : 'quiet'
          return `<tr>
            <td>${escapeHtml(source.name)}<br /><code>${escapeHtml(source.domain)}</code></td>
            <td>${escapeHtml(source.platform ?? '—')}</td>
            <td>${escapeHtml(source.sourceType)}</td>
            <td>${escapeHtml(source.lastStatus)}${source.lastError ? ` <span class="pill">${escapeHtml(source.lastError.slice(0, 40))}</span>` : ''}</td>
            <td>${yieldWord} (${signals})</td>
          </tr>`
        })
        .join('\n      ')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Control plane</h2>
    <p class="sub">
      platforms: ${health.listPlatforms().length} · sources: ${health.listSources().length} ·
      snapshots: ${platforms.reduce((total, platform) => total + health.snapshotsFor(platform.id).length, 0)} ·
      knowledge versions: ${health.currentKnowledgeVersions().length} current ·
      prompts: ${health.prompts.all().length} · templates: ${health.listTemplates().length}
    </p>
  </section>
</main>
</body>
</html>`
}
