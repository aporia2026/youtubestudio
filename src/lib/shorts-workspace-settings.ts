/**
 * Per-workspace Shorts settings. Persisted as JSONB on
 * `workspaces.shorts_settings` (migration 0109).
 *
 * Why JSONB on workspaces:
 *   Matches the pattern of `workspaces.tts_settings` (migration 0089),
 *   explicitly called out as the workspace-scoped settings precedent in
 *   migration 0102's header comment. One column, fully extensible —
 *   Phase 2 (style picker default) and 2.5/2.75 (style-specific prefs)
 *   slot in without another migration.
 *
 * Shape contract:
 *   The reader (`getShortsSettings`) ALWAYS returns a fully-populated
 *   object with defaults filled in for any missing key. Callers never
 *   have to null-check field-by-field. The writer (`updateShortsSettings`)
 *   takes a partial patch and merges over the current row.
 *
 * Defaults documented in §7 Phase 1 settings table of the plan.
 */

// 2026-06-02: this file is intentionally types + pure-normalizer only.
// SQL read/write moved to `shorts-workspace-settings-db.ts` because
// ShortsSettingsPanel (client) imports defaults from here, and
// Turbopack refuses to bundle a client chunk that transitively pulls
// `@vercel/postgres` (which loads `node:async_hooks`). Server callers
// import getShortsSettings / updateShortsSettings from `-db.ts`.

/** Section-medium default behaviour for the toggle. */
export type SectionMediumDefault = 'long_form' | 'short_native' | 'remember_last';

/** Full settings shape — every key non-optional from the reader's POV. */
export interface ShortsWorkspaceSettings {
  /** Auto-fan-out on long-form script save. */
  autoFanOutEnabled: boolean;
  /** How many candidates the auto-fan-out queues per fire (0 effectively disables). */
  autoFanOutCount: number;
  /** Target Short length for Mode A. Clamped to [15, 90]. */
  defaultTargetSecondsModeA: number;
  /** Below this hook score, a candidate gets a "weak hook" tag in the UI. */
  hookScoreThreshold: number;
  /** Each section's default medium when the user has no `?medium=` in the URL.
   *  `remember_last` reads localStorage on the client; server falls back to `long_form`. */
  sectionDefaultMedium: SectionMediumDefault;
}

/** Defaults — change with care; UI reads these to decide whether to
 *  show "(default)" labels next to controls. */
export const SHORTS_SETTINGS_DEFAULTS: Readonly<ShortsWorkspaceSettings> = Object.freeze({
  autoFanOutEnabled: true,
  autoFanOutCount: 3,
  defaultTargetSecondsModeA: 45,
  hookScoreThreshold: 0.6,
  sectionDefaultMedium: 'remember_last',
});

/** Hard bounds. Writer rejects out-of-bound writes. */
const MIN_TARGET_SECONDS = 15;
const MAX_TARGET_SECONDS = 90;
const MIN_FAN_OUT_COUNT = 0;
const MAX_FAN_OUT_COUNT = 5;
const VALID_SECTION_DEFAULTS = new Set<SectionMediumDefault>([
  'long_form',
  'short_native',
  'remember_last',
]);

/** Clamp + defensive parse from an unknown JSONB blob. Used by the
 *  reader AND by the writer's merge step so a bad write never poisons
 *  the row. */
export function normalizeShortsSettings(raw: unknown): ShortsWorkspaceSettings {
  const out = { ...SHORTS_SETTINGS_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

  if (typeof r.autoFanOutEnabled === 'boolean') out.autoFanOutEnabled = r.autoFanOutEnabled;

  if (typeof r.autoFanOutCount === 'number' && Number.isFinite(r.autoFanOutCount)) {
    out.autoFanOutCount = Math.max(
      MIN_FAN_OUT_COUNT,
      Math.min(MAX_FAN_OUT_COUNT, Math.round(r.autoFanOutCount)),
    );
  }

  if (
    typeof r.defaultTargetSecondsModeA === 'number'
    && Number.isFinite(r.defaultTargetSecondsModeA)
  ) {
    out.defaultTargetSecondsModeA = Math.max(
      MIN_TARGET_SECONDS,
      Math.min(MAX_TARGET_SECONDS, Math.round(r.defaultTargetSecondsModeA)),
    );
  }

  if (typeof r.hookScoreThreshold === 'number' && Number.isFinite(r.hookScoreThreshold)) {
    out.hookScoreThreshold = Math.max(0, Math.min(1, r.hookScoreThreshold));
  }

  if (
    typeof r.sectionDefaultMedium === 'string'
    && VALID_SECTION_DEFAULTS.has(r.sectionDefaultMedium as SectionMediumDefault)
  ) {
    out.sectionDefaultMedium = r.sectionDefaultMedium as SectionMediumDefault;
  }

  return out;
}

// SQL functions live in shorts-workspace-settings-db.ts. See the
// comment at the top of this file for the why.
