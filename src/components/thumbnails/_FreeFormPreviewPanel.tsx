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

import { useMemo, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import {
  ThumbnailRenderer,
  type FreeFormCell,
  type TitleBarRendererInput,
} from '@/components/thumbnails/ThumbnailRenderer';
import {
  ICON_REGISTRY,
  getIconEntry,
} from '@/lib/thumbnail-formats/flex-icon-grid-icons';
import type { PostProcessConfig } from '@/lib/thumbnail-formats/shared-overlay-pipeline';

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
    };
  });
  // Icon picker UI state — search query + per-cell open dropdown id.
  const [iconQuery, setIconQuery] = useState('');
  const [iconPickerForIndex, setIconPickerForIndex] = useState<number | null>(null);
  const filteredIcons = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    if (!q) return ICON_REGISTRY;
    return ICON_REGISTRY.filter(
      (entry) => entry.slug.includes(q) || entry.label.toLowerCase().includes(q),
    );
  }, [iconQuery]);
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
  const [saving, setSaving] = useState(false);

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
    <div className="glass p-5 space-y-3" style={{ borderColor: 'rgba(236,72,153,0.2)' }}>
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
      <div ref={containerRef} className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <ThumbnailRenderer
          cells={rendererCells}
          canvasBackground="#ffffff"
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          postProcess={postProcessPayload}
          titleBar={titleBarRendererInput}
          alt="Free-form thumbnail preview"
        />
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Pick an emoji + colour for each {cellNoun}. Live preview — no AI calls, no server roundtrip.
      </p>
      <div className="space-y-1.5">
        {inputs.map((input) => {
          const content = freeFormCells[input.index] ?? DEFAULT_FREE_FORM_CELL_STATE;
          const hasTransform =
            content.emojiRotation !== 0 ||
            content.emojiFlipX ||
            content.emojiFlipY ||
            content.emojiOffsetX !== 0 ||
            content.emojiOffsetY !== 0;
          return (
            <div
              key={input.index}
              className="px-2 py-1 rounded space-y-1"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
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
              {content.emoji.trim() !== '' && (
                <details open={hasTransform}>
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
