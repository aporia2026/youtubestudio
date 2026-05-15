"use client";

/**
 * Inline section-zoom controls rendered in each production-doc row.
 *
 * Three knobs:
 *  - "Zoom to" — pick a thumbnail region (or none).
 *  - "Section title" — text shown as a stripe across the top of frame
 *    for the row's full duration.
 *  - "Transition…" — opens a dialog overriding the doc-level
 *    transition kind, speed, and easing for this specific row.
 *
 * Stateless wrt the row data: parent owns the row, this component just
 * fires change handlers per field. The transition dialog manages its
 * own working copy so the user can tinker without immediately writing
 * to the doc (the save happens on "Done").
 *
 * Phase 4 of `_plans/2026-05-13-thumbnail-zoom-section-divider.md`.
 */
import { useMemo, useState } from 'react';
import type {
  ThumbnailTransitionConfig,
  VideoThumbnail,
} from '@/remotion/types';
import { regionColorFor } from './ThumbnailRegionEditor';
import { TransitionDialog } from './TransitionDialog';

// ─── Props ────────────────────────────────────────────────────────────────────

interface SectionRowControlsProps {
  rowIndex: number;
  /** Total row count in the parent doc — used to validate the upper
   *  bound of the "apply to range" picker so the user can't type a row
   *  number past the end of the doc. */
  totalRows: number;
  thumbnail: VideoThumbnail;
  zoomTo: string | undefined;
  sectionTitle: string | undefined;
  transition: ThumbnailTransitionConfig | undefined;
  defaultTransition: ThumbnailTransitionConfig | undefined;
  onChangeZoomTo: (regionId: string | undefined) => void;
  onChangeSectionTitle: (title: string | undefined) => void;
  onChangeTransition: (t: ThumbnailTransitionConfig | undefined) => void;
  /** Apply `title` to every row from `startRow` to `endRow` inclusive
   *  (0-indexed). The parent walks the doc and sets each row's
   *  `section_title` to the same value in one update. */
  onApplyTitleToRange: (startRow: number, endRow: number, title: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SectionRowControls({
  rowIndex, totalRows, thumbnail, zoomTo, sectionTitle, transition, defaultTransition,
  onChangeZoomTo, onChangeSectionTitle, onChangeTransition, onApplyTitleToRange,
}: SectionRowControlsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Inline "apply to range" picker — collapsed by default, expands into
  // a 2-input row when the chip is clicked. State lives here (not in the
  // parent) because it's transient editor UI, not part of the doc.
  const [rangeOpen, setRangeOpen] = useState(false);
  // 1-indexed end row for display; the picker shows the user the same
  // numbers they see in the # column. Default: 4 rows ahead, clamped.
  const [rangeEndDisplay, setRangeEndDisplay] = useState<string>(
    () => String(Math.min(rowIndex + 5, totalRows)),
  );
  // Local section-title draft so typing doesn't fire the parent's save
  // on every keystroke. Commits on blur or Enter. Stays in sync with
  // external changes (e.g. undo from elsewhere) by detecting prop drift
  // inline — the React-recommended alternative to a setState-in-effect.
  const [titleDraft, setTitleDraft] = useState(sectionTitle ?? '');
  const [lastSyncedTitle, setLastSyncedTitle] = useState(sectionTitle ?? '');
  if ((sectionTitle ?? '') !== lastSyncedTitle) {
    setLastSyncedTitle(sectionTitle ?? '');
    setTitleDraft(sectionTitle ?? '');
  }

  const regions = thumbnail.regions;
  const regionIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    regions.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [regions]);

  const zoomRegion = zoomTo ? regions.find(r => r.id === zoomTo) : undefined;
  const zoomColor = zoomRegion ? regionColorFor(regionIndexMap.get(zoomRegion.id) ?? 0) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 150 }}>
      {/* Mini-preview of the assigned region (when one is set). */}
      {zoomRegion && (
        <RegionMiniCrop region={zoomRegion} thumbnail={thumbnail} color={zoomColor ?? '#8b5cf6'} />
      )}

      {/* Zoom to dropdown */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {zoomColor && !zoomRegion && (
          <span
            aria-hidden
            style={{
              width: 8, height: 8, borderRadius: 2,
              background: zoomColor, flexShrink: 0,
              boxShadow: `0 0 0 1px ${zoomColor}66`,
            }}
          />
        )}
        <select
          value={zoomTo ?? ''}
          onChange={(e) => onChangeZoomTo(e.target.value || undefined)}
          disabled={regions.length === 0}
          title={regions.length === 0 ? 'Upload + mark regions on the thumbnail first' : 'Zoom this section into a thumbnail region'}
          style={{
            flex: 1,
            fontSize: 11,
            padding: '4px 6px',
            borderRadius: 4,
            background: 'rgba(255,255,255,0.04)',
            color: regions.length === 0 ? 'var(--text-muted)' : 'var(--text)',
            border: '1px solid rgba(255,255,255,0.10)',
            cursor: regions.length === 0 ? 'not-allowed' : 'pointer',
            minWidth: 0,
          }}
        >
          <option value="">— No zoom —</option>
          {regions.map(r => (
            <option key={r.id} value={r.id}>
              {r.label || `Region ${(regionIndexMap.get(r.id) ?? 0) + 1}`}
            </option>
          ))}
        </select>
      </div>

      {/* Section title input */}
      <input
        type="text"
        placeholder="Section title…"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={() => {
          const next = titleDraft.trim();
          if (next === (sectionTitle ?? '')) return;
          onChangeSectionTitle(next || undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setTitleDraft(sectionTitle ?? ''); (e.target as HTMLInputElement).blur(); }
        }}
        style={{
          fontSize: 11,
          padding: '4px 6px',
          borderRadius: 4,
          background: 'rgba(255,255,255,0.04)',
          color: 'var(--text)',
          border: '1px solid rgba(255,255,255,0.10)',
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />

      {/* Apply title to a row range — collapsed by default. Lets the editor
          fill a whole section with one title in one action instead of
          retyping it on every row. Uses the value currently in the title
          input (titleDraft), not the persisted sectionTitle, so the user
          can type-then-apply in one flow without committing first. */}
      {titleDraft.trim() && !rangeOpen && rowIndex + 1 < totalRows && (
        <button
          type="button"
          onClick={() => setRangeOpen(true)}
          title="Set this section title on a range of rows in one action"
          style={{
            fontSize: 10,
            padding: '3px 6px',
            borderRadius: 4,
            background: 'rgba(34,211,238,0.10)',
            color: '#22d3ee',
            border: '1px solid rgba(34,211,238,0.30)',
            cursor: 'pointer',
            textAlign: 'left',
            alignSelf: 'flex-start',
          }}
        >
          ⤓ Apply to range…
        </button>
      )}

      {rangeOpen && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 6px',
            borderRadius: 4,
            background: 'rgba(34,211,238,0.08)',
            border: '1px solid rgba(34,211,238,0.30)',
            fontSize: 10,
            color: 'var(--text-muted)',
          }}
        >
          <span>Rows {rowIndex + 1}</span>
          <span>→</span>
          <input
            type="number"
            min={rowIndex + 2}
            max={totalRows}
            value={rangeEndDisplay}
            onChange={(e) => setRangeEndDisplay(e.target.value)}
            style={{
              fontSize: 10,
              padding: '2px 4px',
              borderRadius: 3,
              background: 'rgba(0,0,0,0.20)',
              color: 'var(--text)',
              border: '1px solid rgba(255,255,255,0.10)',
              outline: 'none',
              width: 42,
              boxSizing: 'border-box',
            }}
          />
          <button
            type="button"
            onClick={() => {
              const title = titleDraft.trim();
              if (!title) {
                setRangeOpen(false);
                return;
              }
              // Parse + clamp the end-row input. 1-indexed for display;
              // convert to 0-indexed for the callback. Lower bound is the
              // CURRENT row (so the range always includes the originating
              // row); upper bound is the last row in the doc.
              const parsed = parseInt(rangeEndDisplay, 10);
              const endDisplay = Number.isFinite(parsed)
                ? Math.min(Math.max(parsed, rowIndex + 1), totalRows)
                : rowIndex + 1;
              onApplyTitleToRange(rowIndex, endDisplay - 1, title);
              setRangeOpen(false);
            }}
            style={{
              fontSize: 10,
              padding: '3px 6px',
              borderRadius: 3,
              background: 'rgba(34,211,238,0.20)',
              color: '#22d3ee',
              border: '1px solid rgba(34,211,238,0.45)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setRangeOpen(false)}
            style={{
              fontSize: 10,
              padding: '3px 6px',
              borderRadius: 3,
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.10)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Transition override button */}
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        title="Configure how the camera enters/exits this section"
        style={{
          fontSize: 11,
          padding: '6px 8px',
          minHeight: 28,
          borderRadius: 4,
          background: transition ? 'rgba(168,85,247,0.18)' : 'transparent',
          color: transition ? '#c084fc' : 'var(--text-muted)',
          border: `1px solid ${transition ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.10)'}`,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {transition ? '⚙ Custom transition' : '⚙ Transition…'}
      </button>

      {dialogOpen && (
        <TransitionDialog
          title={`Section transition · shot ${rowIndex + 1}`}
          description="Overrides the doc default for this specific row."
          current={transition}
          fallback={defaultTransition}
          resetLabel="Reset to default"
          onSave={(t) => { onChangeTransition(t); setDialogOpen(false); }}
          onReset={() => { onChangeTransition(undefined); setDialogOpen(false); }}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Sub-component: mini cropped preview of the assigned region ────────────────

interface RegionMiniCropProps {
  region: import('@/remotion/types').ThumbnailRegion;
  thumbnail: VideoThumbnail;
  color: string;
}

/**
 * 24px-tall (approximately) crop of the assigned region, scanned from
 * the thumbnail via CSS background-position. Lets the creator confirm
 * at-a-glance which tile a row points at without re-opening the editor.
 */
function RegionMiniCrop({ region, thumbnail, color }: RegionMiniCropProps) {
  // Defend against zero region dimensions (a corrupt persisted region).
  const rw = Math.max(region.w, 1);
  const rh = Math.max(region.h, 1);
  // Preview width caps at 150px (row column is narrow); height scales with aspect ratio
  // but capped to keep rows compact.
  const previewWidth = 150;
  const previewHeight = Math.max(20, Math.min(54, Math.round(previewWidth * (rh / rw))));
  const bgScale = previewWidth / rw;

  return (
    <div
      style={{
        width: previewWidth,
        height: previewHeight,
        backgroundImage: `url(${thumbnail.imageUrl})`,
        backgroundSize: `${thumbnail.width * bgScale}px ${thumbnail.height * bgScale}px`,
        backgroundPosition: `-${region.x * bgScale}px -${region.y * bgScale}px`,
        backgroundRepeat: 'no-repeat',
        border: `1.5px solid ${color}`,
        borderRadius: 3,
      }}
      title={`Zoom target: ${region.label || 'Untitled region'}`}
      aria-label={`Zoom target: ${region.label || 'Untitled region'}`}
    />
  );
}
