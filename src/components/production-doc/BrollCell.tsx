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
import { createPortal } from 'react-dom';
import {
  BROLL_FAMILY_LABEL,
  BROLL_FAMILY_ORDER,
  BROLL_MODELS,
  DEFAULT_BROLL_I2V_MODEL_ID,
  DEFAULT_BROLL_MODEL_ID,
  DEFAULT_BROLL_T2V_MODEL_ID,
  findBrollModel,
  pickModelForScene,
  type BrollClipRow,
  type BrollFamily,
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
 * In-memory cache of the resolved user defaults so the picker doesn't fetch
 * once per cell. The first BrollCell to mount fetches; subsequent cells
 * read the cached value synchronously. Cache is replaced on PUT so the new
 * default propagates immediately across every cell on the page.
 *
 * Two slots — one per kind. A row with a still picks `i2v`; a row without
 * a still picks `t2v`. The star icon in the picker writes to whichever
 * kind matches the clicked model.
 */
interface UserDefaults {
  t2vModelId: BrollModelId;
  i2vModelId: BrollModelId;
  t2vIsExplicit: boolean;
  i2vIsExplicit: boolean;
}
let userDefaultCache: UserDefaults | null = null;
let userDefaultPromise: Promise<UserDefaults> | null = null;
const userDefaultListeners = new Set<(next: UserDefaults) => void>();

function fallbackDefaults(): UserDefaults {
  return {
    t2vModelId: DEFAULT_BROLL_T2V_MODEL_ID,
    i2vModelId: DEFAULT_BROLL_I2V_MODEL_ID,
    t2vIsExplicit: false,
    i2vIsExplicit: false,
  };
}

function resolveDefaultsFromResponse(data: Record<string, unknown>): UserDefaults {
  const t2v = data.t2vModelId;
  const i2v = data.i2vModelId;
  return {
    t2vModelId:
      typeof t2v === 'string' && findBrollModel(t2v)?.kind === 'text-to-video'
        ? t2v
        : DEFAULT_BROLL_T2V_MODEL_ID,
    i2vModelId:
      typeof i2v === 'string' && findBrollModel(i2v)?.kind === 'image-to-video'
        ? i2v
        : DEFAULT_BROLL_I2V_MODEL_ID,
    t2vIsExplicit: Boolean(data.t2vIsExplicit),
    i2vIsExplicit: Boolean(data.i2vIsExplicit),
  };
}

async function fetchUserDefault(): Promise<UserDefaults> {
  if (userDefaultCache) return userDefaultCache;
  if (userDefaultPromise) return userDefaultPromise;
  userDefaultPromise = (async () => {
    try {
      const res = await fetch('/api/user/settings/broll-default', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const resolved = resolveDefaultsFromResponse(data);
      userDefaultCache = resolved;
      return resolved;
    } catch {
      // Network failure — fall back to library defaults. The picker still works.
      const fallback = fallbackDefaults();
      userDefaultCache = fallback;
      return fallback;
    } finally {
      userDefaultPromise = null;
    }
  })();
  return userDefaultPromise;
}

/** Persist the user's star choice. Server inspects the model's `kind` and
 *  writes into the matching slot (t2v or i2v), leaving the opposite kind's
 *  pin untouched. */
async function saveUserDefault(modelId: BrollModelId | null): Promise<void> {
  const res = await fetch('/api/user/settings/broll-default', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  const next = resolveDefaultsFromResponse(data);
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
  /** Row's scene duration in milliseconds, computed by the parent from
   *  the doc's timecodes. Used to auto-pick a shorter clip tier when
   *  the scene fits in 5s (saves ~$0.21 per short row). Falsy ⇒ no
   *  downgrade. See `_plans/2026-05-17-clip-duration-fit.md`. */
  sceneDurationMs?: number;
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
  sceneDurationMs,
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
  // Two stars in the picker, one per kind. The cell's local `modelId`
  // tracks whichever default is *appropriate for this row* (i2v when a
  // still is present, otherwise t2v), unless the user has explicitly
  // picked a model via the picker (modelIdLocked).
  const [defaultT2vModelId, setDefaultT2vModelId] = useState<BrollModelId>(DEFAULT_BROLL_T2V_MODEL_ID);
  const [defaultI2vModelId, setDefaultI2vModelId] = useState<BrollModelId>(DEFAULT_BROLL_I2V_MODEL_ID);
  const [modelId, setModelId] = useState<BrollModelId>(DEFAULT_BROLL_MODEL_ID);
  const [modelIdLocked, setModelIdLocked] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Lightbox overlay for the ready-state thumbnail. The inline <video> in the
  // cell is too small (~120×70) for useful playback and the native controls'
  // 3-dot overflow is fiddly at that size — clicking the thumbnail opens a
  // full-size player instead.
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const model = useMemo(() => findBrollModel(modelId), [modelId]);
  const isI2v = model?.kind === 'image-to-video';
  const needsStill = isI2v && !stillImageUrl;

  const onClipChangeRef = useRef(onClipChange);
  useEffect(() => {
    onClipChangeRef.current = onClipChange;
  }, [onClipChange]);

  // Subscribe to the user-default cache so a star-click in any cell on the
  // page propagates here immediately. The first cell to mount triggers the
  // GET; the rest read from cache. We only adopt a default into our local
  // `modelId` if the user hasn't manually changed the picker (i.e.,
  // `modelIdLocked` is false). The kind picked depends on whether the row
  // has a still — i2v when it does, t2v when it doesn't — so generating
  // the still later auto-promotes the cell to the i2v default.
  useEffect(() => {
    let cancelled = false;
    const pickForRow = (defs: UserDefaults): BrollModelId =>
      stillImageUrl ? defs.i2vModelId : defs.t2vModelId;
    fetchUserDefault().then((resolved) => {
      if (cancelled) return;
      setDefaultT2vModelId(resolved.t2vModelId);
      setDefaultI2vModelId(resolved.i2vModelId);
      setModelId((current) => (modelIdLocked ? current : pickForRow(resolved)));
    });
    const listener = (next: UserDefaults) => {
      setDefaultT2vModelId(next.t2vModelId);
      setDefaultI2vModelId(next.i2vModelId);
      setModelId((current) => (modelIdLocked ? current : pickForRow(next)));
    };
    userDefaultListeners.add(listener);
    return () => {
      cancelled = true;
      userDefaultListeners.delete(listener);
    };
  }, [modelIdLocked, stillImageUrl]);

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
    // Auto-pick the cheaper 5s tier when the scene is short enough to
    // fit. Saves ~$0.21 per row vs the 10s default. No-op for models
    // without a 5s sibling (Sora 2, Veo 3). See plan
    // `_plans/2026-05-17-clip-duration-fit.md`.
    const sceneSeconds = sceneDurationMs ? sceneDurationMs / 1000 : Number.POSITIVE_INFINITY;
    const tier = pickModelForScene(modelId, sceneSeconds);
    console.info('[broll tier pick]', {
      source: 'cell',
      rowIndex,
      sceneSeconds: Number.isFinite(sceneSeconds) ? Number(sceneSeconds.toFixed(2)) : null,
      userModelId: modelId,
      pickedModelId: tier.modelId,
      downgraded: tier.downgraded,
    });
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
          modelId: tier.modelId,
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
      // Reflect the picked tier (possibly downgraded) so the cell's
      // model picker shows what was actually generated, not what the
      // user originally selected. Same for `duration_seconds` — seed
      // it from the picked model's known tier so playback-rate fit can
      // begin computing on the next render without waiting for the
      // first GET to return the canonical row.
      const pickedDescriptor = findBrollModel(tier.modelId);
      const stub: BrollClipRow = {
        id: data.id,
        workspace_id: '',
        project_id: projectId ?? null,
        source_script_id: scriptId ?? null,
        row_signature: rowSignature,
        row_index: rowIndex,
        production_doc_id: productionDocId ?? null,
        prompt: '',
        model_id: tier.modelId,
        provider: 'kie',
        aspect_ratio: '16:9',
        duration_seconds: pickedDescriptor?.durationSeconds ?? null,
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
    productionDocId,
    sceneDurationMs,
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
            defaultT2vModelId={defaultT2vModelId}
            defaultI2vModelId={defaultI2vModelId}
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
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          aria-label="Play clip"
          title="Click to play"
          style={{
            position: 'relative',
            width: 120,
            height: 70,
            padding: 0,
            border: '1px solid var(--border)',
            borderRadius: 5,
            background: '#000',
            cursor: 'pointer',
            overflow: 'hidden',
            display: 'block',
          }}
        >
          {/* `muted` + `playsInline` + no `controls` keeps the element as a
              static first-frame preview; the click opens the lightbox where
              real playback happens. tabIndex=-1 so keyboard focus lands on
              the parent button instead. */}
          <video
            src={clip.video_url}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              pointerEvents: 'none',
            }}
          />
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.55)',
              color: '#fff',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingLeft: 2,
              pointerEvents: 'none',
            }}
          >
            ▶
          </span>
        </button>
        {lightboxOpen && (
          <VideoLightbox src={clip.video_url} onClose={() => setLightboxOpen(false)} />
        )}
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
      <div className="flex flex-col gap-1 relative">
        <span className="text-[11px]" style={{ color: '#f87171' }} title={msg}>
          ⚠ {truncate(msg, 28)}
        </span>
        {/* Per-cell model swap so the user can recover from a model-specific
            failure (e.g. Sora rejected the prompt, Kie returned no taskId)
            without leaving the row. Retry below picks up the new modelId. */}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="text-[10px] px-1 py-0.5 rounded text-left"
          style={{ background: 'rgba(120,120,120,0.10)', color: 'var(--text-muted)' }}
          title="Pick a different model"
        >
          {modelLabel(modelId)} ▾
        </button>
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
        {pickerOpen && (
          <ModelPicker
            value={modelId}
            defaultT2vModelId={defaultT2vModelId}
            defaultI2vModelId={defaultI2vModelId}
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

  return null;
}

function modelLabel(id: BrollModelId): string {
  return BROLL_MODELS.find((m) => m.id === id)?.label ?? id;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
}

/** Full-viewport overlay that plays a clip at usable size. Used by the ready
 *  state's thumbnail click — the inline 120×70 player is too small for
 *  meaningful playback and the native controls' overflow menu is fiddly at
 *  that size. Portal-rendered so the overlay isn't clipped by the table
 *  cell's overflow / stacking context. */
function VideoLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <video
        src={src}
        controls
        autoPlay
        style={{
          maxWidth: '92vw',
          maxHeight: '88vh',
          borderRadius: 8,
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          background: '#000',
        }}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          fontSize: 13,
          padding: '6px 12px',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.6)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.20)',
          cursor: 'pointer',
        }}
      >
        ✕ Close
      </button>
    </div>,
    document.body,
  );
}

