# Phase 3 — accounts, sessions, and a model that cannot lie to the product

Two changes. Both are about the same thing: **trust**. Who is asking, and what may they be
believed to have said.

## Delivered

### Identity (`packages/core/src/auth`, `packages/server/src/api/auth.ts`)

| Concern | Decision |
| --- | --- |
| Password storage | scrypt from the Node standard library, no dependency, parameters stored in the hash so they can be raised later |
| Verification | constant-time; a malformed stored hash fails closed rather than erroring |
| Password policy | plain-language problems ("Use at least 10 characters"), mirrored on client and server |
| Sessions | opaque 32-byte tokens; only the SHA-256 is stored, so a leaked database hands out nothing |
| Revocation | server-side, immediate — which is why this is not a self-contained JWT |
| CSRF | double-submit token on every mutating request |
| Lockout | five failures, fifteen minutes; a missing account burns comparable time so it cannot be detected by timing |
| Roles | `CREATOR` / `ADMIN` with a permission table, not scattered role comparisons |
| Registration | can be switched off; duplicate emails get a deliberately vague answer |

**Identity is separate from intelligence.** An account owns a creator *profile* through an
explicit link. Learning about a creator never grants access, and losing an account does not
lose what the system learned.

### Access control

| Surface | Rule |
| --- | --- |
| `/api/creator/*` | requires a session; scoped to that account's profile |
| `/api/platforms`, `/api/sources`, `/api/evolution/*`, `/api/knowledge/*` | admin role, or the operator token |
| `/evolution-center` | admin role, or the operator token |
| `/api/health` | open, because monitoring needs it — and it exposes no creator data |
| `/api/admin/*` | admin role, or the operator token; refuses to run unprotected in production |

A signed-in creator asking for an operator surface gets `403`. An operator token still works
alongside a creator session, so CI and humans can both act.

### Optional model provider (`packages/server/src/ai`, `core/src/extract/model.ts`)

The World Engine can run a model over documentation text. It is treated as an **untrusted
contributor**, not an authority:

- output parsed and validated field by field — unknown areas and categories dropped;
- every fact must quote the page **verbatim** or it is discarded;
- confidences capped at **0.8** — a model's confidence is not evidence;
- page furniture filtered (cookies, login prompts, legal footers);
- the deterministic extractor **always** runs, so a model can only add coverage;
- the same verification gate decides what becomes knowledge;
- failure, timeout or outage falls back silently, and the cycle continues.

The key is read in one place, never logged, never returned, never echoed in errors. A
repository-wide test fails the build if a key-shaped string is ever committed.

## Verification

```
npm run verify    # eslint (type-checked) + tsc ×3 workspaces + 179 tests
```

| Guarantee | Test |
| --- | --- |
| Hashes round-trip, reject wrong passwords, never store the password | `auth.test.ts` |
| Malformed stored hashes fail closed | `auth.test.ts` |
| Only SHA-256 of the session token is stored | `auth.test.ts` |
| Expired, revoked and forged sessions are all refused | `auth.test.ts`, `auth-api.test.ts` |
| CSRF comparison and enforcement | `auth.test.ts`, `auth-api.test.ts` |
| Lockout after repeated failures | `auth-api.test.ts` |
| Unknown email and wrong password are indistinguishable | `auth-api.test.ts` |
| One creator cannot see another creator's data | `auth-api.test.ts` |
| Creators cannot reach operator data; admins can | `auth-api.test.ts` |
| No route leaks the password hash or a provider key | `auth-api.test.ts`, `ai-provider.test.ts` |
| Model facts without verbatim evidence are dropped | `model-extract.test.ts` |
| Provider failure falls back and the cycle still completes | `ai-provider.test.ts` |
| Sign-in form explains its own rules | `auth.test.ts` (web) |

A live run (`scripts/smoke-auth.mjs`) exercises the real journey: sign up → read own data →
create → CSRF and role refusals → sign out → session invalid.

## What a live run taught us

Running the engine against real platform sites showed that homepage sources rarely state
machine-readable limits. Two fixes came out of it, both now permanent:

- a **boilerplate filter**, so cookie banners and "browser not supported" notices never
  become platform knowledge;
- a **quality gate**, so nothing is published unless a capability or limit was confirmed.

Empty beats wrong. That principle now also governs the model path.

## Deferred to Phase 4

| Area | Why |
| --- | --- |
| Per-platform documentation curation + yield ranking | homepage seeds are honest but low-yield |
| Real publishing adapters | gated on verified APIs |
| Postgres persistence | `PersistencePort` and serialisable state are in place, including accounts and sessions |
| Preference learning with why / forget / reset | needs real creator behaviour from the signed-in app |
| Email verification and password reset | needs an email provider; the hooks are not designed yet |
| Rate limiting per IP on `/api/auth/*` | lockout exists; per-IP throttling is the next hardening step |
| Session storage shared across instances | sessions live in the control plane, which is single-process by design |
