/**
 * InspectorTabBar — six-tab header for the contextual right inspector
 * in Studio Mode. Phase R3 PR1 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Tests pin the tab inventory, the ARIA tablist contract, and the
 * current-tab signalling. R3 PR2 will wire `onSelect` to a real state
 * setter — these tests already cover the on/off behaviour of the
 * callback so PR2 plumbing lands without surprises.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  InspectorTabBar,
  INSPECTOR_TABS,
  type InspectorTabId,
} from '@/components/production-doc/redesign/InspectorTabBar';

describe('INSPECTOR_TABS — inventory contract', () => {
  it('exposes the six documented tab ids in the documented order', () => {
    expect(INSPECTOR_TABS.map((t) => t.id)).toEqual([
      'content',
      'image',
      'video',
      'overlay',
      'section',
      'variants',
    ]);
  });

  it('every tab has a non-empty human label', () => {
    for (const tab of INSPECTOR_TABS) {
      expect(tab.label.trim()).toBeTruthy();
    }
  });
});

describe('InspectorTabBar — rendering', () => {
  it('renders one button per documented tab', () => {
    const html = renderToStaticMarkup(<InspectorTabBar current="content" />);
    for (const tab of INSPECTOR_TABS) {
      expect(html).toContain(tab.label);
    }
  });

  it('wires the tablist landmark with an accessible name', () => {
    const html = renderToStaticMarkup(<InspectorTabBar current="content" />);
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Row inspector tabs"/);
  });

  it('every tab declares role="tab" and the aria-controls panel id', () => {
    const html = renderToStaticMarkup(<InspectorTabBar current="content" />);
    for (const tab of INSPECTOR_TABS) {
      const re = new RegExp(
        `role="tab"[^>]*aria-controls="inspector-panel-${tab.id}"`,
      );
      expect(html, `missing role=tab for ${tab.id}`).toMatch(re);
    }
  });
});

describe('InspectorTabBar — current-tab signalling', () => {
  it('marks the current tab with aria-selected="true" and the others with false', () => {
    const current: InspectorTabId = 'overlay';
    const html = renderToStaticMarkup(<InspectorTabBar current={current} />);
    for (const tab of INSPECTOR_TABS) {
      const expected = tab.id === current ? 'true' : 'false';
      const re = new RegExp(
        `id="inspector-tab-${tab.id}"[^>]*aria-selected="${expected}"|aria-selected="${expected}"[^>]*id="inspector-tab-${tab.id}"`,
      );
      expect(html, `aria-selected mismatch for ${tab.id}`).toMatch(re);
    }
  });

  it('current tab is keyboard-focusable (tabindex=0); others are not (tabindex=-1)', () => {
    // React serializes camelCase `tabIndex` as lowercase `tabindex` in HTML.
    const html = renderToStaticMarkup(<InspectorTabBar current="section" />);
    expect(html).toMatch(
      /id="inspector-tab-section"[^>]*tabindex="0"|tabindex="0"[^>]*id="inspector-tab-section"/,
    );
    expect(html).toMatch(
      /id="inspector-tab-content"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="inspector-tab-content"/,
    );
  });
});

describe('InspectorTabBar — onSelect plumbing (R3 PR2 contract)', () => {
  it('disables every button when onSelect is omitted (R3 PR1)', () => {
    const html = renderToStaticMarkup(<InspectorTabBar current="content" />);
    // Six tabs, each must carry disabled.
    const disabledCount = (html.match(/<button[^>]*\bdisabled\b/g) ?? []).length;
    expect(disabledCount).toBe(INSPECTOR_TABS.length);
  });

  it('enables every button when onSelect is provided', () => {
    const html = renderToStaticMarkup(
      <InspectorTabBar current="content" onSelect={() => {}} />,
    );
    expect(html).not.toMatch(/<button[^>]*\bdisabled\b/);
  });

  it('does not fire onSelect during SSR render (no synthetic clicks)', () => {
    const onSelect = vi.fn();
    renderToStaticMarkup(<InspectorTabBar current="content" onSelect={onSelect} />);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
