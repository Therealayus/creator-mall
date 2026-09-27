# Findings register

Every finding from all seven audit passes, deduplicated, ordered by severity.
`[F]` = fixed in `9397257` with a regression test. `[O]` = open.

Corroboration count in brackets: how many independent passes found it. A `[4]`
on an authz bug means four auditors hit it separately, which is why it was
reproduced by hand before anything was written.

## P0 — data breach, auth bypass, or data destruction

| ID | Area | Location | Finding | Corrob. | State |
| --- | --- | --- | --- | ---: | --- |
| S-01 | Authz | `api/app.ts:297` vs `:306` | `/api/creator/:creatorId/updates` registered **above** `requireAuth`; anyone reads any creator's notifications, impacts and display name with no session. A test asserted 200. | 4 | **[F]** |
| S-02 | Authz | `api/app.ts:596` | `/api/creator/:creatorId/impact` reads the creator from the URL with no ownership check (IDOR). | 2 | **[F]** |
| S-03 | Security | `api/auth.ts:418` | Recovery links built from `Host` + `X-Forwarded-Proto`; a forged header redirects a reset token to an attacker. | 2 | **[F]** `PUBLIC_BASE_URL` |
| S-04 | Security | `api/app.ts:461,504` | Upload trusts client `Content-Type` and is served `inline` with CSP disabled → stored XSS on the API origin. | 2 | [O] |
| S-05 | SSRF | `fetcher.ts:104` | `redirect: 'follow'` never re-checks the allowlist; an allowed host can 302 to `169.254.169.254`. | 3 | **[F]** |
| S-06 | SSRF | `fetcher.ts:38` | Empty `ALLOWED_HOSTS` (the default) allows every host; no private-IP or DNS check anywhere. | 3 | **[F]** |
| D-01 | Data | `postgres-persistence.ts:281` | `TABLES` omitted `cm_media_asset` + `cm_profile_account_link`, both with PKs → second save dies on duplicate keys and rolls back **all** state. Introduced by me in `9980c5d`. | 1 | **[F]** |
| D-02 | Data | `postgres-persistence.ts:247` | `INSERT INTO cm_preference_counter (id, creator_id, key, value, weight)` — the table has no `key` column, so every Postgres save aborts. | 1 | **[F]** |
| D-03 | Data | `sql-migrate.ts:20` | `migrate()` never inserts the `cm_meta` singleton, so `checkSchema` never passes and `PERSISTENCE=postgres` can never boot. | 1 | **[F]** |
| D-04 | Data | `context.ts:59` | `load().catch(() => null)` swallows a broken projection: the app boots empty, re-seeds, then `save()` deletes all real rows. | 1 | [O] |
| D-05 | Data | `auth.ts:196-217` | register/login/logout/verify never call `persist()`. Accounts, sessions and the account→profile link survive only if an unrelated write ran. | 3 | **[F]** |
| D-06 | Data | `scheduler.ts:21` | The research loop has no persistence hook; all autonomous World Engine output is lost on exit. | 3 | **[F]** `onCycleComplete` |
| D-07 | Data | `index.ts:40` | Shutdown closes the server without flushing state. | 2 | **[F]** |
| A-01 | AI | `extract/model.ts:84` | Fetched page text is concatenated into the model prompt unfenced, HTML comments included. The evidence gate checks only the first 60 characters, so injected text can quote itself as evidence and be accepted. | 1 | [O] |
| U-01 | Frontend | `lib/api.ts:266` | Storyboard shot fields do not match the server (`order/durationSeconds/shot/onScreen` vs `index/seconds/visual/onScreenText`). The shot list always rendered blank. | 1 | **[F]** |
| U-02 | Frontend | `App.tsx:39` | Any `ApiError` — including 500 and CSRF 403 — signs the creator out. The `error` phase with "Try again" was unreachable for every HTTP error. | 1 | **[F]** |

## P1 — serious defects

