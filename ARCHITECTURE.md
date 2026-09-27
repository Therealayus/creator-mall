# Architecture

This document maps the Creator Mall architecture onto the code that exists today, and
records the design decisions that are not obvious from the code itself.

## 1. Three engines, one control plane

```
                         CREATOR MALL
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  CREATOR ENGINE        WORLD ENGINE          MARKET ENGINE
  (Phase 2)              (Phase 1)             (Phase 2)
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                      CONTROL PLANE
                  (server/src/store/control-plane.ts)
                              ▼
                    EVOLUTION ENGINE
                              ▼
                         EVOLUTION CENTER
```

The **control plane** is a single in-process store that both engines read and write. It is
framework-free on purpose: engines are testable without HTTP, and the API is testable
without a scheduler. `ControlPlaneState` is plain JSON, which is also the persistence
format (`FilePersistence`, atomic temp-file + rename) and the seam where Postgres arrives
in Phase 2.

## 2. The capability graph, not a platform switchboard

`core/src/capabilities/taxonomy.ts` defines capabilities as **product concepts**
(`SHORT_VIDEO`, `CAROUSEL`, `SCHEDULING`, `API_PUBLISH`), each with a domain, the surfaces
it appears on, and the language signals that identify it in source text.

`CapabilityRegistry` is **open**: when the Evolution Engine verifies a genuinely new
format, it registers a new definition at runtime (`proposeFromSignal`) rather than
requiring a code change. Application code never asks "which platform is this?" — it asks
"which capabilities are active?".

Consequences:

| Concern | Mechanism |
| --- | --- |
| Creation flow (§20) | `buildPlatformUiConfig` renders options from active capabilities |
| Publishing (§41) | `PlatformAdapter.validateContent` checks the capability exists, then its limits |
| Impact (§28) | `scoreCreatorImpact` scores creator × capability overlap |
| Readiness (§17) | `buildReadinessProfile` scores areas from capabilities + adapter + sources |
| Creator-facing limits (§20) | `limitHintsFor` maps an option to the verified limits to show |

`buildPlatformUiConfig` (§19 + §20) is the only place the option set is decided:

- a capability is available when a **verified snapshot says `ACTIVE`**, or when the platform
  **declares** it and nothing has contradicted that declaration;
- a **verified deprecation always wins** — support is withdrawn only on evidence;
- anything else is shown **disabled with a reason** rather than hidden, so the gap stays
  visible instead of silent.

`limitHintsFor` maps an option to the verified limits a creator needs before writing
("Maximum length: 90 seconds"), and returns "we have not confirmed the exact limits for this
option yet" instead of guessing.

## 3. Snapshots, diffs and risk

`PlatformState` is a bag of JSON areas (`capabilities`, `limits`, `mediaSpecs`,
`publishing`, `api`, `analytics`, `monetization`, `requirements`, `policies`, `notes`)
rather than a fixed schema. Adding a new observation area needs no migration.

```
previous snapshot ──┐
                    ├─► diffValues (structural, leaf level) ─► classifyDelta ─► StateDelta[]
current snapshot  ──┘
```

`classifyDelta` is rule-based and explainable. Every delta carries a category, a risk level
and a human-readable rationale, because §35 requires the product to answer "why did this
change?".

Two risk rules matter most:

- **tightening a limit is HIGH, loosening it is MEDIUM** — tightening can invalidate
  content that already passed validation;
- **an API deprecation is CRITICAL** — integrations break without warning, and if it
  touches auth it also triggers workflow pause and a security review.

The first snapshot for a platform is a **baseline, not a change**. No event is fabricated
from initial knowledge.

## 4. Merge, never subtract

`applyClaims` builds the next state by **merging verified claims into the previous state**.
If a fact stops appearing on a page, it is not deleted.

Inferring removal from absence is the single most dangerous thing a monitoring system can
do: documentation gets reorganised, sections move, pages get reorganised. Capabilities are
withdrawn only when a source explicitly states a removal or deprecation. Every other
absence is a non-event.

## 5. The verification gate

```
source page ─► extract facts ─► group by claim key ─► assess sources ─► ACCEPTED | WATCH | REJECTED
```

- `assessSources` weights source type, assigned trust, and **independence** (distinct
  domains), so one official page is `OFFICIAL`, two independent reports are `VERIFIED`, one
  report is `REPORTED`, community discussion is `COMMUNITY_SIGNAL`.
- `detectRumour` downgrades any claim whose *wording* is hearsay — "rumoured", "sources say",
  "allegedly" — to `RUMOR` regardless of how official the page is. An official blog post
  repeating a rumour is still a rumour.
- Only `ACCEPTED` and `WATCH` claims enter knowledge. Rejected claims stay in the event log
  as signals.

## 6. Knowledge that decays

