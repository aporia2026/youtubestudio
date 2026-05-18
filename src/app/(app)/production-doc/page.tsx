'use client';

import React, { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { EDITOR_V1_PUBLIC } from '@/lib/feature-flags';
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
import {
  BrollCell,
  kickoffBrollGeneration,
  readBrollLockMap,
  writeBrollLockMap,
  readBrollLsMap,
  writeBrollLsMap,
} from '@/components/production-doc/BrollCell';
import { SectionThumbnailCard } from '@/components/production-doc/SectionThumbnailCard';
import { OverlayCell } from '@/components/production-doc/OverlayCell';
import { OverlayPositionEditor } from '@/components/production-doc/OverlayPositionEditor';
import { OverlayEditDialog } from '@/components/production-doc/OverlayEditDialog';
import { OverlayContextMenu } from '@/components/production-doc/OverlayContextMenu';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';
import { SectionRowControls } from '@/components/production-doc/SectionRowControls';
import { MissingClipsModal } from '@/components/production-doc/MissingClipsModal';
import { MaskBrushEditor } from '@/components/production-doc/MaskBrushEditor';
import {
  brollRowSignatureInput,
  DEFAULT_BROLL_MODEL_ID,
  findBrollModel,
  pickModelForScene,
  type BrollClipRow,
  type BrollStatus,
} from '@/lib/broll-types';
import {
  productionDocToVideoConfig,
  parseTimecodeToMs,
  DEFAULT_MIN_SCENE_MS,
  DEFAULT_TAIL_BUFFER_MS,
  MIN_SCENE_MS_BOUNDS,
  TAIL_BUFFER_MS_BOUNDS,
  clampSceneTiming,
  type ImageSaliencyMap,
} from '@/remotion/utils';
import { resolveOverlayPlacement } from '@/lib/overlay-placement';
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
  /** Frame region the overlay lands in. Planned by the doc generator so
   *  the `ai_image_prompt` can reserve matching negative space, then used
   *  at render time to position the fetched overlay PNG. */
  overlay_zone?:
    | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    | 'center-top' | 'center-bottom' | 'left-center' | 'right-center';
  /** Overlay scale relative to the frame width. Planned alongside
   *  `overlay_zone`. small ≈ 12%, medium ≈ 18%, large ≈ 25%. */
  overlay_size?: 'small' | 'medium' | 'large';
  /** Fetched + background-removed overlay PNG, mirrored to R2. Populated
   *  asynchronously by `/api/overlay/fetch` after the row's still is
   *  generated. Falsy means "no overlay rendered" — the still alone is
   *  used. */
  overlay_image_url?: string;
  /** Final overlay placement after saliency-aware resolution. Set by the
   *  image-gen route once `image_saliency` is computed; preferred over
   *  `overlay_zone` / `overlay_size` everywhere downstream. See plan
   *  _plans/2026-05-17-section-title-letterbox-and-overlay-blending.md. */
  overlay_zone_resolved?: ProductionRow['overlay_zone'];
  overlay_size_resolved?: ProductionRow['overlay_size'];
  on_screen_text: string;
  notes: string;
  /** Region id (from ProductionDoc.thumbnail.regions) this row's scene
   *  zooms into. When set, the row's scene becomes a thumbnail-zoom. */
  thumbnail_zoom_to?: string;
  /** Section title shown as a fixed stripe at top of frame for the row's
   *  full duration. Independent of `on_screen_text`. */
  section_title?: string;
  /** Per-row stripe ↔ scene layout (only when `section_title` is set).
   *  Undefined treated as 'letterbox' downstream. */
  section_title_layout?: 'overlay' | 'letterbox';
  /** Per-row pillarbox fill color when layout = letterbox. Hex `#RRGGBB`.
   *  Falls back to doc-level default, then white. */
  pillarbox_color?: string;
  /** Per-row static-zoom percentage applied to the rendered image / video.
   *  100 = unchanged. <100 zooms out (image appears smaller, pillarbox /
   *  scene-bg fills the surrounding area). >100 zooms in (image crops to
   *  the centered window). Animation (Ken Burns, B-roll clip motion) is
   *  unaffected — the zoom multiplies on top of the animated transform.
   *  Falls back to `ProductionDoc.scene_zoom_default`, then 100. */
  scene_zoom?: number;
  /** Manual overlay placement set via drag-and-drop. When present, the
   *  renderer ignores `overlay_zone` / `overlay_zone_resolved` and pins
   *  the overlay's top-left corner at `(x_pct, y_pct)`% of the frame
   *  (origin top-left). Cleared via the editor's "Reset" button so the
   *  AI placement kicks back in. */
  overlay_position?: { x_pct: number; y_pct: number };
  /** Manual overlay width as % of the frame width (typical range 5–40).
   *  When set, overrides `overlay_size` / `overlay_size_resolved` at
   *  render time. Cleared together with `overlay_position` on reset. */
  overlay_size_pct?: number;
  /** Manual overlay height as % of frame height — set only by Shift+drag
   *  on a resize handle (free aspect). Absent means height follows the
   *  image's natural aspect. Phase 1 of the overlay-system overhaul. */
  overlay_stretched_height_pct?: number;
  /** One-sentence AI rationale for this overlay's auto-picked placement.
   *  Surfaced as a tooltip in the position editor. Written by
   *  `/api/overlay/fetch` when smart placement ran at fetch time.
   *  Phase 2 of the overlay-system overhaul. */
  overlay_placement_reason?: string;
  /** Model id that produced the placement decision (e.g.
   *  `kie-gemini-3.1-pro`); `'doc-gen-blind'` for rows whose
   *  zone/size came from the text-only doc-gen LLM. */
  overlay_placement_model?: string;
  /** Phase 4 — `true` when the RMBG cutout was uploaded to R2,
   *  `false` when the heuristic gate / vision tiebreaker decided the
   *  original was cleaner and we re-encoded it as PNG instead. */
  overlay_rmbg_kept?: boolean;
  /** Phase 5 — stack of prior overlay URLs after AI edits. Most-recent
   *  last; cap 3. Undo pops the tail back into the live overlay slot. */
  overlay_edit_history?: string[];
  /** Cached pixel-saliency map for this row's generated image. Populated
   *  by `/api/generate/production-doc/image` after the image lands in R2. */
  image_saliency?: ImageSaliencyMap;
  /** Per-row transition override. Falls back to doc-level default. */
  thumbnail_transition?: ThumbnailTransitionConfig;
  /** Per-row scene-to-scene cross-fade override. `undefined` inherits the
   *  doc-level `scene_fade_enabled`; `true` forces a fade; `false` forces
   *  a hard cut. See `_plans/2026-05-17-scene-transition-controls.md`. */
  scene_fade?: boolean;
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
  /** Doc-level fallback for `ProductionRow.pillarbox_color` when a row
   *  doesn't override. Hex `#RRGGBB`; defaults to white. */
  pillarbox_color_default?: string;
  /** Doc-level fallback for `ProductionRow.section_title_layout` when a
   *  row doesn't override. Mirrors the `pillarbox_color_default` pattern.
   *  Undefined ⇒ renderer treats it as 'letterbox'. */
  section_title_layout_default?: 'overlay' | 'letterbox';
  /** Doc-level fallback for `ProductionRow.scene_zoom` when a row doesn't
   *  override. Mirrors the `pillarbox_color_default` pattern. Undefined ⇒
   *  100 (no zoom). Sensible range: 50–200. */
  scene_zoom_default?: number;
  /** Per-doc override of the workspace's minimum scene duration (ms).
   *  Forwarded into `productionDocToVideoConfig`. Editable inline in the
   *  doc header. See `_plans/2026-05-17-scene-min-duration-and-tail-buffer.md`. */
  min_scene_ms?: number;
  /** Per-doc override of the workspace's tail buffer after narration (ms). */
  tail_buffer_ms?: number;
  /** Doc-level default for the scene-to-scene cross fade. `undefined`
   *  preserves the historical behaviour (faded). `false` makes every
   *  shot hard-cut, including removing the opening fade-in and closing
   *  fade-out. Per-row `scene_fade` overrides per-row. */
  scene_fade_enabled?: boolean;
}

interface RowImageState {
  status: 'idle' | 'pending' | 'loading' | 'uploading' | 'editing' | 'done' | 'error' | 'search';
  imageUrl?: string;
  searchUrl?: string;
  error?: string;
  /** Where the image came from. Drives small UI cues (📷 badge for
   *  uploads, ✎ badge for edits) and gates the "↻ regenerate with the
   *  original prompt" button — uploads have no prompt to regenerate
   *  with, so ↻ is hidden for those rows and the edit pencil ✎ stays. */
  source?: 'generated' | 'upload' | 'url' | 'edit';
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
  rowVideoClips,
  rowOverlays,
  rowLockedAsStill,
  animateScenes,
  suppressLowerThirds,
  voiceoverUrl,
  voiceoverAlignment,
  brandKit,
  onRender,
  isRendering,
  renderProgress,
  downloadUrl,
}: {
  doc: ProductionDoc;
  rowImages: RowImageState[];
  rowVideoClips: Record<number, { status: string; videoUrl?: string } | null>;
  rowOverlays: Record<number, RowOverlayState>;
  rowLockedAsStill: boolean[];
  animateScenes: boolean;
  suppressLowerThirds: boolean;
  voiceoverUrl: string;
  /** Word-level alignment payload. When present, scene timing snaps to
   *  the narration's actual word boundaries — without it the preview
   *  uses estimated WPM timecodes that drift against the audio. The
   *  render route gets this server-side; the preview needs it client-
   *  side. See `_plans/2026-05-17-render-state-hardening.md`. */
  voiceoverAlignment?: import('@/lib/elevenlabs').ForcedAlignmentResponse | null;
  brandKit: Partial<BrandKit>;
  onRender: () => void;
  isRendering: boolean;
  renderProgress: number;
  downloadUrl?: string | null;
}) {
  const config = React.useMemo(() => {
    // Flatten the sparse `rowVideoClips` map into a positional array
    // aligned with `doc.rows[i]`. Rows without an entry get null and
    // fall back to the still-with-Ken-Burns path inside the converter.
    const rowClipsArr = doc.rows.map((_, i) => rowVideoClips[i] ?? null);
    return productionDocToVideoConfig(doc, rowImages, {
      voiceoverUrl: voiceoverUrl || undefined,
      brand: brandKit,
      rowVideoClips: rowClipsArr,
      rowLockedAsStill,
      animateScenes,
      rowOverlays,
      suppressLowerThirds,
      alignment: voiceoverAlignment ?? undefined,
    });
  }, [doc, rowImages, rowVideoClips, rowOverlays, rowLockedAsStill, animateScenes, suppressLowerThirds, voiceoverUrl, voiceoverAlignment, brandKit]);
  return (
    <VideoPlayer
      config={config}
      onRender={onRender}
      isRendering={isRendering}
      renderProgress={renderProgress}
      downloadUrl={downloadUrl}
    />
  );
});

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Per-doc scene-timing override control. Two numeric inputs (min scene
 * duration, tail buffer after narration) with a Reset link when the
 * user has overridden either. Empty input means "use the default".
 * Values are clamped to bounds before commit by the caller's
 * `setSceneTiming` mutator. See the scene-min-duration plan.
 */
