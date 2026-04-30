'use client';

import { Suspense, useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, writeBackToSchedule, loadFullContextForItem, buildContextNotesFromItem, SCHEDULE_LINK_PARAM } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { AddToScheduleButton } from '@/components/ui/AddToScheduleButton';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { ScriptVoiceoverPanel } from '@/components/ui/ScriptVoiceoverPanel';
import { getFeatureDefaultModelId, getModelById } from '@/lib/ai-models';
import { countWords, estimateDuration, formatDuration } from '@/lib/utils';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { SaveAsProject } from '@/components/ui/SaveAsProject';
import { ExportScript } from '@/components/ui/ExportScript';
import { ExportForNarrator } from '@/components/ui/ExportForNarrator';
import { CopyForElevenLabs } from '@/components/ui/CopyForElevenLabs';
import { DraftsBanner } from '@/components/ui/DraftsBanner';
import { SeriesPicker } from '@/components/ui/SeriesPicker';
import { TemplateContextPicker, buildCombinedContext } from '@/components/ui/TemplateContextPicker';
import { ReferenceLibraryPicker, type PickedReference } from '@/components/ui/ReferenceLibraryPicker';
import { fetchPriorParts, formatPriorPartsForPrompt, saveSeriesPart } from '@/lib/series';
import { EMPTY_CONSTRAINTS, type ScriptConstraints } from '@/lib/script-options';
import { getScriptHistory, saveScript as saveScriptToHistory, deleteScriptEntry, clearScriptHistory, getRecentTopics, type ScriptHistoryEntry } from '@/lib/history';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { saveDraft, getActiveDraft, type WorkflowDraft } from '@/lib/drafts';

const TONES = ['Engaging & Friendly', 'Authoritative & Expert', 'Conversational', 'Dramatic & Urgent', 'Humorous & Relaxed', 'Educational & Clear'];
const STYLES = ['Explainer', 'Story-driven', 'Tutorial', 'Comparison', 'Opinion / Commentary', 'Top 10 List', 'Documentary'];
const DURATIONS = [3, 5, 7, 10, 12, 15, 20];

interface VideoAnalysis {
  thumbnail_analysis?: { visual_composition?: string; clickability_score?: string; what_makes_it_click_worthy?: string; text_overlays?: string; colors_and_contrast?: string };
  hook_breakdown?: { opening_technique?: string; first_sentence_verbatim?: string; curiosity_mechanism?: string; emotional_trigger?: string; time_to_hook_seconds?: string };
  content_structure?: { format_type?: string; narrative_arc?: string; sections?: { timestamp: string; label: string; purpose: string }[]; transition_style?: string };
  pacing_analysis?: { overall_tempo?: string; energy_map?: string; dead_zones?: string };
  language_and_voice?: { tone_profile?: string; signature_phrases?: string[]; personality_markers?: string; audience_address_style?: string };
  storytelling_techniques?: { narrative_devices?: string[]; emotional_arc?: string; tension_building?: string };
  engagement_mechanics?: { pattern_interrupts?: { timestamp: string; technique: string }[]; curiosity_gaps?: string[]; calls_to_action?: string[] };
  visual_production_cues?: { inferred_visuals?: string; production_level?: string };
  creator_fingerprint?: string;
  replicable_elements?: string[];
  what_makes_it_work?: string;
  weaknesses?: string[];
}

interface VideoRef {
  id: string;
  url: string;
  title: string;
  channelTitle: string;
  viewCount: number;
  thumbnailUrl: string;
  styleAnalysis: string | null;
  analysis: VideoAnalysis | null;
  loading: boolean;
}

export default function GeneratorPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <GeneratorPage />
    </Suspense>
  );
}

