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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  computeShadowFilterRegion,
  resolveCellShadow,
  resolveCellStroke,
  type BadgeStyle,
  type RingStyle,
  type ShadowStyle,
  type SpanConflictReason,
} from '@/lib/thumbnail-formats/flex-icon-grid';
import {
  extractIconInner,
  getIconEntry,
  getIconSvg,
} from '@/lib/thumbnail-formats/flex-icon-grid-icons';
import { customFontFamilyName } from '@/lib/thumbnail-formats/flex-icon-grid-font-family';
import {
  acquireCustomFont,
  releaseCustomFont,
} from '@/lib/thumbnail-formats/flex-icon-grid-font-registry';
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
 * Subscribe to the module-level font registry for every unique custom-
 * font URL referenced by the config. Phase 4.10 caveat fix: the
 * registry refcounts subscribers, so a side-by-side panel layout (two
 * components referencing the same URL) can't race — the FontFace is
 * shared and only removed when the last subscriber releases it.
 */
function useCustomFontRegistration(config: FlexIconGridConfig): void {
  // URLs this component currently holds a refcount on. Tracked locally
  // so we can release exactly what we acquired on unmount or when the
  // URL set shrinks.
  const subscribed = useRef(new Set<string>());

  useEffect(() => {
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
    // Phase 4.11: subtitle's independent custom font URL.
    if (
      config.titleBar?.subtitleFont === 'custom' &&
      config.titleBar.subtitleCustomFontUrl
    ) {
      wanted.add(config.titleBar.subtitleCustomFontUrl);
    }
    for (const cell of config.cells) {
      const cellStyle = cell.labelStyle;
      if (cellStyle?.font === 'custom' && cellStyle.customFontUrl) {
        wanted.add(cellStyle.customFontUrl);
      }
      // Phase 4.13: badge custom font URLs subscribe to the registry
      // too so the preview chip-row + rendered preview render the
      // right face.
      if (cell.badge?.font === 'custom' && cell.badge.customFontUrl) {
        wanted.add(cell.badge.customFontUrl);
      }
    }

    // Acquire newly-added URLs only.
    for (const url of wanted) {
      if (subscribed.current.has(url)) continue;
      acquireCustomFont(url);
      subscribed.current.add(url);
    }

    // Release URLs that have left the config.
    for (const url of subscribed.current) {
      if (wanted.has(url)) continue;
      releaseCustomFont(url);
      subscribed.current.delete(url);
    }
  }, [config]);

  // Final cleanup on unmount — release every URL this component
  // acquired so the registry refcounts settle to zero when the last
  // subscriber leaves.
  useEffect(() => {
    const tracker = subscribed.current;
    return () => {
      for (const url of tracker) releaseCustomFont(url);
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
        const shadow = resolveCellShadow(cell, config);
        const cellStroke = resolveCellStroke(cell, config);
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
          cell, rect, geom, shape, ring, shadow, cellStroke, labelStyle,
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

        {/* Title bar background + Phase 4.27 optional drop shadow.
            Mirrors the composer's `renderTitleBarBackground` so the
            preview's filter region + offset match the rendered PNG. */}
        {/* Phase 4.27 → 4.28: title bar drop shadow + optional
            gradient fill. Shadow uses the bar height as the
            shape-size hint and inverts the offsetY for bottom-
            position bars so it casts AWAY from the canvas edge —
            into the cells. Gradient (when set) renders via an SVG
            `<linearGradient>` def mirroring the composer's
            `fg-title-bar-bg` id pattern. */}
        {(() => {
          const tb = config.titleBar;
          if (!tb) return null;
          // Phase 4.29: transparent bar — skip both rect and filter
          // since there's no fill to cast a shadow from. The text
          // overlay paints on its own; this just removes the strip.
          const isTransparent = tb.backgroundTransparent === true;
          const hasShadow = !!tb.shadow && !isTransparent;
          const hasGradient = !!tb.backgroundGradient && !isTransparent;
          if (isTransparent) return null;
          const fill = hasGradient
            ? 'url(#fg-preview-title-bar-bg)'
            : tb.background;
          return (
            <>
              {(hasShadow || hasGradient) && (
                <defs>
                  {hasShadow && tb.shadow && (
                    <CellShadowFilter
                      id="fg-preview-title-bar-shadow"
                      shadow={{
                        ...tb.shadow,
                        // Phase 4.33 → 4.34: only displacing
                        // positions auto-flip the direction. Overlay
                        // bars float over cells; either direction is
                        // meaningful, so we respect the raw sign.
                        offsetY:
                          tb.position === 'overlay-top' || tb.position === 'overlay-bottom'
                            ? tb.shadow.offsetY
                            : tb.position === 'bottom'
                              ? -Math.abs(tb.shadow.offsetY)
                              : Math.abs(tb.shadow.offsetY),
                      }}
                      shapeSize={tb.height}
                    />
                  )}
                  {hasGradient && tb.backgroundGradient && (
                    <linearGradient
                      id="fg-preview-title-bar-bg"
                      gradientTransform={`rotate(${tb.backgroundGradient.angle} 0.5 0.5)`}
                    >
                      <stop offset="0%" stopColor={tb.backgroundGradient.from} />
                      <stop offset="100%" stopColor={tb.backgroundGradient.to} />
                    </linearGradient>
                  )}
                </defs>
              )}
              <rect
                x={0}
                y={
                  tb.position === 'top' || tb.position === 'overlay-top'
                    ? 0
                    : config.height - tb.height
                }
                width={config.width}
                height={tb.height}
                fill={fill}
                filter={hasShadow ? 'url(#fg-preview-title-bar-shadow)' : undefined}
              />
            </>
          );
        })()}

        {/* Title bar text + optional Phase 4.10 subtitle. Phase 4.11
            caveat fix: subtitle stacking now uses a single <text>
            element with two <tspan> children + `dy`/`em` line stepping
            so the browser's text engine computes real metrics instead
            of our font-size-as-line-height approximation. Vertical
            centering on the bar is done via SVG `dominantBaseline` on
            the wrapping text element so the stack visually balances
            even when the two lines have different sizes. */}
        {config.titleBar && (() => {
          const tb = config.titleBar;
          const barCenterY =
            tb.position === 'top' || tb.position === 'overlay-top'
              ? tb.height / 2
              : config.height - tb.height / 2;
          const subtitleText = tb.subtitle
            ? sanitizeUserText(tb.subtitle, 80)
            : '';
          const hasSubtitle = subtitleText.length > 0;
          const mainSize = Math.round(tb.height * (hasSubtitle ? 0.45 : 0.55));
          const fontFamily = resolveFontCssFor({
            font: tb.font,
            customFontUrl: tb.customFontUrl,
          });
          // Phase 4.11.1 → 4.30: clip the title text to the same
          // horizontal safe area the composer uses. The composer
          // scales long text to fit (Sharp resize 'inside'); the
          // preview just clips. Phase 4.30 — when the bar is
          // transparent there's no backing rect to clip against, so
          // we skip the clipPath entirely (`undefined` on the text
          // elements means no clip). Cleaner emitted SVG and the
          // text is visually unconstrained, matching the composer's
          // transparent-bar behaviour.
          const titleSideMargin = Math.max(32, Math.round(config.width * 0.06));
          const isTransparentBar = tb.backgroundTransparent === true;
          const clipId = 'fg-preview-title-safe';
          const clipRect = isTransparentBar ? null : (
            <clipPath id={clipId}>
              <rect
                x={titleSideMargin}
                y={
                  tb.position === 'top' || tb.position === 'overlay-top'
                    ? 0
                    : config.height - tb.height
                }
                width={config.width - 2 * titleSideMargin}
                height={tb.height}
              />
            </clipPath>
          );
          const clipPathRef = isTransparentBar ? undefined : `url(#${clipId})`;
          // Phase 4.29 → 4.30: horizontal alignment maps to SVG
          // textAnchor + x position. 'center' (default) keeps the
          // pre-4.29 behaviour. Phase 4.30 — subtitle uses its own
          // alignment when set, falling back to the main alignment.
          const computeAnchor = (
            align: 'left' | 'center' | 'right' | undefined,
          ): { x: number; anchor: 'start' | 'middle' | 'end' } => {
            if (align === 'left') return { x: titleSideMargin, anchor: 'start' };
            if (align === 'right') return { x: config.width - titleSideMargin, anchor: 'end' };
            return { x: config.width / 2, anchor: 'middle' };
          };
          const main = computeAnchor(tb.textAlign);
          const sub = computeAnchor(tb.subtitleTextAlign ?? tb.textAlign);
          const textX = main.x;
          const anchor = main.anchor;
          if (!hasSubtitle) {
            // Phase 4.31 → 4.32: text shadow filter (when set) wraps
            // the single-line <text> just like the two-line case.
            // Region from shared `computeShadowFilterRegion` so big
            // shadows don't clip.
            const ts = tb.textShadow;
            const tsId = ts ? 'fg-preview-title-text-shadow' : null;
            const tsRegion = ts ? computeShadowFilterRegion(ts, mainSize) : null;
            return (
              <>
                <defs>
                  {clipRect}
                  {ts && tsRegion && (
                    <filter
                      id={tsId!}
                      x={`${tsRegion.x}%`}
                      y={`${tsRegion.y}%`}
                      width={`${tsRegion.w}%`}
                      height={`${tsRegion.h}%`}
                    >
                      <feGaussianBlur in="SourceAlpha" stdDeviation={ts.blur} />
                      <feOffset dx={0} dy={ts.offsetY} result="off" />
                      <feFlood floodColor={ts.color} floodOpacity={ts.opacity} />
                      <feComposite in2="off" operator="in" />
                      <feMerge>
                        <feMergeNode />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  )}
                </defs>
                <text
                  x={textX}
                  y={barCenterY}
                  fontFamily={fontFamily}
                  fontSize={mainSize}
                  fontWeight={900}
                  fill={tb.color}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  clipPath={clipPathRef}
                  filter={tsId ? `url(#${tsId})` : undefined}
                >
                  {sanitizeUserText(tb.text, 80)}
                </text>
              </>
            );
          }
          const subSize = Math.max(12, Math.round(tb.height * 0.22));
          // Subtitle line-height: 1em past the main line baseline
          // gives a tight stack; `0.1em` extra padding mirrors the
          // composer's 5%-of-bar-height gap closely enough that the
          // preview lines up with the rendered PNG within a couple
          // of pixels — far better than the per-font estimate the
          // Phase 4.10 implementation used.
          const subDy = `${1 + (tb.height * 0.05) / subSize}em`;
          // Phase 4.11: subtitle resolves its own font family when
          // the user picks one; falls back to the main font family
          // when absent so existing single-font subtitles render
          // unchanged.
          const subFontFamily = tb.subtitleFont
            ? resolveFontCssFor({
                font: tb.subtitleFont,
                customFontUrl: tb.subtitleCustomFontUrl,
              })
            : fontFamily;
          // Phase 4.30: when the subtitle has its own alignment, the
          // single-<text> approach (which shares textAnchor across
          // both lines via the parent) can't satisfy both. Split
          // into two <text> blocks if the alignments differ; share
          // a single <text> with two <tspan>s when they match (the
          // common case — keeps the dy-based line-height honest).
          // Phase 4.30 → 4.31: unified <text> + per-tspan textAnchor +
          // per-tspan x. SVG `<tspan>` accepts both attributes; they
          // override the parent's defaults. We always render one
          // <text> with two <tspan>s — the dy-based stacking stays
          // honest (real glyph-metric line-height), and per-tspan
          // anchors honour independent subtitle alignment without
          // the Phase-4.30 split-text approximation.
          // Phase 4.31 → 4.32: optional drop shadow on the title TEXT
          // (separate from the bar's rect shadow). Mirrors the
          // composer's wrap step via an SVG filter referenced from
          // the <text>'s `filter` attribute. Region from
          // `computeShadowFilterRegion`. Phase 4.32 — subtitle can
          // carry its own text shadow (or opt out with explicit
          // null). When the subtitle's effective shadow differs
          // from the main's, the subtitle gets its own <text>
          // element + filter id since `<tspan>` doesn't accept
          // `filter`.
          const textShadow = tb.textShadow;
          const resolvedSubShadow =
            tb.subtitleTextShadow === null
              ? null
              : tb.subtitleTextShadow ?? tb.textShadow ?? null;
          const subShadowDiffers =
            JSON.stringify(resolvedSubShadow) !== JSON.stringify(tb.textShadow ?? null);
          const textShadowId = textShadow ? 'fg-preview-title-text-shadow' : null;
          const subShadowId = resolvedSubShadow && subShadowDiffers
            ? 'fg-preview-title-sub-text-shadow'
            : null;
          const textShadowRegion = textShadow
            ? computeShadowFilterRegion(textShadow, mainSize)
            : null;
          const subShadowRegion = resolvedSubShadow && subShadowDiffers
            ? computeShadowFilterRegion(resolvedSubShadow, subSize)
            : null;
          return (
            <>
              <defs>
                {clipRect}
                {textShadow && textShadowRegion && (
                  <filter
                    id={textShadowId!}
                    x={`${textShadowRegion.x}%`}
                    y={`${textShadowRegion.y}%`}
                    width={`${textShadowRegion.w}%`}
                    height={`${textShadowRegion.h}%`}
                  >
                    <feGaussianBlur in="SourceAlpha" stdDeviation={textShadow.blur} />
                    <feOffset dx={0} dy={textShadow.offsetY} result="off" />
                    <feFlood floodColor={textShadow.color} floodOpacity={textShadow.opacity} />
                    <feComposite in2="off" operator="in" />
                    <feMerge>
                      <feMergeNode />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                )}
                {subShadowId && resolvedSubShadow && subShadowRegion && (
                  <filter
                    id={subShadowId}
                    x={`${subShadowRegion.x}%`}
                    y={`${subShadowRegion.y}%`}
                    width={`${subShadowRegion.w}%`}
                    height={`${subShadowRegion.h}%`}
                  >
                    <feGaussianBlur in="SourceAlpha" stdDeviation={resolvedSubShadow.blur} />
                    <feOffset dx={0} dy={resolvedSubShadow.offsetY} result="sub-off" />
                    <feFlood floodColor={resolvedSubShadow.color} floodOpacity={resolvedSubShadow.opacity} />
                    <feComposite in2="sub-off" operator="in" />
                    <feMerge>
                      <feMergeNode />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                )}
              </defs>
              {/* Phase 4.32: when subtitle shadow differs from main,
                  render the subtitle as its OWN <text> with its own
                  filter. The main stays a unified <text> + <tspan>
                  with the main filter applied. Approximates the
                  baseline-offset distance so the visual stacking
                  stays close to the unified case. */}
              {subShadowDiffers ? (
                <>
                  <text
                    x={textX}
                    y={barCenterY - subSize / 2}
                    fontFamily={fontFamily}
                    fontSize={mainSize}
                    fontWeight={900}
                    fill={tb.color}
                    textAnchor={anchor}
                    dominantBaseline="middle"
                    clipPath={clipPathRef}
                    filter={textShadowId ? `url(#${textShadowId})` : undefined}
                  >
                    {sanitizeUserText(tb.text, 80)}
                  </text>
                  <text
                    x={sub.x}
                    y={barCenterY + mainSize / 2 + Math.round(tb.height * 0.05)}
                    fontFamily={subFontFamily}
                    fontSize={subSize}
                    fontWeight={700}
                    fill={tb.subtitleColor ?? tb.color}
                    textAnchor={sub.anchor}
                    dominantBaseline="middle"
                    clipPath={clipPathRef}
                    filter={subShadowId ? `url(#${subShadowId})` : undefined}
                  >
                    {subtitleText}
                  </text>
                </>
              ) : (
                <text
                  x={textX}
                  y={barCenterY}
                  fontFamily={fontFamily}
                  fill={tb.color}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  clipPath={clipPathRef}
                  filter={textShadowId ? `url(#${textShadowId})` : undefined}
                >
                  <tspan
                    x={main.x}
                    textAnchor={main.anchor}
                    fontSize={mainSize}
                    fontWeight={900}
                  >
                    {sanitizeUserText(tb.text, 80)}
                  </tspan>
                  <tspan
                    x={sub.x}
                    textAnchor={sub.anchor}
                    dy={subDy}
                    fontFamily={subFontFamily}
                    fontSize={subSize}
                    fontWeight={700}
                    fill={tb.subtitleColor ?? tb.color}
                  >
                    {subtitleText}
                  </tspan>
                </text>
              )}
            </>
          );
        })()}

        {/* Per-cell background defs (gradients + patterns + image),
            per-cell shape shadows, and Phase 4.32 → 4.33 per-cell
            label text shadows — all in ONE top-level <defs> block.
            Phase 4.33 consolidates the label filter entries that
            were previously emitted inside each LabelText. */}
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
          {cellViews.map(({ cell, geom, shadow }) =>
            shadow ? (
              <CellShadowFilter
                key={`shadow-${cell.index}`}
                id={`fg-preview-shadow-${cell.index}`}
                shadow={shadow}
                shapeSize={geom.shapeW}
              />
            ) : null,
          )}
          {cellViews.map(({ cell, geom, labelStyle }) =>
            labelStyle.textShadow ? (
              <LabelShadowFilterDef
                key={`label-shadow-${cell.index}`}
                cellIndex={cell.index}
                labelStyle={labelStyle}
                labelH={geom.labelH}
              />
            ) : null,
          )}
        </defs>

        {/* Cells */}
        {cellViews.map(({ cell, rect, geom, shape, ring, shadow, cellStroke, labelStyle, background, backgroundSpec, conflict }) => (
          <CellGroup
            key={cell.index}
            cell={cell}
            rect={rect}
            geom={geom}
            shape={shape}
            ring={ring}
            shadow={shadow}
            cellStroke={cellStroke}
            labelStyle={labelStyle}
            background={background}
            backgroundSpec={backgroundSpec}
            cornerRadius={config.cornerRadius}
            highlighted={highlightedCellIndex === cell.index}
            conflict={conflict}
            onClick={onCellClick}
            canvasW={config.width}
            canvasH={config.height}
          />
        ))}

        {/* Phase 4.38: grain overlay — rendered BEFORE the vignette
            so the corner-dimming pulls down the grain too (mirrors
            the composer's overlay order). Uses the same
            feTurbulence + tableValues + alpha-scale primitives as
            the server build so visual match is exact. The
            `mix-blend-mode: overlay` is set via CSS on the rect to
            mirror Sharp's `blend: 'overlay'` composite. */}
        {config.grain && (
          <>
            <defs>
              <filter
                id="fg-preview-grain"
                x={0}
                y={0}
                width="100%"
                height="100%"
                filterUnits="userSpaceOnUse"
                primitiveUnits="userSpaceOnUse"
              >
                {/* Phase 4.39: octaves scale with grain size + seed
                    threaded from config so preview matches the
                    composer's render exactly. */}
                <feTurbulence
                  type="fractalNoise"
                  baseFrequency={(0.9 / config.grain.scale).toFixed(4)}
                  numOctaves={Math.max(2, Math.min(5, 2 + Math.round(config.grain.scale / 2)))}
                  seed={config.grain.seed ?? 7}
                  stitchTiles="stitch"
                  result="noise"
                />
                <feComponentTransfer in="noise" result="punched">
                  <feFuncR type="table" tableValues="0 1 0 1 0 1" />
                  <feFuncG type="table" tableValues="0 1 0 1 0 1" />
                  <feFuncB type="table" tableValues="0 1 0 1 0 1" />
                </feComponentTransfer>
                {config.grain.monochrome ? (
                  <feColorMatrix
                    in="punched"
                    type="matrix"
                    values="0.2126 0.7152 0.0722 0 0
                            0.2126 0.7152 0.0722 0 0
                            0.2126 0.7152 0.0722 0 0
                            0      0      0      1 0"
                    result="grain"
                  />
                ) : (
                  <feColorMatrix
                    in="punched"
                    type="matrix"
                    values="1 0 0 0 0
                            0 1 0 0 0
                            0 0 1 0 0
                            0 0 0 1 0"
                    result="grain"
                  />
                )}
                <feColorMatrix
                  in="grain"
                  type="matrix"
                  values={`1 0 0 0 0
                           0 1 0 0 0
                           0 0 1 0 0
                           0 0 0 ${config.grain.intensity.toFixed(3)} 0`}
                />
              </filter>
            </defs>
            <rect
              x={0}
              y={0}
              width={config.width}
              height={config.height}
              fill="#808080"
              filter="url(#fg-preview-grain)"
              style={{ mixBlendMode: 'overlay' }}
              pointerEvents="none"
            />
          </>
        )}

        {/* Phase 4.39 → 4.40: tint overlay — composited AFTER grain
            and BEFORE vignette to mirror the composer's overlay
            order. Uses CSS `mix-blend-mode` matching the configured
            Sharp blend mode so on-screen lines up with the rendered
            PNG. Phase 4.40: split-tone shadows (multiply) +
            highlights (screen) are rendered after the base tint at
            half intensity, in the same stack order as the
            composer's overlays. */}
        {config.tint && (
          <>
            <rect
              x={0}
              y={0}
              width={config.width}
              height={config.height}
              fill={config.tint.color}
              fillOpacity={config.tint.intensity}
              style={{ mixBlendMode: config.tint.blendMode }}
              pointerEvents="none"
            />
            {config.tint.shadows && (
              <rect
                x={0}
                y={0}
                width={config.width}
                height={config.height}
                fill={config.tint.shadows}
                fillOpacity={config.tint.intensity / 2}
                style={{ mixBlendMode: 'multiply' }}
                pointerEvents="none"
              />
            )}
            {config.tint.highlights && (
              <rect
                x={0}
                y={0}
                width={config.width}
                height={config.height}
                fill={config.tint.highlights}
                fillOpacity={config.tint.intensity / 2}
                style={{ mixBlendMode: 'screen' }}
                pointerEvents="none"
              />
            )}
          </>
        )}

        {/* Phase 4.40: light-leak overlay — rendered AFTER tint and
            BEFORE vignette to mirror the composer's order. Uses CSS
            `mix-blend-mode: screen` matching Sharp `blend: 'screen'`. */}
        {config.lightLeak && (() => {
          const l = config.lightLeak;
          const halfMin = Math.min(config.width, config.height) / 2;
          const r = l.radius * halfMin;
          const anchors = {
            'top-left': { cx: 0, cy: 0 },
            'top-right': { cx: config.width, cy: 0 },
            'bottom-left': { cx: 0, cy: config.height },
            'bottom-right': { cx: config.width, cy: config.height },
            top: { cx: config.width / 2, cy: 0 },
            bottom: { cx: config.width / 2, cy: config.height },
            left: { cx: 0, cy: config.height / 2 },
            right: { cx: config.width, cy: config.height / 2 },
          } as const;
          const { cx, cy } = anchors[l.position];
          return (
            <>
              <defs>
                <radialGradient
                  id="fg-preview-lightleak"
                  gradientUnits="userSpaceOnUse"
                  cx={cx}
                  cy={cy}
                  r={r}
                >
                  <stop offset="0%" stopColor={l.color} stopOpacity={l.intensity} />
                  <stop offset="100%" stopColor={l.color} stopOpacity={0} />
                </radialGradient>
              </defs>
              <rect
                x={0}
                y={0}
                width={config.width}
                height={config.height}
                fill="url(#fg-preview-lightleak)"
                style={{ mixBlendMode: 'screen' }}
                pointerEvents="none"
              />
            </>
          );
        })()}

        {/* Phase 4.37 → 4.38: vignette overlay — rendered LAST so it
            sits on top of cells + title bar. Uses an SVG
            `<radialGradient>` matching the composer's
            `buildVignetteOverlay` SVG so on-screen lines up with the
            rendered PNG.

            Phase 4.38 caveat fix: `gradientUnits="userSpaceOnUse"`
            with cx/cy at canvas centre and `r` = half-diagonal. The
            inner-edge offset is `(radius * halfMin) / halfDiag` so
            the falloff stays circular instead of stretching with the
            canvas aspect ratio. */}
        {config.vignette && (() => {
          const cx = config.width / 2;
          const cy = config.height / 2;
          const halfMin = Math.min(config.width, config.height) / 2;
          const halfDiag = Math.sqrt(
            config.width * config.width + config.height * config.height,
          ) / 2;
          const startPct = Math.round(((config.vignette.radius * halfMin) / halfDiag) * 100);
          return (
            <>
              <defs>
                <radialGradient
                  id="fg-preview-vignette"
                  gradientUnits="userSpaceOnUse"
                  cx={cx}
                  cy={cy}
                  r={halfDiag}
                >
                  <stop
                    offset={`${startPct}%`}
                    stopColor={config.vignette.color}
                    stopOpacity={0}
                  />
                  <stop
                    offset="100%"
                    stopColor={config.vignette.color}
                    stopOpacity={config.vignette.intensity}
                  />
                </radialGradient>
              </defs>
              <rect
                x={0}
                y={0}
                width={config.width}
                height={config.height}
                fill="url(#fg-preview-vignette)"
                pointerEvents="none"
              />
            </>
          );
        })()}
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
  /** Phase 4.11 — resolved shadow for this cell; `null` when no
   *  shadow applies (either explicitly opted out or no default set). */
  shadow: ShadowStyle;
  /** Phase 4.30 — resolved outer cell stroke; `null` when no
   *  stroke applies. Painted on top of the cell background fill
   *  and underneath the inner shape. */
  cellStroke: { color: string; thickness: number } | null;
  labelStyle: LabelStyle;
  background: string;
  backgroundSpec: CellBackgroundSpec;
  cornerRadius: number;
  highlighted: boolean;
  conflict: SpanConflictReason | null;
  onClick?: (cellIndex: number) => void;
  /** Phase 4.38: canvas dimensions threaded down so child filter
   *  defs (image filters, future drop-shadows) can pin their
   *  `filterUnits="userSpaceOnUse"` region to the canvas. */
  canvasW: number;
  canvasH: number;
}

function CellGroup({
  cell,
  rect,
  geom,
  shape,
  ring,
  shadow,
  cellStroke,
  labelStyle,
  background,
  backgroundSpec,
  cornerRadius,
  highlighted,
  conflict,
  onClick,
  canvasW,
  canvasH,
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

      {/* Phase 4.30: outer cell stroke. Painted ABOVE the fill and
          BELOW the inner shape so it reads as a frame around the
          whole cell. Inset by half the thickness so the stroke
          stays inside the cell rect. */}
      {cellStroke && cellStroke.thickness > 0 && (
        <rect
          x={rect.x + cellStroke.thickness / 2}
          y={rect.y + cellStroke.thickness / 2}
          width={rect.w - cellStroke.thickness}
          height={rect.h - cellStroke.thickness}
          fill="none"
          stroke={cellStroke.color}
          strokeWidth={cellStroke.thickness}
        />
      )}

      {/* Shape with optional ring + Phase 4.11 drop shadow.
          Phase 4.16 → 4.19: wrap the shape AND content in a
          transform group when `cell.rotation` is non-zero OR the
          cell has flipX/flipY. Combined as
          `translate(cx cy) rotate(N) scale(sx sy) translate(-cx -cy)`
          so both transforms compose around the shape centre — same
          ordering the composer uses, so on-screen lines up with PNG.
          Label band stays outside the group so it remains horizontal. */}
      {(() => {
        const rotation = cell.rotation ?? 0;
        const flipX = cell.flipX === true;
        const flipY = cell.flipY === true;
        const shapeCx = geom.shapeX + geom.shapeW / 2;
        const shapeCy = geom.shapeY + geom.shapeH / 2;
        const sx = flipX ? -1 : 1;
        const sy = flipY ? -1 : 1;
        // Phase 4.35 → 4.36: per-cell content offset shifts the
        // content group by a fraction of the shape's dimensions.
        // Phase 4.36 — rounded to integer pixels so the on-screen
        // preview matches the composer's rendered PNG exactly
        // (Sharp requires integer top/left coordinates for
        // composite overlays).
        // Phase 4.36 — offset is applied OUTSIDE the rotation
        // transform so X positive always means "right on screen"
        // regardless of cell rotation. The previous nesting made
        // the offset axes rotate with the cell, which broke the
        // user's mental model when nudging a rotated icon.
        const offsetDx = cell.contentOffset ? Math.round(cell.contentOffset.x * geom.shapeW) : 0;
        const offsetDy = cell.contentOffset ? Math.round(cell.contentOffset.y * geom.shapeH) : 0;
        const needsTransform = rotation !== 0 || flipX || flipY;
        const needsOffset = offsetDx !== 0 || offsetDy !== 0;
        const contentEl = (
          <>
            {cell.content.type === 'icon-library' && (
              <IconLibraryContent slug={cell.content.name} geom={geom} ring={ring} />
            )}
            {cell.content.type === 'emoji' && (
              <EmojiContent char={cell.content.char} geom={geom} />
            )}
            {cell.content.type === 'upload' && (
              <UploadContent url={cell.content.url} geom={geom} shape={shape} cornerRadius={cornerRadius} fit={cell.content.fit} filter={cell.content.filter} canvasW={canvasW} canvasH={canvasH} />
            )}
            {cell.content.type === 'ai-sticker' && cell.content.url && (
              <UploadContent url={cell.content.url} geom={geom} shape={shape} cornerRadius={cornerRadius} fit={cell.content.fit} filter={cell.content.filter} canvasW={canvasW} canvasH={canvasH} />
            )}
            {cell.content.type === 'text-only' && (
              <TextOnlyContent
                label={labelText}
                geom={geom}
                labelStyle={labelStyle}
                colour={labelColour}
              />
            )}
          </>
        );
        // Phase 4.35: wrap content in a translate group so only the
        // content shifts; the shape rect stays in place. The
        // rotation/flip transform STILL wraps everything (shape +
        // shifted content) so the rotation pivot is the shape
        // centre regardless of offset.
        // Both shape and content get the rotation/flip transform
        // (cells rotate as a unit). Only the CONTENT gets an
        // additional translate(offset) APPLIED OUTSIDE the rotation
        // so its axes are screen-relative — a Phase-4.36 fix for the
        // Phase-4.35 caveat that nudging a rotated cell's content
        // would rotate the offset axes with it.
        const rotateFlipPart = needsTransform
          ? `translate(${shapeCx} ${shapeCy}) ${rotation !== 0 ? `rotate(${rotation}) ` : ''}${flipX || flipY ? `scale(${sx} ${sy}) ` : ''}translate(${-shapeCx} ${-shapeCy})`
          : '';
        const shapeEl = (
          <CellShapeEl
            geom={geom}
            shape={shape}
            ring={ring}
            shadowFilterId={shadow ? `fg-preview-shadow-${cell.index}` : null}
            cornerRadius={cornerRadius}
          />
        );
        const wrappedShape = needsTransform ? (
          <g transform={rotateFlipPart}>{shapeEl}</g>
        ) : (
          shapeEl
        );
        const contentTransformParts: string[] = [];
        if (needsOffset) contentTransformParts.push(`translate(${offsetDx} ${offsetDy})`);
        if (needsTransform) contentTransformParts.push(rotateFlipPart);
        const wrappedContent = contentTransformParts.length === 0 ? (
          contentEl
        ) : (
          <g transform={contentTransformParts.join(' ')}>{contentEl}</g>
        );
        return (
          <>
            {wrappedShape}
            {wrappedContent}
          </>
        );
      })()}

      {/* Label (skip when content is text-only since the label IS the content). */}
      {labelStyle.position !== 'hidden' && cell.content.type !== 'text-only' && (
        <LabelText label={labelText} geom={geom} labelStyle={labelStyle} colour={labelColour} cellIndex={cell.index} />
      )}

      {/* Phase 4.12: corner badge. Sized + positioned to mirror the
          composer's `buildBadgeOverlay` so the live preview lines up
          with the rendered PNG. */}
      {cell.badge && <CornerBadge badge={cell.badge} rect={rect} />}

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
  shadowFilterId,
  cornerRadius,
}: {
  geom: ReturnType<typeof computeCellGeometry>;
  shape: CellShape;
  ring: RingStyle;
  /** Phase 4.11: when set, applies `filter="url(#<id>)"` to the shape
   *  so the SVG renderer casts the configured drop shadow. */
  shadowFilterId: string | null;
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
  const shadowProps = shadowFilterId ? { filter: `url(#${shadowFilterId})` } : {};
  if (shape === 'circle') {
    return <circle cx={cx} cy={cy} r={geom.shapeW / 2} fill={fill} {...strokeProps} {...shadowProps} />;
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
        {...shadowProps}
      />
    );
  }
  if (shape === 'hexagon') {
    return <polygon points={hexagonPointsClient(cx, cy, geom.shapeW)} fill={fill} {...strokeProps} {...shadowProps} />;
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
        {...shadowProps}
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
        {...shadowProps}
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
      {...shadowProps}
    />
  );
}

/**
 * Phase 4.12: corner badge — small rounded-pill chip rendered at one
 * of four cell corners. Sizing math mirrors the composer's
 * `buildBadgeOverlay` so the on-screen preview lines up with the
 * rendered PNG. Text gets pre-uppercased here so the chunky bundled
 * Anton fallback reads consistently with the server-side render.
 *
 * Phase 4.13: pill width is now measured from the actual rendered
 * `<text>` element via `getBBox()` instead of an Anton-only glyph-
 * width estimate. This makes the on-screen preview pixel-accurate
 * for any font, including custom workspace fonts, and removes the
 * ~5 % drift the estimate produced on long badges.
 */
function CornerBadge({
  badge,
  rect,
}: {
  badge: BadgeStyle;
  rect: { x: number; y: number; w: number; h: number };
}) {
  const cellMin = Math.min(rect.w, rect.h);
  const pillH = Math.max(24, Math.round(cellMin * 0.16));
  const fontSize = Math.round(pillH * 0.6);
  const padX = Math.round(pillH * 0.5);
  const inset = Math.max(6, Math.round(cellMin * 0.03));
  const text = badge.text.toUpperCase().slice(0, 8);
  const fontFamily =
    badge.font === 'custom' && badge.customFontUrl
      ? `'${customFontFamilyName(badge.customFontUrl)}', 'Anton', Impact, sans-serif`
      : badge.font
        ? resolveFontCssFor({ font: badge.font })
        : "'Anton', Impact, 'Arial Black', sans-serif";

  // Glyph-width estimate used as the FIRST-PAINT width; replaced by
  // the real getBBox measurement once the text element mounts. The
  // estimate keeps the badge from popping in at zero width on the
  // initial frame (which would briefly show a degenerate pill).
  // Phase 4.14: per-font em-width factors. Measured from the bundled
  // TTFs at 100 px uppercase, averaged across A–Z + 0–9. Custom
  // fonts fall back to the Anton factor — close enough until the
  // post-mount measurement lands.
  const emWidthByFont: Record<Exclude<LabelStyle['font'], 'custom'>, number> = {
    'anton': 0.46,
    'bowlby-one': 0.66,
    'archivo-black': 0.62,
    'patrick-hand': 0.50,
  };
  const emFactor = badge.font && badge.font !== 'custom'
    ? emWidthByFont[badge.font]
    : emWidthByFont.anton;
  const estTextW = Math.round(text.length * fontSize * emFactor);
  const [measuredTextW, setMeasuredTextW] = useState<number | null>(null);
  const textRef = useRef<SVGTextElement | null>(null);

  // Re-measure when text, font size, or font family changes —
  // anything that could change the rendered glyph metrics.
  useLayoutEffect(() => {
    if (!textRef.current) return;
    try {
      const bbox = textRef.current.getBBox();
      if (bbox.width > 0) setMeasuredTextW(bbox.width);
    } catch {
      // getBBox can throw on detached / not-yet-laid-out elements
      // in some browsers — fall back to the estimate silently.
    }
  }, [text, fontSize, fontFamily]);

  const textW = measuredTextW ?? estTextW;
  const pillW = Math.round(textW + 2 * padX);

  let x: number;
  let y: number;
  if (badge.corner === 'top-left') {
    x = rect.x + inset;
    y = rect.y + inset;
  } else if (badge.corner === 'top-right') {
    x = rect.x + rect.w - pillW - inset;
    y = rect.y + inset;
  } else if (badge.corner === 'bottom-left') {
    x = rect.x + inset;
    y = rect.y + rect.h - pillH - inset;
  } else {
    x = rect.x + rect.w - pillW - inset;
    y = rect.y + rect.h - pillH - inset;
  }
  return (
    <g pointerEvents="none">
      <rect
        x={x}
        y={y}
        width={pillW}
        height={pillH}
        rx={pillH / 2}
        ry={pillH / 2}
        fill={badge.background}
      />
      <text
        ref={textRef}
        x={x + pillW / 2}
        y={y + pillH / 2}
        fontSize={fontSize}
        fontWeight={900}
        fontFamily={fontFamily}
        fill={badge.color}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {text}
      </text>
    </g>
  );
}

/**
 * Phase 4.11: SVG <filter> for the drop shadow under a single cell's
 * shape. Mirrors the composer's `emitShadowFilterDef` exactly so the
 * live preview and rendered PNG cast the same shadow.
 */
function CellShadowFilter({
  id,
  shadow,
  shapeSize,
}: {
  id: string;
  shadow: NonNullable<ShadowStyle>;
  shapeSize: number;
}) {
  const region = computeShadowFilterRegion(shadow, shapeSize);
  return (
    <filter
      id={id}
      x={`${region.x}%`}
      y={`${region.y}%`}
      width={`${region.w}%`}
      height={`${region.h}%`}
    >
      <feGaussianBlur in="SourceAlpha" stdDeviation={shadow.blur} />
      <feOffset dx={0} dy={shadow.offsetY} result="offsetblur" />
      <feFlood floodColor={shadow.color} floodOpacity={shadow.opacity} />
      <feComposite in2="offsetblur" operator="in" />
      <feMerge>
        <feMergeNode />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
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

/** Phase 4.37: stable id per filter mode so multiple cells
 *  sharing a filter de-duplicate the `<filter>` def. */
function imageFilterId(mode: string): string {
  return `fg-preview-image-filter-${mode}`;
}

/**
 * Phase 4.37: SVG filter definition for each image filter mode.
 * Cross-browser (Chromium / Firefox / Safari) since SVG `<filter>`
 * elements are part of the SVG spec; the previous CSS `filter` on
 * `<image>` wasn't supported in Safari's WebKit. Each primitive is
 * tuned to visually match the server-side Sharp output as closely
 * as possible (see `buildUploadOverlay` in the composer).
 *
 * Phase 4.38 caveat fix: explicit `filterUnits="userSpaceOnUse"`
 * + region spanning the entire canvas. The default `objectBoundingBox`
 * units with `-10%/120%` region clips drop-style or wide-blur filters
 * at cell edges — by pinning the region to the canvas (which is the
 * outermost bound any cell can occupy), every future filter mode
 * we add (drop-shadow, posterize, glow, etc.) gets the room it needs
 * without changing the filter contract.
 *
 * `primitiveUnits` defaults to `userSpaceOnUse` here as well so any
 * future `stdDeviation` or `dx`/`dy` on primitives is interpreted in
 * pixels rather than fractional-of-region units.
 */
function PreviewImageFilter({
  id,
  mode,
  canvasW,
  canvasH,
}: {
  id: string;
  mode:
    | 'grayscale'
    | 'sepia'
    | 'high-contrast'
    | 'low-contrast'
    | 'invert';
  canvasW: number;
  canvasH: number;
}) {
  // Filter region: pinned to the entire canvas so primitives that
  // extend beyond the image bounds (future blurs, shadows) aren't
  // clipped. feColorMatrix / feComponentTransfer don't expand the
  // bounds today, but ensuring the canonical region now keeps the
  // contract stable as we add more primitives.
  const regionProps = {
    filterUnits: 'userSpaceOnUse' as const,
    primitiveUnits: 'userSpaceOnUse' as const,
    x: 0,
    y: 0,
    width: canvasW,
    height: canvasH,
  };
  if (mode === 'grayscale') {
    // Luminosity grayscale (matches Sharp's .greyscale()).
    return (
      <filter id={id} {...regionProps}>
        <feColorMatrix
          type="matrix"
          values="0.2126 0.7152 0.0722 0 0
                  0.2126 0.7152 0.0722 0 0
                  0.2126 0.7152 0.0722 0 0
                  0      0      0      1 0"
        />
      </filter>
    );
  }
  if (mode === 'sepia') {
    // Sepia toned to match Sharp's `.greyscale().tint({r:112,g:66,b:20})`.
    // Slightly warmer + brighter than the canonical sepia matrix.
    return (
      <filter id={id} {...regionProps}>
        <feColorMatrix
          type="matrix"
          values="0.39 0.77 0.19 0 0
                  0.35 0.69 0.17 0 0
                  0.27 0.53 0.13 0 0
                  0    0    0    1 0"
        />
      </filter>
    );
  }
  if (mode === 'high-contrast') {
    // Match Sharp's `.linear(1.4, -50)` per channel.
    return (
      <filter id={id} {...regionProps}>
        <feComponentTransfer>
          <feFuncR type="linear" slope={1.4} intercept={-0.196} />
          <feFuncG type="linear" slope={1.4} intercept={-0.196} />
          <feFuncB type="linear" slope={1.4} intercept={-0.196} />
        </feComponentTransfer>
      </filter>
    );
  }
  if (mode === 'low-contrast') {
    // Match Sharp's `.linear(0.65, 45)`.
    return (
      <filter id={id} {...regionProps}>
        <feComponentTransfer>
          <feFuncR type="linear" slope={0.65} intercept={0.176} />
          <feFuncG type="linear" slope={0.65} intercept={0.176} />
          <feFuncB type="linear" slope={0.65} intercept={0.176} />
        </feComponentTransfer>
      </filter>
    );
  }
  // invert
  return (
    <filter id={id} {...regionProps}>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="1 0" />
        <feFuncG type="table" tableValues="1 0" />
        <feFuncB type="table" tableValues="1 0" />
      </feComponentTransfer>
    </filter>
  );
}

function UploadContent({
  url,
  geom,
  shape,
  cornerRadius,
  fit,
  filter,
  canvasW,
  canvasH,
}: {
  url: string;
  geom: ReturnType<typeof computeCellGeometry>;
  shape: CellShape;
  cornerRadius: number;
  fit?: 'cover' | 'contain' | 'fill';
  filter?:
    | 'none'
    | 'grayscale'
    | 'sepia'
    | 'high-contrast'
    | 'low-contrast'
    | 'invert';
  /** Phase 4.38: canvas dimensions for filter region pinning. */
  canvasW: number;
  canvasH: number;
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
      {/* Phase 4.36 → 4.37: image filter switched from CSS `filter`
          on `<image>` (which Safari's WebKit doesn't honour) to SVG
          `<filter>` elements referenced by attribute. Each filter
          maps to feColorMatrix / feComponentTransfer primitives —
          cross-browser, no fallback needed. The filter id is shared
          per mode so multiple filtered cells dedupe. */}
      {filter && filter !== 'none' && (
        <defs>
          <PreviewImageFilter
            id={imageFilterId(filter)}
            mode={filter}
            canvasW={canvasW}
            canvasH={canvasH}
          />
        </defs>
      )}
      <image
        href={url}
        x={geom.shapeX}
        y={geom.shapeY}
        width={w}
        height={h}
        preserveAspectRatio={
          fit === 'contain' ? 'xMidYMid meet' : fit === 'fill' ? 'none' : 'xMidYMid slice'
        }
        clipPath={`url(#${clipId})`}
        filter={filter && filter !== 'none' ? `url(#${imageFilterId(filter)})` : undefined}
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
  cellIndex,
}: {
  label: string;
  geom: ReturnType<typeof computeCellGeometry>;
  labelStyle: LabelStyle;
  colour: string;
  cellIndex: number;
}) {
  const bandH = labelStyle.position === 'overlay' ? geom.labelH * 0.7 : geom.labelH;
  const sizePx = Math.max(
    12,
    Math.round(bandH * (labelStyle.maxLines === 2 ? 0.42 : 0.62)),
  );
  // Phase 4.32 → 4.33: label text shadow filter id keyed on cell.
  // The filter <defs> itself lives in a single top-level block (see
  // the parent component's defs map) so a grid with N shadowed
  // labels emits N filter entries inside ONE defs block instead of
  // N separate defs blocks scattered through the SVG tree.
  const ts = labelStyle.textShadow;
  const tsId = ts ? `fg-preview-label-shadow-${cellIndex}` : null;
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
      filter={tsId ? `url(#${tsId})` : undefined}
    >
      {label}
    </text>
  );
}

/**
 * Phase 4.33 → 4.34: helper that emits a single `<filter>` entry
 * for a cell's resolved label shadow. Used inside the top-level
 * shared `<defs>` block so multiple shadowed labels collapse into
 * one defs block instead of polluting the SVG tree.
 *
 * Phase 4.34 — accepts the cell's actual computed `labelH` so the
 * filter region is correctly sized per cell. Replaces the Phase
 * 4.33 hardcoded `bandH = 60` estimate that under-sized regions
 * on dense grids and over-sized them on hero cells.
 */
function LabelShadowFilterDef({
  cellIndex,
  labelStyle,
  labelH,
}: {
  cellIndex: number;
  labelStyle: LabelStyle;
  labelH: number;
}) {
  const ts = labelStyle.textShadow;
  if (!ts) return null;
  // Mirrors the sizing math in LabelText so the region matches the
  // actually-rendered text size for this cell.
  const bandH = labelStyle.position === 'overlay' ? labelH * 0.7 : labelH;
  const sizePx = Math.max(12, Math.round(bandH * (labelStyle.maxLines === 2 ? 0.42 : 0.62)));
  const region = computeShadowFilterRegion(ts, sizePx);
  return (
    <filter
      id={`fg-preview-label-shadow-${cellIndex}`}
      x={`${region.x}%`}
      y={`${region.y}%`}
      width={`${region.w}%`}
      height={`${region.h}%`}
    >
      <feGaussianBlur in="SourceAlpha" stdDeviation={ts.blur} />
      <feOffset dx={0} dy={ts.offsetY} result="off" />
      <feFlood floodColor={ts.color} floodOpacity={ts.opacity} />
      <feComposite in2="off" operator="in" />
      <feMerge>
        <feMergeNode />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
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

