'use client';

import { Suspense, useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, loadFullContextForItem } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId, getModelById } from '@/lib/ai-models';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { SeriesPicker } from '@/components/ui/SeriesPicker';
import { getIdeasHistory, getIdeasHistoryCached, saveIdeas, deleteIdeasEntry, clearIdeasHistory, type IdeasHistoryEntry } from '@/lib/history';

// Collect every previously-generated title across all history entries —
// passed as `existingTitles` so the LLM never repeats and the server can
// post-filter dupes. Caps at 500 to keep the prompt sane.
function collectAllPreviousTitles(entries: IdeasHistoryEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    for (const idea of entry.ideas ?? []) {
      const t = (idea as { title?: unknown }).title;
      if (typeof t === 'string' && t.trim()) {
        const norm = t.trim().toLowerCase();
        if (!seen.has(norm)) {
          seen.add(norm);
          out.push(t.trim());
          if (out.length >= 500) return out;
        }
      }
    }
  }
  return out;
}

interface PerformanceBreakdown {
  search_volume?: string;
  competition_level?: string;
  competition_reasoning?: string;
  monetization_potential?: string;
  audience_size?: string;
  virality_factors?: string[];
  historical_evidence?: string;
}

interface VideoIdea {
  id?: string;
  title: string;
  hook: string;
  description: string;
  why_it_will_perform: string;
  performance_breakdown?: PerformanceBreakdown;
  search_intent: string;
  target_audience_segment: string;
  estimated_difficulty: string;
  content_type: string;
  trend_status: string;
  estimated_views_potential: string;
  confidence_score?: number;
  best_time_to_publish?: string;
  thumbnail_concept: string;
  tags: string[];
  competitor_gap: string;
  inspiration_sources?: {
    from_reference_videos?: string | Array<{ video_title?: string; techniques_borrowed?: string; how_adapted?: string }>;
    from_reddit?: string | Array<{ post_title?: string; post_url?: string; subreddit?: string; what_was_taken?: string; how_adapted?: string }>;
  };
  is_saved?: boolean;
}

const FOCUS_OPTIONS = [
  { id: 'mixed', label: 'Mixed', emoji: '🎯' },
  { id: 'trending', label: 'Trending Now', emoji: '🔥' },
  { id: 'evergreen', label: 'Evergreen', emoji: '🌲' },
  { id: 'beginner', label: 'Beginner-Friendly', emoji: '🌱' },
  { id: 'controversial', label: 'Controversial', emoji: '⚡' },
];

const VIDEO_TYPES = [
  { id: 'any', label: 'Any Type', emoji: '🎲', desc: 'Let AI pick the best format' },
  { id: 'explainer', label: 'Explainer', emoji: '🧠', desc: 'Break down complex topics clearly' },
  { id: 'story', label: 'Story / Narrative', emoji: '📖', desc: 'Story-driven with a beginning, middle, end' },
  { id: 'tutorial', label: 'Tutorial / How-To', emoji: '🛠️', desc: 'Step-by-step instructional content' },
  { id: 'listicle', label: 'Top 10 / Listicle', emoji: '📋', desc: 'Ranked lists, countdowns, compilations' },
  { id: 'comparison', label: 'Comparison / Versus', emoji: '⚔️', desc: 'A vs B, product showdowns, debates' },
  { id: 'reaction', label: 'Reaction / Commentary', emoji: '🎤', desc: 'React to news, trends, or other content' },
  { id: 'case-study', label: 'Case Study / Deep Dive', emoji: '🔬', desc: 'In-depth analysis of a real example' },
  { id: 'myth-busting', label: 'Myth Busting', emoji: '💥', desc: 'Debunk misconceptions and bad advice' },
  { id: 'challenge', label: 'Challenge / Experiment', emoji: '🧪', desc: 'Try something and document the results' },
  { id: 'interview', label: 'Interview / Q&A', emoji: '🎙️', desc: 'Expert interviews or audience Q&A' },
  { id: 'behind-scenes', label: 'Behind the Scenes', emoji: '🎬', desc: 'Process reveals, day-in-the-life' },
  { id: 'news-update', label: 'News / Breaking Update', emoji: '📰', desc: 'Timely coverage of industry news' },
  { id: 'opinion', label: 'Hot Take / Opinion', emoji: '🔥', desc: 'Bold, opinionated take on a topic' },
];

const TREND_BADGES: Record<string, { color: string; bg: string }> = {
  trending: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  rising: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  evergreen: { color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
  declining: { color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};

const VIEWS_COLORS: Record<string, string> = {
  '1M+': '#7c3aed',
  '200K-1M': '#ec4899',
  '50K-200K': '#f59e0b',
  '10K-50K': '#6b7280',
};

interface VideoRef {
  id: string;
  url: string;
  title: string;
  channelTitle: string;
  viewCount: number;
  thumbnailUrl: string;
  styleAnalysis: string | null;
  analysis: Record<string, unknown> | null;
  loading: boolean;
}

interface RedditPost {
  title: string;
  score: number;
  numComments: number;
  url: string;
  subreddit: string;
}

export default function IdeasPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <IdeasPage />
    </Suspense>
  );
}

