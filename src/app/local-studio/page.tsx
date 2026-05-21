'use client';

/**
 * /local-studio — Phase 1 of the lean mean local video creation machine.
 *
 * Generates images locally via ComfyUI on localhost:8188. Reuses the
 * existing `production_doc_styles` registry for style picks. Gated at
 * the server route level by `LOCAL_STUDIO=1` — the page itself does no
 * extra gating since the API returns 404 when the flag is off and the
 * user sees a clear "feature unavailable" state.
 *
 * Phase 2+ adds reference chaining, image-to-video, production-doc
 * integration, and the voiceover-driven batch pipeline. This file
 * stays the prompt-+-result surface; deeper flows live alongside.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

interface WorkflowEntry {
  id: string;
  label: string;
  hint: string;
  nonCommercial?: boolean;
}

interface VideoWorkflowEntry {
  id: string;
  label: string;
  hint: string;
}

interface StyleEntry {
  id: string;
  label: string;
  description: string | null;
  origin: 'built-in' | 'saved';
}

interface StatusResponse {
  reachable: boolean;
  workflows: WorkflowEntry[];
  videoWorkflows?: VideoWorkflowEntry[];
  styles: StyleEntry[];
  /** "db" = saved styles loaded from Postgres. "built-in-fallback" =
   *  DB unreachable (Neon quota, network etc), only built-in styles
   *  available. Surfaces a small notice in the UI. */
  stylesSource?: 'db' | 'built-in-fallback';
  comfyuiUrl: string;
}

interface GenerationOutput {
  url: string;
  width: number;
  height: number;
  seed: number;
  durationMs: number;
  styleLabel: string | null;
  /** True for video clips (animated webp / webm). Drives the result
   *  panel between <img> and a player-style block. Animated WEBP loops
   *  by default in <img>, so for v1 we still use <img>. */
  isClip?: boolean;
  /** Echo of the prompt that produced this — surfaced under the result
   *  so the user can scan history and re-roll without losing context. */
  prompt: string;
  /** Workflow id used for this generation. Lets re-roll route back to
   *  the same model + same settings even if the picker has changed. */
  workflowId: string;
}

interface QueueItem {
  promptId: string;
  clientId: string | null;
  model: string | null;
  prompt: string | null;
  kind: 'image' | 'clip' | 'unknown';
}

interface QueueSummary {
  running: QueueItem[];
  pending: QueueItem[];
  total: number;
}

/** Live progress info from ComfyUI's WebSocket. Keyed by prompt_id. */
interface ProgressEntry {
  /** Current sampling step (0..max). */
  value: number;
  /** Total sampling steps for this prompt. */
  max: number;
  /** Last node id ComfyUI reported as "executing". */
  node?: string;
  /** Updated-at for staleness checks. */
  updatedAt: number;
}

/** Persisted history entry (localStorage). Snapshot of one successful
 *  generation so the user can scroll a gallery and re-load past prompts.
 *  Cap of HISTORY_MAX prunes oldest at write time. */
interface HistoryEntry {
  url: string;
  width: number;
  height: number;
  seed: number;
  durationMs: number;
  isClip: boolean;
  prompt: string;
  workflowId: string;
  styleId: string | null;
  styleLabel: string | null;
  ts: number;
}

const HISTORY_LS_KEY = 'local_studio_history_v1';
const HISTORY_MAX = 20;

function readHistory(): HistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function writeHistory(entries: HistoryEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HISTORY_LS_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX)));
  } catch {
    /* storage full — silent drop */
  }
}

// Presets oriented around YouTube long-form (1920×1080) with section-title
// stripe variants matched pixel-for-pixel to Remotion's letterbox geometry —
// see `src/lib/render-canvas.ts` and
// `_plans/2026-05-21-resolution-aware-generation.md`. Thumbnail / Shorts /
// Square live below for the non-long-form cases.
const PRESET_SIZES: Array<{ label: string; width: number; height: number }> = [
  { label: 'YouTube 1920×1080 (no title row)', width: 1920, height: 1080 },
  { label: 'YouTube + title row 1920×944 (default 13%)', width: 1920, height: 944 },
  { label: 'YouTube + max title row 1920×840 (22%)', width: 1920, height: 840 },
  { label: 'YouTube + min title row 1920×1016 (6%)', width: 1920, height: 1016 },
  { label: 'Thumbnail 1920×1080', width: 1920, height: 1080 },
  { label: 'Shorts 1080×1920', width: 1080, height: 1920 },
  { label: 'Square 1080×1080', width: 1080, height: 1080 },
];

