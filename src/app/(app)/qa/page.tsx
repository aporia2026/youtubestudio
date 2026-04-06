'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { ScoreRing } from '@/components/ui/ScoreRing';
import { scoreLabel } from '@/lib/utils';

type Aggressiveness = 'standard' | 'brutal' | 'nuclear';

interface QACategory {
  score: number;
  assessment: string;
  issues?: string[];
  weak_spots?: string[];
  missing_elements?: string[];
  fix: string;
}

interface CriticalIssue {
  severity: 'critical' | 'major' | 'minor';
  location: string;
  issue: string;
  fix: string;
}

interface RewriteSuggestion {
  original: string;
  improved: string;
  reason: string;
}

interface QAResult {
  overall_score: number;
  verdict: string;
  will_it_perform: string;
  categories: {
    hook_strength: QACategory;
    retention_potential: QACategory;
    content_quality: QACategory;
    audience_targeting: QACategory;
    cta_effectiveness: QACategory;
    seo_optimization: QACategory;
    pacing_flow: QACategory;
  };
  critical_issues: CriticalIssue[];
  strengths: string[];
  rewrite_suggestions: RewriteSuggestion[];
  title_suggestions: string[];
  thumbnail_ideas: string[];
  next_pass_focus: string;
}

const SEVERITY_COLORS = {
  critical: { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', text: '#ef4444', label: '🔴 Critical' },
  major: { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)', text: '#f59e0b', label: '🟡 Major' },
  minor: { bg: 'rgba(99,102,241,0.1)', border: 'rgba(99,102,241,0.3)', text: '#6366f1', label: '🔵 Minor' },
};

const CATEGORY_LABELS: Record<string, { label: string; emoji: string }> = {
  hook_strength: { label: 'Hook Strength', emoji: '🎣' },
  retention_potential: { label: 'Retention', emoji: '📊' },
  content_quality: { label: 'Content Quality', emoji: '💎' },
  audience_targeting: { label: 'Audience Fit', emoji: '🎯' },
  cta_effectiveness: { label: 'CTA', emoji: '📢' },
  seo_optimization: { label: 'SEO', emoji: '🔍' },
  pacing_flow: { label: 'Pacing & Flow', emoji: '⚡' },
  human_authenticity: { label: 'Human Feel', emoji: '🧠' },
  natural_speech: { label: 'Natural Speech', emoji: '🗣️' },
  logic_coherence: { label: 'Logic & Flow', emoji: '🔗' },
};

export default function QAPage() {
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('qa-engine'));
  const [script, setScript] = useState('');
  const [niche, setNiche] = useState('Cybersecurity & Antivirus');
  const [aggressiveness, setAggressiveness] = useState<Aggressiveness>('brutal');
  const [running, setRunning] = useState(false);
  const [passNumber, setPassNumber] = useState(1);
  const [results, setResults] = useState<QAResult[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const [activeTab, setActiveTab] = useState<'scores' | 'issues' | 'rewrites' | 'suggestions' | 'apply'>('scores');
  const [approvedFixes, setApprovedFixes] = useState<Set<string>>(new Set());
  const [applyingFixes, setApplyingFixes] = useState(false);
  const [fixedScript, setFixedScript] = useState('');
  const fixedScriptRef = useRef<HTMLDivElement>(null);

  // Load prefill from Script Generator
  useEffect(() => {
    try {
      const prefill = localStorage.getItem('qa_prefill');
      if (prefill) {
        localStorage.removeItem('qa_prefill');
        const data = JSON.parse(prefill);
        if (data.script) setScript(data.script);
        if (data.niche) setNiche(data.niche);
      }
    } catch {}
  }, []);

  function toggleFix(key: string) {
    setApprovedFixes(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function selectAllFixes() {
    if (!currentResult) return;
    const all = new Set<string>();
    currentResult.critical_issues?.forEach((_, i) => all.add(`issue-${i}`));
    currentResult.rewrite_suggestions?.forEach((_, i) => all.add(`rewrite-${i}`));
    setApprovedFixes(all);
  }

  async function applyFixes() {
    if (approvedFixes.size === 0) { toast.error('Select at least one fix to apply'); return; }
    if (!script.trim()) { toast.error('No script to fix'); return; }
    if (!currentResult) return;

    setApplyingFixes(true);
    setFixedScript('');
    setActiveTab('apply');

    const fixes: string[] = [];
    currentResult.critical_issues?.forEach((issue, i) => {
      if (approvedFixes.has(`issue-${i}`)) fixes.push(`Fix "${issue.location}": ${issue.fix}`);
    });
    currentResult.rewrite_suggestions?.forEach((rw, i) => {
      if (approvedFixes.has(`rewrite-${i}`)) fixes.push(`Replace "${rw.original}" → "${rw.improved}" (${rw.reason})`);
    });

    try {
      const res = await fetch('/api/qa/apply-fixes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          script,
          qaFeedback: `Score: ${currentResult.overall_score}/100. Verdict: ${currentResult.verdict}`,
          approvedFixes: fixes,
        }),
      });

      if (!res.ok) throw new Error('Apply fixes failed');

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No stream');

      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setFixedScript(full);
        fixedScriptRef.current?.scrollTo({ top: fixedScriptRef.current.scrollHeight });
      }

      toast.success('Fixed script generated!');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply fixes');
    } finally {
      setApplyingFixes(false);
    }
  }

  async function runQA() {
    if (!script.trim() || script.length < 100) {
      toast.error('Please paste a script (minimum 100 characters)');
      return;
    }
    setRunning(true);
    try {
      const previousFeedback = results.length > 0
        ? `Score: ${results[results.length - 1].overall_score}/100. Verdict: ${results[results.length - 1].verdict}`
        : undefined;

      const res = await fetch('/api/qa/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          script,
          niche,
          aggressiveness,
          passNumber,
          previousFeedback,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Server error' }));
        throw new Error(err.error || 'QA failed');
      }

      const data = await res.json();
      const newResults = [...results, data.result];
      setResults(newResults);
      setActiveResult(newResults.length - 1);
      setPassNumber(p => p + 1);
      toast.success(`QA Pass ${passNumber} complete! Score: ${data.result.overall_score}/100`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'QA analysis failed');
    } finally {
      setRunning(false);
    }
  }

  function resetQA() {
    setResults([]);
    setPassNumber(1);
    setActiveResult(0);
    setApprovedFixes(new Set());
    setFixedScript('');
    setActiveTab('scores');
  }

  const currentResult = results[activeResult];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(236,72,153,0.3), rgba(245,158,11,0.2))', border: '1px solid rgba(236,72,153,0.3)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#ec4899' }}>
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M11 8v3l2 2" />
            </svg>
          </div>
          <span className="badge badge-pink">Multi-Pass QA Engine</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Script QA Engine</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Brutally critique your script — as many passes as needed
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">
        {/* LEFT PANEL */}
        <div className="space-y-4">
          <div className="glass rounded-xl p-6 space-y-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>QA Configuration</h2>

            <ModelSelector value={modelId} onChange={setModelId} />

            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche Context</label>
              <input value={niche} onChange={e => setNiche(e.target.value)} className="input-field" placeholder="e.g. Cybersecurity & Antivirus" />
            </div>

            {/* Aggressiveness selector */}
            <div>
              <label className="block text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>QA Aggressiveness</label>
              <div className="space-y-2">
                {([
                  { id: 'standard' as const, label: 'Standard', emoji: '📋', desc: 'Thorough & constructive' },
                  { id: 'brutal' as const, label: 'Brutal', emoji: '🔥', desc: 'No sugar-coating, all weaknesses exposed' },
                  { id: 'nuclear' as const, label: 'Nuclear', emoji: '☢️', desc: 'Zero tolerance — maximum harshness' },
                ] as const).map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAggressiveness(opt.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-all"
                    style={{
                      background: aggressiveness === opt.id ? 'rgba(236,72,153,0.15)' : 'var(--bg-secondary)',
                      border: `1px solid ${aggressiveness === opt.id ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
                    }}
                  >
                    <span className="text-lg">{opt.emoji}</span>
                    <div>
                      <div className="text-sm font-semibold" style={{ color: aggressiveness === opt.id ? '#ec4899' : 'var(--text-primary)' }}>
                        {opt.label}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{opt.desc}</div>
                    </div>
                    {aggressiveness === opt.id && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ec4899" strokeWidth="2.5" className="ml-auto">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Script input */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Script to Analyze
                {script && <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>({script.split(/\s+/).filter(Boolean).length} words)</span>}
              </label>
              <textarea
                value={script}
                onChange={e => setScript(e.target.value)}
                placeholder="Paste your script here..."
                className="input-field"
                style={{ minHeight: 200 }}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={runQA}
                disabled={running || !script.trim()}
                className="btn-primary flex-1 justify-center"
                style={{ justifyContent: 'center' }}
              >
                {running ? (
                  <>
                    <div className="spinner" style={{ width: 16, height: 16 }} />
                    Analyzing Pass {passNumber}...
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                    </svg>
                    Run QA Pass {passNumber}
                  </>
                )}
              </button>
              {results.length > 0 && (
                <button onClick={resetQA} className="btn-secondary px-3">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Pass history */}
          {results.length > 0 && (
            <div className="glass rounded-xl p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
                QA History ({results.length} passes)
              </h3>
              <div className="space-y-2">
                {results.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => { setActiveResult(i); setApprovedFixes(new Set()); setFixedScript(''); }}
                    className="w-full flex items-center gap-3 p-3 rounded-lg text-left transition-all"
                    style={{
                      background: activeResult === i ? 'rgba(124,58,237,0.1)' : 'var(--bg-secondary)',
                      border: `1px solid ${activeResult === i ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`,
                    }}
                  >
                    <div className="text-center" style={{ minWidth: 40 }}>
                      <div className="text-lg font-bold" style={{
                        color: r.overall_score >= 75 ? '#10b981' : r.overall_score >= 50 ? '#f59e0b' : '#ef4444'
                      }}>
                        {r.overall_score}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Pass {i + 1}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{scoreLabel(r.overall_score)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT PANEL - Results */}
        <div>
          {!currentResult && !running && (
            <div className="glass rounded-xl h-full min-h-96 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
              <div className="text-center">
                <div className="text-5xl mb-4">🔬</div>
                <p className="text-sm">Run a QA pass to see detailed analysis</p>
                <p className="text-xs mt-2 opacity-60">The more passes, the more refined the critique</p>
              </div>
            </div>
          )}

          {running && (
            <div className="glass rounded-xl h-full min-h-96 flex items-center justify-center">
              <div className="text-center">
                <div className="spinner mx-auto mb-4" style={{ width: 32, height: 32 }} />
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {aggressiveness === 'nuclear' ? '☢️ Nuclear critique in progress...' :
                   aggressiveness === 'brutal' ? '🔥 Brutally analyzing your script...' :
                   '📋 Analyzing your script...'}
                </p>
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>This may take 15-30 seconds</p>
              </div>
            </div>
          )}

          {currentResult && !running && (
            <motion.div
              key={activeResult}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-4"
            >
              {/* Score overview */}
              <div className="glass rounded-xl p-6">
                <div className="flex items-start gap-6">
                  <ScoreRing score={currentResult.overall_score} size={100} strokeWidth={8} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                        Pass {activeResult + 1} · {aggressiveness.toUpperCase()} Mode
                      </span>
                    </div>
                    <p className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                      {currentResult.verdict}
                    </p>
                    <p className="text-sm" style={{ color: currentResult.will_it_perform.toLowerCase().startsWith('yes') ? '#10b981' : currentResult.will_it_perform.toLowerCase().startsWith('maybe') ? '#f59e0b' : '#ef4444' }}>
                      Performance Outlook: {currentResult.will_it_perform}
                    </p>
                  </div>
                </div>

                {/* Next pass focus */}
                {currentResult.next_pass_focus && (
                  <div className="mt-4 px-4 py-3 rounded-lg" style={{ background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)' }}>
                    <span className="text-xs font-semibold" style={{ color: 'var(--accent-purple-bright)' }}>
                      Next Pass Focus:
                    </span>
                    <span className="text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>{currentResult.next_pass_focus}</span>
                  </div>
                )}
              </div>

              {/* Tabs */}
              <div className="flex gap-2 flex-wrap">
                {([
                  { id: 'scores' as const, label: 'Category Scores' },
                  { id: 'issues' as const, label: `☑ Issues (${currentResult.critical_issues?.length || 0})` },
                  { id: 'rewrites' as const, label: `☑ Rewrites (${currentResult.rewrite_suggestions?.length || 0})` },
                  { id: 'suggestions' as const, label: 'Titles & Thumbnails' },
                  { id: 'apply' as const, label: approvedFixes.size > 0 ? `✨ Apply ${approvedFixes.size} Fix${approvedFixes.size > 1 ? 'es' : ''}` : '✨ Apply Fixes' },
                ] as const).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
                    style={{
                      background: activeTab === tab.id ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                      border: `1px solid ${activeTab === tab.id ? 'var(--accent-purple)' : 'var(--border)'}`,
                      color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <AnimatePresence mode="wait">
                {/* Scores tab */}
                {activeTab === 'scores' && (
                  <motion.div key="scores" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
                    {/* Category score rings */}
                    <div className="glass rounded-xl p-6">
                      <div className="grid grid-cols-5 md:grid-cols-10 gap-3 mb-6">
                        {Object.entries(currentResult.categories).map(([key, cat]) => (
                          <ScoreRing key={key} score={cat.score} size={60} strokeWidth={5} label={`${CATEGORY_LABELS[key]?.emoji || ''} ${CATEGORY_LABELS[key]?.label || key}`} />
                        ))}
                      </div>

                      {/* Detailed category assessments */}
                      <div className="space-y-4">
                        {Object.entries(currentResult.categories).map(([key, cat]) => (
                          <div key={key} className="p-4 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                {CATEGORY_LABELS[key]?.emoji} {CATEGORY_LABELS[key]?.label || key}
                              </h4>
                              <span className="text-sm font-bold" style={{
                                color: cat.score >= 75 ? '#10b981' : cat.score >= 50 ? '#f59e0b' : '#ef4444'
                              }}>
                                {cat.score}/100
                              </span>
                            </div>
                            <div className="progress-bar mb-3">
                              <div className="progress-fill" style={{ width: `${cat.score}%` }} />
                            </div>
                            <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>{cat.assessment}</p>
                            <div className="p-3 rounded-lg mt-2" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)' }}>
                              <span className="text-xs font-semibold" style={{ color: '#10b981' }}>Fix: </span>
                              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{cat.fix}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Strengths */}
                    {currentResult.strengths?.length > 0 && (
                      <div className="glass rounded-xl p-5">
                        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--accent-green)' }}>✅ Strengths</h3>
                        <ul className="space-y-2">
                          {currentResult.strengths.map((s, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                              <span style={{ color: 'var(--accent-green)', flexShrink: 0 }}>•</span> {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </motion.div>
                )}

                {/* Issues tab */}
                {activeTab === 'issues' && (
                  <motion.div key="issues" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass rounded-xl p-5 space-y-3">
                    {currentResult.critical_issues?.length > 0 && (
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Check fixes to approve for rewriting</span>
                        <button onClick={selectAllFixes} className="text-xs" style={{ color: 'var(--accent-purple-bright)' }}>Select All</button>
                      </div>
                    )}
                    {currentResult.critical_issues?.length === 0 && (
                      <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No critical issues found in this pass</p>
                    )}
                    {currentResult.critical_issues?.map((issue, i) => {
                      const colors = SEVERITY_COLORS[issue.severity];
                      const fixKey = `issue-${i}`;
                      const isApproved = approvedFixes.has(fixKey);
                      return (
                        <div key={i} className="p-4 rounded-lg transition-all" style={{
                          background: colors.bg, border: `1px solid ${isApproved ? '#10b981' : colors.border}`,
                        }}>
                          <div className="flex items-center gap-2 mb-2">
                            <input type="checkbox" checked={isApproved} onChange={() => toggleFix(fixKey)}
                              className="w-4 h-4 cursor-pointer" style={{ accentColor: 'var(--accent-purple)' }} />
                            <span className="text-xs font-bold" style={{ color: colors.text }}>{colors.label}</span>
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>— {issue.location}</span>
                          </div>
                          <p className="text-sm mb-2" style={{ color: 'var(--text-primary)' }}>{issue.issue}</p>
                          <div className="p-2 rounded" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)' }}>
                            <span className="text-xs font-semibold" style={{ color: '#10b981' }}>Fix: </span>
                            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{issue.fix}</span>
                          </div>
                        </div>
                      );
                    })}
                    {approvedFixes.size > 0 && (
                      <button onClick={applyFixes} className="btn-primary w-full justify-center mt-3" style={{ justifyContent: 'center' }}>
                        ✨ Apply {approvedFixes.size} Selected Fix{approvedFixes.size > 1 ? 'es' : ''} → Get Fixed Script
                      </button>
                    )}
                  </motion.div>
                )}

                {/* Rewrites tab */}
                {activeTab === 'rewrites' && (
                  <motion.div key="rewrites" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass rounded-xl p-5 space-y-4">
                    {currentResult.rewrite_suggestions?.length > 0 && (
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Check rewrites to approve</span>
                        <button onClick={selectAllFixes} className="text-xs" style={{ color: 'var(--accent-purple-bright)' }}>Select All</button>
                      </div>
                    )}
                    {currentResult.rewrite_suggestions?.length === 0 && (
                      <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No rewrite suggestions this pass</p>
                    )}
                    {currentResult.rewrite_suggestions?.map((rw, i) => {
                      const fixKey = `rewrite-${i}`;
                      const isApproved = approvedFixes.has(fixKey);
                      return (
                        <div key={i} className="rounded-lg overflow-hidden transition-all" style={{
                          border: `1px solid ${isApproved ? '#10b981' : 'var(--border)'}`,
                        }}>
                          <div className="flex items-center gap-2 px-3 pt-3">
                            <input type="checkbox" checked={isApproved} onChange={() => toggleFix(fixKey)}
                              className="w-4 h-4 cursor-pointer" style={{ accentColor: 'var(--accent-purple)' }} />
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Approve this rewrite</span>
                          </div>
                          <div className="p-3" style={{ background: 'rgba(239,68,68,0.07)' }}>
                            <div className="text-xs font-semibold mb-1" style={{ color: '#ef4444' }}>❌ Original</div>
                            <p className="text-sm italic" style={{ color: 'var(--text-secondary)' }}>"{rw.original}"</p>
                          </div>
                          <div className="p-3" style={{ background: 'rgba(16,185,129,0.07)' }}>
                            <div className="text-xs font-semibold mb-1" style={{ color: '#10b981' }}>✅ Improved</div>
                            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>"{rw.improved}"</p>
                            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{rw.reason}</p>
                          </div>
                        </div>
                      );
                    })}
                    {approvedFixes.size > 0 && (
                      <button onClick={applyFixes} className="btn-primary w-full justify-center mt-3" style={{ justifyContent: 'center' }}>
                        ✨ Apply {approvedFixes.size} Selected Fix{approvedFixes.size > 1 ? 'es' : ''} → Get Fixed Script
                      </button>
                    )}
                  </motion.div>
                )}

                {/* Suggestions tab */}
                {activeTab === 'suggestions' && (
                  <motion.div key="suggestions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                    <div className="glass rounded-xl p-5">
                      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>🎯 Title Suggestions</h3>
                      <div className="space-y-2">
                        {currentResult.title_suggestions?.map((t, i) => (
                          <div key={i} className="flex items-center gap-3 p-3 rounded-lg"
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                            <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>#{i + 1}</span>
                            <span className="text-sm flex-1" style={{ color: 'var(--text-primary)' }}>{t}</span>
                            <button
                              onClick={() => { navigator.clipboard.writeText(t); toast.success('Copied!'); }}
                              className="text-xs" style={{ color: 'var(--text-muted)' }}
                            >
                              Copy
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="glass rounded-xl p-5">
                      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>🖼️ Thumbnail Ideas</h3>
                      <div className="space-y-2">
                        {currentResult.thumbnail_ideas?.map((t, i) => (
                          <div key={i} className="p-3 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                            {i + 1}. {t}
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* Apply Fixes tab */}
                {activeTab === 'apply' && (
                  <motion.div key="apply" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                    {!fixedScript && !applyingFixes && approvedFixes.size === 0 && (
                      <div className="glass rounded-xl p-8 text-center">
                        <div className="text-5xl mb-4">✨</div>
                        <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>How to fix your script</p>
                        <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                          Go to the <strong>Issues</strong> or <strong>Rewrites</strong> tabs, check the fixes you want to apply, then come back here.
                        </p>
                        <div className="flex gap-3 justify-center">
                          <button onClick={() => setActiveTab('issues')} className="btn-primary text-sm">
                            Go to Issues ({currentResult?.critical_issues?.length || 0})
                          </button>
                          <button onClick={() => setActiveTab('rewrites')} className="btn-secondary text-sm">
                            Go to Rewrites ({currentResult?.rewrite_suggestions?.length || 0})
                          </button>
                        </div>
                      </div>
                    )}
                    {!fixedScript && !applyingFixes && approvedFixes.size > 0 && (
                      <div className="glass rounded-xl p-8 text-center">
                        <div className="text-5xl mb-4">✅</div>
                        <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                          {approvedFixes.size} fix{approvedFixes.size > 1 ? 'es' : ''} selected
                        </p>
                        <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                          The AI will rewrite your script applying only these approved changes.
                        </p>
                        <button onClick={applyFixes} className="btn-primary mx-auto text-base px-8 py-3">
                          ✨ Apply {approvedFixes.size} Fix{approvedFixes.size > 1 ? 'es' : ''} and Rewrite Script
                        </button>
                      </div>
                    )}
                    {applyingFixes && (
                      <div className="glass rounded-xl p-8 text-center">
                        <div className="spinner mx-auto mb-4" style={{ width: 28, height: 28 }} />
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Applying fixes and rewriting script...</p>
                        {fixedScript && (
                          <pre className="mt-4 text-left whitespace-pre-wrap text-xs leading-relaxed" style={{ color: 'var(--text-secondary)', maxHeight: 400, overflow: 'auto' }}>
                            {fixedScript}
                          </pre>
                        )}
                      </div>
                    )}
                    {fixedScript && !applyingFixes && (
                      <div className="glass rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                          <span className="text-sm font-semibold" style={{ color: 'var(--accent-green)' }}>✅ Fixed Script</span>
                          <div className="flex gap-2">
                            <button onClick={() => { navigator.clipboard.writeText(fixedScript); toast.success('Copied!'); }}
                              className="btn-secondary text-xs px-3 py-1.5">Copy</button>
                            <button onClick={() => { setScript(fixedScript); toast.success('Script updated — run another QA pass!'); }}
                              className="btn-primary text-xs px-3 py-1.5">Use as New Script</button>
                          </div>
                        </div>
                        <div ref={fixedScriptRef} className="p-5 overflow-auto" style={{ maxHeight: 600 }}>
                          <pre className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {fixedScript}
                          </pre>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