function IdeasPage() {
  const search = useSearchParams();
  const scheduleItemId = getScheduleLinkId(search);
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);

  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('idea-generator'));
  const [niche, setNiche] = useState('');
  // Full niche rows — description and keywords are load-bearing for prompting.
  // The previous narrow shape (just id+name) silently discarded them, which is
  // why the generator behaved as if every niche meant the same thing.
  const [niches, setNiches] = useState<{ id: string; name: string; description?: string | null; keywords?: string[] | null }[]>([]);
  const [count, setCount] = useState(10);
  const [audience, setAudience] = useState('');
  // Per-generation free-text context (does not persist across refresh by design —
  // see the "Context box" question in the design discussion).
  const [extraContext, setExtraContext] = useState('');
  // Toggle whether the saved niche description is injected into the prompt.
  // Default on: the user set the description for a reason.
  const [useNicheDescription, setUseNicheDescription] = useState(true);
  const [focus, setFocus] = useState('mixed');
  const [videoType, setVideoType] = useState('any');
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [ideas, setIdeas] = useState<VideoIdea[]>([]);
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  // Series linkage — optional. When set, generated ideas/selected-idea will be
  // tagged with series_id/part_number so the Script Generator can pick up the
  // series context when this idea is promoted.
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [seriesTitle, setSeriesTitle] = useState<string>('');
  const [partNumber, setPartNumber] = useState<number>(1);

  // Saved Ideas Library (persisted across sessions via /api/ideas GET)
  interface SavedIdeaRow {
    id: string;
    title: string;
    hook: string;
    description: string;
    niche: string;
    tags: string[];
    difficulty: string;
    created_at: string;
  }
  const [library, setLibrary] = useState<SavedIdeaRow[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [librarySearch, setLibrarySearch] = useState('');
  const [deletingLibId, setDeletingLibId] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // Reference videos
  const [refUrl, setRefUrl] = useState('');
  const [refs, setRefs] = useState<VideoRef[]>([]);
  const [showRefs, setShowRefs] = useState(false);

  // Reddit research — toggle to include in generation
  const [useReddit, setUseReddit] = useState(false);
  const [redditSubs, setRedditSubs] = useState('');

  // History — instant paint from cache, then refresh from server (migration 0049).
  const [ideasHistoryItems, setIdeasHistoryItems] = useState<IdeasHistoryEntry[]>(() => getIdeasHistoryCached());
  useEffect(() => { getIdeasHistory().then(setIdeasHistoryItems).catch(() => {}); }, []);

  function restoreIdeas(id: string) {
    const entry = ideasHistoryItems.find(e => e.id === id);
    if (!entry) return;
    if (ideas.length > 0 && typeof window !== 'undefined' &&
        !confirm('Replace the current ideas list with this restored entry?')) {
      return;
    }
    setNiche(entry.niche);
    setFocus(entry.focus);
    setVideoType(entry.videoType || 'any');
    if (getModelById(entry.modelId)) setModelId(entry.modelId);
    setCount(entry.count);
    setIdeas(entry.ideas as unknown as VideoIdea[]);
    // Rehydrate the input context so the "why these ideas" is clear on restore.
    if (entry.audience !== undefined) setAudience(entry.audience);
    if (typeof entry.usedReddit === 'boolean') setUseReddit(entry.usedReddit);
    if (entry.refs && entry.refs.length) {
      setRefs(entry.refs.map((r, i) => ({
        id: `restored-${i}-${Date.now()}`,
        url: r.url,
        title: r.title,
        channelTitle: r.channelTitle || '',
        viewCount: r.viewCount || 0,
        thumbnailUrl: '',
        styleAnalysis: null,
        analysis: null,
        loading: false,
      })));
    }
    toast.success(`Ideas restored — ${entry.ideas.length} ideas`);
  }

  function handleDeleteIdeas(id: string) {
    setIdeasHistoryItems((prev) => prev.filter((e) => e.id !== id));
    deleteIdeasEntry(id).catch(() => {});
  }

  function handleClearIdeas() {
    setIdeasHistoryItems([]);
    clearIdeasHistory().catch(() => {});
  }

  useEffect(() => {
    fetch('/api/niches').then(r => r.json()).then(data => {
      setNiches(data.niches || []);
      // Functional setter so a parallel schedule-link prefill that resolved
      // first isn't clobbered by the default-first-niche.
      if (data.niches?.length) setNiche(curr => curr || data.niches[0].name);
    }).catch(() => {});
  }, []);

  // Tracks whether the user has manually changed `partNumber` since mount.
  // Without this, a fast schedule fetch could overwrite a value the user just
  // typed (initial state `1` is indistinguishable from "user typed 1").
  const partNumberDirtyRef = useRef(false);

  // Schedule-link preload: when launched from a schedule item (typically a
  // "next part of this series" intent), seed the niche and series linkage so
  // generated ideas slot directly into the existing arc. Skips the script
  // fetch — Ideas never uses the script body.
  useEffect(() => {
    if (!scheduleItemId || schedulePrefilled) return;
    let cancelled = false;
    (async () => {
      const item = await fetchScheduleItem(scheduleItemId);
      if (cancelled || !item) return;
      setScheduleItem(item);
      setSchedulePrefilled(true);
      const ctx = await loadFullContextForItem(item, { withScript: false });
      if (cancelled) return;
      if (ctx.niche) setNiche(curr => curr || ctx.niche);
      if (ctx.series) {
        setSeriesId(curr => curr || ctx.series!.id);
        setSeriesTitle(curr => curr || ctx.series!.title);
        // Suggest the *next* part as the starting number — an idea generated
        // from a series item is almost always a continuation. Only auto-set
        // if the user hasn't touched the field (dirty ref guards against the
        // race where the user typed during the fetch).
        if (!partNumberDirtyRef.current) setPartNumber(ctx.series.partNumber + 1);
      }
      toast.message(`Loaded context from "${item.title || 'schedule item'}"`);
    })();
    return () => { cancelled = true; };
  }, [scheduleItemId, schedulePrefilled]);

  // Analyzer flywheel prefill (Phase 2 of _plans/2026-05-19-analyzer-
  // as-input-source.md). Runs on mount when `?from=analyzer&analysisId=`
  // is present. Fetches the analyzer row, synthesises a reference
  // context block from its strategic report + chapters + style packs,
  // and stores it on `analyzerContext` to be prepended into refContext
  // at generate time. A banner above the niche picker surfaces the
  // active analyzer source so the operator knows ideas will be biased
  // by the analyzed video's identity.
  const [analyzerContext, setAnalyzerContext] = useState<{ analysisId: string; source: string; block: string } | null>(null);
  const [analyzerPrefillApplied, setAnalyzerPrefillApplied] = useState(false);
  useEffect(() => {
    if (analyzerPrefillApplied) return;
    if (search.get('from') !== 'analyzer') return;
    const analysisId = search.get('analysisId');
    if (!analysisId) return;
    setAnalyzerPrefillApplied(true);
    (async () => {
      try {
        const res = await fetch(`/api/analyze/youtube-video/${analysisId}`);
        if (!res.ok) {
          toast.error('Could not load analyzer context', {
            description: `Server returned ${res.status}. The analyzer link may have expired.`,
          });
          return;
        }
        const data = (await res.json()) as {
          id: string;
          videoTitle: string | null;
          channelTitle: string | null;
          result: {
            meta?: { title?: string; channel?: string; duration_seconds?: number };
            transcript?: { chapters?: Array<{ title: string }> };
            style_packs?: Array<{ label?: string; overall_look?: string }>;
            strategic_report?: {
              hook?: { what_works?: string };
              structure?: string;
              standout_techniques?: string[];
            };
          } | null;
        };
        if (!data.result) {
          toast.error('Analyzer row had no usable result');
          return;
        }
        const block = buildAnalyzerReferenceBlock(data);
        const sourceLabel = data.videoTitle || data.result?.meta?.title || data.id;
        setAnalyzerContext({ analysisId: data.id, source: sourceLabel, block });
        toast.message(`Loaded analyzer reference: "${sourceLabel}"`, {
          description: 'Ideas will draw from this video\'s hook, structure, and visual identity.',
        });
      } catch (err) {
        toast.error('Failed to load analyzer context', {
          description: err instanceof Error ? err.message : 'network error',
        });
      }
    })();
  }, [search, analyzerPrefillApplied]);

  // Niche-finder flywheel prefill (Phase 13.2.F). Runs on mount when
  // ?from=niche-finder is present. Reads the `niche` query param +
  // sessionStorage entry written by GenerateIdeasButton, sets the
  // niche, and surfaces a toast so the user knows the prefill came
  // from a different surface.
  const [nichePrefillApplied, setNichePrefillApplied] = useState(false);
  useEffect(() => {
    if (nichePrefillApplied) return;
    if (search.get('from') !== 'niche-finder') return;
    const queryNiche = search.get('niche');
    if (queryNiche) {
      setNiche((curr) => curr || queryNiche);
    }
    try {
      const raw = sessionStorage.getItem('niche-finder:ideas-prefill');
      if (raw) {
        const parsed = JSON.parse(raw) as { niche?: string; capturedAt?: string };
        const age = parsed.capturedAt ? Date.now() - Date.parse(parsed.capturedAt) : Number.POSITIVE_INFINITY;
        if (Number.isFinite(age) && age < 10 * 60 * 1000 && parsed.niche) {
          setNiche((curr) => curr || parsed.niche!);
          toast.message(`Loaded niche "${parsed.niche}" from the niche finder`);
        }
        sessionStorage.removeItem('niche-finder:ideas-prefill');
      } else if (queryNiche) {
        toast.message(`Loaded niche "${queryNiche}" from the niche finder`);
      }
    } catch {
      // sessionStorage parse errors are non-fatal — the niche
      // query-string fallback above already populated state.
    }
    setNichePrefillApplied(true);
  }, [search, nichePrefillApplied]);

  // Load the persisted idea library
  useEffect(() => {
    (async () => {
      setLibraryLoading(true);
      try {
        const res = await fetch('/api/ideas?limit=100');
        if (res.ok) {
          const data = await res.json();
          setLibrary(data.ideas || []);
        }
      } catch { /* ignore */ }
      finally { setLibraryLoading(false); }
    })();
  }, []);

  async function deleteFromLibrary(id: string) {
    if (!confirm('Remove this saved idea?')) return;
    setDeletingLibId(id);
    try {
      const res = await fetch(`/api/ideas/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      setLibrary(prev => prev.filter(i => i.id !== id));
      toast.success('Removed from library');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingLibId(null);
    }
  }

  function sendSavedToGenerator(row: SavedIdeaRow) {
    try {
      localStorage.setItem('generator_prefill', JSON.stringify({
        topic: row.title,
        niche: row.niche || niche,
        context: `Hook: ${row.hook}\n\n${row.description}`,
      }));
      window.location.href = '/generator';
    } catch { toast.error('Handoff failed'); }
  }

  async function addReference() {
    if (!refUrl.trim()) return;
    const url = refUrl.trim();
    if (refs.length >= 5) { toast.error('Maximum 5 reference videos allowed'); return; }
    if (!/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/.test(url)) {
      toast.error('Please enter a valid YouTube URL');
      return;
    }
    setRefUrl('');
    const refId = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setRefs(prev => [...prev, { id: refId, url, title: 'Loading...', channelTitle: '', viewCount: 0, thumbnailUrl: '', styleAnalysis: null, analysis: null, loading: true }]);

    try {
      // Only fetch metadata — NO deep AI analysis yet (that happens at generate time)
      const res = await fetch('/api/youtube/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),  // no modelId → skips AI analysis
      });
      if (!res.ok) throw new Error('Failed to fetch video data');
      const data = await res.json();
      setRefs(prev => prev.map(r => r.id === refId ? {
        id: refId, url,
        title: data.metadata.title,
        channelTitle: data.metadata.channelTitle,
        viewCount: data.metadata.viewCount,
        thumbnailUrl: data.metadata.thumbnailUrl,
        styleAnalysis: null,
        analysis: null,
        loading: false,
      } : r));
      toast.success(`Added: ${data.metadata.title.slice(0, 50)}`);
    } catch {
      setRefs(prev => prev.filter(r => r.id !== refId));
      toast.error('Failed to load video');
    }
  }

  const [genStep, setGenStep] = useState('');

  async function generateIdeas() {
    if (!niche.trim()) { toast.error('Please select a niche'); return; }
    setGenerating(true);
    setIdeas([]);
    setSavedIds(new Set());

    const activeRefs = refs.filter(r => !r.loading);
    let refContext = '';
    let redditContext: string | undefined;

    try {
      // STEP 1: Deep-analyze reference videos (if any)
      if (activeRefs.length > 0) {
        setGenStep(`Analyzing ${activeRefs.length} reference video${activeRefs.length > 1 ? 's' : ''} (visuals, transcript, pacing)...`);
        const analyses = await Promise.all(
          activeRefs.map(async (ref, idx) => {
            setGenStep(`Analyzing video ${idx + 1}/${activeRefs.length}: "${ref.title.slice(0, 40)}..."`);
            try {
              const res = await fetch('/api/youtube/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: ref.url, modelId }),
              });
              if (!res.ok) return null;
              const data = await res.json();
              // Update the ref with analysis results for display
              setRefs(prev => prev.map(r => r.id === ref.id ? {
                ...r,
                styleAnalysis: data.styleAnalysis,
                analysis: data.analysis || null,
              } : r));
              return { title: ref.title, channelTitle: ref.channelTitle, viewCount: ref.viewCount, styleAnalysis: data.styleAnalysis };
            } catch { return null; }
          }),
        );

        refContext = analyses.filter(Boolean).map((a, idx) =>
          `### REFERENCE VIDEO ${idx + 1}: "${a!.title}" by ${a!.channelTitle} (${a!.viewCount.toLocaleString()} views)\n${a!.styleAnalysis}`
        ).join('\n\n---\n\n');
      }

      // Prepend the deep-analyzer reference block if this generation
      // was deep-linked from /analyze/[id] via ?from=analyzer. The
      // block is built once at prefill time (the useEffect above) so
      // we don't re-fetch on every generate.
      if (analyzerContext) {
        refContext = refContext
          ? `${analyzerContext.block}\n\n---\n\n${refContext}`
          : analyzerContext.block;
      }

      // STEP 2: Scrape Reddit (if enabled)
      if (useReddit) {
        setGenStep('Scraping Reddit discussions and top comments...');
        try {
          const subs = redditSubs.split(',').map(s => s.trim()).filter(Boolean);
          const redditRes = await fetch('/api/research/reddit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ niche, subreddits: subs.length > 0 ? subs : undefined, limit: 25 }),
          });
          if (redditRes.ok) {
            const data = await redditRes.json();
            redditContext = data.summary || undefined;
            const count = data.totalFound || 0;
            if (redditContext && count > 0) {
              toast.success(`Found ${count} Reddit discussions`);
              setGenStep(`Found ${count} Reddit posts — generating ideas with Reddit insights...`);
            } else {
              toast.warning(`Reddit returned no results for "${niche}" — Reddit may be blocking. Try adding specific subreddits.`);
            }
          } else if (redditRes.status === 429) {
            toast.warning('Reddit rate limited — wait a minute and try again. Generating without Reddit.');
          } else {
            const errData = await redditRes.json().catch(() => ({}));
            toast.warning(errData.error || 'Reddit fetch failed — generating without Reddit data');
          }
        } catch {
          toast.warning('Reddit connection failed — continuing without Reddit');
        }
      }

      // STEP 3: Generate ideas with all context — pass every title we've
      // already generated (across the full history, this niche AND others)
      // so the LLM never repeats. Server post-filters too as a safety net.
      const existingTitles = collectAllPreviousTitles(ideasHistoryItems);
      // Resolve the saved description/keywords for the currently selected
      // niche row. Match by name (the value in the <select>). When the
      // user disabled "Use niche description", we still pass keywords —
      // they are weaker signals and useful even when the description is
      // intentionally suppressed.
      const selectedNiche = niches.find(n => n.name === niche);
      const resolvedNicheDescription = useNicheDescription
        ? (selectedNiche?.description?.trim() || undefined)
        : undefined;
      const resolvedNicheKeywords = Array.isArray(selectedNiche?.keywords) && selectedNiche!.keywords!.length
        ? selectedNiche!.keywords!
        : undefined;
      setGenStep('Generating ideas from all sources...');
      const res = await fetch('/api/generate/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId, niche, count, audience, focus,
          nicheDescription: resolvedNicheDescription,
          nicheKeywords: resolvedNicheKeywords,
          extraContext: extraContext.trim() || undefined,
          videoType: videoType !== 'any' ? videoType : undefined,
          referenceContext: refContext || undefined,
          redditContext,
          existingTitles,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Generation failed');
      }
      const data = await res.json();
      const generatedIdeas = data.ideas || [];
      setIdeas(generatedIdeas);
      if (generatedIdeas.length > 0) {
        // Save history with the full input context so restore brings it all back.
        const savedIdeasEntry = await saveIdeas({
          niche, focus, videoType, modelId, count, ideas: generatedIdeas,
          audience: audience || undefined,
          usedReddit: useReddit,
          refs: refs.filter(r => !r.loading).map(r => ({
            url: r.url, title: r.title, channelTitle: r.channelTitle, viewCount: r.viewCount,
          })),
          videoTitle: scheduleItem?.title?.trim() || undefined,
          scheduleItemId: scheduleItemId || undefined,
        });
        // Optimistic prepend — see voiceover/generator save handlers.
        setIdeasHistoryItems((prev) => [savedIdeasEntry, ...prev.filter((p) => p.id !== savedIdeasEntry.id)]);
        // Auto-persist all generated ideas to the database. If this generation is
        // linked to a series, tag the ideas with series_id + part_number so the
        // Script Generator can later pick up the right continuity context.
        fetch('/api/ideas/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ideas: generatedIdeas,
            niche,
            seriesId: seriesId || undefined,
            partNumber: seriesId ? partNumber : undefined,
          }),
        }).then(r => r.json()).then(result => {
          if (result.inserted > 0) setSavedIds(new Set(generatedIdeas.map((_: unknown, i: number) => i)));
        }).catch(() => { /* best-effort */ });
      }
      toast.success(`Generated ${generatedIdeas.length} video ideas!`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
      setGenStep('');
    }
  }

  async function saveIdea(idea: VideoIdea, idx: number) {
    try {
      const res = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...idea, niche }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSavedIds(prev => new Set([...prev, idx]));
      toast.success('Idea saved!');
    } catch {
      toast.error('Failed to save idea');
    }
  }

  async function addToSchedule(idea: VideoIdea | SavedIdeaRow, savedId?: string) {
    const title = idea.title;
    const notesParts = [
      'hook' in idea && idea.hook ? `Hook: ${idea.hook}` : null,
      idea.description ? `Description: ${idea.description}` : null,
      'why_it_will_perform' in idea && idea.why_it_will_perform ? `Why it performs: ${idea.why_it_will_perform}` : null,
    ].filter(Boolean).join('\n\n');
    try {
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          notes: notesParts || null,
          tags: Array.isArray(idea.tags) ? idea.tags : [],
          idea_id: savedId || null,
          status: 'idea',
        }),
      });
      if (!res.ok) throw new Error('Failed');
      toast.success('Added to schedule', {
        action: { label: 'View', onClick: () => { window.location.href = '/schedule'; } },
      });
    } catch {
      toast.error('Could not add to schedule');
    }
  }

  function sendToGenerator(idea: VideoIdea) {
    // Store full context in localStorage for the generator to pick up
    const payload: Record<string, unknown> = {
      topic: idea.title,
      niche,
      audience: idea.target_audience_segment || audience || '',
      context: [
        idea.description && `Description: ${idea.description}`,
        idea.why_it_will_perform && `Why it will perform: ${idea.why_it_will_perform}`,
        idea.search_intent && `Search intent: ${idea.search_intent}`,
        idea.competitor_gap && `Competitor gap: ${idea.competitor_gap}`,
        idea.hook && `Hook: ${idea.hook}`,
        idea.thumbnail_concept && `Thumbnail concept: ${idea.thumbnail_concept}`,
      ].filter(Boolean).join('\n'),
      style: idea.content_type === 'explainer' ? 'Explainer'
        : idea.content_type === 'tutorial' ? 'Tutorial'
        : idea.content_type === 'comparison' ? 'Comparison'
        : idea.content_type === 'story' ? 'Story-driven'
        : idea.content_type === 'opinion' ? 'Opinion / Commentary'
        : idea.content_type === 'list' ? 'Top 10 List'
        : undefined,
    };
    // Pass references if any
    if (refs.length > 0) {
      payload.refs = refs.filter(r => !r.loading).map(r => ({
        id: r.id, url: r.url, title: r.title, channelTitle: r.channelTitle,
        viewCount: r.viewCount, thumbnailUrl: r.thumbnailUrl, styleAnalysis: r.styleAnalysis,
        loading: false,
      }));
    }
    localStorage.setItem('generator_prefill', JSON.stringify(payload));
    window.location.href = '/generator?from=ideas';
  }

  function sendToSeo(idea: VideoIdea) {
    localStorage.setItem('seo_prefill', JSON.stringify({
      topic: idea.title,
      niche,
    }));
    window.location.href = '/seo?from=ideas';
  }

  function sendToThumbnails(idea: VideoIdea) {
    localStorage.setItem('thumbnails_prefill', JSON.stringify({
      title: idea.title,
      niche,
      description: idea.description,
    }));
    window.location.href = '/thumbnails?from=ideas';
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {scheduleItem && <ScheduleLinkBanner item={scheduleItem} feature="Idea Generator" />}
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.3), rgba(6,182,212,0.2))', border: '1px solid rgba(16,185,129,0.3)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#10b981' }}>
              <path d="M9 18h6" /><path d="M10 22h4" />
              <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
            </svg>
          </div>
          <span className="badge badge-green">AI Idea Generator</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Video Idea Generator</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Discover high-potential video ideas based on your niche and current trends
        </p>
      </div>

      {/* Saved Ideas Library */}
      <div className="glass rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              📚 Saved Ideas Library ({libraryLoading ? '…' : library.length})
            </span>
            {libraryOpen && library.length > 0 && (
              <input
                className="input-field text-xs"
                style={{ maxWidth: 240 }}
                placeholder="Search saved ideas..."
                value={librarySearch}
                onChange={e => setLibrarySearch(e.target.value)}
              />
            )}
          </div>
          <button
            className="btn-secondary text-xs"
            onClick={() => setLibraryOpen(o => !o)}
            disabled={libraryLoading}
          >
            {libraryOpen ? 'Collapse ▲' : 'Open ▼'}
          </button>
        </div>
        {libraryOpen && (
          <div className="mt-3">
            {library.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Nothing saved yet. Hit ⭐ Save on an idea below, or save ideas from the Competitors page — they all land here.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[500px] overflow-y-auto pr-1">
                {library
                  .filter(row => {
                    const q = librarySearch.trim().toLowerCase();
                    if (!q) return true;
                    return row.title.toLowerCase().includes(q) ||
                      (row.description || '').toLowerCase().includes(q) ||
                      (row.niche || '').toLowerCase().includes(q);
                  })
                  .map(row => (
                    <div key={row.id} className="glass rounded-lg p-3" style={{ borderLeft: '3px solid #10b981' }}>
                      <div className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{row.title}</div>
                      {row.hook && <div className="text-xs mt-1" style={{ color: '#10b981' }}>Hook: {row.hook}</div>}
                      {row.description && <div className="text-xs mt-1 line-clamp-3" style={{ color: 'var(--text-muted)' }}>{row.description}</div>}
                      <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {row.niche && <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>{row.niche}</span>}
                        {row.difficulty && <span>⚙ {row.difficulty}</span>}
                        <span>· {new Date(row.created_at).toLocaleDateString()}</span>
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button className="btn-primary text-xs" onClick={() => sendSavedToGenerator(row)}>✍ Write Script</button>
                        <button className="btn-secondary text-xs" onClick={() => addToSchedule(row, row.id)}>📅 Add to Schedule</button>
                        <button
                          className="btn-secondary text-xs"
                          style={{ color: '#ef4444' }}
                          onClick={() => deleteFromLibrary(row.id)}
                          disabled={deletingLibId === row.id}
                        >
                          {deletingLibId === row.id ? '…' : '✕ Delete'}
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Controls */}
        <div className="glass rounded-xl p-6 space-y-5 h-fit">
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Generator Settings</h2>

          <ModelSelector value={modelId} onChange={setModelId} />

          {analyzerContext && (
            <div
              role="status"
              style={{
                padding: '8px 10px',
                background: 'rgba(124, 58, 237, 0.10)',
                border: '1px solid rgba(124, 58, 237, 0.30)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--text-secondary)',
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <span style={{ flex: 1 }}>
                Bias by analyzer: <strong style={{ color: 'var(--text-primary)' }}>{analyzerContext.source}</strong>
              </span>
              <button
                type="button"
                onClick={() => setAnalyzerContext(null)}
                title="Clear analyzer bias and generate ideas from the niche alone"
                style={{
                  padding: '2px 8px',
                  background: 'transparent',
                  border: '1px solid var(--border-bright)',
                  borderRadius: 4,
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Clear
              </button>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche</label>
            <select value={niche} onChange={e => setNiche(e.target.value)} className="input-field" style={{ appearance: 'none' }}>
              {niches.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
            </select>
            {(() => {
              const selected = niches.find(n => n.name === niche);
              const desc = selected?.description?.trim();
              if (!desc) return null;
              return (
                <div className="mt-2 flex items-start gap-2">
                  <input
                    id="use-niche-description"
                    type="checkbox"
                    checked={useNicheDescription}
                    onChange={e => setUseNicheDescription(e.target.checked)}
                    className="mt-0.5 shrink-0 cursor-pointer"
                  />
                  <label htmlFor="use-niche-description" className="text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                    Use the saved niche description to steer the model
                    <span className="block mt-1 italic" style={{ color: useNicheDescription ? 'var(--text-secondary)' : 'var(--text-muted)', opacity: useNicheDescription ? 1 : 0.6 }}>
                      &quot;{desc.length > 180 ? desc.slice(0, 180) + '...' : desc}&quot;
                    </span>
                  </label>
                </div>
              );
            })()}
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              Number of Ideas: <span style={{ color: 'var(--accent-purple-bright)' }}>{count}</span>
            </label>
            <div className="flex gap-2">
              {[5, 10, 15, 20].map(n => (
                <button key={n} type="button" onClick={() => setCount(n)}
                  className="flex-1 py-2 rounded-lg text-sm font-medium transition-all"
                  style={{
                    background: count === n ? 'rgba(124,58,237,0.2)' : 'var(--bg-secondary)',
                    border: `1px solid ${count === n ? 'var(--accent-purple)' : 'var(--border)'}`,
                    color: count === n ? 'var(--accent-purple-bright)' : 'var(--text-secondary)',
                  }}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Content Focus</label>
            <div className="space-y-1">
              {FOCUS_OPTIONS.map(opt => (
                <button key={opt.id} type="button" onClick={() => setFocus(opt.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all"
                  style={{
                    background: focus === opt.id ? 'rgba(124,58,237,0.15)' : 'transparent',
                    color: focus === opt.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}>
                  <span>{opt.emoji}</span>
                  <span className="text-sm">{opt.label}</span>
                  {focus === opt.id && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-purple-bright)" strokeWidth="2.5" className="ml-auto">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Video Type</label>
            <div className="space-y-1">
              {(showAllTypes ? VIDEO_TYPES : VIDEO_TYPES.slice(0, 6)).map(vt => (
                <button key={vt.id} type="button" onClick={() => setVideoType(vt.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all"
                  style={{
                    background: videoType === vt.id ? 'rgba(6,182,212,0.15)' : 'transparent',
                    color: videoType === vt.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}>
                  <span className="text-sm">{vt.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm">{vt.label}</span>
                    {videoType === vt.id && (
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{vt.desc}</p>
                    )}
                  </div>
                  {videoType === vt.id && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan-bright)" strokeWidth="2.5" className="shrink-0">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
              {!showAllTypes && (
                <button onClick={() => setShowAllTypes(true)} className="w-full text-xs py-1.5 rounded-lg transition-all"
                  style={{ color: 'var(--accent-cyan-bright)' }}>
                  Show {VIDEO_TYPES.length - 6} more types...
                </button>
              )}
              {showAllTypes && (
                <button onClick={() => setShowAllTypes(false)} className="w-full text-xs py-1.5 rounded-lg transition-all"
                  style={{ color: 'var(--text-muted)' }}>
                  Show less
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              Audience <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
            </label>
            <input value={audience} onChange={e => setAudience(e.target.value)}
              placeholder="e.g. small business owners, beginners..."
              className="input-field" />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              Extra Context <span style={{ color: 'var(--text-muted)' }}>(optional, this run only)</span>
            </label>
            <textarea
              value={extraContext}
              onChange={e => setExtraContext(e.target.value)}
              placeholder="Anything else the model should know for THIS batch: a specific angle, a current event to tie into, a mood, a campaign you're running. Takes priority over the niche description when they conflict."
              rows={4}
              className="input-field"
              style={{ resize: 'vertical', minHeight: 90, fontFamily: 'inherit', lineHeight: 1.5 }}
            />
            {extraContext.trim() && (
              <p className="text-xs mt-1" style={{ color: 'var(--accent-cyan-bright)' }}>
                {extraContext.trim().length} characters will be sent with this generation
              </p>
            )}
          </div>

          {/* Reference Videos */}
          <div>
            <button onClick={() => setShowRefs(!showRefs)}
              className="flex items-center gap-2 text-sm font-medium w-full"
              style={{ color: refs.length > 0 ? 'var(--accent-cyan-bright)' : 'var(--text-secondary)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ transform: showRefs ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                <path d="M9 18l6-6-6-6" />
              </svg>
              🎬 Reference Videos {refs.length > 0 && <span className="badge badge-purple text-xs">{refs.length}</span>}
            </button>
            <AnimatePresence>
              {showRefs && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden">
                  <div className="mt-3 space-y-2">
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Add YouTube videos as references — deep analysis runs when you click Generate
                    </p>
                    <div className="flex gap-2">
                      <input value={refUrl} onChange={e => setRefUrl(e.target.value)}
                        placeholder="https://youtube.com/watch?v=..."
                        className="input-field flex-1" style={{ fontSize: 12, padding: '6px 10px' }}
                        onKeyDown={e => e.key === 'Enter' && addReference()} />
                      <button onClick={addReference} disabled={!refUrl.trim()} className="btn-primary text-xs px-3 py-1.5">
                        Add
                      </button>
                    </div>
                    {refs.map(ref => (
                      <div key={ref.id} className="p-2 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                        <div className="flex items-center gap-2">
                          {ref.thumbnailUrl && <img src={ref.thumbnailUrl} alt="" width={64} height={36} className="w-16 h-9 rounded object-cover shrink-0" />}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                              {ref.loading ? 'Loading...' : ref.title}
                            </p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {ref.loading ? (
                                <span className="flex items-center gap-1">
                                  <span className="spinner inline-block" style={{ width: 10, height: 10 }} />
                                  Fetching video info...
                                </span>
                              ) : (
                                <>
                                  {ref.channelTitle} · {ref.viewCount.toLocaleString()} views
                                  {ref.styleAnalysis ? (
                                    <span className="ml-1 badge badge-green text-[9px]">Analyzed</span>
                                  ) : (
                                    <span className="ml-1 badge badge-purple text-[9px]">Will analyze on generate</span>
                                  )}
                                </>
                              )}
                            </p>
                          </div>
                          <button onClick={() => setRefs(prev => prev.filter(r => r.id !== ref.id))} className="text-xs shrink-0" style={{ color: '#ef4444' }}>×</button>
                        </div>
                        {/* Quick insight from analysis */}
                        {ref.analysis && typeof (ref.analysis as Record<string, unknown>).what_makes_it_work === 'string' && (
                          <p className="mt-1 text-[11px] italic" style={{ color: 'var(--accent-cyan-bright)' }}>
                            &quot;{String((ref.analysis as Record<string, unknown>).what_makes_it_work)}&quot;
                          </p>
                        )}
                        {ref.styleAnalysis && (
                          <details className="mt-2">
                            <summary className="text-xs cursor-pointer font-medium" style={{ color: 'var(--accent-purple-bright)' }}>View deep analysis</summary>
                            <pre className="text-xs mt-1 whitespace-pre-wrap" style={{ color: 'var(--text-secondary)', maxHeight: 200, overflow: 'auto' }}>{ref.styleAnalysis}</pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Reddit toggle */}
          <div className="p-3 rounded-lg" style={{ background: useReddit ? 'rgba(255,69,0,0.08)' : 'var(--bg-secondary)', border: `1px solid ${useReddit ? 'rgba(255,69,0,0.25)' : 'var(--border)'}`, transition: 'all 0.2s' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm">🔍</span>
                <div>
                  <p className="text-sm font-medium" style={{ color: useReddit ? 'var(--text-primary)' : 'var(--text-secondary)' }}>Include Reddit</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Scrape trending discussions for inspiration</p>
                </div>
              </div>
              <button
                onClick={() => setUseReddit(!useReddit)}
                className="relative w-10 h-5 rounded-full transition-all shrink-0"
                style={{ background: useReddit ? '#ff4500' : 'var(--bg-card)' }}
              >
                <span className="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all"
                  style={{ left: useReddit ? 22 : 2 }} />
              </button>
            </div>
            {useReddit && (
              <input value={redditSubs} onChange={e => setRedditSubs(e.target.value)}
                placeholder="Subreddits (optional, e.g. cybersecurity, netsec)"
                className="input-field mt-3" style={{ fontSize: 12, padding: '6px 10px' }} />
            )}
          </div>

          {/* Series linkage — tag generated ideas as parts of a named series. */}
          <div className="glass rounded-xl p-4">
            <SeriesPicker
              seriesId={seriesId}
              partNumber={partNumber}
              niche={niche}
              onChange={({ seriesId: id, seriesTitle: t, partNumber: p }) => {
                setSeriesId(id);
                if (t !== undefined) setSeriesTitle(t);
                if (p !== partNumber) partNumberDirtyRef.current = true;
                setPartNumber(p);
              }}
            />
            {seriesId && (
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                Ideas generated here will be saved as Parts {partNumber}–{partNumber + count - 1} of &quot;{seriesTitle}&quot;.
              </p>
            )}
          </div>

          <button onClick={generateIdeas} disabled={generating || !niche.trim()}
            className="btn-primary w-full justify-center" style={{ width: '100%', justifyContent: 'center' }}>
            {generating ? (
              <><div className="spinner" style={{ width: 16, height: 16 }} />Generating...</>
            ) : (
              <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>Generate {count} Ideas</>
            )}
          </button>
          {generating && genStep && (
            <p className="text-xs text-center mt-2 animate-pulse" style={{ color: 'var(--accent-cyan-bright)' }}>
              {genStep}
            </p>
          )}
        </div>

        {/* Ideas grid */}
        <div>
          {generating && (
            <div className="glass rounded-xl h-64 flex items-center justify-center">
              <div className="text-center">
                <div className="spinner mx-auto mb-4" style={{ width: 32, height: 32 }} />
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Finding high-potential ideas...</p>
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Analyzing niche, trends, and search intent</p>
              </div>
            </div>
          )}

          {!generating && ideas.length === 0 && (
            <div className="glass rounded-xl h-64 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
              <div className="text-center">
                <div className="text-5xl mb-4">💡</div>
                <p className="text-sm">Configure your niche and click Generate</p>
              </div>
            </div>
          )}

          {ideas.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {ideas.length} ideas generated
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {savedIds.size} saved
                </span>
              </div>
              <motion.div
                initial="hidden"
                animate="show"
                variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
                className="space-y-3"
              >
                {ideas.map((idea, idx) => {
                  const trendStyle = TREND_BADGES[idea.trend_status] || TREND_BADGES.evergreen;
                  const viewsColor = VIEWS_COLORS[idea.estimated_views_potential] || '#6b7280';
                  const isExpanded = expandedIdx === idx;
                  const isSaved = savedIds.has(idx);

                  return (
                    <motion.div
                      key={idx}
                      variants={{ hidden: { opacity: 0, y: 15 }, show: { opacity: 1, y: 0 } }}
                      className="glass rounded-xl overflow-hidden"
                      style={{ border: '1px solid var(--border)' }}
                    >
                      <div
                        className="p-5 cursor-pointer"
                        onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <span className="text-xs px-2 py-0.5 rounded-full"
                                style={{ background: trendStyle.bg, color: trendStyle.color }}>
                                {idea.trend_status}
                              </span>
                              <span className="text-xs px-2 py-0.5 rounded-full"
                                style={{ background: 'rgba(255,255,255,0.05)', color: viewsColor }}>
                                {idea.estimated_views_potential} potential
                              </span>
                              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {idea.content_type} · {idea.estimated_difficulty}
                              </span>
                            </div>
                            <h3 className="font-semibold text-sm leading-snug" style={{ color: 'var(--text-primary)' }}>
                              {idea.title}
                            </h3>
                            <p className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                              {idea.hook}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={e => { e.stopPropagation(); isSaved ? undefined : saveIdea(idea, idx); }}
                              className="p-2 rounded-lg transition-all"
                              style={{
                                background: isSaved ? 'rgba(16,185,129,0.15)' : 'var(--bg-secondary)',
                                border: `1px solid ${isSaved ? 'rgba(16,185,129,0.3)' : 'var(--border)'}`,
                                color: isSaved ? '#10b981' : 'var(--text-muted)',
                              }}
                              title={isSaved ? 'Saved' : 'Save idea'}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                              </svg>
                            </button>
                            <button
                              onClick={e => { e.stopPropagation(); sendToGenerator(idea); }}
                              className="p-2 rounded-lg transition-all"
                              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                              title="Generate script for this idea"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                              </svg>
                            </button>
                            <svg
                              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                              style={{ color: 'var(--text-muted)', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
                            >
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </div>
                        </div>
                      </div>

                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            style={{ borderTop: '1px solid var(--border)', overflow: 'hidden' }}
                          >
                            <div className="p-5 space-y-4">
                              {/* Performance data strip */}
                              {idea.confidence_score != null && (
                                <div className="flex items-center gap-4 p-3 rounded-lg mb-3"
                                  style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)' }}>
                                  <div className="text-center">
                                    <div className="text-xl font-bold" style={{ color: 'var(--accent-purple-bright)' }}>{idea.confidence_score}/10</div>
                                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Confidence</div>
                                  </div>
                                  {idea.best_time_to_publish && (
                                    <div>
                                      <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Best Time to Publish</div>
                                      <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{idea.best_time_to_publish}</div>
                                    </div>
                                  )}
                                </div>
                              )}

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="md:col-span-2">
                                  <h4 className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>📊 Why It Will Perform</h4>
                                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{idea.why_it_will_perform}</p>
                                </div>

                                {/* Performance Breakdown */}
                                {idea.performance_breakdown && (
                                  <div className="md:col-span-2 p-3 rounded-lg space-y-2"
                                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                                    <h4 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>📈 Data-Driven Breakdown</h4>
                                    <div className="grid grid-cols-2 gap-3">
                                      {idea.performance_breakdown.search_volume && (
                                        <div>
                                          <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan-bright)' }}>Search Volume: </span>
                                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{idea.performance_breakdown.search_volume}</span>
                                        </div>
                                      )}
                                      {idea.performance_breakdown.competition_level && (
                                        <div>
                                          <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan-bright)' }}>Competition: </span>
                                          <span className="text-xs capitalize" style={{
                                            color: idea.performance_breakdown.competition_level === 'low' ? '#10b981' :
                                                   idea.performance_breakdown.competition_level === 'medium' ? '#f59e0b' : '#ef4444'
                                          }}>{idea.performance_breakdown.competition_level}</span>
                                        </div>
                                      )}
                                      {idea.performance_breakdown.monetization_potential && (
                                        <div className="col-span-2">
                                          <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan-bright)' }}>Monetization: </span>
                                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{idea.performance_breakdown.monetization_potential}</span>
                                        </div>
                                      )}
                                      {idea.performance_breakdown.historical_evidence && (
                                        <div className="col-span-2">
                                          <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan-bright)' }}>Historical Evidence: </span>
                                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{idea.performance_breakdown.historical_evidence}</span>
                                        </div>
                                      )}
                                      {(idea.performance_breakdown.virality_factors?.length ?? 0) > 0 && (
                                        <div className="col-span-2">
                                          <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan-bright)' }}>Virality Factors: </span>
                                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{(idea.performance_breakdown.virality_factors ?? []).join(' · ')}</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}

                                <div>
                                  <h4 className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Search Intent</h4>
                                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{idea.search_intent}</p>
                                </div>
                                <div>
                                  <h4 className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Target Segment</h4>
                                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{idea.target_audience_segment}</p>
                                </div>
                                <div>
                                  <h4 className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Competitor Gap</h4>
                                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{idea.competitor_gap}</p>
                                </div>
                                <div>
                                  <h4 className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Thumbnail Concept</h4>
                                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{idea.thumbnail_concept}</p>
                                </div>
                              </div>

                              {/* Inspiration Sources — with detailed attribution */}
                              {idea.inspiration_sources && (
                                (Array.isArray(idea.inspiration_sources.from_reference_videos) ? idea.inspiration_sources.from_reference_videos.length > 0 : !!idea.inspiration_sources.from_reference_videos) ||
                                (Array.isArray(idea.inspiration_sources.from_reddit) ? idea.inspiration_sources.from_reddit.length > 0 : !!idea.inspiration_sources.from_reddit)
                              ) && (
                                <div className="p-3 rounded-lg space-y-2"
                                  style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
                                  <h4 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--accent-cyan-bright)' }}>
                                    🔗 Inspiration Sources & Attribution
                                  </h4>
                                  {idea.inspiration_sources.from_reference_videos && (Array.isArray(idea.inspiration_sources.from_reference_videos) ? idea.inspiration_sources.from_reference_videos.length > 0 : true) && (
                                    <div className="space-y-1.5">
                                      <p className="text-xs font-semibold mb-1" style={{ color: 'var(--accent-purple-bright)' }}>From Reference Videos:</p>
                                      {Array.isArray(idea.inspiration_sources.from_reference_videos) ? (
                                        (idea.inspiration_sources.from_reference_videos as unknown as Array<{ video_title?: string; techniques_borrowed?: string; how_adapted?: string }>).map((src, si) => (
                                          <div key={si} className="p-2 rounded" style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.12)' }}>
                                            {src.video_title && (
                                              <p className="text-xs font-semibold" style={{ color: 'var(--accent-purple-bright)' }}>
                                                From: &quot;{src.video_title}&quot;
                                              </p>
                                            )}
                                            {src.techniques_borrowed && (
                                              <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                                <strong>Techniques:</strong> {src.techniques_borrowed}
                                              </p>
                                            )}
                                            {src.how_adapted && (
                                              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                                <strong>Adapted:</strong> {src.how_adapted}
                                              </p>
                                            )}
                                          </div>
                                        ))
                                      ) : (
                                        /* Handle old string format */
                                        <div>
                                          <span className="text-xs font-semibold" style={{ color: 'var(--accent-purple-bright)' }}>From Reference Videos: </span>
                                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{idea.inspiration_sources.from_reference_videos as unknown as string}</span>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  {idea.inspiration_sources.from_reddit && (Array.isArray(idea.inspiration_sources.from_reddit) ? idea.inspiration_sources.from_reddit.length > 0 : true) && (
                                    <div className="space-y-1.5">
                                      <p className="text-xs font-semibold mb-1" style={{ color: '#ff4500' }}>From Reddit:</p>
                                      {Array.isArray(idea.inspiration_sources.from_reddit) ? (
                                        (idea.inspiration_sources.from_reddit as Array<{ post_title?: string; post_url?: string; subreddit?: string; what_was_taken?: string; how_adapted?: string }>).map((src, si) => (
                                          <div key={si} className="p-2 rounded" style={{ background: 'rgba(255,69,0,0.06)', border: '1px solid rgba(255,69,0,0.12)' }}>
                                            <p className="text-xs font-semibold" style={{ color: '#ff4500' }}>
                                              {src.subreddit && <span className="mr-1">r/{src.subreddit}</span>}
                                              {src.post_url && src.post_url.startsWith('https://') ? (
                                                <a href={src.post_url} target="_blank" rel="noopener noreferrer"
                                                  className="underline hover:opacity-80" style={{ color: '#ff4500' }}>
                                                  &quot;{src.post_title}&quot;
                                                </a>
                                              ) : (
                                                <span>&quot;{src.post_title}&quot;</span>
                                              )}
                                            </p>
                                            {src.what_was_taken && (
                                              <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                                <strong>Insight:</strong> {src.what_was_taken}
                                              </p>
                                            )}
                                            {src.how_adapted && (
                                              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                                <strong>Adapted:</strong> {src.how_adapted}
                                              </p>
                                            )}
                                          </div>
                                        ))
                                      ) : (
                                        <div>
                                          <span className="text-xs font-semibold" style={{ color: '#ff4500' }}>From Reddit: </span>
                                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{idea.inspiration_sources.from_reddit as string}</span>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                              {idea.tags?.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                  {idea.tags.map((tag, t) => (
                                    <span key={t} className="badge badge-purple text-xs">#{tag}</span>
                                  ))}
                                </div>
                              )}
                              <button
                                onClick={() => sendToGenerator(idea)}
                                className="btn-primary text-sm"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                                </svg>
                                Generate Script for This Idea
                              </button>
                              <button onClick={() => addToSchedule(idea)} className="btn-secondary text-xs px-3 py-1.5">
                                📅 Add to Schedule
                              </button>
                              <button onClick={() => sendToSeo(idea)} className="btn-secondary text-xs px-3 py-1.5">
                                🔍 Optimize SEO
                              </button>
                              <button onClick={() => sendToThumbnails(idea)} className="btn-secondary text-xs px-3 py-1.5">
                                🎨 Generate Thumbnail
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  );
                })}
              </motion.div>
            </>
          )}
        </div>
      </div>

      {/* History panel */}
      <HistoryPanel
        title="Ideas History"
        icon="💡"
        accentColor="#10b981"
        items={ideasHistoryItems.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: e.videoTitle || `${e.niche} — ${e.ideas.length} ideas`,
          sublabel: e.videoTitle
            ? `${e.niche} · ${e.ideas.length} ideas · ${e.focus} · ${e.videoType || 'any'}`
            : `${e.focus} · ${e.videoType || 'any'} · ${e.count} requested`,
          preview: e.ideas.slice(0, 3).map(i => (i as Record<string, string>).title || '').join(' | '),
        }))}
        onRestore={restoreIdeas}
        onDelete={handleDeleteIdeas}
        onClearAll={handleClearIdeas}
      />
    </div>
  );
}

/**
 * Synthesise a reference-context block from a deep-analyzer row so the
 * idea generator can be biased by an analyzed video's identity. Picks
 * the load-bearing fields: hook, structure, standout techniques,
 * chapter outline, and the visual identity from style packs. Format
 * mirrors the existing per-reference-video block so the LLM treats it
 * the same way at prompt time.
 */
function buildAnalyzerReferenceBlock(data: {
  videoTitle: string | null;
  channelTitle: string | null;
  result: {
    meta?: { title?: string; channel?: string; duration_seconds?: number };
    transcript?: { chapters?: Array<{ title: string }> };
    style_packs?: Array<{ label?: string; overall_look?: string }>;
    strategic_report?: {
      hook?: { what_works?: string };
      structure?: string;
      standout_techniques?: string[];
    };
  } | null;
}): string {
  const r = data.result;
  const title = data.videoTitle || r?.meta?.title || 'Analyzed video';
  const channel = data.channelTitle || r?.meta?.channel || 'unknown channel';
  const duration = r?.meta?.duration_seconds;
  const hookWorks = r?.strategic_report?.hook?.what_works?.trim();
  const structure = r?.strategic_report?.structure?.trim();
  const techniques = (r?.strategic_report?.standout_techniques ?? []).filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  const chapters = (r?.transcript?.chapters ?? []).map((c) => c.title).filter(Boolean);
  const styleLines = (r?.style_packs ?? [])
    .filter((p) => p.label && p.overall_look)
    .map((p) => `- ${p.label}: ${p.overall_look}`);

  const lines: string[] = [
    `### ANALYZER REFERENCE: "${title}" by ${channel}${duration ? ` (${duration}s)` : ''}`,
  ];
  if (hookWorks) lines.push('', '**Hook (what works):**', hookWorks);
  if (structure) lines.push('', '**Narrative structure:**', structure);
  if (techniques.length) {
    lines.push('', '**Standout techniques:**');
    for (const t of techniques) lines.push(`- ${t}`);
  }
  if (chapters.length) {
    lines.push('', '**Chapter outline:**');
    for (const c of chapters) lines.push(`- ${c}`);
  }
  if (styleLines.length) {
    lines.push('', '**Visual identity:**', ...styleLines);
  }
  return lines.join('\n');
}
