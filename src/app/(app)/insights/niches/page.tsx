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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { slugifyNiche } from '@/lib/niche-finder/slug';
import type { DiscoveryResultItem } from '@/lib/niche-finder/discoveries-db';
import type { OutlierVideo } from '@/lib/niche-finder/outliers';
import {
  DEFAULT_FILTERS,
  filterAndSortOutliers,
  type OutlierFilters,
} from '@/lib/niche-finder/outlier-filters';
import {
  DEFAULT_FILTERS as DEFAULT_BROWSE_FILTERS,
  filterAndSortDiscoveries,
  type BrowseFilters,
} from '@/lib/niche-finder/browse-filters';
import { DiscoveryCard } from '@/components/niche-finder/DiscoveryCard';
import { OutlierCard } from '@/components/niche-finder/OutlierCard';
import { OutlierFilterBar } from '@/components/niche-finder/OutlierFilterBar';
import { OutlierPresetBar } from '@/components/niche-finder/OutlierPresetBar';
import { BrowseFilterBar } from '@/components/niche-finder/BrowseFilterBar';
import { BrowsePresetBar } from '@/components/niche-finder/BrowsePresetBar';
import { BrowseQuadrantView } from '@/components/niche-finder/BrowseQuadrantView';
import { NicheFinderModelPicker } from '@/components/niche-finder/NicheFinderModelPicker';
import { CrossCategorySearchModal } from '@/components/niche-finder/CrossCategorySearchModal';
import { FavoritesTab } from '@/components/niche-finder/FavoritesTab';
import type { NicheScores } from '@/lib/niche-finder/types';
import {
  PLACEHOLDER_NICHE_SCORES,
  type FavoriteSourceTab,
} from '@/lib/niche-finder/favorites';

type TabKey = 'type' | 'interests' | 'channel' | 'category' | 'outliers' | 'favorites';

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'type', label: 'Type a niche', hint: 'I already know the niche I want to look at.' },
  { key: 'interests', label: 'From your interests', hint: 'Give me ideas based on what I want to talk about.' },
  { key: 'channel', label: 'From a channel', hint: 'Show me what a channel I admire is winning at.' },
  { key: 'category', label: 'Browse categories', hint: 'Browse curated, monetization-tilted niches.' },
  { key: 'outliers', label: 'Outlier videos', hint: 'What videos are over-performing in a niche right now?' },
  { key: 'favorites', label: '♥ Favorites', hint: 'Niches and videos you saved — your shortlist for production.' },
];

// ─── Taxonomy payload shapes ────────────────────────────────────────────────

/** Mirror of the JSON returned by /api/niche-finder/taxonomy.
 *  `scores` is null when the node hasn't been scored yet for this
 *  workspace OR when scoring failed for a recoverable reason. */
interface TaxonomyChildPayload {
  id: string;
  parent_id: string | null;
  slug: string;
  name: string;
  level: 'category' | 'subniche' | 'microniche';
  source: 'curated' | 'ai' | 'harvested';
  rationale: string | null;
  scores: NicheScores | null;
  scored_at: string | null;
  sample_size: number | null;
}

interface ScoreResultPayload {
  nodeId: string;
  scores: NicheScores | null;
  sampleSize: number;
  scoredAt: string | null;
  fromCache: boolean;
  error: string | null;
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
      {tab === 'favorites' && <FavoritesTab />}
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
      {results && <ResultsGrid results={results} sourceTab="interests" />}
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
      {results && <ResultsGrid results={results} sourceTab="channel" />}
    </div>
  );
}

// ─── Tab: category (hierarchical drill-down) ────────────────────────────────

