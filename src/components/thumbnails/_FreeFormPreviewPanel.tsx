'use client';

/**
 * Shared free-form preview + per-cell picker (Phase B4 + B5).
 *
 * Used by both `TopicCardGridPanel` and `NLevelsPanel`. Each panel
 * computes its own cell bounds (grid math differs between the two
 * formats), then hands the bounds + per-cell content (`emoji`,
 * `bgColor`, transform overrides) here. This component:
 *   - Renders the live preview via `<ThumbnailRenderer cells={…}>`.
 *   - Surfaces the per-cell content picker (emoji + colour + optional
 *     transform: rotation / offset / flip).
 *   - Offers a quick-pick 16-emoji palette.
 *   - Saves the preview as PNG via browser canvas rasterisation.
 *
 * The component doesn't know about the panel's broader state — it's
 * a pure UI primitive driven entirely by props.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import {
  ThumbnailRenderer,
  type FreeFormCell,
  type TitleBarRendererInput,
} from '@/components/thumbnails/ThumbnailRenderer';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  ICON_REGISTRY,
  getIconEntry,
  type IconCategory,
} from '@/lib/thumbnail-formats/flex-icon-grid-icons';
import type { PostProcessConfig } from '@/lib/thumbnail-formats/shared-overlay-pipeline';

export type CellShape = 'square' | 'rounded' | 'circle';

export interface FreeFormCellState {
  emoji: string;
  bgColor: string;
  emojiRotation: number;
  emojiFlipX: boolean;
  emojiFlipY: boolean;
  emojiOffsetX: number;
  emojiOffsetY: number;
  /** Lucide icon slug (final session). When set, takes precedence over
   *  `emoji` — the renderer paints the Lucide icon instead. */
  iconSlug?: string;
  /** Icon stroke / fill colour. Defaults to '#000000' downstream. */
  iconColor?: string;
  /** Cell shape variant. Defaults to 'square'. */
  shape?: CellShape;
  /** Per-cell label colour override. Defaults to '#000000' downstream. */
  labelColor?: string;
  /** Per-cell label font-size multiplier. 1.0 = default. */
  labelSizeMultiplier?: number;
  /** Per-cell custom image URL. Takes precedence over icon/emoji. */
  imageUrl?: string;
  /** Image fit strategy. Defaults to 'cover'. */
  imageFit?: 'cover' | 'contain' | 'fill';
}

export const DEFAULT_FREE_FORM_CELL_STATE: FreeFormCellState = {
  emoji: '',
  bgColor: '#ffffff',
  emojiRotation: 0,
  emojiFlipX: false,
  emojiFlipY: false,
  emojiOffsetX: 0,
  emojiOffsetY: 0,
};

/** Canvas-level options that live above any single cell — currently
 *  the optional gradient background. Kept separate from `FreeFormCellState`
 *  because it's a single shared value, not per-cell. */
export type CanvasPatternKind = 'stripes' | 'dots' | 'checker' | 'grid';

export interface FreeFormCanvasOptions {
  /** Optional background colour override. Defaults to white. */
  background?: string;
  /** Optional gradient — overrides `background` when set. */
  gradient?: {
    from: string;
    to: string;
    /** 0..360, where 0 is top→bottom and 90 is left→right. */
    angle: number;
  };
  /** Optional pattern overlay drawn BETWEEN the background and the
   *  cells. Adds texture (newsprint dots, paper grid, etc.) without
   *  needing the post-process halftone pipeline. */
  pattern?: {
    kind: CanvasPatternKind;
    color: string;
    opacity: number;
    size: number;
  };
  /** Default cell shape used when a fresh cell is created. */
  defaultShape?: CellShape;
}

/** Single source-of-truth for a row in the picker. Caller provides:
 *  - `index`: 1-based id used to key the per-cell state map.
 *  - `label`: human-readable label shown in the picker row.
 *  - `bounds`: canvas-space rectangle for the renderer. */
export interface FreeFormCellInput {
  index: number;
  label: string;
  bounds: { x: number; y: number; w: number; h: number };
}

