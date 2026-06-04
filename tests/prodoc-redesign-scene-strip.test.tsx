/**
 * SceneCard + SceneStrip — horizontal scene cards under the Studio
 * preview. Phase R4 PR1 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Click-driven selection requires real DOM events that the SSR test
 * env doesn't run; the tests pin the rendered shape (label, ARIA
 * landmarks, selection styling, button-disable contract) and rely on
 * TypeScript + React for onClick → onSelect wiring.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SceneCard } from '@/components/production-doc/redesign/SceneCard';
import { SceneStrip } from '@/components/production-doc/redesign/SceneStrip';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';

function makeRow(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '0:00',
    script_text: '',
    visual_type: 'B-Roll',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...overrides,
  } as ProductionRow;
}

function makeDoc(rows: ProductionRow[]): ProductionDoc {
  return {
    title: 'sample',
    niche: 'finance',
    total_duration: '1:00',
    total_words: 100,
    speaking_pace_wpm: 125,
    rows,
  };
}

// ─── SceneCard ────────────────────────────────────────────────────

describe('SceneCard — content', () => {
  it('renders the 1-based row number in the badge', () => {
    const html = renderToStaticMarkup(
      <SceneCard rowIndex={3} row={makeRow()} />,
    );
    // The badge displays "4" for rowIndex=3.
    expect(html).toMatch(/<span[^>]*>\s*4\s*<\/span>/);
  });

  it('renders the timecode', () => {
    const html = renderToStaticMarkup(
      <SceneCard rowIndex={0} row={makeRow({ timecode: '0:42' })} />,
    );
    expect(html).toContain('0:42');
  });

  it('truncates long script_text with an ellipsis', () => {
    const longText = 'Once Bob starts saving at 25 his money compounds for forty years and reaches…';
    const html = renderToStaticMarkup(
      <SceneCard rowIndex={0} row={makeRow({ script_text: longText.repeat(3) })} />,
    );
    expect(html).toContain('…');
  });

  it('renders the visual-type pill using the shared color token', () => {
    const html = renderToStaticMarkup(
      <SceneCard rowIndex={0} row={makeRow({ visual_type: 'B-Roll' })} />,
    );
    expect(html).toContain('B-Roll');
    // B-Roll's documented color.
    expect(html).toContain('#22d3ee');
  });

  it('shows the thumbnail when imageState is done with a URL', () => {
    const html = renderToStaticMarkup(
      <SceneCard
        rowIndex={0}
        row={makeRow()}
        imageState={{ status: 'done', imageUrl: 'https://example.com/t.png' }}
      />,
    );
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/t\.png"/);
  });

  it('shows the "no image" placeholder when imageState is missing or not done', () => {
    const html = renderToStaticMarkup(<SceneCard rowIndex={0} row={makeRow()} />);
    expect(html).toContain('no image');
    expect(html).not.toContain('<img');
  });

  it('shows the OST and overlay badges when those fields are populated', () => {
    const html = renderToStaticMarkup(
      <SceneCard
        rowIndex={0}
        row={makeRow({ on_screen_text: 'Save now', overlay_stock_terms: 'piggy bank' })}
      />,
    );
    expect(html).toMatch(/title="On-screen text"/);
    expect(html).toMatch(/title="Overlay"/);
  });

  it('hides the OST and overlay badges when those fields are blank', () => {
    const html = renderToStaticMarkup(
      <SceneCard rowIndex={0} row={makeRow()} />,
    );
    expect(html).not.toMatch(/title="On-screen text"/);
    expect(html).not.toMatch(/title="Overlay"/);
  });
});

describe('SceneCard — selection contract', () => {
  it('renders aria-pressed="true" and an accent ring when selected', () => {
    const html = renderToStaticMarkup(
      <SceneCard rowIndex={0} row={makeRow()} selected onSelect={() => {}} />,
    );
    expect(html).toMatch(/aria-pressed="true"/);
    // Selected state uses the accent purple border token.
    expect(html).toMatch(/var\(--accent-purple-bright/);
  });

  it('renders aria-pressed="false" when not selected', () => {
    const html = renderToStaticMarkup(
      <SceneCard rowIndex={0} row={makeRow()} onSelect={() => {}} />,
    );
    expect(html).toMatch(/aria-pressed="false"/);
  });

  it('disables the button when no onSelect is provided (rule 10)', () => {
    const html = renderToStaticMarkup(<SceneCard rowIndex={0} row={makeRow()} />);
    expect(html).toMatch(/<button[^>]*\bdisabled\b/);
  });

  it('uses an accessible label that names the scene + timecode', () => {
    const html = renderToStaticMarkup(
      <SceneCard rowIndex={2} row={makeRow({ timecode: '0:42' })} onSelect={() => {}} />,
    );
    expect(html).toMatch(/aria-label="Scene 3 at 0:42"/);
  });
});

// ─── SceneStrip ───────────────────────────────────────────────────

describe('SceneStrip — empty state', () => {
  it('renders the "no scenes" prompt when doc.rows is empty', () => {
    const html = renderToStaticMarkup(<SceneStrip doc={makeDoc([])} />);
    expect(html).toContain('No scenes yet');
  });
});

describe('SceneStrip — populated', () => {
  it('renders one card per row + a count in the header', () => {
    const rows = [
      makeRow({ timecode: '0:00', script_text: 'first' }),
      makeRow({ timecode: '0:05', script_text: 'second' }),
      makeRow({ timecode: '0:10', script_text: 'third' }),
    ];
    const html = renderToStaticMarkup(<SceneStrip doc={makeDoc(rows)} />);
    expect(html).toContain('first');
    expect(html).toContain('second');
    expect(html).toContain('third');
    expect(html).toContain('3 scenes');
  });

  it('uses a section landmark with an aria-label of "Scene strip"', () => {
    const rows = [makeRow()];
    const html = renderToStaticMarkup(<SceneStrip doc={makeDoc(rows)} />);
    expect(html).toMatch(/<section[^>]*aria-label="Scene strip"/);
  });

  it('uses an ARIA list landmark for the card container', () => {
    const rows = [makeRow()];
    const html = renderToStaticMarkup(<SceneStrip doc={makeDoc(rows)} />);
    expect(html).toMatch(/role="list"[^>]*aria-label="Scene cards"/);
  });

  it('marks exactly one card as selected when selectedRowIndex is set', () => {
    const rows = [
      makeRow({ timecode: '0:00' }),
      makeRow({ timecode: '0:05' }),
      makeRow({ timecode: '0:10' }),
    ];
    const html = renderToStaticMarkup(
      <SceneStrip doc={makeDoc(rows)} selectedRowIndex={1} onSelectRow={() => {}} />,
    );
    const pressedCount = (html.match(/aria-pressed="true"/g) ?? []).length;
    expect(pressedCount).toBe(1);
  });

  it('forwards the matching rowImagesByIndex slice to each card', () => {
    const rows = [
      makeRow({ timecode: '0:00' }),
      makeRow({ timecode: '0:05' }),
    ];
    const html = renderToStaticMarkup(
      <SceneStrip
        doc={makeDoc(rows)}
        rowImagesByIndex={[
          { status: 'done', imageUrl: 'https://x/0.png' },
          { status: 'done', imageUrl: 'https://x/1.png' },
        ]}
      />,
    );
    expect(html).toContain('src="https://x/0.png"');
    expect(html).toContain('src="https://x/1.png"');
  });
});

describe('SceneStrip — orientation prop (R4 PR2)', () => {
  it('defaults to horizontal orientation (R4 PR1 contract)', () => {
    const html = renderToStaticMarkup(
      <SceneStrip doc={makeDoc([makeRow()])} />,
    );
    expect(html).toMatch(/data-orientation="horizontal"/);
    // Horizontal lays out with flex (not flex-col).
    expect(html).toMatch(/role="list"[^>]*class="[^"]*flex items-stretch/);
  });

  it('switches to a vertical column when orientation="vertical"', () => {
    const html = renderToStaticMarkup(
      <SceneStrip doc={makeDoc([makeRow()])} orientation="vertical" />,
    );
    // Both the SceneStrip list and the inner card carry the
    // data-orientation attribute.
    const verticalMarkers = (html.match(/data-orientation="vertical"/g) ?? []).length;
    expect(verticalMarkers).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/role="list"[^>]*class="[^"]*flex-col/);
  });
});

describe('SceneCard — vertical orientation', () => {
  it('renders the data-orientation marker for the vertical layout', () => {
    const html = renderToStaticMarkup(
      <SceneCard
        rowIndex={2}
        row={makeRow({ timecode: '0:10', script_text: 'hello world' })}
        orientation="vertical"
      />,
    );
    expect(html).toMatch(/data-orientation="vertical"/);
    expect(html).toContain('hello world');
    expect(html).toContain('0:10');
    // The 1-based index badge still renders.
    expect(html).toMatch(/<span[^>]*>\s*3\s*<\/span>/);
  });
});
