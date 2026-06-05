'use client';

/**
 * Thin client wrapper around <TimelineEditor /> for the
 * /timeline-editor demo page. Owns the doc state via the
 * useDocHistory hook so undo/redo work without the SSR'd server
 * component having to know about React state.
 *
 * We dynamic-import TimelineEditor here (rather than at the page
 * level) because Next.js 16 forbids `dynamic(..., { ssr: false })`
 * in Server Components. The underlying timeline library uses DOM
 * at module-eval time, so ssr:false is genuinely needed.
 */

import dynamic from 'next/dynamic';
import type { ProductionDoc } from '@/remotion/utils';
import { useDocHistory } from '@/lib/timeline-editor/use-doc-history';

const TimelineEditor = dynamic(
  () => import('./TimelineEditor').then((m) => m.TimelineEditor),
  {
    ssr: false,
    loading: () => <p className="text-xs text-neutral-500">Loading timeline…</p>,
  },
);

export function TimelineEditorDemo({ initialDoc }: { initialDoc: ProductionDoc }) {
  const history = useDocHistory<ProductionDoc>(initialDoc);
  return (
    <TimelineEditor
      doc={history.current}
      onDocChange={history.setDoc}
      onUndo={history.undo}
      onRedo={history.redo}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
    />
  );
}
