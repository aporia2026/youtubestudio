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
  makeDefaultConfig,
  type CellBackgroundSpec,
  type CellContent,
  type CellShape,
  type FlexIconCell,
  type FlexIconGridConfig,
  type LabelFont,
  type PaletteSpec,
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
import { FlexIconGridLivePreview } from './FlexIconGridLivePreview';

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
];

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
   * type that has a prompt but no URL yet. Batches them in groups of
   * 4 (one image-gen call per group of 4) per the collage-mode cost
   * pattern. Each batch updates the cells in place as soon as it
   * returns; partial failures still keep successful batches.
   */
  async function generateStickers() {
    const targets = config.cells.filter(
      (c) => c.content.type === 'ai-sticker' && !!c.content.prompt && !c.content.url,
    );
    if (targets.length === 0) {
      toast.info('No sticker prompts pending generation.');
      return;
    }
    // Pad batches with a generic neutral prompt when the final batch
    // has fewer than 4 cells — the route requires exactly 4 entries
    // per call (2×2 collage). Filler cellIndexes use a high reserved
    // range (9000+) so the server's validation (cellIndex >= 1)
    // accepts them, and the client-side update loop ignores them
    // because no real cell has that index.
    const batches: Array<Array<{ cellIndex: number; prompt: string }>> = [];
    const FILLER_BASE = 9000;
    for (let i = 0; i < targets.length; i += 4) {
      const chunk = targets.slice(i, i + 4).map((cell) => ({
        cellIndex: cell.index,
        prompt: cell.content.type === 'ai-sticker' ? cell.content.prompt : '',
      }));
      while (chunk.length < 4) {
        chunk.push({
          cellIndex: FILLER_BASE + chunk.length,
          prompt: 'a neutral grey blank background',
        });
      }
      batches.push(chunk);
    }
    setStickerBusy(true);
    console.info('[flex-icon-grid panel sticker] batch start', {
      target_count: targets.length, batch_count: batches.length,
    });
    try {
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const res = await fetch('/api/thumbnails/format/flex-icon-grid/generate-stickers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stickers: batch }),
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
    <div style={containerStyle}>
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
        </div>
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
        <section style={cellEditorStyle}>
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
                    },
                  })
                }
                rows={3}
                placeholder="e.g. flat sticker of a hooded rat on a bright yellow background"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
              {selectedCell.content.url && (
                <p style={{ fontSize: 11, color: '#34d399', marginTop: 6 }}>
                  Sticker generated. <a href={selectedCell.content.url} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>View</a>
                </p>
              )}
              {!selectedCell.content.url && (
                <p style={{ fontSize: 11, color: '#a1a1aa', marginTop: 6 }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))', gap: 6 }}>
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
