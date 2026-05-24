'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, writeBackToSchedule, loadFullContextForItem } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { ScheduleLinkProvider, ScheduleSaverRegistration } from '@/components/ui/ScheduleLinkContext';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { DraftsBanner } from '@/components/ui/DraftsBanner';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { getSeoHistory, getSeoHistoryCached, saveSeoEntry, deleteSeoEntry, clearSeoHistory, getRecentTopics, type SeoHistoryEntry } from '@/lib/history';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { saveDraft, getActiveDraft, type WorkflowDraft } from '@/lib/drafts';
import { TemplateContextPicker, buildCombinedContext } from '@/components/ui/TemplateContextPicker';

interface TitleBreakdownEntry {
  score: number;
  detail: string;
  triggers_found?: string[];
  emotion?: string;
}

interface TitleResult {
  title: string;
  score: number;
  character_count?: number;
  style: string;
  breakdown: Record<string, TitleBreakdownEntry | number>;
}

interface DescriptionResult {
  above_fold: string;
  full_description: string;
  hashtags: string[];
}

interface TagResult {
  tag: string;
  type: 'primary' | 'secondary' | 'long-tail' | 'misspelling';
  relevance: number;
}

interface ChapterResult {
  timestamp: string;
  title: string;
}

interface SeoAnalysis {
  primary_keyword: string;
  secondary_keywords: string[];
  competition_assessment: string;
  ranking_strategy: string;
}

interface SeoResult {
  titles: TitleResult[];
  description: DescriptionResult;
  tags: TagResult[];
  chapters: ChapterResult[];
  seo_analysis: SeoAnalysis;
}

export default function SeoPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <SeoPage />
    </Suspense>
  );
}

