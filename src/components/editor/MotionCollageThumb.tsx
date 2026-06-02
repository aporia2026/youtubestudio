'use client';

/**
 * MotionCollageThumb — shared grid thumbnail for `shot_kind === 'motion_collage'`
 * rows. Renders the N-panel grid the renderer will play, so a row that the
 * exported MP4 will animate doesn't disguise itself as a single static image
 * inside the editor.
 *
 * Behavior, in order of precedence:
 *
 *   1. `panelUrls.length > 1` → CSS grid of all panels (top-left first,
 *      row-major). Uses `grid` when provided; otherwise derives a square-ish
 *      layout (`ceil(sqrt(N))` cols, `ceil(N / cols)` rows) — same rule
 *      production-doc's ImageCell uses (page.tsx:2167-2168).
 *   2. `panelUrls.length === 1` → single `<img>` of that panel.
 *   3. `fallbackImageUrl` set → single `<img>` of the fallback (the row's
 *      regular image_url, used while panels are still being generated).
 *   4. Nothing renderable → returns `null`. The caller owns the blank state.
 *
 * Layout-agnostic: relies on the parent for sizing. Pass `fillParent` when
 * the parent uses absolute positioning (Timeline cards). Otherwise the
 * component just fills 100% of the parent's box (ShotsTab fixed-size cell).
 *
 * Part of PR 1 of `_plans/2026-06-02-editor-motion-collage-support.md`.
 */

import { useState } from 'react';

const PANEL_GAP_PX = 1;

export interface MotionCollageThumbProps {
  /** Panel URLs in row-major order (top-left first). Empty / undefined ⇒
   *  falls through to `fallbackImageUrl`. */
  panelUrls: readonly string[] | undefined;
  /** Grid layout for the panel preview. When omitted, the component
   *  derives cols/rows from `panelUrls.length` preferring a square layout. */
  grid?: { cols: number; rows: number };
  /** Single-image URL to use when panelUrls is empty / length === 1 /
   *  undefined. The row's regular image_url. */
  fallbackImageUrl: string | null | undefined;
  /** Alt text for the underlying `<img>` elements. Cards use empty strings
   *  (decorative under a textual label); a meaningful value should be passed
   *  when the thumb appears outside a labeled context. */
  alt?: string;
  /** `<img>` loading attr. Lazy for off-screen lists; eager for inspector
   *  previews above the fold. */
  loading?: 'lazy' | 'eager';
  /** When true, the root is `position: absolute; inset: 0`. Use for
   *  Timeline cards that absolute-position the thumbnail inside the
   *  card chrome. Otherwise the root fills its parent (width/height: 100%). */
  fillParent?: boolean;
  /** Diagnostic identifier — logged with the first-render decision so we
   *  can grep `[editor motion-collage thumb]` and correlate against a
   *  specific shot when something looks off. */
  shotIndex?: number;
}

/** Square-ish default layout for panel count N. Matches ImageCell's
 *  fallback (page.tsx:2167-2168) — `ceil(sqrt(N))` cols then enough rows
 *  to fit all panels. */
function deriveSquareGrid(panelCount: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(panelCount)));
  const rows = Math.max(1, Math.ceil(panelCount / cols));
  return { cols, rows };
}

export function MotionCollageThumb({
  panelUrls,
  grid,
  fallbackImageUrl,
  alt = '',
  loading = 'lazy',
  fillParent = false,
  shotIndex,
}: MotionCollageThumbProps): React.ReactElement | null {
  // First-render decision log. Mounted state guards against logging once
  // per render — React StrictMode would otherwise double-log every mount.
  // Capped to shotIndex < 10 inside the caller's render branch; the
  // component itself doesn't cap (it doesn't know the project's shot count).
  const [logged, setLogged] = useState(false);
  const panelCount = panelUrls?.length ?? 0;
  const useGrid = panelCount > 1;
  if (!logged && typeof console !== 'undefined' && shotIndex !== undefined && shotIndex < 10) {
    console.info('[editor motion-collage thumb]', {
      shotIndex,
      panelCount,
      gridCols: grid?.cols,
      gridRows: grid?.rows,
      fallbackToSingle: !useGrid,
      hasFallbackImage: Boolean(fallbackImageUrl),
    });
    setLogged(true);
  }

  // Resolve display values.
  const rootStyle: React.CSSProperties = fillParent
    ? { position: 'absolute', inset: 0 }
    : { width: '100%', height: '100%' };

  if (useGrid && panelUrls) {
    const resolved = grid && grid.cols > 0 && grid.rows > 0
      ? grid
      : deriveSquareGrid(panelCount);
    const visiblePanels = panelUrls.slice(0, resolved.cols * resolved.rows);
    return (
      <div
        style={{
          ...rootStyle,
          display: 'grid',
          gridTemplateColumns: `repeat(${resolved.cols}, 1fr)`,
          gridTemplateRows: `repeat(${resolved.rows}, 1fr)`,
          gap: PANEL_GAP_PX,
          background: 'rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}
        aria-label={`Motion collage with ${panelCount} keyframes`}
      >
        {visiblePanels.map((url, idx) => (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            key={idx}
            src={url}
            alt={alt}
            loading={loading}
            draggable={false}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ))}
      </div>
    );
  }

  // Single-panel fallback. Either panelUrls has exactly one entry or the
  // pipeline hasn't generated panels yet — show the row's regular image.
  const singleUrl = (panelUrls && panelCount === 1 ? panelUrls[0] : null) ?? fallbackImageUrl;
  if (singleUrl) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={singleUrl}
        alt={alt}
        loading={loading}
        draggable={false}
        style={{
          ...rootStyle,
          width: fillParent ? undefined : '100%',
          height: fillParent ? undefined : '100%',
          objectFit: 'cover',
          display: 'block',
        }}
      />
    );
  }

  return null;
}
