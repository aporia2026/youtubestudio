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
  thumbnail: VideoThumbnail;
  zoomTo: string | undefined;
  sectionTitle: string | undefined;
  transition: ThumbnailTransitionConfig | undefined;
  defaultTransition: ThumbnailTransitionConfig | undefined;
  onChangeZoomTo: (regionId: string | undefined) => void;
  onChangeSectionTitle: (title: string | undefined) => void;
  onChangeTransition: (t: ThumbnailTransitionConfig | undefined) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SectionRowControls({
  rowIndex, thumbnail, zoomTo, sectionTitle, transition, defaultTransition,
  onChangeZoomTo, onChangeSectionTitle, onChangeTransition,
}: SectionRowControlsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
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
