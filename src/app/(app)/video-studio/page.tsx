'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { productionDocToVideoConfig, msToFrame, ProductionDoc, RowImageState } from '@/remotion/utils';
import type { BrandKit, VideoConfig, VideoShot, SceneType } from '@/remotion/types';
import { DEFAULT_BRAND_KIT } from '@/remotion/types';
import { ALLOWED_FONT_FAMILIES, FONT_REGISTRY } from '@/remotion/fonts';
import { getVoiceoverHistory } from '@/lib/history';

const VideoPlayer = dynamic(
  () => import('@/components/video/VideoPlayer').then(m => m.VideoPlayer),
  { ssr: false, loading: () => <PlayerSkeleton /> },
);

// ─── Manual shot definition (startMs computed on render) ──────────────────────

interface ManualShotDef {
  id: string;
  durationMs: number;
  sceneType: SceneType;
  title?: string;
  subtitle?: string;
  onScreenText?: string;
  imageUrl?: string;
  backgroundColor?: string;
  kenBurnsDirection?: VideoShot['kenBurnsDirection'];
}

let _nextId = 0;
const nextId = () => `ms_${++_nextId}_${Date.now()}`;

// ─── Bulk import parser ───────────────────────────────────────────────────────

interface ImportedShot {
  sceneType: SceneType;
  fields: Partial<ManualShotDef>;
  preview: string;
}

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|avif|svg)(\?.*)?$/i;

function parseImportBlocks(raw: string): ImportedShot[] {
  // Split by blank lines — each block is a separate shot
  const blocks = raw.split(/\n[ \t]*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    // ── Image URL ──
    if (IMAGE_EXT_RE.test(block) && /^https?:\/\//i.test(block)) {
      return { sceneType: 'b-roll' as SceneType, fields: { imageUrl: block, durationMs: 5000 }, preview: block.slice(block.lastIndexOf('/') + 1).slice(0, 40) || 'Image' };
    }
    // ── Any URL ──
    if (/^https?:\/\//i.test(block)) {
      const isScreen = /screen|app|ui|demo|mockup|interface|dashboard/i.test(block);
      const type: SceneType = isScreen ? 'screen-mockup' : 'b-roll';
      return { sceneType: type, fields: { imageUrl: block, durationMs: 5000 }, preview: isScreen ? 'Screen' : 'URL → B-Roll' };
    }
    // ── Outro / subscribe ──
    if (/^(outro|subscribe|end card|end screen)/i.test(block)) {
      return { sceneType: 'outro' as SceneType, fields: { onScreenText: block, durationMs: 5000 }, preview: block.slice(0, 40) };
    }
    // ── Multi-line text (bullets / list) ──
    const lines = block.split('\n').map(l => l.replace(/^[\s\-•·*]+/, '').trim()).filter(Boolean);
    if (lines.length >= 2) {
      const cleaned = lines.join('\n');
      return {
        sceneType: 'text-reveal' as SceneType,
        fields: { onScreenText: cleaned, durationMs: Math.min(Math.max(lines.length * 2000, 4000), 12000) },
        preview: lines[0].slice(0, 40) + (lines.length > 1 ? ` + ${lines.length - 1} more` : ''),
      };
    }
    // ── Short single line → title card ──
    if (block.length <= 70 && !block.includes('.')) {
      return { sceneType: 'title-card' as SceneType, fields: { title: block, durationMs: 4000 }, preview: block };
    }
    // ── Long text → text reveal ──
    return { sceneType: 'text-reveal' as SceneType, fields: { onScreenText: block, durationMs: 6000 }, preview: block.slice(0, 40) + '…' };
  });
}

function buildShotsFromManual(defs: ManualShotDef[]): VideoShot[] {
  let time = 0;
  return defs.map(def => {
    const shot: VideoShot = {
      startMs: time,
      durationMs: def.durationMs,
      sceneType: def.sceneType,
      title: def.title,
      subtitle: def.subtitle,
      onScreenText: def.onScreenText,
      imageUrl: def.imageUrl,
      backgroundColor: def.backgroundColor,
      kenBurnsDirection: def.kenBurnsDirection,
      floatImage: true,
    };
    time += def.durationMs;
    return shot;
  });
}

// ─── Scene type metadata ──────────────────────────────────────────────────────

const SCENE_META: Record<SceneType, { label: string; abbr: string; desc: string; color: string }> = {
  'title-card':    { label: 'Title Card',    abbr: 'TL', desc: 'Bold intro / chapter header',           color: '#7c3aed' },
  'b-roll':        { label: 'B-Roll',        abbr: 'BR', desc: 'Image with Ken Burns camera motion',     color: '#0891b2' },
  'icon-scene':    { label: 'Icon Scene',    abbr: 'IC', desc: 'Flat illustration, floating animation',  color: '#059669' },
  'text-reveal':   { label: 'Text Reveal',   abbr: 'TX', desc: 'Bullets or quote reveals on screen',     color: '#d97706' },
  'screen-mockup': { label: 'Screen Mockup', abbr: 'SM', desc: 'App screenshot in browser frame',       color: '#dc2626' },
  'split-scene':   { label: 'Split Scene',   abbr: 'SP', desc: 'Two items side by side',                color: '#9333ea' },
  'outro':         { label: 'Outro',         abbr: 'OT', desc: 'Subscribe card with channel CTA',       color: '#ca8a04' },
};

// ─── Export presets ───────────────────────────────────────────────────────────

interface ExportSettings { width: number; height: number; fps: number }

const EXPORT_PRESETS = [
  { key: '1080p', label: '1080p HD', sub: '1920×1080', width: 1920, height: 1080 },
  { key: '4k',    label: '4K UHD',   sub: '3840×2160', width: 3840, height: 2160 },
  { key: '720p',  label: '720p',     sub: '1280×720',  width: 1280, height: 720  },
  { key: 'short', label: 'Shorts',   sub: '1080×1920 · 9:16', width: 1080, height: 1920 },
] as const;