| ID | Area | Location | Finding | State |
| --- | --- | --- | --- | --- |
| S-07 | Security | `api/app.ts:40` | `cors()` with no options → `Access-Control-Allow-Origin: *` on every route including admin. | [O] |
| S-08 | Security | `api/app.ts:751` | `adminGuard` passes with **no auth** when `ADMIN_TOKEN` is empty and `NODE_ENV !== 'production'` (the default). All 17 operator routes are open. | [O] |
| S-09 | Security | `api/app.ts:725` | `adminGuard` performs no CSRF check, so admin POSTs rest on SameSite=Lax alone. | [O] |
| S-10 | Security | `api/app.ts:733` | Admin bearer token compared with `!==` — a timing oracle. | [O] |
| S-11 | Security | `api/app.ts:632` | The 500 handler echoed `error.message` and never logged it. | **[F]** |
| S-12 | Security | `api/auth.ts:257` | Lockout counter never decays and is re-locked forever: anyone can keep a known email locked out permanently. | [O] |
| S-13 | Security | `api/auth.ts:280` | `consecutiveFailures` is a non-atomic read-modify-write; N parallel failures undercount by N. | [O] |
| S-14 | Security | `api/app.ts:374,487,602` | No rate limit on `generate` (model call), upload (25MB) or admin research run. | [O] |
| S-15 | Security | `api/auth.ts:132` | `/password-reset/confirm` and `/verify-email` are explicitly excluded from the limiter and have no limiter of their own. | [O] |
| A-02 | AI | `evolution/regression.ts:99` | The prompt under test is placed in the **system** role, and it contains `JSON.stringify(delta.after)` — a model-extracted value. Second-order injection. | [O] |
| A-03 | AI | `state-builder.ts:35` | A model fact at `capabilities.X` with no explicit `state` defaults to `ACTIVE`; the path segment is never checked against the capability registry. Enables an option the platform never confirmed. | [O] |
| A-04 | AI | `extract/model.ts:178` | No range check on extracted values: negative, `1e15` or arbitrary nested objects become "verified" limits feeding validation and the creator UI. | [O] |
| A-05 | AI | `verify/verifier.ts:70` | The model confidence cap is dead in the real pipeline; one OFFICIAL page → 0.85 → `ACCEPTED`, and `clampConfidence(0.8)` gates nothing. | [O] |
| A-06 | AI | `generation/model-copy.ts:13` | Activated prompt versions are **never used in generation**. The Evolution Center's "activated" state affects no model call, so prompt evolution has zero effect on output. | [O] |
| A-07 | AI | `evolution/regression.ts:125` | The runner never asserts `expectation` — only length and substrings. "Always answer in French" would pass. | [O] |
| A-08 | AI | `evolution/regression.ts:252` | `forbiddenTerm` only matches "never invent X", but production requirements are "Never mention {path}", so `mustNotInclude` is never populated. Every real case degrades to a length check. | [O] |
| A-09 | AI | `ai/openrouter.ts:84` | The timeout only wraps the headers; `await response.json()` is unbounded, so a provider that sends headers then stalls hangs the caller forever. | [O] |
| W-01 | World | `state-builder.ts:18` | `applyClaims` applies `WATCH` claims, not just `ACCEPTED`. Two news sources can set a capability `ACTIVE` and enable a creator option. | [O] |
| W-02 | World | `verify/verifier.ts:111` | `deprecationsRequireOfficialEvidence` is dead code (zero callers): a non-official claim can switch a **working** option off before any review. | [O] |
| W-03 | World | `verify/trust.ts:121` | One first-party source reaches `ACCEPTED` at 0.85. The doc comment promises a "haircut until a second observation confirms it"; 0.85 clears the bar anyway. | [O] |
| W-04 | World | `knowledge/store.ts:62` | `factId = stableId('fact', slug)` is constant, so facts are silently overwritten — contradicting "facts are never overwritten". | [O] |
| W-05 | World | `fetcher.ts:101` | The body read has no timeout: the AbortController is cleared as soon as headers arrive. | [O] |
| W-06 | World | `ui/capability-config.ts:172` | TTL is enforced on the knowledge path but not the creator path: options read `latestSnapshot.state`, which has no expiry. | [O] |
| W-07 | World | `fetcher.ts:185` | The robots.txt probe has no timeout, no byte cap, and fails **open** on network error. | [O] |
| W-08 | World | `adapters/http-adapter.ts:189` | No idempotency key is sent, and a timeout **after** the platform accepted the post returns `failed` — any retry double-publishes. | [O] |
| D-08 | Data | `file-persistence.ts:32` | Fixed temp filename for all writers, no lock, no fsync; concurrent persists interleave and leave stray `.tmp` files. | [O] |
| D-09 | Data | `postgres-persistence.ts:88` | `save()` is DELETE-all + one INSERT per row in one transaction: 2 round-trips per row, 40k round-trips at 20k events. | [O] |
| D-10 | Data | `control-plane.ts:98` | `addSnapshot` re-sorts the whole per-platform array on every insert; `hydrate` calls it per row → O(n² log n) load. | [O] |
| D-11 | Data | `control-plane.ts:265` | snapshots, events, proposals, notifications, versions and sessions all grow forever. Only `jobRuns` and observations are capped. | [O] |
| D-12 | Data | `control-plane.ts:131` | `getEvent` calls `listEvents()`, which flattens and sorts the whole log — and it is called per notification. | [O] |
| D-13 | Data | `api/auth.ts:53` | `findSessionByToken` copies and linearly scans all sessions on every request; `pruneSessions` has zero callers. Measured 1.86ms p50 at 51k sessions. | [O] |
| D-14 | Data | `account-recovery.ts:125` | Reset/verify tokens live only inside `doc` jsonb with no column or index; confirm does one sha256 per account, unthrottled. | [O] |
| A-10 | API | `api/app.ts:470` | `DELETE /api/creator/assets/:id` has no try/catch, no `next`, no `.catch` — a rejection after the response is an unhandled rejection, which terminates Node. | [O] |
| A-11 | API | `api/app.ts:156,161,181,101,277` | No limit, offset or cursor on any collection endpoint. `listEvents()` returns the entire log in one response body. | [O] |
| A-12 | API | `api/app.ts:172,177` | The `actor` of an admin decision is read from the request body and written to `decidedBy`, so the audit trail is caller-spoofable. | [O] |
| A-13 | API | `api/app.ts:271` | Knowledge search `q` has no maximum length before reaching the embedding provider. | [O] |
| A-14 | API | `api/app.ts:408,509` | No idempotency on the two asset-creating POSTs; `deterministicKey` exists but is dead code. | [O] |
| A-15 | API | `views.ts:228` | Re-deciding an already-decided proposal returns 200 as a silent no-op. | [O] |
| P-01 | Perf | `index.ts:14` | No `requestTimeout`/`headersTimeout`; a model call or research cycle holds a socket open indefinitely. | [O] |
| P-02 | Perf | `api/app.ts:424,477,524,615` | Every mutating route awaits a full-state `JSON.stringify` synchronously on the event loop. Measured 82.5ms p50 / 125.6ms p95 at 13.2MiB. | [O] |
| P-03 | Perf | `app.ts:653` | The 859KB source map is served publicly. Measured: `GET /assets/*.js.map` → 200. | [O] |
| P-04 | Perf | `app.ts:653` | No `compression()`; a 16KB overview goes out uncompressed. | [O] |
| P-05 | Perf | `vite.config.ts` | No code splitting: 12 routes in one 211KB / 66KB-gzip chunk. | [O] |
| U-03 | Frontend | `main.tsx` | No React error boundary: any render throw is a blank page with no way back. | **[F]** |
| U-04 | Frontend | `lib/api.ts`, `lib/auth.ts` | No `AbortController` and no timeout on any of the 8 fetch wrappers: a hung request is an infinite spinner. | **[F]** |
| U-05 | Frontend | `SignInPage.tsx:182` | `<form>` nested inside the outer `<form>`; the reset request also submitted a sign-in. Introduced by me in `4d2c69e`. | **[F]** |
| U-06 | Frontend | `PersonalisationPage.tsx:57` | Error state replaces the page with no retry button — one transient failure is a dead end. | [O] |
| U-07 | Frontend | `ToolsPage.tsx:34` | Same dead-end error state, no retry and no way back. | [O] |
| U-08 | Frontend | `AssetsPage.tsx:103` | No loading state: the first paint says "Nothing here yet" while the request is in flight. | [O] |
| U-09 | Frontend | `AssetsPage.tsx:78` | Error and empty state render simultaneously, so a failed load looks like an empty library. | [O] |
| U-10 | Frontend | `PersonalisationPage.tsx:39` | `useCallback(load, [props])` with an inline prop object refetches personalisation on every `App` render. | [O] |
| U-11 | Frontend | `lib/view-models.ts:275` | `isPublicPath` is an exact string match: a trailing slash makes account recovery unreachable again. | [O] |

