"use client";

/**
 * Per-row B-roll cell for the Production Doc table.
 *
 * Self-contained: owns its own status state + polling loop. The parent only
 * has to (a) feed in the row's identifying fields and prompt inputs and
 * (b) persist the cell's `clipId` callback in localStorage so reload
 * rehydrates the same clip onto the same row.
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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BROLL_MODELS,
  DEFAULT_BROLL_MODEL_ID,
  type BrollClipRow,
  type BrollModelId,
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

function readBrollLsMap(): BrollLsMap {
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

function writeBrollLsMap(map: BrollLsMap) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BROLL_LS_KEY, JSON.stringify(map));
  } catch {
    /* storage full — best-effort only */
  }
}

export interface BrollCellProps {
  /** Project the clip should be attached to (for cross-session listing). Optional. */
  projectId?: string | null;
  /** Source script id, if known (production doc may not have one). */
  scriptId?: string | null;
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
  /** Existing clip rehydrated from a previous fetch — when present, cell
   *  starts in the right phase (generating | ready | failed) without a
   *  fresh POST. */
  initialClip?: BrollClipRow | null;
  /** Notified whenever the cell creates / advances / clears a clip so the
   *  parent can persist {rowIndex → clipId} mapping in localStorage. */
  onClipChange?: (clip: BrollClipRow | null) => void;
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
  rowIndex,
  rowSignature,
  visualDescription,
  aiImagePrompt,
  styleHint,
  initialClip,
  onClipChange,
}: BrollCellProps) {
  const [clip, setClip] = useState<BrollClipRow | null>(initialClip ?? null);
  const [phase, setPhase] = useState<Phase>(phaseFromClip(initialClip));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [modelId, setModelId] = useState<BrollModelId>(DEFAULT_BROLL_MODEL_ID);
  const [pickerOpen, setPickerOpen] = useState(false);

  const onClipChangeRef = useRef(onClipChange);
  useEffect(() => {
    onClipChangeRef.current = onClipChange;
  }, [onClipChange]);

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

  // On mount: if we don't have a clip already (no initialClip prop) but the
  // localStorage map remembers one for this signature, fetch + hydrate.
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
        setClip(data.clip);
        setPhase(phaseFromClip(data.clip));
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
    setPhase('starting');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/broll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectId ?? null,
          scriptId: scriptId ?? null,
          rowSignature,
          rowIndex,
          visualDescription,
          aiImagePrompt: aiImagePrompt || undefined,
          styleHint: styleHint || undefined,
          modelId,
          aspectRatio: '16:9',
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

  if (phase === 'idle') {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={!hasGenerableInput}
          onClick={startGeneration}
          className="text-xs px-2 py-1 rounded whitespace-nowrap"
          style={{
            background: hasGenerableInput ? 'rgba(168,85,247,0.12)' : 'rgba(120,120,120,0.08)',
            color: hasGenerableInput ? '#c084fc' : 'var(--text-muted)',
            cursor: hasGenerableInput ? 'pointer' : 'not-allowed',
          }}
          title={hasGenerableInput ? `Generate B-roll with ${modelLabel(modelId)}` : 'Row has no visual to base a clip on'}
        >
          ▶ B-roll
        </button>
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="text-[10px] px-1 py-0.5 rounded"
          style={{ background: 'rgba(120,120,120,0.10)', color: 'var(--text-muted)' }}
          title="Pick model"
        >
          {modelLabel(modelId)} ▾
        </button>
        {pickerOpen && (
          <ModelPicker
            value={modelId}
            onChange={(id) => {
              setModelId(id);
              setPickerOpen(false);
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

function ModelPicker({
  value,
  onChange,
  onClose,
}: {
  value: BrollModelId;
  onChange: (id: BrollModelId) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute z-20 mt-6 rounded shadow-lg p-1 flex flex-col gap-0.5"
      style={{
        background: 'var(--bg-elevated, #1a1a1a)',
        border: '1px solid var(--border)',
        minWidth: 180,
      }}
      onMouseLeave={onClose}
    >
      {BROLL_MODELS.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id as BrollModelId)}
          className="text-left text-xs px-2 py-1 rounded"
          style={{
            background: m.id === value ? 'rgba(168,85,247,0.16)' : 'transparent',
            color: m.id === value ? '#c084fc' : 'var(--text-secondary)',
          }}
          title={m.blurb}
        >
          {m.label}
          {m.recommended ? ' ★' : ''}
        </button>
      ))}
    </div>
  );
}
