'use client';

/**
 * Flex Icon Grid format — UI component for the /thumbnails page.
 *
 * Deterministic-render flow (no AI image gen): the user assembles a
 * grid of cells via the editor, hits Render, and the server returns
 * a PNG composited from SVG + Sharp. See
 * `_plans/2026-05-28-flex-icon-grid-thumbnail-template.md` for the
 * full contract.
 *
 * UX (rule 10 + 16): progressive disclosure. The top of the panel
 * shows the high-frequency knobs (grid size, palette, default cell
 * shape). The live preview sits below. Clicking any cell opens an
 * inline side panel for that cell's content + per-cell overrides.
 * Advanced settings (label font, title bar, gradient backgrounds)
 * live behind a collapsible "Advanced" disclosure.
 *
 * State persistence: the panel owns its `FlexIconGridConfig` and
 * reports it up via `onDraftStateChange` so the parent page can
 * fold it into the workflow draft. Rendered results go through
 * `onResultChange` and land in history.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { downloadHref } from '@/lib/download-file';
import type { ThumbnailRegion } from '@/remotion/types';
import {
  ASPECT_RATIO_PRESETS,
  DEFAULT_SHADOW,
  STARTER_CELL_SHADOW,
  getSpanConflicts,
  makeDefaultConfig,
  parseConfig,
  transposeCells,
  validateConfig,
  type CellBackgroundSpec,
  type CellContent,
  type CellShape,
  type FlexIconCell,
  type FlexIconGridConfig,
  type LabelFont,
  type PaletteSpec,
  type SpanConflictReason,
} from '@/lib/thumbnail-formats/flex-icon-grid';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  ICON_REGISTRY,
  extractIconInner,
  getIconSvg,
  type IconCategory,
  type IconEntry,
} from '@/lib/thumbnail-formats/flex-icon-grid-icons';
import {
  generateRandomPalette,
  paletteColours,
  pickLabelColourFor,
  resolveCellBackgrounds,
  shiftPaletteLightness,
  shiftPaletteSaturation,
} from '@/lib/thumbnail-formats/flex-icon-grid-palettes';
import {
  DEFAULT_STICKER_STYLE,
  STICKER_STYLE_PRESETS,
} from '@/lib/thumbnail-formats/flex-icon-grid-sticker-styles';
import {
  fetchSavedPalettesCached,
  invalidateSavedPalettesCache,
} from '@/lib/flex-icon-grid-saved-palettes-client-cache';
import { customFontFamilyName } from '@/lib/thumbnail-formats/flex-icon-grid-font-family';
import {
  acquireCustomFont,
  releaseCustomFont,
} from '@/lib/thumbnail-formats/flex-icon-grid-font-registry';
import { FlexIconGridLivePreview } from './FlexIconGridLivePreview';
// Mobile-responsive overrides + bottom-sheet cell editor styles. Scoped
// to `[data-fg-panel]` descendants so the rules can't leak elsewhere.
import './FlexIconGridPanel.css';

// ─── Types mirroring the API contract ───────────────────────────────────────

export interface FlexIconGridGenerationResult {
  imageUrl: string;
  regions: ThumbnailRegion[];
  config: FlexIconGridConfig;
  outputWidth: number;
  outputHeight: number;
  /** Custom-font URLs whose fetch failed during this render. The
   *  panel surfaces them as a "font no longer available" banner so
   *  the user knows to re-upload (Phase 4.7 caveat fix). */
  fontWarnings?: string[];
}

export interface FlexIconGridDraftState {
  config: FlexIconGridConfig;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const GRID_PRESETS: { label: string; rows: number; cols: number }[] = [
  { label: '2×2', rows: 2, cols: 2 },
  { label: '2×3', rows: 2, cols: 3 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '3×4', rows: 3, cols: 4 },
  { label: '3×5', rows: 3, cols: 5 },
  { label: '4×4', rows: 4, cols: 4 },
  { label: '4×5', rows: 4, cols: 5 },
];

const SHAPE_OPTIONS: { value: CellShape; label: string; glyph: string }[] = [
  { value: 'circle', label: 'Circle', glyph: '●' },
  { value: 'square', label: 'Square', glyph: '■' },
  { value: 'rounded-square', label: 'Rounded', glyph: '▢' },
  { value: 'hexagon', label: 'Hexagon', glyph: '⬡' },
  { value: 'pill', label: 'Pill', glyph: '⬭' },
  { value: 'capsule', label: 'Capsule', glyph: '⬬' },
];

const FONT_OPTIONS: { value: LabelFont; label: string; sample: string }[] = [
  { value: 'anton', label: 'Anton', sample: 'CONDENSED' },
  { value: 'bowlby-one', label: 'Bowlby One', sample: 'ROUNDED' },
  { value: 'archivo-black', label: 'Archivo Black', sample: 'CLASSIC' },
  { value: 'patrick-hand', label: 'Patrick Hand', sample: 'Hand-drawn' },
  { value: 'custom', label: 'Custom upload', sample: 'TTF/OTF' },
];

const ALLOWED_FONT_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/octet-stream',
  'application/x-font-ttf',
  'application/x-font-opentype',
]);
const MAX_FONT_UPLOAD_BYTES = 5 * 1024 * 1024;

const PALETTE_OPTIONS: { value: PaletteSpec; label: string }[] = [
  { value: { type: 'preset', name: 'rainbow' }, label: 'Rainbow' },
  { value: { type: 'preset', name: 'pastel' }, label: 'Pastel' },
  { value: { type: 'preset', name: 'neon' }, label: 'Neon' },
  { value: { type: 'preset', name: 'monochrome' }, label: 'Monochrome' },
];

const CONTENT_TYPE_LABELS: Record<CellContent['type'], string> = {
  'icon-library': 'Icon',
  'emoji': 'Emoji',
  'upload': 'Upload',
  'text-only': 'Text only',
  'ai-sticker': 'AI sticker',
};

const MAX_CELL_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_CELL_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const STICKER_STYLE_PREF_KEY = 'flex_icon_grid_sticker_style';

/** Shape of one workspace-registered font as the API returns it
 *  (Phase 4.8b). Each list response mints fresh presigned downloadUrls
 *  so panels never carry stale URLs across sessions. */
interface WorkspaceFontEntry {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  downloadUrl: string;
  updated_at: string;
}

/** Shape of one workspace-saved palette as the API returns it. Lifted
 *  to module scope so both the eager-fetch state in the panel and the
 *  disclosure section share a single source of truth. */
interface SavedPaletteRecord {
  id: string;
  name: string;
  colors: string[];
  updated_at: string;
}

/** Quick-load chip count cap. The user's first N most-recent saved
 *  palettes surface as chips next to the named presets so they don't
 *  have to expand the disclosure to grab a familiar one. */
const SAVED_PALETTE_QUICK_LOAD_COUNT = 3;

/** Phase 4.21: sessionStorage key for the cell clipboard. Scoped
 *  to the flex-icon-grid format so a copy here doesn't collide
 *  with future sibling-format clipboards. */
const CELL_CLIPBOARD_KEY = 'flex-icon-grid:cell-clipboard';

// ─── Export / import (Phase 4.17) ───────────────────────────────────────────

/**
 * Phase 4.17 → 4.18: serialise the current config as pretty-printed
 * JSON, derive a differentiating filename, and trigger a browser
 * download. Filename composition:
 *   `flex-icon-grid-<title-slug>-<YYYY-MM-DD>-<HHMM>.json`
 * The title slug comes from the title bar text (when present) or
 * "untitled" otherwise; the HHMM suffix ensures multiple exports
 * within the same minute still differ. Object URL is revoked after
 * click to avoid leaks.
 */
/** Phase 4.19 → 4.22: bumped each phase a feature lands that
 *  changes the wire format. Imports tolerate older versions and
 *  warn on newer-than-known ones (see `KNOWN_FORMAT_VERSIONS`)
 *  so a config exported from a future client surfaces the version
 *  mismatch instead of silently dropping fields the current parser
 *  doesn't recognise. */
const EXPORT_FORMAT_VERSION = '4.22';

/** Versions this client knows how to read. Append on every export
 *  bump. The parser is forgiving for unrecognised fields, so
 *  reading a NEWER format usually works — but we toast a warning
 *  so the user knows the import may have dropped data. The array
 *  is intentionally kept in ascending order so `KNOWN_FORMAT_LATEST`
 *  is just the last entry; the warning surface uses that instead
 *  of spreading the Set + sort + pop on every import. */
const KNOWN_FORMAT_VERSIONS = ['4.19', '4.20', '4.21', '4.22'] as const;
const KNOWN_FORMAT_VERSIONS_SET: ReadonlySet<string> = new Set(KNOWN_FORMAT_VERSIONS);
const KNOWN_FORMAT_LATEST = KNOWN_FORMAT_VERSIONS[KNOWN_FORMAT_VERSIONS.length - 1];

