/**
 * Unit tests for ShotKindBadge + TitleCardThumb.
 *
 * User-reported gaps (2026-06-02):
 *   - Title-card rows showed "no img" / "BLANK" in the editor's left
 *     rail + timeline strip. The renderer paints typography for those
 *     rows (TitleCardScene), so the editor previews were misleading.
 *   - No visible indicator of shot kind on the thumbnail — users had
 *     to open the inspector and read Shot type to know what each
 *     shot was.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ShotKindBadge,
  resolveShotKindLabel,
} from '@/components/editor/ShotKindBadge';
import { TitleCardThumb } from '@/components/editor/TitleCardThumb';

describe('resolveShotKindLabel — renderer-precedence ordering', () => {
  it('shotKind motion_collage wins over any visual_type', () => {
    expect(
      resolveShotKindLabel({ shotKind: 'motion_collage', visualType: 'Title Card' }),
    ).toBe('COLLAGE');
  });

  it('shotKind motion wins over visual_type', () => {
    expect(resolveShotKindLabel({ shotKind: 'motion', visualType: 'B-Roll' })).toBe('MOTION');
  });

  it('Title Card visual_type maps to TITLE when shotKind is absent', () => {
    expect(resolveShotKindLabel({ visualType: 'Title Card' })).toBe('TITLE');
  });

  it('Statistics maps to STAT', () => {
    expect(resolveShotKindLabel({ visualType: 'Statistics' })).toBe('STAT');
  });

  it('B-Roll maps to B-ROLL', () => {
    expect(resolveShotKindLabel({ visualType: 'B-Roll' })).toBe('B-ROLL');
  });

  it('blank maps to BLANK', () => {
    expect(resolveShotKindLabel({ visualType: 'blank' })).toBe('BLANK');
  });

  it('Animation maps to ANIM (default fallback)', () => {
    expect(resolveShotKindLabel({ visualType: 'Animation' })).toBe('ANIM');
  });

  it('unknown / undefined visual_type falls through to ANIM', () => {
    expect(resolveShotKindLabel({})).toBe('ANIM');
    expect(resolveShotKindLabel({ visualType: 'something-new' })).toBe('ANIM');
  });

  it('shotKind static / hard_cut still defer to visualType', () => {
    expect(resolveShotKindLabel({ shotKind: 'static', visualType: 'Title Card' })).toBe('TITLE');
    expect(resolveShotKindLabel({ shotKind: 'hard_cut', visualType: 'B-Roll' })).toBe('B-ROLL');
  });
});

describe('ShotKindBadge — visual contract', () => {
  it('renders the resolved label with role-appropriate background color', () => {
    const html = renderToStaticMarkup(
      <ShotKindBadge shotKind="motion_collage" visualType="Animation" />,
    );
    expect(html).toContain('COLLAGE');
    // purple-ish background — fingerprint via the rgba color from KIND_COLORS.
    expect(html).toContain('168, 85, 247');
  });

  it('pins top-left by default', () => {
    const html = renderToStaticMarkup(
      <ShotKindBadge visualType="Title Card" />,
    );
    expect(html).toContain('position:absolute');
    expect(html).toContain('top:2');
    expect(html).toContain('left:2');
  });

  it('inline mode (pinTopLeft=false) skips absolute positioning', () => {
    const html = renderToStaticMarkup(
      <ShotKindBadge visualType="Title Card" pinTopLeft={false} />,
    );
    expect(html).not.toContain('position:absolute');
    expect(html).toContain('display:inline-block');
  });

  it('exposes the kind via title + aria-label so hover + screen-readers both surface it', () => {
    const html = renderToStaticMarkup(
      <ShotKindBadge visualType="B-Roll" />,
    );
    expect(html).toContain('title="Shot kind: B-ROLL"');
    expect(html).toContain('aria-label="Shot kind: B-ROLL"');
  });
});

describe('TitleCardThumb — typography preview', () => {
  it('renders the title text', () => {
    const html = renderToStaticMarkup(
      <TitleCardThumb title="Level 1: Brute Force Dictionary Attacks" />,
    );
    expect(html).toContain('Level 1: Brute Force Dictionary Attacks');
  });

  it('renders a placeholder when title is empty', () => {
    const html = renderToStaticMarkup(<TitleCardThumb title="" />);
    expect(html).toContain('Title card');
  });

  it('uses absolute positioning when fillParent is true', () => {
    const html = renderToStaticMarkup(
      <TitleCardThumb title="Hi" fillParent />,
    );
    expect(html).toContain('position:absolute');
    expect(html).toContain('inset:0');
  });

  it('has accessibility label including the title', () => {
    const html = renderToStaticMarkup(
      <TitleCardThumb title="Chapter 1" />,
    );
    expect(html).toContain('aria-label="Title card: Chapter 1"');
  });
});
