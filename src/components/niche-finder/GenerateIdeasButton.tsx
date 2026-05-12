'use client';

/**
 * Flywheel hook (Phase 13.2.F): navigate to the existing /ideas
 * generator with the niche pre-filled. We also stash a short
 * "reference context" string in sessionStorage that lists the top
 * cluster centroids — the ideas page picks it up via the same
 * channel so the model has a richer input than just the niche name.
 *
 * No new state stored server-side. No new AI calls. Just a routed
 * pre-fill into a feature that already exists.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { PersistedCluster } from '@/lib/niche-finder/db';

interface GenerateIdeasButtonProps {
  nicheName: string;
  clusters: readonly PersistedCluster[];
}

export const NICHE_PREFILL_STORAGE_KEY = 'niche-finder:ideas-prefill';

export interface NichePrefill {
  niche: string;
  clusters: { centroidTerm: string; topVideoTitles: string[] }[];
  /** When this prefill was written; the ideas page expires anything
   *  older than 10 minutes so old prefills don't haunt later
   *  sessions. */
  capturedAt: string;
}

export function GenerateIdeasButton({ nicheName, clusters }: GenerateIdeasButtonProps): React.ReactElement {
  const router = useRouter();

  const onClick = useCallback(() => {
    const prefill: NichePrefill = {
      niche: nicheName,
      clusters: clusters.slice(0, 3).map((c) => ({
        centroidTerm: c.centroidTerm,
        topVideoTitles: c.topVideos.slice(0, 5).map((v) => v.title),
      })),
      capturedAt: new Date().toISOString(),
    };
    try {
      sessionStorage.setItem(NICHE_PREFILL_STORAGE_KEY, JSON.stringify(prefill));
    } catch {
      // Storage quota / private-mode failure — the ideas page will
      // still receive `niche` via the query string.
    }
    router.push(`/ideas?niche=${encodeURIComponent(nicheName)}&from=niche-finder`);
  }, [clusters, nicheName, router]);

  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 14px',
        background: 'transparent',
        color: '#cbd5e1',
        border: '1px solid #a78bfa',
        borderRadius: 8,
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      Generate ideas →
    </button>
  );
}