const FPS_OPTIONS = [24, 30, 60];

// ─── Page ─────────────────────────────────────────────────────────────────────

type StudioMode = 'doc' | 'scratch';
type RightTab = 'brand' | 'audio' | 'export';
type RenderStatus = 'idle' | 'rendering' | 'done' | 'error';

export default function VideoStudioPage() {

  // ── Source
  const [mode, setMode] = useState<StudioMode>('doc');
  const [doc, setDoc] = useState<ProductionDoc | null>(null);
  const [rowImages, setRowImages] = useState<RowImageState[]>([]);

  // ── Scratch builder
  const [manualShots, setManualShots] = useState<ManualShotDef[]>([]);
  const [editingShot, setEditingShot] = useState<string | null>(null);
  const [showAddPicker, setShowAddPicker] = useState(false);

  // ── Storyboard / seeking
  const [selectedShotIdx, setSelectedShotIdx] = useState<number | null>(null);
  const [seekTargetFrame, setSeekTargetFrame] = useState<number | null>(null);

  // ── Brand
  const [brandKit, setBrandKit] = useState<Partial<BrandKit>>({
    primaryColor: '#FF0000',
    backgroundColor: '#FFFFFF',
    textColor: '#111111',
    titleColor: '#111111',
    secondaryColor: '#222222',
  });

  // ── Audio
  const [voiceoverUrl, setVoiceoverUrl] = useState('');
  const [musicUrl, setMusicUrl] = useState('');
  const [musicVolume, setMusicVolume] = useState(0.12);

  // ── Export
  const [exportSettings, setExportSettings] = useState<ExportSettings>({ width: 1920, height: 1080, fps: 30 });

  // ── Right panel
  const [rightTab, setRightTab] = useState<RightTab>('brand');

  // ── Render
  const [renderStatus, setRenderStatus] = useState<RenderStatus>('idle');
  const [renderProgress, setRenderProgress] = useState(0);
  // The "Download MP4" URL — a presigned R2/S3 URL with `response-content-
  // disposition: attachment` baked in so the browser streams direct from
  // storage (no /api/download-proxy hop → no 300s Vercel function cap on
  // multi-GB downloads).
  const [renderDownloadUrl, setRenderDownloadUrl] = useState<string | null>(null);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load from localStorage
  useEffect(() => {
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
    // Pre-fill the voiceover URL from the user's most recent voiceover.
    // Server-synced history (migration 0049) so a recording made on another
    // device shows up here too.
    getVoiceoverHistory()
      .then((history) => {
        if (history.length > 0 && history[0]?.audioUrl) setVoiceoverUrl(history[0].audioUrl);
      })
      .catch(() => { /* ignore — no prefill is fine */ });
    try {
      const stored = JSON.parse(localStorage.getItem('video_brand_kit') || '{}') as Partial<BrandKit>;
      if (stored.primaryColor) setBrandKit(b => ({ ...b, ...stored }));
    } catch { /* ignore */ }
    return () => { if (renderPollRef.current) clearInterval(renderPollRef.current); };
  }, []);

  // ── Build VideoConfig
  const videoConfig = useMemo<VideoConfig | null>(() => {
    const brand = { ...DEFAULT_BRAND_KIT, ...brandKit };
    if (mode === 'doc') {
      if (!doc?.rows?.length) return null;
      const cfg = productionDocToVideoConfig(doc, rowImages, voiceoverUrl || undefined, musicUrl || undefined, brandKit);
      return { ...cfg, fps: exportSettings.fps, width: exportSettings.width, height: exportSettings.height, musicVolume, brand };
    }
    if (!manualShots.length) return null;
    return {
      fps: exportSettings.fps,
      width: exportSettings.width,
      height: exportSettings.height,
      shots: buildShotsFromManual(manualShots),
      voiceoverUrl: voiceoverUrl || undefined,
      musicUrl: musicUrl || undefined,
      musicVolume,
      brand,
      showCaptions: true,
    };
  }, [mode, doc, rowImages, manualShots, voiceoverUrl, musicUrl, musicVolume, brandKit, exportSettings]);

  const allShots = videoConfig?.shots ?? [];

  // ── Shot click → seek player
  const handleShotClick = useCallback((idx: number) => {
    setSelectedShotIdx(idx);
    const shot = allShots[idx];
    if (shot && videoConfig) {
      const baseFrame = msToFrame(shot.startMs, videoConfig.fps);
      const shotFrames = Math.max(1, msToFrame(shot.durationMs, videoConfig.fps));
      // Skip fade-in (8 frames) but never overshoot the shot
      const seekFrame = Math.min(baseFrame + 8, baseFrame + shotFrames - 1);
      setSeekTargetFrame(seekFrame);
    }
  }, [allShots, videoConfig]);

  // ── Memoised seek-consumed callback (stable ref prevents VideoPlayer effect from re-running)
  const handleSeekConsumed = useCallback(() => setSeekTargetFrame(null), []);

  // ── Brand update
  const updateBrand = useCallback((patch: Partial<BrandKit>) => {
    setBrandKit(b => {
      const next = { ...b, ...patch };
      try { localStorage.setItem('video_brand_kit', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ── Manual shots CRUD
  const addManualShot = useCallback((type: SceneType) => {
    const id = nextId();
    setManualShots(prev => [...prev, { id, durationMs: 5000, sceneType: type }]);
    setEditingShot(id);
    setShowAddPicker(false);
  }, []);

  const updateManualShot = useCallback((id: string, patch: Partial<ManualShotDef>) => {
    setManualShots(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }, []);

  const removeManualShot = useCallback((id: string) => {
    setManualShots(prev => prev.filter(s => s.id !== id));
    setEditingShot(cur => cur === id ? null : cur);
  }, []);

  const moveShotUp = useCallback((id: string) => {
    setManualShots(prev => {
      const i = prev.findIndex(s => s.id === id);
      if (i <= 0) return prev;
      const arr = [...prev];
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      return arr;
    });
  }, []);

  const moveShotDown = useCallback((id: string) => {
    setManualShots(prev => {
      const i = prev.findIndex(s => s.id === id);
      if (i >= prev.length - 1) return prev;
      const arr = [...prev];
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      return arr;
    });
  }, []);

  const addManualShotsInBulk = useCallback((imported: ImportedShot[]) => {
    const newShots: ManualShotDef[] = imported.map(imp => ({
      id: nextId(),
      durationMs: imp.fields.durationMs ?? 5000,
      sceneType: imp.sceneType,
      title: imp.fields.title,
      subtitle: imp.fields.subtitle,
      onScreenText: imp.fields.onScreenText,
      imageUrl: imp.fields.imageUrl,
      backgroundColor: imp.fields.backgroundColor,
      kenBurnsDirection: imp.fields.kenBurnsDirection,
    }));
    setManualShots(prev => [...prev, ...newShots]);
  }, []);

  // ── Render
  const startRender = useCallback(async () => {
    if (!videoConfig) return;
    // Clear any existing poll before starting a new one (prevents memory leak)
    if (renderPollRef.current) clearInterval(renderPollRef.current);
    setRenderStatus('rendering');
    setRenderProgress(0);
    setRenderDownloadUrl(null);
    try {
      const res = await fetch('/api/render/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: videoConfig }),
      });
      const data = await res.json() as { renderId?: string; error?: string };
      if (!res.ok || !data.renderId) throw new Error(data.error || 'Failed to start render');
      const renderId = data.renderId;
      renderPollRef.current = setInterval(async () => {
        try {
          const s = await fetch(`/api/render/video?renderId=${renderId}`);
          const sd = await s.json() as { status: string; progress: number; downloadUrl?: string | null; error?: string };
          setRenderProgress(sd.progress ?? 0);
          if (sd.status === 'done') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('done');
            setRenderDownloadUrl(sd.downloadUrl ?? null);
            toast.success('Video rendered — ready to download!');
          } else if (sd.status === 'error') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('error');
            toast.error(`Render failed: ${sd.error || 'Unknown error'}`);
          }
        } catch { /* polling hiccup */ }
      }, 2000);
    } catch (err) {
      setRenderStatus('error');
      toast.error(err instanceof Error ? err.message : 'Render failed');
    }
  }, [videoConfig]);

  const imagesReady = rowImages.filter(r => r?.status === 'done').length;

  return (
    <div className="flex flex-col" style={{ height: '100vh', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div
        className="flex items-center justify-between px-5 py-3 shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
      >
        <div>
          <h1 className="text-xl font-bold gradient-text">Video Studio</h1>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Build, preview and render animated YouTube videos
          </p>
        </div>
        {/* Mode toggle */}
        <div className="flex rounded-lg p-0.5 gap-0.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)' }}>
          {(['doc', 'scratch'] as StudioMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="px-4 py-1.5 rounded-md text-sm font-medium transition-all"
              style={{
                background: mode === m ? 'rgba(124,58,237,0.35)' : 'transparent',
                color: mode === m ? '#c4b5fd' : 'var(--text-muted)',
                border: mode === m ? '1px solid rgba(124,58,237,0.4)' : '1px solid transparent',
              }}
            >
              {m === 'doc' ? 'Production Doc' : 'From Scratch'}
            </button>
          ))}
        </div>
      </div>

      {/* ── 3-column layout ── */}
      <div className="flex flex-1 min-h-0">

        {/* ── LEFT PANEL ── */}
        <div
          className="flex flex-col shrink-0 overflow-hidden"
          style={{ width: 264, borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
        >
          {mode === 'doc' ? (
            <DocPanel
              doc={doc}
              allShots={allShots}
              selectedShotIdx={selectedShotIdx}
              imagesReady={imagesReady}
              totalShots={doc?.rows?.length ?? 0}
              totalDuration={doc?.total_duration ?? ''}
              onShotClick={handleShotClick}
              onClearDoc={() => {
                try { localStorage.removeItem('prodoc_last_result'); } catch { /* ignore */ }
                setDoc(null);
                setRowImages([]);
                setSelectedShotIdx(null);
              }}
            />
          ) : (
            <ScratchPanel
              shots={manualShots}
              editingShot={editingShot}
              showAddPicker={showAddPicker}
              onShowAddPicker={setShowAddPicker}
              onAddShot={addManualShot}
              onBulkAdd={addManualShotsInBulk}
              onEditShot={id => setEditingShot(cur => cur === id ? null : id)}
              onUpdateShot={updateManualShot}
              onRemoveShot={removeManualShot}
              onMoveUp={moveShotUp}
              onMoveDown={moveShotDown}
            />
          )}
        </div>

        {/* ── CENTER: PLAYER ── */}
        <div
          className="flex flex-col flex-1 min-w-0 overflow-hidden"
          style={{ background: 'var(--bg-primary)' }}
        >
          {videoConfig ? (
            <div className="flex flex-col h-full">
              {/* Player area */}
              <div className="flex-1 min-h-0 p-4 flex items-center justify-center">
                <VideoPlayer
                  config={videoConfig}
                  onRender={() => { setRightTab('export'); startRender(); }}
                  isRendering={renderStatus === 'rendering'}
                  renderProgress={renderProgress}
                  downloadUrl={renderDownloadUrl}
                  initialFrame={8}
                  seekTargetFrame={seekTargetFrame}
                  onSeekConsumed={handleSeekConsumed}
                />
              </div>
              {/* Shot info bar */}
              {selectedShotIdx !== null && allShots[selectedShotIdx] && (() => {
                const s = allShots[selectedShotIdx];
                const meta = SCENE_META[s.sceneType];
                return (
                  <div
                    className="shrink-0 px-4 py-2 flex items-center gap-3 text-xs"
                    style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  >
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Shot {selectedShotIdx + 1} of {allShots.length}
                    </span>
                    <span>·</span>
                    <span
                      className="px-2 py-0.5 rounded-full"
                      style={{ background: meta.color + '22', color: meta.color }}
                    >
                      {meta.label}
                    </span>
                    <span>·</span>
                    <span>{(s.durationMs / 1000).toFixed(1)}s</span>
                    {s.imageUrl && (
                      <><span>·</span><span style={{ color: '#34d399' }}>✓ image</span></>
                    )}
                  </div>
                );
              })()}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-8">
              <EmptyStateContent mode={mode} />
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL ── */}
        <div
          className="flex flex-col shrink-0 overflow-hidden"
          style={{ width: 296, borderLeft: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
        >
          {/* Tab bar */}
          <div className="flex shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            {(['brand', 'audio', 'export'] as RightTab[]).map(t => (
              <button
                key={t}
                onClick={() => setRightTab(t)}
                className="flex-1 py-3 text-xs font-semibold uppercase tracking-wider transition-colors capitalize"
                style={{
                  color: rightTab === t ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                  borderBottom: rightTab === t ? '2px solid var(--accent-purple-bright)' : '2px solid transparent',
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {rightTab === 'brand' && <BrandTab brand={brandKit} onBrand={updateBrand} />}
            {rightTab === 'audio' && (
              <AudioTab
                voiceoverUrl={voiceoverUrl} onVoiceover={setVoiceoverUrl}
                musicUrl={musicUrl} onMusicUrl={setMusicUrl}
                musicVolume={musicVolume} onMusicVolume={setMusicVolume}
              />
            )}
            {rightTab === 'export' && (
              <ExportTab
                settings={exportSettings} onSettings={setExportSettings}
                renderStatus={renderStatus} renderProgress={renderProgress}
                renderDownloadUrl={renderDownloadUrl}
                canRender={!!videoConfig} onRender={startRender}
                shotCount={allShots.length} mode={mode}
              />
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── DocPanel ─────────────────────────────────────────────────────────────────

interface DocPanelProps {
  doc: ProductionDoc | null;
  allShots: VideoShot[];
  selectedShotIdx: number | null;
  imagesReady: number;
  totalShots: number;
  totalDuration: string;
  onShotClick: (idx: number) => void;
  onClearDoc: () => void;
}

function DocPanel({ doc, allShots, selectedShotIdx, imagesReady, totalShots, totalDuration, onShotClick, onClearDoc }: DocPanelProps) {
  if (!doc) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 p-6 text-center gap-3">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'rgba(124,58,237,0.1)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#a78bfa' }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>No doc loaded</p>
          <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Generate a Production Doc first — it auto-loads here
          </p>
        </div>
        <a href="/production-doc" className="btn-primary text-xs px-4 py-2 rounded-lg">
          Go to Production Doc →
        </a>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Or switch to <strong>From Scratch</strong> to build manually
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Doc info */}
      <div className="shrink-0 p-3 space-y-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
          {doc.title || doc.niche}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Chip label={`${totalShots} shots`} color="purple" />
          {totalDuration && <Chip label={totalDuration} color="cyan" />}
          {imagesReady > 0 && <Chip label={`${imagesReady} imgs`} color="green" />}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={onClearDoc} className="text-xs hover:opacity-80 transition-opacity" style={{ color: 'var(--text-muted)' }}>
            Clear doc ×
          </button>
          <a href="/production-doc" className="text-xs hover:opacity-80" style={{ color: 'var(--accent-purple-bright)' }}>
            Regenerate →
          </a>
        </div>
      </div>
      {/* Storyboard */}
      <div className="shrink-0 px-3 pt-3 pb-1">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          Storyboard · {allShots.length} shots
        </p>
      </div>
      <div className="flex-1 overflow-y-auto pb-4">
        {allShots.map((shot, i) => (
          <ShotListItem
            key={i}
            index={i}
            shot={shot}
            isSelected={selectedShotIdx === i}
            onClick={() => onShotClick(i)}
          />
        ))}
      </div>
    </>
  );
}

// ─── ScratchPanel ─────────────────────────────────────────────────────────────

interface ScratchPanelProps {
  shots: ManualShotDef[];
  editingShot: string | null;
  showAddPicker: boolean;
  onShowAddPicker: (v: boolean) => void;
  onAddShot: (type: SceneType) => void;
  onBulkAdd: (shots: ImportedShot[]) => void;
  onEditShot: (id: string) => void;
  onUpdateShot: (id: string, patch: Partial<ManualShotDef>) => void;
  onRemoveShot: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}

const ADDABLE_SCENES: SceneType[] = ['title-card', 'b-roll', 'icon-scene', 'text-reveal', 'screen-mockup', 'outro'];

function ScratchPanel({ shots, editingShot, showAddPicker, onShowAddPicker, onAddShot, onBulkAdd, onEditShot, onUpdateShot, onRemoveShot, onMoveUp, onMoveDown }: ScratchPanelProps) {
  const [showBulk, setShowBulk] = React.useState(false);
  const totalMs = shots.reduce((s, sh) => s + sh.durationMs, 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 p-3 space-y-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between gap-1">
          <p className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: 'var(--text-muted)' }}>
            Shots {shots.length > 0 ? `· ${shots.length} · ${(totalMs / 1000).toFixed(0)}s` : ''}
          </p>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => { setShowBulk(b => !b); onShowAddPicker(false); }}
              title="Paste content in bulk — system auto-detects scene types"
              className="text-xs px-2 py-1 rounded-lg font-medium transition-colors"
              style={{
                background: showBulk ? 'rgba(6,182,212,0.2)' : 'rgba(255,255,255,0.06)',
                color: showBulk ? '#67e8f9' : 'var(--text-muted)',
                border: showBulk ? '1px solid rgba(6,182,212,0.35)' : '1px solid var(--border)',
              }}
            >
              Bulk
            </button>
            <button
              onClick={() => { onShowAddPicker(!showAddPicker); setShowBulk(false); }}
              className="text-xs px-2 py-1 rounded-lg font-medium transition-colors"
              style={{ background: 'rgba(124,58,237,0.2)', color: '#c4b5fd', border: '1px solid rgba(124,58,237,0.3)' }}
            >
              + Add
            </button>
          </div>
        </div>

        {/* Bulk import area */}
        {showBulk && (
          <BulkImportArea
            onAdd={imported => { onBulkAdd(imported); setShowBulk(false); }}
            onClose={() => setShowBulk(false)}
          />
        )}

        {/* Scene type picker */}
        {showAddPicker && !showBulk && (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {ADDABLE_SCENES.map(type => {
              const meta = SCENE_META[type];
              return (
                <button
                  key={type}
                  onClick={() => onAddShot(type)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/5"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <span
                    className="shrink-0 w-8 h-6 rounded text-xs font-bold flex items-center justify-center"
                    style={{ background: meta.color + '22', color: meta.color }}
                  >
                    {meta.abbr}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{meta.label}</p>
                    <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{meta.desc}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {shots.length === 0 && !showAddPicker && !showBulk && (
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <strong style={{ color: 'var(--text-secondary)' }}>Bulk</strong> — paste images & text, auto-detected.{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>+ Add</strong> — pick a scene type manually.
          </p>
        )}
      </div>

      {/* Shot list */}
      <div className="flex-1 overflow-y-auto py-2">
        {shots.map((shot, i) => (
          <div key={shot.id}>
            <ScratchShotRow
              shot={shot}
              index={i}
              isFirst={i === 0}
              isLast={i === shots.length - 1}
              isEditing={editingShot === shot.id}
              onEdit={() => onEditShot(shot.id)}
              onMoveUp={() => onMoveUp(shot.id)}
              onMoveDown={() => onMoveDown(shot.id)}
              onRemove={() => onRemoveShot(shot.id)}
            />
            {editingShot === shot.id && (
              <ShotEditorInline shot={shot} onUpdate={patch => onUpdateShot(shot.id, patch)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── BulkImportArea ────────────────────────────────────────────────────────────

function BulkImportArea({ onAdd, onClose }: { onAdd: (shots: ImportedShot[]) => void; onClose: () => void }) {
  const [raw, setRaw] = React.useState('');
  const previews = React.useMemo(() => parseImportBlocks(raw), [raw]);

  return (
    <div className="space-y-2 rounded-xl p-3" style={{ background: 'rgba(6,182,212,0.05)', border: '1px solid rgba(6,182,212,0.2)' }}>
      <p className="text-xs font-semibold" style={{ color: '#67e8f9' }}>Bulk Import</p>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Paste URLs, text, or bullet lists. Separate shots with a blank line — the system detects each scene type.
      </p>
      <textarea
        value={raw}
        onChange={e => setRaw(e.target.value)}
        placeholder={`https://example.com/photo.jpg\n\nLearn JavaScript in 10 Steps\n\n• Step 1: Variables\n• Step 2: Functions\n• Step 3: Arrays\n\nSubscribe for more tips`}
        className="input-field text-xs w-full resize-none font-mono"
        rows={6}
        autoFocus
      />
      {previews.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Detected {previews.length} shot{previews.length !== 1 ? 's' : ''}:</p>
          <div className="max-h-28 overflow-y-auto space-y-0.5">
            {previews.map((p, i) => {
              const meta = SCENE_META[p.sceneType];
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="shrink-0 w-6 h-5 rounded flex items-center justify-center font-bold text-[10px]"
                    style={{ background: meta.color + '22', color: meta.color }}>
                    {meta.abbr}
                  </span>
                  <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{p.preview}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => previews.length > 0 && onAdd(previews)}
          disabled={previews.length === 0}
          className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-40"
          style={{ background: 'rgba(6,182,212,0.25)', color: '#67e8f9', border: '1px solid rgba(6,182,212,0.4)' }}
        >
          Add {previews.length > 0 ? `${previews.length} shot${previews.length !== 1 ? 's' : ''}` : 'shots'}
        </button>
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs transition-all hover:bg-white/10"
          style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── ShotListItem (doc storyboard) ────────────────────────────────────────────

function ShotListItem({ index, shot, isSelected, onClick }: { index: number; shot: VideoShot; isSelected: boolean; onClick: () => void }) {
  const meta = SCENE_META[shot.sceneType];
  const preview = shot.title || shot.onScreenText || shot.scriptText || '';
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors"
      style={{
        background: isSelected ? 'rgba(124,58,237,0.12)' : 'transparent',
        borderLeft: isSelected ? '2px solid var(--accent-purple-bright)' : '2px solid transparent',
      }}
    >
      <span className="shrink-0 text-xs font-mono w-7 text-right" style={{ color: 'var(--text-muted)' }}>
        {index + 1}
      </span>
      <span
        className="shrink-0 text-xs font-bold px-1.5 py-0.5 rounded"
        style={{ background: meta.color + '22', color: meta.color, minWidth: 26, textAlign: 'center' }}
      >
        {meta.abbr}
      </span>
      <span className="flex-1 min-w-0 text-xs truncate" style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
        {preview || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>no text</span>}
      </span>
      <span className="shrink-0 text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
        {(shot.durationMs / 1000).toFixed(1)}s
      </span>
      {shot.imageUrl && (
        <span style={{ color: '#34d399', fontSize: 8 }}>●</span>
      )}
    </button>
  );
}

// ─── ScratchShotRow ───────────────────────────────────────────────────────────

function ScratchShotRow({ shot, index, isFirst, isLast, isEditing, onEdit, onMoveUp, onMoveDown, onRemove }: {
  shot: ManualShotDef; index: number; isFirst: boolean; isLast: boolean;
  isEditing: boolean; onEdit: () => void;
  onMoveUp: () => void; onMoveDown: () => void; onRemove: () => void;
}) {
  const meta = SCENE_META[shot.sceneType];
  const preview = shot.title || shot.onScreenText || '';
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 group"
      style={{
        background: isEditing ? 'rgba(124,58,237,0.08)' : 'transparent',
        borderLeft: isEditing ? '2px solid var(--accent-purple-bright)' : '2px solid transparent',
      }}
    >
      <span className="shrink-0 text-xs font-mono w-5 text-right" style={{ color: 'var(--text-muted)' }}>{index + 1}</span>
      <span
        className="shrink-0 text-xs font-bold px-1.5 py-0.5 rounded"
        style={{ background: meta.color + '22', color: meta.color }}
      >
        {meta.abbr}
      </span>
      <button onClick={onEdit} className="flex-1 min-w-0 text-left">
        <span className="text-xs truncate block" style={{ color: 'var(--text-secondary)' }}>
          {preview || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>untitled</span>}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{(shot.durationMs / 1000).toFixed(0)}s</span>
      </button>
      {/* Controls */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={onMoveUp} disabled={isFirst} className="p-1 rounded transition-colors hover:bg-white/10 disabled:opacity-20" title="Move up">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
        <button onClick={onMoveDown} disabled={isLast} className="p-1 rounded transition-colors hover:bg-white/10 disabled:opacity-20" title="Move down">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button onClick={onRemove} className="p-1 rounded transition-colors hover:bg-red-500/20" title="Remove" style={{ color: '#f87171' }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
  );
}

// ─── ShotEditorInline ─────────────────────────────────────────────────────────

function ShotEditorInline({ shot, onUpdate }: { shot: ManualShotDef; onUpdate: (patch: Partial<ManualShotDef>) => void }) {
  const meta = SCENE_META[shot.sceneType];
  const hasTitle = ['title-card', 'icon-scene'].includes(shot.sceneType);
  const hasSubtitle = shot.sceneType === 'title-card';
  const hasOnScreenText = ['b-roll', 'text-reveal', 'outro'].includes(shot.sceneType);
  const hasImage = ['b-roll', 'icon-scene', 'screen-mockup'].includes(shot.sceneType);
  const hasKenBurns = shot.sceneType === 'b-roll';

  return (
    <div className="mx-3 mb-2 rounded-xl p-3 space-y-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)' }}>
      <p className="text-xs font-semibold" style={{ color: meta.color }}>{meta.label} Editor</p>

      {/* Scene type */}
      <div className="space-y-1">
        <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Scene type</label>
        <select
          value={shot.sceneType}
          onChange={e => onUpdate({ sceneType: e.target.value as SceneType })}
          className="input-field text-xs w-full"
        >
          {ADDABLE_SCENES.map(t => (
            <option key={t} value={t}>{SCENE_META[t].label}</option>
          ))}
        </select>
      </div>

      {/* Duration */}
      <div className="space-y-1">
        <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
          <span>Duration</span><span style={{ color: 'var(--text-secondary)' }}>{(shot.durationMs / 1000).toFixed(1)}s</span>
        </label>
        <input
          type="range" min={1500} max={20000} step={500}
          value={shot.durationMs}
          onChange={e => onUpdate({ durationMs: Number(e.target.value) })}
          className="w-full accent-purple-500"
        />
      </div>

      {hasTitle && (
        <div className="space-y-1">
          <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Title</label>
          <input
            type="text" value={shot.title || ''} placeholder="Main title text"
            onChange={e => onUpdate({ title: e.target.value })}
            className="input-field text-xs w-full"
          />
        </div>
      )}

      {hasSubtitle && (
        <div className="space-y-1">
          <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Subtitle</label>
          <input
            type="text" value={shot.subtitle || ''} placeholder="Optional subtitle"
            onChange={e => onUpdate({ subtitle: e.target.value })}
            className="input-field text-xs w-full"
          />
        </div>
      )}

      {hasOnScreenText && (
        <div className="space-y-1">
          <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {shot.sceneType === 'text-reveal' ? 'Text content' : shot.sceneType === 'outro' ? 'CTA text' : 'On-screen text'}
          </label>
          <textarea
            value={shot.onScreenText || ''} placeholder={shot.sceneType === 'text-reveal' ? 'Each line = one bullet' : 'Text overlay'}
            onChange={e => onUpdate({ onScreenText: e.target.value })}
            className="input-field text-xs w-full resize-none"
            rows={3}
          />
        </div>
      )}

      {hasImage && (
        <div className="space-y-1">
          <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Image URL</label>
          <input
            type="url" value={shot.imageUrl || ''} placeholder="https://..."
            onChange={e => onUpdate({ imageUrl: e.target.value })}
            className="input-field text-xs w-full"
          />
        </div>
      )}

      {hasKenBurns && (
        <div className="space-y-1">
          <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Camera motion</label>
          <select
            value={shot.kenBurnsDirection || 'zoom-in'}
            onChange={e => onUpdate({ kenBurnsDirection: e.target.value as VideoShot['kenBurnsDirection'] })}
            className="input-field text-xs w-full"
          >
            {['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'].map(d => (
              <option key={d} value={d}>{d.replace('-', ' ')}</option>
            ))}
          </select>
        </div>
      )}

      {/* Background color */}
      <div className="space-y-1">
        <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Background override</label>
        <div className="flex items-center gap-2">
          <input
            type="color" value={shot.backgroundColor || '#FFFFFF'}
            onChange={e => onUpdate({ backgroundColor: e.target.value })}
            style={{ width: 32, height: 28, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 0, background: 'none' }}
          />
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{shot.backgroundColor || 'default'}</span>
          {shot.backgroundColor && (
            <button onClick={() => onUpdate({ backgroundColor: undefined })} className="text-xs" style={{ color: 'var(--text-muted)' }}>clear</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── BrandTab ─────────────────────────────────────────────────────────────────

function BrandTab({ brand, onBrand }: { brand: Partial<BrandKit>; onBrand: (p: Partial<BrandKit>) => void }) {
  // The font list mirrors the curated set in `src/remotion/fonts.ts` —
  // only families actually loaded by `@remotion/google-fonts` render
  // correctly. The legacy entries (Space Grotesk, Oswald, DM Sans) were
  // never bundled and rendered with the system fallback. Each value is
  // the CSS fallback stack from FONT_REGISTRY.
  const FONT_OPTIONS: Array<{ label: string; value: string }> = ALLOWED_FONT_FAMILIES.map((name) => ({
    label: name === 'Inter' ? 'Inter (default)' : name,
    value: FONT_REGISTRY[name].fallback,
  }));

  return (
    <div className="p-4 space-y-5">
      <Section title="Colors">
        <ColorRow label="Accent" value={brand.primaryColor || '#FF0000'}
          onChange={v => onBrand({ primaryColor: v, secondaryColor: v })} />
        <ColorRow label="Background" value={brand.backgroundColor || '#FFFFFF'}
          onChange={v => onBrand({
            backgroundColor: v,
            titleColor: v === '#FFFFFF' ? '#111111' : '#FFFFFF',
            textColor: v === '#FFFFFF' ? '#222222' : '#EEEEEE',
          })} />
        <ColorRow label="Text" value={brand.textColor || '#111111'}
          onChange={v => onBrand({ textColor: v })} />
        <ColorRow label="Title" value={brand.titleColor || '#111111'}
          onChange={v => onBrand({ titleColor: v })} />
      </Section>

      <Section title="Typography">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Font family</span>
          <select
            value={brand.fontFamily || FONT_OPTIONS[0].value}
            onChange={e => onBrand({ fontFamily: e.target.value, titleFontFamily: e.target.value })}
            className="input-field text-xs"
          >
            {FONT_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
      </Section>

      <Section title="Channel branding">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Channel name</span>
          <input
            type="text" value={brand.channelName || ''} placeholder="Your Channel"
            onChange={e => onBrand({ channelName: e.target.value })}
            className="input-field text-xs"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Logo URL</span>
          <input
            type="url" value={brand.logoUrl || ''} placeholder="https://..."
            onChange={e => onBrand({ logoUrl: e.target.value })}
            className="input-field text-xs"
          />
        </label>
      </Section>
    </div>
  );
}

// ─── AudioTab ─────────────────────────────────────────────────────────────────

function AudioTab({ voiceoverUrl, onVoiceover, musicUrl, onMusicUrl, musicVolume, onMusicVolume }: {
  voiceoverUrl: string; onVoiceover: (v: string) => void;
  musicUrl: string; onMusicUrl: (v: string) => void;
  musicVolume: number; onMusicVolume: (v: number) => void;
}) {
  return (
    <div className="p-4 space-y-5">
      <Section title="Voiceover">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Audio URL</span>
          <input
            type="url" value={voiceoverUrl} placeholder="https://...vercel-storage.com/..."
            onChange={e => onVoiceover(e.target.value)}
            className="input-field text-xs"
          />
        </label>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Auto-filled from your latest{' '}
          <a href="/voiceover" style={{ color: 'var(--accent-purple-bright)' }}>Voiceover Studio</a> generation.
        </p>
        {voiceoverUrl && (
          <audio controls src={voiceoverUrl} className="w-full" style={{ height: 32 }} />
        )}
      </Section>

      <Section title="Background Music">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Music URL (optional)</span>
          <input
            type="url" value={musicUrl} placeholder="https://..."
            onChange={e => onMusicUrl(e.target.value)}
            className="input-field text-xs"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
            <span>Volume</span>
            <span style={{ color: 'var(--text-secondary)' }}>{Math.round(musicVolume * 100)}%</span>
          </span>
          <input
            type="range" min={0} max={0.5} step={0.01}
            value={musicVolume}
            onChange={e => onMusicVolume(Number(e.target.value))}
            className="w-full accent-purple-500"
          />
        </label>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Music is ducked under voiceover automatically.
        </p>
      </Section>
    </div>
  );
}

// ─── ExportTab ────────────────────────────────────────────────────────────────

function ExportTab({ settings, onSettings, renderStatus, renderProgress, renderDownloadUrl, canRender, onRender, shotCount, mode }: {
  settings: ExportSettings; onSettings: (s: ExportSettings) => void;
  renderStatus: 'idle' | 'rendering' | 'done' | 'error';
  renderProgress: number; renderDownloadUrl: string | null;
  canRender: boolean; onRender: () => void;
  shotCount: number; mode: StudioMode;
}) {
  const activePreset = EXPORT_PRESETS.find(p => p.width === settings.width && p.height === settings.height);

  return (
    <div className="p-4 space-y-5">
      <Section title="Resolution">
        <div className="grid grid-cols-2 gap-2">
          {EXPORT_PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => onSettings({ ...settings, width: p.width, height: p.height })}
              className="rounded-lg py-2 px-2 text-left transition-all"
              style={{
                background: activePreset?.key === p.key ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.04)',
                border: activePreset?.key === p.key ? '1px solid rgba(124,58,237,0.5)' : '1px solid var(--border)',
                color: activePreset?.key === p.key ? '#c4b5fd' : 'var(--text-secondary)',
              }}
            >
              <p className="text-xs font-semibold">{p.label}</p>
              <p className="text-xs" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{p.sub}</p>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Frame rate">
        <div className="flex gap-2">
          {FPS_OPTIONS.map(f => (
            <button
              key={f}
              onClick={() => onSettings({ ...settings, fps: f })}
              className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{
                background: settings.fps === f ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.04)',
                border: settings.fps === f ? '1px solid rgba(124,58,237,0.5)' : '1px solid var(--border)',
                color: settings.fps === f ? '#c4b5fd' : 'var(--text-secondary)',
              }}
            >
              {f} fps
            </button>
          ))}
        </div>
      </Section>

      <Section title="Summary">
        <div className="text-xs space-y-1.5" style={{ color: 'var(--text-secondary)' }}>
          <div className="flex justify-between">
            <span>Shots</span><span style={{ color: 'var(--text-primary)' }}>{shotCount}</span>
          </div>
          <div className="flex justify-between">
            <span>Resolution</span><span style={{ color: 'var(--text-primary)' }}>{settings.width}×{settings.height}</span>
          </div>
          <div className="flex justify-between">
            <span>Frame rate</span><span style={{ color: 'var(--text-primary)' }}>{settings.fps} fps</span>
          </div>
          <div className="flex justify-between">
            <span>Codec</span><span style={{ color: 'var(--text-primary)' }}>H.264 MP4</span>
          </div>
        </div>
      </Section>

      {/* Render */}
      <div className="space-y-3">
        <button
          onClick={onRender}
          disabled={!canRender || renderStatus === 'rendering'}
          className="w-full py-3 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2"
          style={{
            background: canRender && renderStatus !== 'rendering'
              ? 'linear-gradient(135deg, #7c3aed, #dc2626)'
              : 'rgba(255,255,255,0.06)',
            color: canRender ? '#fff' : 'var(--text-muted)',
            cursor: !canRender ? 'not-allowed' : undefined,
          }}
        >
          {renderStatus === 'rendering' ? (
            <><SpinnerIcon />Rendering {Math.round(renderProgress * 100)}%</>
          ) : (
            <><RenderIcon />Render to MP4</>
          )}
        </button>

        {renderStatus === 'rendering' && (
          <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${renderProgress * 100}%`, background: 'linear-gradient(90deg, #7c3aed, #dc2626)' }} />
          </div>
        )}

        {renderDownloadUrl && (
          <a
            href={renderDownloadUrl}
            rel="noopener"
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-center flex items-center justify-center gap-2 transition-colors"
            style={{ background: 'rgba(16,185,129,0.15)', color: '#34d399', border: '1px solid rgba(16,185,129,0.25)' }}
          >
            <DownloadIcon />
            Download MP4
          </a>
        )}

        {renderStatus === 'error' && (
          <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
            Render failed. Check Vercel env vars: BLOB_READ_WRITE_TOKEN, POSTGRES_URL.
          </p>
        )}

        {!canRender && (
          <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
            {mode === 'doc' ? (
              <>Load a production doc to enable rendering</>
            ) : (
              <>Add at least one shot to enable rendering</>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyStateContent({ mode }: { mode: StudioMode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 text-center max-w-xs">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{ background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)' }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#a78bfa' }}>
          <rect x="2" y="2" width="20" height="20" rx="2" />
          <line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" />
          <line x1="2" y1="12" x2="22" y2="12" />
        </svg>
      </div>
      <div>
        <p className="text-base font-semibold" style={{ color: 'var(--text-secondary)' }}>
          {mode === 'doc' ? 'No production doc loaded' : 'No shots yet'}
        </p>
        <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {mode === 'doc'
            ? 'Generate a Production Doc first — it auto-loads here with all images.'
            : 'Click "+ Add Shot" in the left panel to start building your video scene by scene.'}
        </p>
      </div>
      {mode === 'doc' && (
        <a href="/production-doc" className="btn-primary text-sm px-6 py-2.5">
          Go to Production Doc →
        </a>
      )}
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color" value={value} onChange={e => onChange(e.target.value)}
          style={{ width: 28, height: 24, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0, background: 'none' }}
        />
        <span className="text-xs font-mono w-16" style={{ color: 'var(--text-secondary)' }}>{value}</span>
      </div>
    </label>
  );
}

function Chip({ label, color }: { label: string; color: 'purple' | 'cyan' | 'green' }) {
  const c = { purple: { bg: 'rgba(124,58,237,0.15)', text: '#a78bfa' }, cyan: { bg: 'rgba(6,182,212,0.12)', text: '#22d3ee' }, green: { bg: 'rgba(16,185,129,0.12)', text: '#34d399' } }[color];
  return <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: c.bg, color: c.text }}>{label}</span>;
}

function PlayerSkeleton() {
  return (
    <div className="rounded-xl flex items-center justify-center gap-3" style={{ aspectRatio: '16/9', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', width: '100%' }}>
      <div className="spinner" style={{ width: 20, height: 20 }} />
      <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading video engine…</span>
    </div>
  );
}

const RenderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="5 3 19 12 5 21 5 3" /></svg>
);
const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
);
const SpinnerIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
);
