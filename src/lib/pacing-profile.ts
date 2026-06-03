// ---------------------------------------------------------------------------
// Shared pacing-profile parsing.
//
// Three callers need the same "is this a valid pacing profile?" rule:
//
//   1. `/api/generate/production-doc` route — whitelists the body field
//      before passing it to `productionDocPrompt`.
//   2. `/api/auto-pipeline/presets` + `[id]` routes — validate the
//      preset POST/PATCH body before INSERT/UPDATE.
//   3. `auto-pipeline/stages/generate-production-doc.ts` — falls back
//      to 'fast' when the preset doesn't carry a pick.
//
// One parser, one unit test surface, no risk of any caller drifting
// from the others (or from the page's PacingProfilePanel which
// surfaces the same three values).
//
// See plan `_plans/2026-06-04-pipeline-preset-pacing-profile.md`.
// ---------------------------------------------------------------------------

export type PacingProfile = 'standard' | 'fast' | 'very_fast';

const VALID = new Set<string>(['standard', 'fast', 'very_fast']);

/** Default profile when nothing was specified. Matches the page panel's
 *  visual default and the server-side hardcode that preceded this work. */
export const DEFAULT_PACING_PROFILE: PacingProfile = 'fast';

/**
 * Parse a body / preset field into a known profile string. Unknown
 * input, including empty string / null / undefined / non-string types,
 * returns null — callers decide whether null means "use the default"
 * (route + handler) or "explicitly unset" (preset upsert).
 *
 * Whitespace is not trimmed: the page panel emits canonical lowercase
 * literals and the DB CHECK constraint stores them verbatim, so a
 * stray `'fast '` from an out-of-band caller is treated as invalid
 * rather than silently coerced.
 */
export function parsePacingProfile(raw: unknown): PacingProfile | null {
  if (typeof raw !== 'string') return null;
  return VALID.has(raw) ? (raw as PacingProfile) : null;
}

/** Parse-or-default. Used by the route + handler where null reads
 *  "fall back to the documented default" rather than "preserve unset." */
export function parsePacingProfileWithDefault(raw: unknown): PacingProfile {
  return parsePacingProfile(raw) ?? DEFAULT_PACING_PROFILE;
}
