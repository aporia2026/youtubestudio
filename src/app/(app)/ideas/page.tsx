'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';

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
  url: string;
  title: string;
  channelTitle: string;
  viewCount: number;
  thumbnailUrl: string;
  styleAnalysis: string | null;
  loading: boolean;
}

interface RedditPost {
  title: string;
  score: number;
  numComments: number;
  url: string;
  subreddit: string;
}

export default function IdeasPage() {
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('idea-generator'));
  const [niche, setNiche] = useState('');
  const [niches, setNiches] = useState<{ id: string; name: string }[]>([]);
  const [count, setCount] = useState(10);
  const [audience, setAudience] = useState('');
  const [focus, setFocus] = useState('mixed');
  const [videoType, setVideoType] = useState('any');
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [ideas, setIdeas] = useState<VideoIdea[]>([]);
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // Reference videos
  const [refUrl, setRefUrl] = useState('');
  const [refs, setRefs] = useState<VideoRef[]>([]);
  const [showRefs, setShowRefs] = useState(false);

  // Reddit research
  const [showReddit, setShowReddit] = useState(false);
  const [redditPosts, setRedditPosts] = useState<RedditPost[]>([]);
  const [redditSummary, setRedditSummary] = useState('');
  const [redditLoading, setRedditLoading] = useState(false);
  const [redditSubs, setRedditSubs] = useState('');

  useEffect(() => {
    fetch('/api/niches').then(r => r.json()).then(data => {
      setNiches(data.niches || []);
      if (data.niches?.length) setNiche(data.niches[0].name);
    }).catch(() => {});
  }, []);

  async function addReference() {
    if (!refUrl.trim()) return;
    const url = refUrl.trim();
    setRefUrl('');
    const placeholder: VideoRef = { url, title: 'Analyzing...', channelTitle: '', viewCount: 0, thumbnailUrl: '', styleAnalysis: null, loading: true };
    setRefs(prev => [...prev, placeholder]);
    const idx = refs.length;

    try {
      const res = await fetch('/api/youtube/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, modelId }),
      });
      if (!res.ok) throw new Error('Analysis failed');
      const data = await res.json();
      setRefs(prev => prev.map((r, i) => i === idx ? {
        url,
        title: data.metadata.title,
        channelTitle: data.metadata.channelTitle,
        viewCount: data.metadata.viewCount,
        thumbnailUrl: data.metadata.thumbnailUrl,
        styleAnalysis: data.styleAnalysis,
        loading: false,
      } : r));
      toast.success(`Analyzed: ${data.metadata.title.slice(0, 40)}...`);
    } catch {
      setRefs(prev => prev.filter((_, i) => i !== idx));
      toast.error('Failed to analyze video');
    }
  }

  async function fetchReddit() {
    if (!niche.trim()) { toast.error('Select a niche first'); return; }
    setRedditLoading(true);
    try {
      const subs = redditSubs.split(',').map(s => s.trim()).filter(Boolean);
      const res = await fetch('/api/research/reddit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ niche, subreddits: subs, limit: 20 }),
      });
      if (!res.ok) throw new Error('Reddit fetch failed');
      const data = await res.json();
      setRedditPosts(data.posts || []);
      setRedditSummary(data.summary || '');
      toast.success(`Found ${data.totalFound} Reddit discussions`);
    } catch {
      toast.error('Reddit research failed');
    } finally {
      setRedditLoading(false);
    }
  }

  async function generateIdeas() {
    if (!niche.trim()) { toast.error('Please select a niche'); return; }
    setGenerating(true);
    setIdeas([]);
    setSavedIds(new Set());

    // Build reference context
    const refContext = refs.filter(r => !r.loading && r.styleAnalysis).map(r =>
      `**"${r.title}"** by ${r.channelTitle} (${r.viewCount.toLocaleString()} views)\nStyle: ${r.styleAnalysis}`
    ).join('\n\n');

    try {
      const res = await fetch('/api/generate/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId, niche, count, audience, focus,
          videoType: videoType !== 'any' ? videoType : undefined,
          referenceContext: refContext || undefined,
          redditContext: redditSummary || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Generation failed');
      }
      const data = await res.json();
      setIdeas(data.ideas || []);
      toast.success(`Generated ${data.ideas?.length || 0} video ideas!`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
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

  async function sendToGenerator(idea: VideoIdea) {
    const params = new URLSearchParams({ topic: idea.title });
    window.location.href = `/generator?${params.toString()}`;
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
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

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Controls */}
        <div className="glass rounded-xl p-6 space-y-5 h-fit">
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Generator Settings</h2>

          <ModelSelector value={modelId} onChange={setModelId} />

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche</label>
            <select value={niche} onChange={e => setNiche(e.target.value)} className="input-field" style={{ appearance: 'none' }}>
              {niches.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
            </select>
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
                      Paste YouTube URLs — AI will analyze their style and use it as inspiration
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
                    {refs.map((ref, i) => (
                      <div key={i} className="p-2 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                        <div className="flex items-center gap-2">
                          {ref.thumbnailUrl && <img src={ref.thumbnailUrl} alt="" className="w-16 h-9 rounded object-cover shrink-0" />}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                              {ref.loading ? 'Analyzing...' : ref.title}
                            </p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {ref.loading ? <span className="spinner inline-block" style={{ width: 10, height: 10 }} /> : `${ref.channelTitle} · ${ref.viewCount.toLocaleString()} views`}
                            </p>
                          </div>
                          <button onClick={() => setRefs(prev => prev.filter((_, j) => j !== i))} className="text-xs shrink-0" style={{ color: '#ef4444' }}>×</button>
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

          {/* Reddit Research */}
          <div>
            <button onClick={() => setShowReddit(!showReddit)}
              className="flex items-center gap-2 text-sm font-medium w-full"
              style={{ color: redditPosts.length > 0 ? '#ff4500' : 'var(--text-secondary)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ transform: showReddit ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                <path d="M9 18l6-6-6-6" />
              </svg>
              🔍 Reddit Research {redditPosts.length > 0 && <span className="text-xs" style={{ color: '#ff4500' }}>({redditPosts.length} posts)</span>}
            </button>
            <AnimatePresence>
              {showReddit && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden">
                  <div className="mt-3 space-y-2">
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Scrape Reddit for trending discussions in your niche
                    </p>
                    <input value={redditSubs} onChange={e => setRedditSubs(e.target.value)}
                      placeholder="Subreddits (optional, comma separated)"
                      className="input-field" style={{ fontSize: 12, padding: '6px 10px' }} />
                    <button onClick={fetchReddit} disabled={redditLoading || !niche.trim()}
                      className="btn-secondary text-xs w-full justify-center" style={{ width: '100%', justifyContent: 'center' }}>
                      {redditLoading ? <><div className="spinner" style={{ width: 12, height: 12 }} /> Scraping Reddit...</> : '🔍 Scrape Reddit for Ideas'}
                    </button>
                    {redditPosts.length > 0 && (
                      <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg p-2" style={{ background: 'var(--bg-secondary)' }}>
                        {redditPosts.slice(0, 10).map((post, i) => (
                          <a key={i} href={post.url} target="_blank" rel="noopener noreferrer"
                            className="block p-2 rounded text-xs transition-colors hover:opacity-80"
                            style={{ color: 'var(--text-secondary)' }}>
                            <span style={{ color: '#ff4500' }}>r/{post.subreddit}</span>
                            <span className="mx-1">·</span>
                            <span>{post.title.slice(0, 80)}</span>
                            <span className="ml-1" style={{ color: 'var(--text-muted)' }}>({post.score}↑ {post.numComments}💬)</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button onClick={generateIdeas} disabled={generating || !niche.trim()}
            className="btn-primary w-full justify-center" style={{ width: '100%', justifyContent: 'center' }}>
            {generating ? (
              <><div className="spinner" style={{ width: 16, height: 16 }} />Generating Ideas...</>
            ) : (
              <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>Generate {count} Ideas</>
            )}
          </button>
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
                              {idea.confidence_score && (
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
    </div>
  );
}