function SceneTimingControl({
  minSceneMs,
  tailBufferMs,
  onChange,
}: {
  minSceneMs: number | undefined;
  tailBufferMs: number | undefined;
  onChange: (patch: { min_scene_ms?: number | null; tail_buffer_ms?: number | null }) => void;
}) {
  // Local draft strings so the user can type freely (including clearing
  // the field) without the parent immediately clamping a partial value.
  // We commit on blur or Enter.
  const [minDraft, setMinDraft] = useState<string>(minSceneMs != null ? String(minSceneMs) : '');
  const [tailDraft, setTailDraft] = useState<string>(tailBufferMs != null ? String(tailBufferMs) : '');
  // Sync drafts when the doc-level values change from outside (e.g.
  // history load, server patch). Avoids stale local input after navigation.
  useEffect(() => { setMinDraft(minSceneMs != null ? String(minSceneMs) : ''); }, [minSceneMs]);
  useEffect(() => { setTailDraft(tailBufferMs != null ? String(tailBufferMs) : ''); }, [tailBufferMs]);

  const hasOverride = minSceneMs != null || tailBufferMs != null;

  const commitMin = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange({ min_scene_ms: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    onChange({ min_scene_ms: n });
  };
  const commitTail = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange({ tail_buffer_ms: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    onChange({ tail_buffer_ms: n });
  };

  const inputStyle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.4)',
    border: '1px solid rgba(255,255,255,0.10)',
    color: 'var(--text-primary)',
    textAlign: 'right',
    width: 72,
    padding: '2px 6px',
    borderRadius: 4,
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div
      className="flex flex-wrap items-center gap-3 mb-4 px-3 py-2 rounded text-xs"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        color: 'var(--text-muted)',
      }}
    >
      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>⏱ Scene timing</span>
      <label className="flex items-center gap-1.5" title="Minimum on-screen time for every scene. Stops too-short title cards.">
        <span>Min scene</span>
        <input
          type="number"
          min={MIN_SCENE_MS_BOUNDS.min}
          max={MIN_SCENE_MS_BOUNDS.max}
          step={100}
          placeholder={String(DEFAULT_MIN_SCENE_MS)}
          value={minDraft}
          onChange={(e) => setMinDraft(e.target.value)}
          onBlur={(e) => commitMin(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={inputStyle}
        />
        <span>ms</span>
      </label>
      <span style={{ opacity: 0.4 }}>·</span>
      <label className="flex items-center gap-1.5" title="Extra hold time after the narrator finishes a row. Capped at the gap to the next narration so audio stays in sync.">
        <span>Tail buffer</span>
        <input
          type="number"
          min={TAIL_BUFFER_MS_BOUNDS.min}
          max={TAIL_BUFFER_MS_BOUNDS.max}
          step={50}
          placeholder={String(DEFAULT_TAIL_BUFFER_MS)}
          value={tailDraft}
          onChange={(e) => setTailDraft(e.target.value)}
          onBlur={(e) => commitTail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={inputStyle}
        />
        <span>ms</span>
      </label>
      {hasOverride && (
        <button
          onClick={() => onChange({ min_scene_ms: null, tail_buffer_ms: null })}
          className="text-xs underline"
          style={{ color: 'var(--text-muted)' }}
          title="Clear the per-doc override and fall back to the workspace default"
        >
          Reset
        </button>
      )}
      <span className="ml-auto" style={{ opacity: 0.7, maxWidth: 420 }}>
        Defaults: {DEFAULT_MIN_SCENE_MS} ms min, {DEFAULT_TAIL_BUFFER_MS} ms tail. Affects this doc only.
      </span>
    </div>
  );
}

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

/**
 * Smart-edit panel for the production-doc image cell.
 *
 * Two phases:
 *   1. Compose — original image preview + prompt textarea + Apply.
 *      "Paint a region instead…" link opens the brush mask editor
 *      (passed in as `onOpenBrush`); when not provided, the link
 *      stays hidden.
 *   2. Review — before/after side-by-side + Use this / Try another /
 *      Discard. The new image is never persisted to the row until the
 *      user clicks "Use this".
 *
 * The panel survives one apply cycle. Users can iterate prompts in
 * Compose mode and the original stays on the row until they accept a
 * candidate.
 */
function EditPanel({
  sourceImageUrl,
  initialResult,
  onApply,
  onUseThis,
  onOpenBrush,
  onClose,
}: {
  sourceImageUrl: string;
  /** When provided, the panel opens directly in review mode showing
   *  before/after. Used by the brush flow: the brush modal produces
   *  the result, then hands the panel off to render the review UI
   *  with a consistent "Use this / Discard" experience. */
  initialResult?: { imageUrl: string; saliency: ImageSaliencyMap | null } | null;
  onApply: (prompt: string) => Promise<EditResult>;
  onUseThis: (imageUrl: string, saliency: ImageSaliencyMap | null) => void;
  /** Open the mask brush modal. Optional; when absent the in-panel
   *  brush link stays hidden. */
  onOpenBrush?: () => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<{ imageUrl: string; saliency: ImageSaliencyMap | null } | null>(
    initialResult ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function apply() {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setError(null);
    const r = await onApply(prompt.trim());
    setIsGenerating(false);
    if (r.ok) {
      setResult({ imageUrl: r.imageUrl, saliency: r.saliency });
    } else {
      setError(r.error);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated, #181818)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 20,
          width: 'min(960px, 96vw)',
          maxHeight: '92vh',
          overflowY: 'auto',
          color: 'var(--text-primary)',
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">Edit image</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        {!result ? (
          <>
            <div
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'flex-start',
                flexWrap: 'wrap',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sourceImageUrl}
                alt="Original"
                style={{
                  width: 320,
                  maxWidth: '100%',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  display: 'block',
                  background: '#000',
                }}
              />
              <div style={{ flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  What should change?
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. change the t-shirt to red, make the sky stormy, add a sunset glow"
                  rows={5}
                  disabled={isGenerating}
                  style={{
                    background: 'var(--bg-card, #111)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: 8,
                    fontSize: 13,
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                  maxLength={2000}
                />
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Smart edit uses Nano Banana 2 — the model locates the region from your
                  prompt. No mask needed. Roughly $0.02 per attempt.
                </div>
                {onOpenBrush && (
                  <button
                    type="button"
                    onClick={onOpenBrush}
                    disabled={isGenerating}
                    className="text-xs"
                    style={{
                      background: 'transparent',
                      color: 'var(--text-secondary)',
                      border: 'none',
                      cursor: isGenerating ? 'not-allowed' : 'pointer',
                      textDecoration: 'underline',
                      padding: 0,
                      textAlign: 'left',
                    }}
                  >
                    Paint a region instead…
                  </button>
                )}
                {error && (
                  <div className="text-xs" style={{ color: '#f87171' }} role="alert">
                    {error}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <button
                    type="button"
                    onClick={apply}
                    disabled={!prompt.trim() || isGenerating}
                    className="text-xs px-3 py-1.5 rounded"
                    style={{
                      background: !prompt.trim() || isGenerating
                        ? 'rgba(120,120,120,0.18)'
                        : 'rgba(168,85,247,0.20)',
                      color: !prompt.trim() || isGenerating ? 'var(--text-muted)' : '#c084fc',
                      border: '1px solid rgba(168,85,247,0.35)',
                      cursor: !prompt.trim() || isGenerating ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {isGenerating ? 'Generating…' : 'Apply (smart edit · ~$0.02)'}
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={isGenerating}
                    className="text-xs px-3 py-1.5 rounded"
                    style={{
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      cursor: isGenerating ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
                  Before
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sourceImageUrl}
                  alt="Before"
                  style={{
                    width: '100%',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    display: 'block',
                    background: '#000',
                  }}
                />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: '#c084fc' }}>
                  After
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={result.imageUrl}
                  alt="After"
                  style={{
                    width: '100%',
                    borderRadius: 6,
                    border: '1px solid rgba(168,85,247,0.45)',
                    display: 'block',
                    background: '#000',
                  }}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  onUseThis(result.imageUrl, result.saliency);
                  onClose();
                }}
                className="text-xs px-3 py-1.5 rounded"
                style={{
                  background: 'rgba(34,197,94,0.18)',
                  color: '#86efac',
                  border: '1px solid rgba(34,197,94,0.40)',
                  cursor: 'pointer',
                }}
              >
                ✓ Use this
              </button>
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setError(null);
                }}
                className="text-xs px-3 py-1.5 rounded"
                style={{
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                Try another prompt
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded"
                style={{
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                Discard
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Result shape returned by edit operations. Defined at module scope so
 *  EditPanel + future MaskBrushEditor share a single type. */
type EditResult =
  | { ok: true; imageUrl: string; saliency: ImageSaliencyMap | null }
  | { ok: false; error: string };

function ImageCell({
  state,
  onRetry,
  onUpload,
  onUrlImport,
  onEdit,
  canGenerate = true,
}: {
  state: RowImageState;
  onRetry: () => void;
  /** Attach a locally-selected file to the row. Wired to the ⬆ button in
   *  the idle column-of-three layout. */
  onUpload?: (file: File) => void;
  /** Mirror an external HTTPS image URL into our R2 bucket and attach. */
  onUrlImport?: (url: string) => void;
  /** Open the smart edit panel (Tier 1 prompt edit + Tier 2 brush mask).
   *  Available on rows with a ready image. */
  onEdit?: () => void;
  /** False when the row has no AI prompt to generate from — disables the
   *  idle-state Generate button. Defaults to true so unmodified callers
   *  keep their old behaviour (an enabled button). */
  canGenerate?: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [urlInputValue, setUrlInputValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Idle state used to render nothing — leaving the cell visually empty
  // with no way to trigger generation. After sanitizing stale 'loading'
  // statuses on restore (fix from b4366fa), every row that was mid-gen
  // when the page refreshed comes back as 'idle', so this state went
  // from "uncommon" to "common after refresh". Render three actions
  // (Generate / Upload / URL) so the user has obvious next steps even
  // when the row has no AI prompt.
  if (state.status === 'idle') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={onRetry}
            disabled={!canGenerate}
            title={canGenerate ? 'Generate this image with the current prompt' : 'Add an AI prompt to this row first'}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
            style={{
              background: canGenerate ? 'rgba(168,85,247,0.12)' : 'transparent',
              color: canGenerate ? '#c084fc' : 'var(--text-muted)',
              border: `1px solid ${canGenerate ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.10)'}`,
              cursor: canGenerate ? 'pointer' : 'not-allowed',
            }}
          >
            ＋ Generate
          </button>
          {onUpload && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Upload an image from your computer"
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
                style={{
                  background: 'rgba(59,130,246,0.10)',
                  color: '#60a5fa',
                  border: '1px solid rgba(59,130,246,0.30)',
                  cursor: 'pointer',
                }}
              >
                ⬆ Upload
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(f);
                  e.target.value = '';
                }}
              />
            </>
          )}
          {onUrlImport && (
            <button
              type="button"
              onClick={() => setUrlInputOpen((v) => !v)}
              title="Import an image from an external HTTPS URL"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
              style={{
                background: 'rgba(120,120,120,0.10)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(255,255,255,0.10)',
                cursor: 'pointer',
              }}
            >
              🔗 URL
            </button>
          )}
        </div>
        {urlInputOpen && onUrlImport && (
          <div className="flex items-center gap-1">
            <input
              type="url"
              value={urlInputValue}
              placeholder="https://…"
              onChange={(e) => setUrlInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && urlInputValue.trim()) {
                  onUrlImport(urlInputValue.trim());
                  setUrlInputValue('');
                  setUrlInputOpen(false);
                } else if (e.key === 'Escape') {
                  setUrlInputValue('');
                  setUrlInputOpen(false);
                }
              }}
              className="text-xs px-1.5 py-0.5 rounded flex-1"
              style={{
                background: 'var(--bg-elevated, #1a1a1a)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                minWidth: 140,
              }}
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                if (urlInputValue.trim()) {
                  onUrlImport(urlInputValue.trim());
                  setUrlInputValue('');
                  setUrlInputOpen(false);
                }
              }}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(59,130,246,0.18)', color: '#60a5fa' }}
            >
              Go
            </button>
          </div>
        )}
      </div>
    );
  }

  if (state.status === 'uploading') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="spinner" style={{ width: 14, height: 14 }} />
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>uploading</span>
      </div>
    );
  }

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
        <div style={{ position: 'relative', display: 'inline-block' }}>
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
          {/* Re-generate + Edit overlay buttons. ↻ re-rolls the row's
              prompt-based generation; only shown for rows whose image
              came from generation or a prior edit (an upload / URL
              import has no prompt to re-roll, so the button would 404
              into nothing useful). ✎ opens the smart edit panel and is
              always available — uploads are edits' primary use case. */}
          {canGenerate && state.source !== 'upload' && state.source !== 'url' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
              title="Re-generate this image with the current prompt"
              aria-label="Re-generate image"
              style={{
                position: 'absolute',
                top: 2,
                right: onEdit ? 22 : 2,
                width: 18,
                height: 18,
                padding: 0,
                borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'rgba(0,0,0,0.55)',
                color: '#e5e7eb',
                fontSize: 11,
                lineHeight: 1,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ↻
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              title="Edit with a prompt or paint a region to change"
              aria-label="Edit image"
              style={{
                position: 'absolute',
                top: 2,
                right: 2,
                width: 18,
                height: 18,
                padding: 0,
                borderRadius: 4,
                border: '1px solid rgba(168,85,247,0.45)',
                background: 'rgba(0,0,0,0.65)',
                color: '#c084fc',
                fontSize: 11,
                lineHeight: 1,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ✎
            </button>
          )}
          {state.source && state.source !== 'generated' && (
            <span
              title={
                state.source === 'upload' ? 'Uploaded image'
                : state.source === 'url' ? 'Imported from URL'
                : 'Edited image'
              }
              style={{
                position: 'absolute',
                bottom: 2,
                left: 2,
                fontSize: 9,
                lineHeight: 1,
                padding: '1px 3px',
                borderRadius: 3,
                background: 'rgba(0,0,0,0.65)',
                color: '#e5e7eb',
              }}
            >
              {state.source === 'upload' ? '📷' : state.source === 'url' ? '🔗' : '✎'}
            </span>
          )}
        </div>
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
  const [stylePreset, setStylePreset] = useState('doodle_explainer');
  // Server-stored "default style for new sessions" — fetched on mount,
  // applied when the user clicks "New session" (or on first-ever load
  // when no form-input cache exists), and updated when the user clicks
  // the ⭐ on a style chip. `null` until fetched; `''` after fetch if
  // the user hasn't set one (we still surface the library default in
  // the picker UI as the fallback).
  const [userDefaultStyle, setUserDefaultStyle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/user/settings/default-style', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { stylePreset?: string; isExplicit?: boolean };
        if (cancelled) return;
        setUserDefaultStyle(data.isExplicit ? (data.stylePreset ?? null) : '');
      } catch { /* leave at library default */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const setStyleAsDefault = useCallback(async (slug: string) => {
    setUserDefaultStyle(slug);
    try {
      await fetch('/api/user/settings/default-style', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stylePreset: slug }),
      });
      toast.success('Default style updated.');
    } catch {
      toast.error('Could not save default — try again.');
    }
  }, []);
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
   * Doc-level scene-fade default toggle. `undefined` preserves the
   * historical behaviour (faded); `false` makes every shot hard-cut.
   * Per-row `scene_fade` still overrides per-row. See
   * `_plans/2026-05-17-scene-transition-controls.md`.
   */
  const setSceneFadeEnabled = useCallback((next: boolean) => {
    setDoc(prev => {
      if (!prev) return prev;
      console.info('[ui scene-fade] doc default', {
        from: prev.scene_fade_enabled,
        to: next,
      });
      const nextDoc: ProductionDoc = { ...prev, scene_fade_enabled: next };
      if (historyEntryId) {
        updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
      }
      return nextDoc;
    });
  }, [historyEntryId]);

  /**
   * Scene-timing override mutator (per-doc). Sets `min_scene_ms` and
   * `tail_buffer_ms` on the doc; both are optional — `undefined` means
   * "fall back to the workspace default (or built-in default)". Values
   * are clamped to their bounds before write so a paste of "9999999"
   * can't bypass the protection. See the scene-min-duration plan.
   */
  const setSceneTiming = useCallback((patch: { min_scene_ms?: number | null; tail_buffer_ms?: number | null }) => {
    setDoc(prev => {
      if (!prev) return prev;
      const next: ProductionDoc = { ...prev };
      if ('min_scene_ms' in patch) {
        if (patch.min_scene_ms == null) {
          delete next.min_scene_ms;
        } else {
          next.min_scene_ms = clampSceneTiming(patch.min_scene_ms, MIN_SCENE_MS_BOUNDS);
        }
      }
      if ('tail_buffer_ms' in patch) {
        if (patch.tail_buffer_ms == null) {
          delete next.tail_buffer_ms;
        } else {
          next.tail_buffer_ms = clampSceneTiming(patch.tail_buffer_ms, TAIL_BUFFER_MS_BOUNDS);
        }
      }
      if (typeof console !== 'undefined' && console.info) {
        console.info('[render-timing] override updated', {
          min_scene_ms: next.min_scene_ms,
          tail_buffer_ms: next.tail_buffer_ms,
          patch,
        });
      }
      if (historyEntryId) {
        updateProductionDocEntry(historyEntryId, { doc: next }).catch(() => {});
      }
      return next;
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

  // Per-row "split as title card" inline form state. When non-null, the row
  // at `rowIndex` shows a title-text input + Apply/Cancel instead of the
  // one-click chip. Lets the user confirm exactly which text to extract,
  // since a `##Heading` on the same line as the body has no reliable
  // computable boundary.
  const [splittingRow, setSplittingRow] = useState<{ rowIndex: number; titleDraft: string } | null>(null);

  // Per-row "edit AI prompt" inline form state. When non-null, the row's
  // AI Prompt cell renders a textarea instead of the static span — same
  // pattern as splittingRow above.
  const [editingPromptRow, setEditingPromptRow] = useState<{ rowIndex: number; draft: string } | null>(null);

  /**
   * Split a row at its `##` markdown heading into TWO rows: a new
   * Title Card row above (containing just the heading as on-screen
   * text, locked-as-still so no i2v garbles it), and the original
   * row with the heading stripped from its script.
   *
   * Why this exists: i2v models (Kling, Sora 2, Veo 3, all of them)
   * mangle text inside source stills. The fix is structural — title
   * text lives in a separate non-animated row, narration lives in the
   * animated row. See user discussion 2026-05-15.
   *
   * Timing: the new title card occupies ~3 s. All rows from the split
   * onward shift forward by 3 s; total_duration grows by 3 s. The
   * user can fine-tune timecodes afterwards if needed.
   */
  const splitTitleCardFromRow = useCallback(
    (rowIndex: number, heading: string) => {
      if (!doc) return;
      const sourceRow = doc.rows[rowIndex];
      if (!sourceRow) return;

      const TITLE_CARD_SECONDS = 3;
      const titleCardVisualDescription = `Title card displaying "${heading}"`;

      const shiftTimecodeStr = (tc: string): string => {
        const totalSec = Math.round((parseTimecodeToMs(tc) + TITLE_CARD_SECONDS * 1000) / 1000);
        return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
      };

      const strippedScript = sourceRow.script_text.replace(/^\s*##[^\n]*\n?\s*/, '').trim();
      const titleCardRow: ProductionRow = {
        timecode: sourceRow.timecode,
        script_text: '',
        visual_type: 'Title Card',
        visual_description: titleCardVisualDescription,
        stock_search_terms: '',
        ai_image_prompt: '',
        on_screen_text: heading,
        notes: 'Auto-split title card. Lock-as-still so the title text is preserved (no i2v garbling).',
      };

      setDoc(prev => {
        if (!prev) return prev;
        const shiftedRows: ProductionRow[] = prev.rows.map((r, i) => {
          if (i < rowIndex) return r;
          if (i === rowIndex) {
            return { ...r, script_text: strippedScript, timecode: shiftTimecodeStr(r.timecode) };
          }
          return { ...r, timecode: shiftTimecodeStr(r.timecode) };
        });
        const nextRows: ProductionRow[] = [
          ...shiftedRows.slice(0, rowIndex),
          titleCardRow,
          ...shiftedRows.slice(rowIndex),
        ];

        // Grow total_duration by the title card's allocated time so the
        // computed shot durations downstream stay coherent.
        const newTotalSec = Math.round((parseTimecodeToMs(prev.total_duration) + TITLE_CARD_SECONDS * 1000) / 1000);
        const newTotalDuration = `${Math.floor(newTotalSec / 60)}:${String(newTotalSec % 60).padStart(2, '0')}`;

        const nextDoc = { ...prev, rows: nextRows, total_duration: newTotalDuration };
        if (historyEntryId) {
          updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
        }
        return nextDoc;
      });

      // Splice in a fresh image state for the title card row, and shift
      // every index-keyed map (clips, overlays, batch stubs) forward by
      // 1 for entries at or after the insertion point. Without this,
      // the title card would inherit the original row's image and the
      // original row would inherit nothing.
      setRowImages(prev => {
        const next = [...prev];
        next.splice(rowIndex, 0, { status: 'idle' });
        return next;
      });
      const shiftRecord = <T,>(record: Record<number, T>): Record<number, T> => {
        const next: Record<number, T> = {};
        for (const k of Object.keys(record)) {
          const idx = Number(k);
          next[idx >= rowIndex ? idx + 1 : idx] = record[idx]!;
        }
        return next;
      };
      setRowOverlays(shiftRecord);
      setRowVideoClips(shiftRecord);
      setRowBatchStubs(shiftRecord);

      // Lock the new title-card row as still — keyed by its row signature
      // (timecode + visual_description), not by index, so the lock
      // survives any future re-ordering. This is the whole point of the
      // split: stop i2v from touching the title scene. Done inline (not
      // via toggleRowLock) to keep this callback above the toggleRowLock
      // declaration without hitting the TDZ.
      const titleCardSignature = brollRowSignatureInput({
        timecode: sourceRow.timecode,
        visual_description: titleCardVisualDescription,
      });
      setRowLockSignatures((prev) => {
        const next = { ...prev, [titleCardSignature]: true as const };
        writeBrollLockMap(next);
        return next;
      });

      toast.success(`Split "${heading}" into its own title-card row (locked-as-still).`);
    },
    [doc, historyEntryId],
  );

  /**
   * Set `section_title` on every row from `startRow` to `endRow` inclusive
   * in a single setDoc call. Drives the "Apply to range" chip in
   * SectionRowControls — lets the editor mark a whole scene (e.g. rows
   * 3-7 all "The Escalation") in one action instead of retyping per row.
   */
  const applyTitleToRange = useCallback(
    (startRow: number, endRow: number, title: string) => {
      setDoc(prev => {
        if (!prev) return prev;
        const lo = Math.max(0, Math.min(startRow, endRow));
        const hi = Math.min(prev.rows.length - 1, Math.max(startRow, endRow));
        const trimmed = title.trim() || undefined;
        const nextRows = prev.rows.map((r, i) =>
          i >= lo && i <= hi ? { ...r, section_title: trimmed } : r,
        );
        const nextDoc = { ...prev, rows: nextRows };
        if (historyEntryId) {
          updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
        }
        return nextDoc;
      });
      const count = endRow - startRow + 1;
      toast.success(`Applied section title to ${count} row${count === 1 ? '' : 's'}.`);
    },
    [historyEntryId],
  );

  /**
   * Promote a single row's pillarbox color to the doc-wide default. Per-row
   * overrides on other rows stay intact — the editor uses
   * `clearPillarboxOverrides` separately when they want the new default to
   * sweep across every row. Same pattern is used for the stripe layout.
   */
  const applyPillarboxColorToAll = useCallback(
    (color: string) => {
      setDoc(prev => {
        if (!prev) return prev;
        const nextDoc = { ...prev, pillarbox_color_default: color };
        if (historyEntryId) {
          updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
        }
        return nextDoc;
      });
      toast.success('Set pillarbox color as the doc default.');
    },
    [historyEntryId],
  );

  const clearPillarboxOverrides = useCallback(() => {
    setDoc(prev => {
      if (!prev) return prev;
      const before = prev.rows.filter(r => r.pillarbox_color).length;
      if (before === 0) {
        toast('No per-row pillarbox overrides to clear.');
        return prev;
      }
      const nextRows = prev.rows.map(r =>
        r.pillarbox_color ? { ...r, pillarbox_color: undefined } : r,
      );
      const nextDoc = { ...prev, rows: nextRows };
      if (historyEntryId) {
        updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
      }
      toast.success(`Cleared pillarbox overrides on ${before} row${before === 1 ? '' : 's'}.`);
      return nextDoc;
    });
  }, [historyEntryId]);

  const applyStripeLayoutToAll = useCallback(
    (layout: 'overlay' | 'letterbox') => {
      setDoc(prev => {
        if (!prev) return prev;
        const nextDoc = { ...prev, section_title_layout_default: layout };
        if (historyEntryId) {
          updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
        }
        return nextDoc;
      });
      toast.success(`Set ${layout} as the doc-default stripe layout.`);
    },
    [historyEntryId],
  );

  const clearStripeLayoutOverrides = useCallback(() => {
    setDoc(prev => {
      if (!prev) return prev;
      const before = prev.rows.filter(r => r.section_title_layout).length;
      if (before === 0) {
        toast('No per-row stripe-layout overrides to clear.');
        return prev;
      }
      const nextRows = prev.rows.map(r =>
        r.section_title_layout ? { ...r, section_title_layout: undefined } : r,
      );
      const nextDoc = { ...prev, rows: nextRows };
      if (historyEntryId) {
        updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
      }
      toast.success(`Cleared stripe-layout overrides on ${before} row${before === 1 ? '' : 's'}.`);
      return nextDoc;
    });
  }, [historyEntryId]);

  const applySceneZoomToAll = useCallback(
    (zoom: number) => {
      const clamped = Math.max(50, Math.min(200, Math.round(zoom)));
      setDoc(prev => {
        if (!prev) return prev;
        const nextDoc = { ...prev, scene_zoom_default: clamped };
        if (historyEntryId) {
          updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
        }
        return nextDoc;
      });
      toast.success(`Set ${clamped}% as the doc-default zoom.`);
    },
    [historyEntryId],
  );

  /**
   * Title Card → section title propagation. Stamps the title card's text
   * (`on_screen_text || script_text`, trimmed) onto every row AFTER the
   * card, stopping at (but not including) the next Title Card row — or
   * the end of the doc if there isn't one. The title card row itself is
   * intentionally left alone (its own visual already carries the title;
   * adding the stripe on top would just duplicate it).
   */
  const applyTitleCardAsSectionTitle = useCallback(
    (titleCardRowIndex: number) => {
      setDoc(prev => {
        if (!prev) return prev;
        const sourceRow = prev.rows[titleCardRowIndex];
        if (!sourceRow || sourceRow.visual_type !== 'Title Card') {
          toast.error('Not a Title Card row.');
          return prev;
        }
        const text =
          (sourceRow.on_screen_text?.trim() || sourceRow.script_text?.trim() || '').trim();
        if (!text) {
          toast.error('Title Card has no On-Screen Text or Script Text to use.');
          return prev;
        }
        // End of section = the row JUST BEFORE the next Title Card row.
        // Walk forward from the row after this title card.
        let endIndex = prev.rows.length - 1;
        for (let i = titleCardRowIndex + 1; i < prev.rows.length; i++) {
          if (prev.rows[i]!.visual_type === 'Title Card') {
            endIndex = i - 1;
            break;
          }
        }
        if (endIndex < titleCardRowIndex + 1) {
          toast('No following rows under this title card.');
          return prev;
        }
        const nextRows = prev.rows.map((r, i) =>
          i > titleCardRowIndex && i <= endIndex ? { ...r, section_title: text } : r,
        );
        const nextDoc = { ...prev, rows: nextRows };
        if (historyEntryId) {
          updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
        }
        const count = endIndex - titleCardRowIndex;
        toast.success(`Applied "${text}" as section title to ${count} row${count === 1 ? '' : 's'}.`);
        return nextDoc;
      });
    },
    [historyEntryId],
  );

  const clearSceneZoomOverrides = useCallback(() => {
    setDoc(prev => {
      if (!prev) return prev;
      const before = prev.rows.filter(r => typeof r.scene_zoom === 'number').length;
      if (before === 0) {
        toast('No per-row zoom overrides to clear.');
        return prev;
      }
      const nextRows = prev.rows.map(r =>
        typeof r.scene_zoom === 'number' ? { ...r, scene_zoom: undefined } : r,
      );
      const nextDoc = { ...prev, rows: nextRows };
      if (historyEntryId) {
        updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {});
      }
      toast.success(`Cleared zoom overrides on ${before} row${before === 1 ? '' : 's'}.`);
      return nextDoc;
    });
  }, [historyEntryId]);

  // — Image generation (declared before effects that reference it)
  const [rowImages, setRowImages] = useState<RowImageState[]>([]);
  const [imageProgress, setImageProgress] = useState({ done: 0, total: 0 });
  const [imagesGenerating, setImagesGenerating] = useState(false);
  // — Edit panel: which row index has its ✎ panel open (null = closed).
  //   Held at page level so opening/closing doesn't unmount the row's cell
  //   (which would tear down in-flight previews bound to that cell).
  //   `editBrushOpen` swaps the smart-edit panel for the brush mask
  //   editor while a row is being edited. `editResult` holds the
  //   candidate produced by a brush-mode apply so EditPanel can show
  //   before/after with the same Use this / Discard buttons the smart
  //   flow uses.
  const [editPanelRow, setEditPanelRow] = useState<number | null>(null);
  const [editBrushOpen, setEditBrushOpen] = useState(false);
  // Drag-and-drop overlay position editor. `null` = closed; otherwise
  // the row index whose overlay is being positioned. Lives at the page
  // level (not the cell) because the editor needs the row's still image
  // URL from `rowImages` and the fetched overlay URL from `rowOverlays`,
  // both of which are page-scoped.
  const [overlayPositionRow, setOverlayPositionRow] = useState<number | null>(null);
  const [editResult, setEditResult] = useState<{ imageUrl: string; saliency: ImageSaliencyMap | null } | null>(null);

  function closeEditPanel() {
    setEditPanelRow(null);
    setEditBrushOpen(false);
    setEditResult(null);
  }
  // — Overlay fetch state, keyed by rowIndex. Sparse: entries exist only
  //   for rows where an overlay fetch has been kicked off.
  const [rowOverlays, setRowOverlays] = useState<Record<number, RowOverlayState>>({});

  // Phase 3 rethink state — rowIndex → number of rethink calls made this
  // page session. Cap is RETHINK_MAX_ATTEMPTS to prevent accidental
  // dollar-loss (each rethink costs ~$0.0075). Resets on page reload —
  // good enough for a soft cap, since the user must consciously reload
  // to refill the budget. `rethinkingRows` is the in-flight set; the
  // OverlayCell shows a spinner for any row in this set.
  const RETHINK_MAX_ATTEMPTS = 5;
  const [rethinkAttempts, setRethinkAttempts] = useState<Record<number, number>>({});
  const [rethinkingRows, setRethinkingRows] = useState<Set<number>>(() => new Set());

  // Phase 5 — overlay AI-edit dialog. Single-row at a time (matches
  // overlayPositionRow's pattern). Mounted from the position editor's
  // ✎ button OR the overlay cell's ✎ button; on accept, the row's
  // overlay URL is swapped to the new R2 URL returned by
  // /api/overlay/edit. The replaced URL is pushed onto the row's
  // overlay_edit_history stack (cap 3) so Undo can roll it back.
  const [overlayEditRow, setOverlayEditRow] = useState<number | null>(null);

  // Phase 5 — right-click context menu state. When set, mounts an
  // OverlayContextMenu at the cursor coords with the row's relevant
  // actions. Cleared on item-click, click-outside, or Escape.
  const [overlayContextMenu, setOverlayContextMenu] = useState<{
    rowIndex: number;
    x: number;
    y: number;
  } | null>(null);

  /** Maximum depth of the per-row edit-history stack. 3 matches the
   *  plan and keeps saved-doc payloads small — three R2 URLs is ~600
   *  bytes per row. */
  const OVERLAY_EDIT_HISTORY_CAP = 3;

  /** Phase 5 — undo the most recent AI edit on a row. Pops the last
   *  URL off `overlay_edit_history` and swaps it back into the live
   *  overlay slot. No-op when the stack is empty. */
  function undoOverlayEdit(rowIndex: number): void {
    const row = doc?.rows[rowIndex];
    const history = row?.overlay_edit_history;
    if (!row || !history || history.length === 0) {
      console.warn('[ui overlay-edit] undo skipped — no history', { rowIndex });
      return;
    }
    const previousUrl = history[history.length - 1]!;
    const nextHistory = history.slice(0, -1);
    console.info('[ui overlay-edit] undo', {
      rowIndex,
      restoredUrl: previousUrl,
      remainingHistory: nextHistory.length,
    });
    updateRow(rowIndex, { overlay_edit_history: nextHistory });
    setRowOverlays((prev) => ({
      ...prev,
      [rowIndex]: { ...prev[rowIndex], status: 'done', url: previousUrl },
    }));
  }

  // — B-roll clips per row (rowIndex → { status, videoUrl }). The BrollCell
  //   owns its own clip lifecycle and reports up via `onClipChange`; we keep
  //   the parent-level map only for the renderer wiring. Sparse — entries
  //   exist only for rows the user has generated a clip on.
  const [rowVideoClips, setRowVideoClips] = useState<Record<number, { status: string; videoUrl?: string; durationSeconds?: number } | null>>({});
  const handleBrollClipChange = useCallback(
    (rowIndex: number, clip: { status: BrollStatus; video_url: string | null; duration_seconds?: number | null } | null) => {
      setRowVideoClips((prev) => {
        if (!clip) {
          if (!(rowIndex in prev)) return prev;
          const next = { ...prev };
          delete next[rowIndex];
          return next;
        }
        const existing = prev[rowIndex];
        // Plumb the clip's intrinsic duration through so BRollScene can
        // fit the playback rate to the scene length. Undefined when the
        // clip's a transient stub (no model yet) or a legacy row that
        // pre-dates `broll_clips.duration_seconds`. See plan
        // `_plans/2026-05-17-clip-duration-fit.md`.
        const nextEntry = {
          status: clip.status,
          videoUrl: clip.video_url ?? undefined,
          durationSeconds: clip.duration_seconds ?? undefined,
        };
        if (
          existing &&
          existing.status === nextEntry.status &&
          existing.videoUrl === nextEntry.videoUrl &&
          existing.durationSeconds === nextEntry.durationSeconds
        ) {
          return prev;
        }
        return { ...prev, [rowIndex]: nextEntry };
      });
    },
    [],
  );

  // — Per-user "Animate scenes" toggle. When OFF, B-roll cells are hidden
  //   and the Remotion render ignores any clips already generated for this
  //   doc — every shot renders as a still with Ken Burns (the pre-animation
  //   default behaviour). Stored in localStorage so the preference sticks
  //   across reloads and across docs.
  const [animateScenes, setAnimateScenes] = useState<boolean>(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('prodoc_animate_scenes_v1');
    if (stored === '0') setAnimateScenes(false);
  }, []);
  const toggleAnimateScenes = useCallback(() => {
    setAnimateScenes((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('prodoc_animate_scenes_v1', next ? '1' : '0');
      } catch {
        /* best-effort */
      }
      return next;
    });
  }, []);

  // — Per-user "Suppress on-screen-text overlay" toggle. When ON, the
  //   Remotion renderer skips the dark lower-third band that normally
  //   appears with on_screen_text. Useful when the OST is already baked
  //   into the AI image (the LLM prompt does this when present) — a
  //   second Remotion-rendered overlay would just be a duplicate. Stored
  //   in localStorage so the preference sticks across reloads. Default
  //   is OFF (overlays shown) for backwards compatibility.
  const [suppressLowerThirds, setSuppressLowerThirds] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('prodoc_suppress_lower_thirds_v1');
    if (stored === '1') setSuppressLowerThirds(true);
  }, []);
  const toggleSuppressLowerThirds = useCallback(() => {
    setSuppressLowerThirds((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('prodoc_suppress_lower_thirds_v1', next ? '1' : '0');
      } catch {
        /* best-effort */
      }
      return next;
    });
  }, []);

  // — Per-row "lock as still" map (rowSignature → true). When true for a
  //   row, the renderer ignores any generated clip and falls back to the
  //   still + Ken Burns path. Persisted in localStorage so locks survive
  //   reload and doc regeneration (as long as the row signature still
  //   matches — same key space as the clip map). The page also reflects
  //   this as a rowIndex-keyed boolean array for the renderer call sites.
  const [rowLockSignatures, setRowLockSignatures] = useState<Record<string, true>>({});
  useEffect(() => {
    setRowLockSignatures(readBrollLockMap());
  }, []);
  const toggleRowLock = useCallback((rowSignature: string, locked: boolean) => {
    setRowLockSignatures((prev) => {
      const next = { ...prev };
      if (locked) next[rowSignature] = true;
      else delete next[rowSignature];
      writeBrollLockMap(next);
      return next;
    });
  }, []);

  // — "Animate all" batch state. While `animatingAll` is non-null the user
  //   is mid-batch; the button shows progress and we block re-entrance.
  const [animatingAll, setAnimatingAll] = useState<{ done: number; total: number } | null>(null);
  // — "Retry failed videos" / "Retry failed images" batch state. Same shape
  //   as `animatingAll` (done/total progress) but tracked separately so the
  //   two retry buttons can run independently of each other while still
  //   blocking re-entrance on their own batch.
  const [retryingVideos, setRetryingVideos] = useState<{ done: number; total: number } | null>(null);
  const [retryingImages, setRetryingImages] = useState<{ done: number; total: number } | null>(null);
  // Stubs assigned by the batch — pushed into each BrollCell as its
  //   `initialClip` so the cell's adoption effect picks up the new task id
  //   and starts polling. Sparse, keyed by rowIndex.
  const [rowBatchStubs, setRowBatchStubs] = useState<Record<number, BrollClipRow | null>>({});
  // — User's resolved default model id (for "Animate all"'s cost preview
  //   and the model it uses on each row). Fetched once after mount; the
  //   BrollCell's own picker stays the source of truth for per-row overrides.
  const [userDefaultModelId, setUserDefaultModelId] = useState<string>(DEFAULT_BROLL_MODEL_ID);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/user/settings/broll-default', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { modelId?: string };
        if (cancelled || !data.modelId) return;
        if (findBrollModel(data.modelId)) setUserDefaultModelId(data.modelId);
      } catch {
        /* leave at library default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── "Animate all" batch ─────────────────────────────────────────────────
  //
  // Eligibility (recomputed every render so the button label tracks state):
  //   - row has a generated still (`rowImages[i].status === 'done'`)
  //   - row is NOT locked-as-still
  //   - row does NOT already have a generating / ready clip
  //
  // Resolved against the user's chosen default model. We honour the model's
  // `kind`: t2v rows skip the still requirement, i2v rows require it.
  type AnimateAllRow = {
    rowIndex: number;
    rowSignature: string;
    visualDescription: string;
    aiImagePrompt?: string;
    stillImageUrl?: string;
  };
  const animateAllPlan = React.useMemo<AnimateAllRow[]>(() => {
    if (!doc) return [];
    const model = findBrollModel(userDefaultModelId);
    if (!model) return [];
    const out: AnimateAllRow[] = [];
    for (let i = 0; i < doc.rows.length; i++) {
      const row = doc.rows[i]!;
      const sig = brollRowSignatureInput({ timecode: row.timecode, visual_description: row.visual_description });
      if (rowLockSignatures[sig]) continue;
      const existing = rowVideoClips[i];
      if (existing && (existing.status === 'generating' || existing.status === 'ready')) continue;
      const still = rowImages[i]?.status === 'done' ? rowImages[i]?.imageUrl : undefined;
      if (model.kind === 'image-to-video' && !still) continue;
      const visDesc = (row.visual_description ?? '').trim();
      const aiPrompt = (row.ai_image_prompt ?? '').trim();
      if (visDesc.length < 20 && aiPrompt.length < 20) continue;
      out.push({
        rowIndex: i,
        rowSignature: sig,
        visualDescription: visDesc,
        aiImagePrompt: aiPrompt || undefined,
        stillImageUrl: still || undefined,
      });
    }
    return out;
  }, [doc, userDefaultModelId, rowLockSignatures, rowVideoClips, rowImages]);

  const animateAllCostUsd = React.useMemo(() => {
    const model = findBrollModel(userDefaultModelId);
    if (!model) return 0;
    return animateAllPlan.length * model.priceUsd;
  }, [animateAllPlan, userDefaultModelId]);

  // Rough scene-duration estimator used to pick a B-roll tier. Uses
  // raw timecodes (no alignment, no min-scene floor) — close enough for
  // a 5s / 10s tier decision. Final timing precision is handled at
  // render time by BRollScene's playbackRate fit. See plan
  // `_plans/2026-05-17-clip-duration-fit.md`.
  const computeRowSceneDurationMs = useCallback(
    (rowIndex: number): number => {
      if (!doc?.rows?.[rowIndex]) return 0;
      const startMs = parseTimecodeToMs(doc.rows[rowIndex].timecode);
      const next = doc.rows[rowIndex + 1];
      if (next) return Math.max(parseTimecodeToMs(next.timecode) - startMs, 0);
      const totalMs = parseTimecodeToMs(doc.total_duration);
      return Math.max(totalMs - startMs, 1000);
    },
    [doc],
  );

  // Shared batch driver: walks `plan` sequentially, kicks off a B-roll
  // generation per row, seeds the cell's adoption stub + the page's status
  // map, and reports progress through `setProgress`. Both `runAnimateAll`
  // and `runRetryFailedVideos` call this — keeps the kickoff contract in
  // one place so the two batches can't drift.
  // Sequential (not parallel): keeps the Kie rate-limiter from kicking us,
  // and gives the user a smooth progress bar.
  const processBrollPlan = useCallback(
    async (
      plan: AnimateAllRow[],
      setProgress: (p: { done: number; total: number } | null) => void,
    ) => {
      setProgress({ done: 0, total: plan.length });
      for (let n = 0; n < plan.length; n++) {
        const item = plan[n]!;
        // Auto-pick the cheap 5s tier when the row's scene fits in 5s.
        // Per-row decision so a doc with mixed scene lengths gets the
        // right tier on each row. See plan
        // `_plans/2026-05-17-clip-duration-fit.md`.
        const sceneSeconds = computeRowSceneDurationMs(item.rowIndex) / 1000;
        const tier = pickModelForScene(userDefaultModelId, sceneSeconds);
        console.info('[broll tier pick]', {
          source: 'batch',
          rowIndex: item.rowIndex,
          sceneSeconds: Number(sceneSeconds.toFixed(2)),
          userModelId: userDefaultModelId,
          pickedModelId: tier.modelId,
          downgraded: tier.downgraded,
        });
        try {
          const stub = await kickoffBrollGeneration({
            projectId: null,
            scriptId: null,
            // Tag the clip with the current production-doc instance so a
            // future page mount (same / other device) can hydrate it
            // from the DB. NULL when the doc hasn't been saved yet —
            // see plan `_plans/2026-05-17-broll-doc-id-hydration.md`.
            productionDocId: historyEntryId,
            rowIndex: item.rowIndex,
            rowSignature: item.rowSignature,
            visualDescription: item.visualDescription,
            aiImagePrompt: item.aiImagePrompt,
            styleHint: stylePreset,
            stillImageUrl: item.stillImageUrl,
            modelId: tier.modelId,
          });
          // Hand the stub down to the row's BrollCell so it adopts the new
          // clip id and starts polling. We also seed `rowVideoClips` with
          // the 'generating' state so the renderer's per-row gating sees
          // the in-flight job immediately.
          setRowBatchStubs((prev) => ({ ...prev, [item.rowIndex]: stub }));
          handleBrollClipChange(item.rowIndex, { status: 'generating', video_url: null });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Row ${item.rowIndex + 1}: ${msg}`);
        }
        setProgress({ done: n + 1, total: plan.length });
      }
      setProgress(null);
    },
    [stylePreset, userDefaultModelId, handleBrollClipChange, historyEntryId, computeRowSceneDurationMs],
  );

  const runAnimateAll = useCallback(async () => {
    if (animatingAll || retryingVideos) return;
    if (animateAllPlan.length === 0) return;
    const model = findBrollModel(userDefaultModelId);
    if (!model) return;
    // Cost confirmation — the picker shows price-per-click already, so the
    // batch needs an explicit "you're about to spend $X" check before
    // firing N parallel paid generations.
    const confirmed = window.confirm(
      `Animate ${animateAllPlan.length} row${animateAllPlan.length === 1 ? '' : 's'} with ${model.label}? ` +
        `Estimated cost: $${animateAllCostUsd.toFixed(2)}.`,
    );
    if (!confirmed) return;
    await processBrollPlan(animateAllPlan, setAnimatingAll);
    toast.success('Animation batch queued — clips will appear as each one finishes.');
  }, [
    animatingAll,
    retryingVideos,
    animateAllPlan,
    animateAllCostUsd,
    userDefaultModelId,
    processBrollPlan,
  ]);

  // ── Retry-failed batches ────────────────────────────────────────────────
  //
  // `failedVideoPlan` is a strict subset of `animateAllPlan` — same
  // eligibility gates (lock-as-still, model-kind/still pairing, min
  // description length) PLUS the row's current clip status must be
  // 'failed'. So clicking "Retry failed videos" never silently retries
  // a row the regular "Animate all" plan would also skip.
  //
  // `failedImagePlan` is independent: rows whose still status is 'error'
  // and which have an AI prompt (search-only rows can't be regenerated).
  //
  // The counters (`imageStats`, `videoStats`) are always visible per the
  // user's spec — so they see "all green" at a glance even with no
  // failures, not just when something needs attention.
  const failedVideoPlan = React.useMemo<AnimateAllRow[]>(
    () => animateAllPlan.filter((item) => rowVideoClips[item.rowIndex]?.status === 'failed'),
    [animateAllPlan, rowVideoClips],
  );

  const failedImagePlan = React.useMemo<Array<{
    rowIndex: number;
    prompt: string;
    onScreenText?: string;
    sectionTitle?: string;
    overlayStockTerms?: string;
  }>>(() => {
    if (!doc) return [];
    const out: Array<{
      rowIndex: number;
      prompt: string;
      onScreenText?: string;
      sectionTitle?: string;
      overlayStockTerms?: string;
    }> = [];
    for (let i = 0; i < doc.rows.length; i++) {
      if (rowImages[i]?.status !== 'error') continue;
      const row = doc.rows[i];
      const prompt = row?.ai_image_prompt?.trim();
      if (!prompt) continue;
      out.push({
        rowIndex: i,
        prompt,
        onScreenText: row?.on_screen_text,
        sectionTitle: row?.section_title,
        overlayStockTerms: row?.overlay_stock_terms,
      });
    }
    return out;
  }, [doc, rowImages]);

  const retryVideosCostUsd = React.useMemo(() => {
    const model = findBrollModel(userDefaultModelId);
    if (!model) return 0;
    return failedVideoPlan.length * model.priceUsd;
  }, [failedVideoPlan, userDefaultModelId]);

  // Rows that have an AI prompt but no still yet — surfaces the
  // "Generate empty" bulk action. Distinct from `failedImagePlan` (which
  // is only 'error' state): includes 'idle' and missing entries, which
  // are the common post-refresh state after the sanitizer resets stale
  // 'loading' statuses. A row with `imageUrl` already set is skipped
  // regardless of status, since the user clearly has an image they
  // don't want re-generated by this batch.
  const emptyImagePlan = React.useMemo<Array<{
    rowIndex: number;
    prompt: string;
    onScreenText?: string;
    sectionTitle?: string;
    overlayStockTerms?: string;
  }>>(() => {
    if (!doc) return [];
    const out: Array<{
      rowIndex: number;
      prompt: string;
      onScreenText?: string;
      sectionTitle?: string;
      overlayStockTerms?: string;
    }> = [];
    for (let i = 0; i < doc.rows.length; i++) {
      const s = rowImages[i];
      // Skip rows that already have a still, are mid-generation, or
      // are the search-only path. Empty = no entry at all OR 'idle'.
      if (s?.imageUrl) continue;
      if (s?.status === 'loading' || s?.status === 'pending' || s?.status === 'search') continue;
      const row = doc.rows[i];
      const prompt = row?.ai_image_prompt?.trim();
      if (!prompt) continue;
      out.push({
        rowIndex: i,
        prompt,
        onScreenText: row?.on_screen_text,
        sectionTitle: row?.section_title,
        overlayStockTerms: row?.overlay_stock_terms,
      });
    }
    return out;
  }, [doc, rowImages]);

  const imageStats = React.useMemo(() => {
    let succeeded = 0;
    let failed = 0;
    for (const s of rowImages) {
      if (s?.status === 'done') succeeded++;
      else if (s?.status === 'error') failed++;
    }
    return { succeeded, failed };
  }, [rowImages]);

  const videoStats = React.useMemo(() => {
    let succeeded = 0;
    let failed = 0;
    for (const k of Object.keys(rowVideoClips)) {
      const v = rowVideoClips[Number(k)];
      if (!v) continue;
      if (v.status === 'ready') succeeded++;
      else if (v.status === 'failed') failed++;
    }
    return { succeeded, failed };
  }, [rowVideoClips]);

  const runRetryFailedImages = useCallback(async () => {
    if (retryingImages || imagesGenerating) return;
    if (failedImagePlan.length === 0) return;
    setRetryingImages({ done: 0, total: failedImagePlan.length });
    for (let n = 0; n < failedImagePlan.length; n++) {
      const item = failedImagePlan[n]!;
      await generateImageForRow(item.rowIndex, item.prompt, {
        onScreenText: item.onScreenText,
        sectionTitle: item.sectionTitle,
        overlayStockTerms: item.overlayStockTerms,
      });
      setRetryingImages({ done: n + 1, total: failedImagePlan.length });
    }
    setRetryingImages(null);
    toast.success(
      `Retried ${failedImagePlan.length} image${failedImagePlan.length === 1 ? '' : 's'}.`,
    );
    // `generateImageForRow` is a per-render async function (not memoised) —
    // intentionally omitted from deps to avoid recreating this callback every
    // render. The function closes over stable state setters and `imageModel`
    // at call time, which is fine for a synchronous retry loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryingImages, imagesGenerating, failedImagePlan]);

  // Bulk generate stills for every row that's currently empty (idle /
  // missing) with a usable AI prompt. Shares the same sequential
  // pipeline as the retry batch so we don't hammer Kie in parallel.
  // Confirms first because a 30-row doc could cost real money.
  const runGenerateEmptyImages = useCallback(async () => {
    if (retryingImages || imagesGenerating) return;
    if (emptyImagePlan.length === 0) return;
    const confirmed = window.confirm(
      `Generate stills for ${emptyImagePlan.length} empty row${emptyImagePlan.length === 1 ? '' : 's'}? This calls the image model once per row.`,
    );
    if (!confirmed) return;
    setRetryingImages({ done: 0, total: emptyImagePlan.length });
    for (let n = 0; n < emptyImagePlan.length; n++) {
      const item = emptyImagePlan[n]!;
      await generateImageForRow(item.rowIndex, item.prompt, {
        onScreenText: item.onScreenText,
        sectionTitle: item.sectionTitle,
        overlayStockTerms: item.overlayStockTerms,
      });
      setRetryingImages({ done: n + 1, total: emptyImagePlan.length });
    }
    setRetryingImages(null);
    toast.success(
      `Generated ${emptyImagePlan.length} image${emptyImagePlan.length === 1 ? '' : 's'}.`,
    );
    // Same deps justification as runRetryFailedImages above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryingImages, imagesGenerating, emptyImagePlan]);

  const runRetryFailedVideos = useCallback(async () => {
    if (animatingAll || retryingVideos) return;
    if (failedVideoPlan.length === 0) return;
    const model = findBrollModel(userDefaultModelId);
    if (!model) return;
    const confirmed = window.confirm(
      `Retry ${failedVideoPlan.length} failed animation${failedVideoPlan.length === 1 ? '' : 's'} with ${model.label}? ` +
        `Estimated cost: $${retryVideosCostUsd.toFixed(2)}.`,
    );
    if (!confirmed) return;
    await processBrollPlan(failedVideoPlan, setRetryingVideos);
    toast.success(
      `Retry batch queued for ${failedVideoPlan.length} row${failedVideoPlan.length === 1 ? '' : 's'}.`,
    );
  }, [
    animatingAll,
    retryingVideos,
    failedVideoPlan,
    retryVideosCostUsd,
    userDefaultModelId,
    processBrollPlan,
  ]);

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
  //
  // A "handoff" is a navigation into the page that carries context from
  // elsewhere (schedule link, project, generator, QA). On the FIRST visit
  // of such a URL we want a fresh session — discard the previous saved
  // doc so the prefilled form doesn't sit next to an unrelated old doc.
  //
  // But on a REFRESH (same handoff URL, second mount) the user expects
  // their in-progress work — including thumbnail regions, row images,
  // and overlay fetches — to survive. We can't distinguish first-visit
  // from refresh from the URL alone, so we track which handoff key has
  // already been consumed in localStorage. If the current URL matches
  // the consumed key, treat the load as a refresh.
  useEffect(() => {
    const handoffKey = [
      scheduleItemId ? `sched:${scheduleItemId}` : '',
      projectIdParam ? `proj:${projectIdParam}` : '',
      search.get('from') ? `from:${search.get('from')}` : '',
      typeof window !== 'undefined' && window.localStorage.getItem('prodoc_prefill') ? 'prefill' : '',
    ].filter(Boolean).join('|');

    let consumedKey: string | null = null;
    try {
      consumedKey = window.localStorage.getItem('prodoc_handoff_consumed');
    } catch { /* ignore */ }

    const isFreshHandoff = handoffKey !== '' && handoffKey !== consumedKey;
    if (isFreshHandoff) {
      // First visit of this handoff URL — wipe the previous session and
      // mark this handoff as consumed so subsequent refreshes restore.
      // Also wipe the form-inputs cache: the prefill effects below will
      // populate the form from the handoff context, so a stale cache
      // here would create a confusing "old form + new handoff" mix.
      try {
        window.localStorage.removeItem('prodoc_last_result');
        window.localStorage.removeItem('prodoc_form_inputs_v1');
        window.localStorage.setItem('prodoc_handoff_consumed', handoffKey);
      } catch { /* ignore */ }
      return;
    }

    // Restore the FORM INPUTS first (script/niche/topic/etc.) so the user
    // sees the same setup they left even when they hadn't yet generated
    // a doc. The doc + row state restore follows; both come from
    // separate localStorage entries so a partial save (form filled, doc
    // not yet generated) still restores cleanly.
    try {
      const rawInputs = localStorage.getItem('prodoc_form_inputs_v1');
      if (rawInputs) {
        const savedInputs = JSON.parse(rawInputs) as {
          script?: string;
          niche?: string;
          topic?: string;
          modelId?: string;
          speakingPace?: number;
          actualDuration?: string;
          stylePreset?: string;
          creativeBrief?: string;
        };
        if (typeof savedInputs.script === 'string') setScript(savedInputs.script);
        if (typeof savedInputs.niche === 'string') setNiche(savedInputs.niche);
        if (typeof savedInputs.topic === 'string') setTopic(savedInputs.topic);
        if (typeof savedInputs.modelId === 'string') setModelId(savedInputs.modelId);
        if (typeof savedInputs.speakingPace === 'number') setSpeakingPace(savedInputs.speakingPace);
        if (typeof savedInputs.actualDuration === 'string') setActualDuration(savedInputs.actualDuration);
        if (typeof savedInputs.stylePreset === 'string') setStylePreset(savedInputs.stylePreset);
        if (typeof savedInputs.creativeBrief === 'string') setCreativeBrief(savedInputs.creativeBrief);
      }
    } catch { /* corrupt form cache — ignore */ }

    try {
      const saved = localStorage.getItem('prodoc_last_result');
      if (!saved) return;
      const parsed = JSON.parse(saved) as {
        doc?: ProductionDoc;
        rowImages?: RowImageState[];
        rowOverlays?: Record<number, RowOverlayState>;
        rowVideoClips?: Record<number, { status: string; videoUrl?: string } | null>;
        historyEntryId?: string | null;
        savedAt?: number;
      };
      if (!parsed.doc?.rows?.length) return;
      setDoc(parsed.doc);
      // Restore EVERY field unconditionally so a refresh after generation
      // never silently drops state. The previous version used
      // `if (parsed.rowImages?.length)` which skipped restoration when the
      // saved array was empty — fine for that specific case but it set a
      // pattern that almost guaranteed silent skips on edge cases. With
      // arrays / records we just assign whatever was saved (empty is
      // fine — the initial useState defaults were also empty).
      // Sanitize transient statuses before restoring. `'loading' / 'pending' /
      // 'search'` all imply an in-flight fetch that died with the page
      // reload — restoring them verbatim leaves the row showing a spinner
      // forever because no actual request is in flight. Reset to `'idle'`
      // so Phase 3 entry hydration can fill from server, or the user can
      // retry the generation. Same logic for overlays.
      if (Array.isArray(parsed.rowImages)) {
        const sanitized = (parsed.rowImages as Array<RowImageState | undefined | null>).map((r) => {
          if (!r) return { status: 'idle' as const };
          if (r.status === 'loading' || r.status === 'pending' || r.status === 'search') {
            return { status: 'idle' as const };
          }
          return r;
        });
        setRowImages(sanitized);
      }
      if (parsed.rowOverlays && typeof parsed.rowOverlays === 'object') {
        const cleaned: Record<number, RowOverlayState> = {};
        for (const [k, v] of Object.entries(parsed.rowOverlays as Record<string, RowOverlayState | undefined>)) {
          if (!v) continue;
          // Skip transient overlay states — the row falls back to 'idle'
          // (no entry in the map) and re-fetches on demand.
          if (v.status === 'loading') continue;
          cleaned[Number(k)] = v;
        }
        setRowOverlays(cleaned);
      }
      if (parsed.rowVideoClips && typeof parsed.rowVideoClips === 'object') {
        // Clip clean-up: 'pending' and 'generating' clips can still be
        // alive server-side (Kie keeps tasks for ~24h), so keep them —
        // the per-cell adoption effect picks the poll back up when the
        // cell mounts. Only 'failed' without a video_url is purely
        // stale; drop those so the cell starts idle. 'ready' obviously
        // stays as-is.
        const cleanedClips: Record<number, { status: string; videoUrl?: string; durationSeconds?: number } | null> = {};
        for (const [k, v] of Object.entries(parsed.rowVideoClips as Record<string, { status: string; videoUrl?: string; durationSeconds?: number } | null>)) {
          if (!v) continue;
          if (v.status === 'failed' && !v.videoUrl) continue;
          cleanedClips[Number(k)] = v;
        }
        setRowVideoClips(cleanedClips);
      }
      if (typeof parsed.historyEntryId === 'string') {
        // Restore so the background patch-the-history-entry pipeline
        // continues writing to the same row after refresh.
        setHistoryEntryId(parsed.historyEntryId);
      }
      const ago = parsed.savedAt ? Math.round((Date.now() - parsed.savedAt) / 60000) : null;
      toast.success(`Previous session restored${ago !== null ? ` (saved ${ago < 1 ? 'just now' : `${ago}m ago`})` : ''}`, { duration: 4000 });
    } catch (err) {
      // Surface corruption so future drops are debuggable. The previous
      // catch swallowed silently and made "my data vanished" reports
      // impossible to triage from the console.
      console.warn('[production-doc] restore failed', err instanceof Error ? err.message : err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the form inputs (script/niche/topic/etc.) on every change.
  // Survives refresh AND survives a tab close — the user no longer loses
  // a half-typed script when they navigate away. Stored separately from
  // the generated doc so a partially-filled form doesn't require a
  // generated doc to round-trip.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('prodoc_form_inputs_v1', JSON.stringify({
        script, niche, topic, modelId, speakingPace, actualDuration, stylePreset, creativeBrief,
      }));
    } catch { /* quota / disabled storage — best effort */ }
  }, [script, niche, topic, modelId, speakingPace, actualDuration, stylePreset, creativeBrief]);

  // "New session" — clear the form inputs, the generated doc, the row
  // images / overlays / video clips / lock state, and every related
  // localStorage entry in one go. Asks for confirmation because the
  // wipe is non-reversible (history entries are NOT touched — the
  // user can always restore a prior generation from the sidebar).
  const resetSession = useCallback(() => {
    const confirmed = window.confirm(
      'Start a new session? This clears the current form (script, niche, topic, etc.) AND the generated doc.\n\nPrevious generations are still available in the history sidebar.',
    );
    if (!confirmed) return;
    setScript('');
    setNiche('');
    setTopic('');
    setSpeakingPace(135);
    setActualDuration('');
    // Use the user's stored default style if they've set one; otherwise
    // fall back to the library default. The user's last explicit choice
    // is what shapes new sessions, not the literal hardcoded default.
    setStylePreset(userDefaultStyle || 'doodle_explainer');
    setCreativeBrief('');
    setDoc(null);
    setRowImages([]);
    setRowOverlays({});
    setRowVideoClips({});
    setRowBatchStubs({});
    setHistoryEntryId(null);
    try {
      window.localStorage.removeItem('prodoc_last_result');
      window.localStorage.removeItem('prodoc_form_inputs_v1');
      window.localStorage.removeItem('prodoc_handoff_consumed');
    } catch { /* ignore */ }
    toast.success('New session started.');
  }, [userDefaultStyle]);

  // Persist EVERYTHING that should survive a refresh into one bundle.
  // Fires whenever any of the relevant slices changes. The user's hard
  // rule is "nothing disappears until I click New Session" — so we
  // include doc, rowImages, rowOverlays, rowVideoClips, AND
  // historyEntryId in the payload. rowBatchStubs is intentionally
  // excluded (transient hand-off objects the BrollCell consumes once).
  useEffect(() => {
    if (!doc?.rows?.length) return;
    let persistFailed = false;
    // Strip `image_saliency` from doc.rows before persisting. Saliency
    // maps (60-cell busyness + dominantColors per row) are the heaviest
    // field on a generated row and account for the bulk of bundle growth
    // on long docs. They're recoverable: the FULL doc with saliency lives
    // on the server-side history entry, so a sidebar restore brings them
    // back; and any new image generation re-emits them. Until then,
    // overlay placement falls back to the LLM-picked zone (still on the
    // row) — minor visual degradation, no broken functionality. Without
    // this slim, a 30-row doc with rich prompts can push the 5MB quota.
    const slimDoc = {
      ...doc,
      rows: doc.rows.map((r) => {
        if (!r.image_saliency) return r;
        const { image_saliency: _saliency, ...slim } = r;
        return slim;
      }),
    };
    const bundle = { doc: slimDoc, rowImages, rowOverlays, rowVideoClips, historyEntryId, savedAt: Date.now() };
    try {
      localStorage.setItem('prodoc_last_result', JSON.stringify(bundle));
    } catch (err) {
      // Quota or similar storage failure. Try once more without overlays
      // (they're the heaviest field — base64-ish thumbnails / URLs). If
      // THAT also fails, drop rowVideoClips next, then doc rows last.
      // Whatever level succeeds, surface a visible toast so the user
      // knows their session may not survive a refresh. The previous
      // implementation only console.warn'd — silent data loss.
      const bundleSizeKb = Math.round(JSON.stringify(bundle).length / 1024);
      console.warn('[persist quota] full bundle failed', {
        bundleSizeKb,
        rowCount: doc.rows.length,
        imageCount: rowImages.filter((r) => r?.imageUrl).length,
        clipCount: Object.keys(rowVideoClips).length,
        overlayCount: Object.keys(rowOverlays).length,
        err: err instanceof Error ? err.message : err,
      });
      try {
        localStorage.setItem('prodoc_last_result', JSON.stringify({
          doc: slimDoc, rowImages, rowVideoClips, historyEntryId, savedAt: Date.now(),
        }));
      } catch {
        try {
          localStorage.setItem('prodoc_last_result', JSON.stringify({
            doc: slimDoc, rowImages, historyEntryId, savedAt: Date.now(),
          }));
          persistFailed = true; // partial — clips + overlays not in bundle
        } catch {
          persistFailed = true; // total failure
        }
      }
      if (!quotaWarnedRef.current) {
        quotaWarnedRef.current = true;
        toast.warning(
          `Browser storage is full (${Math.round(JSON.stringify(bundle).length / 1024)} KB doc). ` +
          'Click your doc in the history sidebar to reload it from the server. ' +
          'Or start a New Session to free space from older docs.',
          { duration: 14000 },
        );
      }
    }
    if (persistFailed) {
      console.info('[persist quota] partial bundle saved without overlays/clips', {
        rowImagesCount: rowImages.length,
        overlayCount: Object.keys(rowOverlays).length,
        clipCount: Object.keys(rowVideoClips).length,
      });
    }
    // Also patch the current history entry so EVERY generated asset
    // survives on restore — images, overlays, AND clip ids. Previously
    // only `rowImages` was persisted here; overlays + clips were lost
    // the moment the user clicked the entry from the sidebar (the
    // sidebar restore zeroed both maps). See plan
    // `_plans/2026-05-17-render-state-hardening.md`.
    if (historyEntryId && doc?.rows?.length) {
      const imgMap: Record<number, string> = {};
      rowImages.forEach((r, i) => { if (r?.imageUrl) imgMap[i] = r.imageUrl; });

      // Overlays: persist the whole resolved state ({status, url}) per
      // row index. Only rows whose status is meaningful get an entry
      // (skip pure 'idle' rows — they round-trip as missing).
      const overlayMap: Record<number, { status: string; url?: string }> = {};
      Object.entries(rowOverlays).forEach(([k, v]) => {
        const i = Number(k);
        if (!Number.isFinite(i) || !v) return;
        overlayMap[i] = { status: v.status, url: v.url };
      });

      // Clips: persist only the clip id per row. The actual videoUrl is
      // re-fetched on restore from `/api/broll/{id}` via BrollCell's
      // mount-hydration. Storing the id (not the url) keeps the entry
      // small AND auto-refreshes the url if it ever rotates server-side.
      // We need the id from BrollCell's localStorage map, not from
      // `rowVideoClips` (which only has status+videoUrl). Rebuild the
      // (rowIndex → clipId) map from rowSignature lookups.
      const clipMap: Record<number, string> = {};
      const sigToClipId = readBrollLsMap();
      doc.rows.forEach((row, i) => {
        const sig = brollRowSignatureInput({
          timecode: row.timecode,
          visual_description: row.visual_description,
        });
        const clipId = sigToClipId[sig];
        if (clipId && rowVideoClips[i]?.status === 'ready') {
          clipMap[i] = clipId;
        }
      });

      const patch: Partial<import('@/lib/history').ProductionDocHistoryEntry> = {};
      if (Object.keys(imgMap).length > 0) patch.rowImages = imgMap;
      if (Object.keys(overlayMap).length > 0) patch.rowOverlays = overlayMap;
      if (Object.keys(clipMap).length > 0) patch.rowVideoClips = clipMap;
      if (Object.keys(patch).length > 0) {
        // Fire-and-forget — the lib updates the localStorage cache
        // synchronously, then PATCHes the server in the background.
        updateProductionDocEntry(historyEntryId, patch).catch(() => {});
      }
    }
  }, [doc, rowImages, rowOverlays, rowVideoClips, historyEntryId]);

  // Auto-scroll log to bottom when new entries are added
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [generationLog.length]);

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
  // The "Download MP4" URL — a presigned R2/S3 URL with `response-
  // content-disposition: attachment` baked in so the browser streams
  // direct from storage (no /api/download-proxy hop → no 300s Vercel
  // function cap on multi-GB downloads).
  const [renderDownloadUrl, setRenderDownloadUrl] = useState<string | null>(null);
  // Phase 0 telemetry: a one-time post-render survey asking whether
  // the creator plans to finish in CapCut / Premiere / elsewhere, or
  // stay in this app. Drives the shot-graph editor build decision
  // (see _plans/2026-05-18-shot-graph-editor.md). Resets when a new
  // render starts so a fresh `done` shows the survey again.
  const [renderSurveyDismissed, setRenderSurveyDismissed] = useState(false);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // One-shot guard: surface the localStorage-quota toast at most once per
  // session so a tight render-typing-render loop doesn't spam the user.
  // The flag resets on hard reload, which is the natural moment to
  // re-warn if the problem persists. See plan
  // `_plans/2026-05-17-render-state-hardening.md`.
  const quotaWarnedRef = useRef(false);
  // Mirror of the three asset-state slices the renderer reads from.
  // `executeRender` is a stable function reference (declared once per
  // render) but may be CALLED later — from the missing-clips modal,
  // after the user reloads — at which point the closure-captured state
  // is stale relative to the fresh state from `handleBrollClipChange`.
  // Reading through these refs guarantees we send the freshest values
  // to the server. See `_plans/2026-05-17-render-state-hardening.md`.
  const rowVideoClipsRef = useRef<Record<number, { status: string; videoUrl?: string } | null>>({});
  const rowImagesRef = useRef<RowImageState[]>([]);
  const rowOverlaysRef = useRef<Record<number, RowOverlayState>>({});

  // — Voiceover-aligned scene timing (per _plans/2026-05-13-voiceover-aligned-scene-timing.md)
  // Mirrors the four-state pill near the Render button: idle → syncing →
  // ready (success) | stale (drift > 20% after a prior alignment) |
  // failed (server returned a reason) | unsupported (voiceover URL isn't
  // a same-origin proxy path).
  type AlignmentPillStatus = 'idle' | 'syncing' | 'ready' | 'stale' | 'failed' | 'unsupported';
  const [alignmentStatus, setAlignmentStatus] = useState<AlignmentPillStatus>('idle');
  const [alignmentDetail, setAlignmentDetail] = useState<string | null>(null);
  // The actual word-level alignment payload from ElevenLabs. Stored
  // here so the in-browser preview (VideoPlayerMemo) can pass it into
  // `productionDocToVideoConfig` — without this, the preview falls back
  // to estimated timecodes and the narration drifts against the frames.
  // The render route gets the alignment via a different code path
  // (server-side cache lookup, see `body.voiceoverAlignment`), but the
  // preview is a pure-client build, so it needs the data in state.
  // See `_plans/2026-05-17-render-state-hardening.md`.
  const [voiceoverAlignment, setVoiceoverAlignment] =
    useState<import('@/lib/elevenlabs').ForcedAlignmentResponse | null>(null);
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

  /**
   * Cache a saliency map on a row and re-resolve overlay placement against
   * it. The renderer prefers `*_resolved` over the LLM's blind picks, so
   * applying saliency after image generation / upload / edit lets overlays
   * land on empty pixels instead of focal content.
   *
   * Best-effort — if there's no saliency, `*_resolved` stays untouched
   * and the renderer falls back to the LLM zone. Single place to update
   * the doc state so generate / upload / edit all converge on one path.
   */
  function applySaliencyToRow(rowIndex: number, saliency: ImageSaliencyMap) {
    setDoc(prev => {
      if (!prev) return prev;
      const nextRows = [...prev.rows];
      const row = nextRows[rowIndex];
      if (!row) return prev;
      let zoneResolved = row.overlay_zone_resolved;
      let sizeResolved = row.overlay_size_resolved;
      if (row.overlay_zone && row.overlay_size) {
        const stripeOverlapsScene =
          Boolean(row.section_title?.trim()) &&
          (row.section_title_layout ?? 'letterbox') === 'overlay';
        const placement = resolveOverlayPlacement({
          llmZone: row.overlay_zone,
          llmSize: row.overlay_size,
          saliency,
          hasSectionTitle: Boolean(row.section_title?.trim()),
          stripeOverlapsScene,
        });
        console.info('[overlay placement] resolved', {
          rowIndex,
          llmZone: row.overlay_zone,
          finalZone: placement.zone,
          llmSize: row.overlay_size,
          finalSize: placement.size,
          reason: placement.reason,
        });
        zoneResolved = placement.zone;
        sizeResolved = placement.size;
      }
      nextRows[rowIndex] = {
        ...row,
        image_saliency: saliency,
        overlay_zone_resolved: zoneResolved,
        overlay_size_resolved: sizeResolved,
      };
      return { ...prev, rows: nextRows };
    });
  }

  /**
   * Compute saliency for an image URL by calling the saliency endpoint.
   * Silent on failure — overlay placement falls back to the LLM zone.
   * Used by upload + URL import paths where the generator route didn't
   * already return a saliency map alongside the image.
   */
  async function runSaliencyForRow(rowIndex: number, imageUrl: string) {
    try {
      const res = await fetch('/api/images/saliency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl }),
      });
      if (!res.ok) return;
      const data = await res.json() as { saliency?: ImageSaliencyMap | null };
      if (data.saliency) applySaliencyToRow(rowIndex, data.saliency);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Attach a locally-selected image to a row. Goes browser → R2 via a
   * presigned PUT to bypass Vercel's 4.5 MB API body cap. On success the
   * row's image state flips to `done` with `source: 'upload'`, and
   * saliency is fetched in the background so overlay placement stays
   * sane.
   */
  async function uploadImageForRow(rowIndex: number, file: File): Promise<boolean> {
    if (!file.type.startsWith('image/')) {
      toast.error('Only image files are supported');
      return false;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be under 10 MB');
      return false;
    }
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], status: 'uploading' };
      return next;
    });
    try {
      const presignRes = await fetch('/api/uploads/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!presignRes.ok) {
        const errBody = await presignRes.json().catch(() => ({}));
        throw new Error((errBody as { error?: string }).error || `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl } = await presignRes.json();
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'done', imageUrl: downloadUrl, source: 'upload' };
        return next;
      });
      void runSaliencyForRow(rowIndex, downloadUrl);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      toast.error(msg);
      // Drop back to idle on upload failure rather than 'error' — the
      // toast already carries the message, and idle restores the
      // three-button row so the user can pick a different recovery
      // path (try again, generate, paste a URL). The 'error' state's
      // Retry button calls onRetry which goes to GENERATE — not what
      // the user meant by retrying an upload.
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'idle' };
        return next;
      });
      return false;
    }
  }

  /**
   * Mirror an externally-hosted image into R2 (so the row's URL is stable
   * and CDN-served). The server-side fetch is DNS-rebinding-pinned via
   * `resolveAndPinSafeUrl` — see `/api/uploads/image-from-url`.
   */
  async function importImageUrlForRow(rowIndex: number, externalUrl: string): Promise<boolean> {
    const trimmed = externalUrl.trim();
    if (!trimmed) return false;
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], status: 'uploading' };
      return next;
    });
    try {
      const res = await fetch('/api/uploads/image-from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: trimmed }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data.error as string) || `Failed (${res.status})`);
      const downloadUrl = data.imageUrl as string;
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'done', imageUrl: downloadUrl, source: 'url' };
        return next;
      });
      void runSaliencyForRow(rowIndex, downloadUrl);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'URL import failed';
      toast.error(msg);
      // Same reasoning as uploadImageForRow's catch — fall back to
      // idle so the user can pick a recovery path. The toast surfaces
      // the failure detail; the 'error' state's Retry would launch
      // generation, not retry the import.
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'idle' };
        return next;
      });
      return false;
    }
  }

  /**
   * Generate an edited image for a row without mutating its current image.
   * Returns the candidate URL + saliency on success so the caller (the
   * edit panel) can show before/after before the user commits.
   *
   * Two modes:
   *   - smart: prompt-only edit via Nano Banana 2 (~$0.02). Default.
   *   - mask:  brush-painted region edit via GPT-4o Image. Caller passes
   *           the pre-uploaded mask URL + quality tier.
   *
   * The row's `RowImageState` is untouched here. Only `acceptEditForRow`
   * (called by the panel's "Use this" button) writes the result onto the
   * row.
   */
  async function editImageForRow(
    rowIndex: number,
    originalImageUrl: string,
    prompt: string,
    opts: { mask?: { url: string; quality: 'low' | 'medium' | 'high' } } = {},
  ): Promise<{ ok: true; imageUrl: string; saliency: ImageSaliencyMap | null } | { ok: false; error: string }> {
    try {
      const res = await fetch('/api/generate/production-doc/image/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalImageUrl,
          prompt,
          model: opts.mask ? 'gpt-4o-image-edit' : 'nano-banana-edit',
          mask: opts.mask ? { url: opts.mask.url, quality: opts.mask.quality } : undefined,
        }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        return { ok: false, error: (data.error as string) || `Failed (${res.status})` };
      }
      console.info('[prodoc image-edit] success', { rowIndex, mode: opts.mask ? 'mask' : 'smart' });
      return {
        ok: true,
        imageUrl: data.imageUrl as string,
        saliency: (data.saliency ?? null) as ImageSaliencyMap | null,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Edit failed' };
    }
  }

  /**
   * Commit an edited image to a row. Called by the edit panel's "Use this"
   * button. Sets the row state + applies saliency the same way generate /
   * upload do, so the renderer picks up the new image immediately.
   */
  function acceptEditForRow(rowIndex: number, imageUrl: string, saliency: ImageSaliencyMap | null) {
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { status: 'done', imageUrl, source: 'edit' };
      return next;
    });
    if (saliency) applySaliencyToRow(rowIndex, saliency);
  }

  // Callers MUST pass `meta` from a source they already own (the `rows`
  // array driving the batch, or the row in JSX scope). We deliberately
  // do NOT fall back to reading `doc?.rows[rowIndex]` here: the auto
  // pipeline calls `setDoc(result)` and then `generateImages(result.rows)`
  // in the same synchronous tick, so React hasn't re-rendered and the
  // `doc` captured in this closure is still the previous value (often
  // null after the reset on `generate()`). Reading from `doc` here was
  // the source of "OST not baked / overlay not fetched" on every fresh
  // batch — see the bug fix commit for the full diagnosis.
  async function generateImageForRow(
    rowIndex: number,
    prompt: string,
    meta: { onScreenText?: string; sectionTitle?: string; overlayStockTerms?: string } = {},
    signal?: AbortSignal,
  ): Promise<boolean> {
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], status: 'loading' };
      return next;
    });
    const onScreenText = meta.onScreenText?.trim() || undefined;
    const sectionTitle = meta.sectionTitle?.trim() || undefined;
    const overlayTerms = meta.overlayStockTerms?.trim() || undefined;
    console.info('[prodoc image-gen] start', {
      rowIndex,
      hasOst: Boolean(onScreenText),
      hasSectionTitle: Boolean(sectionTitle),
      hasOverlayTerms: Boolean(overlayTerms),
    });
    try {
      const res = await fetch('/api/generate/production-doc/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ prompt, model: imageModel, onScreenText, sectionTitle }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data.error as string) || 'Failed');
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'done', imageUrl: data.imageUrl as string, source: 'generated' };
        return next;
      });
      const saliency = data.saliency as ImageSaliencyMap | null | undefined;
      if (saliency) applySaliencyToRow(rowIndex, saliency);
      // Fire-and-forget the overlay fetch in parallel with the next row's
      // image gen. Only triggers when the LLM planned an overlay for this
      // row. Idempotent — the route's R2 cache short-circuits repeats.
      if (overlayTerms) {
        console.info('[prodoc image-gen] overlay queued', { rowIndex, overlayTerms });
        void fetchOverlayForRow(rowIndex, overlayTerms);
      }
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

  // ── Per-row overlay fetch
  //
  // Hits /api/overlay/fetch which sources a real-world asset (logo,
  // screenshot, photo) for the row's `overlay_stock_terms`, strips its
  // background via Replicate RMBG, and stores it on R2. We persist the
  // resulting URL on `rowOverlays[rowIndex]` and the Remotion renderer
  // composites it onto the still at the LLM-planned `overlay_zone`.
  //
  // The route degrades gracefully (no result / search down / RMBG down all
  // return 200 with `overlayUrl: null` + a `reason`), so a missing key or
  // a flaky source never breaks the row — the still alone is rendered.
  async function fetchOverlayForRow(rowIndex: number, overlayStockTerms: string): Promise<void> {
    setRowOverlays((prev) => ({ ...prev, [rowIndex]: { status: 'loading' } }));
    try {
      // Phase 2 smart placement: when both the row's scene image AND its
      // saliency map are ready, send them through so the route can ask
      // a vision LLM where this overlay belongs. The route is tolerant
      // of either being absent — a row whose still hasn't generated yet
      // still gets the overlay, just without smart placement.
      const row = doc?.rows[rowIndex];
      const sceneImageUrl = rowImages[rowIndex]?.imageUrl;
      const saliencyMap = row?.image_saliency;
      const saliencyCells = saliencyMap
        ? Array.from({ length: saliencyMap.cols * saliencyMap.rows }, (_, idx) => ({
            row: Math.floor(idx / saliencyMap.cols),
            col: idx % saliencyMap.cols,
            score: saliencyMap.busyness[idx] ?? 0,
          }))
        : undefined;
      const res = await fetch('/api/overlay/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overlayStockTerms,
          sceneImageUrl,
          saliencyCells,
        }),
      });
      const data = (await safeJson(res)) as {
        overlayUrl?: string | null;
        sourceUrl?: string;
        reason?: string;
        error?: string;
        placement?: {
          model: string;
          sizePct: number;
          mode: 'zone' | 'custom';
          zone?: ProductionRow['overlay_zone'];
          customXPct?: number;
          customYPct?: number;
          reason: string;
        };
        /** Phase 4 — true when RMBG was used, false when reverted. */
        rmbgKept?: boolean;
      };
      if (!res.ok) {
        setRowOverlays((prev) => ({
          ...prev,
          [rowIndex]: { status: 'error', error: data.error || `Failed (${res.status})` },
        }));
        return;
      }
      if (data.overlayUrl) {
        setRowOverlays((prev) => ({
          ...prev,
          [rowIndex]: { status: 'done', url: data.overlayUrl!, sourceUrl: data.sourceUrl },
        }));
        // Phase 4 — persist the RMBG-gate outcome on the row. Separate
        // updateRow so it lands even when no Phase-2 placement was
        // returned (e.g. sceneImageUrl wasn't provided this call).
        if (typeof data.rmbgKept === 'boolean') {
          console.info('[ui overlay-rmbg] gate outcome', {
            rowIndex,
            rmbgKept: data.rmbgKept,
          });
          updateRow(rowIndex, { overlay_rmbg_kept: data.rmbgKept });
        }
        // Phase 2: when the route returned a smart placement, write the
        // decision onto the row. Only write fields the AI actually
        // produced — `mode: 'zone'` leaves customX/Y null; `mode:
        // 'custom'` leaves zone null. The renderer's resolution order
        // (custom > zone > LLM-default) makes either combination work.
        const p = data.placement;
        if (p) {
          console.info('[ui overlay-placement] applied', {
            rowIndex,
            model: p.model,
            sizePct: p.sizePct,
            mode: p.mode,
            zone: p.zone,
            reason: p.reason,
          });
          updateRow(rowIndex, {
            overlay_size_pct: p.sizePct,
            overlay_position:
              p.mode === 'custom' &&
              typeof p.customXPct === 'number' &&
              typeof p.customYPct === 'number'
                ? { x_pct: p.customXPct, y_pct: p.customYPct }
                : undefined,
            // When the AI picked a zone, also clear any prior manual
            // position so the zone wins at render time.
            ...(p.mode === 'zone' && p.zone ? { overlay_zone: p.zone } : {}),
            overlay_placement_reason: p.reason || undefined,
            overlay_placement_model: p.model,
          });
        }
      } else {
        setRowOverlays((prev) => ({
          ...prev,
          [rowIndex]: { status: 'skipped', error: data.reason || 'No usable image found' },
        }));
      }
    } catch (err) {
      setRowOverlays((prev) => ({
        ...prev,
        [rowIndex]: { status: 'error', error: err instanceof Error ? err.message : 'Failed' },
      }));
    }
  }

  /**
   * Phase 3 — Rethink button. Re-runs the vision placement on a row's
   * existing overlay without touching Brave or RMBG. The route's
   * `mode: 'placement-only'` branch handles the cheap path. We also
   * forward the row's current placement as `previousDecision` so the
   * prompt explicitly asks for a different answer; without that hint
   * Gemini tends to return the same pick twice.
   *
   * Bounded by RETHINK_MAX_ATTEMPTS per row per page session. Hitting
   * the cap surfaces an alert; reload refills the budget.
   *
   * Telemetry: emits `overlay_rethink` with the before/after placement
   * and the attempt count so the Phase 0 drag-rate dashboard can also
   * track "how often did the user need to rethink before accepting?"
   */
  async function rethinkOverlayPlacement(rowIndex: number): Promise<void> {
    const overlayState = rowOverlays[rowIndex];
    if (overlayState?.status !== 'done' || !overlayState.url) {
      console.warn('[ui overlay-rethink] no overlay to rethink', { rowIndex, status: overlayState?.status });
      return;
    }
    const attempts = rethinkAttempts[rowIndex] ?? 0;
    if (attempts >= RETHINK_MAX_ATTEMPTS) {
      alert(`AI rethink limit reached for this overlay (${RETHINK_MAX_ATTEMPTS}/session). Reload the page to reset.`);
      return;
    }
    const row = doc?.rows[rowIndex];
    if (!row) return;

    const sceneImageUrl = rowImages[rowIndex]?.imageUrl;
    if (!sceneImageUrl) {
      alert('Generate the row image first — the AI needs to see the scene before it can rethink the overlay placement.');
      return;
    }
    const saliencyMap = row.image_saliency;
    const saliencyCells = saliencyMap
      ? Array.from({ length: saliencyMap.cols * saliencyMap.rows }, (_, idx) => ({
          row: Math.floor(idx / saliencyMap.cols),
          col: idx % saliencyMap.cols,
          score: saliencyMap.busyness[idx] ?? 0,
        }))
      : undefined;

    // Snapshot the row's current placement so we can forward it as the
    // anti-repeat hint AND log the before/after delta in telemetry.
    const prevMode: 'zone' | 'custom' =
      row.overlay_position &&
      typeof row.overlay_position.x_pct === 'number' &&
      typeof row.overlay_position.y_pct === 'number'
        ? 'custom'
        : 'zone';
    const previousDecision = {
      sizePct:
        typeof row.overlay_size_pct === 'number'
          ? row.overlay_size_pct
          : row.overlay_size === 'small'
            ? 12
            : row.overlay_size === 'large'
              ? 25
              : 18,
      mode: prevMode,
      zone: row.overlay_zone_resolved ?? row.overlay_zone,
      customXPct: row.overlay_position?.x_pct,
      customYPct: row.overlay_position?.y_pct,
      reason: row.overlay_placement_reason ?? '',
    };

    console.info('[ui overlay-rethink] request', {
      rowIndex,
      attempt: attempts + 1,
      previousMode: prevMode,
      previousZone: previousDecision.zone,
      previousSize: previousDecision.sizePct,
    });

    setRethinkingRows((prev) => {
      const next = new Set(prev);
      next.add(rowIndex);
      return next;
    });

    try {
      const res = await fetch('/api/overlay/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'placement-only',
          existingOverlayUrl: overlayState.url,
          sceneImageUrl,
          saliencyCells,
          previousDecision,
        }),
      });
      const data = (await safeJson(res)) as {
        placement?: {
          model: string;
          sizePct: number;
          mode: 'zone' | 'custom';
          zone?: ProductionRow['overlay_zone'];
          customXPct?: number;
          customYPct?: number;
          reason: string;
        };
        error?: string;
        reason?: string;
      };
      if (!res.ok) {
        alert(`Rethink failed: ${data.error || `HTTP ${res.status}`}`);
        console.warn('[ui overlay-rethink] non-OK', { rowIndex, status: res.status, body: data });
        return;
      }
      if (!data.placement) {
        alert('AI couldn\'t produce a new placement — the previous pick stays. Try again or drag manually.');
        console.warn('[ui overlay-rethink] no placement returned', { rowIndex, reason: data.reason });
        return;
      }
      const p = data.placement;
      console.info('[ui overlay-rethink] applied', {
        rowIndex,
        attempt: attempts + 1,
        model: p.model,
        sizePct: p.sizePct,
        mode: p.mode,
        zone: p.zone,
        reason: p.reason,
      });

      // Persist new placement — same shape as Phase 2's fetch path.
      updateRow(rowIndex, {
        overlay_size_pct: p.sizePct,
        overlay_position:
          p.mode === 'custom' &&
          typeof p.customXPct === 'number' &&
          typeof p.customYPct === 'number'
            ? { x_pct: p.customXPct, y_pct: p.customYPct }
            : undefined,
        ...(p.mode === 'zone' && p.zone ? { overlay_zone: p.zone } : {}),
        overlay_placement_reason: p.reason || undefined,
        overlay_placement_model: p.model,
      });

      // Increment the per-row counter so the cap eventually bites.
      setRethinkAttempts((prev) => ({ ...prev, [rowIndex]: attempts + 1 }));

      // Telemetry — before/after delta.
      recordEditorTelemetry('overlay_rethink', {
        payload: {
          row_index: rowIndex,
          placement_model: p.model,
          attempt: attempts + 1,
          prev_zone: previousDecision.zone ?? null,
          new_zone: p.zone ?? null,
          prev_size_pct: previousDecision.sizePct,
          new_size_pct: Number(p.sizePct.toFixed(2)),
          prev_mode: previousDecision.mode,
          new_mode: p.mode,
        },
      });
    } catch (err) {
      console.warn('[ui overlay-rethink] threw', {
        rowIndex,
        detail: err instanceof Error ? err.message : String(err),
      });
      alert('Rethink failed — see console for details.');
    } finally {
      setRethinkingRows((prev) => {
        const next = new Set(prev);
        next.delete(rowIndex);
        return next;
      });
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
          // Read meta from the `rows` argument, not React `doc` state — see
          // generateImageForRow header for why.
          await generateImageForRow(
            idx,
            row.ai_image_prompt,
            {
              onScreenText: row.on_screen_text,
              sectionTitle: row.section_title,
              overlayStockTerms: row.overlay_stock_terms,
            },
            signal,
          );
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
    setRowOverlays({});
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
        // Persist the voiceover URL on the saved entry so the
        // shot-graph editor (/edit/[projectId]) can replay audio in
        // its preview without re-fetching from a separate source.
        // Empty string means "no VO yet" — saved as undefined so
        // older entries' "voiceoverUrl missing" path stays distinct
        // from "explicitly cleared."
        voiceoverUrl: voiceoverUrl || undefined,
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
      const data = (await safeJson(res)) as {
        status?: string;
        reason?: string;
        alignment?: import('@/lib/elevenlabs').ForcedAlignmentResponse;
      };
      if (!res.ok) {
        setAlignmentStatus('failed');
        setAlignmentDetail(typeof data.reason === 'string' ? data.reason : 'Alignment request failed.');
        return;
      }
      if (data.status === 'ready') {
        setAlignmentStatus('ready');
        setAlignmentDetail(null);
        setAlignedAtScript(canonicalScript);
        // Capture the alignment payload so the preview can apply it.
        // The render route fetches the same alignment server-side (via
        // the body.voiceoverAlignment hint), so the two paths stay in
        // sync. Falsy `alignment` = older response shape; we keep
        // status='ready' but the preview will fall back to estimated
        // timing for THIS session until a re-align happens.
        if (data.alignment) {
          setVoiceoverAlignment(data.alignment);
          console.info('[alignment captured]', {
            wordCount: data.alignment.words?.length ?? 0,
          });
        }
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
        // Stale alignment vs new voiceover URL — drop the cached payload
        // too. Letting the preview keep using the old timestamps against
        // the new audio would create the exact narration-frame drift
        // bug 2 is fixing.
        setVoiceoverAlignment(null);
        return;
      }
    }

    if (!doc || !voiceoverUrl) {
      setAlignmentStatus('idle');
      setAlignmentDetail(null);
      setVoiceoverAlignment(null);
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

  /**
   * Walk every row and find clips that EXIST in the per-cell localStorage
   * signature map but DIDN'T make it back into `rowVideoClips` state
   * (typically because `prodoc_last_result` was cleared / quota-exceeded
   * / history-sidebar restored without bringing them, etc).
   *
   * Returns a per-row missing list. Used as a pre-render gate: if any
   * row has a generated clip the renderer would silently ignore, we
   * stop and ask the user to reload them before kicking off the render
   * — otherwise they'd ship a stills-only MP4 and pay again for the
   * animations they already generated. See plan
   * `_plans/2026-05-17-render-state-hardening.md`.
   */
  type MissingClip = { rowIndex: number; clipId: string; signature: string };
  const findMissingClipsForRender = useCallback((): MissingClip[] => {
    if (!doc?.rows) return [];
    const sigMap = readBrollLsMap();
    const liveClips = rowVideoClipsRef.current;
    const missing: MissingClip[] = [];
    doc.rows.forEach((row, i) => {
      const sig = brollRowSignatureInput({
        timecode: row.timecode,
        visual_description: row.visual_description,
      });
      const clipId = sigMap[sig];
      if (!clipId) return;
      const current = liveClips[i];
      if (current?.status === 'ready' && current.videoUrl) return;
      missing.push({ rowIndex: i, clipId, signature: sig });
    });
    return missing;
  }, [doc]);

  /**
   * Reload a batch of missing clips by id. Hits the SAME `/api/broll/{id}`
   * endpoint BrollCell uses on mount, then dispatches each result
   * through `handleBrollClipChange` so the parent's `rowVideoClips`
   * actually updates. Errors per-clip are isolated — we still try the
   * rest. Returns the list of clips that failed to reload (so the
   * modal can keep them visible).
   */
  const reloadMissingClips = useCallback(async (missing: MissingClip[]): Promise<MissingClip[]> => {
    const stillMissing: MissingClip[] = [];
    for (const m of missing) {
      try {
        const res = await fetch(`/api/broll/${m.clipId}`, { cache: 'no-store' });
        if (!res.ok) {
          console.warn('[render preflight] reload failed', { rowIndex: m.rowIndex, clipId: m.clipId, status: res.status });
          stillMissing.push(m);
          continue;
        }
        const data = (await res.json()) as {
          clip?: { id: string; status: BrollStatus; video_url: string | null; duration_seconds?: number | null };
        };
        if (data.clip && data.clip.status === 'ready' && data.clip.video_url) {
          handleBrollClipChange(m.rowIndex, {
            status: data.clip.status,
            video_url: data.clip.video_url,
            duration_seconds: data.clip.duration_seconds,
          });
        } else {
          stillMissing.push(m);
        }
      } catch (err) {
        console.warn('[render preflight] reload threw', { rowIndex: m.rowIndex, clipId: m.clipId, err: err instanceof Error ? err.message : String(err) });
        stillMissing.push(m);
      }
    }
    return stillMissing;
  }, [handleBrollClipChange]);

  // Modal state: non-null = modal open with these missing clips.
  // `reloading` flips while the Reload button is in flight.
  const [missingClipsModal, setMissingClipsModal] = useState<{
    missing: MissingClip[];
    reloading: boolean;
  } | null>(null);

  // Keep the asset-state refs in sync with the live state on every
  // commit. Tiny effect; the cost is one assignment per render and
  // it eliminates the stale-closure class of bug in `executeRender`.
  useEffect(() => { rowVideoClipsRef.current = rowVideoClips; }, [rowVideoClips]);
  useEffect(() => { rowImagesRef.current = rowImages; }, [rowImages]);
  useEffect(() => { rowOverlaysRef.current = rowOverlays; }, [rowOverlays]);

  // Shared dependency for the two mount-time hydration effects below
  // (Phase 3 + Phase 2). Reading `doc?.rows?.length` directly inside the
  // dep array would re-fire on every keystroke that mutates a row; using
  // the row COUNT alone keeps the effects scoped to "doc identity
  // changed" without churning on row edits.
  const docRowsLength = doc?.rows?.length ?? 0;

  // ── Entry hydration of images + overlays (Phase 3) ─────────────────────────
  //
  // Mount-time recovery for stills + overlays from the canonical history
  // entry. Phase 1 made the entry the durable record; this effect is
  // what reads it back on refresh when the localStorage bundle came
  // home short (quota-trimmed save). Clips are handled by Phase 2's
  // DB hydration instead — they don't have URLs on the entry, only ids.
  //
  // Merge policy: only fill in rows where the current state is missing
  // or 'idle'. Don't overwrite 'loading' (live generation), 'done' (the
  // user already has it), or 'error' (their explicit "retry" state). The
  // effect is idempotent — once everything's hydrated, subsequent runs
  // are no-ops via the `changed` flag inside the functional setStates.
  // See plan `_plans/2026-05-17-image-overlay-entry-hydration.md`.
  useEffect(() => {
    if (!historyEntryId || !doc?.rows?.length || historyItems.length === 0) return;
    const entry = historyItems.find((e) => e.id === historyEntryId);
    if (!entry) return;

    let imagesApplied = 0;
    let overlaysApplied = 0;

    if (entry.rowImages && Object.keys(entry.rowImages).length > 0) {
      setRowImages((prev) => {
        const next = prev.length >= doc.rows.length
          ? [...prev]
          : [...prev, ...new Array(doc.rows.length - prev.length).fill({ status: 'idle' })];
        let changed = false;
        doc.rows.forEach((_row, i) => {
          const entryUrl = entry.rowImages?.[i];
          if (!entryUrl) return;
          const cur = next[i];
          // Respect every non-idle state: 'loading' is an in-flight
          // generation we mustn't clobber; 'done' is what we'd be
          // restoring TO; 'error' is the user's signal that they want
          // to retry that specific row. Only 'idle' / missing fills.
          if (!cur || cur.status === 'idle') {
            next[i] = { status: 'done', imageUrl: entryUrl };
            imagesApplied++;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }

    if (entry.rowOverlays && Object.keys(entry.rowOverlays).length > 0) {
      setRowOverlays((prev) => {
        const next: Record<number, RowOverlayState> = { ...prev };
        let changed = false;
        Object.entries(entry.rowOverlays!).forEach(([k, v]) => {
          const i = Number(k);
          if (!Number.isFinite(i) || !v) return;
          const cur = next[i];
          // Same merge policy as images: only fill empty / idle slots.
          if (!cur || cur.status === 'idle') {
            next[i] = v as RowOverlayState;
            overlaysApplied++;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }

    console.info('[entry hydrate]', {
      historyEntryId,
      imagesFromEntry: entry.rowImages ? Object.keys(entry.rowImages).length : 0,
      imagesApplied,
      overlaysFromEntry: entry.rowOverlays ? Object.keys(entry.rowOverlays).length : 0,
      overlaysApplied,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyEntryId, docRowsLength, historyItems]);

  // ── DB hydration of B-roll clips (Phase 2) ──────────────────────────────────
  //
  // When the doc is associated with a saved history entry, sweep
  // `broll_clips` for every clip tagged with that doc's id and bridge
  // them into state. Closes the cross-device / cleared-localStorage gap
  // Phase 1's per-cell mount-hydration couldn't cover. Runs once per
  // (historyEntryId, doc.rows-length) combination — once per page mount
  // for typical usage, plus once more if the user clicks a different
  // history entry.
  //
  // Idempotent with Phase 1's per-cell hydration: `handleBrollClipChange`
  // no-ops when the new entry equals the existing one. See plan
  // `_plans/2026-05-17-broll-doc-id-hydration.md`.
  useEffect(() => {
    if (!historyEntryId || !doc?.rows?.length) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/broll?productionDocId=${encodeURIComponent(historyEntryId)}&limit=200`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          console.warn('[broll db-hydrate] list failed', { status: res.status, historyEntryId });
          return;
        }
        const data = (await res.json()) as { clips?: import('@/lib/broll-types').BrollClipRow[] };
        if (cancelled || !data.clips?.length) {
          console.info('[broll db-hydrate]', { historyEntryId, fetched: 0, applied: 0, skipped: 0 });
          return;
        }

        // Build a signature → rowIndex lookup for the CURRENT doc. Clips
        // whose stored row_signature doesn't match (e.g. user edited the
        // visual_description after generation) are skipped; they remain
        // in the workspace clip library but aren't auto-attached.
        const sigToIndex = new Map<string, number>();
        doc.rows.forEach((row, i) => {
          const sig = brollRowSignatureInput({
            timecode: row.timecode,
            visual_description: row.visual_description,
          });
          sigToIndex.set(sig, i);
        });

        // The DB query returns rows ordered by created_at DESC, so the
        // first clip we see for any signature is the freshest. Skip
        // duplicates to avoid clobbering with an older replay.
        const seen = new Set<string>();
        const lsMap = readBrollLsMap();
        const stubAdditions: Record<number, import('@/lib/broll-types').BrollClipRow> = {};
        let applied = 0;
        let skippedNoSig = 0;
        let skippedSigMismatch = 0;

        for (const clip of data.clips) {
          if (!clip.row_signature) { skippedNoSig++; continue; }
          if (seen.has(clip.row_signature)) continue;
          seen.add(clip.row_signature);
          const idx = sigToIndex.get(clip.row_signature);
          if (idx === undefined) { skippedSigMismatch++; continue; }

          // Bridge to parent state — drives the renderer.
          handleBrollClipChange(idx, {
            status: clip.status,
            video_url: clip.video_url,
            duration_seconds: clip.duration_seconds,
          });
          // Hand to the cell as initialClip so its own UI reflects the
          // clip immediately (avoids the cell briefly showing 'idle'
          // after a successful hydration).
          stubAdditions[idx] = clip;
          // Seed the per-cell localStorage map so the next page mount
          // can take the faster per-cell path even without re-querying.
          lsMap[clip.row_signature] = clip.id;
          applied++;
        }

        if (cancelled) return;
        if (Object.keys(stubAdditions).length > 0) {
          setRowBatchStubs((prev) => ({ ...prev, ...stubAdditions }));
        }
        writeBrollLsMap(lsMap);
        console.info('[broll db-hydrate]', {
          historyEntryId,
          fetched: data.clips.length,
          applied,
          skippedNoSig,
          skippedSigMismatch,
        });
      } catch (err) {
        console.warn('[broll db-hydrate] threw', err instanceof Error ? err.message : err);
      }
    })();
    return () => { cancelled = true; };
    // We deliberately only re-run when the doc identity (historyEntryId)
    // or its row count changes — NOT on every row edit. Editing a row's
    // text shouldn't re-sweep the DB; the per-cell localStorage map and
    // existing state already track the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyEntryId, docRowsLength]);

  /**
   * Phase 0 telemetry probe (shot-graph editor plan + overlay-system
   * overhaul plan). Fire-and-forget POST to /api/editor-telemetry; never
   * blocks the caller, never throws into the UI. A failed insert is a
   * logged warning server-side — the calling flow continues regardless.
   */
  async function recordEditorTelemetry(
    event:
      | 'render_clicked'
      | 'external_edit_intent'
      | 'stayed_here'
      | 'overlay_drag'
      | 'overlay_resize'
      | 'overlay_accept'
      | 'overlay_reset'
      | 'overlay_rethink',
    extra: { payload?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      console.info('[editor telemetry] post', { event, projectId: historyEntryId });
      await fetch('/api/editor-telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          project_id: historyEntryId,
          payload: extra.payload ?? null,
        }),
      });
    } catch (err) {
      console.warn('[editor telemetry] post failed', {
        event,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Entry point for the Render button. Runs the missing-clips
   * preflight: if any row has a generated clip in localStorage but
   * NOT in state, opens `MissingClipsModal` and aborts. The modal
   * either reloads the clips (then continues) or asks for explicit
   * confirmation to render anyway. When nothing's missing, falls
   * straight through to `executeRender`.
   */
  async function startVideoRender() {
    if (!doc) return;
    // Phase 0: record render-click intent regardless of whether the
    // missing-clips preflight short-circuits. Captures the moment
    // the creator commits to rendering — the survey on `done` then
    // tells us whether they plan to finish here or elsewhere.
    setRenderSurveyDismissed(false);
    void recordEditorTelemetry('render_clicked', {
      payload: {
        shot_count: doc.rows.length,
        has_voiceover: Boolean(voiceoverUrl),
        has_overlays: Object.values(rowOverlays).some(Boolean),
        animate_scenes: animateScenes,
      },
    });
    const missing = findMissingClipsForRender();
    console.info('[render preflight]', {
      missingClipCount: missing.length,
      rowIndexes: missing.map(m => m.rowIndex),
    });
    if (missing.length > 0) {
      setMissingClipsModal({ missing, reloading: false });
      return;
    }
    await executeRender();
  }

  /**
   * The actual render submission. Extracted from `startVideoRender` so
   * the missing-clips gate can call it after the user reloads or
   * explicitly bypasses the warning. Reads the LATEST `rowVideoClips` /
   * `rowImages` / `rowOverlays` from state at call time (closure over
   * the most recent render), so a reload that just bridged clips into
   * state lands in the config we send to the server.
   */
  async function executeRender() {
    if (!doc) return;
    // Read asset state through refs so a post-reload call (after the
    // missing-clips modal bridged fresh clips into state) sees the
    // committed values instead of the closure's stale snapshot. See
    // `_plans/2026-05-17-render-state-hardening.md`.
    const liveRowVideoClips = rowVideoClipsRef.current;
    const liveRowImages = rowImagesRef.current;
    const liveRowOverlays = rowOverlaysRef.current;
    const rowClipsArr = doc.rows.map((_, i) => liveRowVideoClips[i] ?? null);
    const rowLockedArr = doc.rows.map((row) =>
      Boolean(
        rowLockSignatures[
          brollRowSignatureInput({ timecode: row.timecode, visual_description: row.visual_description })
        ],
      ),
    );
    const config = productionDocToVideoConfig(doc, liveRowImages, {
      voiceoverUrl: voiceoverUrl || undefined,
      brand: effectiveBrandKit,
      rowVideoClips: rowClipsArr,
      rowLockedAsStill: rowLockedArr,
      animateScenes,
      rowOverlays: liveRowOverlays,
      suppressLowerThirds,
    });
    // One-shot diagnostic so a post-mortem can see exactly what the
    // server received. Lists per-row presence of imageUrl + videoUrl so
    // the "rendered MP4 had no animations" mystery is debuggable.
    console.info('[render config built]', {
      shotCount: config.shots.length,
      suppressLowerThirds: config.suppressLowerThirds,
      sceneFadeEnabled: config.sceneFadeEnabled,
      animateScenes,
      rows: config.shots.map((s, i) => ({
        i,
        hasImage: Boolean(s.imageUrl),
        hasVideo: Boolean(s.videoUrl),
        sceneType: s.sceneType,
        hasOst: Boolean(s.onScreenText),
      })),
    });
    setRenderStatus('rendering');
    setRenderProgress(0);
    setRenderDownloadUrl(null);

    // Pass the alignment hint when the cache is warm AND the URL is a
    // proxy path the server-side route accepts. Falsy `voiceoverUrl`,
    // ElevenLabs-direct Blob URLs, and any non-ready alignment state
    // make the server fall back to estimated timing — same as today.
    //
    // `title` is cosmetic — only used to build the Download filename.
    // Falls back to the renderId server-side when missing.
    const body: Record<string, unknown> = { config, title: doc.title || null };
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
            status: string; progress: number; downloadUrl?: string | null; error?: string;
          };

          setRenderProgress(statusData.progress ?? 0);

          if (statusData.status === 'done') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('done');
            setRenderDownloadUrl(statusData.downloadUrl ?? null);
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
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Production Document
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Generate a shot-by-shot breakdown with timecodes, visuals, auto-generated AI images, and Google Images links
          </p>
        </div>
        {/* New session — explicit, confirmation-gated. The form inputs
            (script, niche, topic, etc.) and the generated doc otherwise
            persist across refreshes; this button is how the user opts
            into a clean slate instead of getting one by accident. */}
        <button
          type="button"
          onClick={resetSession}
          className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-secondary)',
            border: '1px solid rgba(255,255,255,0.10)',
            cursor: 'pointer',
          }}
          title="Clear the current form and generated doc to start fresh. Previous generations stay in the history sidebar."
        >
          🆕 New session
        </button>
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
                // ⭐ is filled when this style is the user's persistent
                // default for new sessions. Clicking the star toggles it
                // — clicking the empty star promotes that style; clicking
                // the filled star clears the default (back to library).
                const isUserDefault = userDefaultStyle === p.id;
                return (
                  <div key={p.id} className="inline-flex items-stretch">
                    <button
                      onClick={() => setStylePreset(p.id)}
                      className="px-3 py-1.5 rounded-l-lg text-xs font-medium transition-all flex items-center gap-1.5"
                      style={{
                        background: active ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.05)',
                        color: active ? '#a78bfa' : 'var(--text-secondary)',
                        border: active ? '1px solid rgba(124,58,237,0.4)' : '1px solid var(--border)',
                        borderRight: 'none',
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
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isUserDefault) {
                          // Clear → library fallback
                          setStyleAsDefault('');
                          setUserDefaultStyle('');
                        } else {
                          setStyleAsDefault(p.id);
                        }
                      }}
                      className="px-2 py-1.5 rounded-r-lg text-xs flex items-center"
                      style={{
                        background: active ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.05)',
                        color: isUserDefault ? '#fbbf24' : 'var(--text-muted)',
                        border: active ? '1px solid rgba(124,58,237,0.4)' : '1px solid var(--border)',
                      }}
                      title={
                        isUserDefault
                          ? 'This is your default style for new sessions. Click to clear.'
                          : 'Make this your default style for new sessions.'
                      }
                      aria-label={isUserDefault ? 'Clear default style' : 'Set as default style'}
                    >
                      {isUserDefault ? '★' : '☆'}
                    </button>
                  </div>
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
              Generating AI images with {getImageModelSpec(imageModel)?.label ?? 'the selected model'}…
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

          {/* Scene timing — per-doc override for minimum scene duration
              and tail buffer after narration. Defaults are the workspace's
              if set, otherwise the system defaults. See
              `_plans/2026-05-17-scene-min-duration-and-tail-buffer.md`. */}
          <SceneTimingControl
            minSceneMs={doc.min_scene_ms}
            tailBufferMs={doc.tail_buffer_ms}
            onChange={setSceneTiming}
          />

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

          {/* Media status bar — always-visible succeeded/failed counters for
              this doc's still images and B-roll animations, plus one-click
              "Retry failed" buttons that batch the failed rows sequentially.
              Image retries use the user's selected image model; video retries
              use the user's current default B-roll model (same as Animate all).
              Both retry buttons are disabled when nothing has failed. */}
          <div className="mb-4 flex flex-wrap items-stretch gap-3">
            {/* Images cell */}
            <div
              className="flex-1 min-w-[260px] flex items-center gap-3 px-3 py-2 rounded-lg"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              <span className="text-base" aria-hidden>📷</span>
              <div className="flex flex-col leading-tight flex-1 min-w-0">
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  Images
                </span>
                <div className="flex items-center gap-2 text-[11px]">
                  <span style={{ color: '#4ade80' }} title="Stills generated successfully">
                    {imageStats.succeeded}✓
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <span
                    style={{ color: imageStats.failed > 0 ? '#f87171' : 'var(--text-muted)' }}
                    title="Stills that failed to generate"
                  >
                    {imageStats.failed}✗
                  </span>
                </div>
              </div>
              {retryingImages ? (
                <div className="flex items-center gap-2 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  Generating {retryingImages.done}/{retryingImages.total}…
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {/* Generate-empty: covers the common after-refresh case
                      where the sanitizer reset rows to idle. Sequential
                      pipeline shared with the failed-retry batch. */}
                  <button
                    type="button"
                    onClick={runGenerateEmptyImages}
                    disabled={emptyImagePlan.length === 0 || imagesGenerating}
                    className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                    style={{
                      background: emptyImagePlan.length === 0 ? 'rgba(120,120,120,0.10)' : 'rgba(168,85,247,0.18)',
                      color: emptyImagePlan.length === 0 ? 'var(--text-muted)' : '#c084fc',
                      border: '1px solid ' + (emptyImagePlan.length === 0 ? 'transparent' : 'rgba(168,85,247,0.45)'),
                      cursor: emptyImagePlan.length === 0 || imagesGenerating ? 'not-allowed' : 'pointer',
                    }}
                    title={
                      emptyImagePlan.length === 0
                        ? 'No empty rows with prompts to fill.'
                        : imagesGenerating
                          ? 'Initial image batch is still running — wait for it to finish.'
                          : `Generate stills for ${emptyImagePlan.length} empty row${emptyImagePlan.length === 1 ? '' : 's'} sequentially.`
                    }
                  >
                    ＋ Generate empty
                    {emptyImagePlan.length > 0 && (
                      <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {emptyImagePlan.length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={runRetryFailedImages}
                    disabled={failedImagePlan.length === 0 || imagesGenerating}
                    className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                    style={{
                      background: failedImagePlan.length === 0 ? 'rgba(120,120,120,0.10)' : 'rgba(6,182,212,0.18)',
                      color: failedImagePlan.length === 0 ? 'var(--text-muted)' : '#22d3ee',
                      border: '1px solid ' + (failedImagePlan.length === 0 ? 'transparent' : 'rgba(6,182,212,0.45)'),
                      cursor: failedImagePlan.length === 0 || imagesGenerating ? 'not-allowed' : 'pointer',
                    }}
                    title={
                      failedImagePlan.length === 0
                        ? 'No failed images to retry.'
                        : imagesGenerating
                          ? 'Initial image batch is still running — wait for it to finish.'
                          : `Re-run ${failedImagePlan.length} failed image generation${failedImagePlan.length === 1 ? '' : 's'} one by one.`
                    }
                  >
                    ↻ Retry failed
                    {failedImagePlan.length > 0 && (
                      <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {failedImagePlan.length}
                      </span>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Videos cell */}
            <div
              className="flex-1 min-w-[260px] flex items-center gap-3 px-3 py-2 rounded-lg"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              <span className="text-base" aria-hidden>🎬</span>
              <div className="flex flex-col leading-tight flex-1 min-w-0">
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  Animations
                </span>
                <div className="flex items-center gap-2 text-[11px]">
                  <span style={{ color: '#4ade80' }} title="Animations generated successfully">
                    {videoStats.succeeded}✓
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <span
                    style={{ color: videoStats.failed > 0 ? '#f87171' : 'var(--text-muted)' }}
                    title="Animations that failed to generate"
                  >
                    {videoStats.failed}✗
                  </span>
                </div>
              </div>
              {retryingVideos ? (
                <div className="flex items-center gap-2 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  Retrying {retryingVideos.done}/{retryingVideos.total}…
                </div>
              ) : (
                <button
                  type="button"
                  onClick={runRetryFailedVideos}
                  disabled={failedVideoPlan.length === 0 || !animateScenes || Boolean(animatingAll)}
                  className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                  style={{
                    background: failedVideoPlan.length === 0 || !animateScenes ? 'rgba(120,120,120,0.10)' : 'rgba(168,85,247,0.18)',
                    color: failedVideoPlan.length === 0 || !animateScenes ? 'var(--text-muted)' : '#c084fc',
                    border: '1px solid ' + (failedVideoPlan.length === 0 || !animateScenes ? 'transparent' : 'rgba(168,85,247,0.45)'),
                    cursor: failedVideoPlan.length === 0 || !animateScenes || animatingAll ? 'not-allowed' : 'pointer',
                  }}
                  title={
                    !animateScenes
                      ? 'Animations are disabled — turn on "Animate scenes" first.'
                      : failedVideoPlan.length === 0
                        ? 'No failed animations to retry.'
                        : animatingAll
                          ? 'Animate-all batch is in flight — wait for it to finish.'
                          : `Re-run ${failedVideoPlan.length} failed animation${failedVideoPlan.length === 1 ? '' : 's'} for ~$${retryVideosCostUsd.toFixed(2)}.`
                  }
                >
                  ↻ Retry failed
                  {failedVideoPlan.length > 0 && (
                    <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {failedVideoPlan.length} · ~${retryVideosCostUsd.toFixed(2)}
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Lower-third suppression toggle. Off by default (overlay
              shown); flip ON when the OST is already baked into the AI
              image and the Remotion overlay would duplicate it. */}
          <div className="mb-3 flex flex-wrap items-center gap-3 px-4 py-2 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={toggleSuppressLowerThirds}
              role="switch"
              aria-checked={suppressLowerThirds}
              className="relative inline-flex items-center rounded-full transition-colors"
              style={{
                width: 36,
                height: 20,
                background: suppressLowerThirds ? 'rgba(168,85,247,0.45)' : 'rgba(120,120,120,0.35)',
              }}
              title={
                suppressLowerThirds
                  ? 'On-screen text overlay is hidden — the image carries its own baked text.'
                  : 'On-screen text overlay shown — click to hide it (use when OST is already in the image).'
              }
            >
              <span
                className="inline-block rounded-full bg-white transition-transform"
                style={{
                  width: 14,
                  height: 14,
                  transform: `translateX(${suppressLowerThirds ? 18 : 4}px)`,
                }}
              />
            </button>
            <div className="flex flex-col leading-tight flex-1 min-w-[220px]">
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Hide on-screen text overlay
              </span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {suppressLowerThirds
                  ? 'Renderer skips the lower-third band — only the image’s baked text appears.'
                  : 'Renderer adds a lower-third band with the row’s on_screen_text on top of the image.'}
              </span>
            </div>
          </div>

          {/* Animate-scenes master toggle. When OFF, B-roll buttons are
              hidden on every row and the renderer falls back to stills with
              Ken Burns motion (today's pre-animation behaviour). Adjacent
              "Animate all" button drives a sequential batch over every
              eligible row (has still, not locked, not already in flight). */}
          <div className="mb-4 flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={toggleAnimateScenes}
              role="switch"
              aria-checked={animateScenes}
              className="relative inline-flex items-center rounded-full transition-colors"
              style={{
                width: 36,
                height: 20,
                background: animateScenes ? 'rgba(168,85,247,0.45)' : 'rgba(120,120,120,0.35)',
              }}
              title={animateScenes ? 'Animations enabled — click to use stills only' : 'Stills only — click to enable animations'}
            >
              <span
                className="inline-block rounded-full bg-white transition-transform"
                style={{
                  width: 14,
                  height: 14,
                  transform: `translateX(${animateScenes ? 18 : 4}px)`,
                }}
              />
            </button>
            <div className="flex flex-col leading-tight flex-1 min-w-[220px]">
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Animate scenes
              </span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {animateScenes
                  ? 'Per-row B-roll buttons are visible; rendered video uses any generated clips.'
                  : 'B-roll generation is hidden and the rendered video uses stills with Ken Burns motion (pre-animation behaviour).'}
              </span>
            </div>
            {animateScenes && (
              animatingAll ? (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  Animating {animatingAll.done}/{animatingAll.total}…
                </div>
              ) : (
                <button
                  type="button"
                  onClick={runAnimateAll}
                  disabled={animateAllPlan.length === 0}
                  className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                  style={{
                    background: animateAllPlan.length === 0 ? 'rgba(120,120,120,0.10)' : 'rgba(168,85,247,0.18)',
                    color: animateAllPlan.length === 0 ? 'var(--text-muted)' : '#c084fc',
                    border: '1px solid ' + (animateAllPlan.length === 0 ? 'transparent' : 'rgba(168,85,247,0.45)'),
                    cursor: animateAllPlan.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                  title={
                    animateAllPlan.length === 0
                      ? 'No eligible rows: every row is locked, already generating, already ready, or has no still image yet.'
                      : `Animate ${animateAllPlan.length} row${animateAllPlan.length === 1 ? '' : 's'} for ~$${animateAllCostUsd.toFixed(2)}`
                  }
                >
                  ▶ Animate all
                  {animateAllPlan.length > 0 && (
                    <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {animateAllPlan.length} row{animateAllPlan.length === 1 ? '' : 's'} · ~${animateAllCostUsd.toFixed(2)}
                    </span>
                  )}
                </button>
              )
            )}
          </div>

          {/* Doc-level scene-fade toggle. On = the historical cross-fade
              between every shot (and the opening fade-in / closing fade-out
              on the first/last shot). Off = hard cut everywhere. Per-row
              pills in the Section column can override individual rows.
              See _plans/2026-05-17-scene-transition-controls.md. */}
          {(() => {
            const fadeOn = doc.scene_fade_enabled !== false;
            return (
              <div className="mb-4 flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <button
                  type="button"
                  onClick={() => setSceneFadeEnabled(!fadeOn)}
                  role="switch"
                  aria-checked={fadeOn}
                  className="relative inline-flex items-center rounded-full transition-colors"
                  style={{
                    width: 36,
                    height: 20,
                    background: fadeOn ? 'rgba(168,85,247,0.45)' : 'rgba(120,120,120,0.35)',
                  }}
                  title={
                    fadeOn
                      ? 'Cross-fade is on. Click to make every shot hard-cut instead.'
                      : 'Hard cuts are on. Click to restore the cross-fade between shots.'
                  }
                >
                  <span
                    className="inline-block rounded-full bg-white transition-transform"
                    style={{
                      width: 14,
                      height: 14,
                      transform: `translateX(${fadeOn ? 18 : 4}px)`,
                    }}
                  />
                </button>
                <div className="flex flex-col leading-tight flex-1 min-w-[220px]">
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    Scene fade between shots
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {fadeOn
                      ? 'Smooth fade in/out wraps every shot — and the very first frame fades in from black, the last fades out.'
                      : 'Hard cut between shots — the video starts and ends on its first/last frame with no fade-to-black.'}
                  </span>
                </div>
              </div>
            );
          })()}

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
                      // 'Section' column now always renders — hosts the
                      // scene-fade pill even when there's no thumbnail.
                      headerList.push('Section');
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
                        {/* Script text — when a leading `##` is present
                            we offer an inline "split as title card" form.
                            The user confirms the exact title text (since a
                            heading on the same line as the body has no
                            reliable computable end) and we extract that
                            into a new locked-as-still row. */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: 200, lineHeight: 1.5, borderRight: '1px solid var(--border)' }}>
                          {(() => {
                            const hasHeadingMarker = /^\s*##/.test(row.script_text);
                            // Pre-fill guess: the first 2 words after `##`.
                            // Two words is a sensible default for the common
                            // case ("The Escalation", "Phase One", "Day Three")
                            // and the user can extend in the input.
                            const guessMatch = row.script_text.match(/^\s*##\s*(\S+(?:\s+\S+){0,1})/);
                            const guess = guessMatch?.[1]?.trim() || '';
                            const isEditingThisRow = splittingRow?.rowIndex === i;
                            return (
                              <>
                                <div>{row.script_text}</div>
                                {isEditingThisRow ? (
                                  <div
                                    className="mt-1.5 flex flex-col gap-1.5 p-2 rounded"
                                    style={{
                                      background: 'rgba(34,211,238,0.08)',
                                      border: '1px solid rgba(34,211,238,0.35)',
                                    }}
                                  >
                                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                      Pick the title text to extract:
                                    </span>
                                    <input
                                      type="text"
                                      autoFocus
                                      value={splittingRow.titleDraft}
                                      onChange={(e) => setSplittingRow({ rowIndex: i, titleDraft: e.target.value })}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          const t = splittingRow.titleDraft.trim();
                                          if (t) { splitTitleCardFromRow(i, t); setSplittingRow(null); }
                                        }
                                        if (e.key === 'Escape') setSplittingRow(null);
                                      }}
                                      placeholder="Title text"
                                      style={{
                                        fontSize: 11,
                                        padding: '4px 6px',
                                        borderRadius: 4,
                                        background: 'rgba(0,0,0,0.25)',
                                        color: 'var(--text)',
                                        border: '1px solid rgba(255,255,255,0.10)',
                                        outline: 'none',
                                      }}
                                    />
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const t = splittingRow.titleDraft.trim();
                                          if (!t) return;
                                          splitTitleCardFromRow(i, t);
                                          setSplittingRow(null);
                                        }}
                                        disabled={!splittingRow.titleDraft.trim()}
                                        className="text-[10px] px-2 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(34,211,238,0.20)',
                                          color: '#22d3ee',
                                          border: '1px solid rgba(34,211,238,0.45)',
                                          cursor: splittingRow.titleDraft.trim() ? 'pointer' : 'not-allowed',
                                          fontWeight: 600,
                                        }}
                                      >
                                        Apply
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setSplittingRow(null)}
                                        className="text-[10px] px-2 py-0.5 rounded"
                                        style={{
                                          background: 'transparent',
                                          color: 'var(--text-muted)',
                                          border: '1px solid rgba(255,255,255,0.10)',
                                          cursor: 'pointer',
                                        }}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : hasHeadingMarker ? (
                                  <button
                                    type="button"
                                    onClick={() => setSplittingRow({ rowIndex: i, titleDraft: guess })}
                                    className="mt-1.5 text-[10px] px-2 py-0.5 rounded"
                                    style={{
                                      background: 'rgba(34,211,238,0.12)',
                                      color: '#22d3ee',
                                      border: '1px solid rgba(34,211,238,0.35)',
                                      cursor: 'pointer',
                                    }}
                                    title="Extract a title-card row from this script. You'll confirm the exact title text."
                                  >
                                    ✂ Split as title card…
                                  </button>
                                ) : null}
                              </>
                            );
                          })()}
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
                            canGenerate={Boolean(row.ai_image_prompt?.trim())}
                            onRetry={() => {
                              if (row.ai_image_prompt?.trim()) {
                                generateImageForRow(i, row.ai_image_prompt, {
                                  onScreenText: row.on_screen_text,
                                  sectionTitle: row.section_title,
                                  overlayStockTerms: row.overlay_stock_terms,
                                });
                              }
                            }}
                            onUpload={(file) => { void uploadImageForRow(i, file); }}
                            onUrlImport={(url) => { void importImageUrlForRow(i, url); }}
                            onEdit={() => setEditPanelRow(i)}
                          />
                        </td>
                        {/* B-roll (animation pipeline — Kling 2.5 turbo i2v by default) */}
                        <td style={{ padding: '8px 10px', width: 140, borderRight: '1px solid var(--border)', verticalAlign: 'middle', position: 'relative' }}>
                          {animateScenes ? (() => {
                            const sig = brollRowSignatureInput({
                              timecode: row.timecode,
                              visual_description: row.visual_description,
                            });
                            return (
                              <BrollCell
                                rowIndex={i}
                                rowSignature={sig}
                                productionDocId={historyEntryId}
                                sceneDurationMs={computeRowSceneDurationMs(i)}
                                visualDescription={row.visual_description}
                                aiImagePrompt={row.ai_image_prompt}
                                styleHint={stylePreset}
                                stillImageUrl={imgState.status === 'done' ? imgState.imageUrl : undefined}
                                initialClip={rowBatchStubs[i] ?? undefined}
                                lockedAsStill={Boolean(rowLockSignatures[sig])}
                                onToggleLockedAsStill={(locked) => toggleRowLock(sig, locked)}
                                onClipChange={(clip) =>
                                  handleBrollClipChange(
                                    i,
                                    clip ? { status: clip.status, video_url: clip.video_url, duration_seconds: clip.duration_seconds } : null,
                                  )
                                }
                              />
                            );
                          })() : (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              Animation off
                            </span>
                          )}
                        </td>
                        {/* AI prompt — click ✎ to edit inline. The textarea
                            commits to the row on Save; image regeneration
                            uses the new prompt next time the user clicks
                            the row's Image Retry / re-generate button. */}
                        <td style={{ padding: '8px 12px', maxWidth: 240, borderRight: '1px solid var(--border)' }}>
                          {editingPromptRow?.rowIndex === i ? (
                            <div className="flex flex-col gap-1">
                              <textarea
                                autoFocus
                                value={editingPromptRow.draft}
                                onChange={(e) => setEditingPromptRow({ rowIndex: i, draft: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') setEditingPromptRow(null);
                                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                    updateRow(i, { ai_image_prompt: editingPromptRow.draft });
                                    setEditingPromptRow(null);
                                  }
                                }}
                                rows={6}
                                style={{
                                  fontSize: 11,
                                  padding: '6px 8px',
                                  borderRadius: 4,
                                  background: 'rgba(0,0,0,0.25)',
                                  color: 'var(--text)',
                                  border: '1px solid rgba(34,211,238,0.35)',
                                  outline: 'none',
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  resize: 'vertical',
                                  lineHeight: 1.4,
                                }}
                              />
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    updateRow(i, { ai_image_prompt: editingPromptRow.draft });
                                    setEditingPromptRow(null);
                                  }}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{
                                    background: 'rgba(34,211,238,0.20)',
                                    color: '#22d3ee',
                                    border: '1px solid rgba(34,211,238,0.45)',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                  }}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingPromptRow(null)}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{
                                    background: 'transparent',
                                    color: 'var(--text-muted)',
                                    border: '1px solid rgba(255,255,255,0.10)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Cancel
                                </button>
                                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                  ⌘/Ctrl+Enter to save
                                </span>
                              </div>
                            </div>
                          ) : row.ai_image_prompt ? (
                            <div className="flex items-start gap-1">
                              <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', lineHeight: 1.5, flex: 1 }}>
                                {row.ai_image_prompt}
                              </span>
                              <div className="flex flex-col gap-0.5">
                                <CopyButton text={row.ai_image_prompt} />
                                <button
                                  type="button"
                                  onClick={() => setEditingPromptRow({ rowIndex: i, draft: row.ai_image_prompt })}
                                  className="text-[10px] px-1.5 py-0.5 rounded"
                                  style={{
                                    background: 'rgba(34,211,238,0.10)',
                                    color: '#22d3ee',
                                    border: '1px solid rgba(34,211,238,0.30)',
                                    cursor: 'pointer',
                                  }}
                                  title="Edit this prompt"
                                  aria-label="Edit AI prompt"
                                >
                                  ✎
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditingPromptRow({ rowIndex: i, draft: '' })}
                              className="text-[10px] px-2 py-0.5 rounded"
                              style={{
                                background: 'rgba(34,211,238,0.10)',
                                color: '#22d3ee',
                                border: '1px solid rgba(34,211,238,0.30)',
                                cursor: 'pointer',
                              }}
                            >
                              + Add prompt
                            </button>
                          )}
                        </td>
                        {/* Overlay (real-image composite) — shows the LLM's
                            planned terms plus the auto-fetch status pill.
                            The fetch fires alongside the row's image gen and
                            its result is composited at render time. */}
                        {showOverlayColumn && (
                          <td style={{ padding: '8px 12px', maxWidth: 160, borderRight: '1px solid var(--border)' }}>
                            {row.overlay_stock_terms?.trim() ? (
                              <OverlayCell
                                terms={row.overlay_stock_terms}
                                zone={row.overlay_zone}
                                size={row.overlay_size}
                                state={rowOverlays[i]}
                                onRetry={() => fetchOverlayForRow(i, row.overlay_stock_terms!.trim())}
                                onOpenPositionEditor={() => setOverlayPositionRow(i)}
                                hasManualPosition={Boolean(row.overlay_position)}
                                onRethink={() => { void rethinkOverlayPlacement(i); }}
                                isRethinking={rethinkingRows.has(i)}
                                rethinkExhausted={(rethinkAttempts[i] ?? 0) >= RETHINK_MAX_ATTEMPTS}
                                onEditImage={() => setOverlayEditRow(i)}
                                onUndoEdit={() => undoOverlayEdit(i)}
                                canUndoEdit={(row.overlay_edit_history?.length ?? 0) > 0}
                                onShowContextMenu={(x, y) =>
                                  setOverlayContextMenu({ rowIndex: i, x, y })
                                }
                              />
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
                        {/* Section column — always rendered now. Hosts the
                            thumbnail-zoom controls (only when a thumbnail
                            exists) AND the per-row scene-fade pill (always),
                            so every row stays controllable. */}
                        <td style={{ padding: '8px 10px', width: 170, verticalAlign: 'top' }}>
                          <SectionRowControls
                            rowIndex={i}
                            totalRows={doc.rows.length}
                            thumbnail={doc.thumbnail}
                            zoomTo={row.thumbnail_zoom_to}
                            sectionTitle={row.section_title}
                            sectionTitleLayout={row.section_title_layout}
                            sectionTitleLayoutDefault={doc.section_title_layout_default}
                            pillarboxColor={row.pillarbox_color}
                            pillarboxColorDefault={doc.pillarbox_color_default}
                            sceneZoom={row.scene_zoom}
                            sceneZoomDefault={doc.scene_zoom_default}
                            transition={row.thumbnail_transition}
                            defaultTransition={doc.thumbnail?.defaultTransition}
                            sceneFade={row.scene_fade}
                            sceneFadeDefault={doc.scene_fade_enabled}
                            onChangeZoomTo={(id) => updateRow(i, { thumbnail_zoom_to: id })}
                            onChangeSectionTitle={(t) => updateRow(i, { section_title: t })}
                            onChangeSectionTitleLayout={(l) => updateRow(i, { section_title_layout: l })}
                            onChangePillarboxColor={(c) => updateRow(i, { pillarbox_color: c })}
                            onChangeTransition={(t) => updateRow(i, { thumbnail_transition: t })}
                            onChangeSceneFade={(next) => updateRow(i, { scene_fade: next })}
                            onApplyTitleToRange={applyTitleToRange}
                            onApplyPillarboxColorToAll={applyPillarboxColorToAll}
                            onClearPillarboxOverrides={clearPillarboxOverrides}
                            onApplyStripeLayoutToAll={applyStripeLayoutToAll}
                            onClearStripeLayoutOverrides={clearStripeLayoutOverrides}
                            onChangeSceneZoom={(z) => updateRow(i, { scene_zoom: z })}
                            onApplySceneZoomToAll={applySceneZoomToAll}
                            onClearSceneZoomOverrides={clearSceneZoomOverrides}
                            visualType={row.visual_type}
                            titleCardSourceText={(row.on_screen_text || row.script_text || '').trim()}
                            onApplyTitleCardAsSectionTitle={() => applyTitleCardAsSectionTitle(i)}
                          />
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
                          {(() => {
                            const hasHeadingMarker = /^\s*##/.test(row.script_text);
                            const guessMatch = row.script_text.match(/^\s*##\s*(\S+(?:\s+\S+){0,1})/);
                            const guess = guessMatch?.[1]?.trim() || '';
                            const isEditingThisRow = splittingRow?.rowIndex === i;
                            if (isEditingThisRow) {
                              return (
                                <div
                                  className="mt-1.5 flex flex-col gap-1.5 p-2 rounded"
                                  style={{ background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.35)' }}
                                >
                                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    Pick the title text to extract:
                                  </span>
                                  <input
                                    type="text"
                                    autoFocus
                                    value={splittingRow.titleDraft}
                                    onChange={(e) => setSplittingRow({ rowIndex: i, titleDraft: e.target.value })}
                                    placeholder="Title text"
                                    style={{
                                      fontSize: 11,
                                      padding: '4px 6px',
                                      borderRadius: 4,
                                      background: 'rgba(0,0,0,0.25)',
                                      color: 'var(--text)',
                                      border: '1px solid rgba(255,255,255,0.10)',
                                      outline: 'none',
                                    }}
                                  />
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const t = splittingRow.titleDraft.trim();
                                        if (!t) return;
                                        splitTitleCardFromRow(i, t);
                                        setSplittingRow(null);
                                      }}
                                      disabled={!splittingRow.titleDraft.trim()}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(34,211,238,0.20)',
                                        color: '#22d3ee',
                                        border: '1px solid rgba(34,211,238,0.45)',
                                        cursor: splittingRow.titleDraft.trim() ? 'pointer' : 'not-allowed',
                                        fontWeight: 600,
                                      }}
                                    >
                                      Apply
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setSplittingRow(null)}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'transparent',
                                        color: 'var(--text-muted)',
                                        border: '1px solid rgba(255,255,255,0.10)',
                                        cursor: 'pointer',
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              );
                            }
                            if (!hasHeadingMarker) return null;
                            return (
                              <button
                                type="button"
                                onClick={() => setSplittingRow({ rowIndex: i, titleDraft: guess })}
                                className="mt-1.5 text-[10px] px-2 py-0.5 rounded"
                                style={{
                                  background: 'rgba(34,211,238,0.12)',
                                  color: '#22d3ee',
                                  border: '1px solid rgba(34,211,238,0.35)',
                                  cursor: 'pointer',
                                }}
                              >
                                ✂ Split as title card…
                              </button>
                            );
                          })()}
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Visual</p>
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.visual_description}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Image</p>
                          <ImageCell
                            state={imgState}
                            canGenerate={Boolean(row.ai_image_prompt?.trim())}
                            onRetry={() => row.ai_image_prompt?.trim() && generateImageForRow(i, row.ai_image_prompt, {
                              onScreenText: row.on_screen_text,
                              sectionTitle: row.section_title,
                              overlayStockTerms: row.overlay_stock_terms,
                            })}
                            onUpload={(file) => { void uploadImageForRow(i, file); }}
                            onUrlImport={(url) => { void importImageUrlForRow(i, url); }}
                            onEdit={() => setEditPanelRow(i)}
                          />
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>B-roll</p>
                          {animateScenes ? (() => {
                            const sig = brollRowSignatureInput({
                              timecode: row.timecode,
                              visual_description: row.visual_description,
                            });
                            return (
                              <BrollCell
                                rowIndex={i}
                                rowSignature={sig}
                                productionDocId={historyEntryId}
                                sceneDurationMs={computeRowSceneDurationMs(i)}
                                visualDescription={row.visual_description}
                                aiImagePrompt={row.ai_image_prompt}
                                styleHint={stylePreset}
                                stillImageUrl={imgState.status === 'done' ? imgState.imageUrl : undefined}
                                initialClip={rowBatchStubs[i] ?? undefined}
                                lockedAsStill={Boolean(rowLockSignatures[sig])}
                                onToggleLockedAsStill={(locked) => toggleRowLock(sig, locked)}
                                onClipChange={(clip) =>
                                  handleBrollClipChange(
                                    i,
                                    clip ? { status: clip.status, video_url: clip.video_url, duration_seconds: clip.duration_seconds } : null,
                                  )
                                }
                              />
                            );
                          })() : (
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              Animation off (stills only)
                            </span>
                          )}
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
                            <OverlayCell
                              terms={row.overlay_stock_terms}
                              zone={row.overlay_zone}
                              size={row.overlay_size}
                              state={rowOverlays[i]}
                              onRetry={() => fetchOverlayForRow(i, row.overlay_stock_terms!.trim())}
                              onOpenPositionEditor={() => setOverlayPositionRow(i)}
                              hasManualPosition={Boolean(row.overlay_position)}
                              onRethink={() => { void rethinkOverlayPlacement(i); }}
                              isRethinking={rethinkingRows.has(i)}
                              rethinkExhausted={(rethinkAttempts[i] ?? 0) >= RETHINK_MAX_ATTEMPTS}
                              onEditImage={() => setOverlayEditRow(i)}
                              onUndoEdit={() => undoOverlayEdit(i)}
                              canUndoEdit={(row.overlay_edit_history?.length ?? 0) > 0}
                              onShowContextMenu={(x, y) =>
                                setOverlayContextMenu({ rowIndex: i, x, y })
                              }
                            />
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
                        <div>
                          <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Section</p>
                          <SectionRowControls
                            rowIndex={i}
                            totalRows={doc.rows.length}
                            thumbnail={doc.thumbnail}
                            zoomTo={row.thumbnail_zoom_to}
                            sectionTitle={row.section_title}
                            sectionTitleLayout={row.section_title_layout}
                            sectionTitleLayoutDefault={doc.section_title_layout_default}
                            pillarboxColor={row.pillarbox_color}
                            pillarboxColorDefault={doc.pillarbox_color_default}
                            sceneZoom={row.scene_zoom}
                            sceneZoomDefault={doc.scene_zoom_default}
                            transition={row.thumbnail_transition}
                            defaultTransition={doc.thumbnail?.defaultTransition}
                            sceneFade={row.scene_fade}
                            sceneFadeDefault={doc.scene_fade_enabled}
                            onChangeZoomTo={(id) => updateRow(i, { thumbnail_zoom_to: id })}
                            onChangeSectionTitle={(t) => updateRow(i, { section_title: t })}
                            onChangeSectionTitleLayout={(l) => updateRow(i, { section_title_layout: l })}
                            onChangePillarboxColor={(c) => updateRow(i, { pillarbox_color: c })}
                            onChangeTransition={(t) => updateRow(i, { thumbnail_transition: t })}
                            onChangeSceneFade={(next) => updateRow(i, { scene_fade: next })}
                            onApplyTitleToRange={applyTitleToRange}
                            onApplyPillarboxColorToAll={applyPillarboxColorToAll}
                            onClearPillarboxOverrides={clearPillarboxOverrides}
                            onApplyStripeLayoutToAll={applyStripeLayoutToAll}
                            onClearStripeLayoutOverrides={clearStripeLayoutOverrides}
                            onChangeSceneZoom={(z) => updateRow(i, { scene_zoom: z })}
                            onApplySceneZoomToAll={applySceneZoomToAll}
                            onClearSceneZoomOverrides={clearSceneZoomOverrides}
                            visualType={row.visual_type}
                            titleCardSourceText={(row.on_screen_text || row.script_text || '').trim()}
                            onApplyTitleCardAsSectionTitle={() => applyTitleCardAsSectionTitle(i)}
                          />
                        </div>
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
                  rowVideoClips={rowVideoClips}
                  rowOverlays={rowOverlays}
                  rowLockedAsStill={doc.rows.map((row) =>
                    Boolean(
                      rowLockSignatures[
                        brollRowSignatureInput({ timecode: row.timecode, visual_description: row.visual_description })
                      ],
                    ),
                  )}
                  animateScenes={animateScenes}
                  suppressLowerThirds={suppressLowerThirds}
                  voiceoverUrl={voiceoverUrl}
                  voiceoverAlignment={voiceoverAlignment}
                  brandKit={effectiveBrandKit}
                  onRender={startVideoRender}
                  isRendering={renderStatus === 'rendering'}
                  renderProgress={renderProgress}
                  downloadUrl={renderDownloadUrl}
                />

                {/* Open in the shot-graph editor (/edit/[projectId]).
                    The route gates on EDITOR_V1_ENABLED server-side
                    and 404s when off — we mirror with the client-side
                    NEXT_PUBLIC_EDITOR_V1_ENABLED so the button is
                    hidden too. Disabled until the doc has been saved
                    once (we need a historyEntryId to route against). */}
                {EDITOR_V1_PUBLIC && (
                  historyEntryId ? (
                    <a
                      href={`/edit/${encodeURIComponent(historyEntryId)}`}
                      className="w-full text-xs px-3 py-2 rounded border hover:bg-white/5 transition-colors flex items-center justify-center gap-1.5"
                      style={{ borderColor: 'var(--accent-purple-bright, #a78bfa)', color: 'var(--accent-purple-bright, #a78bfa)' }}
                      title="Open the shot-graph editor for this production doc"
                    >
                      Open in editor →
                    </a>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="w-full text-xs px-3 py-2 rounded border opacity-40 cursor-not-allowed"
                      style={{ borderColor: 'var(--card-border)' }}
                      title="Save the production doc first to open it in the editor"
                    >
                      Open in editor →
                    </button>
                  )
                )}

                {/* Dev-only: send to local Video Studio for advanced editing */}
                {process.env.NODE_ENV !== 'production' && (
                  <button
                    onClick={() => {
                      const rowClipsArr = doc.rows.map((_, i) => rowVideoClips[i] ?? null);
                      const rowLockedArr = doc.rows.map((row) =>
                        Boolean(
                          rowLockSignatures[
                            brollRowSignatureInput({ timecode: row.timecode, visual_description: row.visual_description })
                          ],
                        ),
                      );
                      const config = productionDocToVideoConfig(doc, rowImages, {
                        voiceoverUrl: voiceoverUrl || undefined,
                        brand: effectiveBrandKit,
                        rowVideoClips: rowClipsArr,
                        rowLockedAsStill: rowLockedArr,
                        animateScenes,
                        rowOverlays,
                        suppressLowerThirds,
                      });
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

                {/* Phase 0 telemetry: post-render finish-flow survey.
                    Drives the shot-graph editor build decision — see
                    _plans/2026-05-18-shot-graph-editor.md. One-tap,
                    dismissable, no nagging. */}
                {renderStatus === 'done' && !renderSurveyDismissed && (
                  <div
                    className="mt-3 p-3 rounded-lg border text-xs space-y-2"
                    style={{ borderColor: 'var(--card-border)', background: 'var(--card-bg)' }}
                  >
                    <p style={{ color: 'var(--fg)' }}>
                      Where will you finish this video?
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {([
                        { id: 'capcut',   label: 'CapCut' },
                        { id: 'premiere', label: 'Premiere' },
                        { id: 'other',    label: 'Other editor' },
                      ] as const).map(opt => (
                        <button
                          key={opt.id}
                          className="px-2.5 py-1 rounded border text-xs hover:bg-white/5 transition-colors"
                          style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
                          onClick={() => {
                            void recordEditorTelemetry('external_edit_intent', {
                              payload: { destination: opt.id },
                            });
                            setRenderSurveyDismissed(true);
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                      <button
                        className="px-2.5 py-1 rounded border text-xs hover:bg-white/5 transition-colors"
                        style={{ borderColor: 'var(--card-border)', color: 'var(--accent-purple-bright)' }}
                        onClick={() => {
                          void recordEditorTelemetry('stayed_here');
                          setRenderSurveyDismissed(true);
                        }}
                      >
                        Finishing here
                      </button>
                    </div>
                  </div>
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
            // Restore overlays + B-roll clip state if the entry carries
            // them. Older entries pre-date these fields — they fall back
            // to `{}` and the per-cell mount-hydration in BrollCell /
            // OverlayCell can rebuild from each cell's own localStorage
            // map. The earlier code unconditionally wiped both maps,
            // which dropped every generated asset the moment the user
            // clicked an entry in the sidebar. See plan
            // _plans/2026-05-17-render-state-hardening.md.
            const restoredOverlays = entry.rowOverlays && typeof entry.rowOverlays === 'object'
              ? entry.rowOverlays as Record<number, RowOverlayState>
              : {};
            setRowOverlays(restoredOverlays);
            // rowVideoClips is stored as { rowIndex → clipId }. We can't
            // restore the videoUrl directly (the entry doesn't carry it),
            // but seeding the cell with the clip id is enough — BrollCell's
            // mount-hydration will fetch `/api/broll/{id}`, see status:'ready',
            // and bridge to the parent via the now-fixed updateClip path.
            // For 'ready'-status rows the renderer also needs the videoUrl
            // up front, so we leave the per-row entries empty here and
            // rely on the hydrate-on-mount round trip. The pre-render
            // verification (see plan) will block render if any clip id
            // from the entry didn't land in state by the time the user
            // clicks Render.
            setRowVideoClips({});
            console.info('[history restore]', {
              entryId: entry.id,
              hadImages: Boolean(entry.rowImages),
              hadOverlays: Boolean(entry.rowOverlays),
              hadClips: Boolean(entry.rowVideoClips),
              clipCount: entry.rowVideoClips ? Object.keys(entry.rowVideoClips).length : 0,
            });
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
            setRowOverlays({});
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

      {/* Pre-render verification gate. Mounted only when a render
          attempt found B-roll clips in localStorage that weren't in
          state. The modal handles its own reload pipeline; on full
          success it triggers `executeRender` directly, otherwise the
          user can explicitly accept a stills-only render or cancel.
          See `_plans/2026-05-17-render-state-hardening.md`. */}
      {overlayPositionRow !== null && doc?.rows[overlayPositionRow] && rowOverlays[overlayPositionRow]?.status === 'done' && rowOverlays[overlayPositionRow]?.url && (
        <OverlayPositionEditor
          stillImageUrl={rowImages[overlayPositionRow]?.imageUrl}
          overlayUrl={rowOverlays[overlayPositionRow]!.url!}
          position={doc.rows[overlayPositionRow]!.overlay_position}
          sizePct={doc.rows[overlayPositionRow]!.overlay_size_pct}
          stretchedHeightPct={doc.rows[overlayPositionRow]!.overlay_stretched_height_pct}
          termsLabel={doc.rows[overlayPositionRow]!.overlay_stock_terms || ''}
          placementReason={doc.rows[overlayPositionRow]!.overlay_placement_reason}
          placementModel={doc.rows[overlayPositionRow]!.overlay_placement_model}
          onRethink={() => { void rethinkOverlayPlacement(overlayPositionRow); }}
          isRethinking={rethinkingRows.has(overlayPositionRow)}
          rethinkExhausted={(rethinkAttempts[overlayPositionRow] ?? 0) >= RETHINK_MAX_ATTEMPTS}
          onEditImage={() => setOverlayEditRow(overlayPositionRow)}
          onSave={(pos, size, stretchedH) => {
            console.info('[ui overlay-position] saved', {
              rowIndex: overlayPositionRow,
              pos,
              size,
              stretchedH,
            });
            // Baseline telemetry — see plan-2026-05-18-overlay-system-overhaul.
            // Position changes fire `overlay_drag`; size/stretch changes fire
            // `overlay_resize`. Both may fire on the same save when the user
            // dragged and resized in the same session. placement_model is
            // hardcoded to 'doc-gen-blind' until Phase 2 introduces vision-
            // aware placement that writes a different model id onto the row.
            const prev = doc?.rows[overlayPositionRow]?.overlay_position;
            const prevSize = doc?.rows[overlayPositionRow]?.overlay_size_pct;
            const prevStretchedH = doc?.rows[overlayPositionRow]?.overlay_stretched_height_pct;
            const positionChanged =
              !prev || prev.x_pct !== pos.x_pct || prev.y_pct !== pos.y_pct;
            const sizeChanged = prevSize !== size;
            const stretchChanged = (prevStretchedH ?? null) !== stretchedH;
            const dx = prev ? pos.x_pct - prev.x_pct : 0;
            const dy = prev ? pos.y_pct - prev.y_pct : 0;
            const dragDistancePct = Math.sqrt(dx * dx + dy * dy);
            if (positionChanged) {
              recordEditorTelemetry('overlay_drag', {
                payload: {
                  row_index: overlayPositionRow,
                  placement_model: 'doc-gen-blind',
                  prev_x_pct: prev?.x_pct ?? null,
                  prev_y_pct: prev?.y_pct ?? null,
                  prev_size_pct: prevSize ?? null,
                  new_x_pct: Number(pos.x_pct.toFixed(2)),
                  new_y_pct: Number(pos.y_pct.toFixed(2)),
                  new_size_pct: Number(size.toFixed(2)),
                  drag_distance_pct: Number(dragDistancePct.toFixed(2)),
                },
              });
            }
            if (sizeChanged || stretchChanged) {
              recordEditorTelemetry('overlay_resize', {
                payload: {
                  row_index: overlayPositionRow,
                  placement_model: 'doc-gen-blind',
                  prev_size_pct: prevSize ?? null,
                  new_size_pct: Number(size.toFixed(2)),
                  prev_stretched_height_pct: prevStretchedH ?? null,
                  new_stretched_height_pct:
                    stretchedH !== null ? Number(stretchedH.toFixed(2)) : null,
                  free_aspect_used: stretchedH !== null,
                },
              });
            }
            updateRow(overlayPositionRow, {
              overlay_position: pos,
              overlay_size_pct: size,
              overlay_stretched_height_pct: stretchedH ?? undefined,
            });
          }}
          onReset={() => {
            console.info('[ui overlay-position] reset', { rowIndex: overlayPositionRow });
            recordEditorTelemetry('overlay_reset', {
              payload: {
                row_index: overlayPositionRow,
                placement_model: 'doc-gen-blind',
              },
            });
            updateRow(overlayPositionRow, {
              overlay_position: undefined,
              overlay_size_pct: undefined,
              overlay_stretched_height_pct: undefined,
            });
          }}
          onClose={() => setOverlayPositionRow(null)}
        />
      )}

      {/* Phase 5 — AI image-edit dialog. Mounts on top of the position
          editor when the user clicks ✎ Edit image. On accept the
          row's overlay URL is swapped to the new R2 URL; the renderer's
          Phase 0 onLoad reads the natural aspect of the edited image
          and reshapes the container accordingly, so a square edit of a
          wide wordmark "just works" without any aspect tracking here. */}
      {overlayEditRow !== null &&
        doc?.rows[overlayEditRow] &&
        rowOverlays[overlayEditRow]?.status === 'done' &&
        rowOverlays[overlayEditRow]?.url && (
          <OverlayEditDialog
            overlayUrl={rowOverlays[overlayEditRow]!.url!}
            termsLabel={doc.rows[overlayEditRow]!.overlay_stock_terms || ''}
            onAccept={(newOverlayUrl, mode) => {
              // Push the about-to-be-replaced URL onto the row's edit
              // history so Undo can roll it back. Cap at 3 entries —
              // anything beyond gets shifted off the front (oldest is
              // dropped first).
              const replacedUrl = rowOverlays[overlayEditRow]?.url;
              const prevHistory = doc?.rows[overlayEditRow]?.overlay_edit_history ?? [];
              const nextHistory = replacedUrl
                ? [...prevHistory, replacedUrl].slice(-OVERLAY_EDIT_HISTORY_CAP)
                : prevHistory;
              console.info('[ui overlay-edit] accepted', {
                rowIndex: overlayEditRow,
                mode,
                newOverlayUrl,
                replacedUrl,
                historyDepthAfter: nextHistory.length,
              });
              updateRow(overlayEditRow, { overlay_edit_history: nextHistory });
              setRowOverlays((prev) => ({
                ...prev,
                [overlayEditRow]: {
                  ...prev[overlayEditRow],
                  status: 'done',
                  url: newOverlayUrl,
                },
              }));
            }}
            onClose={() => setOverlayEditRow(null)}
          />
        )}

      {/* Phase 5 — right-click context menu on the overlay cell. Items
          are computed against the live row so e.g. "Undo last edit"
          only appears when there's something to undo. Click on an
          item fires the same handler the inline button would. */}
      {overlayContextMenu &&
        doc?.rows[overlayContextMenu.rowIndex] &&
        (() => {
          const i = overlayContextMenu.rowIndex;
          const row = doc.rows[i]!;
          const overlayState = rowOverlays[i];
          const canUndo = (row.overlay_edit_history?.length ?? 0) > 0;
          return (
            <OverlayContextMenu
              x={overlayContextMenu.x}
              y={overlayContextMenu.y}
              onClose={() => setOverlayContextMenu(null)}
              items={[
                {
                  label: '✎ Edit image',
                  onClick: () => setOverlayEditRow(i),
                  disabled: overlayState?.status !== 'done',
                  title: 'Open the AI image-edit dialog (Smart edit or Brush mask)',
                },
                {
                  label: '↻ Rethink placement',
                  onClick: () => { void rethinkOverlayPlacement(i); },
                  disabled:
                    overlayState?.status !== 'done' ||
                    rethinkingRows.has(i) ||
                    (rethinkAttempts[i] ?? 0) >= RETHINK_MAX_ATTEMPTS,
                  title: 'Ask the AI for a new size + position on this overlay',
                },
                {
                  label: '🔁 Replace overlay (re-search)',
                  onClick: () => {
                    const terms = row.overlay_stock_terms?.trim();
                    if (terms) void fetchOverlayForRow(i, terms);
                  },
                  disabled: !row.overlay_stock_terms?.trim(),
                  title: 'Re-run Brave search + RMBG with the same stock terms (replaces the current overlay)',
                },
                {
                  label: '↶ Undo last edit',
                  onClick: () => undoOverlayEdit(i),
                  disabled: !canUndo,
                  separatorAbove: true,
                  title: canUndo
                    ? 'Restore the overlay state from before the most recent AI edit'
                    : 'No edits to undo yet',
                },
              ]}
            />
          );
        })()}

      {missingClipsModal && (
        <MissingClipsModal
          missing={missingClipsModal.missing}
          reloading={missingClipsModal.reloading}
          onReload={reloadMissingClips}
          onContinue={async () => {
            setMissingClipsModal(null);
            await executeRender();
          }}
          onRenderAnyway={async () => {
            console.info('[render skipped-reload]', {
              missingRowIndexes: missingClipsModal.missing.map(m => m.rowIndex),
            });
            setMissingClipsModal(null);
            await executeRender();
          }}
          onClose={() => setMissingClipsModal(null)}
          onMissingChange={(next) =>
            setMissingClipsModal((prev) => (prev ? { ...prev, missing: next } : prev))
          }
          onReloadingChange={(next) =>
            setMissingClipsModal((prev) => (prev ? { ...prev, reloading: next } : prev))
          }
        />
      )}
      {(() => {
        if (editPanelRow === null) return null;
        const idx = editPanelRow;
        const src = rowImages[idx]?.imageUrl;
        if (!src) return null;
        // While the brush modal is open AND no candidate result exists
        // yet, show the paint UI. Otherwise the EditPanel covers both
        // compose mode (initialResult === null) and review mode
        // (initialResult set after a smart apply or brush apply).
        if (editBrushOpen && !editResult) {
          return (
            <MaskBrushEditor
              sourceImageUrl={src}
              defaultQuality="medium"
              onCancel={() => setEditBrushOpen(false)}
              onApply={async ({ maskUrl, prompt, quality }) => {
                const r = await editImageForRow(idx, src, prompt, { mask: { url: maskUrl, quality } });
                if (r.ok) {
                  setEditResult({ imageUrl: r.imageUrl, saliency: r.saliency });
                  setEditBrushOpen(false);
                } else {
                  toast.error(r.error);
                }
              }}
            />
          );
        }
        return (
          <EditPanel
            sourceImageUrl={src}
            initialResult={editResult}
            onApply={(prompt) => editImageForRow(idx, src, prompt)}
            onUseThis={(imageUrl, saliency) => acceptEditForRow(idx, imageUrl, saliency)}
            onOpenBrush={() => setEditBrushOpen(true)}
            onClose={closeEditPanel}
          />
        );
      })()}
    </div>
    </ScheduleLinkProvider>
  );
}
