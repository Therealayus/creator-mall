# Functionality gap report

For every feature that is not IMPLEMENTED: what exists, what is missing, what
it would take, and what it depends on. Ordered by the brief's implementation
sequence, not by size — dependencies first.

## 1. Mail delivery (blocks: password reset, email verification)

### Current state
Token issue, confirm, expiry, hashing, session revocation, rate limiting, and
the full web flow (forgot-password form, `/reset-password`, `/verify-email`)
all exist and are tested. `Delivery` is a port; `LogDelivery` writes the link
to the log and refuses to log secrets in production.

### Missing
A real provider (Resend, SES, Postmark, or equivalent) and the configuration to
reach it. Links are returned in the API response outside production and shown
inline on the sign-in page; in production nothing is sent at all.

### Required implementation
One `Delivery` implementation (~40 lines), provider credentials in config,
and a test with a stubbed transport asserting send-once semantics.

### Status
PARTIAL — the only gap between "works" and "usable by a customer".

## 2. Live Postgres verification (blocks: production persistence)

### Current state
Schema, migrations, truncate-and-replace save, contract tests against `FakeSql`.

### Missing
A single run against a real database. Three defects in this path were found by
reading, not by running (missing tables in the truncate list, a phantom column,
a migration that never recorded its version). There may be a fourth.

### Required implementation
`DATABASE_URL` against a staging Postgres, `npm run db:migrate`, the suite
with `PERSISTENCE=postgres`.

### Status
PARTIAL — contract-proven, never run live.

## 3. Live model verification (blocks: AI copy, extraction, regression)

### Current state
Every model path has a stubbed-provider test and a deterministic fallback that
is honestly labelled.

### Missing
One run of `npm run model:check` from an unrestricted network. Prompt
construction, delimiter discipline and injection resistance have never been
exercised against a real model.

### Status
PARTIAL — proven against stubs, unproven against the provider.

## 4. Template approval (blocks: half of self-evolution)

### Current state
The pipeline drafts templates as PROPOSED on every verified change. They
persist. Nothing can ever approve or activate them — no route, no service.

### Missing
An admin template-decision route mirroring the prompt one, plus a test that a
PROPOSED template stays inert until decided.

### Dependencies
None. Smallest item on this list (~80 lines + tests).

### Status
INERT.

## 5. Publishing (blocks: the product's end goal)

### Current state
Adapter contract, HTTP + simulated transports, readiness gating, idempotency
analysis. No publish route, no stored platform IDs, no status tracking.

### Missing
Verified platform APIs, OAuth flows, credential storage, a publish route with
user confirmation, result verification, and idempotency keys.

### Dependencies
Platform API access (blocked externally), OAuth (missing), credential vault
(missing).

### Status
INERT by design — the gate is correctly closed. Do not build publishing
without the credentials and confirmation UX first.

## 6. Scheduling engine

### Current state
A capability key, a readiness flag, and adapter type shapes. No queue, no
worker, no calendar, no timezone handling.

### Missing
Everything: schedule entities, a due-queue, a worker, retries, token-expiry
handling, a calendar UI, timezone support.

### Dependencies
Publishing (5) — scheduling something that cannot publish is a reminder app.

### Status
MISSING.

## 7. Analytics

### Current state
A capability key and an adapter flag. No collection, no storage, no dashboard.

### Missing
Everything, plus a decision this list cannot make: which platform metrics are
worth storing, given their definitions differ per platform and must never be
compared as if equivalent.

### Dependencies
Publishing (5) — there is nothing to measure until something is published.

### Status
MISSING.

## 8. Campaigns, repurposing, editor, search, trends, comments

### Current state
None have UI, API, backend, or storage. "Comment", "trend", "calendar" and
"insight" appear in the codebase only as capability vocabulary or prose.

### Missing
Each is a full feature: entities, routes, pages, tests.

### Dependencies
Content library persistence first (assets exist; editable versioned content
does not). Then campaigns, then repurposing (which needs per-platform
constraints, already verified), then trends and search.

### Status
MISSING — correctly absent rather than faked. The brief's order (content
library → campaigns → repurposing → trends → search) is the right build order.

## 9. OAuth / social connections, billing, webhooks, account deletion

### Current state
Nothing. No OAuth flow, no token storage, no billing tables, no webhook
receivers, no deletion path.

### Missing
OAuth is the load-bearing one: publishing, analytics and any "connected"
state all depend on it. Billing needs a product decision first (what is sold).
Account deletion needs a retention policy first (what must be kept).

### Status
MISSING.

## 10. Creator search

### Current state
`/knowledge/search` exists for operators over knowledge chunks.

### Missing
Search over a creator's own assets and content, scoped to their account.

### Dependencies
Editable content (8) — there is little worth searching until content persists.

### Status
PARTIAL (operator search real; creator search missing).

## What was deliberately not built

- **A real marketplace.** The Market Engine is a verified catalogue with no
  partner list, ranking or commerce. Creator-to-creator selling is a different
  product.
- **Real AI media.** Posters, shot lists and scripts are deterministic and
  labelled. Model image/video/audio would implement the same four ports.
- **Metrics, tracing, dashboards.** Request IDs and failure logging exist;
  aggregation and alerting do not.

## Recommended sequence (unchanged from the brief, confirmed by inventory)

1. Mail delivery — unblocks the two auth flows for real use.
2. Live Postgres + live model verification — converts contract-proven paths
   into proven paths.
3. Template approval — smallest item, completes self-evolution.
4. OAuth + credential storage — unblocks publishing, analytics, connections.
5. Editable versioned content, then campaigns, repurposing, trends, search.
6. Scheduling, analytics, billing, webhooks — in dependency order.
