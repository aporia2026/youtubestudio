'use client';

import { useCallback, useState } from 'react';
import { getPref, setPref } from '@/lib/user-prefs';
import type { StudioSubMode } from './StudioTopBar';

/**
 * Shared state hook for the Studio sub-mode toggle (scene-strip vs
 * bulk-grid). Lifted out of `StudioMode` so `page.tsx` can also
 * consume the same source of truth — needed so the legacy Results
 * section can be hidden when in scene-strip sub-mode without
 * duplicating the persistence path.
 *
 * Default `'scene-strip'` per §15.2 of the redesign plan. Persisted
 * via `getPref/setPref` under `prodoc_studio_sub_mode` so the user's
 * choice survives reloads and follows them across machines.
 *
 * Observability log `[prodoc studio] sub-mode-toggle` fires on every
 * flip (preserved from R3 PR6).
 *
 * The `initial` argument is a test-only override — real callers
 * always read the persisted pref. R4 PR3.
 */
export const STUDIO_SUB_MODE_PREF_KEY = 'prodoc_studio_sub_mode';

export interface UseStudioSubModeResult {
  subMode: StudioSubMode;
  toggleSubMode: () => void;
}

export function useStudioSubMode(initial?: StudioSubMode): UseStudioSubModeResult {
  const [subMode, setSubMode] = useState<StudioSubMode>(
    () => initial ?? getPref<StudioSubMode>(STUDIO_SUB_MODE_PREF_KEY, 'scene-strip'),
  );
  const toggleSubMode = useCallback(() => {
    setSubMode((prev) => {
      const next: StudioSubMode = prev === 'scene-strip' ? 'bulk-grid' : 'scene-strip';
      setPref(STUDIO_SUB_MODE_PREF_KEY, next);
      console.info('[prodoc studio] sub-mode-toggle', { to: next });
      return next;
    });
  }, []);
  return { subMode, toggleSubMode };
}
