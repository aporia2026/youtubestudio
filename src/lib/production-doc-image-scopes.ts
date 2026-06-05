import type { ProductionRow } from '@/remotion/utils';
import type { RowImageStateView } from '@/components/production-doc/editor/types';

/**
 * Scoped image-generation batches for the production-doc redesign.
 * See `_plans/2026-06-05-prodoc-scoped-image-generation.md`.
 *
 * Pure helper: no React, no fetch, no side effects. Drives the
 * "Generate images ▾" dropdown in the RenderDock. Each scope kind
 * matches a subset of `doc.rows`; the dropdown shows live counts so
 * the user knows the blast radius before clicking, and the
 * dispatcher in `page.tsx` iterates the matching indices via the
 * existing per-row generation helpers.
 */
export type ImageScopeKind =
  | 'empty'
  | 'failed'
  | 'animation'
  | 'motion_collage'
  | 'base_variant'
  | 'non_base_variant'
  | 'title_card'
  | 'all';

/** Ordered list used by the dropdown; pure helper so tests can
 *  iterate every scope without enumerating the union by hand. */
export const IMAGE_SCOPE_KINDS: readonly ImageScopeKind[] = [
  'empty',
  'failed',
  'animation',
  'motion_collage',
  'base_variant',
  'non_base_variant',
  'title_card',
  'all',
] as const;

/** State-based scopes (status filter) — `empty` matches rows whose
 *  image is missing; `failed` matches rows whose last generate
 *  errored. */
type RowStatusPredicate = (state: RowImageStateView | undefined) => boolean;

const STATE_PREDICATES: Partial<Record<ImageScopeKind, RowStatusPredicate>> = {
  // `empty` ⇒ no image yet AND not already in flight. We intentionally
  // exclude loading / pending / uploading / editing so the user can't
  // double-fire a row that's already churning. `error` rows are
  // handled by the `failed` scope, not `empty`.
  empty: (s) => !s || s.status === 'idle',
  failed: (s) => s?.status === 'error',
};

/** Type-based scopes (shot-kind / variant-index filter). Picks by
 *  row content, ignoring the current image state — a "Re-generate
 *  motion collages" click hits every motion_collage row regardless
 *  of whether it already has a rendered image. */
type RowTypePredicate = (row: ProductionRow) => boolean;

const TYPE_PREDICATES: Partial<Record<ImageScopeKind, RowTypePredicate>> = {
  animation: (r) => r.shot_kind !== 'motion_collage' && r.visual_type !== 'Title Card',
  motion_collage: (r) => r.shot_kind === 'motion_collage',
  base_variant: (r) => (r.variant_index ?? 0) === 0,
  non_base_variant: (r) => (r.variant_index ?? 0) > 0,
  title_card: (r) => r.visual_type === 'Title Card',
  all: () => true,
};

/**
 * Return the 0-based row indices that match `scope`. Pure: no
 * mutation of inputs, stable order (ascending), no allocations
 * beyond the result array. Defensive against undefined entries in
 * `rowImages` so the helper survives sparse arrays.
 */
export function getRowsMatchingScope(
  rows: readonly ProductionRow[],
  rowImages: ReadonlyArray<RowImageStateView | undefined>,
  scope: ImageScopeKind,
): number[] {
  const matched: number[] = [];
  const statePred = STATE_PREDICATES[scope];
  const typePred = TYPE_PREDICATES[scope];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (statePred && statePred(rowImages[i])) {
      matched.push(i);
      continue;
    }
    if (typePred && typePred(row)) matched.push(i);
  }
  return matched;
}

/**
 * Compute the count for every scope kind in a single O(n) pass.
 * Called from a `useMemo` in `page.tsx` so the dropdown can render
 * live counts without re-walking the doc per item.
 */
export function getAllScopeCounts(
  rows: readonly ProductionRow[],
  rowImages: ReadonlyArray<RowImageStateView | undefined>,
): Record<ImageScopeKind, number> {
  const counts: Record<ImageScopeKind, number> = {
    empty: 0,
    failed: 0,
    animation: 0,
    motion_collage: 0,
    base_variant: 0,
    non_base_variant: 0,
    title_card: 0,
    all: 0,
  };
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const state = rowImages[i];
    for (const kind of IMAGE_SCOPE_KINDS) {
      const statePred = STATE_PREDICATES[kind];
      if (statePred) {
        if (statePred(state)) counts[kind] += 1;
        continue;
      }
      const typePred = TYPE_PREDICATES[kind];
      if (typePred && typePred(row)) counts[kind] += 1;
    }
  }
  return counts;
}

/**
 * True when running `scope` would overwrite existing images on
 * `done` rows. Used by the dropdown to decide whether to fire
 * `window.confirm` before dispatching. `empty` and `failed` are
 * non-destructive by definition (they only hit rows that don't
 * have a usable image). Every other scope can hit `done` rows.
 */
export function scopeOverwritesExistingImages(scope: ImageScopeKind): boolean {
  return scope !== 'empty' && scope !== 'failed';
}

/** Human-readable label for the dropdown. Kept here (not in the
 *  component) so the same string can be used in confirm dialogs
 *  + log lines without drift. */
export function scopeLabel(scope: ImageScopeKind): string {
  switch (scope) {
    case 'empty':            return 'Empty images only';
    case 'failed':           return 'Re-generate failed';
    case 'animation':        return 'Animations only';
    case 'motion_collage':   return 'Motion collages';
    case 'base_variant':     return 'Base variants (anchors)';
    case 'non_base_variant': return 'Non-base variants';
    case 'title_card':       return 'Title cards';
    case 'all':              return 'Re-generate ALL';
  }
}
