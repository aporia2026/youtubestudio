# Auto-apply DB migrations on Vercel deploys

**Date:** 2026-05-19
**Status:** Awaiting approval
**Trigger:** Production `/edit/[projectId]` crashed with a generic "Something went wrong" because 4 migrations (0076–0079) had sat pending against the production Neon DB since 2026-05-18. Manual `db:migrate` runs are easy to forget; the schema-vs-code drift only surfaces when a request actually touches a missing column.

## Goal

Eliminate manual migration steps from the deploy flow so the production database can never lag behind the deployed code. After this lands, pushing code that depends on a new column is sufficient to make that column exist in prod — no second action required.

## Constraints

- **Hosting:** Vercel, Next.js App Router. Build runs `npm run build` (no custom build command set today).
- **Database:** Neon Postgres (single DB shared by local dev, preview, and production — flagged separately as its own issue, out of scope here).
- **Runner:** `tsx scripts/migrate.ts up` calls `applyPending()` in [src/lib/migrations/index.ts](src/lib/migrations/index.ts), which:
  - Reads `POSTGRES_URL_NON_POOLING` (preferred) or `POSTGRES_URL`. DDL must NOT use the pooled URL because pgbouncer transaction mode breaks DDL.
  - Holds a `pg_advisory_lock` for the duration so concurrent runs serialize safely.
  - Runs each migration in its own transaction; aborts the whole run on the first failure.
  - Records applied IDs in `schema_migrations`.
- **Migration style today:** every migration uses `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`. They are additive and idempotent. The runner is safe to re-invoke any number of times.
- **Vercel env vars:** Vercel exposes per-environment env vars to builds. `POSTGRES_URL_NON_POOLING` must be present in the Production environment (and preview, if previews also migrate).

## Requirements

- Migrations apply automatically as part of a Vercel deploy.
- If a migration fails, the deploy must fail — the new code must not go live against the old schema.
- Concurrent deploys (e.g. two PRs landing within seconds) must not corrupt state. The advisory lock already gives us this; the new flow must not bypass it.
- Build-time log output should make it obvious which migrations ran, so a failure post-mortem doesn't require a separate Vercel CLI session.
- Existing manual `npm run db:migrate` keeps working for local dev (no regression).

## Options

### Option A — `vercel-build` runs migrations before `next build` (recommended)

Replace the build script in `package.json`:

```jsonc
"scripts": {
  "build": "next build",
  "vercel-build": "tsx --env-file-if-exists=.env.local scripts/migrate.ts up && next build"
}
```

Vercel calls `vercel-build` in preference to `build` when it exists. Every Vercel deploy (preview and production) runs migrations first, then the Next build. If the migration runner exits non-zero, `&&` short-circuits and the Next build never runs — deploy fails closed.

**Why this is the right call:**
- Zero new infra. One line in `package.json`.
- Migration runs **before** any user traffic could hit the new code, because the build hasn't even produced the bundle yet.
- Existing safeguards do the heavy lifting: `pg_advisory_lock` serializes parallel deploys, transactions roll back broken migrations, `IF NOT EXISTS` makes re-runs no-ops.
- Failed migration = failed deploy. The bad state is "old code still serving, no new schema" — exactly what we want when a migration is suspect.
- Build logs already include migration stdout. Searching Vercel build logs for `Applied N migration(s)` is enough to audit the rollout.

**Tradeoffs to know about:**
- Every preview deploy mutates the **same shared Neon DB** because that's the only DB we have. Today's migrations are additive (`IF NOT EXISTS`), so a preview deploying first is invisible to production. But if anyone ever writes a destructive migration (drops a column, renames), shipping it on a preview branch effectively ships it to prod the moment the build runs. This is already the situation with manual `db:migrate`; this option doesn't make it worse, but it doesn't fix it either. The fix is "stop sharing one DB across environments" — separate plan, separate week.
- Adds latency to every deploy. Empirically the existing migration set runs in well under a second per migration, so the impact is negligible unless we ever add a row-rewrite migration.

### Option B — `vercel-build` runs migrations, gated by `MIGRATE_ON_BUILD=true`

Same as A, but the migration step only fires when an env var says so:

```jsonc
"vercel-build": "node -e \"process.exit(process.env.MIGRATE_ON_BUILD==='true'?0:1)\" && tsx --env-file-if-exists=.env.local scripts/migrate.ts up && next build || next build"
```

(Or cleaner: a tiny shell wrapper.) Set `MIGRATE_ON_BUILD=true` only on the Production environment; previews skip the migration step.

**Tradeoffs:**
- Preview branches don't touch the shared DB schema → safer if anyone writes a destructive migration.
- But: preview already hits prod data at runtime (same DB). So previews already "see" production reality. Skipping schema migrations on previews doesn't make them isolated — it just makes them slightly less destructive. Half-fix.
- New env var to maintain across project clones / new Vercel projects. If a dev forgets to set it on a new project, drift returns silently — which is the failure mode we just fixed.
- More complex script, more places to break.

### Option C — GitHub Actions workflow runs migrations on push to main

A `.github/workflows/migrate.yml` that runs `npm run db:migrate` against the prod connection string when `main` is pushed. Decoupled from the Vercel build.

