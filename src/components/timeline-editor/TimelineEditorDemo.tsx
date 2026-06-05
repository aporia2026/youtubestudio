'use client';

/**
 * Thin client wrapper around <TimelineEditor /> for the
 * /timeline-editor demo page. Owns the doc state so the SSR'd
 * server component doesn't have to.
 *
 * We dynamic-import TimelineEditor here (rather than at the page
 * level) because Next.js 16 forbids `dynamic(..., { ssr: false })`
 * in Server Components. The underlying timeline library uses DOM
 * at module-eval time, so ssr:false is genuinely needed.
 */

import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';

const TimelineEditor = dynamic(
  () => import('./TimelineEditor').then((m) => m.TimelineEditor),
  {
    ssr: false,
    loading: () => <p className="text-xs text-neutral-500">Loading timeline…</p>,
  },
);

export function TimelineEditorDemo({ initialDoc }: { initialDoc: ProductionDoc }) {
  const [doc, setDoc] = useState<ProductionDoc>(initialDoc);
  return <TimelineEditor doc={doc} onDocChange={setDoc} />;
}
