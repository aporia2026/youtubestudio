/**
 * Per-field edit tracking helpers — Phase 3 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Every editor command stamps a row's `edited_at` with both the
 * row-level "any" timestamp AND the specific category it touches
 * (image / video / script_text / duration / trim / mute / etc.).
 * Future AI regen-from-doc paths can read these and skip fields
 * the user edited more recently than the regen started.
 *
 * Backward compat: the original Phase 1 shape was a plain ISO
 * string. `readRowEditedAt` normalises both into a uniform object;
 * `stampEditedAt` writes the new structured shape.
 */
import type { RowEditedAt, RowEditedAtCategory } from '@/remotion/utils';

export interface NormalisedRowEditedAt {
  any?: string;
  fields: Partial<Record<RowEditedAtCategory, string>>;
}

/**
 * Read a row's `edited_at` value, accepting both the structured shape
 * (`{ any, fields }`) and the legacy plain-string shape (single
 * ISO timestamp). Returns a uniform object with `any` and `fields`.
 */
export function readRowEditedAt(value: RowEditedAt | string | undefined): NormalisedRowEditedAt {
  if (!value) return { fields: {} };
  if (typeof value === 'string') return { any: value, fields: {} };
  return { any: value.any, fields: { ...(value.fields ?? {}) } };
}

/**
 * Build the new `edited_at` value for a row after a command touched
 * the given category. Stamps both `any` (the row-level marker) and
 * the specific field timestamp. Pass `null` for category if the
 * command can't be categorised (defensive fallback — only `any` is
 * updated).
 *
 * Always returns the structured shape — never a plain string — so
 * the stored data progressively normalises to the new form.
 */
export function stampEditedAt(
  current: RowEditedAt | string | undefined,
  category: RowEditedAtCategory | null,
): RowEditedAt {
  const now = new Date().toISOString();
  const base = readRowEditedAt(current);
  const fields: Partial<Record<RowEditedAtCategory, string>> = { ...base.fields };
  if (category) {
    fields[category] = now;
  }
  return { any: now, fields };
}
