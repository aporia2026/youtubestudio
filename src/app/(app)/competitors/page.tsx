'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { formatNumber } from '@/lib/utils';

/* ───── Types ───── */

interface Competitor {
  id: string;
  channel_id: string;
  title: string;
  custom_url: string;
  subscriber_count: number;
  video_count: number;
  view_count: number;
  thumbnail_url: string;
  last_synced: string | null;
}

interface Video {
  id: string;
  video_id: string;
  title: string;
  published_at: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  duration: string;
  thumbnail_url: string;
  outlier_score: number;
  engagement_rate: number;
}

interface AnalysisResult {
  channel_strategy: string;
  what_works: { pattern: string; evidence: string; replicable: string }[];
  what_fails: { pattern: string; evidence: string; lesson?: string }[];
  outlier_breakdown: { title: string; why_it_exploded: string; replicable_elements?: string[] }[];
  content_gaps: string[];
  title_patterns: { winning_formulas: string[]; losing_formulas: string[] };
  steal_these_ideas: { idea: string; based_on: string; your_angle: string }[];
  threat_level: string;
  upload_strategy?: string;
}

type DetailTab = 'videos' | 'outliers' | 'analysis';
type SortKey = 'views' | 'date' | 'outlier';

/* ───── Helpers ───── */

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function engagementStr(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function outlierBadge(score: number) {
  if (score >= 3) return { label: `\u{1F525} ${score.toFixed(1)}x Outlier`, bg: 'rgba(239,68,68,0.15)', color: '#ef4444' };
  if (score < 0.5) return { label: `\u{1F4C9} ${score.toFixed(1)}x Under`, bg: 'rgba(107,114,128,0.15)', color: '#6b7280' };
  return { label: `${score.toFixed(1)}x`, bg: 'rgba(245,158,11,0.1)', color: '#f59e0b' };
}

const THREAT_COLORS: Record<string, { bg: string; color: string }> = {
  low: { bg: 'rgba(16,185,129,0.15)', color: '#10b981' },
  medium: { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b' },
  high: { bg: 'rgba(239,68,68,0.15)', color: '#ef4444' },
  critical: { bg: 'rgba(168,34,34,0.2)', color: '#f87171' },
};

/* ───── Spinner ───── */

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 1s linear infinite' }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeLinecap="round" />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </svg>
  );
}

/* ───── Page ───── */