function CategoryTab(): React.ReactElement {
  // Breadcrumb path: empty array = root. Each entry is the node clicked
  // to drill down. UI reads from this to render crumbs and to know what
  // parent to query.
  const [crumbs, setCrumbs] = useState<TaxonomyChildPayload[]>([]);
  const currentParent: TaxonomyChildPayload | null = crumbs[crumbs.length - 1] ?? null;

  const [children, setChildren] = useState<TaxonomyChildPayload[] | null>(null);
  const [loadingLevel, setLoadingLevel] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [brainstorming, setBrainstorming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<BrowseFilters>(DEFAULT_BROWSE_FILTERS);
  // Locale lives at the parent because changing it triggers a refetch
  // — the AI taxonomy generations and YouTube samples are locale-
  // specific. Defaults match the operator's primary audience.
  const [language, setLanguage] = useState('en');
  const [region, setRegion] = useState('US');
  const [showQuadrant, setShowQuadrant] = useState(false);
  const [highlightedSlug, setHighlightedSlug] = useState<string | null>(null);
  const [crossCatOpen, setCrossCatOpen] = useState(false);

  /** Convert a TaxonomyChildPayload[] into the shape filterAndSortDiscoveries
   *  expects (DiscoveryResultItem). We drop unscored nodes here — they
   *  render separately as skeletons above the filtered grid so the
   *  operator knows scoring is in progress, not "no results." */
  const scoredAsDiscoveryItems = useMemo(() => {
    if (!children) return null;
    return children
      .filter((c): c is TaxonomyChildPayload & { scores: NicheScores } => c.scores !== null)
      .map((c) => ({
        slug: c.slug,
        name: c.name,
        rationale: c.rationale ?? undefined,
        scores: c.scores,
      })) as DiscoveryResultItem[];
  }, [children]);

  /** Score a batch of node IDs via POST /taxonomy/score. Updates
   *  `children` in place with returned scores. Skips category-level
   *  nodes — categories aren't scored (they're navigation). */
  const scoreNodes = useCallback(
    async (nodes: TaxonomyChildPayload[]) => {
      const ids = nodes
        .filter((n) => n.level !== 'category' && n.scores === null)
        .map((n) => n.id);
      if (ids.length === 0) return;
      setScoring(true);
      try {
        const res = await fetch('/api/niche-finder/taxonomy/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeIds: ids }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { results: ScoreResultPayload[] };
        const byId = new Map(body.results.map((r) => [r.nodeId, r]));
        setChildren((cur) =>
          cur
            ? cur.map((c) => {
                const r = byId.get(c.id);
                if (!r || !r.scores) return c;
                return {
                  ...c,
                  scores: r.scores,
                  scored_at: r.scoredAt,
                  sample_size: r.sampleSize,
                };
              })
            : cur,
        );
      } finally {
        setScoring(false);
      }
    },
    [],
  );

  /** Load the children of `parent` (null = root) and kick off scoring
   *  for any unscored entries. Replaces the current breadcrumb tail. */
  const loadLevel = useCallback(
    async (parent: TaxonomyChildPayload | null, lang: string, reg: string) => {
      setLoadingLevel(true);
      setError(null);
      setChildren(null);
      setHighlightedSlug(null);
      try {
        const params = new URLSearchParams({ lang, region: reg });
        if (parent) params.set('parent', parent.id);
        const res = await fetch(`/api/niche-finder/taxonomy?${params.toString()}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError((body as { error?: string }).error ?? 'Could not load this branch.');
          return;
        }
        const data = body as { children: TaxonomyChildPayload[] };
        setChildren(data.children);
        // Auto-score unscored non-category children. Fire and forget so
        // the level render isn't blocked on scoring — scores stream in.
        if (parent && parent.level !== 'category' && data.children.length > 0) {
          void scoreNodes(data.children);
        } else if (parent && parent.level === 'category') {
          // Drilling into a category → score the sub-niches.
          void scoreNodes(data.children);
        }
        // (root level = no scoring needed; categories don't have scores)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setLoadingLevel(false);
      }
    },
    [scoreNodes],
  );

  // Initial load.
  useEffect(() => {
    void loadLevel(null, language, region);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drillIn = useCallback(
    (node: TaxonomyChildPayload) => {
      if (node.level === 'microniche') return; // leaf
      const nextCrumbs = [...crumbs, node];
      setCrumbs(nextCrumbs);
      void loadLevel(node, language, region);
    },
    [crumbs, language, region, loadLevel],
  );

  const jumpTo = useCallback(
    (index: number) => {
      // index = -1 means "root"; 0..n-1 means slice including that crumb
      const nextCrumbs = index < 0 ? [] : crumbs.slice(0, index + 1);
      setCrumbs(nextCrumbs);
      const nextParent = nextCrumbs[nextCrumbs.length - 1] ?? null;
      void loadLevel(nextParent, language, region);
    },
    [crumbs, language, region, loadLevel],
  );

  const brainstormMore = useCallback(async () => {
    if (!currentParent) return;
    setBrainstorming(true);
    setError(null);
    try {
      const res = await fetch('/api/niche-finder/taxonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentId: currentParent.id,
          language,
          region,
          count: 10,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? 'Could not brainstorm more.');
        return;
      }
      const data = body as { added: TaxonomyChildPayload[] };
      // Refetch the level so the new rows show up with everything else
      // in display order, then trigger scoring on the new additions.
      await loadLevel(currentParent, language, region);
      if (data.added.length > 0) {
        // The just-loaded list is what scoreNodes will dedupe against;
        // it picks out any unscored. The newly-inserted ones qualify.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBrainstorming(false);
    }
  }, [currentParent, language, region, loadLevel]);

  const onLocaleChange = useCallback(
    (next: { language: string; region: string }) => {
      setLanguage(next.language);
      setRegion(next.region);
      // Locale change resets the breadcrumb because category IDs are
      // locale-scoped (each locale has its own row tree).
      setCrumbs([]);
      void loadLevel(null, next.language, next.region);
    },
    [loadLevel],
  );

  // Client-side narrowing applies only at sub-niche / micro-niche levels.
  // The filter has no meaning over category-level nodes (they're not scored).
  const filtered = useMemo(() => {
    if (!scoredAsDiscoveryItems) return null;
    return filterAndSortDiscoveries(scoredAsDiscoveryItems, filters);
  }, [scoredAsDiscoveryItems, filters]);

  const unscoredCount = children?.filter((c) => c.level !== 'category' && c.scores === null).length ?? 0;
  const scoredCount = scoredAsDiscoveryItems?.length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Breadcrumb crumbs={crumbs} onJump={jumpTo} />
        <button
          type="button"
          onClick={() => setCrossCatOpen(true)}
          title="Search every niche you've already scored across all categories"
          style={{
            padding: '6px 12px',
            background: 'rgba(34,197,94,0.10)',
            color: '#86efac',
            border: '1px solid rgba(34,197,94,0.45)',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          ✦ Find sweet spot across all
        </button>
      </div>

      <CrossCategorySearchModal
        open={crossCatOpen}
        spec={filters}
        language={language}
        region={region}
        onClose={() => setCrossCatOpen(false)}
      />

      {/* Header bar: model picker (sub-niche/micro-niche levels only)
          and brainstorm-more button. */}
      {currentParent && currentParent.level !== 'microniche' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <NicheFinderModelPicker
            feature="niche-taxonomy-generate"
            label="Brainstorm with"
          />
          <button
            type="button"
            onClick={brainstormMore}
            disabled={brainstorming || scoring}
            title={
              currentParent.level === 'category'
                ? 'Ask the AI for ~10 more sub-niches under this category'
                : 'Ask the AI for ~10 more micro-niches under this sub-niche'
            }
            style={{
              padding: '4px 12px',
              background: brainstorming ? '#1e293b' : 'rgba(168,139,250,0.12)',
              color: brainstorming ? '#64748b' : '#cbd5e1',
              border: '1px solid rgba(168,139,250,0.35)',
              borderRadius: 6,
              fontSize: 12,
              cursor: brainstorming || scoring ? 'wait' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {brainstorming ? 'Brainstorming…' : '+ Brainstorm more'}
          </button>
        </div>
      )}

      {loadingLevel && (
        <div style={{ color: '#94a3b8', fontSize: 13 }}>
          {currentParent === null
            ? 'Loading categories…'
            : currentParent.level === 'category'
              ? 'Loading sub-niches' + (unscoredCount === 0 ? '…' : ' and scoring against YouTube…')
              : 'Brainstorming and scoring micro-niches…'}
        </div>
      )}
      {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}

      {/* Root view: 12 category cards in a grid, no filters / quadrant. */}
      {currentParent === null && children && (
        <CategoryGrid items={children} onDrill={drillIn} />
      )}

      {/* Sub-niche / micro-niche level: presets, filter bar, results grid. */}
      {currentParent !== null && children && (
        <>
          <BrowsePresetBar
            currentFilters={filters}
            onApplyPreset={(preset) => setFilters(preset)}
          />
          <BrowseFilterBar
            value={filters}
            onChange={setFilters}
            onReset={() => setFilters(DEFAULT_BROWSE_FILTERS)}
            language={language}
            region={region}
            onLocaleChange={onLocaleChange}
            refetching={loadingLevel}
          />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <div style={{ fontSize: 12, color: '#64748b' }}>
              {filtered?.length ?? 0} of {scoredCount} scored {currentParent.level === 'category' ? 'sub-niches' : 'micro-niches'}
              {' matching your filters'}
              {unscoredCount > 0 && scoring && (
                <span style={{ marginLeft: 8, color: '#86efac' }}>
                  · Scoring {unscoredCount} more…
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowQuadrant((x) => !x)}
              style={{
                padding: '4px 10px',
                background: showQuadrant ? 'rgba(34,197,94,0.15)' : 'transparent',
                color: showQuadrant ? '#86efac' : '#94a3b8',
                border: showQuadrant ? '1px solid rgba(34,197,94,0.5)' : '1px solid #334155',
                borderRadius: 6,
                fontSize: 12,
                cursor: 'pointer',
              }}
              aria-pressed={showQuadrant}
            >
              {showQuadrant ? '▣ Hide quadrant map' : '▢ Quadrant map'}
            </button>
          </div>

          {showQuadrant && filtered && (
            <BrowseQuadrantView
              items={filtered}
              selectedSlug={highlightedSlug}
              onSelect={(slug) => setHighlightedSlug((cur) => (cur === slug ? null : slug))}
            />
          )}

          <TaxonomyGrid
            allChildren={children}
            scored={filtered ?? []}
            highlightedSlug={highlightedSlug}
            currentParentLevel={currentParent.level}
            onDrill={drillIn}
            onResetFilters={() => setFilters(DEFAULT_BROWSE_FILTERS)}
            unscoredHasError={!scoring && unscoredCount > 0}
          />
        </>
      )}
    </div>
  );
}

// ─── Tab: category — subcomponents ──────────────────────────────────────────

function Breadcrumb({
  crumbs,
  onJump,
}: {
  crumbs: TaxonomyChildPayload[];
  onJump: (index: number) => void;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13 }}>
      <button
        onClick={() => onJump(-1)}
        disabled={crumbs.length === 0}
        style={{
          background: 'transparent',
          border: 'none',
          color: crumbs.length === 0 ? '#e2e8f0' : '#94a3b8',
          fontSize: 13,
          fontWeight: crumbs.length === 0 ? 600 : 400,
          cursor: crumbs.length === 0 ? 'default' : 'pointer',
          padding: 0,
          textDecoration: crumbs.length === 0 ? 'none' : 'underline',
        }}
      >
        All categories
      </button>
      {crumbs.map((c, i) => (
        <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#475569' }}>›</span>
          <button
            onClick={() => onJump(i)}
            disabled={i === crumbs.length - 1}
            style={{
              background: 'transparent',
              border: 'none',
              color: i === crumbs.length - 1 ? '#e2e8f0' : '#94a3b8',
              fontSize: 13,
              fontWeight: i === crumbs.length - 1 ? 600 : 400,
              cursor: i === crumbs.length - 1 ? 'default' : 'pointer',
              padding: 0,
              textDecoration: i === crumbs.length - 1 ? 'none' : 'underline',
            }}
          >
            {c.name}
          </button>
        </span>
      ))}
    </div>
  );
}

function CategoryGrid({
  items,
  onDrill,
}: {
  items: TaxonomyChildPayload[];
  onDrill: (node: TaxonomyChildPayload) => void;
}): React.ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
      {items.map((c) => (
        <button
          key={c.id}
          onClick={() => onDrill(c)}
          style={{
            textAlign: 'left',
            padding: 14,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: 10,
            color: '#e2e8f0',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{c.name}</div>
          {c.rationale && (
            <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>{c.rationale}</div>
          )}
          <div style={{ fontSize: 11, color: '#22c55e', marginTop: 6 }}>Drill in →</div>
        </button>
      ))}
    </div>
  );
}

function TaxonomyGrid({
  allChildren,
  scored,
  highlightedSlug,
  currentParentLevel,
  onDrill,
  onResetFilters,
  unscoredHasError,
}: {
  /** The full list of children (scored + unscored) for the current level.
   *  Used to look up the original taxonomy node by slug when a scored
   *  card emits onDrill, since DiscoveryCard doesn't carry the node id. */
  allChildren: TaxonomyChildPayload[];
  scored: DiscoveryResultItem[];
  highlightedSlug: string | null;
  currentParentLevel: 'category' | 'subniche' | 'microniche';
  onDrill: (node: TaxonomyChildPayload) => void;
  onResetFilters: () => void;
  unscoredHasError: boolean;
}): React.ReactElement {
  const unscored = allChildren.filter(
    (c) => c.level !== 'category' && c.scores === null,
  );
  const nodeBySlug = useMemo(() => {
    const m = new Map<string, TaxonomyChildPayload>();
    for (const c of allChildren) m.set(c.slug, c);
    return m;
  }, [allChildren]);
  const allEmpty = scored.length === 0 && unscored.length === 0;
  if (allEmpty) {
    return (
      <div
        style={{
          padding: 24,
          textAlign: 'center',
          color: '#94a3b8',
          background: 'rgba(255,255,255,0.02)',
          border: '1px dashed rgba(255,255,255,0.10)',
          borderRadius: 12,
          fontSize: 13,
        }}
      >
        No niches match these filters. Loosen one or hit{' '}
        <button
          onClick={onResetFilters}
          style={{
            background: 'transparent',
            color: '#22c55e',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontSize: 13,
            textDecoration: 'underline',
          }}
        >
          Reset
        </button>
        .
      </div>
    );
  }
  // At sub-niche level the child level is 'microniche' (drillable);
  // at micro-niche level there's no further drill.
  const childLevelIsLeaf = currentParentLevel === 'subniche';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 12,
      }}
    >
      {/* Skeletons first so the user sees activity above the fold. */}
      {unscored.map((c) => (
        <SkeletonDiscoveryCard
          key={c.id}
          name={c.name}
          rationale={c.rationale ?? undefined}
          errored={unscoredHasError}
        />
      ))}
      {scored.map((r) => (
        <DiscoveryCard
          key={r.slug}
          slug={r.slug}
          name={r.name}
          rationale={r.rationale}
          scores={r.scores}
          sourceTab="category"
          highlighted={r.slug === highlightedSlug}
          onDrill={
            childLevelIsLeaf
              ? undefined
              : () => {
                  const node = nodeBySlug.get(r.slug);
                  if (node) onDrill(node);
                }
          }
        />
      ))}
    </div>
  );
}

/** Placeholder card for an unscored taxonomy node. Matches the size +
 *  rhythm of DiscoveryCard so the grid doesn't jump when scores land. */
function SkeletonDiscoveryCard({
  name,
  rationale,
  errored,
}: {
  name: string;
  rationale?: string;
  errored: boolean;
}): React.ReactElement {
  const accent = errored ? '#475569' : '#86efac';
  return (
    <div
      style={{
        border: `1px solid ${errored ? 'rgba(248,113,113,0.20)' : 'rgba(255,255,255,0.06)'}`,
        borderRadius: 12,
        background: errored ? 'rgba(248,113,113,0.04)' : 'rgba(255,255,255,0.015)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        opacity: errored ? 0.7 : 1,
      }}
    >
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#cbd5e1' }}>{name}</div>
        {rationale && (
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, lineHeight: 1.4 }}>{rationale}</div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: 10,
              width: `${85 - i * 10}%`,
              borderRadius: 4,
              background: 'rgba(255,255,255,0.05)',
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: 11, color: accent }}>
        {errored ? 'Couldn’t score yet — try again in a moment.' : 'Scoring against YouTube…'}
      </div>
    </div>
  );
}

// ─── Tab: outliers ──────────────────────────────────────────────────────────

function OutliersTab(): React.ReactElement {
  const [niche, setNiche] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videos, setVideos] = useState<OutlierVideo[] | null>(null);
  const [filters, setFilters] = useState<OutlierFilters>(DEFAULT_FILTERS);

  // Extracted from the submit handler so a preset click can fetch
  // with an explicit niche string instead of waiting on a state
  // round-trip from `setNiche`.
  const fetchOutliers = useCallback(async (nicheText: string) => {
    const trimmed = nicheText.trim();
    if (trimmed.length === 0) {
      setError('Type a niche or click a preset that has one.');
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
  }, []);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void fetchOutliers(niche);
    },
    [fetchOutliers, niche],
  );

  // Preset click semantics:
  //   - Always apply the filter set.
  //   - If the preset declared a nicheHint and the niche input is
  //     empty, seed it.
  //   - If we now have a non-empty niche, auto-fetch — the operator
  //     clicked a one-click action, they shouldn't have to also
  //     press "Find outliers". Filters are applied client-side once
  //     results land.
  const onApplyPreset = useCallback(
    (presetFilters: OutlierFilters, nicheHint?: string) => {
      setFilters(presetFilters);
      const nextNiche = niche.trim().length > 0 ? niche : nicheHint?.trim() ?? '';
      if (nicheHint && niche.trim().length === 0) {
        setNiche(nicheHint);
      }
      if (nextNiche.length > 0 && !submitting) {
        void fetchOutliers(nextNiche);
      }
    },
    [fetchOutliers, niche, submitting],
  );

  // Filtering runs entirely client-side on the already-fetched
  // array so dialling controls is instant — no re-fetch, no extra
  // quota burn.
  const filteredVideos = useMemo(() => {
    if (!videos) return null;
    return filterAndSortOutliers(videos, filters);
  }, [videos, filters]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Preset bar lives ABOVE the form so it's the first thing
          the operator sees — discovery shortcut, not a follow-up. */}
      <OutlierPresetBar
        currentFilters={filters}
        currentNiche={niche}
        onApplyPreset={onApplyPreset}
      />

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
          outlier. Click a preset above for a one-click shortcut.
        </div>
      </form>

      {videos && videos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <OutlierFilterBar
            value={filters}
            onChange={setFilters}
            onReset={() => setFilters(DEFAULT_FILTERS)}
          />
          <div style={{ fontSize: 12, color: '#64748b' }}>
            {filteredVideos?.length ?? 0} of {videos.length} videos matching your filters
          </div>
          {filteredVideos && filteredVideos.length > 0 ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {filteredVideos.map((v) => (
                <OutlierCard
                  key={v.videoId}
                  video={v}
                  sourceTab="outliers"
                  activeNicheContext={
                    // Outliers tab is unambiguous: every video in this list
                    // came from a single niche search. Scores are placeholder
                    // (no deep-dive runs on outlier search); a later deep-dive
                    // overwrites them. This keeps favoriting a one-click action.
                    niche.trim().length > 0
                      ? {
                          slug: slugifyNiche(niche),
                          name: niche.trim(),
                          scores: PLACEHOLDER_NICHE_SCORES,
                        }
                      : null
                  }
                />
              ))}
            </div>
          ) : (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: '#94a3b8',
                background: 'rgba(255,255,255,0.02)',
                border: '1px dashed rgba(255,255,255,0.10)',
                borderRadius: 12,
                fontSize: 13,
              }}
            >
              No videos match these filters. Loosen one or hit{' '}
              <button
                onClick={() => setFilters(DEFAULT_FILTERS)}
                style={{
                  background: 'transparent',
                  color: '#22c55e',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 13,
                  textDecoration: 'underline',
                }}
              >
                Reset
              </button>
              .
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function ResultsGrid({
  results,
  sourceTab,
  highlightedSlug,
}: {
  results: DiscoveryResultItem[];
  /** Which tab the grid is rendering for. Stamped on the favorite row
   *  when the operator hearts a card. */
  sourceTab: FavoriteSourceTab;
  /** Optional — when set, the matching card pulses + scrolls into view.
   *  Used by the category tab's quadrant chart to surface a clicked bubble. */
  highlightedSlug?: string | null;
}): React.ReactElement {
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
          sourceTab={sourceTab}
          highlighted={r.slug === highlightedSlug}
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
