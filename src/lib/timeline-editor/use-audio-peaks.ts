/**
 * React hook around `decodeAudioPeaks`. Returns `{ peaks,
 * durationMs, loading, error }` for one URL. Multiple components
 * subscribing to the same URL share a single decode via the
 * module-level cache in `./audio-peaks.ts`.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md (M6 polish).
 */

import { useEffect, useState } from 'react';
import { decodeAudioPeaks, type DecodedPeaks } from './audio-peaks';

export interface UseAudioPeaksReturn {
  peaks: Float32Array | null;
  durationMs: number;
  loading: boolean;
  error: string | null;
}

export function useAudioPeaks(url: string | null | undefined): UseAudioPeaksReturn {
  const [state, setState] = useState<UseAudioPeaksReturn>({
    peaks: null,
    durationMs: 0,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!url) {
      setState({ peaks: null, durationMs: 0, loading: false, error: null });
      return;
    }
    if (typeof window === 'undefined') return; // SSR no-op
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    decodeAudioPeaks(url)
      .then((result: DecodedPeaks) => {
        if (cancelled) return;
        setState({ peaks: result.peaks, durationMs: result.durationMs, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ peaks: null, durationMs: 0, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [url]);

  return state;
}
