"use client";

/**
 * Per-row B-roll cell for the Production Doc table.
 *
 * Self-contained: owns its own status state + polling loop. The parent only
 * has to (a) feed in the row's identifying fields and prompt inputs, (b) hand
 * in the row's still-image URL (so image-to-video models can animate it), and
 * (c) persist the cell's `clipId` callback in localStorage so reload rehydrates
 * the same clip onto the same row.
 *
 * Lifecycle:
 *   1. idle               → no clip yet, show "Generate" button + model picker
 *   2. starting            → POST /api/broll in flight
 *   3. generating          → row exists, polling GET /api/broll/[id] every
 *                            BROLL_POLL_INTERVAL_MS until status flips
 *   4. ready                → render <video> with controls + actions
 *   5. failed               → show error + Retry
 *
 * Polling stops when status flips OR when the component unmounts. Tab
 * close mid-render is fine: the row stays in 'generating' in the DB and
 * the next page open advances it on first GET.
 *
 * Two model families surface in the picker:
 *   - Image-to-Video (Kling 2.5 turbo, Kling 2.6, Sora 2 i2v) — animates the
 *     row's existing still. REQUIRES `stillImageUrl`; button is disabled
 *     with a hint when no still is available.
 *   - Text-to-Video (Sora 2, Veo 3 fast/quality, Kling t2v) — generates from
 *     the prompt alone; works even on rows without a still.
 *
 * The user can mark any model as their personal default via the star icon
 * in the picker; the default is persisted on `collaborators` and applied
 * on every page load. See `/api/user/settings/broll-default`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BROLL_MODELS,
  DEFAULT_BROLL_MODEL_ID,
  findBrollModel,
  type BrollClipRow,
  type BrollModelDescriptor,
  type BrollModelId,
  type BrollModelKind,
} from '@/lib/broll-types';

const BROLL_POLL_INTERVAL_MS = 6000;

/**
 * localStorage key under which the cell remembers which clip belongs to a
 * given row signature. The production doc has no scriptId/projectId in
 * scope, so the cell self-rehydrates from this map on mount: signature →
 * clipId. When the doc is regenerated and the signature changes, the old
 * clip is orphaned (still accessible from the workspace clip library
 * via /api/broll, just no longer auto-attached to a row).
 */
const BROLL_LS_KEY = 'prodoc_broll_v1';

type BrollLsMap = Record<string, string>; // signature → clipId

/**
 * Read the (rowSignature → clipId) map. Exported so the page can
 * persist the same mapping into history entries and walk it during
 * pre-render verification ("does state match what's been generated?").
 */
export function readBrollLsMap(): BrollLsMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(BROLL_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as BrollLsMap) : {};
  } catch {
    return {};
  }
}

/** Write the (rowSignature → clipId) map. Exported so the page's
 *  DB-hydration effect can seed the same per-cell shortcut the
 *  individual cells use on their own mount. */
export function writeBrollLsMap(map: BrollLsMap) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BROLL_LS_KEY, JSON.stringify(map));
  } catch {
    /* storage full — best-effort only */
  }
}

/**
 * Shared kick-off helper. Same code path as the per-cell "Generate" button,
 * exposed so a page-level "Animate all" batch can drive many rows at once
 * without re-implementing the POST + LS write contract.
 *
 * Returns a transient `BrollClipRow` stub (status='generating') the caller
 * can push into the cell's `initialClip` prop; the cell's adoption effect
 * picks it up and starts polling.
 *
 * Throws on validation / network failure — the caller decides whether to
 * abort the batch or skip the row.
 */
export interface KickoffBrollGenerationArgs {
  projectId?: string | null;
  scriptId?: string | null;
  /** Production-doc history entry id, when the doc is saved. NULL for
   *  unsaved docs — clip persists but isn't cross-device hydratable. See
   *  plan `_plans/2026-05-17-broll-doc-id-hydration.md`. */
  productionDocId?: string | null;
  rowIndex: number;
  rowSignature: string;
  visualDescription: string;
  aiImagePrompt?: string;
  styleHint?: string;
  stillImageUrl?: string;
  modelId: string;
}

