/**
 * StudioTopBar — Studio Mode top chrome.
 * Phase R2 first PR of `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Tests pin the rendered shape so the project title, meta line, and
 * New session control all keep working through later R2 PRs that
 * expand the top bar with sub-mode toggle, Open-in-editor, Export,
 * shortcuts, and the primary Render CTA.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioTopBar } from '@/components/production-doc/redesign/StudioTopBar';
import type { ProductionDoc } from '@/remotion/utils';

const SAMPLE_DOC: ProductionDoc = {
  title: 'How compound interest works',
  niche: 'finance',
  total_duration: '6:24',
  total_words: 800,
  speaking_pace_wpm: 125,
  rows: Array.from({ length: 12 }, () => ({} as ProductionDoc['rows'][number])),
};

describe('StudioTopBar — title', () => {
  it('renders the doc title as h1', () => {
    const html = renderToStaticMarkup(<StudioTopBar doc={SAMPLE_DOC} />);
    expect(html).toMatch(/<h1[^>]*>[\s\S]*?How compound interest works/);
  });

  it('falls back to a placeholder when the doc title is empty', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar doc={{ ...SAMPLE_DOC, title: '' }} />,
    );
    expect(html).toContain('Untitled production');
  });
});

describe('StudioTopBar — meta line', () => {
  it('shows scene count, word count, and total duration', () => {
    const html = renderToStaticMarkup(<StudioTopBar doc={SAMPLE_DOC} />);
    expect(html).toContain('12 scenes');
    expect(html).toContain('800 words');
    expect(html).toContain('6:24');
  });

  it('uses singular "scene" when there is only one row', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar doc={{ ...SAMPLE_DOC, rows: [{} as ProductionDoc['rows'][number]] }} />,
    );
    expect(html).toContain('1 scene');
    expect(html).not.toContain('1 scenes');
  });

  it('omits word count when total_words is zero', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar doc={{ ...SAMPLE_DOC, total_words: 0 }} />,
    );
    expect(html).not.toContain('words');
  });

  it('omits duration when total_duration is empty', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar doc={{ ...SAMPLE_DOC, total_duration: '' }} />,
    );
    expect(html).not.toContain('6:24');
  });
});

describe('StudioTopBar — New session button', () => {
  it('renders the button when onNewSession is provided', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar doc={SAMPLE_DOC} onNewSession={() => {}} />,
    );
    expect(html).toContain('New session');
  });

  it('hides the button when onNewSession is undefined', () => {
    const html = renderToStaticMarkup(<StudioTopBar doc={SAMPLE_DOC} />);
    expect(html).not.toContain('New session');
  });
});

describe('StudioTopBar — landmark', () => {
  it('uses a header landmark with a descriptive aria-label', () => {
    const html = renderToStaticMarkup(<StudioTopBar doc={SAMPLE_DOC} />);
    expect(html).toMatch(/<header[^>]*aria-label="Studio top bar"/);
  });
});
