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
  duration_seconds?: number;
  thumbnail_url: string;
  outlier_score: number;
  engagement_rate: number;
  description?: string;
  tags?: string[];
  video_analysis?: VideoForensics;
  thumbnail_analysis?: ThumbnailAnalysis;
}

interface Analytics {
  dataset: { videoCount: number; oldestPublishedAt: string | null; newestPublishedAt: string | null; spanDays: number };
  performance: { medianViews: number; meanViews: number; p10Views: number; p90Views: number; stddevViews: number; medianEngagementRate: number; medianLikeRate: number; medianCommentRate: number };
  cadence: { uploadsPerWeek: number; medianGapDays: number; stddevGapDays: number; consistencyScore: number; dayOfWeekHistogram: Record<string, number>; hourOfDayHistogram: Record<string, number>; bestDayByAvgViews: string | null; bestHourByAvgViews: number | null };
  duration: { buckets: Record<string, { count: number; avgViews: number; avgEngagement: number }>; bestBucket: string; worstBucket: string };
  titles: { medianLength: number; pctWithQuestion: number; pctWithNumber: number; pctWithBrackets: number; pctAllCaps: number; pctWithEmoji: number; topWordsOverall: { word: string; count: number }[]; topWordsInTopPerformers: { word: string; count: number; lift: number }[]; topWordsInBottomPerformers: { word: string; count: number }[] };
  tags: { avgTagsPerVideo: number; topTags: { tag: string; count: number; avgViews: number }[]; tagsInTopPerformers: { tag: string; count: number }[]; tagsInBottomPerformers: { tag: string; count: number }[] };
  descriptions: { medianLength: number; pctWithHashtags: number; pctWithLinks: number; pctWithChapters: number; avgHashtagsPerVideo: number };
  categories: { label: string; count: number; avgViews: number }[];
  trend: { rollingAvgViews: { date: string; avg: number }[]; firstHalfAvgViews: number; secondHalfAvgViews: number; momentum: string; momentumPct: number };
}

interface DeepAnalysis {
  executive_summary?: string;
  threat_level?: string;
  threat_justification?: string;
  performance_snapshot?: { median_views: number; p90_views: number; median_engagement_pct: number; uploads_per_week: number; consistency_score: number; momentum: string; momentum_pct: number; interpretation: string };
  what_they_do_right?: { strength: string; quantitative_evidence: string; video_examples: string[]; why_it_works: string; replicable_tactic: string }[];
  what_they_do_wrong?: { weakness: string; quantitative_evidence: string; video_examples: string[]; cost_to_them: string; lesson_for_user: string }[];
  top_video_deep_dives?: { video_title: string; video_id: string; views: number; outlier_multiple: number; why_it_succeeded: { title_mechanics: string; duration_fit: string; tag_strategy: string; publish_timing: string; audience_signal: string }; replicable_elements: string[] }[];
  bottom_video_postmortems?: { video_title: string; video_id: string; views: number; views_vs_median_pct: number; why_it_underperformed: { title_issues: string; duration_mismatch: string; tag_gap: string; timing_issue: string }; lesson: string }[];
  title_formula_extraction?: { winning_patterns: { pattern: string; evidence_videos: string[]; stat: string }[]; losing_patterns: { pattern: string; evidence_videos: string[]; stat: string }[]; recommended_title_templates: string[] };
  cadence_verdict?: { assessment: string; evidence: string; best_publishing_window: string; recommendation: string };
  duration_strategy?: { their_best_bucket: string; their_worst_bucket: string; avg_views_by_bucket: string; recommendation_for_user: string };
  audience_insights?: { what_audience_loves: string[]; what_audience_complains_about: string[]; audience_quotes: { quote: string; video_id: string; likes: number }[]; sentiment_verdict: string; note?: string };
  content_gaps_for_user?: { gap: string; opportunity: string; adjacent_evidence: string }[];
  steal_these_ideas?: { video_idea_title: string; inspired_by: string; your_angle: string; target_duration_seconds: number; recommended_tags: string[]; hook_suggestion: string }[];
  thumbnail_strategy_hypothesis?: string;
  one_page_action_plan?: string[];
  data_quality_note?: string;
}

interface ThumbnailAnalysis {
  composition: { layout: string; focal_point: string; rule_of_thirds: string; visual_hierarchy_score: string };
  colors: { dominant_palette: string[]; contrast_rating: string; uses_saturation_pop: boolean; color_psychology: string };
  text_overlay: { present: boolean; exact_text: string | null; font_style: string; text_readability_at_small_size: string; text_percent_of_frame: string };
  human_element: { face_present: boolean; facial_expression: string; eye_contact_with_camera: boolean; gesture: string };
  subjects_and_objects: string[];
  clickbait_elements: { arrows_or_circles: boolean; red_vs_green_contrast: boolean; numbers_visible: boolean; emotional_provocation: string };
  why_this_probably_worked_or_failed: string;
  replicable_design_brief: { layout_to_copy: string; color_direction: string; text_formula: string; emotional_target: string; specific_dos: string[]; specific_donts: string[] };
}

interface Idea {
  title: string;
  hook: string;
  premise: string;
  inspired_by: { competitor_video?: string; video_id?: string; or_gap?: string };
  user_differentiator: string;
  target_duration_seconds: number;
  recommended_tags: string[];
  thumbnail_direction: string;
  predicted_difficulty: string;
  why_this_will_work: string;
}

type DetailTab = 'videos' | 'analytics' | 'top' | 'bottom' | 'thumbnails' | 'forensics' | 'analysis' | 'ideas';

interface VideoForensics {
  error?: string;
  video_summary?: { one_line_pitch: string; core_promise_to_viewer: string; delivers_on_promise: string };
  hook_analysis?: { first_15_seconds_transcript: string; first_15_seconds_visuals: string; hook_type: string; hook_effectiveness_score: string; retention_risk_in_hook: string };
  structural_breakdown?: { timestamp: string; section: string; description: string; purpose: string }[];
  pacing_and_editing?: { estimated_cuts_per_minute: string; cut_style: string; b_roll_density: string; music_present: string; music_style: string; energy_curve: string; dead_zones: string[] };
  on_screen_graphics?: { lower_thirds: string; text_overlays_present: string; key_text_overlays: { timestamp: string; verbatim_text: string; purpose: string }[]; graphics_quality: string; branded_elements: string };
  verbal_content?: { transcript_excerpts: { timestamp: string; verbatim_quote: string; why_notable: string }[]; speaking_style: string; filler_words_observed: string; claims_made: { claim: string; evidence_provided_in_video: string; verifiable: string }[] };
  visual_production?: { setting: string; lighting: string; color_grading: string; camera_setup: string; host_appearance: string; backdrop_elements: string[] };
  monetization_signals?: { sponsor_segment_present: string; sponsor_timestamp: string | null; sponsor_brand: string | null; sponsor_integration_quality: string; affiliate_or_product_mentions: string[]; merch_or_own_product_pitch: string };
  calls_to_action?: { timestamp: string; cta_type: string; verbatim: string; placement_quality: string }[];
  thumbnail_vs_video_alignment?: { title_promise_kept: string; clickbait_assessment: string; satisfaction_prediction: string };
  audience_targeting?: { assumed_knowledge_level: string; language_complexity: string; cultural_or_regional_signals: string[]; ideal_viewer_persona: string };
  what_made_it_work_or_fail?: { top_3_strengths: { strength: string; timestamp_evidence: string; explanation: string }[]; top_3_weaknesses: { weakness: string; timestamp_evidence: string; explanation: string }[]; single_biggest_lesson: string };
  replicable_playbook_for_user?: { structural_template: string; hook_template: string; must_steal_techniques: string[]; do_not_copy: string[]; estimated_production_difficulty: string; estimated_production_cost: string };
  data_quality_note?: string;
}

interface BatchProgressItem {
  videoRowId: string;
  videoTitle: string;
  status: 'pending' | 'analyzing' | 'done' | 'error';
  cached?: boolean;
  error?: string;
}
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