`KnowledgeDocument → KnowledgeVersion → KnowledgeChunk → KnowledgeFact`, with TTLs by
policy (`API_INFO` 7 days, `PLATFORM_LIMIT` 14, `PLATFORM_POLICY` 30, `PLATFORM_GENERAL`
90, `HISTORICAL` permanent).

- Publishing a new observation creates version *N+1*; version *N* becomes `SUPERSEDED` and
  is retained.
- Expiry **marks** knowledge stale; it never deletes it.
- Retrieval prefers current, fresh, high-trust chunks. If nothing current matches, it
  returns stale results with an explicit `degraded` notice rather than a confident answer.

Embeddings default to a deterministic local hashed-bag-of-words provider
(`LocalHashEmbeddingProvider`). The retrieval, freshness and deactivation paths are
therefore fully testable offline, with no API key and no data leaving the machine.

## 7. Evolution: proposals, not deployments

`planEvolution` converts a verified event into `ChangeProposal` records containing
machine-checkable `ProposalAction`s, an affected-component list from the dependency graph,
and a test plan. It never edits production code.

```
                ┌──────────────┬──────────────┬───────────────┐
knowledge only  │ new format   │ API change   │ critical      │
LOW             │ MEDIUM       │ HIGH         │ CRITICAL      │
AUTO_APPROVED   │ PENDING_REVIEW              │ + SECURITY_REVIEW
                └──────────────┴──────────────┴───────────────┘
```

`applyProposalDecision` applies only the **safe** subset on approval — knowledge documents
and capability metadata. Code, migrations, security and publishing actions are recorded for
CI and still require a controlled deployment.

`DependencyGraph` is the machine-readable blast radius (§25):
`Platform → Capability → Content type → Prompt → Template / Editor / Publisher / Analytics / Docs`.
`blastRadius` answers "what else does this touch?" without a hand-maintained list.

## 8. Unknown platforms are first-class

`UnavailablePlatformAdapter` (§42) represents a platform with no integration. It reports
known capabilities, validates content against known limits, and **refuses to publish with an
explanation** rather than pretending to work. `AdapterRegistry.resolve` never returns null,
so "no adapter" can never be mistaken for "no platform".

Discovery (`discovery.ts`) scans news and community sources for platform announcements,
validates identity and source quality, and registers a watchlist entry with status
`DISCOVERED`. A discovered platform is never made publishable from that code path.

`buildReadinessProfile` scores a platform across content generation, image/video support,
adapter, publishing API, analytics API, knowledge coverage and template library — so the
product can be *ready* for a platform the day it opens its API.

## 9. Failure behaviour

`runResearchCycle` records what it did even when things go wrong:

| Failure | Behaviour |
| --- | --- |
| Fetch 5xx / timeout | source marked `FAILED`, retry next cycle, knowledge retained |
| Fetch blocked (robots / allowlist) | source marked `BLOCKED`, never retried aggressively |
| 304 not modified | no snapshot delta, no cost |
| Whole cycle throws | job run recorded as `FAILED`, scheduler backs off, nothing deleted |
| Platform disappears from a page | **no** capability removal inferred |

`buildHealthReport` turns this into one honest number per subsystem, so degradation is
visible in the Evolution Center instead of silent.

## 10. Data model (future-proof)

There are no `instagramPostId` / `youtubePostId` columns anywhere. Platform-specific data
lives in generic structures:

- `SocialPlatform` — identity, status, declared capabilities, integration state
- `Source` — registry with trust, schedule, health, validators
- `PlatformSnapshot` — immutable point-in-time `PlatformState`
- `EvolutionEvent` — the change log, with deltas, evidence, risk, status
- `ChangeProposal` — reviewable work with actions, affected components, test plan
- `KnowledgeDocument/Version/Chunk/Fact` — versioned, attributed, expiring knowledge
- `PublishedContent` + `PlatformContentReference` (Phase 2) — future-proof publishing

## 11. API surface

### Internal (operator) — technical vocabulary allowed

| Route | Purpose |
| --- | --- |
| `GET /api/health` | per-subsystem health + alerts |
| `GET /api/platforms` | platform directory |
| `GET /api/platforms/:id` | capabilities, readiness, UI config, timeline, knowledge |
| `GET /api/platforms/:id/timeline` | creator-visible evolution timeline |
| `GET /api/platforms/:id/why?capability=` | "why did this change?" with sources |
| `GET /api/sources` | source registry with health and yield |
| `GET /api/evolution/summary` | Evolution Center counters |
| `GET /api/evolution/events` | change log |
| `GET /api/evolution/proposals` | staged changes |
| `POST /api/evolution/proposals/:id/decision` | approve / reject |
| `GET /api/knowledge/search?q=` | answers from maintained knowledge |
| `GET /api/knowledge/documents` | versions, TTLs, source attribution |
| `POST /api/admin/research/run` | trigger one cycle (token-guarded) |
| `GET /evolution-center` | operator dashboard (server-rendered) |

### Creator-facing — plain language only

