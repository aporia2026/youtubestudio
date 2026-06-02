'use client';

/**
 * Shot-graph editor client — Phase 2 foundation.
 *
 * Wires:
 *   – persisted ProductionDoc + rowImages from the server props
 *   – the Zustand-style store (`useEditorStore`) with auto-save
 *   – Remotion `<Player>` with memoized inputProps
 *   – Timeline strip showing every shot card
 *   – Save status indicator + manual Save button
 *   – Conflict toast offering Reload when the server rejects a save
 *   – Undo / Redo buttons (Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z also work
 *     via window-scoped listeners inside the hook)
 *
 * Per-command commits land their UI on top of this scaffold — the
 * timeline strip + side panel are the surfaces every command paints
 * onto. This commit ships ZERO editing commands (the store's
 * editing-command catalog is empty); the user can preview, scrub,
 * select a shot, undo / redo (no-ops with empty stacks), and manually
 * save (no-op since `isDirty` is always false until a command lands).
 *
 * Memoization rules (per the resolution of Q2 — `@remotion/player`
 * supports live `inputProps` updates without remount when the
 * reference is stable). All derived values use `useMemo` so the
 * player composition re-renders cheaply.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Player, type PlayerRef } from '@remotion/player';
import { YouTubeVideo } from '@/remotion/compositions/YouTubeVideo';
import {
  productionDocToVideoConfig,
  summarizeConfigForDiagnostics,
  composeVariantEditRequest,
  type ProductionDoc,
  type RowImageState,
  type RowOverlayRenderState,
  type RowVideoClipState,
} from '@/remotion/utils';
import type { ProjectPayload } from '@/lib/project/payload';
import {
  EDITOR_MIN_SHOT_MS,
  EDITOR_MAX_SHOT_MS,
  initialEditorState,
  rowStartTimesMs,
  rowEffectiveDurationMs,
  type EditorCommand,
} from '@/lib/editor/store';
import { reindexForCommand } from '@/lib/editor/reindex-for-command';
import { toast } from 'sonner';
import { useEditorStore } from '@/lib/editor/use-editor-store';
import { mutate } from '@/lib/mutate';
import { queueImageGen, reportUpstream429 } from '@/lib/image-gen-throttle';
import { Timeline } from '@/components/editor/Timeline';
import { ShotInspector } from '@/components/editor/ShotInspector';
import { StatusBar } from '@/components/editor/StatusBar';
import { EditorChrome } from '@/components/editor/EditorChrome';
import { EditorHeader } from '@/components/editor/EditorHeader';
import { ImageGenThrottleToast } from '@/components/editor/ImageGenThrottleToast';
import { TransportBar, type PlaybackRate } from '@/components/editor/TransportBar';
import { EditorLeftRail } from '@/components/editor/EditorLeftRail';
import { EditorInspector, type InspectorTabId } from '@/components/editor/EditorInspector';
import { GenerationHistoryPanel } from '@/components/editor/inspector/GenerationHistoryPanel';
import { InspectorLivePanel } from '@/components/editor/inspector/InspectorLivePanel';
import {
  markGenerationEventTerminal,
  recordGenerationKickoff,
} from '@/lib/editor/generation-events';
import { deriveAlignmentStatus } from '@/lib/editor/alignment-status';
import { computeAutoShiftYPct } from '@/remotion/utils';
import { TransformOverlay } from '@/components/editor/TransformOverlay';
import { BROLL_MODELS } from '@/lib/broll-types';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, getImageModelSpec } from '@/lib/image-models';
import { useLocalStudioEnabled } from '@/lib/local-studio-enabled';
import { InspectorAudioTab } from '@/components/editor/inspector/InspectorAudioTab';
import { InspectorCaptionsTab } from '@/components/editor/inspector/InspectorCaptionsTab';
import { TimelineV2 } from '@/components/editor/timeline-v2/TimelineV2';
import { SectionThumbnailModal } from '@/components/editor/SectionThumbnailModal';
import { MaskBrushEditor } from '@/components/production-doc/MaskBrushEditor';
import {
  DEFAULT_EDIT_OPTION_ID,
  getEditOption,
  type EditOption,
} from '@/lib/image-edit-pricing';
import {
  getLastEditOptionId,
  setLastEditOptionId,
} from '@/lib/editor/settings';
import type { ImageSaliencyMap } from '@/remotion/utils';
import {
  type ChannelVisualBrandKit,
  resolveBrandKitForRender,
} from '@/lib/channel-visual-brand-kit';
import { ProjectSwitcher } from '@/components/editor/ProjectSwitcher';
import { EditorEmptyState } from '@/components/editor/EditorEmptyState';
import { RenderModal, type RenderState } from '@/components/editor/RenderModal';
import {
  FlipOstToOverlayModal,
  computeAffectedRows,
} from '@/components/editor/FlipOstToOverlayModal';
import {
  BulkGenerateModal,
  computeMissingBaseImages,
  computeMissingVariants,
  computeMissingMotionCollages,
  computeAllEligibleMotionCollages,
} from '@/components/editor/BulkGenerateModal';
import { BrandKitModal } from '@/components/editor/BrandKitModal';
import { ShotsTab } from '@/components/editor/leftrail/ShotsTab';
import {
  EMPTY_FILTER as EMPTY_SHOT_FILTER,
  filterStorageKey as shotFilterStorageKey,
  isEmptyFilter as isEmptyShotFilter,
  parseFilter as parseShotFilter,
  serializeFilter as serializeShotFilter,
  type ShotFilter,
} from '@/lib/shot-filter';
import { MediaTab } from '@/components/editor/leftrail/MediaTab';
import { AudioTab } from '@/components/editor/leftrail/AudioTab';
import { CaptionsTab } from '@/components/editor/leftrail/CaptionsTab';
import { AIToolsTab } from '@/components/editor/leftrail/AIToolsTab';
import { SettingsTab } from '@/components/editor/leftrail/SettingsTab';
import {
  getAutoRegenCaptions,
  getDefaultZoomLevel,
  getShowThumbnails,
  getShowShortcutHints,
  getLeftRailDefaultTab,
  getVideoLaneHeight,
  getAudioLaneHeight,
  getDefaultPlaybackRate,
  getPreviewFitMode,
  getShowNarrationStrip,
  getNarrationFontSize,
  getClickShotToSeek,
  getShowMinimap,
  getMinimapWrapEnabled,
  getMinimapWrapThresholdMinutes,
  getInsertDefaultDurationMs,
  getInsertCarveSource,
} from '@/lib/editor/settings';
import { NarrationStrip } from '@/components/editor/NarrationStrip';
import type { CaptionsBundle } from '@/lib/editor/captions';
import {
  kickoffBrollGeneration,
  readBrollLsMap,
  writeBrollLsMap,
} from '@/components/production-doc/BrollCell';
import { brollRowSignatureInput, DEFAULT_BROLL_MODEL_ID, findBrollModel, pickModelForScene } from '@/lib/broll-types';
import { VoiceoverDriftReport } from '@/components/editor/VoiceoverDriftReport';
import { TextOverlayManager } from '@/components/editor/TextOverlayManager';
import { VoiceoverRegenModal } from '@/components/editor/VoiceoverRegenModal';
import { RegenerateFromScriptModal } from '@/components/editor/RegenerateFromScriptModal';
// Phase 5.2 overlay-port (commit B): the position editor, the AI edit
// dialog, and the right-click context menu are shared with the
// production-doc page. Mounting them here means every overlay control
// works identically across both editing surfaces.
import { OverlayPositionEditor } from '@/components/production-doc/OverlayPositionEditor';
import { OverlayEditDialog } from '@/components/production-doc/OverlayEditDialog';
import {
  OverlayContextMenu,
  type OverlayContextMenuItem,
} from '@/components/production-doc/OverlayContextMenu';
import { SetTimingPopover, formatTimecode as formatTimecodeLabel } from '@/components/editor/SetTimingPopover';

interface EditorClientProps {
  projectId: string;
  version: number;
  /** Canonical project payload, already migrated server-side via
   *  `loadProject`. The editor used to defensively re-parse the raw
   *  JSONB here, but Phase 1 of the parity refactor moved that work
   *  into the load path so every consumer (production-doc + editor)
   *  sees the same canonical shape. */
  payload: ProjectPayload;
}

