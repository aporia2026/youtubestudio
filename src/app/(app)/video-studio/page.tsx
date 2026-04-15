'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { productionDocToVideoConfig } from '@/remotion/utils';
import type { BrandKit, VideoConfig } from '@/remotion/types';
import { DEFAULT_BRAND_KIT } from '@/remotion/types';

const VideoPlayer = dynamic(
  () => import('@/components/video/VideoPlayer').then(m => m.VideoPlayer),
  { ssr: false, loading: () => <PlayerSkeleton /> },
);

// ─── Types (mirrors production-doc) ──────────────────────────────────────────

interface ProductionRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  on_screen_text: string;
  notes: string;
}
interface ProductionDoc {
  title: string;
  niche: string;
  total_duration: string;
  total_words: number;
  speaking_pace_wpm: number;
  rows: ProductionRow[];
}
interface RowImageState {
  status: string;
  imageUrl?: string;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VideoStudioPage() {
  // ── Loaded doc state
  const [doc, setDoc] = useState<ProductionDoc | null>(null);
  const [rowImages, setRowImages] = useState<RowImageState[]>([]);
  const [voiceoverUrl, setVoiceoverUrl] = useState('');
  const [brandKit, setBrandKit] = useState<Partial<BrandKit>>({
    primaryColor: '#FF0000',
    backgroundColor: '#FFFFFF',
    textColor: '#111111',
    titleColor: '#111111',
    secondaryColor: '#222222',
  });

  // ── Render state
  const [renderStatus, setRenderStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle');
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderOutputUrl, setRenderOutputUrl] = useState<string | null>(null);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load everything from localStorage on mount (client-only)
  useEffect(() => {
    // Load last production doc
    try {
      const saved = localStorage.getItem('prodoc_last_result');
      if (saved) {
        const parsed = JSON.parse(saved) as { doc?: ProductionDoc; rowImages?: RowImageState[] };
        if (parsed.doc?.rows?.length) {
          setDoc(parsed.doc);
          if (parsed.rowImages?.length) setRowImages(parsed.rowImages);
        }
      }
    } catch { /* ignore */ }

    // Load last voiceover URL
    try {
      const history = JSON.parse(localStorage.getItem('voiceover_history') || '[]') as Array<{ audioUrl?: string }>;
      if (Array.isArray(history) && history[0]?.audioUrl) {
        setVoiceoverUrl(history[0].audioUrl);
      }
    } catch { /* ignore */ }

    // Load brand kit
    try {
      const stored = JSON.parse(localStorage.getItem('video_brand_kit') || '{}') as Partial<BrandKit>;
      if (stored.primaryColor) setBrandKit(b => ({ ...b, ...stored }));
    } catch { /* ignore */ }

    return () => { if (renderPollRef.current) clearInterval(renderPollRef.current); };
  }, []);

  // ── Memoised VideoConfig
  const videoConfig = React.useMemo<VideoConfig | null>(() => {
    if (!doc) return null;
    return productionDocToVideoConfig(doc, rowImages, voiceoverUrl || undefined, undefined, brandKit);
  }, [doc, rowImages, voiceoverUrl, brandKit]);

  // ── Brand update helper
  const updateBrand = useCallback((patch: Partial<BrandKit>) => {
    setBrandKit(b => {
      const next = { ...b, ...patch };
      try { localStorage.setItem('video_brand_kit', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ── Render
  const startRender = useCallback(async () => {
    if (!videoConfig) return;
    setRenderStatus('rendering');
    setRenderProgress(0);
    setRenderOutputUrl(null);
    try {
      const res = await fetch('/api/render/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: videoConfig }),
      });
      const data = await res.json() as { renderId?: string; error?: string };
      if (!res.ok || !data.renderId) throw new Error(data.error || 'Failed to start render');

      renderPollRef.current = setInterval(async () => {
        try {
          const s = await fetch(`/api/render/video?renderId=${data.renderId}`);
          const sd = await s.json() as { status: string; progress: number; outputUrl?: string; error?: string };
          setRenderProgress(sd.progress ?? 0);
          if (sd.status === 'done') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('done');
            setRenderOutputUrl(sd.outputUrl || null);
            toast.success('Video rendered — ready to download!');
          } else if (sd.status === 'error') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('error');
            toast.error(`Render failed: ${sd.error || 'Unknown error'}`);
          }
        } catch { /* polling hiccup — keep trying */ }
      }, 2000);
    } catch (err) {
      setRenderStatus('error');
      toast.error(err instanceof Error ? err.message : 'Render failed');
    }
  }, [videoConfig]);

  const imagesReady = rowImages.filter(r => r?.status === 'done').length;
  const totalShots = doc?.rows?.length ?? 0;

  return (
    <div className="p-6 max-w-6xl mx-auto">

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Video Studio</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Assemble your production doc, voiceover and images into a real animated MP4 using Remotion
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-6">

        {/* Left — player */}
        <div className="space-y-4">
          {videoConfig ? (
            <VideoPlayer
              config={videoConfig}
              onRender={startRender}
              isRendering={renderStatus === 'rendering'}
              renderProgress={renderProgress}
              outputUrl={renderOutputUrl || undefined}
            />
          ) : (
            <EmptyState />
          )}

          {renderStatus === 'error' && (
            <p className="text-sm px-4 py-3 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
              Render failed. Make sure BLOB_READ_WRITE_TOKEN and POSTGRES_URL are set in your Vercel environment.
            </p>
          )}
        </div>

        {/* Right — controls */}
        <div className="space-y-4">

          {/* Doc status */}
          <div className="glass rounded-xl p-4 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Source
            </h2>
            {doc ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {doc.title || doc.niche}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Chip label={`${totalShots} shots`} color="purple" />
                  <Chip label={doc.total_duration} color="cyan" />
                  {imagesReady > 0 && <Chip label={`${imagesReady} images`} color="green" />}
                </div>
                <button
                  onClick={() => {
                    try {
                      localStorage.removeItem('prodoc_last_result');
                      setDoc(null); setRowImages([]);
                      toast.info('Cleared — go generate a new Production Doc');
                    } catch { /* ignore */ }
                  }}
                  className="text-xs"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Clear ×
                </button>
              </div>
            ) : (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                No production doc loaded. Go to{' '}
                <a href="/production-doc" style={{ color: 'var(--accent-purple-bright)', textDecoration: 'underline' }}>
                  Production Doc
                </a>{' '}
                and generate one — it auto-loads here.
              </p>
            )}
          </div>

          {/* Voiceover */}
          <div className="glass rounded-xl p-4 space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Voiceover URL
            </label>
            <input
              type="url"
              value={voiceoverUrl}
              onChange={e => setVoiceoverUrl(e.target.value)}
              placeholder="https://...vercel-storage.com/voiceover/..."
              className="input-field text-xs w-full"
            />
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Auto-filled from your latest{' '}
              <a href="/voiceover" style={{ color: 'var(--accent-purple-bright)', textDecoration: 'underline' }}>
                Voiceover Studio
              </a>{' '}
              generation.
            </p>
          </div>

          {/* Brand kit */}
          <div className="glass rounded-xl p-4 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Brand
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <ColorInput
                label="Accent color"
                value={brandKit.primaryColor || '#FF0000'}
                onChange={v => updateBrand({
                  primaryColor: v,
                  secondaryColor: v,
                })}
              />
              <ColorInput
                label="Background"
                value={brandKit.backgroundColor || '#FFFFFF'}
                onChange={v => updateBrand({
                  backgroundColor: v,
                  titleColor: v === '#FFFFFF' ? '#111111' : '#FFFFFF',
                  textColor: v === '#FFFFFF' ? '#222222' : '#EEEEEE',
                })}
              />
            </div>
          </div>

          {/* Video settings */}
          <div className="glass rounded-xl p-4 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Output
            </h2>
            <div className="text-xs space-y-1.5" style={{ color: 'var(--text-secondary)' }}>
              <div className="flex justify-between">
                <span>Resolution</span><span style={{ color: 'var(--text-primary)' }}>1920 × 1080</span>
              </div>
              <div className="flex justify-between">
                <span>Frame rate</span><span style={{ color: 'var(--text-primary)' }}>30 fps</span>
              </div>
              <div className="flex justify-between">
                <span>Codec</span><span style={{ color: 'var(--text-primary)' }}>H.264 MP4</span>
              </div>
              {videoConfig && (
                <div className="flex justify-between">
                  <span>Duration</span>
                  <span style={{ color: 'var(--text-primary)' }}>{doc?.total_duration}</span>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── Small components ─────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      className="rounded-xl flex flex-col items-center justify-center gap-4 text-center"
      style={{
        aspectRatio: '16/9',
        background: 'rgba(255,255,255,0.03)',
        border: '2px dashed var(--border)',
      }}
    >
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        style={{ color: 'var(--text-muted)', opacity: 0.4 }}>
        <rect x="2" y="2" width="20" height="20" rx="2" />
        <line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" />
        <line x1="2" y1="12" x2="22" y2="12" />
      </svg>
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>No video loaded</p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Generate a Production Doc first — it auto-loads here
        </p>
      </div>
      <a
        href="/production-doc"
        className="btn-primary text-sm px-5 py-2"
      >
        Go to Production Doc →
      </a>
    </div>
  );
}

function PlayerSkeleton() {
  return (
    <div
      className="rounded-xl flex items-center justify-center gap-3"
      style={{ aspectRatio: '16/9', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)' }}
    >
      <div className="spinner" style={{ width: 20, height: 20 }} />
      <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading video engine…</span>
    </div>
  );
}

function Chip({ label, color }: { label: string; color: 'purple' | 'cyan' | 'green' }) {
  const colors = {
    purple: { bg: 'rgba(124,58,237,0.15)', text: '#a78bfa' },
    cyan:   { bg: 'rgba(6,182,212,0.12)',  text: '#22d3ee' },
    green:  { bg: 'rgba(16,185,129,0.12)', text: '#34d399' },
  };
  return (
    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: colors[color].bg, color: colors[color].text }}>
      {label}
    </span>
  );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1.5 cursor-pointer">
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{ width: 32, height: 28, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 0, background: 'none' }}
        />
        <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{value}</span>
      </div>
    </label>
  );
}