export default function LocalStudioPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [styleId, setStyleId] = useState<string>('');
  const [workflowId, setWorkflowId] = useState<string>('flux-schnell-t2i');
  const [sizeIdx, setSizeIdx] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [output, setOutput] = useState<GenerationOutput | null>(null);
  /** Holds the AbortController for the in-flight /generate request so the
   *  Stop button can tear it down. Ref because we don't need re-renders
   *  on assignment — the button reads `generating` for its disabled state. */
  const abortRef = useRef<AbortController | null>(null);
  /** Persistent queue mirror — polled every 2 s. Lets the user see
   *  what's running / queued in ComfyUI even when they haven't clicked
   *  Generate from this page (e.g. a smoke test from another tool). */
  const [queue, setQueue] = useState<QueueSummary>({ running: [], pending: [], total: 0 });
  /** Tracks when each prompt_id first showed up in the queue so we can
   *  display elapsed time. Set on first sighting (pending OR running),
   *  pruned when the prompt disappears. */
  const seenAtRef = useRef<Map<string, number>>(new Map());
  /** WebSocket-fed sampling progress per prompt_id. ComfyUI emits a
   *  `progress` event per sampler step — { value, max, prompt_id }. */
  const [progress, setProgress] = useState<Map<string, ProgressEntry>>(new Map());
  /** Logs panel state. Off by default — only renders when expanded. */
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  /** Force re-renders for the elapsed-time labels at 1 Hz so the
   *  numbers tick visually without us having to mutate queue state. */
  const [tick, setTick] = useState(0);
  /** Persistent history of past generations, last 20, persisted in
   *  localStorage. Click an entry to reload its prompt + model into the
   *  form and show its image in the Result panel. */
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Hydrate history from localStorage once on mount.
  useEffect(() => {
    setHistory(readHistory());
  }, []);
  /** Reference image state. `filename` is what /generate sends to the
   *  backend; `previewUrl` is what we render in the side panel. */
  const [refImage, setRefImage] = useState<{ filename: string; previewUrl: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  /** Denoise strength when a reference image is attached. 0.85 = "same
   *  composition, new content" (sweet spot). 1.0 = ignore the reference
   *  entirely (defeats the purpose). 0.5 = light variation on the ref. */
  const [denoise, setDenoise] = useState(0.85);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Initial status fetch + periodic refresh.
  //
  // ComfyUI can restart out from under us (user kills + relaunches,
  // process crashes, etc). Polling every 10s means the green/red pill
  // catches up within seconds instead of requiring a page refresh.
  // The poll is cheap (single localhost HEAD-equivalent) so the
  // interval can stay short without being noisy.
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const r = await fetch('/api/local-studio/status');
        if (r.status === 404) {
          throw new Error('Local Studio is not enabled. Start with $env:LOCAL_STUDIO=1; npm run dev.');
        }
        if (!r.ok) throw new Error(`Status check failed (HTTP ${r.status})`);
        const s = (await r.json()) as StatusResponse;
        if (!active) return;
        setStatus(s);
        // Clear any previous fatal error if the route recovered.
        setStatusError(null);
      } catch (err) {
        if (!active) return;
        // Only set the fatal-error state on the FIRST failure. A
        // transient hot-reload glitch shouldn't blow away a working
        // page — let the next poll recover. Network-style errors land
        // in the offline pill via setStatus({ reachable: false }).
        if (!status) {
          setStatusError(err instanceof Error ? err.message : String(err));
        } else {
          setStatus({ ...status, reachable: false });
        }
      }
    };
    check();
    const id = window.setInterval(check, 10_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
    // `status` deliberately omitted from deps — we want this interval
    // to keep running on its own cadence, not reset on every state
    // change. The closure-captured `status` inside is fine because
    // setStatus reads from a stable reference and any drift is fixed
    // by the next 10s tick anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed-time ticker while a generation is in flight. ComfyUI doesn't
  // report progress in Phase 1, so showing wall-clock seconds is the
  // best UX we can give the user without WebSocket integration.
  useEffect(() => {
    if (!generating) {
      setElapsedMs(0);
      return;
    }
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - t0), 200);
    return () => window.clearInterval(id);
  }, [generating]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      toast.error('Type a prompt first');
      return;
    }
    if (!status?.reachable) {
      toast.error('ComfyUI is not reachable on localhost:8188');
      return;
    }
    setGenerating(true);
    setOutput(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const size = PRESET_SIZES[sizeIdx];
      const res = await fetch('/api/local-studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          styleId: styleId || null,
          workflowId,
          width: size.width,
          height: size.height,
          refImageFilename: refImage?.filename ?? null,
          denoise: refImage ? denoise : undefined,
        }),
        signal: ac.signal,
      });
      const json = (await res.json()) as
        | { ok: true; result: GenerationOutput & { url: string }; style_label: string | null }
        | { error: string };
      if (!res.ok || 'error' in json) {
        const msg = 'error' in json ? json.error : `HTTP ${res.status}`;
        toast.error(msg);
        return;
      }
      setOutput({
        url: json.result.url,
        width: json.result.width,
        height: json.result.height,
        seed: json.result.seed,
        durationMs: json.result.durationMs,
        styleLabel: json.style_label,
        prompt: prompt.trim(),
        workflowId,
      });
      // Prepend to history (newest first), persist to localStorage.
      setHistory(prev => {
        const next: HistoryEntry[] = [
          {
            url: json.result.url,
            width: json.result.width,
            height: json.result.height,
            seed: json.result.seed,
            durationMs: json.result.durationMs,
            isClip: false,
            prompt: prompt.trim(),
            workflowId,
            styleId: styleId || null,
            styleLabel: json.style_label,
            ts: Date.now(),
          },
          ...prev,
        ].slice(0, HISTORY_MAX);
        writeHistory(next);
        return next;
      });
      toast.success(`Generated in ${(json.result.durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [prompt, styleId, workflowId, sizeIdx, status, refImage, denoise]);

  const handleUploadRef = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set('image', file);
      const res = await fetch('/api/local-studio/upload-ref', { method: 'POST', body: fd });
      const json = (await res.json()) as
        | { ok: true; filename: string; previewUrl: string }
        | { error: string };
      if (!res.ok || 'error' in json) {
        const msg = 'error' in json ? json.error : `HTTP ${res.status}`;
        toast.error(msg);
        return;
      }
      setRefImage({ filename: json.filename, previewUrl: json.previewUrl });
      toast.success('Reference image attached');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const handleGenerateClip = useCallback(async () => {
    if (!prompt.trim()) {
      toast.error('Type a motion prompt first');
      return;
    }
    if (!refImage) {
      toast.error('Upload a reference image first — clips animate an existing still');
      return;
    }
    if (!status?.reachable) {
      toast.error('ComfyUI is not reachable on localhost:8188');
      return;
    }
    setGenerating(true);
    setOutput(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const size = PRESET_SIZES[sizeIdx];
      const res = await fetch('/api/local-studio/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          styleId: styleId || null,
          firstFrameFilename: refImage.filename,
          width: size.width,
          height: size.height,
          durationSeconds: 5,
        }),
        signal: ac.signal,
      });
      const json = (await res.json()) as
        | { ok: true; result: GenerationOutput; style_label: string | null }
        | { error: string };
      if (!res.ok || 'error' in json) {
        const msg = 'error' in json ? json.error : `HTTP ${res.status}`;
        toast.error(msg);
        return;
      }
      setOutput({
        url: json.result.url,
        width: json.result.width,
        height: json.result.height,
        seed: json.result.seed,
        durationMs: json.result.durationMs,
        styleLabel: json.style_label,
        isClip: true,
        prompt: prompt.trim(),
        workflowId: 'wan-2.2-i2v',
      });
      setHistory(prev => {
        const next: HistoryEntry[] = [
          {
            url: json.result.url,
            width: json.result.width,
            height: json.result.height,
            seed: json.result.seed,
            durationMs: json.result.durationMs,
            isClip: true,
            prompt: prompt.trim(),
            workflowId: 'wan-2.2-i2v',
            styleId: styleId || null,
            styleLabel: json.style_label,
            ts: Date.now(),
          },
          ...prev,
        ].slice(0, HISTORY_MAX);
        writeHistory(next);
        return next;
      });
      toast.success(`Clip generated in ${(json.result.durationMs / 1000).toFixed(0)}s`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [prompt, styleId, sizeIdx, status, refImage]);

  // Poll the ComfyUI queue every 2 s so the panel reflects external
  // activity (other tools, my own smoke tests). Cheap — single
  // localhost GET. Cleared on unmount.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/local-studio/queue');
        if (!r.ok) return;
        const json = (await r.json()) as QueueSummary;
        if (!active) return;
        setQueue(json);
        // Track first-seen timestamps for elapsed time. Add any new
        // prompts; drop any that have disappeared from the queue.
        const allIds = new Set([
          ...json.running.map(r => r.promptId),
          ...json.pending.map(p => p.promptId),
        ]);
        for (const id of allIds) {
          if (!seenAtRef.current.has(id)) {
            seenAtRef.current.set(id, Date.now());
          }
        }
        for (const id of [...seenAtRef.current.keys()]) {
          if (!allIds.has(id)) seenAtRef.current.delete(id);
        }
        // Clear progress for prompts that are no longer running.
        setProgress(prev => {
          if (prev.size === 0) return prev;
          const runningIds = new Set(json.running.map(r => r.promptId));
          let changed = false;
          const next = new Map(prev);
          for (const id of [...next.keys()]) {
            if (!runningIds.has(id)) {
              next.delete(id);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      } catch {
        // Transient — next tick will retry.
      }
    };
    poll();
    const id = window.setInterval(poll, 2_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  // 1 Hz tick for elapsed-time labels so they re-render without
  // touching queue state (which only changes on the 2 s poll).
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Live sampling progress via WebSocket was attempted but ComfyUI
  // rejects browser WS connections with `host != origin` 403s when the
  // page is served from `localhost:3000`. The `--enable-cors-header`
  // launch flag only sets HTTP CORS — it doesn't bypass the WS origin
  // check. To get the progress bar back we'd need to proxy the WS
  // server-side via SSE; deferred. For now the panel relies on
  // elapsed-time (1 Hz tick) + the logs panel for visibility.

  // Logs polling — only when the panel is expanded. Avoids fetching
  // 64 KB every 3 s in the steady state.
  useEffect(() => {
    if (!showLogs) return;
    let active = true;
    const pollLogs = async () => {
      try {
        const r = await fetch('/api/local-studio/logs?lines=60');
        if (!r.ok) return;
        const json = (await r.json()) as { lines: string[] };
        if (!active) return;
        setLogs(json.lines);
      } catch {
        // Transient — next tick.
      }
    };
    pollLogs();
    const id = window.setInterval(pollLogs, 3_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [showLogs]);

  const handleClearQueue = useCallback(async () => {
    try {
      const r = await fetch('/api/local-studio/cancel', { method: 'POST' });
      if (r.ok) {
        toast('Queue cleared');
        // Refresh queue immediately so the panel doesn't lag the 2 s tick.
        setQueue({ running: [], pending: [], total: 0 });
      } else {
        toast.error('Failed to clear queue');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleCancelOne = useCallback(async (item: QueueItem, isRunning: boolean) => {
    try {
      const r = await fetch('/api/local-studio/queue/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: item.promptId, isRunning }),
      });
      if (r.ok) {
        toast(isRunning ? 'Interrupted running prompt' : 'Removed from queue');
        // Optimistic local removal — the 2 s tick will reconcile.
        setQueue(prev => ({
          running: isRunning ? [] : prev.running,
          pending: prev.pending.filter(p => p.promptId !== item.promptId),
          total: Math.max(0, prev.total - 1),
        }));
      } else {
        toast.error(`Cancel failed (HTTP ${r.status})`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** "Use as reference" — promote the just-generated image to the
   *  reference slot so the next click is img2img against it. Saves the
   *  user a download + re-upload round trip. Fetches the bytes via the
   *  proxy URL and pipes them through the same upload-ref endpoint
   *  that the file picker uses. */
  const handleUseAsReference = useCallback(async () => {
    if (!output) return;
    if (output.isClip) {
      toast.error("Clips can't be used as a reference (yet). Generate a still first.");
      return;
    }
    setUploading(true);
    try {
      const imgRes = await fetch(output.url);
      if (!imgRes.ok) throw new Error(`Failed to fetch result image (HTTP ${imgRes.status})`);
      const blob = await imgRes.blob();
      const file = new File([blob], `result-${output.seed}.png`, { type: blob.type || 'image/png' });
      const fd = new FormData();
      fd.set('image', file);
      const r = await fetch('/api/local-studio/upload-ref', { method: 'POST', body: fd });
      const json = (await r.json()) as
        | { ok: true; filename: string; previewUrl: string }
        | { error: string };
      if (!r.ok || 'error' in json) {
        toast.error('error' in json ? json.error : `HTTP ${r.status}`);
        return;
      }
      setRefImage({ filename: json.filename, previewUrl: json.previewUrl });
      toast.success('Set as reference — next click will img2img against it');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, [output]);

  /** "Re-roll" — same prompt + model + size + style, new random seed.
   *  Reuses handleGenerate so reference-attached behaviour is consistent. */
  const handleReroll = useCallback(() => {
    if (!output) return;
    setPrompt(output.prompt);
    setWorkflowId(output.workflowId);
    // Defer so React commits state before generate runs.
    window.setTimeout(() => {
      void handleGenerate();
    }, 0);
  }, [output, handleGenerate]);

  /** Click a history thumbnail to restore that generation into the
   *  Result panel + reload its inputs (prompt, model, style) into the
   *  form for easy iteration. Does NOT trigger a new generation;
   *  user clicks Re-roll or Generate to re-run. */
  const handleHistoryClick = useCallback((entry: HistoryEntry) => {
    setOutput({
      url: entry.url,
      width: entry.width,
      height: entry.height,
      seed: entry.seed,
      durationMs: entry.durationMs,
      styleLabel: entry.styleLabel,
      isClip: entry.isClip,
      prompt: entry.prompt,
      workflowId: entry.workflowId,
    });
    setPrompt(entry.prompt);
    setWorkflowId(entry.workflowId);
    if (entry.styleId) setStyleId(entry.styleId);
  }, []);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    writeHistory([]);
    toast('History cleared');
  }, []);

  const handleStop = useCallback(async () => {
    // Two-pronged stop: abort the browser fetch + tell ComfyUI to
    // interrupt its current prompt. Either alone leaves a dangling
    // process; both together stop fully.
    abortRef.current?.abort();
    try {
      await fetch('/api/local-studio/cancel', { method: 'POST' });
      toast('Stopped');
    } catch {
      // Best-effort — the browser abort already gave the user their UX.
    }
  }, []);

  if (statusError) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Local Studio</h1>
        <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
          {statusError}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Local Studio</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Generate images locally via ComfyUI. No cloud, no cost.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <QueuePill queue={queue} />
          <StatusPill status={status} />
        </div>
      </header>

      <QueuePanel
        queue={queue}
        onClearAll={handleClearQueue}
        onCancel={handleCancelOne}
        seenAt={seenAtRef.current}
        progress={progress}
        tick={tick}
        showLogs={showLogs}
        onToggleLogs={() => setShowLogs(v => !v)}
        logs={logs}
      />

      <HistoryStrip history={history} onClick={handleHistoryClick} onClear={handleClearHistory} />

      {status?.stylesSource === 'built-in-fallback' && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-200">
          Your Postgres is unreachable (Neon quota / outage). Built-in styles
          still work; saved styles will return when the DB is back.
        </div>
      )}

      <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_minmax(280px,_1fr)]">
        <div className="space-y-5">
          <Field label="Prompt">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A red fox running through a snowy forest at dawn, soft light, cinematic"
              rows={6}
              className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Style">
              <select
                value={styleId}
                onChange={(e) => setStyleId(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
              >
                <option value="">No style (just the prompt)</option>
                {status?.styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.origin === 'saved' ? ' (saved)' : ''}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Size">
              <select
                value={sizeIdx}
                onChange={(e) => setSizeIdx(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
              >
                {PRESET_SIZES.map((s, i) => (
                  <option key={s.label} value={i}>{s.label}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Model / workflow">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(status?.workflows ?? []).map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setWorkflowId(w.id)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                    workflowId === w.id
                      ? 'border-emerald-500/50 bg-emerald-500/5'
                      : 'border-zinc-700 bg-zinc-900 hover:border-zinc-600'
                  }`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    {w.label}
                    {w.nonCommercial && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300">
                        Non-commercial
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-400">{w.hint}</div>
                </button>
              ))}
            </div>
          </Field>

          <Field label={refImage ? 'Reference image — composition seed' : 'Reference image (optional)'}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleUploadRef(f);
                e.target.value = '';
              }}
            />
            {refImage ? (
              <div className="flex items-start gap-3 rounded-lg border border-zinc-700 bg-zinc-900 p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={refImage.previewUrl}
                  alt="reference"
                  className="h-20 w-32 rounded border border-zinc-800 object-cover"
                />
                <div className="flex-1 space-y-2">
                  <div className="text-xs text-zinc-400">
                    Generation will follow this composition. Drop denoise to keep
                    more of the reference, raise it to follow the prompt more freely.
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={0.4}
                      max={0.99}
                      step={0.01}
                      value={denoise}
                      onChange={(e) => setDenoise(Number(e.target.value))}
                      className="flex-1 accent-emerald-500"
                    />
                    <span className="w-12 text-right text-xs tabular-nums text-zinc-300">
                      {denoise.toFixed(2)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRefImage(null)}
                    className="text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    Remove reference →
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 px-3 py-3 text-sm text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-60"
              >
                {uploading ? 'Uploading…' : '+ Upload an image to use as reference (img2img)'}
              </button>
            )}
          </Field>

          {generating ? (
            <div className="flex gap-2">
              <div className="flex-1 rounded-lg bg-zinc-800 px-4 py-2.5 text-center text-sm font-medium text-zinc-300">
                Generating… {(elapsedMs / 1000).toFixed(1)}s
              </div>
              <button
                type="button"
                onClick={handleStop}
                className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500"
              >
                Stop
              </button>
            </div>
          ) : refImage ? (
            // When a reference image is attached, the user can either
            // produce an img2img still OR an image-to-video clip. Two
            // buttons side by side; the clip path uses Wan 2.2 5B and
            // takes ~3–5 min on this card.
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!status?.reachable || !prompt.trim()}
                className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                Generate image
              </button>
              <button
                type="button"
                onClick={handleGenerateClip}
                disabled={!status?.reachable || !prompt.trim() || !(status?.videoWorkflows?.length)}
                title={
                  status?.videoWorkflows?.length
                    ? 'Animate the reference image into a ~5 s clip via Wan 2.2'
                    : 'Wan 2.2 model files still downloading'
                }
                className="rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                Make it move
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!status?.reachable || !prompt.trim()}
              className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              Generate
            </button>
          )}
        </div>

        <aside className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 className="text-sm font-semibold text-zinc-200">Result</h2>
          {output ? (
            <div className="mt-3 space-y-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={output.url}
                alt={output.isClip ? 'generated clip' : 'generated image'}
                className="w-full rounded-lg border border-zinc-800"
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleReroll}
                  disabled={generating}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Run again with the same prompt + a new random seed"
                >
                  Re-roll
                </button>
                <button
                  type="button"
                  onClick={handleUseAsReference}
                  disabled={generating || output.isClip || uploading}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
                  title={
                    output.isClip
                      ? 'Reference-from-clip not supported yet'
                      : 'Promote this image to the reference slot for the next generation'
                  }
                >
                  {uploading ? 'Setting…' : 'Use as reference'}
                </button>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-400">
                <dt>Type</dt>
                <dd className="text-zinc-200">{output.isClip ? 'Clip (Wan 2.2)' : 'Image'}</dd>
                <dt>Style</dt>
                <dd className="text-zinc-200">{output.styleLabel ?? '—'}</dd>
                <dt>Size</dt>
                <dd className="text-zinc-200">{output.width} × {output.height}</dd>
                <dt>Seed</dt>
                <dd className="font-mono text-zinc-200">{output.seed}</dd>
                <dt>Time</dt>
                <dd className="text-zinc-200">
                  {output.isClip
                    ? `${(output.durationMs / 1000).toFixed(0)}s`
                    : `${(output.durationMs / 1000).toFixed(1)}s`}
                </dd>
                <dt>Prompt</dt>
                <dd className="line-clamp-2 text-zinc-300" title={output.prompt}>{output.prompt}</dd>
              </dl>
              <a
                href={output.url}
                target="_blank"
                rel="noreferrer"
                className="block text-center text-xs text-zinc-400 hover:text-zinc-200"
              >
                Open full size →
              </a>
            </div>
          ) : (
            <p className="mt-3 text-xs text-zinc-500">
              Output appears here. First Flux schnell generation: ~5–10s warm.
              Clips (Wan 2.2): ~3–5 min per 5 s clip.
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-400">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Tiny header pill — at-a-glance state only. The real controls live
 *  in QueuePanel below the header. */
function QueuePill({ queue }: { queue: QueueSummary }) {
  if (queue.total === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-500">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
        Queue empty
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-200">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
      {queue.running.length > 0 ? '1 running' : ''}
      {queue.pending.length > 0 ? ` · ${queue.pending.length} queued` : ''}
    </span>
  );
}

/** Full queue panel — one row per running + pending prompt with
 *  elapsed time + live progress (via WS) + collapsible logs panel. */
function QueuePanel({
  queue,
  onClearAll,
  onCancel,
  seenAt,
  progress,
  tick,
  showLogs,
  onToggleLogs,
  logs,
}: {
  queue: QueueSummary;
  onClearAll: () => void;
  onCancel: (item: QueueItem, isRunning: boolean) => void;
  seenAt: Map<string, number>;
  progress: Map<string, ProgressEntry>;
  tick: number;
  showLogs: boolean;
  onToggleLogs: () => void;
  logs: string[];
}) {
  if (queue.total === 0 && !showLogs) return null;
  return (
    <section className="mt-4 rounded-xl border border-blue-500/20 bg-blue-500/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-blue-200">
          ComfyUI queue ({queue.total})
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleLogs}
            className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300 transition hover:bg-zinc-700"
          >
            {showLogs ? 'Hide logs' : 'Show logs'}
          </button>
          {queue.total > 0 && (
            <button
              type="button"
              onClick={onClearAll}
              className="rounded-full bg-red-500/20 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-200 transition hover:bg-red-500/30"
            >
              Clear all
            </button>
          )}
        </div>
      </div>
      {queue.total > 0 && (
        <ul className="space-y-1.5">
          {queue.running.map((item) => (
            <QueueRow
              key={item.promptId}
              item={item}
              position="RUN"
              onCancel={() => onCancel(item, true)}
              seenAt={seenAt.get(item.promptId) ?? null}
              progress={progress.get(item.promptId) ?? null}
              tick={tick}
            />
          ))}
          {queue.pending.map((item, idx) => (
            <QueueRow
              key={item.promptId}
              item={item}
              position={`#${idx + 1}`}
              onCancel={() => onCancel(item, false)}
              seenAt={seenAt.get(item.promptId) ?? null}
              progress={null}
              tick={tick}
            />
          ))}
        </ul>
      )}
      {showLogs && (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-black p-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-tight text-zinc-400">
            {logs.length === 0 ? '(no log lines yet — ComfyUI may not be running, or log file is at a different path)' : logs.join('\n')}
          </pre>
        </div>
      )}
    </section>
  );
}