function relativeTimeShort(thenMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - thenMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const PLACEHOLDER_DOC: ProductionDoc = {
  rows: [],
  title: '',
  niche: '',
  total_duration: '0',
  total_words: 0,
  speaking_pace_wpm: 150,
};

/** Timeline zoom — integer levels 1..10 (plan's `+`/`-` range).
 *  Levels map to px/sec geometrically so each step feels like the
 *  same proportional zoom: level 1 = 16 px/s (whole videos fit on
 *  screen), level 5 ≈ 94 px/s (the default), level 10 = 800 px/s
 *  (frame-level precision for trim drags). */
const ZOOM_MIN_LEVEL = 1;
const ZOOM_MAX_LEVEL = 10;
const ZOOM_DEFAULT_LEVEL = 5;
const ZOOM_STEP = 1;

function zoomLevelToPxPerSecond(level: number): number {
  const t = (level - ZOOM_MIN_LEVEL) / (ZOOM_MAX_LEVEL - ZOOM_MIN_LEVEL);
  return Math.round(16 * Math.pow(800 / 16, t));
}

export default function EditorClient({ projectId, version, payload }: EditorClientProps) {
  // Initial values for the store. After mount the store owns the
  // working copy; this destructure is just the seed handed to
  // `initialEditorState`. Everything else reads from `state.*` so
  // edits flow through the command pipeline and undo/redo works.
  const doc = payload.doc;
  const rowImages = payload.rowImages;

  // Voiceover drift report modal — toggled from the toolbar.
  const [showDriftReport, setShowDriftReport] = useState(false);
  // Doc-level text-overlay manager modal — toolbar entry point for
  // creating / editing master overlays (independent of any single
  // shot's `on_screen_text`).
  const [showOverlayManager, setShowOverlayManager] = useState(false);
  // Whole-VO regeneration modal. Triggered from the toolbar; on
  // success the editor reloads from server to pick up the new URL.
  const [showVoRegen, setShowVoRegen] = useState(false);
  // Regenerate-doc-from-script modal — heaviest action in the
  // editor. Server-side merge respects per-field editedAt.
  const [showRegenFromScript, setShowRegenFromScript] = useState(false);
  // Batch B — section thumbnail modal. Opens from the AI Tools tab
  // OR from the per-shot inspector's "Edit thumbnail / regions" link.
  const [showSectionThumbnail, setShowSectionThumbnail] = useState(false);
  // Batch C — per-shot AI image edit. The row whose still is being
  // edited via the mask-brush flow; `null` means the dialog is closed.
  // The dialog mounts MaskBrushEditor; on apply we call the same
  // /api/generate/production-doc/image/edit endpoint production-doc
  // uses and dispatch SET_ROW_IMAGE with the new URL.
  const [imageEditRow, setImageEditRow] = useState<number | null>(null);
  const [imageEditApplying, setImageEditApplying] = useState(false);
  // 2026-05-23: Same picker state production-doc owns. Initialised
  // from localStorage post-mount so SSR returns the default and the
  // client picks up the persisted value.
  const [imageEditOptionId, setImageEditOptionIdState] = useState<string>(DEFAULT_EDIT_OPTION_ID);
  useEffect(() => {
    const persisted = getLastEditOptionId(DEFAULT_EDIT_OPTION_ID);
    if (getEditOption(persisted)) setImageEditOptionIdState(persisted);
  }, []);
  const imageEditOption: EditOption =
    getEditOption(imageEditOptionId) ?? getEditOption(DEFAULT_EDIT_OPTION_ID)!;
  // The shot editor jumps straight into the brush surface (no
  // EditPanel intermediate), so the option must be mask-capable —
  // pick the cheapest mask-capable fallback when the persisted value
  // is prompt-only (which can happen if the user last edited from
  // production-doc with Nano Banana selected).
  const resolvedBrushOption: EditOption = imageEditOption.maskCapable
    ? imageEditOption
    : getEditOption('ideogram-v3-balanced')!;
  const updateImageEditOption = (next: EditOption) => {
    setImageEditOptionIdState(next.id);
    setLastEditOptionId(next.id);
  };
  // BrandKitModal open/close. Triggered from the inspector kebab
  // and from the AI Tools tab's brand-kit summary row.
  const [showBrandKit, setShowBrandKit] = useState(false);

  // ─── Batch E: render-to-MP4 ─────────────────────────────────────
  //
  // Same Lambda pipeline production-doc uses. The render runs server-
  // side; the editor only owns the kickoff + polling + UI state.
  // `null` means no render in flight or surfaced; otherwise the
  // RenderModal renders the appropriate body.
  const [renderState, setRenderState] = useState<RenderState | null>(null);
  // Persistent reference to the last completed render's download URL.
  // Set when a render transitions to 'done'; survives the user closing
  // the Render complete modal so the top-bar "Download MP4" button
  // stays accessible. Cleared only when a new render kicks off
  // (the old URL is stale) — never when the modal is dismissed.
  const [latestDownloadUrl, setLatestDownloadUrl] = useState<string | null>(null);
  // Channel visual brand kit — server-side default that the per-doc
  // visualKitOverride layers on top of. Fetched once on mount (or
  // when the channelId on the payload changes); the BrandKitModal
  // uses it as the "channel default" placeholder text.
  const [channelVisualKit, setChannelVisualKit] = useState<ChannelVisualBrandKit | null>(null);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    // Clean up the polling interval if the component unmounts mid-
    // render. The server-side job keeps running; we just stop
    // listening.
    return () => {
      if (renderPollRef.current) clearInterval(renderPollRef.current);
    };
  }, []);

  // ─── Fill blank shots: throttled bulk image generation ───────────
  //
  // The user clicks "Fill N blank shots" in the doc-defaults panel; we
  // run a 3-worker pool over every shot that has no image, calling the
  // same /api/generate/production-doc/image endpoint the single-shot
  // Regenerate uses. 3 was picked over prod-doc's chunked-2 because a
  // pool doesn't stall on the slowest call in a chunk, and 3 still
  // sits well under Kie's 30/min per-IP and per-user ceilings. See
  // _plans/2026-05-24-editor-fill-blank-shots.md.
  const [fillState, setFillState] = useState<'idle' | 'running'>('idle');
  const [fillProgress, setFillProgress] = useState<{
    done: number;
    total: number;
    failed: number;
  }>({ done: 0, total: 0, failed: 0 });
  const fillAbortRef = useRef<AbortController | null>(null);

  // PR 3 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md` —
  // cost-gated "Switch OST to overlay + regen" modal. Surfaces the
  // affected-row count and estimated cost before any spend.
  const [flipOstModalOpen, setFlipOstModalOpen] = useState(false);
  // 2026-06-02 — three bulk-generate cost-gated modals (user-asked-for):
  //   'base'     → Generate all Base images
  //   'variants' → Generate all Variations
  //   'collages' → Generate all motion collages
  // null when no modal is open. Same skeleton as flipOstModalOpen.
  const [bulkGenerateModal, setBulkGenerateModal] = useState<
    'base' | 'variants' | 'collages' | 'collages-regen' | null
  >(null);

  // Timeline zoom. Lives in the client because zoom is a viewing
  // preference, not part of the doc. The user's preferred default
  // comes from localStorage via `getDefaultZoomLevel()` (Phase 4b
  // settings audit); falls back to `ZOOM_DEFAULT_LEVEL` when the
  // setting is unset.
  const [zoomLevel, setZoomLevel] = useState<number>(() => getDefaultZoomLevel());
  // Transport playback rate — passed as a prop to `<Player>` (the ref
  // doesn't expose a setter). Local-only viewing preference. Default
  // comes from the per-device setting (1× unless the user changed it).
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(() => getDefaultPlaybackRate());
  // Which non-shot timeline lane currently owns the inspector. The
  // inspector tab is computed below as: shot selected ⇒ 'shot',
  // else falls back to this. Cleared whenever a shot is selected so
  // the inspector deterministically follows the most recent click.
  // Tracked in `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`
  // Phase 1.
  const [laneFocus, setLaneFocus] = useState<
    'audio' | 'captions' | 'overlays' | null
  >(null);
  const pixelsPerSecond = useMemo(() => zoomLevelToPxPerSecond(zoomLevel), [zoomLevel]);
  const handleZoomDelta = useCallback((delta: number) => {
    setZoomLevel((prev) =>
      Math.max(ZOOM_MIN_LEVEL, Math.min(ZOOM_MAX_LEVEL, prev + delta)),
    );
  }, []);

  // Forward ref to the store's `apply` so the row-reindex callback
  // (declared at useEditorStore construction time, before `apply` is
  // destructured) can dispatch SYNC_SERVER_VERSION after a successful
  // reindex POST. Filled in immediately after the destructure below.
  const applyRef = useRef<((cmd: EditorCommand) => void) | null>(null);

  // Hooks run unconditionally; conditional render via early return AFTER
  // the hooks declare their values.
  const store = useEditorStore(
    initialEditorState({
      doc: doc ?? PLACEHOLDER_DOC,
      rowImages,
      voiceoverUrl: payload.voiceoverUrl,
      captions: payload.captions,
      rowOverlays: payload.rowOverlays,
      rowVideoClips: payload.rowVideoClips,
      musicUrl: payload.musicUrl,
      brandKitOverride: payload.brandKitOverride,
      visualKitOverride: payload.visualKitOverride,
      channelId: payload.channelId,
      voiceoverAlignment: payload.voiceoverAlignment,
      flags: payload.flags,
      linkedProjectId: payload.linkedProjectId,
      linkedScheduleItemId: payload.linkedScheduleItemId,
      version,
    }),
    projectId,
    {
      // Structural-reindex side-effect: when the user inserts /
      // ripple-deletes a shot, OR undoes/redoes one of those, the
      // server's project_assets row_index keys must shift to match
      // the new shot positions. Without this fan-out, the next image
      // upload lands at the wrong index AND on refresh existing
      // assets appear on the wrong shots.
      //
      // See `_plans/2026-05-24-project-assets-extraction.md` §Reindex.
      onAfterCommand: ({ cmd, resolvedInner, prevState }) => {
        // ADD_VARIANT_ROW's insert index isn't part of the command (it
        // depends on the base's group membership), so the pure
        // reindexForCommand helper returns null for it. Compute the
        // insert position here from the pre-state — same algorithm as
        // the reducer — then synthesize an insert effect manually.
        const computeAddVariantInsert = (baseIndex: number): number => {
          const baseRow = prevState.doc.rows[baseIndex];
          if (!baseRow) return baseIndex + 1;
          const gid = baseRow.group_id;
          if (!gid) return baseIndex + 1;
          let lastGroupIndex = baseIndex;
          for (let i = baseIndex + 1; i < prevState.doc.rows.length; i++) {
            if (prevState.doc.rows[i]?.group_id === gid) lastGroupIndex = i;
            else break;
          }
          return lastGroupIndex + 1;
        };
        const addVariantEffect = (c: EditorCommand) =>
          c.type === 'ADD_VARIANT_ROW'
            ? { op: 'insert' as const, atIndex: computeAddVariantInsert(c.baseIndex) }
            : null;

        const effect =
          reindexForCommand(cmd)
          ?? (resolvedInner ? reindexForCommand(resolvedInner) : null)
          ?? addVariantEffect(cmd)
          ?? (resolvedInner ? addVariantEffect(resolvedInner) : null);
        if (!effect) return;
        console.info('[editor row-reindex] start', {
          op: effect.op,
          at_index: effect.atIndex,
          via: cmd.type,
        });
        void (async () => {
          try {
            // eslint-disable-next-line no-restricted-syntax -- awaited POST that returns the new version for SYNC_SERVER_VERSION; RPC, has its own retry loop
            const res = await fetch(
              `/api/edit/${encodeURIComponent(projectId)}/row-reindex`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ op: effect.op, atIndex: effect.atIndex }),
              },
            );
            if (!res.ok) {
              const detail = await res.text().catch(() => '');
              console.warn('[editor row-reindex] failed', {
                op: effect.op,
                at_index: effect.atIndex,
                status: res.status,
                detail: detail.slice(0, 200),
              });
              // Surface to the user — assets are now misaligned with
              // the client's view; ignoring it silently would mean
              // images move to the wrong shots on next refresh.
              toast.error(
                `Couldn't sync shot order to the server — refresh may show assets on the wrong shots. (HTTP ${res.status})`,
                { duration: 8000 },
              );
              return;
            }
            const data = (await res.json().catch(() => ({}))) as {
              version?: number;
              affected?: number;
            };
            console.info('[editor row-reindex] committed', {
              op: effect.op,
              at_index: effect.atIndex,
              affected: data.affected,
              new_version: data.version,
            });
            if (typeof data.version === 'number' && applyRef.current) {
              applyRef.current({ type: 'SYNC_SERVER_VERSION', version: data.version });
            }
          } catch (err) {
            console.warn('[editor row-reindex] threw', {
              op: effect.op,
              at_index: effect.atIndex,
              detail: err instanceof Error ? err.message : String(err),
            });
            toast.error(
              'Network error while syncing shot order — refresh may show assets on the wrong shots.',
              { duration: 8000 },
            );
          }
        })();
      },
    },
  );
  const { state, apply, flushSave, reloadFromServer, saveStatus, canUndo, canRedo } = store;
  applyRef.current = apply;

  // Fresh-state ref. Long-running async batches (fill-blank-shots
  // worker pool) close over state at kickoff time, so without this
  // ref they'd send the stale snapshot for every shot. The useEffect
  // below keeps stateRef.current pointed at the latest store state.
  // Mirrors applyRef's stale-closure dodge above.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Gate the "Local (free)" entries in the doc-level animation-model
  // picker. Same hook the prod-doc page uses so the same models surface
  // on both pages.
  const localStudioEnabled = useLocalStudioEnabled();

  // Generic asset-write helper. The full-payload PATCH endpoint is
  // asset-blind on the server (see src/lib/project/persist.ts), so every
  // editor mutation that targets the three asset maps (`rowImages`,
  // `rowOverlays`, `rowVideoClips`) must go through the atomic row-asset
  // endpoint or it will not persist. Fire-and-forget: local state was
  // already dispatched by the caller; this only handles the server write.
  //
  // Retry policy (2026-05-24): the project_assets table sits behind a
  // Vercel Postgres pool that occasionally drops a transient connection
  // or returns a 502 during regional flaps. Users were seeing
  // "Shot N image not saved" toasts on different shots throughout a
  // batch — none of those errors were data problems, just transient
  // 5xx. We retry up to 3 times total on 5xx + network errors with
  // exponential backoff (500ms, 1.5s, 3.5s — total ~5.5s before
  // surfacing failure). 4xx (413 too-large, 429 rate-limited, 404
  // not-found, 400 bad-input) short-circuit instantly because retry
  // can't help them. Per-retry log lines stay in the console so a
  // future investigation can grep for the pattern.
  const writeRowAsset = useCallback(
    (
      rowIndex: number,
      slot: 'image' | 'overlay' | 'clip',
      value: unknown,
      opts: {
        /** When true, suppress the user-facing toast on permanent
         *  failure. Used by the force-sync-all flow which shows one
         *  consolidated summary toast instead of N per-shot toasts.
         *  Console logging is unchanged so a developer can still
         *  diagnose what went wrong. */
        suppressToast?: boolean;
      } = {},
    ): Promise<{ ok: boolean; failureClass?: string; status?: number; message?: string }> => {
      // Returns a Promise so the force-sync-all loop can await each
      // write + tally results. Existing fire-and-forget callers ignore
      // the promise; their behaviour is unchanged.
      return (async () => {
        const slotLabel =
          slot === 'image' ? 'image' : slot === 'overlay' ? 'overlay' : 'clip';
        // Phase 3-followup (2026-05-30): route through the durable
        // outbox + ack promise. The mutate() chokepoint handles
        // retry / backoff / breaker / server-side dedup; the ack
        // promise gives us the response body so SYNC_SERVER_VERSION
        // still works. Replaces the inline MAX_ATTEMPTS=3 loop —
        // the outbox's retry policy is more generous (10 attempts,
        // exponential backoff to 60s) AND survives tab close, which
        // the inline loop did not.
        const handle = mutate('row-asset.set', {
          url: `/api/edit/${encodeURIComponent(projectId)}/row-asset`,
          method: 'POST',
          body: { rowIndex, slot, value },
        });
        const ack = await handle.ack;
        if (ack.ok) {
          const data = ack.data as { version?: number; deduped?: boolean } | undefined;
          if (data && typeof data.version === 'number') {
            // Keep the editor's local version aligned with the
            // server. Without this sync the next debounced PATCH
            // would fail the optimistic check and surface a
            // spurious conflict.
            apply({ type: 'SYNC_SERVER_VERSION', version: data.version });
          }
          console.info('[editor row-asset] written', {
            rowIndex,
            slot,
            newVersion: data?.version,
            intentId: handle.intentId,
            deduped: data?.deduped ?? false,
          });
          return { ok: true };
        }
        // Failure path — drainer exhausted retries (or hit a 4xx).
        // Try to extract the server-classified failure shape from
        // the reason string (which holds the response body for
        // HTTP failures, or the Error message for network throws).
        let serverFailureClass: string | undefined;
        let serverStep: string | undefined;
        let serverMessage: string | undefined;
        try {
          const parsed = JSON.parse(ack.reason) as {
            error?: string;
            failureClass?: string;
            step?: string;
          };
          serverFailureClass = parsed.failureClass;
          serverStep = parsed.step;
          serverMessage = parsed.error;
        } catch {
          /* reason wasn't JSON (network throw, raw 5xx HTML) */
        }
        const status = ack.status;
        const friendlyReason =
          serverFailureClass && serverMessage
            ? serverMessage
            : status === 413
              ? 'Project is too large to add another image. Delete some shots first.'
              : status === 429
                ? 'Too many uploads in a short window — try again in a minute.'
                : status === 404
                  ? 'Project not found on the server (was it deleted in another tab?).'
                  : status === undefined
                    ? 'Network error. Check your connection and try again.'
                    : status >= 500
                      ? `Server error after repeated retries — try again, or refresh.`
                      : `Couldn't save (HTTP ${status}).`;
        console.error('[editor row-asset] write failed permanently', {
          rowIndex,
          slot,
          status,
          intentId: handle.intentId,
          failure_class: serverFailureClass,
          step: serverStep,
          detail: ack.reason.slice(0, 200),
        });
        if (!opts.suppressToast) {
          toast.error(
            `Shot ${rowIndex + 1} ${slotLabel} not saved — ${friendlyReason}`,
            { duration: 8000 },
          );
        }
        return {
          ok: false,
          failureClass: serverFailureClass,
          status,
          message: friendlyReason,
        };
      })();
    },
    [apply, projectId],
  );

  // Commit a row image: dispatch locally AND persist via row-asset.
  const commitRowImage = useCallback(
    (rowIndex: number, url: string | null) => {
      apply({ type: 'SET_ROW_IMAGE', shotIndex: rowIndex, url });
      writeRowAsset(rowIndex, 'image', url);
      // Phase 5 QA fix: a new image makes the previously cached RMBG
      // cutout stale (it was generated against the OLD image). Clear
      // both fields so the renderer falls back to the new original
      // and the user can run RMBG again on it if they want. Without
      // this clear, "AI Replace with prompt…" or "AI Erase region…"
      // would change rowImages[i] but the renderer would keep showing
      // the old cutout because `image_rmbg_applied` was still true.
      //
      // Conditional dispatch — only fire the PATCH_ROW when the row
      // actually has RMBG state to clear. Saves an empty undo entry
      // for the (common) case where the row never had RMBG applied.
      const row = state.doc.rows[rowIndex];
      if (row && (row.image_rmbg_url || row.image_rmbg_applied === true)) {
        apply({
          type: 'PATCH_ROW',
          rowIndex,
          patch: { image_rmbg_url: undefined, image_rmbg_applied: undefined },
        });
      }
    },
    [apply, writeRowAsset, state.doc.rows],
  );

  // Indices of every shot that currently lacks an image. Source of
  // truth in the editor is `state.rowImages` — `state.doc.rows[i]`
  // does NOT carry the URL (`imageUrl` lives on the derived VideoShot,
  // not the raw row). Memoised so the Fill button's label re-renders
  // when shots gain/lose images without re-walking the array on every
  // render.
  const blankShotIndices = useMemo(
    () => state.doc.rows
      .map((_, i) => (state.rowImages[i] ? -1 : i))
      .filter((i): i is number => i >= 0),
    [state.doc.rows, state.rowImages],
  );

  // Bulk-fill every blank shot with a freshly-generated image. 3-worker
  // pool over /api/generate/production-doc/image — same endpoint the
  // inspector's Regenerate uses, so rate-limit + cost + R2 mirroring
  // are identical. Per-shot model resolution mirrors the inspector:
  // row.image_model > doc.image_model_default > server default. Each
  // worker pulls the next blank index from a shared queue when its
  // current call finishes, so we never stall on the slowest call. The
  // fillAbortRef's controller is shared by every in-flight fetch so a
  // Stop click aborts the whole batch at once.
  //
  // When `doc.collage_mode === true`, the queue holds work units instead
  // of bare indices: groups of 4 consecutive blanks become collage units,
  // the trailing <4 stay as single units. Each worker tries the collage
  // path for a 4-unit and per-chunk-falls-back to 4 single calls on
  // failure. Per-shot row.image_model overrides are honoured in the
  // single path; in collage mode the 4 cells must share one model, so
  // we always use doc.image_model_default for collage units — shots
  // with a row override fall through to the single path automatically
  // because they break the chunk's same-model run.
  // 2026-06-02 — optional `rowFilter` predicate added so the
  // bulk-generate buttons (Generate all Base / all Variations / all
  // motion collages) can constrain the worker to a subset without
  // forking the whole function. Predicate runs over (row, rowIndex)
  // and is applied AFTER the existing "missing image" filter; rows
  // that already have an image are skipped regardless. Undefined ⇒
  // full fill-blanks behaviour (every blank row).
  const runFillBlanks = useCallback(async (
    options?: {
      rowFilter?: (row: ProductionDoc['rows'][number], rowIndex: number) => boolean;
      /** Override the legacy "All shots already have an image" toast
       *  when the filtered run finds nothing. Callers use this for
       *  custom empty-state messages ("All base images already
       *  generated", etc.). */
      emptyMessage?: string;
    },
  ) => {
    if (fillState === 'running') return;
    const filter = options?.rowFilter;
    const initialBlanks = stateRef.current.doc.rows
      .map((row, i) => {
        if (stateRef.current.rowImages[i]) return -1;
        if (filter && !filter(row, i)) return -1;
        return i;
      })
      .filter((i): i is number => i >= 0);
    if (initialBlanks.length === 0) {
      toast.info(options?.emptyMessage ?? 'All shots already have an image.');
      return;
    }
    // Snapshot row count at kickoff so we can detect a structural
    // shift mid-run (insert/delete) and bail instead of writing to
    // the wrong index. The doc-reindex side-effect handles
    // project_assets, but our queue holds raw numeric indices.
    const lockedRowCount = stateRef.current.doc.rows.length;
    const docModelDefault = stateRef.current.doc.image_model_default;
    // Default: ON. Only an explicit `false` (set via the production-doc
    // settings toggle) opts out. Existing docs with no `collage_mode`
    // field automatically run collage after the 2026-05-26 flip.
    const collageOn = stateRef.current.doc.collage_mode !== false;
    const modelLabel =
      getImageModelSpec(docModelDefault ?? DEFAULT_IMAGE_MODEL)?.label ??
      'the default image model';

    // Build work units. In collage mode, group runs of 4 consecutive
    // blanks WHOSE ROWS DON'T HAVE A PER-SHOT MODEL OVERRIDE into
    // collage units; everything else is a single unit. A row with its
    // own image_model breaks the chunk so its override survives.
    type WorkUnit =
      | { kind: 'collage'; indices: number[] }
      | { kind: 'single'; index: number };
    const docRows = stateRef.current.doc.rows;
    const units: WorkUnit[] = [];
    if (collageOn) {
      let i = 0;
      while (i < initialBlanks.length) {
        // Try to fill a chunk of 4. Each candidate must have no
        // row-level model override (or share doc.image_model_default
        // explicitly). Anything else breaks the chunk and lands in
        // singles.
        const chunkCandidate: number[] = [];
        let j = i;
        while (j < initialBlanks.length && chunkCandidate.length < 4) {
          const rowIndex = initialBlanks[j];
          const rowOverride = docRows[rowIndex]?.image_model;
          if (rowOverride && rowOverride !== docModelDefault) break;
          chunkCandidate.push(rowIndex);
          j++;
        }
        if (chunkCandidate.length === 4) {
          units.push({ kind: 'collage', indices: chunkCandidate });
          i += 4;
        } else {
          // Partial chunk — emit the first as a single and try again
          // from i+1. Avoids stranding a shot with an override at the
          // start of what could have been a chunk.
          units.push({ kind: 'single', index: initialBlanks[i] });
          i += 1;
        }
      }
    } else {
      for (const idx of initialBlanks) units.push({ kind: 'single', index: idx });
    }

    const collageUnitCount = units.filter((u) => u.kind === 'collage').length;
    const singleUnitCount = units.length - collageUnitCount;
    // Concurrency: stays at min(3, units) because the worker pool's
    // benefit (no stall on slowest call) applies to chunks the same
    // way it applies to single shots. Collage chunks are heavier per
    // unit but still well under the 30/min Kie rate limit at this
    // concurrency (3 chunks in flight = 6 kie tasks max counting the
    // upscale).
    const CONCURRENCY = Math.min(3, units.length);
    // Rough ETA. Collage units ~30s each (1 gen + 1 upscale), singles
    // ~15s each. Floors at 1 so the prompt never reads "~0m".
    const totalSec = collageUnitCount * 30 + singleUnitCount * 15;
    const etaMin = Math.max(1, Math.ceil(totalSec / CONCURRENCY / 60));
    const breakdown = collageOn
      ? `${collageUnitCount} collage group${collageUnitCount === 1 ? '' : 's'} of 4`
      + (singleUnitCount > 0 ? ` + ${singleUnitCount} single shot${singleUnitCount === 1 ? '' : 's'}` : '')
      : `${initialBlanks.length} single shot${initialBlanks.length === 1 ? '' : 's'}`;
    const ok = window.confirm(
      `Generate ${initialBlanks.length} image${initialBlanks.length === 1 ? '' : 's'} ` +
      `using ${modelLabel}?\n\n` +
      `${breakdown}.\n` +
      `Estimated time: ~${etaMin} min (${CONCURRENCY} at a time so we don't hammer the API).\n` +
      `You can Stop mid-run; already-generated shots are kept.`,
    );
    if (!ok) return;

    console.info('[editor fill-blanks start]', {
      total: initialBlanks.length,
      collage_mode: collageOn,
      collage_units: collageUnitCount,
      single_units: singleUnitCount,
      modelDefault: docModelDefault ?? '(server default)',
      concurrency: CONCURRENCY,
    });
    const controller = new AbortController();
    fillAbortRef.current = controller;
    setFillState('running');
    setFillProgress({ done: 0, total: initialBlanks.length, failed: 0 });

    const queue = [...units];
    let nextIdx = 0;
    let succeeded = 0;
    let failed = 0;
    const startedAt = Date.now();
    const pull = (): WorkUnit | null => (nextIdx < queue.length ? queue[nextIdx++] : null);

    // Process a 4-shot collage chunk. On success, write all 4 row
    // images + saliencies. On any failure (network, fallback_needed,
    // malformed-after-retry), fall back to 4 single calls inline so
    // the chunk still produces images. The per-shot fallback inherits
    // the worker's abort signal so a Stop click halts it too.
    const generateCollageChunk = async (indices: number[]): Promise<void> => {
      const t0 = Date.now();
      const liveState = stateRef.current;
      if (liveState.doc.rows.length !== lockedRowCount) {
        controller.abort();
        return;
      }
      // Skip any chunk index that's already been filled (manual
      // regen mid-batch). If fewer than 4 remain, fall through to
      // singles for those instead of sending a partial collage.
      const stillBlank = indices.filter((i) => !liveState.rowImages[i]);
      if (stillBlank.length === 0) {
        // Whole chunk filled out from under us — count as done.
        succeeded += indices.length;
        setFillProgress((p) => ({ ...p, done: p.done + indices.length }));
        return;
      }
      if (stillBlank.length < 4) {
        for (const i of stillBlank) await generateOne(i);
        return;
      }
      // Build `cells` per row so the collage route's augmentCellPrompt
      // produces the same per-cell OST baking + safe-top bias that the
      // editor's single-shot path applies. Only `onScreenText` and
      // `sectionTitle` are sent from the editor (matching the single-
      // shot call's body shape) — mode and layout default server-side
      // to 'bake' and 'letterbox' respectively. See
      // _plans/2026-05-26-collage-default-on-with-per-cell-augmentation.md.
      const cells = stillBlank.map((i) => {
        const row = liveState.doc.rows[i];
        return {
          prompt: row?.ai_image_prompt?.trim() || row?.visual_description?.trim() || '',
          onScreenText: row?.on_screen_text ?? '',
          sectionTitle: row?.section_title ?? '',
        };
      });
      if (cells.some((c) => c.prompt.length === 0)) {
        // At least one shot has no usable prompt — fall back to
        // singles so generateOne can mark the empty ones as failed
        // individually (the collage route would 400 the whole chunk).
        for (const i of stillBlank) await generateOne(i);
        return;
      }
      try {
        const res = await queueImageGen('generate', 'editor-bulk-collage', () =>
          // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response (4 image URLs)
          fetch('/api/generate/production-doc/collage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cells, model: docModelDefault }),
            signal: controller.signal,
          }),
        );
        if (res.status === 429) reportUpstream429('generate', 'editor-bulk-collage');
        const data = (await res.json().catch(() => ({}))) as {
          status?: 'success' | 'fallback_needed';
          imageUrls?: string[];
          saliencies?: (ImageSaliencyMap | null)[];
          reason?: string;
          detail?: string;
          error?: string;
        };
        if (res.ok && data.status === 'success' && Array.isArray(data.imageUrls) && data.imageUrls.length === 4) {
          for (let k = 0; k < stillBlank.length; k++) {
            const shotIndex = stillBlank[k];
            const url = data.imageUrls[k];
            apply({ type: 'SET_ROW_IMAGE', shotIndex, url });
            writeRowAsset(shotIndex, 'image', url);
            const sal = data.saliencies?.[k];
            if (sal) updateRow(shotIndex, { image_saliency: sal });
          }
          succeeded += stillBlank.length;
          setFillProgress((p) => ({ ...p, done: p.done + stillBlank.length }));
          console.info('[editor fill-blanks collage ok]', {
            indices: stillBlank,
            durationMs: Date.now() - t0,
            model: docModelDefault ?? '(server default)',
          });
          return;
        }
        console.warn('[editor fill-blanks collage fallback]', {
          indices: stillBlank,
          reason: data.reason ?? `http_${res.status}`,
          detail: (data.detail ?? data.error ?? '').slice(0, 200),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn('[editor fill-blanks collage threw — falling back to single]', {
          indices: stillBlank,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Fallback: per-shot single calls for the chunk.
      for (const i of stillBlank) {
        if (controller.signal.aborted) return;
        await generateOne(i);
      }
    };

    const generateOne = async (shotIndex: number): Promise<void> => {
      const t0 = Date.now();
      // Re-read from the live state ref each iteration. Catches mid-
      // run prompt edits + skips shots that already got filled by
      // another path (e.g. user clicked Regenerate manually on this
      // shot while the worker was still queued).
      const liveState = stateRef.current;
      if (liveState.doc.rows.length !== lockedRowCount) {
        // Row count changed mid-batch — we can no longer trust the
        // index. Abort the whole batch instead of writing into the
        // wrong row.
        console.warn('[editor fill-blanks shot skip] row count changed', {
          shotIndex,
          lockedRowCount,
          currentRowCount: liveState.doc.rows.length,
        });
        controller.abort();
        return;
      }
      if (liveState.rowImages[shotIndex]) {
        // Already filled (manual regen, undo, etc.) — count as done
        // without spending a call.
        console.info('[editor fill-blanks shot skip] already has image', { shotIndex });
        succeeded += 1;
        setFillProgress((p) => ({ ...p, done: p.done + 1 }));
        return;
      }
      const row = liveState.doc.rows[shotIndex];
      if (!row) return;
      const prompt = row.ai_image_prompt?.trim() || row.visual_description?.trim();
      if (!prompt) {
        console.warn('[editor fill-blanks shot skip] no prompt', { shotIndex });
        failed += 1;
        setFillProgress((p) => ({ ...p, failed: p.failed + 1 }));
        return;
      }
      const model = row.image_model || liveState.doc.image_model_default || undefined;
      try {
        const res = await queueImageGen('generate', 'editor-bulk-single', () =>
          // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response (image URL + saliency)
          fetch('/api/generate/production-doc/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt,
              model,
              onScreenText: row.on_screen_text ?? '',
              sectionTitle: row.section_title ?? '',
              styleId: liveState.doc.style_preset || undefined,
            }),
            signal: controller.signal,
          }),
        );
        if (res.status === 429) reportUpstream429('generate', 'editor-bulk-single');
        const data = (await res.json().catch(() => ({}))) as {
          imageUrl?: string;
          error?: string;
        };
        if (!res.ok || typeof data.imageUrl !== 'string') {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        // Direct dispatch + persist (no commitRowImage detour) because
        // blank shots by definition have no prior image, so the RMBG-
        // clearing branch inside commitRowImage is a no-op. Avoiding
        // it also avoids the stale-closure risk on commitRowImage's
        // captured state.doc.rows.
        apply({ type: 'SET_ROW_IMAGE', shotIndex, url: data.imageUrl });
        writeRowAsset(shotIndex, 'image', data.imageUrl);
        succeeded += 1;
        setFillProgress((p) => ({ ...p, done: p.done + 1 }));
        console.info('[editor fill-blanks shot ok]', {
          shotIndex,
          durationMs: Date.now() - t0,
          model: model ?? '(server default)',
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : String(err);
        failed += 1;
        setFillProgress((p) => ({ ...p, failed: p.failed + 1 }));
        console.warn('[editor fill-blanks shot fail]', {
          shotIndex,
          error: message,
        });
      }
    };

    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let unit = pull(); unit !== null; unit = pull()) {
          if (controller.signal.aborted) return;
          if (unit.kind === 'collage') {
            await generateCollageChunk(unit.indices);
          } else {
            await generateOne(unit.index);
          }
        }
      }),
    );

    const cancelled = controller.signal.aborted;
    fillAbortRef.current = null;
    setFillState('idle');
    console.info('[editor fill-blanks done]', {
      succeeded,
      failed,
      cancelled,
      elapsedMs: Date.now() - startedAt,
    });
    if (cancelled) {
      toast.info(`Fill stopped — ${succeeded} of ${initialBlanks.length} shots filled.`);
    } else if (failed > 0) {
      toast.warning(
        `Filled ${succeeded} shot${succeeded === 1 ? '' : 's'}; ${failed} failed (see console).`,
      );
    } else {
      toast.success(`Filled ${succeeded} shot${succeeded === 1 ? '' : 's'}.`);
    }
    // `updateRow` is declared further down in this component, so
    // including it in the dep list would trip TS2448 (used-before-
    // declaration). It's a stable useCallback that doesn't change
    // between renders, so omitting it is safe — the closure resolves
    // to the same reference every fillBlanks invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply, fillState, writeRowAsset]);

  // PR 3 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md` —
  // confirm handler for the "Switch OST to overlay + regen" modal.
  // Three steps in order:
  //   1. PATCH_DOC sets on_screen_text_mode_default = 'overlay' so future
  //      generations skip baking text into pixels and the renderer
  //      mounts a LowerThird overlay instead.
  //   2. For every affected row, SET_ROW_IMAGE(null) clears the image
  //      URL — making the row a "blank" that fill-blanks picks up.
  //   3. Kick off runFillBlanks (next tick so state-flush settles)
  //      which regenerates every blanked row at the new overlay setting.
  //
  // Each step is its own command in the undo stack — the user can Cmd+Z
  // through (a) regen result, (b) image-url clears, (c) doc mode flip.
  // The mass regen IS the cost driver; the modal pinned an estimate
  // before this handler fires.
  const handleFlipOstConfirm = useCallback(() => {
    const affected = computeAffectedRows(state.doc, state.rowImages);
    console.info('[editor flip-ost confirm]', {
      affectedCount: affected.length,
      docDefaultBefore: state.doc.on_screen_text_mode_default ?? '(undefined)',
    });
    apply({
      type: 'PATCH_DOC',
      patch: { on_screen_text_mode_default: 'overlay' },
    });
    for (const { rowIndex } of affected) {
      apply({ type: 'SET_ROW_IMAGE', shotIndex: rowIndex, url: null });
    }
    setFlipOstModalOpen(false);
    if (affected.length === 0) {
      toast.success('Doc default set to overlay. No rows needed regeneration.');
      return;
    }
    toast.success(
      `Doc flipped to overlay; ${affected.length} row${affected.length === 1 ? '' : 's'} queued for regen.`,
    );
    // Defer one tick so the cleared image_url writes propagate before
    // runFillBlanks reads stateRef. Without this, the runFillBlanks
    // `initialBlanks` computation may miss the rows we just cleared.
    setTimeout(() => {
      void runFillBlanks();
    }, 50);
  }, [apply, state.doc, state.rowImages, runFillBlanks]);

  // ── Per-shot regenerate state ─────────────────────────────────────────
  //
  // The inspector's Regenerate button used to keep its state local to
  // the ShotInspector component. Because the inspector is a single
  // instance that re-renders with a different `shotIndex` prop when
  // the user navigates, that state bled across shots — clicking Shot
  // 34 → Regenerate → Shot 35 would show Shot 34's "generating…" pill
  // on Shot 35, and clicking Regenerate on Shot 35 aborted Shot 34's
  // in-flight call. State is lifted here, keyed by shotIndex, so:
  //
  //   - multiple shots can regenerate in parallel;
  //   - navigating away mid-gen no longer cancels;
  //   - error messages stay pinned to the shot that produced them, so
  //     navigating back to a failed shot still shows what went wrong;
  //   - the result lands on the originating shotIndex regardless of
  //     where the user has navigated by the time the response arrives.
  type RegenState =
    | { kind: 'idle' }
    | { kind: 'generating' }
    | { kind: 'cancelled' }
    | { kind: 'error'; message: string };
  const [regenStates, setRegenStates] = useState<Record<number, RegenState>>({});
  // Map (not Record) because we mutate this from the async generation
  // path, and a Map's .set()/.get()/.delete() are simpler than spreading
  // a Record without re-creating the ref's identity every call.
  const regenAbortsRef = useRef<Map<number, AbortController>>(new Map());

  const setShotRegenState = useCallback(
    (shotIndex: number, next: RegenState) => {
      setRegenStates((prev) => {
        // Drop the entry entirely when going back to idle so the map
        // stays small and unmount-on-idle invariants hold.
        if (next.kind === 'idle') {
          if (!(shotIndex in prev)) return prev;
          const copy = { ...prev };
          delete copy[shotIndex];
          return copy;
        }
        return { ...prev, [shotIndex]: next };
      });
    },
    [],
  );

  // Kick off a single-shot regenerate. Always single-image — never a
  // collage, regardless of `doc.collage_mode` (collage only applies to
  // the batch fill-blanks path; per-shot regen needs to be predictable
  // because the user just clicked Regenerate on one specific shot).
  //
  // `opts.excludeRefIds` is forwarded into the v2 i2i dispatcher when
  // the previous attempt returned 409 REFERENCE_REJECTED. Lifted here
  // so the toast's Retry action keeps working after the state lift.
  const regenerateShot = useCallback(
    async (shotIndex: number, opts: { excludeRefIds?: readonly string[] } = {}) => {
      const liveState = stateRef.current;
      const row = liveState.doc.rows[shotIndex];
      if (!row) return;
      const prompt = row.ai_image_prompt?.trim() || row.visual_description?.trim();
      if (!prompt) {
        setShotRegenState(shotIndex, {
          kind: 'error',
          message: "No prompt to regenerate from. Edit the row's prompt first.",
        });
        return;
      }

      // Abort any prior in-flight gen FOR THIS SHOT only. Other shots'
      // generations are left running so the user can fan out across
      // shots without one click cancelling another shot's work.
      regenAbortsRef.current.get(shotIndex)?.abort();
      const controller = new AbortController();
      regenAbortsRef.current.set(shotIndex, controller);
      setShotRegenState(shotIndex, { kind: 'generating' });

      // Tier priority mirrors the inspector: row > doc > server default.
      const resolvedModel =
        row.image_model || liveState.doc.image_model_default || undefined;
      console.info('[editor regen start]', {
        shotIndex,
        model: resolvedModel ?? '(server default)',
        excludeRefIds: opts.excludeRefIds?.length ?? 0,
      });

      try {
        const res = await queueImageGen('generate', 'editor-regen', () =>
          // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response
          fetch('/api/generate/production-doc/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt,
              model: resolvedModel,
              onScreenText: row.on_screen_text ?? '',
              sectionTitle: row.section_title ?? '',
              styleId: liveState.doc.style_preset || undefined,
              excludeRefIds:
                opts.excludeRefIds && opts.excludeRefIds.length > 0
                  ? opts.excludeRefIds
                  : undefined,
            }),
            signal: controller.signal,
          }),
        );
        if (res.status === 429) reportUpstream429('generate', 'editor-regen');
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          imageUrl?: string;
          rejectedRefIds?: string[];
          saliency?: ImageSaliencyMap;
        };

        // v2 reference-rejected: surface a toast with a Retry action
        // that re-fires this function with the rejected ids excluded.
        // Cap retries so a misbehaving server can't loop a paid call.
        if (res.status === 409 && data?.code === 'REFERENCE_REJECTED') {
          const rejectedIds = data.rejectedRefIds ?? [];
          const accumulated = [...(opts.excludeRefIds ?? []), ...rejectedIds];
          const allRefsRejected = accumulated.length >= 8;
          const maxAttemptsHit = (opts.excludeRefIds?.length ?? 0) >= 8;
          const n = rejectedIds.length;
          const offerRegenerate =
            !allRefsRejected && !maxAttemptsHit && rejectedIds.length > 0;
          const message = allRefsRejected
            ? 'All reference images rejected — edit the style and clear rejections before retrying.'
            : maxAttemptsHit
              ? 'Too many retries. Edit the style before trying again.'
              : `${n || 'One or more'} reference image${n === 1 ? '' : 's'} rejected by the provider — click Regenerate to retry without them.`;
          regenAbortsRef.current.delete(shotIndex);
          setShotRegenState(shotIndex, { kind: 'error', message });
          toast.error(
            allRefsRejected
              ? `Shot ${shotIndex + 1}: all reference images rejected.`
              : maxAttemptsHit
                ? `Shot ${shotIndex + 1}: stopped retrying after multiple rejections.`
                : `Shot ${shotIndex + 1}: ${n || 'one or more'} reference image${n === 1 ? ' was' : 's were'} rejected.`,
            {
              duration: 10_000,
              action: offerRegenerate
                ? {
                    label: 'Regenerate',
                    onClick: () => {
                      void regenerateShot(shotIndex, { excludeRefIds: accumulated });
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

        commitRowImage(shotIndex, data.imageUrl);
        if (data.saliency) {
          updateRow(shotIndex, { image_saliency: data.saliency });
        }
        regenAbortsRef.current.delete(shotIndex);
        setShotRegenState(shotIndex, { kind: 'idle' });
        console.info('[editor regen ok]', { shotIndex });
      } catch (err) {
        regenAbortsRef.current.delete(shotIndex);
        if (err instanceof DOMException && err.name === 'AbortError') {
          setShotRegenState(shotIndex, { kind: 'cancelled' });
          console.info('[editor regen cancelled]', { shotIndex });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setShotRegenState(shotIndex, { kind: 'error', message });
        // Also surface as a toast so a user who's navigated away from
        // this shot sees the failure immediately instead of having to
        // come back to find a red banner. Includes the shot number so
        // they know which one.
        toast.error(`Shot ${shotIndex + 1} regen failed: ${message}`, {
          duration: 8000,
        });
        console.warn('[editor regen failed]', { shotIndex, error: message });
      }
    },
    // `commitRowImage` + `updateRow` are stable useCallbacks declared
    // later in this file (used-before-declaration if listed in deps).
    // setShotRegenState is stable. So nothing actually changes for the
    // closure here across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setShotRegenState],
  );

  const stopRegenerateShot = useCallback((shotIndex: number) => {
    regenAbortsRef.current.get(shotIndex)?.abort();
    console.info('[editor regen stop]', { shotIndex });
  }, []);

  // ── Force-sync all images to the server ───────────────────────────────
  //
  // Escape-hatch for the "I'm afraid to refresh because the toast says
  // some images weren't saved" situation. Iterates every shot with a
  // current imageUrl in browser state, posts each to the row-asset
  // endpoint (which has its own 3-retry loop), and reports ONE summary
  // toast at the end. Per-shot toasts are suppressed so the user
  // doesn't get bombarded with 100 noise events.
  //
  // Sequential, not parallel — keeps the load on the row-asset
  // endpoint predictable + makes the "Saving X/Y" progress label
  // monotonically increasing. ~50-200ms per shot in the happy path,
  // so 100 shots ≈ 5-20s.
  type SyncState =
    | { kind: 'idle' }
    | { kind: 'running'; done: number; total: number; failed: number };
  const [syncState, setSyncState] = useState<SyncState>({ kind: 'idle' });
  const syncAbortRef = useRef<{ cancelled: boolean } | null>(null);
  const runForceSyncImages = useCallback(async () => {
    if (syncState.kind === 'running') return;
    const liveState = stateRef.current;
    const items: Array<{ shotIndex: number; url: string }> = [];
    for (const [k, v] of Object.entries(liveState.rowImages)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0) continue;
      if (typeof v === 'string' && /^https?:/.test(v)) {
        items.push({ shotIndex: idx, url: v });
      }
    }
    if (items.length === 0) {
      toast.info('No images to sync — every shot is blank.');
      return;
    }
    console.info('[editor force-sync] start', { total: items.length });
    const flag = { cancelled: false };
    syncAbortRef.current = flag;
    setSyncState({ kind: 'running', done: 0, total: items.length, failed: 0 });
    let ok = 0;
    let failed = 0;
    const failures: Array<{ shotIndex: number; reason: string }> = [];
    for (let i = 0; i < items.length; i++) {
      if (flag.cancelled) {
        console.info('[editor force-sync] cancelled', { done: ok + failed, total: items.length });
        break;
      }
      const { shotIndex, url } = items[i];
      const result = await writeRowAsset(shotIndex, 'image', url, { suppressToast: true });
      if (result.ok) {
        ok += 1;
      } else {
        failed += 1;
        failures.push({
          shotIndex,
          reason: result.message ?? result.failureClass ?? `HTTP ${result.status ?? '?'}`,
        });
      }
      setSyncState({ kind: 'running', done: ok + failed, total: items.length, failed });
    }
    syncAbortRef.current = null;
    setSyncState({ kind: 'idle' });
    console.info('[editor force-sync] done', { ok, failed, total: items.length, failures });
    if (failed === 0) {
      toast.success(`Synced ${ok} image${ok === 1 ? '' : 's'} to the server — safe to refresh.`);
    } else {
      toast.error(
        `Synced ${ok}/${items.length} — ${failed} shot${failed === 1 ? '' : 's'} still unsaved. See console for the list.`,
        { duration: 12_000 },
      );
    }
  }, [syncState.kind, writeRowAsset]);
  const stopForceSync = useCallback(() => {
    if (syncAbortRef.current) syncAbortRef.current.cancelled = true;
  }, []);

  // User-initiated seek. Must update BOTH the local playhead state AND
  // the Remotion Player's internal frame. Before this helper, the three
  // user-seek call sites (TransportBar onSeek, Audio tab onSeek,
  // TimelineV2 onSeek) only dispatched SET_PLAYHEAD — the React state
  // moved, but the Player kept its old frame, so pressing Play started
  // from the previous position instead of where the user dragged to.
  // playerRef is declared further down the file; we capture it via the
  // outer closure since it's a ref (stable identity, no dep churn).
  const playerRef = useRef<PlayerRef>(null);
  const seekFromUser = useCallback(
    (ms: number) => {
      apply({ type: 'SET_PLAYHEAD', ms });
      const player = playerRef.current;
      if (!player || !videoConfigRef.current) return;
      const fps = videoConfigRef.current.fps;
      player.seekTo(Math.round((ms / 1000) * fps));
    },
    [apply],
  );
  // Hold the latest videoConfig in a ref so seekFromUser doesn't have to
  // depend on it and re-create on every config recompute. The config's
  // `fps` is the only field we read here and it's stable across edits.
  const videoConfigRef = useRef<{ fps: number } | null>(null);
  // Hoisted above the empty-doc early-return at line ~1804 so this hook
  // runs unconditionally. Previously this lived next to the preview-
  // slot JSX (which only renders when the doc has rows) — that crossed
  // the early return and tripped React's rules-of-hooks check the
  // moment a doc transitioned from empty to populated. Mount lives at
  // the preview's outer container; see `previewSlot` below.
  const previewContainerRef = useRef<HTMLDivElement | null>(null);

  // Phase 2 of `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
  // Holds the cumulative shot start times in a ref so the click-to-jump
  // helper can read them without taking shotStartTimesMs as a dependency
  // and re-creating on every doc edit. shotStartTimesMs is computed
  // further down via useMemo, but the ref is updated synchronously by
  // the effect right after it so the lookup never goes stale.
  const shotStartTimesMsRef = useRef<number[]>([]);
  // Holds the renderer's per-shot startMs (post-alignment, post-trim,
  // post-tail-buffer). Source of truth for "where does shot N actually
  // start in the Player." Diverges from shotStartTimesMs when the doc
  // has voiceover alignment OR per-row trims, in which case the timeline
  // thumbnails and the playhead use different timebases — clicking a
  // shot card seeks to the WRONG time. We keep both refs synced so the
  // click-to-jump helper can read the renderer's value.
  const shotRenderStartTimesMsRef = useRef<number[]>([]);
  // Picks a shot AND (when enabled) moves the playhead to its start.
  // Used by every shot-click surface: timeline cards, ShotsTab items,
  // and the overlay-position-open flow. Centralized so the
  // `editor.playback.clickShotToSeek` escape hatch is honored uniformly
  // and so the seek + select land as a single user-intent transaction.
  const selectShotFromUser = useCallback(
    (shotIndex: number, source: string) => {
      setLaneFocus(null);
      apply({ type: 'SET_SELECTION', shotIndex });
      if (!getClickShotToSeek()) return;
      // Prefer the renderer's startMs (matches the Player's timebase
      // and the timeline thumbnail X positions). Fall back to the
      // editor-store start for shots the renderer hasn't seen yet
      // (e.g. just-inserted row before videoConfig recomputes).
      const startMs =
        shotRenderStartTimesMsRef.current[shotIndex] ??
        shotStartTimesMsRef.current[shotIndex];
      if (typeof startMs !== 'number') return;
      console.info('[editor select-shot] seek', { source, shotIndex, startMs });
      // Defer the seek to the next microtask so the SET_SELECTION
      // commit and the SET_PLAYHEAD commit don't fight the player
      // ref's frame state inside the same render. Without this the
      // Player occasionally jumps to the new frame before the
      // selection state propagates, which makes the inspector tab
      // flicker briefly between 'shot' and the previous tab.
      Promise.resolve().then(() => seekFromUser(startMs));
    },
    [apply, seekFromUser],
  );

  // v2 (2026-05-22) — resolve the active style's `preferred_cloud_model`
  // so the ShotInspector regenerate button can show its per-image
  // cost (rule 8). One small fetch on mount + whenever the doc's
  // style_preset changes; results cached in state so the inspector
  // gets the value as a plain prop without doing its own async work.
  //
  // Falls through (stays null) when:
  //   - the doc has no style_preset (legacy docs)
  //   - the style is a built-in (origin='built-in' has no preferred
  //     cloud model — legacy T2I pricing varies by model)
  //   - the styles fetch fails (best-effort; cost just doesn't surface)
  const [activeStyleI2IModel, setActiveStyleI2IModel] = useState<string | null>(null);
  // PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md` —
  // when the doc's style_preset is a saved-style UUID, capture the
  // built-in slug it derives from so downstream callers (SceneRouter's
  // yellow-LowerThird variant check, future bake→overlay auto-flip)
  // can resolve UUID-style ids to their built-in parent without a
  // second styles fetch. Built-ins resolve to themselves; legacy /
  // missing styles stay null. Reads from the SAME `/api/production-doc/styles`
  // fetch as activeStyleI2IModel so we don't duplicate the network call.
  const [effectiveStyleSlug, setEffectiveStyleSlug] = useState<string | null>(null);
  useEffect(() => {
    const stylePresetId = state.doc.style_preset;
    if (!stylePresetId) {
      setActiveStyleI2IModel(null);
      setEffectiveStyleSlug(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads styles list
        const res = await fetch('/api/production-doc/styles');
        if (!res.ok || cancelled) return;
        const data = await res.json() as {
          styles?: Array<{
            id: string;
            origin?: 'built-in' | 'saved';
            preferred_cloud_model?: string;
            based_on_built_in?: string;
          }>;
        };
        const match = (data.styles ?? []).find(s => s.id === stylePresetId);
        if (cancelled) return;
        if (match && match.origin === 'saved' && match.preferred_cloud_model) {
          setActiveStyleI2IModel(match.preferred_cloud_model);
        } else {
          setActiveStyleI2IModel(null);
        }
        // Resolve effective slug: built-ins are their own slug; saved
        // styles resolve to `based_on_built_in` when set, otherwise null
        // (an unknown saved style with no parent has no built-in
        // semantics to inherit).
        let resolvedSlug: string | null = null;
        if (match) {
          if (match.origin === 'built-in') {
            resolvedSlug = match.id;
          } else if (match.origin === 'saved' && typeof match.based_on_built_in === 'string') {
            resolvedSlug = match.based_on_built_in;
          }
        }
        setEffectiveStyleSlug(resolvedSlug);
        console.info('[editor styleId resolved]', {
          stylePresetId,
          origin: match?.origin ?? '(unknown)',
          based_on_built_in: match?.based_on_built_in ?? '(unset)',
          effectiveStyleSlug: resolvedSlug ?? '(null)',
        });
      } catch {
        // Network/parse failures aren't fatal — cost hint just doesn't show.
        if (!cancelled) {
          setActiveStyleI2IModel(null);
          setEffectiveStyleSlug(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [state.doc.style_preset]);

  // Auto-fetch voiceover alignment when the editor loads with a
  // voiceover URL but no alignment data. Without this, the editor's
  // preview falls back to estimated row timing while the render route
  // fetches fresh alignment server-side — preview and render diverge,
  // and the user reports "voiceover doesn't match scenes in the
  // editor". The fetch posts to the same endpoint prod-doc uses
  // (/api/voiceovers/align). Result is dispatched via
  // SET_VOICEOVER_ALIGNMENT so it persists through the next debounced
  // PATCH and survives a refresh.
  //
  // Guards:
  //   - URL must be a proxy path (the align endpoint rejects raw
  //     ElevenLabs blob URLs).
  //   - Doc must have rows + script_text (the alignment is computed
  //     against the row scripts).
  //   - Skip when alignment is already in state.
  //   - One in-flight request per project — a ref tracks the URL the
  //     last fetch ran against so a URL flip during a slow request
  //     doesn't fire a duplicate.
  const VOICEOVER_PROXY_RE_ALIGN = /^\/api\/voiceovers\/[0-9a-f-]{36}\/audio$/i;
  const alignmentFetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    const url = state.voiceoverUrl;
    if (!url) return;
    if (state.voiceoverAlignment) return;
    if (!VOICEOVER_PROXY_RE_ALIGN.test(url)) return;
    if (!state.doc.rows.length) return;
    if (alignmentFetchedForRef.current === url) return;
    alignmentFetchedForRef.current = url;

    const rowScripts = state.doc.rows.map((r) => r.script_text);
    console.info('[editor alignment auto-fetch] start', {
      url,
      rowCount: rowScripts.length,
    });

    let cancelled = false;
    void (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- voiceover-align RPC: awaits and uses response (alignment data)
        const res = await fetch('/api/voiceovers/align', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioPath: url,
            rowScripts,
            forceRefresh: false,
          }),
        });
        if (cancelled) return;
        if (!res.ok) {
          console.warn('[editor alignment auto-fetch] failed', {
            status: res.status,
          });
          // Reset the ref so a later URL change can retry. We don't
          // reset for the SAME URL — that would loop on a known-bad
          // response.
          return;
        }
        const data = (await res.json().catch(() => ({}))) as {
          status?: string;
          alignment?: import('@/lib/elevenlabs').ForcedAlignmentResponse;
        };
        if (cancelled) return;
        if (data.status === 'ready' && data.alignment) {
          console.info('[editor alignment auto-fetch] ready', {
            wordCount: data.alignment.words?.length ?? 0,
          });
          apply({ type: 'SET_VOICEOVER_ALIGNMENT', alignment: data.alignment });
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[editor alignment auto-fetch] threw', {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    state.voiceoverUrl,
    state.voiceoverAlignment,
    state.doc.rows,
    apply,
  ]);

  // Resolve the brand the renderer should use. Three layers, later
  // overrides earlier:
  //   DEFAULT_BRAND_KIT ◀ channelVisualKit ◀ visualKitOverride
  // When visualKitOverride is unset, fall back to the legacy
  // brandKitOverride field (Partial<BrandKit>) for old payloads.
  // Memoized so the videoConfig + executeRender both read a stable
  // reference and rebuild only when an input layer changes.
  const resolvedRenderBrand = useMemo(() => {
    if (state.visualKitOverride) {
      return resolveBrandKitForRender(channelVisualKit, state.visualKitOverride);
    }
    return state.brandKitOverride;
  }, [state.visualKitOverride, state.brandKitOverride, channelVisualKit]);

  // Channel-kit fetch effect. Active channel id comes from the
  // canonical payload (production-doc mirrors it via the autosave);
  // falls back to /api/user/settings/active-channel when not on the
  // payload (older projects).
  useEffect(() => {
    let cancelled = false;
    async function loadChannelKit() {
      try {
        let channelId = state.channelId;
        if (!channelId) {
          // eslint-disable-next-line no-restricted-syntax -- GET, loads active-channel
          const acRes = await fetch('/api/user/settings/active-channel');
          if (!acRes.ok) return;
          const ac = (await acRes.json()) as { active_channel_id: string | null };
          if (cancelled || !ac.active_channel_id) return;
          channelId = ac.active_channel_id;
        }
        // eslint-disable-next-line no-restricted-syntax -- GET, loads brand kit
        const kitRes = await fetch(`/api/channels/${channelId}/visual-brand-kit`);
        if (!kitRes.ok) return;
        const data = (await kitRes.json()) as { visualBrandKit: ChannelVisualBrandKit | null };
        if (cancelled) return;
        setChannelVisualKit(data.visualBrandKit ?? null);
      } catch {
        /* network failure — kit stays null, override-only path applies */
      }
    }
    void loadChannelKit();
    return () => {
      cancelled = true;
    };
  }, [state.channelId]);

  // ─── Caption regeneration ─────────────────────────────────────
  // Server-side updates payload.captions + bumps version; we
  // reload-from-server to merge the result into editor state.
  const [captionsRegenState, setCaptionsRegenState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const handleRegenerateCaptions = useCallback(async () => {
    if (!state.voiceoverUrl) {
      setCaptionsRegenState({
        kind: 'error',
        message: 'No voiceover URL — assign or generate one first.',
      });
      return;
    }
    setCaptionsRegenState({ kind: 'running' });
    try {
      // Flush any pending edits before the server's JSONB merge to
      // avoid racing against the version-bump.
      await flushSave();
      // eslint-disable-next-line no-restricted-syntax -- captions-regenerate RPC: awaits and uses response
      const res = await fetch(`/api/edit/${encodeURIComponent(projectId)}/captions/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Caption regen failed: HTTP ${res.status}`);
      }
      // Server bumped version. Reload to merge new captions + version.
      closeAllOverlayModals();
      await reloadFromServer();
      setCaptionsRegenState({ kind: 'idle' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[editor captions] regen failed', { detail: message });
      setCaptionsRegenState({ kind: 'error', message });
    }
  }, [flushSave, projectId, reloadFromServer, state.voiceoverUrl]);

  // Auto-regen captions on voiceover-URL change.
  //
  // Gated by the `editor.autoRegenCaptions.onVoiceoverChange` setting
  // (Phase 4b key, default off). The user enabling the setting expects:
  // change VO → auto-regen, NOT "merely opening the editor → auto-regen".
  // To honor that intent we track the previous URL in a ref and:
  //   • Seed the ref on first run without firing — the initial load
  //     payload's voiceoverUrl is "what was already there".
  //   • Fire only on TRANSITIONS (prev → new) where both differ AND
  //     the setting is on AND a regen isn't already in flight.
  //   • Skip the transition `undefined → URL` when there's no caption
  //     bundle yet (initial assignment shouldn't trigger when there's
  //     nothing to regen).
  const lastSeenVoiceoverUrlRef = useRef<string | undefined>(undefined);
  const autoRegenSeededRef = useRef(false);
  useEffect(() => {
    const prev = lastSeenVoiceoverUrlRef.current;
    const curr = state.voiceoverUrl;
    if (!autoRegenSeededRef.current) {
      // First run — seed the ref to the current value so the next
      // ACTUAL change is the one we react to.
      autoRegenSeededRef.current = true;
      lastSeenVoiceoverUrlRef.current = curr;
      return;
    }
    if (prev === curr) return;
    lastSeenVoiceoverUrlRef.current = curr;

    if (!curr) return; // VO was cleared — nothing to regen against
    if (!getAutoRegenCaptions()) return; // setting off
    if (captionsRegenState.kind === 'running') return; // already in flight
    // The first time a project gets a voiceover, there's also no
    // existing caption bundle. Auto-regen makes sense in that case
    // — the user *just* changed the VO; transcribing it is the
    // natural next step. We don't gate on `state.captions` here.

    console.info('[editor captions] auto-regen triggered', {
      prevUrl: prev || '(none)',
      newUrl: curr,
    });
    void handleRegenerateCaptions();
  }, [state.voiceoverUrl, captionsRegenState.kind, handleRegenerateCaptions]);


  // ─── Phase 5.2 overlay-port (commit B) ───────────────────────────
  //
  // Overlay state + handlers mirror production-doc/page.tsx but route
  // mutations through the editor store's `PATCH_ROW` and
  // `SET_ROW_OVERLAY` commands. The auto-save + undo stack pick up
  // every overlay change for free.

  /** Fire-and-forget telemetry probe — mirrors production-doc's
   *  recordEditorTelemetry so the per-model drag-rate dashboard sees
   *  the same events whether the user is on /production-doc or
   *  /edit/[projectId]. Never blocks; never throws into the UI. */
  async function recordOverlayTelemetry(
    event:
      | 'overlay_drag'
      | 'overlay_resize'
      | 'overlay_accept'
      | 'overlay_reset'
      | 'overlay_rethink',
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      console.info('[editor telemetry] post', { event, projectId });
      // Phase 3.2: route through the durable outbox so a tab close
      // mid-flight doesn't lose the metric. Fire-and-forget is the
      // exact case mutate() was designed for.
      mutate('editor.telemetry', {
        url: '/api/editor-telemetry',
        method: 'POST',
        body: { event, project_id: projectId, payload },
      });
    } catch (err) {
      console.warn('[editor telemetry] post failed', {
        event,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const [overlayPositionRow, setOverlayPositionRow] = useState<number | null>(null);
  const [overlayEditRow, setOverlayEditRow] = useState<number | null>(null);
  const [overlayContextMenu, setOverlayContextMenu] = useState<{
    rowIndex: number;
    x: number;
    y: number;
  } | null>(null);

  /** Phase 3 of `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
   *  Centralized state for every right-click context menu in the
   *  editor. One menu mounted in the JSX, items derived from `kind`.
   *  Closing clears the state entirely. `kind: 'overlay'` is
   *  intentionally NOT modeled here — the legacy `overlayContextMenu`
   *  state above continues to drive that surface so the existing
   *  history / Rethink / Edit dialog flow doesn't have to be refactored. */
  const [editorContextMenu, setEditorContextMenu] = useState<
    | { kind: 'shot'; shotIndex: number; x: number; y: number }
    | { kind: 'shots-tab-item'; shotIndex: number; x: number; y: number }
    | { kind: 'audio'; x: number; y: number }
    | { kind: 'caption'; segmentIndex: number; x: number; y: number }
    | null
  >(null);

  // SHOTS-rail filter state. Empty filter on mount; we read
  // localStorage in an effect so the SSR snapshot stays stable (the
  // server can't read localStorage, and reading it during render
  // would hydrate-mismatch). Per-project keying lets each video keep
  // its own filter independently.
  // See `_plans/2026-06-02-editor-shot-type-filter.md`.
  const [shotFilter, setShotFilter] = useState<ShotFilter>(EMPTY_SHOT_FILTER);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(shotFilterStorageKey(projectId));
      const restored = parseShotFilter(raw);
      if (!isEmptyShotFilter(restored)) {
        setShotFilter(restored);
        console.info('[editor shot-filter] restored', {
          project_id: projectId,
          kinds: restored.kinds,
          grouping: restored.grouping,
        });
      }
    } catch (err) {
      // Defensive — parse never throws but localStorage access can
      // (Safari private mode, quota errors). Swallow and move on.
      console.warn('[editor shot-filter] restore-failed', {
        project_id: projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [projectId]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Debounce writes so chip-mashing doesn't pound localStorage.
    const handle = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          shotFilterStorageKey(projectId),
          serializeShotFilter(shotFilter),
        );
      } catch {
        // Quota / private-mode — ignore. Filter still works for the
        // current session, just won't persist.
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [projectId, shotFilter]);
  const handleShotFilterChange = useCallback(
    (next: ShotFilter) => {
      setShotFilter(next);
      console.info('[editor shot-filter] applied', {
        kinds: next.kinds,
        grouping: next.grouping,
      });
    },
    [],
  );

  /** Floating "Set timing…" popover anchored at the cursor. Used by
   *  shot context menus (timeline + ShotsTab) to set both edges of
   *  a shot via Start / End / Duration inputs. Apply dispatches
   *  SET_SHOT_TIMING; the reducer carves from / gives back to both
   *  neighbors in a single atomic step. Replaces the older
   *  "Set duration…" popover (which was duration-only and dispatched
   *  RESIZE_SHOT — semantically a subset of what the timing popover
   *  can do). See
   *  `_plans/2026-05-23-editor-set-shot-timing-and-left-edge-drag.md`. */
  const [timingPopover, setTimingPopover] = useState<
    | {
        shotIndex: number;
        x: number;
        y: number;
        /** Aligned-space start (what the user sees on the ruler). The
         *  Apply handler computes the cascade-space dispatch fresh
         *  from state at apply time using `rowEffectiveDurationMs` —
         *  we DON'T snapshot cascade here because the snapshot can
         *  drift from the reducer's view when the row has no override
         *  (the reducer uses naturalRowDurationMs, the snapshot would
         *  need to too). Keeping only aligned values eliminates the
         *  divergence class entirely. */
        initialStartMs: number;
        /** Aligned-space end. */
        initialEndMs: number;
        isFirstShot: boolean;
      }
    | null
  >(null);

  /** Close every overlay modal (position editor, edit dialog, context
   *  menu) and clear the rethink in-flight set. Called before any
   *  RESET_FROM_SERVER dispatch because those modals hold a rowIndex
   *  that may not point at the same row after the reload — keeping
   *  them mounted causes stale-state flicker or out-of-bounds reads. */
  const closeAllOverlayModals = useCallback(() => {
    setOverlayPositionRow(null);
    setOverlayEditRow(null);
    setOverlayContextMenu(null);
  }, []);
  const RETHINK_MAX_ATTEMPTS = 5;
  const OVERLAY_EDIT_HISTORY_CAP = 3;
  const [rethinkAttempts, setRethinkAttempts] = useState<Record<number, number>>({});
  const [rethinkingRows, setRethinkingRows] = useState<Set<number>>(() => new Set());
  // Synchronous in-flight guard — matches production-doc's pattern.
  // Prevents two rapid clicks (both passing the React-state check
  // before either setRethinkingRows lands) from firing duplicate
  // rethink requests.
  const rethinkInFlightRef = useRef<Set<number>>(new Set());

  // ─── B-roll generator port (Phase 4c) ──────────────────────────
  //
  // The editor inspector can now kick off a B-roll clip generation
  // directly, instead of forcing the user to bounce back to
  // /production-doc. We:
  //   • fetch the workspace's default broll model on mount;
  //   • on click, dispatch SET_ROW_VIDEO_CLIP({status:'generating'}, transient)
  //     and call kickoffBrollGeneration with the row's prompts;
  //   • a poll effect watches every row in 'generating' state and
  //     polls /api/broll/{id} every 5s until ready / failed.
  //
  // The clip-id-per-row mapping is stored in BrollCell's existing
  // localStorage map (`readBrollLsMap` / `writeBrollLsMap`) so the
  // poll knows which id to query. Same key space as production-doc,
  // so a clip kicked off in either surface can be polled from the
  // other.
  const [userBrollModelId, setUserBrollModelId] = useState<string>(DEFAULT_BROLL_MODEL_ID);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads broll-default
        const res = await fetch('/api/user/settings/broll-default', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { modelId?: string };
        if (cancelled || !data.modelId) return;
        if (findBrollModel(data.modelId)) setUserBrollModelId(data.modelId);
      } catch {
        /* fall back to library default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Synchronous in-flight set so two rapid clicks don't double-kick
  // a generation. Mirrors the rethink pattern above.
  const broolKickoffInFlightRef = useRef<Set<number>>(new Set());

  // ─── Generation history (Inspector → History tab) ───────────────
  //
  // The History tab reads `/api/edit/[projectId]/generation-events`
  // for an append-only log of every animation kickoff. To wire the
  // log into the existing kickoff → poll flow without changing its
  // shape we keep three pieces of local state:
  //
  //   - `clipIdToEventIdRef`: map from `broll_clips.id` → the event
  //     row we inserted at kickoff. The poll loop's terminal branch
  //     looks up the eventId by clipId to PATCH the right row.
  //     Cleaned on terminal so the map doesn't grow unbounded across
  //     a long session.
  //
  //   - `historyRefreshTick`: bumped on every kickoff / terminal so
  //     the panel refetches immediately instead of waiting for its
  //     5s tick. The panel uses this as a useEffect dep.
  //
  //   - `historySwitchIntent` + `historyAutoSwitchedRef`: the
  //     one-time "auto-switch to History on the first generation of
  //     the session" UX. We fire the switch intent exactly once per
  //     mount (ref-guarded) and the EditorInspector ignores
  //     unchanged nonces so it doesn't re-fire on every re-render.
  //
  // Source of truth for the user-visible clip remains
  // `state.rowVideoClips` — the history log is a parallel audit
  // surface. If any log write fails, the clip itself still renders.
  // See `_plans/2026-05-23-editor-generation-history-log.md` and
  // the helper in `src/lib/editor/generation-events.ts`.
  const clipIdToEventIdRef = useRef<Map<string, string>>(new Map());
  const [historyRefreshTick, setHistoryRefreshTick] = useState(0);
  const [historySwitchIntent, setHistorySwitchIntent] = useState<{
    tab: InspectorTabId;
    nonce: number;
  } | null>(null);
  const historyAutoSwitchedRef = useRef(false);

  const setRowVideoClip = useCallback(
    (
      rowIndex: number,
      clip: {
        status: string;
        videoUrl?: string;
        durationSeconds?: number;
        errorMessage?: string;
        brollClipId?: string;
      } | null,
      transient = false,
    ) => {
      apply({ type: 'SET_ROW_VIDEO_CLIP', rowIndex, clip, transient });
      // Server-side PATCH is asset-blind for rowVideoClips, so committed
      // states must reach the row-asset endpoint. Transient states (e.g.
      // `loading`, `generating` placeholders) are skipped — they're
      // ephemeral UI only, and writing them would just generate noise
      // version churn the client doesn't care about.
      if (!transient) {
        writeRowAsset(rowIndex, 'clip', clip);
      }
    },
    [apply, writeRowAsset],
  );

  // Track elapsed time per active generation. The Animate panel reads
  // this so the user sees a counter ticking instead of an opaque
  // spinner. Reset when the clip is no longer 'generating'.
  const [clipGenStartMs, setClipGenStartMs] = useState<Record<number, number>>({});
  // Phase per row: 'kickoff' = waiting for /api/broll to return a
  // clipId; 'polling' = clipId in localStorage, /api/broll/[id] poll
  // is running. Drives the inspector label so a slow kickoff is
  // distinguishable from a slow generation.
  const [clipGenPhase, setClipGenPhase] = useState<Record<number, 'kickoff' | 'polling'>>({});

  const handleGenerateClip = useCallback(
    async (rowIndex: number) => {
      if (broolKickoffInFlightRef.current.has(rowIndex)) return;
      const row = state.doc.rows[rowIndex];
      if (!row) return;

      const visualDescription = (row.visual_description ?? '').trim();
      if (!visualDescription) {
        alert(
          'No visual description for this row yet — fill in the inspector field above first so the model knows what to generate.',
        );
        return;
      }

      const sceneSeconds = (state.doc.rows[rowIndex] ? 5 : 5); // editor doesn't track per-shot scene seconds yet; pickModelForScene reads the workspace default to pick the tier
      // Tier priority: row.broll_model_id > doc.broll_model_id > workspace
      // default. Mirrors the renderer's resolution so the user's per-row
      // pick in the inspector dropdown actually drives generation.
      const explicitModelId =
        row.broll_model_id ?? state.doc.broll_model_id ?? undefined;
      const tier = explicitModelId
        ? { modelId: explicitModelId }
        : pickModelForScene(userBrollModelId, sceneSeconds);
      console.info('[editor broll] kickoff', {
        rowIndex,
        rowModelId: row.broll_model_id,
        docModelId: state.doc.broll_model_id,
        userModelId: userBrollModelId,
        pickedModelId: tier.modelId,
        explicit: Boolean(explicitModelId),
      });

      // Capture the prior clip-id BEFORE the first SET_ROW_VIDEO_CLIP
      // dispatch wipes it (the reducer overwrites; it does NOT merge).
      // If a clip-id was already present, this kickoff is a re-generate
      // (the user is replacing an existing clip on this row). The
      // History log distinguishes these so the panel can flag them
      // with a 'Regen' badge.
      const priorBrollClipId = state.rowVideoClips[rowIndex]?.brollClipId ?? null;
      const eventType = priorBrollClipId ? 'regenerate' : 'generate';

      broolKickoffInFlightRef.current.add(rowIndex);
      setRowVideoClip(rowIndex, { status: 'generating' }, true);
      const startMs = Date.now();
      setClipGenStartMs((prev) => ({ ...prev, [rowIndex]: startMs }));
      setClipGenPhase((prev) => ({ ...prev, [rowIndex]: 'kickoff' }));

      try {
        const stub = await kickoffBrollGeneration({
          projectId: null,
          scriptId: null,
          productionDocId: projectId,
          rowIndex,
          rowSignature: brollRowSignatureInput({
            timecode: row.timecode,
            visual_description: row.visual_description,
          }),
          visualDescription,
          aiImagePrompt: row.ai_image_prompt || undefined,
          stillImageUrl: state.rowImages[rowIndex] || undefined,
          modelId: tier.modelId,
        });
        // CRITICAL: store the clipId DIRECTLY on the row's clip state
        // — not just in localStorage. The poll loop reads it from
        // here, which works even when localStorage write fails
        // (private browsing, storage quota, browser race). The
        // previous flow only wrote to localStorage and the poll
        // could never find the clipId, leaving the spinner running
        // forever. Mirrors what prod-doc's BrollCell does internally.
        setRowVideoClip(
          rowIndex,
          { status: 'generating', brollClipId: stub.id },
          true,
        );
        // Also write to the localStorage map BrollCell + the prod-doc
        // page use, so a clip kicked off in the editor is poll-
        // discoverable from prod-doc too. Belt-and-braces — the
        // state path above is now the source of truth.
        const map = readBrollLsMap();
        map[brollRowSignatureInput({
          timecode: row.timecode,
          visual_description: row.visual_description,
        })] = stub.id;
        writeBrollLsMap(map);
        console.info('[editor broll] kickoff committed', { rowIndex, clipId: stub.id });
        setClipGenPhase((prev) => ({ ...prev, [rowIndex]: 'polling' }));

        // History log — best-effort audit insert. Failure does NOT
        // block the generation (the helper swallows errors and
        // returns null). Surfaces in the Inspector's History tab.
        // The promptExcerpt gives the user something to recognize
        // each entry by when scrolling a long log on the same scene.
        const promptExcerpt =
          (row.visual_description || row.ai_image_prompt || row.script_text || '').trim() || undefined;
        const eventId = await recordGenerationKickoff({
          projectId,
          rowIndex,
          brollClipId: stub.id,
          modelId: tier.modelId,
          eventType,
          promptExcerpt,
        });
        if (eventId) {
          clipIdToEventIdRef.current.set(stub.id, eventId);
        }
        // Refresh the panel even when eventId is null — the reconciliation
        // path on GET will still pick up the entry from broll_clips if the
        // POST raced past the user's reload.
        setHistoryRefreshTick((n) => n + 1);
        // One-time auto-switch: on the first kickoff of the session,
        // open the History tab so the user sees the new entry land.
        // Ref-guarded so subsequent kickoffs don't yank the user out
        // of whatever tab they've manually settled on.
        if (!historyAutoSwitchedRef.current) {
          historyAutoSwitchedRef.current = true;
          setHistorySwitchIntent({ tab: 'history', nonce: Date.now() });
          console.info('[history panel] auto-switched on first kickoff', {
            rowIndex,
            eventId,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[editor broll] kickoff failed', { rowIndex, detail: msg });
        alert(`Couldn't kick off animation: ${msg}`);
        setRowVideoClip(rowIndex, null, true);
        setClipGenStartMs((prev) => {
          const next = { ...prev };
          delete next[rowIndex];
          return next;
        });
        setClipGenPhase((prev) => {
          const next = { ...prev };
          delete next[rowIndex];
          return next;
        });
      } finally {
        broolKickoffInFlightRef.current.delete(rowIndex);
      }
    },
    [
      state.doc.rows,
      state.rowImages,
      state.rowVideoClips,
      userBrollModelId,
      projectId,
      setRowVideoClip,
    ],
  );

  // Tick once a second to drive the elapsed-time counter in the
  // Animate panel. Cheap when no rows are generating — the interval
  // sets state that's identical to the previous render, so React's
  // bailout skips the re-render. Stops entirely when nothing is
  // active.
  const [clipElapsedTick, setClipElapsedTick] = useState(0);
  useEffect(() => {
    if (Object.keys(clipGenStartMs).length === 0) return;
    const id = setInterval(() => setClipElapsedTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [clipGenStartMs]);
  // Clean up start-time entries when the row's clip leaves
  // 'generating' (success, failure, or user-cancelled). Run as an
  // effect so the cleanup happens on the same render the new status
  // lands; doing it inside the poll handler would race against the
  // dispatch.
  useEffect(() => {
    const toRemove = Object.keys(clipGenStartMs).filter((k) => {
      const idx = Number(k);
      const status = state.rowVideoClips[idx]?.status;
      return status !== 'generating';
    });
    if (toRemove.length === 0) return;
    setClipGenStartMs((prev) => {
      const next = { ...prev };
      for (const k of toRemove) delete next[Number(k)];
      return next;
    });
    setClipGenPhase((prev) => {
      const next = { ...prev };
      for (const k of toRemove) delete next[Number(k)];
      return next;
    });
  }, [state.rowVideoClips, clipGenStartMs]);

  // ─── Batch E: render-to-MP4 kickoff ─────────────────────────────
  const executeRender = useCallback(async () => {
    if (state.doc.rows.length === 0) return;
    // Flush any unsaved edits before kicking off — the server reads
    // the SAME config we hand it, but the user expects "what I see"
    // to be what gets rendered, including the last keystroke.
    await flushSave();

    // Rebuild the config with `useBrollProxy: true` so the server-
    // side Remotion renderer can stream B-roll bytes through our
    // proxy (R2 presign URLs don't always survive a Lambda fetch).
    // Falls back to the same builder the preview uses; only the
    // proxy flag differs.
    const rowImageArr = state.doc.rows.map((_, i) => {
      const url = state.rowImages[i];
      // Status MUST be 'done' — the renderer's check at utils.ts:665
      // is `imageState?.status === 'done'`. Passing 'ready' silently
      // dropped every image into the text-reveal fallback path because
      // `hasVisual` evaluated false. Cost the user real money + trust.
      return url ? { status: 'done', imageUrl: url } : null;
    });
    const rowVideoClipArr = state.doc.rows.map((_, i) => {
      const clip = state.rowVideoClips[i];
      if (!clip) return null;
      return {
        status: clip.status,
        videoUrl: clip.videoUrl,
        durationSeconds: clip.durationSeconds,
      };
    });
    const rowLockedArr = state.doc.rows.map((_, i) =>
      Boolean(state.flags.rowLockedAsStill[i]),
    );
    const renderConfig = productionDocToVideoConfig(state.doc, rowImageArr, {
      voiceoverUrl: state.voiceoverUrl,
      captions: state.captions?.segments,
      rowOverlays: state.rowOverlays,
      rowVideoClips: rowVideoClipArr,
      rowLockedAsStill: rowLockedArr,
      animateScenes: state.flags.animateScenes,
      suppressLowerThirds: state.flags.suppressLowerThirds,
      musicUrl: state.musicUrl,
      brand: resolvedRenderBrand,
      alignment: state.voiceoverAlignment,
      // PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`:
      // pass the resolved built-in slug so saved-style UUIDs derived
      // from doodle / paint route to the yellow LowerThird variant.
      effectiveStyleSlug: effectiveStyleSlug ?? undefined,
      // CRITICAL for server-side render: stream B-roll through the
      // app's proxy so the Lambda fetch has CORS-clean, presign-
      // stable URLs.
      useBrollProxy: true,
    });

    setRenderState({ status: 'rendering', progress: 0, renderId: null });
    // Clear any prior render's persistent download URL — the file it
    // pointed at is now stale (we're about to make a new one). The
    // top-bar "Download MP4" button hides until the new render lands.
    setLatestDownloadUrl(null);
    console.info('[editor render] start', {
      rowCount: renderConfig.shots.length,
      hasVoiceover: Boolean(renderConfig.voiceoverUrl),
      title: state.doc.title || null,
    });
    // Boundary 1/3 of the preview-vs-render divergence trace. Pairs
    // with `[render] config received` (after parse) and `[render]
    // config effective` (after absolutize + realign) on the server so a
    // creator reporting "the MP4 doesn't match my preview" can paste
    // these three lines and we can spot which boundary mutated the
    // shot data. Cheap: ~1KB of JSON per render kickoff.
    console.info('[editor render] config summary', summarizeConfigForDiagnostics(renderConfig));

    const body: Record<string, unknown> = {
      config: renderConfig,
      title: state.doc.title || null,
    };
    // Pass the alignment hint when the cache is warm AND the URL is
    // a proxy path the server-side route accepts. Falsy voiceoverUrl
    // and ElevenLabs-direct Blob URLs make the server fall back to
    // estimated timing — same as production-doc's render flow.
    const VOICEOVER_PROXY_RE = /^\/api\/voiceovers\/[0-9a-f-]{36}\/audio$/i;
    if (state.voiceoverAlignment && state.voiceoverUrl && VOICEOVER_PROXY_RE.test(state.voiceoverUrl)) {
      body.voiceoverAlignment = {
        audioPath: state.voiceoverUrl,
        rowScripts: state.doc.rows.map((r) => r.script_text),
      };
    }

    let renderId: string | null = null;
    try {
      // eslint-disable-next-line no-restricted-syntax -- render RPC: awaits and uses response (render id)
      const res = await fetch('/api/render/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        renderId?: string;
        error?: string;
      };
      if (!res.ok || !data.renderId) {
        const message = data.error || `Failed to start render: HTTP ${res.status}`;
        console.warn('[editor render] kickoff failed', { message });
        setRenderState({ status: 'error', message });
        return;
      }
      renderId = data.renderId;
      console.info('[editor render] kicked off', { renderId });
      setRenderState({ status: 'rendering', progress: 0, renderId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[editor render] kickoff threw', { detail: message });
      setRenderState({ status: 'error', message });
      return;
    }

    // Poll every 2s — same cadence production-doc uses.
    if (renderPollRef.current) clearInterval(renderPollRef.current);
    renderPollRef.current = setInterval(async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, polls render status
        const statusRes = await fetch(`/api/render/video?renderId=${renderId}`);
        const statusData = (await statusRes.json().catch(() => ({}))) as {
          status?: string;
          progress?: number;
          downloadUrl?: string | null;
          error?: string;
        };
        if (statusData.status === 'done') {
          if (renderPollRef.current) clearInterval(renderPollRef.current);
          console.info('[editor render] done', { renderId, hasUrl: Boolean(statusData.downloadUrl) });
          setRenderState({
            status: 'done',
            downloadUrl: statusData.downloadUrl ?? null,
            renderId,
          });
          // Persist the download URL outside the modal lifecycle so
          // closing the "Render complete" dialog doesn't lose the
          // user's only way back to the file. The header renders a
          // "Download MP4" button whenever this is set.
          if (statusData.downloadUrl) {
            setLatestDownloadUrl(statusData.downloadUrl);
          }
          return;
        }
        if (statusData.status === 'error') {
          if (renderPollRef.current) clearInterval(renderPollRef.current);
          console.warn('[editor render] failed', { renderId, error: statusData.error });
          setRenderState({
            status: 'error',
            message: statusData.error || 'Render failed (no error message returned)',
          });
          return;
        }
        // Still rendering — bump progress.
        setRenderState((prev) =>
          prev && prev.status === 'rendering'
            ? { ...prev, progress: statusData.progress ?? prev.progress }
            : prev,
        );
      } catch {
        // Transient poll error — let the next tick try again.
      }
    }, 2000);
  }, [
    flushSave,
    state.doc,
    state.rowImages,
    state.rowVideoClips,
    state.rowOverlays,
    state.flags,
    state.voiceoverUrl,
    state.voiceoverAlignment,
    state.captions,
    state.musicUrl,
    resolvedRenderBrand,
  ]);

  // ─── Batch D: Animate-all batch ─────────────────────────────────
  //
  // Sequential loop that calls handleGenerateClip for every row that
  // doesn't have a ready/generating clip AND has enough prompt text.
  // Sequential (not parallel) for the same reason production-doc does:
  // Kie's rate-limiter, and smooth progress reporting.
  const [animateAllProgress, setAnimateAllProgress] = useState<{ done: number; total: number } | null>(null);

  const animateAllCandidates = useMemo(() => {
    const model = findBrollModel(userBrollModelId);
    if (!model) return [] as number[];
    const out: number[] = [];
    state.doc.rows.forEach((row, i) => {
      const existing = state.rowVideoClips[i];
      if (existing && (existing.status === 'generating' || existing.status === 'ready')) return;
      if (state.flags.rowLockedAsStill[i]) return;
      const still = state.rowImages[i];
      if (model.kind === 'image-to-video' && !still) return;
      const visDesc = (row.visual_description ?? '').trim();
      const aiPrompt = (row.ai_image_prompt ?? '').trim();
      if (visDesc.length < 20 && aiPrompt.length < 20) return;
      out.push(i);
    });
    return out;
  }, [state.doc.rows, state.rowImages, state.rowVideoClips, state.flags.rowLockedAsStill, userBrollModelId]);

  const animateAllCostUsd = useMemo(() => {
    const model = findBrollModel(userBrollModelId);
    if (!model) return 0;
    return animateAllCandidates.length * model.priceUsd;
  }, [animateAllCandidates, userBrollModelId]);

  const handleAnimateAll = useCallback(async () => {
    if (animateAllProgress) return;
    if (animateAllCandidates.length === 0) return;
    const model = findBrollModel(userBrollModelId);
    if (!model) return;
    const confirmed = window.confirm(
      `Animate ${animateAllCandidates.length} shot${animateAllCandidates.length === 1 ? '' : 's'} with ${model.label}?\n\n` +
        `Estimated cost: ~$${animateAllCostUsd.toFixed(2)}.\n\n` +
        `Generations run sequentially. You can keep editing while they finish.`,
    );
    if (!confirmed) return;
    console.info('[editor animate-all] start', {
      count: animateAllCandidates.length,
      costUsd: animateAllCostUsd,
      modelId: userBrollModelId,
    });
    setAnimateAllProgress({ done: 0, total: animateAllCandidates.length });
    for (let n = 0; n < animateAllCandidates.length; n++) {
      const rowIndex = animateAllCandidates[n]!;
      await handleGenerateClip(rowIndex);
      setAnimateAllProgress({ done: n + 1, total: animateAllCandidates.length });
    }
    console.info('[editor animate-all] done');
    setAnimateAllProgress(null);
  }, [animateAllCandidates, animateAllCostUsd, animateAllProgress, handleGenerateClip, userBrollModelId]);

  // Poll loop for in-flight clips. Walks state.rowVideoClips on each
  // tick, fetches /api/broll/{id} for any row whose status is
  // 'generating', and dispatches SET_ROW_VIDEO_CLIP on each status
  // change. The 'ready' transition lands as a non-transient command
  // so it goes on the undo stack (cleanly Cmd+Z'd if the user
  // changes their mind).
  //
  // Effect dep narrowing: we memoize a stable "which rows to poll"
  // signature so the loop ONLY restarts when (a) the set of generating
  // rows changes or (b) a polled row's broll signature (timecode +
  // visual_description) changes. Depending on `state.doc.rows` would
  // restart the interval on every script_text keystroke — wasteful and
  // it fires an extra immediate tick each time.
  const brollPollTargets = useMemo(() => {
    const map = readBrollLsMap();
    const out: Array<{ rowIndex: number; clipId: string }> = [];
    for (const [k, v] of Object.entries(state.rowVideoClips)) {
      if (!v || v.status !== 'generating') continue;
      const rowIndex = Number(k);
      const row = state.doc.rows[rowIndex];
      if (!row) continue;
      // Source of truth: state.rowVideoClips[i].brollClipId, set by
      // handleGenerateClip immediately after the kickoff returns.
      // Fall back to the localStorage map BrollCell uses (for clips
      // that were kicked off before this state field was wired, or
      // clips kicked off in a different tab). Without this dual path
      // the editor's poll loop would never find the clipId when
      // localStorage was empty / corrupted / cross-origin-blocked —
      // user perceives "endless generation."
      let clipId: string | undefined = v.brollClipId;
      if (!clipId) {
        const sig = brollRowSignatureInput({
          timecode: row.timecode,
          visual_description: row.visual_description,
        });
        clipId = map[sig];
      }
      if (clipId) {
        out.push({ rowIndex, clipId });
      } else {
        console.warn('[editor broll] generating row has no clipId — poll cannot start', {
          rowIndex,
          rowVideoClipState: v,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.rowVideoClips,
    // Stable JSON key of the polled rows' signature fields. Changes
    // only when a generating row's timecode or visual_description
    // changes — not when script_text or any other field does.
    JSON.stringify(
      Object.entries(state.rowVideoClips)
        .filter(([, v]) => v?.status === 'generating')
        .map(([k]) => {
          const r = state.doc.rows[Number(k)];
          return r
            ? [k, r.timecode, r.visual_description, state.rowVideoClips[Number(k)]?.brollClipId]
            : [k, null, null, null];
        }),
    ),
  ]);

  useEffect(() => {
    if (brollPollTargets.length === 0) return;

    // Observability: log every restart of the poll loop with the
    // current target set. Without this, "did my kickoff actually
    // start polling?" is unanswerable from the console — the only
    // existing logs fire on terminal/failure, which a still-generating
    // Kling 3.0 Pro clip won't trigger for 5+ minutes.
    console.info('[editor broll] poll loop started', {
      targets: brollPollTargets,
      intervalMs: 5000,
    });

    let cancelled = false;
    let tickIndex = 0;
    const tick = async () => {
      const myTick = ++tickIndex;
      console.info('[editor broll] poll tick', {
        tick: myTick,
        targets: brollPollTargets.map((t) => ({ rowIndex: t.rowIndex, clipId: t.clipId })),
      });
      for (const { rowIndex, clipId } of brollPollTargets) {
        if (cancelled) return;
        try {
          // eslint-disable-next-line no-restricted-syntax -- GET, polls broll clip status
          const res = await fetch(`/api/broll/${encodeURIComponent(clipId)}`, {
            cache: 'no-store',
          });
          if (!res.ok) {
            console.warn('[editor broll] poll http not ok', {
              tick: myTick,
              rowIndex,
              clipId,
              httpStatus: res.status,
            });
            continue;
          }
          // The server wraps the row in `{ clip }` (matches BrollCell's
          // hydrate + poll loops in production-doc/BrollCell.tsx).
          // The editor previously read `data.status` / `data.video_url`
          // directly on `data`, which were always undefined → the poll
          // defaulted status to 'generating' and NEVER terminated.
          // Result: spinner spun forever even when the clip was ready
          // in the DB. Bug present since the editor's broll integration
          // landed. 2026-05-23 fix: read `data.clip.*` like everyone
          // else does.
          const data = (await res.json()) as {
            clip?: {
              status?: string;
              video_url?: string | null;
              duration_seconds?: number | null;
              error_message?: string | null;
            };
          };
          if (cancelled) return;
          const clip = data.clip;
          if (!clip) {
            console.warn('[editor broll] poll response missing clip field', {
              tick: myTick,
              rowIndex,
              clipId,
            });
            continue;
          }
          const status = typeof clip.status === 'string' ? clip.status : 'generating';
          console.info('[editor broll] poll status', {
            tick: myTick,
            rowIndex,
            clipId,
            status,
            hasVideoUrl: Boolean(clip.video_url),
          });
          if (status === 'generating' || status === 'pending') continue;
          // Terminal state — commit it through the non-transient
          // path so Cmd+Z reverses cleanly to the prior state.
          console.info('[editor broll] poll terminal', {
            rowIndex,
            clipId,
            status,
            hasVideoUrl: Boolean(clip.video_url),
            errorMessage: clip.error_message,
          });
          setRowVideoClip(rowIndex, {
            status,
            videoUrl: clip.video_url ?? undefined,
            durationSeconds: clip.duration_seconds ?? undefined,
            errorMessage: clip.error_message ?? undefined,
            brollClipId: clipId,
          }, false);

          // History log — terminal PATCH. Best-effort: failure does NOT
          // block the user-visible clip commit above. If the eventId
          // isn't in the ref (e.g. user reloaded mid-generation so the
          // ref didn't survive), skip the PATCH; the History panel's
          // GET handler reconciles stuck 'generating' entries by
          // joining broll_clips, so the UI still shows the truth.
          const eventId = clipIdToEventIdRef.current.get(clipId);
          if (eventId && (status === 'ready' || status === 'failed')) {
            void markGenerationEventTerminal({
              projectId,
              eventId,
              status,
              errorMessage: clip.error_message ?? undefined,
            }).then(() => {
              clipIdToEventIdRef.current.delete(clipId);
              setHistoryRefreshTick((n) => n + 1);
            });
          } else {
            // No eventId — still refresh so the GET-side reconciliation
            // path surfaces the terminal status to the panel.
            setHistoryRefreshTick((n) => n + 1);
          }
        } catch (err) {
          console.warn('[editor broll] poll failed', {
            rowIndex,
            clipId,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    const handle = setInterval(() => { void tick(); }, 5000);
    void tick(); // immediate first read
    return () => {
      cancelled = true;
      clearInterval(handle);
      console.info('[editor broll] poll loop stopped', {
        targets: brollPollTargets,
      });
    };
  }, [brollPollTargets, setRowVideoClip, projectId]);

  /** Thin adapter so the ported handlers below read like their
   *  production-doc counterparts. Routes through PATCH_ROW so the
   *  edit lands on the undo stack + auto-save fires. */
  const updateRow = useCallback(
    (rowIndex: number, patch: Partial<ProductionDoc['rows'][number]>) => {
      apply({ type: 'PATCH_ROW', rowIndex, patch });
    },
    [apply],
  );

  // ─── Variants + title cards — port from production-doc ──────────
  //
  // See `_plans/2026-05-27-editor-variants-titles-notes.md`. These are
  // the editor-side adapters that mount the ported reducer commands on
  // the writers prop bundle the ShotInspector + InspectorVariantsPanel
  // expect. Each is intentionally THIN: the heavy lifting (row splice,
  // group renumbering, undo-inverse construction, asset reindex)
  // happens in the reducer + the onAfterCommand reindex side-effect at
  // the store boundary. The wrappers' job is to:
  //   - bind the active row index (or compute it from selection),
  //   - log a console.info breadcrumb that mirrors the production-doc
  //     surface so a bug report from either surface reads the same way,
  //   - surface a toast on user-meaningful state.

  /** Per-row variant-generation state. Keyed by row index. Drives the
   *  Generate button's spinner / error display in InspectorVariantsPanel.
   *  Cleared on success (handled by the helper) or when the user
   *  clicks Generate again (the helper sets it back to 'generating'). */
  const [variantGenStates, setVariantGenStates] = useState<
    Record<number, { kind: 'idle' } | { kind: 'generating' } | { kind: 'error'; message: string }>
  >({});

  const addVariantRow = useCallback(
    (baseIndex: number) => {
      console.info('[editor variants] add', { baseIndex });
      apply({ type: 'ADD_VARIANT_ROW', baseIndex });
    },
    [apply],
  );

  const deleteVariantRow = useCallback(
    (rowIndex: number) => {
      console.info('[editor variants] delete', { rowIndex });
      apply({ type: 'DELETE_VARIANT_ROW', rowIndex });
    },
    [apply],
  );

  const moveVariantRow = useCallback(
    (rowIndex: number, direction: 'up' | 'down') => {
      console.info('[editor variants] move', { rowIndex, direction });
      // Look up the swap target's row index BEFORE dispatch so we know
      // which two asset slots to mirror to the server. The reducer
      // swaps in-place (no row-reindex effect fires) — we have to push
      // both slots through /row-asset explicitly so the server's
      // project_assets table matches the post-swap state.
      const target = stateRef.current.doc.rows[rowIndex];
      if (!target?.group_id || (target.variant_index ?? 0) === 0) return;
      const swapIdx =
        direction === 'up' ? (target.variant_index ?? 0) - 1 : (target.variant_index ?? 0) + 1;
      const swapRowIndex = stateRef.current.doc.rows.findIndex(
        (r) => r.group_id === target.group_id && (r.variant_index ?? 0) === swapIdx,
      );
      if (swapRowIndex < 0) return;
      apply({ type: 'MOVE_VARIANT_ROW', rowIndex, direction });
      // After dispatch, what WAS at rowIndex is now at swapRowIndex
      // (and vice versa). Re-persist both image URLs in their new
      // positions. Reading from stateRef.current post-dispatch is safe
      // because dispatch flushes synchronously in useEditorStore.
      const newRowImages = stateRef.current.rowImages;
      const urlAtRow = newRowImages[rowIndex];
      const urlAtSwap = newRowImages[swapRowIndex];
      writeRowAsset(rowIndex, 'image', urlAtRow ?? null);
      writeRowAsset(swapRowIndex, 'image', urlAtSwap ?? null);
    },
    [apply, writeRowAsset],
  );

  /** Generate a variant image from its base (or previous variant if
   *  chained). Async fire-and-forget: dispatches a local "generating"
   *  state, POSTs to the existing edit endpoint, then commits the
   *  returned URL via commitRowImage (which both dispatches
   *  SET_ROW_IMAGE locally AND persists via /row-asset). On error,
   *  parks the error message on variantGenStates for the panel to
   *  display. */
  const generateVariantImage = useCallback(
    async (variantRowIndex: number) => {
      const liveDoc = stateRef.current.doc;
      const variantRow = liveDoc.rows[variantRowIndex];
      if (!variantRow?.group_id || (variantRow.variant_index ?? 0) === 0) {
        toast.error('Not a variant row.');
        return;
      }

      // Source image: base for parallel variants, previous variant for
      // chained ones. Mirrors production-doc's generateVariantImage.
      const groupId = variantRow.group_id;
      const baseRowIndex = liveDoc.rows.findIndex(
        (r) => r.group_id === groupId && (r.variant_index ?? 0) === 0,
      );
      if (baseRowIndex < 0) {
        toast.error('Base row not found for this variant group.');
        return;
      }
      const currentVariantIdx = variantRow.variant_index ?? 0;
      let sourceRowIndex = baseRowIndex;
      if (variantRow.variant_derives_from_previous && currentVariantIdx > 1) {
        const prevIdx = liveDoc.rows.findIndex(
          (r) =>
            r.group_id === groupId
            && (r.variant_index ?? 0) === currentVariantIdx - 1,
        );
        if (prevIdx >= 0) sourceRowIndex = prevIdx;
      }
      const sourceImageUrl = stateRef.current.rowImages[sourceRowIndex];
      if (!sourceImageUrl) {
        toast.error('Generate the base image first — variants edit it.');
        return;
      }

      // Propagate the user's GPT Image 2 edit primary preference from
      // localStorage into the request body so the server dispatcher
      // honours it without a sync round-trip. Lazy-imported so the
      // editor settings module (browser-only) doesn't leak into any
      // SSR path that might import this file.
      const { getGptImage2EditPrimary } = await import('@/lib/editor/settings');
      const editPrimary = getGptImage2EditPrimary();
      const prepared = composeVariantEditRequest(
        liveDoc,
        variantRow,
        sourceImageUrl,
        editPrimary,
      );
      if (prepared.kind === 'error') {
        toast.error(prepared.message);
        return;
      }

      console.info('[editor variants] generate start', {
        variantRowIndex,
        baseRowIndex,
        sourceRowIndex,
        chained: variantRow.variant_derives_from_previous === true,
        edit_primary: editPrimary,
      });
      setVariantGenStates((prev) => ({ ...prev, [variantRowIndex]: { kind: 'generating' } }));

      try {
        const res = await queueImageGen('edit', 'editor-variant-edit', () =>
          // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response
          fetch('/api/generate/production-doc/image/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prepared.request),
          }),
        );
        if (res.status === 429) reportUpstream429('edit', 'editor-variant-edit');
        const data = (await res.json().catch(() => ({}))) as {
          imageUrl?: string;
          error?: string;
        };
        if (!res.ok || !data.imageUrl) {
          const msg = data.error || `HTTP ${res.status}`;
          console.warn('[editor variants] generate failed', {
            variantRowIndex,
            status: res.status,
            detail: msg.slice(0, 200),
          });
          setVariantGenStates((prev) => ({
            ...prev,
            [variantRowIndex]: { kind: 'error', message: msg },
          }));
          toast.error(`Variant generate failed: ${msg}`);
          return;
        }
        commitRowImage(variantRowIndex, data.imageUrl);
        // Stamp the source image so the staleness banner can detect
        // when the base later changes. Same field the production-doc
        // grid writes in Phase 3.7c.
        updateRow(variantRowIndex, { variant_base_image_at_generation: sourceImageUrl });
        setVariantGenStates((prev) => ({ ...prev, [variantRowIndex]: { kind: 'idle' } }));
        console.info('[editor variants] generate ok', { variantRowIndex });
        toast.success(`Variant ${currentVariantIdx} generated`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[editor variants] generate threw', { variantRowIndex, detail: msg });
        setVariantGenStates((prev) => ({
          ...prev,
          [variantRowIndex]: { kind: 'error', message: msg },
        }));
        toast.error(`Variant generate threw: ${msg}`);
      }
    },
    [commitRowImage, updateRow],
  );

  const setRowVisualType = useCallback(
    (rowIndex: number, visualType: string, options?: { promoteFields?: boolean }) => {
      console.info('[editor visual-type] set', {
        rowIndex,
        visualType,
        promoteFields: options?.promoteFields === true,
      });
      apply({
        type: 'SET_ROW_VISUAL_TYPE',
        rowIndex,
        visualType,
        promoteFields: options?.promoteFields,
      });
    },
    [apply],
  );

  const splitAsTitleCard = useCallback(
    (rowIndex: number, heading: string) => {
      console.info('[editor title-card] split', { rowIndex, heading });
      apply({ type: 'SPLIT_AS_TITLE_CARD', rowIndex, heading });
    },
    [apply],
  );

  const applyTitleCardAsSectionTitle = useCallback(
    (rowIndex: number) => {
      console.info('[editor title-card] apply-as-section-title', { rowIndex });
      apply({ type: 'APPLY_TITLE_CARD_AS_SECTION_TITLE', rowIndex });
      toast.success('Section title applied to downstream rows.');
    },
    [apply],
  );
  /** Set / clear the per-row overlay render state. Same auto-save +
   *  undo guarantees as updateRow. `transient: true` marks the change
   *  as ephemeral UI state (e.g. `loading`) so it skips the undo
   *  stack — used by replaceOverlayForRow's intermediate states so
   *  Cmd+Z only reverses the final committed change. */
  const setRowOverlay = useCallback(
    (rowIndex: number, overlay: RowOverlayRenderState | null, transient?: boolean) => {
      apply({ type: 'SET_ROW_OVERLAY', rowIndex, overlay, transient });
      // Same reasoning as setRowVideoClip — server PATCH is asset-blind
      // for rowOverlays, so committed states need the row-asset endpoint.
      if (!transient) {
        writeRowAsset(rowIndex, 'overlay', overlay);
      }
    },
    [apply, writeRowAsset],
  );

  /** Phase 3 — Rethink. Mirrors production-doc's rethinkOverlayPlacement
   *  with the editor's state shape. */
  const rethinkOverlayPlacement = useCallback(
    async (rowIndex: number): Promise<void> => {
      // Synchronous in-flight guard. See production-doc's twin for
      // the reasoning — defense against state-batching letting two
      // rapid clicks both pass the React-state gate.
      if (rethinkInFlightRef.current.has(rowIndex)) {
        console.warn('[ui overlay-rethink] already in flight — ignoring duplicate click', {
          rowIndex,
        });
        return;
      }
      const overlayState = state.rowOverlays[rowIndex];
      if (overlayState?.status !== 'done' || !overlayState.url) {
        console.warn('[ui overlay-rethink] no overlay to rethink', {
          rowIndex,
          status: overlayState?.status,
        });
        return;
      }
      const attempts = rethinkAttempts[rowIndex] ?? 0;
      if (attempts >= RETHINK_MAX_ATTEMPTS) {
        alert(
          `AI rethink limit reached for this overlay (${RETHINK_MAX_ATTEMPTS}/session). Reload the page to reset.`,
        );
        return;
      }
      const row = state.doc.rows[rowIndex];
      if (!row) return;
      const sceneImageUrl = state.rowImages[rowIndex];
      if (!sceneImageUrl) {
        alert(
          'Generate the row image first — the AI needs to see the scene before it can rethink the overlay placement.',
        );
        return;
      }
      const saliencyMap = row.image_saliency;
      const saliencyCells = saliencyMap
        ? Array.from({ length: saliencyMap.cols * saliencyMap.rows }, (_, idx) => ({
            row: Math.floor(idx / saliencyMap.cols),
            col: idx % saliencyMap.cols,
            score: saliencyMap.busyness[idx] ?? 0,
          }))
        : undefined;
      const prevMode: 'zone' | 'custom' =
        row.overlay_position &&
        typeof row.overlay_position.x_pct === 'number' &&
        typeof row.overlay_position.y_pct === 'number'
          ? 'custom'
          : 'zone';
      const previousDecision = {
        sizePct:
          typeof row.overlay_size_pct === 'number'
            ? row.overlay_size_pct
            : row.overlay_size === 'small'
              ? 12
              : row.overlay_size === 'large'
                ? 25
                : 18,
        mode: prevMode,
        zone: row.overlay_zone_resolved ?? row.overlay_zone,
        customXPct: row.overlay_position?.x_pct,
        customYPct: row.overlay_position?.y_pct,
        reason: row.overlay_placement_reason ?? '',
      };
      console.info('[ui overlay-rethink] request', {
        rowIndex,
        attempt: attempts + 1,
        previousMode: prevMode,
        previousZone: previousDecision.zone,
        previousSize: previousDecision.sizePct,
      });
      rethinkInFlightRef.current.add(rowIndex);
      setRethinkingRows((prev) => {
        const next = new Set(prev);
        next.add(rowIndex);
        return next;
      });
      try {
        // eslint-disable-next-line no-restricted-syntax -- overlay RPC: awaits and uses response
        const res = await fetch('/api/overlay/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'placement-only',
            existingOverlayUrl: overlayState.url,
            sceneImageUrl,
            saliencyCells,
            previousDecision,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          placement?: {
            model: string;
            sizePct: number;
            mode: 'zone' | 'custom';
            zone?: ProductionDoc['rows'][number]['overlay_zone'];
            customXPct?: number;
            customYPct?: number;
            reason: string;
          };
          error?: string;
          reason?: string;
        };
        // Mirror production-doc's two-branch error handling so the user
        // sees a useful message instead of "Rethink failed: undefined"
        // when the route returns 200 with `placement: null`.
        if (!res.ok) {
          alert(`Rethink failed: ${data.error || `HTTP ${res.status}`}`);
          console.warn('[ui overlay-rethink] non-OK', { rowIndex, status: res.status, body: data });
          return;
        }
        if (!data.placement) {
          alert(
            "AI couldn't produce a new placement — the previous pick stays. Try again or drag manually.",
          );
          console.warn('[ui overlay-rethink] no placement returned', {
            rowIndex,
            reason: data.reason,
          });
          return;
        }
        const p = data.placement;
        console.info('[ui overlay-rethink] applied', {
          rowIndex,
          attempt: attempts + 1,
          model: p.model,
          sizePct: p.sizePct,
          mode: p.mode,
          zone: p.zone,
          reason: p.reason,
        });
        updateRow(rowIndex, {
          overlay_size_pct: p.sizePct,
          overlay_position:
            p.mode === 'custom' &&
            typeof p.customXPct === 'number' &&
            typeof p.customYPct === 'number'
              ? { x_pct: p.customXPct, y_pct: p.customYPct }
              : undefined,
          ...(p.mode === 'zone' && p.zone ? { overlay_zone: p.zone } : {}),
          overlay_placement_reason: p.reason || undefined,
          overlay_placement_model: p.model,
        });
        setRethinkAttempts((prev) => ({ ...prev, [rowIndex]: attempts + 1 }));
        // Telemetry parity with production-doc — before/after delta so
        // the per-model drag-rate dashboard sees editor activity too.
        void recordOverlayTelemetry('overlay_rethink', {
          row_index: rowIndex,
          placement_model: p.model,
          attempt: attempts + 1,
          prev_zone: previousDecision.zone ?? null,
          new_zone: p.zone ?? null,
          prev_size_pct: previousDecision.sizePct,
          new_size_pct: Number(p.sizePct.toFixed(2)),
          prev_mode: previousDecision.mode,
          new_mode: p.mode,
        });
      } catch (err) {
        console.warn('[ui overlay-rethink] threw', {
          rowIndex,
          detail: err instanceof Error ? err.message : String(err),
        });
        alert('Rethink failed — see console for details.');
      } finally {
        rethinkInFlightRef.current.delete(rowIndex);
        setRethinkingRows((prev) => {
          const next = new Set(prev);
          next.delete(rowIndex);
          return next;
        });
      }
    },
    [state.rowOverlays, state.doc.rows, state.rowImages, rethinkAttempts, updateRow],
  );

  /** Phase 5.1 — Undo last AI edit. Dispatches a single
   *  REVERT_OVERLAY_EDIT_TO command (composite) that restores both
   *  the overlay URL AND the edit-history stack atomically. The
   *  inverse is another REVERT_OVERLAY_EDIT_TO with the CURRENT
   *  state, so Cmd+Z then re-applies the undone edit cleanly. */
  const undoOverlayEdit = useCallback(
    (rowIndex: number) => {
      const row = state.doc.rows[rowIndex];
      const history = row?.overlay_edit_history;
      if (!row || !history || history.length === 0) {
        console.warn('[ui overlay-edit] undo skipped — no history', { rowIndex });
        return;
      }
      const previousUrl = history[history.length - 1]!;
      const nextHistory = history.slice(0, -1);
      console.info('[ui overlay-edit] undo', {
        rowIndex,
        restoredUrl: previousUrl,
        remainingHistory: nextHistory.length,
      });
      apply({
        type: 'REVERT_OVERLAY_EDIT_TO',
        rowIndex,
        restoredUrl: previousUrl,
        restoredHistory: nextHistory,
      });
    },
    [state.doc.rows, apply],
  );

  /** Phase 5 — accept callback for OverlayEditDialog. Dispatches a
   *  composite ACCEPT_OVERLAY_EDIT command so the URL swap + history
   *  push land as a SINGLE undo entry. Without the composite, Cmd+Z
   *  would have to be pressed multiple times to fully revert one
   *  edit (PATCH_ROW + SET_ROW_OVERLAY were separate inverses).
   *  `replacedUrl` is the dialog's snapshot — race-free vs a
   *  concurrent Replace via the context menu. */
  const handleOverlayEditAccept = useCallback(
    (newOverlayUrl: string, mode: 'smart' | 'brush', replacedUrl: string) => {
      const rowIndex = overlayEditRow;
      if (rowIndex === null) return;
      console.info('[ui overlay-edit] accepted', {
        rowIndex,
        mode,
        newOverlayUrl,
        replacedUrl,
      });
      apply({
        type: 'ACCEPT_OVERLAY_EDIT',
        rowIndex,
        newUrl: newOverlayUrl,
        replacedUrl,
        mode,
      });
    },
    [overlayEditRow, apply],
  );

  /** Phase 5.2 — Replace overlay (re-search). Mirrors production-doc's
   *  fetchOverlayForRow but only handles the response path; the editor
   *  doesn't initiate fetches from scratch (overlays arrive pre-fetched
   *  via the saved payload). */
  const replaceOverlayForRow = useCallback(
    async (rowIndex: number) => {
      const row = state.doc.rows[rowIndex];
      const terms = row?.overlay_stock_terms?.trim();
      if (!terms) {
        console.warn('[ui overlay-replace] skipped — no stock terms', { rowIndex });
        return;
      }
      // Loading state is transient UI — skip the undo stack so a
      // user's Cmd+Z after the Replace completes reverses only the
      // final result, not the intermediate loading status.
      setRowOverlay(rowIndex, { status: 'loading' }, true);
      try {
        const sceneImageUrl = state.rowImages[rowIndex];
        const saliencyMap = row.image_saliency;
        const saliencyCells = saliencyMap
          ? Array.from({ length: saliencyMap.cols * saliencyMap.rows }, (_, idx) => ({
              row: Math.floor(idx / saliencyMap.cols),
              col: idx % saliencyMap.cols,
              score: saliencyMap.busyness[idx] ?? 0,
            }))
          : undefined;
        // eslint-disable-next-line no-restricted-syntax -- overlay RPC: awaits and uses response
        const res = await fetch('/api/overlay/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overlayStockTerms: terms, sceneImageUrl, saliencyCells }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          overlayUrl?: string | null;
          sourceUrl?: string;
          reason?: string;
          error?: string;
          placement?: {
            model: string;
            sizePct: number;
            mode: 'zone' | 'custom';
            zone?: ProductionDoc['rows'][number]['overlay_zone'];
            customXPct?: number;
            customYPct?: number;
            reason: string;
          };
          rmbgKept?: boolean;
        };
        if (!res.ok) {
          setRowOverlay(rowIndex, {
            status: 'error',
            url: undefined,
          });
          return;
        }
        if (data.overlayUrl) {
          setRowOverlay(rowIndex, { status: 'done', url: data.overlayUrl });
          const p = data.placement;
          if (p) {
            updateRow(rowIndex, {
              overlay_size_pct: p.sizePct,
              overlay_position:
                p.mode === 'custom' &&
                typeof p.customXPct === 'number' &&
                typeof p.customYPct === 'number'
                  ? { x_pct: p.customXPct, y_pct: p.customYPct }
                  : undefined,
              ...(p.mode === 'zone' && p.zone ? { overlay_zone: p.zone } : {}),
              overlay_placement_reason: p.reason || undefined,
              overlay_placement_model: p.model,
              overlay_rmbg_kept: typeof data.rmbgKept === 'boolean' ? data.rmbgKept : undefined,
            });
          } else if (typeof data.rmbgKept === 'boolean') {
            updateRow(rowIndex, { overlay_rmbg_kept: data.rmbgKept });
          }
        } else {
          setRowOverlay(rowIndex, { status: 'skipped' });
        }
      } catch (err) {
        console.warn('[ui overlay-replace] threw', {
          rowIndex,
          detail: err instanceof Error ? err.message : String(err),
        });
        setRowOverlay(rowIndex, { status: 'error' });
      }
    },
    [state.doc.rows, state.rowImages, setRowOverlay, updateRow],
  );

  // Derive the VideoConfig the player will render. Memoized so the
  // Remotion player's inputProps reference is stable across renders
  // that don't touch the doc.
  const videoConfig = useMemo(() => {
    if (!doc) return null;
    const rowImageArr: (RowImageState | null)[] = state.doc.rows.map((_, i) => {
      const url = state.rowImages[i];
      // Status MUST be 'done' — the renderer's check at utils.ts:665
      // is `imageState?.status === 'done'`. Passing 'ready' silently
      // dropped every image into the text-reveal fallback path because
      // `hasVisual` evaluated false. Cost the user real money + trust.
      return url ? { status: 'done', imageUrl: url } : null;
    });
    // rowVideoClips → array form for the renderer. Sparse: rows
    // without a clip stay null so BRollScene falls back to the Ken
    // Burns + still path. Phase 3 of the parity refactor: before
    // this commit the editor never threaded clips through, so every
    // shot rendered as a still even when a B-roll animation existed.
    const rowVideoClipArr: (RowVideoClipState | null)[] = state.doc.rows.map((_, i) => {
      const clip = state.rowVideoClips[i];
      if (!clip) return null;
      return {
        status: clip.status,
        videoUrl: clip.videoUrl,
        durationSeconds: clip.durationSeconds,
      };
    });
    // rowLockedAsStill → index→bool array form. The flags map is
    // sparse by row index; the renderer wants `boolean[]` semantically
    // aligned with the rows array.
    const rowLockedArr = state.doc.rows.map((_, i) =>
      Boolean(state.flags.rowLockedAsStill[i]),
    );
    return productionDocToVideoConfig(state.doc, rowImageArr, {
      voiceoverUrl: state.voiceoverUrl,
      captions: state.captions?.segments,
      // Without this the renderer's overlay branch sees `overlayState`
      // as undefined and skips compositing every overlay on the doc.
      rowOverlays: state.rowOverlays,
      rowVideoClips: rowVideoClipArr,
      rowLockedAsStill: rowLockedArr,
      animateScenes: state.flags.animateScenes,
      suppressLowerThirds: state.flags.suppressLowerThirds,
      musicUrl: state.musicUrl,
      brand: resolvedRenderBrand,
      alignment: state.voiceoverAlignment,
      // PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`:
      // saved-style UUIDs route to their built-in parent for variant
      // resolution. Same value the executeRender path passes — preview
      // and final render stay in lockstep.
      effectiveStyleSlug: effectiveStyleSlug ?? undefined,
    });
  }, [
    doc,
    state.doc,
    state.rowImages,
    state.voiceoverUrl,
    state.captions,
    state.rowOverlays,
    state.rowVideoClips,
    state.flags,
    state.musicUrl,
    resolvedRenderBrand,
    state.voiceoverAlignment,
    effectiveStyleSlug,
  ]);

  const inputProps = useMemo(() => (videoConfig ? { config: videoConfig } : null), [videoConfig]);

  // Keep the videoConfigRef in sync. seekFromUser (declared near the
  // top of the component) reads fps off this ref so it doesn't have to
  // declare videoConfig as a dep and re-create on every config rebuild.
  useEffect(() => {
    videoConfigRef.current = videoConfig ? { fps: videoConfig.fps } : null;
  }, [videoConfig]);

  const totalFrames = useMemo(() => {
    if (!videoConfig) return 1;
    const totalMs = videoConfig.shots.reduce((acc, s) => acc + s.durationMs, 0);
    return Math.max(1, Math.round((totalMs / 1000) * videoConfig.fps));
  }, [videoConfig]);

  // Per-shot trim values pulled off the doc rows — handed to the
  // Timeline so the head / tail handles draw at the right offsets.
  const rowTrims = useMemo(() => {
    const out: Record<number, { trimStartMs?: number; trimEndMs?: number }> = {};
    state.doc.rows.forEach((row, i) => {
      if (typeof row.trim_start_ms === 'number' || typeof row.trim_end_ms === 'number') {
        out[i] = {
          trimStartMs: row.trim_start_ms,
          trimEndMs: row.trim_end_ms,
        };
      }
    });
    return out;
  }, [state.doc.rows]);

  // Per-shot transition_in values for the cross-fade chip.
  const rowTransitions = useMemo(() => {
    const out: Record<number, 'cross-fade' | null | undefined> = {};
    state.doc.rows.forEach((row, i) => {
      out[i] = row.transition_in;
    });
    return out;
  }, [state.doc.rows]);

  // Resolve the playhead against the doc's cumulative shot timing
  // so the "split at playhead" path knows which shot to act on and
  // whether the split would produce two legal halves. Recomputed
  // whenever the doc OR the playhead position changes — both are
  // primitive snapshots so the memo deps are stable.
  const splitTarget = useMemo(() => {
    if (!doc) return null;
    const starts = rowStartTimesMs(state.doc);
    for (let i = 0; i < state.doc.rows.length; i++) {
      const row = state.doc.rows[i];
      const startMs = starts[i];
      const duration =
        typeof row.duration_override_ms === 'number'
          ? row.duration_override_ms
          : (i + 1 < starts.length ? starts[i + 1] - startMs : 0);
      const endMs = startMs + duration;
      if (state.playheadMs > startMs && state.playheadMs < endMs) {
        const offsetMs = state.playheadMs - startMs;
        const validSplit =
          offsetMs >= EDITOR_MIN_SHOT_MS && (duration - offsetMs) >= EDITOR_MIN_SHOT_MS;
        return { shotIndex: i, splitAtMs: offsetMs, validSplit };
      }
    }
    return null;
  }, [doc, state.doc, state.playheadMs]);

  const handleSplit = useCallback(() => {
    if (!splitTarget || !splitTarget.validSplit) return;
    apply({ type: 'SPLIT_SHOT', shotIndex: splitTarget.shotIndex, splitAtMs: splitTarget.splitAtMs });
  }, [apply, splitTarget]);

  const handleDelete = useCallback(
    (mode: 'ripple' | 'blank') => {
      if (state.selection === null) return;
      // Refuse to delete the last remaining shot — the reducer
      // also guards but we early-return here so the toolbar button
      // disables itself for the right reason.
      if (state.doc.rows.length <= 1) return;
      apply({ type: 'DELETE_SHOT', shotIndex: state.selection, mode });
    },
    [apply, state.doc.rows.length, state.selection],
  );

  const handleToggleMute = useCallback(() => {
    if (state.selection === null) return;
    const row = state.doc.rows[state.selection];
    if (!row) return;
    apply({ type: 'SET_MUTE', shotIndex: state.selection, muted: row.muted !== true });
  }, [apply, state.doc.rows, state.selection]);

  // Phase 5 of `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
  // Per-shot Remove background AI verb. Two distinct paths:
  //   1. First-time application — POSTs to /image/rmbg, mirrors the
  //      cutout to R2, and patches the row with `image_rmbg_url` +
  //      `image_rmbg_applied: true`. The renderer immediately swaps
  //      in the cutout for the original.
  //   2. Re-toggle (the cutout already exists) — flips
  //      `image_rmbg_applied` only. The Bria call is skipped because
  //      the row's `image_rmbg_url` is still on hand from a past
  //      run, so re-applying is free + undoable.
  // Tracks in-flight requests in a Set keyed by shotIndex so a
  // double-click doesn't fire twice.
  const [rmbgInflight, setRmbgInflight] = useState<Set<number>>(() => new Set());
  const handleRunRmbg = useCallback(
    async (shotIndex: number) => {
      const row = state.doc.rows[shotIndex];
      if (!row) return;
      // Fast path: cutout already exists on this row. Just flip the
      // flag — no network call, instant undo.
      if (row.image_rmbg_url && row.image_rmbg_applied !== true) {
        console.info('[editor ai-rmbg] re-apply existing cutout', { shotIndex });
        apply({
          type: 'PATCH_ROW',
          rowIndex: shotIndex,
          patch: { image_rmbg_applied: true },
        });
        return;
      }
      const sourceUrl = state.rowImages[shotIndex];
      if (!sourceUrl) {
        alert('Remove background needs an image on this shot first.');
        return;
      }
      if (rmbgInflight.has(shotIndex)) return;
      setRmbgInflight((prev) => {
        const next = new Set(prev);
        next.add(shotIndex);
        return next;
      });
      const startedAt = Date.now();
      console.info('[editor ai-rmbg] dispatch', { shotIndex });
      try {
        const res = await queueImageGen('edit', 'editor-rmbg', () =>
          // eslint-disable-next-line no-restricted-syntax -- rmbg RPC: awaits and uses response (cutout URL)
          fetch('/api/generate/production-doc/image/rmbg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ originalImageUrl: sourceUrl }),
          }),
        );
        if (res.status === 429) reportUpstream429('edit', 'editor-rmbg');
        const data = (await res.json().catch(() => ({}))) as {
          cutoutUrl?: string;
          error?: string;
        };
        if (!res.ok || !data.cutoutUrl) {
          alert(`Background removal failed: ${data.error || `HTTP ${res.status}`}`);
          console.warn('[editor ai-rmbg] failed', {
            shotIndex,
            status: res.status,
            error: data.error,
          });
          return;
        }
        apply({
          type: 'PATCH_ROW',
          rowIndex: shotIndex,
          patch: {
            image_rmbg_url: data.cutoutUrl,
            image_rmbg_applied: true,
          },
        });
        console.info('[editor ai-rmbg] success', {
          shotIndex,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        alert(`Background removal failed: ${detail}`);
        console.warn('[editor ai-rmbg] error', { shotIndex, detail });
      } finally {
        setRmbgInflight((prev) => {
          const next = new Set(prev);
          next.delete(shotIndex);
          return next;
        });
      }
    },
    [apply, state.doc.rows, state.rowImages, rmbgInflight],
  );

  /** Undo the Remove background verb in one click without re-running
   *  the model. The cutout stays on the row so re-applying is free. */
  const handleRestoreOriginalBackground = useCallback(
    (shotIndex: number) => {
      console.info('[editor ai-rmbg] restore-original', { shotIndex });
      apply({
        type: 'PATCH_ROW',
        rowIndex: shotIndex,
        patch: { image_rmbg_applied: false },
      });
    },
    [apply],
  );

  // Keyboard shortcuts:
  //   Space      → play / pause (standard NLE binding)
  //   B          → split at playhead (CapCut / FCP blade)
  //   Delete     → ripple-delete selected shot
  //   Shift+Del  → blank-delete selected shot (keeps the slot)
  //   M          → mute / unmute selected shot
  //   + / =      → zoom timeline in
  //   - / _      → zoom timeline out
  // All shortcuts are ignored when focus is in a text input so
  // typing in an inline editor doesn't trigger them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

      // ── Undo / redo ────────────────────────────────────────────────
      // Cmd/Ctrl+Z       → undo
      // Cmd/Ctrl+Shift+Z → redo (Mac convention + secondary Windows)
      // Cmd/Ctrl+Y       → redo (primary Windows convention)
      //
      // These fire BEFORE the modifier-skip below so the Cmd/Ctrl is
      // actually honoured. The input/contentEditable gate above keeps
      // typing-undo inside text fields working natively in the browser
      // — only our doc state undo fires when focus is elsewhere.
      const isMod = e.metaKey || e.ctrlKey;
      const lowerKey = e.key.toLowerCase();
      if (isMod && !e.altKey && lowerKey === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          apply({ type: 'REDO' });
          console.info('[editor shortcut] redo', { source: 'cmd+shift+z' });
        } else {
          apply({ type: 'UNDO' });
          console.info('[editor shortcut] undo', { source: 'cmd+z' });
        }
        return;
      }
      if (isMod && !e.altKey && !e.shiftKey && lowerKey === 'y') {
        e.preventDefault();
        apply({ type: 'REDO' });
        console.info('[editor shortcut] redo', { source: 'cmd+y' });
        return;
      }

      // Bail on remaining modifier combos that don't belong here
      // (browser shortcuts like Cmd+S, find-in-page, etc.).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      // Spacebar → play / pause. Standard NLE binding. `e.key` is
      // ' ' for the space character; checking both keeps the
      // handler robust against quirky keyboards.
      if (key === ' ' || e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        const player = playerRef.current;
        if (player) {
          if (player.isPlaying()) {
            player.pause();
            console.info('[editor transport] pause', { source: 'keyboard', playheadMs: state.playheadMs });
          } else {
            player.play();
            console.info('[editor transport] play', { source: 'keyboard', playheadMs: state.playheadMs });
          }
        }
        return;
      }
      // Split at playhead. B is the conventional "blade" tool key
      // (DaVinci Resolve, iMovie); S is the CapCut convention and the
      // key the user asked for in `_plans/2026-06-02-shot-split-ui.md`.
      // Both fire the same handler so existing muscle memory is preserved.
      if (key === 'b' || key === 's') {
        e.preventDefault();
        console.info('[editor shortcut] split', { source: 'keyboard', key });
        handleSplit();
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        handleDelete(e.shiftKey ? 'blank' : 'ripple');
        return;
      }
      if (key === 'm') {
        e.preventDefault();
        handleToggleMute();
        return;
      }
      // Zoom: `+` / `=` zoom in; `-` zoom out. Matches the plan's
      // keyboard map and the muscle memory of every NLE.
      if (key === '+' || key === '=') {
        e.preventDefault();
        handleZoomDelta(ZOOM_STEP);
        return;
      }
      if (key === '-' || key === '_') {
        e.preventDefault();
        handleZoomDelta(-ZOOM_STEP);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [apply, handleDelete, handleSplit, handleToggleMute, handleZoomDelta, state.playheadMs]);

  // Subscribe to frame updates so the playhead reflects the live
  // play position. Throttled at the ms-rounded level so React only
  // re-renders the toolbar when the integer ms value changes. The
  // `playerRef` itself is declared up with the other refs near
  // `seekFromUser` so the helper can call `player.seekTo` on user
  // seeks (drag-scrub, ruler click, transport scrub).
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !videoConfig) return;
    const fps = videoConfig.fps;
    let lastMs = -1;
    const onFrameUpdate = (e: { detail: { frame: number } }): void => {
      const ms = Math.round((e.detail.frame / fps) * 1000);
      if (ms === lastMs) return;
      lastMs = ms;
      apply({ type: 'SET_PLAYHEAD', ms });
    };
    player.addEventListener('frameupdate', onFrameUpdate);
    return () => {
      player.removeEventListener('frameupdate', onFrameUpdate);
    };
  }, [videoConfig, apply]);

  // Memoize the cumulative shot start times so the TransportBar's
  // skip-prev / skip-next can land on the nearest boundary without
  // recomputing on every keystroke. Hoisted above the empty-payload
  // early return so hook order stays stable across reload-from-server
  // transitions (empty doc → populated doc would otherwise change the
  // number of hooks the component runs and break React's call order).
  const shotStartTimesMs = useMemo(() => rowStartTimesMs(state.doc), [state.doc]);
  // Keep the ref in sync so `selectShotFromUser` (declared earlier in
  // the render order) can read the latest cumulative start times
  // without taking the memo as a dep. Phase 2 of the timeline-and-
  // shots overhaul plan.
  useEffect(() => {
    shotStartTimesMsRef.current = shotStartTimesMs;
  }, [shotStartTimesMs]);
  // Mirror the renderer's per-shot startMs so click-to-jump lands on
  // the actual Player time of the shot, not the editor-store cumulative
  // duration (these differ when voiceover alignment retimes scenes
  // or when per-row trims apply). Without this sync the playhead would
  // appear "far from" the shot the user clicked.
  useEffect(() => {
    shotRenderStartTimesMsRef.current = videoConfig
      ? videoConfig.shots.map((s) => s.startMs)
      : [];
  }, [videoConfig]);

  // Pre-compute the save-status label + color for the header pill so
  // the in-place SaveStatusBadge doesn't have to reach into the
  // store from inside the JSX. Hoisted for the same hook-order reason.
  const totalDurationMs = useMemo(
    () => videoConfig?.shots.reduce((acc, s) => acc + s.durationMs, 0) ?? 0,
    [videoConfig],
  );

  // Narration strip data source. Real captions (generated via the
  // `Generate captions` action) take priority. When they don't exist
  // yet but the project HAS a voiceover, derive a fallback bundle from
  // each row's `script_text` paired with the renderer's per-shot
  // startMs/durationMs. The Player's playhead matches videoConfig
  // timing (post-alignment, post-trim), so `shots[i].startMs` is the
  // correct timebase here — `shotStartTimesMs` would drift when
  // voiceover alignment retimes scenes. Empty script rows are skipped
  // so the strip falls back to its "— silence —" placeholder instead
  // of rendering a blank line.
  const narrationCaptions = useMemo<CaptionsBundle | undefined>(() => {
    if (state.captions) return state.captions;
    if (!state.voiceoverUrl) return undefined;
    if (!videoConfig) return undefined;
    const segments = videoConfig.shots
      .map((shot, i) => {
        const text = state.doc.rows[i]?.script_text?.trim() ?? '';
        if (!text) return null;
        return {
          start: shot.startMs / 1000,
          end: (shot.startMs + shot.durationMs) / 1000,
          text,
        };
      })
      .filter((s): s is { start: number; end: number; text: string } => s !== null);
    if (segments.length === 0) return undefined;
    console.info('[editor narration-fallback] using script_text', {
      rowCount: state.doc.rows.length,
      segmentCount: segments.length,
      voiceoverPresent: true,
      captionsPresent: false,
    });
    return {
      voiceoverUrlHash: 'fallback',
      modelId: 'script-text-fallback',
      generatedAt: new Date(0).toISOString(),
      segments,
    };
  }, [state.captions, state.voiceoverUrl, state.doc.rows, videoConfig]);

  if (!doc || doc.rows.length === 0 || !inputProps || !videoConfig) {
    console.warn('[editor client] payload missing rows', {
      projectId,
      hasDoc: Boolean(doc),
      rowCount: doc?.rows.length ?? 0,
    });
    return (
      <div className="p-8 max-w-2xl mx-auto space-y-3">
        <h1 className="text-xl font-semibold">Couldn&apos;t load this project</h1>
        <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
          The production-doc row this URL points at hasn&apos;t generated any
          shots yet. Open the doc in the production-doc page first.
        </p>
        <Link href="/production-doc" className="text-sm underline">
          ← Back to Production Doc
        </Link>
      </div>
    );
  }

  // Real-NLE Phases 1+2 slice the editor into named slots that mount
  // into the chrome grid. Phase 1 set up the shell; Phase 2 replaces
  // the slot contents incrementally — header is now `EditorHeader`,
  // and a `TransportBar` sits under the preview. AI tools (Drift /
  // Overlays / Regen captions / Regen VO / Regen doc / Split / Delete
  // / Mute / Animate / Lower-3rd) temporarily live in the leftRail
  // slot until Phase 3 builds the real tabbed left rail.
  const saveStatusLabel = statusBarSaveLabel(saveStatus, state.isDirty);
  const saveStatusColor = (() => {
    if (saveStatus.kind === 'conflict') return '#fca5a5';
    if (saveStatus.kind === 'error') return '#fca5a5';
    if (state.isDirty) return 'var(--editor-accent)';
    return 'var(--fg-muted)';
  })();

  const headerSlot = (
    <EditorHeader
      title={payload.title || state.doc.title || 'Untitled project'}
      shotCount={state.doc.rows.length}
      totalDuration={state.doc.total_duration}
      version={state.version}
      saveStatusLabel={saveStatusLabel}
      saveStatusColor={saveStatusColor}
      isDirty={state.isDirty}
      canUndo={canUndo}
      canRedo={canRedo}
      onUndo={() => apply({ type: 'UNDO' })}
      onRedo={() => apply({ type: 'REDO' })}
      onSave={() => { void flushSave(); }}
      exportHref={`/api/edit/${encodeURIComponent(projectId)}/export?format=otio`}
      docHref={`/production-doc?h=${encodeURIComponent(projectId)}`}
      onHelp={() => {
        // Help opens the StatusBar's existing shortcut overlay by
        // dispatching the same custom event. The StatusBar listens
        // for `editor:show-shortcuts` in Phase 6 polish; for now,
        // log so the wiring is visible.
        console.info('[editor header] help clicked');
        window.dispatchEvent(new CustomEvent('editor:show-shortcuts'));
      }}
      switcherSlot={
        <ProjectSwitcher
          currentProjectId={projectId}
          isDirty={state.isDirty}
          onReloadCurrent={async () => {
            await reloadFromServer();
          }}
        />
      }
      onRender={() => { void executeRender(); }}
      isRendering={renderState?.status === 'rendering'}
      // Persistent download URL from the last completed render. The
      // header surfaces a "Download MP4" button while this is set so
      // the user can grab the file even after dismissing the
      // Render-complete modal. Cleared when a new render kicks off.
      latestDownloadUrl={latestDownloadUrl}
      onReopenRenderModal={() => {
        // Re-mount the dialog with the cached state. Useful when the
        // user wants the full "Render complete" panel back (download
        // link + the surrounding copy) — but the inline header button
        // is the primary affordance.
        if (latestDownloadUrl) {
          setRenderState({
            status: 'done',
            downloadUrl: latestDownloadUrl,
            renderId: null,
          });
        }
      }}
      onPullFromDoc={async () => {
        await reloadFromServer();
      }}
      alignmentStatus={
        deriveAlignmentStatus({
          voiceoverUrl: state.voiceoverUrl,
          voiceoverAlignment: state.voiceoverAlignment,
        }).status
      }
    />
  );

  // Caption regen helpers — reused by both the inspector's AI tools
  // tab and (in Phase 4) the inspector's Captions tab.
  const regenCaptionsRunning = captionsRegenState.kind === 'running';
  const regenCaptionsLabel = regenCaptionsRunning
    ? 'Captioning…'
    : state.captions
      ? 'Regen captions'
      : 'Generate captions';

  // Phase 3 leftRail — six tabs. Tab bodies compose existing
  // handlers so undo/redo/autosave behavior is identical to the
  // old toolbar. Selection-dependent tools (Split / Delete / Mute)
  // moved to the inspector / keyboard shortcuts; the left rail is
  // for global project actions.
  const leftRailSlot = (
    <EditorLeftRail
      initialTab={getLeftRailDefaultTab()}
      slots={{
        shots: (
          <ShotsTab
            rows={state.doc.rows}
            rowImages={state.rowImages}
            selection={state.selection}
            onSelect={(shotIndex) => selectShotFromUser(shotIndex, 'shots-tab')}
            onContextMenu={(shotIndex, x, y) => {
              console.info('[editor shots-tab context-menu] open', { shotIndex, x, y });
              setEditorContextMenu({ kind: 'shots-tab-item', shotIndex, x, y });
            }}
            filter={shotFilter}
            onFilterChange={handleShotFilterChange}
          />
        ),
        media: (
          <MediaTab
            shotCount={state.doc.rows.length}
            imageCount={Object.values(state.rowImages).filter(Boolean).length}
            clipCount={Object.values(state.rowVideoClips).filter((c) => c?.status === 'ready').length}
            hasVoiceover={Boolean(state.voiceoverUrl)}
            voiceoverUrl={state.voiceoverUrl}
            hasMusic={Boolean(state.musicUrl)}
            musicUrl={state.musicUrl}
            hasCaptions={Boolean(state.captions)}
            captionSegmentCount={state.captions?.segments.length ?? 0}
          />
        ),
        audio: (
          <AudioTab
            voiceoverUrl={state.voiceoverUrl}
            voiceoverAlignment={state.voiceoverAlignment}
            musicUrl={state.musicUrl}
            onRegenVO={() => setShowVoRegen(true)}
            onPickVoiceover={(url, source) => {
              console.info('[editor voiceover] picker change', { source, url: url || '(cleared)' });
              apply({ type: 'SET_VOICEOVER_URL', url: url || null });
            }}
            linkedProjectId={state.linkedProjectId}
            linkedScheduleItemId={state.linkedScheduleItemId}
            titleCandidates={[
              payload.title || state.doc.title,
              state.doc.title,
            ]}
          />
        ),
        captions: (
          <CaptionsTab
            captions={state.captions}
            onRegen={() => { void handleRegenerateCaptions(); }}
            regenDisabled={regenCaptionsRunning || !state.voiceoverUrl}
            regenLabel={regenCaptionsLabel}
          />
        ),
        ai: (
          <AIToolsTab
            onDriftReport={() => setShowDriftReport(true)}
            onOverlays={() => setShowOverlayManager(true)}
            overlayCount={state.doc.text_overlays?.length ?? 0}
            onRegenCaptions={() => { void handleRegenerateCaptions(); }}
            regenCaptionsDisabled={regenCaptionsRunning || !state.voiceoverUrl}
            regenCaptionsLabel={regenCaptionsLabel}
            onRegenVO={() => setShowVoRegen(true)}
            onRegenDoc={() => setShowRegenFromScript(true)}
            onOpenSectionThumbnail={() => setShowSectionThumbnail(true)}
            sectionThumbnailRegionCount={state.doc.thumbnail?.regions?.length ?? 0}
            hasSectionThumbnail={Boolean(state.doc.thumbnail?.imageUrl)}
            animateAllCandidateCount={animateAllCandidates.length}
            animateAllCostUsd={animateAllCostUsd}
            animateAllProgress={animateAllProgress}
            brollModelId={userBrollModelId}
            onAnimateAll={() => { void handleAnimateAll(); }}
            brandKitChannelName={channelVisualKit?.channelName ?? null}
            hasBrandKitOverride={Boolean(state.visualKitOverride || state.brandKitOverride)}
            onOpenBrandKit={() => setShowBrandKit(true)}
          />
        ),
        settings: (
          <SettingsTab
            flags={state.flags}
            onSetFlags={(patch) => apply({ type: 'SET_FLAGS', flags: patch })}
            // Batch D unblocked this — PATCH_DOC now exists, so the
            // editor can toggle `overlays_disabled` on the doc.
            overlaysDisabledOnDoc={state.doc.overlays_disabled === true}
            onToggleOverlaysDisabledOnDoc={() =>
              apply({
                type: 'PATCH_DOC',
                patch: { overlays_disabled: !(state.doc.overlays_disabled === true) },
              })
            }
            docMinSceneMs={state.doc.min_scene_ms}
            docTailBufferMs={state.doc.tail_buffer_ms}
            onSetSceneTiming={(patch) => apply({ type: 'PATCH_DOC', patch })}
          />
        ),
      }}
    />
  );

  const zoomStrip = (
    <div className="flex items-center justify-end gap-2 text-xs px-2" style={{ color: 'var(--fg-muted)' }}>
        <span title="Zoom out (−)">−</span>
        <input
          type="range"
          min={ZOOM_MIN_LEVEL}
          max={ZOOM_MAX_LEVEL}
          step={1}
          value={zoomLevel}
          onChange={(e) => setZoomLevel(Number(e.target.value))}
          className="w-32"
          aria-label="Timeline zoom"
        />
        <span title="Zoom in (+)">+</span>
        <span className="tabular-nums w-10 text-right">{zoomLevel}×</span>
    </div>
  );

  // Empty-state detection — the canonical signal that the user
  // landed on a project where production-doc hasn't finished its
  // work. Triggers the overlay card with reload + open-doc + pick-
  // another CTAs.
  const imageReadyCount = Object.values(state.rowImages).filter(Boolean).length;
  const clipReadyCount = Object.values(state.rowVideoClips).filter((c) => c?.status === 'ready').length;
  const showEmptyOverlay =
    state.doc.rows.length === 0 ||
    (imageReadyCount === 0 && !state.voiceoverUrl && clipReadyCount === 0);

  // Canva-style transform of the selected shot's visual. Only rendered
  // when (a) a shot is selected, (b) the shot has a visual (image or
  // clip), and (c) the player container has measured its size. The
  // overlay reads + writes through state.doc.rows[selection].
  const selectedRow =
    state.selection !== null ? state.doc.rows[state.selection] : null;
  const selectedHasVisual =
    selectedRow &&
    (Boolean(state.rowImages[state.selection!]) ||
      Boolean(state.rowVideoClips[state.selection!]?.videoUrl) ||
      Boolean(selectedRow.video_url_override));
  const overlayTransform =
    selectedRow && selectedHasVisual
      ? {
          xPct:
            typeof selectedRow.image_x_pct === 'number'
              ? selectedRow.image_x_pct
              : 0,
          yPct:
            typeof selectedRow.image_y_pct === 'number'
              ? selectedRow.image_y_pct
              : 0,
          scalePct:
            typeof selectedRow.image_scale_pct === 'number'
              ? selectedRow.image_scale_pct
              : 100,
          rotationDeg:
            typeof selectedRow.image_rotation_deg === 'number'
              ? selectedRow.image_rotation_deg
              : 0,
        }
      : null;

  const previewSlot = (
    <>
      {saveStatus.kind === 'conflict' && (
        <ConflictBanner
          onReload={() => {
            closeAllOverlayModals();
            void reloadFromServer();
          }}
        />
      )}
      <div
        ref={previewContainerRef}
        className="rounded-lg overflow-hidden flex-1 min-w-0 relative editor-panel"
        style={{ background: '#000' }}
      >
        <Player
          ref={playerRef}
          component={YouTubeVideo}
          inputProps={inputProps}
          durationInFrames={totalFrames}
          compositionWidth={videoConfig.width}
          compositionHeight={videoConfig.height}
          fps={videoConfig.fps}
          playbackRate={playbackRate}
          controls={false}
          // Fit mode comes from the per-device setting. `contain`
          // (default) letterboxes the frame to preserve aspect ratio;
          // `fill` stretches to the preview rectangle (may distort).
          style={{ width: '100%', height: '100%', objectFit: getPreviewFitMode() }}
          acknowledgeRemotionLicense
        />
        {/* Captions are rendered INSIDE the Remotion composition
            via <CaptionsOverlay>, so they appear in both the editor
            preview AND in Lambda renders. No separate HTML overlay
            needed. */}

        {showEmptyOverlay && (
          <EditorEmptyState
            kind={state.doc.rows.length === 0 ? 'no-rows' : 'no-assets'}
            shotCount={state.doc.rows.length}
            imageCount={imageReadyCount}
            clipCount={clipReadyCount}
            hasVoiceover={Boolean(state.voiceoverUrl)}
            onReload={async () => {
              await reloadFromServer();
            }}
            onOpenSwitcher={() =>
              window.dispatchEvent(new CustomEvent('editor:open-switcher'))
            }
          />
        )}
        {/* Free-transform overlay — mounts when a shot is selected
            and has a visual. Live `onChange` fires during the drag so
            the Player follows the mouse; `onCommit` lands the final
            value on the undo stack via PATCH_ROW. */}
        {state.selection !== null && overlayTransform && !showEmptyOverlay && (
          <TransformOverlay
            containerRef={previewContainerRef}
            transform={overlayTransform}
            // Inset the selection box below the title stripe so it
            // wraps the actual visual area, not the entire canvas.
            // Only applies when this row has a section title AND
            // letterbox layout — overlay-mode rows render the stripe
            // ON TOP of the full-frame scene, so visual area is the
            // whole canvas.
            stripeHeightFraction={(() => {
              if (state.selection === null) return 0;
              const row = state.doc.rows[state.selection];
              if (!row?.section_title) return 0;
              const layout =
                row.section_title_layout ??
                state.doc.section_title_layout_default ??
                'letterbox';
              if (layout !== 'letterbox') return 0;
              return state.doc.thumbnail?.stripeHeightFraction ?? 0.13;
            })()}
            onChange={(next) => {
              // Live updates during a drag: TRANSIENT patch — local
              // state moves so the Player follows the cursor, but
              // isDirty stays as-is (no autosave storm) and no undo
              // entry is created (no 60-undos-per-second). The single
              // non-transient commit fires on pointerup below.
              const idx = state.selection as number;
              apply({
                type: 'PATCH_ROW',
                rowIndex: idx,
                patch: {
                  image_x_pct: next.xPct,
                  image_y_pct: next.yPct,
                  image_scale_pct: next.scalePct,
                  image_rotation_deg: next.rotationDeg,
                },
                transient: true,
              });
            }}
            onCommit={(next) => {
              // Final commit on pointerup: clean identity values back
              // to undefined so the row JSON stays free of redundant
              // per-row overrides that match the default behavior.
              // Non-transient: marks dirty, single undo entry, single
              // autosave fires.
              const idx = state.selection as number;
              apply({
                type: 'PATCH_ROW',
                rowIndex: idx,
                patch: {
                  image_x_pct: next.xPct === 0 ? undefined : next.xPct,
                  image_y_pct: next.yPct === 0 ? undefined : next.yPct,
                  image_scale_pct:
                    next.scalePct === 100 ? undefined : next.scalePct,
                  image_rotation_deg:
                    next.rotationDeg === 0 ? undefined : next.rotationDeg,
                },
              });
              console.info('[editor transform commit] overlay', { next });
            }}
          />
        )}
      </div>
      {/* Narration strip — Phase 2 of
          `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
          Shows the active caption segment as the playhead moves so
          the user always sees what's being said. Hidden entirely
          when captions don't exist OR the user disabled the strip
          in settings. Click on the line seeks to the active
          segment's start (the strip's own NavigateBack convenience).
          Mounted between the preview canvas and the TransportBar so
          it sits in the natural visual flow without crowding either. */}
      {getShowNarrationStrip() && (
        <NarrationStrip
          captions={narrationCaptions}
          playheadMs={state.playheadMs}
          onSeek={seekFromUser}
          fontSize={getNarrationFontSize()}
        />
      )}
      <TransportBar
        playerRef={playerRef}
        playheadMs={state.playheadMs}
        totalDurationMs={totalDurationMs}
        shotStartTimesMs={shotStartTimesMs}
        onSeek={seekFromUser}
        fps={videoConfig.fps}
        playbackRate={playbackRate}
        onPlaybackRateChange={setPlaybackRate}
      />
    </>
  );

  // Phase 4 — tabbed inspector. The Shot tab hosts the existing
  // ShotInspector body; the Audio / Captions tabs land here for
  // the first time. The active tab auto-switches based on
  // `inspectorSelectionKind`: a shot tile selection → 'shot', a
  // timeline audio-lane click → 'audio', a caption pill / lane
  // click → 'captions'. Manual tab clicks override the auto-switch
  // until the next selection lands. The 'overlays' lane focus
  // doesn't have a dedicated tab yet — it folds into 'shot' (which
  // hosts the overlay editor on the selected row); clicking the
  // overlays lane background simply leaves the current tab as-is.
  const inspectorSelectionKind: InspectorTabId | null = (() => {
    if (state.selection !== null) return 'shot';
    if (laneFocus === 'audio') return 'audio';
    if (laneFocus === 'captions') return 'captions';
    return null;
  })();

  const inspectorSlot = (
    <EditorInspector
      selectionKind={inspectorSelectionKind}
      switchToTab={historySwitchIntent}
      kebabContent={
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--fg-muted)' }}>
            Project settings
          </div>
          <button
            type="button"
            onClick={() =>
              apply({ type: 'SET_FLAGS', flags: { animateScenes: !state.flags.animateScenes } })
            }
            className="editor-btn w-full justify-between"
            title={
              state.flags.animateScenes
                ? 'Animations on — toggle to render every shot as a still'
                : 'Animations off — toggle to play B-roll clips'
            }
          >
            <span>Animate scenes</span>
            <span style={{ color: state.flags.animateScenes ? 'var(--editor-accent)' : 'var(--fg-muted)' }}>
              {state.flags.animateScenes ? 'On' : 'Off'}
            </span>
          </button>
          <button
            type="button"
            onClick={() =>
              apply({
                type: 'SET_FLAGS',
                flags: { suppressLowerThirds: !state.flags.suppressLowerThirds },
              })
            }
            className="editor-btn w-full justify-between"
          >
            <span>Lower-thirds</span>
            <span style={{ color: !state.flags.suppressLowerThirds ? 'var(--editor-accent)' : 'var(--fg-muted)' }}>
              {state.flags.suppressLowerThirds ? 'Hidden' : 'Visible'}
            </span>
          </button>
          {/* Doc-level fade toggle. Mirrors prod-doc's switch
              (production-doc/page.tsx:7231-7273). `false` forces hard
              cuts everywhere AND disables the opening fade-in on the
              first shot + closing fade-out on the last. Per-row Cut /
              Fade radios in the Shot tab override individual rows. */}
          <button
            type="button"
            onClick={() => {
              const fadeOn = state.doc.scene_fade_enabled !== false;
              const next = !fadeOn;
              console.info('[editor doc-settings scene-fade] toggled', {
                from: state.doc.scene_fade_enabled,
                to: next,
              });
              apply({ type: 'PATCH_DOC', patch: { scene_fade_enabled: next } });
            }}
            className="editor-btn w-full justify-between"
            title={
              state.doc.scene_fade_enabled !== false
                ? 'Scene fade is on. Click to switch every shot to a hard cut.'
                : 'Hard cuts are on. Click to restore the cross-fade between shots.'
            }
          >
            <span>Scene fade between shots</span>
            <span
              style={{
                color:
                  state.doc.scene_fade_enabled !== false
                    ? 'var(--editor-accent)'
                    : 'var(--fg-muted)',
              }}
            >
              {state.doc.scene_fade_enabled !== false ? 'On' : 'Off'}
            </span>
          </button>

          {/* Doc-level defaults (Batch 2). Each control sets the
              doc-wide fallback that per-row values inherit. Mirrors
              the prod-doc "apply to all" actions but without the
              clear-overrides toast — the editor's PATCH_DOC writes
              only the default field, leaving per-row overrides
              intact (same behaviour as prod-doc's `applyXxxToAll`
              functions when no per-row sweeps are involved). */}
          <div
            className="pt-1.5 mt-1 text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--fg-muted)', borderTop: '1px solid var(--editor-edge)' }}
          >
            Doc defaults
          </div>
          {/* Section-title layout default — overlay (stripe sits on
              top of the full-frame scene) vs letterbox (stripe steals
              vertical space, scene shrinks to fit). */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: 'var(--fg)' }}>
              Section title
            </span>
            <div className="flex gap-1">
              {(['overlay', 'letterbox'] as const).map((opt) => {
                const active =
                  (state.doc.section_title_layout_default ?? 'letterbox') === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      console.info('[editor doc-settings section-title-layout] changed', {
                        from: state.doc.section_title_layout_default,
                        to: opt,
                      });
                      apply({
                        type: 'PATCH_DOC',
                        patch: { section_title_layout_default: opt },
                      });
                    }}
                    className="text-[10px] px-2 py-0.5 rounded border"
                    style={{
                      borderColor: active ? 'var(--editor-accent)' : 'var(--card-border)',
                      color: active ? 'var(--editor-accent)' : 'var(--fg)',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
          {/* On-screen-text mode default — overlay (Remotion mounts a
              LowerThird), bake (text already burned into the image
              pixels by the generator), none (suppress entirely). */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: 'var(--fg)' }}>
              On-screen text
            </span>
            <div className="flex gap-1">
              {(['overlay', 'bake', 'none'] as const).map((opt) => {
                const active =
                  (state.doc.on_screen_text_mode_default ?? 'bake') === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      console.info('[editor doc-settings ost-mode] changed', {
                        from: state.doc.on_screen_text_mode_default,
                        to: opt,
                      });
                      apply({
                        type: 'PATCH_DOC',
                        patch: { on_screen_text_mode_default: opt },
                      });
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded border"
                    style={{
                      borderColor: active ? 'var(--editor-accent)' : 'var(--card-border)',
                      color: active ? 'var(--editor-accent)' : 'var(--fg)',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
          {/* PR 3 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`:
              Cost-gated "Switch OST to overlay + regen" action. Surfaces
              the count + cost of baked-text rows before any image-gen
              spend, then flips the mode AND auto-queues fill-blanks so
              the regen runs without the user manually clicking each shot. */}
          <button
            type="button"
            onClick={() => setFlipOstModalOpen(true)}
            className="editor-btn w-full justify-between"
            title="Flip the doc to overlay-mode and regenerate every shot that currently has the lower-third text baked into the image pixels"
          >
            <span>Switch OST → overlay (regen)</span>
            <span style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}>↻</span>
          </button>

          {/* Bulk-generate actions — three separate cost-gated buttons.
              User-asked-for 2026-06-02:
                "Generate All Base images" — variant-index 0 / no variant
                "Generate all Variations" — variant-index > 0
                "Generate all motion collages" — shot_kind=motion_collage
              Each opens a BulkGenerateModal with the filtered row list
              + cost preview. Run dispatches through runFillBlanks (or
              the motion-collage manual path) so progress shows in the
              existing Live tab + bottom-bar fill-blanks indicator. */}
          <div
            className="pt-1.5 mt-1 text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--fg-muted)', borderTop: '1px solid var(--editor-edge)' }}
          >
            Bulk generate
          </div>
          <button
            type="button"
            onClick={() => setBulkGenerateModal('base')}
            className="editor-btn w-full justify-between"
            title="Generate every base image (variant 0 / no variant) that's still blank. Cost-gated; modal shows count + estimate before commit."
          >
            <span>Generate all Base images</span>
            <span style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}>↯</span>
          </button>
          <button
            type="button"
            onClick={() => setBulkGenerateModal('variants')}
            className="editor-btn w-full justify-between"
            title="Generate every variant image (variant index > 0) that's still blank, anchored on its base. Cost-gated."
          >
            <span>Generate all Variations</span>
            <span style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}>↯</span>
          </button>
          <button
            type="button"
            onClick={() => setBulkGenerateModal('collages')}
            className="editor-btn w-full justify-between"
            title="Generate every motion-collage row whose panels haven't been rendered yet. Cost-gated; each collage spends ~$0.05 across N panels."
          >
            <span>Generate all motion collages</span>
            <span style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}>↯</span>
          </button>
          <button
            type="button"
            onClick={() => setBulkGenerateModal('collages-regen')}
            className="editor-btn w-full justify-between"
            title="Regenerate EVERY motion-collage row, including ones that already have panels. Destructive — overwrites existing panel URLs. Useful after a pipeline change (e.g. framing-lock prompt) to re-fix all collages in one shot. Cost-gated."
          >
            <span>Regenerate all motion collages</span>
            <span style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}>↻</span>
          </button>
          {/* Pillarbox color default — used when a row's scene_zoom is
              under 100% and bars sit on either side of the scene. */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: 'var(--fg)' }}>
              Pillarbox color
            </span>
            <input
              type="color"
              value={state.doc.pillarbox_color_default ?? '#ffffff'}
              onChange={(e) => {
                const next = e.target.value;
                console.info('[editor doc-settings pillarbox-color] changed', {
                  from: state.doc.pillarbox_color_default,
                  to: next,
                });
                apply({
                  type: 'PATCH_DOC',
                  patch: { pillarbox_color_default: next },
                });
              }}
              className="w-9 h-6 rounded cursor-pointer"
              style={{ border: '1px solid var(--card-border)' }}
              title="Doc-default pillarbox bar color (used when scene_zoom < 100%)"
            />
          </div>
          {/* Scene zoom default — 50-200% slider that controls how the
              scene's frame is scaled inside the 16:9 canvas. */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: 'var(--fg)' }}>
              Scene zoom
            </span>
            <input
              type="range"
              min={50}
              max={200}
              step={5}
              value={state.doc.scene_zoom_default ?? 100}
              onChange={(e) => {
                const next = Number(e.target.value);
                console.info('[editor doc-settings scene-zoom] changed', {
                  from: state.doc.scene_zoom_default,
                  to: next,
                });
                apply({
                  type: 'PATCH_DOC',
                  patch: { scene_zoom_default: next },
                });
              }}
              className="flex-1"
              style={{ accentColor: 'var(--editor-accent, #a78bfa)' }}
              aria-label={`Scene zoom default (${state.doc.scene_zoom_default ?? 100}%)`}
            />
            <span
              className="text-[10px] tabular-nums w-9 text-right"
              style={{ color: 'var(--fg-muted)' }}
            >
              {state.doc.scene_zoom_default ?? 100}%
            </span>
          </div>
          {/* Animation model for all shots (Batch 3.1). Doc-level i2v
              model that every B-roll cell uses by default. Mirrors the
              prod-doc bulk picker (page.tsx:7281-7317). Tier priority:
              row-level lock > doc-level > user-level default. Empty
              value falls back to the user's global default. Only the
              image-to-video models surface (t2v has no still input);
              local models hidden unless LOCAL_STUDIO is enabled. */}
          <div className="space-y-1">
            <div
              className="text-[11px]"
              style={{ color: 'var(--fg)' }}
              title="Used as the default animation model for every shot's B-roll. Pick a single row's picker to override one shot."
            >
              Animation model
            </div>
            <select
              value={state.doc.broll_model_id ?? ''}
              onChange={(e) => {
                const next = e.target.value || undefined;
                console.info('[editor doc-settings broll-model] changed', {
                  from: state.doc.broll_model_id,
                  to: next,
                });
                apply({
                  type: 'PATCH_DOC',
                  patch: { broll_model_id: next },
                });
              }}
              className="w-full text-xs rounded border px-2 py-1.5"
              style={{
                borderColor: 'var(--card-border)',
                background: 'var(--bg)',
                color: 'var(--fg)',
              }}
              aria-label="Animation model for every B-roll cell on this doc"
            >
              <option value="">— Use my default —</option>
              {BROLL_MODELS.filter((m) => m.kind === 'image-to-video')
                .filter((m) => localStudioEnabled || m.provider !== 'comfyui-local')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.priceUsdLabel}
                  </option>
                ))}
            </select>
          </div>
          {/* Image model — doc-level default for the per-shot
              Regenerate button in the inspector. Tier priority:
              row.image_model > doc.image_model_default > server-side
              DEFAULT_IMAGE_MODEL. The production-doc page stamps this
              field when it generates a fresh doc so the editor opens
              with the user's gen-time choice already populated. */}
          <div className="space-y-1">
            <div
              className="text-[11px]"
              style={{ color: 'var(--fg)' }}
              title="Used as the default image model when you click Regenerate on a shot. Each shot's inspector can override this."
            >
              Image model
            </div>
            <select
              value={state.doc.image_model_default ?? ''}
              onChange={(e) => {
                const next = e.target.value || undefined;
                console.info('[editor doc-settings image-model] changed', {
                  from: state.doc.image_model_default,
                  to: next,
                });
                apply({
                  type: 'PATCH_DOC',
                  patch: { image_model_default: next },
                });
              }}
              className="w-full text-xs rounded border px-2 py-1.5"
              style={{
                borderColor: 'var(--card-border)',
                background: 'var(--bg)',
                color: 'var(--fg)',
              }}
              aria-label="Default image model for every shot on this doc"
            >
              <option value="">
                — Default ({getImageModelSpec(DEFAULT_IMAGE_MODEL)?.label ?? DEFAULT_IMAGE_MODEL}) —
              </option>
              {IMAGE_MODELS.filter((m) => localStudioEnabled || m.provider !== 'comfyui-local').map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                  {m.hint ? ` — ${m.hint}` : ''}
                </option>
              ))}
            </select>
          </div>
          {/* Collage batch mode — when on, "Fill blank shots" below
              groups sequential blanks in chunks of 4 and asks the
              chosen image model to produce one 2×2 collage per group
              (cropped server-side into 4 per-shot images). ~75%
              cheaper than 4 single-shot calls. Per-shot Regenerate
              in the inspector stays single-shot regardless. Mirrors
              the production-doc page's toggle. v1 limits: no per-cell
              OST baking, no style-ref i2i. */}
          <div className="space-y-1">
            <label
              className="flex items-start gap-2 text-[11px] cursor-pointer"
              style={{ color: 'var(--fg)' }}
              title='When on, "Fill blank shots" batches groups of 4 into a single 2×2 collage call (+ 1 upscale), ~75% cheaper than 4 single calls. Per-chunk fallback to single shots on collage failure. Limitations: no per-cell on-screen-text baking.'
            >
              <input
                type="checkbox"
                checked={state.doc.collage_mode === true}
                onChange={(e) => {
                  const next = e.target.checked;
                  console.info('[editor doc-settings collage-mode] changed', {
                    from: state.doc.collage_mode === true,
                    to: next,
                  });
                  apply({
                    type: 'PATCH_DOC',
                    patch: { collage_mode: next ? true : undefined },
                  });
                }}
                className="mt-0.5"
              />
              <span>
                Collage mode for Fill blanks
                <span className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {state.doc.collage_mode === true
                    ? 'on: groups of 4 batch into one 2×2 call (~75% cheaper)'
                    : 'off: one call per shot'}
                </span>
              </span>
            </label>
          </div>
          {/* Fill blank shots — kicks off a throttled (3-at-a-time)
              batch image generation for every shot that currently has
              no image. Uses the doc-level Image model picked above
              (per-shot overrides win on shots that have one). When
              the Collage toggle above is on, groups of 4 batch into
              a single 2×2 collage call instead of 4 single calls.
              While running, the button collapses into a progress
              label + Stop pill. */}
          {fillState === 'running' ? (
            <div
              className="flex items-center gap-2 w-full text-xs px-2 py-1.5 rounded border"
              style={{
                borderColor: 'var(--card-border)',
                background: 'var(--bg)',
                color: 'var(--fg)',
              }}
            >
              <Loader2 size={14} strokeWidth={2} className="animate-spin shrink-0" />
              <span className="flex-1 tabular-nums">
                Filling {fillProgress.done}/{fillProgress.total}
                {fillProgress.failed > 0 ? ` · ${fillProgress.failed} failed` : ''}
              </span>
              <button
                type="button"
                onClick={() => {
                  console.info('[editor fill-blanks] stop clicked', {
                    done: fillProgress.done,
                    failed: fillProgress.failed,
                  });
                  fillAbortRef.current?.abort();
                }}
                className="text-xs px-2 py-0.5 rounded border transition-colors hover:bg-white/5"
                style={{ borderColor: '#f87171', color: '#f87171' }}
                title="Stop the batch. Already-generated shots are kept."
              >
                Stop
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { void runFillBlanks(); }}
              disabled={blankShotIndices.length === 0}
              className="editor-btn w-full justify-between disabled:opacity-40"
              title={
                blankShotIndices.length === 0
                  ? 'Every shot already has an image.'
                  : `Generate images for ${blankShotIndices.length} blank shot${blankShotIndices.length === 1 ? '' : 's'} (3 at a time).`
              }
            >
              <span>
                {blankShotIndices.length === 0
                  ? 'All shots have images'
                  : `Fill ${blankShotIndices.length} blank shot${blankShotIndices.length === 1 ? '' : 's'}`}
              </span>
              <Sparkles size={14} strokeWidth={2} style={{ color: 'var(--fg-muted)' }} />
            </button>
          )}

          {/* Force-sync all images to the server. Escape-hatch for the
              "afraid to refresh because the toast said some images
              weren't saved" situation. Walks every shot with a current
              imageUrl and re-posts to row-asset (which has its own
              3-retry loop). Shows ONE summary toast at the end. */}
          {syncState.kind === 'running' ? (
            <div
              className="flex items-center gap-2 w-full text-xs px-2 py-1.5 rounded border"
              style={{
                borderColor: 'var(--card-border)',
                background: 'var(--bg)',
                color: 'var(--fg)',
              }}
            >
              <Loader2 size={14} strokeWidth={2} className="animate-spin shrink-0" />
              <span className="flex-1 tabular-nums">
                Syncing {syncState.done}/{syncState.total}
                {syncState.failed > 0 ? ` · ${syncState.failed} failed` : ''}
              </span>
              <button
                type="button"
                onClick={stopForceSync}
                className="text-xs px-2 py-0.5 rounded border transition-colors hover:bg-white/5"
                style={{ borderColor: '#f87171', color: '#f87171' }}
                title="Cancel the sync. Already-synced shots are kept."
              >
                Stop
              </button>
            </div>
          ) : (() => {
            const count = Object.values(state.rowImages).filter(
              (v) => typeof v === 'string' && /^https?:/.test(v),
            ).length;
            return (
              <button
                type="button"
                onClick={() => { void runForceSyncImages(); }}
                disabled={count === 0}
                className="editor-btn w-full justify-between disabled:opacity-40"
                title={
                  count === 0
                    ? 'No images in browser state to sync.'
                    : `Force-save all ${count} current image${count === 1 ? '' : 's'} to the server. Use after a "Shot N image not saved" toast — verifies every shot is persisted before refresh.`
                }
              >
                <span>Sync {count} image{count === 1 ? '' : 's'} to server</span>
                <span style={{ color: 'var(--fg-muted)', fontSize: '10px' }}>safe-refresh</span>
              </button>
            );
          })()}

          <button
            type="button"
            onClick={() => setShowBrandKit(true)}
            className="editor-btn w-full justify-between"
            title="Edit per-doc fonts, colors, logo, channel name"
          >
            <span>Brand kit…</span>
            <span style={{ color: state.visualKitOverride ? 'var(--editor-accent)' : 'var(--fg-muted)' }}>
              {state.visualKitOverride ? 'Override' : 'Default'}
            </span>
          </button>

          {/* Smart auto-fix doc-level action. Scans every row, finds
              the ones the renderer would auto-shift (overlay title +
              busy top saliency) AND that the user hasn't already
              overridden, and writes the recommended Y value to each.
              Disabled when no row qualifies (button label shows the
              count). Confirmation gate prevents accidental clicks. */}
          {(() => {
            const candidates = state.doc.rows
              .map((r, i) => {
                if (typeof r.image_y_pct === 'number') return null;
                const hasVisual = Boolean(
                  state.rowImages[i] ||
                    state.rowVideoClips[i]?.videoUrl ||
                    r.video_url_override,
                );
                const auto = computeAutoShiftYPct(r, state.doc, hasVisual);
                return auto ? { i, yPct: auto.yPct } : null;
              })
              .filter((c): c is { i: number; yPct: number } => c !== null);
            return (
              <button
                type="button"
                disabled={candidates.length === 0}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Apply smart auto-fix to ${candidates.length} shot${candidates.length === 1 ? '' : 's'}? The renderer is already shifting these at render time; this writes the value explicitly so you can see + tweak each one.`,
                    )
                  )
                    return;
                  console.info('[editor doc auto-fix] apply-to-all', {
                    count: candidates.length,
                    rows: candidates.map((c) => c.i),
                  });
                  candidates.forEach((c) => {
                    apply({
                      type: 'PATCH_ROW',
                      rowIndex: c.i,
                      patch: { image_y_pct: c.yPct },
                    });
                  });
                }}
                className="editor-btn w-full justify-between disabled:opacity-40"
                title={
                  candidates.length === 0
                    ? 'No rows currently qualify (overlay-mode title + busy top saliency).'
                    : `Make the renderer's auto-shift explicit on ${candidates.length} row${candidates.length === 1 ? '' : 's'}.`
                }
              >
                <span>✨ Apply auto-fix to all</span>
                <span
                  style={{
                    color:
                      candidates.length > 0
                        ? 'var(--editor-accent)'
                        : 'var(--fg-muted)',
                  }}
                >
                  {candidates.length} row{candidates.length === 1 ? '' : 's'}
                </span>
              </button>
            );
          })()}
          <p className="text-[10px] pt-1" style={{ color: 'var(--fg-muted)' }}>
            More project settings live in the left rail’s Settings tab.
          </p>
        </div>
      }
      slots={{
        shot:
          state.selection !== null && state.doc.rows[state.selection] ? (
            <ShotInspector
              shotIndex={state.selection}
              shot={videoConfig.shots[state.selection]}
              row={state.doc.rows[state.selection]}
              doc={state.doc}
              thumbnailUrl={state.rowImages[state.selection] ?? null}
              totalShots={state.doc.rows.length}
              projectId={projectId}
              // v2 (2026-05-22) — pass the doc's active style preset
              // through so the inspector's regenerate button can route
              // ref-bearing generations through the v2 i2i dispatcher
              // (NanoBanana Pro cloud or Qwen-Image local). Undefined on
              // legacy docs → regen falls back to plain T2I unchanged.
              stylePreset={state.doc.style_preset}
              // PR 4 of motion-collage plan: lets the Convert-to-motion-
              // collage button fire on saved styles derived from doodle
              // (UUID style_preset), not just the literal slug.
              effectiveStyleSlug={effectiveStyleSlug ?? undefined}
              // Resolved i2i model for cost-preview rendering near the
              // Regenerate button. Null when the active style is a
              // built-in, has no preferred model, or the fetch failed.
              activeStyleI2IModel={activeStyleI2IModel}
              // Per-shot regenerate state lifted to EditorClient so it
              // doesn't bleed across shots when the inspector re-renders
              // with a different shotIndex. See the regenerateShot block
              // above for the contract. Default to idle for shots that
              // haven't been regenerated this session.
              regenState={regenStates[state.selection] ?? { kind: 'idle' }}
              onRegenerateShot={() => {
                void regenerateShot(state.selection as number);
              }}
              onStopRegenerateShot={() => {
                stopRegenerateShot(state.selection as number);
              }}
              // Mirrors the production-doc page's `applyTitleCardAsSectionTitle`
              // affordance, but works from any shot's manually-edited
              // Section title field. Count = rows after `selection` up
              // to (not including) the next Title Card row, or end of
              // doc. Click stamps the current shot's section_title onto
              // every row in that range in a single PATCH_DOC.
              {...(() => {
                const sel = state.selection as number;
                let endIndex = state.doc.rows.length - 1;
                for (let i = sel + 1; i < state.doc.rows.length; i++) {
                  if (state.doc.rows[i]!.visual_type === 'Title Card') {
                    endIndex = i - 1;
                    break;
                  }
                }
                const count = Math.max(0, endIndex - sel);
                return {
                  applyTitleForwardCount: count,
                  onApplyTitleForward: () => {
                    if (count <= 0) return;
                    const text = state.doc.rows[sel]?.section_title?.trim() ?? '';
                    const next = text.length > 0 ? text : undefined;
                    console.info('[editor section-title forward]', {
                      from: sel,
                      to: endIndex,
                      count,
                      text: next ?? '(clearing)',
                    });
                    const patchedRows = state.doc.rows.map((r, i) =>
                      i > sel && i <= endIndex ? { ...r, section_title: next } : r,
                    );
                    apply({
                      type: 'PATCH_DOC',
                      patch: { rows: patchedRows },
                    });
                    toast.success(
                      next
                        ? `Applied "${next}" as section title to ${count} shot${count === 1 ? '' : 's'}.`
                        : `Cleared section title from ${count} shot${count === 1 ? '' : 's'}.`,
                    );
                  },
                };
              })()}
              onClose={() => apply({ type: 'SET_SELECTION', shotIndex: null })}
              onUploadImage={(url) =>
                commitRowImage(state.selection as number, url)
              }
              onPickProjectClip={(url, durationSeconds) =>
                apply({
                  type: 'SET_ROW_VIDEO',
                  shotIndex: state.selection as number,
                  url,
                  durationSeconds,
                })
              }
              onGenerateClip={() => {
                void handleGenerateClip(state.selection as number);
              }}
              clipStatus={state.rowVideoClips[state.selection]?.status}
              clipError={state.rowVideoClips[state.selection]?.errorMessage}
              onCancelClip={() => {
                const idx = state.selection as number;
                console.info('[editor broll] cancel clicked', { rowIndex: idx });
                // Clear the row's clip slot locally. The poll loop in
                // EditorClient watches rowVideoClips for `generating`
                // entries; clearing this one removes it from the poll
                // set so we stop hitting /api/broll/{id}. The server-
                // side job may still complete and be billed; this just
                // detaches the editor from waiting on it.
                setRowVideoClip(idx, null, true);
              }}
              brollModelId={userBrollModelId}
              docBrollModelId={state.doc.broll_model_id}
              docImageModelDefault={state.doc.image_model_default}
              onUpdateScript={(text) =>
                apply({
                  type: 'SET_ROW_SCRIPT',
                  shotIndex: state.selection as number,
                  text,
                })
              }
              onUpdateRow={(patch) => updateRow(state.selection as number, patch)}
              overlayState={state.rowOverlays[state.selection]}
              isRethinkingOverlay={rethinkingRows.has(state.selection)}
              rethinkExhausted={(rethinkAttempts[state.selection] ?? 0) >= RETHINK_MAX_ATTEMPTS}
              editHistoryDepth={
                state.doc.rows[state.selection]?.overlay_edit_history?.length ?? 0
              }
              onOpenOverlayPosition={() => setOverlayPositionRow(state.selection)}
              onOpenOverlayEdit={() => setOverlayEditRow(state.selection)}
              onRethinkOverlay={() => {
                void rethinkOverlayPlacement(state.selection as number);
              }}
              onUndoOverlayEdit={() => undoOverlayEdit(state.selection as number)}
              onShowOverlayContextMenu={(x, y) =>
                setOverlayContextMenu({ rowIndex: state.selection as number, x, y })
              }
              docThumbnail={state.doc.thumbnail}
              onOpenSectionThumbnail={() => setShowSectionThumbnail(true)}
              docSectionTitleLayoutDefault={state.doc.section_title_layout_default}
              docPillarboxColorDefault={state.doc.pillarbox_color_default}
              docSceneZoomDefault={state.doc.scene_zoom_default}
              docSceneFadeDefault={state.doc.scene_fade_enabled}
              docRegionZoomPaddingDefaultPct={state.doc.region_zoom_padding_default_pct}
              docOnScreenTextModeDefault={state.doc.on_screen_text_mode_default}
              onApplyTransformToAll={(transform) => {
                // Bulk-apply the transform to every shot in the doc.
                // We iterate row-by-row so PATCH_ROW handles each
                // row's undo entry cleanly. A single PATCH_DOC with a
                // rows replacement would land as one undo step but
                // would also require us to rebuild the rows array
                // verbatim, which is harder to reason about.
                state.doc.rows.forEach((_, i) => {
                  apply({
                    type: 'PATCH_ROW',
                    rowIndex: i,
                    patch: transform,
                  });
                });
              }}
              // Layout bulks — `_plans/2026-05-25-editor-bulk-apply-actions.md`.
              // "Apply to all" sets the doc-level default so future
              // rows inherit it; per-row overrides stay until the user
              // hits "Clear overrides", which walks the rows array
              // dispatching one PATCH_ROW per shot (mirrors the
              // onApplyTransformToAll pattern — N undo entries, same
              // documented limitation).
              onApplySectionTitleLayoutToAll={(layout) => {
                apply({
                  type: 'PATCH_DOC',
                  patch: { section_title_layout_default: layout },
                });
              }}
              onClearSectionTitleLayoutOverrides={() => {
                state.doc.rows.forEach((_, i) => {
                  apply({
                    type: 'PATCH_ROW',
                    rowIndex: i,
                    patch: { section_title_layout: undefined },
                  });
                });
              }}
              onApplyPillarboxColorToAll={(color) => {
                apply({
                  type: 'PATCH_DOC',
                  patch: { pillarbox_color_default: color },
                });
              }}
              onClearPillarboxColorOverrides={() => {
                state.doc.rows.forEach((_, i) => {
                  apply({
                    type: 'PATCH_ROW',
                    rowIndex: i,
                    patch: { pillarbox_color: undefined },
                  });
                });
              }}
              onApplySceneZoomToAll={(zoom) => {
                apply({
                  type: 'PATCH_DOC',
                  patch: { scene_zoom_default: zoom },
                });
              }}
              onClearSceneZoomOverrides={() => {
                state.doc.rows.forEach((_, i) => {
                  apply({
                    type: 'PATCH_ROW',
                    rowIndex: i,
                    patch: { scene_zoom: undefined },
                  });
                });
              }}
              onApplySceneFadeToAll={(sceneFade) => {
                apply({
                  type: 'PATCH_DOC',
                  patch: { scene_fade_enabled: sceneFade },
                });
              }}
              onClearSceneFadeOverrides={() => {
                state.doc.rows.forEach((_, i) => {
                  apply({
                    type: 'PATCH_ROW',
                    rowIndex: i,
                    patch: { scene_fade: undefined },
                  });
                });
              }}
              onApplyOstModeToAll={(mode) => {
                apply({
                  type: 'PATCH_DOC',
                  patch: { on_screen_text_mode_default: mode },
                });
              }}
              onClearOstModeOverrides={() => {
                state.doc.rows.forEach((_, i) => {
                  apply({
                    type: 'PATCH_ROW',
                    rowIndex: i,
                    patch: { on_screen_text_mode: undefined },
                  });
                });
              }}
              onOpenImageEdit={() => setImageEditRow(state.selection)}
              onRunRmbg={() => {
                if (state.selection !== null) void handleRunRmbg(state.selection);
              }}
              onRestoreOriginalBackground={() => {
                if (state.selection !== null)
                  handleRestoreOriginalBackground(state.selection);
              }}
              rmbgInflight={
                state.selection !== null && rmbgInflight.has(state.selection)
              }
              rmbgApplied={
                state.selection !== null &&
                state.doc.rows[state.selection]?.image_rmbg_applied === true
              }
              hasRmbgCutout={
                state.selection !== null &&
                typeof state.doc.rows[state.selection]?.image_rmbg_url === 'string'
              }
              // Variants + title-card + per-row notes (see
              // `_plans/2026-05-27-editor-variants-titles-notes.md`).
              // Threading the full image map for the variant mini-strip;
              // every other prop is a per-selection writer that delegates
              // to the reducer commands defined in src/lib/editor/store.ts.
              rowImagesMap={state.rowImages}
              variantGenState={
                variantGenStates[state.selection] ?? { kind: 'idle' }
              }
              onAddVariantRow={() => addVariantRow(state.selection as number)}
              onDeleteVariantRow={() => deleteVariantRow(state.selection as number)}
              onMoveVariantRow={(direction) =>
                moveVariantRow(state.selection as number, direction)
              }
              onSelectRowIndex={(idx) =>
                apply({ type: 'SET_SELECTION', shotIndex: idx })
              }
              onGenerateVariant={() => {
                void generateVariantImage(state.selection as number);
              }}
              onSetRowVisualType={(visualType, options) =>
                setRowVisualType(state.selection as number, visualType, options)
              }
              onSplitAsTitleCard={(heading) =>
                splitAsTitleCard(state.selection as number, heading)
              }
              onApplyTitleCardAsSectionTitle={() =>
                applyTitleCardAsSectionTitle(state.selection as number)
              }
              onCommitNotes={(notes) =>
                updateRow(state.selection as number, { notes })
              }
              canSplit={
                splitTarget?.shotIndex === state.selection &&
                splitTarget?.validSplit === true
              }
              splitOffsetMs={
                splitTarget?.shotIndex === state.selection
                  ? splitTarget.splitAtMs
                  : undefined
              }
              onSplit={handleSplit}
            />
          ) : undefined,
        audio: (
          <InspectorAudioTab
            voiceoverUrl={state.voiceoverUrl}
            voiceoverAlignment={state.voiceoverAlignment}
            musicUrl={state.musicUrl}
            onRegenVO={() => setShowVoRegen(true)}
            onPickVoiceover={(url, source) => {
              console.info('[editor voiceover] picker change', { source, url: url || '(cleared)' });
              apply({ type: 'SET_VOICEOVER_URL', url: url || null });
            }}
            linkedProjectId={state.linkedProjectId}
            linkedScheduleItemId={state.linkedScheduleItemId}
            titleCandidates={[
              payload.title || state.doc.title,
              state.doc.title,
            ]}
            voiceoverMuted={state.doc.voiceover_muted === true}
            voiceoverVolumeDb={state.doc.voiceover_volume_db ?? 0}
            voiceoverFadeInMs={state.doc.voiceover_fade_in_ms ?? 0}
            voiceoverFadeOutMs={state.doc.voiceover_fade_out_ms ?? 0}
            onPatchAudio={(patch) => {
              console.info('[editor audio-mix] patch', { patch });
              apply({ type: 'PATCH_DOC', patch });
            }}
          />
        ),
        captions: (
          <InspectorCaptionsTab
            captions={state.captions}
            playheadMs={state.playheadMs}
            onSeek={seekFromUser}
            onRegen={() => { void handleRegenerateCaptions(); }}
            regenDisabled={regenCaptionsRunning || !state.voiceoverUrl}
            regenLabel={regenCaptionsLabel}
          />
        ),
        history: (
          <GenerationHistoryPanel
            projectId={projectId}
            rows={state.doc.rows}
            refreshTick={historyRefreshTick}
            onJumpToScene={(rowIndex) =>
              selectShotFromUser(rowIndex, 'history-panel')
            }
          />
        ),
        live: (
          <InspectorLivePanel
            doc={state.doc}
            rowImages={(() => {
              // Convert the sparse rowImages map into the positional
              // array RowImageState[] InspectorLivePanel expects.
              // Cheap O(rows) — recomputed only when state.rowImages
              // or rows change (React's prop diffing).
              return state.doc.rows.map((_, i) => {
                const url = state.rowImages[i];
                return url ? { status: 'done', imageUrl: url } : null;
              });
            })()}
            clipStatuses={state.doc.rows.reduce<Record<number, string | undefined>>((acc, _, i) => {
              acc[i] = state.rowVideoClips[i]?.status;
              return acc;
            }, {})}
            overlayStatuses={state.doc.rows.reduce<Record<number, string | undefined>>((acc, _, i) => {
              acc[i] = state.rowOverlays[i]?.status;
              return acc;
            }, {})}
            fillState={fillState}
            fillProgress={fillProgress}
            onStopFill={() => {
              console.info('[editor live-tab] stop fill-blanks pressed', {
                done: fillProgress.done,
                total: fillProgress.total,
              });
              fillAbortRef.current?.abort();
            }}
            onJumpToShot={(rowIndex) => selectShotFromUser(rowIndex, 'live-tab')}
            onRetryShot={(rowIndex) => {
              console.info('[editor live-tab] retry shot via fill-blanks single', {
                rowIndex,
              });
              // Clear the row's image (so fill-blanks sees it as a
              // blank) then kick off fill-blanks. Bulk worker is the
              // existing single-shot regenerator that already knows
              // how to dispatch one row. Future: wire a dedicated
              // per-row regen path so it doesn't blanket the whole
              // doc.
              apply({ type: 'SET_ROW_IMAGE', shotIndex: rowIndex, url: null });
              setTimeout(() => { void runFillBlanks(); }, 50);
            }}
          />
        ),
      }}
    />
  );

  // Phase 5 timeline — multi-lane shell with video / audio / captions
  // / overlays tracks sharing one playhead. The video lane reuses the
  // existing Timeline component verbatim so the tile drag-resize /
  // drag-reorder / trim behaviour comes along untouched.
  const timelineSlot = (
    <TimelineV2
      config={videoConfig}
      doc={state.doc}
      rowImages={getShowThumbnails() ? state.rowImages : {}}
      rowStartTimesMs={shotStartTimesMs}
      rowOverlays={state.rowOverlays}
      captions={state.captions}
      voiceoverUrl={state.voiceoverUrl}
      selection={state.selection}
      playheadMs={state.playheadMs}
      totalDurationMs={totalDurationMs}
      pixelsPerSecond={pixelsPerSecond}
      rowTrims={rowTrims}
      rowTransitions={rowTransitions}
      onSelect={(shotIndex) => selectShotFromUser(shotIndex, 'timeline')}
      onSeek={seekFromUser}
      onResize={(shotIndex, durationMs) =>
        apply({ type: 'RESIZE_SHOT', shotIndex, durationMs })
      }
      onLeadingResize={(shotIndex, newStartMs) => {
        // Leading-edge drag in ALIGNED timebase (Timeline computes
        // shotStartTimesMs from videoConfig.shots which is post-
        // alignment). Pass aligned current values via overrideCurrent
        // so the reducer's delta math operates in aligned space. End
        // is held constant for a leading-edge drag. See plan
        // `_plans/2026-05-23-editor-pin-duration-architecture.md`.
        const shot = videoConfig.shots[shotIndex];
        if (!shot) return;
        const alignedStart = shot.startMs;
        const alignedEnd = alignedStart + shot.durationMs;
        const alignedLeftDur =
          shotIndex > 0 ? videoConfig.shots[shotIndex - 1]?.durationMs : undefined;
        apply({
          type: 'SET_SHOT_TIMING',
          shotIndex,
          startMs: newStartMs,
          endMs: alignedEnd,
          overrideCurrent: {
            startMs: alignedStart,
            endMs: alignedEnd,
            leftDurationMs: alignedLeftDur,
          },
        });
      }}
      onReorder={(fromIndex, toIndex) =>
        apply({ type: 'REORDER_SHOTS', fromIndex, toIndex })
      }
      onTrim={(shotIndex, values) =>
        apply({ type: 'TRIM_SHOT', shotIndex, ...values })
      }
      onToggleTransition={(shotIndex, transition) =>
        apply({ type: 'SET_TRANSITION_IN', shotIndex, transition })
      }
      onUpdateCaption={(segmentIndex, text) =>
        apply({ type: 'UPDATE_CAPTION_SEGMENT', segmentIndex, text })
      }
      onOpenOverlayPosition={(shotIndex) => {
        selectShotFromUser(shotIndex, 'overlay-position');
        setOverlayPositionRow(shotIndex);
      }}
      zoomLevel={zoomLevel}
      zoomMin={ZOOM_MIN_LEVEL}
      zoomMax={ZOOM_MAX_LEVEL}
      onZoomChange={setZoomLevel}
      videoLaneHeight={getVideoLaneHeight()}
      audioLaneHeight={getAudioLaneHeight()}
      focusedLane={laneFocus}
      onLaneFocus={(kind) => {
        console.info('[editor timeline lane-focus]', {
          kind,
          prevSelection: state.selection,
          prevLaneFocus: laneFocus,
        });
        // Clicking a non-shot lane always clears the shot selection so
        // the inspector's auto-tab can switch unambiguously. Without
        // this the shot tab would stay sticky behind a stale selection.
        if (state.selection !== null) {
          apply({ type: 'SET_SELECTION', shotIndex: null });
        }
        setLaneFocus(kind);
      }}
      showMinimap={getShowMinimap()}
      minimapWrapEnabled={getMinimapWrapEnabled()}
      minimapWrapThresholdMinutes={getMinimapWrapThresholdMinutes()}
      onShotContextMenu={(shotIndex, x, y) => {
        console.info('[editor timeline context-menu] open', { kind: 'shot', shotIndex, x, y });
        setEditorContextMenu({ kind: 'shot', shotIndex, x, y });
      }}
      onAudioContextMenu={(x, y) => {
        console.info('[editor timeline context-menu] open', { kind: 'audio', x, y });
        setEditorContextMenu({ kind: 'audio', x, y });
      }}
      onCaptionContextMenu={(segmentIndex, x, y) => {
        console.info('[editor timeline context-menu] open', { kind: 'caption', segmentIndex, x, y });
        setEditorContextMenu({ kind: 'caption', segmentIndex, x, y });
      }}
      onOverlayContextMenu={(shotIndex, x, y) => {
        // Reuse the existing legacy overlay context menu so the user
        // gets the same Edit image / Rethink placement / Remove
        // overlay verbs the production-doc surface offers.
        console.info('[editor timeline context-menu] open', { kind: 'overlay', shotIndex, x, y });
        setOverlayContextMenu({ rowIndex: shotIndex, x, y });
      }}
      insertSceneDefaultDurationMs={getInsertDefaultDurationMs()}
      onInsertScene={(atIndex, mode, carveFrom) => {
        // `carveFrom` may be undefined when the affordance dispatches
        // 'shift'. For 'carve', the popover always sends 'auto' today;
        // honor the per-device setting so a user who's pinned 'right'
        // or 'left' gets that side first (with the reducer's auto-
        // fallback if it can't give enough slack). See
        // `_plans/2026-05-23-editor-insert-blank-scene-between.md`.
        const resolvedCarveFrom: 'left' | 'right' | 'auto' | undefined =
          mode === 'carve' ? (carveFrom ?? getInsertCarveSource()) : undefined;
        apply({
          type: 'INSERT_BLANK_SHOT',
          atIndex,
          mode,
          durationMs: getInsertDefaultDurationMs(),
          carveFrom: resolvedCarveFrom,
        });
      }}
      splitAvailableShotIndex={
        splitTarget && splitTarget.validSplit ? splitTarget.shotIndex : null
      }
      onSplit={handleSplit}
    />
  );

  return (
    <>
      <ImageGenThrottleToast />
      <EditorChrome
        slots={{
          header: headerSlot,
          leftRail: leftRailSlot,
          preview: previewSlot,
          inspector: inspectorSlot,
          timeline: timelineSlot,
        }}
      />

      {/* Floating modals — rendered outside the chrome grid because
          they're position:fixed overlays. Keeping them after the
          chrome means the layout grid doesn't have to budget any
          space for them.

          IMPORTANT: this block is wrapped in `.editor-root` so the
          editor's CSS custom properties (`--editor-panel`,
          `--editor-edge`, `--fg`, etc.) resolve here too. Without the
          wrapper, modals sit at the React tree level OUTSIDE
          EditorChrome's own `.editor-root`, so every `var(--editor-*)`
          reference falls back to its initial value — which renders
          modal backgrounds transparent and washes out content (the
          Section thumbnail modal looked broken because of this). The
          wrapper has no visible footprint because every child is
          position:fixed (taken out of normal flow). */}
      <div className="editor-root">
      {showDriftReport && (
        <VoiceoverDriftReport
          doc={state.doc}
          onClose={() => setShowDriftReport(false)}
          onJumpToShot={(shotIndex) => selectShotFromUser(shotIndex, 'drift-report')}
        />
      )}

      {showOverlayManager && (
        <TextOverlayManager
          overlays={state.doc.text_overlays ?? []}
          playheadMs={state.playheadMs}
          totalDurationMs={videoConfig.shots.reduce((a, s) => a + s.durationMs, 0)}
          onClose={() => setShowOverlayManager(false)}
          onAdd={(overlay) => apply({ type: 'ADD_TEXT_OVERLAY', overlay })}
          onUpdate={(id, patch) => apply({ type: 'UPDATE_TEXT_OVERLAY', id, patch })}
          onDelete={(id) => apply({ type: 'DELETE_TEXT_OVERLAY', id })}
        />
      )}

      {showVoRegen && (
        <VoiceoverRegenModal
          projectId={projectId}
          estimatedChars={state.doc.rows.reduce(
            (acc, r) => acc + (r.script_text ?? '').length,
            0,
          )}
          onClose={() => setShowVoRegen(false)}
          onSuccess={async () => {
            setShowVoRegen(false);
            closeAllOverlayModals();
            await reloadFromServer();
          }}
        />
      )}

      {showRegenFromScript && (
        <RegenerateFromScriptModal
          projectId={projectId}
          doc={state.doc}
          onClose={() => setShowRegenFromScript(false)}
          onSuccess={async () => {
            setShowRegenFromScript(false);
            closeAllOverlayModals();
            await reloadFromServer();
          }}
        />
      )}

      {renderState && (
        <RenderModal
          state={renderState}
          onClose={() => {
            // Dismiss only — the server-side job keeps running if it
            // was mid-flight. The poll loop still ticks; if it later
            // resolves to done/error we surface the modal again on
            // next state set.
            if (renderState.status === 'rendering') {
              console.info('[editor render] modal dismissed mid-flight', {
                renderId: renderState.renderId,
              });
            }
            setRenderState(null);
          }}
          onRetry={() => { void executeRender(); }}
        />
      )}

      {showBrandKit && (
        <BrandKitModal
          channelId={state.channelId ?? null}
          channelKit={channelVisualKit}
          override={state.visualKitOverride ?? { v: 1 }}
          onChange={(next) => {
            // Strip the v + empty-override case so we never persist a
            // "no actual override" marker. The autosave on production-
            // doc does the same trimming.
            const keys = Object.keys(next).filter(
              (k) => k !== 'v' && (next as unknown as Record<string, unknown>)[k] !== undefined,
            );
            const toSet = keys.length > 0 ? next : undefined;
            console.info('[editor brand-kit] change', {
              overriddenFields: keys,
            });
            apply({ type: 'SET_VISUAL_KIT_OVERRIDE', override: toSet });
          }}
          onClose={() => setShowBrandKit(false)}
        />
      )}

      {bulkGenerateModal !== null && (() => {
        // Per-image cost — same lookup the OST flip-to-overlay modal uses.
        // Verified against image-models.ts hints 2026-05-25.
        const modelId = state.doc.image_model_default;
        const { usd, label } = (() => {
          switch (modelId) {
            case 'gpt-image-2-atlas-t2i':
            case undefined:
              return { usd: 0.011, label: '$0.011 / image (GPT Image 2 Atlas, cheaper default)' };
            case 'gpt-image-2-t2i':
              return { usd: 0.04, label: '$0.04 / image (GPT Image 2 Kie)' };
            case 'nano-banana':
              return { usd: 0.04, label: '$0.04 / image (Google NanoBanana 2)' };
            case 'ideogram-v3-quality-t2i':
              return { usd: 0.05, label: '$0.05 / image (Ideogram v3 Quality)' };
            case 'ideogram-v3-turbo-t2i':
              return { usd: 0.0175, label: '$0.0175 / image (Ideogram v3 Turbo)' };
            default:
              return {
                usd: 0.04,
                label: `~$0.04 / image (estimate; model: ${modelId})`,
              };
          }
        })();

        if (bulkGenerateModal === 'base') {
          const rows = computeMissingBaseImages(state.doc, state.rowImages);
          return (
            <BulkGenerateModal
              title="Generate all base images"
              description="Fires the standard image-gen for every base shot (variant index 0 / no variant) that's still blank. Variants and motion-collage rows are excluded — they have their own bulk actions. Each shot runs through the doc's selected image model + style refs, same as the per-shot Regenerate button."
              affectedRows={rows}
              perImageCostLabel={label}
              perImageCostUsd={usd}
              totalRowCount={state.doc.rows.length}
              onCancel={() => setBulkGenerateModal(null)}
              onConfirm={() => {
                console.info('[editor bulk-generate base confirm]', {
                  affectedCount: rows.length,
                });
                setBulkGenerateModal(null);
                void runFillBlanks({
                  rowFilter: (row, i) => {
                    if (row.visual_type === 'blank' || row.visual_type === 'Title Card') return false;
                    if (row.shot_kind === 'motion_collage') return false;
                    return (row.variant_index ?? 0) === 0;
                  },
                  emptyMessage: 'No base images need generation.',
                });
              }}
            />
          );
        }
        if (bulkGenerateModal === 'variants') {
          const rows = computeMissingVariants(state.doc, state.rowImages);
          return (
            <BulkGenerateModal
              title="Generate all variations"
              description="Fires the standard image-gen for every variant shot (variant index > 0) that's still blank. Each variant chains off its base image via the existing variant pipeline. Base images and motion-collage rows are excluded."
              affectedRows={rows}
              perImageCostLabel={label}
              perImageCostUsd={usd}
              totalRowCount={state.doc.rows.length}
              onCancel={() => setBulkGenerateModal(null)}
              onConfirm={() => {
                console.info('[editor bulk-generate variants confirm]', {
                  affectedCount: rows.length,
                });
                setBulkGenerateModal(null);
                void runFillBlanks({
                  rowFilter: (row, i) => {
                    if (row.visual_type === 'blank' || row.visual_type === 'Title Card') return false;
                    return (row.variant_index ?? 0) > 0;
                  },
                  emptyMessage: 'No missing variations.',
                });
              }}
            />
          );
        }
        // bulkGenerateModal === 'collages' (missing only)
        // OR     === 'collages-regen' (every motion_collage row)
        // Both share the same sequential worker — only the filter +
        // modal copy differ. The regen path is destructive (overwrites
        // existing panel URLs); the copy spells that out.
        const isRegen = bulkGenerateModal === 'collages-regen';
        const rows = isRegen
          ? computeAllEligibleMotionCollages(state.doc)
          : computeMissingMotionCollages(state.doc);
        // Motion-collage cost: each row generates ~N panels (cols×rows),
        // each panel ~= one image. Estimate cost = N panels × per-image.
        // For mixed grids, use the panel-prompts length per row.
        const totalPanels = rows.reduce((sum, r) => {
          const row = state.doc.rows[r.rowIndex];
          return sum + (row?.motion_collage_panel_prompts?.length ?? 4);
        }, 0);
        const collageCostUsd = totalPanels * usd;
        const collageLabel = `${label} × N panels per collage`;
        return (
          <BulkGenerateModal
            title={isRegen ? 'Regenerate all motion collages' : 'Generate all motion collages'}
            description={
              isRegen
                ? `DESTRUCTIVE — overwrites existing panel URLs on every motion-collage row that has a grid + non-blank prompts. Use this to re-run the entire batch through the latest pipeline (e.g. after the framing-lock prompt fix). Total panel count across all affected rows: ${totalPanels}. Each panel costs the same as one regular image; rows run sequentially. Existing per-panel transforms (the manual X/Y/SCALE sliders) are PRESERVED — only the panel images themselves get replaced.`
                : `Generates panels for every motion-collage row that hasn't been rendered yet (and that has a grid + panel prompts set). Total panel count across all affected rows: ${totalPanels}. Each panel costs the same as one regular image; rows run sequentially because each panel chains off the previous one inside the row.`
            }
            affectedRows={rows}
            perImageCostLabel={collageLabel}
            perImageCostUsd={collageCostUsd / Math.max(1, rows.length)}
            totalRowCount={state.doc.rows.length}
            onCancel={() => setBulkGenerateModal(null)}
            onConfirm={() => {
              console.info(
                isRegen
                  ? '[editor bulk-generate collages-regen confirm]'
                  : '[editor bulk-generate collages confirm]',
                {
                  affectedCount: rows.length,
                  totalPanels,
                  estCost: collageCostUsd,
                },
              );
              setBulkGenerateModal(null);
              // Sequential dispatch — each motion-collage gen takes
              // ~2 min wall-clock, can't safely parallelize without
              // burning Atlas rate limits. Run them one at a time with
              // toast progress. Per-row failure is non-fatal; the loop
              // continues so a single bad row doesn't kill the batch.
              void (async () => {
                let succeeded = 0;
                let failed = 0;
                for (const target of rows) {
                  const row = state.doc.rows[target.rowIndex];
                  if (!row) continue;
                  if (!row.motion_collage_grid || !row.motion_collage_panel_prompts?.length) {
                    failed += 1;
                    continue;
                  }
                  toast.info(
                    `Generating collage ${succeeded + failed + 1}/${rows.length} (shot #${target.rowIndex + 1})…`,
                  );
                  try {
                    // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC; awaits + reads response
                    const res = await fetch('/api/generate/production-doc/motion-collage', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        grid: row.motion_collage_grid,
                        panelPrompts: row.motion_collage_panel_prompts,
                        stylePreset: state.doc.style_preset,
                        motionCollageSettings: state.doc.doodle_explainer_2_motion_collage_settings,
                        characterDescriptions: state.doc.doodle_explainer_2_character_descriptions,
                      }),
                    });
                    const data = (await res.json()) as {
                      imageUrl?: string;
                      panelUrls?: string[];
                      collageImageUrl?: string;
                      error?: string;
                    };
                    if (!res.ok || !data.imageUrl || !data.panelUrls?.length) {
                      failed += 1;
                      console.warn('[editor bulk-generate collages] row failed', {
                        rowIndex: target.rowIndex,
                        error: data.error,
                      });
                      continue;
                    }
                    apply({
                      type: 'PATCH_ROW',
                      rowIndex: target.rowIndex,
                      patch: {
                        image_url: data.imageUrl,
                        motion_collage_image_url: data.collageImageUrl,
                        motion_collage_panel_urls: data.panelUrls,
                      },
                    });
                    succeeded += 1;
                  } catch (err) {
                    failed += 1;
                    console.warn('[editor bulk-generate collages] threw', {
                      rowIndex: target.rowIndex,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                }
                if (failed === 0) {
                  toast.success(`All ${succeeded} motion collages generated.`);
                } else if (succeeded === 0) {
                  toast.error(`All ${failed} motion collages failed. Check Live tab for details.`);
                } else {
                  toast.success(
                    `${succeeded} collages generated · ${failed} failed.`,
                  );
                }
              })();
            }}
          />
        );
      })()}

      {flipOstModalOpen && (() => {
        const affected = computeAffectedRows(state.doc, state.rowImages);
        const modelId = state.doc.image_model_default;
        // Per-image cost estimate keyed on the doc's chosen image model.
        // Values from src/lib/image-models.ts hints (verified 2026-05-25);
        // re-check at the source when adding a new model. Per Rule 8 we
        // pull these forward into a visible price the user must confirm
        // before any spend.
        const { usd, label } = (() => {
          switch (modelId) {
            case 'gpt-image-2-atlas-t2i':
            case undefined:
              return { usd: 0.011, label: '$0.011 / image (GPT Image 2 Atlas, cheaper default)' };
            case 'gpt-image-2-t2i':
              return { usd: 0.04, label: '$0.04 / image (GPT Image 2 Kie)' };
            case 'nano-banana':
              return { usd: 0.04, label: '$0.04 / image (Google NanoBanana 2)' };
            case 'ideogram-v3-quality-t2i':
              return { usd: 0.05, label: '$0.05 / image (Ideogram v3 Quality)' };
            case 'ideogram-v3-turbo-t2i':
              return { usd: 0.0175, label: '$0.0175 / image (Ideogram v3 Turbo)' };
            default:
              return {
                usd: 0.04,
                label: `~$0.04 / image (estimate; model: ${modelId})`,
              };
          }
        })();
        return (
          <FlipOstToOverlayModal
            affectedRows={affected}
            perImageCostLabel={label}
            perImageCostUsd={usd}
            totalRowCount={state.doc.rows.length}
            onCancel={() => setFlipOstModalOpen(false)}
            onConfirm={handleFlipOstConfirm}
          />
        );
      })()}

      {showSectionThumbnail && (
        <SectionThumbnailModal
          value={state.doc.thumbnail}
          onChange={(next) => {
            console.info('[editor section-thumbnail] change', {
              hasImage: Boolean(next?.imageUrl),
              regionCount: next?.regions?.length ?? 0,
            });
            apply({ type: 'PATCH_DOC', patch: { thumbnail: next } });
          }}
          onClose={() => setShowSectionThumbnail(false)}
        />
      )}

      {/* Batch C — per-shot mask-brush image edit. Wraps the same
          MaskBrushEditor production-doc uses, calls the same
          /api/generate/production-doc/image/edit endpoint. */}
      {imageEditRow !== null && state.rowImages[imageEditRow] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => !imageEditApplying && setImageEditRow(null)}
        >
          <div
            className="editor-panel max-w-5xl w-full max-h-[95vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <MaskBrushEditor
              sourceImageUrl={state.rowImages[imageEditRow]!}
              option={resolvedBrushOption}
              onOptionChange={updateImageEditOption}
              onCancel={() => setImageEditRow(null)}
              onApply={async ({ maskUrl, prompt, option: appliedOption }) => {
                if (imageEditApplying) return;
                const rowIndex = imageEditRow;
                setImageEditApplying(true);
                console.info('[editor image-edit] apply', { rowIndex, optionId: appliedOption.id });
                try {
                  const res = await queueImageGen('edit', 'editor-edit-apply', () =>
                    // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response
                    fetch('/api/generate/production-doc/image/edit', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        originalImageUrl: state.rowImages[rowIndex],
                        prompt,
                        optionId: appliedOption.id,
                        mask: { url: maskUrl },
                      }),
                    }),
                  );
                  if (res.status === 429) reportUpstream429('edit', 'editor-edit-apply');
                  const data = (await res.json().catch(() => ({}))) as {
                    imageUrl?: string;
                    saliency?: ImageSaliencyMap;
                    error?: string;
                  };
                  if (!res.ok || !data.imageUrl) {
                    alert(`Image edit failed: ${data.error || `HTTP ${res.status}`}`);
                    console.warn('[editor image-edit] failed', { rowIndex, status: res.status });
                    return;
                  }
                  commitRowImage(rowIndex, data.imageUrl);
                  if (data.saliency) {
                    updateRow(rowIndex, { image_saliency: data.saliency });
                  }
                  console.info('[editor image-edit] success', { rowIndex });
                  setImageEditRow(null);
                } catch (err) {
                  alert(`Image edit failed: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                  setImageEditApplying(false);
                }
              }}
              onErase={async ({ maskUrl }) => {
                if (imageEditApplying) return;
                const rowIndex = imageEditRow;
                setImageEditApplying(true);
                console.info('[editor image-edit] erase', { rowIndex });
                try {
                  const res = await queueImageGen('edit', 'editor-erase', () =>
                    // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response
                    fetch('/api/generate/production-doc/image/edit', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        originalImageUrl: state.rowImages[rowIndex],
                        intent: 'erase',
                        mask: { url: maskUrl },
                      }),
                    }),
                  );
                  if (res.status === 429) reportUpstream429('edit', 'editor-erase');
                  const data = (await res.json().catch(() => ({}))) as {
                    imageUrl?: string;
                    saliency?: ImageSaliencyMap;
                    error?: string;
                  };
                  if (!res.ok || !data.imageUrl) {
                    alert(`Erase failed: ${data.error || `HTTP ${res.status}`}`);
                    console.warn('[editor image-edit] erase failed', { rowIndex, status: res.status });
                    return;
                  }
                  commitRowImage(rowIndex, data.imageUrl);
                  if (data.saliency) {
                    updateRow(rowIndex, { image_saliency: data.saliency });
                  }
                  console.info('[editor image-edit] erase success', { rowIndex });
                  setImageEditRow(null);
                } catch (err) {
                  alert(`Erase failed: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                  setImageEditApplying(false);
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Phase 5.2 overlay-port — three modal surfaces mount here so
          every overlay action in the editor reuses the same UI the
          production-doc page uses. Each is gated by its own state
          slot so only one shows at a time. */}
      {overlayPositionRow !== null &&
        state.doc.rows[overlayPositionRow] &&
        state.rowOverlays[overlayPositionRow]?.status === 'done' &&
        state.rowOverlays[overlayPositionRow]?.url && (
          <OverlayPositionEditor
            stillImageUrl={state.rowImages[overlayPositionRow]}
            overlayUrl={state.rowOverlays[overlayPositionRow]!.url!}
            position={state.doc.rows[overlayPositionRow]!.overlay_position}
            sizePct={state.doc.rows[overlayPositionRow]!.overlay_size_pct}
            stretchedHeightPct={
              state.doc.rows[overlayPositionRow]!.overlay_stretched_height_pct
            }
            termsLabel={state.doc.rows[overlayPositionRow]!.overlay_stock_terms || ''}
            placementReason={state.doc.rows[overlayPositionRow]!.overlay_placement_reason}
            placementModel={state.doc.rows[overlayPositionRow]!.overlay_placement_model}
            onRethink={() => {
              void rethinkOverlayPlacement(overlayPositionRow);
            }}
            isRethinking={rethinkingRows.has(overlayPositionRow)}
            rethinkExhausted={
              (rethinkAttempts[overlayPositionRow] ?? 0) >= RETHINK_MAX_ATTEMPTS
            }
            onEditImage={() => setOverlayEditRow(overlayPositionRow)}
            onSave={(pos, size, stretchedH) => {
              console.info('[ui overlay-position] saved (editor)', {
                rowIndex: overlayPositionRow,
                pos,
                size,
                stretchedH,
              });
              // Telemetry parity with production-doc — `overlay_drag`
              // when position changed; `overlay_resize` when size or
              // stretch changed. Both can fire in the same save.
              const prevRow = state.doc.rows[overlayPositionRow];
              const prevPos = prevRow?.overlay_position;
              const prevSize = prevRow?.overlay_size_pct;
              const prevStretchedH = prevRow?.overlay_stretched_height_pct;
              const placementModel = prevRow?.overlay_placement_model ?? 'doc-gen-blind';
              const positionChanged =
                !prevPos || prevPos.x_pct !== pos.x_pct || prevPos.y_pct !== pos.y_pct;
              const sizeChanged = prevSize !== size;
              const stretchChanged = (prevStretchedH ?? null) !== (stretchedH ?? null);
              if (positionChanged) {
                const dx = prevPos ? pos.x_pct - prevPos.x_pct : 0;
                const dy = prevPos ? pos.y_pct - prevPos.y_pct : 0;
                const dragDistancePct = Math.sqrt(dx * dx + dy * dy);
                void recordOverlayTelemetry('overlay_drag', {
                  row_index: overlayPositionRow,
                  placement_model: placementModel,
                  prev_x_pct: prevPos?.x_pct ?? null,
                  prev_y_pct: prevPos?.y_pct ?? null,
                  prev_size_pct: prevSize ?? null,
                  new_x_pct: Number(pos.x_pct.toFixed(2)),
                  new_y_pct: Number(pos.y_pct.toFixed(2)),
                  new_size_pct: Number(size.toFixed(2)),
                  drag_distance_pct: Number(dragDistancePct.toFixed(2)),
                });
              }
              if (sizeChanged || stretchChanged) {
                void recordOverlayTelemetry('overlay_resize', {
                  row_index: overlayPositionRow,
                  placement_model: placementModel,
                  prev_size_pct: prevSize ?? null,
                  new_size_pct: Number(size.toFixed(2)),
                  prev_stretched_height_pct: prevStretchedH ?? null,
                  new_stretched_height_pct:
                    stretchedH !== null ? Number(stretchedH.toFixed(2)) : null,
                  free_aspect_used: stretchedH !== null,
                });
              }
              updateRow(overlayPositionRow, {
                overlay_position: pos,
                overlay_size_pct: size,
                overlay_stretched_height_pct: stretchedH ?? undefined,
              });
            }}
            onReset={() => {
              console.info('[ui overlay-position] reset (editor)', {
                rowIndex: overlayPositionRow,
              });
              const placementModel =
                state.doc.rows[overlayPositionRow]?.overlay_placement_model ?? 'doc-gen-blind';
              void recordOverlayTelemetry('overlay_reset', {
                row_index: overlayPositionRow,
                placement_model: placementModel,
              });
              updateRow(overlayPositionRow, {
                overlay_position: undefined,
                overlay_size_pct: undefined,
                overlay_stretched_height_pct: undefined,
              });
            }}
            onClose={() => setOverlayPositionRow(null)}
          />
        )}

      {overlayEditRow !== null &&
        state.rowOverlays[overlayEditRow]?.status === 'done' &&
        state.rowOverlays[overlayEditRow]?.url && (
          <OverlayEditDialog
            overlayUrl={state.rowOverlays[overlayEditRow]!.url!}
            termsLabel={state.doc.rows[overlayEditRow]?.overlay_stock_terms || ''}
            onAccept={handleOverlayEditAccept}
            onClose={() => setOverlayEditRow(null)}
          />
        )}

      {overlayContextMenu &&
        state.doc.rows[overlayContextMenu.rowIndex] &&
        (() => {
          const i = overlayContextMenu.rowIndex;
          const row = state.doc.rows[i]!;
          const overlayState = state.rowOverlays[i];
          const canUndo = (row.overlay_edit_history?.length ?? 0) > 0;
          return (
            <OverlayContextMenu
              x={overlayContextMenu.x}
              y={overlayContextMenu.y}
              onClose={() => setOverlayContextMenu(null)}
              items={[
                {
                  label: 'Edit image',
                  onClick: () => setOverlayEditRow(i),
                  disabled: overlayState?.status !== 'done',
                  title: 'Open the AI image-edit dialog',
                },
                {
                  label: 'Rethink placement',
                  onClick: () => {
                    void rethinkOverlayPlacement(i);
                  },
                  disabled:
                    overlayState?.status !== 'done' ||
                    rethinkingRows.has(i) ||
                    (rethinkAttempts[i] ?? 0) >= RETHINK_MAX_ATTEMPTS,
                  title: 'Ask the AI for a new size + position',
                },
                {
                  label: 'Replace overlay (re-search)',
                  onClick: () => {
                    void replaceOverlayForRow(i);
                  },
                  disabled: !row.overlay_stock_terms?.trim(),
                  title:
                    'Re-run Brave search + RMBG with the same stock terms (replaces the current overlay)',
                },
                {
                  label: 'Undo last edit',
                  onClick: () => undoOverlayEdit(i),
                  disabled: !canUndo,
                  separatorAbove: true,
                  title: canUndo
                    ? 'Restore the overlay from before the most recent AI edit'
                    : 'No edits to undo yet',
                },
                {
                  label: 'Reset to AI placement',
                  onClick: () => {
                    console.info('[ui overlay-position] reset (editor context menu)', {
                      rowIndex: i,
                    });
                    void recordOverlayTelemetry('overlay_reset', {
                      row_index: i,
                      placement_model: row.overlay_placement_model ?? 'doc-gen-blind',
                    });
                    updateRow(i, {
                      overlay_position: undefined,
                      overlay_size_pct: undefined,
                      overlay_stretched_height_pct: undefined,
                    });
                  },
                  disabled:
                    !row.overlay_position &&
                    row.overlay_size_pct === undefined &&
                    row.overlay_stretched_height_pct === undefined,
                  separatorAbove: true,
                  title: 'Clear manual position / size / stretch and fall back to the AI pick',
                },
                {
                  label: 'Remove overlay',
                  onClick: () => {
                    const ok = window.confirm(
                      'Remove the overlay entirely?\n\nThis clears the stock terms, the fetched image, AI placement, edits, and undo history for this row. The row\'s scene image stays. You can re-add by typing new stock terms.',
                    );
                    if (!ok) return;
                    console.info('[ui overlay] removed (editor context menu)', { rowIndex: i });
                    setRowOverlay(i, null);
                    updateRow(i, {
                      overlay_stock_terms: undefined,
                      overlay_zone: undefined,
                      overlay_size: undefined,
                      overlay_zone_resolved: undefined,
                      overlay_size_resolved: undefined,
                      overlay_position: undefined,
                      overlay_size_pct: undefined,
                      overlay_stretched_height_pct: undefined,
                      overlay_placement_reason: undefined,
                      overlay_placement_model: undefined,
                      overlay_rmbg_kept: undefined,
                      overlay_edit_history: undefined,
                    });
                  },
                  destructive: true,
                  title:
                    'Clear all overlay state on this row (stock terms, image, placement, history)',
                },
              ]}
            />
          );
        })()}

      {/* Phase 3 context menu — Timeline shot card / ShotsTab item /
          audio lane / caption pill. Items derived per-kind via the
          `buildEditorContextMenuItems` helper just above. The menu
          itself is the same OverlayContextMenu used by the overlay
          surface so the visuals + close-behavior stay consistent. */}
      {editorContextMenu &&
        (() => {
          const items = buildEditorContextMenuItems({
            menu: editorContextMenu,
            doc: state.doc,
            rowImages: state.rowImages,
            shotDurationsMs: videoConfig.shots.map((s) => s.durationMs),
            captions: state.captions,
            playheadMs: state.playheadMs,
            splitTarget,
            rmbgInflight,
            apply,
            selectShotFromUser,
            setLaneFocus,
            setShowVoRegen,
            setTimingPopover,
            cascadeStartTimesMs: shotStartTimesMs,
            openImageEdit: (i) => setImageEditRow(i),
            handleRunRmbg: (i) => {
              void handleRunRmbg(i);
            },
            handleRestoreOriginalBackground,
          });
          return (
            <OverlayContextMenu
              x={editorContextMenu.x}
              y={editorContextMenu.y}
              onClose={() => setEditorContextMenu(null)}
              items={items}
            />
          );
        })()}

      {/* Set-timing popover — opens from the shot / ShotsTab context
          menu's "Set timing…" item. Apply dispatches SET_SHOT_TIMING
          which carves from / gives back to both neighbors in one
          atomic step. */}
      {timingPopover && (
        <SetTimingPopover
          title={`Shot ${timingPopover.shotIndex + 1} timing`}
          x={timingPopover.x}
          y={timingPopover.y}
          initialStartMs={timingPopover.initialStartMs}
          initialEndMs={timingPopover.initialEndMs}
          minDurationMs={EDITOR_MIN_SHOT_MS}
          maxDurationMs={EDITOR_MAX_SHOT_MS}
          isFirstShot={timingPopover.isFirstShot}
          onApply={(startMs, endMs) => {
            // 2026-05-23 pin-duration architecture follow-up: popover
            // values are ALIGNED space (matches the ruler). We pass
            // aligned current values via overrideCurrent so the
            // reducer's delta math operates in aligned space too.
            // After pin, the rendered position equals the typed
            // values exactly. See the plan's "Edge case analysis".
            const idx = timingPopover.shotIndex;
            const alignedShot = videoConfig.shots[idx];
            const alignedStart = alignedShot?.startMs ?? timingPopover.initialStartMs;
            const alignedEnd =
              (alignedShot?.startMs ?? timingPopover.initialStartMs) +
              (alignedShot?.durationMs ?? 0);
            const hasLeft = idx > 0;
            const alignedLeftDur = hasLeft
              ? videoConfig.shots[idx - 1]?.durationMs ?? 0
              : undefined;
            // Predict left-side clamp so we can toast if the user's
            // requested start would push the left neighbor below the
            // 2 s floor (or above the MAX). Right side is SHIFT —
            // always honored verbatim.
            const deltaStart = startMs - alignedStart;
            const clampDur = (n: number) =>
              Math.max(EDITOR_MIN_SHOT_MS, Math.min(EDITOR_MAX_SHOT_MS, Math.round(n)));
            const achievableDeltaStart = hasLeft && alignedLeftDur !== undefined
              ? clampDur(alignedLeftDur + deltaStart) - alignedLeftDur
              : 0;
            const clampedStart = hasLeft && Math.abs(achievableDeltaStart - deltaStart) > 1;
            if (clampedStart) {
              toast.warning(
                `Scene ${idx} can't shrink past the ${(EDITOR_MIN_SHOT_MS / 1000).toFixed(0)}s minimum — start clamped to ${formatTimecodeLabel(alignedStart + achievableDeltaStart)}.`,
              );
            } else if (!hasLeft && deltaStart !== 0) {
              toast.info('Scene 1’s start is anchored at 0:00 — start change ignored.');
            }
            console.info('[editor set-shot-timing] popover dispatch', {
              shotIndex: idx,
              typedStart: startMs,
              typedEnd: endMs,
              alignedStart,
              alignedEnd,
              alignedLeftDur,
              deltaStart,
              deltaEnd: endMs - alignedEnd,
              achievableDeltaStart,
              clampedStart,
            });
            apply({
              type: 'SET_SHOT_TIMING',
              shotIndex: idx,
              startMs,
              endMs,
              overrideCurrent: {
                startMs: alignedStart,
                endMs: alignedEnd,
                leftDurationMs: alignedLeftDur,
              },
            });
          }}
          onClose={() => setTimingPopover(null)}
        />
      )}
      </div>
    </>
  );
}

