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
| Security | **NEEDS WORK** | 4 P0, 7 P1 | authz ordering, IDOR, SSRF, link poisoning, error leak — all fixed; rate-limit gaps open |
| API | **NEEDS WORK** | 2 P0, 7 P1 | full route inventory; no envelope convention; no pagination anywhere; no idempotency |
| Database | **NEEDS WORK** | 6 P0 | Postgres could not boot, could not migrate, and could not save — all fixed; retention still unbounded |
| AI | **NEEDS WORK** | 1 P0, 8 P1 | prompt injection reachable; prompt versioning has no effect on output; no cost ceiling |
| Frontend | **NEEDS WORK** | 2 P0, 5 P1 | blank shot list; silent sign-out; no error boundary; no timeouts; SSR-smoke-only tests |
| World Engine | **NEEDS WORK** | 0 P0, 8 P1 | SSRF surface fixed; `WATCH` claims can enable creator options; single-source verification |
| Evolution | **PASS WITH FINDINGS** | 0 P0, 3 P1 | gate is real and correct; activated prompts are never used in generation |
| Performance | **NEEDS WORK** | 0 P0, 5 P1 | measured: persist() 82ms p50 at 13MiB; overview 5ms at 4k events; no code splitting |
| Scalability | **NEEDS WORK** | 0 P0, 4 P1 | every collection unbounded; whole-state rewrite per save; no pagination |
| Reliability | **NEEDS WORK** | 2 P0 | scheduler never persisted; shutdown never flushed — both fixed |
| Observability | **BLOCKED** | — | zero metrics, zero request ids, 500s never logged. Not a defect list, an absence |
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

## What is still open

Not fixed, with reasons. Full detail in the per-area documents.

**P0 — none remaining that I could reproduce.** The three data-destruction
paths and the two authz holes are closed.

**P1, security:** `cors()` reflects `*`; admin token compared non-constant-time
and `adminGuard` performs no CSRF check; uploads trust client `Content-Type` and
are served `inline` with CSP disabled (stored XSS); the rate limiter is not
applied to `generate`, uploads, or admin research runs; lockout counter is a
non-atomic read-modify-write and never decays.

**P1, data:** `load()` failures are swallowed, so a broken projection boots empty
and then rewrites real rows; `save()` is delete-all-then-insert with no
transactional increment; sessions are never pruned and `getEvent` does a full
sort per call; Postgres `save()` is 2 round-trips per row.

**P1, AI:** fetched page text reaches the model prompt unfenced, and the
verbatim-evidence gate only checks the first 60 characters, so injected text can
quote itself as evidence; activated prompt versions never reach generation, so
prompt evolution has no effect on output; a model fact at `capabilities.X` with
no explicit state defaults to `ACTIVE`; no range validation on extracted values;
no per-request or per-creator cost ceiling.

**P1, world engine:** `applyClaims` applies `WATCH` claims as well as
`ACCEPTED`, so two news sources can switch a creator option on;
`deprecationsRequireOfficialEvidence` is dead code, so a non-official claim can
switch a working option *off*; one first-party source reaches `ACCEPTED` at 0.85.

**P1, frontend:** no retry on the Tools or Personalisation error states;
`AssetsPage` shows its empty state while loading; `App` renders a `<div>` rather
than `<main>` during load; no `aria-live`, `role="alert"`, skip link or focus
management anywhere; `PersonalisationPage` refetches on every `App` render.

**P2, cross-cutting:** no pagination on any collection endpoint; no idempotency
key on generation or upload; no request id or metrics; no `compression()`; the
859KB source map is served publicly; the 211KB bundle is not code-split; the
admin action `actor` is taken from the request body, so the decision log is
spoofable.

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
