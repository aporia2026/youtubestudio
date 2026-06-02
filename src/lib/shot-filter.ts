/**
 * Editor SHOTS-rail filter — pure helpers.
 *
 * The editor lets the user narrow the shots list to a subset by shot
 * kind (Titles / Collages / Motion / Animations / Statistics / B-Roll /
 * Blank) and variant grouping (Bases / Variants). This module owns the
 * data side of that feature: the `rowKind` / `rowGrouping` discriminants
 * that classify a row, the `passes` predicate, and the localStorage
 * serializer for per-project persistence.
 *
 * The `rowKind` discriminant MUST stay in lockstep with
 * `resolveShotKindLabel` in `src/components/editor/ShotKindBadge.tsx` —
 * if a row's filter discriminant doesn't match its on-thumbnail chip,
 * the user gets a chip that says COLLAGE but a Collages filter that
 * doesn't show it (or vice versa). To prevent drift, both functions
 * branch on the same precedence: shot_kind first, then visual_type.
 *
 * No React deps. Easy to unit-test. See plan
 * `_plans/2026-06-02-editor-shot-type-filter.md`.
 */

import type { ProductionRow } from '@/remotion/utils';

/** Shot-kind discriminant. Matches the chip labels rendered by
 *  `ShotKindBadge` but lowercased so the filter axis is a closed enum
 *  ergonomic to type and to serialize. */
export type ShotKind =
  | 'title'
  | 'collage'
  | 'motion'
  | 'anim'
  | 'stat'
  | 'broll'
  | 'blank';

/** Variant-grouping discriminant. `null` = ungrouped / lone row, which
 *  is neither a base nor a variant and doesn't match either chip. */
export type ShotGrouping = 'base' | 'variant';

export interface ShotFilter {
  /** Empty array = no filter on this axis. */
  kinds: ShotKind[];
  /** Empty array = no filter on this axis. */
  grouping: ShotGrouping[];
}

/** Sentinel "no filter" value. Use this when reading a missing /
 *  corrupt localStorage entry; the predicate short-circuits to "show
 *  everything" when both arrays are empty. */
export const EMPTY_FILTER: ShotFilter = Object.freeze({
  kinds: [] as ShotKind[],
  grouping: [] as ShotGrouping[],
}) as ShotFilter;

/** Classify a row by shot kind. Precedence mirrors
 *  `resolveShotKindLabel` in `ShotKindBadge.tsx`: shot_kind beats
 *  visual_type so a Title-Card row that's actually a motion_collage
 *  still classifies as `collage` (the renderer would paint it that
 *  way). Unknown / Animation rows fall through to `anim`.
 *
 *  Accepts plain strings (not the ProductionRow literal union) so the
 *  badge — which receives strings from React props — can share the
 *  same resolver. The comparisons below narrow at runtime. */
export function rowKind(row: { shot_kind?: string; visual_type?: string }): ShotKind {
  if (row.shot_kind === 'motion_collage') return 'collage';
  if (row.shot_kind === 'motion') return 'motion';
  if (row.visual_type === 'Title Card') return 'title';
  if (row.visual_type === 'Statistics') return 'stat';
  if (row.visual_type === 'B-Roll') return 'broll';
  if (row.visual_type === 'blank') return 'blank';
  return 'anim';
}

/** Classify a row's place in a variant group. Returns `null` when the
 *  row is ungrouped or is a lone "base" of a group of 1 (in which case
 *  there's nothing to differentiate from a regular row).
 *
 *  `groupSize` is the total number of rows sharing this row's
 *  group_id, NOT the count of variants — the caller is responsible for
 *  computing this once per render so we don't walk the array per row.
 *
 *  Matches the chip-rendering rules in `ShotsTab.tsx:59-60`:
 *    - base    ⇔ group_id && variant_index === 0 && groupSize > 1
 *    - variant ⇔ group_id && variant_index > 0
 */
export function rowGrouping(
  row: Pick<ProductionRow, 'group_id' | 'variant_index'>,
  groupSize: number,
): ShotGrouping | null {
  if (!row.group_id) return null;
  const variantIdx = row.variant_index ?? 0;
  if (variantIdx > 0) return 'variant';
  if (variantIdx === 0 && groupSize > 1) return 'base';
  return null;
}

/** Apply a filter to a single row. Both axes use OR within and AND
 *  across — see plan §"Filter predicate". Empty arrays short-circuit
 *  to "axis not constrained". */
