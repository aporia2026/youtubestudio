# Rebuildable Database + Disaster Recovery

Date: 2026-06-01
Status: Plan (awaiting go-ahead to execute Phase 1)
Branch: claude/video-creation-ui-pqXzS

## Why this exists

On 2026-06-01 a multi-hour Neon outage (incident ES-1952612, AWS us-east-1,
"Project/Branch Operations") took the site down — every server-rendered page
hung because the database was unreachable. While trying to stand up a temporary
database in another region, we discovered the schema **cannot be rebuilt from
migrations alone**: `npm run db:migrate` against a fresh DB fails. See
[[project_db-not-migration-complete]] in memory.

## The root problem

The schema has TWO sources of truth that have drifted and are now mutually
circular:

1. ~90 tables created by ordered SQL migrations in `src/lib/migrations`
   (`0001`..`0107`), run on every Vercel deploy via `vercel-build`.
2. 34 tables created LAZILY at runtime by 17 `ensure*Schema()` functions
   (e.g. `ensureNarratorSchema`, `ensureTeamSchema`, `ensureChannelsSchema`)
   that fire on first feature access from API routes.

The deadlock on a fresh database:
- 40+ migrations `ALTER` / index / FK-reference the lazy-only tables
  (`channels` is touched by 20 migrations, `projects` by 11, `scripts` by 7,
  `narrator_assignments` by 2). On a fresh DB those tables don't exist yet, so
  the migration dies with `relation "..." does not exist`.
- BUT the `ensure*Schema()` functions FK-reference migration-owned tables
  (the function that creates `channels` in `src/lib/db.ts` `REFERENCES
  workspaces`, created by migration `0002`). So "run all ensure funcs first,
  then migrate" breaks the other direction.

Already found + fixed one latent bug en route: migration `0005` swallowed a
failed `UPDATE` (referencing columns only the lazy path creates) inside a bare
JS try/catch; in Postgres that poisons the whole transaction, so the next
statement died with "current transaction is aborted". Fixed with a SAVEPOINT
(uncommitted change in `src/lib/migrations/0005_bootstrap_admin_and_default_workspace.ts`).
More such latent bugs are likely on the from-scratch path.

## Goals

- A brand-new empty Neon Postgres (any region) → fully-working schema in well
  under 10 minutes, reliably, with zero hand-holding.
