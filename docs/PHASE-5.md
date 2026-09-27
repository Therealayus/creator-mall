# Phase 5 — the parts that had to be finished

Phases 1 to 4 built the intelligence spine, the creator product, real accounts and the
infrastructure to run it for real. Phase 5 closes the three engines and hardens the edges.
Every claim below is covered by a test; the counts are from `npm run verify`.

| Slice | Commit | What it added |
| --- | --- | --- |
| 5/1a Creator Engine | `67967c0` | generation ports, deterministic renderer, model-backed copy, `POST /api/creator/generate` |
| 5/1b Media library | `9980c5d` | durable asset storage, uploads, library page |
| 5/2 Market Engine | `55ea006` | verified tool catalogue, `GET /api/creator/tools`, Tools page |
| 5/3 Evolution | `0ee9836` | regression runner, draft-on-change, activation gate |
| 5/4 Auth hardening | `58f309f` | per-IP limits, password reset, email verification |

Tests at the end of the phase: **347 server + core, 62 web**.

---

## 5/1 Creator Engine

### What a tool can be

Four ports, so the engine is not welded to one provider:

```ts
CopyGenerator    // hook, body, cta, hashtags
ImageGenerator   // a real SVG poster, or whatever a model returns
VideoGenerator   // a shot list: what to film, for how long, said over what
AudioGenerator   // a narration script with timings
```

`DeterministicGenerator` implements all four and produces usable artifacts on a machine with no
key and no network. It labels itself `creator-mall-renderer-v1` in every asset's provenance,
and `madeWithAI` is only ever true when a model actually wrote something. A rendered poster
that claims to be AI output would be a lie told to a creator about their own work.

`ModelCopyGenerator` wraps a model with validated JSON, a markdown cleanup pass, limit
enforcement, and a fallback to the renderer. A provider failure is logged in one line with no
key material and the creator still gets their post.

### The rule that matters

Generation is refused for any option the platform does not *verifiably* support. The option list
comes from `buildPlatformUiConfig`, which is the same code the web app renders from, so there is
no second answer to drift out of sync.

### The media library

Bytes live behind an `AssetStorage` port. `FileAssetStorage` writes under `DATA_DIR/assets`,
keyed per creator, keeps the content type beside the file, and flattens any path traversal in a
key. Records persist through both backends — the JSON snapshot and a new `cm_media_asset` table
— and the library rehydrates on start, so a restart keeps a creator's work.

Uploads post the file as the request body with its own content type, which means no multipart
parser on either side and a browser can send a `File` directly. The kind is inferred from the
content type, an upload is labelled as the creator's own work rather than ours, and the size is
capped.

---

## 5/2 Market Engine

The Market Engine turns what the World Engine has already verified into a catalogue of tools,
endpoints and official reading. One rule governs it:

> **nothing appears without evidence.**

A tool is refused unless a `CURRENT`, verified claim is backed by an active official or verified
source — and refused again the moment that claim is retracted or that source is deactivated.
Confidence reads `CONFIRMED` only for an official claim from an official source; everything else
is `likely`, which is what it actually is.

There is **no curated partner list, no affiliate placement and no ranking**. That is a
deliberately smaller product than a marketplace. It is the version we can stand behind, and the
alternative is a catalogue that reads as evidence without being any.

---

## 5/3 Evolution: the loop, closed

Two holes, both serious.

**The drafting code existed and was never called.** A platform changed and the system carried on
writing exactly as it always had. Now a verified change drafts the next prompt version and a
proposed template for each capability it touched, idempotently, built from the change's own
deltas. Drafts stay `DRAFT`; templates stay `PROPOSED`.

**A draft could be activated with no evidence at all.** `activate()` had no gate. Now:

```
verified change → draft → run the checks → only then may it go live
```

The checks are mechanical and provable: does the output fit the limit the platform documents,
does it avoid what it was told to avoid, is it a real post rather than a stub. The verdict rules
are strict on purpose:

| Situation | Verdict |
| --- | --- |
| any check failed | `REJECT` — no averaging a failure away |
| a check could not run | `NEEDS_REVIEW` — an untested run is not a pass |
| nothing to test | `NEEDS_REVIEW` — "we tested nothing" is not a pass |
| every check passed | `SAFE` |

Activation is gated on that verdict. A person may overrule it — they may know something a test
cannot — but the decision is recorded as an override, never as a pass.

A design flaw the tests caught and fixed: a case built from a requirement with nothing to assert
could never fail, so a six-character stub scored `SAFE`. Every generated case must now assert
something, and a test enforces it.

With no model configured, every case skips and activation stays closed. A deterministic renderer
is not evidence that a prompt is good.

---

## 5/4 Auth hardening

Account lockout protected one account from being ground down. Three gaps remained.

**Per-IP rate limiting** in front of sign-in, sign-up and reset, with a sliding window, a
`retry-after` a client can wait out, and per-route buckets. `X-Forwarded-For` is only read when
`TRUST_PROXY` says a real proxy sits in front, because a header anyone can set is not a rate
limit.

**Password reset** end to end: single-use token, 30 minute expiry, stored as a SHA-256 hash so a
database leak yields no usable link, and every existing session revoked on success. The response
is identical whether or not the address has an account, so the endpoint cannot be used to
enumerate customers.

**Email verification** with the same token discipline. `REQUIRE_EMAIL_VERIFICATION` was a dead
setting: registration always created an `ACTIVE` account. It now creates a `PENDING` account and
issues a confirmation token, and sign-in waits for it.

One deliberate exemption: reset and verification need no session and no CSRF token, because a
person who cannot sign in is the entire reason those flows exist. The single-use token is the
guard, and it cannot be replayed.

---

## Known gaps

Stated plainly, because a phase document that claims completeness is not worth reading.

- **No mail provider.** `Delivery` is a port whose only implementation writes the link to the log
  and refuses to log a secret in production. Reset and verification are fully functional in
  development but cannot reach a real inbox until a provider is chosen.
- **No live model verification.** The OpenRouter API is blocked from this machine, so model paths
  are covered by stubbed providers. Run `npm run model:check` from an unrestricted network.
- **No live Postgres.** The Postgres path is contract-tested against `FakeSql` and has never run
  against a real database.
- **No live publishing.** `CM_INTEGRATIONS` is empty; adapters are proven with a simulated
  transport and the gate is closed.
- **No real image, video or audio model.** Generated media is deterministic SVG, shot lists and
  scripts, labelled as such. Real providers would implement the same four ports.
- **Tool coverage depends on research.** A platform shows official reading out of the box, but
  only earns a FEATURE or ENDPOINT entry once a verified fact describes one.
