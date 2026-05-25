'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';

/**
 * Tracks when the editor last wrote a change to the doc, so the UI
 * can surface a "Saved Xs ago" indicator. We treat every doc-reference
 * change as a save — the page's `updateRow` fires `setDoc` + a
 * fire-and-forget PATCH to `/api/history/[id]`. We don't track the
 * network response yet; that's a Phase 4 polish item (per-field error
 * state, retry button, etc.).
 *
 * The label re-computes every 15s so "Just now" eventually rolls over
 * to "1 min ago" even when the user is idle.
 */

function relative(now: number, then: number): string {
  const diff = Math.max(0, Math.floor((now - then) / 1000));
  if (diff < 5) return 'Saved just now';
  if (diff < 60) return `Saved ${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `Saved ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Saved ${h} hr ago`;
  return `Saved ${Math.floor(h / 24)} d ago`;
}

export function useSaveIndicator(doc: ProductionDoc) {
  // On mount the doc was just hydrated, not saved by the user. Use a
  // sentinel so the label stays empty until the user actually edits.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const initialDocRef = useRef(doc);
  // `tick` increments on a 15s timer so the relative label refreshes.
  const [, setTick] = useState(0);

  useEffect(() => {
    // Skip the very first doc identity (mount-time hydration). After
    // that, every new reference is treated as a user edit through one
    // of the writers.
    if (doc === initialDocRef.current) return;
    setSavedAt(Date.now());
  }, [doc]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  if (savedAt == null) return { label: '', savedAt: null };
  return { label: relative(Date.now(), savedAt), savedAt };
}