## P2 — major

| ID | Area | Finding |
| --- | --- | --- |
| S-16 | Security | `cors()` reflects any origin, and `helmet({contentSecurityPolicy:false})` disables CSP wholesale |
| S-17 | Security | `newId` derives ids from `Math.random()`, so creator and asset ids are enumerable — the id space S-01 read |
| S-18 | Security | `RateLimiter.prune()` and `pruneSessions()` both have zero production callers: two unbounded maps |
| S-19 | Security | `express.json()` runs before the auth limiter, so bodies are parsed before the limit is checked |
| S-20 | Security | `touchSession` is never called: `lastSeenAt` is write-once, no sliding expiry or reuse detection |
| A-16 | AI | `model-copy.ts:102`: `limitNumber` takes the first `/character/i` match; a missing limit ships unconstrained with no note |
| A-17 | AI | `pipeline.ts:150`: one model call per source, sequential, up to 50 sources ≈ 850k tokens in a single admin request |
| A-18 | AI | Regression cases share one brief, so N cases = N identical paid calls, no dedupe or cache |
| A-19 | AI | `knowledge/store.ts:253`: chunks that fell back to local stay "pending" forever, so a flaky provider re-bills every chunk every cycle |
| A-20 | AI | `knowledge/store.ts:192`: embeddings are never used for retrieval (lexical only) while a hosted provider bills per chunk |
| A-21 | AI | `app.ts:616`: unredacted provider error text is returned in the API response; `redactSecrets` is not applied on this path |
| D-15 | Data | 7 of 24 `ORDER BY`s have no usable index; foreign keys exist on only 5 of 24 tables |
| D-16 | Data | Migration runs statement-by-statement with no transaction and no rollback path |
| D-17 | Data | `register` does 4 writes (account, profile, link, session) with no rollback |
| D-18 | Data | Password reset swaps the hash then revokes sessions in a separate step, with no transaction |
| D-19 | Data | `media-library.ts:65`: two `writeFile`s with no temp+rename, so a crash leaves a body with no content type |
| D-20 | Data | Orphan bytes are never swept; `remove()` deletes bytes first, so a crash leaves a record pointing at nothing |
| D-21 | Data | `preferences/learning.ts:289`: the counter wipe is inside the per-preference loop, so reset re-learns instantly |
| W-09 | World | `curation.ts:92`: a probed candidate is granted `active:true` and OFFICIAL trust on the strength of the facts its own page produced |
| W-10 | World | `adapters/registry.ts:109`: `registry.resolve(...)` result is discarded, so SIMULATED adapters are never registered |
| W-11 | World | Templates drafted by the World Engine can never leave `PROPOSED` — no route approves them |
| W-12 | World | `pipeline.ts:116`: `maxSourcesPerRun` defaults to `Infinity` for the scheduler |
| W-13 | World | `health/report.ts:69`: six subsystems are hardcoded `UNKNOWN`; `integrationHealth: {}` is a literal |
| P-06 | Perf | `creatorOverview` is O(platforms × events), measured 5.16ms p50 at 4,250 events |
| P-07 | Perf | `api/app.ts:291`: `/api/knowledge/documents` computes version counts in O(documents × versions) |
| P-08 | Perf | `evolution-center.ts:177`: per-source loop re-filters all events — O(sources × events) per render |
| P-09 | Perf | scrypt saturates 4 libuv threads: 20 parallel hashes 4.5× the serial time, shared with the pg pool |
| U-12 | Frontend | `App.tsx:50`: strictly sequential 2-RTT waterfall before first paint |
| U-13 | Frontend | Zero `aria-live` / `role="alert"` regions anywhere |
| U-14 | Frontend | No focus management on navigation; no skip link; `App` renders a `<div>` not `<main>` during load |
| U-15 | Frontend | `CreatePage.tsx:33`: `platformSlug` is seeded from the URL and never resynced, so client-side nav shows the wrong platform |
| U-16 | Frontend | Server error strings shown raw to creators, including `'no creator profile'` |
| U-17 | Frontend | 50 `<img>` with no `loading="lazy"`; the library fires 50 full-size requests on mount |
| U-18 | Frontend | `withMode` rebuilds from `initialForm()`, re-enabling the submit button mid-request |
| U-19 | Frontend | `api.ts:113`: unguarded `JSON.parse` renders a raw `SyntaxError` as the user-facing error |

