# Phase 2 — the creator product surface

Phase 1 proved the spine: the system notices change, verifies it, understands it and plans
safely. Phase 2 puts that spine behind a real creator-facing product, so the architecture is
judged by what a creator actually gets.

## Delivered

### The creator web app (`apps/web`)

React + Vite, three dependencies, no component library, one stylesheet of design tokens.

| Screen | What it does |
| --- | --- |
| **What's changed** | The creator's feed, grouped by platform, each item naming its source and date |
| **Create** | Capability-driven creation flow: platform → option → brief → draft → validation |
| **Platform support** | Confirmed options, unavailable options with reasons, freshness, connection state |
| **Your updates** | Only the changes that affect the platforms this creator uses |
| **Coming soon** | Platforms being watched, with how ready Creator Mall already is |

The creation flow is the architectural proof:

- options come from `buildPlatformUiConfig`, so a newly verified capability appears without a
  code change;
- limits come from verified platform facts and are shown before the creator writes;
- an unavailable option is shown **disabled with a reason**, never hidden and never offered as
  a dead end;
- validation runs against the same adapter contract the publisher will use;
- "Why is this here?" is always one click away.

### The creator-facing API (`/api/creator/*`)

Plain language only. No capability keys, adapters, snapshots, trust levels or evolution events
cross this boundary — a test fails the build if internal vocabulary appears in the response.

| Route | Purpose |
| --- | --- |
| `GET /api/creator/overview` | everything the home screen needs, in one request |
| `GET /api/creator/coming-soon` | watchlist with readiness |
| `POST /api/creator/validate` | checks a draft against verified limits |
| `POST /api/creator/draft` | a structured starting point from the platform's own templates |
| `GET /api/creator/platforms/:slug/why?option=` | "why did this change?" with sources |

### Supporting work

- **Declared capabilities count as available.** A capability is offered when a verified snapshot
  says `ACTIVE` *or* the platform declares it and nothing has contradicted that. A verified
  deprecation still wins — support is withdrawn only on evidence.
- **Template composer** (`core/src/composer`): deterministic, capability-aware, and it says
  where the draft came from. Not presented as AI; a hosted generator replaces it behind the
  same interface.
- **Creator limit hints** (`core/src/ui/limits.ts`): which verified limits matter for which
  option, rendered as "Maximum length: 90 seconds".
- **Boilerplate filter**: cookie banners, "browser not supported" notices and login prompts are
  never published as platform knowledge. Found by running the engine against live sites.
- **Knowledge quality gate**: a "what creators can do" page is only published when it contains a
  confirmed capability or limit. Empty beats vague.
- **Source yield**: every source reports whether it is producing facts or merely answering, so
  the registry can be curated instead of growing forever.
- **One origin in production**: the API serves the built app with an SPA fallback; in
  development Vite proxies `/api` to the API.
- **`npm run dev`** starts both processes with prefixed output and clean shutdown.

## Verification

```
npm run verify    # eslint (type-checked) + tsc ×3 workspaces + 115 tests
```

| Guarantee | Test |
| --- | --- |
| Creator API never leaks internal vocabulary | `creator-api.test.ts` |
| An unintegrated platform never claims it can publish | `creator-api.test.ts` |
| Unavailable options explain themselves | `creator-api.test.ts` |
| Validation rejects an unconfirmed option | `creator-api.test.ts` |
| Drafts declare their provenance | `creator-api.test.ts` |
| "Why" answers in plain language with sources | `creator-api.test.ts` |
| Option grouping, limit wording, character counting | `view-models.test.ts` |
| Every page renders from real-shaped data | `render.test.tsx` |
| Rendered pages contain no jargon | `render.test.tsx` |
| Empty states render instead of breaking | `render.test.tsx` |
| Boilerplate is never extracted as a fact | `verify-extract.test.ts` |
| Draft composition is deterministic and honest | `composer.test.ts` |

Component behaviour is covered by server-rendering the real component tree
(`renderToString`), which needs no DOM and no second test framework. A live smoke run
(`scripts/smoke.mjs`) additionally checks the built app, deep links, assets and every creator
endpoint against a running server.

## What a live run taught us

Running the World Engine against real platform sites (17 sources):

| Source | Result |
| --- | --- |
| `creators.instagram.com`, `about.instagram.com`, `support.google.com`, `blog.youtube`, `developer.x.com`, … | answered and parsed |
| `facebook.com` | **blocked by robots.txt** — correctly refused |
| `support.tiktok.com`, `developers.tiktok.com`, `newsroom.tiktok.com` | HTTP 503 (bot protection) — marked failed, will retry |
| `help.x.com`, `blog.x.com` | HTTP 403 — marked failed, will retry |

No facts were published from those pages, because platform *homepages* rarely state machine
-readable limits, and the boilerplate filter plus the quality gate correctly refused to turn
navigation text into knowledge. That is the system behaving properly: **empty beats wrong**.

## Deferred to Phase 3

| Area | Why |
| --- | --- |
| Real creator accounts, sessions, RBAC | `CREATOR_ID` selects the acting creator today |
| Hosted generation behind the composer | interface exists, no provider configured |
| Per-platform documentation curation | homepage seeds are honest but low-yield; needs curated doc paths and yield-based ranking |
| Real publishing adapters | gated on verified APIs; contract and honest stub already tested |
| Postgres persistence | `PersistencePort` + serialisable state in place |
| Hosted embeddings and vector search | `Embedding` interface isolated, local provider ships |
| Preference learning with why / forget / reset | needs real creator behaviour data from this app |
| Automated template generation on new formats | proposal action exists; needs generation quality work |
