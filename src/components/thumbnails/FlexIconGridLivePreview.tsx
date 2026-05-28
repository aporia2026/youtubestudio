'use client';

/**
 * Flex Icon Grid — client-side live preview.
 *
 * Renders the same SVG geometry the server composer would produce,
 * inline in the browser. Used inside `FlexIconGridPanel` so every
 * config tweak is reflected on the canvas without a network round
 * trip — see plan §10 ("Live preview is non-negotiable"). No fonts
 * are loaded explicitly here: the browser falls back to its system
 * sans-serif unless the project's global CSS @font-face rules
 * register the bundled TTFs (added by the next-up wire-in step).
 *
 * Symmetry rule: any geometry change (cell rect math, shape rules,
 * label band fractions) MUST happen in `flex-icon-grid.ts` so this
 * file and `flex-icon-grid-composer.ts` use the same source of
 * truth. The preview re-implements only the SVG emission paths
 * because the server composer's text rendering goes through Sharp
 * + Pango, which the browser can't run.
 *
 * Click handling: cells fire `onCellClick(cellIndex)` so the parent
 * panel can open the cell editor side-panel for the clicked cell.
 * Optional `highlightedCellIndex` paints a subtle border around the
 * currently-selected cell for visual lock-in.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  applyLabelCase,
  computeCellGeometry,
  computeCellRect,
  computeGridLayout,
  getConsumedCellIndexes,
  getSpanConflicts,
  sanitizeUserText,
  type CellBackgroundSpec,
  type CellShape,
  type FlexIconCell,
  type FlexIconGridConfig,
  type LabelStyle,
  type RingStyle,
  type SpanConflictReason,
} from '@/lib/thumbnail-formats/flex-icon-grid';
import {
  extractIconInner,
  getIconEntry,
  getIconSvg,
} from '@/lib/thumbnail-formats/flex-icon-grid-icons';
import { customFontFamilyName } from '@/lib/thumbnail-formats/flex-icon-grid-font-family';
import {
  pickLabelColourFor,
  resolveCellBackgrounds,
} from '@/lib/thumbnail-formats/flex-icon-grid-palettes';

interface Props {
  config: FlexIconGridConfig;
  /** When set, paints a 4 px highlighted outline around the cell
   *  with that 1-based index. Use to indicate which cell the
   *  side-panel editor is currently editing. */
  highlightedCellIndex?: number | null;
  /** Click handler invoked with the 1-based cell index. */
  onCellClick?: (cellIndex: number) => void;
  /** Optional CSS className for the outer wrapper. The wrapper is
   *  responsive: the SVG keeps its 16:9 aspect ratio while the
   *  wrapper scales to its container width. */
  className?: string;
}

/** Map our `LabelFont` enum to a browser CSS family stack. Falls
 *  back to a chunky generic sans-serif when the bundled TTF isn't
 *  loaded — keeps the preview readable even if the wire-in font
 *  registration hasn't happened yet. `'custom'` returns a stack that
 *  references the per-URL-derived family registered via
 *  `registerCustomFonts` below; the stable hash-based name lets the
 *  preview pick up the font as soon as it's loaded. */
const FONT_CSS_FALLBACK: Record<Exclude<LabelStyle['font'], 'custom'>, string> = {
  'anton': "'Anton', Impact, 'Arial Black', sans-serif",
  'bowlby-one': "'Bowlby One', 'Arial Black', sans-serif",
  'archivo-black': "'Archivo Black', 'Helvetica Neue', sans-serif",
  'patrick-hand': "'Patrick Hand', Caveat, cursive",
};

// `customFontFamilyName` moved to `flex-icon-grid-font-family.ts` so
// the panel and any other surface can derive the same family names
// without duplicating the hash logic. See top of this file for the
// import.

/** Resolve a `LabelStyle.font` to the CSS family stack the live
 *  preview should set on the rendering `<text>` elements. Threads
 *  the custom font URL when applicable so the FontFace registered by
 *  the effect below is actually used. */
