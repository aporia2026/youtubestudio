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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Sparkles, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatI2ICostHint } from '@/lib/image-models-i2i';
import type { ProductionDoc, RowOverlayRenderState } from '@/remotion/utils';
import type { ThumbnailTransitionConfig, VideoShot, VideoThumbnail } from '@/remotion/types';
import { ShotLayoutControls } from '@/components/editor/inspector/ShotLayoutControls';
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
  /** Live B-roll clip status for this row. Drives the "Generate"
   *  button's label / disabled state — `generating` collapses it
   *  into a busy spinner; `ready` hides it (clip is already there). */
  clipStatus?: string;
  /** Workspace's currently-resolved B-roll model id. Surfaced as a
   *  small caption next to the generate button so the user knows
   *  what they're about to spend on. */
  brollModelId?: string;
  /** Called when the user edits the row's voiceover script (inline
   *  textarea OR via the AI rephrase button). Dispatches
   *  SET_ROW_SCRIPT. */
  onUpdateScript?: (text: string) => void;
  /** Called when the user edits any other row field inline (visual
   *  description, AI image prompt, on-screen text, section title).
   *  Dispatches PATCH_ROW so each edit lands on the undo stack and
   *  auto-save picks it up. */
  onUpdateRow?: (patch: Partial<ProductionDoc['rows'][number]>) => void;
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
  /** Open the mask-brush image edit dialog for this shot. The parent
   *  mounts MaskBrushEditor + calls the image-edit endpoint. */
  onOpenImageEdit?: () => void;
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
}

