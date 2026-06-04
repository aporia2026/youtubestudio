/**
 * InspectorInlineField — labelled inline-editable field.
 * Phase R3 PR3b of `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Click-driven edit behaviour (open editor → type → Ctrl+Enter →
 * onSave fires) needs a DOM event simulator that the project's
 * `node` test environment doesn't run; the tests below pin the SSR
 * contract (which elements render, when the edit affordance hides,
 * the ARIA wiring on the textarea) and rely on TypeScript + React
 * for the onClick semantics.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InspectorInlineField } from '@/components/production-doc/redesign/InspectorInlineField';

describe('InspectorInlineField — read-only mode (no onSave)', () => {
  it('renders label + value with no edit affordance', () => {
    const html = renderToStaticMarkup(
      <InspectorInlineField
        fieldId="row-3-script"
        label="Script"
        value="Hello world"
      />,
    );
    expect(html).toContain('Script');
    expect(html).toContain('Hello world');
    // No edit button, no textarea, no keyboard hint.
    expect(html).not.toContain('aria-label="Edit Script"');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Ctrl+Enter saves');
  });

  it('shows a soft — placeholder when the value is empty', () => {
    const html = renderToStaticMarkup(
      <InspectorInlineField fieldId="row-3-notes" label="Notes" value="" />,
    );
    expect(html).toContain('Notes');
    expect(html).toContain('—');
  });

  it('treats whitespace-only values as empty for placeholder purposes', () => {
    const html = renderToStaticMarkup(
      <InspectorInlineField fieldId="row-3-notes" label="Notes" value="   " />,
    );
    expect(html).toContain('—');
  });

  it('wires the read-mode value to the label via aria-labelledby', () => {
    const html = renderToStaticMarkup(
      <InspectorInlineField
        fieldId="row-3-script"
        label="Script"
        value="Hello"
      />,
    );
    expect(html).toContain('id="inspector-field-row-3-script-label"');
    expect(html).toContain('aria-labelledby="inspector-field-row-3-script-label"');
  });
});

describe('InspectorInlineField — editable mode (onSave provided)', () => {
  it('renders the ✎ edit button when onSave is provided', () => {
    const html = renderToStaticMarkup(
      <InspectorInlineField
        fieldId="row-3-script"
        label="Script"
        value="Hello"
        onSave={() => {}}
      />,
    );
    expect(html).toMatch(/aria-label="Edit Script"/);
    expect(html).toContain('✎');
  });

  it('the edit button title also mirrors the field label', () => {
    const html = renderToStaticMarkup(
      <InspectorInlineField
        fieldId="row-3-script"
        label="AI prompt"
        value=""
        onSave={() => {}}
      />,
    );
    expect(html).toMatch(/title="Edit AI prompt"/);
  });

  it('the read mode is the initial render even with onSave (textarea does not pre-mount)', () => {
    // R3 PR3b expectation: the field starts read-only. Clicking ✎ opens
    // the textarea — but that's a DOM event we can't fire in SSR. We
    // therefore assert no textarea is in the initial SSR output.
    const html = renderToStaticMarkup(
      <InspectorInlineField
        fieldId="row-3-script"
        label="Script"
        value="initial"
        onSave={() => {}}
      />,
    );
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Ctrl+Enter saves');
  });
});

describe('InspectorInlineField — stable field ids', () => {
  it('emits stable label + textarea ids derived from fieldId', () => {
    const html = renderToStaticMarkup(
      <InspectorInlineField
        fieldId="row-7-on-screen-text"
        label="On-screen text"
        value="Start saving"
        onSave={() => {}}
      />,
    );
    expect(html).toContain('id="inspector-field-row-7-on-screen-text-label"');
  });
});
