'use client';

/**
 * Thin client wrapper around <TimelineEditor /> for the
 * /timeline-editor demo page. Owns the doc state so the SSR'd
 * server component doesn't have to.
 */

import { useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import { TimelineEditor } from './TimelineEditor';

export function TimelineEditorDemo({ initialDoc }: { initialDoc: ProductionDoc }) {
  const [doc, setDoc] = useState<ProductionDoc>(initialDoc);
  return <TimelineEditor doc={doc} onDocChange={setDoc} />;
}
