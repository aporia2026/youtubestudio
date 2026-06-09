'use client';

/**
 * Shot inspector — the side panel for a selected shot.
 *
 * Phase 3 of `_plans/2026-05-18-shot-graph-editor.md`. Hosts the
 * editing surfaces that don't make sense on the timeline strip
 * itself: script text, visual description, AI image prompt, replace
 * media buttons, regenerate-shot, rewrite-script-with-AI.
 *
 * Each Phase 3 follow-up commit lands one capability here:
 *
 *   ✓ Upload an image           — this commit
 *     · Pick a clip from project  (next)
 *     · Regenerate from prompt    (after that)
 *     · Rewrite script-with-AI    (final Phase 3 commit)
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Sparkles, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatI2ICostHint } from '@/lib/image-models-i2i';
import type { ProductionDoc, RowOverlayRenderState } from '@/remotion/utils';
import { computeAutoShiftYPct } from '@/remotion/utils';
import type { ThumbnailTransitionConfig, VideoShot, VideoThumbnail } from '@/remotion/types';
import { BROLL_MODELS } from '@/lib/broll-types';
import { useLocalStudioEnabled } from '@/lib/local-studio-enabled';
import { ShotImageModelPicker } from './inspector/ShotImageModelPicker';
import { ShotLayoutControls } from '@/components/editor/inspector/ShotLayoutControls';
import {
  InspectorVariantsPanel,
  type VariantGenState,
} from '@/components/editor/inspector/InspectorVariantsPanel';
import { OstModeControl } from '@/components/production-doc/OstModeControl';
import { InspectorMotionCollagePanel } from '@/components/editor/inspector/InspectorMotionCollagePanel';
import { InspectorTextBlocksPanel } from '@/components/editor/inspector/InspectorTextBlocksPanel';
import { ConvertToMotionCollageButton } from '@/components/editor/inspector/ConvertToMotionCollageButton';
import {
  InspectorShotTypePanel,
  detectLeadingHeading,
} from '@/components/editor/inspector/InspectorShotTypePanel';
import { InspectorNotesPanel } from '@/components/editor/inspector/InspectorNotesPanel';
import { TransitionDialog } from '@/components/production-doc/TransitionDialog';

/** A clip from /api/broll. Trimmed to the fields the picker needs. */
interface ProjectClip {
  id: string;
  video_url: string | null;
  duration_seconds: number | null;
  prompt: string;
  model_id: string;
  aspect_ratio: string;
  status: string;
  row_index: number | null;
}

interface ShotInspectorProps {
  shotIndex: number;
  shot: VideoShot;
  row: ProductionDoc['rows'][number];
  /** Parent doc — needed for doc-level defaults that the smart
   *  auto-shift recommendation reads (section_title_layout_default,
   *  doc.thumbnail.stripeHeightFraction). */
  doc: ProductionDoc;
  /** rowImages[shotIndex] — first-frame thumbnail URL when present. */
  thumbnailUrl: string | null;
  totalShots: number;
  /** The user_history.id this project is keyed by. Used to scope
   *  the broll_clips list to clips from this doc. */
  projectId: string;
  /** v2 (2026-05-22) — the doc's active style preset id. Threaded
   *  through so the regenerate-shot button can route ref-bearing
   *  generations to the v2 i2i dispatcher. Undefined → regen falls
   *  back to plain text-to-image. May be a built-in slug or a
   *  saved-style UUID. */
  stylePreset?: string;
  /** PR 4 of `_plans/2026-06-02-editor-motion-collage-support.md`.
   *  Built-in slug `stylePreset` resolves to (for saved-style UUIDs,
   *  this is `based_on_built_in`). Same value `productionDocToVideoConfig`
   *  receives via PR 1 of the OST plan. Threaded through so the
   *  Convert to motion collage button can fire on saved styles
   *  derived from doodle_explainer_2, not just the literal slug. */
  effectiveStyleSlug?: string;
  /** v2 (2026-05-22) — the active style's preferred i2i model id,
   *  resolved by the parent (EditorClient does one styles fetch on
   *  mount and finds the match). Used here purely for the cost-preview
   *  label next to the Regenerate button (rule 8). Null when the
   *  active style is a built-in or has no preferred model. */
  activeStyleI2IModel?: string | null;
  onClose: () => void;
  /** Called with the new R2 URL after a successful upload. The
   *  caller dispatches SET_ROW_IMAGE. */
  onUploadImage?: (url: string) => void;
  /** Called when the user picks a clip from the project's broll
   *  library. The caller dispatches SET_ROW_VIDEO. Pass `null` for
   *  videoUrl to clear an existing pick. */
  onPickProjectClip?: (videoUrl: string | null, durationSeconds: number | null) => void;
  /** Called when the user clicks "Generate animation" — kicks off a
   *  fresh B-roll clip generation for this row using the workspace's
   *  default model. The caller manages the polling lifecycle and
   *  pushes status updates into the editor's `rowVideoClips` state
   *  via SET_ROW_VIDEO_CLIP. */
  onGenerateClip?: () => void;
  /** Cancel an in-flight B-roll clip generation for this row. The
   *  caller clears the row's `rowVideoClips` entry so the poll loop
   *  stops looking for it. The server-side generation may still
   *  complete and be billed, but the UI stops waiting on it. */
  onCancelClip?: () => void;
  /** Live B-roll clip status for this row. Drives the "Generate"
   *  button's label / disabled state — `generating` collapses it
   *  into a busy spinner; `ready` hides it (clip is already there). */
  clipStatus?: string;
  /** Last error message from a failed clip generation. Surfaced as
   *  an inline alert below the Animate button so the user knows what
   *  went wrong. */
  clipError?: string;
  /** Workspace's currently-resolved B-roll model id. Surfaced as a
   *  small caption next to the generate button so the user knows
   *  what they're about to spend on. */
  brollModelId?: string;
  /** Doc-level animation model id — applied as the default for every
   *  B-roll cell unless this row has its own pick (`row.broll_model_id`).
   *  Surfaced so the dropdown's "Default" label can show the effective
   *  fallback ("Default — doc setting", "Default — workspace setting"). */
  docBrollModelId?: string;
  /** Doc-level image (still) model id — applied as the default for
   *  every shot's Regenerate unless the row has its own pick
   *  (`row.image_model`). Undefined falls back to `DEFAULT_IMAGE_MODEL`
   *  server-side. Surfaced so the per-shot picker's "Default" label can
   *  show what it resolves to right now. */
  docImageModelDefault?: string;
  /** Called when the user edits the row's voiceover script (inline
   *  textarea OR via the AI rephrase button). Dispatches
   *  SET_ROW_SCRIPT. */
  onUpdateScript?: (text: string) => void;
  /** Called when the user edits any other row field inline (visual
   *  description, AI image prompt, on-screen text, section title).
   *  Dispatches PATCH_ROW so each edit lands on the undo stack and
   *  auto-save picks it up. */
  onUpdateRow?: (patch: Partial<ProductionDoc['rows'][number]>) => void;
  /** 2026-06-09 — promote the row's image-model pick to the doc-level
   *  default. Fed into the per-row `ShotImageModelPicker`'s
   *  `onSaveAsDefault` so the user can change the doc-wide default
   *  from inside the inspector without hunting for the doc-defaults
   *  sidebar panel. The EditorClient parent wires this to a
   *  `PATCH_DOC { image_model_default: modelId }` apply. Optional —
   *  when omitted the button is hidden. */
  onSetDocImageModelDefault?: (modelId: string) => void;
  // ─── Phase 5.2 overlay-port — props for the overlay control surface ──
  /** The row's current overlay state (URL + status). When absent or
   *  not `done`, the overlay section in the inspector hides its
   *  action buttons (nothing to position / edit / rethink yet). */
  overlayState?: RowOverlayRenderState;
  /** True while a rethink request is in flight for this row — the
   *  Rethink button collapses to a busy state. */
  isRethinkingOverlay?: boolean;
  /** True when this row has burned its session rethink budget — the
   *  Rethink button greys out with a "reload to reset" tooltip. */
  rethinkExhausted?: boolean;
  /** Number of prior overlay URLs on the row's `overlay_edit_history`
   *  stack. 0 hides Undo; ≥2 surfaces the count badge. */
  editHistoryDepth?: number;
  /** Open the position editor (drag-and-drop + 8 resize handles). */
  onOpenOverlayPosition?: () => void;
  /** Open the AI image-edit dialog (Smart edit / Brush mask). */
  onOpenOverlayEdit?: () => void;
  /** Re-run vision placement on the current overlay. */
  onRethinkOverlay?: () => void;
  /** Pop the row's edit-history stack — undo the most recent AI edit. */
  onUndoOverlayEdit?: () => void;
  /** Open the right-click context menu at the cursor coords. The
   *  parent renders OverlayContextMenu at the given (x, y). */
  onShowOverlayContextMenu?: (x: number, y: number) => void;
  // ─── Batch C: per-shot polish ──────────────────────────────────
  /** Doc-level fallbacks for the layout controls so the "inherits"
   *  hint shows the right effective value. */
  docSectionTitleLayoutDefault?: 'overlay' | 'letterbox';
  docPillarboxColorDefault?: string;
  docSceneZoomDefault?: number;
  docSceneFadeDefault?: boolean;
  /** Doc-level fallback for region zoom padding (percent of the
   *  region's longest edge). Falls back to 15 when undefined. */
  docRegionZoomPaddingDefaultPct?: number;
  /** Doc-level fallback for per-row on-screen-text mode. Surfaced in
   *  the layout accordion's tri-state radio so the "Default" pill
   *  shows the effective mode (e.g. "Default (overlay)"). */
  docOnScreenTextModeDefault?: 'overlay' | 'bake' | 'none';
  /** Optional: bulk-apply THIS row's free-transform to every shot in
   *  the doc. Surfaces an "Apply to all" link in the Transform card.
   *  When undefined the link is hidden. */
  onApplyTransformToAll?: (transform: {
    image_x_pct?: number;
    image_y_pct?: number;
    image_scale_pct?: number;
    image_rotation_deg?: number;
  }) => void;
  // ─── Layout bulks (`_plans/2026-05-25-editor-bulk-apply-actions.md`) ──
  //
  // Forwarded to ShotLayoutControls. Each pair targets one of the five
  // per-row layout fields. Optional — when undefined, the matching
  // affordance hides itself. See ShotLayoutControlsProps for the
  // semantics (Apply-to-all sets the doc default; Clear-overrides
  // wipes per-row overrides via PATCH_ROW).
  onApplySectionTitleLayoutToAll?: (layout: 'overlay' | 'letterbox') => void;
  onClearSectionTitleLayoutOverrides?: () => void;
  onApplyPillarboxColorToAll?: (color: string) => void;
  onClearPillarboxColorOverrides?: () => void;
  onApplySceneZoomToAll?: (zoom: number) => void;
  onClearSceneZoomOverrides?: () => void;
  onApplySceneFadeToAll?: (sceneFade: boolean) => void;
  onClearSceneFadeOverrides?: () => void;
  onApplyOstModeToAll?: (mode: 'overlay' | 'bake' | 'none' | undefined) => void;
  onClearOstModeOverrides?: () => void;
  /** Open the mask-brush image edit dialog for this shot. The parent
   *  mounts MaskBrushEditor + calls the image-edit endpoint. */
  onOpenImageEdit?: () => void;
  /** Phase 5 of `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
   *  Per-shot AI verbs surfaced as a quick-actions strip at the top
   *  of the inspector so a lazy user can reach them without
   *  right-clicking. All three are optional; the strip hides
   *  itself when neither the shot has an image nor any handler is
   *  wired. */
  onRunRmbg?: () => void;
  onRestoreOriginalBackground?: () => void;
  /** True when an RMBG call is in flight for this shot. The button
   *  disables itself + shows "Removing background…". */
  rmbgInflight?: boolean;
  /** True when this row currently has `image_rmbg_applied === true`.
   *  Flips the button label to "Restore original background". */
  rmbgApplied?: boolean;
  /** True when this row has a stored `image_rmbg_url` (i.e., a
   *  previous run's cutout is on hand). Drives the "Re-apply" copy
   *  variant when applied is false but a cutout is cached. */
  hasRmbgCutout?: boolean;
  // ─── Batch B: section thumbnail region zoom ───────────────────────
  /** The doc's composite section thumbnail (if any). When present and
   *  it has regions, the inspector renders a "Zoom into region" picker
   *  for this shot. */
  docThumbnail?: VideoThumbnail;
  /** Open the section-thumbnail modal (upload / replace / draw
   *  regions). Surfaced as a small "Edit thumbnail" link next to the
   *  picker so the user can create regions without leaving the
   *  inspector. */
  onOpenSectionThumbnail?: () => void;

