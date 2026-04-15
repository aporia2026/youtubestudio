'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { DraftsBanner } from '@/components/ui/DraftsBanner';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { getSeoHistory, saveSeoEntry, deleteSeoEntry, clearSeoHistory, getRecentTopics, type SeoHistoryEntry } from '@/lib/history';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { saveDraft, getActiveDraft, type WorkflowDraft } from '@/lib/drafts';

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

export default function SeoPage() {
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('seo-optimizer'));
  const [topic, setTopic] = useState('');
  const [topicHints, setTopicHints] = useState<string[]>([]);
  const [niche, setNiche] = useState('');
  const [niches, setNiches] = useState<{ id: string; name: string }[]>([]);
  const [targetKeywords, setTargetKeywords] = useState('');
  const [script, setScript] = useState('');
  const [existingTitle, setExistingTitle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<SeoResult | null>(null);
  const [activeTab, setActiveTab] = useState<'titles' | 'description' | 'tags'>('titles');
  const [expandedTitle, setExpandedTitle] = useState<number | null>(null);
  const [historyItems, setHistoryItems] = useState<SeoHistoryEntry[]>(() => getSeoHistory());
  const [draftId, setDraftId] = useState<string | null>(() => getActiveDraft()?.id || null);

  useEffect(() => {
    setTopicHints(getRecentTopics());
    fetch('/api/niches').then(r => r.json()).then(data => {
      setNiches(data.niches || []);
      if (data.niches?.length) setNiche(data.niches[0].name);
    }).catch(() => {});

    try {
      const prefill = localStorage.getItem('seo_prefill');
      if (prefill) {
        localStorage.removeItem('seo_prefill');
        const data = JSON.parse(prefill);
        if (data.topic) setTopic(data.topic);
        if (data.niche) setNiche(data.niche);
        if (data.script) setScript(data.script);
      }
    } catch {}
  }, []);

  async function handleGenerate() {
    if (!topic.trim()) { toast.error('Please enter a topic or title'); return; }
    if (!niche) { toast.error('Please select a niche'); return; }
    setGenerating(true);
    setResult(null);
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
      // Save to history
      const titles = (data.result as any).titles || [];
      const bestTitle = [...titles].sort((a: any, b: any) => (b.score || 0) - (a.score || 0))[0];
      saveSeoEntry({
        topic, niche, modelId,
        titlesCount: titles.length,
        bestTitle: bestTitle?.title || topic,
        bestScore: bestTitle?.score || 0,
        tagsCount: ((data.result as any).tags || []).length,
      });
      setHistoryItems(getSeoHistory());
      // Save draft
      const draft = saveDraft({
        id: draftId || undefined, title: topic, niche, step: 'seo',
        topic, modelId, seoTitle: bestTitle?.title,
        seoDescription: (data.result as any).description?.above_fold,
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

  return (
    <div className="p-8 max-w-6xl mx-auto">
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
          label: e.bestTitle,
          sublabel: `${e.niche} · ${e.titlesCount} titles · Best: ${e.bestScore}/100 · ${e.tagsCount} tags`,
        }))}
        onRestore={(id) => {
          const entry = historyItems.find(e => e.id === id);
          if (entry) { setTopic(entry.topic || entry.bestTitle); setNiche(entry.niche); toast.success('Restored from history'); }
        }}
        onDelete={(id) => { deleteSeoEntry(id); setHistoryItems(getSeoHistory()); }}
        onClearAll={() => { clearSeoHistory(); setHistoryItems([]); }}
      />
    </div>
  );
}
