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

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { downloadHref } from '@/lib/download-file';
import type { ThumbnailRegion } from '@/remotion/types';
import {
  getSpanConflicts,
  makeDefaultConfig,
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
  paletteColours,
} from '@/lib/thumbnail-formats/flex-icon-grid-palettes';
import {
  DEFAULT_STICKER_STYLE,
  STICKER_STYLE_PRESETS,
} from '@/lib/thumbnail-formats/flex-icon-grid-sticker-styles';
import {
  fetchSavedPalettesCached,
  invalidateSavedPalettesCache,
} from '@/lib/flex-icon-grid-saved-palettes-client-cache';
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
      labelStyle: undefined,
      cellSpan: undefined,
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
      const { uploadUrl, downloadUrl } = await presignRes.json();
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'font/ttf' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);
      updateConfig({
        defaultLabel: {
          ...config.defaultLabel,
          font: 'custom',
          customFontUrl: downloadUrl,
          customFontLabel: file.name.replace(/\.(ttf|otf|woff|woff2)$/i, ''),
        },
      });
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
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionHeaderStyle}>Palette</h3>
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
                onClick={() => updateConfig({ palette: opt.value })}
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
        </div>
        {config.palette.type === 'custom' && (
          <CustomPaletteEditor
            palette={config.palette}
            onChange={(next) => updateConfig({ palette: next })}
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
        <h3 style={sectionHeaderStyle}>Live preview · click any cell to edit</h3>
        <FlexIconGridLivePreview
          config={config}
          highlightedCellIndex={selectedCellIndex}
          onCellClick={(idx) => setSelectedCellIndex(idx)}
        />
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

          {/* Cell background (overrides palette for this cell). */}
          <CellBackgroundEditor
            cell={selectedCell}
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
                <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
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
      </section>

      {/* Result */}
      {result && (
        <section style={sectionStyle}>
          <h3 style={sectionHeaderStyle}>Result</h3>
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

// ─── Cell background editor ─────────────────────────────────────────────────

function CellBackgroundEditor({
  cell,
  onChange,
}: {
  cell: FlexIconCell;
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
