'use client';

/**
 * Niche-finder discovery hub.
 *
 * Five tabs:
 *   1. Type a niche  - v0.5 typed-input fallback (the original entry).
 *   2. Interests     - mode A (AI-proposed niches from operator interests).
 *   3. Channel       - mode B (pull a channel's clusters).
 *   4. Categories    - mode C (curated taxonomy).
 *   5. Outliers      - mode D (over-performing videos in a niche).
 *
 * State is per-tab. Switching tabs preserves the form inputs but
 * not the results (re-renders cheap from the cache on resubmit
 * within the 7-day TTL).
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { slugifyNiche } from '@/lib/niche-finder/slug';
import type { DiscoveryResultItem } from '@/lib/niche-finder/discoveries-db';
import type { OutlierVideo } from '@/lib/niche-finder/outliers';
import { DiscoveryCard } from '@/components/niche-finder/DiscoveryCard';
import { OutlierCard } from '@/components/niche-finder/OutlierCard';

type TabKey = 'type' | 'interests' | 'channel' | 'category' | 'outliers';

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'type', label: 'Type a niche', hint: 'I already know the niche I want to look at.' },
  { key: 'interests', label: 'From your interests', hint: 'Give me ideas based on what I want to talk about.' },
  { key: 'channel', label: 'From a channel', hint: 'Show me what a channel I admire is winning at.' },
  { key: 'category', label: 'Browse categories', hint: 'Browse curated, monetization-tilted niches.' },
  { key: 'outliers', label: 'Outlier videos', hint: 'What videos are over-performing in a niche right now?' },
];

interface CategoryListItem {
  slug: string;
  name: string;
  description: string;
  subNicheCount: number;
}

export default function NicheHubPage(): React.ReactElement {
  const [tab, setTab] = useState<TabKey>('type');

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto', color: '#e2e8f0' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 4 }}>Find what to make videos about</h1>
      <p style={{ color: '#94a3b8', marginBottom: 24, lineHeight: 1.5 }}>
        Five ways to find niches. Pick the one that matches what you already know about your idea.
      </p>

      <div
        role="tablist"
        style={{ display: 'flex', gap: 4, marginBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)', overflowX: 'auto' }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '10px 14px',
              border: 'none',
              borderBottom: tab === t.key ? '2px solid #22c55e' : '2px solid transparent',
              background: 'transparent',
              color: tab === t.key ? '#e2e8f0' : '#94a3b8',
              fontSize: 14,
              fontWeight: tab === t.key ? 600 : 400,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>
        {TABS.find((t) => t.key === tab)?.hint}
      </div>

      {tab === 'type' && <TypeNicheTab />}
      {tab === 'interests' && <InterestsTab />}
      {tab === 'channel' && <ChannelTab />}
      {tab === 'category' && <CategoryTab />}
      {tab === 'outliers' && <OutliersTab />}
    </div>
  );
}

// ─── Tab: type a niche ──────────────────────────────────────────────────────

function TypeNicheTab(): React.ReactElement {
  const router = useRouter();
  const [niche, setNiche] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
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
          setError((body as { error?: string }).error ?? 'Something went wrong.');
          setSubmitting(false);
          return;
        }
        router.push(`/insights/niches/${slugifyNiche(trimmed)}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
        setSubmitting(false);
      }
    },
    [niche, router],
  );

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 600 }}>
      <input
        autoFocus
        value={niche}
        onChange={(e) => setNiche(e.target.value)}
        placeholder="e.g. ww2 tank documentaries, nba stats deep dive"
        maxLength={120}
        disabled={submitting}
        style={inputStyle}
      />
      {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}
      <button type="submit" disabled={submitting || niche.trim().length === 0} style={primaryBtn(submitting)}>
        {submitting ? 'Looking…' : 'Show me'}
      </button>
    </form>
  );
}

// ─── Tab: interests ─────────────────────────────────────────────────────────

function InterestsTab(): React.ReactElement {
  const [interests, setInterests] = useState(['', '', '']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DiscoveryResultItem[] | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const cleaned = interests.map((i) => i.trim()).filter((i) => i.length > 0);
      if (cleaned.length === 0) {
        setError('At least one interest is required.');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/niche-finder/discover/from-interests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ interests: cleaned }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError((body as { error?: string }).error ?? 'Something went wrong.');
          return;
        }
        type Resp = { discovery: { results: DiscoveryResultItem[] }; candidatesOk: boolean };
        const data = body as Resp;
        if (!data.candidatesOk || data.discovery.results.length === 0) {
          setError('No niches surfaced. Try different interests.');
          setResults([]);
          return;
        }
        setResults(data.discovery.results);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setSubmitting(false);
      }
    },
    [interests],
  );

  return (
    <div>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 600 }}>
        <div style={{ fontSize: 13, color: '#cbd5e1' }}>Tell me three things you&apos;d enjoy talking about:</div>
        {interests.map((v, i) => (
          <input
            key={i}
            value={v}
            onChange={(e) => {
              const next = interests.slice();
              next[i] = e.target.value;
              setInterests(next);
            }}
            placeholder={
              i === 0 ? 'e.g. ancient civilisations' : i === 1 ? 'e.g. military strategy' : 'e.g. unsolved mysteries'
            }
            maxLength={80}
            disabled={submitting}
            style={inputStyle}
          />
        ))}
        {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={submitting} style={primaryBtn(submitting)}>
          {submitting ? 'Generating niches…' : 'Find niches for me'}
        </button>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          Takes about 45 seconds: we propose 8 niches from your interests and score each against real YouTube data.
        </div>
      </form>
      {results && <ResultsGrid results={results} />}
    </div>
  );
}

// ─── Tab: channel ───────────────────────────────────────────────────────────

function ChannelTab(): React.ReactElement {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DiscoveryResultItem[] | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = url.trim();
      if (trimmed.length === 0) {
        setError('Paste a YouTube channel URL.');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/niche-finder/discover/from-channel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelUrl: trimmed }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError((body as { error?: string }).error ?? 'Something went wrong.');
          return;
        }
        type Resp = { discovery: { results: DiscoveryResultItem[] }; fetchOk: boolean };
        const data = body as Resp;
        if (!data.fetchOk) {
          setError("Couldn't fetch this channel. Check the URL or try the @handle form.");
          setResults([]);
          return;
        }
        if (data.discovery.results.length === 0) {
          setError("Channel found but we couldn't cluster its uploads. Try another channel.");
          setResults([]);
          return;
        }
        setResults(data.discovery.results);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setSubmitting(false);
      }
    },
    [url],
  );

  return (
    <div>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 700 }}>
        <div style={{ fontSize: 13, color: '#cbd5e1' }}>
          Paste a channel URL (e.g. <code style={codeStyle}>youtube.com/@kurzgesagt</code>):
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://youtube.com/@channel-name"
          maxLength={300}
          disabled={submitting}
          style={inputStyle}
        />
        {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={submitting} style={primaryBtn(submitting)}>
          {submitting ? 'Looking at the channel…' : 'Show me what they win at'}
        </button>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          We fetch the channel&apos;s 50 most recent uploads and cluster them by topic. About 15 seconds.
        </div>
      </form>
      {results && <ResultsGrid results={results} />}
    </div>
  );
}

// ─── Tab: category ──────────────────────────────────────────────────────────

function CategoryTab(): React.ReactElement {
  const [categories, setCategories] = useState<CategoryListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DiscoveryResultItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/niche-finder/discover/from-category');
        const body = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setCategories((body as { categories: CategoryListItem[] }).categories);
        }
      } catch {
        // The page still works without the category list — UI just
        // shows the error state below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onPick = useCallback(async (slug: string) => {
    setSelected(slug);
    setSubmitting(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch('/api/niche-finder/discover/from-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categorySlug: slug }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? 'Something went wrong.');
        return;
      }
      type Resp = { discovery: { results: DiscoveryResultItem[] } };
      setResults((body as Resp).discovery.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }, []);

  if (!categories) {
    return <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading categories…</div>;
  }
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginBottom: 24 }}>
        {categories.map((c) => (
          <button
            key={c.slug}
            onClick={() => onPick(c.slug)}
            disabled={submitting}
            style={{
              textAlign: 'left',
              padding: 14,
              border: selected === c.slug ? '1px solid #22c55e' : '1px solid rgba(255,255,255,0.08)',
              background: selected === c.slug ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.02)',
              borderRadius: 10,
              color: '#e2e8f0',
              cursor: submitting ? 'wait' : 'pointer',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{c.name}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>{c.description}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>{c.subNicheCount} sub-niches</div>
          </button>
        ))}
      </div>
      {submitting && <div style={{ color: '#94a3b8', fontSize: 13 }}>Scoring sub-niches…</div>}
      {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}
      {results && <ResultsGrid results={results} />}
    </div>
  );
}

// ─── Tab: outliers ──────────────────────────────────────────────────────────

function OutliersTab(): React.ReactElement {
  const [niche, setNiche] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videos, setVideos] = useState<OutlierVideo[] | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = niche.trim();
      if (trimmed.length === 0) {
        setError('Type a niche to scan for outliers.');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/niche-finder/outliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ niche: trimmed }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError((body as { error?: string }).error ?? 'Something went wrong.');
          return;
        }
        type Resp = { videos: OutlierVideo[]; fetchOk: boolean };
        const data = body as Resp;
        if (!data.fetchOk) {
          setError('No videos returned for that niche. Try a different search.');
          setVideos([]);
          return;
        }
        setVideos(data.videos);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setSubmitting(false);
      }
    },
    [niche],
  );

  return (
    <div>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 600 }}>
        <input
          autoFocus
          value={niche}
          onChange={(e) => setNiche(e.target.value)}
          placeholder="e.g. world war 2 documentary, nba stats"
          maxLength={120}
          disabled={submitting}
          style={inputStyle}
        />
        {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={submitting} style={primaryBtn(submitting)}>
          {submitting ? 'Scanning…' : 'Find outliers'}
        </button>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          Shows videos that punch above their channel size (views ÷ subscribers). The bigger the number, the bigger the
          outlier.
        </div>
      </form>
      {videos && (
        <div style={{ marginTop: 24, display: 'grid', gap: 10 }}>
          {videos.map((v) => (
            <OutlierCard key={v.videoId} video={v} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function ResultsGrid({ results }: { results: DiscoveryResultItem[] }): React.ReactElement {
  if (results.length === 0) {
    return <div style={{ marginTop: 24, color: '#94a3b8', fontSize: 13 }}>No niches surfaced.</div>;
  }
  return (
    <div
      style={{
        marginTop: 24,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 12,
      }}
    >
      {results.map((r) => (
        <DiscoveryCard
          key={r.slug}
          slug={r.slug}
          name={r.name}
          rationale={r.rationale}
          scores={r.scores}
        />
      ))}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '11px 14px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 10,
  color: '#e2e8f0',
  fontSize: 15,
  outline: 'none',
};

const codeStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  padding: '1px 6px',
  borderRadius: 4,
  fontSize: 12,
};

function primaryBtn(busy: boolean): React.CSSProperties {
  return {
    padding: '11px 18px',
    background: busy ? '#1e293b' : '#22c55e',
    color: busy ? '#94a3b8' : '#0a0e16',
    border: 'none',
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: busy ? 'not-allowed' : 'pointer',
    alignSelf: 'flex-start',
  };
}
