# Creator Mall — Master QA Audit

Date: 2026-09-27 · Commit audited: `4d2c69e` · Fixes landed in `9397257`
Method: seven independent read-only passes (security, API, data, frontend, AI,
world/evolution, operations), followed by manual reproduction of every P0/P1
claim before it was reported. Findings that could not be reproduced were dropped.

## How to read this

- **Every P0/P1 finding was verified by hand.** Agents disagreed on several
  claims; where they did, the conservative reading was taken.
- **Three of the P0s were bugs introduced by the phases I shipped in this
  session.** That is the most important line in this document.
- Findings are deduplicated across passes. Where two auditors found the same
  defect it appears once, with the count as corroboration.
- Severity: P0 exploitable breach/auth bypass or data destruction · P1 serious
  defect · P2 major · P3 moderate · P4 minor. Not inflated.

## The single most important finding

> A test was asserting the vulnerability.

`packages/server/test/api.test.ts:185` called
`GET /api/creator/cr_demo_video_creator/updates` **with no session** and
asserted `200` plus a full notification body. The route was registered at
`app.ts:297`, above the `requireAuth` mount at `app.ts:306`. Four independent
auditors flagged it; the test confirms it was reachable and the suite was green.

This is the "a passing test can hide missing failure scenarios" case from the
audit brief, in its purest form. It is now the opposite test.

## Scorecard

| Category | Status | Critical findings | Evidence |
| --- | --- | ---: | --- |
| Security | **PASS WITH FINDINGS** | 0 P0 open | All 4 P0 and the top P1s fixed; rate-limit and lockout edges remain |
| API | **PASS WITH FINDINGS** | 0 P0 open | Full inventory; envelope is still ad-hoc and idempotency is absent |
| Database | **NEEDS WORK** | 0 P0 open | Postgres boot/migrate/save all fixed; save is still delete-all-then-insert |
| AI | **PASS WITH FINDINGS** | 0 P0 open | Injection closed and prompts now reach output; embeddings still unused, no cost ceiling |
| Frontend | **PASS WITH FINDINGS** | 0 P0 open | Shot list, sign-out, boundary and timeouts fixed; still SSR-smoke-only tests |
| World Engine | **NEEDS WORK** | 0 P0, 8 P1 | SSRF surface fixed; `WATCH` claims can enable creator options; single-source verification |
| Evolution | **PASS WITH FINDINGS** | 0 P0, 3 P1 | gate is real and correct; activated prompts are never used in generation |
| Performance | **NEEDS WORK** | 0 P0, 5 P1 | measured: persist() 82ms p50 at 13MiB; overview 5ms at 4k events; no code splitting |
| Scalability | **NEEDS WORK** | 0 P0 open | Retention and pagination added; save pattern still whole-state |
| Reliability | **NEEDS WORK** | 2 P0 | scheduler never persisted; shutdown never flushed — both fixed |
| Observability | **NEEDS WORK** | - | Request ids, failure logging and a readiness probe added; no metrics or tracing |
| Platform integrations | **NOT IMPLEMENTED** | — | adapters proven only against a simulated transport; gate correctly closed |
| Testing | **NEEDS WORK** | — | 433 tests, but frontend is 100% server-render smoke: no DOM, no interaction, no network mocking |

## What was fixed in `9397257`

Each with a named regression test in `packages/server/test/qa-regressions.test.ts`.

| Area | Defect | Origin |
| --- | --- | --- |
| Authz | `/updates` served to anyone, registered above the auth guard | pre-existing, encoded by a test |
| Authz | `/impact` had no ownership check | pre-existing |
| Security | Recovery links built from `Host`/`X-Forwarded-Proto` | pre-existing |
| Security | 500 handler echoed `error.message` | pre-existing |
| Security | Fetcher followed redirects unchecked; empty allowlist allowed all | pre-existing |
| Durability | register/login/logout never persisted | pre-existing |
| Durability | Scheduler never persisted its output | pre-existing |
| Durability | Shutdown never flushed | pre-existing |
| Data | Postgres truncate list missing two tables I added | **introduced in `9980c5d`** |
| Data | `cm_preference_counter` insert named a non-existent column | pre-existing |
| Data | `migrate()` never recorded the schema version | pre-existing |
| Data | `readSchema()` pointed at a path that does not exist | pre-existing |
| Frontend | Storyboard field names mismatched; shot list blank | pre-existing |
| Frontend | Any `ApiError` signed the user out, 5xx included | pre-existing |
| Frontend | Nested `<form>`, reset request also submitted a sign-in | **introduced in `4d2c69e`** |
| Frontend | No error boundary; no fetch timeout | pre-existing |

## What was fixed, and what is still open

> **Status: 8 fix commits landed since this audit** — `9397257`, `cf17ef6`,
> `cc7a063`, `e964838`, `b7eb85b`, `87843bb`, `ce8019e`, `6e15414`.
> Roughly 82 findings are closed; **about 72 remain open**. The counts below are
> as of `6e15414`, not as of the original audit.

