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
  initialEditorState,
  rowStartTimesMs,
} from '@/lib/editor/store';
import { useEditorStore } from '@/lib/editor/use-editor-store';
import { Timeline } from '@/components/editor/Timeline';
import { ShotInspector } from '@/components/editor/ShotInspector';
import { StatusBar } from '@/components/editor/StatusBar';
import { EditorChrome } from '@/components/editor/EditorChrome';
import {
  getDefaultZoomLevel,
  getShowThumbnails,
  getShowShortcutHints,
} from '@/lib/editor/settings';
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
import { OverlayContextMenu } from '@/components/production-doc/OverlayContextMenu';

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

  // Timeline zoom. Lives in the client because zoom is a viewing
  // preference, not part of the doc. The user's preferred default
  // comes from localStorage via `getDefaultZoomLevel()` (Phase 4b
  // settings audit); falls back to `ZOOM_DEFAULT_LEVEL` when the
  // setting is unset.
  const [zoomLevel, setZoomLevel] = useState<number>(() => getDefaultZoomLevel());
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
      channelId: payload.channelId,
      voiceoverAlignment: payload.voiceoverAlignment,
      flags: payload.flags,
      version,
    }),
    projectId,
  );
  const { state, apply, flushSave, reloadFromServer, saveStatus, canUndo, canRedo } = store;

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
    (rowIndex: number, clip: { status: string; videoUrl?: string; durationSeconds?: number } | null, transient = false) => {
      apply({ type: 'SET_ROW_VIDEO_CLIP', rowIndex, clip, transient });
    },
    [apply],
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
      const tier = pickModelForScene(userBrollModelId, sceneSeconds);
      console.info('[editor broll] kickoff', {
        rowIndex,
        userModelId: userBrollModelId,
        pickedModelId: tier.modelId,
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

  // Poll loop for in-flight clips. Walks state.rowVideoClips on each
  // tick, fetches /api/broll/{id} for any row whose status is
  // 'generating', and dispatches SET_ROW_VIDEO_CLIP on each status
  // change. The 'ready' transition lands as a non-transient command
  // so it goes on the undo stack (cleanly Cmd+Z'd if the user
  // changes their mind).
  useEffect(() => {
    const generatingRows: Array<{ rowIndex: number; clipId: string }> = [];
    const map = readBrollLsMap();
    Object.entries(state.rowVideoClips).forEach(([k, v]) => {
      if (!v || v.status !== 'generating') return;
      const rowIndex = Number(k);
      const row = state.doc.rows[rowIndex];
      if (!row) return;
      const sig = brollRowSignatureInput({
        timecode: row.timecode,
        visual_description: row.visual_description,
      });
      const clipId = map[sig];
      if (clipId) generatingRows.push({ rowIndex, clipId });
    });

    if (generatingRows.length === 0) return;

    let cancelled = false;
    const tick = async () => {
      for (const { rowIndex, clipId } of generatingRows) {
        if (cancelled) return;
        try {
          const res = await fetch(`/api/broll/${encodeURIComponent(clipId)}`, {
            cache: 'no-store',
          });
          if (!res.ok) continue;
          const data = (await res.json()) as {
            status?: string;
            video_url?: string | null;
            duration_seconds?: number | null;
          };
          if (cancelled) return;
          const status = typeof data.status === 'string' ? data.status : 'generating';
          if (status === 'generating' || status === 'pending') continue;
          // Terminal state — commit it through the non-transient
          // path so Cmd+Z reverses cleanly to the prior state.
          console.info('[editor broll] poll terminal', { rowIndex, clipId, status });
          setRowVideoClip(rowIndex, {
            status,
            videoUrl: data.video_url ?? undefined,
            durationSeconds: data.duration_seconds ?? undefined,
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
  }, [state.rowVideoClips, state.doc.rows, setRowVideoClip]);

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
    },
    [apply],
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
      return url ? { status: 'ready', imageUrl: url } : null;
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
      brand: state.brandKitOverride,
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
    state.brandKitOverride,
    state.voiceoverAlignment,
  ]);

  const inputProps = useMemo(() => (videoConfig ? { config: videoConfig } : null), [videoConfig]);

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

  // Keyboard shortcuts:
  //   B          → split at playhead (CapCut / FCP blade)
  //   Delete     → ripple-delete selected shot
  //   Shift+Del  → blank-delete selected shot (keeps the slot)
  // All shortcuts are ignored when focus is in a text input so
  // typing in a future inline editor doesn't trigger them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      // Bail on modifier combos that belong to other handlers
      // (Cmd/Ctrl+Z, Cmd/Ctrl+S already bound at the store layer).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
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
  }, [handleDelete, handleSplit, handleToggleMute, handleZoomDelta]);

  // Subscribe to frame updates so the playhead reflects the live
  // play position. Throttled at the ms-rounded level so React only
  // re-renders the toolbar when the integer ms value changes.
  const playerRef = useRef<PlayerRef>(null);
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

  // Phase 1 of `_plans/2026-05-19-editor-real-nle-look.md` slices the
  // editor into named slots that mount into a CSS-grid chrome. The
  // existing toolbar / preview / inspector / timeline content stays
  // identical — only the surrounding layout changed. Phases 2-5
  // incrementally replace each slot's content with CapCut-style
  // components.
  const headerSlot = (
    <div className="flex items-center justify-between gap-3 flex-wrap h-full px-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">
            {payload.title || state.doc.title || 'Untitled project'}
          </h1>
          <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>
            {state.doc.rows.length} shots · {state.doc.total_duration} · version {state.version}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <SaveStatusBadge status={saveStatus} isDirty={state.isDirty} />

          <button
            type="button"
            onClick={() => setShowDriftReport(true)}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title="Show voiceover drift report — narration vs shot durations"
          >
            Drift report
          </button>

          <button
            type="button"
            onClick={() => setShowOverlayManager(true)}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title="Add or edit doc-level text overlays"
          >
            Overlays
            {state.doc.text_overlays && state.doc.text_overlays.length > 0 && (
              <span className="ml-1 tabular-nums" style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}>
                ({state.doc.text_overlays.length})
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => { void handleRegenerateCaptions(); }}
            disabled={captionsRegenState.kind === 'running' || !state.voiceoverUrl}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ borderColor: 'var(--card-border)' }}
            title={
              state.voiceoverUrl
                ? 'Generate captions from the voiceover via gpt-4o-mini-transcribe'
                : 'Assign a voiceover first'
            }
          >
            {captionsRegenState.kind === 'running'
              ? 'Captioning…'
              : state.captions
                ? 'Regen captions'
                : 'Generate captions'}
          </button>

          <button
            type="button"
            onClick={() => setShowVoRegen(true)}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title="Regenerate the voiceover from the current scripts via ElevenLabs"
          >
            Regen VO
          </button>

          <button
            type="button"
            onClick={() => setShowRegenFromScript(true)}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title="Edit the full script and regenerate the doc (preserves your manual edits via edited_at)"
          >
            Regen doc
          </button>

          <button
            type="button"
            onClick={handleSplit}
            disabled={!splitTarget?.validSplit}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title={
              splitTarget?.validSplit
                ? `Split shot ${splitTarget.shotIndex + 1} at playhead (B)`
                : 'Move the playhead inside a shot to split it (B)'
            }
          >
            ✂ Split at playhead
          </button>

          <button
            type="button"
            onClick={() => handleDelete('ripple')}
            disabled={state.selection === null || state.doc.rows.length <= 1}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title={
              state.selection === null
                ? 'Select a shot to delete it (Delete)'
                : `Delete shot ${state.selection + 1} (Delete; Shift+Delete to keep the slot)`
            }
          >
            ✕ Delete
          </button>

          <button
            type="button"
            onClick={handleToggleMute}
            disabled={state.selection === null}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{
              borderColor: 'var(--card-border)',
              color:
                state.selection !== null && state.doc.rows[state.selection]?.muted
                  ? '#f87171'
                  : undefined,
            }}
            title={
              state.selection === null
                ? 'Select a shot to mute / unmute it (M)'
                : state.doc.rows[state.selection]?.muted
                  ? `Unmute shot ${state.selection + 1} (M)`
                  : `Mute shot ${state.selection + 1} (M)`
            }
          >
            {state.selection !== null && state.doc.rows[state.selection]?.muted
              ? 'Unmute'
              : 'Mute'}
          </button>

          {/* Doc-level flag toggles — Phase 3b of the parity
              refactor. Two compact pill-buttons next to mute. Each
              flip dispatches SET_FLAGS so undo / redo / autosave all
              pick it up. */}
          <button
            type="button"
            onClick={() =>
              apply({ type: 'SET_FLAGS', flags: { animateScenes: !state.flags.animateScenes } })
            }
            className="text-xs px-2.5 py-1.5 rounded border transition-colors hover:bg-white/5"
            style={{
              borderColor: 'var(--card-border)',
              color: state.flags.animateScenes ? 'var(--accent-purple-bright, #a78bfa)' : undefined,
            }}
            title={
              state.flags.animateScenes
                ? 'Animations on — B-roll clips play in their shots'
                : 'Animations off — every shot renders as a still + Ken Burns'
            }
          >
            {state.flags.animateScenes ? '🎬 Animate' : '🎬 Stills'}
          </button>
          <button
            type="button"
            onClick={() =>
              apply({
                type: 'SET_FLAGS',
                flags: { suppressLowerThirds: !state.flags.suppressLowerThirds },
              })
            }
            className="text-xs px-2.5 py-1.5 rounded border transition-colors hover:bg-white/5"
            style={{
              borderColor: 'var(--card-border)',
              color: state.flags.suppressLowerThirds
                ? 'var(--accent-purple-bright, #a78bfa)'
                : undefined,
            }}
            title={
              state.flags.suppressLowerThirds
                ? 'Lower-thirds hidden across all shots'
                : 'Lower-thirds visible — toggle to hide on-screen-text overlays'
            }
          >
            {state.flags.suppressLowerThirds ? '⤓ Lower-3rd off' : '⤓ Lower-3rd on'}
          </button>

          <button
            type="button"
            onClick={() => apply({ type: 'UNDO' })}
            disabled={!canUndo}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title="Undo (Cmd/Ctrl+Z)"
          >
            ↶ Undo
          </button>
          <button
            type="button"
            onClick={() => apply({ type: 'REDO' })}
            disabled={!canRedo}
            className="text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{ borderColor: 'var(--card-border)' }}
            title="Redo (Cmd/Ctrl+Shift+Z)"
          >
            ↷ Redo
          </button>
          <button
            type="button"
            onClick={() => { void flushSave(); }}
            disabled={!state.isDirty}
            className="text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
            style={{
              borderColor: state.isDirty ? 'var(--accent-purple-bright, #a78bfa)' : 'var(--card-border)',
              color: state.isDirty ? 'var(--accent-purple-bright, #a78bfa)' : undefined,
            }}
            title="Save now (Cmd/Ctrl+S)"
          >
            Save
          </button>
          <a
            href={`/api/edit/${encodeURIComponent(projectId)}/export?format=otio`}
            className="text-xs px-2.5 py-1.5 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: 'var(--card-border)' }}
            title="Download the timeline as OpenTimelineIO JSON. Importable into DaVinci Resolve, Premiere, and Final Cut via otioconvert."
          >
            Export .otio
          </a>

          <Link
            href="/production-doc"
            className="text-sm px-3 py-1.5 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: 'var(--card-border)' }}
          >
            ← Production Doc
          </Link>
        </div>
    </div>
  );

  const leftRailSlot = (
    <div className="h-full p-2 text-xs editor-scroll" style={{ color: 'var(--fg-muted)', overflow: 'auto' }}>
      <div className="font-medium mb-1" style={{ color: 'var(--fg)' }}>Tools</div>
      <p style={{ color: 'var(--fg-muted)' }}>
        Coming in Phase 3 — Shots / Media / Audio / Captions / AI Tools tabs.
        Use the toolbar above for now.
      </p>
    </div>
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

  const previewSlot = (
    <>
      {zoomStrip}
      {saveStatus.kind === 'conflict' && (
        <ConflictBanner
          onReload={() => {
            closeAllOverlayModals();
            void reloadFromServer();
          }}
        />
      )}
      <div
        className="rounded-lg overflow-hidden border flex-1 min-w-0 relative"
        style={{ borderColor: 'var(--card-border)', background: '#000' }}
      >
        <Player
          ref={playerRef}
          component={YouTubeVideo}
          inputProps={inputProps}
          durationInFrames={totalFrames}
          compositionWidth={videoConfig.width}
          compositionHeight={videoConfig.height}
          fps={videoConfig.fps}
          controls
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          acknowledgeRemotionLicense
        />
        {/* Captions are rendered INSIDE the Remotion composition
            via <CaptionsOverlay>, so they appear in both the editor
            preview AND in Lambda renders. No separate HTML overlay
            needed. */}
      </div>
    </>
  );

  const inspectorSlot =
    state.selection !== null && state.doc.rows[state.selection] ? (
      <div className="h-full editor-scroll" style={{ overflow: 'auto' }}>
        <ShotInspector
          shotIndex={state.selection}
          shot={videoConfig.shots[state.selection]}
          row={state.doc.rows[state.selection]}
          thumbnailUrl={state.rowImages[state.selection] ?? null}
          totalShots={state.doc.rows.length}
          projectId={projectId}
          onClose={() => apply({ type: 'SET_SELECTION', shotIndex: null })}
          onUploadImage={(url) =>
            apply({ type: 'SET_ROW_IMAGE', shotIndex: state.selection as number, url })
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
          brollModelId={userBrollModelId}
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
        />
      </div>
    ) : (
      <div className="h-full flex items-center justify-center p-4 text-xs text-center" style={{ color: 'var(--fg-muted)' }}>
        Select a shot on the timeline below to inspect or edit it.
      </div>
    );

  const timelineSlot = (
    <div className="h-full flex flex-col p-2 gap-2 editor-scroll" style={{ overflow: 'auto' }}>
      <Timeline
        config={videoConfig}
        rowImages={getShowThumbnails() ? state.rowImages : {}}
        selection={state.selection}
        playheadMs={state.playheadMs}
        rowTrims={rowTrims}
        pixelsPerSecond={pixelsPerSecond}
        onSelect={(shotIndex) => apply({ type: 'SET_SELECTION', shotIndex })}
        onResize={(shotIndex, durationMs) =>
          apply({ type: 'RESIZE_SHOT', shotIndex, durationMs })
        }
        onReorder={(fromIndex, toIndex) =>
          apply({ type: 'REORDER_SHOTS', fromIndex, toIndex })
        }
        onTrim={(shotIndex, values) =>
          apply({ type: 'TRIM_SHOT', shotIndex, ...values })
        }
        rowTransitions={rowTransitions}
        onToggleTransition={(shotIndex, transition) =>
          apply({ type: 'SET_TRANSITION_IN', shotIndex, transition })
        }
      />
      <StatusBar
        playheadMs={state.playheadMs}
        totalDurationMs={videoConfig.shots.reduce((acc, s) => acc + s.durationMs, 0)}
        selection={state.selection}
        selectionScriptPreview={
          state.selection !== null
            ? (state.doc.rows[state.selection]?.script_text ?? null)
            : null
        }
        saveStatusLabel={statusBarSaveLabel(saveStatus, state.isDirty)}
        showShortcutHints={getShowShortcutHints()}
        readiness={{
          shotCount: state.doc.rows.length,
          imageCount: Object.values(state.rowImages).filter(Boolean).length,
          clipCount: Object.values(state.rowVideoClips).filter((c) => c && c.status === 'ready').length,
          overlayPlannedCount: state.doc.rows.filter((r) => Boolean(r.overlay_stock_terms?.trim())).length,
          overlayReadyCount: Object.values(state.rowOverlays).filter((o) => o?.status === 'done').length,
          hasVoiceover: Boolean(state.voiceoverUrl),
          hasCaptions: Boolean(state.captions),
        }}
      />
    </div>
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
          onJumpToShot={(shotIndex) => apply({ type: 'SET_SELECTION', shotIndex })}
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
                  label: '✎ Edit image',
                  onClick: () => setOverlayEditRow(i),
                  disabled: overlayState?.status !== 'done',
                  title: 'Open the AI image-edit dialog',
                },
                {
                  label: '↻ Rethink placement',
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
                  label: '🔁 Replace overlay (re-search)',
                  onClick: () => {
                    void replaceOverlayForRow(i);
                  },
                  disabled: !row.overlay_stock_terms?.trim(),
                  title:
                    'Re-run Brave search + RMBG with the same stock terms (replaces the current overlay)',
                },
                {
                  label: '↶ Undo last edit',
                  onClick: () => undoOverlayEdit(i),
                  disabled: !canUndo,
                  separatorAbove: true,
                  title: canUndo
                    ? 'Restore the overlay from before the most recent AI edit'
                    : 'No edits to undo yet',
                },
                {
                  label: '↺ Reset to AI placement',
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
                  label: '✕ Remove overlay',
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
    </>
  );
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