`server/src/api/creator.ts` is a separate, deliberately narrow surface. It converts internal
state into what a creator needs and nothing else: options, limits, reasons, sources, drafts.

| Route | Purpose |
| --- | --- |
| `GET /api/creator/overview` | home screen in one request |
| `GET /api/creator/coming-soon` | watchlist with readiness |
| `POST /api/creator/validate` | checks a draft against verified limits |
| `POST /api/creator/draft` | structured starting point from platform templates |
| `GET /api/creator/platforms/:slug/why?option=` | "why did this change?" |
| `GET /api/creator/:id/updates` | personalised alerts |

Tests fail the build if any of these responses contain internal vocabulary, and the web app's
server-rendered pages are checked for the same thing.

## 12. Identity, sessions and trust

Identity is deliberately **separate from intelligence**:

```
CreatorAccount  ──link──▶  CreatorProfile
  email, passwordHash,      platformSlugs, goals,
  role, status, failures    usedCapabilityKeys, learned preferences
```

A `CreatorAccount` is who you are and what you may do. A `CreatorProfile` is what the system
knows about you. Learning about a creator must never grant access, and losing an account must
not lose what was learned.

| Concern | Decision |
| --- | --- |
| Password storage | `scrypt` from Node's standard library; N/r/p stored in the hash so they can be raised later |
| Verification | `timingSafeEqual`; a malformed stored hash fails closed |
| Session | opaque 32 random bytes in an HttpOnly cookie; only SHA-256 stored; revocable, expiring |
| Why not JWT | revocation. A self-contained token cannot be withdrawn, and the Evolution Center needs to be able to cut a session instantly |
| CSRF | double-submit token required on every mutating request |
| Lockout | 5 failures → 15 minutes; a missing account burns comparable time |
| Authorisation | one permission table, so "who can do what" is data |

Route rules:

| Surface | Rule |
| --- | --- |
| `/api/creator/*` | session required, scoped to that account's profile |
| `/api/platforms`, `/api/sources`, `/api/evolution/*`, `/api/knowledge/*` | `admin` role or operator token |
| `/evolution-center`, `/api/admin/*` | `admin` role or operator token; refuses to run unprotected in production |
| `/api/health` | open for monitoring; exposes no creator data |

## 13. The model is a contributor, not an authority

When a provider key is configured, a model runs first over documentation text. Everything
about it is defensive:

```
page text ─► model ─► parse ─► validate ─► cap confidence ─► merge with deterministic ─► verification gate
              │          │         │             │                 │
              │          │         │             │                 └─ always runs, so a model adds coverage only
              │          │         │             └─ max 0.8: a model's confidence is not evidence
              │          │         └─ unknown areas and categories are dropped
              │          └─ output must be a JSON array; anything else yields no facts
              └─ failure, timeout or outage ⇒ silent fallback, cycle continues
```

A fact survives only if it quotes the page **verbatim**. Boilerplate never becomes knowledge.
The provider key is read in exactly one place, never logged, never returned by a route, never
echoed in an error, and a test fails the build if a key-shaped string is ever committed.

## 14. The creator app

`apps/web` is React + Vite with three runtime dependencies and one stylesheet. All product
logic lives in `apps/web/src/lib/view-models.ts` as pure functions, so the rules are tested
without a browser; components only render.

```
Shell (nav)
├── HomePage          What's changed, grouped by platform
├── CreatePage        capability-driven creation flow
│   ├── CapabilityPicker   options from uiConfig, disabled ones explain themselves
│   ├── ComposerForm       brief, text, media count, live character counter
│   ├── validation         server-side, against verified limits
│   └── WhyCard            §35 attribution
├── PlatformPage      confirmed vs unavailable, freshness, connection state
├── UpdatesPage       only what affects this creator
└── ComingSoonPage    watchlist with readiness
```

The creation flow contains **no platform name**. It renders whatever
`buildPlatformUiConfig` returns, which is why a newly verified capability appears in the UI
without a frontend change.

In development Vite proxies `/api` to the API on `:4000`; in production the API serves
`apps/web/dist` with an SPA fallback, so there is one origin and no CORS in the product path.

## 15. Deliberate non-goals

- **No AI writes code.** Not by policy, by architecture: there is no code-generation path
  in the repo.
- **No fine-tuning.** Adaptation happens through knowledge retrieval, configuration
  evolution, prompt versioning, the capability registry and evaluation — not by retraining
  a model on user data.
- **No fake generation.** The draft composer is deterministic and says so in its
  `provenance` field. It is never presented as AI output.
- **No dead ends.** An unsupported option is shown disabled with a reason rather than
  hidden, and publishing is never offered for a platform without a verified integration.
- **No invented knowledge.** A live run against platform homepages produced no facts, and the
  system published nothing rather than turning navigation text into knowledge.
- **No real publishing adapters yet.** The registry, the contract and the honest unavailable
  implementation exist; live integrations are gated on verified APIs.
