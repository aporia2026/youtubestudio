'use client';

/**
 * Topic Card Grid format — UI component for the /thumbnails page.
 *
 * Two-step flow with mandatory user review by default, plus Pre-fill and
 * One-shot shortcut modes. See _plans/2026-05-19-thumbnail-format-topic-
 * card-grid.md for the contract this component implements.
 *
 * State A: editable card table after Step 1 (LLM card list).
 * State B: rendered image with region overlay after Step 2 (image gen).
 *
 * Parent (page.tsx) owns: title, niche, script, description, modelId,
 * referenceImageUrl, and the schedule-link saver. This component owns:
 * grid size, format mode, the card list editor, the result + regions.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { downloadHref } from '@/lib/download-file';
import type { ThumbnailRegion } from '@/remotion/types';

// ─── Types mirroring the API contract ───────────────────────────────────────

export interface FormatCard {
  index: number;
  label: string;
  icon_concept: string;
  accent_color?: string;
}

export interface FormatPalette {
  background: string;
  primary_accent: string;
  secondary_accent: string;
}

export interface FormatGenerationResult {
  imageUrl: string;
  regions: ThumbnailRegion[];
  cards: FormatCard[];
  palette: FormatPalette;
  gridRows: number;
  gridCols: number;
  gridMode: 'preset' | 'custom';
  mode: 'review' | 'pre-fill' | 'one-shot';
  formatImageModel: string;
  referenceImageUrl?: string;
  outputWidth: number;
  outputHeight: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const GRID_PRESETS: { label: string; rows: number; cols: number }[] = [
  { label: '2×2', rows: 2, cols: 2 },
  { label: '2×3', rows: 2, cols: 3 },
  { label: '2×4', rows: 2, cols: 4 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '3×4', rows: 3, cols: 4 },
  { label: '4×3', rows: 4, cols: 3 },
  { label: '4×4', rows: 4, cols: 4 },
  { label: '3×6', rows: 3, cols: 6 },
  { label: '4×6', rows: 4, cols: 6 },
];

const IMAGE_MODELS = [
  { value: 'gpt-image-2-i2i', label: 'GPT Image 2 (recommended)' },
  { value: 'grok-imagine-i2i', label: 'Grok Imagine (image-to-image)' },
  { value: 'flux2-pro-i2i', label: 'Flux2 Pro (image-to-image)' },
  { value: 'flux2-flex-i2i', label: 'Flux2 Flex (image-to-image)' },
];

const REGION_OVERLAY_PREF_KEY = 'topic_card_grid_region_overlay';
const IMAGE_MODEL_PREF_KEY = 'topic_card_grid_default_image_model';

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  // Inputs from parent
  title: string;
  niche: string;
  script: string;
  description: string;
  modelId: string;
  referenceImageUrl: string;
  // Notifies parent when a generation completes (so parent can save to
  // history and patch the schedule-link saver).
  onResultChange: (result: FormatGenerationResult | null) => void;
  /** Hydrate State B from a history-restored result. When this prop changes
   *  to a new non-null value, the panel hydrates its internal grid + cards
   *  state and displays the restored image. Lets the parent re-open a past
   *  Topic Card Grid generation. */
  restoredResult?: FormatGenerationResult | null;
}

