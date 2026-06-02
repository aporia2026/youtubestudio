'use client';

/**
 * Typography preview thumbnail for `visual_type === 'Title Card'` rows.
 *
 * User report (2026-06-02): title-card rows showed "no img" (left rail)
 * and "BLANK" (timeline strip) because they have no R2 image URL — the
 * actual render is `<TitleCardScene>` which paints typography over a
 * solid background. The fallback states implied a broken / unfilled
 * row, but title cards are working-as-intended.
 *
 * This component renders a tiny preview that visually mirrors the
 * TitleCardScene: an accent bar + the row's title text on a solid
 * background. Layout-agnostic — relies on the parent for sizing.
 * Used by ShotsTab and Timeline in place of the blank fallback for
 * title-card rows.
 */

interface TitleCardThumbProps {
  /** Heading text to show — usually the row's on_screen_text or
   *  section_title or visual_description. Truncated visually. */
  title: string;
  /** When true, applies absolute positioning (inset-0) for the
   *  Timeline card layout. Otherwise fills its parent (ShotsTab cell). */
  fillParent?: boolean;
  /** Accent stripe color. Defaults to a deep purple matching the
   *  editor's accent. Mirrors TitleCardScene's `brand.primaryColor`
   *  conceptually but without dragging the brand kit through every
   *  thumbnail caller. */
  accentColor?: string;
}

export function TitleCardThumb({
  title,
  fillParent = false,
  accentColor = '#a78bfa',
}: TitleCardThumbProps): React.ReactElement {
  const rootStyle: React.CSSProperties = fillParent
    ? { position: 'absolute', inset: 0 }
    : { width: '100%', height: '100%' };

  return (
    <div
      style={{
        ...rootStyle,
        background: '#1f2937',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 6px',
        overflow: 'hidden',
        position: fillParent ? 'absolute' : 'relative',
      }}
      aria-label={`Title card: ${title}`}
    >
      {/* Top accent stripe — visual fingerprint that says "this is a
          title card, not a missing image". */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '60%',
          height: 2,
          background: accentColor,
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: '40%',
          height: 2,
          background: accentColor,
        }}
      />
      <span
        style={{
          fontSize: 8,
          fontWeight: 700,
          color: '#f3f4f6',
          textAlign: 'center',
          letterSpacing: 0.2,
          lineHeight: 1.1,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {title || 'Title card'}
      </span>
    </div>
  );
}
