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

  // ─── Phase 3 (2026-05-25): variant-group mutators ────────────────
  //
  // Plumb through to the same useCallback writers in page.tsx that
  // the main grid view uses (Phase 3.3 + 3.7). Single source of
  // truth — the editor view never redefines variant semantics, it
  // just exposes them through a different UI shell.
  //
  // See `_plans/2026-05-25-editor-view-variant-inspector.md`.
  /** Add a new variant row anchored to `baseIndex`. Auto-promotes
   *  the base into a group on first call. Caps at 4 rows / group. */
  addVariantRow: (baseIndex: number) => void;
  /** Generate the image for the variant at `variantIndex` via the
   *  Atlas Edit route. Async — Inspector should show a busy state
   *  while pending. */
  generateVariantImage: (variantIndex: number) => Promise<void>;
  /** Generate every variant in a group in parallel. Skips variants
   *  already generated and variants without an edit prompt. Surfaced
   *  on the BASE row's Inspector as the "Generate all variants" button.
   *  Async — button should show busy while pending. */
  generateAllVariantsInGroup: (baseRowIndex: number) => Promise<void>;
  /** Delete a variant row and renumber the remaining variants in
   *  the group. Base rows can NOT be deleted via this writer. */
  deleteVariantRow: (variantIndex: number) => void;
  /** Swap a variant row with its previous or next sibling in the
   *  same group. Disabled at group boundaries. */
  moveVariantRow: (variantIndex: number, direction: 'up' | 'down') => void;
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
  /** `user_history.id` for the current production-doc. Required by the
   *  notes feature to scope its REST calls. Pass null when the doc
   *  hasn't been server-persisted yet — the notes dock will hide. */
  docId: string | null;
  rowImages: RowImageStateView[];
  rowVideoClips: Record<number, RowVideoClipView | null>;
  rowOverlays: Record<number, RowOverlayState>;
  rowLockedAsStill: boolean[];
  /** Map of `rowSignature → boolean` for rows whose broll is locked-as-still.
   *  Passed through to BrollCell which keys off the signature, not the
   *  positional index, so the lock survives row-position changes.
   *
   *  Phase 1b sync (2026-06-05): shape widened from `true` to `boolean`.
   *  Explicit `false` means "actively unlocked by the user" — distinct
   *  from absent entries (= never touched). The page's patch effect
   *  forwards both to `payload.flags.rowLockedAsStill` so the server
   *  merge can tell unlock from no-information. Render-side: still
   *  truthy-check (false = unlocked = animate). */
  rowLockSignatures: Record<string, boolean>;
  voiceoverUrl: string;
  voiceoverAlignment?: import('@/lib/elevenlabs').ForcedAlignmentResponse | null;
  brandKit: Partial<BrandKit>;
  animateScenes: boolean;
  suppressLowerThirds: boolean;
  writers?: EditorWriters;
  brollContext?: EditorBrollContext;
}
