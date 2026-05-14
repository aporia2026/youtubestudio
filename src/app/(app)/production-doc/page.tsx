'use client';

import React, { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, loadFullContextForItem, buildContextNotesFromItem } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { ScheduleLinkProvider, ScheduleSaverRegistration } from '@/components/ui/ScheduleLinkContext';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, getImageModelSpec } from '@/lib/image-models';
import {
  saveProductionDocEntry,
  getProductionDocHistory,
  getProductionDocHistoryCached,
  getVoiceoverHistory,
  updateProductionDocEntry,
  deleteProductionDocEntry,
  clearProductionDocHistory,
  getRecentNiches,
  getRecentTopics,
  type ProductionDocHistoryEntry,
} from '@/lib/history';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { CopyForElevenLabs } from '@/components/ui/CopyForElevenLabs';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { StyleManagerDialog, type StyleSummary } from './StyleManagerDialog';
import { BrollCell } from '@/components/production-doc/BrollCell';
import { SectionThumbnailCard } from '@/components/production-doc/SectionThumbnailCard';
import { SectionRowControls } from '@/components/production-doc/SectionRowControls';
import { brollRowSignatureInput } from '@/lib/broll-types';
import { productionDocToVideoConfig } from '@/remotion/utils';
import { stripProductionMarkers } from '@/lib/script-markers';
import { buildCanonicalScript, scriptDriftRatio } from '@/lib/voiceover-alignment';
import type { BrandKit, ThumbnailTransitionConfig, VideoThumbnail } from '@/remotion/types';
import {
  resolveBrandKitForRender,
  parseVisualBrandKit,
  type ChannelVisualBrandKit,
} from '@/lib/channel-visual-brand-kit';
import { VisualBrandKitOverridePanel } from '@/components/production-doc/VisualBrandKitOverridePanel';

// Dynamically import VideoPlayer — Remotion uses browser-only APIs (WebGL, Canvas)
const VideoPlayer = dynamic(
  () => import('@/components/video/VideoPlayer').then(m => m.VideoPlayer),
  { ssr: false, loading: () => <VideoPlayerSkeleton /> },
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Same-origin proxy path the voiceover-alignment cache accepts. Mirrors
 *  the validator in `/api/voiceovers/align`. ElevenLabs-direct entries
 *  (raw Vercel Blob URLs) deliberately do NOT match — those need to be
 *  saved into the workspace library first so the proxy can serve them. */
const VOICEOVER_PROXY_PATH_RE =
  /^\/api\/voiceovers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/audio$/i;

/** Safely parse a fetch response as JSON. On non-JSON bodies (e.g. Vercel timeout HTML),
 *  throws an error with the first 200 chars of the body for easier debugging. */
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(
      res.ok
        ? `Unexpected response from server (${res.status}): ${preview}`
        : `Server error ${res.status}: ${preview}`,
    );
  }
}

/**
 * Split a script into chunks of at most `maxWords` words.
 * Treats each non-empty line as an atomic unit and greedily fills chunks.
 * Any chunk that ends up below MIN_CHUNK_WORDS is merged into the adjacent chunk
 * so the API's 20-word minimum is never hit.
 */
function splitScriptIntoChunks(script: string, maxWords: number): string[] {
  const MIN_CHUNK_WORDS = 50;
  const lines = script.split(/\n/).filter(l => l.trim().length > 0);

  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentWords = 0;

  for (const line of lines) {
    const lw = line.trim().split(/\s+/).length;
    if (currentWords + lw > maxWords && currentLines.length > 0) {
      chunks.push(currentLines.join('\n'));
      currentLines = [];
      currentWords = 0;
    }
    currentLines.push(line);
    currentWords += lw;
  }
  if (currentLines.length > 0) chunks.push(currentLines.join('\n'));

  // Merge any chunk that is too small into its neighbor to avoid API rejection
  const merged: string[] = [];
  for (const chunk of chunks) {
    const wc = chunk.trim().split(/\s+/).length;
    if (wc < MIN_CHUNK_WORDS && merged.length > 0) {
      // Append to previous chunk (it's already been sent if sequential, so prepend to next is safer)
      merged[merged.length - 1] += '\n' + chunk;
    } else {
      merged.push(chunk);
    }
  }
  // Edge case: first chunk is tiny — merge forward into the second
  if (merged.length > 1 && merged[0].trim().split(/\s+/).length < MIN_CHUNK_WORDS) {
    const head = merged.shift()!;
    merged[0] = head + '\n' + merged[0];
  }

  return merged.length > 0 ? merged : [script];
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductionRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  /** Optional editor-composite asset to overlay on top of the AI visual.
   *  Only populated when the chosen style has `allow_overlay_stock` and
   *  the model decides this row warrants a real-world reference. */
  overlay_stock_terms?: string;
  on_screen_text: string;
  notes: string;
  /** Region id (from ProductionDoc.thumbnail.regions) this row's scene
   *  zooms into. When set, the row's scene becomes a thumbnail-zoom. */
  thumbnail_zoom_to?: string;
  /** Section title shown as a fixed stripe at top of frame for the row's
   *  full duration. Independent of `on_screen_text`. */
  section_title?: string;
  /** Per-row transition override. Falls back to doc-level default. */
  thumbnail_transition?: ThumbnailTransitionConfig;
}

interface ProductionDoc {
  title: string;
  niche: string;
  total_duration: string;
  total_words: number;
  speaking_pace_wpm: number;
  rows: ProductionRow[];
  /** Section-divider thumbnail (one composite image + named regions
   *  + transition defaults). Optional — docs without one render the
   *  same as before. See _plans/2026-05-13-thumbnail-zoom-section-divider.md. */
  thumbnail?: VideoThumbnail;
}

interface RowImageState {
  status: 'idle' | 'pending' | 'loading' | 'done' | 'error' | 'search';
  imageUrl?: string;
  searchUrl?: string;
  error?: string;
}

interface VisualRef {
  type: 'youtube' | 'screenshot';
  // YouTube
  url?: string;
  title?: string;
  channelTitle?: string;
  // Screenshot — `objectUrl` is a `blob:` URL produced by URL.createObjectURL.
  // Storing the full base64 data URL here previously held 5–7 MB per upload
  // on the JS heap; the blob URL is a few dozen bytes and the bytes live in
  // browser-managed memory until revoked.
  objectUrl?: string;
  mediaType?: string;
  name?: string;
  // Shared
  analyzedStyle?: string;
  analyzing?: boolean;
  analysisFailed?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Fallback style picker entries shown while the workspace's full style
 * list (built-ins + saved) is still loading from /api/production-doc/styles.
 * Keeps the UI from flashing empty on a slow cold start.
 */
const FALLBACK_BUILT_IN_STYLES: StyleSummary[] = [
  { id: 'cinematic', label: 'Cinematic', ai_image_suffix: '', allow_overlay_stock: false, origin: 'built-in' },
  { id: 'animation_2d', label: '2D Animation', ai_image_suffix: '', allow_overlay_stock: false, origin: 'built-in' },
  { id: 'doodle_explainer', label: 'Doodle Explainer', ai_image_suffix: '', allow_overlay_stock: true, origin: 'built-in' },
];

const VISUAL_TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  'Title Card':       { bg: 'rgba(124,58,237,0.15)', color: '#a78bfa' },
  'B-Roll':           { bg: 'rgba(6,182,212,0.12)',  color: '#22d3ee' },
  'Talking Head':     { bg: 'rgba(16,185,129,0.12)', color: '#34d399' },
  'Screen Recording': { bg: 'rgba(245,158,11,0.12)', color: '#fbbf24' },
  'Animation':        { bg: 'rgba(236,72,153,0.12)', color: '#f472b6' },
  'Lower Third':      { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
  'Statistics':       { bg: 'rgba(239,68,68,0.12)',  color: '#f87171' },
  'Cutaway':          { bg: 'rgba(107,114,128,0.12)', color: '#9ca3af' },
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
  } catch {
    // not a valid URL
  }
  return null;
}