  // ─── Per-shot regenerate (state lifted to EditorClient) ─────────────
  //
  // The inspector used to own this state locally, but the inspector is
  // a single component instance reused across shots — so Shot A's
  // "generating" state bled onto Shot B when the user navigated, and
  // clicking Regenerate on Shot B aborted Shot A's in-flight call.
  // EditorClient now keeps a shotIndex-keyed map of regen states +
  // controllers and threads the current shot's slice down here.
  /** Current regen state for the displayed shot. `idle` for shots
   *  that haven't been regenerated this session. */
  regenState: ShotRegenState;
  /** Trigger a single-shot regenerate against the active row's prompt.
   *  Always single-image (never a collage) regardless of doc.collage_mode. */
  onRegenerateShot: () => void;
  /** Abort an in-flight regen for the currently displayed shot. No-op
   *  when nothing is in flight. */
  onStopRegenerateShot: () => void;

  // ─── Section-title forward propagation ────────────────────────────────
  //
  // Mirrors the production-doc page's "Apply title card → section title"
  // affordance, but works from any shot's manually-edited Section title
  // field. Takes the current shot's `section_title` value and stamps it
  // onto every following shot up to (but not including) the next Title
  // Card row, or the end of the doc. Hidden when the count below is 0.
  /** Number of following shots that would be affected by a propagate.
   *  Computed by the parent (counts rows after `shotIndex` until the
   *  next `visual_type === 'Title Card'` or end-of-doc). The button
   *  hides when this is 0 so the inspector doesn't show a no-op
   *  action. */
  applyTitleForwardCount: number;
  /** Stamp `row.section_title` onto the `applyTitleForwardCount`
   *  following shots in one batched mutation. When `row.section_title`
   *  is empty/undefined, clears section_title on those rows instead. */
  onApplyTitleForward: () => void;

  // ─── Variants + title-card + per-row notes ──────────────────────
  //
  // See `_plans/2026-05-27-editor-variants-titles-notes.md`. These
  // surface the same affordances the production-doc grid view has had
  // since the near-static-variants + title-card workflows shipped.
  // Optional — when undefined the inspector hides the corresponding
  // panel so an editor mounted without these (e.g. a future read-only
  // surface) renders cleanly.

  /** Sparse map of row-index → image URL. The variant mini-strip
   *  reads this to render thumbnails for siblings in the same group. */
  rowImagesMap?: Record<number, string>;
  /** Async variant-generation state for the active row only. The
   *  variant panel uses it to drive the Generate button's
   *  spinner / error display. */
  variantGenState?: VariantGenState;
  /** Promote the active row to a base + insert the first variant; or
   *  extend an existing group with a new variant. */
  onAddVariantRow?: () => void;
  /** Delete the active variant row (only meaningful when the active
   *  row IS a variant — variant_index > 0). */
  onDeleteVariantRow?: () => void;
  /** Move the active variant up / down within its group. Refuses to
   *  cross the base or a group boundary. */
  onMoveVariantRow?: (direction: 'up' | 'down') => void;
  /** Jump editor selection to a different row index. Used by the
   *  variant mini-strip's click-to-jump and the variant view's
   *  "Jump to base" link. */
  onSelectRowIndex?: (rowIndex: number) => void;
  /** Kick off the variant generation against the base (or previous
   *  variant if chained). Async — parent POSTs to
   *  /api/generate/production-doc/image/edit and persists via /row-asset. */
  onGenerateVariant?: () => void;
  /** Change the active row's `visual_type`. With `promoteFields: true`,
   *  also runs the production-doc Title Card promotion side-effects. */
  onSetRowVisualType?: (visualType: string, options?: { promoteFields?: boolean }) => void;
  /** Extract a leading markdown heading from `script_text` into a
   *  fresh Title Card row inserted above the active row. */
  onSplitAsTitleCard?: (heading: string) => void;
  /** Propagate the active Title Card's text as `section_title` to
   *  every downstream row up to (not including) the next Title Card. */
  onApplyTitleCardAsSectionTitle?: () => void;
  /** Commit the per-row notes textarea via PATCH_ROW. */
  onCommitNotes?: (notes: string) => void;

  // ─── Split at playhead ────────────────────────────────────────────
  //
  // Surfaces the same SPLIT_SHOT action available via right-click,
  // the B / S keyboard shortcut, and the timeline card scissors button.
  // The inspector entry shows the relative offset so the user can see
  // where exactly the split will land before clicking. See
  // `_plans/2026-06-02-shot-split-ui.md`.

  /** True when the playhead is currently inside THIS shot AND a split
   *  there would produce two halves both ≥ EDITOR_MIN_SHOT_MS. The
   *  parent (EditorClient) computes this from `splitTarget`. */
  canSplit?: boolean;
  /** Offset (ms) from this shot's start where the split would land.
   *  Surfaced as a "at 4.2s" hint next to the button. Meaningful only
   *  when `canSplit` is true. */
  splitOffsetMs?: number;
  /** Fires when the user clicks the "Split at playhead" button. The
   *  parent dispatches SPLIT_SHOT. */
  onSplit?: () => void;
}

/** Lifted regen state shape — kept here so EditorClient and the
 *  inspector share one source of truth on the union members. */
export type ShotRegenState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

