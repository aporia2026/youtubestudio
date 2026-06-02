/**
 * Unit tests for <InspectorTextBlocksPanel>.
 *
 * PR 5 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 *
 * The panel is a thin presentation layer over `row.on_screen_text_blocks`
 * — every mutation dispatches through `onUpdateRow`. Tests verify:
 *   - Empty state renders the help text + "+ Add block".
 *   - Each block renders text, anchor grid, variant picker, sliders, delete.
 *   - "Add block" button is disabled at the cap.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InspectorTextBlocksPanel } from '@/components/editor/inspector/InspectorTextBlocksPanel';
import { ON_SCREEN_TEXT_BLOCK_LIMITS, type OnScreenTextBlock, type ProductionDoc } from '@/remotion/utils';

function makeRow(blocks?: OnScreenTextBlock[]): ProductionDoc['rows'][number] {
  return {
    timecode: '0:00',
    script_text: '',
    visual_type: 'B-Roll',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    on_screen_text_blocks: blocks,
  };
}

function makeDoc(stylePreset?: string): ProductionDoc {
  return {
    title: 'T',
    niche: 'X',
    total_duration: '0:30',
    total_words: 60,
    speaking_pace_wpm: 120,
    rows: [],
    style_preset: stylePreset,
  };
}

describe('InspectorTextBlocksPanel — empty state', () => {
  it('renders the help text and an enabled Add button when zero blocks', () => {
    const html = renderToStaticMarkup(
      <InspectorTextBlocksPanel
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc()}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('No text blocks yet');
    expect(html).toContain('+ Add block');
    // Button NOT disabled when under cap
    expect(html).not.toContain('not-allowed');
  });

  it('does not show a block-count chip when zero blocks', () => {
    const html = renderToStaticMarkup(
      <InspectorTextBlocksPanel
        row={makeRow()}
        shotIndex={0}
        doc={makeDoc()}
        onUpdateRow={() => {}}
      />,
    );
    // The block-count chip "· N" follows the "Text blocks" header.
    // Empty state should NOT show it.
    expect(html).toMatch(/Text blocks[^·]*<\/span>/);
  });
});

describe('InspectorTextBlocksPanel — with blocks', () => {
  it('renders the count chip + every block', () => {
    const blocks: OnScreenTextBlock[] = [
      { id: 'a', text: 'First block', x_pct: 10, y_pct: 20, scale: 1 },
      { id: 'b', text: 'Second block', x_pct: 50, y_pct: 50, scale: 1.5, variant: 'doodle-yellow' },
    ];
    const html = renderToStaticMarkup(
      <InspectorTextBlocksPanel
        row={makeRow(blocks)}
        shotIndex={0}
        doc={makeDoc()}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('· 2');
    expect(html).toContain('First block');
    expect(html).toContain('Second block');
    expect(html).toContain('Block 1');
    expect(html).toContain('Block 2');
  });

  it('shows scale + rotation values on each block', () => {
    const blocks: OnScreenTextBlock[] = [
      { id: 'a', text: 'hi', x_pct: 50, y_pct: 50, scale: 2.5, rotation_deg: 30 },
    ];
    const html = renderToStaticMarkup(
      <InspectorTextBlocksPanel
        row={makeRow(blocks)}
        shotIndex={0}
        doc={makeDoc()}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('2.5×');
    expect(html).toContain('30°');
  });

  it('shows the variant picker with the active variant highlighted', () => {
    const blocks: OnScreenTextBlock[] = [
      { id: 'a', text: 'hi', x_pct: 50, y_pct: 50, scale: 1, variant: 'doodle-yellow' },
    ];
    const html = renderToStaticMarkup(
      <InspectorTextBlocksPanel
        row={makeRow(blocks)}
        shotIndex={0}
        doc={makeDoc()}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('Yellow');
    expect(html).toContain('Default');
  });

  it('renders all 9 anchor preset cells', () => {
    const blocks: OnScreenTextBlock[] = [
      { id: 'a', text: 'hi', x_pct: 50, y_pct: 50, scale: 1, anchor: 'top-left' },
    ];
    const html = renderToStaticMarkup(
      <InspectorTextBlocksPanel
        row={makeRow(blocks)}
        shotIndex={0}
        doc={makeDoc()}
        onUpdateRow={() => {}}
      />,
    );
    // 9 anchor buttons, each with aria-label
    for (const anchor of [
      'top-left', 'top-center', 'top-right',
      'center-left', 'center', 'center-right',
      'bottom-left', 'bottom-center', 'bottom-right',
    ]) {
      expect(html).toContain(`Anchor to ${anchor}`);
    }
  });

  it('renders the delete button per block', () => {
    const blocks: OnScreenTextBlock[] = [
      { id: 'a', text: 'hi', x_pct: 50, y_pct: 50, scale: 1 },
      { id: 'b', text: 'bye', x_pct: 50, y_pct: 50, scale: 1 },
    ];
    const html = renderToStaticMarkup(
      <InspectorTextBlocksPanel
        row={makeRow(blocks)}
        shotIndex={0}
        doc={makeDoc()}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('Delete text block 1');
    expect(html).toContain('Delete text block 2');
  });
});

describe('InspectorTextBlocksPanel — block cap', () => {
  it('disables the Add button at the cap', () => {
    const blocks = Array.from(
      { length: ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot },
      (_, i): OnScreenTextBlock => ({ id: `b${i}`, text: 't', x_pct: 50, y_pct: 50, scale: 1 }),
    );
    const html = renderToStaticMarkup(
      <InspectorTextBlocksPanel
        row={makeRow(blocks)}
        shotIndex={0}
        doc={makeDoc()}
        onUpdateRow={() => {}}
      />,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('cap');
  });
});
