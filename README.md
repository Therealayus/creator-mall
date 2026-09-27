<<<<<<< HEAD
# creator-mall
=======
# Creator Mall

**The mall that never closes.**

Creator Mall is an adaptive intelligence platform for the creator economy. Instead of
hardcoding a list of platforms and their features, it continuously observes the
creator ecosystem, verifies what it finds against trusted sources, understands the
impact on creators, and evolves its own knowledge, capabilities, prompts, templates and
integration plans through a controlled software lifecycle.

> The creator ecosystem changes. Creator Mall changes with it.

---

## What is in this repository

Phases 1 and 2: the intelligence spine, plus the creator product that sits on top of it. Both
are working and tested end to end.

```
packages/
  core/     pure decision logic — no I/O, no framework, fully unit tested
  server/   World Engine workers, Evolution Center API, creator API, platform adapters
apps/
  web/      creator-facing web app (React + Vite) rendered from capability data
```

| Concern | Where it lives |
| --- | --- |
| Capability taxonomy + open registry | `core/src/capabilities` |
| Platform snapshots + structural diff + risk classification | `core/src/diff` |
| HTML reading + fact extraction | `core/src/extract` |
| Source trust + multi-source verification gate | `core/src/verify` |
| Knowledge versioning, TTL, retrieval, offline embeddings | `core/src/knowledge` |
| Feature dependency graph, impact engine, evolution planner, readiness | `core/src/evolution` |
| Config-driven UI model (no `if (platform === ...)`) | `core/src/ui` |
| Prompt versioning | `core/src/prompts` |
| Permitted-source fetcher (allowlist, robots, conditional GET) | `server/src/world-engine/fetcher.ts` |
| Continuous research cycle + change detection | `server/src/world-engine/pipeline.ts` |
| New-platform discovery | `server/src/world-engine/discovery.ts` |
| Scheduler with safe failure behaviour | `server/src/world-engine/scheduler.ts` |
| Platform adapters (including "unknown platform") | `server/src/adapters` |
| Evolution Center API + admin dashboard | `server/src/api` |
| Creator-facing API, in plain language only | `server/src/api/creator.ts` |
| Deterministic, capability-aware draft composer | `core/src/composer` |
| Creator web app (creation flow, updates, platform support) | `apps/web` |

## Quick start

```bash
npm install
npm run verify        # lint + typecheck + 179 tests
npm run dev           # api on :4000, web on :5173
```

Then open:

- `http://127.0.0.1:5173` — the creator app (What's changed, Create, Platform support, Your updates, Coming soon)
- `http://127.0.0.1:4000/evolution-center` — internal operator dashboard
- `http://127.0.0.1:4000/api/creator/overview` — the creator-facing data, in one request
- `http://127.0.0.1:4000/api/platforms` — platform directory
- `http://127.0.0.1:4000/api/platforms/instagram` — capability-driven platform view
- `http://127.0.0.1:4000/api/platforms/instagram/why?capability=SHORT_VIDEO` — "why did this change?"
- `http://127.0.0.1:4000/api/knowledge/search?q=maximum+video+length` — maintained-knowledge answers
- `http://127.0.0.1:4000/api/sources` — source registry, including which sources actually produce facts
- `http://127.0.0.1:4000/api/health` — system health

Production-shaped local run (one origin, built assets):

```bash
npm run build && npm start   # everything on :4000
```

Run one research cycle against real documentation:

```bash
npm run engine:once
```

The World Engine never runs on its own unless you ask it to:

```bash
RESEARCH_ENABLED=true RESEARCH_INTERVAL_MS=900000 npm run dev
```

## The core idea

Nothing in the product branches on a platform name. A platform is described entirely by
**which capabilities it declares**, and capabilities are product concepts
(`SHORT_VIDEO`, `CAROUSEL`, `SCHEDULING`, `API_PUBLISH`).

That single decision is what makes the system future-proof:

- a newly discovered platform is representable before any integration exists;
- a new capability appears in the creation flow without a redesign;
- a withdrawn capability disappears with an explanation, never as a dead button;
- impact on a creator is computed from what *they* actually use.

## Controlled autonomy

The system is not an AI that rewrites itself. It is a product that detects change and
routes it through a software lifecycle.

| Automatic | Controlled (tests + review + deployment) |
| --- | --- |
| Research, verification, change detection | Code changes |
| Knowledge updates (versioned, with TTLs) | Database migrations |
| Platform discovery and watchlisting | Security and authentication changes |
| Impact analysis and personalised alerts | Publishing integrations |
| Feature, template and prompt *proposals* | Production deployments |
| Regression test plans | Production UI architecture |

Every change is classified `LOW → MEDIUM → HIGH → CRITICAL`. Low-risk knowledge refreshes
publish themselves. A critical API or authentication change raises an alert, pauses the
affected workflow and waits for a human. Nothing deploys itself.

## Research is permitted, not invasive

The fetcher is deliberately conservative:

- only hosts on `ALLOWED_HOSTS` are read;
- `robots.txt` is honoured;
- one request per host per `FETCH_MIN_HOST_GAP_MS`;
- hard timeout, hard byte cap, text content types only;
- conditional requests (`ETag` / `If-Modified-Since`), so unchanged pages cost nothing.

When a source stops responding, existing knowledge is **kept and marked stale**. The
platform degrades visibly instead of pretending to know things.

## Knowledge, not model memory

Answers about current platform behaviour come from the maintained knowledge system, with
fact-level source attribution, verification timestamps, confidence, TTLs and full version
history. Superseded knowledge is never overwritten — it is marked and retained.

Embeddings ship as a deterministic local provider so retrieval, freshness and
deactivation paths are fully testable offline, with no API key and no data leaving the
machine. A hosted vector model plugs in behind the same interface.

## Who can see what

Creators have accounts. Passwords are hashed with scrypt (Node standard library, no
dependency), sessions are opaque server-side tokens where only the SHA-256 is stored, and
every mutating request carries a CSRF token.

- creator data is scoped to the signed-in account — one creator can never see another's alerts;
- the platform directory, source registry, evolution log, knowledge and the Evolution Center
  require the **admin** role, by session or by operator token;
- identity is separate from intelligence: what the system learned about a creator is not what
  grants them access;
- five wrong passwords locks an account for fifteen minutes, and a missing account costs the
  same time as a wrong one so it cannot be detected.

## Creator-facing language

Creators see *What's changed*, *Create*, *Platform support*, *Your updates*, *Coming soon*.
Capability registries, adapters, crawlers, embeddings and evolution events stay inside the
Evolution Center. The creator-facing API is a separate surface, and tests fail the build if
internal jargon appears in it or in any rendered creator page.

## Configuration

See `.env.example`. Notable values:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESEARCH_ENABLED` | `false` | run the World Engine loop |
| `RESEARCH_INTERVAL_MS` | `900000` | cadence between cycles |
| `ALLOWED_HOSTS` | *(empty = all)* | comma-separated hosts the engine may read |
| `ADMIN_TOKEN` | *(empty)* | operator token for admin surfaces; required in production |
| `OPENROUTER_API_KEY` | *(empty)* | optional model for fact extraction; unset means deterministic only |
| `OPENROUTER_MODEL` | `openrouter/stealth/space-bunny-alpha` | model id |
| `DATA_DIR` | *(empty = memory)* | directory for the control-plane JSON snapshot |
| `RESPECT_ROBOTS` | `true` | honour robots.txt |

## The model is an assistant, not an authority

With `OPENROUTER_API_KEY` set, a model runs first during fact extraction. It is treated as
an **untrusted contributor**:

- its output is parsed and validated field by field — unknown areas and categories are dropped;
- every fact must quote the page **verbatim** or it is discarded;
- confidences are capped at 0.8, because a model's confidence is not evidence;
- the deterministic extractor **always** runs too, so a model can only add coverage;
- the same verification gate decides what becomes knowledge;
- a provider failure, timeout or outage falls back silently and the cycle continues.

Keys live in `.env` (gitignored) or your deployment secret store. A test scans the repository
and fails if a key-shaped string is ever committed, and provider errors never echo the key.

```
npm run model:check      # one-off: does the configured provider answer?
```

## Status

| Area | State |
| --- | --- |
| World Engine: fetch → verify → detect → understand → plan | implemented, tested |
| Knowledge: versioning, TTL, retrieval, evidence, quality gate | implemented, tested |
| Evolution Center: events, proposals, approvals, health, source yield | implemented, tested |
| Creator impact + notifications | implemented, tested |
| Config-driven UI model + platform readiness | implemented, tested |
| Prompt versioning | implemented, tested |
| **Creator web app: creation flow, updates, platform support, coming soon** | **implemented, tested** |
| **Accounts, sessions, roles, tenant isolation** | **implemented, tested** |
| **Optional model provider for fact extraction** | **implemented, tested** |
| Draft composer (deterministic, capability-aware) | implemented, tested |
| Per-platform documentation curation + yield ranking | Phase 4 |
| Email verification, password reset, per-IP rate limiting | Phase 4 |
| Postgres persistence, real publishing adapters | Phase 4 |

See `docs/PHASE-1.md` and `docs/PHASE-2.md` for scope, and `ARCHITECTURE.md` for the design.

## License

Private. All rights reserved.
>>>>>>> 33bb30a (Phase 1: Creator Mall intelligence spine)
