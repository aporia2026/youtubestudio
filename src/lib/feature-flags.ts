/**
 * Centralised feature-flag reads. Server-side only — the values are
 * resolved at request time on Vercel from `process.env`. Two patterns
 * live here:
 *
 *   - **Default-OFF (opt-in)** flags use `=== 'true'`. Used for
 *     surfaces that should stay dark until we explicitly enable
 *     (debug panels, gated UI, in-flight features). A deployment
 *     without the env var set evaluates as `false`.
 *
 *   - **Default-ON (opt-out)** flags use `!== 'false'`. Used for
 *     uniform infrastructure that should run everywhere unless we
 *     explicitly flip off (e.g. a vendor kill-switch). A deployment
 *     without the env var set evaluates as `true`; the env var only
 *     turns it OFF.
 *
 * For a client-side mirror, expose the value through a server
 * component's prop (don't add `NEXT_PUBLIC_*` mirrors casually — the
 * point of a flag is to keep it dark until we choose otherwise).
 *
 * Pattern: every flag is named after the feature it gates, in
 * UPPER_SNAKE_CASE. Adding a new flag means adding one line here
 * and reading it from the server component that gates the feature.
 */

/**
 * Shot-graph editor (`/edit/[projectId]`).
 *
 * Phase 1 of `_plans/2026-05-18-shot-graph-editor.md`. Default off.
 * Opt-in by setting `EDITOR_V1_ENABLED=true` in the environment
 * (e.g. `.env.local` for development).
 *
 * The route's page-component calls `notFound()` when this is false,
 * which produces the same 404 a non-existent route would — no leak
 * about the editor's existence.
 */
export const EDITOR_V1_ENABLED = process.env.EDITOR_V1_ENABLED === 'true';

/**
 * Client-readable mirror for surfaces that need to conditionally
 * render "Open in editor" buttons / nav entries. Next.js inlines
 * `NEXT_PUBLIC_*` env vars at build time, so changing this requires
 * a rebuild — keep it in sync with `EDITOR_V1_ENABLED` in deploy
 * configs.
 *
 * Why two flags: the SERVER flag gates the route (404s when off).
 * The CLIENT flag gates the UI entry points (hide the link). They
 * need to be set together; only the server flag is load-bearing
 * for security, the client flag is purely UX.
 */
export const EDITOR_V1_PUBLIC = process.env.NEXT_PUBLIC_EDITOR_V1_ENABLED === 'true';

/**
 * Collage tester debug panel (production-doc page) + the dev-only
 * `/api/dev/collage-test` endpoint that backs it.
 *
 * Same two-flag pattern as EDITOR_V1: the SERVER flag
 * (`COLLAGE_TESTER_ENABLED`) gates the dev endpoint (404s when off),
 * the CLIENT flag (`NEXT_PUBLIC_COLLAGE_TESTER`) gates the panel's
 * visibility. The dev endpoint short-circuits to 404 regardless of
 * the client flag, so a leaked client flag can't expose the tester
 * to real users — defence in depth.
 *
 * Both default off. Opt-in by setting `COLLAGE_TESTER_ENABLED=true`
 * and `NEXT_PUBLIC_COLLAGE_TESTER=true` in `.env.local`. See
 * `_plans/2026-05-24-system-upscale-and-collage.md`.
 *
 * Both flags use the `=== 'true'` check (same convention as
 * EDITOR_V1_PUBLIC above) — uniform across the file so an operator
 * setting the flags doesn't have to remember which one takes 'true'
 * vs '1' vs '0'. Anything other than the literal string `'true'`
 * (including unset, '1', 'yes', whitespace) evaluates to off.
 */
export const COLLAGE_TESTER_ENABLED = process.env.COLLAGE_TESTER_ENABLED === 'true';
export const COLLAGE_TESTER_PUBLIC = process.env.NEXT_PUBLIC_COLLAGE_TESTER === 'true';

/**
 * Production-doc redesign V1 (see
 * `_plans/2026-06-04-production-doc-redesign.md`).
 *
 * Default-ON (opt-out) as of R6 (2026-06-05). The production-doc page
 * renders the new two-mode shell — Brief Notebook before generation,
 * Studio Workspace after — in place of today's grid view. Every
 * existing feature stays reachable; the redesign is presentation-only.
 * The page is `'use client'`, so only a public flag is needed.
 *
 * Default-ON pattern (`!== 'false'`): an unset env var evaluates to
 * `true` so the redesign ships on every deploy. To opt back into the
 * legacy grid (rollback path) set
 * `NEXT_PUBLIC_PROD_DOC_REDESIGN_V1=false` in `.env.local` or Vercel
 * env. Next.js inlines `NEXT_PUBLIC_*` at build time, so flipping
 * requires a redeploy.
 *
 * Phase progression (the plan ships across six phases):
 *   R0 — flag + scaffolding (this file)
 *   R1–R5 — progressive surface buildout behind the flag
 *   R6 — flip default to ON (this commit). The legacy grid stays
 *        reachable as a rollback path; a follow-up PR will remove
 *        the legacy code paths and this flag entirely.
 */
export const PROD_DOC_REDESIGN_V1_PUBLIC = process.env.NEXT_PUBLIC_PROD_DOC_REDESIGN_V1 !== 'false';

