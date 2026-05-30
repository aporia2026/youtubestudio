/**
 * Pure validation for the saved-style-preset POST payload, shared by
 * the Topic Card Grid and N Levels saved-presets routes.
 *
 * Lives in its own module (separated from the CRUD libs) so vitest can
 * import the validator directly without dragging in @vercel/postgres.
 * Same shape as `flex-icon-grid-saved-templates-validate.ts`.
 *
 * Rules:
 *  - `name` is required, trimmed, non-empty, ≤60 chars.
 *  - `preset` is a non-null object. Deep shape validation happens later
 *    at apply time via the panel's coerce helpers — at save time we
 *    trust the panel's own preset snapshot (the same trust model the
 *    Flex Icon Grid saved-templates validator uses).
 *  - The whole serialised payload must be ≤16 KB to protect against
 *    accidental or malicious blob explosion. 16 KB comfortably covers
 *    the full PanelPostProcessState + PanelTitleBarState shape (under
 *    1 KB in practice) with three orders of magnitude of headroom.
 */

export interface SavedPresetInput {
  name: string;
  preset: unknown;
}

export type SavedPresetValidationResult =
  | { ok: true; value: SavedPresetInput }
  | { ok: false; reason: string };

/** Maximum serialised preset payload bytes. The actual postProcess +
 *  titleBar shape sits well under 1 KB; the cap is a defensive belt
 *  against blob explosion from a stale or hostile client. */
export const SAVED_PRESET_MAX_PAYLOAD_BYTES = 16 * 1024;

/** Maximum preset name length. Matches the Flex Icon Grid
 *  saved-template cap so users see the same limit across formats. */
export const SAVED_PRESET_MAX_NAME_LENGTH = 60;

export function validateSavedPresetInput(raw: unknown): SavedPresetValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'request body must be an object' };
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { ok: false, reason: 'name is required' };
  if (name.length > SAVED_PRESET_MAX_NAME_LENGTH) {
    return {
      ok: false,
      reason: `name must be at most ${SAVED_PRESET_MAX_NAME_LENGTH} characters`,
    };
  }
  if (!o.preset || typeof o.preset !== 'object') {
    return { ok: false, reason: 'preset must be an object' };
  }
  // Defensive size cap. JSON.stringify is the right measure because that's
  // exactly what hits Postgres via the `::jsonb` cast in the DB layer —
  // matches the byte budget the database column will actually receive.
  const serialised = JSON.stringify(o.preset);
  if (serialised.length > SAVED_PRESET_MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      reason: `preset payload too large (${serialised.length} bytes; max ${SAVED_PRESET_MAX_PAYLOAD_BYTES})`,
    };
  }
  return { ok: true, value: { name, preset: o.preset } };
}