export function TopicCardGridPanel({
  title,
  niche,
  script,
  description,
  modelId,
  referenceImageUrl,
  onResultChange,
  restoredResult,
}: Props) {
  // Grid configuration
  const [gridMode, setGridMode] = useState<'preset' | 'custom'>('preset');
  // 3×3 default — its index shifts when GRID_PRESETS changes, so look it up
  // by value rather than hard-coding an index that's easy to break.
  const [presetIdx, setPresetIdx] = useState(
    () => GRID_PRESETS.findIndex((p) => p.rows === 3 && p.cols === 3),
  );
  const [customRows, setCustomRows] = useState(3);
  const [customCols, setCustomCols] = useState(3);

  const gridRows = gridMode === 'preset' ? GRID_PRESETS[presetIdx].rows : customRows;
  const gridCols = gridMode === 'preset' ? GRID_PRESETS[presetIdx].cols : customCols;
  const totalCards = gridRows * gridCols;

  // Format mode
  const [formatMode, setFormatMode] = useState<'review' | 'pre-fill' | 'one-shot'>('review');
  const [prefilledLabels, setPrefilledLabels] = useState('');

  // Image model — defaults to the recommended gpt-image-2-i2i, but
  // auto-remembers the user's last choice in localStorage so whatever they
  // picked last time becomes their personal default on the next page load.
  const [imageModelId, setImageModelId] = useState<string>(() => {
    if (typeof window === 'undefined') return 'gpt-image-2-i2i';
    try {
      const stored = localStorage.getItem(IMAGE_MODEL_PREF_KEY);
      if (stored && IMAGE_MODELS.some((m) => m.value === stored)) return stored;
    } catch {
      /* fall through to default */
    }
    return 'gpt-image-2-i2i';
  });
  useEffect(() => {
    try { localStorage.setItem(IMAGE_MODEL_PREF_KEY, imageModelId); } catch { /* ignore */ }
  }, [imageModelId]);

  // Flow state
  const [busyStep, setBusyStep] = useState<'idle' | 'cards' | 'image'>('idle');
  const [cards, setCards] = useState<FormatCard[] | null>(null);
  const [palette, setPalette] = useState<FormatPalette | null>(null);
  const [notesForImageModel, setNotesForImageModel] = useState<string | undefined>();
  const [result, setResult] = useState<FormatGenerationResult | null>(null);

  // Hydrate from a history-restored result. Runs when `restoredResult`
  // changes to a new non-null value — typically the parent setting it on
  // history click. We sync grid mode, dimensions, image model, mode, cards,
  // palette, and the result itself so State B paints immediately.
  useEffect(() => {
    if (!restoredResult) return;
    setGridMode(restoredResult.gridMode);
    if (restoredResult.gridMode === 'preset') {
      const idx = GRID_PRESETS.findIndex(
        (p) => p.rows === restoredResult.gridRows && p.cols === restoredResult.gridCols,
      );
      if (idx >= 0) setPresetIdx(idx);
    } else {
      setCustomRows(restoredResult.gridRows);
      setCustomCols(restoredResult.gridCols);
    }
    setFormatMode(restoredResult.mode);
    setImageModelId(restoredResult.formatImageModel);
    setCards(restoredResult.cards);
    setPalette(restoredResult.palette);
    setResult(restoredResult);
  }, [restoredResult]);

  // Region overlay preference — persists across sessions per the plan.
  const [regionOverlayOn, setRegionOverlayOn] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(REGION_OVERLAY_PREF_KEY);
      if (stored === 'off') setRegionOverlayOn(false);
    } catch {
      /* default ON */
    }
  }, []);
  function toggleRegionOverlay() {
    const next = !regionOverlayOn;
    setRegionOverlayOn(next);
    try {
      localStorage.setItem(REGION_OVERLAY_PREF_KEY, next ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }

  // Validation
  const prefilledLabelsList = useMemo(
    () =>
      prefilledLabels
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [prefilledLabels],
  );

  // Reference image is optional — the server falls back to the bundled
  // curated default (public/thumbnail-formats/topic-card-grid-default.png)
  // when no upload is provided. If neither is available the server returns
  // a clear error; we don't pre-block the click for that case so the user
  // sees the actionable server message.
  const canGenerateCards =
    !!title.trim() &&
    !!niche.trim() &&
    gridRows >= 1 &&
    gridCols >= 1 &&
    (formatMode !== 'pre-fill' || prefilledLabelsList.length === totalCards);

  const cardListMismatch = cards && cards.length !== totalCards;
  const canRenderImage = !!cards && !cardListMismatch && cards.every((c) => c.label.trim() && c.icon_concept.trim());

  // ─── Actions ──────────────────────────────────────────────────────────────

  async function runStep1() {
    if (!canGenerateCards) {
      if (formatMode === 'pre-fill' && prefilledLabelsList.length !== totalCards) {
        toast.error(`Pre-fill mode needs exactly ${totalCards} labels (one per line). You have ${prefilledLabelsList.length}.`);
      } else {
        toast.error('Title and niche are required.');
      }
      return;
    }
    console.info('[thumbnails format-grid cards] requesting', { gridRows, gridCols, modelId, mode: formatMode });
    setBusyStep('cards');
    try {
      const res = await fetch('/api/thumbnails/format/topic-card-grid/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          title: title.trim(),
          niche,
          script: script.trim() || undefined,
          description: description.trim() || undefined,
          gridRows,
          gridCols,
          mode: formatMode,
          prefilledLabels: formatMode === 'pre-fill' ? prefilledLabelsList : undefined,
          referenceImageUrl: referenceImageUrl.trim(),
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Card list generation failed (${res.status})`);
      }
      const data: { result: { cards: FormatCard[]; global_palette: FormatPalette; notes_for_image_model?: string } } = await res.json();
      console.info('[thumbnails format-grid cards] received', { cardsCount: data.result.cards.length });
      setCards(data.result.cards);
      setPalette(data.result.global_palette);
      setNotesForImageModel(data.result.notes_for_image_model);
      // One-shot mode: don't stop here, chain into Step 2.
      if (formatMode === 'one-shot') {
        await runStep2(data.result.cards, data.result.global_palette, data.result.notes_for_image_model);
        return;
      }
      toast.success(`Generated ${data.result.cards.length} card${data.result.cards.length === 1 ? '' : 's'} — review and edit before rendering.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Card list generation failed.');
    } finally {
      setBusyStep('idle');
    }
  }

  async function runStep2(
    cardsToUse: FormatCard[] | null = cards,
    paletteToUse: FormatPalette | null = palette,
    notesToUse: string | undefined = notesForImageModel,
  ) {
    if (!cardsToUse || !paletteToUse) {
      toast.error('Generate the card list first.');
      return;
    }
    if (cardsToUse.length !== totalCards) {
      toast.error(`Card count (${cardsToUse.length}) does not match the grid (${totalCards}). Add or remove cards before rendering.`);
      return;
    }
    console.info('[thumbnails format-grid image] requesting', {
      cardsCount: cardsToUse.length,
      imageModelId,
      editsApplied: 0,
    });
    setBusyStep('image');
    try {
      const res = await fetch('/api/thumbnails/format/topic-card-grid/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageModelId,
          cards: cardsToUse,
          globalPalette: paletteToUse,
          notesForImageModel: notesToUse,
          gridRows,
          gridCols,
          referenceImageUrl: referenceImageUrl.trim(),
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Image generation failed (${res.status})`);
      }
      const data: {
        imageUrl: string;
        regions: ThumbnailRegion[];
        layout: { width: number; height: number };
      } = await res.json();
      console.info('[thumbnails format-grid image] received', {
        imageUrl: data.imageUrl,
        regionsCount: data.regions.length,
      });
      const generation: FormatGenerationResult = {
        imageUrl: data.imageUrl,
        regions: data.regions,
        cards: cardsToUse,
        palette: paletteToUse,
        gridRows,
        gridCols,
        gridMode,
        mode: formatMode,
        formatImageModel: imageModelId,
        referenceImageUrl: referenceImageUrl.trim() || undefined,
        outputWidth: data.layout.width,
        outputHeight: data.layout.height,
      };
      setResult(generation);
      onResultChange(generation);
      toast.success('Thumbnail generated!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Image generation failed.');
    } finally {
      setBusyStep('idle');
    }
  }

  function updateCard(idx: number, patch: Partial<FormatCard>) {
    setCards((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function deleteCard(idx: number) {
    if (gridMode !== 'custom') {
      toast.error('Cards can only be deleted in Custom grid mode. Switch to Custom to add or remove cards.');
      return;
    }
    setCards((prev) => prev?.filter((_, i) => i !== idx).map((c, i) => ({ ...c, index: i + 1 })) ?? null);
    // Shrink the grid by 1 column or row to match. Simplest: drop one cell off
    // the last row by decreasing cols if possible.
    setCustomCols((c) => Math.max(1, c - 1));
  }

  function addCard() {
    if (gridMode !== 'custom') {
      toast.error('Cards can only be added in Custom grid mode.');
      return;
    }
    setCards((prev) => {
      if (!prev) return prev;
      const next = [...prev, { index: prev.length + 1, label: 'New card', icon_concept: 'a single bold central icon on dark background' }];
      return next;
    });
    setCustomCols((c) => c + 1);
  }

  function moveCard(idx: number, dir: -1 | 1) {
    setCards((prev) => {
      if (!prev) return prev;
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next.map((c, i) => ({ ...c, index: i + 1 }));
    });
  }

  function clearCards() {
    if (cards && !confirm('Discard the current card list and regenerate?')) return;
    setCards(null);
    setPalette(null);
    setNotesForImageModel(undefined);
    setResult(null);
    onResultChange(null);
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-6" style={{ alignItems: 'flex-start' }}>
      {/* LEFT PANEL — format controls */}
      <div className="shrink-0" style={{ width: 380 }}>
        <div className="glass p-5 space-y-4" style={{ borderColor: 'rgba(236,72,153,0.15)' }}>
          {/* Grid size */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Grid size
            </label>
            <div className="flex flex-wrap gap-1.5">
              {GRID_PRESETS.map((p, i) => {
                const active = gridMode === 'preset' && presetIdx === i;
                return (
                  <button
                    key={p.label}
                    onClick={() => { setGridMode('preset'); setPresetIdx(i); }}
                    className="text-[11px] px-2.5 py-1 rounded transition-all"
                    style={{
                      background: active ? 'rgba(236,72,153,0.2)' : 'var(--bg-card)',
                      border: `1px solid ${active ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
                      color: active ? 'var(--accent-pink)' : 'var(--text-muted)',
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button
                onClick={() => setGridMode('custom')}
                className="text-[11px] px-2.5 py-1 rounded transition-all"
                style={{
                  background: gridMode === 'custom' ? 'rgba(236,72,153,0.2)' : 'var(--bg-card)',
                  border: `1px solid ${gridMode === 'custom' ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
                  color: gridMode === 'custom' ? 'var(--accent-pink)' : 'var(--text-muted)',
                }}
              >
                Custom…
              </button>
            </div>
            {gridMode === 'custom' && (
              <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <label className="flex items-center gap-1">
                  Rows
                  <input
                    type="number"
                    min={1}
                    value={customRows}
                    onChange={(e) => setCustomRows(Math.max(1, Number(e.target.value) || 1))}
                    className="input-field w-16 text-xs"
                  />
                </label>
                <label className="flex items-center gap-1">
                  Cols
                  <input
                    type="number"
                    min={1}
                    value={customCols}
                    onChange={(e) => setCustomCols(Math.max(1, Number(e.target.value) || 1))}
                    className="input-field w-16 text-xs"
                  />
                </label>
                <span style={{ color: 'var(--text-muted)' }}>= {totalCards} cards</span>
              </div>
            )}
            {totalCards > 64 && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--accent-yellow)' }}>
                Grids above 8×8 may render inconsistently — the model has more cards to keep aligned.
              </p>
            )}
          </div>

          {/* Image model */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Image Model
            </label>
            <select
              className="input-field w-full text-sm"
              value={imageModelId}
              onChange={(e) => setImageModelId(e.target.value)}
            >
              {IMAGE_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {imageModelId !== 'gpt-image-2-i2i' && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--accent-yellow)' }}>
                This format is calibrated for GPT Image 2. Other models will produce a different style and likely mangle the per-card typography.
              </p>
            )}
          </div>

          {/* Mode chips */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Flow
            </label>
            <div className="flex gap-1.5">
              {(['review', 'pre-fill', 'one-shot'] as const).map((m) => {
                const active = formatMode === m;
                const labelText = m === 'review' ? 'Review cards' : m === 'pre-fill' ? 'Pre-fill cards' : 'One-shot';
                return (
                  <button
                    key={m}
                    onClick={() => setFormatMode(m)}
                    className="text-[11px] px-2.5 py-1 rounded transition-all"
                    style={{
                      background: active ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                      border: `1px solid ${active ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`,
                      color: active ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                    }}
                  >
                    {labelText}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {formatMode === 'review' && 'Generate card list → review and edit → render image. Default.'}
              {formatMode === 'pre-fill' && 'You type the labels below; the LLM only fills in icon concepts.'}
              {formatMode === 'one-shot' && 'Generate card list and image back-to-back without a review step.'}
            </p>
            {formatMode === 'review' && script.trim() && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Tip: if the LLM picks titles that paraphrase your script, switch to <strong>Pre-fill cards</strong> and type the exact labels — the model will only fill in icon concepts and leave your wording intact.
              </p>
            )}
          </div>

          {formatMode === 'pre-fill' && (
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Card labels — one per line, exactly {totalCards}
              </label>
              <textarea
                className="input-field w-full text-xs"
                rows={Math.min(10, Math.max(4, totalCards))}
                value={prefilledLabels}
                onChange={(e) => setPrefilledLabels(e.target.value)}
                placeholder={'Morris Worm\nILOVEYOU\nStuxnet\n…'}
              />
              <p className="text-[10px] mt-0.5" style={{ color: prefilledLabelsList.length === totalCards ? 'var(--text-muted)' : 'var(--accent-yellow)' }}>
                {prefilledLabelsList.length} / {totalCards} labels
              </p>
            </div>
          )}

          {/* Reference image notice — optional, server falls back to a
              curated default when nothing is uploaded. */}
          {!referenceImageUrl.trim() && (
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              No reference uploaded — we&apos;ll use a bundled curated default. Upload one above (Image Generation section) to lock the typography to your own font.
            </p>
          )}
          {referenceImageUrl.trim() && (
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Reference image will guide the layout, typography, and overall style of the rendered thumbnail.
            </p>
          )}

          {/* Primary CTA */}
          <button
            className="btn-primary w-full flex items-center justify-center gap-2"
            onClick={runStep1}
            disabled={!canGenerateCards || busyStep !== 'idle'}
          >
            {busyStep === 'cards' && (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Generating card list…
              </>
            )}
            {busyStep === 'image' && (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Rendering image…
              </>
            )}
            {busyStep === 'idle' && 'Generate thumbnail'}
          </button>
          {cards && (
            <button
              onClick={clearCards}
              className="text-[11px] underline w-full text-center"
              style={{ color: 'var(--text-muted)' }}
            >
              Discard current card list
            </button>
          )}
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            ≈ $0.05–$0.11 per generation. Step 1 (card list) is &lt; $0.01; Step 2 (image) is the bulk.
          </p>
        </div>
      </div>

      {/* RIGHT PANEL — State A (editable cards) OR State B (result) */}
      <div className="flex-1 min-w-0">
        {!cards && !result && (
          <div className="glass p-12 text-center">
            <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              Topic Card Grid
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Upload a reference image, set the grid size, and click <strong>Generate thumbnail</strong>.
            </p>
          </div>
        )}

        {cards && !result && (
          <CardTableState
            cards={cards}
            totalCards={totalCards}
            gridMismatch={cardListMismatch ?? false}
            canRender={canRenderImage}
            busy={busyStep === 'image'}
            allowDelete={gridMode === 'custom'}
            allowAdd={gridMode === 'custom'}
            onUpdate={updateCard}
            onMove={moveCard}
            onDelete={deleteCard}
            onAdd={addCard}
            onRender={() => runStep2()}
            onRegenerate={() => { setCards(null); runStep1(); }}
          />
        )}

        {result && (
          <ResultState
            result={result}
            regionOverlayOn={regionOverlayOn}
            onToggleOverlay={toggleRegionOverlay}
            onEditCards={() => setResult(null)}
            onRegenerateImage={() => runStep2()}
            busy={busyStep === 'image'}
          />
        )}
      </div>
    </div>
  );
}

// ─── State A subcomponent — editable card table ─────────────────────────────

interface CardTableProps {
  cards: FormatCard[];
  totalCards: number;
  gridMismatch: boolean;
  canRender: boolean;
  busy: boolean;
  allowDelete: boolean;
  allowAdd: boolean;
  onUpdate: (idx: number, patch: Partial<FormatCard>) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onDelete: (idx: number) => void;
  onAdd: () => void;
  onRender: () => void;
  onRegenerate: () => void;
}

function CardTableState(props: CardTableProps) {
  const { cards, totalCards, gridMismatch, canRender, busy, allowDelete, allowAdd } = props;
  return (
    <div className="glass p-5 space-y-3" style={{ borderColor: 'rgba(124,58,237,0.2)' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
          Review cards
        </h3>
        <span
          className="text-xs px-2 py-0.5 rounded"
          style={{
            background: gridMismatch ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
            color: gridMismatch ? '#ef4444' : '#22c55e',
          }}
        >
          {cards.length} / {totalCards} cards
        </span>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Edit any label or icon concept. Reorder with the arrows. {allowDelete ? 'Add or remove cards using the buttons below (Custom grid mode).' : 'Switch to Custom grid mode to add or remove cards.'}
      </p>

      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {cards.map((card, i) => (
          <div
            key={i}
            className="p-2 rounded-lg space-y-1.5"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono w-6 text-right" style={{ color: 'var(--text-muted)' }}>
                {card.index}
              </span>
              <input
                className="input-field flex-1 text-xs font-medium"
                placeholder="Card label"
                value={card.label}
                onChange={(e) => props.onUpdate(i, { label: e.target.value })}
                maxLength={60}
              />
              {card.accent_color ? (
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={card.accent_color}
                    onChange={(e) => props.onUpdate(i, { accent_color: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer"
                    style={{ border: '1px solid var(--border)', background: 'none' }}
                    title="Accent color"
                  />
                  <button
                    onClick={() => props.onUpdate(i, { accent_color: undefined })}
                    className="text-[9px] px-1 rounded"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                    title="Clear accent — let the model pick natural colors"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => props.onUpdate(i, { accent_color: '#ff3b3b' })}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px dashed var(--border)' }}
                  title="Add an accent color hint for this card (optional)"
                >
                  + color
                </button>
              )}
              <button
                onClick={() => props.onMove(i, -1)}
                disabled={i === 0}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: i === 0 ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid var(--border)', opacity: i === 0 ? 0.4 : 1 }}
                title="Move up"
              >
                ↑
              </button>
              <button
                onClick={() => props.onMove(i, 1)}
                disabled={i === cards.length - 1}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: i === cards.length - 1 ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid var(--border)', opacity: i === cards.length - 1 ? 0.4 : 1 }}
                title="Move down"
              >
                ↓
              </button>
              {allowDelete && (
                <button
                  onClick={() => props.onDelete(i)}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-card)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
                  title="Delete card"
                >
                  ✕
                </button>
              )}
            </div>
            <input
              className="input-field w-full text-xs"
              placeholder="Icon concept — one bold central symbol, no text, no scene"
              value={card.icon_concept}
              onChange={(e) => props.onUpdate(i, { icon_concept: e.target.value })}
              maxLength={200}
            />
          </div>
        ))}
        {allowAdd && (
          <button
            onClick={props.onAdd}
            className="w-full text-xs py-1.5 rounded"
            style={{ background: 'var(--bg-card)', border: '1px dashed var(--border)', color: 'var(--text-muted)' }}
          >
            + Add card
          </button>
        )}
      </div>

      {gridMismatch && (
        <div
          className="text-xs px-3 py-2 rounded-lg"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}
        >
          Card count ({cards.length}) does not match the grid ({totalCards}). Adjust the grid size or add/remove cards before rendering.
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={props.onRender}
          disabled={!canRender || busy}
          className="btn-primary text-xs flex-1 flex items-center justify-center gap-1.5"
        >
          {busy ? (
            <>
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
              Rendering…
            </>
          ) : (
            'Render image'
          )}
        </button>
        <button
          onClick={props.onRegenerate}
          className="btn-secondary text-xs"
        >
          Regenerate card list
        </button>
      </div>
    </div>
  );
}

// ─── State B subcomponent — result with region overlay ──────────────────────

interface ResultProps {
  result: FormatGenerationResult;
  regionOverlayOn: boolean;
  onToggleOverlay: () => void;
  onEditCards: () => void;
  onRegenerateImage: () => void;
  busy: boolean;
}

function ResultState({ result, regionOverlayOn, onToggleOverlay, onEditCards, onRegenerateImage, busy }: ResultProps) {
  const aspect = result.outputHeight / result.outputWidth;
  return (
    <div className="glass p-5 space-y-3" style={{ borderColor: 'rgba(34,197,94,0.2)' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
          Generated thumbnail
        </h3>
        <label className="flex items-center gap-2 cursor-pointer text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={regionOverlayOn}
            onChange={onToggleOverlay}
            style={{ accentColor: 'var(--accent-pink)' }}
          />
          Region overlay
        </label>
      </div>

      <div
        className="relative w-full rounded-lg overflow-hidden"
        style={{ border: '1px solid var(--border)', aspectRatio: `${result.outputWidth} / ${result.outputHeight}` }}
      >
        <img
          src={result.imageUrl}
          alt="Generated thumbnail"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        {regionOverlayOn && (
          <svg
            viewBox={`0 0 ${result.outputWidth} ${result.outputHeight}`}
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            {result.regions.map((r, i) => (
              <g key={r.id}>
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill="none"
                  stroke="rgba(236,72,153,0.85)"
                  strokeWidth={Math.max(2, result.outputWidth * 0.003)}
                  strokeDasharray={`${Math.max(6, result.outputWidth * 0.01)} ${Math.max(4, result.outputWidth * 0.006)}`}
                />
                <text
                  x={r.x + 8}
                  y={r.y + Math.max(20, result.outputWidth * 0.025)}
                  fill="rgba(236,72,153,1)"
                  fontSize={Math.max(14, result.outputWidth * 0.018)}
                  fontFamily="ui-monospace, monospace"
                >
                  {i + 1}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Aspect {Math.round(1 / aspect * 10) / 10}:1 · {result.outputWidth}×{result.outputHeight} · {result.regions.length} region{result.regions.length === 1 ? '' : 's'} ready for production-doc.
      </p>

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { navigator.clipboard.writeText(result.imageUrl); toast.success('Image URL copied'); }}
          className="btn-secondary text-xs px-2 py-1"
        >
          Copy URL
        </button>
        <a
          href={downloadHref(result.imageUrl, `thumbnail-grid.png`)}
          download="thumbnail-grid.png"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary text-xs px-2 py-1 inline-flex items-center gap-1"
        >
          Download
        </a>
        <button
          onClick={() => {
            navigator.clipboard.writeText(JSON.stringify(result.regions, null, 2));
            toast.success('Regions JSON copied');
          }}
          className="btn-secondary text-xs px-2 py-1"
        >
          Copy regions JSON
        </button>
        <button
          onClick={onEditCards}
          className="btn-secondary text-xs px-2 py-1"
        >
          Edit cards
        </button>
        <button
          onClick={onRegenerateImage}
          disabled={busy}
          className="btn-secondary text-xs px-2 py-1"
        >
          Regenerate image
        </button>
      </div>

      {/* Read-only card list reference */}
      <details className="text-xs">
        <summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>
          Cards rendered ({result.cards.length})
        </summary>
        <div className="mt-2 space-y-1">
          {result.cards.map((c) => (
            <div key={c.index} className="flex gap-2" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-mono w-6 text-right" style={{ color: 'var(--text-muted)' }}>{c.index}</span>
              <span className="font-medium">{c.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>— {c.icon_concept}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
