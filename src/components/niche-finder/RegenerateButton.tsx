'use client';

/**
 * Force-regenerate the deep-dive report. POSTs with `force: true`
 * which bypasses the niche_reports cache and re-runs the entire
 * pipeline (suggest → cluster → fetch → score → synthesize → upsert).
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

interface RegenerateButtonProps {
  nicheText: string;
}

export function RegenerateButton({ nicheText }: RegenerateButtonProps): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/niche-finder/deep-dive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nicheText, force: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Regenerate failed: ${(body as { error?: string }).error ?? res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, nicheText, router]);

  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        padding: '8px 14px',
        background: busy ? '#1e293b' : 'transparent',
        color: busy ? '#64748b' : '#94a3b8',
        border: '1px solid #334155',
        borderRadius: 8,
        fontSize: 13,
        cursor: busy ? 'not-allowed' : 'pointer',
      }}
    >
      {busy ? 'Re-running…' : 'Regenerate'}
    </button>
  );
}
