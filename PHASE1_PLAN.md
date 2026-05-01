# Phase 1 — Foundation

This document tracks the multi-tenancy + auth + observability foundation work. It is the source of truth for what changes, in what order, and how each piece is verified.

**Goal:** make this app safe to operate with multiple real humans (owner + admin + editors + narrators + reviewers + clients) without any of them seeing data they shouldn't, with every change verified by tests and CI before it lands.

**Constraint:** Vercel hobby tier. Zero new paid services.

---

## Architectural decisions

### Unified user model

A single user/identity table for every human. The existing `collaborators` table is **kept under that name** (renaming would touch 60+ sites: `editor_collaborator_id` and `narrator_collaborator_id` FKs, JOINs in `notify.ts`, `narrator-db.ts`, `editor-db.ts`, `team-db.ts`, `review-db.ts`, `activity-feed.ts`, plus query strings throughout API routes). Instead it is **extended in place** with `password_hash`, `google_sub`, `system_role`, `status`, `last_login_at`, `encrypted_settings`, `invite_token`, `password_reset_token`, etc. The "user" terminology is used in new auth code; existing code continues to say "collaborator". This is a deliberate cosmetic compromise to avoid breakage.

### Two role layers

- `users.system_role`: `admin` | `user`. Admins can access `/admin`.
- `workspace_members.role`: `owner` | `member` | `editor` | `narrator` | `reviewer` | `client`. A user can hold multiple roles in the same workspace.

### Workspace = tenant

One workspace per YouTuber. All data tables get a `workspace_id NOT NULL` column, indexed. Every API query is scoped by workspace via the `requireUser`/`withWorkspace` route helpers. A defense-in-depth tenancy test attempts cross-tenant access on every protected route and asserts 404.

### Token portals coexist with login

`/editor/[token]`, `/narrator/[token]`, `/review/[token]`, `/share/[token]` keep working unchanged — they identify a user by token, no login required. Login is added on top for collaborators who want a dashboard across multiple projects. Admin can issue, regenerate, or revoke tokens.

### Login methods

- Email + bcrypt password
- "Continue with Google" (OAuth) — matches by email; rejects unknown emails
- Forgot password → magic link via SendGrid (already wired)
- **No public signup.** All user creation is admin-only via `/admin`.

The legacy `AUTH_PASSWORD` env var is deprecated. On first boot, if `users` is empty, the runner bootstraps an admin from `ADMIN_EMAIL` + `ADMIN_PASSWORD`. After that the env vars are inert.

### Session

JWT (HS256, jose). Payload includes `{ uid, sysrole, ws }`. Cookie `yt_studio_session`, `httpOnly`, `secure`, `sameSite: 'strict'`.

### Encryption at rest

`src/lib/crypto.ts` (AES-256-GCM) is reused. `ENCRYPTION_KEY` env var becomes mandatory in prod; the legacy fallback to `AUTH_SECRET` is kept for one release with a deprecation warning. The Perplexity API key is migrated out of cookies into `users.encrypted_settings`.

### Rate limiting

Postgres-backed sliding-window token bucket in a `rate_limits` table. Concurrency-safe via atomic `INSERT … ON CONFLICT DO UPDATE SET count = count + 1`. Applied via `withRateLimit` to login, all `/api/generate/*`, all `/api/qa/*`, `/api/upload`, and `/api/admin/*`.

### Observability

- Sentry free tier wired via `instrumentation.ts`, with a `withErrorHandler` route wrapper.
- Structured JSON logger emitting `{ ts, level, requestId, userId, route, msg }` to stdout.
- Request ID generated in middleware, propagated via `x-request-id`.

### Migrations

Numbered files under `src/lib/migrations/`, tracked in a `schema_migrations` table. Runner is sequential, transactional per migration, and acquires a pg advisory lock to prevent concurrent runs. The legacy `ensure*Schema()` helpers stay for one release as deprecated.

### Tests

Vitest. Three layers: unit (pure logic), integration (real test DB, transactional rollback per test), tenancy (auto-generated cross-tenant attack test for every protected route). 100% coverage on `users`, `session`, `crypto`, `rate-limit`, `route-helpers`. ≥80% on admin routes. Smoke on every other route.

### CI

GitHub Actions, single workflow, three parallel jobs: typecheck, lint, test (against a Neon branch DB). Required to merge. Free for our usage.

### Vercel hobby constraints

- Routes default to Node runtime; `maxDuration: 60` where AI generation needs it.
- `/api/generate/script` currently sets a 120s timeout — will be unreachable on hobby (60s max). Flagged as a Phase 2 follow-up to chunk QA or migrate to Edge streaming.
- No background jobs in Phase 1; cron is Phase 2.

---

## Migration sequence