**Tradeoffs:**
- Cleanest separation of concerns. Vercel build doesn't need DB env vars.
- But: GitHub Actions and Vercel run in parallel. There's a window where new code is live and the migration hasn't completed yet → requests for the new column fail. We just fixed exactly that bug; reintroducing the same race in a different form is a regression.
- Could fix with a "wait for migration before promoting" gate, but now we're building deployment orchestration, and we're a small project that doesn't need it.
- Two systems to debug when something breaks (Actions logs + Vercel logs).

### Option D — Rejected: runtime migration on cold start

A guard that calls `applyPending()` on first request to a server function.

**Why rejected:**
- Cold starts get unpredictably slow.
- Fluid Compute reuses instances, but multi-region deploys mean N instances racing to acquire the advisory lock.
- A migration failure shows up as a user-visible 500 instead of a failed deploy.
- Hard to audit "when did the migration actually run."

## Recommendation: Option A

Smallest change, fail-closed, uses every safeguard the runner already has. The preview-deploys-touch-prod-schema concern is a real one but it's an artifact of the single-DB setup, not of this hook — fix it in a separate plan if/when we split environments.

## Implementation

1. **Add `vercel-build` script to [package.json](package.json).** Leave `build` alone so local `npm run build` and CI checks behave unchanged.

   ```jsonc
   "vercel-build": "tsx --env-file-if-exists=.env.local scripts/migrate.ts up && next build"
   ```

2. **Verify `POSTGRES_URL_NON_POOLING` is set on Vercel's Production AND Preview environments.** Production almost certainly has it (the running app needs it). Preview needs explicit verification — if it's missing there, preview builds will fail with the runner's `"POSTGRES_URL_NON_POOLING (preferred) or POSTGRES_URL must be set to run migrations."` error. Either add the env var to Preview (safer DDL connection) or accept the fallback to `POSTGRES_URL` which is also pre-provisioned by the Neon integration.

3. **Smoke test:**
   - Push a no-op commit. Confirm the Vercel build log includes either `No pending migrations.` or `Applied N migration(s):`.
   - Push a commit that adds a trivial migration (`ADD COLUMN IF NOT EXISTS dummy_col TEXT`). Confirm the build log shows it applied, and `db:status` from local confirms it landed.
   - Push a commit with a deliberately broken migration (e.g. `ALTER TABLE nonexistent_table ...`). Confirm the deploy fails and the broken code never goes live. Then revert.

4. **Document in [AGENTS.md](AGENTS.md):** one line under a "Database" section noting that migrations run automatically on Vercel deploy via `vercel-build`. No more "remember to run `npm run db:migrate`" tribal knowledge.

## Security

- **Secret surface:** `POSTGRES_URL_NON_POOLING` is already provisioned to the Vercel build environment for the existing `next build` step (Next.js can read env at build time). This change does not add a new secret.
- **Permission level:** the migration runner uses the same connection string as the app, which currently has full DDL rights on Neon. No privilege escalation.
- **Failure modes:**
  - Bad migration → deploy fails → prod keeps serving old code with old schema. Safe.
  - Network blip during migration → transaction rolls back → migration stays pending → next deploy retries. Safe.
  - Two concurrent deploys → advisory lock serializes them. Safe.
- **Not addressed here (out of scope, but flagged):** preview deploys still mutate the prod schema because there is one shared DB. Anyone writing a destructive migration should know this. A separate plan should split prod/dev/preview into distinct Neon branches or projects.

## Observability

- The runner already writes one stdout line per applied migration (`+ 0079_user_history_version_column`) plus a summary. Vercel captures stdout into the build log. No additional logging needed for this change.
- If a migration fails, the runner throws with a wrapped error including the migration ID and underlying message, plus a `cause`. The Vercel build log shows it as the build failure cause.
- For future debugging: `vercel logs <deployment-url>` after the deploy is the right tool to chase runtime errors. `vercel inspect <deployment-url>` for build-time errors. (Vercel CLI is not installed locally — recommend `npm i -g vercel`.)

## Settings audit (rule 15)

No user-facing settings. This is build infrastructure. Nothing to expose in the app's settings layer.

## Alternatives rejected

- **Option B** (gated by `MIGRATE_ON_BUILD`): half-fix that adds drift risk via forgotten env var.
- **Option C** (GitHub Actions): reintroduces the exact race we just debugged.
- **Option D** (runtime cold-start migration): turns DB problems into user-facing 500s. Anti-pattern.

## Open questions

- Does Preview environment have `POSTGRES_URL_NON_POOLING` set in Vercel? Needs verification before merge — if not, preview deploys will fail until added.
- Are any in-flight migration designs going to involve row rewrites or long-running DDL (`CREATE INDEX CONCURRENTLY`, large table backfills)? If so, the "block the deploy until done" approach has a cap. None of the migrations 0001–0079 cross that threshold, and the project's pattern is "additive, fast." If that ever changes, revisit.

## Definition of done

- `vercel-build` script is committed.
- One preview deploy proves migrations run (or report "No pending migrations") in the build log.
- One main deploy after merge confirms the same in production logs.
- [AGENTS.md](AGENTS.md) has the one-line note.
- No manual `db:migrate` is needed for any future feature work.
