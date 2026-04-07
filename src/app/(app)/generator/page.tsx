'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { ScriptVoiceoverPanel } from '@/components/ui/ScriptVoiceoverPanel';
import { getFeatureDefaultModelId, getModelById } from '@/lib/ai-models';
import { countWords, estimateDuration, formatDuration } from '@/lib/utils';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { SaveAsProject } from '@/components/ui/SaveAsProject';
import { ExportScript } from '@/components/ui/ExportScript';
import { DraftsBanner } from '@/components/ui/DraftsBanner';
import { getScriptHistory, saveScript as saveScriptToHistory, deleteScriptEntry, clearScriptHistory, type ScriptHistoryEntry } from '@/lib/history';
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

export default function GeneratorPage() {
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('script-generator'));
  const [topic, setTopic] = useState('');
  const [niche, setNiche] = useState('');
  const [niches, setNiches] = useState<{ id: string; name: string }[]>([]);
  const [duration, setDuration] = useState(7);
  const [tone, setTone] = useState(TONES[0]);
  const [style, setStyle] = useState(STYLES[0]);
  const [audience, setAudience] = useState('');
  const [context, setContext] = useState('');
  const [generating, setGenerating] = useState(false);
  const [script, setScript] = useState('');
  // saving/projectTitle removed — handled by SaveAsProject component
  const [showSave, setShowSave] = useState(false);
  const scriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reference videos
  const [refUrl, setRefUrl] = useState('');
  const [refs, setRefs] = useState<VideoRef[]>([]);
  const [showRefs, setShowRefs] = useState(false);

  // History & drafts
  const [historyItems, setHistoryItems] = useState<ScriptHistoryEntry[]>(() => getScriptHistory());
  const [draftId, setDraftId] = useState<string | null>(() => getActiveDraft()?.id || null);

  function resumeDraft(draft: WorkflowDraft) {
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
    setDraftId(draft.id);
    toast.success('Draft resumed');
  }

  function restoreScript(id: string) {
    const entry = historyItems.find(e => e.id === id);
    if (!entry) return;
    setTopic(entry.topic);
    setNiche(entry.niche);
    setTone(entry.tone);
    setStyle(entry.style);
    setDuration(entry.duration);
    // Only restore model if it still exists
    if (getModelById(entry.modelId)) setModelId(entry.modelId);
    setScript(entry.script);
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
      toast.success(`Deep analysis complete: ${data.metadata.title.slice(0, 40)}...`);
    } catch {
      setRefs(prev => prev.filter(r => r.id !== refId));
      toast.error('Failed to analyze video');
    }
  }

  useEffect(() => {
    // Read prefill FIRST (before async fetch can overwrite)
    let prefillNiche: string | null = null;
    try {
      const prefill = localStorage.getItem('generator_prefill');
      if (prefill) {
        localStorage.removeItem('generator_prefill');
        const data = JSON.parse(prefill);
        if (data.topic) setTopic(data.topic);
        if (data.niche) { setNiche(data.niche); prefillNiche = data.niche; }
        if (data.audience) setAudience(data.audience);
        if (data.context) setContext(data.context);
        if (data.style && STYLES.includes(data.style)) setStyle(data.style);
        if (data.refs && Array.isArray(data.refs)) {
          setRefs(data.refs);
          setShowRefs(true);
        }
      }
    } catch {}

    fetch('/api/niches').then(r => r.json()).then(data => {
      setNiches(data.niches || []);
      // Only set default niche if no prefill was applied
      if (!prefillNiche && data.niches?.length) setNiche(data.niches[0].name);
    }).catch(() => {});
  }, []);

  async function generateScript() {
    if (!topic.trim()) { toast.error('Please enter a topic'); return; }
    if (!niche.trim()) { toast.error('Please select a niche'); return; }

    setGenerating(true);
    setScript('');
    setShowSave(false);
    abortRef.current = new AbortController();

    // Build rich reference context from deep analysis
    const refContext = refs.filter(r => !r.loading && r.styleAnalysis).map((r, idx) =>
      `### REFERENCE VIDEO ${idx + 1}: "${r.title}" by ${r.channelTitle} (${r.viewCount.toLocaleString()} views)\n${r.styleAnalysis}`
    ).join('\n\n---\n\n');

    try {
      const res = await fetch('/api/generate/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, topic, niche, duration, tone, style, audience, context, referenceContext: refContext || undefined }),
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

      setShowSave(true);
      // Auto-save to history
      saveScriptToHistory({ topic, niche, tone, style, duration, modelId, script: full, wordCount: countWords(full) });
      setHistoryItems(getScriptHistory());
      // Auto-save draft
      const draft = saveDraft({ id: draftId || undefined, title: topic, niche, step: 'script', topic, tone, style, duration, modelId, script: full, wordCount: countWords(full) });
      setDraftId(draft.id);
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
              <input
                value={topic}
                onChange={e => setTopic(e.target.value)}
                placeholder="e.g. How antivirus software actually works in 2024"
                className="input-field"
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

            {/* Additional context */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Additional Context <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
              </label>
              <textarea
                value={context}
                onChange={e => setContext(e.target.value)}
                placeholder="Key points to include, competitors to mention, specific angle..."
                className="input-field"
                style={{ minHeight: 80 }}
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
                  Generate Script
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
                  <ExportScript title={topic} script={script} niche={niche} duration={formatDuration(estimateDuration(wordCount))} />
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
                {/* Save as Project */}
                <SaveAsProject script={script} niche={niche} topic={topic} modelId={modelId} />

                {/* Next steps */}
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      // Update draft to QA step
                      if (draftId) saveDraft({ id: draftId, title: topic, niche, step: 'qa', topic, tone, style, duration, modelId, script, wordCount: countWords(script) });
                      localStorage.setItem('qa_prefill', JSON.stringify({ script, niche }));
                      window.location.href = '/qa?from=generator';
                    }}
                    className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center"
                    style={{ justifyContent: 'center' }}
                  >
                    🔬 Send to QA Engine
                  </button>
                  <button
                    onClick={() => {
                      localStorage.setItem('voiceover_prefill', JSON.stringify({ script, niche }));
                      window.location.href = '/voiceover?from=generator';
                    }}
                    className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center"
                    style={{ justifyContent: 'center' }}
                  >
                    🎙️ Generate Voiceover
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
    </div>
  );
}