function GeneratorPage() {
  const search = useSearchParams();
  const scheduleItemId = getScheduleLinkId(search);
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);

  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('script-generator'));
  const [topic, setTopic] = useState('');
  const [topicHints, setTopicHints] = useState<string[]>([]);
  const [niche, setNiche] = useState('');
  const [niches, setNiches] = useState<{ id: string; name: string }[]>([]);
  const [duration, setDuration] = useState(7);
  const [tone, setTone] = useState(TONES[0]);
  const [style, setStyle] = useState(STYLES[0]);
  const [audience, setAudience] = useState('');
  const [context, setContext] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [script, setScript] = useState('');
  // saving/projectTitle removed — handled by SaveAsProject component
  const [showSave, setShowSave] = useState(false);
  // Track saved project + script id so post-save actions (e.g. Send to Narrator)
  // can deep-link straight to the right project.
  const [savedProjectId, setSavedProjectId] = useState<string | null>(null);
  const scriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Self-QA: when on, we hit /api/generate/script-validated which generates,
  // scores against a brutal rubric, and regenerates up to maxAttempts times
  // if the score < threshold. Blocks the script entirely when it never
  // clears the bar — per the user's "don't even return it" requirement.
  const [selfQA, setSelfQA] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('script-gen:self-qa') === 'true';
  });
  const [qaThreshold, setQaThreshold] = useState<number>(() => {
    if (typeof window === 'undefined') return 85;
    const v = Number(localStorage.getItem('script-gen:qa-threshold') ?? 85);
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 85;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('script-gen:self-qa', String(selfQA));
  }, [selfQA]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('script-gen:qa-threshold', String(qaThreshold));
  }, [qaThreshold]);
  // Last-run QA metadata so we can show the score + strengths/issues after
  // a validated run completes.
  const [qaResult, setQaResult] = useState<{
    overall_score?: number;
    passed: boolean;
    attempts: number;
    threshold: number;
    strengths?: string[];
    critical_issues?: Array<{ severity?: string; location?: string; issue?: string; fix?: string }>;
  } | null>(null);

  // Reference videos
  const [refUrl, setRefUrl] = useState('');
  const [refs, setRefs] = useState<VideoRef[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showRefs, setShowRefs] = useState(false);

  // History & drafts
  const [historyItems, setHistoryItems] = useState<ScriptHistoryEntry[]>(() => getScriptHistory());
  const [draftId, setDraftId] = useState<string | null>(() => getActiveDraft()?.id || null);

  // Series linkage (optional). If set, generate() fetches prior parts as
  // continuity context and saves the new script as the next series part.
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [seriesTitle, setSeriesTitle] = useState<string>('');
  const [partNumber, setPartNumber] = useState<number>(1);
  // Tracks whether the user has manually changed `partNumber` since mount.
  // Without this, a fast schedule fetch could overwrite a value the user just
  // typed (initial state `1` is indistinguishable from "user typed 1").
  const partNumberDirtyRef = useRef(false);

  // User-authored script constraints — skip hook, skip CTA, custom rules.
  // These ride with every generate + QA call so the reviewer doesn't flag
  // intentional omissions as issues. Default to empty (all off).
  const [constraints, setConstraints] = useState<ScriptConstraints>(EMPTY_CONSTRAINTS);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [customRuleInput, setCustomRuleInput] = useState('');

  // Post-generation refinement UI state.
  const [refining, setRefining] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineNotes, setRefineNotes] = useState('');
  const [previousScriptSnapshot, setPreviousScriptSnapshot] = useState<string | null>(null);
  const refineAbortRef = useRef<AbortController | null>(null);
  const [seriesTokenBudget, setSeriesTokenBudget] = useState<number>(() => {
    if (typeof window === 'undefined') return 15000;
    const v = Number(localStorage.getItem('series:token-budget'));
    return Number.isFinite(v) && v > 0 ? v : 15000;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('series:token-budget', String(seriesTokenBudget));
  }, [seriesTokenBudget]);

  function resumeDraft(draft: WorkflowDraft, options?: { silent?: boolean }) {
    // Abort any in-progress generation
    if (generating) {
      abortRef.current?.abort();
      setGenerating(false);
    }
    if (draft.topic) setTopic(draft.topic);
    if (draft.niche) setNiche(draft.niche);
    if (draft.tone) setTone(draft.tone);
    if (draft.style) setStyle(draft.style);
    if (draft.duration) setDuration(draft.duration);
    if (draft.modelId && getModelById(draft.modelId)) setModelId(draft.modelId);
    if (draft.script) {
      setScript(draft.script);
      setShowSave(true);
      if (draft.script.includes('[... truncated in draft ...]')) {
        toast.warning('This draft\'s script was truncated for storage. You may need to regenerate.');
      }
    }
    if (draft.constraints) {
      setConstraints({ ...EMPTY_CONSTRAINTS, ...draft.constraints });
      setOptionsOpen(true);
    }
    if (draft.seriesId) {
      setSeriesId(draft.seriesId);
      setSeriesTitle(draft.seriesTitle || '');
      setPartNumber(draft.partNumber || 1);
    }
    setDraftId(draft.id);
    if (!options?.silent) toast.success('Draft resumed');
  }

  /** Post-generation refinement: stream an edited version of the current
   *  script using the user's notes, preserving constraints. On success the
   *  edited text replaces `script`; the prior version is stashed so the
   *  "Undo" button can bring it back without a round-trip. */
  async function refineScript() {
    const notes = refineNotes.trim();
    if (!notes) { toast.error('Describe what to improve first.'); return; }
    if (!script.trim()) { toast.error('Generate a script first.'); return; }
    setRefining(true);
    setPreviousScriptSnapshot(script);
    const prevScript = script;
    setScript('');
    refineAbortRef.current = new AbortController();
    try {
      const res = await fetch('/api/generate/script/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          originalScript: prevScript,
          refinementInstructions: notes,
          topic,
          niche,
          constraints,
        }),
        signal: refineAbortRef.current.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Refine failed' }));
        throw new Error(err.error || 'Refine failed');
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response stream');
      let refined = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        refined += decoder.decode(value, { stream: true });
        setScript(refined);
        scriptRef.current?.scrollTo({ top: scriptRef.current.scrollHeight, behavior: 'smooth' });
      }
      // Save the refined version as a new history entry so both versions are recoverable.
      saveScriptToHistory({
        topic, niche, tone, style, duration, modelId,
        script: refined, wordCount: countWords(refined),
        audience: audience || undefined,
        context: (context ? context + '\n\n' : '') + `[Refined: ${notes}]`,
        refs: refs.filter(r => !r.loading).map(r => ({
          url: r.url, title: r.title, channelTitle: r.channelTitle,
          viewCount: r.viewCount, thumbnailUrl: r.thumbnailUrl,
        })),
        constraints,
        seriesId: seriesId || undefined,
        seriesTitle: seriesTitle || undefined,
        partNumber: seriesId ? partNumber : undefined,
      });
      setHistoryItems(getScriptHistory());
      // Update draft too — the current script is now the refined one.
      const draft = saveDraft({ id: draftId || undefined, title: topic, niche, step: 'script', topic, tone, style, duration, modelId, script: refined, wordCount: countWords(refined), constraints, seriesId: seriesId || undefined, seriesTitle: seriesTitle || undefined, partNumber: seriesId ? partNumber : undefined });
      setDraftId(draft.id);
      setRefineNotes('');
      setRefineOpen(false);
      toast.success('Script refined — click Undo to revert.');
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        setScript(prevScript); // bring the prior version back if user cancelled mid-stream
        setPreviousScriptSnapshot(null); // clear the snapshot so no spurious "Undo" button appears
        return;
      }
      // Restore prior version on any error
      setScript(prevScript);
      setPreviousScriptSnapshot(null);
      toast.error(err instanceof Error ? err.message : 'Refine failed');
    } finally {
      setRefining(false);
    }
  }

  function undoRefine() {
    if (!previousScriptSnapshot) return;
    setScript(previousScriptSnapshot);
    setPreviousScriptSnapshot(null);
    toast.message('Reverted to the previous version.');
  }

  function restoreScript(id: string) {
    const entry = historyItems.find(e => e.id === id);
    if (!entry) return;
    if (script && typeof window !== 'undefined' &&
        !confirm('Replace the current script with this restored entry?')) {
      return;
    }
    setTopic(entry.topic);
    setNiche(entry.niche);
    setTone(entry.tone);
    setStyle(entry.style);
    setDuration(entry.duration);
    // Only restore model if it still exists
    if (getModelById(entry.modelId)) setModelId(entry.modelId);
    setScript(entry.script);
    // Rehydrate the full input context if the entry has it.
    if (entry.audience !== undefined) setAudience(entry.audience);
    if (entry.context !== undefined) setContext(entry.context);
    if (entry.refs && entry.refs.length) {
      // Reconstruct VideoRef shape; the deep styleAnalysis/analysis blobs were
      // too large to keep in history — user can re-analyze if they want them.
      setRefs(entry.refs.map((r, i) => ({
        id: `restored-${i}-${Date.now()}`,
        url: r.url,
        title: r.title,
        channelTitle: r.channelTitle || '',
        viewCount: r.viewCount || 0,
        thumbnailUrl: r.thumbnailUrl || '',
        styleAnalysis: null,
        analysis: null,
        loading: false,
      })));
      setShowRefs(true);
    } else {
      setRefs([]);
    }
    // Rehydrate constraints + series linkage.
    if (entry.constraints) {
      setConstraints({ ...EMPTY_CONSTRAINTS, ...entry.constraints });
      setOptionsOpen(true);
    }
    if (entry.seriesId) {
      setSeriesId(entry.seriesId);
      setSeriesTitle(entry.seriesTitle || '');
      setPartNumber(entry.partNumber || 1);
    }
    setShowSave(true);
    toast.success('Script restored from history');
  }

  function handleDeleteScript(id: string) {
    deleteScriptEntry(id);
    setHistoryItems(getScriptHistory());
  }

  function handleClearScripts() {
    clearScriptHistory();
    setHistoryItems([]);
  }

  async function addReference() {
    if (!refUrl.trim()) return;
    if (refs.length >= 5) { toast.error('Maximum 5 reference videos allowed'); return; }
    const url = refUrl.trim();
    if (!/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/.test(url)) {
      toast.error('Please enter a valid YouTube URL');
      return;
    }
    setRefUrl('');
    const refId = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setRefs(prev => [...prev, { id: refId, url, title: 'Deep analyzing...', channelTitle: '', viewCount: 0, thumbnailUrl: '', styleAnalysis: null, analysis: null, loading: true }]);

    try {
      const res = await fetch('/api/youtube/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, modelId }),
      });
      if (!res.ok) throw new Error('Analysis failed');
      const data = await res.json();
      setRefs(prev => prev.map(r => r.id === refId ? {
        id: refId, url,
        title: data.metadata.title,
        channelTitle: data.metadata.channelTitle,
        viewCount: data.metadata.viewCount,
        thumbnailUrl: data.metadata.thumbnailUrl,
        styleAnalysis: data.styleAnalysis,
        analysis: data.analysis || null,
        loading: false,
      } : r));
      // Cache-hit responses skip the AI round-trip — let the user know
      // they got an instant answer from the saved library.
      const titleSlice = data.metadata.title.slice(0, 40);
      if (data.cached) {
        toast.success(`📚 Reused from library: ${titleSlice}...`);
      } else {
        toast.success(`Deep analysis complete: ${titleSlice}... (saved to library)`);
      }
    } catch {
      setRefs(prev => prev.filter(r => r.id !== refId));
      toast.error('Failed to analyze video');
    }
  }

  // Load the linked schedule item once, then prefill empty fields from it so
  // the user doesn't retype the title / topic / context they already captured
  // in the schedule. Manual edits made after the first prefill win.
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
      // Compose the freeform context from notes + series + tags + checklist,
      // not just notes — gives the script generator everything the schedule
      // item already knows about this video.
      const composed = buildContextNotesFromItem(ctx);
      if (composed) setContext(curr => curr || composed);
      // Auto-link the series so part-N continuity context is fetched at
      // generate time. Series picker picks this up via its prop sync effect.
      // Only auto-set partNumber if the user hasn't touched it (dirty ref
      // guards against the race where the user typed during the fetch).
      if (ctx.series) {
        setSeriesId(curr => curr || ctx.series!.id);
        setSeriesTitle(curr => curr || ctx.series!.title);
        if (!partNumberDirtyRef.current) setPartNumber(ctx.series.partNumber);
      }
      toast.message(`Loaded context from "${item.title || 'schedule item'}"`);
    })();
    return () => { cancelled = true; };
  }, [scheduleItemId, schedulePrefilled]);

  useEffect(() => {
    setTopicHints(getRecentTopics());
    // Read prefill FIRST (before async fetch can overwrite)
    let prefillNiche: string | null = null;
    try {
      const prefill = localStorage.getItem('generator_prefill');
      if (prefill) {
        localStorage.removeItem('generator_prefill');
        const data = JSON.parse(prefill);
        // Functional setters so a schedule-link prefill that resolved first
        // (`?scheduleItemId=…`) isn't clobbered by stale localStorage from a
        // prior session.
        if (data.topic) setTopic(curr => curr || data.topic);
        if (data.niche) { setNiche(curr => curr || data.niche); prefillNiche = data.niche; }
        if (data.audience) setAudience(curr => curr || data.audience);
        if (data.context) setContext(curr => curr || data.context);
        if (data.style && STYLES.includes(data.style)) setStyle(data.style);
        if (data.refs && Array.isArray(data.refs)) {
          setRefs(prev => prev.length ? prev : data.refs);
          setShowRefs(true);
        }
      }
    } catch {}

    // When arriving from QA, auto-resume the active draft so the QA-improved script
    // is shown immediately instead of requiring a manual click on the drafts banner.
    // Silent mode: the arrival itself is the confirmation — no toast needed.
    // Also strip ?from=qa from the URL so a bookmark/share doesn't re-trigger this path.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('from') === 'qa') {
        const active = getActiveDraft();
        if (active?.script) {
          resumeDraft(active, { silent: true });
          if (!prefillNiche && active.niche) prefillNiche = active.niche;
        }
        url.searchParams.delete('from');
        window.history.replaceState({}, '', url.pathname + (url.search || ''));
      }
    } catch {}

    fetch('/api/niches').then(r => r.json()).then(data => {
      setNiches(data.niches || []);
      // Only set default niche if no prefill was applied. Functional setter
      // also covers the schedule-link race: if the schedule prefill effect
      // resolved first and set a niche, this won't clobber it.
      if (!prefillNiche && data.niches?.length) setNiche(curr => curr || data.niches[0].name);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generateScript() {
    if (!topic.trim()) { toast.error('Please enter a topic'); return; }
    if (!niche.trim()) { toast.error('Please select a niche'); return; }

    setGenerating(true);
    setScript('');
    setShowSave(false);
    setQaResult(null);
    abortRef.current = new AbortController();

    // Build rich reference context from deep analysis
    const refContext = refs.filter(r => !r.loading && r.styleAnalysis).map((r, idx) =>
      `### REFERENCE VIDEO ${idx + 1}: "${r.title}" by ${r.channelTitle} (${r.viewCount.toLocaleString()} views)\n${r.styleAnalysis}`
    ).join('\n\n---\n\n');

    // Previously-generated scripts from history — fed to both endpoints so
    // the LLM doesn't repeat hooks/angles it has used for this user before.
    // Cap at ~6 recent entries to keep the prompt compact.
    const previousScripts = getScriptHistory().slice(0, 6).map(e => e.script).filter(Boolean);

    // Resolve the picked style template (if any) and merge with the freeform
    // "extra context" textarea. The merged string takes the place of the old
    // single context field in the API payload — the script route is unchanged.
    let mergedContext = context;
    if (templateId) {
      try {
        const tplRes = await fetch(`/api/templates/${templateId}`);
        if (tplRes.ok) {
          const { template } = await tplRes.json();
          mergedContext = buildCombinedContext(template?.content, context);
        }
      } catch {}
    }

    // Series continuity: if this script is Part >= 2 of a linked series, fetch
    // budgeted prior-parts context. The server handles truncation/summaries to
    // stay within `seriesTokenBudget`. On failure (offline etc.) we continue
    // without continuity rather than blocking the user from generating.
    let seriesContext = '';
    if (seriesId && partNumber > 1) {
      try {
        const parts = await fetchPriorParts(seriesId, { before: partNumber, maxTokens: seriesTokenBudget });
        if (parts.length > 0) {
          seriesContext = formatPriorPartsForPrompt(parts, seriesTitle || 'Series', partNumber);
          toast.info(`Series continuity loaded — ${parts.length} prior part${parts.length === 1 ? '' : 's'} used as context`);
        }
      } catch (err) {
        console.warn('Series context fetch failed:', err);
        toast.warning('Could not load prior series parts — generating without continuity context');
      }
    }

    try {
      if (selfQA) {
        // Non-streaming validated path. Round-trips once per attempt; can
        // take 1–5 minutes depending on threshold + attempts.
        toast.info(`Self-QA running — scoring at threshold ${qaThreshold}. This may take a few minutes…`);
        const res = await fetch('/api/generate/script-validated', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelId, topic, niche, duration, tone, style, audience, context: mergedContext,
            referenceContext: refContext || undefined,
            threshold: qaThreshold,
            previousScripts,
            seriesContext: seriesContext || undefined,
            constraints,
          }),
          signal: abortRef.current.signal,
        });
        // Vercel returns an HTML/text error page (not JSON) when a serverless
        // function crashes or hits FUNCTION_INVOCATION_TIMEOUT. Parse the body
        // as text first so we can surface a readable message instead of a
        // cryptic JSON.parse error.
        const rawBody = await res.text();
        let data: { error?: string; passed?: boolean; script?: string; qa?: { overall_score?: number; critical_issues?: Array<{ severity?: string; location?: string; issue?: string; fix?: string }>; strengths?: string[] }; attempts?: number; threshold?: number; bestScore?: number } = {};
        try { data = rawBody ? JSON.parse(rawBody) : {}; }
        catch {
          if (res.status === 504 || /timeout|FUNCTION_INVOCATION_TIMEOUT/i.test(rawBody)) {
            throw new Error('Self-QA timed out on the server (Vercel 300s cap). Lower the threshold or try a faster model.');
          }
          throw new Error(`Self-QA server error (${res.status}). The function likely crashed — check the Vercel dashboard for this deployment's runtime logs.`);
        }
        if (!res.ok) throw new Error(data.error || `Generation failed (${res.status})`);
        if (!data.passed) {
          // Per the user's requirement: if it never clears the bar, don't
          // return the script — warn so they can retry or lower the threshold.
          setQaResult({
            overall_score: data.bestScore,
            passed: false,
            attempts: data.attempts ?? 0,
            threshold: data.threshold ?? qaThreshold,
            critical_issues: data.qa?.critical_issues,
            strengths: data.qa?.strengths,
          });
          toast.error(`Self-QA failed after ${data.attempts ?? 0} attempts — best score ${data.bestScore ?? '?'}/${data.threshold ?? qaThreshold}. Lower the threshold or try a stronger model.`);
          return;
        }
        setScript(data.script ?? '');
        setQaResult({
          overall_score: data.qa?.overall_score,
          passed: true,
          attempts: data.attempts ?? 0,
          threshold: data.threshold ?? qaThreshold,
          critical_issues: data.qa?.critical_issues,
          strengths: data.qa?.strengths,
        });
        setShowSave(true);
        const finalScript = data.script ?? '';
        saveScriptToHistory({
          topic, niche, tone, style, duration, modelId,
          script: finalScript, wordCount: countWords(finalScript),
          audience: audience || undefined,
          context: context || undefined,
          refs: refs.filter(r => !r.loading).map(r => ({
            url: r.url, title: r.title, channelTitle: r.channelTitle,
            viewCount: r.viewCount, thumbnailUrl: r.thumbnailUrl,
          })),
          constraints,
          seriesId: seriesId || undefined,
          seriesTitle: seriesTitle || undefined,
          partNumber: seriesId ? partNumber : undefined,
        });
        setHistoryItems(getScriptHistory());
        const draft = saveDraft({ id: draftId || undefined, title: topic, niche, step: 'script', topic, tone, style, duration, modelId, script: finalScript, wordCount: countWords(finalScript), constraints, seriesId: seriesId || undefined, seriesTitle: seriesTitle || undefined, partNumber: seriesId ? partNumber : undefined });
        setDraftId(draft.id);
        // If this is a series part, persist it to the series so cross-device Part N+1 can pull it.
        if (seriesId && finalScript) {
          saveSeriesPart(seriesId, { content: finalScript, partNumber, modelId })
            .then(r => { if (r) toast.success(`Saved as Part ${partNumber} of "${seriesTitle}"`); })
            .catch(() => { /* best-effort */ });
        }
        toast.success(`Self-QA passed in ${data.attempts ?? 1} attempt${(data.attempts ?? 1) === 1 ? '' : 's'} — score ${data.qa?.overall_score ?? '?'}/100`);
        return;
      }

      const res = await fetch('/api/generate/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, topic, niche, duration, tone, style, audience, context: mergedContext, referenceContext: refContext || undefined, previousScripts, seriesContext: seriesContext || undefined, constraints }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Generation failed');
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response stream');

      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        setScript(full);
        scriptRef.current?.scrollTo({ top: scriptRef.current.scrollHeight, behavior: 'smooth' });
      }

      // Server signals an empty-provider-response with this sentinel after
      // its own retry already failed. Treat as an error, not a success.
      const EMPTY_SENTINEL = '__EMPTY_RESPONSE__';
      if (full.includes(EMPTY_SENTINEL) || full.trim().length < 100) {
        const detail = full.startsWith(EMPTY_SENTINEL) ? full.slice(EMPTY_SENTINEL.length).replace(/^[:\s]+/, '') : '';
        setScript('');
        throw new Error(
          `The model returned no content${detail ? ` (${detail})` : ''}. Try a different model — some providers (GPT-4 Turbo, certain Kie routes) silently cap output and return empty when the prompt is heavy.`,
        );
      }

      setShowSave(true);
      // Auto-save to history — include audience/context/refs/constraints/series
      // so restoring brings back the full input context, not just the output.
      saveScriptToHistory({
        topic, niche, tone, style, duration, modelId,
        script: full, wordCount: countWords(full),
        audience: audience || undefined,
        context: context || undefined,
        refs: refs.filter(r => !r.loading).map(r => ({
          url: r.url, title: r.title, channelTitle: r.channelTitle,
          viewCount: r.viewCount, thumbnailUrl: r.thumbnailUrl,
        })),
        constraints,
        seriesId: seriesId || undefined,
        seriesTitle: seriesTitle || undefined,
        partNumber: seriesId ? partNumber : undefined,
      });
      setHistoryItems(getScriptHistory());
      // Auto-save draft
      const draft = saveDraft({ id: draftId || undefined, title: topic, niche, step: 'script', topic, tone, style, duration, modelId, script: full, wordCount: countWords(full), constraints, seriesId: seriesId || undefined, seriesTitle: seriesTitle || undefined, partNumber: seriesId ? partNumber : undefined });
      setDraftId(draft.id);
      // Persist to series if linked — cross-device continuity for the next part.
      if (seriesId && full) {
        saveSeriesPart(seriesId, { content: full, partNumber, modelId })
          .then(r => { if (r) toast.success(`Saved as Part ${partNumber} of "${seriesTitle}"`); })
          .catch(() => { /* best-effort */ });
      }
      toast.success('Script generated!');
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  const wordCount = countWords(script);
  const estSeconds = estimateDuration(wordCount);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {scheduleItem && <ScheduleLinkBanner item={scheduleItem} feature="Script Generator" />}
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(124,58,237,0.3), rgba(6,182,212,0.2))', border: '1px solid rgba(124,58,237,0.3)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--accent-purple-bright)' }}>
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="badge badge-purple">AI Script Generator</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Script Generator</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Generate complete, publish-ready YouTube scripts with real-time AI streaming
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
        {/* LEFT PANEL - Controls */}
        <div className="space-y-4">
          <DraftsBanner currentStep="script" onResume={resumeDraft} />
          <div className="glass rounded-xl p-6 space-y-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Script Parameters
            </h2>

            {/* Model */}
            <ModelSelector value={modelId} onChange={setModelId} />

            {/* Niche */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche</label>
              <select
                value={niche}
                onChange={e => setNiche(e.target.value)}
                className="input-field"
                style={{ appearance: 'none' }}
              >
                {niches.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
                <option value="custom">Custom...</option>
              </select>
            </div>

            {/* Topic */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Topic / Title *
              </label>
              <AutocompleteInput
                value={topic}
                onChange={setTopic}
                suggestions={topicHints}
                placeholder="e.g. How antivirus software actually works in 2024"
              />
            </div>

            {/* Duration */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Target Duration: <span style={{ color: 'var(--accent-purple-bright)' }}>{duration} minutes</span>
              </label>
              <div className="flex gap-2 flex-wrap">
                {DURATIONS.map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDuration(d)}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                    style={{
                      background: duration === d ? 'rgba(124,58,237,0.25)' : 'var(--bg-secondary)',
                      border: `1px solid ${duration === d ? 'var(--accent-purple)' : 'var(--border)'}`,
                      color: duration === d ? 'var(--accent-purple-bright)' : 'var(--text-secondary)',
                    }}
                  >
                    {d}m
                  </button>
                ))}
              </div>
            </div>

            {/* Tone */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Tone</label>
              <select value={tone} onChange={e => setTone(e.target.value)} className="input-field" style={{ appearance: 'none' }}>
                {TONES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>

            {/* Style */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Content Style</label>
              <select value={style} onChange={e => setStyle(e.target.value)} className="input-field" style={{ appearance: 'none' }}>
                {STYLES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>

            {/* Audience */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Target Audience <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
              </label>
              <input
                value={audience}
                onChange={e => setAudience(e.target.value)}
                placeholder="e.g. Small business owners, beginners..."
                className="input-field"
              />
            </div>

            {/* Style template + per-call extra context. Lets the user
                save reusable creative directions ("Fast & engaging — cut to
                the chase", "Documentary tone", etc.) and just tweak what's
                different per video. Manage templates in Settings → Templates. */}
            <div>
              <TemplateContextPicker
                fieldType="script"
                templateId={templateId}
                onTemplateChange={setTemplateId}
                context={context}
                onContextChange={setContext}
                label="Script style template"
              />
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
                        Add YouTube videos — AI performs deep forensic analysis of visuals, transcript, pacing, structure, and engagement mechanics
                      </p>
                      <div className="flex gap-2">
                        <input value={refUrl} onChange={e => setRefUrl(e.target.value)}
                          placeholder="https://youtube.com/watch?v=..."
                          className="input-field flex-1" style={{ fontSize: 12, padding: '6px 10px' }}
                          onKeyDown={e => e.key === 'Enter' && addReference()} />
                        <button onClick={addReference} disabled={!refUrl.trim()} className="btn-primary text-xs px-3 py-1.5">Add</button>
                        {/* Pick from saved library — every previously analyzed video
                            is cached server-side and instantly re-attachable here
                            without scraping or re-running deep analysis. */}
                        <button
                          type="button"
                          onClick={() => setShowLibrary(true)}
                          className="btn-secondary text-xs px-3 py-1.5"
                          title="Browse previously analyzed videos and reuse them without re-scraping"
                        >
                          📚 From Library
                        </button>
                      </div>
                      {refs.map(ref => (
                        <div key={ref.id} className="p-2 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                          <div className="flex items-center gap-2">
                            {ref.thumbnailUrl && <img src={ref.thumbnailUrl} alt="" width={64} height={36} className="w-16 h-9 rounded object-cover shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                {ref.loading ? 'Deep analyzing video...' : ref.title}
                              </p>
                              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {ref.loading ? (
                                  <span className="flex items-center gap-1">
                                    <span className="spinner inline-block" style={{ width: 10, height: 10 }} />
                                    Analyzing visuals, transcript, pacing, structure...
                                  </span>
                                ) : `${ref.channelTitle} · ${ref.viewCount.toLocaleString()} views`}
                              </p>
                            </div>
                            <button onClick={() => setRefs(prev => prev.filter(r => r.id !== ref.id))} className="text-xs shrink-0" style={{ color: '#ef4444' }}>×</button>
                          </div>
                          {ref.analysis && (
                            <div className="mt-2 space-y-1">
                              {/* Quick summary badges */}
                              <div className="flex flex-wrap gap-1">
                                {ref.analysis.content_structure?.format_type && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,58,237,0.15)', color: 'var(--accent-purple-bright)' }}>
                                    {ref.analysis.content_structure.format_type}
                                  </span>
                                )}
                                {ref.analysis.pacing_analysis?.overall_tempo && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(6,182,212,0.15)', color: 'var(--accent-cyan-bright)' }}>
                                    {ref.analysis.pacing_analysis.overall_tempo} pace
                                  </span>
                                )}
                                {ref.analysis.thumbnail_analysis?.clickability_score && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(16,185,129,0.15)', color: 'var(--accent-green)' }}>
                                    Thumb: {ref.analysis.thumbnail_analysis.clickability_score}
                                  </span>
                                )}
                              </div>
                              {/* Core insight */}
                              {ref.analysis.what_makes_it_work && (
                                <p className="text-[11px] italic" style={{ color: 'var(--accent-cyan-bright)' }}>
                                  &quot;{ref.analysis.what_makes_it_work}&quot;
                                </p>
                              )}
                              {/* Expandable deep analysis sections */}
                              <details className="mt-1">
                                <summary className="text-xs cursor-pointer font-medium" style={{ color: 'var(--accent-purple-bright)' }}>
                                  View full deep analysis
                                </summary>
                                <div className="mt-2 space-y-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                  {ref.analysis.thumbnail_analysis && (
                                    <details open>
                                      <summary className="font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }}>Thumbnail & Visuals</summary>
                                      <div className="pl-2 mt-1 space-y-0.5">
                                        {ref.analysis.thumbnail_analysis.what_makes_it_click_worthy && <p><strong>Click trigger:</strong> {ref.analysis.thumbnail_analysis.what_makes_it_click_worthy}</p>}
                                        {ref.analysis.thumbnail_analysis.visual_composition && <p><strong>Composition:</strong> {ref.analysis.thumbnail_analysis.visual_composition}</p>}
                                        {ref.analysis.thumbnail_analysis.colors_and_contrast && <p><strong>Colors:</strong> {ref.analysis.thumbnail_analysis.colors_and_contrast}</p>}
                                        {ref.analysis.thumbnail_analysis.text_overlays && <p><strong>Text:</strong> {ref.analysis.thumbnail_analysis.text_overlays}</p>}
                                      </div>
                                    </details>
                                  )}
                                  {ref.analysis.hook_breakdown && (
                                    <details>
                                      <summary className="font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }}>Hook Breakdown</summary>
                                      <div className="pl-2 mt-1 space-y-0.5">
                                        {ref.analysis.hook_breakdown.opening_technique && <p><strong>Technique:</strong> {ref.analysis.hook_breakdown.opening_technique}</p>}
                                        {ref.analysis.hook_breakdown.first_sentence_verbatim && <p><strong>First line:</strong> &quot;{ref.analysis.hook_breakdown.first_sentence_verbatim}&quot;</p>}
                                        {ref.analysis.hook_breakdown.curiosity_mechanism && <p><strong>Curiosity:</strong> {ref.analysis.hook_breakdown.curiosity_mechanism}</p>}
                                        {ref.analysis.hook_breakdown.emotional_trigger && <p><strong>Emotion:</strong> {ref.analysis.hook_breakdown.emotional_trigger}</p>}
                                      </div>
                                    </details>
                                  )}
                                  {ref.analysis.content_structure && (
                                    <details>
                                      <summary className="font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }}>Structure</summary>
                                      <div className="pl-2 mt-1 space-y-0.5">
                                        {ref.analysis.content_structure.narrative_arc && <p><strong>Arc:</strong> {ref.analysis.content_structure.narrative_arc}</p>}
                                        {ref.analysis.content_structure.transition_style && <p><strong>Transitions:</strong> {ref.analysis.content_structure.transition_style}</p>}
                                        {ref.analysis.content_structure.sections?.map((s, i) => (
                                          <p key={i} className="ml-2"><span style={{ color: 'var(--accent-cyan-bright)' }}>[{s.timestamp}]</span> {s.label} — {s.purpose}</p>
                                        ))}
                                      </div>
                                    </details>
                                  )}
                                  {ref.analysis.pacing_analysis && (
                                    <details>
                                      <summary className="font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }}>Pacing & Energy</summary>
                                      <div className="pl-2 mt-1 space-y-0.5">
                                        {ref.analysis.pacing_analysis.energy_map && <p><strong>Energy:</strong> {ref.analysis.pacing_analysis.energy_map}</p>}
                                        {ref.analysis.pacing_analysis.dead_zones && <p><strong>Dead zones:</strong> {ref.analysis.pacing_analysis.dead_zones}</p>}
                                      </div>
                                    </details>
                                  )}
                                  {ref.analysis.language_and_voice && (
                                    <details>
                                      <summary className="font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }}>Voice & Language</summary>
                                      <div className="pl-2 mt-1 space-y-0.5">
                                        {ref.analysis.language_and_voice.tone_profile && <p><strong>Tone:</strong> {ref.analysis.language_and_voice.tone_profile}</p>}
                                        {ref.analysis.language_and_voice.personality_markers && <p><strong>Personality:</strong> {ref.analysis.language_and_voice.personality_markers}</p>}
                                        {ref.analysis.language_and_voice.signature_phrases?.length ? <p><strong>Phrases:</strong> {ref.analysis.language_and_voice.signature_phrases.join(', ')}</p> : null}
                                        {ref.analysis.language_and_voice.audience_address_style && <p><strong>Talks to viewer:</strong> {ref.analysis.language_and_voice.audience_address_style}</p>}
                                      </div>
                                    </details>
                                  )}
                                  {ref.analysis.engagement_mechanics && (
                                    <details>
                                      <summary className="font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }}>Engagement Mechanics</summary>
                                      <div className="pl-2 mt-1 space-y-0.5">
                                        {ref.analysis.engagement_mechanics.curiosity_gaps?.map((g, i) => (
                                          <p key={i}>• Curiosity gap: {g}</p>
                                        ))}
                                        {ref.analysis.engagement_mechanics.pattern_interrupts?.map((p, i) => (
                                          <p key={i}>• <span style={{ color: 'var(--accent-cyan-bright)' }}>[{p.timestamp}]</span> {p.technique}</p>
                                        ))}
                                      </div>
                                    </details>
                                  )}
                                  {ref.analysis.replicable_elements?.length ? (
                                    <details>
                                      <summary className="font-medium cursor-pointer" style={{ color: 'var(--accent-green)' }}>Replicable Techniques</summary>
                                      <div className="pl-2 mt-1">
                                        {ref.analysis.replicable_elements.map((r, i) => (
                                          <p key={i} className="flex gap-1"><span style={{ color: 'var(--accent-green)' }}>{i + 1}.</span> {r}</p>
                                        ))}
                                      </div>
                                    </details>
                                  ) : null}
                                  {ref.analysis.weaknesses?.length ? (
                                    <details>
                                      <summary className="font-medium cursor-pointer" style={{ color: '#ef4444' }}>Weaknesses</summary>
                                      <div className="pl-2 mt-1">
                                        {ref.analysis.weaknesses.map((w, i) => <p key={i}>• {w}</p>)}
                                      </div>
                                    </details>
                                  ) : null}
                                  {ref.analysis.creator_fingerprint && (
                                    <p className="mt-1 italic" style={{ color: 'var(--accent-purple-bright)' }}>
                                      <strong>Creator DNA:</strong> {ref.analysis.creator_fingerprint}
                                    </p>
                                  )}
                                </div>
                              </details>
                            </div>
                          )}
                          {!ref.analysis && ref.styleAnalysis && (
                            <details className="mt-2">
                              <summary className="text-xs cursor-pointer" style={{ color: 'var(--accent-cyan-bright)' }}>View style analysis</summary>
                              <pre className="text-xs mt-1 whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{ref.styleAnalysis}</pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Self-QA controls. When enabled, hits /script-validated which
                scores the script 0–100 and regenerates if below threshold.
                If it can't clear the bar after maxAttempts, the script is
                withheld — per "don't even return it" requirement. */}
            <div className="rounded-lg p-3 border" style={{ borderColor: 'var(--border)', background: 'rgba(124,58,237,0.05)' }}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={selfQA} onChange={e => setSelfQA(e.target.checked)} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Self-QA mode</span>
                <span className="badge badge-purple text-xs">brutal scorer</span>
              </label>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Generates → scores 0–100 → regenerates with feedback. Blocks scripts that score below the threshold.
              </p>
              {selfQA && (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
                    <span>Threshold</span>
                    <span className="font-semibold" style={{ color: 'var(--accent-purple-bright)' }}>{qaThreshold}/100</span>
                  </div>
                  <input
                    type="range" min={50} max={100} step={1}
                    value={qaThreshold}
                    onChange={e => setQaThreshold(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}
            </div>

            {/* Script Options — user-authored exclusions that ride with both
                generation AND the QA review, so intentionally-omitted elements
                (hook, CTA, links) aren't later flagged as issues. Collapsed by
                default; all three toggles plus a free-form custom-rules list. */}
            <div>
              <button
                type="button"
                onClick={() => setOptionsOpen(v => !v)}
                className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wider px-3 py-2 rounded-lg"
                style={{ color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              >
                <span>⚙️ Script Options {constraints.skipHook || constraints.skipSubscribeCTA || constraints.skipClickableLinks || (constraints.custom && constraints.custom.length) ? <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,58,237,0.2)', color: 'var(--accent-purple-bright)' }}>active</span> : null}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: optionsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {optionsOpen && (
                <div className="mt-2 p-3 rounded-lg space-y-2" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    These rules apply to both the generation and the QA review — flagged omissions won&apos;t be treated as issues.
                  </p>
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={!!constraints.skipHook} onChange={e => setConstraints(c => ({ ...c, skipHook: e.target.checked }))} />
                    Zero hook — open directly in-scene / with the story
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={!!constraints.skipSubscribeCTA} onChange={e => setConstraints(c => ({ ...c, skipSubscribeCTA: e.target.checked }))} />
                    No subscribe / like / bell CTAs
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={!!constraints.skipClickableLinks} onChange={e => setConstraints(c => ({ ...c, skipClickableLinks: e.target.checked }))} />
                    No &quot;link in description&quot; / promo links
                  </label>
                  <div>
                    <label className="text-[11px] block mb-1" style={{ color: 'var(--text-muted)' }}>Custom exclusions (one per line — e.g. &quot;no pop-culture refs&quot;)</label>
                    <textarea
                      value={(constraints.custom || []).join('\n')}
                      // Don't trim or filter on every keystroke — that strips
                      // spaces mid-word and prevents typing multiple lines.
                      // Server-side applyScriptConstraints() does the cleanup
                      // before sending to the LLM.
                      onChange={e => setConstraints(c => ({ ...c, custom: e.target.value.split('\n') }))}
                      // Stop ALL keystrokes from bubbling so nothing higher up
                      // (e.g. Cmd/Ctrl+K palette, page shortcuts) can swallow
                      // characters typed inside the textarea.
                      onKeyDown={e => e.stopPropagation()}
                      onKeyUp={e => e.stopPropagation()}
                      placeholder={'no pop-culture refs\nno celebrity names\nno specific dates'}
                      className="input-field w-full"
                      style={{ fontSize: 12, minHeight: 80, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}
                      spellCheck
                      wrap="soft"
                    />
                    <div className="text-[10px] mt-1 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                      <span>
                        Saved automatically — used the next time you generate or refine.
                        {(constraints.custom?.filter(s => s.trim()).length ?? 0) > 0 && (
                          <span style={{ color: '#22c55e', marginLeft: 6 }}>
                            {constraints.custom!.filter(s => s.trim()).length} rule{constraints.custom!.filter(s => s.trim()).length === 1 ? '' : 's'} active
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Series linkage — optional. If enabled and partNumber > 1, the
                generator pulls prior parts as continuity context. */}
            <div>
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
              {seriesId && partNumber > 1 && (
                <div className="mt-2 px-3 py-2 rounded-lg flex items-center gap-2 flex-wrap" style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)' }}>
                  <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Continuity budget:</label>
                  <input
                    type="number" min={2000} max={60000} step={1000}
                    value={seriesTokenBudget}
                    onChange={e => setSeriesTokenBudget(Math.max(2000, Math.min(60000, parseInt(e.target.value) || 15000)))}
                    className="input-field"
                    style={{ width: 90, fontSize: 12, padding: '4px 8px' }}
                  />
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    tokens — prev part full, older parts summarized.
                  </span>
                </div>
              )}
            </div>

            <button
              onClick={generating ? () => abortRef.current?.abort() : generateScript}
              disabled={!topic.trim() || !niche.trim()}
              className={generating ? 'btn-danger w-full justify-center' : 'btn-primary w-full justify-center'}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {generating ? (
                <>
                  <div className="spinner" style={{ width: 16, height: 16 }} />
                  Stop Generation
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  {seriesId && partNumber > 1 ? `Generate Part ${partNumber}` : 'Generate Script'}
                </>
              )}
            </button>
          </div>

          {/* Stats */}
          {script && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass rounded-xl p-4"
            >
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--accent-purple-bright)' }}>{wordCount.toLocaleString()}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Words</div>
                </div>
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--accent-cyan-bright)' }}>{formatDuration(estSeconds)}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Est. Duration</div>
                </div>
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--accent-green)' }}>{Math.ceil(wordCount / 300)}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Sections</div>
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {/* RIGHT PANEL - Output */}
        <div className="space-y-4">
          {qaResult && (
            <div
              className="glass rounded-xl p-4"
              style={{ borderLeft: `3px solid ${qaResult.passed ? 'var(--accent-green)' : '#F87171'}` }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {qaResult.passed ? '✓ Self-QA passed' : '✕ Self-QA blocked this script'}
                  </span>
                  <span className="badge badge-purple text-xs">
                    {qaResult.overall_score ?? '?'}/100 · threshold {qaResult.threshold} · {qaResult.attempts} attempt{qaResult.attempts === 1 ? '' : 's'}
                  </span>
                </div>
                <button
                  onClick={() => setQaResult(null)}
                  className="text-xs"
                  style={{ color: 'var(--text-muted)' }}
                  title="Dismiss"
                >✕</button>
              </div>
              {qaResult.strengths && qaResult.strengths.length > 0 && (
                <details className="mt-1">
                  <summary className="text-xs cursor-pointer" style={{ color: 'var(--accent-green)' }}>Strengths ({qaResult.strengths.length})</summary>
                  <ul className="text-xs mt-1 ml-4 list-disc" style={{ color: 'var(--text-secondary)' }}>
                    {qaResult.strengths.slice(0, 8).map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </details>
              )}
              {qaResult.critical_issues && qaResult.critical_issues.length > 0 && (
                <details className="mt-1" open={!qaResult.passed}>
                  <summary className="text-xs cursor-pointer" style={{ color: '#F87171' }}>Critical issues ({qaResult.critical_issues.length})</summary>
                  <ul className="text-xs mt-1 ml-4 list-disc" style={{ color: 'var(--text-secondary)' }}>
                    {qaResult.critical_issues.slice(0, 8).map((ci, i) => {
                      if (typeof ci === 'string') return <li key={i}>{ci}</li>;
                      const sev = ci.severity ? `[${ci.severity}] ` : '';
                      const loc = ci.location ? `${ci.location}: ` : '';
                      return (
                        <li key={i}>
                          <span>{sev}{loc}{ci.issue || ''}</span>
                          {ci.fix && <div className="ml-2 mt-0.5" style={{ color: 'var(--text-muted)' }}>Fix: {ci.fix}</div>}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
            </div>
          )}
          <div className="glass rounded-xl" style={{ minHeight: 600 }}>
            {/* Output header */}
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Generated Script</span>
                {generating && (
                  <span className="badge badge-purple text-xs flex items-center gap-1">
                    <div className="spinner" style={{ width: 10, height: 10 }} />
                    Streaming...
                  </span>
                )}
              </div>
              {script && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { navigator.clipboard.writeText(script); toast.success('Copied!'); }}
                    className="btn-secondary px-3 py-1.5 text-xs"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    Copy
                  </button>
                  <CopyForElevenLabs script={script} version="v3" />
                  <CopyForElevenLabs script={script} version="v2" />
                  <ExportScript title={topic} script={script} niche={niche} duration={formatDuration(estimateDuration(wordCount))} />
                  <ExportForNarrator title={topic} script={script} niche={niche} duration={formatDuration(estimateDuration(wordCount))} />
                </div>
              )}
            </div>

            {/* Script output */}
            <div
              ref={scriptRef}
              className="p-6 overflow-y-auto"
              style={{ height: 520 }}
            >
              {!script && !generating && (
                <div className="h-full flex flex-col items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mb-4 opacity-30">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                  </svg>
                  <p className="text-sm">Configure parameters and click Generate</p>
                </div>
              )}
              {(script || generating) && (
                <pre
                  className={`whitespace-pre-wrap font-sans text-sm leading-relaxed ${generating && !script ? 'cursor-blink' : ''}`}
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {script}
                  {generating && <span className="inline-block w-0.5 h-4 ml-0.5 align-middle animate-pulse" style={{ background: 'var(--accent-purple-bright)' }} />}
                </pre>
              )}
            </div>
          </div>

          {/* Actions after script generation */}
          <AnimatePresence>
            {showSave && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="space-y-3"
              >
                {/* ✨ Refine — post-generation improvement loop. User describes
                    what to change; the server returns an edited version streaming
                    in place of the current script. Previous version is stashed
                    for one-click Undo. */}
                <div className="glass rounded-xl p-4 space-y-2" style={{ border: '1px solid rgba(124,58,237,0.25)' }}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>✨ Refine this script</h3>
                    <div className="flex gap-2">
                      {previousScriptSnapshot && !refining && (
                        <button onClick={undoRefine} className="btn-secondary text-xs px-3 py-1">↶ Undo</button>
                      )}
                      <button
                        onClick={() => setRefineOpen(v => !v)}
                        className="btn-secondary text-xs px-3 py-1"
                      >
                        {refineOpen ? 'Hide' : 'Open'}
                      </button>
                    </div>
                  </div>
                  {refineOpen && (
                    <div className="space-y-2">
                      <textarea
                        value={refineNotes}
                        onChange={e => setRefineNotes(e.target.value)}
                        placeholder="What should be improved? e.g. 'Make the second section snappier', 'Replace the ColonialPipeline example with Equifax', 'Tighten the middle — it drags'."
                        className="input-field w-full"
                        style={{ minHeight: 80, fontSize: 13 }}
                        disabled={refining}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={refining ? () => refineAbortRef.current?.abort() : refineScript}
                          disabled={!refining && !refineNotes.trim()}
                          className={refining ? 'btn-danger text-sm flex-1 justify-center' : 'btn-primary text-sm flex-1 justify-center'}
                          style={{ justifyContent: 'center' }}
                        >
                          {refining ? (
                            <><div className="spinner" style={{ width: 14, height: 14 }} /> Stop</>
                          ) : (
                            <>✨ Apply refinement</>
                          )}
                        </button>
                      </div>
                      <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Constraints (skip hook / CTA / links) are respected — the refine won&apos;t re-add anything you opted out of.
                      </p>
                    </div>
                  )}
                </div>

                {/* Save as Project — also write back to the linked schedule item
                    (script_id / project_id / status idea → scripting). */}
                <div className="flex items-center gap-2 flex-wrap">
                  <SaveAsProject
                    script={script}
                    niche={niche}
                    topic={topic}
                    modelId={modelId}
                    onSaved={(projectId, scriptId) => {
                      setSavedProjectId(projectId);
                      if (scheduleItemId) {
                        writeBackToSchedule(
                          scheduleItemId,
                          { project_id: projectId, ...(scriptId ? { script_id: scriptId } : {}) },
                          { autoAdvanceTo: 'scripting', advanceLabel: 'Scripting' },
                        );
                      }
                    }}
                  />

                  {/* Mark this script ready for narration. If unsaved, save it
                      first (using the topic as the project title), then jump
                      straight to the project's Narration tab where the
                      AssignDialog opens automatically. */}
                  <button
                    onClick={async () => {
                      if (savedProjectId) {
                        window.location.href = `/projects/${savedProjectId}?tab=narration&assign=1`;
                        return;
                      }
                      if (!script || !topic.trim()) {
                        toast.error('Generate a script first');
                        return;
                      }
                      try {
                        const res = await fetch('/api/projects', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            title: topic.trim(),
                            niche: niche || 'General',
                            topic: topic.trim(),
                            script,
                            modelId,
                          }),
                        });
                        if (!res.ok) throw new Error('Save failed');
                        const data = await res.json();
                        const projectId = data.project?.id || data.id;
                        if (!projectId) throw new Error('No project id returned');
                        setSavedProjectId(projectId);
                        if (scheduleItemId) {
                          writeBackToSchedule(
                            scheduleItemId,
                            { project_id: projectId, ...(data.script?.id ? { script_id: data.script.id } : {}) },
                            { autoAdvanceTo: 'scripting', advanceLabel: 'Scripting' },
                          );
                        }
                        window.location.href = `/projects/${projectId}?tab=narration&assign=1`;
                      } catch {
                        toast.error('Could not save project');
                      }
                    }}
                    disabled={!script}
                    className="btn-secondary text-sm disabled:opacity-50"
                    title={savedProjectId ? 'Open the Narration tab' : 'Save as project and pick a narrator'}
                  >
                    🎤 Send to Narrator
                  </button>
                  {/* Symmetric entry point: if this generation wasn't launched
                      from a schedule item, offer to park it in the schedule
                      right now. Hidden once a link is active. */}
                  {!scheduleItemId && (
                    <AddToScheduleButton
                      title={topic}
                      notes={context || undefined}
                      pillar={niche || undefined}
                      initialStatus="scripting"
                    />
                  )}
                </div>

                {/* Next steps */}
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      // Update draft to QA step
                      if (draftId) saveDraft({ id: draftId, title: topic, niche, step: 'qa', topic, tone, style, duration, modelId, script, wordCount: countWords(script), constraints });
                      // Include constraints in the prefill so QA honors the same exclusions.
                      // `topic` rides along so QA can show the user which script/title they're working on.
                      localStorage.setItem('qa_prefill', JSON.stringify({ script, niche, constraints, topic }));
                      const sched = scheduleItemId ? `&${SCHEDULE_LINK_PARAM}=${scheduleItemId}` : '';
                      window.location.href = `/qa?from=generator${sched}`;
                    }}
                    className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center"
                    style={{ justifyContent: 'center' }}
                  >
                    🔬 Send to QA Engine
                  </button>
                  <button
                    onClick={() => {
                      localStorage.setItem('voiceover_prefill', JSON.stringify({ script, niche }));
                      const sched = scheduleItemId ? `&${SCHEDULE_LINK_PARAM}=${scheduleItemId}` : '';
                      window.location.href = `/voiceover?from=generator${sched}`;
                    }}
                    className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center"
                    style={{ justifyContent: 'center' }}
                  >
                    🎙️ Generate Voiceover
                  </button>
                  <button
                    onClick={() => {
                      localStorage.setItem('seo_prefill', JSON.stringify({ topic, niche, script }));
                      const sched = scheduleItemId ? `&${SCHEDULE_LINK_PARAM}=${scheduleItemId}` : '';
                      window.location.href = `/seo?from=generator${sched}`;
                    }}
                    className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                  >
                    🔍 Optimize SEO
                  </button>
                  <button
                    onClick={() => {
                      localStorage.setItem('thumbnails_prefill', JSON.stringify({ title: topic, niche, description: script?.slice(0, 500) }));
                      const sched = scheduleItemId ? `&${SCHEDULE_LINK_PARAM}=${scheduleItemId}` : '';
                      window.location.href = `/thumbnails?from=generator${sched}`;
                    }}
                    className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                  >
                    🎨 Generate Thumbnail
                  </button>
                  <button
                    onClick={() => {
                      localStorage.setItem('prodoc_prefill', JSON.stringify({ script, niche, topic }));
                      window.location.href = '/production-doc?from=generator';
                    }}
                    className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                  >
                    🎬 Production Doc
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Voiceover panel — appears after script is generated */}
          {script && !generating && (
            <ScriptVoiceoverPanel
              script={script}
              tone={tone}
              style={style}
              targetDuration={duration}
            />
          )}
        </div>
      </div>

      {/* History panel */}
      <HistoryPanel
        title="Script History"
        icon="📝"
        items={historyItems.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: e.topic,
          sublabel: `${e.niche} · ${e.tone} · ${e.duration}min · ${e.wordCount} words`,
          preview: e.script.slice(0, 150),
        }))}
        onRestore={restoreScript}
        onDelete={handleDeleteScript}
        onClearAll={handleClearScripts}
      />

      {/* Reference library — opens via the "📚 From Library" button in the
          Reference Videos section. Pulls a previously-cached deep analysis
          and appends it to the refs array as if it had just been analyzed.
          excludeYoutubeIds prevents re-adding what's already on the page. */}
      <ReferenceLibraryPicker
        open={showLibrary}
        onClose={() => setShowLibrary(false)}
        excludeYoutubeIds={refs
          .map(r => {
            const m = r.url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
            return m ? m[1] : null;
          })
          .filter((id): id is string => !!id)}
        onPick={(picked: PickedReference) => {
          const refId = `lib-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          setRefs(prev => [
            ...prev,
            {
              id: refId,
              url: picked.url,
              title: picked.title,
              channelTitle: picked.channelTitle,
              viewCount: picked.viewCount,
              thumbnailUrl: picked.thumbnailUrl || '',
              styleAnalysis: picked.styleAnalysis,
              analysis: (picked.analysis as VideoAnalysis | null) || null,
              loading: false,
            },
          ]);
        }}
      />
    </div>
  );
}
