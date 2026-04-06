'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { ScriptVoiceoverPanel } from '@/components/ui/ScriptVoiceoverPanel';
import { getFeatureDefaultModelId, getModelById } from '@/lib/ai-models';
import { countWords, estimateDuration, formatDuration } from '@/lib/utils';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { getScriptHistory, saveScript as saveScriptToHistory, deleteScriptEntry, clearScriptHistory, type ScriptHistoryEntry } from '@/lib/history';

const TONES = ['Engaging & Friendly', 'Authoritative & Expert', 'Conversational', 'Dramatic & Urgent', 'Humorous & Relaxed', 'Educational & Clear'];
const STYLES = ['Explainer', 'Story-driven', 'Tutorial', 'Comparison', 'Opinion / Commentary', 'Top 10 List', 'Documentary'];
const DURATIONS = [3, 5, 7, 10, 12, 15, 20];

interface VideoRef {
  id: string;
  url: string;
  title: string;
  channelTitle: string;
  viewCount: number;
  thumbnailUrl: string;
  styleAnalysis: string | null;
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
  const [saving, setSaving] = useState(false);
  const [projectTitle, setProjectTitle] = useState('');
  const [showSave, setShowSave] = useState(false);
  const scriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reference videos
  const [refUrl, setRefUrl] = useState('');
  const [refs, setRefs] = useState<VideoRef[]>([]);
  const [showRefs, setShowRefs] = useState(false);

  // History
  const [historyItems, setHistoryItems] = useState<ScriptHistoryEntry[]>(() => getScriptHistory());

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
    const url = refUrl.trim();
    if (!/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/.test(url)) {
      toast.error('Please enter a valid YouTube URL');
      return;
    }
    setRefUrl('');
    const refId = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setRefs(prev => [...prev, { id: refId, url, title: 'Analyzing...', channelTitle: '', viewCount: 0, thumbnailUrl: '', styleAnalysis: null, loading: true }]);

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
        loading: false,
      } : r));
      toast.success(`Analyzed: ${data.metadata.title.slice(0, 40)}...`);
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

    // Build reference context
    let refContext = refs.filter(r => !r.loading && r.styleAnalysis).map(r =>
      `**"${r.title}"** by ${r.channelTitle} (${r.viewCount.toLocaleString()} views)\nStyle: ${r.styleAnalysis}`
    ).join('\n\n');
    if (refContext.length > 4000) refContext = refContext.slice(0, 4000) + '\n\n[... truncated ...]';

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
      toast.success('Script generated!');
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  async function saveScript() {
    if (!script || !projectTitle.trim()) { toast.error('Enter a project title'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: projectTitle, niche, topic, script, modelId }),
      });
      if (!res.ok) throw new Error('Save failed');
      toast.success('Project saved!');
      setShowSave(false);
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
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
                        Add YouTube videos — AI analyzes their style and matches your script to it
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
                                {ref.loading ? 'Analyzing...' : ref.title}
                              </p>
                              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {ref.loading ? <span className="spinner inline-block" style={{ width: 10, height: 10 }} /> : `${ref.channelTitle} · ${ref.viewCount.toLocaleString()} views`}
                              </p>
                            </div>
                            <button onClick={() => setRefs(prev => prev.filter(r => r.id !== ref.id))} className="text-xs shrink-0" style={{ color: '#ef4444' }}>×</button>
                          </div>
                          {ref.styleAnalysis && (
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
                  <button
                    onClick={() => { const a = document.createElement('a'); a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(script); a.download = `${topic.slice(0, 30)}.txt`; a.click(); }}
                    className="btn-secondary px-3 py-1.5 text-xs"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                    Export
                  </button>
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

          {/* Save to project */}
          <AnimatePresence>
            {showSave && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="glass rounded-xl p-5"
                style={{ border: '1px solid rgba(124,58,237,0.3)' }}
              >
                <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
                  Save as Project
                </h3>
                <div className="flex gap-3">
                  <input
                    value={projectTitle}
                    onChange={e => setProjectTitle(e.target.value)}
                    placeholder="Project title..."
                    className="input-field flex-1"
                    onKeyDown={e => e.key === 'Enter' && saveScript()}
                  />
                  <button onClick={saveScript} disabled={saving || !projectTitle.trim()} className="btn-primary">
                    {saving ? <div className="spinner" style={{ width: 16, height: 16 }} /> : 'Save'}
                  </button>
                </div>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => { localStorage.setItem('qa_prefill', JSON.stringify({ script, niche })); window.location.href = '/qa?from=generator'; }}
                    className="btn-secondary text-xs px-3 py-1.5"
                  >
                    🔬 Send to QA Engine
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