/** Build the item list for the Phase 3 context menu based on which
 *  surface the user right-clicked. Pure function — the parent
 *  passes in the doc + the dispatchers + the state setters it
 *  needs. Defined outside the component body so the JSX above stays
 *  readable. */
function buildEditorContextMenuItems(args: {
  menu:
    | { kind: 'shot'; shotIndex: number; x: number; y: number }
    | { kind: 'shots-tab-item'; shotIndex: number; x: number; y: number }
    | { kind: 'audio'; x: number; y: number }
    | { kind: 'caption'; segmentIndex: number; x: number; y: number };
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  /** Cumulative computed shot durations in ms. Read from the same
   *  `videoConfig.shots[i].durationMs` the timeline draws so the
   *  Set duration… popover initializes to the duration the user
   *  visually sees — even when `duration_override_ms` isn't set
   *  and the duration comes from the doc's timecode delta. */
  shotDurationsMs: number[];
  /** Cascade-space start time for each shot (cumulative sum of
   *  `duration_override_ms || naturalRowDurationMs`). The Set timing
   *  popover anchors on these so the dispatched values land in the
   *  exact timebase the reducer reads — no aligned↔cascade translation
   *  bugs. See `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
  cascadeStartTimesMs: number[];
  captions: { segments: { start: number; end: number; text: string }[] } | undefined;
  playheadMs: number;
  splitTarget: { shotIndex: number; splitAtMs: number; validSplit: boolean } | null;
  rmbgInflight: Set<number>;
  apply: (cmd: EditorCommand) => void;
  selectShotFromUser: (shotIndex: number, source: string) => void;
  setLaneFocus: (kind: 'audio' | 'captions' | 'overlays' | null) => void;
  setShowVoRegen: (open: boolean) => void;
  setTimingPopover: (
    p:
      | {
          shotIndex: number;
          x: number;
          y: number;
          initialStartMs: number;
          initialEndMs: number;
          isFirstShot: boolean;
        }
      | null,
  ) => void;
  openImageEdit: (shotIndex: number) => void;
  handleRunRmbg: (shotIndex: number) => void;
  handleRestoreOriginalBackground: (shotIndex: number) => void;
}): OverlayContextMenuItem[] {
  const {
    menu,
    doc,
    rowImages,
    shotDurationsMs,
    captions,
    playheadMs,
    splitTarget,
    rmbgInflight,
    apply,
    selectShotFromUser,
    setLaneFocus,
    setShowVoRegen,
    setTimingPopover,
    cascadeStartTimesMs,
    openImageEdit,
    handleRunRmbg,
    handleRestoreOriginalBackground,
  } = args;

  switch (menu.kind) {
    case 'shot':
    case 'shots-tab-item': {
      const i = menu.shotIndex;
      const row = doc.rows[i];
      if (!row) return [];
      const muted = row.muted === true;
      const hasTrim =
        (row.trim_start_ms ?? 0) > 0 || (row.trim_end_ms ?? 0) > 0;
      const crossFadeOn = row.transition_in === 'cross-fade';
      const canSplit =
        menu.kind === 'shot' &&
        splitTarget !== null &&
        splitTarget.shotIndex === i &&
        splitTarget.validSplit;
      const canDelete = doc.rows.length > 1;
      // Read the duration the user actually sees on the timeline.
      // `shotDurationsMs[i]` is sourced from videoConfig.shots which
      // resolves override > timecode delta > min-scene fallback in
      // the same way the render does — so the popover initializes
      // to the value the user expects regardless of which source
      // the row's effective duration came from. Defensive fallback
      // to 4000 ms if the index is somehow out of range (shouldn't
      // happen — the helper validated `row` exists above).
      const currentDurationMs =
        typeof shotDurationsMs[i] === 'number' && shotDurationsMs[i] > 0
          ? shotDurationsMs[i]
          : row.duration_override_ms ?? 4000;

      const items: OverlayContextMenuItem[] = [
        {
          label: 'Jump to start',
          onClick: () => selectShotFromUser(i, `${menu.kind}-context-menu`),
          title: 'Move the playhead to this shot and select it',
        },
        ...(menu.kind === 'shot'
          ? [
              {
                label: 'Split at playhead',
                onClick: () => {
                  if (!splitTarget || !splitTarget.validSplit) return;
                  apply({
                    type: 'SPLIT_SHOT' as const,
                    shotIndex: splitTarget.shotIndex,
                    splitAtMs: splitTarget.splitAtMs,
                  });
                },
                disabled: !canSplit,
                title: canSplit
                  ? 'Cut this shot in two at the playhead'
                  : 'Playhead must be inside this shot to split',
              },
            ]
          : []),
        {
          label: 'Set timing…',
          onClick: () => {
            // Show ALIGNED values (matches the ruler the user sees).
            // The reducer's `overrideCurrent` field lets the dispatch
            // operate in aligned-timebase too — after pin, the
            // rendered position equals the user's typed values
            // exactly. The earlier cascade-only popover (Phase 4 of
            // the pin-duration plan) surfaced cascade values that
            // diverged from the ruler by many seconds when alignment
            // was active — surprised the user. Aligned values are
            // the right UX; the reducer math handles the rest.
            // 2026-05-23 pin-duration architecture follow-up.
            let alignedStart = 0;
            for (let k = 0; k < i; k += 1) alignedStart += shotDurationsMs[k] ?? 0;
            const alignedEnd = alignedStart + (shotDurationsMs[i] ?? 0);
            setTimingPopover({
              shotIndex: i,
              x: menu.x,
              y: menu.y,
              initialStartMs: alignedStart,
              initialEndMs: alignedEnd,
              isFirstShot: i === 0,
            });
          },
          title:
            'Set the shot\'s exact start and end timecodes. The new timing is pinned so alignment won\'t overwrite it.',
        },
        // Reset timing to alignment — clears both duration_override_ms
        // AND pin_duration so alignment takes over again. Disabled
        // when the row has no override to reset.
        // 2026-05-23 pin-duration architecture.
        ...(typeof row.duration_override_ms === 'number'
          ? [
              {
                label: 'Reset timing to alignment',
                onClick: () => apply({ type: 'RESET_SHOT_TIMING', shotIndex: i }),
                title:
                  'Release this shot\'s manual duration. The voiceover-aligned timing takes over.',
              },
            ]
          : []),
        {
          label: muted ? 'Unmute shot' : 'Mute shot',
          onClick: () =>
            apply({ type: 'SET_MUTE', shotIndex: i, muted: !muted }),
          title: muted
            ? 'Re-enable this shot\'s audio (per-shot mute flag)'
            : 'Silence this shot only (does not affect adjacent shots)',
        },
        {
          label: crossFadeOn ? 'Remove cross-fade' : 'Add cross-fade in',
          onClick: () =>
            apply({
              type: 'SET_TRANSITION_IN',
              shotIndex: i,
              transition: crossFadeOn ? null : 'cross-fade',
            }),
          title: 'Toggle the cross-fade transition into this shot',
        },
        {
          label: 'Duplicate shot',
          onClick: () => apply({ type: 'DUPLICATE_SHOT', shotIndex: i }),
          title:
            'Insert a copy of this shot right after it. The clone inherits script + visual + duration and gets selected so you can tweak it.',
        },
        // ── AI Edit verbs ──────────────────────────────────────
        // Single-tier (flat) menu, separator above so the AI block
        // reads as its own region. The sub-menu / "AI Edit ▸"
        // pattern from the plan would need OverlayContextMenu to
        // grow nested support; that's out of scope here, so flat
        // works fine for the four MVP verbs.
        ...(rowImages[i]
          ? [
              {
                label: 'AI: Replace with prompt…',
                onClick: () => openImageEdit(i),
                separatorAbove: true,
                title:
                  'Open the AI image-edit dialog (paint mask + prompt, or prompt-only models)',
              },
              {
                label: 'AI: Erase region (mask)…',
                onClick: () => openImageEdit(i),
                title:
                  'Open the mask-brush editor to paint over an object — Erase removes it and rebuilds the background',
              },
              ...(row.image_rmbg_applied === true
                ? [
                    {
                      label: 'AI: Restore original background',
                      onClick: () => handleRestoreOriginalBackground(i),
                      title:
                        'Revert this shot to the original image (the cutout stays on the row so re-applying is free)',
                    },
                  ]
                : [
                    {
                      label: rmbgInflight.has(i)
                        ? 'AI: Removing background…'
                        : row.image_rmbg_url
                          ? 'AI: Re-apply background removal'
                          : 'AI: Remove background',
                      onClick: () => handleRunRmbg(i),
                      disabled: rmbgInflight.has(i),
                      title: row.image_rmbg_url
                        ? 'Re-apply the previously generated cutout (instant — no model call)'
                        : 'Run Bria RMBG to isolate the subject; the row\'s background color shows through where the original background was',
                    },
                  ]),
            ]
          : []),
        ...(menu.kind === 'shot' && hasTrim
          ? [
              {
                label: 'Reset trim',
                onClick: () =>
                  apply({
                    type: 'TRIM_SHOT' as const,
                    shotIndex: i,
                    trimStartMs: null,
                    trimEndMs: null,
                  }),
                separatorAbove: true,
                title: 'Clear head + tail trim handles on this shot',
              },
            ]
          : []),
        {
          label: 'Delete shot (ripple)',
          // Dispatch DELETE_SHOT directly with shotIndex: i — going
          // through `handleDelete` would read a stale `state.selection`
          // from the closure (the closure captures selection at the
          // render BEFORE the menu opened, not the row the user
          // right-clicked). The reducer adjusts selection itself
          // post-delete, so no SET_SELECTION precursor is needed.
          onClick: () =>
            apply({ type: 'DELETE_SHOT', shotIndex: i, mode: 'ripple' }),
          disabled: !canDelete,
          separatorAbove: !hasTrim,
          destructive: true,
          title: canDelete
            ? 'Remove this shot and pull every later shot earlier'
            : 'Can\'t delete the last remaining shot',
        },
        {
          label: 'Delete shot (keep slot)',
          onClick: () =>
            apply({ type: 'DELETE_SHOT', shotIndex: i, mode: 'blank' }),
          disabled: !canDelete,
          destructive: true,
          title:
            'Remove this shot\'s content but keep its timeline slot (later shots stay put)',
        },
      ];
      return items;
    }

    case 'audio': {
      const muted = doc.voiceover_muted === true;
      return [
        {
          label: muted ? 'Unmute voiceover' : 'Mute voiceover',
          onClick: () =>
            apply({ type: 'PATCH_DOC', patch: { voiceover_muted: !muted } }),
          title: 'Toggle the doc-level voiceover mute flag',
        },
        {
          label: 'Open audio inspector',
          onClick: () => {
            setLaneFocus('audio');
            apply({ type: 'SET_SELECTION', shotIndex: null });
          },
          title: 'Switch the inspector to the audio Mix card',
        },
        {
          label: 'Regenerate voiceover…',
          onClick: () => setShowVoRegen(true),
          separatorAbove: true,
          title: 'Open the voiceover regenerate modal',
        },
      ];
    }

    case 'caption': {
      // "Edit text" is a hint pointing the user back to the
      // captions lane's double-click editor; wiring a separate
      // inline editor here would duplicate that flow.
      // "Re-align from playhead" shifts the segment so its start
      // lands at the current playhead time, preserving its duration
      // — useful when the user has scrubbed to the exact moment a
      // line is spoken and wants the caption to track from there.
      const seg = captions?.segments?.[menu.segmentIndex];
      const playheadSeconds = playheadMs / 1000;
      const canRealign =
        seg !== undefined &&
        playheadSeconds >= 0 &&
        Math.abs(playheadSeconds - seg.start) > 0.05; // ignore < 50 ms drift
      return [
        {
          label: 'Edit text (double-click pill)',
          onClick: () => {
            console.info('[editor caption-context-menu] edit hint', {
              segmentIndex: menu.segmentIndex,
            });
          },
          disabled: true,
          title: 'Captions lane: double-click the pill to edit inline',
        },
        {
          label: 'Re-align from playhead',
          onClick: () => {
            if (!seg) return;
            const duration = seg.end - seg.start;
            const nextStart = playheadSeconds;
            const nextEnd = nextStart + duration;
            apply({
              type: 'SET_CAPTION_SEGMENT_TIMING',
              segmentIndex: menu.segmentIndex,
              startSeconds: nextStart,
              endSeconds: nextEnd,
            });
          },
          disabled: !canRealign,
          title: canRealign
            ? `Shift this segment so it starts at ${playheadSeconds.toFixed(2)}s (keeps the duration)`
            : 'Move the playhead off the segment\'s start to enable re-align',
        },
        {
          label: 'Clear segment text',
          onClick: () =>
            apply({
              type: 'UPDATE_CAPTION_SEGMENT',
              segmentIndex: menu.segmentIndex,
              text: '',
            }),
          destructive: true,
          separatorAbove: true,
          title:
            'Empty this caption segment\'s text (the renderer skips empty segments)',
        },
      ];
    }

    default:
      return [];
  }
}

// ─── Save-status badge ─────────────────────────────────────────────

interface SaveStatusBadgeProps {
  status: ReturnType<typeof useEditorStore>['saveStatus'];
  isDirty: boolean;
}

function SaveStatusBadge({ status, isDirty }: SaveStatusBadgeProps): React.ReactElement {
  // Re-tick once per second when we're displaying a relative time so
  // "Saved 4s ago" advances. Cheap — only mounts when status.kind ===
  // 'saved'.
  const [now, setNow] = useTick(status.kind === 'saved' ? 1000 : null);

  let label: string;
  let color: string;
  switch (status.kind) {
    case 'idle':
      label = isDirty ? 'Unsaved changes' : 'Saved';
      color = isDirty ? 'var(--accent-purple-bright, #a78bfa)' : 'var(--fg-muted)';
      break;
    case 'pending':
      label = 'Saving…';
      color = 'var(--fg-muted)';
      break;
    case 'saving':
      label = 'Saving…';
      color = 'var(--fg-muted)';
      break;
    case 'saved':
      label = `Saved · ${relativeTimeShort(status.at, now)}`;
      color = 'var(--fg-muted)';
      break;
    case 'conflict':
      label = 'Conflict — see banner';
      color = '#f87171';
      break;
    case 'error':
      label = `Save error: ${status.message.slice(0, 50)}`;
      color = '#f87171';
      break;
  }

  // setNow is unused (the tick hook drives `now`); keep destructure
  // to silence the lint rule.
  void setNow;

  return (
    <span className="text-xs tabular-nums" style={{ color }}>
      {label}
    </span>
  );
}

/** Re-render every `intervalMs` ms. Pass `null` to pause. */
/** Flat-string version of the save status for the StatusBar. The
 *  toolbar already shows a colored badge; the status bar just needs
 *  one short label that fits on a single line at the bottom. */
function statusBarSaveLabel(
  status: ReturnType<typeof useEditorStore>['saveStatus'],
  isDirty: boolean,
): string {
  switch (status.kind) {
    case 'idle':
      return isDirty ? 'Unsaved' : 'Saved';
    case 'pending':
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'conflict':
      return 'Conflict';
    case 'error':
      return 'Save error';
  }
}

function useTick(intervalMs: number | null): [number, (n: number) => void] {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const handle = setInterval(() => setN(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return [n, setN];
}

// ─── Conflict banner ───────────────────────────────────────────────

function ConflictBanner({ onReload }: { onReload: () => void }): React.ReactElement {
  return (
    <div
      className="p-3 rounded-lg border flex items-center justify-between gap-3"
      style={{
        borderColor: '#f87171',
        background: 'rgba(248, 113, 113, 0.08)',
      }}
    >
      <div className="text-sm" style={{ color: '#fca5a5' }}>
        This project was edited elsewhere. Your unsaved changes will be lost.
      </div>
      <button
        type="button"
        onClick={onReload}
        className="text-xs px-3 py-1.5 rounded border transition-colors hover:bg-white/5"
        style={{ borderColor: '#f87171', color: '#fca5a5' }}
      >
        Reload from server
      </button>
    </div>
  );
}