export function passes(
  row: Pick<ProductionRow, 'shot_kind' | 'visual_type' | 'group_id' | 'variant_index'>,
  groupSize: number,
  filter: ShotFilter,
): boolean {
  const kindOk = filter.kinds.length === 0 || filter.kinds.includes(rowKind(row));
  if (!kindOk) return false;
  if (filter.grouping.length === 0) return true;
  const grp = rowGrouping(row, groupSize);
  // When the user selected a grouping filter but the row has no
  // grouping, the row is filtered out. This matches user intent:
  // "show me only bases" should not include ungrouped rows.
  return grp !== null && filter.grouping.includes(grp);
}

/** Build per-kind + per-grouping counts for the entire row set in one
 *  pass. Used by the chip strip to show "(N)" next to each label and
 *  to hide zero-count chips. Group sizes are pre-computed once. */
export function computeCounts(
  rows: ReadonlyArray<Pick<ProductionRow, 'shot_kind' | 'visual_type' | 'group_id' | 'variant_index'>>,
): {
  total: number;
  byKind: Record<ShotKind, number>;
  byGrouping: Record<ShotGrouping, number>;
} {
  const groupSizes = new Map<string, number>();
  for (const r of rows) {
    if (r.group_id) groupSizes.set(r.group_id, (groupSizes.get(r.group_id) ?? 0) + 1);
  }
  const byKind: Record<ShotKind, number> = {
    title: 0, collage: 0, motion: 0, anim: 0, stat: 0, broll: 0, blank: 0,
  };
  const byGrouping: Record<ShotGrouping, number> = { base: 0, variant: 0 };
  for (const r of rows) {
    byKind[rowKind(r)] += 1;
    const grp = rowGrouping(r, r.group_id ? (groupSizes.get(r.group_id) ?? 0) : 0);
    if (grp !== null) byGrouping[grp] += 1;
  }
  return { total: rows.length, byKind, byGrouping };
}

/** True when the filter is wide-open (matches everything). Used to
 *  hide the "Clear" pill so it only appears when there's something to
 *  clear. */
export function isEmptyFilter(filter: ShotFilter): boolean {
  return filter.kinds.length === 0 && filter.grouping.length === 0;
}

/** Toggle a kind in the filter, immutable. Returns a new filter with
 *  the kind added if absent, removed if present. Result arrays are
 *  sorted so localStorage values stay canonical (and tests compare
 *  with deep equality cleanly). */
export function toggleKind(filter: ShotFilter, kind: ShotKind): ShotFilter {
  const has = filter.kinds.includes(kind);
  const next = has ? filter.kinds.filter((k) => k !== kind) : [...filter.kinds, kind].sort();
  return { kinds: next, grouping: filter.grouping };
}

/** Toggle a grouping in the filter, immutable. Mirrors `toggleKind`. */
export function toggleGrouping(filter: ShotFilter, grouping: ShotGrouping): ShotFilter {
  const has = filter.grouping.includes(grouping);
  const next = has ? filter.grouping.filter((g) => g !== grouping) : [...filter.grouping, grouping].sort();
  return { kinds: filter.kinds, grouping: next };
}

/** Canonical JSON serializer for localStorage. Sorted arrays in,
 *  sorted arrays out — equal filters always produce equal strings. */
export function serializeFilter(filter: ShotFilter): string {
  return JSON.stringify({
    kinds: [...filter.kinds].sort(),
    grouping: [...filter.grouping].sort(),
  });
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  'title', 'collage', 'motion', 'anim', 'stat', 'broll', 'blank',
] satisfies ShotKind[]);
const VALID_GROUPINGS: ReadonlySet<string> = new Set([
  'base', 'variant',
] satisfies ShotGrouping[]);

/** Defensive parse — never throws, never returns garbage. If the
 *  stored value is malformed (older schema, hand-edited localStorage,
 *  partial write), we return EMPTY_FILTER and let the caller move on.
 *  Unknown kinds are silently dropped so adding a new kind doesn't
 *  invalidate stored filters from older deployments. */
export function parseFilter(raw: string | null | undefined): ShotFilter {
  if (!raw) return EMPTY_FILTER;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_FILTER;
    const obj = parsed as { kinds?: unknown; grouping?: unknown };
    const kindsIn = Array.isArray(obj.kinds) ? obj.kinds : [];
    const grpIn = Array.isArray(obj.grouping) ? obj.grouping : [];
    const kinds = kindsIn.filter((k): k is ShotKind => typeof k === 'string' && VALID_KINDS.has(k));
    const grouping = grpIn.filter((g): g is ShotGrouping => typeof g === 'string' && VALID_GROUPINGS.has(g));
    return {
      kinds: [...new Set(kinds)].sort(),
      grouping: [...new Set(grouping)].sort(),
    };
  } catch {
    return EMPTY_FILTER;
  }
}

/** localStorage key for a project's filter. Keyed by project so each
 *  video keeps its own filter state independently. */
export function filterStorageKey(projectId: string): string {
  return `editor:shot-filter:${projectId}`;
}