function QueueRow({
  item,
  position,
  onCancel,
  seenAt,
  progress,
  tick: _tick,
}: {
  item: QueueItem;
  position: string;
  onCancel: () => void;
  seenAt: number | null;
  progress: ProgressEntry | null;
  /** Read so React re-renders on the 1 Hz timer. The math reads
   *  Date.now() so we don't actually use the tick value. */
  tick: number;
}) {
  const running = position === 'RUN';
  const modelLabel = item.model
    ? item.model.replace(/\.(?:gguf|safetensors)$/i, '')
    : '—';

  // Elapsed seconds since this prompt first appeared in the queue.
  const elapsedSec = seenAt != null ? Math.max(0, Math.floor((Date.now() - seenAt) / 1000)) : null;

  // Progress + ETA (only when we have a live progress event for this
  // prompt and have made at least one step of progress).
  const progressPct = progress && progress.max > 0 ? (progress.value / progress.max) * 100 : null;
  let etaSec: number | null = null;
  if (running && progressPct != null && elapsedSec != null && progress!.value > 0) {
    const fraction = progress!.value / progress!.max;
    if (fraction > 0 && fraction < 1) {
      const total = elapsedSec / fraction;
      etaSec = Math.max(0, Math.round(total - elapsedSec));
    }
  }

  return (
    <li
      className={`rounded-lg border px-3 py-2 ${
        running ? 'border-blue-500/40 bg-blue-500/10' : 'border-zinc-800 bg-zinc-950'
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`min-w-[3rem] rounded-full px-2 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide ${
            running ? 'bg-blue-500/30 text-blue-100' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {running && <span className="mr-1 inline-block h-1 w-1 animate-pulse rounded-full bg-blue-300" />}
          {position}
        </span>
        <span className="hidden rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400 sm:inline-block">
          {item.kind}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px] text-zinc-300" title={item.model ?? undefined}>
            {modelLabel}
          </div>
          <div className="truncate text-xs text-zinc-400" title={item.prompt ?? undefined}>
            {item.prompt ?? <em className="text-zinc-600">(no prompt)</em>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-right text-[10px] tabular-nums">
          {elapsedSec != null && (
            <span className="text-zinc-400">{formatDuration(elapsedSec)}</span>
          )}
          {running && etaSec != null && (
            <span className="text-blue-300">~{formatDuration(etaSec)} left</span>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md bg-red-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-red-200 transition hover:bg-red-500/25"
        >
          {running ? 'Stop' : 'Remove'}
        </button>
      </div>
      {/* Sampling progress bar — only on the running row, only when we
          have a WS progress event. Shows step X / Y + visual bar. */}
      {running && progressPct != null && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] tabular-nums text-blue-200">
            <span>step {progress!.value} / {progress!.max}</span>
            <span>{progressPct.toFixed(0)}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-blue-500/15">
            <div
              className="h-full rounded-full bg-blue-400 transition-all duration-200"
              style={{ width: `${Math.min(100, progressPct)}%` }}
            />
          </div>
        </div>
      )}
    </li>
  );
}

/** Format seconds as "0:42", "1:23", "12:34". */
function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Horizontal strip of recent generation thumbnails. Hidden when
 *  history is empty. Click a tile to load it back into the result
 *  panel + restore inputs for fast iteration. */
function HistoryStrip({
  history,
  onClick,
  onClear,
}: {
  history: HistoryEntry[];
  onClick: (entry: HistoryEntry) => void;
  onClear: () => void;
}) {
  if (history.length === 0) return null;
  return (
    <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Recent ({history.length})
        </h2>
        <button
          type="button"
          onClick={onClear}
          className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 transition hover:bg-zinc-700"
        >
          Clear
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {history.map((entry) => (
          <button
            key={`${entry.ts}-${entry.seed}`}
            type="button"
            onClick={() => onClick(entry)}
            className="group relative shrink-0 overflow-hidden rounded-md border border-zinc-800 transition hover:border-zinc-500"
            title={`${entry.prompt.slice(0, 100)}${entry.prompt.length > 100 ? '…' : ''}\nseed: ${entry.seed} · ${entry.styleLabel ?? 'no style'}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={entry.url}
              alt=""
              className="h-20 w-32 object-cover"
              loading="lazy"
            />
            {entry.isClip && (
              <span className="absolute right-1 top-1 rounded bg-purple-500/80 px-1 py-0.5 text-[9px] font-semibold uppercase text-white">
                clip
              </span>
            )}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1 text-[10px] text-zinc-200">
              {entry.prompt.slice(0, 30)}{entry.prompt.length > 30 ? '…' : ''}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: StatusResponse | null }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-400">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
        Checking…
      </span>
    );
  }
  return status.reachable ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      ComfyUI ready
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      ComfyUI offline
    </span>
  );
}
