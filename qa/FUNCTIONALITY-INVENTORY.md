# Functionality inventory

Every user-facing capability in Creator Mall, traced UI → API → backend → DB →
integration. Status is what the code proves, not what the screen suggests.

Method: full-repo grep for fake markers (5 hits, all false positives — HTML
`placeholder=` attributes and a `pendingAlert` name), zero TODO/FIXME, route
inventory from `api/app.ts`, table inventory from `sql/schema.sql`, and
first-hand verification from building the system. Suite: 452 passing.

## Status key

- **IMPLEMENTED** — UI, API, backend, persistence and tests all exist and were
  verified live where possible.
- **PARTIAL** — works end to end for part of the promise; the rest is absent.
- **INERT** — code and data exist but nothing can ever activate or reach them.
- **MISSING** — no UI, no API, no backend.

## Matrix

| Feature | UI | API | Backend | DB | AI / Integration | Real output | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Signup / login / logout | SignInPage | `/auth/register`, `/login`, `/logout`, `/me` | sessions, CSRF, lockout, rate limits | accounts, sessions, links | — | session cookie + profile | IMPLEMENTED |
| Password reset | forgot-password form + `/reset-password` page | `/password-reset`, `/password-reset/confirm` | single-use hashed tokens, session revocation | account fields | no mail provider | new password works | PARTIAL — no email delivery |
| Email verification | `/verify-email` page | `/verify-email` | single-use hashed tokens, PENDING gate | account fields | no mail provider | confirmed flag | PARTIAL — no email delivery |
| OAuth / social login | none | none | none | — | — | — | MISSING |
| Account deletion | none | none | none | — | — | — | MISSING |
| Creator profile + preferences | PersonalisationPage | observations, preferences CRUD, reset | learning engine | observations, preferences, counters | — | learned preferences change recommendations | IMPLEMENTED |
| Deterministic draft composer | CreatePage "Build a starting point" | `/creator/draft` | composer | — | none (deterministic) | hook/body/cta draft | IMPLEMENTED |
| AI copy generation | CreatePage "Make it for me" | `/creator/generate` | model copy + renderer fallback | assets | OpenRouter, stub-tested only | validated copy or honest fallback | PARTIAL — no live model verification possible here |
| Posters / shot lists / narration | CreatePage result panel | `/creator/generate` | deterministic renderer | assets | none (rendered, labelled) | real SVG, shot list, script | IMPLEMENTED |
| Media library | AssetsPage | list/get/upload/delete | file storage, per-creator keys | asset index | — | byte-identical round trip | IMPLEMENTED |
| Limit validation | CreatePage "Check my post" | `/creator/validate` | verified limits | knowledge | — | pass/fail with reasons | IMPLEMENTED |
| Tool catalogue | ToolsPage | `/creator/tools` | verified-facts derivation | knowledge + sources | — | 17 tools, all with evidence | IMPLEMENTED |
| World Engine research | Evolution Center | `/admin/research/run`, scheduler | fetch/parse/extract/verify/classify/store | snapshots, events, knowledge | deterministic proven; model path stub-only | verified facts, events, proposals | PARTIAL — no live network verification possible here |
| Knowledge versioning + TTL | timeline, why views | knowledge routes | version store, expiry | versions, chunks, facts | embeddings computed, never used for retrieval | current vs superseded knowledge | PARTIAL — embedding spend with no retrieval use |
| Source registry + curation | Evolution Center | sources routes, curation action | scoring, probing | sources | — | active/inactive sources with reasons | IMPLEMENTED |
| Capability system | all option lists | via overview/views | registry + taxonomy | platform records | — | options enabled/disabled with reasons | IMPLEMENTED |
| Platform readiness | PlatformPage, HomePage | overview, platforms | readiness profiles | snapshots | — | readiness %, coming-soon list | IMPLEMENTED |
| Evolution proposals | Evolution Center | proposals, decisions | planner, apply | proposals, events | — | approved/rejected with audit trail | IMPLEMENTED |
| Prompt auto-draft + regression gate | Evolution Center prompts list | evaluate, activate | draftNext, runner, gate | prompt versions | model or skip | SAFE/REJECT verdicts; activated body reaches generation | IMPLEMENTED |
| Templates | none (no approval surface) | none | auto-draft as PROPOSED | templates | — | drafts that can never activate | INERT — no approval route exists |
| Publishing adapters | readiness badges only | none (no publish route) | HTTP + simulated adapters | — | no live integrations | gate correctly closed | INERT — contract proven, nothing to call it |
| Notifications feed | UpdatesPage | updates, impact (scoped) | notifyCreators | notifications, impacts | — | read/unread feed | IMPLEMENTED (in-app only; no email/push) |
| Updates timeline + why | PlatformPage | timeline, why | state summaries, evidence | snapshots, events | — | human-readable change history | IMPLEMENTED |
| Coming-soon platforms | ComingSoonPage | coming-soon | readiness staging | platforms | — | data-driven, never invented | IMPLEMENTED |
| Scheduling / calendar | capability key only | none | none | — | — | — | MISSING — no queue, no worker, no calendar |
| Analytics | capability key only | none | none | — | — | — | MISSING — no collection, no dashboard |
| Campaigns / projects | none | none | none | — | — | — | MISSING |
| Content repurposing | none | none | none | — | — | — | MISSING |
| Content editor + versioning | textarea in CreatePage (edit, no save) | none | none | — | — | — | MISSING — edits are not stored |
| Global search | none | `/knowledge/search` (operator) | lexical retrieval | chunks | — | operator-only; no creator search | PARTIAL |
| Trend radar | none | none | none | — | — | — | MISSING |
| Comments / replies / polls / live / DMs | capability keys only | none | none | — | — | — | MISSING as features; present as vocabulary |
| Billing | none | none | none | — | — | — | MISSING |
| Webhooks | none | none | none | — | — | — | MISSING |
| Health / readiness / request IDs | Evolution Center | `/health`, `/ready` | health report | job runs | — | 200/503 semantics, traced slow requests | IMPLEMENTED (no metrics/tracing) |
| Persistence | — | — | JSON file + Postgres contract | 24 tables | — | restart-safe (JSON proven live; Postgres contract-tested, never run live) | PARTIAL — delete-all-then-insert; Postgres unverified live |
| Scheduler + shutdown | — | — | interval loop, persist hook, flush + drain | job runs | — | cycles persist; clean shutdown | IMPLEMENTED |

## What "capability key only" means

`SCHEDULING`, `ANALYTICS`, `COMMENT`, `LIVE`, `POLL` and similar exist as
taxonomy entries so the system can *talk* about platforms that have them. They
drive readiness text and option labels. They are not features. Nothing is
scheduled, no metric is collected, no comment is posted. The distinction is
deliberate: vocabulary lets the product describe reality without inventing it.

## Fake-functionality check

Searched for TODO, FIXME, placeholder, mock, dummy, fake/sample data,
hardcoded responses, `alert(`, lorem, empty handlers, and APIs returning `{}`,
`[]`, `null` or constants. Five hits, all false positives. No fake success
messages, no pretend processing, no hardcoded generated content. Where an
integration cannot run (mail, live model, live publishing, live Postgres), the
code says so and degrades to a real fallback — it does not fake success.
