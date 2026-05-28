/**
 * Pure validation for Flex Icon Grid saved-palette input.
 *
 * Lives in its own module (separated from the CRUD lib) so vitest can
 * import the validator directly without dragging in
 * `@vercel/postgres`. The DB-side `flex-icon-grid-saved-palettes-db.ts`
 * re-exports `validateSavedPaletteInput` and `ValidationResult` so
 * existing callers keep their existing import path.
 *
 * Rules (server-authoritative; the panel UI mirrors them client-side
 * to give immediate feedback but the route always re-validates):
 *  - `name` is required, trimmed, non-empty, ≤60 chars.
 *  - `colors` is a non-empty array of 1..30 hex strings (`#RGB` or
 *    `#RRGGBB`).
 *  - Anything outside that shape rejects with an actionable reason
 *    string.
 */

export interface SavedPaletteInput {
  name: string;
  colors: string[];
}

export type ValidationResult =
  | { ok: true; value: SavedPaletteInput }
  | { ok: false; reason: string };

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function validateSavedPaletteInput(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'request body must be an object' };
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { ok: false, reason: 'name is required' };
  if (name.length > 60) return { ok: false, reason: 'name must be at most 60 characters' };
  if (!Array.isArray(o.colors)) return { ok: false, reason: 'colors must be an array' };
  if (o.colors.length === 0) return { ok: false, reason: 'colors must have at least one entry' };
  if (o.colors.length > 30) return { ok: false, reason: 'colors must have at most 30 entries' };
  const colors: string[] = [];
  for (let i = 0; i < o.colors.length; i++) {
    const c = o.colors[i];
    if (typeof c !== 'string' || !HEX_COLOR_RE.test(c)) {
      return { ok: false, reason: `colors[${i}] is not a valid hex colour` };
    }
    colors.push(c);
  }
  return { ok: true, value: { name, colors } };
}