/** Picker is grouped two-deep: image-to-video first (recommended path for
 *  rows that already have a still), text-to-video below, with each section
 *  subdivided by provider family (Kling, Sora, Veo, Runway, Grok, Seedance).
 *  Each entry shows label + price.
 *
 *  Two stars are shown — one in the i2v section, one in the t2v section.
 *  Each star marks the user's default for that kind. Clicking the star on
 *  a different model in the same section promotes it to the new default
 *  for that kind; the opposite kind's default is left untouched. The cell
 *  uses whichever default matches its row (i2v when a still is present,
 *  t2v otherwise). Family subheadings keep the 25-entry list scannable. */
function ModelPicker({
  value,
  defaultT2vModelId,
  defaultI2vModelId,
  hasStill,
  onChange,
  onMakeDefault,
  onClose,
}: {
  value: BrollModelId;
  defaultT2vModelId: BrollModelId;
  defaultI2vModelId: BrollModelId;
  hasStill: boolean;
  onChange: (id: BrollModelId) => void;
  onMakeDefault: (id: BrollModelId) => void | Promise<void>;
  onClose: () => void;
}) {
  const grouped = useMemo(() => groupModelsByKindAndFamily(BROLL_MODELS), []);
  return (
    <div
      className="absolute z-20 mt-6 rounded shadow-lg p-1 flex flex-col gap-1"
      style={{
        background: 'var(--bg-elevated, #1a1a1a)',
        border: '1px solid var(--border)',
        minWidth: 260,
        maxHeight: '70vh',
        overflowY: 'auto',
        top: 0,
      }}
      onMouseLeave={onClose}
    >
      {grouped.map((group) => (
        <div key={group.kind} className="flex flex-col gap-1">
          <div
            className="text-[9px] uppercase tracking-wider px-2 py-0.5"
            style={{ color: 'var(--text-muted)' }}
          >
            {group.kind === 'image-to-video' ? 'Animate this image' : 'Generate from text'}
          </div>
          {group.families.map((fam) => (
            <div key={`${group.kind}:${fam.family}`} className="flex flex-col gap-0.5">
              <div
                className="text-[10px] px-2 pt-1"
                style={{ color: 'var(--text-tertiary, var(--text-muted))', fontWeight: 600 }}
              >
                {BROLL_FAMILY_LABEL[fam.family]}
              </div>
              {fam.models.map((m) => {
                const isCurrent = m.id === value;
                const isDefault =
                  m.kind === 'image-to-video'
                    ? m.id === defaultI2vModelId
                    : m.id === defaultT2vModelId;
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
                      title={
                        isDefault
                          ? `Current default for ${m.kind === 'image-to-video' ? 'image-to-video' : 'text-to-video'}`
                          : `Set as default for ${m.kind === 'image-to-video' ? 'image-to-video' : 'text-to-video'}`
                      }
                      aria-label={
                        isDefault
                          ? `Current default for ${m.kind === 'image-to-video' ? 'image-to-video' : 'text-to-video'}`
                          : `Set ${m.label} as default for ${m.kind === 'image-to-video' ? 'image-to-video' : 'text-to-video'}`
                      }
                    >
                      {isDefault ? '★' : '☆'}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Two-deep grouping: first by kind (i2v / t2v), then by family. Families
 *  empty in either kind are dropped from the result so the picker only
 *  shows headings that have entries beneath them. Family order is the
 *  canonical `BROLL_FAMILY_ORDER`. */
function groupModelsByKindAndFamily(
  models: readonly BrollModelDescriptor[],
): {
  kind: BrollModelKind;
  families: { family: BrollFamily; models: BrollModelDescriptor[] }[];
}[] {
  function familiesFor(kind: BrollModelKind) {
    const kindModels = models.filter((m) => m.kind === kind);
    return BROLL_FAMILY_ORDER.map((family) => ({
      family,
      models: kindModels.filter((m) => m.family === family),
    })).filter((g) => g.models.length > 0);
  }
  return [
    { kind: 'image-to-video', families: familiesFor('image-to-video') },
    { kind: 'text-to-video', families: familiesFor('text-to-video') },
  ];
}