function resolveFontCssFor(style: { font: LabelStyle['font']; customFontUrl?: string }): string {
  if (style.font === 'custom' && style.customFontUrl) {
    return `'${customFontFamilyName(style.customFontUrl)}', Impact, 'Arial Black', sans-serif`;
  }
  if (style.font === 'custom') return FONT_CSS_FALLBACK.anton;
  return FONT_CSS_FALLBACK[style.font];
}

/**
 * Mount + cleanup FontFace registrations for every unique custom-
 * font URL referenced by the config. Phase 4.7 caveat fix: tracks
 * registered URLs in a ref so the effect only registers NEWLY-added
 * URLs and only deletes URLs that have left the config — no churn
 * on edits that don't touch the font set.
 */
function useCustomFontRegistration(config: FlexIconGridConfig): void {
  // url → FontFace, persisted across renders so we can delta-update.
  const registered = useRef(new Map<string, FontFace>());

  useEffect(() => {
    if (typeof document === 'undefined' || !('fonts' in document)) return;

    // Collect unique URLs from every label-style position. Phase 4.9a
    // adds the title bar's custom URL to the registration set so the
    // preview's title text loads the right face.
    const wanted = new Set<string>();
    if (config.defaultLabel.font === 'custom' && config.defaultLabel.customFontUrl) {
      wanted.add(config.defaultLabel.customFontUrl);
    }
    if (config.titleBar?.font === 'custom' && config.titleBar.customFontUrl) {
      wanted.add(config.titleBar.customFontUrl);
    }
    for (const cell of config.cells) {
      const cellStyle = cell.labelStyle;
      if (cellStyle?.font === 'custom' && cellStyle.customFontUrl) {
        wanted.add(cellStyle.customFontUrl);
      }
    }

    // Register newly-added URLs only.
    for (const url of wanted) {
      if (registered.current.has(url)) continue;
      const family = customFontFamilyName(url);
      const face = new FontFace(family, `url(${url})`);
      registered.current.set(url, face);
      void face.load().then((loaded) => {
        document.fonts.add(loaded);
      }).catch((err) => {
        console.warn('[flex-icon-grid preview] custom font load failed', {
          family, url_prefix: url.slice(0, 60),
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Delete URLs that have left the config.
    for (const [url, face] of registered.current) {
      if (wanted.has(url)) continue;
      try { document.fonts.delete(face); } catch { /* ignore */ }
      registered.current.delete(url);
    }
  }, [config]);

  // Final cleanup on unmount — delete every registered face the
  // panel session ever loaded so a hot-reload doesn't leak fonts
  // into the document.fonts registry.
  useEffect(() => {
    const tracker = registered.current;
    return () => {
      if (typeof document === 'undefined' || !('fonts' in document)) return;
      for (const face of tracker.values()) {
        try { document.fonts.delete(face); } catch { /* ignore */ }
      }
      tracker.clear();
    };
  }, []);
}

export function FlexIconGridLivePreview({
  config,
  highlightedCellIndex,
  onCellClick,
  className,
}: Props) {
  // Register any custom font URLs the config references (default
  // label style, per-cell overrides). Each unique URL becomes a
  // FontFace under a hash-derived family name; resolveFontCssFor()
  // produces the same family name so the <text> elements pick the
  // loaded face the moment it resolves.
  useCustomFontRegistration(config);
  // Memoise heavy work: layout + palette resolution + per-cell geometry.
  // Triggered only when the config reference changes; the panel will
  // give us a fresh reference on every edit so the memo is correct
  // without a deep-equal comparison.
  const { cellViews } = useMemo(() => {
    const layout = computeGridLayout(config);
    const backgrounds = resolveCellBackgrounds(config);
    const consumed = getConsumedCellIndexes(config);
    const conflicts = getSpanConflicts(config);
    const cellViews = config.cells
      .filter((cell) => !consumed.has(cell.index))
      .map((cell) => {
        const rect = computeCellRect(layout, cell.index, cell.cellSpan);
        const labelStyle = resolveLabelStyle(cell, config);
        const shape = cell.shape ?? config.defaultCellShape;
        const ring = resolveRing(cell, config);
        const geom = computeCellGeometry(rect.x, rect.y, rect.w, rect.h, labelStyle.position);
        const paletteColour = backgrounds[cell.index - 1] ?? '#0a0a0a';
        const backgroundSpec: CellBackgroundSpec =
          cell.background ??
          (cell.backgroundColor ? { type: 'solid', color: cell.backgroundColor } : { type: 'solid', color: paletteColour });
        // For label-colour heuristics we need a representative single
        // colour; gradient + pattern + image cells use a sensible
        // fallback (the gradient's "from" stop, the pattern bg, or the
        // palette colour respectively).
        const representativeColour =
          backgroundSpec.type === 'solid' ? backgroundSpec.color :
          backgroundSpec.type === 'gradient' ? backgroundSpec.from :
          backgroundSpec.type === 'pattern' ? backgroundSpec.bg :
          paletteColour;
        return {
          cell, rect, geom, shape, ring, labelStyle,
          background: representativeColour, backgroundSpec,
          conflict: conflicts.get(cell.index) ?? null,
        };
      });
    return { cellViews };
  }, [config]);

  return (
    <div className={className} style={{ aspectRatio: `${config.width} / ${config.height}`, width: '100%' }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${config.width} ${config.height}`}
        width="100%"
        height="100%"
        style={{ display: 'block', borderRadius: 6 }}
      >
        {/* Canvas background */}
        <CanvasBackground config={config} />

        {/* Title bar background */}
        {config.titleBar && (
          <rect
            x={0}
            y={config.titleBar.position === 'top' ? 0 : config.height - config.titleBar.height}
            width={config.width}
            height={config.titleBar.height}
            fill={config.titleBar.background}
          />
        )}

        {/* Title bar text */}
        {config.titleBar && (
          <text
            x={config.width / 2}
            y={
              config.titleBar.position === 'top'
                ? config.titleBar.height / 2
                : config.height - config.titleBar.height / 2
            }
            fontFamily={resolveFontCssFor({
              font: config.titleBar.font,
              customFontUrl: config.titleBar.customFontUrl,
            })}
            fontSize={Math.round(config.titleBar.height * 0.55)}
            fontWeight={900}
            fill={config.titleBar.color}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {sanitizeUserText(config.titleBar.text, 80)}
          </text>
        )}

        {/* Per-cell background defs (gradients + patterns + image). One <defs>
            block per cell to keep ids unique. */}
        <defs>
          {cellViews.map(({ cell, backgroundSpec }) =>
            backgroundSpec.type === 'solid' ? null : (
              <CellBackgroundDef
                key={`def-${cell.index}`}
                id={`fg-preview-bg-${cell.index}`}
                spec={backgroundSpec}
              />
            ),
          )}
        </defs>

        {/* Cells */}
        {cellViews.map(({ cell, rect, geom, shape, ring, labelStyle, background, backgroundSpec, conflict }) => (
          <CellGroup
            key={cell.index}
            cell={cell}
            rect={rect}
            geom={geom}
            shape={shape}
            ring={ring}
            labelStyle={labelStyle}
            background={background}
            backgroundSpec={backgroundSpec}
            cornerRadius={config.cornerRadius}
            highlighted={highlightedCellIndex === cell.index}
            conflict={conflict}
            onClick={onCellClick}
          />
        ))}
      </svg>
    </div>
  );
}

// ─── Background ─────────────────────────────────────────────────────────────

/**
 * SVG `<defs>` content for a single cell's non-solid background. Mirrors
 * the composer's `emitCellBackgroundFill` exactly so the live preview
 * matches the rendered PNG. Solid cells skip the def entirely (handled
 * by the parent).
 */
function CellBackgroundDef({ id, spec }: { id: string; spec: CellBackgroundSpec }) {
  if (spec.type === 'gradient') {
    return (
      <linearGradient id={id} gradientTransform={`rotate(${spec.angle} 0.5 0.5)`}>
        <stop offset="0%" stopColor={spec.from} />
        <stop offset="100%" stopColor={spec.to} />
      </linearGradient>
    );
  }
  if (spec.type === 'pattern') {
    if (spec.pattern === 'dots') {
      return (
        <pattern id={id} patternUnits="userSpaceOnUse" width="24" height="24">
          <rect width="24" height="24" fill={spec.bg} />
          <circle cx="12" cy="12" r="3" fill={spec.fg} />
        </pattern>
      );
    }
    if (spec.pattern === 'stripes') {
      return (
        <pattern id={id} patternUnits="userSpaceOnUse" width="20" height="20" patternTransform="rotate(45)">
          <rect width="20" height="20" fill={spec.bg} />
          <rect width="10" height="20" fill={spec.fg} />
        </pattern>
      );
    }
    if (spec.pattern === 'grid') {
      return (
        <pattern id={id} patternUnits="userSpaceOnUse" width="24" height="24">
          <rect width="24" height="24" fill={spec.bg} />
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke={spec.fg} strokeWidth={2} />
        </pattern>
      );
    }
    // checker
    return (
      <pattern id={id} patternUnits="userSpaceOnUse" width="16" height="16">
        <rect width="16" height="16" fill={spec.bg} />
        <rect x="0" y="0" width="8" height="8" fill={spec.fg} />
        <rect x="8" y="8" width="8" height="8" fill={spec.fg} />
      </pattern>
    );
  }
  // Solid cells are handled by the parent (no def emitted), so the only
  // remaining variant by this point is 'image'. Narrow explicitly so
  // TypeScript knows `.url` is safe.
  if (spec.type === 'solid') return null;
  return (
    <pattern id={id} patternUnits="objectBoundingBox" width="1" height="1">
      <image href={spec.url} x="0" y="0" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
    </pattern>
  );
}

function CanvasBackground({ config }: { config: FlexIconGridConfig }) {
  const { width, height, background } = config;
  if (background.type === 'gradient') {
    const id = 'fg-bg-grad-preview';
    return (
      <>
        <defs>
          <linearGradient id={id} gradientTransform={`rotate(${background.angle} 0.5 0.5)`}>
            <stop offset="0%" stopColor={background.from} />
            <stop offset="100%" stopColor={background.to} />
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={width} height={height} fill={`url(#${id})`} />
      </>
    );
  }
  return <rect x={0} y={0} width={width} height={height} fill={background.color} />;
}

// ─── Cell ───────────────────────────────────────────────────────────────────

interface CellGroupProps {
  cell: FlexIconCell;
  rect: { x: number; y: number; w: number; h: number };
  geom: ReturnType<typeof computeCellGeometry>;
  shape: CellShape;
  ring: RingStyle;
  labelStyle: LabelStyle;
  background: string;
  backgroundSpec: CellBackgroundSpec;
  cornerRadius: number;
  highlighted: boolean;
  conflict: SpanConflictReason | null;
  onClick?: (cellIndex: number) => void;
}

function CellGroup({
  cell,
  rect,
  geom,
  shape,
  ring,
  labelStyle,
  background,
  backgroundSpec,
  cornerRadius,
  highlighted,
  conflict,
  onClick,
}: CellGroupProps) {
  const handleClick = onClick ? () => onClick(cell.index) : undefined;
  const labelText = applyLabelCase(sanitizeUserText(cell.label, 60), labelStyle.case);
  const labelColour = resolveLabelColour(labelStyle, background);
  const cellFill =
    backgroundSpec.type === 'solid' ? backgroundSpec.color : `url(#fg-preview-bg-${cell.index})`;

  return (
    <g
      style={onClick ? { cursor: 'pointer' } : undefined}
      onClick={handleClick}
    >
      {/* Cell background */}
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill={cellFill} />

      {/* Shape with optional ring */}
      <CellShapeEl geom={geom} shape={shape} ring={ring} cornerRadius={cornerRadius} />

      {/* Content */}
      {cell.content.type === 'icon-library' && (
        <IconLibraryContent
          slug={cell.content.name}
          geom={geom}
          ring={ring}
        />
      )}
      {cell.content.type === 'emoji' && (
        <EmojiContent char={cell.content.char} geom={geom} />
      )}
      {cell.content.type === 'upload' && (
        <UploadContent url={cell.content.url} geom={geom} shape={shape} cornerRadius={cornerRadius} />
      )}
      {cell.content.type === 'ai-sticker' && cell.content.url && (
        <UploadContent url={cell.content.url} geom={geom} shape={shape} cornerRadius={cornerRadius} />
      )}
      {cell.content.type === 'text-only' && (
        <TextOnlyContent
          label={labelText}
          geom={geom}
          labelStyle={labelStyle}
          colour={labelColour}
        />
      )}

      {/* Label (skip when content is text-only since the label IS the content). */}
      {labelStyle.position !== 'hidden' && cell.content.type !== 'text-only' && (
        <LabelText label={labelText} geom={geom} labelStyle={labelStyle} colour={labelColour} />
      )}

      {/* Highlight outline for the active cell in the editor. */}
      {highlighted && (
        <rect
          x={rect.x + 2}
          y={rect.y + 2}
          width={rect.w - 4}
          height={rect.h - 4}
          fill="none"
          stroke="#38BDF8"
          strokeWidth={4}
          strokeDasharray="10 6"
          pointerEvents="none"
        />
      )}

      {/* Span conflict warning — yellow dashed outline + corner badge.
          Drawn LAST so it sits on top of the highlight border for the
          unambiguous "this cell needs attention" affordance. */}
      {conflict && (
        <>
          <rect
            x={rect.x + 2}
            y={rect.y + 2}
            width={rect.w - 4}
            height={rect.h - 4}
            fill="none"
            stroke="#FACC15"
            strokeWidth={4}
            strokeDasharray="6 4"
            pointerEvents="none"
          />
          <circle
            cx={rect.x + rect.w - 16}
            cy={rect.y + 16}
            r={10}
            fill="#FACC15"
            stroke="#0a0a0a"
            strokeWidth={2}
            pointerEvents="none"
          />
          <text
            x={rect.x + rect.w - 16}
            y={rect.y + 16}
            fontSize={14}
            fontWeight={900}
            fill="#0a0a0a"
            textAnchor="middle"
            dominantBaseline="central"
            pointerEvents="none"
          >
            !
          </text>
        </>
      )}
    </g>
  );
}

function CellShapeEl({
  geom,
  shape,
  ring,
  cornerRadius,
}: {
  geom: ReturnType<typeof computeCellGeometry>;
  shape: CellShape;
  ring: RingStyle;
  cornerRadius: number;
}) {
  const cx = geom.shapeX + geom.shapeW / 2;
  const cy = geom.shapeY + geom.shapeH / 2;
  const fill = '#fbfbf8';
  const strokeProps = ring
    ? {
        stroke: ring.color,
        strokeWidth: ring.thickness,
        strokeDasharray: ring.style === 'dashed' ? `${ring.thickness * 2} ${ring.thickness * 1.5}` : undefined,
      }
    : { stroke: 'none' };
  if (shape === 'circle') {
    return <circle cx={cx} cy={cy} r={geom.shapeW / 2} fill={fill} {...strokeProps} />;
  }
  if (shape === 'rounded-square') {
    const r = Math.min(cornerRadius, geom.shapeW / 4);
    return (
      <rect
        x={geom.shapeX}
        y={geom.shapeY}
        width={geom.shapeW}
        height={geom.shapeH}
        rx={r}
        ry={r}
        fill={fill}
        {...strokeProps}
      />
    );
  }
  if (shape === 'hexagon') {
    return <polygon points={hexagonPointsClient(cx, cy, geom.shapeW)} fill={fill} {...strokeProps} />;
  }
  if (shape === 'pill') {
    const pw = geom.shapeW * 0.55;
    const ph = geom.shapeH;
    return (
      <rect
        x={cx - pw / 2}
        y={cy - ph / 2}
        width={pw}
        height={ph}
        rx={pw / 2}
        ry={pw / 2}
        fill={fill}
        {...strokeProps}
      />
    );
  }
  if (shape === 'capsule') {
    const cw = geom.shapeW;
    const ch = geom.shapeH * 0.55;
    return (
      <rect
        x={cx - cw / 2}
        y={cy - ch / 2}
        width={cw}
        height={ch}
        rx={ch / 2}
        ry={ch / 2}
        fill={fill}
        {...strokeProps}
      />
    );
  }
  return (
    <rect
      x={geom.shapeX}
      y={geom.shapeY}
      width={geom.shapeW}
      height={geom.shapeH}
      fill={fill}
      {...strokeProps}
    />
  );
}

/** Six vertices of a flat-top regular hexagon inscribed in a square of
 *  side `size`, centred at (cx, cy). Mirrors the server-side helper
 *  in `flex-icon-grid-composer.ts` so the live preview and the
 *  rendered PNG line up pixel-for-pixel. */
function hexagonPointsClient(cx: number, cy: number, size: number): string {
  const w = size;
  const h = size * 0.866;
  const halfW = w / 2;
  const halfH = h / 2;
  const quarterW = w / 4;
  return [
    `${cx - halfW},${cy}`,
    `${cx - quarterW},${cy - halfH}`,
    `${cx + quarterW},${cy - halfH}`,
    `${cx + halfW},${cy}`,
    `${cx + quarterW},${cy + halfH}`,
    `${cx - quarterW},${cy + halfH}`,
  ].join(' ');
}

function IconLibraryContent({
  slug,
  geom,
  ring,
}: {
  slug: string;
  geom: ReturnType<typeof computeCellGeometry>;
  ring: RingStyle;
}) {
  const entry = useMemo(() => getIconEntry(slug), [slug]);
  const inner = useMemo(() => extractIconInner(entry?.svg ?? getIconSvg(slug) ?? ''), [entry, slug]);
  if (!inner) return null;
  const iconSize = Math.round(geom.shapeW * 0.62);
  const cx = geom.shapeX + geom.shapeW / 2;
  const cy = geom.shapeY + geom.shapeH / 2;
  const colour = ring?.color ?? '#0a0a0a';
  const strokeWidth = Math.max(2, Math.round(iconSize * 0.06));
  const scale = iconSize / 24;
  const tx = cx - iconSize / 2;
  const ty = cy - iconSize / 2;
  const isFill = entry?.iconStyle === 'fill';
  // dangerouslySetInnerHTML for the Lucide / Simple-Icons body. The
  // string comes from our static registry — no XSS risk. The wrapping
  // `<g>` switches between fill and stroke modes based on the entry's
  // configured iconStyle so mixed Lucide + Simple-Icons sets render
  // correctly in the same grid.
  return (
    <g
      transform={`translate(${tx} ${ty}) scale(${scale})`}
      {...(isFill
        ? { fill: colour, stroke: 'none' }
        : {
            fill: 'none',
            stroke: colour,
            strokeWidth: strokeWidth / scale,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}

function EmojiContent({
  char,
  geom,
}: {
  char: string;
  geom: ReturnType<typeof computeCellGeometry>;
}) {
  const sizePx = Math.max(16, Math.round(Math.min(geom.shapeW, geom.shapeH) * 0.62));
  return (
    <text
      x={geom.shapeX + geom.shapeW / 2}
      y={geom.shapeY + geom.shapeH / 2}
      fontSize={sizePx}
      textAnchor="middle"
      dominantBaseline="middle"
    >
      {char}
    </text>
  );
}

function UploadContent({
  url,
  geom,
  shape,
  cornerRadius,
}: {
  url: string;
  geom: ReturnType<typeof computeCellGeometry>;
  shape: CellShape;
  cornerRadius: number;
}) {
  // Mask uploaded images to the cell shape via SVG <clipPath>. Each
  // cell gets a unique clip id so multiple uploads in one preview
  // don't collide.
  const clipId = `fg-clip-${geom.shapeX}-${geom.shapeY}`;
  const w = geom.shapeW;
  const h = geom.shapeH;
  const cx = geom.shapeX + w / 2;
  const cy = geom.shapeY + h / 2;
  return (
    <>
      <defs>
        <clipPath id={clipId}>
          {shape === 'circle' ? (
            <circle cx={cx} cy={cy} r={w / 2} />
          ) : shape === 'rounded-square' ? (
            <rect
              x={geom.shapeX}
              y={geom.shapeY}
              width={w}
              height={h}
              rx={Math.min(cornerRadius, w / 4)}
              ry={Math.min(cornerRadius, w / 4)}
            />
          ) : shape === 'hexagon' ? (
            <polygon points={hexagonPointsClient(cx, cy, w)} />
          ) : shape === 'pill' ? (
            <rect
              x={cx - (w * 0.55) / 2}
              y={cy - h / 2}
              width={w * 0.55}
              height={h}
              rx={(w * 0.55) / 2}
              ry={(w * 0.55) / 2}
            />
          ) : shape === 'capsule' ? (
            <rect
              x={cx - w / 2}
              y={cy - (h * 0.55) / 2}
              width={w}
              height={h * 0.55}
              rx={(h * 0.55) / 2}
              ry={(h * 0.55) / 2}
            />
          ) : (
            <rect x={geom.shapeX} y={geom.shapeY} width={w} height={h} />
          )}
        </clipPath>
      </defs>
      <image
        href={url}
        x={geom.shapeX}
        y={geom.shapeY}
        width={w}
        height={h}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${clipId})`}
      />
    </>
  );
}

function TextOnlyContent({
  label,
  geom,
  labelStyle,
  colour,
}: {
  label: string;
  geom: ReturnType<typeof computeCellGeometry>;
  labelStyle: LabelStyle;
  colour: string;
}) {
  const sizePx = Math.max(20, Math.round(Math.min(geom.shapeW, geom.shapeH) * 0.4));
  return (
    <text
      x={geom.shapeX + geom.shapeW / 2}
      y={geom.shapeY + geom.shapeH / 2}
      fontFamily={resolveFontCssFor(labelStyle)}
      fontSize={sizePx}
      fontWeight={900}
      fill={colour}
      textAnchor="middle"
      dominantBaseline="middle"
    >
      {label}
    </text>
  );
}

function LabelText({
  label,
  geom,
  labelStyle,
  colour,
}: {
  label: string;
  geom: ReturnType<typeof computeCellGeometry>;
  labelStyle: LabelStyle;
  colour: string;
}) {
  const bandH = labelStyle.position === 'overlay' ? geom.labelH * 0.7 : geom.labelH;
  const sizePx = Math.max(
    12,
    Math.round(bandH * (labelStyle.maxLines === 2 ? 0.42 : 0.62)),
  );
  return (
    <text
      x={geom.labelX + geom.labelW / 2}
      y={geom.labelY + geom.labelH / 2}
      fontFamily={resolveFontCssFor(labelStyle)}
      fontSize={sizePx}
      fontWeight={900}
      fill={colour}
      stroke={labelStyle.stroke ? labelStyle.stroke.color : undefined}
      strokeWidth={labelStyle.stroke ? labelStyle.stroke.thickness : undefined}
      paintOrder="stroke fill"
      textAnchor="middle"
      dominantBaseline="middle"
    >
      {label}
    </text>
  );
}

// ─── Helpers (mirror composer) ──────────────────────────────────────────────

function resolveRing(cell: FlexIconCell, config: FlexIconGridConfig): RingStyle {
  if (cell.ring === null) return null;
  if (cell.ring) return cell.ring;
  return config.defaultRing;
}

function resolveLabelStyle(cell: FlexIconCell, config: FlexIconGridConfig): LabelStyle {
  return { ...config.defaultLabel, ...(cell.labelStyle ?? {}) };
}

function resolveLabelColour(style: LabelStyle, background: string): string {
  if (style.color !== '#0a0a0a' && style.color !== '#0A0A0A') return style.color;
  return pickLabelColourFor(background);
}