| # | File | What it does |
|---|---|---|
| 0001 | `0001_init_schema_migrations` | Bootstrap + sentinel |
| 0002 | `0002_create_workspaces` | `workspaces` table |
| 0003 | `0003_extend_collaborators_with_auth` | Add `password_hash`, `google_sub`, `system_role`, `status`, `last_login_at`, `encrypted_settings`, `invite_token`, `invite_expires_at`, `password_reset_token`, `password_reset_expires_at`. Partial unique index on `LOWER(email)` where not null. No rename. |
| 0004 | `0004_create_workspace_members` | `workspace_members` table |
| 0005 | `0005_bootstrap_admin_and_default_workspace` | Read `ADMIN_EMAIL`/`ADMIN_PASSWORD`, create admin user, default workspace, owner membership |
| 0006 | `0006_create_narration_take_comments` | Threaded timestamped comments on narrator audio takes (parallel feature work; pre-dates the workspace_id rollout) |
| 0010 | `0010_add_assignment_full_audio` | `narrator_assignments` columns for single-file full-audio narration uploads (parallel feature work) |
| 0011 | `0011_add_workspace_id_columns` | Add nullable `workspace_id` (FK ON DELETE CASCADE) to all data tables |
| 0012 | `0012_backfill_workspace_id` | Set every existing row to bootstrap workspace; deepest-first parent-child resolution for child tables |
| 0013 | `0013_enforce_workspace_id` | `ALTER COLUMN … NOT NULL` and per-table scoping index |
| 0014 | `0014_assign_existing_collaborators` | Map editor/narrator/reviewer assignments to `workspace_members` rows (PR #3) |
| 0015 | `0015_create_rate_limits` | Rate limit storage (PR #7) |
| 0016 | `0016_create_admin_audit_log` | Admin audit log (PR #6) |

> Note: 0007–0009 were originally allocated to this rollout but were renumbered to 0011–0013 after parallel feature work introduced 0006 and 0010 in the same id space. The migration runner enforces strict numerical apply order, so out-of-order numbering would break re-runs after a partial deploy. Keep ids monotonically increasing.

Each migration is wrapped in `BEGIN`/`COMMIT`. The runner refuses to apply a migration if the previous one failed.

---

## PR plan

| PR | Scope | Behavior change? |
|---|---|---|
| **#1** | Plan doc, vitest harness, migration runner, `schema_migrations` table, sentinel migration, runner unit tests | No — infrastructure only |
| **#2** | Migrations 0002–0005: user model + workspaces + bootstrap admin + per-migration tests | DB schema only; app code still uses legacy auth |
| **#2b** | Migrations 0006–0010: `workspace_id` column added, backfilled, enforced NOT NULL on every data table; collaborator → workspace_member assignment | DB schema only; data scoped, app code still doesn't use it |
| **#3** | `users.ts`, `session.ts`, `route-helpers.ts`, new login route (email+password), Google login, password reset, magic-link invites | Login changes for users; AUTH_PASSWORD kept as fallback |
| **#4** | `request-context`, `logger`, `middleware.ts`, tenancy test framework | No behavior change for users |
| **#5** | Edge middleware gates every `/api/*` path behind a valid Phase-1 session (with explicit allow-list for token portals + auth flows). Per-route `WHERE workspace_id` clauses are deliberately staged as a follow-up — invasive across ~120 files but mechanical, no security risk in the meantime because every route is now behind auth. | All authenticated /api/* routes require a valid session; legacy `{authenticated:true}` JWTs rejected. |
| **#6** | `/admin` panel: user CRUD, password reset, suspend/delete, token regen, audit log, workspace management | Admins only |
| **#7** | Postgres-backed rate limiter, Sentry init, GitHub Actions CI, AUTH_PASSWORD fully removed | Failed-login lockouts; logs centralized |

Each PR ships only when CI is green and tests cover the new code.

---

## Rollout

1. Branch the prod Neon DB.
2. Set new env vars: `ENCRYPTION_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SENTRY_DSN`.
3. Deploy preview.
4. `npm run db:migrate` against the branched DB — verify.
5. Smoke test (login as admin, create a user, log in as them, see only their workspace).
6. Promote preview to prod.
7. `npm run db:migrate` against prod DB.
8. Send password reset emails to existing collaborators (admin panel).
9. Monitor Sentry for 24h.

### Rollback

- App: Vercel "promote previous deployment" — instant.
- DB: restore the pre-Phase-1 Neon branch — minutes.
- Each migration is transactional, so partial failures auto-revert.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Migration loses data | DB branch before run; transactional migrations; tested on copy first |
| R2 | A route is missed in the workspace-scope refactor | Auto-generated tenancy test hits every protected route |
| R3 | Existing collaborator tokens break | Token portal routes unchanged; integration test for each |
| R4 | Postgres rate limiter becomes a bottleneck | Atomic upsert is fast; if it ever matters, swap to Upstash free tier (drop-in) |
| R5 | Admin loses password | `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars allow re-bootstrap when `users` is empty |
| R6 | bcrypt cost too high on cold start | Cost factor 11 (~250ms); tune to 10 if needed |
| R7 | Sentry free quota (5k/mo) exhausted | Sample at 0.5 if approached |
| R8 | "Forgot password" email not delivered | Already-wired SendGrid; admin can manually set password as fallback |
| R9 | `/api/generate/script` 120s timeout silently truncates on hobby | Out of Phase 1; Phase 2 follow-up |
