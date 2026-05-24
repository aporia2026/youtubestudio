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
