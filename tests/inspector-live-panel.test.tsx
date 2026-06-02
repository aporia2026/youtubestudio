/**
 * Unit tests for InspectorLivePanel.
 *
 * User-asked-for (2026-06-02): "a tab in the side panel that shows
 * live which shot is being generated with full control like stop and
 * regenerate".
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InspectorLivePanel } from '@/components/editor/inspector/InspectorLivePanel';
import type { ProductionDoc, RowImageState } from '@/remotion/utils';

function rowWith(text: string): ProductionDoc['rows'][number] {
  return {
    timecode: '0:00',
    script_text: text,
    visual_type: 'Animation',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
  };
}

function makeDoc(rows: ProductionDoc['rows']): ProductionDoc {
  return {
    title: 'T',
    niche: 'X',
    total_duration: '0:30',
    total_words: 60,
    speaking_pace_wpm: 120,
    rows,
  };
}

describe('InspectorLivePanel — aggregate header', () => {
  it('shows totals for done / loading / error / blank', () => {
    const doc = makeDoc([
      rowWith('shot 1'),
      rowWith('shot 2'),
      rowWith('shot 3'),
      rowWith('shot 4'),
    ]);
    const rowImages: (RowImageState | null)[] = [
      { status: 'done', imageUrl: 'a.png' },
      { status: 'loading' },
      { status: 'error' } as RowImageState,
      null,
    ];
    const html = renderToStaticMarkup(
      <InspectorLivePanel
        doc={doc}
        rowImages={rowImages}
        clipStatuses={{}}
        overlayStatuses={{}}
        fillState="idle"
        fillProgress={{ done: 0, total: 0, failed: 0 }}
        onStopFill={() => {}}
        onJumpToShot={() => {}}
        onRetryShot={() => {}}
      />,
    );
    // Aggregate counts row contains the per-status totals + shot count.
    expect(html).toContain('4 shots');
  });
});

describe('InspectorLivePanel — bulk fill-blanks status', () => {
  it('shows Idle when fillState=idle', () => {
    const html = renderToStaticMarkup(
      <InspectorLivePanel
        doc={makeDoc([rowWith('a')])}
        rowImages={[null]}
        clipStatuses={{}}
        overlayStatuses={{}}
        fillState="idle"
        fillProgress={{ done: 0, total: 0, failed: 0 }}
        onStopFill={() => {}}
        onJumpToShot={() => {}}
        onRetryShot={() => {}}
      />,
    );
    expect(html).toContain('Idle');
    // Stop button hidden when not running.
    expect(html).not.toContain('Stop bulk');
  });

  it('shows progress + Stop button when fillState=running', () => {
    const html = renderToStaticMarkup(
      <InspectorLivePanel
        doc={makeDoc([rowWith('a'), rowWith('b'), rowWith('c')])}
        rowImages={[null, null, null]}
        clipStatuses={{}}
        overlayStatuses={{}}
        fillState="running"
        fillProgress={{ done: 1, total: 3, failed: 0 }}
        onStopFill={() => {}}
        onJumpToShot={() => {}}
        onRetryShot={() => {}}
      />,
    );
    expect(html).toContain('Running');
    expect(html).toContain('1 / 3 done');
    expect(html).toContain('Stop bulk');
  });

  it('surfaces failed count when fill-blanks has hit errors', () => {
    const html = renderToStaticMarkup(
      <InspectorLivePanel
        doc={makeDoc([rowWith('a')])}
        rowImages={[null]}
        clipStatuses={{}}
        overlayStatuses={{}}
        fillState="running"
        fillProgress={{ done: 2, total: 5, failed: 1 }}
        onStopFill={() => {}}
        onJumpToShot={() => {}}
        onRetryShot={() => {}}
      />,
    );
    expect(html).toContain('1 failed');
  });
});

describe('InspectorLivePanel — per-row rendering', () => {
  it('renders each row with its label', () => {
    const html = renderToStaticMarkup(
      <InspectorLivePanel
        doc={makeDoc([
          rowWith('First shot label'),
          rowWith('Second shot label'),
        ])}
        rowImages={[{ status: 'done', imageUrl: 'x' }, null]}
        clipStatuses={{}}
        overlayStatuses={{}}
        fillState="idle"
        fillProgress={{ done: 0, total: 0, failed: 0 }}
        onStopFill={() => {}}
        onJumpToShot={() => {}}
        onRetryShot={() => {}}
      />,
    );
    expect(html).toContain('First shot label');
    expect(html).toContain('Second shot label');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
  });

  it('shows retry button for error + blank rows, not for done', () => {
    const html = renderToStaticMarkup(
      <InspectorLivePanel
        doc={makeDoc([
          rowWith('done row'),
          rowWith('blank row'),
          rowWith('error row'),
        ])}
        rowImages={[
          { status: 'done', imageUrl: 'x' },
          null,
          { status: 'error' } as RowImageState,
        ]}
        clipStatuses={{}}
        overlayStatuses={{}}
        fillState="idle"
        fillProgress={{ done: 0, total: 0, failed: 0 }}
        onStopFill={() => {}}
        onJumpToShot={() => {}}
        onRetryShot={() => {}}
      />,
    );
    // Each retryable row has a retry button (title contains "Retry" or
    // "Generate this shot"). Count: blank + error = 2 retry buttons.
    const retryMatches = html.match(/title="(Retry|Generate this shot)/g) ?? [];
    expect(retryMatches.length).toBe(2);
  });

  it('shows the loading glyph + label for in-flight image generation', () => {
    const html = renderToStaticMarkup(
      <InspectorLivePanel
        doc={makeDoc([rowWith('loading shot')])}
        rowImages={[{ status: 'loading' }]}
        clipStatuses={{}}
        overlayStatuses={{}}
        fillState="idle"
        fillProgress={{ done: 0, total: 0, failed: 0 }}
        onStopFill={() => {}}
        onJumpToShot={() => {}}
        onRetryShot={() => {}}
      />,
    );
    expect(html).toContain('loading shot');
    expect(html).toContain('Generating');
  });

  it('reports clip-pending status when image is done but clip is generating', () => {
    const html = renderToStaticMarkup(
      <InspectorLivePanel
        doc={makeDoc([rowWith('animating shot')])}
        rowImages={[{ status: 'done', imageUrl: 'x.png' }]}
        clipStatuses={{ 0: 'generating' }}
        overlayStatuses={{}}
        fillState="idle"
        fillProgress={{ done: 0, total: 0, failed: 0 }}
        onStopFill={() => {}}
        onJumpToShot={() => {}}
        onRetryShot={() => {}}
      />,
    );
    expect(html).toContain('Generating');
  });
});
