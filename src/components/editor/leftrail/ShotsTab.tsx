'use client';

/**
 * Shots tab — Phase 3 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Lists every shot in the doc with its thumbnail, script preview,
 * and duration. Click jumps the selection to that shot (which the
 * inspector and timeline both observe and react to).
 *
 * Thin presentation layer — all data comes from props; no fetches,
 * no state.
 */

import type { ProductionDoc } from '@/remotion/utils';
import { MotionCollageThumb } from '@/components/editor/MotionCollageThumb';
import { TitleCardThumb } from '@/components/editor/TitleCardThumb';
import { ShotKindBadge } from '@/components/editor/ShotKindBadge';
import {
  passes,
  computeCounts,
  isEmptyFilter,
  toggleKind,
  toggleGrouping,
  EMPTY_FILTER,
  type ShotFilter,
  type ShotKind,
  type ShotGrouping,
} from '@/lib/shot-filter';

interface ShotsTabProps {
  rows: ProductionDoc['rows'];
  rowImages: Record<number, string>;
  selection: number | null;
  onSelect: (shotIndex: number) => void;
  /** Phase 3: right-click a shots-tab item. Fires with the shot
   *  index + viewport coords so EditorClient can open its
   *  centralized context menu. */
  onContextMenu?: (shotIndex: number, x: number, y: number) => void;
  /** Filter state — owned by EditorClient and persisted to
   *  localStorage per project. Pass `EMPTY_FILTER` when no filter UI
   *  should appear (e.g. legacy callers). */
  filter?: ShotFilter;
  onFilterChange?: (next: ShotFilter) => void;
}

/** Display strings for the chip strip. Lowercase to read as labels,
 *  not codes — "Titles" / "Collages" / etc. Kept here (not in
 *  shot-filter.ts) because shot-filter is data-only. */
const KIND_LABELS: Record<ShotKind, string> = {
  title: 'Titles',
  collage: 'Collages',
  motion: 'Motion',
  anim: 'Animations',
  stat: 'Stats',
  broll: 'B-Roll',
  blank: 'Blank',
};
const GROUPING_LABELS: Record<ShotGrouping, string> = {
  base: 'Bases',
  variant: 'Variants',
};
/** Chip render order — matches the precedence in `rowKind()` so the
 *  strip reads left-to-right the way a user would scan their video. */
const KIND_ORDER: ShotKind[] = ['title', 'collage', 'motion', 'anim', 'stat', 'broll', 'blank'];
const GROUPING_ORDER: ShotGrouping[] = ['base', 'variant'];