**All P0s are closed.** The three that survived the first pass — the data wipe,
stored XSS via upload, and prompt injection — were fixed in `cc7a063`, together
with the highest-risk P1s.

| Commit | Closed |
| --- | --- |
| `9397257` | Both authz holes, Host-header link poisoning, error-handler leak, SSRF via unchecked redirects and link-local targets, auth routes never persisting, scheduler discarding its output, shutdown not flushing, four separate Postgres defects, blank shot list, silent sign-out, no error boundary, no fetch timeouts, nested form |
| `cc7a063` | **P0:** data wipe on failed load, stored XSS, prompt injection (fencing, comment stripping, whole-quote evidence gate). Admin API falling open, admin CSRF, constant-time token compare, CORS wildcard, generation/upload budgets, `WATCH` claims enabling creator options, capability state defaulting to `ACTIVE`, **activated prompts never reaching generation** |
| `e964838` | Unhandled rejection in asset delete, lockout that never decayed, provider body-read timeout, session and rate-limit map leaks, reset/verify not persisting, three UI dead ends, `isPublicPath` exact match |
| `b7eb85b` | Snapshot and event retention, pagination on event and proposal endpoints |
| `87843bb` | Request IDs and failure logging, health semantics with liveness/readiness split, stalled-body and robots timeouts, strict mutation schemas, source maps no longer served, immutable asset caching, route-level code splitting |
| `ce8019e` | Persistence write safety (unique temp, fsync, cleanup), compact state writes, source registry paging, skip link, main landmark, live status regions, lazy images, JSON parse guard |
| `6e15414` | The regression runner asserting its own requirement — an activation gate that could be passed by a prompt ignoring the verified change |

**Still open, in priority order:**

1. **Incremental persistence (~10).** `save()` is still delete-all-then-insert:
   two round-trips per row in Postgres, and the JSON backend still rewrites
   everything on each mutating request. The write is now safe and cheaper, but
   the pattern is unchanged. This is the largest single item and the only one
   that will bite at real scale.
2. **No frontend interaction tests (~8).** No jsdom, no request mocking. Every
   UI fix in this entire effort is verified by typecheck and server-render smoke
   only. This is the weakest guarantee in the project and it is a test-coverage
   problem, not a code problem.
3. **Embeddings are computed but never used for retrieval (~3).** A hosted
   provider bills per chunk while `retrieveKnowledge` is lexical only. Either
   rank by similarity or drop the hosted provider.
4. **Remaining a11y and polish (~25).** `aria-live` on async status, focus
   management on route change, some heading semantics, a few contract type
   narrowings, `compression()` (the package is not installed).
5. **Remaining P2/P3 security and correctness (~26).** Non-atomic writes in
   several places, `getEvent` doing a full sort per call, no idempotency key on
   generation or upload, missing foreign keys and indexes on 7 of 24 tables,
   publish-timeout ambiguity on the adapter path.

**Two known blind spots in this audit itself:**

- Everything was verified against `FakeSql`, never a live Postgres.
- The model paths were exercised only through stubs. No test asserts prompt
  construction end to end, and the OpenRouter API is unreachable from the
  machine that ran this audit.


## The honest verdict on the four questions that matter

**Is it secure?** No, not yet. The catastrophic holes are closed, but stored XSS
via upload, an unauthenticated admin surface when `ADMIN_TOKEN` is unset, and
`cors()` reflecting any origin are all real and open.

**Will it survive a restart?** Now, yes — for the JSON backend. That was not true
an hour ago, and the Postgres backend had never worked at all.

**Can it scale?** No. Every collection is unbounded, `persist()` rewrites the
entire state synchronously on the event loop (82ms p50 at 13MiB, measured), and
there is no pagination anywhere. The architecture is fine; the retention and
write patterns are not.

**Is the AI reliable?** It cannot be trusted with adversarial input. Prompt
injection from fetched pages is reachable, and the verification gate is bypassable
by a claim that quotes itself. For benign sources the deterministic path is solid
and honestly labelled.

## Reports

- [API-AUDIT.md](API-AUDIT.md) — full route inventory, 45 routes
- [SECURITY-AUDIT.md](SECURITY-AUDIT.md) — 24 findings
- [DATABASE-AUDIT.md](DATABASE-AUDIT.md) — 30 findings, scale table
- [AI-AUDIT.md](AI-AUDIT.md) — 30 findings, injection verdict
- [UI-AUDIT.md](UI-AUDIT.md) — 30 findings, per-page state matrix
- [PERFORMANCE-AUDIT.md](PERFORMANCE-AUDIT.md) — measurements and bottlenecks
- [PLATFORM-AUDIT.md](PLATFORM-AUDIT.md) — World Engine, evolution, adapters
- [ARCHITECTURE-AUDIT.md](ARCHITECTURE-AUDIT.md) — structure, debt, hardcoding
- [TEST-MATRIX.md](TEST-MATRIX.md) — what is and is not proven
- [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) — gate checklist