const FREE_FORM_EMOJI_PRESETS = [
  '⭐', '🔥', '⚡', '💡', '🚀', '🎯', '✅', '❌',
  '⚠️', '🛡️', '🎨', '📊', '💰', '🔒', '🧠', '👀',
];

export function FreeFormPreviewPanel({
  inputs,
  canvasWidth,
  canvasHeight,
  freeFormCells,
  onUpdateCell,
  canvasOptions,
  onUpdateCanvasOptions,
  postProcessPayload,
  titleBarRendererInput,
  labelFontFamily,
  title = 'Free-form preview',
  downloadFilename = 'thumbnail-free-form.png',
  cellNoun = 'card',
}: {
  inputs: FreeFormCellInput[];
  canvasWidth: number;
  canvasHeight: number;
  freeFormCells: Record<number, FreeFormCellState>;
  onUpdateCell: (cellIndex: number, patch: Partial<FreeFormCellState>) => void;
  /** Canvas-level options (background / gradient). Optional — when
   *  omitted the renderer uses a white background. */
  canvasOptions?: FreeFormCanvasOptions;
  /** Patch the canvas options. Called for every nudge of the bg colour /
   *  gradient sliders. */
  onUpdateCanvasOptions?: (patch: Partial<FreeFormCanvasOptions>) => void;
  postProcessPayload?: PostProcessConfig;
  titleBarRendererInput?: TitleBarRendererInput;
  labelFontFamily: string;
  /** Heading shown above the preview. */
  title?: string;
  /** Filename used by the Save PNG button. */
  downloadFilename?: string;
  /** Singular noun for the per-cell rows ("card" / "level"). */
  cellNoun?: string;
}): ReactElement {
  const rendererCells: FreeFormCell[] = inputs.map((input) => {
    const content = freeFormCells[input.index] ?? DEFAULT_FREE_FORM_CELL_STATE;
    return {
      bounds: input.bounds,
      bgColor: content.bgColor,
      emoji: content.emoji,
      label: input.label,
      labelFontFamily,
      emojiRotation: content.emojiRotation,
      emojiFlipX: content.emojiFlipX,
      emojiFlipY: content.emojiFlipY,
      emojiOffsetX: content.emojiOffsetX,
      emojiOffsetY: content.emojiOffsetY,
      iconSlug: content.iconSlug,
      iconColor: content.iconColor ?? '#000000',
      shape: content.shape ?? canvasOptions?.defaultShape ?? 'square',
      labelColor: content.labelColor,
      labelSizeMultiplier: content.labelSizeMultiplier,
      imageUrl: content.imageUrl,
      imageFit: content.imageFit,
    };
  });
  // Icon picker UI state — search query + per-cell open dropdown id +
  // active category tab. The tab filter is bypassed when a search is
  // active (so "shield" shows results regardless of which tab is
  // selected). When the search is empty, the tab dictates which
  // category to show; `null` = "All" tab (all icons, flat list).
  const [iconQuery, setIconQuery] = useState('');
  const [iconPickerForIndex, setIconPickerForIndex] = useState<number | null>(null);
  const [iconCategoryTab, setIconCategoryTab] = useState<IconCategory | null>(null);
  const filteredIcons = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    if (q) {
      return ICON_REGISTRY.filter(
        (entry) => entry.slug.includes(q) || entry.label.toLowerCase().includes(q),
      );
    }
    if (iconCategoryTab === null) return ICON_REGISTRY;
    return ICON_REGISTRY.filter((entry) => entry.category === iconCategoryTab);
  }, [iconQuery, iconCategoryTab]);
  // Quick-pick popular icons rendered as a small palette row above the
  // per-cell picker — matches the 16-emoji palette pattern.
  const POPULAR_ICON_SLUGS = [
    'star',
    'shield',
    'lock',
    'zap',
    'flame',
    'rocket',
    'target',
    'sparkles',
    'check',
    'x',
    'alert-triangle',
    'heart',
  ];
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pickerRowsRef = useRef<Record<number, HTMLDivElement | null>>({});
  const [saving, setSaving] = useState(false);
  /** Index of the currently-selected cell. Clicking a cell on the
   *  preview sets this; the matching picker row gains a highlight
   *  border + auto-scrolls into view. `null` = nothing selected. */
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  function selectCell(index: number): void {
    setSelectedIndex(index);
    const row = pickerRowsRef.current[index];
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  // Escape key clears the selection. Mounts ONLY when something is
  // selected so we're not adding a listener for the common no-op
  // path.
  useEffect(() => {
    if (selectedIndex === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelectedIndex(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIndex]);

  async function downloadAsPng(): Promise<void> {
    const container = containerRef.current;
    if (!container) return;
    setSaving(true);
    try {
      const svg = container.querySelector('svg');
      if (!svg) {
        toast.error('Preview not ready');
        return;
      }
      const cloned = svg.cloneNode(true) as SVGSVGElement;
      cloned.setAttribute('width', String(canvasWidth));
      cloned.setAttribute('height', String(canvasHeight));
      const xml = new XMLSerializer().serializeToString(cloned);
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('SVG load failed'));
        img.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        toast.error('Canvas unavailable');
        return;
      }
      ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
      canvas.toBlob((blob) => {
        if (!blob) {
          toast.error('PNG encode failed');
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success('Downloaded');
      }, 'image/png');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="glass p-5 space-y-3"
      style={{ borderColor: 'rgba(236,72,153,0.2)' }}
      onClick={(e) => {
        // Click-anywhere-to-deselect: clear the selected cell when the
        // user clicks the panel background (NOT a control inside it).
        // The `e.target === e.currentTarget` check ensures we only
        // catch background clicks; bubble-up clicks from buttons /
        // inputs / picker rows don't deselect (those have their own
        // handlers that set the selection).
        if (e.target === e.currentTarget && selectedIndex !== null) {
          setSelectedIndex(null);
        }
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        <button
          type="button"
          onClick={() => void downloadAsPng()}
          disabled={saving}
          className="btn-secondary text-xs px-3 py-1"
        >
          {saving ? 'Saving…' : 'Save PNG'}
        </button>
      </div>
      <div
        ref={containerRef}
        className="rounded-lg overflow-hidden relative"
        style={{ border: '1px solid var(--border)' }}
      >
        <ThumbnailRenderer
          cells={rendererCells}
          canvasBackground={canvasOptions?.background ?? '#ffffff'}
          canvasBackgroundGradient={canvasOptions?.gradient}
          canvasBackgroundPattern={canvasOptions?.pattern}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          postProcess={postProcessPayload}
          titleBar={titleBarRendererInput}
          alt="Free-form thumbnail preview"
        >
          {/* Click overlay — transparent rects per cell that focus
              the matching picker row when clicked. The selected cell
              also gets a magenta outline so the user can see WHICH
              cell their picker edits are about to affect. */}
          <svg
            viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
            preserveAspectRatio="none"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              cursor: 'pointer',
            }}
          >
            {inputs.map((input) => {
              const active = selectedIndex === input.index;
              return (
                <rect
                  key={input.index}
                  x={input.bounds.x}
                  y={input.bounds.y}
                  width={input.bounds.w}
                  height={input.bounds.h}
                  fill="transparent"
                  stroke={active ? 'rgba(236,72,153,0.85)' : 'transparent'}
                  strokeWidth={Math.max(4, canvasWidth * 0.006)}
                  strokeDasharray={`${Math.max(8, canvasWidth * 0.012)} ${Math.max(6, canvasWidth * 0.008)}`}
                  onClick={() => selectCell(input.index)}
                  style={{ pointerEvents: 'auto' }}
                >
                  <title>{input.label || `${cellNoun} ${input.index}`}</title>
                </rect>
              );
            })}
          </svg>
        </ThumbnailRenderer>
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Pick an emoji + colour for each {cellNoun}. Live preview — no AI calls, no server roundtrip.
      </p>
      {/* Canvas-level options: cell shape default, background colour /
          gradient. Only shown when the host panel supplies the update
          callback (so the older N Levels / TCG entrypoints stay
          unchanged until they opt in). */}
      {onUpdateCanvasOptions && (
        <div
          className="rounded p-2 space-y-2"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Default cell shape
            </span>
            <div className="flex gap-1">
              {(['square', 'rounded', 'circle'] as CellShape[]).map((shape) => {
                const active = (canvasOptions?.defaultShape ?? 'square') === shape;
                return (
                  <button
                    key={shape}
                    type="button"
                    onClick={() => onUpdateCanvasOptions({ defaultShape: shape })}
                    className="px-2 py-0.5 rounded text-[10px]"
                    style={{
                      background: active ? 'var(--accent-pink)' : 'var(--bg-card)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                    aria-pressed={active}
                  >
                    {shape === 'square' ? '▢' : shape === 'rounded' ? '▣' : '◯'} {shape}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Canvas bg
            </span>
            <input
              type="color"
              value={canvasOptions?.background ?? '#ffffff'}
              onChange={(e) =>
                onUpdateCanvasOptions({ background: e.target.value })
              }
              className="w-7 h-5 rounded border-0 p-0 cursor-pointer"
              aria-label="Canvas background colour"
            />
            <button
              type="button"
              onClick={() => {
                if (canvasOptions?.gradient) {
                  // Toggle gradient OFF — drop the field entirely.
                  onUpdateCanvasOptions({ gradient: undefined });
                } else {
                  // Toggle gradient ON with sensible defaults — bg
                  // colour to white, 135° (top-left → bottom-right).
                  onUpdateCanvasOptions({
                    gradient: {
                      from: canvasOptions?.background ?? '#ec4899',
                      to: '#ffffff',
                      angle: 135,
                    },
                  });
                }
              }}
              className="px-2 py-0.5 rounded text-[10px]"
              style={{
                background: canvasOptions?.gradient ? 'var(--accent-pink)' : 'var(--bg-card)',
                color: canvasOptions?.gradient ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
              aria-pressed={!!canvasOptions?.gradient}
            >
              Gradient
            </button>
            {canvasOptions?.gradient && (
              <>
                <input
                  type="color"
                  value={canvasOptions.gradient.from}
                  onChange={(e) =>
                    onUpdateCanvasOptions({
                      gradient: { ...canvasOptions.gradient!, from: e.target.value },
                    })
                  }
                  className="w-7 h-5 rounded border-0 p-0 cursor-pointer"
                  aria-label="Gradient from colour"
                  title="From"
                />
                <input
                  type="color"
                  value={canvasOptions.gradient.to}
                  onChange={(e) =>
                    onUpdateCanvasOptions({
                      gradient: { ...canvasOptions.gradient!, to: e.target.value },
                    })
                  }
                  className="w-7 h-5 rounded border-0 p-0 cursor-pointer"
                  aria-label="Gradient to colour"
                  title="To"
                />
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={canvasOptions.gradient.angle}
                  onChange={(e) => {
                    const angle = Number.parseFloat(e.target.value);
                    if (Number.isFinite(angle)) {
                      onUpdateCanvasOptions({
                        gradient: { ...canvasOptions.gradient!, angle },
                      });
                    }
                  }}
                  className="flex-1"
                  style={{ accentColor: 'var(--accent-pink)' }}
                  title={`${Math.round(canvasOptions.gradient.angle)}°`}
                />
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {Math.round(canvasOptions.gradient.angle)}°
                </span>
              </>
            )}
          </div>
          {/* Pattern overlay row — texture between the bg and the
              cells (without going through the post-process pipeline). */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Pattern
            </span>
            <div className="flex gap-1">
              {(['stripes', 'dots', 'checker', 'grid'] as CanvasPatternKind[]).map((kind) => {
                const active = canvasOptions?.pattern?.kind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => {
                      if (active) {
                        onUpdateCanvasOptions({ pattern: undefined });
                      } else {
                        onUpdateCanvasOptions({
                          pattern: {
                            kind,
                            color: canvasOptions?.pattern?.color ?? '#000000',
                            opacity: canvasOptions?.pattern?.opacity ?? 0.12,
                            size: canvasOptions?.pattern?.size ?? 20,
                          },
                        });
                      }
                    }}
                    className="px-2 py-0.5 rounded text-[10px]"
                    style={{
                      background: active ? 'var(--accent-pink)' : 'var(--bg-card)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                    aria-pressed={active}
                  >
                    {kind}
                  </button>
                );
              })}
            </div>
            {canvasOptions?.pattern && (
              <>
                <input
                  type="color"
                  value={canvasOptions.pattern.color}
                  onChange={(e) =>
                    onUpdateCanvasOptions({
                      pattern: { ...canvasOptions.pattern!, color: e.target.value },
                    })
                  }
                  className="w-7 h-5 rounded border-0 p-0 cursor-pointer"
                  aria-label="Pattern colour"
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={canvasOptions.pattern.opacity}
                  onChange={(e) => {
                    const opacity = Number.parseFloat(e.target.value);
                    if (Number.isFinite(opacity)) {
                      onUpdateCanvasOptions({
                        pattern: { ...canvasOptions.pattern!, opacity },
                      });
                    }
                  }}
                  className="flex-1"
                  style={{ accentColor: 'var(--accent-pink)' }}
                  title={`${Math.round(canvasOptions.pattern.opacity * 100)}%`}
                />
                <input
                  type="range"
                  min={4}
                  max={80}
                  step={2}
                  value={canvasOptions.pattern.size}
                  onChange={(e) => {
                    const size = Number.parseFloat(e.target.value);
                    if (Number.isFinite(size)) {
                      onUpdateCanvasOptions({
                        pattern: { ...canvasOptions.pattern!, size },
                      });
                    }
                  }}
                  className="flex-1"
                  style={{ accentColor: 'var(--accent-pink)' }}
                  title={`${Math.round(canvasOptions.pattern.size)}px tile`}
                />
              </>
            )}
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        {inputs.map((input) => {
          const content = freeFormCells[input.index] ?? DEFAULT_FREE_FORM_CELL_STATE;
          const hasTransform =
            content.emojiRotation !== 0 ||
            content.emojiFlipX ||
            content.emojiFlipY ||
            content.emojiOffsetX !== 0 ||
            content.emojiOffsetY !== 0;
          const isSelected = selectedIndex === input.index;
          return (
            <div
              key={input.index}
              ref={(el) => {
                pickerRowsRef.current[input.index] = el;
              }}
              className="px-2 py-1 rounded space-y-1"
              style={{
                background: 'var(--bg-secondary)',
                border: isSelected
                  ? '1px solid rgba(236,72,153,0.85)'
                  : '1px solid var(--border)',
                outline: isSelected ? '2px solid rgba(236,72,153,0.25)' : undefined,
              }}
              onClick={() => setSelectedIndex(input.index)}
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)', width: 18 }}>
                  {input.index}
                </span>
                <span className="text-[11px] flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                  {input.label || `(${cellNoun} ${input.index})`}
                </span>
                {content.iconSlug ? (
                  // Selected icon indicator with clear button. Replaces
                  // the emoji input when an icon is set (icon wins over
                  // emoji per renderer precedence).
                  <div
                    className="flex items-center gap-1 px-1 py-0.5 rounded text-[10px]"
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <IconPreview slug={content.iconSlug} colour={content.iconColor ?? '#000000'} />
                    <span className="font-mono">{content.iconSlug}</span>
                    <button
                      type="button"
                      onClick={() => onUpdateCell(input.index, { iconSlug: undefined })}
                      className="hover:opacity-60"
                      title="Clear icon"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <input
                    type="text"
                    value={content.emoji}
                    onChange={(e) => onUpdateCell(input.index, { emoji: e.target.value.slice(0, 4) })}
                    placeholder="🎯"
                    className="w-10 px-1 py-0.5 rounded text-center text-sm"
                    style={{
                      background: 'var(--bg-card)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border)',
                    }}
                    aria-label={`Emoji for ${cellNoun} ${input.index}`}
                  />
                )}
                <button
                  type="button"
                  onClick={() =>
                    setIconPickerForIndex(
                      iconPickerForIndex === input.index ? null : input.index,
                    )
                  }
                  className="px-1 py-0.5 rounded text-[10px]"
                  style={{
                    background:
                      iconPickerForIndex === input.index
                        ? 'var(--accent-pink)'
                        : 'var(--bg-card)',
                    color: iconPickerForIndex === input.index ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                  title="Pick Lucide icon"
                  aria-pressed={iconPickerForIndex === input.index}
                >
                  🎨
                </button>
                <input
                  type="color"
                  value={content.iconSlug ? (content.iconColor ?? '#000000') : content.bgColor}
                  onChange={(e) =>
                    onUpdateCell(
                      input.index,
                      content.iconSlug ? { iconColor: e.target.value } : { bgColor: e.target.value },
                    )
                  }
                  className="w-7 h-5 rounded border-0 p-0 cursor-pointer"
                  aria-label={
                    content.iconSlug
                      ? `Icon colour for ${cellNoun} ${input.index}`
                      : `Background colour for ${cellNoun} ${input.index}`
                  }
                />
              </div>
              {iconPickerForIndex === input.index && (
                <div
                  className="rounded mt-1 px-2 py-1 space-y-1"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                >
                  <input
                    type="text"
                    value={iconQuery}
                    onChange={(e) => setIconQuery(e.target.value)}
                    placeholder="Search icons…"
                    className="w-full px-1 py-0.5 rounded text-[11px]"
                    style={{
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border)',
                    }}
                  />
                  {/* Category tabs. Hidden when a search query is
                      active (search wins over category filter). */}
                  {!iconQuery.trim() && (
                    <div className="flex flex-wrap gap-0.5">
                      <button
                        type="button"
                        onClick={() => setIconCategoryTab(null)}
                        className="px-1.5 py-0.5 rounded text-[10px]"
                        style={{
                          background: iconCategoryTab === null ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                          color: iconCategoryTab === null ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid var(--border)',
                        }}
                        aria-pressed={iconCategoryTab === null}
                      >
                        All
                      </button>
                      {CATEGORY_ORDER.map((cat) => {
                        const active = iconCategoryTab === cat;
                        return (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => setIconCategoryTab(cat)}
                            className="px-1.5 py-0.5 rounded text-[10px]"
                            style={{
                              background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                              color: active ? '#fff' : 'var(--text-secondary)',
                              border: '1px solid var(--border)',
                            }}
                            aria-pressed={active}
                          >
                            {CATEGORY_LABELS[cat]}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div
                    className="grid gap-1 overflow-auto"
                    style={{
                      gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
                      maxHeight: 180,
                    }}
                  >
                    {filteredIcons.map((entry) => (
                      <button
                        key={entry.slug}
                        type="button"
                        onClick={() => {
                          onUpdateCell(input.index, {
                            iconSlug: entry.slug,
                            iconColor: content.iconColor ?? '#000000',
                          });
                          setIconPickerForIndex(null);
                        }}
                        className="aspect-square flex items-center justify-center rounded hover:opacity-80"
                        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                        title={`${entry.label} (${entry.slug})`}
                      >
                        <IconPreview slug={entry.slug} colour="#888" />
                      </button>
                    ))}
                    {filteredIcons.length === 0 && (
                      <span
                        className="text-[10px] col-span-8 px-1"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        No icons match &quot;{iconQuery}&quot;
                      </span>
                    )}
                  </div>
                </div>
              )}
              {(content.emoji.trim() !== '' ||
                content.iconSlug ||
                content.labelColor ||
                content.imageUrl ||
                content.labelSizeMultiplier) && (
                <details
                  open={
                    hasTransform ||
                    !!content.labelColor ||
                    !!content.imageUrl ||
                    !!content.labelSizeMultiplier
                  }
                >
                  <summary
                    className="text-[10px] cursor-pointer select-none"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Transform
                    {hasTransform && (
                      <span className="ml-1" style={{ color: 'var(--accent-pink)' }}>
                        ●
                      </span>
                    )}
                  </summary>
                  <div className="mt-1 space-y-1">
                    <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      <span style={{ width: 50 }}>Rotate</span>
                      <input
                        type="range"
                        min={-180}
                        max={180}
                        step={5}
                        value={content.emojiRotation}
                        onChange={(e) =>
                          onUpdateCell(input.index, {
                            emojiRotation: Number.parseFloat(e.target.value) || 0,
                          })
                        }
                        className="flex-1"
                        style={{ accentColor: 'var(--accent-pink)' }}
                      />
                      <span style={{ width: 36, textAlign: 'right' }}>
                        {Math.round(content.emojiRotation)}°
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      <span style={{ width: 50 }}>Offset</span>
                      <input
                        type="range"
                        min={-0.4}
                        max={0.4}
                        step={0.02}
                        value={content.emojiOffsetX}
                        onChange={(e) =>
                          onUpdateCell(input.index, {
                            emojiOffsetX: Number.parseFloat(e.target.value) || 0,
                          })
                        }
                        className="flex-1"
                        style={{ accentColor: 'var(--accent-pink)' }}
                        title="X offset"
                      />
                      <input
                        type="range"
                        min={-0.4}
                        max={0.4}
                        step={0.02}
                        value={content.emojiOffsetY}
                        onChange={(e) =>
                          onUpdateCell(input.index, {
                            emojiOffsetY: Number.parseFloat(e.target.value) || 0,
                          })
                        }
                        className="flex-1"
                        style={{ accentColor: 'var(--accent-pink)' }}
                        title="Y offset"
                      />
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span style={{ color: 'var(--text-muted)' }}>Image URL</span>
                      <input
                        type="url"
                        value={content.imageUrl ?? ''}
                        onChange={(e) =>
                          onUpdateCell(input.index, {
                            imageUrl: e.target.value || undefined,
                          })
                        }
                        placeholder="https://… or data:image/…"
                        className="flex-1 px-1 py-0.5 rounded text-[10px]"
                        style={{
                          background: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--border)',
                        }}
                      />
                      {content.imageUrl && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateCell(input.index, {
                                imageFit:
                                  content.imageFit === 'cover'
                                    ? 'contain'
                                    : content.imageFit === 'contain'
                                      ? 'fill'
                                      : 'cover',
                              })
                            }
                            className="px-1.5 py-0.5 rounded"
                            style={{
                              background: 'var(--bg-card)',
                              color: 'var(--text-secondary)',
                              border: '1px solid var(--border)',
                            }}
                            title="Cycle fit mode"
                          >
                            {content.imageFit ?? 'cover'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateCell(input.index, {
                                imageUrl: undefined,
                                imageFit: undefined,
                              })
                            }
                            className="hover:opacity-60"
                            title="Clear image"
                          >
                            ×
                          </button>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span style={{ color: 'var(--text-muted)', width: 60 }}>Label size</span>
                      <input
                        type="range"
                        min={0.5}
                        max={2}
                        step={0.05}
                        value={content.labelSizeMultiplier ?? 1}
                        onChange={(e) =>
                          onUpdateCell(input.index, {
                            labelSizeMultiplier: Number.parseFloat(e.target.value) || 1,
                          })
                        }
                        className="flex-1"
                        style={{ accentColor: 'var(--accent-pink)' }}
                      />
                      <span style={{ color: 'var(--text-muted)', width: 36, textAlign: 'right' }}>
                        {Math.round((content.labelSizeMultiplier ?? 1) * 100)}%
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span style={{ color: 'var(--text-muted)' }}>Label colour</span>
                      <input
                        type="color"
                        value={content.labelColor ?? '#000000'}
                        onChange={(e) =>
                          onUpdateCell(input.index, { labelColor: e.target.value })
                        }
                        className="w-7 h-5 rounded border-0 p-0 cursor-pointer"
                        aria-label={`Label colour for ${cellNoun} ${input.index}`}
                      />
                      {content.labelColor && content.labelColor !== '#000000' && (
                        <button
                          type="button"
                          onClick={() => onUpdateCell(input.index, { labelColor: undefined })}
                          className="ml-1 underline"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span style={{ color: 'var(--text-muted)' }}>Shape</span>
                      {(['square', 'rounded', 'circle'] as CellShape[]).map((shape) => {
                        const active = (content.shape ?? canvasOptions?.defaultShape ?? 'square') === shape;
                        return (
                          <button
                            key={shape}
                            type="button"
                            onClick={() => onUpdateCell(input.index, { shape })}
                            className="px-1.5 py-0.5 rounded"
                            style={{
                              background: active ? 'var(--accent-pink)' : 'var(--bg-card)',
                              color: active ? '#fff' : 'var(--text-secondary)',
                              border: '1px solid var(--border)',
                            }}
                            aria-pressed={active}
                            title={shape}
                          >
                            {shape === 'square' ? '▢' : shape === 'rounded' ? '▣' : '◯'}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <button
                        type="button"
                        onClick={() => onUpdateCell(input.index, { emojiFlipX: !content.emojiFlipX })}
                        className="px-2 py-0.5 rounded"
                        style={{
                          background: content.emojiFlipX
                            ? 'var(--accent-pink)'
                            : 'var(--bg-card)',
                          color: content.emojiFlipX ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid var(--border)',
                        }}
                        aria-pressed={content.emojiFlipX}
                      >
                        Flip X
                      </button>
                      <button
                        type="button"
                        onClick={() => onUpdateCell(input.index, { emojiFlipY: !content.emojiFlipY })}
                        className="px-2 py-0.5 rounded"
                        style={{
                          background: content.emojiFlipY
                            ? 'var(--accent-pink)'
                            : 'var(--bg-card)',
                          color: content.emojiFlipY ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid var(--border)',
                        }}
                        aria-pressed={content.emojiFlipY}
                      >
                        Flip Y
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateCell(input.index, {
                            emojiRotation: 0,
                            emojiFlipX: false,
                            emojiFlipY: false,
                            emojiOffsetX: 0,
                            emojiOffsetY: 0,
                          })
                        }
                        className="ml-auto underline"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
      <div>
        <span className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
          Quick emoji palette
        </span>
        <div className="flex flex-wrap gap-1">
          {FREE_FORM_EMOJI_PRESETS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                const target = inputs.find(
                  (input) =>
                    !freeFormCells[input.index]?.iconSlug &&
                    !(freeFormCells[input.index]?.emoji ?? '').trim(),
                );
                if (target) onUpdateCell(target.index, { emoji });
              }}
              className="text-base px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              title={`Fill next empty ${cellNoun} with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
          Quick Lucide icon palette
        </span>
        <div className="flex flex-wrap gap-1">
          {POPULAR_ICON_SLUGS.map((slug) => (
            <button
              key={slug}
              type="button"
              onClick={() => {
                const target = inputs.find(
                  (input) =>
                    !freeFormCells[input.index]?.iconSlug &&
                    !(freeFormCells[input.index]?.emoji ?? '').trim(),
                );
                if (target) onUpdateCell(target.index, { iconSlug: slug });
              }}
              className="p-1 rounded"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              title={`Fill next empty ${cellNoun} with ${slug}`}
            >
              <IconPreview slug={slug} colour="#888" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Small inline SVG preview for an icon slug. Used inside the picker
 *  buttons and the selected-icon indicator. 16×16 fixed size so it
 *  fits the dense per-cell row without re-layout. */
function IconPreview({
  slug,
  colour,
  size = 16,
}: {
  slug: string;
  colour: string;
  size?: number;
}): ReactElement {
  const entry = getIconEntry(slug);
  if (!entry) {
    return <span style={{ width: size, height: size, display: 'inline-block' }} />;
  }
  // Lucide raw SVG ships with its own width/height/stroke attrs. The
  // inner content uses stroke="currentColor" / fill="currentColor" so
  // `color` on the wrapper drives the visible glyph colour.
  return (
    <span
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        color: colour,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      dangerouslySetInnerHTML={{
        __html: entry.svg
          .replace(/width="\d+"/, `width="${size}"`)
          .replace(/height="\d+"/, `height="${size}"`),
      }}
    />
  );
}