## P3 / P4 — moderate and minor

<details>
<summary>46 further findings, listed by area</summary>

**Security (6)** — `ADMIN_TOKEN` defaults to empty with no boot-time guard;
`/api/health` is public and discloses source counts and proposal titles; CSRF gate
is skipped when the session table is empty; `robots.txt` content type unchecked;
missing `content-type` defaults to `text/html`; logout returns 200 where 204 is
conventional.

**AI (7)** — `isBoilerplate` drops every evidence quote under 25 characters;
rumour detection scans only `evidence`, which the model chooses; `maxFacts` is
dead configuration; `maxOutputTokens` is not exposed to config; embedding
dimension mismatch silently scores 0; a claim can permanently merge a capability
into `platform.capabilityKeys` with no expiry; `onFallback` is never wired, so
hosted embedding failures are invisible.

**Data (3)** — `MemoryPersistence` stores the caller's live objects, so later
mutations change "persisted" state; `cm_knowledge_chunk.text` is stored twice
(column and doc); `cm_creator_profile.updated_at` is fed `createdAt`.

**World (9)** — `CANDIDATE_PATHS` hardcodes 7 platform slugs in `core`;
`KIND_SIGNALS` matches the literal word "linkedin"; `maxConsecutiveErrors` is
declared and unused; backoff has no jitter; scheduler backoff never re-arms
after a hung cycle; `notifyCreators` notification ids never dedupe across events;
trust is not monotonic across versions; a dead guard compares an array to a
string; `jobRuns` has no duration field.