/**
 * System-wide auto-upscale via Recraft Crisp Upscale (see
 * `src/lib/upscale.ts`). Default-ON kill switch: every cloud image
 * generation flows through the upscale pass unless this is explicitly
 * set to `'false'`. Wired so a Recraft outage can be triaged with a
 * single env change in Vercel, no redeploy.
 *
 * Default-ON pattern: `!== 'false'`, not `=== 'true'`. Anything other
 * than the literal string `'false'` (including unset) keeps upscale
 * running so a missing env var doesn't silently degrade image quality
 * everywhere.
 */
export const AUTO_UPSCALE_ENABLED = process.env.AUTO_UPSCALE_ENABLED !== 'false';

/**
 * Pre-QA self-check (Lever B of the QA hardening plan, see
 * `_plans/2026-05-26-qa-hardening.md`).
 *
 * When enabled, every fresh script in the auto-pipeline goes through
 * one self-criticism pass before the critic panel runs. The generator
 * reads the same rubric the critics use, identifies the weakest
 * section, and rewrites it. The critic panel then sees the
 * self-improved draft.
 *
 * Default OFF for existing workspaces (preserves current cost + latency
 * profile). Turn on by setting `QA_PRE_CHECK_ENABLED=true` in Vercel /
 * `.env.local`. The self-check skips on qa-retry attempts because the
 * fix list from the prior verdict already drives that revision — running
 * a self-check on top would compete with the fix-list directives.
 *
 * Default-OFF pattern (`=== 'true'`): an unset env var evaluates to off
 * so a fresh deploy keeps the current behavior without surprise.
 */
export const QA_PRE_CHECK_ENABLED = process.env.QA_PRE_CHECK_ENABLED === 'true';

/**
 * Critic rubric V2 (Lever A of the QA hardening plan).
 *
 * When enabled, the script-critic skills loader reads `hook-coach.v2.md`,
 * `substance-auditor.v2.md`, and `flow-critic.v2.md` instead of the V1
 * files. The V2 rubrics rebuild the structure with:
 *   - Anchor examples at known score points (100, 70, 40) showing what
 *     each looks like.
 *   - Explicit "lose N points for X" deduction lists per category.
 *   - A self-criticism step at the end where the critic re-reads its own
 *     scoring and asks "would a harsher reviewer score this lower?"
 *
 * Default OFF so existing presets keep their current scoring distribution
 * until you intentionally flip the switch (then watch `/qa-stats`).
 * Setting `QA_RUBRIC_V2_ENABLED=true` in the environment activates V2.
 *
 * The V1 files stay in the repo as the rollback path. The loader resolves
 * the flag at module-init time (file reads are synchronous), so flipping
 * the flag requires a redeploy — which is the right granularity for a
 * change this load-bearing.
 */
export const QA_RUBRIC_V2_ENABLED = process.env.QA_RUBRIC_V2_ENABLED === 'true';

/**
 * Stronger generator prompt (Lever C of the QA hardening plan).
 *
 * When enabled, the auto-pipeline's script generator inlines a short
 * digest of the critic rubric (pulled from SCRIPT_CRITICS at runtime,
 * so it tracks whichever rubric is loaded — V1 or V2) into its system
 * prompt. The generator targets the criteria it knows it will be
 * evaluated against, so the first draft already aims at 100.
 *
 * Pairs with QA_RUBRIC_V2_ENABLED: turning V2 on first means the digest
 * surfaces V2's tighter rubric to the generator. Turning C on without A
 * still helps (the generator sees the V1 rubric digest), but the gain
 * is largest when A and C are both on.
 *
 * Default OFF. Set `QA_GENERATOR_V2_ENABLED=true` in the environment to
 * enable. The recommended rollout sequence (see /qa-stats):
 *   1. Lever B (QA_PRE_CHECK_ENABLED) first — cheapest, fastest signal.
 *   2. Lever A (QA_RUBRIC_V2_ENABLED) — harsher grading.
 *   3. Lever C (QA_GENERATOR_V2_ENABLED) — aim the generator at the new bar.
 */
export const QA_GENERATOR_V2_ENABLED = process.env.QA_GENERATOR_V2_ENABLED === 'true';

// Lever D of the QA hardening plan (nuclear-mode critic model upgrade)
// is configured per-workspace via Settings → QA, not via env vars. The
// runner reads from workspace_model_defaults (scope: 'qa_nuclear_model').
// See src/lib/qa-workspace-settings.ts.

/**
 * Atlas Cloud vendor kill switch (see `src/lib/atlas-cloud-images.ts`
 * + `src/lib/image-gen-dispatch.ts`). Default-ON: any model whose
 * registry spec has `provider: 'atlas'` is reachable from the picker
 * unless this is explicitly set to `'false'`. When off, the picker
 * filters out Atlas options at registry-load time so a vendor outage
 * doesn't surface as a generation failure mid-flow.
 *
 * Pairs with `process.env.ATLAS_CLOUD_API_KEY` — if the key is unset,
 * the dispatcher throws at request time regardless of this flag. The
 * picker also filters Atlas out when the key is unset (UX), so the
 * thrown path is defense in depth for direct API hits.
 *
 * Default-ON pattern: `!== 'false'`, same convention as
 * AUTO_UPSCALE_ENABLED. Setting `ATLAS_CLOUD_ENABLED=false` in Vercel
 * lets us triage an Atlas outage in seconds without a redeploy. See
 * `_plans/2026-05-25-atlas-cloud-gpt-image-2.md`.
 */
export const ATLAS_CLOUD_ENABLED = process.env.ATLAS_CLOUD_ENABLED !== 'false';