function SeoPage() {
  const search = useSearchParams();
  const scheduleItemId = getScheduleLinkId(search);
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);

  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('seo-optimizer'));
  const [topic, setTopic] = useState('');
  const [topicHints, setTopicHints] = useState<string[]>([]);
  const [niche, setNiche] = useState('');
  const [niches, setNiches] = useState<{ id: string; name: string }[]>([]);
  const [targetKeywords, setTargetKeywords] = useState('');
  const [script, setScript] = useState('');
  const [existingTitle, setExistingTitle] = useState('');
  // Saved SEO style template + per-call extra rules. Merged into one
  // `additionalContext` string and shipped as USER DIRECTION to the
  // SEO prompt — applies to titles, description, hashtags, tags, and
  // chapter labels in a single pass.
  const [seoTemplateId, setSeoTemplateId] = useState<string | null>(null);
  const [seoContext, setSeoContext] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<SeoResult | null>(null);
  const [activeTab, setActiveTab] = useState<'titles' | 'description' | 'tags'>('titles');
  const [expandedTitle, setExpandedTitle] = useState<number | null>(null);
  // Initial state from localStorage cache so the panel paints instantly;
  // useEffect below pulls the canonical list from the server (migration 0049).
  const [historyItems, setHistoryItems] = useState<SeoHistoryEntry[]>(() => getSeoHistoryCached());
  useEffect(() => { getSeoHistory().then(setHistoryItems).catch(() => {}); }, []);
  const [draftId, setDraftId] = useState<string | null>(() => getActiveDraft()?.id || null);
  // Identity of the last result that was successfully pushed to the schedule
  // item via the banner button. Drives the dirty indicator.
  const [lastSavedResultRef, setLastSavedResultRef] = useState<SeoResult | null>(null);

  // Schedule-link preload: pull topic / niche / script + carry over any prior
  // SEO outputs already stamped on the item (yt_tags, freeform tags) as a
  // keyword seed so a re-run can refine instead of starting from scratch.
  useEffect(() => {
    if (!scheduleItemId || schedulePrefilled) return;
    let cancelled = false;
    (async () => {
      const item = await fetchScheduleItem(scheduleItemId);
      if (cancelled || !item) return;
      setScheduleItem(item);
      setSchedulePrefilled(true);
      const ctx = await loadFullContextForItem(item);
      if (cancelled) return;
      setTopic(curr => curr || ctx.topic);
      setNiche(curr => curr || ctx.niche);
      setExistingTitle(curr => curr || ctx.topic);
      if (ctx.script) setScript(prev => prev || ctx.script!);
      // Seed target keywords from the user's freeform schedule tags only —
      // *not* from `prevTags` (yt_tags), which are the AI's own previous
      // output. Reseeding from past output would create a self-reinforcement
      // loop where the LLM treats its prior suggestions as the target.
      const seedTags = Array.from(new Set(ctx.freeformTags)).slice(0, 12);
      if (seedTags.length) setTargetKeywords(curr => curr || seedTags.join(', '));
      toast.message(`Loaded context from "${item.title || 'schedule item'}"`);
    })();
    return () => { cancelled = true; };
     
  }, [scheduleItemId, schedulePrefilled]);

  useEffect(() => {
    setTopicHints(getRecentTopics());
    fetch('/api/niches').then(r => r.json()).then(data => {
      setNiches(data.niches || []);
      // Functional setter so a schedule-link or other prefill that already set
      // niche isn't overwritten by the default-first-niche on slow networks.
      if (data.niches?.length) setNiche(curr => curr || data.niches[0].name);
    }).catch(() => {});

    try {
      const prefill = localStorage.getItem('seo_prefill');
      if (prefill) {
        localStorage.removeItem('seo_prefill');
        const data = JSON.parse(prefill);
        if (data.topic) setTopic(curr => curr || data.topic);
        if (data.niche) setNiche(curr => curr || data.niche);
        if (data.script) setScript(curr => curr || data.script);
      }
    } catch {}
  }, []);

  // Analyzer flywheel prefill (Phase 2 of _plans/2026-05-19-analyzer-
  // as-input-source.md). Mirrors the /ideas prefill: when
  // `?from=analyzer&analysisId=` is present, fetch the row, build an
  // SEO-relevant context block (hook + structure + transcript), and
  // also prefill the topic field with the analyzed video's title when
  // empty.
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
            transcript?: { text?: string };
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
        const block = buildAnalyzerSeoBlock(data);
        const sourceLabel = data.videoTitle || data.result?.meta?.title || data.id;
        setAnalyzerContext({ analysisId: data.id, source: sourceLabel, block });
        // Soft prefill of the topic field — only set when empty so we
        // don't clobber what the operator typed.
        if (data.videoTitle) {
          setTopic((curr) => curr || data.videoTitle || '');
        }
        toast.message(`Loaded analyzer reference: "${sourceLabel}"`, {
          description: 'SEO will use this video\'s hook + structure + transcript as additionalContext.',
        });
      } catch (err) {
        toast.error('Failed to load analyzer context', {
          description: err instanceof Error ? err.message : 'network error',
        });
      }
    })();
  }, [search, analyzerPrefillApplied]);

  async function handleGenerate() {
    if (!topic.trim()) { toast.error('Please enter a topic or title'); return; }
    if (!niche) { toast.error('Please select a niche'); return; }
    setGenerating(true);
    setResult(null);
    // Resolve the selected template (if any) and route its content
    // based on `field_type`:
    //   - 'seo' (or any non-description type) → merged into
    //     `additionalContext` alongside the per-call freeform context,
    //     so the model treats it as a global direction that shapes
    //     titles + description + tags + chapters together.
    //   - 'youtube_description' → travels separately as
    //     `descriptionStyle` so it ONLY shapes the description body
    //     and doesn't bleed into title/tag generation. This is the
    //     fix for the cross-field caveat created when the SEO picker
    //     started accepting borrowed description templates.
    // The per-call freeform context is always treated as global SEO
    // direction — the user typed it on the SEO page, not bound to a
    // specific output field.
    let mergedContext = seoContext;
    let descriptionStyle: string | undefined;
    if (seoTemplateId) {
      try {
        const tplRes = await fetch(`/api/templates/${seoTemplateId}`);
        if (tplRes.ok) {
          const { template } = await tplRes.json();
          const tplContent: string | undefined = template?.content;
          const tplFieldType: string | undefined = template?.field_type;
          if (tplFieldType === 'youtube_description') {
            descriptionStyle = tplContent?.trim() || undefined;
            // Freeform context stays in mergedContext as global SEO
            // direction; description-only template content is kept
            // out of it so it doesn't influence titles / tags.
          } else if (tplContent) {
            mergedContext = buildCombinedContext(tplContent, seoContext);
          }
          console.info('[seo template] route', {
            templateId: seoTemplateId,
            fieldType: tplFieldType,
            routedTo: tplFieldType === 'youtube_description' ? 'descriptionStyle' : 'additionalContext',
            hasFreeformContext: seoContext.trim().length > 0,
          });
        }
      } catch (err) {
        // Network blip — fall through with the per-call context only
        // so the user still gets a generation instead of a blocking error.
        console.warn('[seo template] fetch failed, falling back to freeform only', err);
      }
    }
    // Prepend the analyzer reference block when this generation was
    // deep-linked from /analyze/[id]. The block is built once at
    // prefill time so we don't re-fetch on every generate.
    if (analyzerContext) {
      mergedContext = mergedContext.trim()
        ? `${analyzerContext.block}\n\n---\n\n${mergedContext}`
        : analyzerContext.block;
    }
    try {
      const res = await fetch('/api/seo/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          topic: topic.trim(),
          niche,
          script: script.trim() || undefined,
          targetKeywords: targetKeywords.trim() || undefined,
          existingTitle: existingTitle.trim() || undefined,
          additionalContext: mergedContext.trim() || undefined,
          descriptionStyle,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to optimize');
      }
      const data = await res.json();
      setResult(data.result);
      setActiveTab('titles');
      toast.success('SEO optimization complete!');
      // Save to history — include the full result + original inputs so clicking
      // a past entry fully rehydrates the results panel, not just the form.
      const titles = (data.result as { titles?: Array<{ title?: string; score?: number }> }).titles || [];
      const bestTitle = [...titles].sort((a, b) => (b.score || 0) - (a.score || 0))[0];

      // Silent auto-write — pushes the generated description + tags + metadata
      // straight onto the linked schedule item the moment the run finishes.
      // Coexists with the banner's explicit "Save SEO bundle" button, which
      // re-pushes the same payload with a confirmation toast for users who
      // want loud feedback. Title is *not* auto-written; the per-title
      // "Use title" button below handles that explicitly so the top-ranked
      // suggestion never silently overwrites a manually-chosen headline.
      if (scheduleItemId) {
        const desc = (data.result as { description?: { full_description?: string; above_fold?: string } }).description;
        const fullDesc = desc?.full_description || desc?.above_fold || '';
        const tagStrings: string[] = ((data.result as { tags?: Array<{ tag?: string }> }).tags ?? [])
          .map(t => t.tag)
          .filter((t): t is string => !!t);
        // Only send fields that actually have values — sending `yt_tags: []`
        // would wipe the user's existing tags.
        const patch: Record<string, unknown> = {};
        if (fullDesc) patch.yt_description = fullDesc;
        if (tagStrings.length) patch.yt_tags = tagStrings;
        writeBackToSchedule(scheduleItemId, patch, {
          customFieldsMerge: {
            latest_seo: {
              best_title: bestTitle?.title ?? null,
              best_score: bestTitle?.score ?? null,
              titles_count: titles.length,
              tags_count: tagStrings.length,
              ran_at: new Date().toISOString(),
              model_id: modelId,
            },
          },
        });
      }
      const savedSeo = await saveSeoEntry({
        topic, niche, modelId,
        titlesCount: titles.length,
        bestTitle: bestTitle?.title || topic,
        bestScore: bestTitle?.score || 0,
        tagsCount: ((data.result as { tags?: unknown[] }).tags || []).length,
        result: data.result,
        script: script.trim() || undefined,
        targetKeywords: targetKeywords.trim() || undefined,
        existingTitle: existingTitle.trim() || undefined,
        videoTitle: scheduleItem?.title?.trim() || topic.trim() || undefined,
        scheduleItemId: scheduleItemId || undefined,
      });
      // Optimistic prepend — see voiceover/generator save handlers.
      setHistoryItems((prev) => [savedSeo, ...prev.filter((p) => p.id !== savedSeo.id)]);
      // Save draft
      const draft = saveDraft({
        id: draftId || undefined, title: topic, niche, step: 'seo',
        topic, modelId, seoTitle: bestTitle?.title,
        seoDescription: (data.result as { description?: { above_fold?: string } }).description?.above_fold,
      });
      setDraftId(draft.id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setGenerating(false);
    }
  }

  function copyText(text: string, label = 'Copied!') {
    navigator.clipboard.writeText(text).then(() => toast.success(label));
  }

  function scoreColor(score: number) {
    if (score >= 75) return 'var(--accent-green)';
    if (score >= 50) return 'var(--accent-yellow)';
    return '#ef4444';
  }

  function scoreBg(score: number) {
    if (score >= 75) return 'rgba(16,185,129,0.15)';
    if (score >= 50) return 'rgba(245,158,11,0.15)';
    return 'rgba(239,68,68,0.15)';
  }

  function resumeDraft(draft: WorkflowDraft) {
    if (draft.topic) setTopic(draft.topic);
    if (draft.niche) setNiche(draft.niche);
    if (draft.modelId) setModelId(draft.modelId);
    setDraftId(draft.id);
    toast.success('Draft resumed — click Generate to run SEO optimization');
  }

  const tagColors: Record<string, { badge: string; color: string }> = {
    primary: { badge: 'badge-purple', color: 'var(--accent-purple-bright)' },
    secondary: { badge: 'badge-cyan', color: 'var(--accent-cyan-bright)' },
    'long-tail': { badge: 'badge-green', color: 'var(--accent-green)' },
    misspelling: { badge: 'badge-yellow', color: 'var(--accent-yellow)' },
  };

  const tabs = [
    { key: 'titles' as const, label: 'Titles', count: result?.titles?.length },
    { key: 'description' as const, label: 'Description' },
    { key: 'tags' as const, label: 'Tags & Chapters', count: result?.tags?.length },
  ];

  // Saver derived values. Memoized inline because hooks read functions
  // through a ref; primitive flags drive re-registration.
  const seoBestTitle = result?.titles?.length
    ? [...result.titles].sort((a, b) => (b.score || 0) - (a.score || 0))[0]
    : null;
  const seoFullDesc = result?.description?.full_description || result?.description?.above_fold || '';
  const seoTagStrings: string[] = (result?.tags ?? [])
    .map(t => t.tag)
    .filter((t): t is string => !!t);
  const seoIsReady = !!result && (!!seoFullDesc || seoTagStrings.length > 0);
  const seoIsDirty = seoIsReady && result !== lastSavedResultRef;

  return (
    <ScheduleLinkProvider item={scheduleItem}>
      <ScheduleSaverRegistration
        handle={{
          artifactLabel: 'SEO bundle',
          isReady: seoIsReady,
          isDirty: seoIsDirty,
          notReadyReason: 'Run SEO optimization first',
          // SEO is a polish step that can run at multiple stages — no
          // automatic next-stage advance.
          buildPatch: () => {
            const patch: Record<string, unknown> = {};
            if (seoFullDesc) patch.yt_description = seoFullDesc;
            // Only send tags when we have them — sending `[]` would wipe the
            // user's existing tags.
            if (seoTagStrings.length) patch.yt_tags = seoTagStrings;
            return {
              patch,
              customFieldsMerge: {
                latest_seo: {
                  best_title: seoBestTitle?.title ?? null,
                  best_score: seoBestTitle?.score ?? null,
                  titles_count: result?.titles?.length ?? 0,
                  tags_count: seoTagStrings.length,
                  ran_at: new Date().toISOString(),
                  model_id: modelId,
                },
              },
            };
          },
          describeSaved: () => {
            const parts: string[] = [];
            if (seoFullDesc) parts.push('description');
            if (seoTagStrings.length) parts.push(`${seoTagStrings.length} tags`);
            return parts.length ? parts.join(' + ') : 'metadata';
          },
          onSaved: () => setLastSavedResultRef(result),
        }}
        // No autoStamp here — the inline writeBackToSchedule in
        // handleGenerate (above) already pushes desc/tags + metadata
        // silently on each run. Adding an autoStamp would just fire a
        // duplicate metadata-only PATCH for no extra value.
      />
    <div className="p-8 max-w-6xl mx-auto">
      {scheduleItem && <ScheduleLinkBanner item={scheduleItem} feature="SEO Optimizer" />}
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, var(--accent-green), var(--accent-cyan-bright))' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </div>
          <span className="badge badge-green">SEO Optimizer</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Title & Description Optimizer</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Generate high-ranking titles, descriptions, tags, and chapters optimized for YouTube search and discovery.
        </p>
      </div>

      <DraftsBanner currentStep="seo" onResume={resumeDraft} />

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
        {/* LEFT PANEL */}
        <div className="space-y-4">
          <div className="glass rounded-2xl p-5 space-y-4">
            {/* Model Selector */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>AI Model</label>
              <ModelSelector value={modelId} onChange={setModelId} />
            </div>

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
                  title="Clear analyzer bias"
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

            {/* Niche */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Niche</label>
              <select
                className="input-field w-full"
                value={niche}
                onChange={e => setNiche(e.target.value)}
              >
                {niches.map(n => (
                  <option key={n.id} value={n.name}>{n.name}</option>
                ))}
              </select>
            </div>

            {/* Topic */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Topic / Title *</label>
              <AutocompleteInput
                value={topic}
                onChange={setTopic}
                suggestions={topicHints}
                placeholder="e.g. How to grow a YouTube channel in 2026"
                className="input-field w-full"
              />
            </div>

            {/* Target Keywords */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Target Keywords</label>
              <input
                className="input-field w-full"
                placeholder="e.g. youtube growth, get more views (optional)"
                value={targetKeywords}
                onChange={e => setTargetKeywords(e.target.value)}
              />
            </div>

            {/* Script */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Script</label>
              <textarea
                className="input-field w-full"
                rows={3}
                placeholder="Paste your script for chapter extraction (optional)"
                value={script}
                onChange={e => setScript(e.target.value)}
              />
            </div>

            {/* Existing Title */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Existing Title</label>
              <input
                className="input-field w-full"
                placeholder="Optimize an existing title (optional)"
                value={existingTitle}
                onChange={e => setExistingTitle(e.target.value)}
              />
            </div>

            {/* SEO context / saved templates — applies to titles + description
                + hashtags + tags + chapters in this run. Saved templates show
                up in the dropdown so the user doesn't have to retype the rules
                they care about (e.g. "always include channel pillars in the
                description, never use ALL CAPS in titles"). */}
            {/* `extraFieldTypes` borrows YouTube Description templates into
                the dropdown alongside dedicated SEO ones. The SEO Optimizer
                output is mostly description + titles + tags, and the user's
                "description style" rules are usually identical to what they
                want here — so reusing those templates saves duplicating
                them under a second category. New saves still land under
                `seo` (the canonical category for this picker). */}
            <TemplateContextPicker
              fieldType="seo"
              extraFieldTypes={['youtube_description']}
              borrowedScopeNote="Scoped to the description body only — titles, tags, and chapter labels keep following the built-in SEO rules."
              label="SEO style template"
              templateId={seoTemplateId}
              onTemplateChange={setSeoTemplateId}
              context={seoContext}
              onContextChange={setSeoContext}
              compact
            />

            {/* Generate Button */}
            <button
              className="btn-primary w-full flex items-center justify-center gap-2"
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Optimizing...
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  Optimize SEO
                </>
              )}
            </button>
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div>
          <AnimatePresence mode="wait">
            {!result && !generating ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="glass rounded-2xl p-12 flex flex-col items-center justify-center text-center"
                style={{ minHeight: 400 }}
              >
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                  style={{ background: 'rgba(16,185,129,0.1)' }}
                >
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>No results yet</h3>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Enter a topic and click Optimize SEO to generate titles, descriptions, tags, and chapters.</p>
              </motion.div>
            ) : generating ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="glass rounded-2xl p-12 flex flex-col items-center justify-center"
                style={{ minHeight: 400 }}
              >
                <div className="animate-spin w-10 h-10 border-2 rounded-full mb-4" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent-green)' }} />
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Analyzing and optimizing...</p>
              </motion.div>
            ) : result ? (
              <motion.div
                key="results"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                {/* Tabs */}
                <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--bg-secondary)' }}>
                  {tabs.map(t => (
                    <button
                      key={t.key}
                      onClick={() => setActiveTab(t.key)}
                      className="flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all"
                      style={{
                        background: activeTab === t.key ? 'var(--bg-card)' : 'transparent',
                        color: activeTab === t.key ? 'var(--text-primary)' : 'var(--text-muted)',
                      }}
                    >
                      {t.label}
                      {t.count != null && <span className="ml-1 opacity-60">({t.count})</span>}
                    </button>
                  ))}
                </div>

                {/* Titles Tab */}
                {activeTab === 'titles' && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
                    {result.titles.map((t, i) => (
                      <div key={i} className="glass rounded-xl p-4">
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <p className="text-base font-semibold flex-1" style={{ color: 'var(--text-primary)' }}>{t.title}</p>
                          {scheduleItemId && (
                            <button
                              className="btn-secondary text-xs px-2 py-1 shrink-0"
                              onClick={() => {
                                writeBackToSchedule(scheduleItemId, { title: t.title });
                                toast.success('Title saved to schedule item');
                              }}
                              title="Use this title on the linked schedule item"
                            >
                              Use title
                            </button>
                          )}
                          <button
                            className="btn-secondary text-xs px-2 py-1 shrink-0"
                            onClick={() => copyText(t.title, 'Title copied!')}
                          >
                            Copy
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2 mb-2">
                          <span
                            className="text-xs font-semibold px-2 py-0.5 rounded-full"
                            style={{ color: scoreColor(t.score), background: scoreBg(t.score) }}
                          >
                            Score: {t.score}
                          </span>
                          <span className="badge badge-green text-xs">{t.title.length} chars</span>
                          <span className="badge badge-cyan text-xs">{t.style}</span>
                        </div>

                        {/* Expandable breakdown */}
                        <button
                          className="text-xs font-medium mt-1"
                          style={{ color: 'var(--accent-green)' }}
                          onClick={() => setExpandedTitle(expandedTitle === i ? null : i)}
                        >
                          {expandedTitle === i ? 'Hide breakdown' : 'Show breakdown'}
                        </button>

                        <AnimatePresence>
                          {expandedTitle === i && t.breakdown && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="overflow-hidden"
                            >
                              <div className="mt-3 space-y-2">
                                {Object.entries(t.breakdown).map(([key, rawVal]) => {
                                  const val = typeof rawVal === 'object' && rawVal !== null ? (rawVal as TitleBreakdownEntry).score : (typeof rawVal === 'number' ? rawVal : 0);
                                  return (
                                  <div key={key}>
                                    <div className="flex justify-between text-xs mb-0.5">
                                      <span style={{ color: 'var(--text-secondary)' }}>{key.replace(/_/g, ' ')}</span>
                                      <span style={{ color: 'var(--text-muted)' }}>{val}/100</span>
                                    </div>
                                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                                      <motion.div
                                        className="h-full rounded-full"
                                        style={{ background: scoreColor(val) }}
                                        initial={{ width: 0 }}
                                        animate={{ width: `${val}%` }}
                                        transition={{ duration: 0.5, delay: 0.1 }}
                                      />
                                    </div>
                                  </div>
                                  );
                                })}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    ))}
                  </motion.div>
                )}

                {/* Description Tab */}
                {activeTab === 'description' && result.description && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                    {/* Above the fold */}
                    <div
                      className="glass rounded-xl p-4"
                      style={{ borderLeft: '3px solid var(--accent-cyan-bright)' }}
                    >
                      <p className="text-xs font-medium mb-2" style={{ color: 'var(--accent-cyan-bright)' }}>Above the fold (first 150 characters)</p>
                      <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                        {result.description.above_fold || result.description.full_description?.slice(0, 150)}
                      </p>
                    </div>

                    {/* Full description */}
                    <div className="glass rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Full Description</p>
                          <span className="badge badge-green text-xs">{result.description.full_description.length} chars</span>
                        </div>
                        <button
                          className="btn-secondary text-xs px-2 py-1"
                          onClick={() => copyText(result.description.full_description, 'Description copied!')}
                        >
                          Copy
                        </button>
                      </div>
                      <pre
                        className="text-sm whitespace-pre-wrap font-sans leading-relaxed"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {result.description.full_description}
                      </pre>
                    </div>

                    {/* Hashtags */}
                    {result.description.hashtags?.length > 0 && (
                      <div className="glass rounded-xl p-4">
                        <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Hashtags</p>
                        <div className="flex flex-wrap gap-2">
                          {result.description.hashtags.map((h, i) => (
                            <span key={i} className="badge badge-green text-xs">{h}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {/* Tags & Chapters Tab */}
                {activeTab === 'tags' && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                    {/* Tags */}
                    <div className="glass rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Tags</p>
                        <button
                          className="btn-secondary text-xs px-2 py-1"
                          onClick={() => copyText(result.tags.map(t => t.tag).join(', '), 'All tags copied!')}
                        >
                          Copy All
                        </button>
                      </div>

                      {(['primary', 'secondary', 'long-tail', 'misspelling'] as const).map(type => {
                        const grouped = result.tags.filter(t => t.type === type);
                        if (!grouped.length) return null;
                        return (
                          <div key={type} className="mb-3 last:mb-0">
                            <p className="text-xs font-medium mb-1.5 capitalize" style={{ color: tagColors[type]?.color }}>
                              {type === 'long-tail' ? 'Long-tail' : type}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {grouped.map((t, i) => (
                                <span key={i} className={`badge ${tagColors[t.type]?.badge} text-xs`}>
                                  {t.tag}
                                  <span className="ml-1 opacity-60">{t.relevance}/10</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Chapters */}
                    {result.chapters?.length > 0 && (
                      <div className="glass rounded-xl p-4">
                        <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Chapters</p>
                        <div className="space-y-2">
                          {result.chapters.map((ch, i) => (
                            <div key={i} className="flex items-center gap-3">
                              <span
                                className="text-xs font-mono px-2 py-0.5 rounded"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--accent-green)' }}
                              >
                                {ch.timestamp}
                              </span>
                              <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{ch.title}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {/* SEO Analysis */}
                {result.seo_analysis && (
                  <div
                    className="glass rounded-xl p-5"
                    style={{ borderLeft: '3px solid var(--accent-purple-bright)' }}
                  >
                    <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>SEO Analysis</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Primary Keyword</p>
                        <p className="text-sm font-medium" style={{ color: 'var(--accent-purple-bright)' }}>
                          {result.seo_analysis.primary_keyword}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Competition</p>
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {result.seo_analysis.competition_assessment}
                        </p>
                      </div>
                      <div className="sm:col-span-2">
                        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Secondary Keywords</p>
                        <div className="flex flex-wrap gap-1.5">
                          {result.seo_analysis.secondary_keywords.map((kw, i) => (
                            <span key={i} className="badge badge-cyan text-xs">{kw}</span>
                          ))}
                        </div>
                      </div>
                      <div className="sm:col-span-2">
                        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Ranking Strategy</p>
                        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.seo_analysis.ranking_strategy}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Workflow buttons */}
                {result && (
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => {
                        const bestTitle = [...(result.titles || [])].sort((a: any, b: any) => (b.score||0) - (a.score||0))[0];
                        if (draftId) saveDraft({ id: draftId, title: topic, niche, step: 'thumbnails', topic, modelId, seoTitle: bestTitle?.title });
                        localStorage.setItem('thumbnails_prefill', JSON.stringify({
                          title: bestTitle?.title || topic, niche, description: result.description?.full_description?.slice(0, 500),
                        }));
                        window.location.href = '/thumbnails?from=seo';
                      }}
                      className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                    >
                      🎨 Generate Thumbnail
                    </button>
                    <button
                      onClick={() => {
                        localStorage.setItem('voiceover_prefill', JSON.stringify({ script: result.description?.full_description, niche }));
                        window.location.href = '/voiceover?from=seo';
                      }}
                      className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                    >
                      🎙️ Generate Voiceover
                    </button>
                  </div>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <HistoryPanel
        title="SEO History"
        icon="🔍"
        items={historyItems.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: e.videoTitle || e.bestTitle,
          sublabel: `${e.niche} · ${e.titlesCount} titles · Best: ${e.bestScore}/100 · ${e.tagsCount} tags`,
          preview: e.videoTitle && e.bestTitle && e.bestTitle !== e.videoTitle ? `Top title: ${e.bestTitle}` : undefined,
        }))}
        onRestore={(id) => {
          const entry = historyItems.find(e => e.id === id);
          if (!entry) return;
          if (result && typeof window !== 'undefined' &&
              !confirm('Replace current SEO results with this restored entry?')) {
            return;
          }
          setTopic(entry.topic || entry.bestTitle);
          setNiche(entry.niche);
          if (entry.modelId) setModelId(entry.modelId);
          if (entry.script !== undefined) setScript(entry.script);
          if (entry.targetKeywords !== undefined) setTargetKeywords(entry.targetKeywords);
          if (entry.existingTitle !== undefined) setExistingTitle(entry.existingTitle);
          if (entry.result) {
            setResult(entry.result as SeoResult);
            setActiveTab('titles');
            toast.success(`Restored — ${entry.titlesCount} titles, best ${entry.bestScore}/100`);
          } else {
            toast.info('Older entry — only metadata was saved. Click Generate to re-run with these inputs.');
          }
        }}
        onDelete={(id) => {
          setHistoryItems((prev) => prev.filter((e) => e.id !== id));
          deleteSeoEntry(id).catch(() => {});
        }}
        onClearAll={() => {
          setHistoryItems([]);
          clearSeoHistory().catch(() => {});
        }}
      />
    </div>
    </ScheduleLinkProvider>
  );
}

/**
 * Synthesise the SEO-relevant subset of a deep-analyzer row. SEO cares
 * about title-and-description-driving signal: the hook, the structure,
 * the standout techniques, and a transcript excerpt. Style packs and
 * scene timings are not surfaced — they don't shape title choice.
 */
function buildAnalyzerSeoBlock(data: {
  videoTitle: string | null;
  channelTitle: string | null;
  result: {
    meta?: { title?: string; channel?: string; duration_seconds?: number };
    transcript?: { text?: string };
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
  const hookWorks = r?.strategic_report?.hook?.what_works?.trim();
  const structure = r?.strategic_report?.structure?.trim();
  const techniques = (r?.strategic_report?.standout_techniques ?? []).filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  const transcript = r?.transcript?.text?.trim() ?? '';
  const transcriptExcerpt = transcript.length > 2000 ? `${transcript.slice(0, 2000)}…` : transcript;

  const lines: string[] = [`### ANALYZER REFERENCE: "${title}" by ${channel}`];
  if (hookWorks) lines.push('', '**Hook (what works):**', hookWorks);
  if (structure) lines.push('', '**Narrative structure:**', structure);
  if (techniques.length) {
    lines.push('', '**Standout techniques:**');
    for (const t of techniques) lines.push(`- ${t}`);
  }
  if (transcriptExcerpt) {
    lines.push('', '**Transcript excerpt (first 2000 chars):**', transcriptExcerpt);
  }
  return lines.join('\n');
}
