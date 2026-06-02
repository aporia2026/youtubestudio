'use client';

/**
 * ShortNativeIdeasSurface — Phase 15.2 + 15.5 + 15.8.
 *
 * Hook-first idea generation tuned for the 60-second algorithm. Mounted in:
 *   - /ideas?medium=short_native            (Ideas section, Shorts mode)
 *   - /shorts?tab=create                    (Create-from-scratch tab)
 *
 * Phase 15.8 additions (the "more options" the user asked for, kept
 * behind disclosures so the lazy-user view stays simple per rule 10):
 *   - Niche dropdown reads workspace niches (description + keywords
 *     injected into the prompt automatically). "Custom…" falls back
 *     to free-text for niches not yet saved.
 *   - Series picker integrates Phase 15.6 — picking a series LOCKS
 *     the style (Doodle / Paint / Minimal) and injects intro/outro.
 *   - "More options ▾" disclosure: length chips (15/30/45/60s), hook
 *     style archetype, tone, POV.
 *   - "Inspired by my channel ▾" disclosure: pick a connected channel,
 *     toggle "pattern after my top performers" (reads video_analytics
 *     outlier ratio over the last 90 days) and/or "avoid topics I've
 *     covered recently".
 *
 * Each idea card carries a "Generate this Short →" button that calls
 * /api/shorts/generate-from-idea; if a non-minimal style is picked,
 * the asset pipeline fires after the row is created.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ShortStylePicker } from '@/components/shorts/ShortStylePicker';
import { DEFAULT_SHORT_STYLE_ID, type ShortStyleId } from '@/lib/short-styles';
import {
  HOOK_STYLES,
  POVS,
  TONES,
  type HookStyle,
  type PovStyle,
  type Tone,
} from '@/lib/shorts-ideas';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import {
  clearShortsIdeasHistory,
  deleteShortsIdeasEntry,
  getShortsIdeasHistory,
  getShortsIdeasHistoryCached,
  saveShortsIdeas,
  type ShortsIdeasHistoryEntry,
} from '@/lib/history';

interface ShortIdea {
  hook: string;
  title: string;
  payoff: string;
  thesis: string;
  shotConcept: string;
  confidence: number;
}

interface NicheRow {
  id: string;
  name: string;
  description: string;
  keywords: string[];
}

interface SeriesRow {
  id: string;
  name: string;
  locked_style_id: string;
  intro_text: string | null;
  outro_text: string | null;
  cadence: string | null;
}

interface ChannelRow {
  id: string;
  name: string;
  oauth_connected: boolean;
}

const LENGTH_OPTIONS = [15, 30, 45, 60] as const;

const HOOK_STYLE_LABELS: Record<HookStyle, string> = {
  question: 'Question',
  number: 'Specific number',
  contrarian: 'Contrarian',
  story: 'Story drop-in',
  'fact-reveal': 'Fact reveal',
  'youre-doing-it-wrong': "You're doing it wrong",
};

const TONE_LABELS: Record<Tone, string> = {
  irreverent: 'Irreverent',
  authoritative: 'Authoritative',
  wry: 'Wry',
  earnest: 'Earnest',
  urgent: 'Urgent',
};

const POV_LABELS: Record<PovStyle, string> = {
  'first-person': 'First person (I)',
  'second-person': 'Second person (you)',
  'third-person': 'Third person',
};

export function ShortNativeIdeasSurface() {
  // ── primary inputs ──────────────────────────────────────────────────
  const [nicheText, setNicheText] = useState('');
  const [nicheRowId, setNicheRowId] = useState<string>(''); // '' = Custom…
  const [count, setCount] = useState(8);
  const [context, setContext] = useState('');

  // ── 15.8 controls ───────────────────────────────────────────────────
  const [seriesId, setSeriesId] = useState<string>('');
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [targetLengthSec, setTargetLengthSec] = useState<number | ''>('');
  const [hookStyle, setHookStyle] = useState<HookStyle | ''>('');
  const [tone, setTone] = useState<Tone | ''>('');
  const [pov, setPov] = useState<PovStyle | ''>('');

  // Inspired-by section
  const [showInspirationPanel, setShowInspirationPanel] = useState(false);
  const [inspirationChannelId, setInspirationChannelId] = useState<string>('');
  const [useTopPerformers, setUseTopPerformers] = useState(false);
  const [avoidRecentlyCovered, setAvoidRecentlyCovered] = useState(false);
  const [inspiredByTitles, setInspiredByTitles] = useState<string[]>([]);
  const [avoidTitles, setAvoidTitles] = useState<string[]>([]);
  const [inspirationLoading, setInspirationLoading] = useState(false);

  // ── data the surface loads on mount ─────────────────────────────────
  const [niches, setNiches] = useState<NicheRow[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);

  // ── output ──────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [ideas, setIdeas] = useState<ShortIdea[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [styleId, setStyleId] = useState<ShortStyleId>(DEFAULT_SHORT_STYLE_ID);
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);

  // ── history sidebar ─────────────────────────────────────────────────
  // Paint instantly from the localStorage cache, then refresh from the
  // server on mount (long-form ideas page does the same).
  const [historyItems, setHistoryItems] = useState<ShortsIdeasHistoryEntry[]>(
    () => (typeof window !== 'undefined' ? getShortsIdeasHistoryCached() : []),
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const server = await getShortsIdeasHistory();
        if (!cancelled) setHistoryItems(server);
      } catch {
        /* degraded mode — cache stays */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── load workspace data on mount ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nichesRes, seriesRes, channelsRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, loads workspace niches
          fetch('/api/niches'),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads series
          fetch('/api/shorts/series'),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads channels
          fetch('/api/channels'),
        ]);
        if (cancelled) return;
        if (nichesRes.ok) {
          const data = await nichesRes.json();
          setNiches((data.niches ?? []) as NicheRow[]);
        }
        if (seriesRes.ok) {
          const data = await seriesRes.json();
          setSeries((data.series ?? []) as SeriesRow[]);
        }
        if (channelsRes.ok) {
          const data = await channelsRes.json();
          setChannels((data.channels ?? []) as ChannelRow[]);
        }
      } catch {
        // Best-effort: a workspace with no niches/series/channels still
        // works via free-text fallbacks.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── effective niche (auto-fills text when a row is picked) ──────────
  const selectedNicheRow = useMemo(
    () => niches.find((n) => n.id === nicheRowId) ?? null,
    [niches, nicheRowId],
  );
  const effectiveNiche = selectedNicheRow ? selectedNicheRow.name : nicheText.trim();

  // ── effective series (locks style when picked) ──────────────────────
  const selectedSeries = useMemo(
    () => series.find((s) => s.id === seriesId) ?? null,
    [series, seriesId],
  );
  const effectiveStyleId: ShortStyleId = selectedSeries
    ? (selectedSeries.locked_style_id as ShortStyleId)
    : styleId;

  // ── load inspiration titles on toggle ───────────────────────────────
  const loadInspiration = useCallback(async () => {
    if (!inspirationChannelId) {
      setInspiredByTitles([]);
      setAvoidTitles([]);
      return;
    }
    if (!useTopPerformers && !avoidRecentlyCovered) {
      setInspiredByTitles([]);
      setAvoidTitles([]);
      return;
    }
    setInspirationLoading(true);
    try {
      const calls: Array<Promise<{ kind: 'top' | 'recent'; titles: string[] }>> = [];
      if (useTopPerformers) {
        calls.push(
          // eslint-disable-next-line no-restricted-syntax -- GET, loads top performers
          fetch(
            `/api/shorts/inspiration?channelDbId=${encodeURIComponent(inspirationChannelId)}&kind=top&limit=8`,
          )
            .then((r) => (r.ok ? r.json() : { titles: [] }))
            .then((d) => ({ kind: 'top' as const, titles: (d.titles ?? []) as string[] })),
        );
      }
      if (avoidRecentlyCovered) {
        calls.push(
          // eslint-disable-next-line no-restricted-syntax -- GET, loads recent
          fetch(
            `/api/shorts/inspiration?channelDbId=${encodeURIComponent(inspirationChannelId)}&kind=recent&limit=20`,
          )
            .then((r) => (r.ok ? r.json() : { titles: [] }))
            .then((d) => ({ kind: 'recent' as const, titles: (d.titles ?? []) as string[] })),
        );
      }
      const results = await Promise.all(calls);
      for (const r of results) {
        if (r.kind === 'top') setInspiredByTitles(r.titles);
        else setAvoidTitles(r.titles);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load inspiration');
    } finally {
      setInspirationLoading(false);
    }
  }, [inspirationChannelId, useTopPerformers, avoidRecentlyCovered]);

  useEffect(() => {
    loadInspiration();
  }, [loadInspiration]);

  // ── generate ideas ──────────────────────────────────────────────────
  const generate = useCallback(async () => {
    if (!effectiveNiche) {
      setError('Pick a niche first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/shorts/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: effectiveNiche,
          context: context.trim() || undefined,
          count,
          nicheRowId: selectedNicheRow ? selectedNicheRow.id : undefined,
          seriesId: seriesId || undefined,
          formatHints: {
            targetLengthSec: typeof targetLengthSec === 'number' ? targetLengthSec : undefined,
            hookStyle: hookStyle || undefined,
            tone: tone || undefined,
            pov: pov || undefined,
          },
          inspiredByTitles: useTopPerformers && inspiredByTitles.length > 0 ? inspiredByTitles : undefined,
          avoidTitles: avoidRecentlyCovered && avoidTitles.length > 0 ? avoidTitles : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const generated = (data.ideas || []) as ShortIdea[];
      setIdeas(generated);
      if (generated.length === 0) {
        toast.info('Got an empty response — try again.');
      } else {
        // Persist the batch into the history sidebar. Same write-through
        // pattern as the long-form Ideas page — optimistic prepend
        // followed by the server save. Failures degrade gracefully:
        // the cache still has the entry from saveShortsIdeas() (which
        // writes the cache before/around the network call).
        try {
          const saved = await saveShortsIdeas({
            niche: effectiveNiche,
            count,
            ideas: generated as unknown as Array<Record<string, unknown>>,
            context: context.trim() || undefined,
            nicheRowId: selectedNicheRow?.id ?? undefined,
            seriesId: seriesId || undefined,
            targetLengthSec: typeof targetLengthSec === 'number' ? targetLengthSec : undefined,
            hookStyle: hookStyle || undefined,
            tone: tone || undefined,
            pov: pov || undefined,
            inspiredByTitles: useTopPerformers && inspiredByTitles.length > 0 ? inspiredByTitles : undefined,
            avoidTitles: avoidRecentlyCovered && avoidTitles.length > 0 ? avoidTitles : undefined,
            modelId: data.modelId as string | undefined,
          });
          setHistoryItems((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
        } catch {
          /* swallow — the cache fallback in saveShortsIdeas keeps the
             entry visible on next mount even if the server is down */
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate Shorts ideas');
    } finally {
      setBusy(false);
    }
  }, [
    effectiveNiche,
    context,
    count,
    selectedNicheRow,
    seriesId,
    targetLengthSec,
    hookStyle,
    tone,
    pov,
    useTopPerformers,
    inspiredByTitles,
    avoidRecentlyCovered,
    avoidTitles,
  ]);

  // ── history actions ────────────────────────────────────────────────
  const restoreFromHistory = useCallback(
    (id: string) => {
      const entry = historyItems.find((h) => h.id === id);
      if (!entry) return;
      // Repopulate the form. If the niche row referenced in the entry
      // still exists in the user's workspace, select it; otherwise
      // fall back to the literal text.
      if (entry.nicheRowId && niches.some((n) => n.id === entry.nicheRowId)) {
        setNicheRowId(entry.nicheRowId);
        setNicheText('');
      } else {
        setNicheRowId('');
        setNicheText(entry.niche);
      }
      if (entry.seriesId && series.some((s) => s.id === entry.seriesId)) {
        setSeriesId(entry.seriesId);
      } else {
        setSeriesId('');
      }
      setCount(entry.count);
      setContext(entry.context ?? '');
      setTargetLengthSec(typeof entry.targetLengthSec === 'number' ? entry.targetLengthSec : '');
      setHookStyle((entry.hookStyle as HookStyle) || '');
      setTone((entry.tone as Tone) || '');
      setPov((entry.pov as PovStyle) || '');
      // Open the disclosures so the restored values are visible.
      if (entry.targetLengthSec || entry.hookStyle || entry.tone || entry.pov) {
        setShowMoreOptions(true);
      }
      if ((entry.inspiredByTitles ?? []).length > 0 || (entry.avoidTitles ?? []).length > 0) {
        setShowInspirationPanel(true);
        setInspiredByTitles(entry.inspiredByTitles ?? []);
        setAvoidTitles(entry.avoidTitles ?? []);
        // Keep the toggles in sync so the prompt builder threads the
        // restored lists through on the next Generate click.
        setUseTopPerformers((entry.inspiredByTitles ?? []).length > 0);
        setAvoidRecentlyCovered((entry.avoidTitles ?? []).length > 0);
      }
      // Restore the actual idea cards too — most useful when the user is
      // re-evaluating a batch they generated earlier and wants to click
      // "Generate this Short →" on one of them now.
      setIdeas((entry.ideas as unknown as ShortIdea[]) ?? []);
      toast.success('Batch restored');
    },
    [historyItems, niches, series],
  );

  const handleDeleteHistory = useCallback(
    async (id: string) => {
      // Optimistic remove
      const prior = historyItems;
      setHistoryItems((items) => items.filter((i) => i.id !== id));
      try {
        await deleteShortsIdeasEntry(id);
      } catch (e) {
        setHistoryItems(prior);
        toast.error(e instanceof Error ? e.message : 'Delete failed');
      }
    },
    [historyItems],
  );

  const handleClearHistory = useCallback(async () => {
    const prior = historyItems;
    setHistoryItems([]);
    try {
      await clearShortsIdeasHistory();
      toast.success('History cleared');
    } catch (e) {
      setHistoryItems(prior);
      toast.error(e instanceof Error ? e.message : 'Clear failed');
    }
  }, [historyItems]);

  function copyAll(idea: ShortIdea) {
    const text = `Hook: ${idea.hook}\nTitle: ${idea.title}\nPayoff: ${idea.payoff}\n\nThesis: ${idea.thesis}\nShot: ${idea.shotConcept}`;
    navigator.clipboard.writeText(text).then(
      () => toast.success('Idea copied'),
      () => toast.error('Could not copy'),
    );
  }

  const generateShort = useCallback(
    async (idea: ShortIdea, idx: number) => {
      const key = `${idx}-${idea.hook.slice(0, 30)}`;
      setGeneratingKey(key);
      try {
        // 1. Create the short_native row — fast (~10-20s extractor).
        const res = await fetch('/api/shorts/generate-from-idea', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            niche: effectiveNiche,
            hook: idea.hook,
            payoff: idea.payoff,
            ideaTitle: idea.title,
            thesis: idea.thesis || undefined,
            shotConcept: idea.shotConcept || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const newShortId = data.id as string | undefined;

        // 2. Style asset generation. Minimal = no-op stamp (fast). Doodle
        //    + Paint take 1-4 minutes server-side; we fire-and-forget
        //    instead of blocking the page on the wait. The Vercel function
        //    has maxDuration=300 and will keep running even after this
        //    fetch promise gets resolved/cancelled.
        if (newShortId && effectiveStyleId !== 'minimal_gradient_v1') {
          // Kick off without awaiting. The catch keeps an uncaught
          // promise rejection from logging to the console if the server
          // 502s or the user navigates away.
          void fetch(
            `/api/shorts/${encodeURIComponent(newShortId)}/generate-style-assets`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                style_id: effectiveStyleId,
                niche: effectiveNiche,
              }),
              keepalive: true,
            },
          ).catch(() => {
            // Surface as an inbox status when the user gets back to it;
            // a toast now would be misleading because the work may still
            // succeed even after the keepalive socket drops.
          });
          toast.success(
            `Short created — ${effectiveStyleId.replace(/_/g, ' ')} assets generating in the background (1-4 min). Check the Shorts inbox shortly.`,
          );
        } else {
          toast.success('Short created — open the Shorts inbox to voice it.');
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to generate the Short');
      } finally {
        setGeneratingKey(null);
      }
    },
    [effectiveNiche, effectiveStyleId],
  );

  return (
    <section
      style={{
        marginTop: 16,
        padding: 20,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        maxWidth: 920,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
        Hook-first Shorts ideas
      </h2>
      <p style={{ marginTop: 6, marginBottom: 0, fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
        Every idea opens with the literal first-3-seconds line — what you would actually say,
        not a topic title.
      </p>

      {/* Niche + Series row */}
      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
            Niche {niches.length > 0 && <span style={{ opacity: 0.65 }}>(from Settings)</span>}
          </span>
          <select
            value={nicheRowId}
            onChange={(e) => {
              setNicheRowId(e.target.value);
              if (e.target.value === '') setNicheText('');
            }}
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: 'rgba(0,0,0,0.2)',
              color: 'inherit',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <option value="">{niches.length === 0 ? 'No niches saved — use Custom' : 'Custom (type your own)'}</option>
            {niches.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          {!nicheRowId && (
            <input
              type="text"
              value={nicheText}
              onChange={(e) => setNicheText(e.target.value)}
              placeholder="e.g. AI tools for solopreneurs"
              className="input-field"
              style={{
                marginTop: 6,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(0,0,0,0.2)',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            />
          )}
          {selectedNicheRow && (selectedNicheRow.description || (selectedNicheRow.keywords ?? []).length > 0) && (
            <div
              style={{
                marginTop: 6,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(124,58,237,0.10)',
                border: '1px solid rgba(124,58,237,0.25)',
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--text-secondary, rgba(255,255,255,0.8))',
              }}
            >
              <strong>Loaded into the prompt:</strong>{' '}
              {selectedNicheRow.description?.slice(0, 200) || '(no description)'}
              {(selectedNicheRow.keywords ?? []).length > 0 && (
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  Keywords: {selectedNicheRow.keywords.join(', ')}
                </div>
              )}
            </div>
          )}
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
            Series {series.length > 0 && <span style={{ opacity: 0.65 }}>(locks style if picked)</span>}
          </span>
          <select
            value={seriesId}
            onChange={(e) => setSeriesId(e.target.value)}
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: 'rgba(0,0,0,0.2)',
              color: 'inherit',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <option value="">{series.length === 0 ? 'No series saved' : 'No series (free pick)'}</option>
            {series.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.locked_style_id.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          {selectedSeries && (
            <div
              style={{
                marginTop: 6,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(124,58,237,0.10)',
                border: '1px solid rgba(124,58,237,0.25)',
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--text-secondary, rgba(255,255,255,0.8))',
              }}
            >
              Style locked to <strong>{selectedSeries.locked_style_id.replace(/_/g, ' ')}</strong>.
              {selectedSeries.intro_text && <div style={{ marginTop: 4 }}>Intro: "{selectedSeries.intro_text.slice(0, 100)}…"</div>}
              {selectedSeries.outro_text && <div>Outro: "{selectedSeries.outro_text.slice(0, 100)}…"</div>}
            </div>
          )}
        </label>
      </div>

      {/* Count + Context row */}
      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>How many</span>
          <input
            type="number"
            min={3}
            max={15}
            value={count}
            onChange={(e) => setCount(Math.max(3, Math.min(15, Number(e.target.value) || 8)))}
            className="input-field"
            style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.2)', color: 'inherit', border: '1px solid rgba(255,255,255,0.1)' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>Context (optional)</span>
          <textarea
            rows={2}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Voice notes, recent themes, audience tone…"
            style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.2)', color: 'inherit', border: '1px solid rgba(255,255,255,0.1)', resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }}
          />
        </label>
      </div>

      {/* More options disclosure */}
      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          onClick={() => setShowMoreOptions((v) => !v)}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'transparent',
            color: 'var(--text-secondary, rgba(255,255,255,0.75))',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {showMoreOptions ? 'Hide format options ▴' : 'More options — length, hook style, tone, POV ▾'}
        </button>
      </div>

      {showMoreOptions && (
        <div
          style={{
            marginTop: 10,
            padding: 14,
            borderRadius: 12,
            background: 'rgba(0,0,0,0.18)',
            border: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <ChipRow
            label="Target length"
            value={targetLengthSec === '' ? null : targetLengthSec}
            onChange={(v) => setTargetLengthSec(v == null ? '' : (v as number))}
            options={LENGTH_OPTIONS.map((n) => ({ value: n, label: `${n}s` }))}
            disabled={busy}
          />
          <ChipRow
            label="Hook style"
            value={hookStyle || null}
            onChange={(v) => setHookStyle(v == null ? '' : (v as HookStyle))}
            options={HOOK_STYLES.map((id) => ({ value: id, label: HOOK_STYLE_LABELS[id] }))}
            disabled={busy}
          />
          <ChipRow
            label="Tone"
            value={tone || null}
            onChange={(v) => setTone(v == null ? '' : (v as Tone))}
            options={TONES.map((id) => ({ value: id, label: TONE_LABELS[id] }))}
            disabled={busy}
          />
          <ChipRow
            label="POV"
            value={pov || null}
            onChange={(v) => setPov(v == null ? '' : (v as PovStyle))}
            options={POVS.map((id) => ({ value: id, label: POV_LABELS[id] }))}
            disabled={busy}
          />
        </div>
      )}

      {/* Inspired by disclosure */}
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          onClick={() => setShowInspirationPanel((v) => !v)}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'transparent',
            color: 'var(--text-secondary, rgba(255,255,255,0.75))',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {showInspirationPanel ? 'Hide channel inspiration ▴' : 'Inspired by my channel ▾'}
        </button>
      </div>

      {showInspirationPanel && (
        <div
          style={{
            marginTop: 10,
            padding: 14,
            borderRadius: 12,
            background: 'rgba(0,0,0,0.18)',
            border: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>Channel</span>
            <select
              value={inspirationChannelId}
              onChange={(e) => setInspirationChannelId(e.target.value)}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(0,0,0,0.2)',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <option value="">Pick a channel…</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useTopPerformers}
              disabled={!inspirationChannelId || inspirationLoading}
              onChange={(e) => setUseTopPerformers(e.target.checked)}
            />
            <span>
              Pattern after my top-performing recent videos
              {useTopPerformers && inspiredByTitles.length > 0 && (
                <span style={{ marginLeft: 6, opacity: 0.65 }}>({inspiredByTitles.length} loaded)</span>
              )}
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={avoidRecentlyCovered}
              disabled={!inspirationChannelId || inspirationLoading}
              onChange={(e) => setAvoidRecentlyCovered(e.target.checked)}
            />
            <span>
              Avoid topics I've already covered recently
              {avoidRecentlyCovered && avoidTitles.length > 0 && (
                <span style={{ marginLeft: 6, opacity: 0.65 }}>({avoidTitles.length} loaded)</span>
              )}
            </span>
          </label>
          {inspirationLoading && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.55))' }}>
              Loading channel signals…
            </div>
          )}
        </div>
      )}

      {/* Generate ideas button */}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={generate}
          disabled={busy || !effectiveNiche}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            cursor: busy ? 'wait' : !effectiveNiche ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            fontSize: 13,
            background: busy ? 'rgba(124,58,237,0.5)' : 'rgba(124,58,237,0.95)',
            color: '#fff',
            opacity: !effectiveNiche ? 0.6 : 1,
          }}
        >
          {busy ? 'Generating…' : 'Generate ideas'}
        </button>
        {error && <span style={{ fontSize: 12, color: '#fca5a5' }}>{error}</span>}
      </div>

      {/* Style picker */}
      {ideas.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))', marginBottom: 6 }}>
            Style for the Shorts you generate below.
            {selectedSeries && (
              <span style={{ marginLeft: 6, opacity: 0.85 }}>
                Locked by series — change at the series level if you want a different style.
              </span>
            )}
            {!selectedSeries && ' Doodle / Paint adds ~30-90s of Atlas time per Short.'}
          </div>
          <ShortStylePicker
            value={effectiveStyleId}
            onChange={setStyleId}
            disabled={generatingKey !== null || selectedSeries != null}
          />
        </div>
      )}

      {/* Idea cards */}
      {ideas.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {ideas.map((idea, idx) => (
            <article
              key={idx}
              style={{
                padding: 14,
                borderRadius: 12,
                background: 'rgba(0,0,0,0.18)',
                border: '1px solid rgba(255,255,255,0.08)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <header style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'rgba(124,58,237,0.18)',
                    color: '#c4b5fd',
                    fontWeight: 600,
                  }}
                >
                  #{idx + 1} • {(idea.confidence * 100).toFixed(0)} conf
                </span>
                <span style={{ marginLeft: 'auto', fontWeight: 500, color: 'var(--text-primary, #fff)' }}>
                  {idea.title}
                </span>
              </header>
              <div style={{ fontSize: 14, lineHeight: 1.5 }}>
                <strong style={{ color: '#fbbf24' }}>{idea.hook}</strong>
                <div style={{ marginTop: 6, color: 'var(--text-secondary, rgba(255,255,255,0.75))' }}>
                  {idea.payoff}
                </div>
              </div>
              {(idea.thesis || idea.shotConcept) && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.55))', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {idea.thesis && <div><em>Proves:</em> {idea.thesis}</div>}
                  {idea.shotConcept && <div><em>Shot:</em> {idea.shotConcept}</div>}
                </div>
              )}
              <footer style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => copyAll(idea)}
                  style={{
                    padding: '5px 11px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: 'transparent',
                    color: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Copy idea
                </button>
                <button
                  type="button"
                  onClick={() => generateShort(idea, idx)}
                  disabled={generatingKey !== null}
                  style={{
                    padding: '5px 11px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'rgba(124,58,237,0.95)',
                    color: '#fff',
                    cursor: generatingKey !== null ? 'wait' : 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {generatingKey === `${idx}-${idea.hook.slice(0, 30)}`
                    ? 'Generating…'
                    : 'Generate this Short →'}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}

      {/* Sidebar history — same pattern as the seven long-form panels. */}
      <HistoryPanel
        title="Shorts Ideas History"
        icon="⚡"
        accentColor="#7c3aed"
        items={historyItems.map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          label: `${e.niche} — ${e.ideas.length} ideas`,
          sublabel: [
            typeof e.targetLengthSec === 'number' ? `${e.targetLengthSec}s` : null,
            e.hookStyle ? `hook: ${e.hookStyle.replace(/-/g, ' ')}` : null,
            e.tone ? `tone: ${e.tone}` : null,
            e.pov ? `pov: ${e.pov.replace(/-/g, ' ')}` : null,
            e.seriesId ? 'series' : null,
          ]
            .filter(Boolean)
            .join(' · ') || `${e.count} requested`,
          preview: e.ideas
            .slice(0, 3)
            .map((i) => (i as Record<string, string>).hook || (i as Record<string, string>).title || '')
            .join(' | '),
        }))}
        onRestore={restoreFromHistory}
        onDelete={handleDeleteHistory}
        onClearAll={handleClearHistory}
      />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// In-file chip-row primitive. Trivial enough that a dedicated component file
// would just be ceremony for one consumer.
// ────────────────────────────────────────────────────────────────────────────

function ChipRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T | null) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--text-secondary, rgba(255,255,255,0.55))', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <ChipButton active={value == null} onClick={() => onChange(null)} disabled={disabled}>
          Auto
        </ChipButton>
        {options.map((o) => (
          <ChipButton
            key={String(o.value)}
            active={value === o.value}
            onClick={() => onChange(o.value)}
            disabled={disabled}
          >
            {o.label}
          </ChipButton>
        ))}
      </div>
    </div>
  );
}

function ChipButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '4px 11px',
        borderRadius: 999,
        border: '1px solid ' + (active ? 'rgba(124,58,237,0.85)' : 'rgba(255,255,255,0.1)'),
        background: active ? 'rgba(124,58,237,0.18)' : 'transparent',
        color: active ? '#c4b5fd' : 'var(--text-secondary, rgba(255,255,255,0.75))',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