function exportConfigJson(config: FlexIconGridConfig): void {
  // Phase 4.19: wrap the config in an envelope carrying
  // `formatVersion` + `exportedAt` so future imports can detect old
  // shapes and either migrate or warn. The envelope is the OUTER
  // object; the parser tolerates either form (envelope vs raw config)
  // so old exports keep importing unchanged.
  const envelope = {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    config,
  };
  const json = JSON.stringify(envelope, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const titleSlug = slugifyForFilename(config.titleBar?.text) || 'untitled';
  a.href = url;
  a.download = `flex-icon-grid-${titleSlug}-${datePart}-${hhmm}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Phase 4.18 → 4.19: lower-kebab-case slug capped at 40 chars,
 *  suitable for a download filename. Strips diacritics via NFKD
 *  followed by the Unicode combining-mark range (`̀-ͯ`),
 *  encoded as escapes so a future editor's encoding can't corrupt
 *  the regex. Then collapses non-alphanumerics to hyphens and trims
 *  any leading/trailing ones. */
function slugifyForFilename(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Phase 4.17 → 4.18: read the given file as text, parse as JSON,
 * run through the tolerant `parseConfig`, then validate the
 * resulting config BEFORE handing it to `setConfig`. Catches the
 * Phase-4.17 caveat where a row × col mismatch or bad hex colour
 * would import "successfully" then break at render time. Errors
 * surface as a toast with the validator's actionable reason so the
 * user knows what to fix.
 */
async function importConfigJson(
  file: File,
  setConfig: (next: FlexIconGridConfig) => void,
): Promise<void> {
  try {
    const text = await file.text();
    const raw = JSON.parse(text) as unknown;
    // Phase 4.19 → 4.20: tolerant envelope unwrap. Treat the root as
    // an envelope ONLY when it carries BOTH `formatVersion` AND
    // `config` — the combination is unique to the Phase-4.19 export
    // shape, while a raw config that happens to have a `config`
    // property won't be misclassified. Pre-4.19 exports fall
    // through to the raw-config path unchanged.
    const rawObj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const isEnvelope = !!rawObj && 'config' in rawObj && 'formatVersion' in rawObj;
    const candidate = isEnvelope ? (rawObj as { config: unknown }).config : raw;
    // Phase 4.21: warn (non-blocking) when the envelope advertises a
    // version the client doesn't know about. `parseConfig` is still
    // forgiving so the import usually works, but the user deserves
    // to know that newer fields may have been dropped during the
    // tolerant parse — they can re-export from THIS client to lock
    // in the round-trippable shape going forward.
    if (isEnvelope) {
      const advertised = String((rawObj as { formatVersion: unknown }).formatVersion);
      if (advertised && !KNOWN_FORMAT_VERSIONS_SET.has(advertised)) {
        toast.message(
          `Imported config advertises format ${advertised}; this client knows ${KNOWN_FORMAT_LATEST}. Some newer fields may have been dropped.`,
        );
      }
    }
    const config = parseConfig(candidate);
    const result = validateConfig(config);
    if (!result.ok) {
      toast.error(`Import rejected: ${result.reason}`);
      return;
    }
    setConfig(config);
    toast.success(`Imported config from ${file.name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    toast.error(`Import failed: ${message}`);
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  onResultChange: (result: FlexIconGridGenerationResult | null) => void;
  restoredResult?: FlexIconGridGenerationResult | null;
  onDraftStateChange?: (state: FlexIconGridDraftState) => void;
  restoredDraftState?: FlexIconGridDraftState | null;
}

export function FlexIconGridPanel({
  onResultChange,
  restoredResult,
  onDraftStateChange,
  restoredDraftState,
}: Props) {
  // ── State ────────────────────────────────────────────────────────────────

  const [config, setConfig] = useState<FlexIconGridConfig>(() => makeDefaultConfig(3, 5));
  const [selectedCellIndex, setSelectedCellIndex] = useState<number | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stickerBusy, setStickerBusy] = useState(false);
  const [result, setResult] = useState<FlexIconGridGenerationResult | null>(null);
  const [uploadingCells, setUploadingCells] = useState<Set<number>>(new Set());
  // Phase 4.20 → 4.21: cell clipboard. Holds the FULL cell minus its
  // `index` so paste can drop it into any slot. Mirrored to
  // sessionStorage so navigating to another project and back keeps
  // the clipboard — the previous per-mount-only behaviour was a
  // common surprise. SSR-safe init checks `typeof window`.
  // Phase 4.23: track the clipboard's source format version (or
  // `null` when none was recorded — legacy / in-memory). Surfaced as
  // a one-shot toast at paste time when the version is newer than
  // this client knows, so the user is informed that paste may have
  // dropped fields the parser didn't recognise.
  const clipboardVersionRef = useRef<string | null>(null);
  const [cellClipboard, setCellClipboardState] = useState<Omit<FlexIconCell, 'index'> | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.sessionStorage.getItem(CELL_CLIPBOARD_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      // Phase 4.22: clipboard is now stored as an envelope
      // `{ formatVersion, cell }` so a future client can detect old
      // shapes. Pre-4.22 entries are unwrapped tolerantly by
      // checking for the envelope shape; falling through to the
      // raw-cell path keeps existing sessions importable.
      if (parsed && typeof parsed === 'object' && 'cell' in (parsed as Record<string, unknown>)) {
        const env = parsed as { formatVersion?: unknown; cell: unknown };
        if (typeof env.formatVersion === 'string') {
          clipboardVersionRef.current = env.formatVersion;
          if (!KNOWN_FORMAT_VERSIONS_SET.has(env.formatVersion)) {
            console.info(
              `[flex-icon-grid] clipboard advertises unknown format ${env.formatVersion}; will warn at paste time.`,
            );
          }
        }
        return env.cell as Omit<FlexIconCell, 'index'>;
      }
      return parsed as Omit<FlexIconCell, 'index'>;
    } catch {
      return null;
    }
  });
  // Wrap the setter so the storage mirror updates atomically with
  // the state. Phase 4.22: writes the envelope shape going forward
  // so future clients can spot stale clipboards; reads accept both
  // shapes (see the init reducer).
  const setCellClipboard = (next: Omit<FlexIconCell, 'index'> | null) => {
    setCellClipboardState(next);
    // Phase 4.23: writes from this client are always at the current
    // export version, so a fresh copy clears any stale version tag
    // from a previous (cross-client) read.
    clipboardVersionRef.current = next === null ? null : EXPORT_FORMAT_VERSION;
    if (typeof window === 'undefined') return;
    try {
      if (next === null) window.sessionStorage.removeItem(CELL_CLIPBOARD_KEY);
      else {
        const envelope = { formatVersion: EXPORT_FORMAT_VERSION, cell: next };
        window.sessionStorage.setItem(CELL_CLIPBOARD_KEY, JSON.stringify(envelope));
      }
    } catch {
      // Quota / private-mode failures are non-fatal — the in-memory
      // state still works for this session.
    }
  };

  /** Phase 4.23: one-shot paste-time warning if the clipboard was
   *  written by a client with a newer-than-known format version.
   *  Resets the tracked version after warning so a chain of pastes
   *  from the same clipboard only nags once per fresh read. */
  function warnIfClipboardVersionUnknown() {
    const version = clipboardVersionRef.current;
    if (version && !KNOWN_FORMAT_VERSIONS_SET.has(version)) {
      toast.message(
        `Clipboard was written by format ${version}; this client knows ${KNOWN_FORMAT_LATEST}. Some pasted fields may have been ignored.`,
      );
      clipboardVersionRef.current = null;
    }
  }

  // Workspace-registered fonts (Phase 4.8b). Fetched eagerly so the
  // chip row inside the custom-font picker shows up immediately
  // without forcing the user to re-upload a previously-attached
  // font. Auto-populated after every successful upload via the
  // `uploadCustomFont` handler below.
  const [workspaceFonts, setWorkspaceFonts] = useState<WorkspaceFontEntry[]>([]);
  // Phase 4.10 caveat fix: ARIA live region announcement for font
  // picker selections. Screen readers + voice control hear "Font set
  // to <name>" the moment the user activates a chip. Empty string is
  // the steady state — set on every chip click, polite mode so it
  // doesn't interrupt the user mid-action.
  const [fontAnnouncement, setFontAnnouncement] = useState('');
  // Phase 4.18: persistent "always snap to 15°" toggle for the cell
  // rotation slider. When on, the slider step becomes 15 and the
  // value clamps to multiples of 15 regardless of Shift. When off,
  // step=1 with Shift-snap (Phase 4.17). Local to this panel — not
  // saved to config since it's a UI preference, not a data choice.
  const [rotationAlwaysSnap, setRotationAlwaysSnap] = useState(false);
  // Phase 4.22: target colour count for the Random palette button.
  // 5 keeps a tight, on-style scheme; 8 is the Phase-4.21 default;
  // 12 gives dense grids enough variety to avoid the adjacency
  // fallback. Local UI state — not persisted.
  const [randomPaletteCount, setRandomPaletteCount] = useState<number>(8);
  // Phase 4.23: snapshot of the palette as it stood before the first
  // Lighten / Darken / Saturate / Desaturate adjustment. Set on the
  // first adjust click; cleared when the user picks a preset chip or
  // Random (those are "fresh starts"). Lets the panel render a
  // "Restore palette" chip that returns to the snapshot — a cleaner
  // path than asking the user to remember which preset they were on.
  const [paletteBaseline, setPaletteBaseline] = useState<PaletteSpec | null>(null);
  // Phase 4.26: ref to the per-cell stroke colour input so the "On"
  // tristate chip can hand focus to it after the controls render.
  const strokeColorInputRef = useRef<HTMLInputElement | null>(null);
  // Phase 4.26: live-preview zoom level. 100 = native fit. Scales
  // the SVG via CSS transform so the rendered PNG is unaffected.
  // Local UI state — not persisted. Bounded to the discrete chip
  // set to keep the math simple and avoid pathological values.
  const [previewZoom, setPreviewZoom] = useState<number>(100);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads workspace fonts
        const res = await fetch('/api/thumbnails/format/flex-icon-grid/workspace-fonts');
        if (!res.ok) return;
        const data = (await res.json()) as { fonts: WorkspaceFontEntry[] };
        if (!cancelled) setWorkspaceFonts(data.fonts);
      } catch (err) {
        console.warn('[flex-icon-grid panel font] registry fetch failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // Phase 4.9b → Phase 4.10: subscribe every workspace font's URL to
  // the shared module-level registry so the chip row + per-cell picker
  // can render the font name in its OWN face. The registry refcounts
  // subscribers, so when the live preview also references the same URL
  // (via its own `useCustomFontRegistration`), they share one FontFace
  // — no double-add / no race-on-unmount.
  const panelSubscribedFonts = useRef(new Set<string>());
  useEffect(() => {
    const wanted = new Set(workspaceFonts.map((f) => f.downloadUrl));
    for (const url of wanted) {
      if (panelSubscribedFonts.current.has(url)) continue;
      acquireCustomFont(url);
      panelSubscribedFonts.current.add(url);
    }
    for (const url of panelSubscribedFonts.current) {
      if (wanted.has(url)) continue;
      releaseCustomFont(url);
      panelSubscribedFonts.current.delete(url);
    }
  }, [workspaceFonts]);
  useEffect(() => {
    const tracker = panelSubscribedFonts.current;
    return () => {
      for (const url of tracker) releaseCustomFont(url);
      tracker.clear();
    };
  }, []);

  async function removeRegisteredFont(id: string, name: string) {
    // Phase 4.9 caveat fix: surface the "also delete from storage"
    // decision explicitly. Two-step prompt — first confirm removal,
    // then ask separately whether to reclaim the R2 object so a
    // single mis-click can't permanently destroy a font another
    // user might have referenced in a saved template.
    if (!confirm(`Remove registered font "${name}" from the picker?`)) return;
    const reclaim = confirm(
      `Also delete "${name}" from storage permanently?\n\n` +
      `OK = delete the file from R2 (other users' saved templates that reference it will break).\n` +
      `Cancel = keep the file in storage (bucket lifecycle may reclaim it later).`,
    );
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE for workspace font - RPC
      const res = await fetch(
        `/api/thumbnails/format/flex-icon-grid/workspace-fonts/${encodeURIComponent(id)}` +
          (reclaim ? '?reclaim=true' : ''),
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      const data = (await res.json().catch(() => ({}))) as {
        reclaimed?: boolean;
        skippedDueToRefs?: boolean;
      };
      setWorkspaceFonts((prev) => prev.filter((f) => f.id !== id));
      // Phase 4.10 caveat fix: explicitly distinguish "kept the file
      // because a sibling workspace still has it registered" from
      // "tried to delete and the delete failed".
      toast.success(
        reclaim && data.reclaimed
          ? 'Font removed and file deleted'
          : reclaim && data.skippedDueToRefs
            ? 'Font removed; file kept (another workspace still references it)'
            : reclaim
              ? 'Font removed; file delete failed (lifecycle will reclaim later)'
              : 'Font removed from registry',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  // Workspace-saved palettes — fetched eagerly on mount so the quick-
  // load chip row next to the named-preset chips shows the user's
  // most recently saved palettes without waiting for the disclosure.
  // Read goes through a module-level 60s TTL cache
  // (`flex-icon-grid-saved-palettes-client-cache`) so rapid panel
  // mount/unmount cycles don't refetch — the eager fetch on every
  // mount was a Phase 4.5 caveat. Save/delete handlers invalidate
  // the cache so the user's own writes are visible immediately.
  const [savedPalettes, setSavedPalettes] = useState<SavedPaletteRecord[]>([]);
  const [savedPalettesLoaded, setSavedPalettesLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const palettes = await fetchSavedPalettesCached();
      if (cancelled) return;
      if (palettes !== null) {
        setSavedPalettes(palettes);
      } else {
        console.warn('[flex-icon-grid panel] eager palette fetch failed');
      }
      setSavedPalettesLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Global sticker style preset — applied to every AI-sticker
  // generation call in this panel session. Persisted to localStorage
  // (rule 15: settings audit) so a repeat user lands back in their
  // preferred style without re-picking each session.
  const [stickerStyle, setStickerStyle] = useState<string>(() => {
    if (typeof window === 'undefined') return DEFAULT_STICKER_STYLE;
    try {
      const v = localStorage.getItem(STICKER_STYLE_PREF_KEY);
      if (v && STICKER_STYLE_PRESETS.some((p) => p.id === v)) return v;
    } catch { /* fall through */ }
    return DEFAULT_STICKER_STYLE;
  });
  useEffect(() => {
    try { localStorage.setItem(STICKER_STYLE_PREF_KEY, stickerStyle); } catch { /* ignore */ }
  }, [stickerStyle]);

  // Restore from history (rendered result).
  useEffect(() => {
    if (!restoredResult) return;
    setConfig(restoredResult.config);
    setResult(restoredResult);
  }, [restoredResult]);

  // Restore in-progress draft from workflow draft.
  useEffect(() => {
    if (!restoredDraftState) return;
    setConfig(restoredDraftState.config);
    console.info('[flex-icon-grid panel draft] hydrated', {
      cell_count: restoredDraftState.config.cells.length,
      rows: restoredDraftState.config.rows,
      cols: restoredDraftState.config.cols,
    });
  }, [restoredDraftState]);

  // Report draft state to parent on every config change.
  useEffect(() => {
    onDraftStateChange?.({ config });
  }, [config, onDraftStateChange]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const totalCells = config.rows * config.cols;
  const selectedCell = selectedCellIndex
    ? config.cells.find((c) => c.index === selectedCellIndex) ?? null
    : null;
  const spanConflicts = useMemo(() => getSpanConflicts(config), [config]);
  const selectedCellConflict = selectedCell
    ? spanConflicts.get(selectedCell.index) ?? null
    : null;
  // Phase 4.14: resolved palette colours per cell, used by the cell
  // editor's "Lock current colour" button so we can capture whatever
  // the palette engine would have picked for this cell into the
  // explicit `backgroundColor` field.
  const paletteResolvedBackgrounds = useMemo(
    () => resolveCellBackgrounds(config),
    [config],
  );
  // Phase 4.25: memoized palette adjust probes. Each direction's
  // shifted palette + at-limit flag is computed once per palette
  // change instead of on every panel render. The closure captures
  // the palette spec — unrelated state (selectedCellIndex,
  // workspaceFonts, etc.) doesn't invalidate the memo.
  const paletteAdjustProbes = useMemo(() => {
    const currentColors = paletteColours(config.palette);
    const lightProbe = shiftPaletteLightness(currentColors, 8);
    const darkProbe = shiftPaletteLightness(currentColors, -8);
    const satProbe = shiftPaletteSaturation(currentColors, 10);
    const mutedProbe = shiftPaletteSaturation(currentColors, -10);
    return {
      lightProbe,
      darkProbe,
      satProbe,
      mutedProbe,
      lightAtLimit: colorsEqual(currentColors, lightProbe),
      darkAtLimit: colorsEqual(currentColors, darkProbe),
      satAtLimit: colorsEqual(currentColors, satProbe),
      mutedAtLimit: colorsEqual(currentColors, mutedProbe),
    };
  }, [config.palette]);

  // ── Mutators ─────────────────────────────────────────────────────────────

  function updateConfig(patch: Partial<FlexIconGridConfig>) {
    setConfig((prev) => ({ ...prev, ...patch }));
  }

  function setGridSize(rows: number, cols: number) {
    setConfig((prev) => {
      const total = rows * cols;
      const cells: FlexIconCell[] = [];
      for (let i = 0; i < total; i++) {
        const existing = prev.cells[i];
        if (existing) {
          cells.push({ ...existing, index: i + 1 });
        } else {
          cells.push({ index: i + 1, label: `Item ${i + 1}`, content: { type: 'text-only' } });
        }
      }
      return { ...prev, rows, cols, cells };
    });
    setSelectedCellIndex(null);
  }

  function updateCell(cellIndex: number, patch: Partial<FlexIconCell>) {
    setConfig((prev) => ({
      ...prev,
      cells: prev.cells.map((c) => (c.index === cellIndex ? { ...c, ...patch } : c)),
    }));
  }

  function applyIconToSelectedCell(slug: string) {
    if (selectedCellIndex == null) return;
    updateCell(selectedCellIndex, { content: { type: 'icon-library', name: slug } });
  }

  function clearCellOverrides(cellIndex: number) {
    updateCell(cellIndex, {
      shape: undefined,
      backgroundColor: undefined,
      background: undefined,
      ring: undefined,
      shadow: undefined,
      badge: undefined,
      rotation: undefined,
      flipX: undefined,
      flipY: undefined,
      labelStyle: undefined,
      cellSpan: undefined,
    });
  }

  /**
   * Phase 4.20: copy the selected cell into the in-memory clipboard.
   * Strips the `index` so the paste target picks its own. Survives
   * for the panel's lifetime; clipboard chip surfaces "Paste here"
   * on every other selected cell.
   */
  function copyCell(cellIndex: number) {
    const source = config.cells.find((c) => c.index === cellIndex);
    if (!source) return;
    const { index: _index, ...withoutIndex } = source;
    void _index;
    setCellClipboard(withoutIndex);
    toast.success(`Copied cell ${cellIndex}`);
  }

  /**
   * Phase 4.20: paste the clipboard cell over the target index.
   * Replaces EVERY field on the target (content, label, style)
   * since the user's intent is "make this cell a copy of the
   * copied one"; if they want to keep some fields they can edit
   * after pasting.
   */
  function pasteCell(targetIndex: number) {
    if (!cellClipboard) return;
    warnIfClipboardVersionUnknown();
    // Full replace — not a merge — so the target picks up every
    // field from the clipboard (including UNSET fields that should
    // clear existing overrides on the target). Spreading the
    // clipboard onto an empty `{ index }` base achieves that.
    //
    // Phase 4.22: explicitly carry the TARGET's existing `cellSpan`
    // through the replace so a paste never collapses an adjacent
    // hero block. Matches Paste style's behaviour (which also
    // leaves cellSpan untouched) so both paste variants behave
    // consistently on layout-affecting fields.
    setConfig((prev) => ({
      ...prev,
      cells: prev.cells.map((c) =>
        c.index === targetIndex
          ? ({
              index: targetIndex,
              ...cellClipboard,
              cellSpan: c.cellSpan,
            } as FlexIconCell)
          : c,
      ),
    }));
    toast.success(`Pasted into cell ${targetIndex}`);
  }

  /**
   * Phase 4.21: paste only the STYLE fields from the clipboard onto
   * the target, preserving the target's content/label/colour. Same
   * field selection as `applyStyleToAllCells` so the two operations
   * agree on what "style" means. Useful for "make this cell look
   * like the copied one but keep the existing icon/label".
   */
  function pasteCellStyle(targetIndex: number) {
    if (!cellClipboard) return;
    warnIfClipboardVersionUnknown();
    updateCell(targetIndex, {
      shape: cellClipboard.shape,
      ring: cellClipboard.ring,
      shadow: cellClipboard.shadow,
      rotation: cellClipboard.rotation,
      flipX: cellClipboard.flipX,
      flipY: cellClipboard.flipY,
      labelStyle: cellClipboard.labelStyle,
      badge: cellClipboard.badge,
    });
    toast.success(`Pasted style into cell ${targetIndex}`);
  }

  /**
   * Phase 4.18: copy the selected cell's style fields to every other
   * cell. "Style" means everything that's visual/decorative — shape,
   * ring, shadow, rotation, labelStyle, badge — but NOT content,
   * label text, or per-cell colour overrides (the user usually
   * wants each cell to keep its own subject + colour). `cellSpan`
   * stays out too since copying a 2×2 span to every cell would
   * collapse the grid.
   */
  function applyStyleToAllCells(sourceIndex: number) {
    setConfig((prev) => {
      const source = prev.cells.find((c) => c.index === sourceIndex);
      if (!source) return prev;
      return {
        ...prev,
        cells: prev.cells.map((c) => {
          if (c.index === sourceIndex) return c;
          return {
            ...c,
            shape: source.shape,
            ring: source.ring,
            shadow: source.shadow,
            rotation: source.rotation,
            flipX: source.flipX,
            flipY: source.flipY,
            labelStyle: source.labelStyle,
            badge: source.badge,
          };
        }),
      };
    });
  }

  // ── Uploads ──────────────────────────────────────────────────────────────

  /**
   * Custom-font upload (Phase 4.7b). Presign → R2 PUT → store the
   * returned URL on `config.defaultLabel.customFontUrl`. The live
   * preview and server composer both pick up the new URL on the
   * next render. License posture: the file is the user's; the panel
   * surfaces a one-line warning next to the upload control.
   */
  async function uploadCustomFont(file: File) {
    if (!ALLOWED_FONT_TYPES.has(file.type) && !/\.(ttf|otf|woff|woff2)$/i.test(file.name)) {
      toast.error('Font must be a .ttf, .otf, .woff, or .woff2 file.');
      return;
    }
    if (file.size > MAX_FONT_UPLOAD_BYTES) {
      toast.error('Font upload must be under 5MB.');
      return;
    }
    console.info('[flex-icon-grid panel font] upload start', {
      content_type: file.type, size_bytes: file.size,
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- presign RPC: returns upload URL
      const presignRes = await fetch('/api/uploads/flex-icon-grid-font', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || 'font/ttf',
          fileSize: file.size,
        }),
      });
      if (!presignRes.ok) {
        const data: { error?: string } = await presignRes.json().catch(() => ({}));
        throw new Error(data.error || `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl, r2Key } = await presignRes.json();
      // eslint-disable-next-line no-restricted-syntax -- PUT to presigned R2 URL - file upload
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'font/ttf' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);
      const fontLabel = file.name.replace(/\.(ttf|otf|woff|woff2)$/i, '');
      updateConfig({
        defaultLabel: {
          ...config.defaultLabel,
          font: 'custom',
          customFontUrl: downloadUrl,
          customFontLabel: fontLabel,
        },
      });
      // Phase 4.8b: auto-register the font in the workspace registry
      // so it appears as a chip for future thumbnails. Non-fatal —
      // a failed registration still leaves the URL usable in THIS
      // thumbnail; the chip just won't appear next session.
      void (async () => {
        try {
          // eslint-disable-next-line no-restricted-syntax -- awaited POST to register font - RPC
          const regRes = await fetch('/api/thumbnails/format/flex-icon-grid/workspace-fonts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: fontLabel,
              r2_key: r2Key,
              mime_type: file.type || 'font/ttf',
              size_bytes: file.size,
            }),
          });
          if (regRes.ok) {
            const registered = (await regRes.json()) as WorkspaceFontEntry;
            setWorkspaceFonts((prev) => [registered, ...prev.filter((f) => f.id !== registered.id)]);
          } else if (regRes.status === 409) {
            // Duplicate name (Phase 4.9 caveat fix). The font's
            // attached to this thumbnail just fine, but the registry
            // chip won't update — surface that so the user knows to
            // either rename the file next time or just keep using
            // the existing chip.
            toast.message(
              `A font named "${fontLabel}" already exists in your workspace registry. ` +
              `The font is attached to this thumbnail but the registry chip didn't update — ` +
              `pick the existing chip in future thumbnails or rename your file to register a new one.`,
              { duration: 8000 },
            );
            console.info('[flex-icon-grid panel font] registry name conflict', { name: fontLabel });
          } else {
            console.warn('[flex-icon-grid panel font] registry registration failed', {
              status: regRes.status,
            });
          }
        } catch (err) {
          console.warn('[flex-icon-grid panel font] registry registration error', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      toast.success(`Font "${file.name}" attached`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[flex-icon-grid panel font] upload error', { reason });
      toast.error(reason || 'Font upload failed');
    }
  }

  async function uploadCellImage(cellIndex: number, file: File) {
    if (!ALLOWED_CELL_UPLOAD_TYPES.has(file.type)) {
      toast.error('Cell upload must be JPEG, PNG, WebP, or GIF.');
      return;
    }
    if (file.size > MAX_CELL_UPLOAD_BYTES) {
      toast.error('Cell upload must be under 8MB.');
      return;
    }
    setUploadingCells((prev) => new Set(prev).add(cellIndex));
    const startedAt = Date.now();
    console.info('[flex-icon-grid panel] upload start', {
      cell_index: cellIndex, size_bytes: file.size, content_type: file.type,
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- presign RPC: returns upload URL
      const presignRes = await fetch('/api/uploads/flex-icon-grid-cell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!presignRes.ok) {
        const data: { error?: string } = await presignRes.json().catch(() => ({}));
        throw new Error(data.error || `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl } = await presignRes.json();
      // eslint-disable-next-line no-restricted-syntax -- PUT to presigned R2 URL - file upload
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);
      updateCell(cellIndex, { content: { type: 'upload', url: downloadUrl } });
      console.info('[flex-icon-grid panel] upload done', {
        cell_index: cellIndex, ms: Date.now() - startedAt,
      });
      toast.success(`Cell ${cellIndex} image attached`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[flex-icon-grid panel] upload error', { cell_index: cellIndex, reason });
      toast.error(reason || 'Cell upload failed');
    } finally {
      setUploadingCells((prev) => {
        const next = new Set(prev);
        next.delete(cellIndex);
        return next;
      });
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  /**
   * Generate AI stickers for every cell with an `ai-sticker` content
   * type that has a prompt but no URL yet.
   *
   * Style-coherence rule (Phase 4 fix): cells are GROUPED BY EFFECTIVE
   * STYLE before batching. Every batch contains only cells that share
   * the same style — and fillers in that batch inherit the same style
   * via the request body's `style` field. The model never sees a
   * batch with mixed-style cells competing in the same collage call,
   * which used to produce visibly less coherent real-cell renders.
   *
   * Cost trade-off: in the worst case (e.g. 4 real cells, each with a
   * different style override), this turns 1 mixed-style call into 4
   * single-cell calls. Documented at the panel UI level — the chip
   * row warns users that per-cell overrides multiply the batch count.
   */
  async function generateStickers() {
    const targets = config.cells.filter(
      (c) => c.content.type === 'ai-sticker' && !!c.content.prompt && !c.content.url,
    );
    if (targets.length === 0) {
      toast.info('No sticker prompts pending generation.');
      return;
    }
    // Resolve the effective style for each target (per-cell override
    // wins; falls back to the global). Group by that string.
    const groupedByStyle = new Map<string, typeof targets>();
    for (const cell of targets) {
      const cellStyle = cell.content.type === 'ai-sticker' ? cell.content.style : undefined;
      const effective = cellStyle || stickerStyle;
      const bucket = groupedByStyle.get(effective);
      if (bucket) bucket.push(cell);
      else groupedByStyle.set(effective, [cell]);
    }

    // Build per-style batches. Fillers inherit the batch's style via
    // the request body, so the collage prompt stays internally
    // consistent and the model renders real cells coherently.
    interface StickerBatch {
      items: Array<{ cellIndex: number; prompt: string; style?: string }>;
      style: string;
    }
    const batches: StickerBatch[] = [];
    const FILLER_BASE = 9000;
    for (const [groupStyle, groupCells] of groupedByStyle) {
      for (let i = 0; i < groupCells.length; i += 4) {
        const items: StickerBatch['items'] = groupCells.slice(i, i + 4).map((cell) => ({
          cellIndex: cell.index,
          prompt: cell.content.type === 'ai-sticker' ? cell.content.prompt : '',
          // Per-cell style intentionally omitted — the batch's `style`
          // field carries the same value for both real cells and
          // fillers, so the route's resolver picks it for both.
        }));
        while (items.length < 4) {
          items.push({
            cellIndex: FILLER_BASE + items.length,
            prompt: 'a neutral grey blank background',
          });
        }
        batches.push({ items, style: groupStyle });
      }
    }
    setStickerBusy(true);
    console.info('[flex-icon-grid panel sticker] batch start', {
      target_count: targets.length,
      batch_count: batches.length,
      style_groups: Array.from(groupedByStyle.entries()).map(([s, cells]) => ({
        style: s, cell_count: cells.length,
      })),
    });
    try {
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        // eslint-disable-next-line no-restricted-syntax -- sticker-gen RPC: awaits and uses response
        const res = await fetch('/api/thumbnails/format/flex-icon-grid/generate-stickers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stickers: batch.items, style: batch.style }),
        });
        if (!res.ok) {
          const data: { error?: string } = await res.json().catch(() => ({}));
          throw new Error(data.error || `Sticker generation failed (${res.status})`);
        }
        const data = (await res.json()) as { stickers: Record<number, string> };
        setConfig((prev) => ({
          ...prev,
          cells: prev.cells.map((cell) => {
            if (cell.content.type !== 'ai-sticker') return cell;
            const url = data.stickers[cell.index];
            if (!url) return cell;
            return {
              ...cell,
              content: { type: 'ai-sticker', prompt: cell.content.prompt, url },
            };
          }),
        }));
        console.info('[flex-icon-grid panel sticker] batch done', {
          batch_index: b, returned_count: Object.keys(data.stickers).length,
        });
      }
      toast.success(`Generated ${targets.length} sticker${targets.length === 1 ? '' : 's'}.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[flex-icon-grid panel sticker] failed', { reason });
      toast.error(reason || 'Sticker generation failed');
    } finally {
      setStickerBusy(false);
    }
  }

  async function runRender() {
    setBusy(true);
    console.info('[flex-icon-grid panel] render request', {
      rows: config.rows, cols: config.cols, cell_count: config.cells.length,
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- render RPC: awaits and uses response
      const res = await fetch('/api/thumbnails/format/flex-icon-grid/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Render failed (${res.status})`);
      }
      const data = (await res.json()) as FlexIconGridGenerationResult;
      setResult(data);
      onResultChange(data);
      console.info('[flex-icon-grid panel] render ok', {
        image_url_prefix: data.imageUrl.slice(0, 60),
      });
      toast.success('Thumbnail rendered');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[flex-icon-grid panel] render error', { reason });
      toast.error(reason || 'Render failed');
    } finally {
      setBusy(false);
    }
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  return (
    <div
      style={containerStyle}
      data-fg-panel="true"
      // `data-fg-sheet-open` lets the CSS pad the bottom render
      // controls so the mobile bottom-sheet cell editor doesn't cover
      // them. Toggled by selecting a cell.
      data-fg-sheet-open={selectedCell ? 'true' : 'false'}
    >
      {/* Phase 4.10 caveat fix: ARIA live region for font picker
          selections. Visually hidden but exposed to assistive tech
          so a screen reader announces the active font name when the
          user activates a chip. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {fontAnnouncement}
      </div>

      {/* Grid size + palette + defaults */}
      <section style={sectionStyle}>
        <h3 style={sectionHeaderStyle}>Grid</h3>
        <div style={chipRowStyle}>
          {GRID_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setGridSize(p.rows, p.cols)}
              style={chipStyle(config.rows === p.rows && config.cols === p.cols)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {/* Phase 4.13: aspect ratio presets. Picking one updates the
            canvas dimensions; the grid re-flows automatically since
            the layout math is purely proportional. Cell contents
            survive the switch — only the rendered canvas changes.
            Phase 4.14: when the orientation flips (landscape ↔
            portrait), swap rows and cols so a 5×3 landscape grid
            becomes 3×5 on portrait. Cell reading order stays 1-based
            top-to-bottom, left-to-right; cell contents survive the
            re-flow because they're indexed by `cell.index`. */}
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>Aspect ratio</label>
          <div style={chipRowStyle}>
            {ASPECT_RATIO_PRESETS.map((preset) => {
              const active = config.width === preset.width && config.height === preset.height;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    // Use the functional setConfig so the cell re-seed
                    // and the canvas dim update land in a single React
                    // commit — avoids a transient frame where the
                    // canvas dims and the grid dims disagree.
                    setConfig((prev) => {
                      const currentLandscape = prev.width >= prev.height;
                      const nextLandscape = preset.width >= preset.height;
                      const flip = currentLandscape !== nextLandscape;
                      // Phase 4.14 → 4.15: scale title bar height
                      // proportionally with the new canvas height.
                      // 4.15 remembers the fraction explicitly so a
                      // tall bar stays tall across multiple flips
                      // even if the user nudged the absolute height
                      // between them. The fraction is captured here
                      // (using the current absolute height) and
                      // applied to the new canvas height in one step.
                      const fraction = prev.titleBar
                        ? prev.titleBar.heightFraction ?? prev.titleBar.height / prev.height
                        : null;
                      const titleBar = prev.titleBar && fraction !== null
                        ? {
                            ...prev.titleBar,
                            height: Math.max(16, Math.round(fraction * preset.height)),
                            heightFraction: fraction,
                          }
                        : undefined;
                      if (!flip) {
                        return {
                          ...prev,
                          width: preset.width,
                          height: preset.height,
                          titleBar,
                        };
                      }
                      // Phase 4.15: transpose cells so the visual
                      // layout rotates with the canvas. A landscape
                      // hero at top-left stays at top-left on the
                      // portrait flip; row 1 ↔ column 1.
                      const newRows = prev.cols;
                      const newCols = prev.rows;
                      const cells = transposeCells(prev.cells, prev.rows, prev.cols);
                      return {
                        ...prev,
                        width: preset.width,
                        height: preset.height,
                        rows: newRows,
                        cols: newCols,
                        cells,
                        titleBar,
                      };
                    });
                    setSelectedCellIndex(null);
                  }}
                  style={chipStyle(active)}
                  title={`${preset.description} (${preset.width}×${preset.height})`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionHeaderStyle}>
          Palette
          {/* Phase 4.24: "modified" indicator when a baseline has
              been captured (i.e. Lighten / Darken / More vivid /
              Muted has run at least once since the last fresh
              start). Visual signal that Restore is meaningful;
              disappears as soon as Restore (or a preset / Random
              / custom edit) clears the baseline. */}
          {paletteBaseline !== null && (
            <span
              // Phase 4.25: theme-aware. Border + tinted fill are
              // derived from `currentColor` so the badge inherits
              // the header's text colour, with low alpha for the
              // fill so it reads as a subtle highlight in dark mode
              // and a soft tint in light mode. No hardcoded hex.
              style={{
                marginLeft: 8,
                fontSize: 10,
                fontWeight: 500,
                padding: '1px 6px',
                borderRadius: 4,
                border: '1px solid currentColor',
                background: 'rgba(147, 197, 253, 0.12)',
                color: 'currentColor',
                opacity: 0.85,
                verticalAlign: 'middle',
                // Phase 4.26: em-relative spacing so the pill reads
                // consistently across system fonts where 0.3 px ≈
                // varies. ~0.03em ≈ same visual tracking the pill
                // had in dev (≈10 px font × 0.03 = 0.3 px) but
                // scales sensibly if the inherited font ever
                // changes size.
                letterSpacing: '0.03em',
              }}
              title="The palette has been adjusted since the last preset / Random / custom edit. Tap Restore to return to the baseline."
              aria-label="Palette modified"
            >
              modified
            </span>
          )}
        </h3>
        <div style={chipRowStyle}>
          {PALETTE_OPTIONS.map((opt) => {
            const active =
              config.palette.type === 'preset' &&
              opt.value.type === 'preset' &&
              config.palette.name === opt.value.name;
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => {
                  // Phase 4.23: picking a preset is a fresh start,
                  // so drop any captured adjust baseline so the
                  // Restore chip doesn't dangle past its useful life.
                  updateConfig({ palette: opt.value });
                  setPaletteBaseline(null);
                }}
                style={chipStyle(active)}
              >
                <PaletteSwatchRow spec={opt.value} />
                <span style={{ marginLeft: 8 }}>{opt.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              if (config.palette.type === 'custom') return;
              // Seed the custom palette from the currently-active named
              // preset so the user sees their starting colours rather
              // than an empty list.
              const seed = config.palette.type === 'preset'
                ? [...paletteColours(config.palette).slice(0, 8)]
                : ['#FFD60A', '#2563EB', '#E63946', '#34D399', '#C026D3'];
              updateConfig({ palette: { type: 'custom', colors: seed } });
            }}
            style={chipStyle(config.palette.type === 'custom')}
          >
            <PaletteSwatchRow
              spec={
                config.palette.type === 'custom'
                  ? config.palette
                  : { type: 'custom', colors: ['#888', '#aaa', '#ccc'] }
              }
            />
            <span style={{ marginLeft: 8 }}>Custom</span>
          </button>

          {/* Phase 4.5a: quick-load chips for the user's most recent
              workspace-saved palettes. Shown inline so the user can
              switch to a saved palette without expanding the
              disclosure. Capped at SAVED_PALETTE_QUICK_LOAD_COUNT
              so the row doesn't sprawl on workspaces with many saves. */}
          {savedPalettes.slice(0, SAVED_PALETTE_QUICK_LOAD_COUNT).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                updateConfig({ palette: { type: 'custom', colors: p.colors } })
              }
              style={chipStyle(false)}
              title={`Saved palette: ${p.name}`}
            >
              <PaletteSwatchRow spec={{ type: 'custom', colors: p.colors }} />
              <span style={{ marginLeft: 8 }}>★ {p.name}</span>
            </button>
          ))}
          {/* Phase 4.15: shuffle button — rotates the palette cursor
              so unlocked cells get re-assigned to different palette
              colours while the palette itself stays the same. Locked
              cells (those with explicit backgroundColor, e.g. via the
              Phase-4.14 "Lock current colour" chip) skip the rotation
              entirely. Each click adds 1 to the offset; the resolver
              takes modulo so it never overflows. */}
          <button
            type="button"
            onClick={() =>
              updateConfig({ paletteShuffleOffset: (config.paletteShuffleOffset ?? 0) + 1 })
            }
            style={{ ...chipStyle(false), display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title="Shuffle palette colour assignment (locked cells unaffected)"
            aria-label="Shuffle palette colour assignment"
          >
            <span aria-hidden="true">⤵</span>
            Shuffle
          </button>
          {/* Phase 4.21 → 4.22: random palette. Click ✦ Random to
              swap the active palette for a fresh harmonious set of
              `randomPaletteCount` colours; the 5 / 8 / 12 chips
              after it select the count. 5 keeps a tight on-style
              scheme; 8 is the default; 12 gives dense grids enough
              variety to avoid the adjacency fallback. Locked cells
              (with explicit `backgroundColor`) bypass the palette so
              they survive Random untouched. */}
          <button
            type="button"
            onClick={() => {
              const colors = generateRandomPalette(randomPaletteCount);
              updateConfig({
                palette: { type: 'custom', colors },
                paletteShuffleOffset: 0,
              });
              // Phase 4.23: Random is a fresh start — drop any
              // captured adjust baseline so the Restore chip
              // doesn't offer a path back to a now-stale palette.
              setPaletteBaseline(null);
            }}
            style={{ ...chipStyle(false), display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title={`Generate a fresh random palette of ${randomPaletteCount} colours (locked cells unaffected)`}
            aria-label={`Generate random palette of ${randomPaletteCount} colours`}
          >
            <span aria-hidden="true">✦</span>
            Random
          </button>
          {/* Phase 4.23: count chips visually distinguished from
              the palette chips: bordered radio-group style, mono
              digits, narrower padding. Makes it clear at a glance
              that they're NUMERIC modifiers for the Random button,
              not palette choices. */}
          <div
            role="radiogroup"
            aria-label="Random palette count"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0,
              borderRadius: 6,
              border: '1px solid #2a2a2e',
              padding: 2,
              background: '#0e0e10',
            }}
          >
            {[5, 8, 12].map((count) => {
              const active = randomPaletteCount === count;
              return (
                <button
                  key={count}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setRandomPaletteCount(count)}
                  style={{
                    background: active ? '#2563eb' : 'transparent',
                    color: active ? '#fafafa' : '#a1a1aa',
                    border: 'none',
                    padding: '3px 8px',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 11,
                    fontWeight: active ? 700 : 500,
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                  title={`Use ${count} colours for Random`}
                  aria-label={`Random palette count: ${count}`}
                >
                  {count}
                </button>
              );
            })}
          </div>
          {/* Phase 4.22 → 4.24 → 4.25: lighten / darken / saturate /
              desat chips. Each click handler reuses the memoized
              probe so the helper isn't re-run on every keystroke
              elsewhere in the panel — `paletteAdjustProbes` is
              keyed on the palette spec, so unrelated state changes
              don't invalidate the memo. */}
          <PaletteAdjustChip
            label="Lighten"
            badge="L↑"
            atLimit={paletteAdjustProbes.lightAtLimit}
            title="Lighten the palette by ~8% (HSL lightness)"
            onClick={() => {
              if (paletteBaseline === null) setPaletteBaseline(config.palette);
              updateConfig({ palette: { type: 'custom', colors: paletteAdjustProbes.lightProbe } });
            }}
          />
          <PaletteAdjustChip
            label="Darken"
            badge="L↓"
            atLimit={paletteAdjustProbes.darkAtLimit}
            title="Darken the palette by ~8% (HSL lightness)"
            onClick={() => {
              if (paletteBaseline === null) setPaletteBaseline(config.palette);
              updateConfig({ palette: { type: 'custom', colors: paletteAdjustProbes.darkProbe } });
            }}
          />
          <PaletteAdjustChip
            label="More vivid"
            badge="S↑"
            atLimit={paletteAdjustProbes.satAtLimit}
            title="More vivid: increase saturation by ~10%"
            onClick={() => {
              if (paletteBaseline === null) setPaletteBaseline(config.palette);
              updateConfig({ palette: { type: 'custom', colors: paletteAdjustProbes.satProbe } });
            }}
          />
          <PaletteAdjustChip
            label="Muted"
            badge="S↓"
            atLimit={paletteAdjustProbes.mutedAtLimit}
            title="Muted: decrease saturation by ~10%"
            onClick={() => {
              if (paletteBaseline === null) setPaletteBaseline(config.palette);
              updateConfig({ palette: { type: 'custom', colors: paletteAdjustProbes.mutedProbe } });
            }}
          />
          {/* Phase 4.23: restore-to-baseline chip. Appears whenever a
              baseline has been captured (i.e. an adjust has run) and
              the current palette differs from it. One click swaps
              the palette back to the baseline and clears the baseline
              so a subsequent adjust starts fresh. */}
          {paletteBaseline !== null && (
            <button
              type="button"
              onClick={() => {
                updateConfig({ palette: paletteBaseline });
                setPaletteBaseline(null);
              }}
              style={{ ...chipStyle(false), display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title="Restore the palette to the pre-adjust state"
              aria-label="Restore palette to baseline"
            >
              <span aria-hidden="true">↺</span>
              Restore
            </button>
          )}
          {/* Phase 4.16 → 4.17: reset + undo chips — appear once
              the user has shuffled at least once. Undo steps back
              by one; Reset jumps to 0. Together they let a user
              freely explore shuffle positions and return to a
              previous one without re-shuffling the cycle's full
              length. */}
          {(config.paletteShuffleOffset ?? 0) > 0 && (
            <>
              <button
                type="button"
                onClick={() =>
                  updateConfig({
                    paletteShuffleOffset: Math.max(0, (config.paletteShuffleOffset ?? 0) - 1),
                  })
                }
                style={chipStyle(false)}
                title="Step back one shuffle position"
                aria-label="Undo last shuffle"
              >
                <span aria-hidden="true">↶</span> Undo
              </button>
              <button
                type="button"
                onClick={() => updateConfig({ paletteShuffleOffset: 0 })}
                style={chipStyle(false)}
                title="Reset palette colour rotation to the canonical order"
                aria-label="Reset palette colour rotation"
              >
                Reset
              </button>
            </>
          )}
        </div>
        {config.palette.type === 'custom' && (
          <CustomPaletteEditor
            palette={config.palette}
            onChange={(next) => {
              // Phase 4.24: a manual edit through the custom editor
              // is a "the user is taking control" signal. Clear the
              // baseline so a subsequent Restore can't undo a real
              // creative choice — they can re-establish a baseline
              // by tapping Lighten/Darken/Saturate/Desaturate again.
              updateConfig({ palette: next });
              setPaletteBaseline(null);
            }}
          />
        )}

        {/* Workspace-saved palettes (Phase 4). Hidden under a
            disclosure so the most common case (preset palettes) stays
            uncluttered. */}
        <SavedPalettesSection
          currentPalette={config.palette}
          palettes={savedPalettes}
          palettesLoaded={savedPalettesLoaded}
          onPalettesChange={setSavedPalettes}
          onLoad={(colors) => updateConfig({ palette: { type: 'custom', colors } })}
        />
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionHeaderStyle}>Default cell shape</h3>
        <div style={chipRowStyle}>
          {SHAPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => updateConfig({ defaultCellShape: opt.value })}
              style={chipStyle(config.defaultCellShape === opt.value)}
            >
              <span style={{ marginRight: 6, fontSize: 16 }}>{opt.glyph}</span>
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      {/* Workspace-saved starting templates (Phase 4.7c). A separate
          surface from saved palettes — palettes are colour-only,
          templates carry the full structural config (grid size, default
          shape, ring, label style, title bar). Per-cell content is
          intentionally not saved so loading a template doesn't blow
          away the user's current cells. */}
      <SavedTemplatesSection
        config={config}
        onLoad={(loaded) => {
          // Apply saved structural settings on top of the current
          // config, preserving per-cell content + cell count. The
          // panel's `setGridSize` would normally re-seed cells, so we
          // bypass it and carry over `cells` verbatim.
          setConfig((prev) => ({
            ...prev,
            ...loaded,
            cells: prev.cells, // keep current per-cell content
          }));
        }}
      />

      {/* Live preview */}
      <section style={{ ...sectionStyle, padding: '12px 14px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <h3 style={{ ...sectionHeaderStyle, marginBottom: 0 }}>
            Live preview · click any cell to edit
          </h3>
          {/* Phase 4.26: zoom controls. 50 % shows full thumbnail at
              a glance on small windows; 100 % is native fit;
              150 % / 200 % are for precision editing of small
              cells in a dense grid. Uses CSS transform so the
              rendered PNG geometry is unaffected. The wrapping
              container handles the resulting overflow with horizontal
              + vertical scrolling. */}
          <div
            role="radiogroup"
            aria-label="Live preview zoom"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0,
              borderRadius: 6,
              border: '1px solid #2a2a2e',
              padding: 2,
              background: '#0e0e10',
            }}
          >
            {[50, 100, 150, 200].map((pct) => {
              const active = previewZoom === pct;
              return (
                <button
                  key={pct}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPreviewZoom(pct)}
                  style={{
                    background: active ? '#2563eb' : 'transparent',
                    color: active ? '#fafafa' : '#a1a1aa',
                    border: 'none',
                    padding: '3px 8px',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 11,
                    fontWeight: active ? 700 : 500,
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                  title={`Zoom preview to ${pct}%`}
                  aria-label={`Zoom ${pct} percent`}
                >
                  {pct}%
                </button>
              );
            })}
          </div>
        </div>
        <div
          style={{
            marginTop: 10,
            // Container scrolls when the inner div outgrows it
            // (zoom > 100 %). At 100 % the preview fits exactly;
            // below 100 % it sits in the top-left with empty
            // surround.
            overflow: previewZoom > 100 ? 'auto' : 'hidden',
          }}
        >
          <div
            style={{
              // Scale via width rather than CSS transform — the SVG
              // inside renders to `width: 100%` of its parent, so
              // a parent at 200% width gives a 200%-size SVG that
              // takes its own layout space (transform wouldn't).
              // Overflow + scroll work naturally.
              width: `${previewZoom}%`,
            }}
          >
            <FlexIconGridLivePreview
              config={config}
              highlightedCellIndex={selectedCellIndex}
              onCellClick={(idx) => setSelectedCellIndex(idx)}
            />
          </div>
        </div>
      </section>

      {/* Selected cell editor */}
      {selectedCell && (
        <section style={cellEditorStyle} data-fg-cell-editor="true">
          <div style={cellEditorHeaderStyle}>
            <h3 style={{ ...sectionHeaderStyle, margin: 0 }}>
              Editing cell {selectedCell.index} of {totalCells}
            </h3>
            <button type="button" onClick={() => setSelectedCellIndex(null)} style={ghostButtonStyle}>
              Close
            </button>
          </div>

          {/* Label */}
          <label style={labelStyle}>Label</label>
          <input
            type="text"
            value={selectedCell.label}
            onChange={(e) => updateCell(selectedCell.index, { label: e.target.value })}
            maxLength={60}
            placeholder={`Item ${selectedCell.index}`}
            style={inputStyle}
          />

          {/* Content type */}
          <label style={labelStyle}>Content</label>
          <div style={chipRowStyle}>
            {(['icon-library', 'emoji', 'upload', 'text-only', 'ai-sticker'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  if (t === selectedCell.content.type) return;
                  const initial: CellContent =
                    t === 'icon-library'
                      ? { type: 'icon-library', name: 'shield' }
                      : t === 'emoji'
                        ? { type: 'emoji', char: '⚡' }
                        : t === 'upload'
                          ? { type: 'upload', url: selectedCell.content.type === 'upload' ? selectedCell.content.url : '' }
                          : t === 'ai-sticker'
                            ? { type: 'ai-sticker', prompt: selectedCell.content.type === 'ai-sticker' ? selectedCell.content.prompt : '' }
                            : { type: 'text-only' };
                  updateCell(selectedCell.index, { content: initial });
                }}
                style={chipStyle(selectedCell.content.type === t)}
              >
                {CONTENT_TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          {/* Content-specific UI */}
          {selectedCell.content.type === 'icon-library' && (
            <IconPicker
              activeSlug={selectedCell.content.name}
              onPick={applyIconToSelectedCell}
            />
          )}
          {selectedCell.content.type === 'emoji' && (
            <div>
              <label style={labelStyle}>Emoji</label>
              <input
                type="text"
                value={selectedCell.content.char}
                onChange={(e) =>
                  updateCell(selectedCell.index, {
                    content: { type: 'emoji', char: e.target.value },
                  })
                }
                maxLength={8}
                placeholder="⚡"
                style={{ ...inputStyle, fontSize: 22, width: 80 }}
              />
            </div>
          )}
          {selectedCell.content.type === 'upload' && (
            <UploadField
              currentUrl={selectedCell.content.url}
              uploading={uploadingCells.has(selectedCell.index)}
              onFile={(file) => uploadCellImage(selectedCell.index, file)}
              onClear={() =>
                updateCell(selectedCell.index, { content: { type: 'upload', url: '' } })
              }
            />
          )}
          {selectedCell.content.type === 'ai-sticker' && (
            <div>
              <label style={labelStyle}>Sticker prompt</label>
              <textarea
                value={selectedCell.content.prompt}
                onChange={(e) =>
                  updateCell(selectedCell.index, {
                    content: {
                      type: 'ai-sticker',
                      prompt: e.target.value,
                      url: selectedCell.content.type === 'ai-sticker' ? selectedCell.content.url : undefined,
                      style: selectedCell.content.type === 'ai-sticker' ? selectedCell.content.style : undefined,
                    },
                  })
                }
                rows={3}
                placeholder="e.g. flat sticker of a hooded rat on a bright yellow background"
                style={{ ...inputStyle, resize: 'vertical' }}
              />

              {/* Per-cell style override (Phase 3.5). When unset, the
                  request uses the global default. */}
              <label style={{ ...labelStyle, marginTop: 10 }}>Style override (this cell)</label>
              <div style={chipRowStyle}>
                <button
                  type="button"
                  onClick={() =>
                    updateCell(selectedCell.index, {
                      content: {
                        type: 'ai-sticker',
                        prompt: selectedCell.content.type === 'ai-sticker' ? selectedCell.content.prompt : '',
                        url: selectedCell.content.type === 'ai-sticker' ? selectedCell.content.url : undefined,
                        style: undefined,
                      },
                    })
                  }
                  style={chipStyle(
                    selectedCell.content.type === 'ai-sticker' && !selectedCell.content.style,
                  )}
                >
                  Use global ({stickerStyle})
                </button>
                {STICKER_STYLE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() =>
                      updateCell(selectedCell.index, {
                        content: {
                          type: 'ai-sticker',
                          prompt: selectedCell.content.type === 'ai-sticker' ? selectedCell.content.prompt : '',
                          url: selectedCell.content.type === 'ai-sticker' ? selectedCell.content.url : undefined,
                          style: preset.id,
                        },
                      })
                    }
                    title={preset.description}
                    style={chipStyle(
                      selectedCell.content.type === 'ai-sticker' && selectedCell.content.style === preset.id,
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              {selectedCell.content.url && (
                <p style={{ fontSize: 11, color: '#34d399', marginTop: 10 }}>
                  Sticker generated. <a href={selectedCell.content.url} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>View</a>
                </p>
              )}
              {!selectedCell.content.url && (
                <p style={{ fontSize: 11, color: '#a1a1aa', marginTop: 10 }}>
                  No sticker generated yet. Use “Generate stickers” below to batch-generate.
                </p>
              )}
            </div>
          )}

          {/* Shape override */}
          <label style={labelStyle}>Cell shape</label>
          <div style={chipRowStyle}>
            <button
              type="button"
              onClick={() => updateCell(selectedCell.index, { shape: undefined })}
              style={chipStyle(!selectedCell.shape)}
            >
              Use default ({SHAPE_OPTIONS.find((s) => s.value === config.defaultCellShape)?.label})
            </button>
            {SHAPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => updateCell(selectedCell.index, { shape: opt.value })}
                style={chipStyle(selectedCell.shape === opt.value)}
              >
                <span style={{ marginRight: 6, fontSize: 16 }}>{opt.glyph}</span>
                {opt.label}
              </button>
            ))}
          </div>

          {/* Cell background (overrides palette for this cell).
              Phase 4.14: pass the resolved palette colour for this
              cell so the editor can offer a one-click "lock" that
              freezes the current palette assignment. */}
          <CellBackgroundEditor
            cell={selectedCell}
            palettePreviewColour={paletteResolvedBackgrounds[selectedCell.index - 1] ?? '#1a1a1a'}
            onChange={(patch) => updateCell(selectedCell.index, patch)}
          />

          {/* Span (cell-merge) */}
          <CellSpanEditor
            cell={selectedCell}
            rows={config.rows}
            cols={config.cols}
            onChange={(span) => updateCell(selectedCell.index, { cellSpan: span })}
          />

          {/* Conflict warning (per cell). Auto-resolve handler picks
              the smallest fix per reason: 'consumed-by-earlier' →
              clear the cell's own span; 'clamped-to-grid' → clamp to
              the largest span that fits. Computed `clampedSpan` is
              passed to the warning so the button label can show the
              concrete dimensions ("Clamp to 2×1") rather than the
              abstract "Clamp to fit" — and when the clamp resolves to
              1×1, the button switches to "Clear span" because the two
              are equivalent. */}
          {selectedCellConflict && (
            <SpanConflictWarning
              reason={selectedCellConflict}
              clampedSpan={
                selectedCellConflict === 'clamped-to-grid' && selectedCell.cellSpan
                  ? (() => {
                      const idx = selectedCell.index - 1;
                      const baseR = Math.floor(idx / config.cols);
                      const baseC = idx % config.cols;
                      return {
                        rows: Math.max(1, Math.min(selectedCell.cellSpan.rows, config.rows - baseR)),
                        cols: Math.max(1, Math.min(selectedCell.cellSpan.cols, config.cols - baseC)),
                      };
                    })()
                  : null
              }
              onAutoResolve={() => {
                const idx = selectedCell.index - 1;
                const baseR = Math.floor(idx / config.cols);
                const baseC = idx % config.cols;
                const span = selectedCell.cellSpan;
                if (selectedCellConflict === 'consumed-by-earlier') {
                  updateCell(selectedCell.index, { cellSpan: undefined });
                  return;
                }
                // clamped-to-grid
                if (!span) return;
                const maxRows = Math.max(1, config.rows - baseR);
                const maxCols = Math.max(1, config.cols - baseC);
                const next = {
                  rows: Math.min(span.rows, maxRows),
                  cols: Math.min(span.cols, maxCols),
                };
                updateCell(selectedCell.index, {
                  cellSpan:
                    next.rows === 1 && next.cols === 1 ? undefined : next,
                });
              }}
            />
          )}

          {/* Phase 4.18 → 4.19: per-cell label position override.
              Each chip carries a tiny SVG preview so the meaning
              ("overlay" sits on the shape, "hidden" omits the label
              band entirely, etc.) is obvious without reading docs.
              "Use default" resets the per-cell `position` so the
              cell falls back to the grid's `defaultLabel.position`. */}
          <label style={labelStyle}>Label position (this cell)</label>
          <div style={chipRowStyle}>
            <button
              type="button"
              aria-pressed={selectedCell.labelStyle?.position === undefined}
              onClick={() =>
                updateCell(selectedCell.index, {
                  labelStyle: selectedCell.labelStyle
                    ? { ...selectedCell.labelStyle, position: undefined }
                    : undefined,
                })
              }
              style={chipStyle(selectedCell.labelStyle?.position === undefined)}
            >
              Use default ({config.defaultLabel.position})
            </button>
            {(['below', 'above', 'overlay', 'hidden'] as const).map((pos) => (
              <button
                key={pos}
                type="button"
                aria-pressed={selectedCell.labelStyle?.position === pos}
                onClick={() =>
                  updateCell(selectedCell.index, {
                    labelStyle: {
                      ...(selectedCell.labelStyle ?? {}),
                      position: pos,
                    },
                  })
                }
                style={{ ...chipStyle(selectedCell.labelStyle?.position === pos), display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <LabelPositionPreview position={pos} />
                {pos}
              </button>
            ))}
          </div>

          {/* Phase 4.24: per-cell label colour override. The composer
              normally picks black/white automatically based on cell
              background luminance (see `pickLabelColourFor`), but a
              hero cell with brand-specific colours often wants an
              explicit hue (e.g. a yellow label on a navy hero).
              "Use auto" clears the per-cell `color` so the
              automatic luminance picker takes over again. */}
          <label style={labelStyle}>Label colour (this cell)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              aria-pressed={!selectedCell.labelStyle?.color}
              onClick={() => {
                if (!selectedCell.labelStyle) {
                  updateCell(selectedCell.index, { labelStyle: undefined });
                  return;
                }
                // OMIT the color key so the composer's
                // `resolveLabelStyle` spread doesn't carry `undefined`
                // through and break the default-vs-auto heuristic.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { color: _unused, ...rest } = selectedCell.labelStyle;
                updateCell(selectedCell.index, {
                  labelStyle: Object.keys(rest).length > 0 ? rest : undefined,
                });
              }}
              style={chipStyle(!selectedCell.labelStyle?.color)}
            >
              Use auto
            </button>
            {selectedCell.labelStyle?.color && (
              <span
                style={{
                  display: 'inline-block',
                  width: 14,
                  height: 14,
                  borderRadius: 4,
                  background: selectedCell.labelStyle.color,
                  border: '1px solid rgba(255,255,255,0.2)',
                }}
                aria-hidden="true"
              />
            )}
            <input
              type="color"
              // Phase 4.25: seed the picker from the EFFECTIVE colour
              // — when no override is set, that's `pickLabelColourFor`
              // run against the cell's resolved background colour
              // (matches what the composer would actually paint).
              // Means a user clicking the picker on a yellow cell
              // starts from "#0a0a0a" (the auto pick) instead of
              // "#0a0a0a" coincidentally — but on a near-black cell
              // they start from "#fbfbf8", which is the genuine
              // luminance-aware default.
              value={
                selectedCell.labelStyle?.color ??
                (config.defaultLabel.color === '#0a0a0a'
                  ? pickLabelColourFor(
                      paletteResolvedBackgrounds[selectedCell.index - 1] ?? '#0a0a0a',
                    )
                  : config.defaultLabel.color)
              }
              onChange={(e) =>
                updateCell(selectedCell.index, {
                  labelStyle: {
                    ...(selectedCell.labelStyle ?? {}),
                    color: e.target.value,
                  },
                })
              }
              aria-label="Label colour for this cell"
              title="Override the auto-picked label colour for this cell"
              style={{
                width: 36,
                height: 32,
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
              }}
            />
            {selectedCell.labelStyle?.color && (
              <span style={{ fontSize: 11, color: '#a1a1aa', fontFamily: 'ui-monospace, monospace' }}>
                {selectedCell.labelStyle.color}
              </span>
            )}
          </div>

          {/* Phase 4.25: per-cell label stroke (text outline). Adds a
              contrasting halo around the label glyphs — useful when
              the cell background is busy (e.g. a pattern or an
              uploaded photo) and the unbordered label would lose
              contrast at small sizes. Toggle to opt in; the stroke
              colour + thickness sliders only appear once enabled.
              `labelStyle.stroke` is already wired through the
              composer (see `buildLabelOverlay`'s stroke-aware Pango
              render), this just surfaces it in the UI. */}
          <label style={labelStyle}>Label stroke (this cell)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Phase 4.25 → 4.26: tristate.
                  - Inherit (`stroke === undefined`) → fall back to
                    `config.defaultLabel.stroke`.
                  - Off (`stroke === null`) → explicit opt-out even
                    if the canvas-level default has a stroke set.
                  - On (`stroke` is an object) → cell-specific
                    halo; switches the slider/colour controls on.
                The three states cover both "I want every cell
                aligned with the default" and "I want THIS cell to
                explicitly not have a halo even when the default
                does". */}
            {(() => {
              const strokeState: 'inherit' | 'off' | 'on' =
                selectedCell.labelStyle?.stroke === undefined ||
                !('stroke' in (selectedCell.labelStyle ?? {}))
                  ? 'inherit'
                  : selectedCell.labelStyle?.stroke === null
                    ? 'off'
                    : 'on';
              return (
                <>
                  <button
                    type="button"
                    aria-pressed={strokeState === 'inherit'}
                    onClick={() => {
                      // Drop the `stroke` field entirely so the
                      // composer's `resolveLabelStyle` spread keeps
                      // the canvas-level default in place.
                      if (!selectedCell.labelStyle) return;
                      // eslint-disable-next-line @typescript-eslint/no-unused-vars
                      const { stroke: _unused, ...rest } = selectedCell.labelStyle;
                      updateCell(selectedCell.index, {
                        labelStyle: Object.keys(rest).length > 0 ? rest : undefined,
                      });
                    }}
                    style={chipStyle(strokeState === 'inherit')}
                    title="Inherit the canvas-level default stroke"
                  >
                    Inherit
                  </button>
                  <button
                    type="button"
                    aria-pressed={strokeState === 'off'}
                    onClick={() =>
                      updateCell(selectedCell.index, {
                        labelStyle: { ...(selectedCell.labelStyle ?? {}), stroke: null },
                      })
                    }
                    style={chipStyle(strokeState === 'off')}
                    title="Force no stroke on this cell even if the default has one"
                  >
                    Off
                  </button>
                  <button
                    type="button"
                    aria-pressed={strokeState === 'on'}
                    onClick={() => {
                      updateCell(selectedCell.index, {
                        labelStyle: {
                          ...(selectedCell.labelStyle ?? {}),
                          stroke:
                            selectedCell.labelStyle?.stroke ?? {
                              color: '#fbfbf8',
                              thickness: 4,
                            },
                        },
                      });
                      // Phase 4.26 caveat fix: focus the colour
                      // input after the next paint so a keyboard
                      // user can keep tabbing forward into the
                      // newly-revealed controls without re-finding
                      // them. `requestAnimationFrame` defers past
                      // React's commit so the input element exists.
                      if (typeof window !== 'undefined') {
                        window.requestAnimationFrame(() => {
                          strokeColorInputRef.current?.focus();
                        });
                      }
                    }}
                    style={chipStyle(strokeState === 'on')}
                    title="Add a contrasting halo around the label glyphs"
                  >
                    On
                  </button>
                </>
              );
            })()}
            {selectedCell.labelStyle?.stroke && (
              <>
                <input
                  ref={strokeColorInputRef}
                  type="color"
                  value={selectedCell.labelStyle.stroke.color}
                  onChange={(e) =>
                    updateCell(selectedCell.index, {
                      labelStyle: {
                        ...(selectedCell.labelStyle ?? {}),
                        stroke: {
                          ...selectedCell.labelStyle!.stroke!,
                          color: e.target.value,
                        },
                      },
                    })
                  }
                  aria-label="Stroke colour"
                  title="Stroke colour"
                  style={{
                    width: 32,
                    height: 28,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                />
                <input
                  type="range"
                  min={1}
                  max={12}
                  step={1}
                  value={selectedCell.labelStyle.stroke.thickness}
                  onChange={(e) =>
                    updateCell(selectedCell.index, {
                      labelStyle: {
                        ...(selectedCell.labelStyle ?? {}),
                        stroke: {
                          ...selectedCell.labelStyle!.stroke!,
                          thickness: Number(e.target.value),
                        },
                      },
                    })
                  }
                  aria-label="Stroke thickness in pixels"
                  title={`Stroke thickness: ${selectedCell.labelStyle.stroke.thickness}px`}
                  style={{ width: 100 }}
                />
                <span style={{ fontSize: 11, color: '#a1a1aa', minWidth: 28, textAlign: 'right' }}>
                  {selectedCell.labelStyle.stroke.thickness}px
                </span>
              </>
            )}
          </div>

          {/* Phase 4.8a: per-cell font override. Lets a single cell
              pick its own bundled font or registered custom font
              independently of the grid's defaultLabel font. The
              composer falls back to the default when no override is
              set (cell.labelStyle is undefined or font omitted). */}
          <label style={labelStyle}>Label font (this cell)</label>
          <div style={chipRowStyle}>
            <button
              type="button"
              onClick={() =>
                updateCell(selectedCell.index, {
                  labelStyle: selectedCell.labelStyle
                    ? { ...selectedCell.labelStyle, font: undefined, customFontUrl: undefined, customFontLabel: undefined }
                    : undefined,
                })
              }
              style={chipStyle(!selectedCell.labelStyle?.font)}
            >
              Use default ({config.defaultLabel.font})
            </button>
            {FONT_OPTIONS.filter((o) => o.value !== 'custom').map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  updateCell(selectedCell.index, {
                    labelStyle: {
                      ...(selectedCell.labelStyle ?? {}),
                      font: opt.value,
                      customFontUrl: undefined,
                      customFontLabel: undefined,
                    },
                  })
                }
                style={chipStyle(selectedCell.labelStyle?.font === opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {workspaceFonts.length > 0 && (
            <>
              <p style={{ fontSize: 11, color: '#a1a1aa', margin: '6px 0 0 0' }}>
                Or pick a registered custom font:
              </p>
              <div style={chipRowStyle}>
                {workspaceFonts.map((wf) => {
                  const isActive =
                    selectedCell.labelStyle?.font === 'custom' &&
                    selectedCell.labelStyle?.customFontUrl === wf.downloadUrl;
                  return (
                    <button
                      key={wf.id}
                      type="button"
                      aria-pressed={isActive}
                      aria-label={`Set cell ${selectedCell.index} font to ${wf.name}`}
                      onClick={() => {
                        updateCell(selectedCell.index, {
                          labelStyle: {
                            ...(selectedCell.labelStyle ?? {}),
                            font: 'custom',
                            customFontUrl: wf.downloadUrl,
                            customFontLabel: wf.name,
                          },
                        });
                        setFontAnnouncement(`Cell ${selectedCell.index} font set to ${wf.name}`);
                      }}
                      style={{
                        ...chipStyle(isActive),
                        // Phase 4.9b: render the chip label in the
                        // registered font itself. Fallback stack covers
                        // the brief moment between mount and FontFace
                        // load completion.
                        fontFamily: `'${customFontFamilyName(wf.downloadUrl)}', 'Arial Black', sans-serif`,
                        fontWeight: 700,
                      }}
                      title={`${wf.name} · ${Math.round(wf.size_bytes / 1024)} KB`}
                    >
                      {wf.name}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* Phase 4.12: per-cell shadow override. Three states:
              - inherit (cell.shadow === undefined) → uses
                config.defaultShadow.
              - off (cell.shadow === null) → explicit opt-out, wins
                over the default.
              - on (cell.shadow is an object) → cell-specific shadow.
              The override surface stays compact; the defaultShadow
              sliders in Advanced are where the precise values live
              for the global default. */}
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>Cell shadow</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                aria-pressed={selectedCell.shadow === undefined}
                onClick={() => updateCell(selectedCell.index, { shadow: undefined })}
                style={chipStyle(selectedCell.shadow === undefined)}
              >
                Inherit
              </button>
              <button
                type="button"
                aria-pressed={selectedCell.shadow === null}
                onClick={() => updateCell(selectedCell.index, { shadow: null })}
                style={chipStyle(selectedCell.shadow === null)}
              >
                Off
              </button>
              <button
                type="button"
                aria-pressed={
                  selectedCell.shadow !== undefined && selectedCell.shadow !== null
                }
                onClick={() =>
                  updateCell(selectedCell.index, {
                    // Phase 4.13: seed from the canvas default first
                    // (so a per-cell tweak starts where the rest of
                    // the grid is); fall back to STARTER_CELL_SHADOW
                    // — a lighter "starter" — when there is no
                    // default so the override visibly differs from
                    // turning the toggle on for the whole grid.
                    shadow: selectedCell.shadow && selectedCell.shadow !== null
                      ? selectedCell.shadow
                      : (config.defaultShadow ?? STARTER_CELL_SHADOW),
                  })
                }
                style={chipStyle(
                  selectedCell.shadow !== undefined && selectedCell.shadow !== null,
                )}
              >
                Custom
              </button>
            </div>
            {selectedCell.shadow && selectedCell.shadow !== null && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="range"
                  min={0}
                  max={24}
                  step={1}
                  value={selectedCell.shadow.offsetY}
                  onChange={(e) =>
                    updateCell(selectedCell.index, {
                      shadow: { ...selectedCell.shadow!, offsetY: Number(e.target.value) },
                    })
                  }
                  aria-label="Cell shadow vertical offset"
                  title={`Offset: ${selectedCell.shadow.offsetY}px`}
                  style={{ width: 100 }}
                />
                <input
                  type="range"
                  min={0}
                  max={32}
                  step={1}
                  value={selectedCell.shadow.blur}
                  onChange={(e) =>
                    updateCell(selectedCell.index, {
                      shadow: { ...selectedCell.shadow!, blur: Number(e.target.value) },
                    })
                  }
                  aria-label="Cell shadow blur"
                  title={`Blur: ${selectedCell.shadow.blur}px`}
                  style={{ width: 100 }}
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={selectedCell.shadow.opacity}
                  onChange={(e) =>
                    updateCell(selectedCell.index, {
                      shadow: { ...selectedCell.shadow!, opacity: Number(e.target.value) },
                    })
                  }
                  aria-label="Cell shadow opacity"
                  title={`Opacity: ${Math.round(selectedCell.shadow.opacity * 100)}%`}
                  style={{ width: 80 }}
                />
                <input
                  type="color"
                  value={selectedCell.shadow.color}
                  onChange={(e) =>
                    updateCell(selectedCell.index, {
                      shadow: { ...selectedCell.shadow!, color: e.target.value },
                    })
                  }
                  aria-label="Cell shadow colour"
                  style={{ width: 32, height: 28, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                />
              </div>
            )}
          </div>

          {/* Phase 4.16 → 4.18: cell shape rotation. Slider from -180
              to +180 degrees plus quick-pick chips for common angles
              + a "Snap 15°" persistent toggle. When the toggle is on,
              the slider always snaps to 15° increments (no Shift
              required); when off, step=1 with Shift-snap is the
              Phase-4.17 behaviour. Rotates the shape + icon content
              but keeps the label band horizontal so multi-cell grids
              stay readable. */}
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>Cell rotation</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="range"
                min={-180}
                max={180}
                step={rotationAlwaysSnap ? 15 : 1}
                value={selectedCell.rotation ?? 0}
                onChange={(e) => {
                  // Phase 4.18: when the "Snap 15°" toggle is on, the
                  // browser's step={15} already enforces snapping —
                  // no extra rounding needed. When off, fall back to
                  // the Phase-4.17 Shift-snap behaviour.
                  const raw = Number(e.target.value);
                  let next: number;
                  if (rotationAlwaysSnap) {
                    next = raw;
                  } else {
                    const native = e.nativeEvent as { shiftKey?: boolean };
                    const shifted = native.shiftKey === true;
                    next = shifted ? Math.round(raw / 15) * 15 : raw;
                  }
                  updateCell(selectedCell.index, {
                    rotation: next === 0 ? undefined : next,
                  });
                }}
                aria-label="Cell rotation in degrees"
                title={(() => {
                  const flipParts: string[] = [];
                  if (selectedCell.flipX === true) flipParts.push('flipped X');
                  if (selectedCell.flipY === true) flipParts.push('flipped Y');
                  const flipNote = flipParts.length > 0 ? ` — ${flipParts.join(' + ')}` : '';
                  const snapNote = rotationAlwaysSnap ? ' (snapped to 15°)' : ' (hold Shift to snap to 15°)';
                  return `Rotation: ${selectedCell.rotation ?? 0}°${flipNote}${snapNote}`;
                })()}
                style={{ flex: 1, minWidth: 120 }}
              />
              <span
                style={{ fontSize: 11, color: '#a1a1aa', minWidth: 36, textAlign: 'right' }}
                aria-live="off"
              >
                {selectedCell.rotation ?? 0}°
                {/* Phase 4.20: tiny flip indicators surface the cell's
                    flip state alongside the rotation value so the
                    user doesn't have to scroll to the flip chips to
                    see what's active. */}
                {selectedCell.flipX === true && <span title="Flipped horizontally"> ⇆</span>}
                {selectedCell.flipY === true && <span title="Flipped vertically"> ⇅</span>}
              </span>
              <button
                type="button"
                aria-pressed={rotationAlwaysSnap}
                onClick={() => setRotationAlwaysSnap((x) => !x)}
                style={chipStyle(rotationAlwaysSnap)}
                title="Always snap rotation to 15° increments"
              >
                Snap 15°
              </button>
            </div>
            <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[-90, -45, 0, 45, 90].map((angle) => (
                <button
                  key={angle}
                  type="button"
                  aria-pressed={(selectedCell.rotation ?? 0) === angle}
                  onClick={() =>
                    updateCell(selectedCell.index, {
                      rotation: angle === 0 ? undefined : angle,
                    })
                  }
                  style={chipStyle((selectedCell.rotation ?? 0) === angle)}
                >
                  {angle === 0 ? 'No rotation' : `${angle}°`}
                </button>
              ))}
            </div>
            {/* Phase 4.19: flip toggles, separate from rotation.
                Mirror the cell's shape + icon content horizontally /
                vertically. Combined freely with rotation; label band
                stays un-mirrored so multi-cell grids remain readable. */}
            <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                aria-pressed={selectedCell.flipX === true}
                onClick={() =>
                  updateCell(selectedCell.index, {
                    flipX: selectedCell.flipX === true ? undefined : true,
                  })
                }
                style={chipStyle(selectedCell.flipX === true)}
                title="Mirror left ↔ right"
              >
                ⇆ Flip X
              </button>
              <button
                type="button"
                aria-pressed={selectedCell.flipY === true}
                onClick={() =>
                  updateCell(selectedCell.index, {
                    flipY: selectedCell.flipY === true ? undefined : true,
                  })
                }
                style={chipStyle(selectedCell.flipY === true)}
                title="Mirror top ↔ bottom"
              >
                ⇅ Flip Y
              </button>
            </div>
          </div>

          {/* Phase 4.12: corner badge editor. Toggle on/off plus
              text input, corner picker, and two colour swatches.
              Stays compact — badges are a small per-cell decoration
              not a global default. */}
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>Corner badge</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                aria-pressed={!!selectedCell.badge}
                onClick={() =>
                  updateCell(selectedCell.index, {
                    badge: selectedCell.badge
                      ? null
                      : { text: 'NEW', corner: 'top-right', background: '#fbbf24', color: '#0a0a0a' },
                  })
                }
                style={chipStyle(!!selectedCell.badge)}
              >
                {selectedCell.badge ? 'Badge on' : 'Badge off'}
              </button>
              {selectedCell.badge && (
                <>
                  <input
                    type="text"
                    value={selectedCell.badge.text}
                    onChange={(e) =>
                      updateCell(selectedCell.index, {
                        badge: { ...selectedCell.badge!, text: e.target.value.slice(0, 8) },
                      })
                    }
                    maxLength={8}
                    placeholder="NEW"
                    aria-label="Badge text"
                    style={{ ...inputStyle, width: 90 }}
                  />
                  <input
                    type="color"
                    value={selectedCell.badge.background}
                    onChange={(e) =>
                      updateCell(selectedCell.index, {
                        badge: { ...selectedCell.badge!, background: e.target.value },
                      })
                    }
                    aria-label="Badge background colour"
                    title="Background"
                    style={{ width: 32, height: 28, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                  />
                  <input
                    type="color"
                    value={selectedCell.badge.color}
                    onChange={(e) =>
                      updateCell(selectedCell.index, {
                        badge: { ...selectedCell.badge!, color: e.target.value },
                      })
                    }
                    aria-label="Badge text colour"
                    title="Text"
                    style={{ width: 32, height: 28, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                  />
                </>
              )}
            </div>
            {selectedCell.badge && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((corner) => (
                  <button
                    key={corner}
                    type="button"
                    aria-pressed={selectedCell.badge!.corner === corner}
                    onClick={() =>
                      updateCell(selectedCell.index, {
                        badge: { ...selectedCell.badge!, corner },
                      })
                    }
                    style={chipStyle(selectedCell.badge!.corner === corner)}
                  >
                    {corner.replace('-', ' ')}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Phase 4.20 → 4.21: copy / paste / paste-style row. Copy
              snapshots the current cell. "Paste cell" replaces the
              target fully; "Paste style" replaces only the visual
              fields and keeps the target's existing content + label
              + colour. Mirrors `applyStyleToAllCells`'s field
              selection so the two operations agree on what "style"
              means. Both paste buttons disable until something has
              been copied. */}
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => copyCell(selectedCell.index)}
              style={{ ...ghostButtonStyle, flex: 1, minWidth: 90 }}
              title="Copy this cell to the clipboard"
              aria-label={`Copy cell ${selectedCell.index} to clipboard`}
            >
              Copy cell
            </button>
            <button
              type="button"
              onClick={() => pasteCell(selectedCell.index)}
              disabled={!cellClipboard}
              style={{ ...ghostButtonStyle, flex: 1, minWidth: 90, opacity: cellClipboard ? 1 : 0.5 }}
              title={
                cellClipboard
                  ? 'Paste the clipboard cell here (full replace)'
                  : 'Copy a cell first'
              }
              aria-label={cellClipboard ? 'Paste clipboard cell here' : 'Paste disabled — no cell copied'}
            >
              Paste cell
            </button>
            <button
              type="button"
              onClick={() => pasteCellStyle(selectedCell.index)}
              disabled={!cellClipboard}
              style={{ ...ghostButtonStyle, flex: 1, minWidth: 90, opacity: cellClipboard ? 1 : 0.5 }}
              title={
                cellClipboard
                  ? 'Paste only the style (shape, ring, shadow, etc.) — keep the target\'s content'
                  : 'Copy a cell first'
              }
              aria-label={cellClipboard ? 'Paste style only' : 'Paste style disabled — no cell copied'}
            >
              Paste style
            </button>
          </div>

          {/* Phase 4.18 → 4.19: bulk apply this cell's style to every
              other cell. Uses a non-blocking 2-tap confirm — first
              click flips the button into an "Confirm?" state for 4s;
              second click inside that window commits the apply.
              Replaces the Phase-4.18 native `confirm()` dialog which
              was both visually jarring and harder to dismiss on
              mobile. Copies shape, ring, shadow, rotation,
              labelStyle, badge — NOT content, label, colour, or
              cellSpan (those typically stay per-cell). */}
          <BulkApplyStyleButton
            otherCellCount={totalCells - 1}
            onConfirm={() => {
              applyStyleToAllCells(selectedCell.index);
              toast.success('Style applied to all cells');
            }}
          />

          {/* Reset everything */}
          <button
            type="button"
            onClick={() => clearCellOverrides(selectedCell.index)}
            style={{ ...ghostButtonStyle, marginTop: 12 }}
          >
            Reset all per-cell overrides
          </button>
        </section>
      )}

      {/* Advanced */}
      <section style={sectionStyle}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((x) => !x)}
          style={{ ...ghostButtonStyle, padding: '6px 0' }}
        >
          {advancedOpen ? '▼' : '▸'} Advanced
        </button>
        {advancedOpen && (
          <div style={{ marginTop: 12, display: 'grid', gap: 16 }}>
            <div>
              <label style={labelStyle}>Default label font</label>
              <div style={chipRowStyle}>
                {FONT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      updateConfig({
                        defaultLabel: { ...config.defaultLabel, font: opt.value },
                      })
                    }
                    style={chipStyle(config.defaultLabel.font === opt.value)}
                  >
                    <span style={{ fontWeight: 900 }}>{opt.sample}</span>
                    <span style={{ marginLeft: 6, opacity: 0.7 }}>{opt.label}</span>
                  </button>
                ))}
              </div>
              {config.defaultLabel.font === 'custom' && (
                <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                  {/* Phase 4.8b: registered font chip row. Click to
                      apply, × to delete. Chips appear above the
                      upload control because reuse is more common than
                      first-time upload. */}
                  {workspaceFonts.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {workspaceFonts.map((wf) => {
                        const isActive = config.defaultLabel.customFontUrl === wf.downloadUrl;
                        return (
                          <span
                            key={wf.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              background: isActive ? '#1e3a5f' : '#1a1a1d',
                              border: '1px solid #2a2a2e',
                              borderRadius: 6,
                              padding: '4px 4px 4px 10px',
                            }}
                          >
                            <button
                              type="button"
                              aria-pressed={isActive}
                              aria-label={`Set default label font to ${wf.name}`}
                              onClick={() => {
                                updateConfig({
                                  defaultLabel: {
                                    ...config.defaultLabel,
                                    font: 'custom',
                                    customFontUrl: wf.downloadUrl,
                                    customFontLabel: wf.name,
                                  },
                                });
                                setFontAnnouncement(`Default label font set to ${wf.name}`);
                              }}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#fafafa',
                                cursor: 'pointer',
                                fontSize: 13,
                                padding: 0,
                                // Phase 4.9b: chip label renders in its own
                                // registered font face for at-a-glance
                                // preview.
                                fontFamily: `'${customFontFamilyName(wf.downloadUrl)}', 'Arial Black', sans-serif`,
                                fontWeight: 700,
                              }}
                              title={`${wf.name} · ${Math.round(wf.size_bytes / 1024)} KB`}
                            >
                              {wf.name}
                            </button>
                            <button
                              type="button"
                              aria-label={`Remove ${wf.name} from registry`}
                              onClick={() => removeRegisteredFont(wf.id, wf.name)}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#71717a',
                                cursor: 'pointer',
                                fontSize: 14,
                                padding: '0 4px',
                              }}
                              title="Remove from registry"
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="file"
                      accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadCustomFont(f);
                      }}
                    />
                    {config.defaultLabel.customFontUrl && (
                      <>
                        <span style={{ fontSize: 12, color: '#34d399' }}>
                          {config.defaultLabel.customFontLabel ?? 'Custom font'}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            updateConfig({
                              defaultLabel: {
                                ...config.defaultLabel,
                                customFontUrl: undefined,
                                customFontLabel: undefined,
                              },
                            })
                          }
                          style={ghostButtonStyle}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                  <p style={{ fontSize: 11, color: '#facc15', margin: 0 }}>
                    ⚠ Many fonts ship under restrictive licences (desktop-only, paid-only). You are
                    responsible for ensuring the font you upload may be embedded in a publicly
                    hosted thumbnail.
                  </p>
                </div>
              )}
            </div>
            <div>
              <label style={labelStyle}>Cell gap (px)</label>
              <input
                type="number"
                value={config.cellGap}
                min={0}
                max={64}
                onChange={(e) => updateConfig({ cellGap: Number(e.target.value) || 0 })}
                style={{ ...inputStyle, width: 100 }}
              />
            </div>
            <div>
              <label style={labelStyle}>Outer padding (px)</label>
              <input
                type="number"
                value={config.outerPadding}
                min={0}
                max={120}
                onChange={(e) => updateConfig({ outerPadding: Number(e.target.value) || 0 })}
                style={{ ...inputStyle, width: 100 }}
              />
            </div>
            <div>
              <label style={labelStyle}>Canvas background</label>
              <input
                type="color"
                value={config.background.type === 'solid' ? config.background.color : '#0a0a0a'}
                onChange={(e) =>
                  updateConfig({ background: { type: 'solid', color: e.target.value } })
                }
                style={{ width: 48, height: 32, border: 'none', background: 'transparent' }}
              />
            </div>
            {/* Phase 4.11: cell drop shadow. Single toggle for the
                "sticker on paper" look — gives every cell shape a
                soft cast. Per-cell overrides live behind the cell
                editor; this control sets the default. Off by default
                to keep the flat-cell look the reference channels use. */}
            <div>
              <label style={labelStyle}>Cell shadow</label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  aria-pressed={!!config.defaultShadow}
                  onClick={() =>
                    updateConfig({
                      defaultShadow: config.defaultShadow ? null : DEFAULT_SHADOW,
                    })
                  }
                  style={chipStyle(!!config.defaultShadow)}
                >
                  {config.defaultShadow ? 'Shadow on' : 'Shadow off'}
                </button>
                {config.defaultShadow && (
                  <>
                    <input
                      type="range"
                      min={0}
                      max={24}
                      step={1}
                      value={config.defaultShadow.offsetY}
                      onChange={(e) =>
                        updateConfig({
                          defaultShadow: {
                            ...config.defaultShadow!,
                            offsetY: Number(e.target.value),
                          },
                        })
                      }
                      aria-label="Shadow vertical offset"
                      title={`Vertical offset: ${config.defaultShadow.offsetY}px`}
                      style={{ width: 120 }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={32}
                      step={1}
                      value={config.defaultShadow.blur}
                      onChange={(e) =>
                        updateConfig({
                          defaultShadow: {
                            ...config.defaultShadow!,
                            blur: Number(e.target.value),
                          },
                        })
                      }
                      aria-label="Shadow blur"
                      title={`Blur: ${config.defaultShadow.blur}px`}
                      style={{ width: 120 }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={config.defaultShadow.opacity}
                      onChange={(e) =>
                        updateConfig({
                          defaultShadow: {
                            ...config.defaultShadow!,
                            opacity: Number(e.target.value),
                          },
                        })
                      }
                      aria-label="Shadow opacity"
                      title={`Opacity: ${Math.round(config.defaultShadow.opacity * 100)}%`}
                      style={{ width: 100 }}
                    />
                    <input
                      type="color"
                      value={config.defaultShadow.color}
                      onChange={(e) =>
                        updateConfig({
                          defaultShadow: { ...config.defaultShadow!, color: e.target.value },
                        })
                      }
                      aria-label="Shadow colour"
                      title="Shadow colour"
                      style={{ width: 36, height: 32, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                    />
                  </>
                )}
              </div>
            </div>
            <div>
              <label style={labelStyle}>Title bar</label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() =>
                    updateConfig({
                      titleBar: config.titleBar
                        ? undefined
                        : {
                            text: 'Every X Explained',
                            position: 'bottom',
                            height: 96,
                            background: '#0a0a0a',
                            color: '#fbfbf8',
                            font: 'anton',
                          },
                    })
                  }
                  style={chipStyle(!!config.titleBar)}
                >
                  {config.titleBar ? 'Title bar on' : 'Title bar off'}
                </button>
                {config.titleBar && (
                  <input
                    type="text"
                    value={config.titleBar.text}
                    onChange={(e) =>
                      updateConfig({
                        titleBar: { ...config.titleBar!, text: e.target.value },
                      })
                    }
                    maxLength={80}
                    placeholder="Master headline"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                )}
              </div>
              {/* Phase 4.16 → 4.17: title bar height slider exposing
                  `heightFraction` directly. Range 5–50 % of canvas
                  height — covers thin caption (~5 %) through hero
                  banner strip (~50 %). The validator caps the
                  absolute height at half canvas regardless, so the
                  slider's 50 % top matches the hard limit. */}
              {config.titleBar && (
                <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
                  <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0, minWidth: 90 }}>
                    Bar height
                  </label>
                  <input
                    type="range"
                    min={5}
                    max={50}
                    step={1}
                    value={Math.round(
                      (config.titleBar.heightFraction ?? config.titleBar.height / config.height) * 100,
                    )}
                    onChange={(e) => {
                      const fraction = Number(e.target.value) / 100;
                      updateConfig({
                        titleBar: {
                          ...config.titleBar!,
                          heightFraction: fraction,
                          height: Math.max(16, Math.round(fraction * config.height)),
                        },
                      });
                    }}
                    aria-label="Title bar height as percent of canvas"
                    title={`${Math.round(
                      (config.titleBar.heightFraction ?? config.titleBar.height / config.height) * 100,
                    )}% of canvas (${config.titleBar.height}px)`}
                    style={{ flex: 1 }}
                  />
                  <span style={{ fontSize: 11, color: '#a1a1aa', minWidth: 60 }}>
                    {Math.round(
                      (config.titleBar.heightFraction ?? config.titleBar.height / config.height) * 100,
                    )}% / {config.titleBar.height}px
                  </span>
                </div>
              )}
              {/* Phase 4.10: optional subtitle (second smaller line).
                  Rendered below the main title at ~half the size,
                  same font/colour by default. Off by default — only
                  painted when the user types something. Phase 4.11
                  adds an optional independent subtitle font. */}
              {config.titleBar && (
                <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input
                      type="text"
                      value={config.titleBar.subtitle ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateConfig({
                          titleBar: {
                            ...config.titleBar!,
                            subtitle: v.length > 0 ? v : undefined,
                          },
                        });
                      }}
                      maxLength={80}
                      placeholder="Optional subtitle (smaller second line)"
                      aria-label="Title bar subtitle"
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    {config.titleBar.subtitle && (
                      <input
                        type="color"
                        value={config.titleBar.subtitleColor ?? config.titleBar.color}
                        onChange={(e) =>
                          updateConfig({
                            titleBar: { ...config.titleBar!, subtitleColor: e.target.value },
                          })
                        }
                        aria-label="Subtitle colour"
                        title="Subtitle colour (defaults to main title colour)"
                        style={{ width: 36, height: 32, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                      />
                    )}
                  </div>
                  {/* Phase 4.11: subtitle font picker — only appears
                      once a subtitle is set. First chip ("Same as
                      title") clears the override so the subtitle
                      inherits the main font; remaining chips are the
                      bundled font set. Custom workspace-font picker
                      is not surfaced here — most users want the same
                      face or a contrasting bundled one; a custom
                      subtitle font can be edited via the JSON if
                      really needed. */}
                  {config.titleBar.subtitle && (
                    <div>
                      <label style={{ ...labelStyle, marginTop: 0 }}>Subtitle font</label>
                      <div style={chipRowStyle}>
                        <button
                          type="button"
                          aria-pressed={!config.titleBar.subtitleFont}
                          onClick={() =>
                            updateConfig({
                              titleBar: {
                                ...config.titleBar!,
                                subtitleFont: undefined,
                                subtitleCustomFontUrl: undefined,
                                subtitleCustomFontLabel: undefined,
                              },
                            })
                          }
                          style={chipStyle(!config.titleBar.subtitleFont)}
                        >
                          Same as title
                        </button>
                        {FONT_OPTIONS
                          .filter((opt) => opt.value !== 'custom')
                          .map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              aria-pressed={config.titleBar!.subtitleFont === opt.value}
                              onClick={() =>
                                updateConfig({
                                  titleBar: {
                                    ...config.titleBar!,
                                    subtitleFont: opt.value,
                                    subtitleCustomFontUrl: undefined,
                                    subtitleCustomFontLabel: undefined,
                                  },
                                })
                              }
                              style={chipStyle(config.titleBar!.subtitleFont === opt.value)}
                            >
                              {opt.label}
                            </button>
                          ))}
                      </div>
                      {/* Phase 4.12 caveat fix: workspace-font chips
                          for the subtitle. Same chip row as the main
                          title font picker — clicking applies the
                          workspace font as the subtitle's custom font. */}
                      {workspaceFonts.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {workspaceFonts.map((wf) => {
                            const isActive =
                              config.titleBar!.subtitleFont === 'custom' &&
                              config.titleBar!.subtitleCustomFontUrl === wf.downloadUrl;
                            return (
                              <button
                                key={wf.id}
                                type="button"
                                aria-pressed={isActive}
                                aria-label={`Set subtitle font to ${wf.name}`}
                                onClick={() => {
                                  updateConfig({
                                    titleBar: {
                                      ...config.titleBar!,
                                      subtitleFont: 'custom',
                                      subtitleCustomFontUrl: wf.downloadUrl,
                                      subtitleCustomFontLabel: wf.name,
                                    },
                                  });
                                  setFontAnnouncement(`Subtitle font set to ${wf.name}`);
                                }}
                                style={{
                                  ...chipStyle(isActive),
                                  fontFamily: `'${customFontFamilyName(wf.downloadUrl)}', 'Arial Black', sans-serif`,
                                  fontWeight: 700,
                                }}
                                title={`${wf.name} · ${Math.round(wf.size_bytes / 1024)} KB`}
                              >
                                {wf.name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* Phase 4.9a: title bar font picker. Same options as the
                  default label font; registered custom fonts appear as
                  chips when the user picks 'Custom upload'. */}
              {config.titleBar && (
                <div style={{ marginTop: 10 }}>
                  <label style={{ ...labelStyle, marginTop: 0 }}>Title bar font</label>
                  <div style={chipRowStyle}>
                    {FONT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          updateConfig({
                            titleBar: {
                              ...config.titleBar!,
                              font: opt.value,
                              // Clear stale custom URL when switching
                              // to a bundled font.
                              customFontUrl: opt.value === 'custom' ? config.titleBar!.customFontUrl : undefined,
                              customFontLabel: opt.value === 'custom' ? config.titleBar!.customFontLabel : undefined,
                            },
                          })
                        }
                        style={chipStyle(config.titleBar!.font === opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {config.titleBar!.font === 'custom' && workspaceFonts.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {workspaceFonts.map((wf) => {
                        const isActive = config.titleBar!.customFontUrl === wf.downloadUrl;
                        return (
                          <button
                            key={wf.id}
                            type="button"
                            aria-pressed={isActive}
                            aria-label={`Set title bar font to ${wf.name}`}
                            onClick={() => {
                              updateConfig({
                                titleBar: {
                                  ...config.titleBar!,
                                  font: 'custom',
                                  customFontUrl: wf.downloadUrl,
                                  customFontLabel: wf.name,
                                },
                              });
                              setFontAnnouncement(`Title bar font set to ${wf.name}`);
                            }}
                            style={{
                              ...chipStyle(isActive),
                              fontFamily: `'${customFontFamilyName(wf.downloadUrl)}', 'Arial Black', sans-serif`,
                              fontWeight: 700,
                            }}
                            title={`${wf.name} · ${Math.round(wf.size_bytes / 1024)} KB`}
                          >
                            {wf.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {config.titleBar.font === 'custom' && workspaceFonts.length === 0 && (
                    <p style={{ fontSize: 11, color: '#a1a1aa', marginTop: 6 }}>
                      Upload a font via the &quot;Default label font&quot; section above to populate
                      this picker. Registered fonts appear here automatically.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Sticker style picker — only shown when the panel actually
          contains at least one ai-sticker cell. Keeps the panel
          uncluttered for users who never touch the AI flow. */}
      {config.cells.some((c) => c.content.type === 'ai-sticker') && (
        <section style={sectionStyle}>
          <h3 style={sectionHeaderStyle}>Sticker style</h3>
          <div style={chipRowStyle}>
            {STICKER_STYLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setStickerStyle(preset.id)}
                title={preset.description}
                style={chipStyle(stickerStyle === preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: '#71717a', marginTop: 8 }}>
            Applied to every AI-sticker generation. Prepended as style language to each cell's prompt.
          </p>
        </section>
      )}

      {/* Sticker batch + Render buttons */}
      <section style={{ ...sectionStyle, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {config.cells.some((c) => c.content.type === 'ai-sticker') && (
          <button
            type="button"
            onClick={generateStickers}
            disabled={stickerBusy}
            style={{ ...ghostButtonStyle, padding: '10px 14px', fontSize: 13 }}
          >
            {stickerBusy ? 'Generating stickers…' : 'Generate stickers (collage mode)'}
          </button>
        )}
        <button
          type="button"
          onClick={runRender}
          disabled={busy}
          style={primaryButtonStyle(busy)}
        >
          {busy ? 'Rendering…' : 'Render thumbnail'}
        </button>
        {result && (
          <a href={downloadHref(result.imageUrl, 'flex-icon-grid.png')} style={ghostButtonStyle}>
            Download
          </a>
        )}
        {/* Phase 4.17: export / import config as JSON. Export
            downloads a pretty-printed JSON file the user can stash
            or share; import reads a previously-exported file and
            replaces the current config. Tolerant `parseConfig`
            handles minor shape drift across format versions. */}
        <button
          type="button"
          onClick={() => exportConfigJson(config)}
          style={ghostButtonStyle}
          title="Download the current thumbnail config as JSON"
          aria-label="Export config as JSON"
        >
          Export JSON
        </button>
        <label style={{ ...ghostButtonStyle, cursor: 'pointer', display: 'inline-block' }} title="Import a thumbnail config from a previously-exported JSON file">
          Import JSON
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importConfigJson(file, setConfig);
              // Reset value so the same file can be re-selected after
              // a parse error.
              e.target.value = '';
            }}
            style={{ display: 'none' }}
            aria-label="Import config from JSON file"
          />
        </label>
      </section>

      {/* Result */}
      {result && (
        <section style={sectionStyle}>
          <h3 style={sectionHeaderStyle}>Result</h3>
          {/* Font warnings (Phase 4.7 caveat fix). Surfaces any custom-
              font URLs whose fetch failed during this render so the
              user knows a label silently fell back to Anton instead of
              their picked font. */}
          {result.fontWarnings && result.fontWarnings.length > 0 && (
            <div
              style={{
                background: '#3a2e08',
                border: '1px solid #facc15',
                color: '#fefce8',
                padding: '8px 10px',
                borderRadius: 6,
                fontSize: 11,
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 700 }}>
                ⚠ {result.fontWarnings.length} custom font{result.fontWarnings.length === 1 ? '' : 's'} could not be loaded
              </div>
              <div style={{ marginTop: 4 }}>
                Affected cells fell back to the default font. The font URL may have expired or the
                upload may have been deleted. Re-upload to fix.
              </div>
            </div>
          )}
          <img
            src={result.imageUrl}
            alt="Rendered thumbnail"
            style={{ maxWidth: '100%', borderRadius: 6, display: 'block' }}
          />
        </section>
      )}
    </div>
  );
}

// ─── Icon picker ────────────────────────────────────────────────────────────

function IconPicker({
  activeSlug,
  onPick,
}: {
  activeSlug: string;
  onPick: (slug: string) => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    // Mutable IconEntry[] (not `typeof ICON_REGISTRY`) — the registry
    // itself is `readonly IconEntry[]`, but the per-category buckets we
    // build here are populated via .push().
    const byCat: Record<IconCategory, IconEntry[]> = {
      tech: [], security: [], communication: [], money: [], media: [],
      people: [], web: [], common: [], nature: [], misc: [],
    };
    const q = query.trim().toLowerCase();
    for (const entry of ICON_REGISTRY) {
      if (q && !entry.slug.includes(q) && !entry.label.toLowerCase().includes(q)) continue;
      byCat[entry.category].push(entry);
    }
    return CATEGORY_ORDER.map((cat) => ({ cat, label: CATEGORY_LABELS[cat], items: byCat[cat] }))
      .filter((g) => g.items.length > 0);
  }, [query]);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <input
        type="text"
        placeholder="Search icons…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={inputStyle}
      />
      <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #2a2a2e', borderRadius: 6, padding: 8 }}>
        {groups.map((group) => (
          <div key={group.cat} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#a1a1aa', letterSpacing: 1, marginBottom: 6 }}>
              {group.label}
            </div>
            <div data-fg-icon-grid="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))', gap: 6 }}>
              {group.items.map((entry) => (
                <button
                  key={entry.slug}
                  type="button"
                  onClick={() => onPick(entry.slug)}
                  title={entry.label}
                  style={{
                    aspectRatio: '1',
                    background: activeSlug === entry.slug ? '#1e3a5f' : '#1a1a1d',
                    border: `1px solid ${activeSlug === entry.slug ? '#38bdf8' : '#2a2a2e'}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 8,
                    color: '#fafafa',
                  }}
                >
                  <SvgPreview slug={entry.slug} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SvgPreview({ slug }: { slug: string }) {
  const inner = extractIconInner(getIconSvg(slug) ?? '');
  if (!inner) return <span style={{ fontSize: 10 }}>?</span>;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      stroke="currentColor"
      strokeWidth={2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}

// ─── Workspace-saved starting templates (Phase 4.7c) ────────────────────────

interface SavedTemplateRecord {
  id: string;
  name: string;
  config: Partial<FlexIconGridConfig>;
  updated_at: string;
}

/** Strip per-cell content from a config before saving as a template.
 *  Per-cell labels / icons / uploads are video-specific; the
 *  template should capture the user's preferred LAYOUT and STYLING
 *  defaults only. Cells are excluded; everything else round-trips. */
function trimConfigForTemplate(config: FlexIconGridConfig): Partial<FlexIconGridConfig> {
  const { cells: _cells, ...rest } = config;
  return rest;
}

function SavedTemplatesSection({
  config,
  onLoad,
}: {
  config: FlexIconGridConfig;
  onLoad: (loaded: Partial<FlexIconGridConfig>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<SavedTemplateRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, loads saved templates
      const res = await fetch('/api/thumbnails/format/flex-icon-grid/saved-templates');
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = (await res.json()) as { templates: SavedTemplateRecord[] };
      setTemplates(data.templates);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load saved templates');
    }
  }

  useEffect(() => {
    if (open && templates === null) void refresh();
  }, [open, templates]);

  async function save() {
    const name = saveName.trim();
    if (!name) {
      setError('Name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST to save template - RPC
      const res = await fetch('/api/thumbnails/format/flex-icon-grid/saved-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config: trimConfigForTemplate(config) }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Save failed (${res.status})`);
      }
      setSaveName('');
      await refresh();
      toast.success(`Saved template "${name}"`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Save failed';
      setError(reason);
      toast.error(reason);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete saved template "${name}"?`)) return;
    setBusy(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE for template - RPC
      const res = await fetch(
        `/api/thumbnails/format/flex-icon-grid/saved-templates/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      await refresh();
      toast.success('Template deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={sectionStyle}>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        style={{ ...ghostButtonStyle, padding: '6px 0', textAlign: 'left', width: '100%' }}
      >
        {open ? '▼' : '▸'} Workspace-saved starting templates
      </button>
      {open && (
        <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
          <p style={{ fontSize: 11, color: '#a1a1aa', margin: 0 }}>
            Save the current grid&apos;s layout, shape, palette, and label style as a reusable
            starting template. Per-cell content stays out of the template so loading one
            keeps your current cells intact.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Template name"
              maxLength={60}
              style={{ ...inputStyle, flex: 1, minWidth: 160 }}
            />
            <button
              type="button"
              onClick={save}
              disabled={busy || !saveName.trim()}
              style={chipStyle(false)}
            >
              {busy ? 'Saving…' : 'Save current as template'}
            </button>
          </div>
          {error && (
            <p style={{ fontSize: 11, color: '#f87171', margin: 0 }}>{error}</p>
          )}
          {templates === null && !error && (
            <p style={{ fontSize: 11, color: '#a1a1aa', margin: 0 }}>Loading…</p>
          )}
          {templates !== null && templates.length === 0 && (
            <p style={{ fontSize: 11, color: '#a1a1aa', margin: 0 }}>
              No saved templates yet.
            </p>
          )}
          {templates !== null && templates.length > 0 && (
            <div style={{ display: 'grid', gap: 6 }}>
              {templates.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: '#0a0a0d',
                    border: '1px solid #2a2a2e',
                    padding: '6px 8px',
                    borderRadius: 6,
                  }}
                >
                  <span style={{ fontSize: 12, color: '#fafafa', flex: 1 }}>{t.name}</span>
                  <button
                    type="button"
                    onClick={() => onLoad(t.config)}
                    style={{ ...chipStyle(false), padding: '4px 10px', fontSize: 12 }}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(t.id, t.name)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#71717a',
                      cursor: 'pointer',
                      fontSize: 16,
                      padding: '0 4px',
                    }}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Workspace-saved palettes (Phase 4) ─────────────────────────────────────

function SavedPalettesSection({
  currentPalette,
  palettes,
  palettesLoaded,
  onPalettesChange,
  onLoad,
}: {
  currentPalette: PaletteSpec;
  /** Shared state from the panel. The panel fetches eagerly on mount;
   *  this section just renders the list and mutates it through
   *  `onPalettesChange` after save/delete. */
  palettes: SavedPaletteRecord[];
  palettesLoaded: boolean;
  onPalettesChange: (next: SavedPaletteRecord[]) => void;
  onLoad: (colors: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    // Reads after a mutation should bypass the TTL cache so the
    // user's own write is visible immediately. The save/delete
    // handlers below call invalidate() before refresh().
    const palettes = await fetchSavedPalettesCached();
    if (palettes !== null) {
      onPalettesChange(palettes);
      setError(null);
    } else {
      setError('Could not load saved palettes');
    }
  }

  // Concrete colour list we'd save right now — the named presets
  // resolve through `paletteColours` so the user can save any of them
  // as a starting point, not only their own custom edits.
  const currentColors = paletteColours(currentPalette);

  async function save() {
    const name = saveName.trim();
    if (!name) {
      setError('Name is required');
      return;
    }
    if (currentColors.length === 0) {
      setError('Current palette is empty');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST to save palette - RPC
      const res = await fetch('/api/thumbnails/format/flex-icon-grid/saved-palettes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, colors: [...currentColors] }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Save failed (${res.status})`);
      }
      setSaveName('');
      // Drop the TTL cache so the next read picks up the new row.
      invalidateSavedPalettesCache();
      await refresh();
      toast.success(`Saved palette "${name}"`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Save failed';
      setError(reason);
      toast.error(reason);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete saved palette "${name}"?`)) return;
    setBusy(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE for palette - RPC
      const res = await fetch(
        `/api/thumbnails/format/flex-icon-grid/saved-palettes/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      invalidateSavedPalettesCache();
      await refresh();
      toast.success('Palette deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #2a2a2e' }}>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        style={{ ...ghostButtonStyle, padding: '6px 0', textAlign: 'left' }}
      >
        {open ? '▼' : '▸'} Workspace-saved palettes
      </button>
      {open && (
        <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Palette name"
              maxLength={60}
              style={{ ...inputStyle, flex: 1, minWidth: 160 }}
            />
            <button
              type="button"
              onClick={save}
              disabled={busy || !saveName.trim()}
              style={chipStyle(false)}
            >
              {busy ? 'Saving…' : 'Save current palette'}
            </button>
          </div>
          {error && (
            <p style={{ fontSize: 11, color: '#f87171', margin: 0 }}>{error}</p>
          )}
          {!palettesLoaded && !error && (
            <p style={{ fontSize: 11, color: '#a1a1aa', margin: 0 }}>Loading…</p>
          )}
          {palettesLoaded && palettes.length === 0 && (
            <p style={{ fontSize: 11, color: '#a1a1aa', margin: 0 }}>
              No saved palettes yet. Name one above and click &quot;Save current palette&quot;.
            </p>
          )}
          {palettesLoaded && palettes.length > 0 && (
            <div style={{ display: 'grid', gap: 6 }}>
              {palettes.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: '#0a0a0d',
                    border: '1px solid #2a2a2e',
                    padding: '6px 8px',
                    borderRadius: 6,
                  }}
                >
                  <PaletteSwatchRow spec={{ type: 'custom', colors: p.colors }} />
                  <span style={{ fontSize: 12, color: '#fafafa', flex: 1 }}>{p.name}</span>
                  <button
                    type="button"
                    onClick={() => onLoad(p.colors)}
                    style={{ ...chipStyle(false), padding: '4px 10px', fontSize: 12 }}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(p.id, p.name)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#71717a',
                      cursor: 'pointer',
                      fontSize: 16,
                      padding: '0 4px',
                    }}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Custom palette editor (Phase 3.5) ──────────────────────────────────────

function CustomPaletteEditor({
  palette,
  onChange,
}: {
  palette: Extract<PaletteSpec, { type: 'custom' }>;
  onChange: (next: PaletteSpec) => void;
}) {
  const update = (next: string[]) => onChange({ type: 'custom', colors: next });

  // Drag-to-reorder state (Phase 4.6). HTML5 drag API rather than
  // @dnd-kit because the list is short, in-cell, and doesn't need
  // keyboard reorder support — a 30-line implementation beats a
  // dependency pull-in. `dragIndex` is the slot being dragged;
  // `overIndex` is the current drop target (for the highlight
  // outline). Both clear on drop / dragend.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  function handleDragStart(i: number, e: React.DragEvent<HTMLDivElement>) {
    setDragIndex(i);
    e.dataTransfer.effectAllowed = 'move';
    // Setting data is required for Firefox to start the drag at all.
    e.dataTransfer.setData('text/plain', String(i));
  }
  function handleDragOver(i: number, e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault(); // allow drop
    e.dataTransfer.dropEffect = 'move';
    if (overIndex !== i) setOverIndex(i);
  }
  function handleDrop(targetIndex: number, e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const sourceIndexStr = e.dataTransfer.getData('text/plain');
    const sourceIndex = Number(sourceIndexStr);
    setDragIndex(null);
    setOverIndex(null);
    if (!Number.isInteger(sourceIndex) || sourceIndex === targetIndex) return;
    const next = [...palette.colors];
    const [moved] = next.splice(sourceIndex, 1);
    // Account for the index shift when inserting after the source.
    const insertAt = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    next.splice(insertAt, 0, moved);
    update(next);
  }
  function handleDragEnd() {
    setDragIndex(null);
    setOverIndex(null);
  }

  /** Swap two slots in the colour list. Used by the keyboard-
   *  accessible "Move up / Move down" buttons (Phase 4.7a). */
  function moveBy(i: number, delta: number) {
    const target = i + delta;
    if (target < 0 || target >= palette.colors.length) return;
    const next = [...palette.colors];
    [next[i], next[target]] = [next[target], next[i]];
    update(next);
  }

  return (
    <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
      <p style={{ fontSize: 11, color: '#a1a1aa', margin: 0 }}>
        Drag the grip ⋮⋮ to reorder or use the ↑/↓ buttons. Click a swatch to change its colour.
        The adjacency engine cycles through these in order across the grid.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {palette.colors.map((c, i) => (
          <div
            key={`${c}-${i}`}
            draggable
            onDragStart={(e) => handleDragStart(i, e)}
            onDragOver={(e) => handleDragOver(i, e)}
            onDrop={(e) => handleDrop(i, e)}
            onDragEnd={handleDragEnd}
            aria-label={`Palette colour ${i + 1} of ${palette.colors.length}: ${normaliseHex(c).toUpperCase()}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: '#0a0a0d',
              // Highlight the drop target in the same cyan the cell
              // editor uses, and dim the slot being dragged so the
              // user gets unambiguous "this is moving / this is the
              // destination" feedback.
              border: overIndex === i
                ? '1px dashed #38bdf8'
                : '1px solid #2a2a2e',
              padding: 4,
              borderRadius: 6,
              opacity: dragIndex === i ? 0.45 : 1,
            }}
          >
            {/* Grip handle — visual + touch affordance for drag, plus
                a long-press target on mobile. cursor: grab signals the
                drag intent. The ⋮⋮ glyph is purely decorative; screen
                readers skip it via aria-hidden. */}
            <span
              aria-hidden="true"
              title="Drag to reorder"
              style={{
                color: '#52525b',
                fontFamily: 'monospace',
                fontSize: 14,
                cursor: 'grab',
                padding: '0 2px',
                userSelect: 'none',
              }}
            >
              ⋮⋮
            </span>
            <input
              type="color"
              value={normaliseHex(c)}
              onChange={(e) => {
                const next = [...palette.colors];
                next[i] = e.target.value;
                update(next);
              }}
              style={swatchInputStyle}
            />
            <span style={{ fontSize: 11, color: '#a1a1aa', fontFamily: 'monospace' }}>
              {normaliseHex(c).toUpperCase()}
            </span>
            {/* Keyboard-accessible reorder. Disabled at the edges so
                arrow-key navigation through the slots doesn't trigger
                no-op clicks. */}
            <button
              type="button"
              onClick={() => moveBy(i, -1)}
              disabled={i === 0}
              aria-label="Move colour up"
              title="Move up"
              style={miniReorderButtonStyle(i === 0)}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => moveBy(i, 1)}
              disabled={i === palette.colors.length - 1}
              aria-label="Move colour down"
              title="Move down"
              style={miniReorderButtonStyle(i === palette.colors.length - 1)}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => update(palette.colors.filter((_, j) => j !== i))}
              aria-label="Remove colour"
              title="Remove this colour"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#71717a',
                cursor: 'pointer',
                fontSize: 14,
                padding: '0 4px',
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => update([...palette.colors, '#FACC15'])}
          style={{
            background: '#1a1a1d',
            border: '1px dashed #38bdf8',
            color: '#38bdf8',
            padding: '6px 14px',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          + Add colour
        </button>
      </div>
      {palette.colors.length < 2 && (
        <p style={{ fontSize: 11, color: '#facc15', margin: 0 }}>
          The adjacency rule needs at least 2 colours to alternate. The renderer falls back to the
          rainbow preset until you add more.
        </p>
      )}
    </div>
  );
}

/** Normalise an arbitrary user-typed colour string to `#RRGGBB` for
 *  the native colour input (which rejects shorthand `#RGB`). */
function normaliseHex(s: string): string {
  const trimmed = s.trim().replace(/^#/, '');
  if (trimmed.length === 3) {
    return '#' + trimmed.split('').map((c) => c + c).join('');
  }
  if (trimmed.length === 6) return '#' + trimmed;
  return '#888888';
}

// ─── Span conflict warning ──────────────────────────────────────────────────

const SPAN_CONFLICT_MESSAGES: Record<SpanConflictReason, { title: string; body: string }> = {
  'consumed-by-earlier': {
    title: 'Cell is hidden — claimed by an earlier span',
    body:
      'This cell sits inside another cell\'s span and isn\'t drawn in the rendered thumbnail. '
      + 'Its own span (if any) is ignored. Edit the earlier spanning cell to free this slot.',
  },
  'clamped-to-grid': {
    title: 'Span clamped to fit the grid',
    body:
      'This cell\'s span extends past the grid edge. The renderer clips it to fit, which means '
      + 'the rendered tile is smaller than the configured span. Pick a smaller span or move '
      + 'the cell inward.',
  },
};

function SpanConflictWarning({
  reason,
  clampedSpan,
  onAutoResolve,
}: {
  reason: SpanConflictReason;
  /** For `clamped-to-grid`: the actual span the auto-resolve would
   *  apply. Lets the button label show concrete dimensions ("Clamp to
   *  2×1") or switch to "Clear span" when the clamp would collapse
   *  to 1×1. Ignored for the other reasons. */
  clampedSpan?: { rows: number; cols: number } | null;
  onAutoResolve?: () => void;
}) {
  const { title, body } = SPAN_CONFLICT_MESSAGES[reason];
  let actionLabel: string;
  if (reason === 'consumed-by-earlier') {
    actionLabel = 'Clear this cell\'s span';
  } else {
    // clamped-to-grid
    if (clampedSpan && clampedSpan.rows === 1 && clampedSpan.cols === 1) {
      actionLabel = 'Clear span';
    } else if (clampedSpan) {
      actionLabel = `Clamp to ${clampedSpan.rows}×${clampedSpan.cols}`;
    } else {
      actionLabel = 'Clamp span to fit';
    }
  }
  return (
    <div
      style={{
        background: '#3a2e08',
        border: '1px solid #facc15',
        color: '#fefce8',
        padding: '10px 12px',
        borderRadius: 6,
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ {title}</div>
      <div style={{ lineHeight: 1.5 }}>{body}</div>
      {onAutoResolve && (
        <button
          type="button"
          onClick={onAutoResolve}
          style={{
            marginTop: 8,
            background: '#facc15',
            color: '#0a0a0a',
            border: 'none',
            padding: '6px 12px',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          Auto-resolve · {actionLabel}
        </button>
      )}
    </div>
  );
}

// ─── Cell span editor (cell-merge) ──────────────────────────────────────────

function CellSpanEditor({
  cell,
  rows,
  cols,
  onChange,
}: {
  cell: FlexIconCell;
  rows: number;
  cols: number;
  onChange: (span: { rows: number; cols: number } | undefined) => void;
}) {
  const i = cell.index - 1;
  const baseR = Math.floor(i / cols);
  const baseC = i % cols;
  const maxRowSpan = rows - baseR;
  const maxColSpan = cols - baseC;
  const span = cell.cellSpan ?? { rows: 1, cols: 1 };

  return (
    <div>
      <label style={labelStyle}>Cell-merge span (rows × cols)</label>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <select
          value={span.rows}
          onChange={(e) => {
            const r = Number(e.target.value);
            if (r === 1 && span.cols === 1) onChange(undefined);
            else onChange({ rows: r, cols: span.cols });
          }}
          style={{ ...inputStyle, width: 70 }}
        >
          {Array.from({ length: maxRowSpan }, (_, k) => k + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <span style={{ color: '#a1a1aa' }}>×</span>
        <select
          value={span.cols}
          onChange={(e) => {
            const c = Number(e.target.value);
            if (c === 1 && span.rows === 1) onChange(undefined);
            else onChange({ rows: span.rows, cols: c });
          }}
          style={{ ...inputStyle, width: 70 }}
        >
          {Array.from({ length: maxColSpan }, (_, k) => k + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        {(span.rows > 1 || span.cols > 1) && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            style={ghostButtonStyle}
          >
            Reset to 1×1
          </button>
        )}
      </div>
      <p style={{ fontSize: 11, color: '#71717a', marginTop: 6 }}>
        Spanning consumes the cells immediately to the right and below. Consumed cells stay in
        the config but are skipped at render time.
      </p>
    </div>
  );
}

// ─── Palette adjust chip (Phase 4.24) ───────────────────────────────────────

/**
 * Single chip for a one-tap palette adjustment (Lighten / Darken /
 * More vivid / Muted). Renders the monospace badge + label; when
 * `atLimit` is true the chip dims, the tooltip switches to the
 * "at limit" copy, and the button stays clickable (the user can
 * still confirm — it's just a no-op). Click handler + label
 * supplied by the caller so the same chip can serve every
 * adjustment direction without leaking helper imports here.
 */
function PaletteAdjustChip({
  label,
  badge,
  atLimit,
  title,
  onClick,
}: {
  label: string;
  badge: string;
  atLimit: boolean;
  title: string;
  onClick: () => void;
}) {
  const limitTitle = atLimit
    ? `${title} (at limit — every colour is already as ${label.toLowerCase()} as it can go)`
    : title;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...chipStyle(false),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: atLimit ? 0.55 : 1,
      }}
      title={limitTitle}
      aria-label={`${label} palette${atLimit ? ' (at limit)' : ''}`}
    >
      <span
        aria-hidden="true"
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 10 }}
      >
        {badge}
      </span>
      {label}
    </button>
  );
}

/** Phase 4.24 → 4.25: shallow-equal two readonly colour arrays.
 *  Used to detect "adjust would be a no-op". Phase 4.25 normalises
 *  `#RGB` to `#RRGGBB` first so a palette mixing the two formats
 *  (e.g. one entry seeded from a `#fff` shorthand, another from
 *  the helper's verbose output) doesn't read as "different" when
 *  no semantic change occurred. */
function colorsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (normalizeHex(a[i]) !== normalizeHex(b[i])) return false;
  }
  return true;
}

/** Phase 4.25 → 4.26: lower-cased `#RRGGBB`. Three-digit shorthand
 *  `#RGB` expands to `#RRGGBB`; six-digit hex is lower-cased.
 *  Phase 4.26 — anything else (malformed `#abcd`, non-`#` prefix,
 *  whitespace-only) is returned lower-cased AND prefixed with a
 *  sentinel `bad:` token so two malformed values that happen to be
 *  identical strings still compare equal, but a malformed value
 *  never collides with a real `#RRGGBB` colour. Defensive against
 *  a doctored config whose `#abcd` would otherwise read as equal
 *  to itself (true) but the comparison would feel coincidental. */
function normalizeHex(input: string): string {
  const v = input.toLowerCase().trim();
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(v)) {
    return v;
  }
  return `bad:${v}`;
}

// ─── Label position preview (Phase 4.19) ────────────────────────────────────

/**
 * Tiny SVG glyph showing where the label band sits relative to the
 * shape for each `LabelStyle['position']` variant. Used inside the
 * per-cell label-position chips so the visual meaning of "overlay"
 * / "hidden" / "above" / "below" is obvious at a glance — no docs
 * reading required. 22 × 16 viewport keeps the chip compact.
 */
function LabelPositionPreview({ position }: { position: 'below' | 'above' | 'overlay' | 'hidden' }) {
  // Phase 4.20: use `currentColor` for the shape and a derived
  // translucent shade for the band. Inherits the button's text
  // colour so the glyph stays legible whether the chip is pressed
  // (high-contrast text) or idle (muted text). No hardcoded greys
  // means future light-mode theming Just Works.
  const shape = 'currentColor';
  const band = 'currentColor';
  const stroke = 'currentColor';
  return (
    <svg width={22} height={16} viewBox="0 0 22 16" aria-hidden="true" focusable="false">
      <rect
        x={0} y={0} width={22} height={16} rx={2} ry={2}
        fill="transparent" stroke={stroke} strokeOpacity={0.25}
      />
      {position === 'below' && (
        <>
          <circle cx={11} cy={6} r={3.5} fill={shape} fillOpacity={0.95} />
          <rect x={2} y={11} width={18} height={3} fill={band} fillOpacity={0.55} />
        </>
      )}
      {position === 'above' && (
        <>
          <rect x={2} y={2} width={18} height={3} fill={band} fillOpacity={0.55} />
          <circle cx={11} cy={10} r={3.5} fill={shape} fillOpacity={0.95} />
        </>
      )}
      {position === 'overlay' && (
        <>
          <circle cx={11} cy={8} r={5} fill={shape} fillOpacity={0.95} />
          <rect x={2} y={10} width={18} height={3} fill={band} fillOpacity={0.45} />
        </>
      )}
      {position === 'hidden' && (
        <circle cx={11} cy={8} r={5} fill={shape} fillOpacity={0.95} />
      )}
    </svg>
  );
}

// ─── Bulk apply button (Phase 4.19) ─────────────────────────────────────────

/**
 * Two-tap "Apply style to all cells" button. First tap flips the
 * button to a confirm state for 4 seconds; second tap inside that
 * window commits the apply. After the timeout the button silently
 * returns to its primary state. Replaces the native `confirm()` so
 * the affordance lives inline with the other controls instead of
 * popping a system dialog.
 */
function BulkApplyStyleButton({
  otherCellCount,
  onConfirm,
}: {
  otherCellCount: number;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);
  // Phase 4.21: when the button arms, give keyboard focus to the
  // cancel chip so Tab/Enter behaviour matches the visible "armed"
  // affordance, and Esc disarms cleanly without leaving focus
  // somewhere stale. Skipped on the initial mount (armed=false).
  useEffect(() => {
    if (armed) cancelRef.current?.focus();
  }, [armed]);
  const disarm = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
  };
  const handleClick = () => {
    if (armed) {
      disarm();
      onConfirm();
      return;
    }
    setArmed(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setArmed(false);
      timerRef.current = null;
    }, 6000);
  };
  return (
    <div
      style={{ display: 'flex', gap: 6, marginTop: 12 }}
      onKeyDown={(e) => {
        // Esc dismisses the armed state from anywhere in this row.
        if (e.key === 'Escape' && armed) {
          e.preventDefault();
          disarm();
        }
      }}
    >
      <button
        type="button"
        onClick={handleClick}
        style={{
          ...ghostButtonStyle,
          flex: 1,
          borderColor: armed ? '#fbbf24' : undefined,
          color: armed ? '#fbbf24' : undefined,
        }}
        aria-pressed={armed}
        title={
          armed
            ? `Click again to confirm — applies to ${otherCellCount} other cells`
            : `Apply this cell's style to ${otherCellCount} other cells`
        }
      >
        {armed
          ? `Click again to confirm (${otherCellCount} cells)`
          : 'Apply style to all cells'}
      </button>
      {armed && (
        <button
          ref={cancelRef}
          type="button"
          onClick={disarm}
          style={{ ...ghostButtonStyle, paddingLeft: 12, paddingRight: 12 }}
          aria-label="Cancel apply (or press Esc)"
          title="Cancel (Esc)"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ─── Cell background editor ─────────────────────────────────────────────────

function CellBackgroundEditor({
  cell,
  palettePreviewColour,
  onChange,
}: {
  cell: FlexIconCell;
  /** Phase 4.14: the resolved palette colour for this cell — what the
   *  palette engine would assign when the user is in "Use palette"
   *  mode. Used to seed the "Lock current colour" button. */
  palettePreviewColour: string;
  onChange: (patch: Partial<FlexIconCell>) => void;
}) {
  // Effective spec: explicit `background` wins; legacy `backgroundColor`
  // becomes a solid spec; neither → "Use palette" sentinel.
  const usingPalette = !cell.background && !cell.backgroundColor;
  const spec: CellBackgroundSpec | null = cell.background
    ? cell.background
    : cell.backgroundColor
      ? { type: 'solid', color: cell.backgroundColor }
      : null;
  const activeType: 'palette' | CellBackgroundSpec['type'] = usingPalette ? 'palette' : spec!.type;

  function pickType(next: 'palette' | CellBackgroundSpec['type']) {
    if (next === 'palette') {
      onChange({ background: undefined, backgroundColor: undefined });
      return;
    }
    if (next === 'solid') {
      const colour = spec?.type === 'solid' ? spec.color : cell.backgroundColor ?? '#1a1a1a';
      // Use the legacy `backgroundColor` shorthand for plain solid — wire
      // compatibility with Phase-1 stored thumbnails.
      onChange({ background: undefined, backgroundColor: colour });
      return;
    }
    if (next === 'gradient') {
      const from = spec?.type === 'gradient' ? spec.from : '#FF6B00';
      const to = spec?.type === 'gradient' ? spec.to : '#FF0040';
      const angle = spec?.type === 'gradient' ? spec.angle : 135;
      onChange({ background: { type: 'gradient', from, to, angle }, backgroundColor: undefined });
      return;
    }
    if (next === 'pattern') {
      const pattern = spec?.type === 'pattern' ? spec.pattern : 'dots';
      const fg = spec?.type === 'pattern' ? spec.fg : '#0a0a0a';
      const bg = spec?.type === 'pattern' ? spec.bg : '#FFD60A';
      onChange({ background: { type: 'pattern', pattern, fg, bg }, backgroundColor: undefined });
      return;
    }
    // image
    const url = spec?.type === 'image' ? spec.url : '';
    onChange({ background: { type: 'image', url }, backgroundColor: undefined });
  }

  function updateSpec(patch: Partial<CellBackgroundSpec>) {
    if (!spec) return;
    onChange({ background: { ...spec, ...patch } as CellBackgroundSpec, backgroundColor: undefined });
  }

  return (
    <div>
      <label style={labelStyle}>Background</label>
      <div style={chipRowStyle}>
        {(['palette', 'solid', 'gradient', 'pattern', 'image'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => pickType(t)}
            style={chipStyle(activeType === t)}
          >
            {t === 'palette' ? 'Use palette' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {/* Phase 4.14: one-click lock for the current palette colour.
          Visible only when the cell is still in palette mode (the
          colour is being assigned dynamically). Click → captures the
          current palette colour into `backgroundColor`, switching the
          cell into solid mode so a palette re-roll leaves it alone.
          Phase 4.15: complementary "Restore palette" chip appears
          when the cell is in solid mode — one click drops the
          explicit colour and the palette re-flows. The two chips
          are mutually exclusive: at most one shows at a time. */}
      {usingPalette && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() =>
              onChange({ backgroundColor: palettePreviewColour, background: undefined })
            }
            style={{ ...chipStyle(false), display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title="Freeze this cell's current palette colour so it survives a re-roll"
            aria-label={`Lock current palette colour ${palettePreviewColour}`}
          >
            <span
              style={{
                display: 'inline-block',
                width: 14,
                height: 14,
                borderRadius: 4,
                background: palettePreviewColour,
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            />
            Lock current colour
          </button>
        </div>
      )}
      {!usingPalette && activeType === 'solid' && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => onChange({ backgroundColor: undefined, background: undefined })}
            style={{ ...chipStyle(false), display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title="Return this cell to palette-driven colour assignment"
            aria-label="Restore palette colour for this cell"
          >
            {/* Phase 4.16: solid swatch matches the Lock chip's
                visual language; the leading ↻ glyph (and the
                button label) carry the "this restores" meaning. */}
            <span
              style={{
                display: 'inline-block',
                width: 14,
                height: 14,
                borderRadius: 4,
                background: palettePreviewColour,
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            />
            <span aria-hidden="true">↻</span>
            Restore palette
          </button>
        </div>
      )}

      {activeType === 'solid' && spec?.type === 'solid' && (
        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="color"
            value={spec.color}
            onChange={(e) => onChange({ backgroundColor: e.target.value, background: undefined })}
            style={swatchInputStyle}
          />
          <span style={{ fontSize: 12, color: '#a1a1aa' }}>{spec.color}</span>
        </div>
      )}

      {activeType === 'gradient' && spec?.type === 'gradient' && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0, width: 60 }}>From</label>
            <input
              type="color"
              value={spec.from}
              onChange={(e) => updateSpec({ from: e.target.value })}
              style={swatchInputStyle}
            />
            <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0, width: 40 }}>To</label>
            <input
              type="color"
              value={spec.to}
              onChange={(e) => updateSpec({ to: e.target.value })}
              style={swatchInputStyle}
            />
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0, width: 60 }}>Angle</label>
            <input
              type="range"
              min={0}
              max={360}
              value={spec.angle}
              onChange={(e) => updateSpec({ angle: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 12, color: '#a1a1aa', width: 40, textAlign: 'right' }}>{spec.angle}°</span>
          </div>
        </div>
      )}

      {activeType === 'pattern' && spec?.type === 'pattern' && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <div style={chipRowStyle}>
            {(['dots', 'stripes', 'grid', 'checker'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => updateSpec({ pattern: p })}
                style={chipStyle(spec.pattern === p)}
              >
                {p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0, width: 60 }}>Pattern</label>
            <input
              type="color"
              value={spec.fg}
              onChange={(e) => updateSpec({ fg: e.target.value })}
              style={swatchInputStyle}
            />
            <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0, width: 60 }}>Base</label>
            <input
              type="color"
              value={spec.bg}
              onChange={(e) => updateSpec({ bg: e.target.value })}
              style={swatchInputStyle}
            />
          </div>
        </div>
      )}

      {activeType === 'image' && spec?.type === 'image' && (
        <div style={{ marginTop: 10 }}>
          <input
            type="text"
            value={spec.url}
            onChange={(e) => updateSpec({ url: e.target.value })}
            placeholder="Image URL (must be on the R2 allowlist)"
            style={inputStyle}
          />
        </div>
      )}
    </div>
  );
}

const swatchInputStyle: React.CSSProperties = {
  width: 48,
  height: 32,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
};

/** Compact ↑/↓ reorder buttons for the custom palette editor. Sized
 *  to sit inline with the colour swatch without taking visual
 *  precedence over the colour itself. Disabled state dims rather than
 *  hides — the static button position keeps the slot widths stable
 *  while iterating through the list. */
function miniReorderButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid #2a2a2e',
    color: disabled ? '#3f3f46' : '#a1a1aa',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 11,
    padding: '2px 5px',
    borderRadius: 3,
    minWidth: 18,
    minHeight: 18,
  };
}

// ─── Upload field ───────────────────────────────────────────────────────────

function UploadField({
  currentUrl,
  uploading,
  onFile,
  onClear,
}: {
  currentUrl: string;
  uploading: boolean;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <label style={labelStyle}>Upload</label>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
          disabled={uploading}
        />
        {uploading && <span style={{ color: '#a1a1aa' }}>Uploading…</span>}
        {currentUrl && !uploading && (
          <>
            <a href={currentUrl} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>
              View attached image
            </a>
            <button type="button" onClick={onClear} style={ghostButtonStyle}>
              Clear
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Palette swatch ─────────────────────────────────────────────────────────

function PaletteSwatchRow({ spec }: { spec: PaletteSpec }) {
  const colours = paletteColours(spec).slice(0, 6);
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      {colours.map((c, i) => (
        <span
          key={i}
          style={{
            width: 14,
            height: 14,
            background: c,
            borderRadius: 3,
            display: 'inline-block',
          }}
        />
      ))}
    </span>
  );
}

// ─── Inline styles ──────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  padding: 16,
};

const sectionStyle: React.CSSProperties = {
  background: '#15151a',
  border: '1px solid #2a2a2e',
  borderRadius: 8,
  padding: 14,
};

const cellEditorStyle: React.CSSProperties = {
  ...sectionStyle,
  background: '#101019',
  borderColor: '#38bdf8',
  display: 'grid',
  gap: 10,
};

const cellEditorHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 4,
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: '#a1a1aa',
  margin: '0 0 8px 0',
};

const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? '#1e3a5f' : '#1a1a1d',
    border: `1px solid ${active ? '#38bdf8' : '#2a2a2e'}`,
    color: '#fafafa',
    padding: '7px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    display: 'inline-flex',
    alignItems: 'center',
  };
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: '#a1a1aa',
  marginBottom: 6,
  marginTop: 6,
};

const inputStyle: React.CSSProperties = {
  background: '#0a0a0d',
  border: '1px solid #2a2a2e',
  color: '#fafafa',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

const ghostButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #2a2a2e',
  color: '#a1a1aa',
  padding: '6px 12px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  textDecoration: 'none',
  display: 'inline-block',
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? '#1e3a5f' : '#0284c7',
    color: '#fafafa',
    border: 'none',
    padding: '10px 18px',
    borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 14,
    fontWeight: 600,
  };
}