export async function kickoffBrollGeneration(args: KickoffBrollGenerationArgs): Promise<BrollClipRow> {
  const model = findBrollModel(args.modelId);
  const isI2v = model?.kind === 'image-to-video';

  const res = await fetch('/api/broll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: args.projectId ?? null,
      scriptId: args.scriptId ?? null,
      productionDocId: args.productionDocId ?? null,
      rowSignature: args.rowSignature,
      rowIndex: args.rowIndex,
      visualDescription: args.visualDescription,
      aiImagePrompt: args.aiImagePrompt || undefined,
      styleHint: args.styleHint || undefined,
      modelId: args.modelId,
      aspectRatio: '16:9',
      stillImageUrl: isI2v ? args.stillImageUrl : undefined,
    }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as { error?: string }).error || `Request failed (${res.status})`);
  }
  const data = (await res.json()) as { id: string };

  const stub: BrollClipRow = {
    id: data.id,
    workspace_id: '',
    project_id: args.projectId ?? null,
    source_script_id: args.scriptId ?? null,
    row_signature: args.rowSignature,
    row_index: args.rowIndex,
    production_doc_id: args.productionDocId ?? null,
    prompt: '',
    model_id: args.modelId,
    provider: 'kie',
    aspect_ratio: '16:9',
    duration_seconds: null,
    status: 'generating',
    task_id: null,
    error_message: null,
    video_url: null,
    blob_pathname: null,
    thumbnail_url: null,
    width: null,
    height: null,
    notes: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
  };

  // Persist the signature → clipId mapping the same way the per-cell
  // generate path does, so reload re-attaches the clip even if the page
  // closes before polling finishes.
  const map = readBrollLsMap();
  map[args.rowSignature] = data.id;
  writeBrollLsMap(map);

  return stub;
}

// ─── Lock-as-still localStorage layer ──────────────────────────────────────
//
// Lives at module scope so the page-level batch handler and the BrollCell
// share a single source of truth. Keyed by `rowSignature` (same key space
// as the clip map) so locks survive doc regeneration when the row's
// timecode + visual_description still match.

const BROLL_LOCK_LS_KEY = 'prodoc_broll_lock_v1';
type BrollLockMap = Record<string, true>;

export function readBrollLockMap(): BrollLockMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(BROLL_LOCK_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: BrollLockMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeBrollLockMap(map: BrollLockMap) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BROLL_LOCK_LS_KEY, JSON.stringify(map));
  } catch {
    /* storage full — best-effort only */
  }
}

/**
 * In-memory cache of the resolved user default so the picker doesn't fetch
 * once per cell. The first BrollCell to mount fetches; subsequent cells
 * read the cached value synchronously. Cache is cleared on PUT so the new
 * default propagates immediately across every cell on the page.
 */
let userDefaultCache: { modelId: BrollModelId; isExplicit: boolean } | null = null;
let userDefaultPromise: Promise<{ modelId: BrollModelId; isExplicit: boolean }> | null = null;
const userDefaultListeners = new Set<(next: { modelId: BrollModelId; isExplicit: boolean }) => void>();