export default function CompetitorsPage() {
  const [view, setView] = useState<'overview' | 'detail'>('overview');
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [channelUrl, setChannelUrl] = useState('');
  const [adding, setAdding] = useState(false);

  // Detail state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailComp, setDetailComp] = useState<Competitor | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('videos');
  const [sortKey, setSortKey] = useState<SortKey>('date');

  // Sync / delete
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Analysis
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('idea-generator'));
  const [analysisNiche, setAnalysisNiche] = useState('General');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

  /* Fetch competitors list */
  const fetchCompetitors = useCallback(async () => {
    try {
      const res = await fetch('/api/competitors');
      if (!res.ok) throw new Error();
      const data = await res.json();
      setCompetitors(data.competitors ?? []);
    } catch { toast.error('Failed to load competitors'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchCompetitors(); }, [fetchCompetitors]);

  /* Add competitor */
  async function addCompetitor() {
    if (!channelUrl.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/competitors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_url: channelUrl.trim() }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      const data = await res.json();
      setCompetitors(prev => [...prev, data.competitor]);
      setChannelUrl('');
      toast.success(`Added ${data.competitor.title}`);
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Failed to add competitor'); }
    finally { setAdding(false); }
  }

  /* Sync */
  async function syncCompetitor(id: string) {
    setSyncingId(id);
    try {
      const res = await fetch(`/api/competitors/${id}/sync`, { method: 'POST' });
      if (!res.ok) throw new Error();
      const data = await res.json();
      toast.success(`Synced! ${data.new ?? 0} new videos found. Median views: ${formatNumber(data.medianViews ?? 0)}`);
      fetchCompetitors();
      if (selectedId === id) openDetail(id);
    } catch { toast.error('Sync failed'); }
    finally { setSyncingId(null); }
  }

  /* Delete */
  async function deleteCompetitor(id: string) {
    if (!confirm('Remove this competitor and all synced data?')) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/competitors/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      setCompetitors(prev => prev.filter(c => c.id !== id));
      if (selectedId === id) { setView('overview'); setSelectedId(null); }
      toast.success('Competitor removed');
    } catch { toast.error('Delete failed'); }
    finally { setDeletingId(null); }
  }

  /* Open detail */
  async function openDetail(id: string) {
    setSelectedId(id);
    setView('detail');
    setDetailTab('videos');
    setAnalysis(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/competitors/${id}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setDetailComp(data.competitor);
      setVideos(data.videos ?? []);
    } catch { toast.error('Failed to load competitor details'); }
    finally { setDetailLoading(false); }
  }

  /* Analyze */
  async function runAnalysis() {
    if (!selectedId) return;
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const res = await fetch(`/api/competitors/${selectedId}/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, niche: analysisNiche || 'General' }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAnalysis(data.analysis);
      toast.success('Analysis complete');
    } catch { toast.error('Analysis failed'); }
    finally { setAnalyzing(false); }
  }

  /* Sort videos */
  const sortedVideos = [...videos].sort((a, b) => {
    if (sortKey === 'views') return b.view_count - a.view_count;
    if (sortKey === 'outlier') return b.outlier_score - a.outlier_score;
    return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
  });

  const outlierVideos = videos.filter(v => v.outlier_score >= 3);

  /* ─── Render ─── */

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(239,68,68,0.3), rgba(249,115,22,0.2))', border: '1px solid rgba(239,68,68,0.3)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#f97316' }}>
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <span className="badge badge-yellow">Competitor Intel</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Competitor Channel Tracker</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Track competitor channels, discover outlier videos, and steal winning strategies
        </p>
      </div>

      <AnimatePresence mode="wait">
        {view === 'overview' ? (
          <motion.div key="overview" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
            {/* Add Competitor Row */}
            <div className="flex gap-3 mb-6">
              <input
                className="input-field flex-1"
                placeholder="YouTube channel URL or @handle..."
                value={channelUrl}
                onChange={e => setChannelUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCompetitor()}
              />
              <button className="btn-primary whitespace-nowrap flex items-center gap-2" onClick={addCompetitor} disabled={adding || !channelUrl.trim()}>
                {adding ? <Spinner /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>}
                Add Competitor
              </button>
            </div>

            {/* Competitor Cards */}
            {loading ? (
              <div className="flex items-center justify-center py-20" style={{ color: 'var(--text-muted)' }}><Spinner size={28} /></div>
            ) : competitors.length === 0 ? (
              <div className="glass rounded-xl p-12 text-center">
                <p className="text-lg font-medium" style={{ color: 'var(--text-secondary)' }}>No competitors tracked yet</p>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Paste a YouTube channel URL above to start tracking</p>
              </div>
            ) : (
              <motion.div className="space-y-3" initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: 0.06 } } }}>
                {competitors.map(c => (
                  <motion.div
                    key={c.id}
                    variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
                    className="glass rounded-xl p-4 cursor-pointer"
                    style={{ borderLeft: '3px solid rgba(249,115,22,0.4)' }}
                    onClick={() => openDetail(c.id)}
                    whileHover={{ scale: 1.005, transition: { duration: 0.15 } }}
                  >
                    <div className="flex items-center gap-4 flex-wrap">
                      {/* Thumbnail */}
                      <img
                        src={c.thumbnail_url || '/placeholder-avatar.png'}
                        alt={c.title}
                        className="rounded-full flex-shrink-0"
                        style={{ width: 48, height: 48, objectFit: 'cover', border: '2px solid rgba(249,115,22,0.3)' }}
                      />
                      {/* Info */}
                      <div className="flex-1 min-w-[180px]">
                        <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{c.title}</div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{c.custom_url || c.channel_id}</div>
                      </div>
                      {/* Stats */}
                      <StatPill label="Subs" value={formatNumber(c.subscriber_count)} />
                      <StatPill label="Videos" value={formatNumber(c.video_count)} />
                      <StatPill label="Views" value={formatNumber(c.view_count)} />
                      {/* Sync badge */}
                      <div className="text-xs px-2 py-1 rounded-md" style={{
                        background: c.last_synced ? 'rgba(16,185,129,0.1)' : 'rgba(107,114,128,0.15)',
                        color: c.last_synced ? '#10b981' : '#6b7280',
                      }}>
                        {c.last_synced ? `Synced ${timeAgo(c.last_synced)}` : 'Not synced'}
                      </div>
                      {/* Actions */}
                      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => syncCompetitor(c.id)} disabled={syncingId === c.id}>
                          {syncingId === c.id ? <Spinner size={12} /> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>}
                          Sync
                        </button>
                        <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => openDetail(c.id)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
                          Analyze
                        </button>
                        <button
                          className="btn-secondary text-xs flex items-center gap-1"
                          style={{ color: '#ef4444' }}
                          onClick={() => deleteCompetitor(c.id)}
                          disabled={deletingId === c.id}
                        >
                          {deletingId === c.id ? <Spinner size={12} /> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>}
                          Delete
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </motion.div>
        ) : (
          /* ─── Detail View ─── */
          <motion.div key="detail" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
            {/* Back */}
            <button className="btn-secondary text-sm flex items-center gap-2 mb-6" onClick={() => { setView('overview'); setSelectedId(null); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
              Back to Overview
            </button>

            {detailLoading ? (
              <div className="flex items-center justify-center py-20" style={{ color: 'var(--text-muted)' }}><Spinner size={28} /></div>
            ) : detailComp && (
              <>
                {/* Channel Header */}
                <div className="glass rounded-xl p-6 mb-6 flex items-center gap-5 flex-wrap">
                  <img src={detailComp.thumbnail_url || '/placeholder-avatar.png'} alt={detailComp.title}
                    className="rounded-full" style={{ width: 64, height: 64, objectFit: 'cover', border: '3px solid rgba(249,115,22,0.4)' }} />
                  <div className="flex-1">
                    <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{detailComp.title}</h2>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{detailComp.custom_url}</p>
                  </div>
                  <StatPill label="Subscribers" value={formatNumber(detailComp.subscriber_count)} />
                  <StatPill label="Videos" value={formatNumber(detailComp.video_count)} />
                  <StatPill label="Total Views" value={formatNumber(detailComp.view_count)} />
                </div>

                {/* Tabs */}
                <div className="flex gap-2 mb-6">
                  {(['videos', 'outliers', 'analysis'] as DetailTab[]).map(tab => (
                    <button key={tab} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${detailTab === tab ? 'text-white' : ''}`}
                      style={{
                        background: detailTab === tab ? 'linear-gradient(135deg, rgba(239,68,68,0.3), rgba(249,115,22,0.25))' : 'transparent',
                        color: detailTab === tab ? 'var(--text-primary)' : 'var(--text-muted)',
                        border: detailTab === tab ? '1px solid rgba(249,115,22,0.3)' : '1px solid transparent',
                      }}
                      onClick={() => setDetailTab(tab)}
                    >
                      {tab === 'videos' ? `Videos (${videos.length})` : tab === 'outliers' ? `Outliers (${outlierVideos.length})` : 'AI Analysis'}
                    </button>
                  ))}
                </div>

                {/* Tab Content */}
                <AnimatePresence mode="wait">
                  {detailTab === 'videos' && (
                    <motion.div key="videos" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      {/* Sort Controls */}
                      <div className="flex items-center gap-2 mb-4">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Sort by:</span>
                        {([['date', 'Date'], ['views', 'Views'], ['outlier', 'Outlier Score']] as [SortKey, string][]).map(([key, label]) => (
                          <button key={key}
                            className="text-xs px-3 py-1 rounded-md transition-colors"
                            style={{
                              background: sortKey === key ? 'rgba(249,115,22,0.15)' : 'rgba(255,255,255,0.03)',
                              color: sortKey === key ? '#f97316' : 'var(--text-muted)',
                              border: sortKey === key ? '1px solid rgba(249,115,22,0.3)' : '1px solid rgba(255,255,255,0.06)',
                            }}
                            onClick={() => setSortKey(key)}
                          >{label}</button>
                        ))}
                      </div>

                      {/* Table Header */}
                      <div className="glass rounded-t-xl px-4 py-3 grid gap-3 text-xs font-semibold"
                        style={{ color: 'var(--text-muted)', gridTemplateColumns: '48px 1fr 80px 70px 80px 80px 80px 100px' }}>
                        <div />
                        <div>Title</div>
                        <div className="text-right">Views</div>
                        <div className="text-right">Likes</div>
                        <div className="text-right">Comments</div>
                        <div className="text-right">Eng. Rate</div>
                        <div className="text-center">Outlier</div>
                        <div className="text-right">Published</div>
                      </div>

                      {/* Rows */}
                      <div className="glass rounded-b-xl overflow-hidden divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                        {sortedVideos.length === 0 ? (
                          <div className="p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No videos synced yet. Hit Sync on the overview page.</div>
                        ) : sortedVideos.map(v => {
                          const ob = outlierBadge(v.outlier_score);
                          return (
                            <div key={v.id} className="px-4 py-3 grid gap-3 items-center text-sm hover:bg-white/[0.02] transition-colors"
                              style={{ gridTemplateColumns: '48px 1fr 80px 70px 80px 80px 80px 100px' }}>
                              <img src={v.thumbnail_url} alt="" className="rounded" style={{ width: 48, height: 27, objectFit: 'cover' }} />
                              <div className="truncate" style={{ color: 'var(--text-primary)' }} title={v.title}>{v.title}</div>
                              <div className="text-right" style={{ color: 'var(--text-secondary)' }}>{formatNumber(v.view_count)}</div>
                              <div className="text-right" style={{ color: 'var(--text-secondary)' }}>{formatNumber(v.like_count)}</div>
                              <div className="text-right" style={{ color: 'var(--text-secondary)' }}>{formatNumber(v.comment_count)}</div>
                              <div className="text-right" style={{ color: 'var(--text-secondary)' }}>{engagementStr(v.engagement_rate)}</div>
                              <div className="text-center">
                                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: ob.bg, color: ob.color }}>{ob.label}</span>
                              </div>
                              <div className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(v.published_at).toLocaleDateString()}</div>
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}

                  {detailTab === 'outliers' && (
                    <motion.div key="outliers" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      {outlierVideos.length === 0 ? (
                        <div className="glass rounded-xl p-12 text-center">
                          <p className="text-base font-medium" style={{ color: 'var(--text-secondary)' }}>No outlier videos found</p>
                          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Sync more data or this channel doesn&apos;t have standout performers</p>
                        </div>
                      ) : (
                        <motion.div className="grid grid-cols-1 md:grid-cols-2 gap-4" initial="hidden" animate="visible"
                          variants={{ visible: { transition: { staggerChildren: 0.07 } } }}>
                          {outlierVideos.sort((a, b) => b.outlier_score - a.outlier_score).map(v => (
                            <motion.div key={v.id} variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
                              className="glass rounded-xl p-4" style={{ borderLeft: '3px solid #ef4444' }}>
                              <div className="flex gap-3 mb-3">
                                <img src={v.thumbnail_url} alt="" className="rounded-lg flex-shrink-0" style={{ width: 120, height: 68, objectFit: 'cover' }} />
                                <div className="flex-1 min-w-0">
                                  <h3 className="font-semibold text-sm leading-snug line-clamp-2" style={{ color: 'var(--text-primary)' }}>{v.title}</h3>
                                  <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{new Date(v.published_at).toLocaleDateString()}</div>
                                </div>
                              </div>
                              <div className="flex items-center gap-3 flex-wrap">
                                <span className="text-xs px-2 py-1 rounded-full font-semibold" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                                  {v.outlier_score.toFixed(1)}x above median
                                </span>
                                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{formatNumber(v.view_count)} views</span>
                                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Eng: {engagementStr(v.engagement_rate)}</span>
                              </div>
                            </motion.div>
                          ))}
                        </motion.div>
                      )}
                    </motion.div>
                  )}

                  {detailTab === 'analysis' && (
                    <motion.div key="analysis" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <div className="glass rounded-xl p-6 mb-6 space-y-4">
                        <ModelSelector value={modelId} onChange={setModelId} />
                        <div>
                          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche (optional)</label>
                          <input className="input-field" placeholder="e.g. Tech Reviews, Fitness..." value={analysisNiche} onChange={e => setAnalysisNiche(e.target.value)} />
                        </div>
                        <button className="btn-primary flex items-center gap-2" onClick={runAnalysis} disabled={analyzing}>
                          {analyzing ? <Spinner /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" /></svg>}
                          {analyzing ? 'Analyzing...' : 'Analyze Channel'}
                        </button>
                      </div>

                      {analysis && <AnalysisDisplay analysis={analysis} />}
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ───── Sub-components ───── */

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center px-3">
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function AnalysisDisplay({ analysis }: { analysis: AnalysisResult }) {
  const threat = THREAT_COLORS[analysis.threat_level?.toLowerCase()] || THREAT_COLORS.medium;

  return (
    <motion.div className="space-y-6" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      {/* Threat Level */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Threat Level:</span>
        <span className="px-3 py-1 rounded-full text-sm font-bold uppercase" style={{ background: threat.bg, color: threat.color }}>
          {analysis.threat_level}
        </span>
      </div>

      {/* Channel Strategy */}
      <Section title="Channel Strategy">
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{analysis.channel_strategy}</p>
      </Section>

      {/* What Works */}
      <Section title="What Works">
        <div className="space-y-3">
          {analysis.what_works?.map((w, i) => (
            <div key={i} className="glass rounded-lg p-3" style={{ borderLeft: '3px solid #10b981' }}>
              <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{w.pattern}</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{w.evidence}</div>
              {w.replicable && <p className="text-xs mt-1" style={{ color: 'var(--accent-green)' }}><strong>Replicate:</strong> {w.replicable}</p>}
            </div>
          ))}
        </div>
      </Section>

      {/* What Fails */}
      <Section title="What Fails">
        <div className="space-y-3">
          {analysis.what_fails?.map((w, i) => (
            <div key={i} className="glass rounded-lg p-3" style={{ borderLeft: '3px solid #ef4444' }}>
              <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{w.pattern}</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{w.evidence}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Outlier Breakdown */}
      <Section title="Outlier Breakdown">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {analysis.outlier_breakdown?.map((o, i) => (
            <div key={i} className="glass rounded-lg p-3" style={{ borderLeft: '3px solid #f97316' }}>
              <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{o.title}</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{o.why_it_exploded}</div>
              {o.replicable_elements?.length ? <div className="text-xs mt-1" style={{ color: 'var(--accent-green)' }}>Replicate: {o.replicable_elements.join(', ')}</div> : null}
            </div>
          ))}
        </div>
      </Section>

      {/* Content Gaps */}
      <Section title="Content Gaps">
        <ul className="space-y-1">
          {analysis.content_gaps?.map((g, i) => (
            <li key={i} className="text-sm flex items-start gap-2" style={{ color: 'var(--text-secondary)' }}>
              <span style={{ color: '#f97316' }}>&#x2022;</span>{g}
            </li>
          ))}
        </ul>
      </Section>

      {/* Title Patterns */}
      <Section title="Title Patterns">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h4 className="text-xs font-semibold uppercase mb-2" style={{ color: '#10b981' }}>Winning Formulas</h4>
            <ul className="space-y-1">
              {analysis.title_patterns?.winning_formulas?.map((t, i) => (
                <li key={i} className="text-sm" style={{ color: 'var(--text-secondary)' }}>&#x2713; {t}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase mb-2" style={{ color: '#ef4444' }}>Losing Formulas</h4>
            <ul className="space-y-1">
              {analysis.title_patterns?.losing_formulas?.map((t, i) => (
                <li key={i} className="text-sm" style={{ color: 'var(--text-secondary)' }}>&#x2717; {t}</li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* Steal These Ideas */}
      <Section title="Steal These Ideas">
        <motion.div className="grid grid-cols-1 md:grid-cols-2 gap-3" initial="hidden" animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.05 } } }}>
          {analysis.steal_these_ideas?.map((idea, i) => (
            <motion.div key={i} variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
              className="glass rounded-lg p-4" style={{ borderLeft: '3px solid #f59e0b' }}>
              <div className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>{idea.idea}</div>
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Based on: {idea.based_on}</div>
              <div className="text-xs" style={{ color: '#f59e0b' }}>Your angle: {idea.your_angle}</div>
            </motion.div>
          ))}
        </motion.div>
      </Section>
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-xl p-5">
      <h3 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>{title}</h3>
      {children}
    </div>
  );
}
