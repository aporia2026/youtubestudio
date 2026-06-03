'use client';

/**
 * ShortEditor — Phase 15.10.
 *
 * The single workspace for editing + generating a Short. Same shape as
 * the production-doc page: live Remotion preview at the top, sectioned
 * editor below. Generation actions (style assets, voiceover, render)
 * live INSIDE the editor so the user can see the live preview update
 * after each step instead of staring at a stalled "Generating…" button
 * on the Create surface.
 *
 * Layout:
 *   ┌────────────────────────────────────────────┐
 *   │  9:16 Player preview              ←  back │
 *   │  (mounts ShortVideo composition)          │
 *   ├────────────────────────────────────────────┤
 *   │  Script         (textarea, save on blur)   │
 *   │  Style          (picker + assets + retry)  │
 *   │  Voiceover      (voice picker + Generate)  │
 *   │  Render         (Render + progress + DL)   │
 *   └────────────────────────────────────────────┘
 *
 * Polling: while style assets are still generating server-side, the
 * editor polls the row every 12s to keep the preview + status pill
 * current. Same cadence as ShortsInboxPanel. The interval clears the
 * moment style_assets land.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  SHORT_FPS,
  SHORT_HEIGHT,
  SHORT_WIDTH,
  type ShortVideoConfig,
} from '@/lib/shorts-render-types';
import type {
  GenerationProgressState,
  ShortFrameAnimation,
  ShortFrameCollage,
  ShortRow,
} from '@/lib/shorts-types';
import { ShortStylePicker } from '@/components/shorts/ShortStylePicker';
import { type ShortStyleId } from '@/lib/short-styles';
import {
  anyRowGenerating,
  getStyleAssetStatus,
  isGenerationStale,
  styleAssetLabel,
} from '@/lib/shorts-asset-status';
import { buildShortVideoConfig, splitScriptIntoCaptions } from '@/lib/shorts-render';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';
import type {
  ShortsCaptionChunkOverride,
  ShortsCaptionsConfig,
  ShortsCaptionsStyle,
} from '@/lib/shorts-render-types';

// Dynamic import keeps Remotion's browser-only deps (WebGL, Canvas, etc.)
// out of the SSR bundle. Same pattern the production-doc page uses for its
// VideoPlayer wrapper. The Player + ShortVideo composition both reference
// browser globals at module-load time so they cannot be statically imported
// into an SSR'd file. `as any` on the Player component prop because
// @remotion/player's type is constrained to `Record<string, unknown>` props
// and refuses our typed ShortVideoProps — runtime is correct, only the
// generic is misaligned.
const Player = dynamic(() => import('@remotion/player').then((m) => m.Player), {
  ssr: false,
  loading: () => (
    <div style={{ width: '100%', aspectRatio: '9 / 16', background: 'rgba(255,255,255,0.04)', borderRadius: 12 }} />
  ),
}) as unknown as React.ComponentType<{
  component: unknown;
  inputProps: Record<string, unknown>;
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  durationInFrames: number;
  controls?: boolean;
  style?: React.CSSProperties;
}>;

const ShortVideo = dynamic(
  () => import('@/remotion/compositions/ShortVideo').then((m) => m.ShortVideo),
  { ssr: false },
);

interface ElevenVoice {
  voice_id: string;
  name: string;
}

interface RenderJob {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  progress: number;
  output_url: string | null;
  error: string | null;
}

export function ShortEditor({ shortId }: { shortId: string }) {
  const [row, setRow] = useState<ShortRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable buffers — saved on blur. The row is the source of truth;
  // these mirror it so the user can type without re-render thrash.
  const [titleDraft, setTitleDraft] = useState('');
  const [scriptDraft, setScriptDraft] = useState('');
  const [hookDraft, setHookDraft] = useState('');
  const [payoffDraft, setPayoffDraft] = useState('');

  // Style picker — initial selection from row.style_id, falls back to
  // minimal. The user can change it; clicking "Generate assets" then
  // calls the asset pipeline with the chosen style.
  const [stylePick, setStylePick] = useState<ShortStyleId>('minimal_gradient_v1');

  // Voiceover state.
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [voiceoverBusy, setVoiceoverBusy] = useState(false);

  // Style asset generation state.
  const [assetsBusy, setAssetsBusy] = useState(false);
  // Epoch ms of the last (re)start of asset generation. Used to keep
  // polling through the brief window after a kick — before the server
  // writes its first fresh progress row — so a Retry on a stalled job
  // isn't silently dropped by the staleness gate below.
  const [assetsKickedAt, setAssetsKickedAt] = useState<number | null>(null);

  // Render state.
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [renderBusy, setRenderBusy] = useState(false);

  // Phase 15.11 — alignment data for accurate caption timing in the preview.
  const [alignment, setAlignment] = useState<ForcedAlignmentResponse | null>(null);

  // ── load row + voices ──────────────────────────────────────────────
  const loadRow = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, loads short row
      const res = await fetch(`/api/shorts/${encodeURIComponent(shortId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const short = data.short as ShortRow;
      setRow(short);
      setTitleDraft(short.title ?? '');
      setScriptDraft(short.short_script ?? '');
      setHookDraft(short.hook ?? '');
      setPayoffDraft(short.payoff ?? '');
      if (short.style_id) setStylePick(short.style_id as ShortStyleId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Short');
    } finally {
      setLoading(false);
    }
  }, [shortId]);

  useEffect(() => {
    loadRow();
  }, [loadRow]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads ElevenLabs voices
        const res = await fetch('/api/elevenlabs/voices');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const list = (data.voices || []) as ElevenVoice[];
        setVoices(list);
        if (list.length > 0 && !selectedVoice) setSelectedVoice(list[0]!.voice_id);
      } catch {
        /* voiceover section degrades to an explanation */
      }
    })();
    return () => {
      cancelled = true;
    };
    // selectedVoice intentionally excluded from deps — we don't want to
    // re-fetch every time the user picks a voice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── poll while style assets are generating ─────────────────────────
  // Two cadences (Phase 15.13):
  //   - 2s while `generation_progress.phase` is in flight, so the strip
  //     animates smoothly.
  //   - 12s baseline for the existing `anyRowGenerating` heuristic that
  //     covers older rows + the brief window between row update and the
  //     progress field being cleared.
  // The interval reruns when `pollCadenceMs` flips — useEffect tears
  // down + restarts the setInterval so the new cadence takes effect on
  // the next tick.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressPhase = row?.generation_progress?.phase;
  const progressInFlight =
    progressPhase === 'queued' ||
    progressPhase === 'planning' ||
    progressPhase === 'base' ||
    progressPhase === 'variant';
  // A job still "in flight" past the function's hard deadline is dead (the
  // serverless function was killed before it could write a terminal state).
  // Stop the fast poll — there's nothing left to advance it — and let the
  // strip surface a Retry. Phase 1 has no cron to heal it; Phase 2 will.
  const progressStale = isGenerationStale(row?.generation_progress, Date.now());
  // After a (re)start, keep polling for a grace window even if the row's
  // progress still looks stale — the server hasn't reset started_at yet.
  // Without this, retrying a stalled job would re-arm the staleness gate
  // before the fresh run's first progress write lands, dropping the poll.
  const inKickGrace = assetsKickedAt !== null && Date.now() - assetsKickedAt < 30_000;
  const shouldPoll = row
    ? (anyRowGenerating([row]) || progressInFlight) && (!progressStale || inKickGrace)
    : false;
  const pollCadenceMs = progressInFlight ? 2_000 : 12_000;
  useEffect(() => {
    if (!shouldPoll) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    intervalRef.current = setInterval(() => {
      loadRow();
    }, pollCadenceMs);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [shouldPoll, pollCadenceMs, loadRow]);

  // ── derived preview config ─────────────────────────────────────────
  // The preview tries to build a ShortVideoConfig from the current row.
  // buildShortVideoConfig throws when prerequisites are missing
  // (no voiceover, doodle without assets, etc.) — we catch and
  // surface the message as a friendly placeholder. Alignment threads
  // through when present so caption timing snaps to real word boundaries.
  const { previewConfig, previewMessage } = useMemo<{
    previewConfig: ShortVideoConfig | null;
    previewMessage: string | null;
  }>(() => {
    if (!row) return { previewConfig: null, previewMessage: null };
    try {
      const config = buildShortVideoConfig({ short: row, alignment });
      return { previewConfig: config, previewMessage: null };
    } catch (e) {
      return {
        previewConfig: null,
        previewMessage: e instanceof Error ? e.message : 'Preview unavailable',
      };
    }
  }, [row, alignment]);

  // ── fetch alignment after voiceover lands ─────────────────────────
  useEffect(() => {
    if (!row?.voiceover_audio_url) {
      setAlignment(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads alignment
        const res = await fetch(`/api/shorts/${encodeURIComponent(row.id)}/alignment`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setAlignment(data.alignment as ForcedAlignmentResponse);
      } catch {
        /* preview falls back to proportional timing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row?.id, row?.voiceover_audio_url]);

  // ── PATCH helper for the editable fields ───────────────────────────
  const savePatch = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        const res = await fetch(`/api/shorts/${encodeURIComponent(shortId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setRow(data.short as ShortRow);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Save failed');
      }
    },
    [shortId],
  );

  // ── Phase 15.11 — captions config + helpers ────────────────────────
  const captionsConfig = row?.captions_config ?? {};
  const captionStyle = captionsConfig.style ?? {};
  const chunkOverrides = captionsConfig.chunks ?? [];

  // Derived preview-chunk list so the captions editor lines up with what
  // the renderer will show. Re-runs the same auto-chunker the renderer
  // uses, threading alignment so the chunk text + timestamps match.
  const previewChunks = useMemo(() => {
    if (!row?.short_script) return [] as Array<{ text: string; start_ms: number; end_ms: number }>;
    const baseSeconds = row.voiceover_duration_seconds
      ?? row.estimated_duration_seconds
      ?? 30;
    const durationMs = Math.max(3000, Math.round(baseSeconds * 1000));
    return splitScriptIntoCaptions(row.short_script, durationMs, 4, alignment);
  }, [row?.short_script, row?.voiceover_duration_seconds, row?.estimated_duration_seconds, alignment]);

  const saveStyle = useCallback(
    (patch: Partial<ShortsCaptionsStyle>) => {
      const next: ShortsCaptionsConfig = {
        ...captionsConfig,
        style: { ...captionStyle, ...patch },
      };
      savePatch({ captions_config: next });
    },
    [captionsConfig, captionStyle, savePatch],
  );

  const saveChunkOverride = useCallback(
    (idx: number, patch: ShortsCaptionChunkOverride) => {
      const nextChunks = [...chunkOverrides];
      // Pad with empty objects so idx lands at the right slot.
      while (nextChunks.length <= idx) nextChunks.push({});
      nextChunks[idx] = { ...nextChunks[idx], ...patch };
      const next: ShortsCaptionsConfig = { ...captionsConfig, chunks: nextChunks };
      savePatch({ captions_config: next });
    },
    [captionsConfig, chunkOverrides, savePatch],
  );

  const resetChunkOverride = useCallback(
    (idx: number) => {
      const nextChunks = [...chunkOverrides];
      nextChunks[idx] = {};
      const next: ShortsCaptionsConfig = { ...captionsConfig, chunks: nextChunks };
      savePatch({ captions_config: next });
    },
    [captionsConfig, chunkOverrides, savePatch],
  );

  const resetAllCaptions = useCallback(() => {
    savePatch({ captions_config: {} });
  }, [savePatch]);

  // ── action: generate style assets ──────────────────────────────────
  const generateAssets = useCallback(async () => {
    if (!row) return;
    setAssetsBusy(true);
    try {
      void fetch(`/api/shorts/${encodeURIComponent(row.id)}/generate-style-assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style_id: stylePick }),
        keepalive: true,
      }).catch(() => {
        /* swallow — status surfaces on the next poll */
      });
      if (stylePick === 'minimal_gradient_v1') {
        // Minimal returns fast — re-fetch in a moment.
        setTimeout(() => loadRow(), 1500);
        toast.success('Style stamped as Minimal.');
      } else {
        // Open the kick grace window and optimistically show a fresh
        // in-flight strip, so the user sees feedback immediately (and a
        // Retry of a stalled job clears the stale state) before the server
        // writes its first progress row.
        setAssetsKickedAt(Date.now());
        setRow((prev) =>
          prev
            ? {
                ...prev,
                generation_progress: {
                  phase: 'planning',
                  label: 'Starting…',
                  started_at: new Date().toISOString(),
                  style_id: stylePick,
                },
              }
            : prev,
        );
        toast.success(
          `${styleAssetLabel(stylePick)} assets generating (1-4 min). The preview will update when they land.`,
        );
      }
    } finally {
      setTimeout(() => setAssetsBusy(false), 1500);
    }
  }, [row, stylePick, loadRow]);

  // ── action: generate voiceover ─────────────────────────────────────
  const generateVoiceover = useCallback(async () => {
    if (!row || !selectedVoice) return;
    setVoiceoverBusy(true);
    try {
      const res = await fetch(`/api/shorts/${encodeURIComponent(row.id)}/voiceover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: selectedVoice }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadRow();
      toast.success('Voiceover ready.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Voiceover failed');
    } finally {
      setVoiceoverBusy(false);
    }
  }, [row, selectedVoice, loadRow]);

  // ── action: render to MP4 ──────────────────────────────────────────
  const renderShort = useCallback(async () => {
    if (!row) return;
    setRenderBusy(true);
    try {
      const res = await fetch('/api/render/short', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortId: row.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const renderId = data.renderId as string;
      // Poll the render job — the route already does its own bundle +
      // upload internally; we just want progress + the final URL.
      const pollOnce = async () => {
        // eslint-disable-next-line no-restricted-syntax -- GET, polls render progress
        const j = await fetch(`/api/render/short?renderId=${encodeURIComponent(renderId)}`);
        if (!j.ok) return;
        const jd = await j.json();
        setRenderJob(jd as RenderJob);
        if (jd.status === 'done' || jd.status === 'error') return true;
        return false;
      };
      const interval = setInterval(async () => {
        const done = await pollOnce();
        if (done) {
          clearInterval(interval);
          setRenderBusy(false);
          await loadRow();
        }
      }, 3000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Render failed');
      setRenderBusy(false);
    }
  }, [row, loadRow]);

  // ── render ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading Short…</div>
    );
  }
  if (error || !row) {
    return (
      <div style={{ padding: 32, color: '#fca5a5' }}>
        {error || 'Short not found.'}{' '}
        <Link href="/shorts" style={{ color: '#c4b5fd' }}>
          ← Back to Shorts
        </Link>
      </div>
    );
  }

  const assetStatus = getStyleAssetStatus(row);
  const previewDurationFrames = previewConfig
    ? Math.max(1, Math.round((previewConfig.duration_ms / 1000) * previewConfig.fps))
    : 90;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Link
          href="/shorts"
          style={{
            fontSize: 13,
            color: 'var(--text-secondary, rgba(255,255,255,0.7))',
            textDecoration: 'none',
          }}
        >
          ← Shorts
        </Link>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
          {row.title || 'Untitled Short'}
        </h1>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
          {new Date(row.updated_at).toLocaleString()}
        </span>
      </div>

      {/* ── Preview pane ─────────────────────────────────────────── */}
      <section
        style={{
          marginBottom: 20,
          padding: 16,
          borderRadius: 14,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'grid',
          gridTemplateColumns: 'minmax(280px, 360px) 1fr',
          gap: 20,
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            aspectRatio: '9 / 16',
            background: '#000',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {previewConfig ? (
            <Player
              component={ShortVideo}
              inputProps={{ config: previewConfig }}
              compositionWidth={SHORT_WIDTH}
              compositionHeight={SHORT_HEIGHT}
              fps={SHORT_FPS}
              durationInFrames={previewDurationFrames}
              controls
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
                textAlign: 'center',
                color: 'var(--text-secondary, rgba(255,255,255,0.6))',
                fontSize: 12,
                lineHeight: 1.55,
              }}
            >
              <strong style={{ color: '#fde68a', fontSize: 13, marginBottom: 6 }}>
                Preview unavailable
              </strong>
              {previewMessage}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
          <Row label="Medium" value={row.medium} />
          <Row label="Style" value={row.style_id || 'not picked yet'} />
          <Row label="Words" value={row.word_count ? String(row.word_count) : '—'} />
          <Row
            label="Estimated length"
            value={row.estimated_duration_seconds ? `${row.estimated_duration_seconds}s` : '—'}
          />
          <Row
            label="Voiceover"
            value={
              row.voiceover_audio_url
                ? `${row.voiceover_duration_seconds ?? '?'}s ✓`
                : 'not generated yet'
            }
          />
          <Row
            label="Style assets"
            value={
              assetStatus === 'ready'
                ? `${styleAssetLabel(row.style_id)} ready ✓`
                : assetStatus === 'generating'
                  ? `${styleAssetLabel(row.style_id)} generating (polls every 12s)`
                  : 'n/a'
            }
          />
          <Row
            label="Rendered MP4"
            value={row.rendered_video_url ? 'ready ✓' : 'not rendered yet'}
          />
        </div>
      </section>

      {/* ── Script section ───────────────────────────────────────── */}
      <EditorSection title="Script" subtitle="Edit the spoken text. Saves on blur.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Title</span>
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => titleDraft !== (row.title ?? '') && savePatch({ title: titleDraft })}
              className="input-field"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Hook (first 1-3s)</span>
            <input
              type="text"
              value={hookDraft}
              onChange={(e) => setHookDraft(e.target.value)}
              onBlur={() => hookDraft !== (row.hook ?? '') && savePatch({ hook: hookDraft })}
              className="input-field"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Payoff (closing line)</span>
            <input
              type="text"
              value={payoffDraft}
              onChange={(e) => setPayoffDraft(e.target.value)}
              onBlur={() => payoffDraft !== (row.payoff ?? '') && savePatch({ payoff: payoffDraft })}
              className="input-field"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Full script (spoken body — captions are auto-chunked from this at render time)
            </span>
            <textarea
              rows={10}
              value={scriptDraft}
              onChange={(e) => setScriptDraft(e.target.value)}
              onBlur={() =>
                scriptDraft !== (row.short_script ?? '')
                && savePatch({ short_script: scriptDraft })
              }
              style={{
                ...inputStyle,
                resize: 'vertical',
                fontFamily: 'inherit',
                fontSize: 13,
                lineHeight: 1.6,
              }}
            />
          </label>
        </div>
      </EditorSection>

      {/* ── Style section ────────────────────────────────────────── */}
      <EditorSection
        title="Style"
        subtitle="Pick the visual treatment. Doodle + Paint mint Atlas frames (1-4 min)."
      >
        <ShortStylePicker value={stylePick} onChange={setStylePick} disabled={assetsBusy} />
        {stylePick !== 'minimal_gradient_v1' && <ShortImageModelControls />}
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={generateAssets}
            disabled={assetsBusy}
            style={primaryButton(assetsBusy)}
          >
            {assetsBusy
              ? 'Kicking off…'
              : assetStatus === 'ready' && row.style_id === stylePick
                ? `Regenerate ${styleAssetLabel(stylePick)} assets`
                : stylePick === 'minimal_gradient_v1'
                  ? 'Stamp style'
                  : `Generate ${styleAssetLabel(stylePick)} assets`}
          </button>
          {assetStatus === 'generating' && !progressInFlight && (
            <span style={{ fontSize: 12, color: '#fde68a' }}>
              ● {styleAssetLabel(row.style_id)} pipeline running on the server. Polling every 12s.
            </span>
          )}
        </div>
        <GenerationProgressStrip progress={row.generation_progress} onRetry={generateAssets} />
        <ShotsPanel row={row} onChange={loadRow} />
      </EditorSection>

      {/* ── Captions section (Phase 15.11) ───────────────────────── */}
      <EditorSection
        title="Captions"
        subtitle={
          alignment
            ? `Timing snapped to ${alignment.words.length} ElevenLabs word boundaries. Edit per-chunk text + timing below, or restyle globally.`
            : 'Timing falls back to proportional WPM until the voiceover lands and the aligner runs. Edit text + style now; timing locks once the voiceover is ready.'
        }
      >
        <CaptionsEditorPanel
          previewChunks={previewChunks}
          overrides={chunkOverrides}
          style={captionStyle}
          alignmentReady={!!alignment}
          onStyleChange={saveStyle}
          onChunkChange={saveChunkOverride}
          onChunkReset={resetChunkOverride}
          onResetAll={resetAllCaptions}
        />
      </EditorSection>

      {/* ── Voiceover section ────────────────────────────────────── */}
      <EditorSection
        title="Voiceover"
        subtitle="ElevenLabs multilingual_v2. Re-run with a different voice to overwrite."
      >
        {voices.length === 0 ? (
          <div style={{ fontSize: 12, color: '#fca5a5' }}>
            No ElevenLabs voices loaded — check the ElevenLabs API key in Settings.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Voice</span>
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                disabled={voiceoverBusy}
                style={inputStyle}
              >
                {voices.map((v) => (
                  <option key={v.voice_id} value={v.voice_id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={generateVoiceover}
              disabled={voiceoverBusy || !row.short_script}
              style={primaryButton(voiceoverBusy)}
              title={!row.short_script ? 'Write a script first.' : undefined}
            >
              {voiceoverBusy ? 'Generating…' : row.voiceover_audio_url ? 'Regenerate voiceover' : 'Generate voiceover'}
            </button>
          </div>
        )}
        {row.voiceover_audio_url && (
          <audio
            controls
            src={row.voiceover_audio_url}
            style={{ width: '100%', marginTop: 10 }}
          />
        )}
      </EditorSection>

      {/* ── Render section ───────────────────────────────────────── */}
      <EditorSection
        title="Render"
        subtitle="Compose the MP4 at 1080×1920. Needs voiceover + (for Doodle/Paint) generated assets."
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            onClick={renderShort}
            disabled={renderBusy || !row.voiceover_audio_url}
            style={primaryButton(renderBusy)}
            title={!row.voiceover_audio_url ? 'Generate voiceover first.' : undefined}
          >
            {renderBusy ? `Rendering ${(renderJob?.progress ?? 0).toFixed(0)}%…` : row.rendered_video_url ? 'Re-render' : 'Render Short'}
          </button>
          {row.rendered_video_url && (
            <a
              href={row.rendered_video_url}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: 'inherit',
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Download MP4 →
            </a>
          )}
          {renderJob?.status === 'error' && (
            <span style={{ fontSize: 12, color: '#fca5a5' }}>{renderJob.error}</span>
          )}
        </div>
      </EditorSection>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Small in-file primitives — these are trivial enough that a dedicated file
// would be ceremony for one consumer (rule 2 — match the file's structure).
// ────────────────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  background: 'rgba(0,0,0,0.2)',
  color: 'inherit',
  border: '1px solid rgba(255,255,255,0.1)',
  fontSize: 13,
};

function primaryButton(busy: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 8,
    border: 'none',
    cursor: busy ? 'wait' : 'pointer',
    fontWeight: 600,
    fontSize: 13,
    background: busy ? 'rgba(124,58,237,0.55)' : 'rgba(124,58,237,0.95)',
    color: '#fff',
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ width: 130, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ flex: 1, color: 'var(--text-secondary, rgba(255,255,255,0.85))' }}>
        {value}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Captions editor — Phase 15.11. Lives in this file because it tightly
// couples to ShortEditor's state shape (overrides, preview chunks, save
// helpers). A separate file would be ceremony for one consumer.
// ────────────────────────────────────────────────────────────────────────────

const CAPTION_FONTS: Array<NonNullable<ShortsCaptionsStyle['fontFamily']>> = [
  'Inter',
  'Anton',
  'Bebas Neue',
  'Archivo Black',
  'Patrick Hand',
  'Caveat',
  'Source Serif 4',
  'JetBrains Mono',
];

const ENTRY_EFFECTS: Array<NonNullable<ShortsCaptionsStyle['entryEffect']>> = [
  'fade',
  'pop',
  'slide-up',
  'none',
];

const BACKGROUNDS: Array<NonNullable<ShortsCaptionsStyle['background']>> = [
  'none',
  'solid',
  'blur',
];

const TEXT_TRANSFORMS: Array<NonNullable<ShortsCaptionsStyle['textTransform']>> = [
  'none',
  'uppercase',
  'lowercase',
  'capitalize',
];

function formatMs(ms: number): string {
  const sec = ms / 1000;
  return `${sec.toFixed(2)}s`;
}

function CaptionsEditorPanel({
  previewChunks,
  overrides,
  style,
  alignmentReady,
  onStyleChange,
  onChunkChange,
  onChunkReset,
  onResetAll,
}: {
  previewChunks: Array<{ text: string; start_ms: number; end_ms: number }>;
  overrides: ShortsCaptionChunkOverride[];
  style: ShortsCaptionsStyle;
  alignmentReady: boolean;
  onStyleChange: (patch: Partial<ShortsCaptionsStyle>) => void;
  onChunkChange: (idx: number, patch: ShortsCaptionChunkOverride) => void;
  onChunkReset: (idx: number) => void;
  onResetAll: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Global style controls */}
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: 'rgba(0,0,0,0.18)',
          border: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Global style</strong>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
            All Google Fonts, free.
          </span>
        </header>

        <StyleChipRow
          label="Font"
          value={style.fontFamily ?? null}
          options={CAPTION_FONTS.map((f) => ({ value: f, label: f }))}
          onChange={(v) => onStyleChange({ fontFamily: (v as ShortsCaptionsStyle['fontFamily']) ?? undefined })}
        />
        <StyleChipRow
          label="Effect"
          value={style.entryEffect ?? null}
          options={ENTRY_EFFECTS.map((e) => ({ value: e, label: e }))}
          onChange={(v) => onStyleChange({ entryEffect: (v as ShortsCaptionsStyle['entryEffect']) ?? undefined })}
        />
        <StyleChipRow
          label="Background"
          value={style.background ?? null}
          options={BACKGROUNDS.map((b) => ({ value: b, label: b }))}
          onChange={(v) => onStyleChange({ background: (v as ShortsCaptionsStyle['background']) ?? undefined })}
        />
        <StyleChipRow
          label="Transform"
          value={style.textTransform ?? null}
          options={TEXT_TRANSFORMS.map((t) => ({ value: t, label: t }))}
          onChange={(v) => onStyleChange({ textTransform: (v as ShortsCaptionsStyle['textTransform']) ?? undefined })}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <NumberField
            label="Size scale"
            value={style.sizeScale ?? 1}
            min={0.5}
            max={1.8}
            step={0.05}
            onCommit={(v) => onStyleChange({ sizeScale: v })}
          />
          <NumberField
            label="Position (0 top → 1 bottom)"
            value={style.positionY ?? 0.5}
            min={0}
            max={1}
            step={0.05}
            onCommit={(v) => onStyleChange({ positionY: v })}
          />
          <NumberField
            label="Padding X (px)"
            value={style.paddingX ?? 80}
            min={0}
            max={300}
            step={4}
            onCommit={(v) => onStyleChange({ paddingX: Math.round(v) })}
          />
          <NumberField
            label="Outline width"
            value={style.outlineWidth ?? 0}
            min={0}
            max={20}
            step={1}
            onCommit={(v) => onStyleChange({ outlineWidth: Math.round(v) })}
          />
          <NumberField
            label="Letter spacing"
            value={style.letterSpacing ?? -1.5}
            min={-5}
            max={10}
            step={0.25}
            onCommit={(v) => onStyleChange({ letterSpacing: v })}
          />
          <NumberField
            label="Line height"
            value={style.lineHeight ?? 1.05}
            min={0.8}
            max={2}
            step={0.05}
            onCommit={(v) => onStyleChange({ lineHeight: v })}
          />
          <ColorField
            label="Color"
            value={style.color ?? '#ffffff'}
            onCommit={(v) => onStyleChange({ color: v })}
          />
          <ColorField
            label="Highlight"
            value={style.highlightColor ?? '#a78bfa'}
            onCommit={(v) => onStyleChange({ highlightColor: v })}
          />
          <ColorField
            label="Outline"
            value={style.outlineColor ?? '#000000'}
            onCommit={(v) => onStyleChange({ outlineColor: v })}
          />
        </div>

        <button
          type="button"
          onClick={onResetAll}
          style={{
            alignSelf: 'flex-start',
            padding: '4px 10px',
            borderRadius: 7,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'transparent',
            color: 'var(--text-secondary, rgba(255,255,255,0.75))',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Reset all caption styling
        </button>
      </div>

      {/* Per-chunk editor */}
      <div>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>Per-chunk overrides</strong>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
            {previewChunks.length} chunk{previewChunks.length === 1 ? '' : 's'} •{' '}
            {alignmentReady ? 'real word timing' : 'proportional fallback'}
          </span>
        </header>
        {previewChunks.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            No chunks yet — write a script first.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {previewChunks.map((c, i) => {
            const ov = overrides[i] ?? {};
            const effectiveText = ov.text ?? c.text;
            const effectiveStart = ov.start_ms ?? c.start_ms;
            const effectiveEnd = ov.end_ms ?? c.end_ms;
            const hasOverride = !!(ov.text || ov.start_ms !== undefined || ov.end_ms !== undefined || ov.hidden);
            return (
              <div
                key={i}
                style={{
                  padding: 10,
                  borderRadius: 10,
                  background: ov.hidden
                    ? 'rgba(239,68,68,0.06)'
                    : hasOverride
                      ? 'rgba(124,58,237,0.07)'
                      : 'rgba(0,0,0,0.18)',
                  border: hasOverride
                    ? '1px solid rgba(124,58,237,0.4)'
                    : '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span>#{i + 1}</span>
                  <span>{formatMs(effectiveStart)} – {formatMs(effectiveEnd)}</span>
                  {hasOverride && !ov.hidden && <span style={{ color: '#c4b5fd' }}>overridden</span>}
                  {ov.hidden && <span style={{ color: '#fca5a5' }}>hidden</span>}
                  <button
                    type="button"
                    onClick={() => onChunkChange(i, { hidden: !ov.hidden })}
                    style={{
                      marginLeft: 'auto',
                      padding: '3px 8px',
                      borderRadius: 6,
                      border: '1px solid rgba(255,255,255,0.15)',
                      background: 'transparent',
                      color: 'inherit',
                      fontSize: 10,
                      cursor: 'pointer',
                    }}
                  >
                    {ov.hidden ? 'Show' : 'Hide'}
                  </button>
                  {hasOverride && (
                    <button
                      type="button"
                      onClick={() => onChunkReset(i)}
                      style={{
                        padding: '3px 8px',
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.15)',
                        background: 'transparent',
                        color: 'inherit',
                        fontSize: 10,
                        cursor: 'pointer',
                      }}
                    >
                      Reset
                    </button>
                  )}
                </header>
                <input
                  type="text"
                  defaultValue={effectiveText}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== c.text) {
                      onChunkChange(i, { text: v });
                    } else if (v === c.text && ov.text) {
                      onChunkChange(i, { text: undefined });
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: 7,
                    background: 'rgba(0,0,0,0.25)',
                    color: 'inherit',
                    border: '1px solid rgba(255,255,255,0.1)',
                    fontSize: 13,
                  }}
                  placeholder="Replacement caption text…"
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <NumberField
                    label="Start (s)"
                    inline
                    value={effectiveStart / 1000}
                    step={0.05}
                    onCommit={(v) =>
                      onChunkChange(i, { start_ms: Math.max(0, Math.round(v * 1000)) })
                    }
                  />
                  <NumberField
                    label="End (s)"
                    inline
                    value={effectiveEnd / 1000}
                    step={0.05}
                    onCommit={(v) =>
                      onChunkChange(i, { end_ms: Math.max(0, Math.round(v * 1000)) })
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StyleChipRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  onChange: (next: string | null) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ width: 90, fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      <button
        type="button"
        onClick={() => onChange(null)}
        style={chipStyle(value == null)}
      >
        Auto
      </button>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          style={chipStyle(value === o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '3px 9px',
    borderRadius: 999,
    border: '1px solid ' + (active ? 'rgba(124,58,237,0.85)' : 'rgba(255,255,255,0.1)'),
    background: active ? 'rgba(124,58,237,0.18)' : 'transparent',
    color: active ? '#c4b5fd' : 'var(--text-secondary, rgba(255,255,255,0.75))',
    fontSize: 11,
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
  };
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
  inline,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (v: number) => void;
  inline?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: inline ? 'row' : 'column',
        alignItems: inline ? 'center' : 'stretch',
        gap: inline ? 6 : 3,
        flex: inline ? '1 1 auto' : undefined,
      }}
    >
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</span>
      <input
        type="number"
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onCommit(v);
        }}
        style={{
          padding: '4px 8px',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.25)',
          color: 'inherit',
          border: '1px solid rgba(255,255,255,0.1)',
          fontSize: 12,
          width: inline ? 80 : '100%',
        }}
      />
    </label>
  );
}

function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="color"
          defaultValue={value.startsWith('#') ? value : '#ffffff'}
          onBlur={(e) => onCommit(e.target.value)}
          style={{ width: 36, height: 30, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', cursor: 'pointer' }}
        />
        <input
          type="text"
          defaultValue={value}
          onBlur={(e) => onCommit(e.target.value)}
          style={{
            flex: 1,
            padding: '4px 8px',
            borderRadius: 6,
            background: 'rgba(0,0,0,0.25)',
            color: 'inherit',
            border: '1px solid rgba(255,255,255,0.1)',
            fontSize: 12,
          }}
        />
      </div>
    </label>
  );
}

function EditorSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        marginBottom: 16,
        padding: 18,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>
        {subtitle && (
          <p style={{ margin: 0, marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            {subtitle}
          </p>
        )}
      </header>
      {children}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Shots panel — Phase 15.12. Inline because, like CaptionsEditorPanel above,
// it ties closely to the parent's row + loadRow contract and has exactly one
// consumer. Lives behind the Doodle / Paint style branches; renders nothing
// for Minimal or pre-asset-generation rows.
// ────────────────────────────────────────────────────────────────────────────

interface ShotsPanelFrameBlock {
  base_url: string;
  base_prompt?: string;
  /** Phase 15.16 — i2v animation generated from `base_url`. */
  base_animation?: ShortFrameAnimation;
  variants: Array<{
    url: string;
    caption_chunk_start_index: number;
    edit_prompt?: string;
    /** Phase 15.16 — i2v animation generated from this variant's `url`. */
    animation?: ShortFrameAnimation;
    /** Phase 15.18 — when present, the variant is a 2×2 collage. */
    collage?: ShortFrameCollage;
  }>;
}

/** Resolve which `style_assets` sub-block the panel should operate on
 *  for the row's current `style_id`. Returns null when the row is on a
 *  non-frame-bearing style OR when the pipeline hasn't run yet. */
function pickShotsBlock(row: ShortRow): { key: 'doodle' | 'paint'; block: ShotsPanelFrameBlock } | null {
  if (row.style_id === 'doodle_explainer_2_short' && row.style_assets?.doodle) {
    return { key: 'doodle', block: row.style_assets.doodle };
  }
  if (row.style_id === 'paint_explainer_v1_short' && row.style_assets?.paint) {
    return { key: 'paint', block: row.style_assets.paint };
  }
  return null;
}

/** Phase 15.14 — vendor for GPT Image 2 Edit calls (variant frames).
 *  Stored on the user's `gpt_image_2_edit_primary` setting; persisted
 *  via `POST /api/user/settings/gpt-image-2-edit-primary`.
 *
 *  Atlas is the cost-optimal default (~$0.011/call); Kie is the richer
 *  + slower fallback (~$0.05/call). The dispatcher already does
 *  primary-then-other fallback at the vendor layer — this toggle picks
 *  which vendor IS the primary. */
type VendorChoice = 'atlas' | 'kie';

/** Phase 15.15 — base T2I model registry shape returned by the
 *  settings endpoint. Mirrors `ShortsBaseT2iModelSpec` server-side but
 *  uses plain strings so we don't drag the full type into the client
 *  bundle. */
interface BaseT2iModelOption {
  id: string;
  label: string;
  vendor: 'atlas' | 'kie';
  costUsd: number;
  hint: string;
}

/** Phase 15.16 — i2v model registry shape returned by
 *  `/api/shorts/i2v-models`. Subset of `BrollModelDescriptor`. */
interface I2vModelOption {
  id: string;
  label: string;
  family: string;
  durationSeconds: number;
  priceUsd: number;
  priceUsdLabel: string;
  blurb: string;
  recommended: boolean;
}

const VARIANT_VENDOR_LABELS: Record<VendorChoice, { label: string; cost: string; note: string }> = {
  atlas: {
    label: 'Atlas',
    cost: '$0.011',
    note: 'Cost-optimal. Kie kicks in automatically if Atlas fails.',
  },
  kie: {
    label: 'Kie',
    cost: '$0.05',
    note: 'Higher cost; native 16:9 output. Atlas is the fallback.',
  },
};

/**
 * Base-model + variant-vendor selectors for the Style section (Phase 15.16).
 *
 * The Shots panel carries the same two controls, but it only renders once
 * assets exist — too late if the DEFAULT vendor (Atlas) is the one failing,
 * since you can't reach the selector to switch away before the first
 * generation. This surfaces them up front, next to the Generate button.
 *
 * Self-contained: loads + persists the same global user settings the Shots
 * panel uses (`shorts_base_t2i_model_id`, `gpt_image_2_edit_primary`), so a
 * change here applies to generation immediately and both controls converge
 * on reload. Shown only for the image-based styles (minimal needs neither).
 */
function ShortImageModelControls() {
  const [baseModelId, setBaseModelId] = useState<string>('atlas-gpt-image-2');
  const [baseModelOptions, setBaseModelOptions] = useState<BaseT2iModelOption[]>([]);
  const [baseModelSaving, setBaseModelSaving] = useState(false);
  const [vendor, setVendor] = useState<VendorChoice>('atlas');
  const [vendorSaving, setVendorSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads base model setting
        const res = await fetch('/api/user/settings/shorts-base-t2i-model');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.models)) setBaseModelOptions(data.models as BaseT2iModelOption[]);
        if (typeof data.shorts_base_t2i_model_id === 'string') setBaseModelId(data.shorts_base_t2i_model_id);
      } catch {
        /* swallow — stay on the 'atlas-gpt-image-2' default */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads vendor setting
        const res = await fetch('/api/user/settings/gpt-image-2-edit-primary');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.gpt_image_2_edit_primary === 'atlas' || data.gpt_image_2_edit_primary === 'kie') {
          setVendor(data.gpt_image_2_edit_primary);
        }
      } catch {
        /* swallow — stay on the 'atlas' default */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setBaseModelPersisted = useCallback(async (next: string) => {
    setBaseModelId(next);
    setBaseModelSaving(true);
    try {
      await fetch('/api/user/settings/shorts-base-t2i-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: next }),
      });
    } catch {
      toast.error('Could not save your model choice (still applied for this session).');
    } finally {
      setBaseModelSaving(false);
    }
  }, []);

  const setVendorPersisted = useCallback(async (next: VendorChoice) => {
    setVendor(next);
    setVendorSaving(true);
    try {
      await fetch('/api/user/settings/gpt-image-2-edit-primary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary: next }),
      });
    } catch {
      toast.error('Could not save your vendor choice (still applied for this session).');
    } finally {
      setVendorSaving(false);
    }
  }, []);

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {baseModelOptions.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Base image model:</span>
          <select
            value={baseModelId}
            onChange={(e) => setBaseModelPersisted(e.target.value)}
            disabled={baseModelSaving}
            title={
              baseModelOptions.find((m) => m.id === baseModelId)?.hint
              ?? 'Text-to-image model that generates the base frame'
            }
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.2)',
              color: 'inherit',
              border: '1px solid rgba(255,255,255,0.15)',
              fontSize: 11,
            }}
          >
            {baseModelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — ${m.costUsd.toFixed(3)}
              </option>
            ))}
          </select>
          {baseModelSaving && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>saving…</span>}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Variant vendor:</span>
        {(Object.keys(VARIANT_VENDOR_LABELS) as VendorChoice[]).map((v) => {
          const meta = VARIANT_VENDOR_LABELS[v];
          const active = vendor === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => !active && setVendorPersisted(v)}
              disabled={vendorSaving}
              title={meta.note}
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                border: `1px solid ${active ? 'rgba(167,139,250,0.55)' : 'rgba(255,255,255,0.15)'}`,
                background: active ? 'rgba(167,139,250,0.18)' : 'transparent',
                color: active ? '#c4b5fd' : 'inherit',
                fontSize: 11,
                fontWeight: 500,
                cursor: active || vendorSaving ? 'default' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span>{meta.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>{meta.cost}</span>
            </button>
          );
        })}
        {vendorSaving && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>saving…</span>}
      </div>
    </div>
  );
}

function ShotsPanel({ row, onChange }: { row: ShortRow; onChange: () => Promise<void> | void }) {
  const picked = pickShotsBlock(row);

  // Per-frame busy state. Keys: 'base' for the base frame; numeric index
  // for variants; 'append' for the new-variant form. Allows concurrent
  // ops on different frames if the user clicks fast.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const setBusyFor = useCallback((key: string, v: boolean) => {
    setBusy((prev) => ({ ...prev, [key]: v }));
  }, []);

  // Variant-edit vendor — loaded from UserSettings on mount, updated
  // on toggle, and persisted server-side so it sticks for next session.
  const [vendor, setVendor] = useState<VendorChoice>('atlas');
  const [vendorSaving, setVendorSaving] = useState(false);

  // Base T2I model — same UserSettings pattern as the variant vendor.
  // The available-models list ships with the GET response so the UI
  // dropdown doesn't need a second fetch.
  const [baseModelId, setBaseModelId] = useState<string>('atlas-gpt-image-2');
  const [baseModelOptions, setBaseModelOptions] = useState<BaseT2iModelOption[]>([]);
  const [baseModelSaving, setBaseModelSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads base model setting
        const res = await fetch('/api/user/settings/shorts-base-t2i-model');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.models)) {
          setBaseModelOptions(data.models as BaseT2iModelOption[]);
        }
        if (typeof data.shorts_base_t2i_model_id === 'string') {
          setBaseModelId(data.shorts_base_t2i_model_id);
        }
      } catch {
        /* swallow — stay on the 'atlas-gpt-image-2' default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const setBaseModelPersisted = useCallback(async (next: string) => {
    setBaseModelId(next);
    setBaseModelSaving(true);
    try {
      await fetch('/api/user/settings/shorts-base-t2i-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: next }),
      });
    } catch {
      toast.error('Could not save your model choice (still applied for this session).');
    } finally {
      setBaseModelSaving(false);
    }
  }, []);

  // Phase 15.16 — i2v animation model picker. Reads the user's
  // `default_broll_i2v_model_id` (same setting the b-roll picker
  // uses) so the choice is shared with long-form animation work.
  const [i2vModelId, setI2vModelId] = useState<string>('');
  const [i2vModels, setI2vModels] = useState<I2vModelOption[]>([]);
  const [i2vModelSaving, setI2vModelSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads i2v registry + default
        const res = await fetch('/api/shorts/i2v-models');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.models)) {
          setI2vModels(data.models as I2vModelOption[]);
        }
        if (typeof data.current === 'string') {
          setI2vModelId(data.current);
        }
      } catch {
        /* swallow — picker stays empty, Animate button hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const setI2vModelPersisted = useCallback(async (next: string) => {
    setI2vModelId(next);
    setI2vModelSaving(true);
    try {
      // Reuse the existing /broll-default PUT so long-form + Shorts
      // share one persisted i2v default. The route routes the value
      // into `default_broll_i2v_model_id` based on the model's kind.
      await fetch('/api/user/settings/broll-default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: next }),
      });
    } catch {
      toast.error('Could not save your animation model choice (still applied for this session).');
    } finally {
      setI2vModelSaving(false);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads vendor setting
        const res = await fetch('/api/user/settings/gpt-image-2-edit-primary');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.gpt_image_2_edit_primary === 'atlas' || data.gpt_image_2_edit_primary === 'kie') {
          setVendor(data.gpt_image_2_edit_primary);
        }
      } catch {
        /* swallow — stay on the 'atlas' default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const setVendorPersisted = useCallback(async (next: VendorChoice) => {
    setVendor(next);
    setVendorSaving(true);
    try {
      await fetch('/api/user/settings/gpt-image-2-edit-primary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary: next }),
      });
    } catch {
      toast.error('Could not save your vendor choice (still applied for this session).');
    } finally {
      setVendorSaving(false);
    }
  }, []);

  // Per-frame prompt drafts. Initialised from the stored prompt when the
  // row loads; the user can type freely without re-render thrash.
  // basePromptDraft / variantPromptDrafts[i] / appendPromptDraft.
  const [basePromptDraft, setBasePromptDraft] = useState<string>('');
  const [variantPromptDrafts, setVariantPromptDrafts] = useState<Record<number, string>>({});
  const [appendPromptDraft, setAppendPromptDraft] = useState('');
  const [appendChunkDraft, setAppendChunkDraft] = useState<number>(0);
  const [appendOpen, setAppendOpen] = useState(false);

  // Phase 15.18 — collage append form state. Four panel prompts +
  // chunk index + an optional brief. Same pattern as the single-frame
  // append form just with 4 prompts instead of 1.
  const [collageOpen, setCollageOpen] = useState(false);
  const [collageChunkDraft, setCollageChunkDraft] = useState<number>(0);
  const [collagePanelDrafts, setCollagePanelDrafts] = useState<string[]>([
    '',
    '',
    '',
    '',
  ]);
  const [collageBriefDraft, setCollageBriefDraft] = useState('');

  // Re-sync drafts whenever the row's assets change (e.g., after a
  // regen lands). useEffect on the stable string content so we don't
  // clobber the user's in-flight edits when polling fires while they're
  // typing.
  useEffect(() => {
    setBasePromptDraft(picked?.block.base_prompt ?? '');
    setVariantPromptDrafts(() => {
      const next: Record<number, string> = {};
      picked?.block.variants.forEach((v, i) => {
        next[i] = v.edit_prompt ?? '';
      });
      return next;
    });
    // The variants array reference changes on every parent rerender, but
    // its serialised content is stable across no-op polls. Stringifying
    // the prompts + URLs gives a cheap dependency that only flips on
    // real changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    picked?.block.base_prompt,
    picked?.block.base_url,
    JSON.stringify(picked?.block.variants ?? []),
  ]);

  if (!picked) return null;

  const regenerateBase = async () => {
    const prompt = basePromptDraft.trim();
    if (prompt.length < 8) {
      toast.error('Base prompt needs at least 8 characters.');
      return;
    }
    setBusyFor('base', true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/base`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, model_id: baseModelId }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success('New base frame ready.');
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Regen failed');
    } finally {
      setBusyFor('base', false);
    }
  };

  const regenerateVariant = async (index: number) => {
    const prompt = (variantPromptDrafts[index] ?? '').trim();
    if (prompt.length < 4) {
      toast.error('Edit prompt needs at least 4 characters.');
      return;
    }
    setBusyFor(`v${index}`, true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/variants/${index}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, gpt_image_2_edit_primary: vendor }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success(`Variant ${index} updated.`);
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Regen failed');
    } finally {
      setBusyFor(`v${index}`, false);
    }
  };

  const appendVariant = async () => {
    const prompt = appendPromptDraft.trim();
    if (prompt.length < 4) {
      toast.error('Edit prompt needs at least 4 characters.');
      return;
    }
    if (!Number.isFinite(appendChunkDraft) || appendChunkDraft < 0) {
      toast.error('Caption chunk index must be ≥ 0.');
      return;
    }
    setBusyFor('append', true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/variants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            caption_chunk_start_index: Math.floor(appendChunkDraft),
            gpt_image_2_edit_primary: vendor,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success(`Variant added at chunk ${Math.floor(appendChunkDraft)}.`);
      setAppendPromptDraft('');
      setAppendOpen(false);
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Append failed');
    } finally {
      setBusyFor('append', false);
    }
  };

  const appendCollage = async () => {
    const trimmedPanels = collagePanelDrafts.map((p) => p.trim());
    for (let i = 0; i < trimmedPanels.length; i++) {
      if (trimmedPanels[i].length < 12) {
        toast.error(`Panel ${i + 1} prompt needs ≥12 characters.`);
        return;
      }
    }
    if (!Number.isFinite(collageChunkDraft) || collageChunkDraft < 0) {
      toast.error('Caption chunk index must be ≥ 0.');
      return;
    }
    setBusyFor('collage', true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/variants/collage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caption_chunk_start_index: Math.floor(collageChunkDraft),
            panel_prompts: trimmedPanels,
            brief: collageBriefDraft.trim() || undefined,
            model_id: baseModelId || undefined,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success(
        `Collage variant added at chunk ${Math.floor(collageChunkDraft)} (cost ~$${(data.estimated_cost_usd ?? 0).toFixed(3)}).`,
      );
      setCollagePanelDrafts(['', '', '', '']);
      setCollageBriefDraft('');
      setCollageOpen(false);
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Collage failed');
    } finally {
      setBusyFor('collage', false);
    }
  };

  const animateBase = async () => {
    if (!i2vModelId) {
      toast.error('Pick an animation model first.');
      return;
    }
    setBusyFor('anim-base', true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/base/animate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: i2vModelId }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success('Base frame animated.');
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Animation failed');
    } finally {
      setBusyFor('anim-base', false);
    }
  };

  const clearBaseAnimation = async () => {
    if (!window.confirm('Clear the base animation? The mp4 stays on the provider but the Short stops using it.')) return;
    setBusyFor('anim-base', true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/base/animate`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success('Base animation cleared.');
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Clear failed');
    } finally {
      setBusyFor('anim-base', false);
    }
  };

  const animateVariant = async (index: number) => {
    if (!i2vModelId) {
      toast.error('Pick an animation model first.');
      return;
    }
    setBusyFor(`anim-v${index}`, true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/variants/${index}/animate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: i2vModelId }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success(`Variant ${index} animated.`);
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Animation failed');
    } finally {
      setBusyFor(`anim-v${index}`, false);
    }
  };

  const clearVariantAnimation = async (index: number) => {
    if (!window.confirm(`Clear variant ${index}'s animation?`)) return;
    setBusyFor(`anim-v${index}`, true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/variants/${index}/animate`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success(`Variant ${index} animation cleared.`);
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Clear failed');
    } finally {
      setBusyFor(`anim-v${index}`, false);
    }
  };

  const deleteVariant = async (index: number) => {
    if (!window.confirm(`Delete variant ${index}? This cannot be undone.`)) return;
    setBusyFor(`v${index}`, true);
    try {
      const res = await fetch(
        `/api/shorts/${encodeURIComponent(row.id)}/frames/variants/${index}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast.success(`Variant ${index} removed.`);
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyFor(`v${index}`, false);
    }
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed rgba(255,255,255,0.12)' }}>
      <header style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
          Shots — {picked.key === 'doodle' ? 'Doodle' : 'Paint'} frames
        </h3>
        <p style={{ margin: 0, marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
          1 base + {picked.block.variants.length} variants. Edit the prompt and click Regenerate to
          re-mint any single frame (15-90s each).
        </p>
        {baseModelOptions.length > 0 && (
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Base model:</span>
            <select
              value={baseModelId}
              onChange={(e) => setBaseModelPersisted(e.target.value)}
              disabled={baseModelSaving}
              style={{
                padding: '4px 8px',
                borderRadius: 6,
                background: 'rgba(0,0,0,0.2)',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.15)',
                fontSize: 11,
              }}
              title={
                baseModelOptions.find((m) => m.id === baseModelId)?.hint
                ?? 'Base T2I model used when you click "Regenerate base"'
              }
            >
              {baseModelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — ${m.costUsd.toFixed(3)}
                </option>
              ))}
            </select>
            {baseModelSaving && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>saving…</span>
            )}
          </div>
        )}
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Variant vendor:</span>
          {(Object.keys(VARIANT_VENDOR_LABELS) as VendorChoice[]).map((v) => {
            const meta = VARIANT_VENDOR_LABELS[v];
            const active = vendor === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => !active && setVendorPersisted(v)}
                disabled={vendorSaving}
                title={meta.note}
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: `1px solid ${active ? 'rgba(167,139,250,0.55)' : 'rgba(255,255,255,0.15)'}`,
                  background: active ? 'rgba(167,139,250,0.18)' : 'transparent',
                  color: active ? '#c4b5fd' : 'inherit',
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: active || vendorSaving ? 'default' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span>{meta.label}</span>
                <span style={{ color: 'var(--text-muted)' }}>{meta.cost}</span>
              </button>
            );
          })}
          {vendorSaving && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>saving…</span>
          )}
        </div>
        {i2vModels.length > 0 && (
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Animation model:</span>
            <select
              value={i2vModelId}
              onChange={(e) => setI2vModelPersisted(e.target.value)}
              disabled={i2vModelSaving}
              style={{
                padding: '4px 8px',
                borderRadius: 6,
                background: 'rgba(0,0,0,0.2)',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.15)',
                fontSize: 11,
                maxWidth: 280,
              }}
              title={
                i2vModels.find((m) => m.id === i2vModelId)?.blurb
                ?? 'i2v model used when you click "Animate"'
              }
            >
              {i2vModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.priceUsdLabel} ({m.durationSeconds}s)
                </option>
              ))}
            </select>
            {i2vModelSaving && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>saving…</span>
            )}
          </div>
        )}
      </header>

      <ShotFrameCard
        title="Base frame"
        subtitle={(() => {
          const meta = baseModelOptions.find((m) => m.id === baseModelId);
          return meta
            ? `Regen uses ${meta.label} ($${meta.costUsd.toFixed(3)}) · portrait 9:16`
            : 'Base T2I · portrait 9:16';
        })()}
        imageUrl={picked.block.base_url}
        animation={picked.block.base_animation}
        prompt={basePromptDraft}
        onPromptChange={setBasePromptDraft}
        promptPlaceholder={
          picked.block.base_prompt
            ? undefined
            : '(no prompt recorded — type a new full-scene prompt to regenerate)'
        }
        busy={!!busy.base}
        primaryLabel="Regenerate base"
        onPrimary={regenerateBase}
        animate={
          i2vModels.length > 0
            ? {
                busy: !!busy['anim-base'],
                onAnimate: animateBase,
                onClear: clearBaseAnimation,
              }
            : undefined
        }
      />

      {picked.block.variants.map((v, i) => (
        <ShotFrameCard
          key={`${v.url}-${i}`}
          title={v.collage ? `Variant ${i} · 2×2 collage` : `Variant ${i}`}
          subtitle={
            v.collage
              ? `Swaps in at caption chunk ${v.caption_chunk_start_index} · ${v.collage.panels.length}-panel collage · regen uses ${VARIANT_VENDOR_LABELS[vendor].label} (${VARIANT_VENDOR_LABELS[vendor].cost})`
              : `Swaps in at caption chunk ${v.caption_chunk_start_index} · regen uses ${VARIANT_VENDOR_LABELS[vendor].label} (${VARIANT_VENDOR_LABELS[vendor].cost})`
          }
          imageUrl={v.url}
          collage={v.collage}
          animation={v.animation}
          prompt={variantPromptDrafts[i] ?? ''}
          onPromptChange={(s) =>
            setVariantPromptDrafts((prev) => ({ ...prev, [i]: s }))
          }
          promptPlaceholder={
            v.edit_prompt
              ? undefined
              : '(no prompt recorded — type a new edit instruction to regenerate)'
          }
          busy={!!busy[`v${i}`]}
          primaryLabel="Regenerate"
          onPrimary={() => regenerateVariant(i)}
          danger={{ label: 'Delete', onClick: () => deleteVariant(i) }}
          animate={
            i2vModels.length > 0
              ? {
                  busy: !!busy[`anim-v${i}`],
                  onAnimate: () => animateVariant(i),
                  onClear: () => clearVariantAnimation(i),
                }
              : undefined
          }
        />
      ))}

      {!appendOpen && !collageOpen ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            type="button"
            onClick={() => setAppendOpen(true)}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px dashed rgba(255,255,255,0.2)',
              background: 'transparent',
              color: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            + Append new variant
          </button>
          <button
            type="button"
            onClick={() => setCollageOpen(true)}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px dashed rgba(167,139,250,0.4)',
              background: 'transparent',
              color: '#c4b5fd',
              fontSize: 12,
              cursor: 'pointer',
            }}
            title="Generate a 2×2 collage variant — 4 independent panels composed into one frame."
          >
            + Append 2×2 collage variant
          </button>
        </div>
      ) : appendOpen ? (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(0,0,0,0.18)',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>New variant</div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Caption chunk to swap in at
            </span>
            <input
              type="number"
              min={0}
              value={appendChunkDraft}
              onChange={(e) => setAppendChunkDraft(parseInt(e.target.value, 10) || 0)}
              style={{ ...inputStyle, width: 100 }}
              disabled={!!busy.append}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Edit prompt (describes the change vs the base)
            </span>
            <textarea
              rows={3}
              value={appendPromptDraft}
              onChange={(e) => setAppendPromptDraft(e.target.value)}
              placeholder="e.g. Add a thought bubble above the character with a question mark."
              style={{
                ...inputStyle,
                resize: 'vertical',
                fontFamily: 'inherit',
                fontSize: 12,
              }}
              disabled={!!busy.append}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={appendVariant}
              disabled={!!busy.append}
              style={primaryButton(!!busy.append)}
            >
              {busy.append ? 'Generating…' : 'Create variant'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAppendOpen(false);
                setAppendPromptDraft('');
              }}
              disabled={!!busy.append}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: 'inherit',
                fontSize: 12,
                cursor: busy.append ? 'wait' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            border: '1px solid rgba(167,139,250,0.3)',
            background: 'rgba(167,139,250,0.05)',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            New 2×2 collage variant
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
            4 independent panels composed server-side into one portrait frame. Each panel uses
            your selected base model (currently {baseModelOptions.find((m) => m.id === baseModelId)?.label ?? baseModelId}).
            Total cost ≈ 4× the per-call price.
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Caption chunk to swap in at
            </span>
            <input
              type="number"
              min={0}
              value={collageChunkDraft}
              onChange={(e) => setCollageChunkDraft(parseInt(e.target.value, 10) || 0)}
              style={{ ...inputStyle, width: 100 }}
              disabled={!!busy.collage}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Brief (optional — shown on the variant card)
            </span>
            <input
              type="text"
              value={collageBriefDraft}
              onChange={(e) => setCollageBriefDraft(e.target.value)}
              placeholder="e.g. 4 emotional stages of the character"
              style={inputStyle}
              disabled={!!busy.collage}
            />
          </label>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              marginBottom: 10,
            }}
          >
            {(['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right'] as const).map(
              (label, i) => (
                <label
                  key={label}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Panel {i + 1}: {label}
                  </span>
                  <textarea
                    rows={3}
                    value={collagePanelDrafts[i]}
                    onChange={(e) =>
                      setCollagePanelDrafts((prev) => {
                        const next = prev.slice();
                        next[i] = e.target.value;
                        return next;
                      })
                    }
                    placeholder="Describe this panel's scene (≥12 chars)"
                    style={{
                      ...inputStyle,
                      resize: 'vertical',
                      fontFamily: 'inherit',
                      fontSize: 12,
                    }}
                    disabled={!!busy.collage}
                  />
                </label>
              ),
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={appendCollage}
              disabled={!!busy.collage}
              style={primaryButton(!!busy.collage)}
            >
              {busy.collage ? 'Generating 4 panels…' : 'Create collage variant'}
            </button>
            <button
              type="button"
              onClick={() => {
                setCollageOpen(false);
                setCollagePanelDrafts(['', '', '', '']);
                setCollageBriefDraft('');
              }}
              disabled={!!busy.collage}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: 'inherit',
                fontSize: 12,
                cursor: busy.collage ? 'wait' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ShotFrameCard({
  title,
  subtitle,
  imageUrl,
  animation,
  collage,
  prompt,
  onPromptChange,
  promptPlaceholder,
  busy,
  primaryLabel,
  onPrimary,
  danger,
  animate,
}: {
  title: string;
  subtitle: string;
  imageUrl: string;
  animation?: ShortFrameAnimation;
  collage?: ShortFrameCollage;
  prompt: string;
  onPromptChange: (s: string) => void;
  promptPlaceholder?: string;
  busy: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  danger?: { label: string; onClick: () => void };
  animate?: {
    busy: boolean;
    onAnimate: () => void;
    onClear: () => void;
  };
}) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: 12,
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(0,0,0,0.18)',
        display: 'grid',
        gridTemplateColumns: '96px 1fr',
        gap: 14,
        alignItems: 'flex-start',
      }}
    >
      <a
        href={imageUrl}
        target="_blank"
        rel="noreferrer"
        title="Open full size"
        style={{
          display: 'block',
          width: 96,
          aspectRatio: '2 / 3',
          borderRadius: 8,
          overflow: 'hidden',
          background: '#000',
          border: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={title}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </a>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{subtitle}</span>
          {busy && (
            <span style={{ fontSize: 11, color: '#fde68a' }}>● working…</span>
          )}
        </div>
        <textarea
          rows={3}
          value={prompt}
          placeholder={promptPlaceholder}
          onChange={(e) => onPromptChange(e.target.value)}
          disabled={busy}
          style={{
            ...inputStyle,
            resize: 'vertical',
            fontFamily: 'inherit',
            fontSize: 12,
            width: '100%',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onPrimary}
            disabled={busy || prompt.trim().length === 0}
            style={primaryButton(busy)}
          >
            {busy ? 'Generating…' : primaryLabel}
          </button>
          {animate && !animation && (
            <button
              type="button"
              onClick={animate.onAnimate}
              disabled={animate.busy || busy}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid rgba(167,139,250,0.4)',
                background: animate.busy ? 'rgba(167,139,250,0.12)' : 'transparent',
                color: '#c4b5fd',
                fontSize: 12,
                fontWeight: 500,
                cursor: animate.busy ? 'wait' : 'pointer',
              }}
              title="Generate a 5-10s motion clip from this still using the model selected above."
            >
              {animate.busy ? 'Animating…' : '▶ Animate'}
            </button>
          )}
          {animate && animation && (
            <>
              <button
                type="button"
                onClick={animate.onAnimate}
                disabled={animate.busy || busy}
                style={{
                  padding: '8px 14px',
                  borderRadius: 8,
                  border: '1px solid rgba(167,139,250,0.4)',
                  background: animate.busy ? 'rgba(167,139,250,0.12)' : 'transparent',
                  color: '#c4b5fd',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: animate.busy ? 'wait' : 'pointer',
                }}
              >
                {animate.busy ? 'Animating…' : 'Re-animate'}
              </button>
              <button
                type="button"
                onClick={animate.onClear}
                disabled={animate.busy || busy}
                style={{
                  padding: '8px 14px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: animate.busy ? 'wait' : 'pointer',
                }}
              >
                Clear animation
              </button>
            </>
          )}
          {danger && (
            <button
              type="button"
              onClick={danger.onClick}
              disabled={busy}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid rgba(248,113,113,0.4)',
                background: 'transparent',
                color: '#fca5a5',
                fontSize: 12,
                fontWeight: 500,
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              {danger.label}
            </button>
          )}
        </div>
        {collage && (
          <div
            style={{
              marginTop: 8,
              padding: 8,
              borderRadius: 8,
              border: '1px solid rgba(167,139,250,0.25)',
              background: 'rgba(167,139,250,0.05)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: '#c4b5fd' }}>
              Composed from {collage.grid.cols}×{collage.grid.rows} panels
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 4,
                fontSize: 10,
                color: 'var(--text-muted)',
              }}
            >
              {collage.panels.map((p, i) => (
                <div
                  key={`${p.url}-${i}`}
                  style={{
                    padding: '4px 6px',
                    borderRadius: 4,
                    background: 'rgba(0,0,0,0.18)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    overflow: 'hidden',
                  }}
                  title={p.prompt}
                >
                  <span style={{ fontWeight: 600, color: '#c4b5fd' }}>
                    Panel {i + 1}
                  </span>
                  <span
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      lineHeight: 1.3,
                    }}
                  >
                    {p.prompt}
                  </span>
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 9 }}
                  >
                    open raw →
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
        {animation && (
          <div
            style={{
              marginTop: 8,
              padding: 8,
              borderRadius: 8,
              border: '1px solid rgba(167,139,250,0.25)',
              background: 'rgba(167,139,250,0.05)',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <video
              src={animation.video_url}
              poster={animation.thumbnail_url}
              controls
              loop
              muted
              playsInline
              style={{
                width: 144,
                aspectRatio: '9 / 16',
                borderRadius: 6,
                background: '#000',
                display: 'block',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: '#c4b5fd' }}>Animated</span>
              <span style={{ color: 'var(--text-muted)' }}>
                {animation.model_id} · {animation.duration_s}s · ${animation.cost_usd.toFixed(2)}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                Generated {new Date(animation.generated_at).toLocaleString()}
              </span>
              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Plays in place of the still during this frame's caption window.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Generation progress strip — Phase 15.13. Renders the row's
// `generation_progress` field as a "what's happening right now" bar with
// phase label, sub-progress (variant N / M), elapsed time, and a sticky
// error message on terminal failure. Nothing renders when no job is in
// flight, so the strip is invisible on the happy path.
// ────────────────────────────────────────────────────────────────────────────

function GenerationProgressStrip({
  progress,
  onRetry,
}: {
  progress: GenerationProgressState;
  onRetry?: () => void;
}) {
  // Re-render every second so the elapsed timer ticks even when the
  // poll doesn't fire (the row only re-fetches every 2s in flight). The
  // tick is cheap; one setInterval per editor instance.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!progress.phase) return;
    if (progress.phase === 'done') return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [progress.phase]);

  if (!progress.phase) return null;

  const phase = progress.phase;
  const startedAtMs = progress.started_at ? new Date(progress.started_at).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));

  // A job still mid-phase past the function's hard deadline is dead — the
  // serverless function was killed before its `.catch` could write an
  // error state, so the row froze. Render it as a recoverable failure
  // (Retry) rather than a bar that climbs forever. `danger` unifies the
  // styling for genuine errors and stalls.
  const stalled = isGenerationStale(progress, Date.now());
  const danger = phase === 'error' || stalled;

  // The progress bar uses two heuristics:
  //   - planning: indeterminate (returns null → no bar fill ratio)
  //   - base: ~30s budget; one segment
  //   - variant: current/total against the variant range
  // We weight: planning 0–15%, base 15–35%, variants 35–100%. Lets the
  // bar advance steadily through the whole pipeline so users don't
  // think it's stuck during the long Atlas T2I leg.
  const ratio = (() => {
    if (phase === 'planning') return 0.08;
    if (phase === 'base') return 0.25;
    if (phase === 'variant' && progress.current && progress.total) {
      return 0.35 + (progress.current / progress.total) * 0.65;
    }
    if (phase === 'done') return 1;
    if (phase === 'error') return 1;
    if (stalled) return 1;
    return 0.5;
  })();

  const accent = danger ? '#fca5a5' : '#a78bfa';
  const trackBg =
    danger ? 'rgba(248,113,113,0.12)' : 'rgba(167,139,250,0.12)';

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${danger ? 'rgba(248,113,113,0.35)' : 'rgba(167,139,250,0.3)'}`,
        background: danger ? 'rgba(248,113,113,0.06)' : 'rgba(167,139,250,0.06)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 12,
          color: danger ? '#fca5a5' : 'inherit',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 13 }}>{danger ? '⚠' : '●'}</span>
        <span style={{ fontWeight: 600 }}>
          {stalled
            ? 'Generation stalled'
            : progress.label ?? (phase === 'error' ? 'Pipeline failed.' : 'Working…')}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
          {elapsedSec}s elapsed
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 4,
          background: trackBg,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.min(100, ratio * 100)}%`,
            height: '100%',
            background: accent,
            transition: 'width 600ms ease-out',
            // Animated stripe on indeterminate phases so the user sees
            // motion even when the percentage doesn't advance for ~30s.
            ...(phase === 'planning' || phase === 'base'
              ? {
                  backgroundImage:
                    'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0) 100%)',
                  backgroundSize: '200% 100%',
                  animation: 'shortsProgressShimmer 1.6s linear infinite',
                }
              : {}),
          }}
        />
      </div>
      <style>{`
        @keyframes shortsProgressShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      {stalled && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#fca5a5', lineHeight: 1.5 }}>
          It ran past the time limit and didn&apos;t finish. This usually means the image
          service was slow or rate-limited. Retry to start it again.
        </div>
      )}
      {phase === 'error' && progress.error_message && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: '#fca5a5',
            background: 'rgba(0,0,0,0.18)',
            padding: '6px 8px',
            borderRadius: 6,
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {progress.error_message}
        </div>
      )}
      {danger && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 10,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            background: '#7c3aed',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Retry generation
        </button>
      )}
    </div>
  );
}
