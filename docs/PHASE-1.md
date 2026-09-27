# Phase 1 — scope, verification and what comes next

Phase 1 goal: prove the *spine* — a system that notices a real ecosystem change, verifies
it, understands it, plans the work, and refuses to act unsafely — before building any
creator-facing surface on top of it.

## Delivered

### World intelligence
- Source registry with per-source type, trust level, platform, schedule, health, and HTTP
  validators (`Source`).
- Permitted-data fetcher: host allowlist, robots.txt, per-host rate gap, timeout, byte cap,
  text content types only, conditional GET.
- Continuous research cycle (`runResearchCycle`): discover → fetch → extract → verify →
  snapshot → diff → understand → plan → publish.
- Platform snapshots with immutable history and structural diffs.
- New-platform discovery with identity + source validation and a watchlist.

### Understanding
- Change classifier: 27 change categories with `LOW → CRITICAL` risk and stated rationale.
- Verification gate: `OFFICIAL / VERIFIED / REPORTED / COMMUNITY_SIGNAL / UNCONFIRMED /
  RUMOR`, including hearsay-wording detection.
- Fact extraction: numeric limits, character limits, hashtag limits, file-size limits,
  deprecations, newly launched formats — each with its evidence sentence.
- Creator impact scoring per creator, with a notification floor so nobody is spammed.

### Evolution
- `ChangeProposal` with typed actions, affected components from the dependency graph, and
  test plans.
- Automatic only for low-risk knowledge; everything else staged for review; critical changes
  additionally raise an alert and pause affected workflows.
- Feature dependency graph (platform → capability → content type → prompt → template →
  editor → publisher → analytics → docs) with blast-radius traversal.
- Platform readiness profiles for platforms that do not exist yet as integrations.
- Config-driven UI model: creation options, disabled reasons, and "why did this change?"
  attribution — no platform conditionals anywhere in the rendering path.
- Versioned prompts: draft → diff → activate, with supersession history.

### Knowledge
- Documents, versions, chunks, facts, embeddings, source attribution, TTL policies.
- Expiry marks stale, never deletes. Retrieval prefers fresh and degrades explicitly.
- Deterministic local embeddings so the whole path is testable offline.

### Operator surface
- Evolution Center API + server-rendered dashboard: watchlist, proposals, change log,
  research runs, health.
- Per-subsystem health with alerts.

## Verification

```
npm run verify     # eslint (type-checked rules) + tsc + 67 tests
```

Coverage highlights:

| Guarantee | Test |
| --- | --- |
| Unchanged state produces no deltas | `snapshot-diff.test.ts` |
| Tightened limit is HIGH, loosened is MEDIUM | `snapshot-diff.test.ts` |
| API deprecation is CRITICAL | `snapshot-diff.test.ts` |
| New capabilities register at runtime | `snapshot-diff.test.ts` |
| Scripts/styles never enter extracted text | `verify-extract.test.ts` |
| Community sources never become platform facts | `verify-extract.test.ts` |
| Hearsay wording is downgraded even on official pages | `verify-extract.test.ts` |
| Knowledge versions supersede, never overwrite | `knowledge.test.ts` |
| Stale knowledge is returned only as a labelled fallback | `knowledge.test.ts` |
| Prompts never overwrite an active version | `knowledge.test.ts` |
| Only affected creators are notified | `pipeline.test.ts` |
| Failed research keeps knowledge and marks the source | `pipeline.test.ts` |
| An announced platform is registered but not publishable | `pipeline.test.ts` |
| Publishing stays off for unintegrated platforms | `api.test.ts` |
| Creator-facing copy contains no internal jargon | `api.test.ts` |
| Admin routes require a token | `api.test.ts` |
| Unknown platforms refuse to publish, with a reason | `api.test.ts` |
| Allowlist, robots, 304, content-type, byte cap | `fetcher.test.ts` |

## Deferred to Phase 2

| Area | Why now |
| --- | --- |
| Creator web app (React creation flow) | needs the UI model to be consumed by real screens |
| Postgres persistence | `PersistencePort` + serialisable state already in place |
| Real platform publishing adapters | gated on verified APIs; contract is tested |
| Hosted embeddings + vector search | `Embedding` interface already isolated |
| Model-backed fact extraction | `FactExtractor` interface already isolated; deterministic extractor ships as default |
| Template generation and prompt evaluation | proposal actions and versioning exist; generation quality needs real data |
| Creator preference learning with "why / forget / reset" | `LearnedPreference` model exists; needs the creator app to produce behaviour data |
| Multi-tenant auth and RBAC | single-admin token in Phase 1 |

## Known limits of Phase 1

1. The deterministic extractor reads explicit limit phrasing ("up to 90 seconds"). It will
   miss limits stated in prose or tables. The `FactExtractor` interface is the seam for a
   model-backed extractor, which must keep the same evidence and confidence contract.
2. Discovery uses announcement-shaped sentences. It is intentionally conservative: a false
   positive costs a watchlist entry, a false negative costs nothing until the platform is
   announced again.
3. Health components without configured integrations report `UNKNOWN` rather than a
   percentage, so the dashboard never invents a number.
4. The control plane is a single process. The research loop is idempotent per cycle
   (`newId` + `stableId` for content-derived ids), so it is safe to re-run, but there is no
   distributed locking yet.
