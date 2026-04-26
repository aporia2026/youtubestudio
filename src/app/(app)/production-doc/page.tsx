'use client';

import React, { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, writeBackToSchedule, loadFullContextForItem, buildContextNotesFromItem } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import {
  saveProductionDocEntry,
  getProductionDocHistory,
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
import { productionDocToVideoConfig } from '@/remotion/utils';
import type { BrandKit } from '@/remotion/types';

// Dynamically import VideoPlayer — Remotion uses browser-only APIs (WebGL, Canvas)
const VideoPlayer = dynamic(
  () => import('@/components/video/VideoPlayer').then(m => m.VideoPlayer),
  { ssr: false, loading: () => <VideoPlayerSkeleton /> },
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  // Screenshot
  dataUrl?: string;
  mediaType?: string;
  name?: string;
  // Shared
  analyzedStyle?: string;
  analyzing?: boolean;
  analysisFailed?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STYLE_PRESETS = [
  { id: 'cinematic',    label: 'Cinematic' },
  { id: 'animation_2d', label: '2D Animation' },
  { id: 'animation_3d', label: '3D Animation' },
  { id: 'documentary', label: 'Documentary' },
  { id: 'stock',       label: 'Stock Photo' },
  { id: 'tech',        label: 'Tech / SaaS' },
  { id: 'viral',       label: 'Viral / Trendy' },
  { id: 'whiteboard',  label: 'Whiteboard' },
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
  const headers = [
    'Timecode', 'Script Text', 'Visual Type', 'Visual Description',
    'Stock Search Terms', 'AI Image Prompt', 'Image URL', 'Stock Search URL',
    'On-Screen Text', 'Notes',
  ];
  const rows = doc.rows.map((r, i) => [
    r.timecode,
    r.script_text,
    r.visual_type,
    r.visual_description,
    r.stock_search_terms,
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

function ImageCell({ state, onRetry }: { state: RowImageState; onRetry: () => void }) {
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
      <a href={state.imageUrl} target="_blank" rel="noopener noreferrer" title="Open full image">
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
      </a>
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
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);

  // — Inputs
  const [script, setScript] = useState('');
  const [niche, setNiche] = useState('');
  const [topic, setTopic] = useState('');
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('production-doc'));

  function handleModelChange(id: string) {
    setModelId(id);
    // Persist as the default for Production Doc (readable in Settings → Model Defaults)
    try {
      const saved = JSON.parse(localStorage.getItem('feature_model_defaults') || '{}');
      saved['production-doc'] = id;
      localStorage.setItem('feature_model_defaults', JSON.stringify(saved));
    } catch { /* ignore storage errors */ }
  }
  const [speakingPace, setSpeakingPace] = useState(135);
  const [actualDuration, setActualDuration] = useState(''); // "mm:ss" of actual voiceover recording
  const [stylePreset, setStylePreset] = useState('cinematic');
  const [creativeBrief, setCreativeBrief] = useState('');
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
  const [historyItems, setHistoryItems] = useState<ProductionDocHistoryEntry[]>(() => getProductionDocHistory());
  // Track which history entry the current on-screen doc belongs to, so row-image
  // generations (fire-and-forget after the doc is saved) can patch back onto the
  // same entry instead of being lost.
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // — Image generation (declared before effects that reference it)
  const [rowImages, setRowImages] = useState<RowImageState[]>([]);
  const [imageProgress, setImageProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
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
      const ctx = await loadFullContextForItem(item);
      if (cancelled) return;
      setTopic(curr => curr || ctx.topic);
      setNiche(curr => curr || ctx.niche);
      if (ctx.script) setScript(prev => prev || ctx.script!);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleItemId, schedulePrefilled]);

  // Restore last result from localStorage after mount (useEffect so SSR is unaffected).
  // Skip restore on a handoff (schedule-link, generator, QA) so the new script
  // starts a fresh session — and discard the saved draft so it doesn't resurface.
  useEffect(() => {
    const fromHandoff = !!scheduleItemId
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
        updateProductionDocEntry(historyEntryId, { rowImages: imgMap });
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
  // Brand kit loaded client-side only to avoid SSR hydration mismatch
  const [brandKit, setBrandKit] = useState<Partial<BrandKit>>(DEFAULT_BRAND);
  const [renderId, setRenderId] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle');
  const [renderOutputUrl, setRenderOutputUrl] = useState<string | null>(null);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load brand kit + voiceover URL from localStorage on client only
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('video_brand_kit') || '{}') as Partial<BrandKit>;
      if (stored.primaryColor) setBrandKit(b => ({ ...b, ...stored }));
    } catch { /* ignore */ }
    try {
      const history = JSON.parse(localStorage.getItem('voiceover_history') || '[]') as Array<{ audioUrl?: string }>;
      if (Array.isArray(history) && history.length > 0 && history[0]?.audioUrl) {
        setVoiceoverUrl(history[0].audioUrl);
      }
    } catch { /* ignore */ }
  }, []);

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

  async function analyzeScreenshot(ref: VisualRef, idx: number) {
    if (!ref.dataUrl || !ref.mediaType) return;
    const base64 = ref.dataUrl.split(',')[1];
    if (!base64) return; // malformed data URL
    setVisualRefs(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], analyzing: true };
      return next;
    });
    try {
      const res = await fetch('/api/analyze/image-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mediaType: ref.mediaType }),
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
        const newRef: VisualRef = {
          type: 'screenshot',
          dataUrl,
          mediaType: file.type,
          name: file.name,
        };
        const newIdx = visualRefs.length;
        setVisualRefs(prev => [...prev, newRef]);
        // Analyze outside the state updater
        analyzeScreenshot(newRef, newIdx);
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
        body: JSON.stringify({ prompt }),
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
    setGenerationLog(prev => [...prev, `${ts}  ${msg}`]);
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

      for (let ci = 0; ci < chunks.length; ci++) {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (isMultiChunk) appendLog(`Generating chunk ${ci + 1} of ${chunks.length}...`);

        const res = await fetch('/api/generate/production-doc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            modelId, niche, topic,
            script: chunks[ci],
            speakingPaceWpm: effectiveWpm,
            stylePreset,
            creativeBrief: fullBrief || undefined,
            startTimecodeSeconds: timecodeOffsetSeconds,
            isChunk: isMultiChunk && ci > 0,
          }),
        });

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
      const savedEntry = saveProductionDocEntry({
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
      });
      setHistoryEntryId(savedEntry.id);
      setHistoryItems(getProductionDocHistory());
      appendLog(`✓ ${result.rows.length} shots generated`);
      toast.success(`Production doc ready — ${result.rows.length} shots`);

      // Write back to the linked schedule item so the schedule surfaces that a
      // production doc exists (history is localStorage-scoped; the history
      // entry ID here lets the card round-trip back to this doc).
      if (scheduleItemId) {
        writeBackToSchedule(scheduleItemId, {}, {
          customFieldsMerge: {
            latest_production_doc: {
              history_entry_id: savedEntry.id,
              shot_count: result.rows.length,
              total_duration: result.total_duration,
              style_preset: stylePreset,
              generated_at: new Date().toISOString(),
              model_id: modelId,
            },
          },
        });
      }
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

  // ── Video render ─────────────────────────────────────────────────────────────

  async function startVideoRender() {
    if (!doc) return;
    const config = productionDocToVideoConfig(doc, rowImages, voiceoverUrl || undefined);
    setRenderStatus('rendering');
    setRenderProgress(0);
    setRenderOutputUrl(null);

    try {
      const res = await fetch('/api/render/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
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
            <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              Visual Style
            </label>
            <div className="flex flex-wrap gap-2">
              {STYLE_PRESETS.map(p => (
                <button
                  key={p.id}
                  onClick={() => setStylePreset(p.id)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: stylePreset === p.id ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.05)',
                    color: stylePreset === p.id ? '#a78bfa' : 'var(--text-secondary)',
                    border: stylePreset === p.id ? '1px solid rgba(124,58,237,0.4)' : '1px solid var(--border)',
                  }}
                >
                  {p.label}
                </button>
              ))}
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
                    ) : ref.type === 'screenshot' && ref.dataUrl ? (
                      <div style={{ position: 'relative' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={ref.dataUrl}
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
                      onClick={() => setVisualRefs(prev => prev.filter((_, i) => i !== idx))}
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

        {/* Model + Generate */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <ModelSelector value={modelId} onChange={handleModelChange} label="" />
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
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {imageProgress.done} / {imageProgress.total}
            </span>
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
      {doc && (
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
          <div className="flex flex-wrap gap-2 mb-4">
            {Object.entries(VISUAL_TYPE_COLORS).map(([type, { bg, color }]) => (
              <span key={type} className="text-xs px-2 py-0.5 rounded-full" style={{ background: bg, color }}>
                {type}
              </span>
            ))}
          </div>

          {/* ── Desktop table */}
          <div className="glass rounded-xl overflow-hidden">
            <div className="overflow-x-auto hidden md:block">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
                    {['#', 'Time', 'Script Text', 'Visual Type', 'Visual Description', 'Stock Terms', 'Image', 'AI Prompt', 'On-Screen Text', 'Notes'].map(h => (
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
                {/* Voiceover URL input */}
                <div className="pt-4">
                  <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Voiceover URL
                    <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
                      (optional — auto-filled from your latest Voiceover Studio generation)
                    </span>
                  </label>
                  <input
                    type="url"
                    value={voiceoverUrl}
                    onChange={e => setVoiceoverUrl(e.target.value)}
                    placeholder="https://...vercel-storage.com/voiceover/..."
                    className="input-field text-xs"
                  />
                </div>

                {/* Brand kit quick-config */}
                <VideoPreviewBrandBar
                  onBrandChange={(brand) => setBrandKit(b => ({ ...b, ...brand }))}
                />

                {/* The actual player */}
                <VideoPlayerMemo
                  doc={doc}
                  rowImages={rowImages}
                  voiceoverUrl={voiceoverUrl}
                  brandKit={brandKit}
                  onRender={startVideoRender}
                  isRendering={renderStatus === 'rendering'}
                  renderProgress={renderProgress}
                  outputUrl={renderOutputUrl || undefined}
                />

                {/* Dev-only: send to local Video Studio for advanced editing */}
                {process.env.NODE_ENV !== 'production' && (
                  <button
                    onClick={() => {
                      const config = productionDocToVideoConfig(doc, rowImages, voiceoverUrl || undefined, undefined, brandKit);
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
                    Render failed. Check server logs. Make sure BLOB_READ_WRITE_TOKEN is configured.
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
      )}

      <HistoryPanel
        title="Production Doc History"
        icon="🎬"
        items={historyItems.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: e.title,
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
            toast.success(`Restored — ${entry.shotCount} shots, ${entry.totalDuration}`);
          } else {
            setDoc(null);
            setRowImages([]);
            setHistoryEntryId(null);
            toast.info('Older entry — only metadata was saved. Re-generate to produce the doc.');
          }
        }}
        onDelete={(id) => { deleteProductionDocEntry(id); setHistoryItems(getProductionDocHistory()); }}
        onClearAll={() => { clearProductionDocHistory(); setHistoryItems([]); }}
      />
    </div>
  );
}