function fmt(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

const ACCEPT_IMAGE_TYPES = 'image/jpeg,image/png,image/webp,image/gif';

export function ShotInspector({
  shotIndex,
  shot,
  row,
  thumbnailUrl,
  totalShots,
  projectId,
  stylePreset,
  activeStyleI2IModel,
  onClose,
  onUploadImage,
  onPickProjectClip,
  onGenerateClip,
  clipStatus,
  brollModelId,
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
  onOpenImageEdit,
}: ShotInspectorProps): React.ReactElement {
  const undoDepth = editHistoryDepth ?? 0;
  const overlayReady = overlayState?.status === 'done' && Boolean(overlayState.url);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading'; fileName: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const [regenState, setRegenState] = useState<
    | { kind: 'idle' }
    | { kind: 'generating' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // TransitionDialog open/close. Self-contained — the dialog owns its
  // working copy; we only listen for `onSave` + `onReset` and dispatch
  // through `onUpdateRow`. Only meaningful when this shot has a
  // `thumbnail_zoom_to` region set.
  const [transitionDialogOpen, setTransitionDialogOpen] = useState(false);

  // Recursive — call site re-invokes itself with accumulated
  // `excludeRefIds` after a 409 REFERENCE_REJECTED, mirroring the
  // production-doc page's regenerate flow. The server's already
  // flagged the offending refs as rejected; passing them in
  // `excludeRefIds` just makes the retry deterministic in case the
  // user clicks the toast Regenerate button before the flag write
  // commits.
  const handleRegenerate = useCallback(async (excludeRefIds: readonly string[] = []) => {
    if (!onUploadImage) return;
    const prompt = row.ai_image_prompt?.trim() || row.visual_description?.trim();
    if (!prompt) {
      setRegenState({
        kind: 'error',
        message: 'No prompt to regenerate from. Edit the row’s prompt first.',
      });
      return;
    }
    setRegenState({ kind: 'generating' });
    try {
      const res = await fetch('/api/generate/production-doc/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          onScreenText: row.on_screen_text ?? '',
          sectionTitle: row.section_title ?? '',
          // v2 (2026-05-22) — when the doc has a style preset pinned,
          // route the regenerate through the v2 i2i dispatcher so the
          // refs (if any) flow into the new image. Built-in slugs
          // resolve to origin='built-in' inside the route and fall
          // back to legacy T2I unchanged.
          styleId: stylePreset || undefined,
          excludeRefIds: excludeRefIds.length > 0 ? excludeRefIds : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        imageUrl?: string;
        rejectedRefIds?: string[];
      };
      // v2 — provider rejected one or more refs. Same UX as the
      // production-doc page: surface a toast with a one-click
      // Regenerate action that re-fires this function with the
      // rejected ids excluded. Server has already flagged them.
      //
      // Two safety gates:
      // (a) terminal state when all refs are rejected — keep offering
      //     "Regenerate" would just trigger another doomed call that
      //     falls back to T2I or errors;
      // (b) max-attempts cap so a misbehaving server can't loop the
      //     user through paid retries via rage-clicks. After ~$0.15
      //     of wasted spend (3 cloud i2i attempts) we stop offering
      //     the action.
      if (res.status === 409 && data?.code === 'REFERENCE_REJECTED') {
        const rejectedIds = data.rejectedRefIds ?? [];
        const accumulated = [...excludeRefIds, ...rejectedIds];
        const allRefsRejected = accumulated.length >= 8;
        const maxAttemptsHit = excludeRefIds.length >= 8; // already 8 prior excludes = 3rd+ click
        const n = rejectedIds.length;
        const offerRegenerate = !allRefsRejected && !maxAttemptsHit && rejectedIds.length > 0;
        const message = allRefsRejected
          ? 'All reference images rejected — edit the style and clear rejections before retrying.'
          : maxAttemptsHit
            ? 'Too many retries. Edit the style before trying again.'
            : `${n || 'One or more'} reference image${n === 1 ? '' : 's'} rejected by the provider — click Regenerate to retry without them.`;
        setRegenState({ kind: 'error', message });
        toast.error(
          allRefsRejected
            ? 'All reference images rejected.'
            : maxAttemptsHit
              ? 'Stopped retrying after multiple rejections.'
              : `${n || 'One or more'} reference image${n === 1 ? ' was' : 's were'} rejected by the provider.`,
          {
            duration: 10000,
            action: offerRegenerate
              ? {
                  label: 'Regenerate',
                  onClick: () => {
                    void handleRegenerate(accumulated);
                  },
                }
              : undefined,
          },
        );
        return;
      }
      if (!res.ok) {
        throw new Error(data?.error || `Generate failed: HTTP ${res.status}`);
      }
      if (typeof data.imageUrl !== 'string') {
        throw new Error('Server response missing imageUrl');
      }
      console.info('[editor inspector] regenerate complete', {
        shotIndex,
        imageUrl: data.imageUrl,
      });
      onUploadImage(data.imageUrl);
      setRegenState({ kind: 'idle' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[editor inspector] regenerate failed', { detail: message });
      setRegenState({ kind: 'error', message });
    }
  }, [onUploadImage, row.ai_image_prompt, row.visual_description, row.on_screen_text, row.section_title, shotIndex, stylePreset]);

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
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2 py-1 rounded border hover:bg-white/5 transition-colors"
          style={{ borderColor: 'var(--card-border)' }}
          title="Close inspector"
        >
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {thumbnailUrl && (
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
        )}

        {/* Replace media — upload only in this commit. The
            from-project picker + regenerate-from-prompt land in
            follow-up commits next to this section. */}
        {onUploadImage && (
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

            {/* Regenerate from this row's current prompt. Calls the
                existing /api/generate/production-doc/image route so
                pricing + rate-limit + R2 mirroring behave identically
                to a Production-Doc-page regenerate. */}
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void handleRegenerate()}
                disabled={regenState.kind === 'generating'}
                className="flex-1 text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
                style={{ borderColor: 'var(--card-border)' }}
                title="Re-run the image generator on this row's current prompt"
              >
                {regenState.kind === 'generating'
                  ? 'Regenerating…'
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
              <div className="text-[10px]" style={{ color: '#f87171' }}>
                {regenState.message}
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
            project below to swap it. */}
        {onGenerateClip && clipStatus !== 'ready' && (
          <div
            className="p-3 border-b space-y-2"
            style={{ borderColor: 'var(--card-border)' }}
          >
            <div className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
              Animate this shot
            </div>
            <button
              type="button"
              onClick={onGenerateClip}
              disabled={clipStatus === 'generating'}
              className="w-full flex items-center justify-center gap-2 text-xs px-3 py-2 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
              style={{
                borderColor: 'var(--accent-purple-bright, #a78bfa)',
                color:
                  clipStatus === 'generating'
                    ? 'var(--fg-muted)'
                    : 'var(--accent-purple-bright, #a78bfa)',
              }}
              title={
                clipStatus === 'generating'
                  ? 'Clip is generating — this can take 1-3 minutes depending on the model.'
                  : 'Generate a fresh B-roll animation for this shot using the workspace default model.'
              }
            >
              {clipStatus === 'generating' ? (
                <>
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  <span>Generating animation…</span>
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
            {brollModelId && (
              <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                Model: {brollModelId}.
                {' '}
                <Link
                  href="/settings"
                  className="underline"
                  style={{ color: 'var(--fg-muted)' }}
                >
                  Change default
                </Link>
              </div>
            )}
          </div>
        )}

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
          {onUpdateRow ? (
            <EditableTextarea
              label="Visual description"
              value={row.visual_description ?? ''}
              onCommit={(v) => onUpdateRow({ visual_description: v })}
              minRows={2}
            />
          ) : (
            <Field label="Visual description" value={row.visual_description || '—'} />
          )}
          {onUpdateRow ? (
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
          )}
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
              onUpdate={onUpdateRow}
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
