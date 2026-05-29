'use client';

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { getRecentNiches, primeHistoryCaches } from '@/lib/history';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';

interface Candidate {
  name: string;
  handle: string;
  category?: string;
  naming_technique?: string;
  seo_score: number;
  brand_score: number;
  memorability_score: number;
  pronounceability: string;
  search_intent_match?: string;
  semantic_territory?: string[];
  keyword_coverage: string[];
  phonetic_pattern?: string;
  visual_mental_image?: string;
  reasoning: string;
  tagline_suggestion?: string;
  domain_check_note?: string;
  social_handle_consistency?: string;
  risks: string;
  rejected_alternatives?: string[];
  available: boolean;
  takenBy?: { id: string; title: string; thumbnail?: string };
  checkError?: string;
  availabilityNote?: string;
  combinedScore: number;
  /** Client-only: which generation batch this came from */
  batch?: number;
  /** Client-only: saved row id if persisted */
  savedId?: string;
}

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  'safe-descriptive': { label: 'Safe', color: '#10b981' },
  'brandable-evocative': { label: 'Brandable', color: '#f59e0b' },
  'bold-distinctive': { label: 'Bold', color: '#ef4444' },
  'short-power': { label: 'Short power', color: '#a78bfa' },
};

interface SavedName {
  id: string;
  name: string;
  handle: string;
  niche: string;
  combined_score: number;
  seo_score: number;
  brand_score: number;
  memorability_score: number;
  reasoning: string;
  was_available: boolean | null;
  saved_at: string;
}

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 1s linear infinite' }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeLinecap="round" />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </svg>
  );
}

/**
 * Resize image client-side before base64-encoding to stay well under Vercel's
 * 4.5 MB body limit. Target: max 1024px on longest side, JPEG quality 0.82.
 * Typical 4 MB phone photo → ~250 KB output.
 */
async function resizeAndEncode(file: File, maxSide = 1024, quality = 0.82): Promise<{ base64: string; mimeType: string; previewUrl: string; bytes: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = URL.createObjectURL(file);
  });

  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unsupported');
  ctx.drawImage(img, 0, 0, w, h);

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', quality);
  });
  const buf = await blob.arrayBuffer();
  const bytes = buf.byteLength;
  let binary = '';
  const arr = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  const base64 = btoa(binary);

  // Free original object URL; caller gets a new preview URL for the resized blob
  URL.revokeObjectURL(img.src);
  const previewUrl = URL.createObjectURL(blob);
  return { base64, mimeType: 'image/jpeg', previewUrl, bytes };
}

/** Workspace competitor as returned by GET /api/competitors — only the
 *  fields the picker needs. `hasAnalysis` is derived client-side from
 *  `latest_deep_analysis_at` so the picker can show an "analyzed ✓" badge.
 */
interface PickerCompetitor {
  id: string;
  title: string;
  thumbnail_url: string;
  subscriber_count: number;
  hasAnalysis: boolean;
}

interface SeededFromInfo {
  competitorId: string;
  title: string;
  thumbnail: string | null;
  hasAnalysis: boolean;
  analyzedAt: string | null;
}

interface NamingContextPayload {
  channel: { id: string; title: string; handle: string | null; subs: number; thumbnail_url: string | null };
  topVideoUrls: string[];
  namingSeed: {
    niche: string;
    freeText: string;
    referenceImages: { base64: string; mimeType: string; previewUrl: string }[];
  };
  hasAnalysis: boolean;
  analyzedAt: string | null;
}

export default function ChannelNamingPageWrapper() {
  // useSearchParams() requires a Suspense boundary in App Router — same
  // pattern as src/app/(app)/thumbnails/page.tsx.
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <ChannelNamingPage />
    </Suspense>
  );
}

function ChannelNamingPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('channel-naming'));
  const [niche, setNiche] = useState('');
  const [nicheHints, setNicheHints] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const [videoInput, setVideoInput] = useState('');
  const [refVideos, setRefVideos] = useState<string[]>([]);
  const [refImages, setRefImages] = useState<{ base64: string; mimeType: string; preview: string }[]>([]);
  const [count, setCount] = useState(20);
  const [generating, setGenerating] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [batchNum, setBatchNum] = useState(0);
  const [stats, setStats] = useState<{ allChecked: number; availableCount: number; refVideosUsed?: number; refVideosFailed?: string[]; availabilityCaveat?: string } | null>(null);

  // Competitor bridge — surfaces A (URL prefill), B (picker), and C
  // (inline panel on competitor page → navigates here).
  const [sourceCompetitorId, setSourceCompetitorId] = useState<string | null>(null);
  const [seededFrom, setSeededFrom] = useState<SeededFromInfo | null>(null);
  const [hydratingCompetitor, setHydratingCompetitor] = useState(false);
  const [competitorsList, setCompetitorsList] = useState<PickerCompetitor[]>([]);
  // Cancel out-of-order responses if the user switches competitors mid-fetch.
  const hydrationSeqRef = useRef(0);

  // Saved
  const [saved, setSaved] = useState<SavedName[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savingHandle, setSavingHandle] = useState<string | null>(null);

  // Manual handle/name check
  const [manualHandle, setManualHandle] = useState('');
  const [checkingManual, setCheckingManual] = useState(false);
  const [manualResult, setManualResult] = useState<{ handle: string; available: boolean; takenBy?: { id: string; title: string; thumbnail?: string }; error?: string; note?: string } | null>(null);

  // Filters
  const [showAvailableOnly, setShowAvailableOnly] = useState(false);
  const [minOverall, setMinOverall] = useState(0);
  const [minSeo, setMinSeo] = useState(0);
  const [minBrand, setMinBrand] = useState(0);
  const [minMemo, setMinMemo] = useState(0);
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterTechnique, setFilterTechnique] = useState<string>('');
  const [filterPronounce, setFilterPronounce] = useState<string>('');
  const [filterHandleLen, setFilterHandleLen] = useState<'' | 'short' | 'medium' | 'long'>('');
  const [filterText, setFilterText] = useState('');
  const [sortBy, setSortBy] = useState<'combined' | 'seo' | 'brand' | 'memorable' | 'length'>('combined');
  const [filtersOpen, setFiltersOpen] = useState(false);

  function resetFilters() {
    setShowAvailableOnly(false);
    setMinOverall(0); setMinSeo(0); setMinBrand(0); setMinMemo(0);
    setFilterCategory(''); setFilterTechnique(''); setFilterPronounce(''); setFilterHandleLen('');
    setFilterText('');
    setSortBy('combined');
  }

  // ---- Competitor bridge ----

  /** Pull the workspace's competitor list for the B-picker dropdown. */
  const fetchCompetitorsList = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, loads competitors
      const res = await fetch('/api/competitors');
      if (!res.ok) return;
      const data = await res.json();
      const list: PickerCompetitor[] = (data.competitors || []).map((c: { id: string; title: string; thumbnail_url?: string; subscriber_count?: number; latest_deep_analysis_at?: string | null }) => ({
        id: c.id,
        title: c.title,
        thumbnail_url: c.thumbnail_url || '',
        subscriber_count: Number(c.subscriber_count) || 0,
        hasAnalysis: !!c.latest_deep_analysis_at,
      }));
      // Analyzed competitors first (more useful seeds), then alphabetical.
      list.sort((a, b) => {
        if (a.hasAnalysis !== b.hasAnalysis) return a.hasAnalysis ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
      setCompetitorsList(list);
    } catch { /* picker is optional UI, silent fail is fine */ }
  }, []);

  /** Fetch the naming-context for a competitor and overwrite the form
   *  inputs with the seeded values. Preserves any in-session generated
   *  candidates (per the existing "accumulate, never wipe" pattern). */
  const hydrateFromCompetitor = useCallback(async (competitorId: string) => {
    const seq = ++hydrationSeqRef.current;
    setHydratingCompetitor(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, loads naming context
      const res = await fetch(`/api/competitors/${competitorId}/naming-context`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not load competitor context');
        // Stale URL param (e.g. competitor was deleted) — clear it so the
        // user isn't stuck with a broken seed source.
        setSourceCompetitorId(null);
        setSeededFrom(null);
        return;
      }
      const data: NamingContextPayload = await res.json();
      // A newer hydration started — drop this stale one.
      if (seq !== hydrationSeqRef.current) return;

      setSourceCompetitorId(data.channel.id);
      setSeededFrom({
        competitorId: data.channel.id,
        title: data.channel.title,
        thumbnail: data.channel.thumbnail_url,
        hasAnalysis: data.hasAnalysis,
        analyzedAt: data.analyzedAt,
      });
      setNiche(data.namingSeed.niche);
      setFreeText(data.namingSeed.freeText);
      setRefVideos(data.topVideoUrls);
      // Replace ref images entirely with the channel avatar (if any) — the
      // seed should be a fresh visual context, not stacked on prior uploads.
      setRefImages(prev => {
        // Free any prior object URLs to avoid memory leaks.
        for (const img of prev) { try { URL.revokeObjectURL(img.preview); } catch {} }
        return data.namingSeed.referenceImages.map(img => ({
          base64: img.base64,
          mimeType: img.mimeType,
          preview: img.previewUrl,
        }));
      });
      if (!data.hasAnalysis) {
        toast.info(`Loaded ${data.channel.title} — run Deep Analysis on this competitor for a richer naming seed.`);
      } else {
        toast.success(`Seeded from ${data.channel.title}`);
      }
    } catch (err: unknown) {
      if (seq !== hydrationSeqRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Could not load competitor context');
    } finally {
      if (seq === hydrationSeqRef.current) setHydratingCompetitor(false);
    }
  }, []);

  /** Clear the source link but preserve the prefilled form text — the
   *  user may want to keep the seeded prompt and just unlink it from the
   *  saving provenance. */
  function clearSourceLink() {
    setSourceCompetitorId(null);
    setSeededFrom(null);
    // Strip the ?fromCompetitor param from the URL without unmounting the page.
    router.replace(pathname, { scroll: false });
  }

  /** Picker change handler — re-points the seed at a different competitor
   *  and syncs the URL so refresh preserves the source. */
  function onPickCompetitor(competitorId: string) {
    if (!competitorId) return;
    router.replace(`${pathname}?fromCompetitor=${encodeURIComponent(competitorId)}`, { scroll: false });
    hydrateFromCompetitor(competitorId);
  }

  function addVideo() {
    const url = videoInput.trim();
    if (!url) return;
    if (refVideos.includes(url)) return;
    if (refVideos.length >= 10) { toast.error('Max 10 reference videos'); return; }
    setRefVideos(prev => [...prev, url]);
    setVideoInput('');
  }

  function removeVideo(url: string) {
    setRefVideos(prev => prev.filter(v => v !== url));
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (refImages.length + files.length > 5) { toast.error('Max 5 images'); return; }
    for (const file of files) {
      // Reject only if the original is absurdly huge; otherwise resize aggressively.
      if (file.size > 25 * 1024 * 1024) { toast.error(`${file.name} is too large (max 25MB)`); continue; }
      try {
        const { base64, mimeType, previewUrl } = await resizeAndEncode(file);
        setRefImages(prev => [...prev, { base64, mimeType, preview: previewUrl }]);
      } catch { toast.error(`Failed to process ${file.name}`); }
    }
    e.target.value = '';
  }

  function removeImage(idx: number) {
    setRefImages(prev => {
      const removed = prev[idx];
      if (removed?.preview) { try { URL.revokeObjectURL(removed.preview); } catch {} }
      return prev.filter((_, i) => i !== idx);
    });
  }

  async function generate() {
    if (!niche.trim() && !freeText.trim() && refVideos.length === 0) {
      toast.error('Add at least some context — niche, description, or reference videos');
      return;
    }
    setGenerating(true);
    // NOTE: we accumulate across generations within the session — never wipe prior results.
    // Use the "Clear results" button to reset.
    const thisBatch = batchNum + 1;
    setBatchNum(thisBatch);
    try {
      // Pass every name/handle we've seen this session — both candidates
      // currently shown AND saved entries from previous sessions — so the
      // server never returns duplicates.
      const existingNames = [
        ...candidates.map(c => c.name).filter((s): s is string => !!s),
        ...saved.map(s => s.name).filter((s): s is string => !!s),
      ];
      const existingHandles = [
        ...candidates.map(c => c.handle).filter((s): s is string => !!s),
        ...saved.map(s => s.handle).filter((s): s is string => !!s),
      ];
      // eslint-disable-next-line no-restricted-syntax -- channel-naming-generate RPC: awaits and uses response
      const res = await fetch('/api/channel-naming/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          niche,
          freeText,
          referenceVideoUrls: refVideos,
          referenceImages: refImages.map(i => ({ base64: i.base64, mimeType: i.mimeType })),
          count,
          existingNames,
          existingHandles,
          sourceCompetitorId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      // Build a saved-handle index so newly generated candidates immediately
      // reflect any prior saves (whether from earlier in this session or a
      // previous one). Without this, fetchSaved->setCandidates fires before
      // candidates exist and saved status is lost on the next generation.
      const savedIdByHandle = new Map(saved.map(s => [s.handle, s.id] as const));
      const newOnes: Candidate[] = (data.candidates || []).map((c: Candidate) => ({
        ...c,
        batch: thisBatch,
        savedId: savedIdByHandle.get(c.handle),
      }));

      // Merge with existing, dedup by handle, newer entries win, BUT preserve
      // savedId from prior version (newer payload doesn't include client-only fields).
      setCandidates(prev => {
        const map = new Map<string, Candidate>();
        for (const c of prev) map.set(c.handle, c);
        for (const c of newOnes) {
          const old = map.get(c.handle);
          map.set(c.handle, { ...c, savedId: c.savedId || old?.savedId });
        }
        const all = Array.from(map.values());
        all.sort((a, b) => {
          if (a.available !== b.available) return a.available ? -1 : 1;
          return b.combinedScore - a.combinedScore;
        });
        return all;
      });

      setStats({
        allChecked: data.allChecked,
        availableCount: data.availableCount,
        refVideosUsed: data.refVideosUsed,
        refVideosFailed: data.refVideosFailed,
        availabilityCaveat: data.availabilityCaveat,
      });
      if (data.refVideosFailed?.length) {
        toast.warning(`${data.refVideosFailed.length} reference video${data.refVideosFailed.length > 1 ? 's' : ''} could not be fetched`);
      }
      toast.success(`+${newOnes.length} candidates (batch ${thisBatch})`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally {
      setGenerating(false);
    }
  }

  function clearResults() {
    if (candidates.length === 0) return;
    if (!confirm(`Clear all ${candidates.length} generated candidates from this session?`)) return;
    setCandidates([]);
    setStats(null);
    setBatchNum(0);
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${label}`);
    } catch {
      toast.error('Copy failed');
    }
  }

  // ---- Saved names ----
  const fetchSaved = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, loads saved names
      const res = await fetch('/api/channel-naming/saved');
      if (!res.ok) return;
      const data = await res.json();
      const savedRows: SavedName[] = data.saved || [];
      setSaved(savedRows);
      // Reflect saved status on any currently displayed candidates
      const idByHandle = new Map(savedRows.map(s => [s.handle, s.id]));
      setCandidates(prev => prev.map(c => {
        const id = idByHandle.get(c.handle);
        return id ? { ...c, savedId: id } : c;
      }));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { fetchSaved(); }, [fetchSaved]);
  // Prime the localStorage history caches on a fresh device so the
  // niche autocomplete has suggestions even when the user hasn't
  // opened any of the seven generator panels yet on this PC.
  // primeHistoryCaches() resolves when all seven kinds have been
  // fetched; we then re-read the aggregated niche list.
  useEffect(() => {
    setNicheHints(getRecentNiches());
    primeHistoryCaches().then(() => setNicheHints(getRecentNiches())).catch(() => {});
  }, []);

  // Surface A: arrive via /channel-naming?fromCompetitor=<id> — hydrate
  // immediately. We intentionally only honour the param on first read;
  // later picker changes drive hydration directly so we don't double-fetch.
  const initialFromCompetitorRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialFromCompetitorRef.current !== null) return;
    const fromCompetitor = searchParams.get('fromCompetitor');
    initialFromCompetitorRef.current = fromCompetitor || '';
    if (fromCompetitor) hydrateFromCompetitor(fromCompetitor);
  }, [searchParams, hydrateFromCompetitor]);

  // Surface B: picker dropdown. Fetched once on mount; refreshes after
  // any successful hydration so a newly-analyzed competitor's badge
  // updates without a page reload.
  useEffect(() => { fetchCompetitorsList(); }, [fetchCompetitorsList]);

  async function saveCandidate(c: Candidate) {
    setSavingHandle(c.handle);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST to save name - RPC
      const res = await fetch('/api/channel-naming/saved', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: c.name, handle: c.handle,
          niche, freeText,
          seoScore: c.seo_score, brandScore: c.brand_score, memorabilityScore: c.memorability_score,
          combinedScore: c.combinedScore,
          reasoning: c.reasoning, keywordCoverage: c.keyword_coverage, risks: c.risks,
          wasAvailable: c.available, aiModel: modelId,
          sourceCompetitorId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      // Mark as saved in the candidate list
      setCandidates(prev => prev.map(x => x.handle === c.handle ? { ...x, savedId: data.saved.id } : x));
      // Prepend to saved list
      setSaved(prev => [data.saved, ...prev]);
      toast.success(`Saved "${c.name}"`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingHandle(null);
    }
  }

  async function deleteSaved(id: string) {
    if (!confirm('Delete this saved name?')) return;
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE for saved name - RPC
      const res = await fetch(`/api/channel-naming/saved/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      setSaved(prev => prev.filter(s => s.id !== id));
      setCandidates(prev => prev.map(c => c.savedId === id ? { ...c, savedId: undefined } : c));
      toast.success('Deleted');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  // ---- Manual handle / name check ----
  async function runManualCheck() {
    const raw = manualHandle.trim();
    if (!raw) return;
    setCheckingManual(true);
    setManualResult(null);
    try {
      // Auto-derive a handle from a name input (lowercase, strip non-allowed)
      const handleGuess = raw.replace(/^@/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
      // eslint-disable-next-line no-restricted-syntax -- awaited check-handle RPC: returns availability
      const res = await fetch('/api/channel-naming/check-handle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handleGuess }),
      });
      const data = await res.json();
      setManualResult({ handle: handleGuess, ...data });
    } catch { toast.error('Check failed'); }
    finally { setCheckingManual(false); }
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.3), rgba(147,51,234,0.2))', border: '1px solid rgba(59,130,246,0.3)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#60a5fa' }}>
              <path d="M4 4h16v16H4z" /><path d="M4 9h16" /><path d="M9 4v16" />
            </svg>
          </div>
          <span className="badge badge-blue">Channel Naming</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Channel Naming</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Give some context, reference videos, and a visual direction. Get 10 brandable names + @handles that are actually available on YouTube.
        </p>
      </div>

      <div className="glass rounded-xl p-6 mb-6 space-y-5">
        <ModelSelector value={modelId} onChange={setModelId} />

        <CompetitorPicker
          competitors={competitorsList}
          value={sourceCompetitorId}
          loading={hydratingCompetitor}
          onPick={onPickCompetitor}
        />

        {seededFrom && (
          <SeededFromChip info={seededFrom} onClear={clearSourceLink} />
        )}

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche</label>
          <AutocompleteInput value={niche} onChange={setNiche} suggestions={nicheHints} placeholder="e.g. Cybersecurity explainers, Home cooking, AI productivity..." />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Channel context, voice, style (free text)</label>
          <textarea
            className="input-field"
            style={{ minHeight: 100 }}
            placeholder="e.g. I want to make 3-8 minute videos for developers who want to learn AI tools without hype. Conversational, slightly nerdy, respects the viewer's time. Inspired by Fireship but less frantic."
            value={freeText}
            onChange={e => setFreeText(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            Reference videos or channels (up to 10 — optional). Paste any mix of video URLs (youtube.com/watch, youtu.be, shorts) or channel URLs (@handle, /channel/UCxxx, /c/name). For channel URLs we pull the 5 most-recent videos as style signal.
          </label>
          <div className="flex gap-2 mb-2">
            <input
              className="input-field flex-1"
              placeholder="Paste a YouTube video URL or a @handle / channel URL..."
              value={videoInput}
              onChange={e => setVideoInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addVideo())}
            />
            <button className="btn-secondary whitespace-nowrap" onClick={addVideo} disabled={!videoInput.trim()}>+ Add</button>
          </div>
          {refVideos.length > 0 && (
            <div className="space-y-1">
              {refVideos.map(url => (
                <div key={url} className="flex items-center gap-2 text-xs px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{url}</span>
                  <button onClick={() => removeVideo(url)} style={{ color: '#ef4444' }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            Reference images (up to 5 — optional; informs visual brand tone). Images are auto-resized client-side to ~1024px to stay within request limits. Only the first image is sent to the model today; all help guide the aesthetic.
          </label>
          <input type="file" accept="image/*" multiple onChange={handleImageUpload} className="text-xs" style={{ color: 'var(--text-muted)' }} />
          {refImages.length > 0 && (
            <div className="flex gap-2 mt-2 flex-wrap">
              {refImages.map((img, i) => (
                <div key={i} className="relative">
                  <img src={img.preview} alt="" style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }} />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center text-xs"
                    style={{ background: '#ef4444', color: 'white' }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Candidates to generate</label>
            <input type="number" className="input-field" style={{ width: 100 }} min={10} max={40} value={count} onChange={e => setCount(Math.max(10, Math.min(40, parseInt(e.target.value) || 20)))} />
          </div>
          <button className="btn-primary flex items-center gap-2" onClick={generate} disabled={generating}>
            {generating ? <Spinner /> : '✨'} {generating ? 'Generating + checking handles...' : candidates.length > 0 ? `Generate more (+${count})` : 'Generate names'}
          </button>
          {candidates.length > 0 && (
            <button className="btn-secondary text-xs flex items-center gap-2" onClick={clearResults} disabled={generating}>
              ✕ Clear all ({candidates.length})
            </button>
          )}
          <p className="text-xs flex-1 min-w-[200px]" style={{ color: 'var(--text-muted)' }}>
            Generations accumulate during this session — hit Generate again for more variety. Use Clear to start fresh.
          </p>
        </div>
      </div>

      {/* Manual check + Saved panel */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="glass rounded-xl p-5">
          <div className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>🔎 Check a name / handle manually</div>
          <div className="flex gap-2">
            <input
              className="input-field flex-1"
              placeholder="e.g. PixelCraft or @pixelcraft"
              value={manualHandle}
              onChange={e => setManualHandle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), runManualCheck())}
            />
            <button className="btn-secondary whitespace-nowrap flex items-center gap-2" onClick={runManualCheck} disabled={checkingManual || !manualHandle.trim()}>
              {checkingManual ? <Spinner size={12} /> : '🔍'} Check
            </button>
          </div>
          {manualResult && (
            <div className="mt-3 p-3 rounded text-sm" style={{
              background: manualResult.available ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${manualResult.available ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
            }}>
              <div className="flex items-center gap-2">
                <code className="font-mono" style={{ color: '#60a5fa' }}>@{manualResult.handle}</code>
                <span className="text-xs px-2 py-0.5 rounded font-semibold" style={{
                  background: manualResult.available ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)',
                  color: manualResult.available ? '#10b981' : '#ef4444',
                }}>
                  {manualResult.available ? '✓ Likely available' : manualResult.error ? `⚠ ${manualResult.error}` : '✗ Taken'}
                </span>
                <a
                  href={`https://www.youtube.com/@${manualResult.handle}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs ml-auto"
                  style={{ color: '#60a5fa' }}
                >Verify on YouTube ↗</a>
              </div>
              {manualResult.takenBy && (
                <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Owned by: <strong>{manualResult.takenBy.title}</strong></div>
              )}
              {manualResult.note && (
                <div className="text-xs mt-2 italic" style={{ color: 'var(--text-muted)' }}>ℹ {manualResult.note}</div>
              )}
            </div>
          )}
        </div>

        <div className="glass rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>💾 Saved names ({saved.length})</div>
            <button className="text-xs" style={{ color: 'var(--text-muted)' }} onClick={() => setSavedOpen(o => !o)}>
              {savedOpen ? 'Collapse ▲' : 'Expand ▼'}
            </button>
          </div>
          {savedOpen && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {saved.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Nothing saved yet. Hit ⭐ Save on a candidate.</div>
              ) : saved.map(s => (
                <div key={s.id} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{s.name}</div>
                    <code className="font-mono text-[11px]" style={{ color: '#60a5fa' }}>@{s.handle}</code>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{
                    background: s.was_available ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.15)',
                    color: s.was_available ? '#10b981' : '#9ca3af',
                  }}>
                    {s.was_available ? '✓ avail' : '✗ taken'}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {s.combined_score.toFixed(1)}
                  </span>
                  <button onClick={() => copy(`${s.name} · @${s.handle}`, 'name+handle')} title="Copy" className="text-xs" style={{ color: 'var(--text-muted)' }}>📋</button>
                  <button onClick={() => deleteSaved(s.id)} title="Delete" style={{ color: '#ef4444' }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {stats && (
        <div className="mb-4 space-y-2">
          <div className="text-xs px-1" style={{ color: 'var(--text-muted)' }}>
            Checked {stats.allChecked} candidates · {stats.availableCount} available · {stats.allChecked - stats.availableCount} taken
            {typeof stats.refVideosUsed === 'number' && ` · ${stats.refVideosUsed} ref video${stats.refVideosUsed !== 1 ? 's' : ''} used`}
          </div>
          {stats.refVideosFailed && stats.refVideosFailed.length > 0 && (
            <div className="text-xs px-3 py-2 rounded" style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}>
              ⚠ Failed to fetch: {stats.refVideosFailed.join(', ')}
            </div>
          )}
          {stats.availabilityCaveat && (
            <div className="text-xs px-3 py-2 rounded" style={{ background: 'rgba(245,158,11,0.08)', color: '#fbbf24' }}>
              ℹ {stats.availabilityCaveat}
            </div>
          )}
        </div>
      )}

      {generating && candidates.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass rounded-xl p-5 flex flex-col gap-3" style={{ borderLeft: '3px solid rgba(255,255,255,0.05)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 space-y-2">
                  <div className="rounded animate-pulse" style={{ height: 22, width: '60%', background: 'rgba(255,255,255,0.06)' }} />
                  <div className="rounded animate-pulse" style={{ height: 14, width: '40%', background: 'rgba(255,255,255,0.04)' }} />
                </div>
                <div className="rounded animate-pulse" style={{ height: 36, width: 50, background: 'rgba(255,255,255,0.06)' }} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[0,1,2].map(j => <div key={j} className="rounded animate-pulse" style={{ height: 36, background: 'rgba(255,255,255,0.04)' }} />)}
              </div>
              <div className="space-y-1">
                <div className="rounded animate-pulse" style={{ height: 10, width: '95%', background: 'rgba(255,255,255,0.04)' }} />
                <div className="rounded animate-pulse" style={{ height: 10, width: '85%', background: 'rgba(255,255,255,0.04)' }} />
                <div className="rounded animate-pulse" style={{ height: 10, width: '70%', background: 'rgba(255,255,255,0.04)' }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {candidates.length > 0 && (() => {
        const categorySet = Array.from(new Set(candidates.map(c => c.category).filter(Boolean) as string[]));
        const techniqueSet = Array.from(new Set(candidates.map(c => c.naming_technique).filter(Boolean) as string[]));
        const textLower = filterText.trim().toLowerCase();
        const filtered = candidates
          .filter(c => !showAvailableOnly || c.available)
          .filter(c => c.combinedScore >= minOverall)
          .filter(c => (Number(c.seo_score) || 0) >= minSeo)
          .filter(c => (Number(c.brand_score) || 0) >= minBrand)
          .filter(c => (Number(c.memorability_score) || 0) >= minMemo)
          .filter(c => !filterCategory || c.category === filterCategory)
          .filter(c => !filterTechnique || c.naming_technique === filterTechnique)
          .filter(c => !filterPronounce || c.pronounceability === filterPronounce)
          .filter(c => {
            if (!filterHandleLen) return true;
            const L = c.handle.length;
            if (filterHandleLen === 'short') return L <= 7;
            if (filterHandleLen === 'medium') return L >= 8 && L <= 15;
            return L >= 16;
          })
          .filter(c => !textLower ||
            c.name.toLowerCase().includes(textLower) ||
            c.handle.toLowerCase().includes(textLower) ||
            c.reasoning.toLowerCase().includes(textLower))
          .sort((a, b) => {
            if (sortBy === 'seo') return (b.seo_score || 0) - (a.seo_score || 0);
            if (sortBy === 'brand') return (b.brand_score || 0) - (a.brand_score || 0);
            if (sortBy === 'memorable') return (b.memorability_score || 0) - (a.memorability_score || 0);
            if (sortBy === 'length') return a.handle.length - b.handle.length;
            // 'combined' — available first, then combined desc
            if (a.available !== b.available) return a.available ? -1 : 1;
            return b.combinedScore - a.combinedScore;
          });

        const activeFilterCount = [
          showAvailableOnly, minOverall > 0, minSeo > 0, minBrand > 0, minMemo > 0,
          !!filterCategory, !!filterTechnique, !!filterPronounce, !!filterHandleLen, !!textLower,
          sortBy !== 'combined',
        ].filter(Boolean).length;

        return (
          <>
            <div className="glass rounded-xl p-4 mb-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {filtered.length} / {candidates.length} shown
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {batchNum} generation{batchNum !== 1 ? 's' : ''} this session
                </span>
                <div className="flex-1" />
                <button
                  className="btn-secondary text-xs flex items-center gap-2"
                  onClick={() => setFiltersOpen(o => !o)}
                >
                  {filtersOpen ? '▲ Hide filters' : '▼ Filters'} {activeFilterCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px]" style={{ background: 'rgba(124,58,237,0.2)', color: '#a78bfa' }}>
                      {activeFilterCount}
                    </span>
                  )}
                </button>
                {activeFilterCount > 0 && (
                  <button className="btn-secondary text-xs" onClick={resetFilters}>✕ Reset</button>
                )}
              </div>

              {filtersOpen && (
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {/* Score sliders */}
                  <FilterSlider label={`Min overall score (${minOverall.toFixed(1)})`} value={minOverall} max={10} step={0.5} onChange={setMinOverall} />
                  <FilterSlider label={`Min SEO score (${minSeo})`} value={minSeo} max={10} step={1} onChange={setMinSeo} />
                  <FilterSlider label={`Min brand score (${minBrand})`} value={minBrand} max={10} step={1} onChange={setMinBrand} />
                  <FilterSlider label={`Min memorability (${minMemo})`} value={minMemo} max={10} step={1} onChange={setMinMemo} />

                  {/* Dropdowns */}
                  <FilterSelect label="Category" value={filterCategory} onChange={setFilterCategory} options={([['', 'All'], ...categorySet.map(c => [c, c] as [string, string])])} />
                  <FilterSelect label="Naming technique" value={filterTechnique} onChange={setFilterTechnique} options={([['', 'All'], ...techniqueSet.map(t => [t, t] as [string, string])])} />
                  <FilterSelect label="Pronounceability" value={filterPronounce} onChange={setFilterPronounce} options={[['', 'All'], ['easy', 'Easy'], ['moderate', 'Moderate'], ['hard', 'Hard']]} />
                  <FilterSelect label="Handle length" value={filterHandleLen} onChange={(v) => setFilterHandleLen(v as '' | 'short' | 'medium' | 'long')} options={[['', 'All'], ['short', 'Short (≤7)'], ['medium', 'Medium (8–15)'], ['long', 'Long (16+)']]} />
                  <FilterSelect label="Sort by" value={sortBy} onChange={(v) => setSortBy(v as 'combined' | 'seo' | 'brand' | 'memorable' | 'length')} options={[['combined', 'Overall (available first)'], ['seo', 'SEO score'], ['brand', 'Brand score'], ['memorable', 'Memorability'], ['length', 'Handle length (short→long)']]} />

                  {/* Text search */}
                  <div className="md:col-span-2 lg:col-span-3">
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Search in name / handle / reasoning</label>
                    <input className="input-field" placeholder="e.g. craft, hub, ai..." value={filterText} onChange={e => setFilterText(e.target.value)} />
                  </div>

                  {/* Toggle */}
                  <label className="flex items-center gap-2 text-xs cursor-pointer md:col-span-2 lg:col-span-3" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={showAvailableOnly} onChange={e => setShowAvailableOnly(e.target.checked)} />
                    Available handles only
                  </label>
                </div>
              )}
            </div>

            <AnimatePresence>
              {filtered.length === 0 ? (
                <div className="glass rounded-xl p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  No candidates match your filters. <button className="underline" onClick={resetFilters}>Reset filters</button>
                </div>
              ) : (
                <motion.div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch" initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: 0.03 } } }}>
                  {filtered.map((c, i) => (
              <motion.div
                key={c.handle}
                variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
                className="glass rounded-xl p-5 flex flex-col h-full"
                style={{ borderLeft: `3px solid ${c.available ? '#10b981' : '#6b7280'}` }}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{c.name}</h3>
                      <span className="text-xs px-2 py-0.5 rounded" style={{
                        background: c.available ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.15)',
                        color: c.available ? '#10b981' : '#9ca3af',
                      }}>
                        {c.available ? '✓ Available' : c.checkError ? `⚠ ${c.checkError}` : '✗ Taken'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-sm font-mono" style={{ color: '#60a5fa' }}>@{c.handle}</code>
                      <button
                        onClick={() => copy(`@${c.handle}`, 'handle')}
                        className="text-xs px-2 py-0.5 rounded hover:bg-white/5"
                        style={{ color: 'var(--text-muted)' }}
                        title="Copy handle"
                      >📋</button>
                      {c.available && (
                        <a
                          href={`https://www.youtube.com/@${c.handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs px-2 py-0.5 rounded hover:bg-white/5"
                          style={{ color: 'var(--text-muted)' }}
                          title="Verify on YouTube"
                        >↗</a>
                      )}
                    </div>
                    {c.takenBy && (
                      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        Taken by: {c.takenBy.title}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-2xl font-bold" style={{ color: c.combinedScore >= 8 ? '#10b981' : c.combinedScore >= 6 ? '#f59e0b' : 'var(--text-secondary)' }}>
                      {c.combinedScore.toFixed(1)}
                    </div>
                    <div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>overall</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap mb-2">
                  {c.category && CATEGORY_LABELS[c.category] && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase" style={{
                      background: `${CATEGORY_LABELS[c.category].color}22`,
                      color: CATEGORY_LABELS[c.category].color,
                    }}>{CATEGORY_LABELS[c.category].label}</span>
                  )}
                  {c.naming_technique && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>
                      {c.naming_technique}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 text-center mb-3">
                  <Score label="SEO" value={c.seo_score} />
                  <Score label="Brand" value={c.brand_score} />
                  <Score label="Memorable" value={c.memorability_score} />
                </div>

                {c.tagline_suggestion && (
                  <div className="text-xs italic mb-2" style={{ color: 'var(--text-secondary)' }}>“{c.tagline_suggestion}”</div>
                )}

                <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>{c.reasoning}</p>

                {c.visual_mental_image && (
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
                    <strong style={{ color: 'var(--text-secondary)' }}>Mental image:</strong> {c.visual_mental_image}
                  </div>
                )}

                {c.search_intent_match && (
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
                    <strong style={{ color: 'var(--text-secondary)' }}>Search:</strong> {c.search_intent_match}
                  </div>
                )}

                {c.phonetic_pattern && (
                  <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                    <strong style={{ color: 'var(--text-secondary)' }}>Sound:</strong> {c.phonetic_pattern}
                  </div>
                )}

                {(c.keyword_coverage?.length || c.semantic_territory?.length) ? (
                  <div className="flex flex-wrap gap-1 mb-2 flex-1">
                    {c.keyword_coverage?.map((k, j) => (
                      <span key={`k${j}`} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(59,130,246,0.12)', color: '#60a5fa' }} title="Keyword present in name">#{k}</span>
                    ))}
                    {c.semantic_territory?.map((t, j) => (
                      <span key={`t${j}`} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }} title="Concept evoked">~{t}</span>
                    ))}
                  </div>
                ) : <div className="flex-1" />}

                {(c.domain_check_note || c.social_handle_consistency) && (
                  <details className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
                    <summary className="cursor-pointer" style={{ color: 'var(--text-secondary)' }}>Branding notes</summary>
                    <div className="mt-1 space-y-1 pl-3">
                      {c.domain_check_note && <div>🌐 {c.domain_check_note}</div>}
                      {c.social_handle_consistency && <div>📱 {c.social_handle_consistency}</div>}
                      {c.rejected_alternatives?.length ? (
                        <div>↩ Rejected: {c.rejected_alternatives.join(' · ')}</div>
                      ) : null}
                    </div>
                  </details>
                )}

                {c.risks && c.risks !== 'none' && (
                  <div className="text-[11px] mt-1" style={{ color: '#f59e0b' }}>⚠ {c.risks}</div>
                )}

                {c.available && c.availabilityNote && (
                  <div className="text-[10px] mt-1 italic" style={{ color: 'var(--text-muted)' }}>ℹ Verify at youtube.com/@{c.handle} before claiming</div>
                )}

                <div className="flex gap-2 mt-3 pt-3 border-t flex-wrap" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                  <button
                    className="btn-secondary text-xs flex-1"
                    onClick={() => saveCandidate(c)}
                    disabled={!!c.savedId || savingHandle === c.handle}
                    style={c.savedId ? { color: '#10b981' } : undefined}
                  >
                    {savingHandle === c.handle ? <Spinner size={12} /> : c.savedId ? '✓ Saved' : '⭐ Save'}
                  </button>
                  <button className="btn-secondary text-xs flex-1" onClick={() => copy(c.name, 'name')}>Copy name</button>
                  <button className="btn-secondary text-xs flex-1" onClick={() => copy(`${c.name} · @${c.handle}`, 'both')}>Copy both</button>
                  <span className="text-[10px] px-2 py-1 rounded" style={{ color: 'var(--text-muted)' }} title="Position in current sort">
                    #{i + 1}
                  </span>
                  {c.batch && (
                    <span className="text-[10px] px-2 py-1 rounded" style={{ background: 'rgba(124,58,237,0.1)', color: '#a78bfa' }} title="Generation batch">
                      gen {c.batch}
                    </span>
                  )}
                </div>
              </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        );
      })()}
    </div>
  );
}

function CompetitorPicker({
  competitors, value, loading, onPick,
}: {
  competitors: PickerCompetitor[];
  value: string | null;
  loading: boolean;
  onPick: (id: string) => void;
}) {
  if (competitors.length === 0) return null;
  return (
    <div>
      <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
        Start from a competitor (optional) — pulls niche, top videos, and analysis as the naming seed
      </label>
      <div className="flex gap-2 items-center">
        <select
          className="input-field flex-1"
          value={value || ''}
          onChange={e => onPick(e.target.value)}
          disabled={loading}
        >
          <option value="">— pick a competitor —</option>
          {competitors.map(c => (
            <option key={c.id} value={c.id}>
              {c.hasAnalysis ? '✓ ' : '  '}
              {c.title} ({c.subscriber_count.toLocaleString()} subs)
              {c.hasAnalysis ? ' · analyzed' : ''}
            </option>
          ))}
        </select>
        {loading && <Spinner size={14} />}
      </div>
      <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
        ✓ marks competitors with a Deep Analysis run — those produce the richest naming seeds. Others use channel + top videos only.
      </p>
    </div>
  );
}

function SeededFromChip({ info, onClear }: { info: SeededFromInfo; onClear: () => void }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-lg"
      style={{
        background: 'linear-gradient(135deg, rgba(239,68,68,0.08), rgba(249,115,22,0.05))',
        border: '1px solid rgba(249,115,22,0.2)',
      }}
    >
      {info.thumbnail && (
        <img
          src={info.thumbnail}
          alt=""
          style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Seeded from <span style={{ color: '#f97316' }}>{info.title}</span>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {info.hasAnalysis
            ? `Using Deep Analysis seed. Names saved here will be linked to this competitor.`
            : `No Deep Analysis yet — using channel + top videos only. Run analysis for a richer seed.`}
        </div>
      </div>
      <button
        className="text-xs px-2 py-1 rounded hover:bg-white/5"
        style={{ color: 'var(--text-muted)' }}
        onClick={onClear}
        title="Unlink source — form text stays as-is"
      >✕ unlink</button>
    </div>
  );
}

function FilterSlider({ label, value, max, step, onChange }: { label: string; value: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <input type="range" min={0} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)} className="w-full" />
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <select className="input-field" value={value} onChange={e => onChange(e.target.value)}>
        {options.map(([v, lbl]) => <option key={v || '_all'} value={v}>{lbl}</option>)}
      </select>
    </div>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  const n = Number(value) || 0;
  const color = n >= 8 ? '#10b981' : n >= 6 ? '#f59e0b' : '#6b7280';
  return (
    <div className="rounded-lg py-1" style={{ background: 'rgba(255,255,255,0.03)' }}>
      <div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-sm font-bold" style={{ color }}>{n}/10</div>
    </div>
  );
}
