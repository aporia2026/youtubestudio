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
import { Player, type PlayerRef } from '@remotion/player';
import { YouTubeVideo } from '@/remotion/compositions/YouTubeVideo';
import {
  productionDocToVideoConfig,
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
  type EditorCommand,
} from '@/lib/editor/store';
import { useEditorStore } from '@/lib/editor/use-editor-store';
import { Timeline } from '@/components/editor/Timeline';
import { ShotInspector } from '@/components/editor/ShotInspector';
import { StatusBar } from '@/components/editor/StatusBar';
import { EditorChrome } from '@/components/editor/EditorChrome';
import { EditorHeader } from '@/components/editor/EditorHeader';
import { TransportBar, type PlaybackRate } from '@/components/editor/TransportBar';
import { EditorLeftRail } from '@/components/editor/EditorLeftRail';
import { EditorInspector, type InspectorTabId } from '@/components/editor/EditorInspector';
import { deriveAlignmentStatus } from '@/lib/editor/alignment-status';
import { computeAutoShiftYPct } from '@/remotion/utils';
import { TransformOverlay } from '@/components/editor/TransformOverlay';
import { BROLL_MODELS } from '@/lib/broll-types';
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
import { BrandKitModal } from '@/components/editor/BrandKitModal';
import { ShotsTab } from '@/components/editor/leftrail/ShotsTab';
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
} from '@/lib/editor/settings';
import { NarrationStrip } from '@/components/editor/NarrationStrip';
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
import { SetDurationPopover } from '@/components/editor/SetDurationPopover';

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
  );
  const { state, apply, flushSave, reloadFromServer, saveStatus, canUndo, canRedo } = store;

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
  const writeRowAsset = useCallback(
    (rowIndex: number, slot: 'image' | 'overlay' | 'clip', value: unknown) => {
      void (async () => {
        try {
          const res = await fetch(`/api/edit/${encodeURIComponent(projectId)}/row-asset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowIndex, slot, value }),
          });
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            console.warn('[editor row-asset] write failed', {
              rowIndex,
              slot,
              status: res.status,
              detail: detail.slice(0, 200),
            });
            return;
          }
          const data = (await res.json().catch(() => ({}))) as { version?: number };
          if (typeof data.version === 'number') {
            // Keep the editor's local version aligned with the server.
            // Without this sync the next debounced PATCH would fail
            // the optimistic check and surface a spurious conflict.
            apply({ type: 'SYNC_SERVER_VERSION', version: data.version });
          }
          console.info('[editor row-asset] written', { rowIndex, slot, newVersion: data.version });
        } catch (err) {
          console.warn('[editor row-asset] write threw', {
            rowIndex,
            slot,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    },
    [apply, projectId],
  );

  // Commit a row image: dispatch locally AND persist via row-asset.
  const commitRowImage = useCallback(
    (rowIndex: number, url: string | null) => {
      apply({ type: 'SET_ROW_IMAGE', shotIndex: rowIndex, url });
      writeRowAsset(rowIndex, 'image', url);
    },
    [apply, writeRowAsset],
  );

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
  useEffect(() => {
    const stylePresetId = state.doc.style_preset;
    if (!stylePresetId) {
      setActiveStyleI2IModel(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/production-doc/styles');
        if (!res.ok || cancelled) return;
        const data = await res.json() as {
          styles?: Array<{
            id: string;
            origin?: 'built-in' | 'saved';
            preferred_cloud_model?: string;
          }>;
        };
        const match = (data.styles ?? []).find(s => s.id === stylePresetId);
        if (cancelled) return;
        if (match && match.origin === 'saved' && match.preferred_cloud_model) {
          setActiveStyleI2IModel(match.preferred_cloud_model);
        } else {
          setActiveStyleI2IModel(null);
        }
      } catch {
        // Network/parse failures aren't fatal — cost hint just doesn't show.
        if (!cancelled) setActiveStyleI2IModel(null);
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
          const acRes = await fetch('/api/user/settings/active-channel');
          if (!acRes.ok) return;
          const ac = (await acRes.json()) as { active_channel_id: string | null };
          if (cancelled || !ac.active_channel_id) return;
          channelId = ac.active_channel_id;
        }
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
      await fetch('/api/editor-telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, project_id: projectId, payload }),
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

  /** Floating "Set duration…" popover anchored at the cursor. Used by
   *  shot context menus (timeline + ShotsTab) to edit `durationMs` via
   *  a slider+ms input pair. Apply dispatches RESIZE_SHOT. */
  const [durationPopover, setDurationPopover] = useState<
    | {
        kind: 'shot-duration';
        shotIndex: number;
        x: number;
        y: number;
        initialMs: number;
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

  const setRowVideoClip = useCallback(
    (
      rowIndex: number,
      clip: {
        status: string;
        videoUrl?: string;
        durationSeconds?: number;
        errorMessage?: string;
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

      broolKickoffInFlightRef.current.add(rowIndex);
      setRowVideoClip(rowIndex, { status: 'generating' }, true);

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
        // Record the clip id in the same localStorage map BrollCell
        // uses so the poll loop knows which id to query and so the
        // production-doc page sees the same clip on next load.
        const map = readBrollLsMap();
        map[brollRowSignatureInput({
          timecode: row.timecode,
          visual_description: row.visual_description,
        })] = stub.id;
        writeBrollLsMap(map);
        console.info('[editor broll] kickoff committed', { rowIndex, clipId: stub.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[editor broll] kickoff failed', { rowIndex, detail: msg });
        alert(`Couldn't kick off animation: ${msg}`);
        setRowVideoClip(rowIndex, null, true);
      } finally {
        broolKickoffInFlightRef.current.delete(rowIndex);
      }
    },
    [state.doc.rows, state.rowImages, userBrollModelId, projectId, setRowVideoClip],
  );

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
      // CRITICAL for server-side render: stream B-roll through the
      // app's proxy so the Lambda fetch has CORS-clean, presign-
      // stable URLs.
      useBrollProxy: true,
    });

    setRenderState({ status: 'rendering', progress: 0, renderId: null });
    console.info('[editor render] start', {
      rowCount: renderConfig.shots.length,
      hasVoiceover: Boolean(renderConfig.voiceoverUrl),
      title: state.doc.title || null,
    });

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
      const sig = brollRowSignatureInput({
        timecode: row.timecode,
        visual_description: row.visual_description,
      });
      const clipId = map[sig];
      if (clipId) out.push({ rowIndex, clipId });
    }
    return out;
    // Dep on the per-row signature inputs only, not the full doc.
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
          return r ? [k, r.timecode, r.visual_description] : [k, null, null];
        }),
    ),
  ]);

  useEffect(() => {
    if (brollPollTargets.length === 0) return;

    let cancelled = false;
    const tick = async () => {
      for (const { rowIndex, clipId } of brollPollTargets) {
        if (cancelled) return;
        try {
          const res = await fetch(`/api/broll/${encodeURIComponent(clipId)}`, {
            cache: 'no-store',
          });
          if (!res.ok) continue;
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
          if (!clip) continue;
          const status = typeof clip.status === 'string' ? clip.status : 'generating';
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
          }, false);
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
    };
  }, [brollPollTargets, setRowVideoClip]);

  /** Thin adapter so the ported handlers below read like their
   *  production-doc counterparts. Routes through PATCH_ROW so the
   *  edit lands on the undo stack + auto-save fires. */
  const updateRow = useCallback(
    (rowIndex: number, patch: Partial<ProductionDoc['rows'][number]>) => {
      apply({ type: 'PATCH_ROW', rowIndex, patch });
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
        const res = await fetch('/api/generate/production-doc/image/rmbg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalImageUrl: sourceUrl }),
        });
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
      // Bail on modifier combos that belong to other handlers
      // (Cmd/Ctrl+Z, Cmd/Ctrl+S already bound at the store layer).
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
      if (key === 'b') {
        e.preventDefault();
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
  }, [handleDelete, handleSplit, handleToggleMute, handleZoomDelta, state.playheadMs]);

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
          captions={state.captions}
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
              // Resolved i2i model for cost-preview rendering near the
              // Regenerate button. Null when the active style is a
              // built-in, has no preferred model, or the fetch failed.
              activeStyleI2IModel={activeStyleI2IModel}
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
    />
  );

  return (
    <>
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
          space for them. */}

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
                  const res = await fetch('/api/generate/production-doc/image/edit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      originalImageUrl: state.rowImages[rowIndex],
                      prompt,
                      optionId: appliedOption.id,
                      mask: { url: maskUrl },
                    }),
                  });
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
                  const res = await fetch('/api/generate/production-doc/image/edit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      originalImageUrl: state.rowImages[rowIndex],
                      intent: 'erase',
                      mask: { url: maskUrl },
                    }),
                  });
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
            captions: state.captions,
            playheadMs: state.playheadMs,
            splitTarget,
            rmbgInflight,
            apply,
            selectShotFromUser,
            setLaneFocus,
            setShowVoRegen,
            setDurationPopover,
            handleDelete,
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

      {/* Set-duration popover — opens from the shot / ShotsTab
          context menu's "Set duration…" item. Apply dispatches
          RESIZE_SHOT (the same path the trailing-edge drag uses)
          so undo / redo Just Work. */}
      {durationPopover && (
        <SetDurationPopover
          title={`Shot ${durationPopover.shotIndex + 1} duration`}
          x={durationPopover.x}
          y={durationPopover.y}
          initialMs={durationPopover.initialMs}
          minMs={EDITOR_MIN_SHOT_MS}
          maxMs={EDITOR_MAX_SHOT_MS}
          stepMs={100}
          onApply={(ms) => {
            apply({
              type: 'RESIZE_SHOT',
              shotIndex: durationPopover.shotIndex,
              durationMs: ms,
            });
          }}
          onClose={() => setDurationPopover(null)}
        />
      )}
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
  captions: { segments: { start: number; end: number; text: string }[] } | undefined;
  playheadMs: number;
  splitTarget: { shotIndex: number; splitAtMs: number; validSplit: boolean } | null;
  rmbgInflight: Set<number>;
  apply: (cmd: EditorCommand) => void;
  selectShotFromUser: (shotIndex: number, source: string) => void;
  setLaneFocus: (kind: 'audio' | 'captions' | 'overlays' | null) => void;
  setShowVoRegen: (open: boolean) => void;
  setDurationPopover: (
    p:
      | { kind: 'shot-duration'; shotIndex: number; x: number; y: number; initialMs: number }
      | null,
  ) => void;
  handleDelete: (mode: 'ripple' | 'blank') => void;
  openImageEdit: (shotIndex: number) => void;
  handleRunRmbg: (shotIndex: number) => void;
  handleRestoreOriginalBackground: (shotIndex: number) => void;
}): OverlayContextMenuItem[] {
  const {
    menu,
    doc,
    rowImages,
    captions,
    playheadMs,
    splitTarget,
    rmbgInflight,
    apply,
    selectShotFromUser,
    setLaneFocus,
    setShowVoRegen,
    setDurationPopover,
    handleDelete,
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
      const currentDurationMs = (() => {
        // Read the same duration the timeline draws: row's
        // `duration_override_ms` if present, else fall back to the
        // doc's parsed timecode delta. The split-target helper
        // computed it cleanly when it was active, but it isn't
        // always — so we re-derive from the row here.
        const dur = row.duration_override_ms;
        if (typeof dur === 'number') return dur;
        // Fallback: a sensible 4s if neither override nor timecode
        // delta is available. The popover clamps anyway.
        return 4000;
      })();

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
          label: 'Set duration…',
          onClick: () =>
            setDurationPopover({
              kind: 'shot-duration',
              shotIndex: i,
              x: menu.x,
              y: menu.y,
              initialMs: currentDurationMs,
            }),
          title: 'Dial in a new duration via slider or numeric input',
        },
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
          onClick: () => {
            // handleDelete reads state.selection; ensure we select
            // THIS shot before dispatching so the menu's row is the
            // one removed regardless of what was selected before.
            selectShotFromUser(i, `${menu.kind}-delete-ripple`);
            // Defer so the SET_SELECTION lands before the delete.
            Promise.resolve().then(() => handleDelete('ripple'));
          },
          disabled: !canDelete,
          separatorAbove: !hasTrim,
          destructive: true,
          title: canDelete
            ? 'Remove this shot and pull every later shot earlier'
            : 'Can\'t delete the last remaining shot',
        },
        {
          label: 'Delete shot (keep slot)',
          onClick: () => {
            selectShotFromUser(i, `${menu.kind}-delete-blank`);
            Promise.resolve().then(() => handleDelete('blank'));
          },
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