async function fetchUserDefault(): Promise<{ modelId: BrollModelId; isExplicit: boolean }> {
  if (userDefaultCache) return userDefaultCache;
  if (userDefaultPromise) return userDefaultPromise;
  userDefaultPromise = (async () => {
    try {
      const res = await fetch('/api/user/settings/broll-default', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { modelId?: string; isExplicit?: boolean };
      const modelId = data.modelId && findBrollModel(data.modelId) ? data.modelId : DEFAULT_BROLL_MODEL_ID;
      const resolved = { modelId, isExplicit: Boolean(data.isExplicit) };
      userDefaultCache = resolved;
      return resolved;
    } catch {
      // Network failure — fall back to library default. The picker still works.
      const fallback = { modelId: DEFAULT_BROLL_MODEL_ID, isExplicit: false };
      userDefaultCache = fallback;
      return fallback;
    } finally {
      userDefaultPromise = null;
    }
  })();
  return userDefaultPromise;
}

async function saveUserDefault(modelId: BrollModelId | null): Promise<void> {
  const res = await fetch('/api/user/settings/broll-default', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { modelId?: string; isExplicit?: boolean };
  const next = {
    modelId: data.modelId && findBrollModel(data.modelId) ? data.modelId : DEFAULT_BROLL_MODEL_ID,
    isExplicit: Boolean(data.isExplicit),
  };
  userDefaultCache = next;
  userDefaultListeners.forEach((fn) => fn(next));
}

export interface BrollCellProps {
  /** Project the clip should be attached to (for cross-session listing). Optional. */
  projectId?: string | null;
  /** Source script id, if known (production doc may not have one). */
  scriptId?: string | null;
  /** Production-doc history entry id, when the doc is saved. Tagged on
   *  the clip server-side so the page can DB-hydrate clips on mount
   *  across devices. NULL when the doc isn't saved yet — falls back to
   *  the per-cell localStorage map for recovery. See plan
   *  `_plans/2026-05-17-broll-doc-id-hydration.md`. */
  productionDocId?: string | null;
  /** Stable row index (drives display order). */
  rowIndex: number;
  /** Stable signature of the row's identifying fields, for rehydration. */
  rowSignature: string;
  /** The row's editor-facing visual direction. */
  visualDescription: string;
  /** The row's full scene prompt for AI image gen, if any. */
  aiImagePrompt?: string;
  /** Production-doc style suffix appended to every video prompt. */
  styleHint?: string;
  /** The URL of the row's already-generated still. Image-to-video models
   *  REQUIRE this; when absent and the resolved default is i2v, the
   *  Generate button is disabled with a hint. Undefined when the row's
   *  image is still generating or never started. */
  stillImageUrl?: string;
  /** Existing clip rehydrated from a previous fetch — when present, cell
   *  starts in the right phase (generating | ready | failed) without a
   *  fresh POST. Also adopted as a NEW state when the parent assigns a
   *  fresh stub mid-session (e.g. the "Animate all" batch creates one
   *  for this row); the cell picks up the new id and kicks off polling. */
  initialClip?: BrollClipRow | null;
  /** Notified whenever the cell creates / advances / clears a clip so the
   *  parent can persist {rowIndex → clipId} mapping in localStorage. */
  onClipChange?: (clip: BrollClipRow | null) => void;
  /** "Lock as still" — when true, the row's generated clip is ignored at
   *  render time and the still + Ken Burns path is used instead. The
   *  clip itself is preserved so unlocking restores the animation
   *  without re-generation. Controlled by the parent (page-level state
   *  persisted in localStorage). */
  lockedAsStill?: boolean;
  /** Toggle the lock state. Parent persists. */
  onToggleLockedAsStill?: (next: boolean) => void;
}

type Phase = 'idle' | 'starting' | 'generating' | 'ready' | 'failed';

function phaseFromClip(clip: BrollClipRow | null | undefined): Phase {
  if (!clip) return 'idle';
  if (clip.status === 'ready') return 'ready';
  if (clip.status === 'failed') return 'failed';
  return 'generating';
}

export function BrollCell({
  projectId,
  scriptId,
  productionDocId,
  rowIndex,
  rowSignature,
  visualDescription,
  aiImagePrompt,
  styleHint,
  stillImageUrl,
  initialClip,
  onClipChange,
  lockedAsStill = false,
  onToggleLockedAsStill,
}: BrollCellProps) {
  const [clip, setClip] = useState<BrollClipRow | null>(initialClip ?? null);
  const [phase, setPhase] = useState<Phase>(phaseFromClip(initialClip));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [defaultModelId, setDefaultModelId] = useState<BrollModelId>(DEFAULT_BROLL_MODEL_ID);
  const [modelId, setModelId] = useState<BrollModelId>(DEFAULT_BROLL_MODEL_ID);
  const [modelIdLocked, setModelIdLocked] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const model = useMemo(() => findBrollModel(modelId), [modelId]);
  const isI2v = model?.kind === 'image-to-video';
  const needsStill = isI2v && !stillImageUrl;

  const onClipChangeRef = useRef(onClipChange);
  useEffect(() => {
    onClipChangeRef.current = onClipChange;
  }, [onClipChange]);

  // Subscribe to the user-default cache so a star-click in any cell on the
  // page propagates here immediately. The first cell to mount triggers the
  // GET; the rest read from cache. We only adopt the new default into our
  // local `modelId` if the user hasn't manually changed the picker (i.e.,
  // `modelIdLocked` is false).
  useEffect(() => {
    let cancelled = false;
    fetchUserDefault().then((resolved) => {
      if (cancelled) return;
      setDefaultModelId(resolved.modelId);
      setModelId((current) => (modelIdLocked ? current : resolved.modelId));
    });
    const listener = (next: { modelId: BrollModelId; isExplicit: boolean }) => {
      setDefaultModelId(next.modelId);
      setModelId((current) => (modelIdLocked ? current : next.modelId));
    };
    userDefaultListeners.add(listener);
    return () => {
      cancelled = true;
      userDefaultListeners.delete(listener);
    };
  }, [modelIdLocked]);

  const updateClip = useCallback(
    (next: BrollClipRow | null) => {
      setClip(next);
      setPhase(phaseFromClip(next));
      onClipChangeRef.current?.(next);
      // Persist (signature → clipId) so reload + doc regeneration
      // (when the signature still matches) re-attaches the clip.
      const map = readBrollLsMap();
      if (next?.id) {
        map[rowSignature] = next.id;
      } else {
        delete map[rowSignature];
      }
      writeBrollLsMap(map);
    },
    [rowSignature],
  );

  // Adopt a freshly-assigned initialClip after mount. Used by the page's
  // "Animate all" batch: it kicks off generation for every eligible row,
  // gets back a stub, and pushes it down here. The cell flips to
  // 'generating' so the existing polling loop picks the job up.
  // We compare by id to avoid spurious resets when the parent re-creates
  // an equivalent stub object.
  const initialClipId = initialClip?.id ?? null;
  useEffect(() => {
    if (!initialClipId) return;
    setClip((prev) => {
      if (prev && prev.id === initialClipId) return prev;
      // Only adopt when we don't already have a clip — never blow away a
      // ready clip the user might be inspecting.
      if (prev) return prev;
      setPhase(phaseFromClip(initialClip));
      return initialClip ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialClipId]);

  // On mount: if we don't have a clip already (no initialClip prop) but the
  // localStorage map remembers one for this signature, fetch + hydrate.
  //
  // CRITICAL: route hydration through `updateClip`, NOT raw `setClip`. The
  // raw setters update only the cell's internal state; `updateClip` also
  // fires `onClipChange` which propagates to the parent's `rowVideoClips`
  // map — and that map is what the Remotion renderer reads from. The
  // earlier raw-setClip path silently left the parent's state empty, so
  // a refresh that hydrated the cell visually was still producing
  // stills-only renders. See `_plans/2026-05-17-render-state-hardening.md`.
  useEffect(() => {
    if (initialClip || clip) return;
    const map = readBrollLsMap();
    const remembered = map[rowSignature];
    if (!remembered) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/broll/${remembered}`, { cache: 'no-store' });
        if (!res.ok) {
          // 404 → the clip was deleted server-side; clean up the stale entry.
          if (res.status === 404) {
            const next = readBrollLsMap();
            delete next[rowSignature];
            writeBrollLsMap(next);
          }
          return;
        }
        const data = (await res.json()) as { clip?: BrollClipRow };
        if (cancelled || !data.clip) return;
        console.info('[broll hydrate]', {
          rowIndex,
          rowSignature,
          clipId: data.clip.id,
          status: data.clip.status,
        });
        updateClip(data.clip);
      } catch {
        /* network hiccup — leave cell idle, user can regenerate */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSignature]);

  const hasGenerableInput = useMemo(
    () => Boolean((aiImagePrompt && aiImagePrompt.trim().length >= 20) || (visualDescription && visualDescription.trim().length >= 20)),
    [aiImagePrompt, visualDescription],
  );

  const generateDisabled = !hasGenerableInput || needsStill;
  const generateHint = !hasGenerableInput
    ? 'Add a richer visual description (≥ 20 characters) before generating.'
    : needsStill
    ? 'This model animates an existing still. Generate the row’s image first.'
    : `Generate with ${model?.label ?? modelId}`;

  // Lazy poll: when phase=generating, fetch GET every interval until the
  // status flips. The endpoint advances state inline on each call.
  useEffect(() => {
    if (phase !== 'generating' || !clip?.id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/broll/${clip.id}`, { cache: 'no-store' });
        if (!res.ok) {
          if (cancelled) return;
          timer = setTimeout(poll, BROLL_POLL_INTERVAL_MS);
          return;
        }
        const data = (await res.json()) as { clip?: BrollClipRow };
        if (cancelled) return;
        if (data.clip) {
          updateClip(data.clip);
          if (data.clip.status === 'generating' || data.clip.status === 'pending') {
            timer = setTimeout(poll, BROLL_POLL_INTERVAL_MS);
          }
        } else {
          timer = setTimeout(poll, BROLL_POLL_INTERVAL_MS);
        }
      } catch {
        if (cancelled) return;
        timer = setTimeout(poll, BROLL_POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(poll, BROLL_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, clip?.id, updateClip]);

  const startGeneration = useCallback(async () => {
    if (!hasGenerableInput) {
      setErrorMsg('Add a richer visual description (≥ 20 characters) before generating.');
      setPhase('failed');
      return;
    }
    if (isI2v && !stillImageUrl) {
      setErrorMsg('This model animates an existing still. Generate the row’s image first.');
      setPhase('failed');
      return;
    }
    setPhase('starting');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/broll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectId ?? null,
          scriptId: scriptId ?? null,
          productionDocId: productionDocId ?? null,
          rowSignature,
          rowIndex,
          visualDescription,
          aiImagePrompt: aiImagePrompt || undefined,
          styleHint: styleHint || undefined,
          modelId,
          aspectRatio: '16:9',
          stillImageUrl: isI2v ? stillImageUrl : undefined,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error((errBody as { error?: string }).error || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { id: string };
      // We have an id but no full row yet — synthesise a transient stub so the
      // poll effect can kick in. The first GET will replace it.
      const stub: BrollClipRow = {
        id: data.id,
        workspace_id: '',
        project_id: projectId ?? null,
        source_script_id: scriptId ?? null,
        row_signature: rowSignature,
        row_index: rowIndex,
        production_doc_id: productionDocId ?? null,
        prompt: '',
        model_id: modelId,
        provider: 'kie',
        aspect_ratio: '16:9',
        duration_seconds: null,
        status: 'generating',
        task_id: null,
        error_message: null,
        video_url: null,
        blob_pathname: null,
        thumbnail_url: null,
        width: null,
        height: null,
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
      };
      updateClip(stub);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start generation';
      setErrorMsg(msg);
      setPhase('failed');
    }
  }, [
    hasGenerableInput,
    isI2v,
    stillImageUrl,
    projectId,
    scriptId,
    rowSignature,
    rowIndex,
    visualDescription,
    aiImagePrompt,
    styleHint,
    modelId,
    updateClip,
  ]);

  const deleteClip = useCallback(async () => {
    if (!clip?.id) {
      updateClip(null);
      setErrorMsg(null);
      return;
    }
    try {
      await fetch(`/api/broll/${clip.id}`, { method: 'DELETE' });
    } catch {
      // Best-effort; the row will be reaped if/when the user revisits.
    }
    updateClip(null);
    setErrorMsg(null);
  }, [clip?.id, updateClip]);

  // ─── Render ────────────────────────────────────────────────────────────

  // Locked-as-still short-circuits every phase. The clip itself is preserved
  // so toggling unlocks it back into the render — no regeneration cost.
  if (lockedAsStill) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: 'rgba(120,120,120,0.18)', color: 'var(--text-muted)' }}>
          🔒 Locked — using still
        </span>
        <button
          type="button"
          onClick={() => onToggleLockedAsStill?.(false)}
          className="text-[10px] px-1 py-0.5 rounded self-start"
          style={{ background: 'transparent', color: 'var(--text-muted)', textDecoration: 'underline' }}
          title="Allow animation for this row"
        >
          Unlock
        </button>
      </div>
    );
  }

  if (phase === 'idle') {
    return (
      <div className="flex flex-col gap-1 relative">
        <button
          type="button"
          disabled={generateDisabled}
          onClick={startGeneration}
          className="text-xs px-2 py-1 rounded whitespace-nowrap"
          style={{
            background: generateDisabled ? 'rgba(120,120,120,0.08)' : 'rgba(168,85,247,0.12)',
            color: generateDisabled ? 'var(--text-muted)' : '#c084fc',
            cursor: generateDisabled ? 'not-allowed' : 'pointer',
          }}
          title={generateHint}
        >
          {isI2v ? '▶ Animate' : '▶ B-roll'}
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="text-[10px] px-1 py-0.5 rounded flex-1 text-left"
            style={{ background: 'rgba(120,120,120,0.10)', color: 'var(--text-muted)' }}
            title="Pick model"
          >
            {modelLabel(modelId)} ▾
          </button>
          {onToggleLockedAsStill && (
            <button
              type="button"
              onClick={() => onToggleLockedAsStill(true)}
              className="text-[10px] px-1 py-0.5 rounded"
              style={{ background: 'transparent', color: 'var(--text-muted)' }}
              title="Lock as still — never animate this row"
              aria-label="Lock as still"
            >
              🔓
            </button>
          )}
        </div>
        {needsStill && (
          <span className="text-[10px]" style={{ color: 'var(--text-muted)', maxWidth: 130 }}>
            Generate the still first
          </span>
        )}
        {pickerOpen && (
          <ModelPicker
            value={modelId}
            defaultModelId={defaultModelId}
            hasStill={Boolean(stillImageUrl)}
            onChange={(id) => {
              setModelId(id);
              setModelIdLocked(true);
              setPickerOpen(false);
            }}
            onMakeDefault={async (id) => {
              try {
                await saveUserDefault(id);
              } catch {
                /* surfacing this in a cell-level toast would need parent wiring; swallow for now */
              }
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    );
  }

  if (phase === 'starting') {
    return <span className="text-xs" style={{ color: 'var(--text-muted)' }}>queueing…</span>;
  }

  if (phase === 'generating') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="spinner" style={{ width: 14, height: 14 }} />
        <span className="text-[10px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
          rendering
        </span>
        <button
          type="button"
          onClick={deleteClip}
          className="text-[10px] px-1 rounded"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
          title="Cancel + delete"
        >
          ✕
        </button>
      </div>
    );
  }

  if (phase === 'ready' && clip?.video_url) {
    return (
      <div className="flex flex-col gap-1">
        <video
          src={clip.video_url}
          controls
          preload="metadata"
          style={{
            width: 120,
            maxHeight: 70,
            borderRadius: 5,
            border: '1px solid var(--border)',
            background: '#000',
          }}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              updateClip(null);
              setErrorMsg(null);
              startGeneration();
            }}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(168,85,247,0.10)', color: '#c084fc' }}
            title="Regenerate"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={deleteClip}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
            title="Delete"
          >
            ✕
          </button>
          {onToggleLockedAsStill && (
            <button
              type="button"
              onClick={() => onToggleLockedAsStill(true)}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: 'transparent', color: 'var(--text-muted)' }}
              title="Lock as still — render this row from the still image, ignoring the clip"
              aria-label="Lock as still"
            >
              🔓
            </button>
          )}
          {clip.model_id && (
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
              {modelLabel(clip.model_id as BrollModelId)}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'failed') {
    const msg = errorMsg || clip?.error_message || 'Generation failed';
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[11px]" style={{ color: '#f87171' }} title={msg}>
          ⚠ {truncate(msg, 28)}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              updateClip(null);
              setErrorMsg(null);
              startGeneration();
            }}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
          >
            Retry
          </button>
          {clip?.id && (
            <button
              type="button"
              onClick={deleteClip}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(120,120,120,0.10)', color: 'var(--text-muted)' }}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}

function modelLabel(id: BrollModelId): string {
  return BROLL_MODELS.find((m) => m.id === id)?.label ?? id;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
}

/** Picker is grouped: image-to-video first (recommended path for rows that
 *  already have a still), text-to-video below. Each row shows label + price.
 *  The user's current default has a filled star; clicking the star on a
 *  different row promotes it to the new default. */
function ModelPicker({
  value,
  defaultModelId,
  hasStill,
  onChange,
  onMakeDefault,
  onClose,
}: {
  value: BrollModelId;
  defaultModelId: BrollModelId;
  hasStill: boolean;
  onChange: (id: BrollModelId) => void;
  onMakeDefault: (id: BrollModelId) => void | Promise<void>;
  onClose: () => void;
}) {
  const grouped = useMemo(() => groupModelsByKind(BROLL_MODELS), []);
  return (
    <div
      className="absolute z-20 mt-6 rounded shadow-lg p-1 flex flex-col gap-1"
      style={{
        background: 'var(--bg-elevated, #1a1a1a)',
        border: '1px solid var(--border)',
        minWidth: 240,
        top: 0,
      }}
      onMouseLeave={onClose}
    >
      {grouped.map((group) => (
        <div key={group.kind} className="flex flex-col gap-0.5">
          <div
            className="text-[9px] uppercase tracking-wider px-2 py-0.5"
            style={{ color: 'var(--text-muted)' }}
          >
            {group.kind === 'image-to-video' ? 'Animate this image' : 'Generate from text'}
          </div>
          {group.models.map((m) => {
            const isCurrent = m.id === value;
            const isDefault = m.id === defaultModelId;
            const disabled = m.kind === 'image-to-video' && !hasStill;
            return (
              <div
                key={m.id}
                className="flex items-center gap-1 px-1"
                style={{
                  background: isCurrent ? 'rgba(168,85,247,0.16)' : 'transparent',
                  borderRadius: 4,
                  opacity: disabled ? 0.45 : 1,
                }}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => !disabled && onChange(m.id as BrollModelId)}
                  className="flex-1 text-left text-xs px-1 py-1 rounded"
                  style={{
                    color: isCurrent ? '#c084fc' : 'var(--text-secondary)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    background: 'transparent',
                  }}
                  title={disabled ? 'Needs a still image to animate' : m.blurb}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span>{m.label}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {m.priceUsdLabel}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onMakeDefault(m.id as BrollModelId)}
                  className="text-xs px-1 py-1 rounded"
                  style={{
                    background: 'transparent',
                    color: isDefault ? '#facc15' : 'var(--text-muted)',
                  }}
                  title={isDefault ? 'Current default' : 'Set as my default'}
                  aria-label={isDefault ? 'Current default' : `Set ${m.label} as default`}
                >
                  {isDefault ? '★' : '☆'}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function groupModelsByKind(
  models: readonly BrollModelDescriptor[],
): { kind: BrollModelKind; models: BrollModelDescriptor[] }[] {
  const i2v = models.filter((m) => m.kind === 'image-to-video');
  const t2v = models.filter((m) => m.kind === 'text-to-video');
  return [
    { kind: 'image-to-video', models: i2v },
    { kind: 'text-to-video', models: t2v },
  ];
}
