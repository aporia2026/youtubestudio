/**
 * BriefHeader — the top chrome of Brief Mode. See
 * `_plans/2026-06-04-production-doc-redesign.md` §4.1.
 *
 * Phase R1 ships this header above the legacy input panel when the
 * flag is on. These tests pin the rendered shape so a typo in the
 * title or a missed button doesn't slip through.
 *
 * Click behavior of the New session button is verified at the
 * integration level (the shell test confirms `onNewSession` reaches
 * the button), because the project's test environment is `node` SSR
 * which cannot dispatch real DOM events.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefHeader } from '@/components/production-doc/redesign/BriefHeader';

describe('BriefHeader — content', () => {
  it('renders the title "Production Doc"', () => {
    const html = renderToStaticMarkup(<BriefHeader />);
    expect(html).toContain('Production Doc');
  });

  it('renders the subtitle copy verbatim (no em dashes per rule 5)', () => {
    const html = renderToStaticMarkup(<BriefHeader />);
    expect(html).toContain('Plan, write, and produce a video end to end.');
    // Anti-AI-tell pass: no em dash, no smart quotes in this header.
    expect(html).not.toContain('—');
    expect(html).not.toContain('‘');
    expect(html).not.toContain('’');
    expect(html).not.toContain('“');
    expect(html).not.toContain('”');
  });

  it('uses an h1 for the title (single-page hierarchy)', () => {
    const html = renderToStaticMarkup(<BriefHeader />);
    expect(html).toMatch(/<h1[^>]*>\s*Production Doc\s*<\/h1>/);
  });
});

describe('BriefHeader — New session button', () => {
  it('renders the button when onNewSession is provided', () => {
    const html = renderToStaticMarkup(<BriefHeader onNewSession={() => {}} />);
    expect(html).toContain('New session');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>\s*New session\s*<\/button>/);
  });

  it('hides the button when onNewSession is undefined', () => {
    const html = renderToStaticMarkup(<BriefHeader />);
    expect(html).not.toContain('New session');
  });

  it('omits the no-op History and shortcuts buttons (R1 ships only working controls)', () => {
    // The §4.1 mock includes History and ⌘? buttons, but their
    // backing drawers don't exist until R2/R5. Per rule 10 we don't
    // ship dead buttons that confuse the lazy user. When the drawers
    // land, update this assertion deliberately and add the buttons.
    const html = renderToStaticMarkup(<BriefHeader onNewSession={() => {}} />);
    expect(html).not.toContain('History');
    expect(html).not.toContain('Shortcuts');
  });
});