export function ShotsTab({
  rows,
  rowImages,
  selection,
  onSelect,
  onContextMenu,
  filter = EMPTY_FILTER,
  onFilterChange,
}: ShotsTabProps): React.ReactElement {
  // Uniform badge width so single-, double-, and triple-digit shot
  // numbers all line up cleanly — without this, the thumbnail column
  // shifts horizontally when crossing 10 / 100 shots in a project.
  // Sized for the widest number this project will render, not the
  // current row's number.
  const badgeDigits = Math.max(2, String(rows.length).length);
  const badgeMinWidth = 16 + badgeDigits * 8; // 8px per digit at 12px tabular-nums, + 16px chrome

  // Pre-compute per-group sizes so each variant/base row can show
  // its position within the group ("var 2/3", "base · 3 variants")
  // without re-walking the array per render. Pure derivation, no
  // memo — the array walk is O(N) and the row map is rebuilt on
  // every render anyway.
  const groupSizes = new Map<string, number>();
  for (const r of rows) {
    if (r.group_id) {
      groupSizes.set(r.group_id, (groupSizes.get(r.group_id) ?? 0) + 1);
    }
  }

  // Per-kind / per-grouping counts for the chip strip. Computed once
  // here against the full row set (not the filtered subset) so the
  // counts always show how many rows there are of each type — not
  // how many would remain after applying the current filter.
  const counts = computeCounts(rows);
  const filterActive = !!onFilterChange && !isEmptyFilter(filter);
  const showFilterStrip = !!onFilterChange && rows.length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      {showFilterStrip && (
        <FilterStrip
          filter={filter}
          counts={counts}
          onToggleKind={(k) => {
            const next = toggleKind(filter, k);
            console.info('[editor shot-filter] toggle-kind', { kind: k, next });
            onFilterChange?.(next);
          }}
          onToggleGrouping={(g) => {
            const next = toggleGrouping(filter, g);
            console.info('[editor shot-filter] toggle-grouping', { grouping: g, next });
            onFilterChange?.(next);
          }}
          onClear={() => {
            console.info('[editor shot-filter] cleared');
            onFilterChange?.(EMPTY_FILTER);
          }}
        />
      )}
      {rows.map((row, i) => {
        // Apply the filter inline — preserves the original row index
        // (`i`) so clicking shot N in the visible list still resolves
        // to the correct slot in the doc. Hidden rows render `null`
        // rather than being filtered out of the array.
        const groupSizeForRow = row.group_id ? (groupSizes.get(row.group_id) ?? 0) : 0;
        if (filterActive && !passes(row, groupSizeForRow, filter)) return null;
        const thumb = rowImages[i];
        const isActive = selection === i;
        const variantIdx = row.variant_index ?? 0;
        const groupSize = row.group_id ? (groupSizes.get(row.group_id) ?? 0) : 0;
        const isBase = !!row.group_id && variantIdx === 0 && groupSize > 1;
        const isVariant = !!row.group_id && variantIdx > 0;
        const isTitleCard = row.visual_type === 'Title Card';
        // Left-border accent for grouped rows so variant runs read as
        // a visual cluster on the strip. Distinct color from the
        // selection border so the two don't fight.
        const leftAccent = row.group_id
          ? isVariant
            ? '3px solid var(--accent-purple, #7c3aed)'
            : isBase
              ? '3px solid var(--accent-purple-bright, #a78bfa)'
              : 'none'
          : 'none';
        return (
          <button
            key={i}
            type="button"
            onClick={() => {
              onSelect(i);
              console.info('[editor leftrail shots] select', { shotIndex: i });
            }}
            onContextMenu={
              onContextMenu
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.info('[editor leftrail shots] context-menu', { shotIndex: i });
                    onContextMenu(i, e.clientX, e.clientY);
                  }
                : undefined
            }
            className="text-left rounded-md overflow-hidden transition-colors"
            style={{
              background: isActive ? 'var(--editor-accent-soft)' : 'var(--editor-panel)',
              border: '1px solid',
              borderColor: isActive ? 'var(--editor-accent)' : 'var(--editor-edge)',
              borderLeft: leftAccent !== 'none' ? leftAccent : undefined,
            }}
          >
            <div className="flex items-center gap-2 p-1.5">
              {/* Number badge — left of the thumbnail so the shot's
                  ordinal reads independently of the timecode. Tabular
                  nums keep the column flush as digits grow (1 → 99 →
                  180+). Width scales with digit count to avoid
                  jagged-left rows in long projects. */}
              <div
                className="shrink-0 flex items-center justify-center rounded ed-mono tabular-nums font-semibold text-[12px]"
                style={{
                  minWidth: badgeMinWidth,
                  height: 32,
                  padding: '0 4px',
                  background: isActive
                    ? 'var(--editor-accent)'
                    : 'var(--editor-edge)',
                  color: isActive ? '#fff' : 'var(--fg)',
                }}
                aria-hidden
              >
                {i + 1}
              </div>
              <div
                className="shrink-0 rounded overflow-hidden relative"
                style={{ width: 56, height: 32, background: '#000' }}
              >
                {/* Precedence:
                    1. Motion-collage shots → N-panel grid via MotionCollageThumb.
                    2. Static shots with a thumbnail → single image.
                    3. Title-card rows → typography preview (no R2 image
                       exists; the renderer paints text via TitleCardScene).
                    4. Fallback → "no img" placeholder.
                    User report (2026-06-02): title-card rows used to show
                    "no img" / "BLANK" which implied a broken row. */}
                {thumb || (row.motion_collage_panel_urls?.length ?? 0) > 0 ? (
                  <MotionCollageThumb
                    panelUrls={row.motion_collage_panel_urls}
                    grid={row.motion_collage_grid}
                    fallbackImageUrl={thumb}
                    loading="lazy"
                    shotIndex={i}
                  />
                ) : row.visual_type === 'Title Card' ? (
                  <TitleCardThumb
                    title={
                      row.on_screen_text?.trim() ||
                      row.section_title?.trim() ||
                      row.visual_description?.trim() ||
                      row.script_text?.trim() ||
                      'Title card'
                    }
                  />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-[9px] ed-mono"
                    style={{ color: 'var(--fg-muted)' }}
                  >
                    no img
                  </div>
                )}
                {/* Shot-kind badge — overlaid in the top-left corner so
                    every shot communicates its type at a glance. Mirrors
                    the renderer's SceneRouter precedence so the badge
                    matches what the renderer will paint. */}
                <ShotKindBadge
                  shotKind={row.shot_kind}
                  visualType={row.visual_type}
                  pinTopLeft
                />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="text-[10px] tabular-nums ed-mono flex items-center gap-1"
                  style={{ color: isActive ? 'var(--editor-accent)' : 'var(--fg-muted)' }}
                >
                  <span>{row.timecode || '—'}</span>
                  {/* Variant / title-card chips — scan-friendly tiny
                      glyphs so a 171-row doc with 36 variant groups
                      stays readable. Variants and title cards are the
                      two row-types users most often want to find at a
                      glance on the strip. See
                      `_plans/2026-05-27-editor-variants-titles-notes.md`. */}
                  {isBase && (
                    <span
                      className="px-1 py-0 rounded text-[8px] font-semibold"
                      style={{
                        background: 'var(--accent-purple-bright, #a78bfa)',
                        color: '#fff',
                      }}
                      title={`Base of a ${groupSize - 1}-variant group`}
                    >
                      base
                    </span>
                  )}
                  {isVariant && (
                    <span
                      className="px-1 py-0 rounded text-[8px] font-semibold"
                      style={{
                        background: 'var(--accent-purple, #7c3aed)',
                        color: '#fff',
                      }}
                      title={`Variant ${variantIdx} of ${groupSize - 1}`}
                    >
                      v{variantIdx}/{groupSize - 1}
                    </span>
                  )}
                  {isTitleCard && (
                    <span
                      className="px-1 py-0 rounded text-[8px] font-semibold"
                      style={{
                        background: 'var(--accent-blue, #3b82f6)',
                        color: '#fff',
                      }}
                      title="Title card (renders as typography, no image)"
                    >
                      title
                    </span>
                  )}
                </div>
                <div
                  className="text-[11px] truncate"
                  style={{ color: 'var(--fg)' }}
                  title={row.script_text || ''}
                >
                  {row.script_text || row.visual_description || '—'}
                </div>
              </div>
            </div>
          </button>
        );
      })}
      {/* Empty-state notice when the filter hides everything. Without
          this, the user sees just the chip strip and a blank panel
          and might think the project lost its rows. */}
      {filterActive && rows.every((r, i) => {
        const gs = r.group_id ? (groupSizes.get(r.group_id) ?? 0) : 0;
        void i;
        return !passes(r, gs, filter);
      }) && (
        <div
          className="text-[11px] px-2 py-3 text-center rounded"
          style={{
            color: 'var(--fg-muted)',
            background: 'var(--editor-panel)',
            border: '1px dashed var(--editor-edge)',
          }}
        >
          No shots match the current filter.
        </div>
      )}
    </div>
  );
}