**Performance (2)** — `/api/sources` re-scores every source per request;
`retrieveKnowledge` lowercases each chunk per query.

**Frontend (11)** — label without `htmlFor` on the platform group; email input
not `type="email"`; no `aria-invalid`/`aria-describedby`; `div.section-title`
used as a heading; disabled button explained only by a `title`; a `useEffect`
POSTs an observation unguarded (StrictMode double-fires); `*` route silently
renders the home feed; no `verify` script in the web workspace; unknown GET
returns 200 HTML while unknown POST returns 404; the `apps/web` package has no
`verify` script so `npm run verify --workspace @creator-mall/web` fails.

**API (2)** — no `.strict()` on mutation schemas, so typos silently become
defaults; success status codes are ad-hoc (201/200/200 for creates).

</details>

## Scale risks

| Collection | Grows how | Pruned? | Risk at scale |
| --- | --- | --- | --- |
| `snapshots` | 1 per platform per cycle | No | 28/hour → ~245k/yr ≈ 1.2GB, fully rewritten per save |
| `events` | 1 per verified diff | No | full flat+sort per `listEvents()` call |
| `knowledge.chunks` | 1 per ~480 chars | Only superseded versions | 100k chunks ≈ 250MB jsonb, 100k single-row INSERTs per save |
| `knowledge.versions` | 1 per publish | Marked EXPIRED only | 8.8k/yr, each body persisted twice |
| `notifications` | 1 per creator × event | No | served whole on the creator feed |
| `sessions` | 1 per login | `pruneSessions` unused | linear scan per request |
| `accounts` | 1 per registration | No | linear scan per reset/verify |
| `RateLimiter.windows` | 1 per distinct IP | `prune` unused | map leak from an address spray |
| `media.assets` | 1 per generate/upload | only on DELETE | full sort to return 50 |
| `jobRuns` | 1 per cycle | **Yes** (50) | the only bounded collection |

## Measurements taken during the audit

| Metric | Value | Method |
| --- | --- | --- |
| Cold start to first `/api/health` | 528ms | real server, polled every 50ms |
| `persist()` at 0.25 / 3.5 / 13.2 MiB | 2.7 / 20.6 / 82.5ms p50 | measured, 15 iterations each |
| `JSON.stringify(state, null, 2)` at 9.4MiB | 43.4ms | measured |
| `creatorOverview` at 0 / 1k / 4.2k events | 0.20 / 2.2 / 5.2ms p50 | in-process |
| `findSessionByToken` at 51k sessions | 1.86ms p50 | in-process |
| `hashPassword` / `verifyPassword` | 53.3 / 39.7ms p50 | scrypt N=16384 |
| scrypt at 20 parallel | 234ms vs 1065ms serial | 4 libuv threads |
| Research cycle, no network | 7ms | instrumented stub fetcher |
| Model calls per cycle | 17 chat completions, 33,279 input chars | counted through the real extractor |
| Web bundle | 211,440 B (66.03 kB gzip), 1 chunk | `npm run build` |
| Source map served | 859,569 B at HTTP 200 | `GET /assets/*.js.map` |
| Request ids / metrics / traces | **0** | repo-wide grep |
| `console.*` in `packages/server/src` | 16 log, 9 error, 1 warn | counted |
| `readSchema()` | ENOENT in both src and dist | reproduced |
| `npm run verify` at audit time | 420 tests passing | run |
