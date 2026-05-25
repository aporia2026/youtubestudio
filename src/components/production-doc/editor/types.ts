/**
 * Read-only prop types for the Editor view. These mirror the in-page
 * state shapes so the editor can consume them without depending on
 * `page.tsx` exports. When Phase 2 deepens the integration we can
 * consolidate these with the page-level definitions.
 */

import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';
import type { BrandKit, ThumbnailTransitionConfig } from '@/remotion/types';
import type { BrollClipRow, BrollStatus } from '@/lib/broll-types';

export interface RowImageStateView {
  status: 'idle' | 'pending' | 'loading' | 'uploading' | 'editing' | 'done' | 'error' | 'search';
  imageUrl?: string;
  searchUrl?: string;
  error?: string;
  source?: 'generated' | 'upload' | 'url' | 'edit';
}

export interface RowVideoClipView {
  status: string;
  videoUrl?: string;
}

/**
 * Writer-side handler bundle for Phase 2. The page builds this bundle
 * once per render with closure-bound mutators and passes it down so the
 * editor accordion bodies can invoke them with the active section's
 * index. Each handler matches the existing in-page signature exactly
 * — the editor view does not introduce new mutation semantics, only a
 * new presentation of the same write surface.
 */
export interface EditorWriters {
  updateRow: (rowIndex: number, patch: Partial<ProductionRow>) => void;
  applyTitleToRange: (startRow: number, endRow: number, title: string) => void;
  applyPillarboxColorToAll: (color: string) => void;
  clearPillarboxOverrides: () => void;
  applyStripeLayoutToAll: (layout: 'overlay' | 'letterbox') => void;
  clearStripeLayoutOverrides: () => void;
  applySceneZoomToAll: (zoom: number) => void;
  clearSceneZoomOverrides: () => void;
  applyRegionZoomPaddingToAll: (paddingPct: number) => void;
  applyTitleCardAsSectionTitle: (titleCardRowIndex: number) => void;

  // B-roll & image cell writers (per-row; editor passes activeSection)
  fetchOverlayForRow: (rowIndex: number, terms: string) => void;
  generateImageForRow: (
    rowIndex: number,
    prompt: string,
    extra?: { onScreenText?: string; sectionTitle?: string; overlayStockTerms?: string },
  ) => void;
  uploadImageForRow: (rowIndex: number, file: File) => void;
  importImageUrlForRow: (rowIndex: number, url: string) => void;
  openEditPanelForRow: (rowIndex: number) => void;
  openOverlayPositionEditorForRow: (rowIndex: number) => void;
  handleBrollClipChange: (
    rowIndex: number,
    clip: { status: BrollStatus; video_url: string | null; duration_seconds?: number | null } | null,
  ) => void;
  toggleRowLock: (rowSignature: string, locked: boolean) => void;
  computeRowSceneDurationMs: (rowIndex: number) => number;
}

/**
 * Identifying / contextual props the BrollCell needs about the parent
 * doc. Bundled into one prop on EditorViewProps for ergonomics.
 */
export interface EditorBrollContext {
  productionDocId: string | null;
  stylePreset: string;
  /** Sparse map of pre-existing broll clip stubs (rowIndex → stub). Mirrors
   *  the page-level `rowBatchStubs` map that BrollCell consumes via
   *  `initialClip`. The page stores `null` for cleared slots; consumers
   *  treat null/undefined identically. */
  rowBatchStubs: Record<number, BrollClipRow | null | undefined>;
  /** Used by SectionStrip's "show transition icon" heuristic when the
   *  default transition is set at the doc level. */
  defaultTransition?: ThumbnailTransitionConfig;
}

/**
 * The full prop bundle the Editor view consumes from `page.tsx`. Phase 1
 * shipped with just the read fields; Phase 2 adds the optional `writers`
 * + `brollContext` bundles. When `writers` is absent the editor renders
 * in read-only mode (Phase 1 fallback).
 */
export interface EditorViewProps {
  doc: ProductionDoc;
  rowImages: RowImageStateView[];
  rowVideoClips: Record<number, RowVideoClipView | null>;
  rowOverlays: Record<number, RowOverlayState>;
  rowLockedAsStill: boolean[];
  /** Map of `rowSignature → true` for rows whose broll is locked-as-still.
   *  Passed through to BrollCell which keys off the signature, not the
   *  positional index, so the lock survives row-position changes. */
  rowLockSignatures: Record<string, true>;
  voiceoverUrl: string;
  voiceoverAlignment?: import('@/lib/elevenlabs').ForcedAlignmentResponse | null;
  brandKit: Partial<BrandKit>;
  animateScenes: boolean;
  suppressLowerThirds: boolean;
  writers?: EditorWriters;
  brollContext?: EditorBrollContext;
}