/** Chip strip rendered above the shot list when a filter callback is
 *  wired up. Two segments separated by a divider — kind chips first,
 *  grouping chips second — plus a Clear pill when the filter is
 *  active. Zero-count chips are hidden so the strip stays tight. */
function FilterStrip(props: {
  filter: ShotFilter;
  counts: ReturnType<typeof computeCounts>;
  onToggleKind: (k: ShotKind) => void;
  onToggleGrouping: (g: ShotGrouping) => void;
  onClear: () => void;
}): React.ReactElement {
  const { filter, counts, onToggleKind, onToggleGrouping, onClear } = props;
  const active = !isEmptyFilter(filter);
  const visibleKinds = KIND_ORDER.filter((k) => counts.byKind[k] > 0);
  const visibleGroupings = GROUPING_ORDER.filter((g) => counts.byGrouping[g] > 0);

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto pb-1"
      style={{
        scrollbarWidth: 'thin',
        borderBottom: '1px solid var(--editor-edge)',
        paddingBottom: 6,
        marginBottom: 2,
      }}
      role="toolbar"
      aria-label="Filter shots by type"
    >
      <span
        className="text-[10px] ed-mono shrink-0 pr-1"
        style={{ color: 'var(--fg-muted)' }}
      >
        {active ? 'Filter' : `All ${counts.total}`}
      </span>
      {visibleKinds.map((k) => (
        <FilterChip
          key={`k-${k}`}
          label={KIND_LABELS[k]}
          count={counts.byKind[k]}
          selected={filter.kinds.includes(k)}
          onClick={() => onToggleKind(k)}
        />
      ))}
      {visibleKinds.length > 0 && visibleGroupings.length > 0 && (
        <span
          aria-hidden
          className="shrink-0"
          style={{ width: 1, height: 14, background: 'var(--editor-edge)', margin: '0 2px' }}
        />
      )}
      {visibleGroupings.map((g) => (
        <FilterChip
          key={`g-${g}`}
          label={GROUPING_LABELS[g]}
          count={counts.byGrouping[g]}
          selected={filter.grouping.includes(g)}
          onClick={() => onToggleGrouping(g)}
          tone="grouping"
        />
      ))}
      {active && (
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 ml-auto px-1.5 py-0.5 rounded text-[10px] ed-mono"
          style={{
            color: 'var(--fg-muted)',
            background: 'transparent',
            border: '1px solid var(--editor-edge)',
          }}
          title="Clear all filters"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** Single chip. Two tones — `kind` (the default, blue-ish when
 *  selected) and `grouping` (purple, matches the existing base/variant
 *  chips below). Selected state inverts background ↔ text so the chip
 *  reads as "on" even at this small a footprint. */
function FilterChip(props: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
  tone?: 'kind' | 'grouping';
}): React.ReactElement {
  const { label, count, selected, onClick, tone = 'kind' } = props;
  const accent = tone === 'grouping'
    ? 'var(--accent-purple, #7c3aed)'
    : 'var(--editor-accent)';
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 px-1.5 py-0.5 rounded text-[10px] ed-mono whitespace-nowrap transition-colors"
      style={{
        background: selected ? accent : 'transparent',
        color: selected ? '#fff' : 'var(--fg)',
        border: '1px solid',
        borderColor: selected ? accent : 'var(--editor-edge)',
      }}
      aria-pressed={selected}
    >
      {label} <span style={{ opacity: 0.7 }}>{count}</span>
    </button>
  );
}
