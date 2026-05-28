/**
 * Pure validation for Flex Icon Grid saved-starting-template input.
 *
 * Lives in its own module (separated from the CRUD lib) so vitest can
 * import the validator directly without dragging in @vercel/postgres.
 * Mirrors the shape of `flex-icon-grid-saved-palettes-validate.ts`.
 *
 * Rules:
 *  - `name` is required, trimmed, non-empty, ≤60 chars.
 *  - `config` is a non-null object. Deep shape validation happens
 *    later via `parseConfig` on restore — at save time we trust the
 *    panel's own config snapshot.
 */

export interface SavedTemplateInput {
  name: string;
  config: unknown;
}

export type ValidationResult =
  | { ok: true; value: SavedTemplateInput }
  | { ok: false; reason: string };

export function validateSavedTemplateInput(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'request body must be an object' };
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { ok: false, reason: 'name is required' };
  if (name.length > 60) return { ok: false, reason: 'name must be at most 60 characters' };
  if (!o.config || typeof o.config !== 'object') {
    return { ok: false, reason: 'config must be an object' };
  }
  return { ok: true, value: { name, config: o.config } };
}
