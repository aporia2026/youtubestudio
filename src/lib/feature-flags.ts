/**
 * Centralised feature-flag reads. Server-side only — the values are
 * resolved at request time on Vercel from `process.env`, so a
 * deployment without the env var set evaluates the flag as `false`.
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
