# Phase 4 — the five remaining slices

Each slice was committed separately, so any one of them can be read, reviewed or
reverted on its own.

| Slice | Commit | Tests |
| --- | --- | --- |
| 1. Source curation and yield ranking | `c3d1054` | 13 + 8 |
| 2. Preference learning with why/forget/reset | `4613f9d` | 15 + 8 + 12 |
| 3. Postgres persistence | `8fb17a1` | 14 |
| 4. Publishing adapter layer | `0c70964` | 17 |
| 5. Hosted embeddings | `45fcc29` | 16 |

---

## 1. Source curation and yield ranking

A registry that only grows is a liability. Sources that answer but never say
anything useful cost requests and hide real problems.

- `SourceStats` on the record — checks, successes, failures, blocked, facts,
  events, lastFactAt. Curation measures reality and survives a restart.
- Four tiers with plain-language reasons: `PRIMARY`, `SECONDARY`, `QUIET`
  (answers, yields nothing), `BROKEN` (robots or repeated failures).
- Productive sources are scheduled **first**, so a tight request budget still
  buys information.
- Candidate documentation paths start **inactive**. The engine probes a few per
  cycle and activates only the ones that produce a verified fact. A wrong guess
  costs one request, never a wrong belief.
- `GET /api/sources` reports tier, score, reasons and lifetime stats;
  `POST /api/admin/sources/:id/curation` retires or reactivates. Knowledge a
  retired source produced is never deleted.
- The Evolution Center shows what needs curating and why.

The research cycle now credits accepted claims to the sources that produced
them, which is what makes "is this source earning its place?" answerable.

## 2. Preference learning the creator can take back

- Observations: option chosen, draft accepted or edited, platform added or
  removed, limit warnings hit, updates opened or dismissed.
- Patterns need repeated evidence before a belief forms. Counters are
  maintained incrementally, so a later contradiction **withdraws** support
  instead of being overwritten by the next "yes". A preference that falls below
  its threshold is dropped, not kept.
- Every preference carries a label, a plain-language description, its evidence,
  a confidence and an occurrence count.
- The creator can ask *why am I seeing this*, turn one off, forget one, or reset
  everything. A disabled preference is never used.
- Scoped to the signed-in account: one creator never sees another's learning.
- Nothing learned can publish anything or change access.

**Also fixed a real bug:** the web app's POST helpers bypassed the CSRF token,
so *validate* and *draft* would have failed in the browser since Phase 3. Found
while wiring observations into the creation flow.

## 3. Postgres persistence

Storage is configuration, not a code path: `PERSISTENCE=postgres` with a
`DATABASE_URL` uses the control-plane tables; otherwise the JSON snapshot.

- 20 tables, normalised where rows are queried (sources, sessions, knowledge
  versions, events, proposals, learning counters), JSONB where a row is read
  whole.
- Writes replace the projection inside one transaction, so a crash cannot leave a
  half-saved control plane, and a delete really deletes.
- `SqlClient` is a four-method interface: the mapping is testable and `pg` is
  only imported when a connection is opened.
- Startup verifies the schema version and refuses to run against the wrong one.
- `npm run db:migrate` applies the schema, `npm run db:check` proves the tables
  are usable.
- Sessions, observations, preferences and learning counters now persist.

**Honest scope:** covered by a contract test against a fake SQL client that
records every statement, and the same contract runs against the memory and file
stores. It is **not** tested against a live database — none is reachable from
this environment. Run `db:migrate` and `db:check` against real Postgres to
verify.

## 4. Publishing adapters driven by verified knowledge

An integration is a **definition**, not a class: endpoint, method, field mapping,
where the published id comes back, and how the credential is presented.

- `HttpPlatformAdapter` — one implementation serves every platform, present or
  future. Paths are relative to the base URL even with a leading slash, so a
  definition means what its author intended.
- Credentials are resolved per call from the environment, never stored, never
  logged, and a platform error body is never surfaced (it can echo the key).
- 5xx and 429 are reported as retryable, 4xx as final.
- `SimulatedPlatformAdapter` — the same composer, validation, idempotency and
  scheduling behaviour with no network call. Every result it returns is flagged
  `simulated`, and references are prefixed `sim_`.
- Validation moved into one place and is driven by verified limits, so a
  declared-but-unobserved capability is allowed, and an unverified limit
  produces a *warning* rather than silent permission.
- `publishingEnabled` requires two independent facts: a `LIVE` adapter **and**
  our own verified knowledge that the publishing API exists.

**A design change worth naming:** the old `UnavailablePlatformAdapter` refused
everything. That was honest but useless — local development could not exercise
the real path. The product gate (`publishingEnabled`) already prevented any false
promise, so the fallback is now `SIMULATED` and marked as such at every boundary.

**No live platform integration is claimed.** `CM_INTEGRATIONS` is empty, because
no platform's publishing API has been verified from this environment.

## 5. Hosted embeddings

- `EmbeddingProvider`: one method, one batch method.
- The local provider is the default and needs nothing — knowledge is searchable
  immediately after a write, with no indexing step, no key, no network, and
  nothing about a creator leaving the machine.
- The hosted provider speaks the OpenAI-compatible embeddings shape, batches
  large inputs, never surfaces a response body, and falls back to the local
  provider so an outage degrades the index rather than losing it.
- `embedPendingChunks` re-embeds only what the requested provider has not seen,
  and is idempotent per provider.
- The research cycle refreshes embeddings after knowledge changes and records a
  key-free reason when the hosted path is skipped.

**Stated rather than implied:** the local provider is a hashed bag of words. It
matches shared vocabulary, not synonyms. A test asserts that limitation so it
cannot be quietly forgotten.

---

## What a live run taught us

Running the engine against real platform sites (17 sources) produced findings
that changed the code:

| Finding | Response |
| --- | --- |
| `facebook.com` disallows automated reading | blocked correctly, source marked, never retried aggressively |
| TikTok returns 503, X returns 403 | marked failed with the reason, retried later |
| Homepages state no machine-readable limits | candidates now probe deeper documentation paths |
| Cookie banners and "browser not supported" were becoming knowledge | boilerplate filter, then a quality gate |

**Empty beats wrong.** That principle now governs the model path, the source
registry, the knowledge store and the adapters.

## Still open

| Area | Why |
| --- | --- |
| Verifying Postgres against a live database | no database reachable from this environment |
| Verifying the OpenRouter key | the API path is blocked by this machine's egress filter; run `npm run model:check` |
| A real publishing integration | needs a verified platform API and credentials |
| Email verification, password reset, per-IP rate limiting | next hardening pass |
| Session store shared across instances | sessions live in the control plane, single process by design |
| Creator accounts beyond one profile each | fine today; multi-profile creators would need a link table |
