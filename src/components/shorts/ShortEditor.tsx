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
import type { ShortRow } from '@/lib/shorts-types';
import { ShortStylePicker } from '@/components/shorts/ShortStylePicker';
import { type ShortStyleId } from '@/lib/short-styles';
import {
  anyRowGenerating,
  getStyleAssetStatus,
  styleAssetLabel,
} from '@/lib/shorts-asset-status';
import { buildShortVideoConfig } from '@/lib/shorts-render';

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

  // Render state.
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [renderBusy, setRenderBusy] = useState(false);

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
  const POLL_INTERVAL_MS = 12_000;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shouldPoll = row ? anyRowGenerating([row]) : false;
  useEffect(() => {
    if (!shouldPoll) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    if (intervalRef.current) return;
    intervalRef.current = setInterval(() => {
      loadRow();
    }, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [shouldPoll, loadRow]);

  // ── derived preview config ─────────────────────────────────────────
  // The preview tries to build a ShortVideoConfig from the current row.
  // buildShortVideoConfig throws when prerequisites are missing
  // (no voiceover, doodle without assets, etc.) — we catch and
  // surface the message as a friendly placeholder.
  const { previewConfig, previewMessage } = useMemo<{
    previewConfig: ShortVideoConfig | null;
    previewMessage: string | null;
  }>(() => {
    if (!row) return { previewConfig: null, previewMessage: null };
    try {
      const config = buildShortVideoConfig({ short: row });
      return { previewConfig: config, previewMessage: null };
    } catch (e) {
      return {
        previewConfig: null,
        previewMessage: e instanceof Error ? e.message : 'Preview unavailable',
      };
    }
  }, [row]);

  // ── PATCH helper for the editable fields ───────────────────────────
  const savePatch = useCallback(
    async (patch: Record<string, string>) => {
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
          {assetStatus === 'generating' && (
            <span style={{ fontSize: 12, color: '#fde68a' }}>
              ● {styleAssetLabel(row.style_id)} pipeline running on the server. Polling every 12s.
            </span>
          )}
        </div>
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
