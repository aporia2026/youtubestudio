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

interface ShotsTabProps {
  rows: ProductionDoc['rows'];
  rowImages: Record<number, string>;
  selection: number | null;
  onSelect: (shotIndex: number) => void;
  /** Phase 3: right-click a shots-tab item. Fires with the shot
   *  index + viewport coords so EditorClient can open its
   *  centralized context menu. */
  onContextMenu?: (shotIndex: number, x: number, y: number) => void;
}

export function ShotsTab({ rows, rowImages, selection, onSelect, onContextMenu }: ShotsTabProps): React.ReactElement {
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

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, i) => {
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
                className="shrink-0 rounded overflow-hidden"
                style={{ width: 56, height: 32, background: '#000' }}
              >
                {/* Motion-collage shots show their N-panel grid here so
                    they don't disguise themselves as single static shots.
                    Falls through to a regular single image for static
                    shots (the common case) and to the "no img" placeholder
                    when neither is present. See
                    `_plans/2026-06-02-editor-motion-collage-support.md`. */}
                {thumb || (row.motion_collage_panel_urls?.length ?? 0) > 0 ? (
                  <MotionCollageThumb
                    panelUrls={row.motion_collage_panel_urls}
                    grid={row.motion_collage_grid}
                    fallbackImageUrl={thumb}
                    loading="lazy"
                    shotIndex={i}
                  />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-[9px] ed-mono"
                    style={{ color: 'var(--fg-muted)' }}
                  >
                    no img
                  </div>
                )}
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
    </div>
  );
}