function engagementStr(rate: number): string { return `${(rate * 100).toFixed(2)}%`; }
function pctStr(n: number): string { return `${(n * 100).toFixed(0)}%`; }
function fmtDuration(sec: number): string {
  if (!sec) return '—';
  const m = Math.floor(sec / 60); const s = sec % 60;
  if (sec >= 3600) return `${Math.floor(sec/3600)}h${(m%60).toString().padStart(2,'0')}m`;
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function outlierBadge(score: number) {
  if (score >= 3) return { label: `🔥 ${score.toFixed(1)}x`, bg: 'rgba(239,68,68,0.15)', color: '#ef4444' };
  if (score < 0.5) return { label: `📉 ${score.toFixed(1)}x`, bg: 'rgba(107,114,128,0.15)', color: '#6b7280' };
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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailComp, setDetailComp] = useState<Competitor | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('videos');
  const [sortKey, setSortKey] = useState<SortKey>('date');

  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('competitor-analysis'));
  const [analysisNiche, setAnalysisNiche] = useState('General');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<DeepAnalysis | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  // Thumbnails
  const [thumbAnalyses, setThumbAnalyses] = useState<Record<string, ThumbnailAnalysis>>({});
  const [thumbAnalyzing, setThumbAnalyzing] = useState<string | null>(null);

  // Ideas
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [userAngle, setUserAngle] = useState('');
  const [savingIdeaIdx, setSavingIdeaIdx] = useState<number | null>(null);

  // Video Forensics
  const [videoAnalyses, setVideoAnalyses] = useState<Record<string, VideoForensics>>({});
  const [videoAnalyzing, setVideoAnalyzing] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressItem[]>([]);
  const [batchCount, setBatchCount] = useState(10);
  const [batchStrategy, setBatchStrategy] = useState<'top-views' | 'outliers'>('top-views');
  const [expandedForensics, setExpandedForensics] = useState<string | null>(null);

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

  async function syncCompetitor(id: string) {
    setSyncingId(id);
    try {
      const res = await fetch(`/api/competitors/${id}/sync`, { method: 'POST' });
      if (!res.ok) throw new Error();
      const data = await res.json();
      toast.success(`Synced ${data.synced} videos (${data.new ?? 0} new). Median: ${formatNumber(data.medianViews ?? 0)}`);
      fetchCompetitors();
      if (selectedId === id) openDetail(id);
    } catch { toast.error('Sync failed'); }
    finally { setSyncingId(null); }
  }

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

  async function openDetail(id: string) {
    setSelectedId(id);
    setView('detail');
    setDetailTab('videos');
    setAnalysis(null);
    setAnalytics(null);
    setIdeas([]);
    setThumbAnalyses({});
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

  async function runAnalysis() {
    if (!selectedId) return;
    setAnalyzing(true); setAnalysis(null); setAnalytics(null);
    try {
      const res = await fetch(`/api/competitors/${selectedId}/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, niche: analysisNiche || 'General' }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      const data = await res.json();
      setAnalysis(data.analysis);
      setAnalytics(data.analytics);
      toast.success('Analysis complete');
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Analysis failed'); }
    finally { setAnalyzing(false); }
  }

  async function analyzeThumbnail(videoRowId: string) {
    if (!selectedId) return;
    setThumbAnalyzing(videoRowId);
    try {
      const res = await fetch(`/api/competitors/${selectedId}/thumbnail-analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, videoRowId }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      const data = await res.json();
      setThumbAnalyses(prev => ({ ...prev, [videoRowId]: data.analysis }));
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Thumbnail analysis failed'); }
    finally { setThumbAnalyzing(null); }
  }

  async function generateIdeas() {
    if (!selectedId) return;
    setIdeasLoading(true); setIdeas([]);
    try {
      const contentGaps = analysis?.content_gaps_for_user?.map(g => g.gap) || [];
      const res = await fetch(`/api/competitors/${selectedId}/ideas`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, niche: analysisNiche || 'General', userAngle, contentGaps }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      const data = await res.json();
      setIdeas(data.ideas || []);
      toast.success(`Generated ${data.ideas?.length || 0} ideas`);
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Failed'); }
    finally { setIdeasLoading(false); }
  }

  async function saveIdea(idea: Idea, idx: number) {
    setSavingIdeaIdx(idx);
    try {
      const res = await fetch('/api/ideas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: analysisNiche,
          title: idea.title,
          hook: idea.hook,
          description: idea.premise + '\n\nWhy: ' + idea.why_this_will_work + '\n\nDifferentiator: ' + idea.user_differentiator,
          tags: idea.recommended_tags,
          estimated_difficulty: idea.predicted_difficulty,
        }),
      });
      if (!res.ok) throw new Error();
      toast.success('Idea saved to library');
    } catch { toast.error('Failed to save idea'); }
    finally { setSavingIdeaIdx(null); }
  }

  /* Load any cached forensics + thumbnail analyses from the loaded videos */
  useEffect(() => {
    if (!selectedId) return;
    const cachedV: Record<string, VideoForensics> = {};
    const cachedT: Record<string, ThumbnailAnalysis> = {};
    for (const v of videos) {
      if (v.video_analysis) cachedV[v.id] = v.video_analysis;
      if (v.thumbnail_analysis) cachedT[v.id] = v.thumbnail_analysis;
    }
    if (Object.keys(cachedV).length) setVideoAnalyses(prev => ({ ...cachedV, ...prev }));
    if (Object.keys(cachedT).length) setThumbAnalyses(prev => ({ ...cachedT, ...prev }));
  }, [selectedId, videos]);

  async function analyzeOneVideo(videoRowId: string, force = false) {
    if (!selectedId) return;
    setVideoAnalyzing(videoRowId);
    try {
      const res = await fetch(`/api/competitors/${selectedId}/video-analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, videoRowId, niche: analysisNiche, force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setVideoAnalyses(prev => ({ ...prev, [videoRowId]: data.analysis }));
      setExpandedForensics(videoRowId);
      toast.success(data.cached ? 'Loaded cached analysis' : 'Video analyzed');
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Video analysis failed'); }
    finally { setVideoAnalyzing(null); }
  }

  async function runBatchVideoAnalysis() {
    if (!selectedId) return;
    setBatchRunning(true);
    setBatchProgress([]);
    try {
      const res = await fetch(`/api/competitors/${selectedId}/video-analyze-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, niche: analysisNiche, count: batchCount, strategy: batchStrategy }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Batch failed');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(trimmed.slice(6));
            if (evt.type === 'start') {
              setBatchProgress(Array.from({ length: evt.total }, () => ({
                videoRowId: '', videoTitle: '', status: 'pending' as const,
              })));
            } else if (evt.type === 'progress') {
              setBatchProgress(prev => {
                const idx = prev.findIndex(p => p.videoRowId === evt.videoRowId);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = { ...next[idx], status: evt.status, cached: evt.cached, error: evt.error };
                  return next;
                }
                // Find first pending slot
                const pendIdx = prev.findIndex(p => p.status === 'pending' && !p.videoRowId);
                if (pendIdx >= 0) {
                  const next = [...prev];
                  next[pendIdx] = { videoRowId: evt.videoRowId, videoTitle: evt.videoTitle, status: evt.status, cached: evt.cached, error: evt.error };
                  return next;
                }
                return [...prev, { videoRowId: evt.videoRowId, videoTitle: evt.videoTitle, status: evt.status, cached: evt.cached, error: evt.error }];
              });
            } else if (evt.type === 'complete') {
              toast.success(`Batch complete — analyzed ${evt.analyzed}, failed ${evt.failed}`);
              // Refresh detail to pull cached analyses from DB
              if (selectedId) openDetail(selectedId);
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Batch failed');
    } finally {
      setBatchRunning(false);
    }
  }

  function sendToScript(idea: Idea) {
    try {
      localStorage.setItem('generator_prefill', JSON.stringify({
        topic: idea.title,
        niche: analysisNiche,
        audience: '',
        context: `Hook: ${idea.hook}\n\nPremise: ${idea.premise}\n\nDifferentiator: ${idea.user_differentiator}\n\nRecommended tags: ${idea.recommended_tags?.join(', ')}\n\nTarget duration: ~${Math.round((idea.target_duration_seconds || 600) / 60)} min`,
      }));
      window.location.href = '/generator';
    } catch { toast.error('Could not hand off to script generator'); }
  }

  const sortedVideos = [...videos].sort((a, b) => {
    if (sortKey === 'views') return b.view_count - a.view_count;
    if (sortKey === 'outlier') return b.outlier_score - a.outlier_score;
    return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
  });

  const topVideos = [...videos].sort((a, b) => b.view_count - a.view_count).slice(0, Math.max(5, Math.ceil(videos.length * 0.1)));
  const bottomVideos = [...videos].sort((a, b) => a.view_count - b.view_count).slice(0, Math.max(5, Math.ceil(videos.length * 0.1)));

  /* ─── Render ─── */

  return (
    <div className="p-8 max-w-7xl mx-auto">
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
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Competitor Deep Intelligence</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Forensic data-driven analysis: cadence, duration, titles, tags, audience sentiment, thumbnails, and idea handoff
        </p>
      </div>

      <AnimatePresence mode="wait">
        {view === 'overview' ? (
          <motion.div key="overview" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
            <div className="flex gap-3 mb-6">
              <input
                className="input-field flex-1"
                placeholder="YouTube channel URL or @handle..."
                value={channelUrl}
                onChange={e => setChannelUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCompetitor()}
              />
              <button className="btn-primary whitespace-nowrap flex items-center gap-2" onClick={addCompetitor} disabled={adding || !channelUrl.trim()}>
                {adding ? <Spinner /> : '+'} Add Competitor
              </button>
            </div>

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
                      <img src={c.thumbnail_url || '/placeholder-avatar.png'} alt={c.title}
                        className="rounded-full flex-shrink-0"
                        style={{ width: 48, height: 48, objectFit: 'cover', border: '2px solid rgba(249,115,22,0.3)' }} />
                      <div className="flex-1 min-w-[180px]">
                        <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{c.title}</div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{c.custom_url || c.channel_id}</div>
                      </div>
                      <StatPill label="Subs" value={formatNumber(c.subscriber_count)} />
                      <StatPill label="Videos" value={formatNumber(c.video_count)} />
                      <StatPill label="Views" value={formatNumber(c.view_count)} />
                      <div className="text-xs px-2 py-1 rounded-md" style={{
                        background: c.last_synced ? 'rgba(16,185,129,0.1)' : 'rgba(107,114,128,0.15)',
                        color: c.last_synced ? '#10b981' : '#6b7280',
                      }}>
                        {c.last_synced ? `Synced ${timeAgo(c.last_synced)}` : 'Not synced'}
                      </div>
                      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => syncCompetitor(c.id)} disabled={syncingId === c.id}>
                          {syncingId === c.id ? <Spinner size={12} /> : '↻'} Sync
                        </button>
                        <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => openDetail(c.id)}>👁 Open</button>
                        <button className="btn-secondary text-xs flex items-center gap-1" style={{ color: '#ef4444' }} onClick={() => deleteCompetitor(c.id)} disabled={deletingId === c.id}>
                          {deletingId === c.id ? <Spinner size={12} /> : '✕'} Delete
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </motion.div>
        ) : (
          <motion.div key="detail" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
            <button className="btn-secondary text-sm flex items-center gap-2 mb-6" onClick={() => { setView('overview'); setSelectedId(null); }}>
              ← Back to Overview
            </button>

            {detailLoading ? (
              <div className="flex items-center justify-center py-20" style={{ color: 'var(--text-muted)' }}><Spinner size={28} /></div>
            ) : detailComp && (
              <>
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

                {/* Model selector + niche — global for all AI ops on this competitor */}
                <div className="glass rounded-xl p-5 mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <ModelSelector value={modelId} onChange={setModelId} />
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Your niche (for context)</label>
                    <input className="input-field" placeholder="e.g. Cybersecurity, Fitness..." value={analysisNiche} onChange={e => setAnalysisNiche(e.target.value)} />
                  </div>
                </div>

                {videos.length === 0 && (
                  <div className="glass rounded-xl p-5 mb-6 flex items-center gap-4 flex-wrap" style={{ borderLeft: '3px solid #f59e0b' }}>
                    <div className="flex-1 min-w-[280px]">
                      <div className="text-sm font-semibold" style={{ color: '#f59e0b' }}>📥 Sync this channel first</div>
                      <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                        No videos pulled yet. Sync to fetch up to 200 recent videos with tags, descriptions, and comments. Then you can run Deep Analysis, Video Forensics, and generate ideas.
                      </div>
                    </div>
                    <button className="btn-primary flex items-center gap-2" onClick={() => syncCompetitor(detailComp.id)} disabled={syncingId === detailComp.id}>
                      {syncingId === detailComp.id ? <Spinner /> : '↻'} Sync now
                    </button>
                  </div>
                )}

                <div className="flex gap-2 mb-6 flex-wrap">
                  {([
                    ['videos', `Videos (${videos.length})`],
                    ['analytics', '📊 Analytics'],
                    ['top', `🚀 Top (${topVideos.length})`],
                    ['bottom', `📉 Bottom (${bottomVideos.length})`],
                    ['thumbnails', '🎨 Thumbnails'],
                    ['forensics', '🎬 Video Forensics'],
                    ['analysis', '🧠 Deep Analysis'],
                    ['ideas', '💡 Ideas'],
                  ] as [DetailTab, string][]).map(([tab, label]) => (
                    <button key={tab} className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                      style={{
                        background: detailTab === tab ? 'linear-gradient(135deg, rgba(239,68,68,0.3), rgba(249,115,22,0.25))' : 'transparent',
                        color: detailTab === tab ? 'var(--text-primary)' : 'var(--text-muted)',
                        border: detailTab === tab ? '1px solid rgba(249,115,22,0.3)' : '1px solid transparent',
                      }}
                      onClick={() => setDetailTab(tab)}
                    >{label}</button>
                  ))}
                </div>

                <AnimatePresence mode="wait">
                  {detailTab === 'videos' && (
                    <motion.div key="videos" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
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
                      <VideoTable videos={sortedVideos} />
                    </motion.div>
                  )}

                  {detailTab === 'analytics' && (
                    <motion.div key="analytics" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      {analytics ? <AnalyticsView a={analytics} /> : (
                        <div className="glass rounded-xl p-8 text-center">
                          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                            Analytics is computed alongside Deep Analysis. Run a Deep Analysis (in the &quot;🧠 Deep Analysis&quot; tab) to see this view, or click below to compute analytics only.
                          </p>
                          <button className="btn-secondary mt-4" onClick={runAnalysis} disabled={analyzing}>
                            {analyzing ? <Spinner /> : 'Compute Analytics + Run Analysis'}
                          </button>
                        </div>
                      )}
                    </motion.div>
                  )}

                  {detailTab === 'top' && (
                    <motion.div key="top" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <PerformerGrid videos={topVideos} accent="#10b981" label="top performer" />
                    </motion.div>
                  )}

                  {detailTab === 'bottom' && (
                    <motion.div key="bottom" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <PerformerGrid videos={bottomVideos} accent="#6b7280" label="underperformer" />
                    </motion.div>
                  )}

                  {detailTab === 'thumbnails' && (
                    <motion.div key="thumbnails" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <ThumbnailsTab videos={topVideos} thumbAnalyses={thumbAnalyses} thumbAnalyzing={thumbAnalyzing} onAnalyze={analyzeThumbnail} />
                    </motion.div>
                  )}

                  {detailTab === 'forensics' && (
                    <motion.div key="forensics" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <ForensicsTab
                        videos={videos}
                        topVideos={topVideos}
                        modelId={modelId}
                        analyses={videoAnalyses}
                        analyzing={videoAnalyzing}
                        batchRunning={batchRunning}
                        batchProgress={batchProgress}
                        batchCount={batchCount}
                        setBatchCount={setBatchCount}
                        batchStrategy={batchStrategy}
                        setBatchStrategy={setBatchStrategy}
                        expanded={expandedForensics}
                        setExpanded={setExpandedForensics}
                        onAnalyze={analyzeOneVideo}
                        onBatch={runBatchVideoAnalysis}
                      />
                    </motion.div>
                  )}

                  {detailTab === 'analysis' && (
                    <motion.div key="analysis" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <div className="glass rounded-xl p-5 mb-6 flex items-center gap-3">
                        <button className="btn-primary flex items-center gap-2" onClick={runAnalysis} disabled={analyzing}>
                          {analyzing ? <Spinner /> : '🧠'} {analyzing ? 'Analyzing 200 videos...' : 'Run Deep Analysis'}
                        </button>
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Computes 50+ metrics deterministically, then synthesizes with the selected AI model. Zero hallucinations.
                        </span>
                      </div>
                      {analysis && <DeepAnalysisDisplay analysis={analysis} />}
                    </motion.div>
                  )}

                  {detailTab === 'ideas' && (
                    <motion.div key="ideas" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <div className="glass rounded-xl p-5 mb-6 space-y-3">
                        <div>
                          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Your angle / voice (optional)</label>
                          <input className="input-field" placeholder="e.g. 'beginner-friendly, no jargon, hands-on demos'" value={userAngle} onChange={e => setUserAngle(e.target.value)} />
                        </div>
                        <button className="btn-primary flex items-center gap-2" onClick={generateIdeas} disabled={ideasLoading}>
                          {ideasLoading ? <Spinner /> : '💡'} Generate Ideas From This Competitor
                        </button>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Ideas are anchored to specific competitor videos and identified content gaps. Run Deep Analysis first for richer gap detection.
                        </p>
                      </div>

                      {ideas.length > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {ideas.map((idea, i) => (
                            <div key={i} className="glass rounded-xl p-4 space-y-2" style={{ borderLeft: '3px solid #f59e0b' }}>
                              <div className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>{idea.title}</div>
                              <div className="text-xs" style={{ color: '#f59e0b' }}><strong>Hook:</strong> {idea.hook}</div>
                              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{idea.premise}</div>
                              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                <strong>Inspired by:</strong> {idea.inspired_by?.competitor_video || idea.inspired_by?.or_gap || '—'}
                              </div>
                              <div className="text-xs" style={{ color: 'var(--accent-green)' }}><strong>Your angle:</strong> {idea.user_differentiator}</div>
                              <div className="flex gap-2 flex-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                <span>⏱ {fmtDuration(idea.target_duration_seconds)}</span>
                                <span>📊 {idea.predicted_difficulty}</span>
                                <span>🎨 {idea.thumbnail_direction}</span>
                              </div>
                              <div className="flex gap-2 pt-2">
                                <button className="btn-secondary text-xs" onClick={() => saveIdea(idea, i)} disabled={savingIdeaIdx === i}>
                                  {savingIdeaIdx === i ? <Spinner size={12} /> : '💾'} Save to Library
                                </button>
                                <button className="btn-primary text-xs" onClick={() => sendToScript(idea)}>
                                  ✍ Write Script
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
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

function VideoTable({ videos }: { videos: Video[] }) {
  return (
    <>
      <div className="glass rounded-t-xl px-4 py-3 grid gap-3 text-xs font-semibold"
        style={{ color: 'var(--text-muted)', gridTemplateColumns: '48px 1fr 80px 70px 80px 80px 80px 100px' }}>
        <div /><div>Title</div>
        <div className="text-right">Views</div>
        <div className="text-right">Likes</div>
        <div className="text-right">Comments</div>
        <div className="text-right">Eng. Rate</div>
        <div className="text-center">Outlier</div>
        <div className="text-right">Published</div>
      </div>
      <div className="glass rounded-b-xl overflow-hidden divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
        {videos.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No videos. Hit Sync.</div>
        ) : videos.map(v => {
          const ob = outlierBadge(v.outlier_score);
          return (
            <div key={v.id} className="px-4 py-3 grid gap-3 items-center text-sm hover:bg-white/[0.02] transition-colors"
              style={{ gridTemplateColumns: '48px 1fr 80px 70px 80px 80px 80px 100px' }}>
              <img src={v.thumbnail_url} alt="" className="rounded" style={{ width: 48, height: 27, objectFit: 'cover' }} />
              <a href={`https://www.youtube.com/watch?v=${v.video_id}`} target="_blank" rel="noopener noreferrer" className="truncate hover:underline" style={{ color: 'var(--text-primary)' }} title={v.title}>{v.title}</a>
              <div className="text-right" style={{ color: 'var(--text-secondary)' }}>{formatNumber(v.view_count)}</div>
              <div className="text-right" style={{ color: 'var(--text-secondary)' }}>{formatNumber(v.like_count)}</div>
              <div className="text-right" style={{ color: 'var(--text-secondary)' }}>{formatNumber(v.comment_count)}</div>
              <div className="text-right" style={{ color: 'var(--text-secondary)' }}>{engagementStr(v.engagement_rate)}</div>
              <div className="text-center"><span className="text-xs px-2 py-0.5 rounded-full" style={{ background: ob.bg, color: ob.color }}>{ob.label}</span></div>
              <div className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(v.published_at).toLocaleDateString()}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function PerformerGrid({ videos, accent, label }: { videos: Video[]; accent: string; label: string }) {
  if (!videos.length) return <div className="glass rounded-xl p-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No data. Sync the channel first.</div>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {videos.map(v => (
        <div key={v.id} className="glass rounded-xl p-4" style={{ borderLeft: `3px solid ${accent}` }}>
          <div className="flex gap-3 mb-3">
            <img src={v.thumbnail_url} alt="" className="rounded-lg flex-shrink-0" style={{ width: 120, height: 68, objectFit: 'cover' }} />
            <div className="flex-1 min-w-0">
              <a href={`https://www.youtube.com/watch?v=${v.video_id}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-sm leading-snug line-clamp-2 hover:underline" style={{ color: 'var(--text-primary)' }}>{v.title}</a>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{new Date(v.published_at).toLocaleDateString()} · {fmtDuration(v.duration_seconds || 0)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <span className="px-2 py-1 rounded-full font-semibold" style={{ background: `${accent}25`, color: accent }}>{v.outlier_score.toFixed(1)}x · {label}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{formatNumber(v.view_count)} views</span>
            <span style={{ color: 'var(--text-secondary)' }}>👍 {formatNumber(v.like_count)}</span>
            <span style={{ color: 'var(--text-secondary)' }}>💬 {formatNumber(v.comment_count)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function AnalyticsView({ a }: { a: Analytics }) {
  const dowDays = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const maxDow = Math.max(...dowDays.map(d => a.cadence.dayOfWeekHistogram[d] || 0), 1);
  const maxHour = Math.max(...Object.values(a.cadence.hourOfDayHistogram), 1);
  const maxRoll = Math.max(...a.trend.rollingAvgViews.map(r => r.avg), 1);

  return (
    <div className="space-y-6">
      <Section title="Performance Distribution">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Median Views" value={formatNumber(a.performance.medianViews)} />
          <Stat label="Mean Views" value={formatNumber(a.performance.meanViews)} />
          <Stat label="P10 / P90" value={`${formatNumber(a.performance.p10Views)} / ${formatNumber(a.performance.p90Views)}`} />
          <Stat label="Median Engagement" value={engagementStr(a.performance.medianEngagementRate)} />
        </div>
      </Section>

      <Section title="Upload Cadence">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Stat label="Uploads / week" value={a.cadence.uploadsPerWeek.toFixed(2)} />
          <Stat label="Median gap" value={`${a.cadence.medianGapDays}d`} />
          <Stat label="Consistency" value={`${(a.cadence.consistencyScore * 100).toFixed(0)}%`} />
          <Stat label="Best day" value={a.cadence.bestDayByAvgViews || '—'} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>Day of week (uploads)</div>
            <div className="space-y-1">
              {dowDays.map(d => (
                <div key={d} className="flex items-center gap-2">
                  <span className="text-xs w-8" style={{ color: 'var(--text-muted)' }}>{d}</span>
                  <div className="flex-1 h-3 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    <div className="h-full rounded" style={{
                      width: `${((a.cadence.dayOfWeekHistogram[d] || 0) / maxDow) * 100}%`,
                      background: d === a.cadence.bestDayByAvgViews ? '#10b981' : '#f97316',
                    }} />
                  </div>
                  <span className="text-xs w-6 text-right" style={{ color: 'var(--text-secondary)' }}>{a.cadence.dayOfWeekHistogram[d] || 0}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>Hour of day (UTC)</div>
            <div className="grid grid-cols-12 gap-0.5">
              {Array.from({ length: 24 }, (_, h) => {
                const v = a.cadence.hourOfDayHistogram[String(h)] || 0;
                return (
                  <div key={h} className="relative" style={{ height: 30 }} title={`${h}:00 — ${v} uploads`}>
                    <div className="absolute bottom-0 w-full rounded-t" style={{
                      height: `${(v / maxHour) * 100}%`,
                      background: h === a.cadence.bestHourByAvgViews ? '#10b981' : '#3b82f6',
                    }} />
                  </div>
                );
              })}
            </div>
            <div className="text-[10px] mt-1 flex justify-between" style={{ color: 'var(--text-muted)' }}>
              <span>0h</span><span>12h</span><span>23h</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Duration Strategy">
        <div className="grid grid-cols-5 gap-2">
          {(['shorts','short','medium','long','extended'] as const).map(b => {
            const s = a.duration.buckets[b];
            const isBest = b === a.duration.bestBucket;
            const isWorst = b === a.duration.worstBucket;
            return (
              <div key={b} className="rounded-lg p-3 text-center" style={{
                background: isBest ? 'rgba(16,185,129,0.1)' : isWorst ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isBest ? 'rgba(16,185,129,0.3)' : isWorst ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.05)'}`,
              }}>
                <div className="text-xs uppercase font-semibold" style={{ color: isBest ? '#10b981' : isWorst ? '#ef4444' : 'var(--text-muted)' }}>{b}</div>
                <div className="text-lg font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{s.count}</div>
                <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{formatNumber(s.avgViews)} avg</div>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{(s.avgEngagement * 100).toFixed(2)}% eng</div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Title Patterns">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <Stat label="Median length" value={`${a.titles.medianLength} chars`} />
          <Stat label="With ?" value={pctStr(a.titles.pctWithQuestion)} />
          <Stat label="With number" value={pctStr(a.titles.pctWithNumber)} />
          <Stat label="With brackets" value={pctStr(a.titles.pctWithBrackets)} />
          <Stat label="With emoji" value={pctStr(a.titles.pctWithEmoji)} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-semibold uppercase mb-2" style={{ color: '#10b981' }}>Words that LIFT performance</div>
            <div className="flex flex-wrap gap-1">
              {a.titles.topWordsInTopPerformers.slice(0, 12).map((w, i) => (
                <span key={i} className="text-xs px-2 py-1 rounded-full" style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>
                  {w.word} <span style={{ opacity: 0.7 }}>({w.lift.toFixed(1)}x)</span>
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase mb-2" style={{ color: '#ef4444' }}>Words in losing titles</div>
            <div className="flex flex-wrap gap-1">
              {a.titles.topWordsInBottomPerformers.slice(0, 12).map((w, i) => (
                <span key={i} className="text-xs px-2 py-1 rounded-full" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                  {w.word} ({w.count})
                </span>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title="Tag Strategy">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Stat label="Avg tags / video" value={a.tags.avgTagsPerVideo.toFixed(1)} />
        </div>
        <div className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>Top tags by frequency</div>
        <div className="flex flex-wrap gap-1 mb-3">
          {a.tags.topTags.slice(0, 15).map((t, i) => (
            <span key={i} className="text-xs px-2 py-1 rounded-full" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>
              {t.tag} <span style={{ opacity: 0.7 }}>({t.count})</span>
            </span>
          ))}
        </div>
      </Section>

      <Section title="Description Strategy">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Median length" value={`${a.descriptions.medianLength} chars`} />
          <Stat label="With #hashtags" value={pctStr(a.descriptions.pctWithHashtags)} />
          <Stat label="With links" value={pctStr(a.descriptions.pctWithLinks)} />
          <Stat label="With chapters" value={pctStr(a.descriptions.pctWithChapters)} />
          <Stat label="Avg #tags" value={a.descriptions.avgHashtagsPerVideo.toFixed(1)} />
        </div>
      </Section>

      <Section title="View Trend">
        <div className="flex items-center gap-3 mb-3">
          <span className="px-2 py-1 rounded text-xs font-semibold" style={{
            background: a.trend.momentum === 'accelerating' ? 'rgba(16,185,129,0.15)' : a.trend.momentum === 'declining' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
            color: a.trend.momentum === 'accelerating' ? '#10b981' : a.trend.momentum === 'declining' ? '#ef4444' : '#f59e0b',
          }}>{a.trend.momentum} ({a.trend.momentumPct >= 0 ? '+' : ''}{a.trend.momentumPct}%)</span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>1st-half avg {formatNumber(a.trend.firstHalfAvgViews)} → 2nd-half avg {formatNumber(a.trend.secondHalfAvgViews)}</span>
        </div>
        <div className="flex items-end gap-0.5" style={{ height: 80 }}>
          {a.trend.rollingAvgViews.map((r, i) => (
            <div key={i} className="flex-1 rounded-t" style={{
              height: `${(r.avg / maxRoll) * 100}%`,
              background: 'linear-gradient(to top, #f97316, #fbbf24)',
              minHeight: 2,
            }} title={`${r.date}: ${formatNumber(r.avg)} avg views`} />
          ))}
        </div>
      </Section>

      <Section title="Categories">
        <div className="space-y-2">
          {a.categories.map((c, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="text-sm w-40" style={{ color: 'var(--text-secondary)' }}>{c.label}</span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{c.count} videos</span>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>· {formatNumber(c.avgViews)} avg views</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function ThumbnailsTab({ videos, thumbAnalyses, thumbAnalyzing, onAnalyze }: {
  videos: Video[];
  thumbAnalyses: Record<string, ThumbnailAnalysis>;
  thumbAnalyzing: string | null;
  onAnalyze: (videoRowId: string) => void;
}) {
  if (!videos.length) return <div className="glass rounded-xl p-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Sync the channel first.</div>;
  return (
    <div className="space-y-4">
      <p className="text-xs px-1" style={{ color: 'var(--text-muted)' }}>
        Vision-based thumbnail forensics on the top performers. Requires a vision-capable model (Claude, GPT-4o, or Gemini).
      </p>
      {videos.map(v => {
        const ta = thumbAnalyses[v.id];
        return (
          <div key={v.id} className="glass rounded-xl p-4">
            <div className="flex gap-4 flex-wrap">
              <img src={v.thumbnail_url} alt="" className="rounded-lg flex-shrink-0" style={{ width: 240, height: 135, objectFit: 'cover' }} />
              <div className="flex-1 min-w-[280px]">
                <a href={`https://www.youtube.com/watch?v=${v.video_id}`} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline" style={{ color: 'var(--text-primary)' }}>{v.title}</a>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {formatNumber(v.view_count)} views · {v.outlier_score.toFixed(1)}x median · {fmtDuration(v.duration_seconds || 0)}
                </div>
                <button className="btn-secondary text-xs mt-3 flex items-center gap-2" onClick={() => onAnalyze(v.id)} disabled={thumbAnalyzing === v.id}>
                  {thumbAnalyzing === v.id ? <Spinner size={12} /> : '🔍'} {ta ? 'Re-analyze' : 'Analyze Thumbnail'}
                </button>
              </div>
            </div>

            {ta && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <H4>Composition</H4>
                  <KV k="Layout" v={ta.composition.layout} />
                  <KV k="Focal point" v={ta.composition.focal_point} />
                  <KV k="Hierarchy" v={ta.composition.visual_hierarchy_score} />
                </div>
                <div>
                  <H4>Colors</H4>
                  <div className="flex gap-1 mb-2">
                    {ta.colors.dominant_palette?.map((c, i) => (
                      <div key={i} className="w-8 h-8 rounded border" style={{ background: c, borderColor: 'rgba(255,255,255,0.1)' }} title={c} />
                    ))}
                  </div>
                  <KV k="Contrast" v={ta.colors.contrast_rating} />
                  <KV k="Psychology" v={ta.colors.color_psychology} />
                </div>
                <div>
                  <H4>Text overlay</H4>
                  <KV k="Present" v={ta.text_overlay.present ? 'Yes' : 'No'} />
                  {ta.text_overlay.exact_text && <KV k="Text" v={ta.text_overlay.exact_text} />}
                  <KV k="Readability" v={ta.text_overlay.text_readability_at_small_size} />
                </div>
                <div>
                  <H4>Human element</H4>
                  <KV k="Face" v={ta.human_element.face_present ? `Yes — ${ta.human_element.facial_expression}` : 'No'} />
                  <KV k="Eye contact" v={ta.human_element.eye_contact_with_camera ? 'Yes' : 'No'} />
                  <KV k="Gesture" v={ta.human_element.gesture} />
                </div>
                <div className="md:col-span-2">
                  <H4>Why it worked / failed</H4>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{ta.why_this_probably_worked_or_failed}</p>
                </div>
                <div className="md:col-span-2 rounded-lg p-3" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)' }}>
                  <H4 color="#10b981">Replicable design brief</H4>
                  <KV k="Layout to copy" v={ta.replicable_design_brief.layout_to_copy} />
                  <KV k="Color direction" v={ta.replicable_design_brief.color_direction} />
                  <KV k="Text formula" v={ta.replicable_design_brief.text_formula} />
                  <KV k="Emotional target" v={ta.replicable_design_brief.emotional_target} />
                  <div className="mt-2">
                    <div className="text-xs font-semibold" style={{ color: '#10b981' }}>DO:</div>
                    <ul className="text-xs ml-4 list-disc" style={{ color: 'var(--text-secondary)' }}>
                      {ta.replicable_design_brief.specific_dos?.map((d, i) => <li key={i}>{d}</li>)}
                    </ul>
                    <div className="text-xs font-semibold mt-2" style={{ color: '#ef4444' }}>DON&apos;T:</div>
                    <ul className="text-xs ml-4 list-disc" style={{ color: 'var(--text-secondary)' }}>
                      {ta.replicable_design_brief.specific_donts?.map((d, i) => <li key={i}>{d}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DeepAnalysisDisplay({ analysis }: { analysis: DeepAnalysis }) {
  const threat = THREAT_COLORS[analysis.threat_level?.toLowerCase() || 'medium'] || THREAT_COLORS.medium;
  return (
    <motion.div className="space-y-6" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <div className="glass rounded-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Threat Level:</span>
          <span className="px-3 py-1 rounded-full text-sm font-bold uppercase" style={{ background: threat.bg, color: threat.color }}>
            {analysis.threat_level}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{analysis.threat_justification}</span>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{analysis.executive_summary}</p>
      </div>

      {analysis.performance_snapshot && (
        <Section title="Performance Snapshot">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <Stat label="Median views" value={formatNumber(analysis.performance_snapshot.median_views)} />
            <Stat label="P90 views" value={formatNumber(analysis.performance_snapshot.p90_views)} />
            <Stat label="Engagement" value={`${analysis.performance_snapshot.median_engagement_pct?.toFixed(2)}%`} />
            <Stat label="Uploads/wk" value={String(analysis.performance_snapshot.uploads_per_week)} />
            <Stat label="Consistency" value={`${(analysis.performance_snapshot.consistency_score * 100).toFixed(0)}%`} />
            <Stat label="Momentum" value={`${analysis.performance_snapshot.momentum} ${analysis.performance_snapshot.momentum_pct >= 0 ? '+' : ''}${analysis.performance_snapshot.momentum_pct}%`} />
          </div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{analysis.performance_snapshot.interpretation}</p>
        </Section>
      )}

      {analysis.what_they_do_right?.length ? (
        <Section title="✅ What They Do Right">
          <div className="space-y-3">
            {analysis.what_they_do_right.map((w, i) => (
              <div key={i} className="glass rounded-lg p-3" style={{ borderLeft: '3px solid #10b981' }}>
                <div className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{w.strength}</div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>📊 {w.quantitative_evidence}</div>
                {w.video_examples?.length ? <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>🎬 {w.video_examples.join(' · ')}</div> : null}
                <div className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>Why: {w.why_it_works}</div>
                <div className="text-xs mt-1" style={{ color: '#10b981' }}><strong>Replicate:</strong> {w.replicable_tactic}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {analysis.what_they_do_wrong?.length ? (
        <Section title="❌ What They Do Wrong">
          <div className="space-y-3">
            {analysis.what_they_do_wrong.map((w, i) => (
              <div key={i} className="glass rounded-lg p-3" style={{ borderLeft: '3px solid #ef4444' }}>
                <div className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{w.weakness}</div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>📊 {w.quantitative_evidence}</div>
                {w.video_examples?.length ? <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>🎬 {w.video_examples.join(' · ')}</div> : null}
                <div className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>Cost: {w.cost_to_them}</div>
                <div className="text-xs mt-1" style={{ color: '#ef4444' }}><strong>Lesson:</strong> {w.lesson_for_user}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {analysis.top_video_deep_dives?.length ? (
        <Section title="🚀 Top Video Deep-Dives">
          <div className="space-y-3">
            {analysis.top_video_deep_dives.map((v, i) => (
              <div key={i} className="glass rounded-lg p-4" style={{ borderLeft: '3px solid #f97316' }}>
                <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                  <a href={`https://www.youtube.com/watch?v=${v.video_id}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-sm hover:underline" style={{ color: 'var(--text-primary)' }}>{v.video_title}</a>
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>{v.outlier_multiple?.toFixed(1)}x · {formatNumber(v.views)} views</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <div><strong style={{ color: 'var(--text-primary)' }}>Title mechanics:</strong> {v.why_it_succeeded?.title_mechanics}</div>
                  <div><strong style={{ color: 'var(--text-primary)' }}>Duration fit:</strong> {v.why_it_succeeded?.duration_fit}</div>
                  <div><strong style={{ color: 'var(--text-primary)' }}>Tags:</strong> {v.why_it_succeeded?.tag_strategy}</div>
                  <div><strong style={{ color: 'var(--text-primary)' }}>Timing:</strong> {v.why_it_succeeded?.publish_timing}</div>
                  <div className="md:col-span-2"><strong style={{ color: 'var(--text-primary)' }}>Audience:</strong> {v.why_it_succeeded?.audience_signal}</div>
                </div>
                <div className="mt-2 text-xs" style={{ color: '#10b981' }}><strong>Replicate:</strong> {v.replicable_elements?.join(' · ')}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {analysis.bottom_video_postmortems?.length ? (
        <Section title="📉 Bottom Video Post-Mortems">
          <div className="space-y-3">
            {analysis.bottom_video_postmortems.map((v, i) => (
              <div key={i} className="glass rounded-lg p-4" style={{ borderLeft: '3px solid #6b7280' }}>
                <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                  <a href={`https://www.youtube.com/watch?v=${v.video_id}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-sm hover:underline" style={{ color: 'var(--text-primary)' }}>{v.video_title}</a>
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(107,114,128,0.15)', color: '#9ca3af' }}>{v.views_vs_median_pct}% of median · {formatNumber(v.views)} views</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <div><strong style={{ color: 'var(--text-primary)' }}>Title issues:</strong> {v.why_it_underperformed?.title_issues}</div>
                  <div><strong style={{ color: 'var(--text-primary)' }}>Duration mismatch:</strong> {v.why_it_underperformed?.duration_mismatch}</div>
                  <div><strong style={{ color: 'var(--text-primary)' }}>Tag gap:</strong> {v.why_it_underperformed?.tag_gap}</div>
                  <div><strong style={{ color: 'var(--text-primary)' }}>Timing:</strong> {v.why_it_underperformed?.timing_issue}</div>
                </div>
                <div className="mt-2 text-xs" style={{ color: '#ef4444' }}><strong>Lesson:</strong> {v.lesson}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {analysis.title_formula_extraction && (
        <Section title="📝 Title Formula Extraction">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <H4 color="#10b981">Winning patterns</H4>
              {analysis.title_formula_extraction.winning_patterns?.map((p, i) => (
                <div key={i} className="text-sm mb-2">
                  <div style={{ color: 'var(--text-primary)' }}>✓ {p.pattern}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{p.stat}</div>
                </div>
              ))}
            </div>
            <div>
              <H4 color="#ef4444">Losing patterns</H4>
              {analysis.title_formula_extraction.losing_patterns?.map((p, i) => (
                <div key={i} className="text-sm mb-2">
                  <div style={{ color: 'var(--text-primary)' }}>✗ {p.pattern}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{p.stat}</div>
                </div>
              ))}
            </div>
          </div>
          {analysis.title_formula_extraction.recommended_title_templates?.length ? (
            <div className="mt-4">
              <H4 color="#f59e0b">Recommended templates for you</H4>
              <ul className="space-y-1">
                {analysis.title_formula_extraction.recommended_title_templates.map((t, i) => (
                  <li key={i} className="text-sm" style={{ color: 'var(--text-secondary)' }}>→ {t}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      )}

      {analysis.cadence_verdict && (
        <Section title="📅 Cadence Verdict">
          <div className="text-sm" style={{ color: 'var(--text-primary)' }}><strong>{analysis.cadence_verdict.assessment}</strong> — {analysis.cadence_verdict.evidence}</div>
          <div className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>📍 Best window: {analysis.cadence_verdict.best_publishing_window}</div>
          <div className="text-sm mt-1" style={{ color: '#10b981' }}><strong>For you:</strong> {analysis.cadence_verdict.recommendation}</div>
        </Section>
      )}

      {analysis.duration_strategy && (
        <Section title="⏱ Duration Strategy">
          <div className="text-sm" style={{ color: 'var(--text-primary)' }}>Best bucket: <strong style={{ color: '#10b981' }}>{analysis.duration_strategy.their_best_bucket}</strong> · Worst: <strong style={{ color: '#ef4444' }}>{analysis.duration_strategy.their_worst_bucket}</strong></div>
          <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{analysis.duration_strategy.avg_views_by_bucket}</div>
          <div className="text-sm mt-2" style={{ color: '#10b981' }}><strong>For you:</strong> {analysis.duration_strategy.recommendation_for_user}</div>
        </Section>
      )}

      {analysis.audience_insights && (
        <Section title="👥 Audience Insights">
          {analysis.audience_insights.note ? (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{analysis.audience_insights.note}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
                <div>
                  <H4 color="#10b981">What they love</H4>
                  <ul className="text-sm space-y-1">{analysis.audience_insights.what_audience_loves?.map((s, i) => <li key={i} style={{ color: 'var(--text-secondary)' }}>+ {s}</li>)}</ul>
                </div>
                <div>
                  <H4 color="#ef4444">What they complain about</H4>
                  <ul className="text-sm space-y-1">{analysis.audience_insights.what_audience_complains_about?.map((s, i) => <li key={i} style={{ color: 'var(--text-secondary)' }}>− {s}</li>)}</ul>
                </div>
              </div>
              <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Sentiment: <strong>{analysis.audience_insights.sentiment_verdict}</strong></div>
              {analysis.audience_insights.audience_quotes?.length ? (
                <div className="space-y-2">
                  {analysis.audience_insights.audience_quotes.map((q, i) => (
                    <div key={i} className="text-xs italic p-2 rounded" style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)' }}>
                      &ldquo;{q.quote}&rdquo; <span style={{ color: 'var(--text-muted)' }}>— 👍 {q.likes}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </Section>
      )}

      {analysis.content_gaps_for_user?.length ? (
        <Section title="🎯 Content Gaps for You">
          <div className="space-y-2">
            {analysis.content_gaps_for_user.map((g, i) => (
              <div key={i} className="text-sm">
                <div style={{ color: 'var(--text-primary)' }}>→ <strong>{g.gap}</strong></div>
                <div className="text-xs ml-4" style={{ color: 'var(--text-muted)' }}>Why: {g.opportunity}</div>
                <div className="text-xs ml-4" style={{ color: 'var(--text-muted)' }}>Evidence: {g.adjacent_evidence}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {analysis.steal_these_ideas?.length ? (
        <Section title="💡 Steal These Ideas">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {analysis.steal_these_ideas.map((idea, i) => (
              <div key={i} className="glass rounded-lg p-4" style={{ borderLeft: '3px solid #f59e0b' }}>
                <div className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>{idea.video_idea_title}</div>
                <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Inspired by: {idea.inspired_by}</div>
                <div className="text-xs mb-1" style={{ color: '#f59e0b' }}>Angle: {idea.your_angle}</div>
                <div className="text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Hook: {idea.hook_suggestion}</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>⏱ {fmtDuration(idea.target_duration_seconds)} · 🏷 {idea.recommended_tags?.slice(0,4).join(', ')}</div>
              </div>
            ))}
          </div>
          <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>Want more? Open the &quot;💡 Ideas&quot; tab to generate a fresh batch with your own angle.</p>
        </Section>
      ) : null}

      {analysis.thumbnail_strategy_hypothesis && (
        <Section title="🎨 Thumbnail Strategy Hypothesis">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{analysis.thumbnail_strategy_hypothesis}</p>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>For pixel-level forensics, run analyses in the &quot;🎨 Thumbnails&quot; tab.</p>
        </Section>
      )}

      {analysis.one_page_action_plan?.length ? (
        <Section title="📋 One-Page Action Plan">
          <ol className="space-y-2">
            {analysis.one_page_action_plan.map((a, i) => (
              <li key={i} className="text-sm flex gap-2" style={{ color: 'var(--text-secondary)' }}>
                <span className="flex-shrink-0 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center" style={{ background: 'rgba(249,115,22,0.15)', color: '#f97316' }}>{i + 1}</span>
                {a}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {analysis.data_quality_note && (
        <div className="text-xs px-4" style={{ color: 'var(--text-muted)' }}>ℹ {analysis.data_quality_note}</div>
      )}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
      <div className="text-[11px] uppercase font-semibold" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-base font-bold mt-0.5" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function H4({ children, color }: { children: React.ReactNode; color?: string }) {
  return <div className="text-xs font-semibold uppercase mb-2" style={{ color: color || 'var(--text-muted)' }}>{children}</div>;
}

function ForensicsTab({
  videos, topVideos, modelId, analyses, analyzing, batchRunning, batchProgress,
  batchCount, setBatchCount, batchStrategy, setBatchStrategy,
  expanded, setExpanded, onAnalyze, onBatch,
}: {
  videos: Video[];
  topVideos: Video[];
  modelId: string;
  analyses: Record<string, VideoForensics>;
  analyzing: string | null;
  batchRunning: boolean;
  batchProgress: BatchProgressItem[];
  batchCount: number;
  setBatchCount: (n: number) => void;
  batchStrategy: 'top-views' | 'outliers';
  setBatchStrategy: (s: 'top-views' | 'outliers') => void;
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  onAnalyze: (videoRowId: string, force?: boolean) => void;
  onBatch: () => void;
}) {
  // Both direct Google Gemini and Kie.ai Gemini variants support video analysis.
  // Direct Google uses fileData with YouTube URLs (officially supported).
  // Kie.ai uses OpenAI-compatible image_url with the YouTube URL (works as a passthrough,
  // though YouTube URL support specifically is undocumented by Kie.ai — best effort).
  // Mirrors modelSupportsVideo() in src/lib/ai.ts — keep these in sync.
  const isVideoCapable = modelId.startsWith('gemini-') || modelId.startsWith('kie-gemini-');

  if (!videos.length) {
    return <div className="glass rounded-xl p-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Sync the channel first.</div>;
  }

  const ranked = [...videos].sort((a, b) => b.view_count - a.view_count).slice(0, 50);

  return (
    <div className="space-y-4">
      {!isVideoCapable && (
        <div className="glass rounded-xl p-4" style={{ borderLeft: '3px solid #f59e0b' }}>
          <div className="text-sm font-semibold" style={{ color: '#f59e0b' }}>⚠ Select a Gemini model</div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            Video analysis requires a Gemini model. Both <strong>direct Google Gemini</strong>
            (Gemini 2.0/2.5/3/3.1 Flash or Pro — officially supported, billed by Google)
            and <strong>Kie.ai Gemini variants</strong> (passes through Kie.ai's OpenAI-compatible chat completions, billed by Kie — undocumented but works as a passthrough)
            are supported. Claude, GPT, and Perplexity cannot watch videos directly.
          </div>
        </div>
      )}

      {/* Batch controls */}
      <div className="glass rounded-xl p-5 space-y-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>🎬 Batch Video Forensics</div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Gemini watches each video end-to-end and produces a frame-accurate, audio-accurate breakdown.
          Costs ~$0.015 per 10-min video on Gemini 2.0 Flash. Results cached forever.
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Pick</label>
            <select className="input-field" value={batchStrategy} onChange={e => setBatchStrategy(e.target.value as 'top-views' | 'outliers')} disabled={batchRunning}>
              <option value="top-views">Top by views</option>
              <option value="outliers">Top by outlier score</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Count (max 50)</label>
            <input type="number" min={1} max={50} className="input-field" style={{ width: 100 }}
              value={batchCount} onChange={e => setBatchCount(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))} disabled={batchRunning} />
          </div>
          <button className="btn-primary flex items-center gap-2" onClick={onBatch} disabled={batchRunning || !isVideoCapable}>
            {batchRunning ? <Spinner /> : '▶'} {batchRunning ? 'Analyzing...' : `Analyze ${batchCount} videos`}
          </button>
        </div>

        {batchProgress.length > 0 && (
          <div className="space-y-1 mt-3 max-h-60 overflow-y-auto">
            {batchProgress.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-xs px-2 py-1 rounded" style={{
                background: p.status === 'done' ? 'rgba(16,185,129,0.05)' : p.status === 'error' ? 'rgba(239,68,68,0.05)' : p.status === 'analyzing' ? 'rgba(59,130,246,0.05)' : 'rgba(255,255,255,0.02)',
              }}>
                <span className="w-4 text-center">
                  {p.status === 'done' ? '✓' : p.status === 'error' ? '✗' : p.status === 'analyzing' ? <Spinner size={10} /> : '○'}
                </span>
                <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{p.videoTitle || `video ${i + 1}`}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {p.status === 'done' ? (p.cached ? 'cached' : 'analyzed') : p.status === 'error' ? p.error?.slice(0, 60) : p.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-video list */}
      <div className="space-y-3">
        {ranked.map(v => {
          const a = analyses[v.id];
          const isExpanded = expanded === v.id;
          const isAnalyzing = analyzing === v.id;
          const isInTop = topVideos.some(tv => tv.id === v.id);
          return (
            <div key={v.id} className="glass rounded-xl p-4">
              <div className="flex gap-3 flex-wrap">
                <img src={v.thumbnail_url} alt="" className="rounded-lg flex-shrink-0" style={{ width: 160, height: 90, objectFit: 'cover' }} />
                <div className="flex-1 min-w-[280px]">
                  <a href={`https://www.youtube.com/watch?v=${v.video_id}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-sm hover:underline" style={{ color: 'var(--text-primary)' }}>{v.title}</a>
                  <div className="text-xs mt-1 flex flex-wrap gap-2" style={{ color: 'var(--text-muted)' }}>
                    <span>{formatNumber(v.view_count)} views</span>
                    <span>· {v.outlier_score.toFixed(1)}x median</span>
                    <span>· {fmtDuration(v.duration_seconds || 0)}</span>
                    {isInTop && <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>top performer</span>}
                  </div>
                  <div className="flex gap-2 mt-3">
                    {!a ? (
                      <button className="btn-secondary text-xs flex items-center gap-2" onClick={() => onAnalyze(v.id)} disabled={isAnalyzing || !isVideoCapable}>
                        {isAnalyzing ? <Spinner size={12} /> : '🔍'} Watch & Analyze
                      </button>
                    ) : (
                      <>
                        <button className="btn-secondary text-xs flex items-center gap-2" onClick={() => setExpanded(isExpanded ? null : v.id)}>
                          {isExpanded ? '▼' : '▶'} {isExpanded ? 'Collapse' : 'View Forensics'}
                        </button>
                        <button className="btn-secondary text-xs flex items-center gap-2" onClick={() => onAnalyze(v.id, true)} disabled={isAnalyzing || !isVideoCapable}>
                          {isAnalyzing ? <Spinner size={12} /> : '↻'} Re-analyze
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {a && isExpanded && <ForensicsDisplay a={a} videoId={v.video_id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ForensicsDisplay({ a, videoId }: { a: VideoForensics; videoId: string }) {
  if (a.error) {
    return <div className="mt-4 p-3 rounded-lg text-sm" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>{a.error}</div>;
  }

  const tsLink = (ts: string | undefined) => {
    if (!ts) return null;
    const m = ts.match(/(\d+):(\d+)(?::(\d+))?/);
    if (!m) return ts;
    const total = m[3] ? parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]) : parseInt(m[1])*60 + parseInt(m[2]);
    return <a href={`https://www.youtube.com/watch?v=${videoId}&t=${total}`} target="_blank" rel="noopener noreferrer" className="text-xs px-1.5 py-0.5 rounded font-mono hover:underline" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>{ts}</a>;
  };

  return (
    <div className="mt-4 space-y-4 text-sm">
      {a.video_summary && (
        <ForensicSection title="Summary">
          <KV k="Pitch" v={a.video_summary.one_line_pitch} />
          <KV k="Promise" v={a.video_summary.core_promise_to_viewer} />
          <KV k="Delivers" v={a.video_summary.delivers_on_promise} />
        </ForensicSection>
      )}

      {a.hook_analysis && (
        <ForensicSection title="🎣 Hook Analysis">
          <KV k="Type" v={a.hook_analysis.hook_type} />
          <KV k="Effectiveness" v={a.hook_analysis.hook_effectiveness_score} />
          <div className="text-xs mt-2 p-2 rounded italic" style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>First 15s spoken:</strong> &ldquo;{a.hook_analysis.first_15_seconds_transcript}&rdquo;
          </div>
          <div className="text-xs mt-2 p-2 rounded" style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>First 15s visuals:</strong> {a.hook_analysis.first_15_seconds_visuals}
          </div>
          <KV k="Retention risk" v={a.hook_analysis.retention_risk_in_hook} />
        </ForensicSection>
      )}

      {a.structural_breakdown?.length ? (
        <ForensicSection title="🏗 Structural Breakdown">
          <div className="space-y-1">
            {a.structural_breakdown.map((s, i) => (
              <div key={i} className="text-xs flex gap-2 items-start">
                <div className="flex-shrink-0">{tsLink(s.timestamp)}</div>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase" style={{ background: 'rgba(249,115,22,0.1)', color: '#f97316' }}>{s.section}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{s.description}</span>
                <span style={{ color: 'var(--text-muted)' }}>— {s.purpose}</span>
              </div>
            ))}
          </div>
        </ForensicSection>
      ) : null}

      {a.pacing_and_editing && (
        <ForensicSection title="✂ Pacing & Editing">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
            <KV k="Cuts/min" v={a.pacing_and_editing.estimated_cuts_per_minute} />
            <KV k="Cut style" v={a.pacing_and_editing.cut_style} />
            <KV k="B-roll" v={a.pacing_and_editing.b_roll_density} />
            <KV k="Music" v={a.pacing_and_editing.music_present} />
            <KV k="Music style" v={a.pacing_and_editing.music_style} />
          </div>
          <KV k="Energy curve" v={a.pacing_and_editing.energy_curve} />
          {a.pacing_and_editing.dead_zones?.length ? (
            <div className="text-xs mt-2" style={{ color: '#ef4444' }}>⚠ Dead zones: {a.pacing_and_editing.dead_zones.join(' · ')}</div>
          ) : null}
        </ForensicSection>
      )}

      {a.on_screen_graphics && (
        <ForensicSection title="🎨 On-Screen Graphics">
          <KV k="Lower thirds" v={a.on_screen_graphics.lower_thirds} />
          <KV k="Quality" v={a.on_screen_graphics.graphics_quality} />
          <KV k="Branding" v={a.on_screen_graphics.branded_elements} />
          {a.on_screen_graphics.key_text_overlays?.length ? (
            <div className="mt-2 space-y-1">
              <div className="text-[10px] uppercase font-semibold" style={{ color: 'var(--text-muted)' }}>Key text overlays</div>
              {a.on_screen_graphics.key_text_overlays.map((t, i) => (
                <div key={i} className="text-xs flex gap-2 items-start">
                  {tsLink(t.timestamp)}
                  <span style={{ color: 'var(--text-primary)' }}>&ldquo;{t.verbatim_text}&rdquo;</span>
                  <span style={{ color: 'var(--text-muted)' }}>({t.purpose})</span>
                </div>
              ))}
            </div>
          ) : null}
        </ForensicSection>
      )}

      {a.verbal_content && (
        <ForensicSection title="🗣 Verbal Content">
          <div className="grid grid-cols-3 gap-2 text-xs mb-2">
            <KV k="Style" v={a.verbal_content.speaking_style} />
            <KV k="Filler words" v={a.verbal_content.filler_words_observed} />
          </div>
          {a.verbal_content.transcript_excerpts?.length ? (
            <div className="space-y-2">
              <div className="text-[10px] uppercase font-semibold" style={{ color: 'var(--text-muted)' }}>Notable quotes</div>
              {a.verbal_content.transcript_excerpts.map((q, i) => (
                <div key={i} className="text-xs p-2 rounded" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  {tsLink(q.timestamp)} <em style={{ color: 'var(--text-primary)' }}>&ldquo;{q.verbatim_quote}&rdquo;</em>
                  <div style={{ color: 'var(--text-muted)' }} className="mt-1">→ {q.why_notable}</div>
                </div>
              ))}
            </div>
          ) : null}
          {a.verbal_content.claims_made?.length ? (
            <div className="mt-3 space-y-1">
              <div className="text-[10px] uppercase font-semibold" style={{ color: 'var(--text-muted)' }}>Claims made</div>
              {a.verbal_content.claims_made.map((c, i) => (
                <div key={i} className="text-xs p-2 rounded" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <div style={{ color: 'var(--text-primary)' }}>{c.claim}</div>
                  <div style={{ color: 'var(--text-muted)' }}>Evidence: {c.evidence_provided_in_video}</div>
                  <div style={{ color: c.verifiable === 'yes' ? '#10b981' : c.verifiable === 'no' ? '#ef4444' : '#f59e0b' }}>Verifiable: {c.verifiable}</div>
                </div>
              ))}
            </div>
          ) : null}
        </ForensicSection>
      )}

      {a.visual_production && (
        <ForensicSection title="🎥 Visual Production">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
            <KV k="Setting" v={a.visual_production.setting} />
            <KV k="Lighting" v={a.visual_production.lighting} />
            <KV k="Color grading" v={a.visual_production.color_grading} />
            <KV k="Camera" v={a.visual_production.camera_setup} />
          </div>
          <KV k="Host" v={a.visual_production.host_appearance} />
          {a.visual_production.backdrop_elements?.length ? (
            <KV k="Backdrop" v={a.visual_production.backdrop_elements.join(', ')} />
          ) : null}
        </ForensicSection>
      )}

      {a.monetization_signals && (
        <ForensicSection title="💰 Monetization">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <KV k="Sponsor" v={a.monetization_signals.sponsor_segment_present} />
            {a.monetization_signals.sponsor_brand && <KV k="Brand" v={a.monetization_signals.sponsor_brand} />}
            {a.monetization_signals.sponsor_timestamp && (
              <div className="text-xs"><span style={{ color: 'var(--text-muted)' }}>Time: </span>{tsLink(a.monetization_signals.sponsor_timestamp)}</div>
            )}
            <KV k="Integration" v={a.monetization_signals.sponsor_integration_quality} />
            <KV k="Own product" v={a.monetization_signals.merch_or_own_product_pitch} />
          </div>
          {a.monetization_signals.affiliate_or_product_mentions?.length ? (
            <KV k="Mentions" v={a.monetization_signals.affiliate_or_product_mentions.join(' · ')} />
          ) : null}
        </ForensicSection>
      )}

      {a.calls_to_action?.length ? (
        <ForensicSection title="📢 Calls to Action">
          <div className="space-y-1">
            {a.calls_to_action.map((c, i) => (
              <div key={i} className="text-xs flex gap-2 items-start">
                {tsLink(c.timestamp)}
                <span className="px-1.5 py-0.5 rounded text-[10px] uppercase" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>{c.cta_type}</span>
                <span style={{ color: 'var(--text-primary)' }}>&ldquo;{c.verbatim}&rdquo;</span>
                <span style={{ color: 'var(--text-muted)' }}>— {c.placement_quality}</span>
              </div>
            ))}
          </div>
        </ForensicSection>
      ) : null}

      {a.thumbnail_vs_video_alignment && (
        <ForensicSection title="🎯 Promise vs Delivery">
          <KV k="Title kept" v={a.thumbnail_vs_video_alignment.title_promise_kept} />
          <KV k="Clickbait" v={a.thumbnail_vs_video_alignment.clickbait_assessment} />
          <KV k="Satisfaction prediction" v={a.thumbnail_vs_video_alignment.satisfaction_prediction} />
        </ForensicSection>
      )}

      {a.audience_targeting && (
        <ForensicSection title="👥 Audience Targeting">
          <KV k="Knowledge level" v={a.audience_targeting.assumed_knowledge_level} />
          <KV k="Language" v={a.audience_targeting.language_complexity} />
          <KV k="Persona" v={a.audience_targeting.ideal_viewer_persona} />
          {a.audience_targeting.cultural_or_regional_signals?.length ? (
            <KV k="Cultural signals" v={a.audience_targeting.cultural_or_regional_signals.join(', ')} />
          ) : null}
        </ForensicSection>
      )}

      {a.what_made_it_work_or_fail && (
        <ForensicSection title="🔑 What Worked / Failed">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="text-xs font-semibold mb-1" style={{ color: '#10b981' }}>STRENGTHS</div>
              {a.what_made_it_work_or_fail.top_3_strengths?.map((s, i) => (
                <div key={i} className="text-xs mb-2 p-2 rounded" style={{ background: 'rgba(16,185,129,0.05)' }}>
                  <div style={{ color: 'var(--text-primary)' }}>{tsLink(s.timestamp_evidence)} {s.strength}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{s.explanation}</div>
                </div>
              ))}
            </div>
            <div>
              <div className="text-xs font-semibold mb-1" style={{ color: '#ef4444' }}>WEAKNESSES</div>
              {a.what_made_it_work_or_fail.top_3_weaknesses?.map((s, i) => (
                <div key={i} className="text-xs mb-2 p-2 rounded" style={{ background: 'rgba(239,68,68,0.05)' }}>
                  <div style={{ color: 'var(--text-primary)' }}>{tsLink(s.timestamp_evidence)} {s.weakness}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{s.explanation}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 p-3 rounded text-sm" style={{ background: 'rgba(249,115,22,0.05)', color: 'var(--text-secondary)' }}>
            <strong style={{ color: '#f97316' }}>Biggest lesson:</strong> {a.what_made_it_work_or_fail.single_biggest_lesson}
          </div>
        </ForensicSection>
      )}

      {a.replicable_playbook_for_user && (
        <ForensicSection title="📋 Replicable Playbook">
          <KV k="Structural template" v={a.replicable_playbook_for_user.structural_template} />
          <KV k="Hook template" v={a.replicable_playbook_for_user.hook_template} />
          <KV k="Difficulty" v={a.replicable_playbook_for_user.estimated_production_difficulty} />
          <KV k="Cost" v={a.replicable_playbook_for_user.estimated_production_cost} />
          {a.replicable_playbook_for_user.must_steal_techniques?.length ? (
            <div className="mt-2">
              <div className="text-[10px] uppercase font-semibold" style={{ color: '#10b981' }}>STEAL THESE</div>
              <ul className="text-xs ml-4 list-disc" style={{ color: 'var(--text-secondary)' }}>
                {a.replicable_playbook_for_user.must_steal_techniques.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          ) : null}
          {a.replicable_playbook_for_user.do_not_copy?.length ? (
            <div className="mt-2">
              <div className="text-[10px] uppercase font-semibold" style={{ color: '#ef4444' }}>DON&apos;T COPY</div>
              <ul className="text-xs ml-4 list-disc" style={{ color: 'var(--text-secondary)' }}>
                {a.replicable_playbook_for_user.do_not_copy.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          ) : null}
        </ForensicSection>
      )}

      {a.data_quality_note && (
        <div className="text-xs px-2" style={{ color: 'var(--text-muted)' }}>ℹ {a.data_quality_note}</div>
      )}
    </div>
  );
}

function ForensicSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>{title}</div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string | undefined }) {
  if (!v) return null;
  return <div className="text-xs mb-1"><span style={{ color: 'var(--text-muted)' }}>{k}: </span><span style={{ color: 'var(--text-secondary)' }}>{v}</span></div>;
}