- A path to recover **data**, not just schema, when the provider itself is down
  (the actual failure mode we hit — Neon's control plane outage means even
  Neon's own PITR/branching was unavailable).
- The existing production database is NEVER disrupted by any of this work.
- The fix is maintainable: drift between schema sources becomes impossible to
  reintroduce silently, not merely absent today.

## Non-goals (for this plan)

- Automatic live failover / hot standby across providers (a much larger HA
  project; revisit only if the reliability bar rises).
- Rewriting the application's data-access layer off `@vercel/postgres`.

## Constraints

- Solo operator. Whatever ships must be low-maintenance and self-verifying.
- App is hard-wired to `@vercel/postgres` (Neon serverless WebSocket driver)
  across 191 files — the replacement DB must be Neon-compatible.
- `pg_dump` / `psql` are NOT installed locally (Windows). Dumps must run from a
  GitHub Actions Ubuntu runner (ships `postgresql-client`) or Neon's console.
- Migrations run automatically on every deploy (`vercel-build`); any change to
  the runner must keep existing production deploys working unchanged.

## Decision — informed by the LLM Council (2026-06-01)

Council was unanimous on the mechanism (Approach C) and on the deeper reframe.
Full verdict captured in the chat transcript; key conclusions:

1. **Approach C (schema baseline snapshot / "squash") is correct.** It breaks
   the circular dependency without editing 40 migrations or untangling FK cycles.
2. **Schema rebuild is NOT disaster recovery** — it yields an EMPTY database.
   Real recovery from a full-provider outage needs **off-Neon logical backups
   (schema + data)**. The baseline is a prerequisite for that, not a substitute.
3. **The baseline is dumped from an already-corrupted prod** (silent-failure
   holes). It must be DIFF-verified against prod, never trusted blind.
4. **`ensure*Schema()` still fires at runtime after restore** — every `ALTER`
   in those functions must be `IF NOT EXISTS` or the first API hit on the new
   region throws "already exists" mid-outage. Must audit.
5. **The durable cure is killing the dual source of truth** — fold the 34 lazy
   tables into migrations and add a CI drift check. Band-aid otherwise.

### Alternatives rejected

- **A — Ensure-first bootstrap** (run all 17 `ensure*Schema()` then migrate):
  blocked by the circular FK dependency; fragile interleaving required.
- **B — Patch every landmine migration defensively** (`ADD COLUMN IF NOT
  EXISTS`, guard each `ALTER`/`INDEX`, `CREATE TABLE IF NOT EXISTS` shims):
  40+ migrations, edits committed history, error-prone, and leaves the
  dual-source drift fully in place. "A multi-day landmine hunt that rots
  instantly."

## Plan (phased — each phase is independently shippable)

### Phase 0 — Prove a faithful baseline is even capturable (the one-thing-first)
1. From a GitHub Actions Ubuntu job (or Neon console), run
   `pg_dump "$PROD_URL" --schema-only --no-owner --no-privileges -f baseline.sql`
   against the **read** path of prod (no writes; non-disruptive).
2. Apply `baseline.sql` to the existing empty **eu-central-1 sandbox**.
3. Diff the rebuilt sandbox schema against prod with `migra` (or `pgdiff`).
4. **Gate:** if the diff is non-empty, the baseline lies — investigate the
   missing/extra objects (likely silent-failure holes like the 0005 bug)
   before proceeding. If empty, the baseline is trustworthy → continue.

### Phase 1 — Bootstrap path for a fresh DB
1. Store the verified `baseline.sql` under `src/lib/migrations/baseline/`.
2. Add `scripts/bootstrap.ts` (and a `db:bootstrap` npm script): if
   `schema_migrations` is empty, apply `baseline.sql`, INSERT `0001`..`<cutoff>`
   into `schema_migrations` as already-applied, then hand off to the existing
   runner which applies only migrations newer than the cutoff.
3. Keep the existing `applyPending` runner unchanged for established DBs (they
   already have all migrations recorded; bootstrap is a no-op there).
4. **Test:** wipe the eu-central-1 sandbox, run `db:bootstrap` from empty, then
   run the full app against it and click through the real flows (production-doc,
   projects, narrator). Proof = working app, not "no errors".

### Phase 2 — Audit the runtime collision
1. Audit all 17 `ensure*Schema()` functions: every `ALTER`/`ADD COLUMN`/index
   must be `IF NOT EXISTS`. Fix any that aren't, so they're safe no-ops against
   a baseline-built DB.

### Phase 3 — Off-Neon data backups (the actual DR)
1. Scheduled GitHub Action: `pg_dump "$PROD_URL"` (schema + data) →
   encrypted upload to R2/S3 (off Neon). Decide retention + RPO with the owner.
2. Document the restore runbook: new Postgres → restore dump → repoint env.
3. **Cost note (rule 8):** GitHub Actions minutes are free at this scale; R2
   storage for compressed dumps is cents/month. Confirm current R2 pricing
   before enabling.

### Phase 4 — Make drift impossible (the durable cure)
1. Incrementally fold the 34 lazy tables into ordered migrations; retire the
   `ensure*Schema()` lazy path.
2. CI check: build a fresh DB from migrations and fail the build if it doesn't
   match the baseline (drift guard). Regenerate the baseline on migration merges.

## Security (rule 13)

- **The schema/data dumps and connection strings are the crown jewels.** Dumps
  run only inside GitHub Actions with the prod URL injected from encrypted
  Actions secrets — never written to the repo, never logged.
- Data backups (Phase 3) MUST be encrypted at rest in R2/S3 and access-scoped to
  a dedicated least-privilege key. A leaked unencrypted dump = full data breach.
- The pasted eu-central-1 sandbox credentials were exposed in chat on 2026-06-01;
  rotate that password (it's a throwaway empty DB, low stakes, but rotate).
- `pg_dump` must use a read-only or read-scoped role against prod where possible.
- No dump artifact is ever committed to git; `.gitignore` the baseline data dump
  paths (the schema-only baseline is safe to commit — no secrets, no rows).

## Open questions for the owner

1. RPO: how much data loss is acceptable in a full-Neon outage? (drives Phase 3
   backup frequency — hourly vs daily.)
2. Is GitHub Actions wired to this repo yet? (Phases 0/3 assume an Actions
   runner for `pg_dump`. If not, we set that up first.)
3. Appetite for Phase 4 (the lazy-pattern refactor) now vs later — it's the real
   cure but the largest chunk of work.

## The one change already on disk

`src/lib/migrations/0005_bootstrap_admin_and_default_workspace.ts` — SAVEPOINT
fix for the transaction-poisoning bug. Correct and low-risk (only affects
from-scratch builds). Keep it; it's Phase 0's first prerequisite.