function escapeCsvCell(value: string): string {
  if (!value) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportToCsv(doc: ProductionDoc, rowImages: RowImageState[]) {
  // Only include the Overlay column when at least one row uses it —
  // keeps CSVs from styles that don't support overlays exactly the
  // same shape they were before this feature.
  const hasOverlay = doc.rows.some((r) => r.overlay_stock_terms?.trim());
  const headers = [
    'Timecode', 'Script Text', 'Visual Type', 'Visual Description',
    'Stock Search Terms',
    ...(hasOverlay ? ['Overlay Stock Terms'] : []),
    'AI Image Prompt', 'Image URL', 'Stock Search URL',
    'On-Screen Text', 'Notes',
  ];
  const rows = doc.rows.map((r, i) => [
    r.timecode,
    r.script_text,
    r.visual_type,
    r.visual_description,
    r.stock_search_terms,
    ...(hasOverlay ? [r.overlay_stock_terms || ''] : []),
    r.ai_image_prompt,
    rowImages[i]?.imageUrl || '',
    rowImages[i]?.searchUrl || '',
    r.on_screen_text,
    r.notes,
  ].map(escapeCsvCell).join(','));

  // Editors often want the full script as one continuous block at the
  // bottom — the row-by-row table is great for production but bad for
  // reading the narrative end-to-end. Append it as a comment-prefixed
  // section so spreadsheet apps still parse the table cleanly.
  const fullScript = doc.rows
    .map(r => r.script_text?.trim())
    .filter(Boolean)
    .join('\n\n');

  const csv = [
    `# Production Document: ${doc.title}`,
    `# Niche: ${doc.niche} | Duration: ${doc.total_duration} | ${doc.total_words} words @ ${doc.speaking_pace_wpm} wpm`,
    '',
    headers.join(','),
    ...rows,
    '',
    '# ─── FULL SCRIPT (continuous, for reading) ───',
    ...fullScript.split('\n').map(line => `# ${line}`),
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `production-doc-${doc.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success('CSV exported — open in Excel or Google Sheets');
}

// ─── Video Preview helpers ────────────────────────────────────────────────────

const DEFAULT_BRAND: Partial<BrandKit> = {
  primaryColor: '#FF0000',
  secondaryColor: '#111111',
  backgroundColor: '#FFFFFF',
  textColor: '#111111',
  titleColor: '#111111',
};

function VideoPlayerSkeleton() {
  return (
    <div
      style={{
        width: '100%',
        aspectRatio: '16/9',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontSize: 14,
      }}
    >
      <div className="spinner" style={{ width: 20, height: 20 }} />
      <span className="ml-3">Loading video engine…</span>
    </div>
  );
}

function VideoPreviewBrandBar({ onBrandChange }: { onBrandChange: (b: Partial<BrandKit>) => void }) {
  // Safe defaults — no localStorage in initial state to avoid SSR hydration mismatch
  const [primary, setPrimary] = useState('#FF0000');
  const [bg, setBg] = useState('#FFFFFF');

  // Load persisted brand on client only (after hydration)
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('video_brand_kit') || '{}') as Partial<BrandKit>;
      if (stored.primaryColor) setPrimary(stored.primaryColor);
      if (stored.backgroundColor) setBg(stored.backgroundColor);
    } catch { /* ignore corrupt storage */ }
  }, []);

  function update(p: string, b: string) {
    setPrimary(p);
    setBg(b);
    const brand: Partial<BrandKit> = {
      primaryColor: p,
      backgroundColor: b,
      titleColor: b === '#FFFFFF' ? '#111111' : '#FFFFFF',
      textColor: b === '#FFFFFF' ? '#222222' : '#EEEEEE',
    };
    onBrandChange(brand);
    try { localStorage.setItem('video_brand_kit', JSON.stringify(brand)); } catch { /* ignore */ }
  }

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Brand</span>
      <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
        Accent color
        <input type="color" value={primary} onChange={e => update(e.target.value, bg)}
          style={{ width: 28, height: 24, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none', padding: 0 }} />
      </label>
      <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
        Background
        <input type="color" value={bg} onChange={e => update(primary, e.target.value)}
          style={{ width: 28, height: 24, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none', padding: 0 }} />
      </label>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        (changes apply on play)
      </span>
    </div>
  );
}

/**
 * Voiceover-aligned scene-timing pill. Four states — `syncing` is the
 * only one with a spinner; `ready` is a calm green checkmark; `stale`
 * and `failed` offer a re-align action. `unsupported` and `idle` are
 * both informational and never block the user — silent when there's
 * nothing useful to say.
 *
 * Visual choices target the lazy user (rule 10): one glance at the
 * green check confirms scenes will land on the narration; anything
 * else has a one-line explanation and (where applicable) a single
 * obvious button.
 */
function AlignmentPill({
  status,
  detail,
  onRealign,
}: {
  status: 'idle' | 'syncing' | 'ready' | 'stale' | 'failed' | 'unsupported';
  detail: string | null;
  onRealign: () => void;
}) {
  if (status === 'idle') return null;

  const palette: Record<typeof status, { bg: string; fg: string; dot: string; label: string }> = {
    syncing:     { bg: 'rgba(59,130,246,0.10)',  fg: '#60a5fa', dot: '#60a5fa', label: 'Syncing scenes to voiceover…' },
    ready:       { bg: 'rgba(16,185,129,0.10)',  fg: '#34d399', dot: '#34d399', label: 'Synced to voiceover' },
    stale:       { bg: 'rgba(245,158,11,0.12)',  fg: '#fbbf24', dot: '#fbbf24', label: 'Re-align needed' },
    failed:      { bg: 'rgba(239,68,68,0.10)',   fg: '#f87171', dot: '#f87171', label: 'Alignment failed' },
    unsupported: { bg: 'rgba(148,163,184,0.10)', fg: '#94a3b8', dot: '#94a3b8', label: 'Alignment unavailable' },
  };
  const p = palette[status];
  const showRealign = status === 'stale' || status === 'failed';

  return (
    <div
      className="mt-2 flex items-start gap-2 text-xs rounded-md px-3 py-2"
      style={{ background: p.bg, color: p.fg }}
    >
      <span className="flex-shrink-0 mt-0.5">
        {status === 'syncing' ? (
          <svg width="12" height="12" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : status === 'ready' ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: p.dot }}
            aria-hidden
          />
        )}
      </span>
      <span className="flex-1 leading-snug">
        <span className="font-medium">{p.label}</span>
        {detail && (
          <span className="block opacity-75 mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {detail}
          </span>
        )}
      </span>
      {showRealign && (
        <button
          type="button"
          onClick={onRealign}
          className="flex-shrink-0 text-xs underline underline-offset-2 hover:no-underline"
          style={{ color: p.fg }}
        >
          Re-align
        </button>
      )}
    </div>
  );
}

/**
 * Memoized VideoPlayer wrapper — rebuilds config only when inputs change,
 * preventing the Player from re-mounting on every parent state update.
 */
const VideoPlayerMemo = React.memo(function VideoPlayerMemo({
  doc,
  rowImages,
  voiceoverUrl,
  brandKit,
  onRender,
  isRendering,
  renderProgress,
  outputUrl,
}: {
  doc: ProductionDoc;
  rowImages: RowImageState[];
  voiceoverUrl: string;
  brandKit: Partial<BrandKit>;
  onRender: () => void;
  isRendering: boolean;
  renderProgress: number;
  outputUrl?: string;
}) {
  const config = React.useMemo(
    () => productionDocToVideoConfig(doc, rowImages, voiceoverUrl || undefined, undefined, brandKit),
    [doc, rowImages, voiceoverUrl, brandKit],
  );
  return (
    <VideoPlayer
      config={config}
      onRender={onRender}
      isRendering={isRendering}
      renderProgress={renderProgress}
      outputUrl={outputUrl}
    />
  );
});

// ─── Sub-components ───────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-xs px-1.5 py-0.5 rounded transition-all"
      style={{
        background: copied ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.06)',
        color: copied ? '#34d399' : 'var(--text-muted)',
        border: '1px solid transparent',
      }}
      title="Copy to clipboard"
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

function ImageLightbox({ imageUrl, onClose }: { imageUrl: string; onClose: () => void }) {
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      // Fetch as blob so cross-origin R2 URLs save instead of navigating.
      // The browser ignores `download` on cross-origin anchors without
      // matching CORS headers, so a fetch-then-objectURL is the reliable path.
      const res = await fetch(imageUrl, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const filename = (() => {
        try {
          const u = new URL(imageUrl);
          const tail = u.pathname.split('/').filter(Boolean).pop();
          if (tail && /\.[a-z0-9]{2,5}$/i.test(tail)) return tail;
        } catch { /* fall through */ }
        const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
        return `image-${Date.now()}.${ext}`;
      })();
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch {
      // CORS-blocked or offline — open the raw URL in a new tab as a fallback
      // so the user can right-click → Save As. Better than a silent failure.
      window.open(imageUrl, '_blank', 'noopener,noreferrer');
      toast.message('Download blocked by browser. Opened in a new tab instead.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        cursor: 'zoom-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          display: 'flex',
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          aria-label="Download image"
          title="Download image"
          style={{
            height: 36,
            padding: '0 14px',
            borderRadius: 18,
            background: 'rgba(255,255,255,0.10)',
            border: '1px solid rgba(255,255,255,0.20)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 500,
            cursor: downloading ? 'wait' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            opacity: downloading ? 0.7 : 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {downloading ? 'Downloading…' : 'Download'}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          title="Close (Esc)"
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            background: 'rgba(255,255,255,0.10)',
            border: '1px solid rgba(255,255,255,0.20)',
            color: '#fff',
            fontSize: 18,
            lineHeight: 1,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="Full preview"
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          maxHeight: '92vh',
          objectFit: 'contain',
          borderRadius: 8,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          cursor: 'default',
        }}
      />
    </div>
  );
}

function ImageCell({ state, onRetry }: { state: RowImageState; onRetry: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);

  if (state.status === 'idle') return null;

  if (state.status === 'search') {
    return (
      <a
        href={state.searchUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
        style={{ background: 'rgba(59,130,246,0.12)', color: '#60a5fa' }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
        Search Images
      </a>
    );
  }

  if (state.status === 'pending') {
    return (
      <span className="text-xs" style={{ color: 'var(--text-muted)', letterSpacing: 2 }}>•••</span>
    );
  }

  if (state.status === 'loading') {
    return <div className="spinner" style={{ width: 16, height: 16 }} />;
  }

  if (state.status === 'done' && state.imageUrl) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          title="Click to preview full size"
          style={{
            padding: 0,
            background: 'transparent',
            border: 'none',
            cursor: 'zoom-in',
            display: 'block',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.imageUrl}
            alt="AI generated"
            style={{
              width: 80,
              height: 50,
              objectFit: 'cover',
              borderRadius: 5,
              border: '1px solid var(--border)',
              display: 'block',
            }}
          />
        </button>
        {previewOpen && (
          <ImageLightbox imageUrl={state.imageUrl} onClose={() => setPreviewOpen(false)} />
        )}
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs" style={{ color: '#f87171' }} title={state.error}>⚠ Failed</span>
        <button
          onClick={onRetry}
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
        >
          Retry
        </button>
      </div>
    );
  }

  return null;
}

// ─── Voiceover picker ─────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Unified voiceover record for the picker. Merges two underlying sources:
 *
 *   - ElevenLabs voiceovers from the per-user history (scoped by uid via
 *     /api/history). Linked to a video by scheduleItemId / videoTitle.
 *   - Workspace media_assets of type='voiceover'. These cover narrator-
 *     approved full uploads and stitched section assemblies (see
 *     /api/voiceovers/library). Linked by projectId + assignmentId, and
 *     by scheduleItemId via the narrator_assignment_id pointer that the
 *     assignment-create flow writes into schedule_items.custom_fields.
 */
interface VoiceoverItem {
  id: string;
  source: 'elevenlabs' | 'narrator_full' | 'narrator_stitched' | 'media_asset';
  audioUrl: string;
  voiceName: string;
  /** Optional narrator/role for `narrator_*` entries, used as a sublabel. */
  badgeLabel: string | null;
  videoTitle: string | null;
  projectId: string | null;
  assignmentId: string | null;
  scheduleItemId: string | null;
  timestamp: number;
  /** Optional summary line for ElevenLabs entries (char count + text preview). */
  summary: string | null;
}

function sourceLabel(s: VoiceoverItem['source']): string {
  switch (s) {
    case 'elevenlabs':         return 'ElevenLabs';
    case 'narrator_full':      return 'Narrator';
    case 'narrator_stitched':  return 'Narrator (stitched)';
    case 'media_asset':        return 'Library';
  }
}

/**
 * Pick the best-matching voiceover for the current production doc.
 *
 * Precedence:
 *   1. Same schedule item — strongest signal, works for both ElevenLabs
 *      (entry.scheduleItemId) and narrator (resolved server-side from
 *      schedule_items.custom_fields).
 *   2. Same project — narrator audio is project-scoped, so a project
 *      match is almost as strong as a schedule-item match for those rows.
 *   3. videoTitle / projectTitle match against the doc's known titles
 *      (case/whitespace insensitive).
 *   4. Most recent — fallback so the field isn't empty for users who skip
 *      schedule items / haven't named their doc yet.
 */
function pickBestVoiceover(
  list: VoiceoverItem[],
  scheduleItemId: string | null | undefined,
  projectId: string | null | undefined,
  candidates: Array<string | null | undefined>,
): VoiceoverItem | null {
  if (list.length === 0) return null;

  if (scheduleItemId) {
    const byItem = list.find(v => v.scheduleItemId === scheduleItemId && v.audioUrl);
    if (byItem) return byItem;
  }

  if (projectId) {
    const byProject = list.find(v => v.projectId === projectId && v.audioUrl);
    if (byProject) return byProject;
  }

  const norm = (s: string | null | undefined) =>
    (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const titles = candidates.map(norm).filter(Boolean);
  if (titles.length > 0) {
    const byTitle = list.find(v => {
      if (!v.audioUrl) return false;
      const vt = norm(v.videoTitle);
      return vt && titles.includes(vt);
    });
    if (byTitle) return byTitle;
  }

  // Final fallback: most recent entry that actually has an audio URL.
  return list.find(v => v.audioUrl) ?? null;
}

interface VoiceoverPickerProps {
  /** Current URL (controlled — keeps Remotion player API untouched). */
  value: string;
  /** Setter that also persists "user touched this" intent. */
  onChange: (url: string, source: 'auto' | 'manual' | 'clear') => void;
  /** Schedule item id we're linked to, if any (strongest match signal). */
  scheduleItemId: string | null | undefined;
  /** Project id derived from schedule item or URL param. Matches narrator audio. */
  projectId: string | null | undefined;
  /** Title candidates to match against entry.videoTitle (in priority order). */
  titleCandidates: Array<string | null | undefined>;
}

function VoiceoverPicker({
  value,
  onChange,
  scheduleItemId,
  projectId,
  titleCandidates,
}: VoiceoverPickerProps) {
  const [items, setItems] = useState<VoiceoverItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [autoMatchedId, setAutoMatchedId] = useState<string | null>(null);
  const userTouchedRef = useRef(false);
  const playingIdRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  // Initial load — fetch both sources in parallel and merge. Failures on
  // one source don't block the other; an offline media_assets call still
  // shows the user's ElevenLabs history and vice versa.
  useEffect(() => {
    let cancelled = false;

    const elevenlabsPromise = getVoiceoverHistory()
      .then(list => list.map((e): VoiceoverItem => ({
        id: `el:${e.id}`,
        source: 'elevenlabs',
        audioUrl: e.audioUrl,
        voiceName: e.voiceName,
        badgeLabel: null,
        videoTitle: e.videoTitle ?? null,
        projectId: null,
        assignmentId: null,
        scheduleItemId: e.scheduleItemId ?? null,
        timestamp: e.timestamp,
        summary: e.textPreview
          ? `${e.charCount.toLocaleString()} chars · ${e.textPreview.slice(0, 60)}${e.textPreview.length > 60 ? '…' : ''}`
          : null,
      })))
      .catch(() => [] as VoiceoverItem[]);

    type LibraryRow = {
      id: string;
      audioUrl: string;
      name: string;
      narratorName: string | null;
      projectId: string | null;
      projectTitle: string | null;
      assignmentId: string | null;
      scheduleItemId: string | null;
      timestamp: number;
      source: 'narrator_full' | 'narrator_stitched' | 'other';
    };
    const libraryPromise = fetch('/api/voiceovers/library', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { voiceovers: [] as LibraryRow[] })
      .then((data: { voiceovers?: LibraryRow[] }) => (data.voiceovers || []).map((e): VoiceoverItem => ({
        id: `lib:${e.id}`,
        source: e.source === 'other' ? 'media_asset' : e.source,
        audioUrl: e.audioUrl,
        voiceName: e.narratorName || e.name || 'Narrator',
        badgeLabel: e.source === 'narrator_stitched' ? 'stitched' : (e.source === 'narrator_full' ? 'full upload' : null),
        videoTitle: e.projectTitle,
        projectId: e.projectId,
        assignmentId: e.assignmentId,
        scheduleItemId: e.scheduleItemId,
        timestamp: e.timestamp,
        summary: null,
      })))
      .catch(() => [] as VoiceoverItem[]);

    Promise.all([elevenlabsPromise, libraryPromise]).then(([a, b]) => {
      if (cancelled) return;
      // Dedupe on audioUrl — if the same blob URL shows up under both sources
      // (rare, but possible if a narrator approval was also logged to history)
      // we keep the first occurrence, which preserves source ordering.
      const seen = new Set<string>();
      const merged: VoiceoverItem[] = [];
      for (const item of [...a, ...b].sort((x, y) => y.timestamp - x.timestamp)) {
        if (!item.audioUrl || seen.has(item.audioUrl)) continue;
        seen.add(item.audioUrl);
        merged.push(item);
      }
      setItems(merged);
      setLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setLoaded(true);
    });

    return () => { cancelled = true; };
  }, []);

  // Auto-match — re-runs when matching context changes (e.g. schedule item
  // resolved after first paint, doc title generated). Skips silently once
  // the user has clicked something to avoid clobbering their choice.
  // Stringify title candidates so the effect doesn't refire on every render
  // from a new array identity carrying the same values.
  const titleKey = titleCandidates.filter(Boolean).join('||');
  useEffect(() => {
    if (!loaded || userTouchedRef.current) return;
    const match = pickBestVoiceover(items, scheduleItemId, projectId, titleCandidates);
    if (match?.audioUrl && match.audioUrl !== value) {
      onChange(match.audioUrl, 'auto');
      setAutoMatchedId(match.id);
    } else if (match?.id) {
      setAutoMatchedId(match.id);
    }
    // titleCandidates is captured via titleKey; suppress exhaustive-deps for
    // the array identity warning that doesn't reflect a real dependency change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, items, scheduleItemId, projectId, titleKey]);

  // Stop preview audio if the picker unmounts or the popover closes.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  function togglePreview(item: VoiceoverItem) {
    if (!item.audioUrl) return;
    if (playingIdRef.current === item.id && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      playingIdRef.current = null;
      setPlayingId(null);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const audio = new Audio(item.audioUrl);
    audio.onended = () => {
      if (playingIdRef.current === item.id) {
        playingIdRef.current = null;
        setPlayingId(null);
      }
    };
    audio.onerror = () => {
      playingIdRef.current = null;
      setPlayingId(null);
      toast.error('Could not play preview');
    };
    audioRef.current = audio;
    playingIdRef.current = item.id;
    setPlayingId(item.id);
    audio.play().catch(() => {
      playingIdRef.current = null;
      setPlayingId(null);
    });
  }

  function selectItem(item: VoiceoverItem) {
    userTouchedRef.current = true;
    onChange(item.audioUrl, 'manual');
    setOpen(false);
  }

  function clearSelection() {
    userTouchedRef.current = true;
    onChange('', 'clear');
    setOpen(false);
  }

  const selected = items.find(i => i.audioUrl === value) || null;
  const matchedToCurrent = selected && autoMatchedId === selected.id;

  // ─── Trigger button (collapsed state) ──────────────────────────────────
  const triggerLabel = (() => {
    if (!loaded) return 'Loading voiceovers…';
    if (selected) {
      const title = selected.videoTitle?.trim();
      return title
        ? `${selected.voiceName} · ${title}`
        : `${selected.voiceName} (${relativeTime(selected.timestamp)})`;
    }
    if (value) return 'External URL set';
    if (items.length === 0) return 'No voiceovers in library yet';
    return 'Select a voiceover…';
  })();

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="input-field text-xs"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: selected ? '#a78bfa' : 'var(--text-muted)', flexShrink: 0 }}>
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1v-7h3zM3 19a2 2 0 0 0 2 2h1v-7H3z" />
          </svg>
          <span style={{
            color: selected || value ? 'var(--text-primary)' : 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {triggerLabel}
          </span>
          {matchedToCurrent && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap"
              style={{ background: 'rgba(168,85,247,0.18)', color: '#c084fc', flexShrink: 0 }}
              title="Auto-matched to this video"
            >
              auto-matched
            </span>
          )}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          {/* Click-outside catcher */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          />
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 50,
              maxHeight: 380,
              overflowY: 'auto',
              background: 'var(--bg-elevated, #181818)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
              padding: 4,
            }}
          >
            {items.length === 0 ? (
              <div
                className="text-xs px-3 py-4 text-center"
                style={{ color: 'var(--text-muted)' }}
              >
                No voiceovers yet. Record one in <strong style={{ color: 'var(--text-secondary)' }}>Voiceover Studio</strong> or assign a <strong style={{ color: 'var(--text-secondary)' }}>Narrator</strong> to a project.
              </div>
            ) : (
              <>
                {value && (
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="text-xs w-full text-left px-3 py-2 rounded"
                    style={{
                      color: '#f87171',
                      background: 'transparent',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    ✕ Clear voiceover (silent video)
                  </button>
                )}
                {items.map(item => {
                  const isSelected = item.audioUrl === value;
                  const isAutoMatch = item.id === autoMatchedId;
                  const srcColor =
                    item.source === 'elevenlabs' ? '#60a5fa'
                    : item.source.startsWith('narrator') ? '#34d399'
                    : 'var(--text-muted)';
                  const srcBg =
                    item.source === 'elevenlabs' ? 'rgba(59,130,246,0.14)'
                    : item.source.startsWith('narrator') ? 'rgba(16,185,129,0.14)'
                    : 'rgba(255,255,255,0.06)';
                  return (
                    <div
                      key={item.id}
                      className="flex items-start gap-2 px-2 py-2 rounded"
                      style={{
                        background: isSelected ? 'rgba(168,85,247,0.14)' : 'transparent',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => {
                        if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                      }}
                      onMouseLeave={e => {
                        if (!isSelected) e.currentTarget.style.background = 'transparent';
                      }}
                      onClick={() => selectItem(item)}
                    >
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); togglePreview(item); }}
                        title={playingId === item.id ? 'Stop preview' : 'Play preview'}
                        style={{
                          width: 26,
                          height: 26,
                          flexShrink: 0,
                          marginTop: 2,
                          borderRadius: 13,
                          background: playingId === item.id ? 'rgba(168,85,247,0.25)' : 'rgba(255,255,255,0.08)',
                          border: 'none',
                          color: playingId === item.id ? '#c084fc' : 'var(--text-secondary)',
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {playingId === item.id ? (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="5" width="4" height="14" rx="1" />
                            <rect x="14" y="5" width="4" height="14" rx="1" />
                          </svg>
                        ) : (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="flex items-center gap-1.5" style={{ minWidth: 0 }}>
                          <span
                            className="text-xs font-medium"
                            style={{
                              color: isSelected ? '#c084fc' : 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {item.voiceName}
                          </span>
                          <span
                            className="text-[9px] px-1 py-0.5 rounded whitespace-nowrap"
                            style={{ background: srcBg, color: srcColor }}
                          >
                            {sourceLabel(item.source)}
                          </span>
                          {item.badgeLabel && (
                            <span
                              className="text-[9px] px-1 py-0.5 rounded whitespace-nowrap"
                              style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                            >
                              {item.badgeLabel}
                            </span>
                          )}
                          {isAutoMatch && !isSelected && (
                            <span
                              className="text-[9px] px-1 py-0.5 rounded"
                              style={{ background: 'rgba(168,85,247,0.18)', color: '#c084fc' }}
                            >
                              match
                            </span>
                          )}
                          <span
                            className="text-[10px] ml-auto whitespace-nowrap"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {relativeTime(item.timestamp)}
                          </span>
                        </div>
                        {item.videoTitle && (
                          <div
                            className="text-[10px] truncate"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {item.videoTitle}
                          </div>
                        )}
                        {item.summary && (
                          <div
                            className="text-[10px] truncate"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {item.summary}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProductionDocPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <ProductionDocPage />
    </Suspense>
  );
}

function ProductionDocPage() {
  const search = useSearchParams();
  const scheduleItemId = getScheduleLinkId(search);
  // Direct project handoff (e.g. from the project detail page's "Send to
  // Production Doc" button). Mirrors the schedule-item path but pulls the
  // metadata + active script straight off /api/projects/[id] so the
  // owner doesn't need a schedule item in the loop.
  const projectIdParam = search.get('projectId');
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);
  const [projectPrefilled, setProjectPrefilled] = useState(false);

  // — Inputs
  const [script, setScript] = useState('');
  const [niche, setNiche] = useState('');
  const [topic, setTopic] = useState('');
  // Per-session override only. The canonical default is set in
  // Settings → Model Defaults and resolved server-side.
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('production-doc'));
  const [imageModel, setImageModel] = useState<string>(() => {
    if (typeof window === 'undefined') return DEFAULT_IMAGE_MODEL;
    try {
      const saved = localStorage.getItem('prodoc_image_model');
      if (saved && getImageModelSpec(saved)) return saved;
    } catch { /* ignore */ }
    return DEFAULT_IMAGE_MODEL;
  });
  useEffect(() => {
    try { localStorage.setItem('prodoc_image_model', imageModel); } catch { /* ignore */ }
  }, [imageModel]);
  const [speakingPace, setSpeakingPace] = useState(135);
  const [actualDuration, setActualDuration] = useState(''); // "mm:ss" of actual voiceover recording
  const [stylePreset, setStylePreset] = useState('cinematic');
  const [creativeBrief, setCreativeBrief] = useState('');
  const [availableStyles, setAvailableStyles] = useState<StyleSummary[]>(FALLBACK_BUILT_IN_STYLES);
  const [stylesLoaded, setStylesLoaded] = useState(false);
  const [styleManagerOpen, setStyleManagerOpen] = useState(false);

  /**
   * Load the full universe of styles (built-ins + workspace-saved) once
   * on mount. The endpoint is cheap (one SELECT against an indexed
   * workspace_id) so we don't bother with stale-while-revalidate; we
   * just refetch after every mutation in the dialog.
   */
  const loadStyles = useCallback(async () => {
    try {
      const res = await fetch('/api/production-doc/styles');
      if (!res.ok) {
        // Stay on the fallback list — the picker will still work for built-ins.
        setStylesLoaded(true);
        return;
      }
      const data = await res.json();
      const list: StyleSummary[] = Array.isArray(data?.styles) ? data.styles : [];
      if (list.length > 0) setAvailableStyles(list);
      setStylesLoaded(true);
    } catch {
      setStylesLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadStyles();
  }, [loadStyles]);

  // If the currently-selected style id disappears (e.g. user deleted the
  // saved style they had picked), fall back to the first built-in so the
  // picker doesn't end up with no active selection.
  useEffect(() => {
    if (!stylesLoaded) return;
    if (availableStyles.some((s) => s.id === stylePreset)) return;
    const fallback = availableStyles.find((s) => s.origin === 'built-in') ?? availableStyles[0];
    if (fallback) setStylePreset(fallback.id);
  }, [availableStyles, stylesLoaded, stylePreset]);
  const [ytRefInput, setYtRefInput] = useState('');
  const [visualRefs, setVisualRefs] = useState<VisualRef[]>([]);
  const screenshotInputRef = useRef<HTMLInputElement>(null);

  // — Generation
  const [generating, setGenerating] = useState(false);
  const [generationLog, setGenerationLog] = useState<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [doc, setDoc] = useState<ProductionDoc | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  // Initial state from localStorage cache so the panel paints instantly;
  // useEffect below pulls the canonical list from the server (migration 0049).
  const [historyItems, setHistoryItems] = useState<ProductionDocHistoryEntry[]>(() => getProductionDocHistoryCached());
  useEffect(() => { getProductionDocHistory().then(setHistoryItems).catch(() => {}); }, []);
  // Track which history entry the current on-screen doc belongs to, so row-image
  // generations (fire-and-forget after the doc is saved) can patch back onto the
  // same entry instead of being lost.
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  // Tracks which production doc (by runKey) was last explicitly saved via
  // the banner button. Drives the dirty indicator.
  const [lastSavedProdDocRunKey, setLastSavedProdDocRunKey] = useState<string | null>(null);

  /**
   * Section-divider thumbnail mutator. Updates the doc's `thumbnail`
   * field and patches the same change to the history entry on the
   * server so a reload restores it. Other doc fields don't have
   * server-side patch wiring yet — only thumbnail and rowImages do.
   */
  const setThumbnail = useCallback((next: VideoThumbnail | undefined) => {
    setDoc(prev => {
      if (!prev) return prev;
      const nextDoc = { ...prev, thumbnail: next };
      if (historyEntryId) {
        updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
      }
      return nextDoc;
    });
  }, [historyEntryId]);

  /**
   * Patch a single production-doc row. Used by the per-row Section
   * controls. Patches the same fields to the server history entry so
   * a reload restores edits.
   */
  const updateRow = useCallback((rowIndex: number, patch: Partial<ProductionRow>) => {
    setDoc(prev => {
      if (!prev) return prev;
      const nextRows = prev.rows.map((r, i) => i === rowIndex ? { ...r, ...patch } : r);
      const nextDoc = { ...prev, rows: nextRows };
      if (historyEntryId) {
        updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
      }
      return nextDoc;
    });
  }, [historyEntryId]);

  // — Image generation (declared before effects that reference it)
  const [rowImages, setRowImages] = useState<RowImageState[]>([]);
  const [imageProgress, setImageProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Revoke any outstanding screenshot blob URLs on unmount. We track the
  // latest visualRefs through a ref so the cleanup closure sees the final
  // list (not the empty array captured at mount).
  const visualRefsLatestRef = useRef<VisualRef[]>([]);
  useEffect(() => { visualRefsLatestRef.current = visualRefs; }, [visualRefs]);
  useEffect(() => () => {
    for (const r of visualRefsLatestRef.current) {
      if (r.objectUrl) URL.revokeObjectURL(r.objectUrl);
    }
  }, []);

  // Schedule-link preload: pull every relevant field off the linked item so
  // the user doesn't retype context they already captured upstream. Functional
  // setters (curr => curr || ctx.x) keep manual edits made before the async
  // resolves from being clobbered.
  useEffect(() => {
    if (!scheduleItemId || schedulePrefilled) return;
    let cancelled = false;
    (async () => {
      const item = await fetchScheduleItem(scheduleItemId);
      if (cancelled || !item) return;
      setScheduleItem(item);
      setSchedulePrefilled(true);
      const ctx = await loadFullContextForItem(item, { withVoiceoverDuration: true });
      if (cancelled) return;
      setTopic(curr => curr || ctx.topic);
      setNiche(curr => curr || ctx.niche);
      if (ctx.script) setScript(prev => prev || ctx.script!);
      // Pre-fill the "actual duration" mm:ss with the most recent recorded
      // voiceover for this item's project, so the computed-wpm readout works
      // on first paint without the user retyping the take length.
      if (ctx.voiceoverDurationSeconds && ctx.voiceoverDurationSeconds > 0) {
        const total = ctx.voiceoverDurationSeconds;
        const mm = Math.floor(total / 60);
        const ss = total % 60;
        const formatted = `${mm}:${String(ss).padStart(2, '0')}`;
        setActualDuration(curr => curr || formatted);
      }
      // Seed the creative brief with the item's accumulated narrative context
      // (notes, series part, prior published description, editor, open
      // checklist) — the prod-doc generator will weight these as scene-shaping
      // hints. User can still wipe / edit before generating.
      const briefSeed = [buildContextNotesFromItem(ctx), ctx.prevDescription]
        .filter(Boolean)
        .join('\n\n');
      if (briefSeed) setCreativeBrief(curr => curr || briefSeed);
      toast.message(`Loaded context from "${item.title || 'schedule item'}"`);
    })();
    return () => { cancelled = true; };
     
  }, [scheduleItemId, schedulePrefilled]);

  // Project-link preload: when launched from `/projects/[id]` via the
  // "Send to Production Doc" button, pull title + niche + active script
  // off the project so the user starts with the same context they'd get
  // from a schedule item, without needing a schedule item at all.
  // Functional setters keep manual edits made before the fetch resolves.
  useEffect(() => {
    if (!projectIdParam || projectPrefilled || scheduleItemId) return;
    let cancelled = false;
    (async () => {
      try {
        const [projectRes, scriptsRes] = await Promise.all([
          fetch(`/api/projects/${projectIdParam}`),
          fetch(`/api/projects/${projectIdParam}/scripts`),
        ]);
        if (cancelled) return;
        if (!projectRes.ok) return;
        const projectData = await projectRes.json();
        const project: {
          title?: string;
          topic?: string;
          niche?: string;
          youtube_description?: string | null;
        } | undefined = projectData?.project;
        if (!project) return;
        setProjectPrefilled(true);
        const title = (project.title || project.topic || '').trim();
        const projectNiche = (project.niche || '').trim();
        if (title) setTopic(curr => curr || title);
        if (projectNiche) setNiche(curr => curr || projectNiche);
        // Seed the creative brief with the published description if there
        // is one — the same role `prevDescription` plays in the schedule-
        // item handoff. The prod-doc generator weights it as a scene-
        // shaping hint; the user can wipe / edit before generating.
        const desc = (project.youtube_description || '').trim();
        if (desc) setCreativeBrief(curr => curr || desc);
        if (scriptsRes.ok) {
          const scriptsData = await scriptsRes.json();
          type ScriptRow = { id: string; content: string; is_active?: boolean };
          const scripts: ScriptRow[] = Array.isArray(scriptsData?.scripts) ? scriptsData.scripts : [];
          const active = scripts.find(s => s.is_active) ?? scripts[0];
          if (active?.content) setScript(curr => curr || active.content);
        }
        toast.message(`Loaded context from "${title || 'project'}"`);
      } catch {
        // Best-effort prefill — leave the page blank and let the user start fresh.
      }
    })();
    return () => { cancelled = true; };
  }, [projectIdParam, projectPrefilled, scheduleItemId]);

  // Restore last result from localStorage after mount (useEffect so SSR is unaffected).
  // Skip restore on a handoff (schedule-link, generator, QA, project) so the
  // new script starts a fresh session — and discard the saved draft so it
  // doesn't resurface.
  useEffect(() => {
    const fromHandoff = !!scheduleItemId
      || !!projectIdParam
      || search.get('from') === 'generator'
      || search.get('from') === 'qa'
      || !!localStorage.getItem('prodoc_prefill');
    if (fromHandoff) {
      try { localStorage.removeItem('prodoc_last_result'); } catch { /* ignore */ }
      return;
    }
    try {
      const saved = localStorage.getItem('prodoc_last_result');
      if (!saved) return;
      const parsed = JSON.parse(saved) as { doc?: ProductionDoc; rowImages?: RowImageState[]; savedAt?: number };
      if (!parsed.doc?.rows?.length) return;
      setDoc(parsed.doc);
      if (parsed.rowImages?.length) setRowImages(parsed.rowImages);
      const ago = parsed.savedAt ? Math.round((Date.now() - parsed.savedAt) / 60000) : null;
      toast.success(`Previous session restored${ago !== null ? ` (saved ${ago < 1 ? 'just now' : `${ago}m ago`})` : ''}`, { duration: 4000 });
    } catch { /* corrupt storage — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist doc + images together whenever either changes
  useEffect(() => {
    if (!doc?.rows?.length) return;
    try {
      localStorage.setItem('prodoc_last_result', JSON.stringify({ doc, rowImages, savedAt: Date.now() }));
    } catch { /* storage full — ignore */ }
    // Also patch the current history entry so row-image URLs survive on restore.
    if (historyEntryId && rowImages.length > 0) {
      const imgMap: Record<number, string> = {};
      rowImages.forEach((r, i) => { if (r?.imageUrl) imgMap[i] = r.imageUrl; });
      if (Object.keys(imgMap).length > 0) {
        // Fire-and-forget — the lib updates the localStorage cache
        // synchronously, then PATCHes the server in the background.
        updateProductionDocEntry(historyEntryId, { rowImages: imgMap }).catch(() => {});
      }
    }
  }, [doc, rowImages, historyEntryId]);

  // Auto-scroll log to bottom when new entries are added
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [generationLog.length]);
  const [imagesGenerating, setImagesGenerating] = useState(false);

  // — Autocomplete hints
  const [nicheHints, setNicheHints] = useState<string[]>([]);
  const [topicHints, setTopicHints] = useState<string[]>([]);

  // — Google Sheets export
  const [sheetsExporting, setSheetsExporting] = useState(false);
  const [sheetsUrl, setSheetsUrl] = useState<string | null>(null);

  // — Video preview & render
  const [showVideoPreview, setShowVideoPreview] = useState(false);
  const [voiceoverUrl, setVoiceoverUrl] = useState('');
  // Legacy localStorage-driven quick-tweak bar — kept so existing
  // workspace-wide brand presets still work. New channel kit + per-doc
  // override take precedence as base; this state spreads on top for
  // last-mile tweaks via VideoPreviewBrandBar.
  const [brandKit, setBrandKit] = useState<Partial<BrandKit>>(DEFAULT_BRAND);
  // — Channel-level visual brand kit (fonts, colors, logo, channel name).
  //   Fetched once on mount when an active channel is pinned; null
  //   otherwise (no channel → renderer falls through to DEFAULT_BRAND_KIT).
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [channelVisualKit, setChannelVisualKit] = useState<ChannelVisualBrandKit | null>(null);
  // — Per-doc override: persists on the production_doc history entry so
  //   it follows the doc across devices and restores cleanly. Default is
  //   the empty kit { v: 1 } — every field falls through to channel.
  const [visualKitOverride, setVisualKitOverride] = useState<ChannelVisualBrandKit>({ v: 1 });
  const [renderId, setRenderId] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle');
  const [renderOutputUrl, setRenderOutputUrl] = useState<string | null>(null);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // — Voiceover-aligned scene timing (per _plans/2026-05-13-voiceover-aligned-scene-timing.md)
  // Mirrors the four-state pill near the Render button: idle → syncing →
  // ready (success) | stale (drift > 20% after a prior alignment) |
  // failed (server returned a reason) | unsupported (voiceover URL isn't
  // a same-origin proxy path).
  type AlignmentPillStatus = 'idle' | 'syncing' | 'ready' | 'stale' | 'failed' | 'unsupported';
  const [alignmentStatus, setAlignmentStatus] = useState<AlignmentPillStatus>('idle');
  const [alignmentDetail, setAlignmentDetail] = useState<string | null>(null);
  // `alignedAtScript` is the canonical script frozen at the moment of
  // the last successful alignment. The drift check compares it against
  // the current script to decide whether soft re-align is enough or a
  // fresh API call is needed.
  const [alignedAtScript, setAlignedAtScript] = useState<string | null>(null);
  const alignmentReqRef = useRef(0);

  // Load brand kit from localStorage on client only. The voiceover URL is
  // handled by <VoiceoverPicker>, which fetches the library, picks the best
  // match for this video (schedule item → title → most recent), and yields
  // a URL through onChange. Centralising that logic in the picker keeps the
  // page free of stale "latest" prefills when the doc is actually for a
  // different video.
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('video_brand_kit') || '{}') as Partial<BrandKit>;
      if (stored.primaryColor) setBrandKit(b => ({ ...b, ...stored }));
    } catch { /* ignore */ }
  }, []);

  // ── Fetch the active channel + its visual brand kit on mount ───────────
  //
  // Two hops: GET /api/user/settings/active-channel → channel id, then
  // GET /api/channels/[id]/visual-brand-kit → kit. Both are silently
  // ignored on failure (default kit applies). The kit is read-only here;
  // changes happen on the channel settings page.
  useEffect(() => {
    let cancelled = false;
    async function loadChannelKit() {
      try {
        const acRes = await fetch('/api/user/settings/active-channel');
        if (!acRes.ok) return;
        const ac = (await acRes.json()) as { active_channel_id: string | null };
        if (cancelled || !ac.active_channel_id) return;
        setActiveChannelId(ac.active_channel_id);
        const kitRes = await fetch(`/api/channels/${ac.active_channel_id}/visual-brand-kit`);
        if (cancelled || !kitRes.ok) return;
        const { visual_brand_kit } = (await kitRes.json()) as {
          visual_brand_kit: ChannelVisualBrandKit;
        };
        setChannelVisualKit(visual_brand_kit);
      } catch { /* ignore — falls through to DEFAULT_BRAND_KIT */ }
    }
    void loadChannelKit();
    return () => { cancelled = true; };
  }, []);

  // ── Persist the per-doc override onto the history entry whenever it
  //    changes. Mirrors how doc + rowImages are persisted. Fire-and-
  //    forget — a stale override on disk is a soft failure.
  useEffect(() => {
    if (!historyEntryId) return;
    updateProductionDocEntry(historyEntryId, {
      visualBrandKitOverride: visualKitOverride,
    }).catch(() => { /* ignore */ });
  }, [historyEntryId, visualKitOverride]);

  // ── Compute the merged BrandKit for every render-time consumer.
  //    Order: DEFAULT_BRAND_KIT ← channel ← override ← legacy bar.
  //    The legacy bar (VideoPreviewBrandBar's localStorage state) stays
  //    on top so users who only ever used the quick-tweak still see
  //    their colors take effect.
  const effectiveBrandKit = React.useMemo<Partial<BrandKit>>(
    () => ({
      ...resolveBrandKitForRender(channelVisualKit, visualKitOverride),
      ...brandKit,
    }),
    [channelVisualKit, visualKitOverride, brandKit],
  );

  // Load prefill from generator / QA pages. Functional setters so a
  // schedule-link prefill that resolved first isn't clobbered by stale
  // localStorage from an earlier handoff.
  useEffect(() => {
    setNicheHints(getRecentNiches());
    setTopicHints(getRecentTopics());
    try {
      const raw = localStorage.getItem('prodoc_prefill');
      if (raw) {
        localStorage.removeItem('prodoc_prefill');
        const data = JSON.parse(raw);
        if (data.script) setScript(curr => curr || data.script);
        if (data.niche)  setNiche(curr => curr || data.niche);
        if (data.topic)  setTopic(curr => curr || data.topic);
      }
    } catch { /* ignore */ }
  }, []);

  // ── YouTube reference helpers

  async function analyzeYouTubeStyle(url: string, idx: number) {
    setVisualRefs(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], analyzing: true };
      return next;
    });
    try {
      const res = await fetch('/api/analyze/youtube-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: url }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data.error as string) || 'Analysis failed');
      setVisualRefs(prev => {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          analyzing: false,
          title: (data.title as string) || undefined,
          channelTitle: (data.channelTitle as string) || undefined,
          analyzedStyle: data.styleDescription as string,
        };
        return next;
      });
      if (data.styleDescription) {
        setCreativeBrief(prev => {
          const label = (data.title as string) || url;
          const tag = `[YouTube ref "${label}": ${data.styleDescription}]`;
          return prev ? `${prev}\n\n${tag}` : tag;
        });
        toast.success('Visual style extracted from YouTube video');
      }
    } catch (err) {
      setVisualRefs(prev => {
        const next = [...prev];
        next[idx] = { ...next[idx], analyzing: false, analysisFailed: true };
        return next;
      });
      toast.error(err instanceof Error ? err.message : 'YouTube style analysis failed');
    }
  }

  function addYtRef() {
    const id = extractYouTubeId(ytRefInput);
    if (!id) { toast.error('Invalid YouTube URL'); return; }
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    if (visualRefs.some(r => r.type === 'youtube' && r.url === canonical)) { toast.error('Already added'); return; }
    // Capture index before state update — safe because we only ever append
    const newIdx = visualRefs.length;
    setVisualRefs(prev => [...prev, { type: 'youtube' as const, url: canonical }]);
    setYtRefInput('');
    // Analyze outside the state updater to avoid side-effects in a pure function
    analyzeYouTubeStyle(canonical, newIdx);
  }

  // Takes the base64 + mediaType directly so the bytes never have to be
  // retained in component state. Caller has them transiently from the
  // FileReader; once this call resolves they're gone.
  async function analyzeScreenshot(base64: string, mediaType: string, idx: number) {
    setVisualRefs(prev => {
      if (!prev[idx]) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], analyzing: true };
      return next;
    });
    try {
      const res = await fetch('/api/analyze/image-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mediaType }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data.error as string) || 'Analysis failed');
      setVisualRefs(prev => {
        const next = [...prev];
        next[idx] = { ...next[idx], analyzing: false, analyzedStyle: data.description as string };
        return next;
      });
      // Append to creative brief
      if (data.description) {
        setCreativeBrief(prev => {
          const tag = `[Screenshot style: ${data.description}]`;
          return prev ? `${prev}\n\n${tag}` : tag;
        });
        toast.success('Style extracted from screenshot and added to creative brief');
      }
    } catch (err) {
      setVisualRefs(prev => {
        if (!prev[idx]) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], analyzing: false, analysisFailed: true };
        return next;
      });
      toast.error(err instanceof Error ? err.message : 'Style analysis failed');
    }
  }

  function handleScreenshotUpload(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) { toast.error('Only image files are supported'); return; }
      if (file.size > 5 * 1024 * 1024) { toast.error('Image must be under 5 MB'); return; }
      const reader = new FileReader();
      reader.onload = e => {
        const dataUrl = e.target?.result as string;
        const base64 = dataUrl?.split(',')[1];
        if (!base64) { toast.error('Failed to read image'); return; }
        // `objectUrl` is the small string we store for display. The base64
        // we just extracted stays in this closure only — we hand it to the
        // analyze API and then it falls out of scope.
        const objectUrl = URL.createObjectURL(file);
        const newRef: VisualRef = {
          type: 'screenshot',
          objectUrl,
          mediaType: file.type,
          name: file.name,
        };
        // Capture the index inside the updater so concurrent uploads
        // don't all collide on a stale `visualRefs.length` snapshot.
        // queueMicrotask defers the analyze call until after React's
        // commit so we don't kick off a side effect during render.
        setVisualRefs(prev => {
          const newIdx = prev.length;
          queueMicrotask(() => { void analyzeScreenshot(base64, file.type, newIdx); });
          return [...prev, newRef];
        });
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Per-row image generation

  async function generateImageForRow(rowIndex: number, prompt: string, signal?: AbortSignal): Promise<boolean> {
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], status: 'loading' };
      return next;
    });
    try {
      const res = await fetch('/api/generate/production-doc/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ prompt, model: imageModel }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data.error as string) || 'Failed');
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'done', imageUrl: data.imageUrl as string };
        return next;
      });
      return true;
    } catch (err) {
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'error', error: err instanceof Error ? err.message : 'Failed' };
        return next;
      });
      return false;
    }
  }

  async function generateImages(rows: ProductionRow[], signal?: AbortSignal) {
    const aiRows = rows
      .map((r, i) => ({ row: r, idx: i }))
      .filter(({ row }) => row.ai_image_prompt?.trim());

    // Initialise all row states immediately
    const initialStates: RowImageState[] = rows.map(r => {
      if (!r.ai_image_prompt?.trim()) {
        const q = r.stock_search_terms || r.visual_description || r.visual_type;
        return {
          status: 'search',
          searchUrl: `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`,
        };
      }
      return { status: 'pending' };
    });
    setRowImages(initialStates);
    setImageProgress({ done: 0, total: aiRows.length });
    if (aiRows.length === 0) return;

    setImagesGenerating(true);
    appendLog(`Starting AI image generation for ${aiRows.length} shots (2 at a time)...`);
    let doneCount = 0;
    const CONCURRENCY = 2;

    for (let i = 0; i < aiRows.length; i += CONCURRENCY) {
      if (signal?.aborted) break;
      const batch = aiRows.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async ({ row, idx }) => {
          if (signal?.aborted) return;
          await generateImageForRow(idx, row.ai_image_prompt, signal);
          doneCount++;
          setImageProgress({ done: doneCount, total: aiRows.length });
          appendLog(`Image ${doneCount}/${aiRows.length} — shot ${idx + 1} (${row.visual_type})`);
        }),
      );
    }

    setImagesGenerating(false);
    appendLog(`✓ All ${aiRows.length} images complete`);
    toast.success(`${aiRows.length} images generated`);
  }

  // ── Main generation

  const appendLog = useCallback((msg: string) => {
    if (!mountedRef.current) return;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // Cap the log so a long-running session with image generation, retries
    // and chunked runs can't grow it without bound. 200 lines is plenty to
    // diagnose a single run; older lines drop off the front.
    const MAX_LOG_LINES = 200;
    setGenerationLog(prev => {
      const entry = `${ts}  ${msg}`;
      if (prev.length < MAX_LOG_LINES) return [...prev, entry];
      // Slice from the tail to keep the most recent (MAX-1) plus the new entry.
      return [...prev.slice(prev.length - (MAX_LOG_LINES - 1)), entry];
    });
  }, []);

  function cancelGeneration() {
    abortControllerRef.current?.abort();
  }

  async function generate() {
    if (!script.trim() || !niche.trim()) {
      toast.error('Script and niche are required');
      return;
    }

    // Cancel any in-progress generation before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setGenerating(true);
    setDoc(null);
    setRowImages([]);
    try { localStorage.removeItem('prodoc_last_result'); } catch {};
    setImageProgress({ done: 0, total: 0 });
    setImagesGenerating(false);
    setGenerationLog([]);

    try {
      // Build creative brief from analyzed visual refs (not raw URLs — the model can't click them)
      let fullBrief = creativeBrief.trim();

      const analyzedRefs = visualRefs.filter(r => r.analyzedStyle);
      if (analyzedRefs.length > 0) {
        const refLines = analyzedRefs.map(r => {
          if (r.type === 'youtube') {
            const label = r.title ? `"${r.title}"` : r.url || 'YouTube';
            return `• YouTube ref ${label}: ${r.analyzedStyle}`;
          }
          return `• Screenshot${r.name ? ` "${r.name}"` : ''}: ${r.analyzedStyle}`;
        }).join('\n');
        fullBrief += (fullBrief ? '\n\n' : '') + `Visual Style References (match these exactly):\n${refLines}`;
      }

      // Refs that failed analysis — re-attempt them now and wait up to 12 s
      const failedRefs = visualRefs.filter(r => r.type === 'youtube' && r.url && r.analysisFailed && !r.analyzedStyle);
      if (failedRefs.length > 0) {
        appendLog(`↻ Retrying style analysis for ${failedRefs.length} YouTube ref(s)...`);
        await Promise.all(
          failedRefs.map((r, fi) => {
            const idx = visualRefs.findIndex(v => v === r);
            if (idx === -1 || !r.url) return;
            // Clear failed flag before retry
            setVisualRefs(prev => {
              const next = [...prev];
              next[idx] = { ...next[idx], analysisFailed: false };
              return next;
            });
            return Promise.race([
              analyzeYouTubeStyle(r.url, idx),
              new Promise(res => setTimeout(res, 12000)), // 12 s max wait
            ]);
          }),
        );
      }

      // Refs still without a style after retry (genuinely failed or still analyzing)
      const stillPending = visualRefs.filter(r => r.type === 'youtube' && r.url && !r.analyzedStyle);
      if (stillPending.length > 0) {
        const analyzing = stillPending.filter(r => r.analyzing).length;
        const failed = stillPending.filter(r => !r.analyzing).length;
        if (analyzing > 0) appendLog(`⚠ ${analyzing} YouTube ref(s) still analyzing — their style won't be in this generation`);
        if (failed > 0) appendLog(`⚠ ${failed} YouTube ref(s) could not be analyzed (thumbnail unavailable) — their style won't be included`);
      }

      const analyzedCount = analyzedRefs.length;
      const totalWords = script.trim().split(/\s+/).length;
      appendLog(`Script: ${totalWords} words · Style: ${stylePreset}${analyzedCount > 0 ? ` · ${analyzedCount} visual ref(s) analyzed` : ''}`);

      // ── Chunked generation — split long scripts to avoid 504 timeouts ──────────
      // 700 words ≈ 35–50 rows per chunk, comfortably within the API's 16k output cap.
      const MAX_CHUNK_WORDS = 700;
      const chunks = splitScriptIntoChunks(script.trim(), MAX_CHUNK_WORDS);
      const isMultiChunk = chunks.length > 1;
      if (isMultiChunk) {
        appendLog(`Long script — splitting into ${chunks.length} chunks to avoid timeout...`);
      } else {
        appendLog('Sending to AI model...');
      }

      let allRows: ProductionRow[] = [];
      let firstResult: ProductionDoc | null = null;
      let timecodeOffsetSeconds = 0;

      // Send one chunk to the API. Retries once on transient upstream failures
      // (502/503/504 + network errors) — Kie's gateway has occasional blips
      // and a single retry recovers most of them. Aborts and 4xx responses
      // are non-retryable.
      const sendChunk = async (chunkIdx: number): Promise<Response> => {
        const doFetch = () => fetch('/api/generate/production-doc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            modelId, niche, topic,
            script: chunks[chunkIdx],
            speakingPaceWpm: effectiveWpm,
            stylePreset,
            creativeBrief: fullBrief || undefined,
            startTimecodeSeconds: timecodeOffsetSeconds,
            isChunk: isMultiChunk && chunkIdx > 0,
          }),
        });
        let attempts = 0;
        while (true) {
          let res: Response | null = null;
          let networkErr: unknown = null;
          try {
            res = await doFetch();
          } catch (err) {
            if ((err as { name?: string }).name === 'AbortError') throw err;
            networkErr = err;
          }
          const transient = networkErr !== null
            || (res !== null && (res.status === 502 || res.status === 503 || res.status === 504));
          if (transient && attempts < 1) {
            attempts++;
            const reason = networkErr !== null
              ? 'network error'
              : `HTTP ${res!.status}`;
            appendLog(`↻ Chunk ${chunkIdx + 1} ${reason} — retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          if (networkErr) throw networkErr;
          return res!;
        }
      };

      for (let ci = 0; ci < chunks.length; ci++) {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (isMultiChunk) appendLog(`Generating chunk ${ci + 1} of ${chunks.length}...`);

        const res = await sendChunk(ci);
        const data = await safeJson(res);
        if (!res.ok) throw new Error((data.error as string) || `Chunk ${ci + 1} generation failed`);

        const chunkResult = data.result as ProductionDoc;
        if (!chunkResult?.rows?.length) {
          throw new Error(`Chunk ${ci + 1} returned empty — try again`);
        }

        if (ci === 0) firstResult = chunkResult;
        allRows = allRows.concat(chunkResult.rows);

        // Advance timecode offset by the actual words spoken (not just chunk length)
        const chunkWords = chunks[ci].trim().split(/\s+/).length;
        timecodeOffsetSeconds += Math.round((chunkWords / effectiveWpm) * 60);
      }

      // Merge chunk results into a single ProductionDoc
      const totalDurationSecs = timecodeOffsetSeconds;
      const totalMins = Math.floor(totalDurationSecs / 60);
      const totalSecs = totalDurationSecs % 60;
      const result: ProductionDoc = {
        ...(firstResult as ProductionDoc),
        total_duration: `${totalMins}:${String(totalSecs).padStart(2, '0')}`,
        total_words: totalWords,
        rows: allRows,
      };

      appendLog(`Response received — parsing production doc...`);
      if (!result?.rows?.length) {
        throw new Error('Production doc returned empty — the AI may have failed to parse the script. Try again.');
      }

      setDoc(result);
      const savedEntry = await saveProductionDocEntry({
        title: result.title || topic || niche,
        niche: result.niche || niche,
        topic,
        modelId,
        shotCount: result.rows.length,
        totalDuration: result.total_duration,
        totalWords: result.total_words,
        stylePreset,
        doc: result,
        script: script.trim() || undefined,
        videoTitle: scheduleItem?.title?.trim() || topic.trim() || undefined,
        scheduleItemId: scheduleItemId || undefined,
      });
      setHistoryEntryId(savedEntry.id);
      // Optimistic prepend — see voiceover/generator save handlers.
      setHistoryItems((prev) => [savedEntry, ...prev.filter((p) => p.id !== savedEntry.id)]);
      appendLog(`✓ ${result.rows.length} shots generated`);
      toast.success(`Production doc ready — ${result.rows.length} shots`);

      // Schedule writeback now goes through the saver registration:
      //   - <ScheduleSaverRegistration autoStamp={...}> silently stamps the
      //     `latest_production_doc` fingerprint as soon as the doc is parsed.
      //   - The banner's "Save production doc" button re-pushes the same
      //     metadata with a confirmation toast and offers an optional
      //     advance to "Recording".
      setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);

      // Fire-and-forget image generation — passes the same abort signal so Stop also cancels images
      generateImages(result.rows, controller.signal).catch(err => {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.error('Image generation error:', err);
        }
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        appendLog('⊘ Cancelled');
        toast.info('Generation cancelled');
      } else {
        const msg = err instanceof Error ? err.message : 'Generation failed';
        appendLog(`✗ ${msg}`);
        toast.error(msg);
      }
    } finally {
      setGenerating(false);
      abortControllerRef.current = null;
    }
  }

  // ── Google Sheets export

  async function exportToSheets() {
    if (!doc) return;
    setSheetsExporting(true);
    setSheetsUrl(null);
    try {
      const exportData = {
        title: doc.title || topic || niche,
        niche: doc.niche,
        totalDuration: doc.total_duration,
        totalWords: doc.total_words,
        speakingPaceWpm: doc.speaking_pace_wpm,
        rows: doc.rows.map((r, i) => ({
          timecode: r.timecode || '',
          script_text: r.script_text || '',
          visual_type: r.visual_type || '',
          visual_description: r.visual_description || '',
          stock_search_terms: r.stock_search_terms || '',
          overlay_stock_terms: r.overlay_stock_terms || '',
          ai_image_prompt: r.ai_image_prompt || '',
          on_screen_text: r.on_screen_text || '',
          notes: r.notes || '',
          imageUrl: rowImages[i]?.imageUrl,
          searchUrl: rowImages[i]?.searchUrl,
        })),
      };
      const res = await fetch('/api/production-doc/export-sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportData }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        if ((data.error as string) === 'NEEDS_GOOGLE_AUTH') {
          toast.error(
            (data.message as string) || 'Connect your Google account in Settings to export to Sheets.',
            { duration: 8000 },
          );
          return;
        }
        if ((data.error as string) === 'NEEDS_REAUTH') {
          toast.error(
            (data.message as string) ||
            'Google Sheets access not granted — reconnect in Settings → Google Account',
            { duration: 8000 },
          );
          return;
        }
        throw new Error((data.error as string) || 'Export failed');
      }
      const url = data.sheetUrl as string;
      setSheetsUrl(url);
      window.open(url, '_blank', 'noopener,noreferrer');
      toast.success('Exported to Google Sheets!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setSheetsExporting(false);
    }
  }

  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const estDuration = wordCount > 0
    ? `~${Math.floor(wordCount / speakingPace)}:${String(Math.round(((wordCount / speakingPace) % 1) * 60)).padStart(2, '0')}`
    : null;
  // Parse "mm:ss" actual voiceover duration → derive real WPM for timecode accuracy
  const actualDurationSecs = (() => {
    const parts = actualDuration.trim().split(':');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const s = parseInt(parts[1], 10);
      if (!isNaN(m) && !isNaN(s) && s < 60) return m * 60 + s;
    }
    return 0;
  })();
  const effectiveWpm = actualDurationSecs > 0 && wordCount > 0
    ? Math.round(wordCount / (actualDurationSecs / 60))
    : speakingPace;

  // ── Voiceover-aligned scene timing ───────────────────────────────────────────

  /**
   * Canonical script seen by the alignment cache. Memoised so the
   * drift-check effect doesn't recompute on every render, and so the
   * dependency comparison (string equality) is cheap.
   */
  const canonicalScript = React.useMemo(() => {
    if (!doc) return '';
    return buildCanonicalScript(doc.rows.map((r) => stripProductionMarkers(r.script_text)));
  }, [doc]);

  /**
   * Trigger an alignment request. Tracked by an incrementing request
   * id so a slow in-flight response can't clobber a newer one if the
   * user clicks "Re-align" twice in a row.
   */
  const runAlignment = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    if (!doc || !voiceoverUrl) return;
    if (!VOICEOVER_PROXY_PATH_RE.test(voiceoverUrl)) return;
    if (!canonicalScript.trim()) return;

    const reqId = ++alignmentReqRef.current;
    setAlignmentStatus('syncing');
    setAlignmentDetail(null);

    try {
      const res = await fetch('/api/voiceovers/align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioPath: voiceoverUrl,
          rowScripts: doc.rows.map((r) => r.script_text),
          forceRefresh: opts?.forceRefresh ?? false,
        }),
      });
      if (reqId !== alignmentReqRef.current) return;
      const data = (await safeJson(res)) as { status?: string; reason?: string };
      if (!res.ok) {
        setAlignmentStatus('failed');
        setAlignmentDetail(typeof data.reason === 'string' ? data.reason : 'Alignment request failed.');
        return;
      }
      if (data.status === 'ready') {
        setAlignmentStatus('ready');
        setAlignmentDetail(null);
        setAlignedAtScript(canonicalScript);
      } else {
        setAlignmentStatus('failed');
        setAlignmentDetail(typeof data.reason === 'string' ? data.reason : 'Alignment failed.');
      }
    } catch (err) {
      if (reqId !== alignmentReqRef.current) return;
      setAlignmentStatus('failed');
      setAlignmentDetail(err instanceof Error ? err.message : 'Alignment request errored.');
    }
  }, [doc, voiceoverUrl, canonicalScript]);

  /**
   * Re-alignment policy (see plan section 'Re-alignment policy'):
   *   - no prior alignment      → run after a 600ms settle delay
   *   - drift ≤ 5%              → soft re-align, cursor walk absorbs it
   *   - 5% < drift ≤ 20%        → background re-align after 1s debounce
   *   - drift > 20%             → 'stale' pill, manual re-align or
   *                               re-record needed
   *
   * Voiceover-change handling is folded in via `lastVoiceoverUrlRef`
   * so a single effect reset gets the new audio's anchor cleared
   * atomically — splitting that into a second effect would flash
   * "Synced to voiceover" for one render against the OLD audio
   * before the clear propagated.
   */
  const lastVoiceoverUrlRef = useRef<string>(voiceoverUrl);
  useEffect(() => {
    // Voiceover changed → clear the anchor and exit. The state update
    // triggers another effect run with the cleared anchor, which then
    // proceeds through the normal "no prior alignment" branch below.
    if (lastVoiceoverUrlRef.current !== voiceoverUrl) {
      lastVoiceoverUrlRef.current = voiceoverUrl;
      if (alignedAtScript !== null) {
        setAlignedAtScript(null);
        setAlignmentStatus('idle');
        setAlignmentDetail(null);
        return;
      }
    }

    if (!doc || !voiceoverUrl) {
      setAlignmentStatus('idle');
      setAlignmentDetail(null);
      return;
    }
    if (!VOICEOVER_PROXY_PATH_RE.test(voiceoverUrl)) {
      setAlignmentStatus('unsupported');
      setAlignmentDetail('Save this voiceover to the workspace library to enable scene sync.');
      return;
    }
    if (!canonicalScript.trim()) {
      setAlignmentStatus('idle');
      return;
    }

    if (!alignedAtScript) {
      const timer = setTimeout(() => { void runAlignment(); }, 600);
      return () => clearTimeout(timer);
    }

    const drift = scriptDriftRatio(alignedAtScript, canonicalScript);
    if (drift <= 0.05) {
      setAlignmentStatus('ready');
      setAlignmentDetail(null);
      return;
    }
    if (drift > 0.20) {
      setAlignmentStatus('stale');
      setAlignmentDetail(`Script drifted ~${Math.round(drift * 100)}% since the last alignment.`);
      return;
    }
    const timer = setTimeout(() => { void runAlignment(); }, 1000);
    return () => clearTimeout(timer);
  }, [doc, voiceoverUrl, canonicalScript, alignedAtScript, runAlignment]);

  // ── Video render ─────────────────────────────────────────────────────────────

  async function startVideoRender() {
    if (!doc) return;
    const config = productionDocToVideoConfig(doc, rowImages, voiceoverUrl || undefined, undefined, effectiveBrandKit);
    setRenderStatus('rendering');
    setRenderProgress(0);
    setRenderOutputUrl(null);

    // Pass the alignment hint when the cache is warm AND the URL is a
    // proxy path the server-side route accepts. Falsy `voiceoverUrl`,
    // ElevenLabs-direct Blob URLs, and any non-ready alignment state
    // make the server fall back to estimated timing — same as today.
    const body: Record<string, unknown> = { config };
    if (
      alignmentStatus === 'ready' &&
      voiceoverUrl &&
      VOICEOVER_PROXY_PATH_RE.test(voiceoverUrl)
    ) {
      body.voiceoverAlignment = {
        audioPath: voiceoverUrl,
        rowScripts: doc.rows.map((r) => r.script_text),
      };
    } else if (alignmentStatus === 'syncing' || alignmentStatus === 'stale') {
      toast.warning('Rendering with estimated timing — voiceover alignment not ready.');
    }

    try {
      const res = await fetch('/api/render/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { renderId?: string; error?: string };
      if (!res.ok || !data.renderId) throw new Error(data.error || 'Failed to start render');

      setRenderId(data.renderId);

      // Poll for progress
      renderPollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/render/video?renderId=${data.renderId}`);
          const statusData = await statusRes.json() as {
            status: string; progress: number; outputUrl?: string; error?: string;
          };

          setRenderProgress(statusData.progress ?? 0);

          if (statusData.status === 'done') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('done');
            setRenderOutputUrl(statusData.outputUrl || null);
            toast.success('Video rendered! Ready to download.');
          } else if (statusData.status === 'error') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('error');
            toast.error(`Render failed: ${statusData.error || 'Unknown error'}`);
          }
        } catch { /* polling error — keep trying */ }
      }, 2000);
    } catch (err) {
      setRenderStatus('error');
      toast.error(err instanceof Error ? err.message : 'Render failed');
    }
  }

  // Cleanup render polling on unmount
  useEffect(() => {
    return () => { if (renderPollRef.current) clearInterval(renderPollRef.current); };
  }, []);

  // ── Saver registration ────────────────────────────────────────────────────
  // Production doc's primary artifact is a row-list (`doc.rows`) with timing
  // metadata. Schedule-side we only stamp the fingerprint — the full doc
  // lives in localStorage history (linked via `history_entry_id`).
  const prodDocReady = !!doc && (doc.rows?.length ?? 0) > 0;
  const prodDocRunKey = doc && historyEntryId
    ? `${historyEntryId}:${doc.rows?.length ?? 0}`
    : null;

  return (
    <ScheduleLinkProvider item={scheduleItem}>
      <ScheduleSaverRegistration
        handle={{
          artifactLabel: 'production doc',
          isReady: prodDocReady,
          isDirty: prodDocReady && prodDocRunKey !== lastSavedProdDocRunKey,
          notReadyReason: 'Generate a production doc first',
          // Production doc → recording is a clean pipeline transition: once
          // the shot list exists, the user can start filming.
          nextStatus: { key: 'recording', label: 'Recording' },
          buildPatch: () => ({
            patch: {},
            customFieldsMerge: {
              latest_production_doc: {
                history_entry_id: historyEntryId,
                shot_count: doc!.rows?.length ?? 0,
                total_duration: doc!.total_duration,
                style_preset: stylePreset,
                generated_at: new Date().toISOString(),
                model_id: modelId,
              },
            },
          }),
          describeSaved: () => doc
            ? `${doc.rows?.length ?? 0} shots${doc.total_duration ? ` · ${doc.total_duration}` : ''}`
            : '',
          onSaved: () => setLastSavedProdDocRunKey(prodDocRunKey),
        }}
        autoStamp={{
          key: 'latest_production_doc',
          value: () => doc ? {
            history_entry_id: historyEntryId,
            shot_count: doc.rows?.length ?? 0,
            total_duration: doc.total_duration,
            style_preset: stylePreset,
            generated_at: new Date().toISOString(),
            model_id: modelId,
          } : null,
          runKey: prodDocRunKey,
        }}
      />
    <div className="p-6 max-w-full">
      {scheduleItem && <ScheduleLinkBanner item={scheduleItem} feature="Production Doc" />}

      {/* ── Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Production Document
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Generate a shot-by-shot breakdown with timecodes, visuals, auto-generated AI images, and Google Images links
        </p>
      </div>

      {/* ── Input Panel */}
      <div className="glass rounded-xl p-5 mb-6 space-y-5">

        {/* Row: niche / topic / pace */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Niche *</label>
            <AutocompleteInput
              value={niche}
              onChange={setNiche}
              suggestions={nicheHints}
              placeholder="e.g. Cybersecurity & Antivirus"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Video Topic</label>
            <AutocompleteInput
              value={topic}
              onChange={setTopic}
              suggestions={topicHints}
              placeholder="e.g. Top 5 Antivirus Mistakes"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Speaking Pace (wpm)
              {actualDurationSecs > 0 && wordCount > 0 ? (
                <span className="ml-2 font-normal" style={{ color: '#34d399' }}>
                  → {actualDuration} actual · {Math.round(wordCount / (actualDurationSecs / 60))} wpm computed
                </span>
              ) : estDuration && (
                <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
                  → est. {estDuration} video
                </span>
              )}
            </label>
            <div className="flex gap-2">
              <select
                value={speakingPace}
                onChange={e => setSpeakingPace(Number(e.target.value))}
                className="input-field flex-1"
                disabled={actualDurationSecs > 0}
                style={{ opacity: actualDurationSecs > 0 ? 0.4 : 1 }}
              >
                <option value={110}>Slow — 110 wpm</option>
                <option value={125}>Moderate — 125 wpm</option>
                <option value={135}>Standard — 135 wpm</option>
                <option value={150}>Fast — 150 wpm</option>
                <option value={165}>Very Fast — 165 wpm</option>
              </select>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <input
                  type="text"
                  value={actualDuration}
                  onChange={e => setActualDuration(e.target.value.replace(/[^0-9:]/g, ''))}
                  placeholder="actual mm:ss"
                  className="input-field"
                  style={{ width: 120, paddingRight: actualDurationSecs > 0 ? 28 : undefined }}
                  title="Enter your actual voiceover recording length (e.g. 16:05) to compute exact timecodes"
                />
                {actualDurationSecs > 0 && (
                  <button
                    onClick={() => setActualDuration('')}
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', lineHeight: 1 }}
                    title="Clear"
                  >×</button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Creative Direction card */}
        <div
          className="rounded-lg p-4 space-y-4"
          style={{ background: 'rgba(124,58,237,0.05)', border: '1px solid rgba(124,58,237,0.15)' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-purple-bright)' }}>
            Creative Direction
          </h3>

          {/* Style preset buttons */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Visual Style
              </label>
              <button
                onClick={() => setStyleManagerOpen(true)}
                className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded"
                style={{ background: 'rgba(124,58,237,0.12)', color: 'var(--accent-purple-bright)', border: '1px solid rgba(124,58,237,0.3)' }}
                title="Create, edit, and delete saved styles"
              >
                Manage styles
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {availableStyles.map(p => {
                const active = stylePreset === p.id;
                const isSaved = p.origin === 'saved';
                const supportsOverlay = p.allow_overlay_stock;
                return (
                  <button
                    key={p.id}
                    onClick={() => setStylePreset(p.id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5"
                    style={{
                      background: active ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.05)',
                      color: active ? '#a78bfa' : 'var(--text-secondary)',
                      border: active ? '1px solid rgba(124,58,237,0.4)' : '1px solid var(--border)',
                    }}
                    title={p.description || (isSaved ? 'Saved style' : 'Built-in style')}
                  >
                    <span>{p.label}</span>
                    {isSaved && (
                      <span
                        className="text-[9px] px-1 rounded"
                        style={{ background: 'rgba(34,211,238,0.15)', color: '#22d3ee' }}
                        title="Workspace-saved style"
                      >
                        Saved
                      </span>
                    )}
                    {supportsOverlay && (
                      <span
                        className="text-[9px] px-1 rounded"
                        style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
                        title="Mixes AI visuals with real-image overlays"
                      >
                        Mixed
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Creative brief */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Creative Brief
            </label>
            <textarea
              value={creativeBrief}
              onChange={e => setCreativeBrief(e.target.value)}
              placeholder="Describe the mood, color palette, tone, or any specific visual direction… e.g. Dark cyberpunk aesthetic, neon blues and purples, futuristic UI overlays"
              className="input-field text-xs"
              style={{ minHeight: 68, resize: 'vertical' }}
            />
          </div>

          {/* Visual References — YouTube URLs or uploaded screenshots */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Visual References
            </label>
            <div className="flex gap-2 mb-2 flex-wrap">
              <input
                value={ytRefInput}
                onChange={e => setYtRefInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addYtRef(); } }}
                placeholder="Paste a YouTube URL and press Enter"
                className="input-field flex-1 text-xs"
                style={{ minWidth: 180 }}
              />
              <button onClick={addYtRef} className="btn-secondary text-xs px-3 shrink-0">
                + YouTube
              </button>
              <button
                onClick={() => screenshotInputRef.current?.click()}
                className="btn-secondary text-xs px-3 shrink-0"
              >
                + Screenshot
              </button>
              <input
                ref={screenshotInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={e => handleScreenshotUpload(e.target.files)}
              />
            </div>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              Add YouTube videos or upload screenshots — AI will analyze the style and auto-fill the creative brief
            </p>
            {visualRefs.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {visualRefs.map((ref, idx) => (
                  <div key={idx} className="relative group">
                    {ref.type === 'youtube' && ref.url ? (
                      <div style={{ position: 'relative' }}>
                        <a href={ref.url} target="_blank" rel="noopener noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`https://img.youtube.com/vi/${extractYouTubeId(ref.url)}/mqdefault.jpg`}
                            alt="YouTube reference"
                            title={ref.analyzedStyle || ref.title || ref.url}
                            style={{ width: 100, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)', display: 'block' }}
                          />
                        </a>
                        {ref.analyzing && (
                          <div className="absolute inset-0 flex items-center justify-center rounded-md" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}>
                            <div className="spinner" style={{ width: 16, height: 16 }} />
                          </div>
                        )}
                        {ref.analyzedStyle && !ref.analyzing && (
                          <div className="absolute bottom-0 left-0 right-0 rounded-b-md px-1 py-0.5 text-center" style={{ background: 'rgba(16,185,129,0.85)', fontSize: '0.55rem', color: 'white', lineHeight: 1.2 }}>
                            ✓ Style analyzed
                          </div>
                        )}
                        {ref.analysisFailed && !ref.analyzing && !ref.analyzedStyle && (
                          <button
                            onClick={() => analyzeYouTubeStyle(ref.url!, idx)}
                            className="absolute bottom-0 left-0 right-0 rounded-b-md px-1 py-0.5 text-center"
                            style={{ background: 'rgba(239,68,68,0.85)', fontSize: '0.55rem', color: 'white', lineHeight: 1.2 }}
                            title="Analysis failed — click to retry"
                          >
                            ✗ Failed · retry
                          </button>
                        )}
                      </div>
                    ) : ref.type === 'screenshot' && ref.objectUrl ? (
                      <div style={{ position: 'relative' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={ref.objectUrl}
                          alt={ref.name || 'Screenshot'}
                          title={ref.analyzedStyle || ref.name}
                          style={{ width: 100, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)', display: 'block' }}
                        />
                        {ref.analyzing && (
                          <div
                            className="absolute inset-0 flex items-center justify-center rounded-md"
                            style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
                          >
                            <div className="spinner" style={{ width: 16, height: 16 }} />
                          </div>
                        )}
                        {ref.analyzedStyle && !ref.analyzing && (
                          <div
                            className="absolute bottom-0 left-0 right-0 rounded-b-md px-1 py-0.5 text-center"
                            style={{ background: 'rgba(16,185,129,0.85)', fontSize: '0.55rem', color: 'white', lineHeight: 1.2 }}
                          >
                            ✓ Style analyzed
                          </div>
                        )}
                        {ref.analysisFailed && !ref.analyzing && !ref.analyzedStyle && (
                          <div
                            className="absolute bottom-0 left-0 right-0 rounded-b-md px-1 py-0.5 text-center"
                            style={{ background: 'rgba(239,68,68,0.85)', fontSize: '0.55rem', color: 'white', lineHeight: 1.2 }}
                            title="Style analysis failed"
                          >
                            ✗ Failed
                          </div>
                        )}
                      </div>
                    ) : null}
                    <button
                      onClick={() => setVisualRefs(prev => {
                        const removed = prev[idx];
                        if (removed?.objectUrl) URL.revokeObjectURL(removed.objectUrl);
                        return prev.filter((_, i) => i !== idx);
                      })}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
                      style={{ background: '#ef4444', color: 'white', lineHeight: 1 }}
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Script textarea */}
        <div>
          <div className="flex items-center justify-between mb-1.5 flex-wrap gap-2">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Script *</label>
            <div className="flex items-center gap-2">
              {script.trim().length > 0 && (
                <>
                  <CopyForElevenLabs script={script} version="v2" />
                  <CopyForElevenLabs script={script} version="v3" />
                </>
              )}
              {wordCount > 0 && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {wordCount.toLocaleString()} words
                </span>
              )}
            </div>
          </div>
          <textarea
            value={script}
            onChange={e => setScript(e.target.value)}
            placeholder="Paste your finished script here..."
            className="input-field font-mono text-xs leading-relaxed"
            style={{ minHeight: 200, resize: 'vertical' }}
          />
        </div>

        {/* Image model — used for per-shot AI images */}
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            Image Model
          </label>
          <select
            value={imageModel}
            onChange={e => setImageModel(e.target.value)}
            className="input-field w-full text-sm"
          >
            {IMAGE_MODELS.map(m => (
              <option key={m.value} value={m.value}>
                {m.label}
                {m.hint ? ` — ${m.hint}` : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Model + Generate */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <ModelSelector value={modelId} onChange={setModelId} label="" />
          </div>
          <button
            onClick={generate}
            disabled={generating || !script.trim() || !niche.trim()}
            className="btn-primary px-6 shrink-0"
          >
            {generating ? (
              <><div className="spinner" style={{ width: 14, height: 14 }} /> Generating...</>
            ) : (
              'Generate Production Doc'
            )}
          </button>
        </div>

        {(generating || generationLog.length > 0) && (
          <div
            className="rounded-lg overflow-hidden"
            style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(124,58,237,0.2)' }}
          >
            <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid rgba(124,58,237,0.15)', background: 'rgba(124,58,237,0.08)' }}>
              <div className="flex items-center gap-2">
                {generating && <div className="spinner" style={{ width: 10, height: 10 }} />}
                <span className="text-xs font-medium" style={{ color: 'var(--accent-purple-bright)' }}>
                  {generating ? 'Generating…' : 'Done'}
                </span>
              </div>
              {generating && (
                <button
                  onClick={cancelGeneration}
                  className="text-xs px-2 py-0.5 rounded transition-colors"
                  style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}
                >
                  ✕ Stop
                </button>
              )}
            </div>
            <div className="px-3 py-2 font-mono text-xs space-y-0.5 max-h-40 overflow-y-auto" style={{ color: 'var(--text-secondary)' }}>
              {generationLog.map((line, i) => (
                <div key={i} style={{ color: line.includes('✓') ? '#34d399' : line.includes('✗') || line.includes('⊘') ? '#f87171' : line.includes('⚠') ? '#fbbf24' : 'var(--text-secondary)' }}>
                  {line}
                </div>
              ))}
              {generating && <div style={{ color: 'var(--text-muted)' }}>▌</div>}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* ── Image Generation Progress */}
      {(imagesGenerating || (imageProgress.total > 0 && imageProgress.done < imageProgress.total)) && (
        <div className="glass rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Generating AI images with Grok…
            </span>
            <div className="flex items-center gap-3">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {imageProgress.done} / {imageProgress.total}
              </span>
              {/* Stop — same AbortController also cancels in-flight image fetches */}
              <button
                onClick={cancelGeneration}
                className="text-xs px-2 py-0.5 rounded transition-colors"
                style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}
                title="Cancel remaining image generations"
              >
                ✕ Stop
              </button>
            </div>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
            <div
              className="h-1.5 rounded-full transition-all duration-700"
              style={{
                width: `${imageProgress.total ? (imageProgress.done / imageProgress.total) * 100 : 0}%`,
                background: 'linear-gradient(90deg, #7c3aed, #06b6d4)',
              }}
            />
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Each image takes ~30–60 s. They appear inline as they complete — non-AI rows already have Google Image search links.
          </p>
        </div>
      )}

      {/* ── Results */}
      {doc && (() => {
        // The Overlay column / pill only appear when at least one row in
        // this doc carries an `overlay_stock_terms` value. Pure-doodle and
        // pure-cinematic docs render exactly as they did before.
        const showOverlayColumn = doc.rows.some((r) => r.overlay_stock_terms?.trim());
        return (
        <div ref={tableRef}>
          {/* Doc header */}
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {doc.title || topic || niche}
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {doc.rows?.length} shots · {doc.total_duration} · {doc.total_words?.toLocaleString()} words · {doc.speaking_pace_wpm} wpm
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => exportToCsv(doc, rowImages)} className="btn-primary text-sm px-4">
                ⬇ Export CSV
              </button>
              <button
                onClick={exportToSheets}
                disabled={sheetsExporting}
                className="btn-secondary text-sm px-4 flex items-center gap-1.5"
                title="Export to Google Sheets"
              >
                {sheetsExporting ? (
                  <><div className="spinner" style={{ width: 12, height: 12 }} /> Exporting…</>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.85 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="8" y1="13" x2="16" y2="13" />
                      <line x1="8" y1="17" x2="16" y2="17" />
                    </svg>
                    Export to Sheets
                  </>
                )}
              </button>
              {sheetsUrl && (
                <a
                  href={sheetsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs flex items-center gap-1 underline"
                  style={{ color: '#34d399' }}
                >
                  ↗ Open Sheet
                </a>
              )}
              <button onClick={generate} disabled={generating} className="btn-secondary text-sm px-4">
                ↺ Regenerate
              </button>
            </div>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            {Object.entries(VISUAL_TYPE_COLORS).map(([type, { bg, color }]) => (
              <span key={type} className="text-xs px-2 py-0.5 rounded-full" style={{ background: bg, color }}>
                {type}
              </span>
            ))}
            {(() => {
              const overlayCount = doc.rows.filter((r) => r.overlay_stock_terms?.trim()).length;
              if (overlayCount === 0) return null;
              return (
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
                  title={`${overlayCount} row(s) flagged for editor-composited real-image overlays`}
                >
                  ✦ {overlayCount} overlay{overlayCount === 1 ? '' : 's'}
                </span>
              );
            })()}
          </div>

          {/* Section-divider thumbnail — composite image referenced by per-row "Zoom to" picks. */}
          <div className="mb-4">
            <SectionThumbnailCard value={doc.thumbnail} onChange={setThumbnail} />
          </div>

          {/* ── Desktop table */}
          <div className="glass rounded-xl overflow-hidden">
            <div className="overflow-x-auto hidden md:block">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
                    {(() => {
                      const headerList = ['#', 'Time', 'Script Text', 'Visual Type', 'Visual Description', 'Stock Terms', 'Image', 'B-roll', 'AI Prompt'];
                      if (showOverlayColumn) headerList.push('Overlay');
                      headerList.push('On-Screen Text', 'Notes');
                      if (doc.thumbnail) headerList.push('Section');
                      return headerList;
                    })().map(h => (
                      <th key={h} style={{
                        padding: '10px 12px', textAlign: 'left', fontWeight: 600,
                        color: 'var(--text-secondary)', whiteSpace: 'nowrap',
                        borderRight: '1px solid var(--border)',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {doc.rows?.map((row, i) => {
                    const vt = VISUAL_TYPE_COLORS[row.visual_type] || VISUAL_TYPE_COLORS['B-Roll'];
                    const imgState = rowImages[i] || { status: 'idle' };
                    return (
                      <tr
                        key={i}
                        style={{
                          borderBottom: '1px solid var(--border)',
                          background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                        }}
                      >
                        {/* # */}
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', borderRight: '1px solid var(--border)' }}>
                          {i + 1}
                        </td>
                        {/* Timecode */}
                        <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: 'var(--accent-cyan-bright)', whiteSpace: 'nowrap', fontWeight: 600, borderRight: '1px solid var(--border)' }}>
                          {row.timecode}
                        </td>
                        {/* Script text */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: 200, lineHeight: 1.5, borderRight: '1px solid var(--border)' }}>
                          {row.script_text}
                        </td>
                        {/* Visual type */}
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', borderRight: '1px solid var(--border)' }}>
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: vt.bg, color: vt.color }}>
                            {row.visual_type}
                          </span>
                        </td>
                        {/* Visual description */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', maxWidth: 180, lineHeight: 1.5, borderRight: '1px solid var(--border)' }}>
                          {row.visual_description}
                        </td>
                        {/* Stock terms */}
                        <td style={{ padding: '8px 12px', maxWidth: 130, borderRight: '1px solid var(--border)' }}>
                          <div className="flex flex-wrap gap-1">
                            {row.stock_search_terms.split(',').map((t, ti) => (
                              <span key={ti} className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                {t.trim()}
                              </span>
                            ))}
                          </div>
                        </td>
                        {/* Image */}
                        <td style={{ padding: '8px 10px', width: 100, borderRight: '1px solid var(--border)', verticalAlign: 'middle' }}>
                          <ImageCell
                            state={imgState}
                            onRetry={() => {
                              if (row.ai_image_prompt?.trim()) {
                                generateImageForRow(i, row.ai_image_prompt);
                              }
                            }}
                          />
                        </td>
                        {/* B-roll (Veo 3 / Sora 2) */}
                        <td style={{ padding: '8px 10px', width: 140, borderRight: '1px solid var(--border)', verticalAlign: 'middle', position: 'relative' }}>
                          <BrollCell
                            rowIndex={i}
                            rowSignature={brollRowSignatureInput({
                              timecode: row.timecode,
                              visual_description: row.visual_description,
                            })}
                            visualDescription={row.visual_description}
                            aiImagePrompt={row.ai_image_prompt}
                            styleHint={stylePreset}
                          />
                        </td>
                        {/* AI prompt */}
                        <td style={{ padding: '8px 12px', maxWidth: 240, borderRight: '1px solid var(--border)' }}>
                          {row.ai_image_prompt ? (
                            <div className="flex items-start gap-1">
                              <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', lineHeight: 1.5, flex: 1 }}>
                                {row.ai_image_prompt}
                              </span>
                              <CopyButton text={row.ai_image_prompt} />
                            </div>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>—</span>
                          )}
                        </td>
                        {/* Overlay (real-image composite) */}
                        {showOverlayColumn && (
                          <td style={{ padding: '8px 12px', maxWidth: 140, borderRight: '1px solid var(--border)' }}>
                            {row.overlay_stock_terms?.trim() ? (
                              <a
                                href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(row.overlay_stock_terms)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
                                style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
                                title="Click to find a real image to composite onto the AI-generated visual"
                              >
                                ✦ {row.overlay_stock_terms}
                              </a>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>—</span>
                            )}
                          </td>
                        )}
                        {/* On-screen text */}
                        <td style={{ padding: '8px 12px', borderRight: '1px solid var(--border)' }}>
                          {row.on_screen_text ? (
                            <span className="px-1.5 py-0.5 rounded text-xs font-medium" style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>
                              {row.on_screen_text}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>—</span>
                          )}
                        </td>
                        {/* Notes */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-muted)', maxWidth: 130, fontSize: '0.7rem', lineHeight: 1.5 }}>
                          {row.notes || '—'}
                        </td>
                        {/* Section (thumbnail-zoom controls) — only rendered when a thumbnail exists */}
                        {doc.thumbnail && (
                          <td style={{ padding: '8px 10px', width: 170, verticalAlign: 'top' }}>
                            <SectionRowControls
                              rowIndex={i}
                              thumbnail={doc.thumbnail}
                              zoomTo={row.thumbnail_zoom_to}
                              sectionTitle={row.section_title}
                              transition={row.thumbnail_transition}
                              defaultTransition={doc.thumbnail.defaultTransition}
                              onChangeZoomTo={(id) => updateRow(i, { thumbnail_zoom_to: id })}
                              onChangeSectionTitle={(t) => updateRow(i, { section_title: t })}
                              onChangeTransition={(t) => updateRow(i, { thumbnail_transition: t })}
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Mobile cards */}
            <div className="md:hidden divide-y" style={{ borderColor: 'var(--border)' }}>
              {doc.rows?.map((row, i) => {
                const vt = VISUAL_TYPE_COLORS[row.visual_type] || VISUAL_TYPE_COLORS['B-Roll'];
                const imgState = rowImages[i] || { status: 'idle' };
                const isOpen = expandedRow === i;
                return (
                  <div key={i} className="p-4">
                    <button
                      className="w-full flex items-center gap-3 text-left"
                      onClick={() => setExpandedRow(isOpen ? null : i)}
                    >
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', width: 16 }}>{i + 1}</span>
                      <span style={{ fontFamily: 'monospace', color: 'var(--accent-cyan-bright)', fontWeight: 700, fontSize: '0.8rem' }}>{row.timecode}</span>
                      <span className="px-2 py-0.5 rounded-full text-xs" style={{ background: vt.bg, color: vt.color }}>{row.visual_type}</span>
                      <span className="flex-1 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{row.script_text}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', color: 'var(--text-muted)', flexShrink: 0 }}>
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {isOpen && (
                      <div className="mt-3 space-y-2.5 pl-4">
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Script</p>
                          <p className="text-xs" style={{ color: 'var(--text-primary)' }}>{row.script_text}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Visual</p>
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.visual_description}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Image</p>
                          <ImageCell
                            state={imgState}
                            onRetry={() => row.ai_image_prompt?.trim() && generateImageForRow(i, row.ai_image_prompt)}
                          />
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>B-roll</p>
                          <BrollCell
                            rowIndex={i}
                            rowSignature={brollRowSignatureInput({
                              timecode: row.timecode,
                              visual_description: row.visual_description,
                            })}
                            visualDescription={row.visual_description}
                            aiImagePrompt={row.ai_image_prompt}
                            styleHint={stylePreset}
                          />
                        </div>
                        {row.ai_image_prompt && (
                          <div>
                            <div className="flex items-center justify-between mb-0.5">
                              <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>AI Prompt</p>
                              <CopyButton text={row.ai_image_prompt} />
                            </div>
                            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.ai_image_prompt}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Stock Terms</p>
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.stock_search_terms}</p>
                        </div>
                        {row.overlay_stock_terms?.trim() && (
                          <div>
                            <p className="text-xs font-semibold mb-0.5" style={{ color: '#fbbf24' }}>✦ Real-image overlay</p>
                            <a
                              href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(row.overlay_stock_terms)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs underline"
                              style={{ color: '#fbbf24' }}
                            >
                              {row.overlay_stock_terms}
                            </a>
                          </div>
                        )}
                        {row.on_screen_text && (
                          <div>
                            <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>On-Screen Text</p>
                            <p className="text-xs" style={{ color: '#fbbf24' }}>{row.on_screen_text}</p>
                          </div>
                        )}
                        {row.notes && (
                          <div>
                            <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Notes</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{row.notes}</p>
                          </div>
                        )}
                        {doc.thumbnail && (
                          <div>
                            <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Section</p>
                            <SectionRowControls
                              rowIndex={i}
                              thumbnail={doc.thumbnail}
                              zoomTo={row.thumbnail_zoom_to}
                              sectionTitle={row.section_title}
                              transition={row.thumbnail_transition}
                              defaultTransition={doc.thumbnail.defaultTransition}
                              onChangeZoomTo={(id) => updateRow(i, { thumbnail_zoom_to: id })}
                              onChangeSectionTitle={(t) => updateRow(i, { section_title: t })}
                              onChangeTransition={(t) => updateRow(i, { thumbnail_transition: t })}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Video Preview & Render ─────────────────────────────────────── */}
          <div className="mt-6 glass rounded-xl overflow-hidden">
            {/* Header — toggle */}
            <button
              className="w-full flex items-center justify-between px-5 py-4"
              onClick={() => setShowVideoPreview(v => !v)}
            >
              <div className="flex items-center gap-3">
                {/* Film icon */}
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.15)' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                    <line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" />
                    <line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" />
                    <line x1="17" y1="7" x2="22" y2="7" />
                  </svg>
                </div>
                <div className="text-left">
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Video Preview & Render
                  </span>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Assemble your shots into a real animated video powered by Remotion
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Shot/image count badges */}
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
                  {doc.rows.length} shots
                </span>
                {rowImages.filter(r => r?.status === 'done').length > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(16,185,129,0.1)', color: '#34d399' }}>
                    {rowImages.filter(r => r?.status === 'done').length} images ready
                  </span>
                )}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ transform: showVideoPreview ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', color: 'var(--text-muted)' }}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
            </button>

            {showVideoPreview && (
              <div className="px-5 pb-5 space-y-4" style={{ borderTop: '1px solid var(--border)' }}>
                {/* Voiceover picker — pulls from the workspace library and
                    auto-matches by schedule item / video title when possible. */}
                <div className="pt-4">
                  <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Voiceover
                    <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
                      (optional, auto-matched from your Voiceover library when we know which video this is)
                    </span>
                  </label>
                  <VoiceoverPicker
                    value={voiceoverUrl}
                    onChange={(url) => setVoiceoverUrl(url)}
                    scheduleItemId={scheduleItemId}
                    projectId={scheduleItem?.project_id ?? projectIdParam}
                    titleCandidates={[scheduleItem?.title, doc?.title, topic]}
                  />
                  {/* Voiceover-aligned scene timing pill. Sits directly
                      under the picker — same visual locus as the data
                      it talks about, so a lazy user sees both at once. */}
                  {voiceoverUrl && (
                    <AlignmentPill
                      status={alignmentStatus}
                      detail={alignmentDetail}
                      onRealign={() => { void runAlignment({ forceRefresh: true }); }}
                    />
                  )}
                </div>

                {/* Per-video visual brand kit override (channel kit ← override ← bar below). */}
                <VisualBrandKitOverridePanel
                  channelId={activeChannelId}
                  channelKit={channelVisualKit}
                  override={visualKitOverride}
                  onChange={setVisualKitOverride}
                />

                {/* Brand kit quick-config (legacy local tweak, sits on top of channel + override). */}
                <VideoPreviewBrandBar
                  onBrandChange={(brand) => setBrandKit(b => ({ ...b, ...brand }))}
                />

                {/* The actual player */}
                <VideoPlayerMemo
                  doc={doc}
                  rowImages={rowImages}
                  voiceoverUrl={voiceoverUrl}
                  brandKit={effectiveBrandKit}
                  onRender={startVideoRender}
                  isRendering={renderStatus === 'rendering'}
                  renderProgress={renderProgress}
                  outputUrl={renderOutputUrl || undefined}
                />

                {/* Dev-only: send to local Video Studio for advanced editing */}
                {process.env.NODE_ENV !== 'production' && (
                  <button
                    onClick={() => {
                      const config = productionDocToVideoConfig(doc, rowImages, voiceoverUrl || undefined, undefined, effectiveBrandKit);
                      sessionStorage.setItem('video-studio:bridge', JSON.stringify({
                        config,
                        brief: `Production doc: ${doc.title} (niche: ${doc.niche})`,
                      }));
                      window.location.href = '/video-studio';
                    }}
                    className="w-full text-xs px-3 py-2 rounded border border-purple-500/40 hover:bg-purple-500/10 transition-colors"
                    style={{ color: 'var(--accent-purple-bright)' }}
                  >
                    → Send to Video Studio (local editor)
                  </button>
                )}

                {renderStatus === 'error' && (
                  <p className="text-xs" style={{ color: '#f87171' }}>
                    Render failed. Check server logs for details — the toast above carries the reason.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Bottom export */}
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <button onClick={() => exportToCsv(doc, rowImages)} className="btn-primary text-sm px-6">
              ⬇ Export CSV
            </button>
            <button
              onClick={exportToSheets}
              disabled={sheetsExporting}
              className="btn-secondary text-sm px-6 flex items-center gap-1.5"
              title="Export to Google Sheets"
            >
              {sheetsExporting ? (
                <><div className="spinner" style={{ width: 12, height: 12 }} /> Exporting…</>
              ) : 'Export to Sheets'}
            </button>
          </div>
        </div>
        );
      })()}

      <HistoryPanel
        title="Production Doc History"
        icon="🎬"
        items={historyItems.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: e.videoTitle || e.title,
          sublabel: `${e.niche} · ${e.shotCount} shots · ${e.totalDuration} · ${e.stylePreset}`,
        }))}
        onRestore={(id) => {
          const entry = historyItems.find(e => e.id === id);
          if (!entry) return;
          if (doc && typeof window !== 'undefined' &&
              !confirm('Replace the current production doc with this restored entry?')) {
            return;
          }
          setNiche(entry.niche);
          setTopic(entry.topic);
          if (entry.modelId) setModelId(entry.modelId);
          if (entry.stylePreset) setStylePreset(entry.stylePreset);
          if (entry.script) setScript(entry.script);
          if (entry.doc) {
            const restoredDoc = entry.doc as ProductionDoc;
            setDoc(restoredDoc);
            // Rebuild rowImages from the saved map
            if (entry.rowImages && restoredDoc.rows?.length) {
              const restoredImages: RowImageState[] = restoredDoc.rows.map((_row, i) => {
                const url = entry.rowImages?.[i];
                return url ? { status: 'done', imageUrl: url } : { status: 'idle' };
              });
              setRowImages(restoredImages);
            } else {
              setRowImages([]);
            }
            setHistoryEntryId(entry.id);
            // Restore the per-video visual brand kit override if the
            // entry carried one. parseVisualBrandKit drops anything
            // unexpected, so a corrupt payload silently falls back to
            // an empty override.
            setVisualKitOverride(parseVisualBrandKit(entry.visualBrandKitOverride));
            toast.success(`Restored — ${entry.shotCount} shots, ${entry.totalDuration}`);
          } else {
            setDoc(null);
            setRowImages([]);
            setHistoryEntryId(null);
            setVisualKitOverride({ v: 1 });
            toast.info('Older entry — only metadata was saved. Re-generate to produce the doc.');
          }
        }}
        onDelete={(id) => {
          setHistoryItems((prev) => prev.filter((e) => e.id !== id));
          deleteProductionDocEntry(id).catch(() => {});
        }}
        onClearAll={() => {
          setHistoryItems([]);
          clearProductionDocHistory().catch(() => {});
        }}
      />

      {styleManagerOpen && (
        <StyleManagerDialog
          styles={availableStyles}
          onChanged={() => { void loadStyles(); }}
          onClose={() => setStyleManagerOpen(false)}
        />
      )}
    </div>
    </ScheduleLinkProvider>
  );
}