function fmt(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

const ACCEPT_IMAGE_TYPES = 'image/jpeg,image/png,image/webp,image/gif';

export function ShotInspector({
  shotIndex,
  shot,
  row,
  doc,
  thumbnailUrl,
  totalShots,
  projectId,
  stylePreset,
  effectiveStyleSlug,
  activeStyleI2IModel,
  regenState,
  onRegenerateShot,
  onStopRegenerateShot,
  applyTitleForwardCount,
  onApplyTitleForward,
  onClose,
  onUploadImage,
  onPickProjectClip,
  onGenerateClip,
  onCancelClip,
  clipStatus,
  clipError,
  brollModelId,
  docBrollModelId,
  docImageModelDefault,
  onSetDocImageModelDefault,
  onUpdateScript,
  onUpdateRow,
  overlayState,
  isRethinkingOverlay,
  rethinkExhausted,
  editHistoryDepth,
  onOpenOverlayPosition,
  onOpenOverlayEdit,
  onRethinkOverlay,
  onUndoOverlayEdit,
  onShowOverlayContextMenu,
  docThumbnail,
  onOpenSectionThumbnail,
  docSectionTitleLayoutDefault,
  docPillarboxColorDefault,
  docSceneZoomDefault,
  docSceneFadeDefault,
  docRegionZoomPaddingDefaultPct,
  docOnScreenTextModeDefault,
  onApplyTransformToAll,
  onApplySectionTitleLayoutToAll,
  onClearSectionTitleLayoutOverrides,
  onApplyPillarboxColorToAll,
  onClearPillarboxColorOverrides,
  onApplySceneZoomToAll,
  onClearSceneZoomOverrides,
  onApplySceneFadeToAll,
  onClearSceneFadeOverrides,
  onApplyOstModeToAll,
  onClearOstModeOverrides,
  onOpenImageEdit,
  onRunRmbg,
  onRestoreOriginalBackground,
  rmbgInflight,
  rmbgApplied,
  hasRmbgCutout,
  rowImagesMap,
  variantGenState,
  onAddVariantRow,
  onDeleteVariantRow,
  onMoveVariantRow,
  onSelectRowIndex,
  onGenerateVariant,
  onSetRowVisualType,
  onSplitAsTitleCard,
  onApplyTitleCardAsSectionTitle,
  onCommitNotes,
  canSplit = false,
  splitOffsetMs,
  onSplit,
}: ShotInspectorProps): React.ReactElement {
  const undoDepth = editHistoryDepth ?? 0;
  const overlayReady = overlayState?.status === 'done' && Boolean(overlayState.url);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading'; fileName: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // TransitionDialog open/close. Self-contained — the dialog owns its
  // working copy; we only listen for `onSave` + `onReset` and dispatch
  // through `onUpdateRow`. Only meaningful when this shot has a
  // `thumbnail_zoom_to` region set.
  const [transitionDialogOpen, setTransitionDialogOpen] = useState(false);
  // Regenerate state is lifted to EditorClient (per-shot map keyed by
  // shotIndex) so it doesn't bleed across shots when this inspector
  // re-renders with a different `shotIndex` prop. See the
  // `regenerateShot` block in EditorClient.tsx for the contract.

  // Inline-edit + Rephrase state for the voiceover script field.
  // The textarea is a controlled mirror of `row.script_text`; we
  // commit on blur so the doc isn't rewritten on every keystroke.
  const [scriptDraft, setScriptDraft] = useState<string>(row.script_text ?? '');
  // Sync the draft when the row changes (e.g. user selects a
  // different shot). Compared by index to avoid clobbering an
  // in-progress edit when something else dirties the doc.
  const scriptSyncedFor = useRef<number>(shotIndex);
  if (scriptSyncedFor.current !== shotIndex) {
    scriptSyncedFor.current = shotIndex;
    // Mid-render setState would loop — schedule via microtask so
    // the next render uses the fresh draft.
    queueMicrotask(() => setScriptDraft(row.script_text ?? ''));
  }

  const commitScriptDraft = useCallback(() => {
    if (!onUpdateScript) return;
    const next = scriptDraft;
    const prev = row.script_text ?? '';
    if (next === prev) return;
    onUpdateScript(next);
  }, [onUpdateScript, row.script_text, scriptDraft]);

  // PR 3 of `_plans/2026-06-02-editor-motion-collage-support.md`:
  // motion_collage shots get a totally different image-editing surface
  // (panel grid + per-panel regen + lightbox) instead of the single-image
  // AI Replace / Animate / Visual description / AI image prompt stack
  // that assumes one still per shot. Branch once at the body level; the
  // four blocks below are gated on `!isMotionCollage`.
  const isMotionCollage = shot.shotKind === 'motion_collage';

  const [rephraseState, setRephraseState] = useState<
    | { kind: 'idle' }
    | { kind: 'rephrasing'; style: 'same' | 'shorter' | 'longer' | 'simpler' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const handleRephrase = useCallback(
    async (style: 'same' | 'shorter' | 'longer' | 'simpler') => {
      if (!onUpdateScript) return;
      // Use the live draft if the user typed since the last commit;
      // otherwise the row's text. Either way we send the latest
      // value to the model.
      const text = (scriptDraft || row.script_text || '').trim();
      if (!text) {
        setRephraseState({ kind: 'error', message: 'No script text to rephrase.' });
        return;
      }
      setRephraseState({ kind: 'rephrasing', style });
      try {
        // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
        const res = await fetch('/api/edit/rephrase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, style }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Rephrase failed: HTTP ${res.status}`);
        }
        const data = (await res.json()) as { text?: string };
        const rephrased = typeof data.text === 'string' ? data.text.trim() : '';
        if (!rephrased) {
          throw new Error('Empty rephrase output');
        }
        setScriptDraft(rephrased);
        onUpdateScript(rephrased);
        setRephraseState({ kind: 'idle' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[editor inspector] rephrase failed', { detail: message });
        setRephraseState({ kind: 'error', message });
      }
    },
    [onUpdateScript, row.script_text, scriptDraft],
  );

  const [projectClips, setProjectClips] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'loaded'; clips: ProjectClip[] }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // Lazy-load the project's broll clips when the user expands the
  // picker. Avoids the per-shot mount cost when most users never
  // open it. Re-fetches on inspector mount if the projectId changes.
  const [showPicker, setShowPicker] = useState(false);
  useEffect(() => {
    if (!showPicker || projectClips.kind !== 'idle') return;
    let cancelled = false;
    setProjectClips({ kind: 'loading' });
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch(`/api/broll?productionDocId=${encodeURIComponent(projectId)}&limit=200`);
        if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
        const data = (await res.json()) as { clips?: unknown };
        const raw = Array.isArray(data.clips) ? data.clips : [];
        const clips: ProjectClip[] = raw
          .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
          .map((c) => ({
            id: typeof c.id === 'string' ? c.id : '',
            video_url: typeof c.video_url === 'string' ? c.video_url : null,
            duration_seconds:
              typeof c.duration_seconds === 'number' ? c.duration_seconds : null,
            prompt: typeof c.prompt === 'string' ? c.prompt : '',
            model_id: typeof c.model_id === 'string' ? c.model_id : '',
            aspect_ratio: typeof c.aspect_ratio === 'string' ? c.aspect_ratio : '',
            status: typeof c.status === 'string' ? c.status : '',
            row_index: typeof c.row_index === 'number' ? c.row_index : null,
          }))
          // Only show clips that have a usable URL — pending / failed
          // rows are noise here. Keep the row-index ordering from the
          // server response.
          .filter((c) => c.id && c.status === 'ready' && c.video_url);
        if (!cancelled) {
          setProjectClips({ kind: 'loaded', clips });
        }
      } catch (err) {
        if (!cancelled) {
          setProjectClips({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showPicker, projectClips.kind, projectId]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting the same file
      if (!file || !onUploadImage) return;

      setUploadState({ kind: 'uploading', fileName: file.name });
      try {
        // 1. Mint a presigned PUT URL.
        // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
        const presignRes = await fetch('/api/uploads/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.type,
            fileSize: file.size,
          }),
        });
        if (!presignRes.ok) {
          const data = (await presignRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Presign failed: HTTP ${presignRes.status}`);
        }
        const { uploadUrl, downloadUrl } = (await presignRes.json()) as {
          uploadUrl: string;
          downloadUrl: string;
        };

        // 2. PUT the file directly to R2 (bypassing Vercel's body cap).
        // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        if (!putRes.ok) {
          throw new Error(`Upload failed: HTTP ${putRes.status}`);
        }

        // 3. Hand the new URL to the editor — the store dispatches
        //    SET_ROW_IMAGE and the player + thumbnail update on the
        //    next render.
        console.info('[editor inspector] upload complete', {
          shotIndex,
          downloadUrl,
        });
        onUploadImage(downloadUrl);
        setUploadState({ kind: 'idle' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[editor inspector] upload failed', { detail: message });
        setUploadState({ kind: 'error', message });
      }
    },
    [onUploadImage, shotIndex],
  );

  return (
    <aside
      className="rounded-lg border overflow-hidden flex flex-col"
      style={{
        borderColor: 'var(--card-border)',
        background: 'var(--card-bg)',
        width: 380,
        maxWidth: '100%',
      }}
      aria-label="Selected shot inspector"
    >
      <header
        className="px-4 py-3 flex items-center justify-between border-b"
        style={{ borderColor: 'var(--card-border)' }}
      >
        <div>
          <div className="text-sm font-semibold">
            Shot {shotIndex + 1} <span style={{ color: 'var(--fg-muted)' }}>of {totalShots}</span>
          </div>
          <div className="text-[11px] tabular-nums" style={{ color: 'var(--fg-muted)' }}>
            {row.timecode || '—'} · {fmt(shot.durationMs)}
            {typeof row.duration_override_ms === 'number' && (
              <span style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}> · edited</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* Split at playhead — same action as B / S keyboard, the
              right-click context menu, and the timeline card scissors
              button. Only rendered when the playhead is inside this
              shot AND both halves would be ≥ EDITOR_MIN_SHOT_MS. See
              `_plans/2026-06-02-shot-split-ui.md`. */}
          {canSplit && onSplit && (
            <button
              type="button"
              onClick={() => {
                console.info('[editor split] click', { source: 'inspector-button' });
                onSplit();
              }}
              className="text-xs px-2 py-1 rounded border hover:bg-white/5 transition-colors flex items-center gap-1"
              style={{ borderColor: 'var(--card-border)' }}
              title={`Split this shot at the playhead${
                typeof splitOffsetMs === 'number' ? ` (${fmt(splitOffsetMs)} in)` : ''
              }. Keyboard: B or S.`}
            >
              <span aria-hidden>✂</span>
              <span>Split</span>
              {typeof splitOffsetMs === 'number' && (
                <span style={{ color: 'var(--fg-muted)' }}> at {fmt(splitOffsetMs)}</span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2 py-1 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: 'var(--card-border)' }}
            title="Close inspector"
          >
            ×
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Phase 5 of `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
            Quick-actions strip — AI verbs in one row at the top of
            the inspector. Mirrors the verbs surfaced in the shot
            context menu so the user can reach them without
            right-clicking (rule 10 — build for a lazy user).
            Suppressed entirely when the row has no image and no
            handler is wired. */}
        {isMotionCollage && onUpdateRow && (
          <div
            className="p-3 border-b"
            style={{ borderColor: 'var(--card-border)' }}
          >
            {/* key={shotIndex} — ShotInspector itself isn't keyed by
                shot, so without this the panel's local gen/lightbox/
                busy state would persist across shot switches. */}
            <InspectorMotionCollagePanel
              key={shotIndex}
              row={row}
              shotIndex={shotIndex}
              doc={doc}
              onUpdateRow={onUpdateRow}
              onSetDocImageModelDefault={onSetDocImageModelDefault}
            />
          </div>
        )}
        {/* PR 4 of `_plans/2026-06-02-editor-motion-collage-support.md`:
            explicit "Convert to motion collage" button — replaces the
            implicit "switch shot_type to motion collage" route the user's
            screenshot showed didn't exist. The component returns null on
            non-doodle docs / title-card rows / already-motion-collage
            rows, so it only appears where it's actionable. */}
        {!isMotionCollage && onUpdateRow && (
          <ConvertToMotionCollageButton
            row={row}
            shotIndex={shotIndex}
            doc={doc}
            effectiveStyleSlug={effectiveStyleSlug}
            onUpdateRow={onUpdateRow}
          />
        )}
        {!isMotionCollage && thumbnailUrl && (onOpenImageEdit || onRunRmbg) && (
          <div
            className="flex items-center gap-1 px-3 py-2 border-b"
            style={{ borderColor: 'var(--card-border)' }}
            role="toolbar"
            aria-label="AI quick actions"
          >
            {onOpenImageEdit && (
              <>
                <button
                  type="button"
                  onClick={onOpenImageEdit}
                  className="text-[11px] px-2 py-1 rounded border hover:bg-white/5 transition-colors"
                  style={{ borderColor: 'var(--card-border)' }}
                  title="Open the AI image-edit dialog (replace via prompt, or paint a mask to erase)"
                >
                  AI Replace
                </button>
                <button
                  type="button"
                  onClick={onOpenImageEdit}
                  className="text-[11px] px-2 py-1 rounded border hover:bg-white/5 transition-colors"
                  style={{ borderColor: 'var(--card-border)' }}
                  title="Paint a mask over an object and Bria-erases it"
                >
                  Erase
                </button>
              </>
            )}
            {onRunRmbg &&
              (rmbgApplied ? (
                <button
                  type="button"
                  onClick={onRestoreOriginalBackground}
                  className="text-[11px] px-2 py-1 rounded border hover:bg-white/5 transition-colors"
                  style={{
                    borderColor: 'var(--card-border)',
                    color: 'var(--accent-purple-bright, #a78bfa)',
                  }}
                  title="Revert to the original background (the cutout stays — re-applying is instant)"
                >
                  Restore bg
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onRunRmbg}
                  disabled={rmbgInflight === true}
                  className="text-[11px] px-2 py-1 rounded border hover:bg-white/5 transition-colors"
                  style={{ borderColor: 'var(--card-border)' }}
                  title={
                    hasRmbgCutout
                      ? 'Re-apply the previously generated cutout (no model call)'
                      : 'Run Bria RMBG to isolate the subject of this image'
                  }
                >
                  {rmbgInflight
                    ? 'Removing bg…'
                    : hasRmbgCutout
                      ? 'Re-apply bg'
                      : 'Remove bg'}
                </button>
              ))}
          </div>
        )}
        {thumbnailUrl ? (
          <div
            className="aspect-video relative"
            style={{ background: '#000' }}
          >
            <img
              src={thumbnailUrl}
              alt={`Shot ${shotIndex + 1} thumbnail`}
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
          </div>
        ) : (
          // No image attached — banner tells the user EXACTLY what's
          // up (renders as blank in the final video) and what to do
          // (use the Upload / Regenerate buttons below). 2026-05-24:
          // surfaces the most common "why is preview empty" confusion
          // (see Timeline.tsx blank-marker for the timeline-side
          // mirror).
          <div
            className="aspect-video relative flex flex-col items-center justify-center gap-2 px-4 text-center"
            style={{
              background:
                'repeating-linear-gradient(135deg, rgba(255,255,255,0.04) 0 8px, rgba(255,255,255,0.10) 8px 16px), #1f2937',
            }}
          >
            <div
              className="uppercase tracking-widest font-semibold rounded px-2 py-0.5"
              style={{
                fontSize: 10,
                letterSpacing: '0.14em',
                background: 'rgba(0,0,0,0.6)',
                color: 'rgba(255,255,255,0.92)',
              }}
            >
              No image
            </div>
            <div
              className="text-[11px] leading-snug"
              style={{ color: 'rgba(255,255,255,0.75)', maxWidth: 280 }}
            >
              This shot renders as blank in the final video. Use{' '}
              <strong>Upload from disk</strong> below to add one, or{' '}
              <strong>Regenerate</strong> to create one from the prompt.
            </div>
          </div>
        )}

        {/* Replace media — upload only in this commit. The
            from-project picker + regenerate-from-prompt land in
            follow-up commits next to this section.
            Hidden on motion_collage shots — the InspectorMotionCollagePanel
            mounted above owns the image surface for those rows. */}
        {onUploadImage && !isMotionCollage && (
          <div
            className="p-3 border-b space-y-2"
            style={{ borderColor: 'var(--card-border)' }}
          >
            <div className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
              Replace image
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_IMAGE_TYPES}
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={handleUploadClick}
              disabled={uploadState.kind === 'uploading'}
              className="w-full text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
              style={{ borderColor: 'var(--card-border)' }}
            >
              {uploadState.kind === 'uploading'
                ? `Uploading ${uploadState.fileName}…`
                : 'Upload from disk'}
            </button>
            {uploadState.kind === 'error' && (
              <div className="text-[10px]" style={{ color: '#f87171' }}>
                {uploadState.message}
              </div>
            )}
            <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
              JPG, PNG, WebP, or GIF · max 10 MB. The new still replaces this shot
              immediately; Cmd/Ctrl+Z undoes.
            </div>

            {/* Per-shot image (still) model picker. Controls which
                model Regenerate sends to /api/generate/production-doc/image.
                "Default" clears row.image_model so the doc-level default
                (set in the editor's doc-defaults panel and stamped on
                fresh docs by the production-doc page) takes over. */}
            {onUpdateRow && (
              <ShotImageModelPicker
                rowModelId={row.image_model}
                docModelId={docImageModelDefault}
                onChange={(next) => {
                  console.info('[editor row-image-model] changed', {
                    shotIndex,
                    from: row.image_model,
                    to: next,
                  });
                  onUpdateRow({ image_model: next });
                }}
                onSaveAsDefault={
                  onSetDocImageModelDefault
                    ? (modelId) => {
                        console.info('[editor row-image-model] promote to doc default', {
                          shotIndex,
                          modelId,
                          previousDocDefault: docImageModelDefault ?? null,
                        });
                        onSetDocImageModelDefault(modelId);
                      }
                    : undefined
                }
              />
            )}

            {/* Regenerate from this row's current prompt. Calls the
                existing /api/generate/production-doc/image route so
                pricing + rate-limit + R2 mirroring behave identically
                to a Production-Doc-page regenerate. */}
            <div className="flex gap-1.5">
              {regenState.kind === 'generating' ? (
                <button
                  type="button"
                  onClick={() => {
                    console.info('[editor inspector] regenerate stop clicked', { shotIndex });
                    onStopRegenerateShot();
                  }}
                  className="flex-1 text-xs px-3 py-1.5 rounded border transition-colors hover:bg-white/5"
                  style={{ borderColor: '#f87171', color: '#f87171' }}
                  title="Cancel this generation"
                >
                  Stop · Regenerating…
                </button>
              ) : (
              <button
                type="button"
                onClick={() => onRegenerateShot()}
                className="flex-1 text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
                style={{ borderColor: 'var(--card-border)' }}
                title="Re-run the image generator on this row's current prompt"
              >
                {regenState.kind === 'cancelled'
                  ? 'Retry'
                  : 'Regenerate'}
                {/* v2 (2026-05-22) — inline cost hint when the active
                    style pins an i2i model (rule 8: cost preview before
                    paid actions). Local models show "free", cloud show
                    "~$0.05". Hidden when no i2i model is pinned. */}
                {(() => {
                  if (!activeStyleI2IModel) return null;
                  const hint = formatI2ICostHint(activeStyleI2IModel);
                  if (!hint) return null;
                  return (
                    <span
                      className="ml-1.5 text-[10px] opacity-70"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      ({hint})
                    </span>
                  );
                })()}
              </button>
              )}
              {/* Batch C — open the mask-brush AI edit dialog with this
                  row's current still. The parent owns the modal mount
                  + the API call (same endpoint production-doc uses). */}
              {onOpenImageEdit && thumbnailUrl && (
                <button
                  type="button"
                  onClick={onOpenImageEdit}
                  className="text-xs px-3 py-1.5 rounded border transition-colors hover:bg-white/5"
                  style={{ borderColor: 'var(--card-border)' }}
                  title="Paint a mask and ask the AI to alter that region"
                >
                  Edit image
                </button>
              )}
            </div>
            {regenState.kind === 'error' && (
              <div
                className="text-[10px] rounded px-2 py-1"
                style={{
                  color: '#f87171',
                  background: 'rgba(239,68,68,0.10)',
                  border: '1px solid rgba(239,68,68,0.3)',
                }}
                role="alert"
              >
                <span className="font-medium">Generation failed:</span>{' '}
                {regenState.message}
              </div>
            )}
            {regenState.kind === 'cancelled' && (
              <div
                className="text-[10px] rounded px-2 py-1"
                style={{ color: '#fbbf24' }}
                role="status"
              >
                Cancelled. Click Retry to try again.
              </div>
            )}
          </div>
        )}

        {/* Generate animation — kicks off a fresh B-roll clip
            generation for this row using the workspace default
            model. The poll loop in EditorClient streams status
            updates into `clipStatus`; while generating, the button
            collapses to a busy state. Hidden when a clip is already
            attached and `ready` — the user can use Pick from
            project below to swap it.
            Hidden on motion_collage shots — these animate via panel
            switching, not Kling. */}
        {onGenerateClip && !isMotionCollage && (() => {
          // Per-row + doc-level + workspace-level model resolution
          // mirrors the renderer's tier priority (row > doc > user).
          // The dropdown writes row.broll_model_id; empty string clears
          // the row override so the doc-level default kicks back in
          // (and `undefined` doc cascades to workspace default).
          const rowModelId = row.broll_model_id;
          const effectiveModelId =
            rowModelId ?? docBrollModelId ?? brollModelId ?? '';
          const effectiveModel = BROLL_MODELS.find(
            (m) => m.id === effectiveModelId,
          );
          const isReady = clipStatus === 'ready';
          const isGenerating = clipStatus === 'generating';
          return (
            <div
              className="p-3 border-b space-y-2"
              style={{ borderColor: 'var(--card-border)' }}
            >
              <div className="flex items-center justify-between">
                <div
                  className="text-[11px] font-semibold"
                  style={{ color: 'var(--fg)' }}
                >
                  Animate this shot
                </div>
                {isReady && (
                  <span
                    className="text-[9px] px-1.5 py-0.5 rounded ed-mono"
                    style={{
                      background: 'rgba(34,197,94,0.14)',
                      color: '#22c55e',
                    }}
                  >
                    clip ready
                  </span>
                )}
              </div>

              {/* Per-row model picker. Dropdown shows every i2v model
                  in the broll registry; local entries gated behind
                  LOCAL_STUDIO. "Default" first option clears the row
                  override. The label includes the resolved fallback
                  so the user knows what "Default" means right now. */}
              {onUpdateRow && (
                <ShotBrollModelPicker
                  rowModelId={rowModelId}
                  docModelId={docBrollModelId}
                  workspaceModelId={brollModelId}
                  onChange={(next) =>
                    onUpdateRow({ broll_model_id: next })
                  }
                />
              )}

              {isGenerating && onCancelClip ? (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled
                    className="flex-1 flex items-center justify-center gap-2 text-xs px-3 py-2 rounded border opacity-70"
                    style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
                  >
                    <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                    <span>Generating…</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      console.info('[editor inspector] animation stop clicked', { shotIndex });
                      onCancelClip();
                    }}
                    className="text-xs px-3 py-2 rounded border transition-colors hover:bg-white/5"
                    style={{ borderColor: '#f87171', color: '#f87171' }}
                    title="Stop waiting on this generation. The server-side job may still run and be billed."
                  >
                    Stop
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onGenerateClip}
                  className="w-full flex items-center justify-center gap-2 text-xs px-3 py-2 rounded border transition-colors hover:bg-white/5"
                  style={{
                    borderColor: 'var(--accent-purple-bright, #a78bfa)',
                    color: 'var(--accent-purple-bright, #a78bfa)',
                  }}
                  title={
                    isReady
                      ? 'Regenerate the animation using the model below. The existing clip will be replaced once the new one is ready.'
                      : 'Generate a fresh B-roll animation for this shot.'
                  }
                >
                  {isReady ? (
                    <>
                      <RefreshCw size={14} strokeWidth={2} />
                      <span>Regenerate animation</span>
                    </>
                  ) : clipStatus === 'error' ? (
                    <>
                      <RefreshCw size={14} strokeWidth={2} />
                      <span>Retry animation</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} strokeWidth={2} />
                      <span>Generate animation</span>
                    </>
                  )}
                </button>
              )}
              {effectiveModel && (
                <div
                  className="text-[10px]"
                  style={{ color: 'var(--fg-muted)' }}
                >
                  {effectiveModel.label} — {effectiveModel.priceUsdLabel}
                </div>
              )}

              {/* Clip-fit policy picker — what to do when clip and
                  scene durations don't match. See ProductionRow.
                  clip_fit_mode for the per-mode contract. Visible
                  whenever this row could host a clip (the panel
                  itself is conditional on onGenerateClip). */}
              {isReady && onUpdateRow && (
                <ShotClipFitPicker
                  row={row}
                  shotVideoDurationSeconds={shot.videoDurationSeconds}
                  onUpdate={onUpdateRow}
                />
              )}
              {(clipStatus === 'error' || clipStatus === 'failed') && (
                <div
                  className="text-[10px] rounded px-2 py-1"
                  style={{
                    color: '#f87171',
                    background: 'rgba(239,68,68,0.10)',
                    border: '1px solid rgba(239,68,68,0.3)',
                  }}
                  role="alert"
                >
                  <span className="font-medium">Animation failed.</span>{' '}
                  {clipError ?? 'Click Retry to try again. Check the browser console for the full error.'}
                </div>
              )}
            </div>
          );
        })()}

        {/* Pick from project — lists clips that were already
            generated for this production-doc, so the user can swap
            a row's source clip without spending another LLM call. */}
        {onPickProjectClip && (
          <div
            className="p-3 border-b space-y-2"
            style={{ borderColor: 'var(--card-border)' }}
          >
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
                Pick a clip from this project
              </div>
              <button
                type="button"
                onClick={() => setShowPicker((v) => !v)}
                className="text-[10px] underline"
                style={{ color: 'var(--fg-muted)' }}
              >
                {showPicker ? 'Hide' : 'Show'}
              </button>
            </div>

            {showPicker && (
              <>
                {projectClips.kind === 'loading' && (
                  <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                    Loading clips…
                  </div>
                )}
                {projectClips.kind === 'error' && (
                  <div className="text-[10px]" style={{ color: '#f87171' }}>
                    {projectClips.message}
                  </div>
                )}
                {projectClips.kind === 'loaded' && projectClips.clips.length === 0 && (
                  <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                    No animated clips for this project yet. Generate one on the
                    Production Doc page first.
                  </div>
                )}
                {projectClips.kind === 'loaded' && projectClips.clips.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {projectClips.clips.map((clip) => {
                      const isSelected = row.video_url_override === clip.video_url;
                      return (
                        <button
                          key={clip.id}
                          type="button"
                          onClick={() =>
                            onPickProjectClip(
                              clip.video_url as string,
                              clip.duration_seconds,
                            )
                          }
                          className="relative rounded border overflow-hidden hover:opacity-90 transition-opacity"
                          style={{
                            borderColor: isSelected
                              ? 'var(--accent-purple-bright, #a78bfa)'
                              : 'var(--card-border)',
                            background: '#000',
                            aspectRatio: '16 / 9',
                          }}
                          title={clip.prompt.slice(0, 200)}
                        >
                          <video
                            src={clip.video_url ?? undefined}
                            className="absolute inset-0 w-full h-full object-cover"
                            muted
                            preload="metadata"
                            playsInline
                          />
                          <div
                            className="absolute bottom-0 left-0 right-0 p-1"
                            style={{
                              background:
                                'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
                            }}
                          >
                            <div
                              className="text-[9px] tabular-nums"
                              style={{ color: 'rgba(255,255,255,0.85)' }}
                            >
                              {clip.duration_seconds ? `${clip.duration_seconds}s · ` : ''}
                              {clip.model_id}
                              {clip.row_index !== null ? ` · row ${clip.row_index + 1}` : ''}
                            </div>
                          </div>
                          {isSelected && (
                            <div
                              className="absolute top-1 right-1 rounded px-1 py-0.5 text-[9px]"
                              style={{
                                background: 'var(--accent-purple-bright, #a78bfa)',
                                color: '#000',
                              }}
                            >
                              picked
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Clear button surfaces when this row has a picked clip,
                    so undoing-via-undo isn't the only path back. */}
                {row.video_url_override && (
                  <button
                    type="button"
                    onClick={() => onPickProjectClip(null, null)}
                    className="w-full text-[10px] px-2 py-1 rounded border hover:bg-white/5 transition-colors"
                    style={{ borderColor: 'var(--card-border)' }}
                  >
                    Clear picked clip
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <div className="p-4 space-y-4 text-xs">
          {/* Visual_description — the prompt the doc generator wrote
              to drive image / video generation. Editable inline so
              the user can tweak the prompt and either regenerate the
              image (button above) or just refine what the doc says
              about this shot. */}
          {!isMotionCollage && (onUpdateRow ? (
            <EditableTextarea
              label="Visual description"
              value={row.visual_description ?? ''}
              onCommit={(v) => onUpdateRow({ visual_description: v })}
              minRows={2}
            />
          ) : (
            <Field label="Visual description" value={row.visual_description || '—'} />
          ))}
          {!isMotionCollage && (onUpdateRow ? (
            <EditableTextarea
              label="AI image prompt"
              value={row.ai_image_prompt ?? ''}
              onCommit={(v) => onUpdateRow({ ai_image_prompt: v })}
              minRows={3}
              mono
              placeholder="The prompt the image generator will use…"
            />
          ) : (
            <Field label="AI image prompt" value={row.ai_image_prompt || '—'} mono />
          ))}
          {/* Voiceover script — editable inline. Commits on blur
              (or on AI rephrase). Cmd/Ctrl+Z still walks the undo
              stack through SET_ROW_SCRIPT commands. */}
          <div className="space-y-1">
            <div className="font-medium" style={{ color: 'var(--fg)' }}>
              Voiceover script
              {row.muted && (
                <span className="ml-1" style={{ color: '#f87171' }}>
                  (muted)
                </span>
              )}
            </div>
            {onUpdateScript ? (
              <>
                <textarea
                  value={scriptDraft}
                  onChange={(e) => setScriptDraft(e.target.value)}
                  onBlur={commitScriptDraft}
                  className="w-full text-xs rounded border p-2 resize-y min-h-[80px]"
                  style={{
                    borderColor: 'var(--card-border)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                  }}
                  placeholder="—"
                  spellCheck
                />
                <div className="flex flex-wrap gap-1">
                  {(['same', 'shorter', 'longer', 'simpler'] as const).map((style) => (
                    <button
                      key={style}
                      type="button"
                      onClick={() => { void handleRephrase(style); }}
                      disabled={rephraseState.kind === 'rephrasing'}
                      className="text-[10px] px-2 py-0.5 rounded border transition-colors disabled:opacity-50 hover:bg-white/5"
                      style={{ borderColor: 'var(--card-border)' }}
                      title={`Rephrase with AI (${style})`}
                    >
                      {rephraseState.kind === 'rephrasing' && rephraseState.style === style
                        ? 'Rephrasing…'
                        : `Rephrase: ${style}`}
                    </button>
                  ))}
                </div>
                {rephraseState.kind === 'error' && (
                  <div className="text-[10px]" style={{ color: '#f87171' }}>
                    {rephraseState.message}
                  </div>
                )}
              </>
            ) : (
              <div className="whitespace-pre-wrap break-words" style={{ color: 'var(--fg-muted)' }}>
                {row.script_text || '—'}
              </div>
            )}
          </div>

          {onUpdateRow ? (
            <EditableInput
              label="On-screen text"
              value={row.on_screen_text ?? ''}
              onCommit={(v) =>
                onUpdateRow({ on_screen_text: v.length > 0 ? v : undefined })
              }
              placeholder="Lower-third / kinetic-text caption for this shot"
            />
          ) : (
            row.on_screen_text && <Field label="On-screen text" value={row.on_screen_text} />
          )}
          {/* OST mode picker — overlay (Remotion renders a LowerThird on
              top of a clean image), bake (text painted into the diffusion
              prompt at generation time), or none. Mounted here, right
              under the OST text input, so the picker is co-located with
              the value it governs. The collapsed Layout panel below also
              carries this picker with full bulk-action affordances; this
              one is the discoverable quick-pick. PR 2 of
              `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
              Right-click "apply to all" intentionally NOT wired here —
              the bulk affordance lives in the Layout panel + kebab. */}
          {onUpdateRow && (
            <div className="-mt-1">
              <div
                className="text-[10px] mb-0.5"
                style={{ color: 'var(--fg-muted)' }}
              >
                Mode
              </div>
              <OstModeControl
                value={row.on_screen_text_mode}
                docDefault={doc.on_screen_text_mode_default}
                onChange={(next) => {
                  console.info('[editor inspector ost-mode] changed', {
                    rowIndex: shotIndex,
                    from: row.on_screen_text_mode,
                    to: next,
                  });
                  onUpdateRow({ on_screen_text_mode: next });
                }}
              />
            </div>
          )}
          {/* PR 5 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`:
              multi-block OST. Persisted into `on_screen_text_blocks`
              (PR 4 data shape). The renderer continues consuming the
              legacy `on_screen_text` field above until PR 6 wires the
              per-block composition. */}
          {onUpdateRow && (
            <InspectorTextBlocksPanel
              row={row}
              shotIndex={shotIndex}
              doc={doc}
              onUpdateRow={onUpdateRow}
            />
          )}
          {onUpdateRow ? (
            <EditableInput
              label="Section title"
              value={row.section_title ?? ''}
              onCommit={(v) =>
                onUpdateRow({ section_title: v.length > 0 ? v : undefined })
              }
              placeholder="If set, a section-title stripe / divider renders on this shot"
            />
          ) : (
            row.section_title && <Field label="Section title" value={row.section_title} />
          )}
          {/* Propagate this shot's section title forward, mirroring the
              production-doc's "Title Card → section title" affordance.
              Walks until (not including) the next Title Card row, or
              end of doc. Hidden when no following non-title-card shots
              exist (count = 0). When section_title is empty, the button
              clears section_title on the same range — symmetric so the
              user can both apply AND wipe a section in one click. */}
          {onUpdateRow && applyTitleForwardCount > 0 && (
            <button
              type="button"
              onClick={onApplyTitleForward}
              className="text-[11px] underline self-start"
              style={{ color: 'var(--editor-accent, #a78bfa)' }}
              title={
                row.section_title?.trim()
                  ? `Stamp "${row.section_title.trim()}" onto the next ${applyTitleForwardCount} shot${applyTitleForwardCount === 1 ? '' : 's'} up to the next Title Card row.`
                  : `Clear section title on the next ${applyTitleForwardCount} shot${applyTitleForwardCount === 1 ? '' : 's'} up to the next Title Card row.`
              }
            >
              {row.section_title?.trim()
                ? `Apply to next ${applyTitleForwardCount} shot${applyTitleForwardCount === 1 ? '' : 's'} →`
                : `Clear from next ${applyTitleForwardCount} shot${applyTitleForwardCount === 1 ? '' : 's'} →`}
            </button>
          )}

          {/* Section-thumbnail region zoom (Batch B). Only renders when
              the doc has a composite thumbnail with at least one drawn
              region; otherwise the section thumbnail is a doc-level
              concern surfaced from the AI Tools tab. */}
          {onUpdateRow && (
            <div className="space-y-1">
              <div className="font-medium flex items-center justify-between" style={{ color: 'var(--fg)' }}>
                <span>Section thumbnail zoom</span>
                {onOpenSectionThumbnail && (
                  <button
                    type="button"
                    onClick={onOpenSectionThumbnail}
                    className="text-[10px] underline"
                    style={{ color: 'var(--editor-accent, #a78bfa)' }}
                  >
                    {docThumbnail ? 'Edit thumbnail / regions' : 'Add thumbnail'}
                  </button>
                )}
              </div>
              {docThumbnail && docThumbnail.regions.length > 0 ? (
                <>
                  <select
                    value={row.thumbnail_zoom_to ?? ''}
                    onChange={(e) =>
                      onUpdateRow({
                        thumbnail_zoom_to: e.target.value || undefined,
                      })
                    }
                    className="w-full text-xs rounded border px-2 py-1.5"
                    style={{
                      borderColor: 'var(--card-border)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                    }}
                    aria-label="Zoom into region for this shot"
                  >
                    <option value="">— Show full thumbnail —</option>
                    {docThumbnail.regions.map((reg) => (
                      <option key={reg.id} value={reg.id}>
                        {reg.label || reg.id}
                      </option>
                    ))}
                  </select>
                  {/* Per-shot transition customization (Batch C follow-up).
                      Only meaningful once a region is chosen — without
                      one there's nothing for the transition to act on. */}
                  {row.thumbnail_zoom_to && (() => {
                    // Region zoom padding slider — controls how much
                    // breathing room sits around the marked region
                    // when the camera zooms in. Mirrors the prod-doc
                    // SectionRowControls slider (production-doc
                    // SectionRowControls.tsx:295-358). 0 = exact
                    // region, 50 = far pull-back. Override cleared
                    // when slider lands on the doc default so the row
                    // JSON stays free of redundant per-row values.
                    const docFallback =
                      typeof docRegionZoomPaddingDefaultPct === 'number'
                        ? docRegionZoomPaddingDefaultPct
                        : 15;
                    const effectivePadding =
                      typeof row.region_zoom_padding_pct === 'number'
                        ? row.region_zoom_padding_pct
                        : docFallback;
                    const overrideActive =
                      typeof row.region_zoom_padding_pct === 'number';
                    return (
                      <>
                        <div className="flex items-center gap-2 mt-2">
                          <label
                            className="text-[10px] uppercase tracking-wider whitespace-nowrap"
                            style={{ color: 'var(--fg-muted)' }}
                            title="How much breathing room around the region. 0 = exact region, 50 = far pull-back."
                          >
                            Padding
                          </label>
                          <input
                            type="range"
                            min={0}
                            max={50}
                            step={1}
                            value={effectivePadding}
                            onChange={(e) => {
                              const next = Number(e.target.value);
                              console.info('[editor region-padding] changed', {
                                shotIndex,
                                from: row.region_zoom_padding_pct,
                                to: next,
                                docDefault: docFallback,
                              });
                              onUpdateRow({
                                region_zoom_padding_pct:
                                  next === docFallback ? undefined : next,
                              });
                            }}
                            className="flex-1"
                            style={{ accentColor: 'var(--editor-accent, #a78bfa)' }}
                            aria-label={`Region zoom padding (${effectivePadding}%)`}
                          />
                          <span
                            className="text-[11px] tabular-nums w-9 text-right"
                            style={{
                              color: overrideActive
                                ? 'var(--editor-accent, #a78bfa)'
                                : 'var(--fg-muted)',
                            }}
                          >
                            {effectivePadding}%
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <div
                            className="text-[10px]"
                            style={{ color: 'var(--fg-muted)' }}
                          >
                            Transition:{' '}
                            <span
                              style={{
                                color: row.thumbnail_transition
                                  ? 'var(--editor-accent, #a78bfa)'
                                  : 'var(--fg-muted)',
                              }}
                            >
                              {row.thumbnail_transition
                                ? `${row.thumbnail_transition.kind}${row.thumbnail_transition.kind !== 'none' ? ` · ${row.thumbnail_transition.easing ?? 'spring-smooth'}` : ''}`
                                : `default (${docThumbnail.defaultTransition?.kind ?? 'hard-cut'})`}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setTransitionDialogOpen(true)}
                            className="text-[10px] underline"
                            style={{ color: 'var(--editor-accent, #a78bfa)' }}
                          >
                            Customize…
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </>
              ) : (
                <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                  {docThumbnail
                    ? 'No regions drawn yet. Click "Edit thumbnail / regions" to add some.'
                    : 'No section thumbnail yet. Click "Add thumbnail" to upload one.'}
                </div>
              )}
            </div>
          )}

          {/* Batch C — per-shot layout accordion. Section-title layout,
              pillarbox color, scene zoom, scene fade. Collapsed by
              default so the inspector stays readable; expand to fine-tune. */}
          {onUpdateRow && (
            <ShotLayoutControls
              row={row}
              docSectionTitleLayoutDefault={docSectionTitleLayoutDefault}
              docPillarboxColorDefault={docPillarboxColorDefault}
              docSceneZoomDefault={docSceneZoomDefault}
              docSceneFadeDefault={docSceneFadeDefault}
              docOnScreenTextModeDefault={docOnScreenTextModeDefault}
              onUpdate={onUpdateRow}
              totalRows={totalShots}
              onApplySectionTitleLayoutToAll={onApplySectionTitleLayoutToAll}
              onClearSectionTitleLayoutOverrides={onClearSectionTitleLayoutOverrides}
              onApplyPillarboxColorToAll={onApplyPillarboxColorToAll}
              onClearPillarboxColorOverrides={onClearPillarboxColorOverrides}
              onApplySceneZoomToAll={onApplySceneZoomToAll}
              onClearSceneZoomOverrides={onClearSceneZoomOverrides}
              onApplySceneFadeToAll={onApplySceneFadeToAll}
              onClearSceneFadeOverrides={onClearSceneFadeOverrides}
              onApplyOstModeToAll={onApplyOstModeToAll}
              onClearOstModeOverrides={onClearOstModeOverrides}
            />
          )}

          {/* Canva-style free transform — Batches A-D of
              _plans/2026-05-23-editor-canva-transform.md. Numeric
              inputs + interactive overlay + multi-shot apply. */}
          {onUpdateRow && (
            <ShotFreeTransformControls
              row={row}
              doc={doc}
              hasVisual={Boolean(thumbnailUrl || row.video_url_override || clipStatus === 'ready')}
              onUpdate={onUpdateRow}
              onApplyTransformToAll={onApplyTransformToAll}
            />
          )}

          {(typeof row.trim_start_ms === 'number' || typeof row.trim_end_ms === 'number') && (
            <div
              className="p-2 rounded border space-y-1"
              style={{ borderColor: 'var(--card-border)' }}
            >
              <div className="font-medium" style={{ color: 'var(--fg)' }}>
                Trim
              </div>
              <div className="tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                Head: {fmt(row.trim_start_ms)} · Tail: {fmt(row.trim_end_ms)}
              </div>
            </div>
          )}

          {/* Phase 5.2 overlay-port — controls for the per-row image
              overlay. Visible when the row's doc-gen pass produced
              overlay stock terms. The action buttons require the
              overlay to be `done` (URL ready). Right-click on the
              section header opens the full context menu. */}
          {row.overlay_stock_terms?.trim() && (
            <div
              onContextMenu={
                onShowOverlayContextMenu && overlayReady
                  ? (e) => {
                      e.preventDefault();
                      onShowOverlayContextMenu(e.clientX, e.clientY);
                    }
                  : undefined
              }
              className="p-3 rounded border space-y-2"
              style={{ borderColor: 'var(--card-border)' }}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium" style={{ color: '#fbbf24' }}>
                  ✦ Overlay
                </span>
                <span
                  className="text-[10px] truncate"
                  style={{ color: 'var(--fg-muted)', maxWidth: 220 }}
                  title={row.overlay_stock_terms}
                >
                  {row.overlay_stock_terms}
                </span>
              </div>
              {overlayState?.status === 'loading' && (
                <div className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>
                  fetching…
                </div>
              )}
              {overlayState?.status === 'skipped' && (
                <div className="text-[11px]" style={{ color: '#f87171' }}>
                  ⚠ No usable image found
                </div>
              )}
              {overlayState?.status === 'error' && (
                <div className="text-[11px]" style={{ color: '#f87171' }}>
                  ⚠ Fetch failed
                </div>
              )}
              {overlayReady && overlayState?.url && (
                <>
                  <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={overlayState.url}
                      alt={row.overlay_stock_terms}
                      style={{
                        maxWidth: 60,
                        maxHeight: 40,
                        objectFit: 'contain',
                        background:
                          'repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 8px 8px',
                        borderRadius: 3,
                      }}
                    />
                    {row.overlay_placement_reason && (
                      <span
                        className="text-[10px]"
                        style={{ color: 'var(--fg-muted)', lineHeight: 1.4 }}
                        // The full rationale already shows in the
                        // position editor's header (the authoritative
                        // surface for placement context). Surface the
                        // model id here as a quiet inline tooltip
                        // instead of duplicating the prose.
                        title={
                          row.overlay_placement_model
                            ? `AI placement (${row.overlay_placement_model}) — open ✋ Position to see the rationale`
                            : `AI placement — open ✋ Position to see the rationale`
                        }
                      >
                        <span style={{ color: '#a78bfa' }}>ⓘ AI placed</span>
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {onOpenOverlayPosition && (
                      <button
                        type="button"
                        onClick={onOpenOverlayPosition}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{
                          background: row.overlay_position
                            ? 'rgba(168,85,247,0.16)'
                            : 'rgba(255,255,255,0.04)',
                          color: row.overlay_position ? '#c084fc' : 'var(--fg-muted)',
                          border: `1px solid ${row.overlay_position ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.10)'}`,
                          cursor: 'pointer',
                        }}
                        title={
                          row.overlay_position
                            ? 'Open the drag-and-drop editor — position is currently manual'
                            : 'Open the drag-and-drop editor + 8 resize handles'
                        }
                      >
                        {row.overlay_position ? '✋ Position (manual)' : '✋ Position…'}
                      </button>
                    )}
                    {onRethinkOverlay && (
                      <button
                        type="button"
                        onClick={onRethinkOverlay}
                        disabled={isRethinkingOverlay || rethinkExhausted}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{
                          background: rethinkExhausted
                            ? 'rgba(255,255,255,0.02)'
                            : 'rgba(99,102,241,0.14)',
                          color: rethinkExhausted ? 'rgba(255,255,255,0.30)' : '#a5b4fc',
                          border: `1px solid ${rethinkExhausted ? 'rgba(255,255,255,0.06)' : 'rgba(99,102,241,0.32)'}`,
                          cursor:
                            isRethinkingOverlay || rethinkExhausted ? 'not-allowed' : 'pointer',
                          opacity: isRethinkingOverlay ? 0.7 : 1,
                        }}
                        title={
                          rethinkExhausted
                            ? 'Rethink limit reached this session — reload to reset'
                            : isRethinkingOverlay
                              ? 'Asking the AI for a new placement…'
                              : 'Ask the AI to rethink size + position'
                        }
                      >
                        {isRethinkingOverlay ? '↻ …' : '↻ Rethink'}
                      </button>
                    )}
                    {onOpenOverlayEdit && (
                      <button
                        type="button"
                        onClick={onOpenOverlayEdit}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{
                          background: 'rgba(168,85,247,0.14)',
                          color: '#c084fc',
                          border: '1px solid rgba(168,85,247,0.30)',
                          cursor: 'pointer',
                        }}
                        title="Edit this overlay image with AI (Smart edit or Brush mask)"
                      >
                        ✎ Edit
                      </button>
                    )}
                    {onUndoOverlayEdit && undoDepth > 0 && (
                      <button
                        type="button"
                        onClick={onUndoOverlayEdit}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          color: 'var(--fg-muted)',
                          border: '1px solid rgba(255,255,255,0.10)',
                          cursor: 'pointer',
                        }}
                        title={
                          undoDepth === 1
                            ? 'Undo the most recent AI edit'
                            : `Undo the most recent AI edit (${undoDepth} stored — click again to step back)`
                        }
                      >
                        <span className="inline-flex items-center gap-1">
                          <Undo2 size={11} strokeWidth={2} />
                          <span>Undo{undoDepth > 1 ? ` (${undoDepth})` : ''}</span>
                        </span>
                      </button>
                    )}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                    Right-click for more actions (Replace / Reset / Remove).
                  </div>
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-1 text-[10px]">
            <Badge label={shot.sceneType} />
            {shot.videoUrl ? (
              <Badge label="animated" tone="purple" />
            ) : shot.imageUrl ? (
              <Badge label="still + Ken Burns" tone="default" />
            ) : (
              <Badge label="text card" tone="default" />
            )}
            {shot.muted && <Badge label="muted" tone="red" />}
          </div>
        </div>

        {/* Shot Type — visual_type dropdown + Title Card workflow
            buttons (make / split / apply-as-section-title). Hidden
            entirely when the parent didn't wire onSetRowVisualType
            so a read-only inspector mount stays clean.
            See `_plans/2026-05-27-editor-variants-titles-notes.md`. */}
        {onSetRowVisualType && (
          <InspectorShotTypePanel
            row={row}
            detectedHeading={detectLeadingHeading(row.script_text ?? '')}
            applySectionTitleAffectedCount={(() => {
              if (row.visual_type !== 'Title Card') return 0;
              let endIndex = doc.rows.length - 1;
              for (let i = shotIndex + 1; i < doc.rows.length; i++) {
                if (doc.rows[i]?.visual_type === 'Title Card') {
                  endIndex = i - 1;
                  break;
                }
              }
              return Math.max(0, endIndex - shotIndex);
            })()}
            onSetVisualType={onSetRowVisualType}
            onSplitAsTitleCard={onSplitAsTitleCard ?? (() => {})}
            onApplyTitleCardAsSectionTitle={
              onApplyTitleCardAsSectionTitle ?? (() => {})
            }
          />
        )}

        {/* Variants — add / generate / move / delete affordances. The
            panel hides ALL controls when no writers are wired, which
            mirrors the read-only convention of the rest of this
            inspector. */}
        {onAddVariantRow && onUpdateRow && (
          <InspectorVariantsPanel
            row={row}
            rowIndex={shotIndex}
            doc={doc}
            rowImages={rowImagesMap ?? {}}
            genState={variantGenState ?? { kind: 'idle' }}
            onAddVariant={onAddVariantRow}
            onDeleteVariant={onDeleteVariantRow ?? (() => {})}
            onMoveVariant={onMoveVariantRow ?? (() => {})}
            onPatchRow={onUpdateRow}
            onGenerateVariant={onGenerateVariant ?? (() => {})}
            onSelectRow={onSelectRowIndex ?? (() => {})}
          />
        )}

        {/* Per-row notes — bottom of the inspector body so the more
            frequently-edited fields stay above the fold. The
            timeline-level NotesDock is separate from this. */}
        {onCommitNotes && (
          <InspectorNotesPanel row={row} onCommit={onCommitNotes} />
        )}
      </div>

      <footer
        className="p-3 border-t text-[11px]"
        style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
      >
        For doc-wide edits, head back to{' '}
        <Link href="/production-doc" className="underline">
          Production Doc
        </Link>
        . All edits here round-trip through the same save endpoint.
      </footer>

      {/* TransitionDialog (Batch C follow-up). Self-contained portal —
          renders into document.body so the inspector's overflow:auto
          doesn't clip it. Open only when the shot has a region zoom
          target; closed on save / reset / Escape. */}
      {transitionDialogOpen && onUpdateRow && (
        <TransitionDialog
          title={`Zoom transition · shot ${shotIndex + 1}`}
          description={`Customize how the camera enters region "${
            docThumbnail?.regions.find((r) => r.id === row.thumbnail_zoom_to)?.label ||
            row.thumbnail_zoom_to ||
            ''
          }". Resetting falls back to the doc-level default.`}
          current={row.thumbnail_transition}
          fallback={docThumbnail?.defaultTransition}
          resetLabel="Reset to doc default"
          onSave={(t: ThumbnailTransitionConfig) => {
            console.info('[editor transition] save', { shotIndex, kind: t.kind });
            onUpdateRow({ thumbnail_transition: t });
            setTransitionDialogOpen(false);
          }}
          onReset={() => {
            console.info('[editor transition] reset', { shotIndex });
            onUpdateRow({ thumbnail_transition: undefined });
            setTransitionDialogOpen(false);
          }}
          onClose={() => setTransitionDialogOpen(false)}
        />
      )}
    </aside>
  );
}

interface FieldProps {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: 'muted' | null;
}

function Field({ label, value, mono = false, highlight = null }: FieldProps): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="font-medium" style={{ color: 'var(--fg)' }}>
        {label}
        {highlight === 'muted' && (
          <span className="ml-1" style={{ color: '#f87171' }}>
            (muted)
          </span>
        )}
      </div>
      <div
        className={mono ? 'font-mono whitespace-pre-wrap break-words' : 'whitespace-pre-wrap break-words'}
        style={{ color: 'var(--fg-muted)' }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Editable single-line input. Local draft state buffers keystrokes;
 * the commit fires on blur OR when the user presses Enter, so the
 * undo stack records one entry per logical edit instead of one per
 * keystroke. Empty strings are passed through unchanged — callers
 * decide whether to remap "" → undefined for nullable fields.
 */
function EditableInput({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  // Keep the draft in sync if the canonical value changes from
  // outside (e.g. undo / redo, doc regen). The cheap reference check
  // avoids clobbering an in-progress edit.
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className="space-y-1">
      <div className="font-medium" style={{ color: 'var(--fg)' }}>
        {label}
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        className="w-full text-xs rounded border px-2 py-1.5"
        style={{
          borderColor: 'var(--card-border)',
          background: 'var(--bg)',
          color: 'var(--fg)',
        }}
      />
    </div>
  );
}

/**
 * Editable multi-line textarea. Same blur-to-commit behaviour as
 * `EditableInput`; Enter inserts a newline (typical textarea
 * semantics) — callers blur to commit.
 */
function EditableTextarea({
  label,
  value,
  onCommit,
  minRows = 2,
  mono = false,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  minRows?: number;
  mono?: boolean;
  placeholder?: string;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className="space-y-1">
      <div className="font-medium" style={{ color: 'var(--fg)' }}>
        {label}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={placeholder}
        rows={minRows}
        className={`w-full text-xs rounded border px-2 py-1.5 resize-y ${mono ? 'font-mono' : ''}`}
        style={{
          borderColor: 'var(--card-border)',
          background: 'var(--bg)',
          color: 'var(--fg)',
          minHeight: `${minRows * 1.6}em`,
        }}
        spellCheck
      />
    </div>
  );
}

interface BadgeProps {
  label: string;
  tone?: 'default' | 'purple' | 'red';
}

function Badge({ label, tone = 'default' }: BadgeProps): React.ReactElement {
  const palette = {
    default: { bg: 'rgba(255,255,255,0.08)', fg: 'var(--fg-muted)' },
    purple: { bg: 'rgba(167,139,250,0.18)', fg: 'var(--accent-purple-bright, #a78bfa)' },
    red: { bg: 'rgba(248,113,113,0.18)', fg: '#fca5a5' },
  }[tone];
  return (
    <span
      className="rounded px-1.5 py-0.5"
      style={{ background: palette.bg, color: palette.fg }}
    >
      {label}
    </span>
  );
}

// ─── Per-row free-transform controls ───────────────────────────────
//
// Canva-style position / scale / rotation inputs for the shot's
// visual. Composes WITH `scene_zoom`: scene_zoom is the coarse uniform
// shortcut, these fields are the fine control. The renderer composes
// them inside the BRollScene's existing zoom wrapper, so identity
// values (0/0/100/0) are render-identical to today.
function ShotFreeTransformControls({
  row,
  doc,
  hasVisual,
  onUpdate,
  onApplyTransformToAll,
}: {
  row: ProductionDoc['rows'][number];
  /** The parent doc — needed so the auto-shift recommendation can
   *  read the doc-level section_title_layout_default and the
   *  composite thumbnail's stripeHeightFraction. */
  doc: ProductionDoc;
  /** Whether this row has any visual on the canvas. The auto-shift
   *  recommendation only fires when there's something to shift. */
  hasVisual: boolean;
  onUpdate: (patch: Partial<ProductionDoc['rows'][number]>) => void;
  /** Optional: copy THIS row's transform to every shot in the doc.
   *  When undefined the "Apply to all" button is hidden. */
  onApplyTransformToAll?: (transform: {
    image_x_pct?: number;
    image_y_pct?: number;
    image_scale_pct?: number;
    image_rotation_deg?: number;
  }) => void;
}): React.ReactElement {
  const x = typeof row.image_x_pct === 'number' ? row.image_x_pct : 0;
  const y = typeof row.image_y_pct === 'number' ? row.image_y_pct : 0;
  const scale =
    typeof row.image_scale_pct === 'number' ? row.image_scale_pct : 100;
  const rot =
    typeof row.image_rotation_deg === 'number' ? row.image_rotation_deg : 0;
  const isIdentity = x === 0 && y === 0 && scale === 100 && rot === 0;

  // Smart auto-shift availability for this row. Returns the recommended
  // y_pct when the row qualifies (overlay-mode title with busy top
  // saliency); null otherwise. When the user has a manual y override
  // the recommendation is hidden — their value already wins.
  const autoShift = computeAutoShiftYPct(row, doc, hasVisual);
  const hasManualY = typeof row.image_y_pct === 'number';
  const showAutoShiftHint = autoShift !== null && !hasManualY;
  const autoShiftAlreadyApplied =
    hasManualY &&
    autoShift !== null &&
    Math.abs((row.image_y_pct ?? 0) - autoShift.yPct) < 0.5;

  const update = (patch: Partial<ProductionDoc['rows'][number]>) => {
    console.info('[editor transform commit] numeric', {
      from: {
        x: row.image_x_pct,
        y: row.image_y_pct,
        scale: row.image_scale_pct,
        rot: row.image_rotation_deg,
      },
      to: { ...patch },
    });
    onUpdate(patch);
  };
  const resetField = (key: 'image_x_pct' | 'image_y_pct' | 'image_scale_pct' | 'image_rotation_deg') =>
    update({ [key]: undefined });
  const resetAll = () =>
    update({
      image_x_pct: undefined,
      image_y_pct: undefined,
      image_scale_pct: undefined,
      image_rotation_deg: undefined,
    });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium" style={{ color: 'var(--fg)' }}>
          Transform
        </span>
        <button
          type="button"
          onClick={resetAll}
          disabled={isIdentity}
          className="text-[10px] underline disabled:opacity-30 disabled:no-underline"
          style={{ color: 'var(--fg-muted)' }}
          title="Reset position, scale, and rotation for this shot."
        >
          Reset
        </button>
      </div>
      <FreeTransformRow
        label="X"
        suffix="%"
        value={x}
        min={-200}
        max={200}
        step={1}
        active={typeof row.image_x_pct === 'number'}
        onChange={(v) => update({ image_x_pct: v === 0 ? undefined : v })}
        onReset={() => resetField('image_x_pct')}
      />
      <FreeTransformRow
        label="Y"
        suffix="%"
        value={y}
        min={-200}
        max={200}
        step={1}
        active={typeof row.image_y_pct === 'number'}
        onChange={(v) => update({ image_y_pct: v === 0 ? undefined : v })}
        onReset={() => resetField('image_y_pct')}
      />
      <FreeTransformRow
        label="Scale"
        suffix="%"
        value={scale}
        min={10}
        max={400}
        step={1}
        active={typeof row.image_scale_pct === 'number'}
        onChange={(v) =>
          update({ image_scale_pct: v === 100 ? undefined : v })
        }
        onReset={() => resetField('image_scale_pct')}
      />
      <FreeTransformRow
        label="Rotate"
        suffix="°"
        value={rot}
        min={-180}
        max={180}
        step={1}
        active={typeof row.image_rotation_deg === 'number'}
        onChange={(v) =>
          update({ image_rotation_deg: v === 0 ? undefined : v })
        }
        onReset={() => resetField('image_rotation_deg')}
      />
      <div
        className="text-[10px] mt-1"
        style={{ color: 'var(--fg-muted)' }}
      >
        Composes with Layout → Scene zoom. Drag the visual in the
        preview or use the corner + rotate handles for direct control.
      </div>

      {/* Smart auto-fix surface. Shown when:
          - row qualifies (overlay-mode title + saliency busy at top)
          - AND the user hasn't already overridden Y.
          The renderer applies the same value automatically; this
          button just makes the value EXPLICIT on the row so the user
          can see it in the slider and tweak it after. */}
      {showAutoShiftHint && autoShift && (
        <div
          className="text-[10px] rounded px-2 py-1.5 flex items-start gap-2"
          style={{
            background: 'rgba(168,85,247,0.10)',
            border: '1px solid rgba(168,85,247,0.3)',
            color: 'var(--editor-accent, #a78bfa)',
          }}
        >
          <span aria-hidden style={{ fontSize: 12, lineHeight: '14px' }}>✨</span>
          <div className="flex-1 leading-snug">
            <div className="font-medium">Auto-fix recommended</div>
            <div
              className="opacity-80"
              style={{ color: 'var(--fg-muted)' }}
            >
              The title would cover busy image content
              ({Math.round(autoShift.collisionScore * 100)}% saliency in the top
              stripe). The renderer is already shifting this row down
              by {autoShift.yPct.toFixed(0)}% at preview/render time.
              Click Apply to make the value explicit so you can tweak it.
            </div>
            <button
              type="button"
              onClick={() => {
                console.info('[editor transform auto-fix] apply', {
                  yPct: autoShift.yPct,
                });
                onUpdate({ image_y_pct: autoShift.yPct });
              }}
              className="mt-1 text-[10px] underline"
              style={{ color: 'var(--editor-accent, #a78bfa)' }}
            >
              Apply (Y = {autoShift.yPct.toFixed(0)}%)
            </button>
          </div>
        </div>
      )}
      {autoShiftAlreadyApplied && (
        <div
          className="text-[10px]"
          style={{ color: 'var(--fg-muted)' }}
        >
          ✨ This Y value matches the smart auto-fix recommendation.
        </div>
      )}
      {onApplyTransformToAll && !isIdentity && (
        <button
          type="button"
          onClick={() => {
            if (
              !window.confirm(
                'Apply this transform (X, Y, Scale, Rotate) to every shot in the doc? Per-row overrides on other shots will be replaced.',
              )
            )
              return;
            console.info('[editor transform] apply-to-all', {
              transform: {
                image_x_pct: row.image_x_pct,
                image_y_pct: row.image_y_pct,
                image_scale_pct: row.image_scale_pct,
                image_rotation_deg: row.image_rotation_deg,
              },
            });
            onApplyTransformToAll({
              image_x_pct: row.image_x_pct,
              image_y_pct: row.image_y_pct,
              image_scale_pct: row.image_scale_pct,
              image_rotation_deg: row.image_rotation_deg,
            });
          }}
          className="text-[10px] underline"
          style={{ color: 'var(--editor-accent, #a78bfa)' }}
          title="Copy these X/Y/Scale/Rotate values to every shot in the doc."
        >
          Apply to all shots
        </button>
      )}
    </div>
  );
}

function FreeTransformRow({
  label,
  suffix,
  value,
  min,
  max,
  step,
  active,
  onChange,
  onReset,
}: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  step: number;
  active: boolean;
  onChange: (next: number) => void;
  onReset: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <label
        className="text-[10px] uppercase tracking-wider w-12 shrink-0"
        style={{ color: 'var(--fg-muted)' }}
      >
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1"
        style={{ accentColor: 'var(--editor-accent, #a78bfa)' }}
        aria-label={`${label}${suffix}`}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const raw = Number(e.target.value);
          if (!Number.isFinite(raw)) return;
          const clamped = Math.max(min, Math.min(max, raw));
          onChange(clamped);
        }}
        className="text-[11px] tabular-nums w-14 rounded border px-1 py-0.5"
        style={{
          borderColor: active ? 'var(--editor-accent, #a78bfa)' : 'var(--card-border)',
          background: 'var(--bg)',
          color: active ? 'var(--editor-accent, #a78bfa)' : 'var(--fg)',
        }}
        aria-label={`${label} value`}
      />
      <span
        className="text-[10px] tabular-nums w-3"
        style={{ color: 'var(--fg-muted)' }}
      >
        {suffix}
      </span>
      <button
        type="button"
        onClick={onReset}
        disabled={!active}
        className="text-[10px] underline disabled:opacity-30 disabled:no-underline w-8 text-right"
        style={{ color: 'var(--fg-muted)' }}
        title={`Reset ${label}`}
      >
        ↺
      </button>
    </div>
  );
}

// ─── Per-row clip-fit picker ───────────────────────────────────────
//
// Per-row policy for how the renderer reconciles a clip's intrinsic
// duration with the scene's duration when they differ. Four options:
//
//   - Stretch (default): rescale playbackRate to fit. Slow-mo when
//     scene > clip, speed-up when scene < clip.
//   - Freeze last: play at native speed, freeze the last frame for
//     the remainder. Scene > clip only.
//   - Loop: play at native speed, restart from frame 0 when the clip
//     ends, until the scene's done.
//   - Trim scene: NOT a render policy. Writes the row's
//     duration_override_ms = clip_duration so the scene's playable
//     window matches the clip's intrinsic duration exactly. Cleaner
//     than render-time gymnastics when the user genuinely wants the
//     scene to be the clip's length.
function ShotClipFitPicker({
  row,
  shotVideoDurationSeconds,
  onUpdate,
}: {
  row: ProductionDoc['rows'][number];
  shotVideoDurationSeconds?: number;
  onUpdate: (patch: Partial<ProductionDoc['rows'][number]>) => void;
}): React.ReactElement {
  const current = row.clip_fit_mode ?? 'stretch';
  const options: Array<{
    value: 'stretch' | 'freeze-last' | 'loop' | 'trim-scene';
    label: string;
    description: string;
  }> = [
    {
      value: 'stretch',
      label: 'Stretch',
      description: 'Slow-mo / speed-up to fit. Default.',
    },
    {
      value: 'freeze-last',
      label: 'Freeze last',
      description: 'Native speed; hold last frame if scene is longer.',
    },
    {
      value: 'loop',
      label: 'Loop',
      description: 'Native speed; restart clip when it ends.',
    },
    {
      value: 'trim-scene',
      label: 'Trim scene',
      description:
        'Shorten the scene to match the clip exactly (writes duration_override).',
    },
  ];
  const handleSelect = (
    value: 'stretch' | 'freeze-last' | 'loop' | 'trim-scene',
  ) => {
    console.info('[editor clip-fit] changed', {
      from: row.clip_fit_mode,
      to: value,
      shotVideoDurationSeconds,
    });
    if (value === 'trim-scene') {
      // Trim is a data operation: set duration_override_ms to the
      // clip's intrinsic duration so the scene matches. ALSO clear
      // the clip_fit_mode (or set to stretch) since the renderer
      // would now see matched durations and stretch becomes a no-op.
      // Skip silently when we don't know the clip duration (the
      // renderer would have no value to fall back to either).
      if (
        typeof shotVideoDurationSeconds !== 'number' ||
        !Number.isFinite(shotVideoDurationSeconds) ||
        shotVideoDurationSeconds <= 0
      ) {
        toast.error(
          'Clip duration unknown — pick a different mode or wait for the clip to finish generating.',
        );
        return;
      }
      const nextDurationMs = Math.round(shotVideoDurationSeconds * 1000);
      onUpdate({
        duration_override_ms: nextDurationMs,
        clip_fit_mode: undefined,
      });
      toast.success(
        `Scene trimmed to ${shotVideoDurationSeconds.toFixed(1)}s — matches clip duration.`,
      );
      return;
    }
    onUpdate({ clip_fit_mode: value === 'stretch' ? undefined : value });
  };
  return (
    <div className="space-y-1">
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--fg-muted)' }}
      >
        Clip fit
      </div>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => {
          const isActive = current === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleSelect(opt.value)}
              title={opt.description}
              className="text-[10px] px-1.5 py-1 rounded border transition-colors"
              style={{
                borderColor: isActive
                  ? 'var(--editor-accent, #a78bfa)'
                  : 'var(--card-border)',
                color: isActive ? 'var(--editor-accent, #a78bfa)' : 'var(--fg)',
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Per-row B-roll model picker ───────────────────────────────────
//
// Mirrors prod-doc's BrollCell model picker (BrollCell.tsx:1120+) but
// flattened for the inspector — single dropdown grouped by family. The
// renderer's tier priority is row > doc > workspace, so the dropdown
// reflects the row's pick (or shows "Default" when cleared). Clearing
// writes `broll_model_id: undefined` on the row, falling back to the
// doc default which itself falls back to the workspace default.
function ShotBrollModelPicker({
  rowModelId,
  docModelId,
  workspaceModelId,
  onChange,
}: {
  rowModelId: string | undefined;
  docModelId: string | undefined;
  workspaceModelId: string | undefined;
  onChange: (next: string | undefined) => void;
}): React.ReactElement {
  const localStudioEnabled = useLocalStudioEnabled();
  const i2vModels = useMemo(
    () =>
      BROLL_MODELS.filter((m) => m.kind === 'image-to-video').filter(
        (m) => localStudioEnabled || m.provider !== 'comfyui-local',
      ),
    [localStudioEnabled],
  );
  // Resolve what "Default" means right now so the user can read the
  // dropdown label without guessing. Empty value = "use Default".
  const fallbackId = docModelId ?? workspaceModelId;
  const fallback = fallbackId
    ? BROLL_MODELS.find((m) => m.id === fallbackId)
    : null;
  const defaultLabel = fallback
    ? `Default — ${fallback.label}${
        docModelId ? ' (doc setting)' : ' (workspace setting)'
      }`
    : 'Default — workspace setting';
  return (
    <select
      value={rowModelId ?? ''}
      onChange={(e) => {
        const next = e.target.value || undefined;
        console.info('[editor row-broll-model] changed', {
          from: rowModelId,
          to: next,
        });
        onChange(next);
      }}
      className="w-full text-xs rounded border px-2 py-1.5"
      style={{
        borderColor: 'var(--card-border)',
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
      aria-label="Animation model for this shot"
    >
      <option value="">{defaultLabel}</option>
      {i2vModels.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label} — {m.priceUsdLabel}
        </option>
      ))}
    </select>
  );
}

// Per-row image (still) model picker lives at
// `./inspector/ShotImageModelPicker.tsx` — lifted 2026-06-09 so the
// motion-collage inspector branch (InspectorMotionCollagePanel) can
// reuse it without duplicating the local-studio gate, default label
// resolution, and styling. Imported at the top of this file.
