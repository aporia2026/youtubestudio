'use client';

/**
 * Niche finder — entry page.
 *
 * Lazy-user UX (council pass + rule 10): one input, one button. We
 * deliberately don't ask for fit / interests up-front; the operator
 * can run a niche through the scorer and see if the report is
 * useful before being asked for more data. (Phase 2 adds the
 * three-things-you'd-talk-about prompt as a discovery surface.)
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { slugifyNiche } from '@/lib/niche-finder/slug';

export default function NichesEntryPage(): React.ReactElement {
  const router = useRouter();
  const [niche, setNiche] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = niche.trim();
      if (trimmed.length === 0) {
        setError('Type a niche to look at.');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/niche-finder/deep-dive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nicheText: trimmed }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? 'Something went wrong. Try again.');
          setSubmitting(false);
          return;
        }
        // The orchestrator returns a slug we navigate to. We slugify
        // client-side to avoid an extra parse-the-body roundtrip.
        router.push(`/insights/niches/${slugifyNiche(trimmed)}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
        setSubmitting(false);
      }
    },
    [niche, router],
  );

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 24px', color: '#e2e8f0' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 4 }}>Find what to make videos about</h1>
      <p style={{ color: '#94a3b8', marginBottom: 32, lineHeight: 1.5 }}>
        Type a niche you&apos;re considering. We look at the top videos in that niche, score it on
        demand, crowdedness, money, and fit, and write a short strategy memo.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label htmlFor="niche-input" style={{ fontSize: 13, color: '#cbd5e1' }}>
          Niche to look at
        </label>
        <input
          id="niche-input"
          autoFocus
          type="text"
          value={niche}
          onChange={(e) => setNiche(e.target.value)}
          placeholder="e.g. world war 2 history, sports stats, mystery"
          maxLength={120}
          disabled={submitting}
          style={{
            padding: '12px 14px',
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 10,
            color: '#e2e8f0',
            fontSize: 16,
            outline: 'none',
          }}
        />

        {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}

        <button
          type="submit"
          disabled={submitting || niche.trim().length === 0}
          style={{
            padding: '12px 18px',
            background: submitting ? '#1e293b' : '#22c55e',
            color: submitting ? '#94a3b8' : '#0a0e16',
            border: 'none',
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 600,
            cursor: submitting ? 'not-allowed' : 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          {submitting ? 'Looking…' : 'Show me'}
        </button>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          We fetch the top 30 videos per concept cluster from YouTube and score them. Takes about
          30 seconds on the first run; cached after that.
        </div>
      </form>
    </div>
  );
}
