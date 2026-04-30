'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { NotificationBell } from '@/components/dashboard/NotificationBell';
import { AvailabilityToggle } from '@/components/dashboard/AvailabilityToggle';
import { NotificationPrefsPanel } from '@/components/dashboard/NotificationPrefsPanel';

interface Assignment {
  id: string;
  status: string;
  deadline: string | null;
  share_token: string;
  director_notes: string | null;
  created_at: string;
  updated_at: string;
  project_title: string | null;
  total_sections: number;
  approved_sections: number;
  submitted_sections: number;
  retake_sections: number;
  pending_sections: number;
  unread_owner_comments: number;
  total_words: number;
}

interface NarratorInfo {
  id: string;
  name: string;
  email: string | null;
  color: string;
}

const STATUS_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  assigned:  { label: 'New',          bg: 'rgba(234,179,8,0.18)',  text: '#eab308' },
  received:  { label: 'Received',     bg: 'rgba(6,182,212,0.18)',  text: '#06b6d4' },
  recording: { label: 'Recording',    bg: 'rgba(124,58,237,0.22)', text: '#a78bfa' },
  submitted: { label: 'In review',    bg: 'rgba(59,130,246,0.18)', text: '#3b82f6' },
  revisions: { label: 'Revisions',    bg: 'rgba(239,68,68,0.18)',  text: '#ef4444' },
  approved:  { label: 'Approved',     bg: 'rgba(34,197,94,0.18)',  text: '#22c55e' },
  completed: { label: 'Completed',    bg: 'rgba(34,197,94,0.18)',  text: '#22c55e' },
};

type Filter = 'all' | 'urgent' | 'recording' | 'review' | 'completed';

function deadlineInfo(d: string | null): { text: string; days: number | null; tone: 'overdue' | 'urgent' | 'soon' | 'normal' | 'none' } {
  if (!d) return { text: 'No deadline', days: null, tone: 'none' };
  const date = new Date(d);
  const ms = date.getTime() - Date.now();
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  if (ms < 0) return { text: `Overdue · ${date.toLocaleDateString()}`, days, tone: 'overdue' };
  if (days === 0) return { text: 'Due today', days, tone: 'urgent' };
  if (days === 1) return { text: 'Due tomorrow', days, tone: 'urgent' };
  if (days <= 3) return { text: `Due in ${days} days`, days, tone: 'soon' };
  return { text: `Due ${date.toLocaleDateString()}`, days, tone: 'normal' };
}

export default function NarratorDashboard({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [narrator, setNarrator] = useState<NarratorInfo | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    fetch(`/api/narrator-dashboard/${token}`)
      .then(async r => {
        if (!r.ok) { setError(true); return; }
        const data = await r.json();
        setNarrator(data.narrator);
        setAssignments(data.assignments);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [token]);

  const buckets = useMemo(() => {
    const now = Date.now();
    const urgent = assignments.filter(a => {
      if (a.status === 'completed' || a.status === 'approved') return false;
      if (a.retake_sections > 0) return true;
      if (a.unread_owner_comments > 0) return true;
      if (a.deadline && new Date(a.deadline).getTime() - now <= 1000 * 60 * 60 * 24 * 3) return true;
      return false;
    });
    const recording = assignments.filter(a => a.status === 'received' || a.status === 'recording' || a.status === 'assigned');
    const review = assignments.filter(a => a.status === 'submitted' || a.status === 'revisions');
    const completed = assignments.filter(a => a.status === 'completed' || a.status === 'approved');
    const active = assignments.filter(a => a.status !== 'completed' && a.status !== 'approved');
    return { urgent, recording, review, completed, active };
  }, [assignments]);

  // Aggregate metrics — words, hours of work, completion rate
  const metrics = useMemo(() => {
    const totalWords = assignments.reduce((a, x) => a + x.total_words, 0);
    const recordedWords = assignments
      .filter(a => a.status === 'completed' || a.status === 'approved')
      .reduce((a, x) => a + x.total_words, 0);
    const totalSections = assignments.reduce((a, x) => a + x.total_sections, 0);
    const approvedSections = assignments.reduce((a, x) => a + x.approved_sections, 0);
    const completionRate = totalSections > 0 ? Math.round((approvedSections / totalSections) * 100) : 0;
    // Estimated hours of work assuming ~150 wpm and ~3x record-to-deliver overhead.
    const estHours = Math.round((totalWords / 150) * 3 / 60);
    return { totalWords, recordedWords, totalSections, approvedSections, completionRate, estHours };
  }, [assignments]);

  const filtered = useMemo(() => {
    let list = assignments;
    if (filter === 'urgent') list = buckets.urgent;
    else if (filter === 'recording') list = buckets.recording;
    else if (filter === 'review') list = buckets.review;
    else if (filter === 'completed') list = buckets.completed;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(a => (a.project_title || '').toLowerCase().includes(q));
    }
    return list;
  }, [assignments, buckets, filter, search]);

  if (loading) return <SplashLoader />;
  if (error || !narrator) return <SplashError />;

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Top bar */}
        <header className="flex items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center text-base font-bold text-white shadow-lg"
              style={{ background: `linear-gradient(135deg, ${narrator.color}, ${narrator.color}99)` }}
            >
              {(narrator.name || '?')[0].toUpperCase()}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Narrator dashboard
              </p>
              <h1 className="text-2xl font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
                Hey {narrator.name.split(' ')[0]} 👋
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell token={token} />
            <button
              onClick={() => setShowSettings(s => !s)}
              className="w-9 h-9 rounded-full flex items-center justify-center transition-colors"
              style={{ background: showSettings ? 'rgba(124,58,237,0.15)' : 'var(--bg-secondary)', border: `1px solid ${showSettings ? 'rgba(124,58,237,0.4)' : 'var(--border)'}` }}
              title="Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }}>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </header>

        {showSettings && (
          <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
            <AvailabilityToggle token={token} role="narrator" />
            <NotificationPrefsPanel token={token} role="narrator" />
          </section>
        )}

        {/* Hero stats */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <HeroStat
            value={buckets.urgent.length}
            label="Need attention"
            sub={buckets.urgent.length === 0 ? 'You\'re caught up' : 'Retakes / deadlines'}
            tone={buckets.urgent.length > 0 ? 'urgent' : 'good'}
          />
          <HeroStat
            value={buckets.active.length}
            label="Active queue"
            sub={`${metrics.totalWords.toLocaleString()} words total`}
            tone="info"
          />
          <HeroStat
            value={`${metrics.completionRate}%`}
            label="Completion"
            sub={`${metrics.approvedSections} of ${metrics.totalSections} sections`}
            tone={metrics.completionRate >= 80 ? 'good' : 'info'}
          />
          <HeroStat
            value={metrics.recordedWords.toLocaleString()}
            label="Words shipped"
            sub={`Across ${buckets.completed.length} project${buckets.completed.length === 1 ? '' : 's'}`}
            tone="good"
          />
        </section>

        {/* Filter pills + search */}
        <section className="mb-4 flex items-center gap-2 flex-wrap">
          <FilterPill active={filter === 'all'} onClick={() => setFilter('all')} count={assignments.length}>All</FilterPill>
          <FilterPill active={filter === 'urgent'} onClick={() => setFilter('urgent')} tone="urgent" count={buckets.urgent.length}>Urgent</FilterPill>
          <FilterPill active={filter === 'recording'} onClick={() => setFilter('recording')} count={buckets.recording.length}>Recording</FilterPill>
          <FilterPill active={filter === 'review'} onClick={() => setFilter('review')} count={buckets.review.length}>In review</FilterPill>
          <FilterPill active={filter === 'completed'} onClick={() => setFilter('completed')} count={buckets.completed.length}>Completed</FilterPill>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search projects…"
            className="ml-auto px-3 py-1.5 rounded-lg text-xs"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', minWidth: 200 }}
          />
        </section>

        {/* List */}
        <section>
          {filtered.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            <div className="space-y-2.5">
              {filtered.map(a => <AssignmentCard key={a.id} a={a} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function SplashLoader() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
    </div>
  );
}

function SplashError() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center max-w-sm">
        <div className="text-4xl mb-3">🚪</div>
        <h1 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Invalid dashboard link</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Ask the project owner to send you a fresh link — your old one may have been revoked.</p>
      </div>
    </div>
  );
}

function HeroStat({ value, label, sub, tone }: { value: string | number; label: string; sub: string; tone: 'good' | 'urgent' | 'info' | 'muted' }) {
  const accent = tone === 'good' ? '#22c55e' : tone === 'urgent' ? '#ef4444' : tone === 'info' ? '#a78bfa' : 'var(--text-muted)';
  return (
    <div
      className="rounded-2xl p-4 transition-transform hover:translate-y-[-1px]"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        boxShadow: tone === 'urgent' ? `0 0 0 1px ${accent}33` : 'none',
      }}
    >
      <p className="text-3xl font-bold leading-none mb-1" style={{ color: accent }}>{value}</p>
      <p className="text-[11px] uppercase tracking-wider mt-2" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</p>
    </div>
  );
}

function FilterPill({ active, onClick, count, tone, children }: { active: boolean; onClick: () => void; count?: number; tone?: 'urgent'; children: React.ReactNode }) {
  const accent = tone === 'urgent' ? '#ef4444' : '#a78bfa';
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5"
      style={{
        background: active ? `${accent}22` : 'var(--bg-secondary)',
        color: active ? accent : 'var(--text-secondary)',
        border: `1px solid ${active ? accent : 'var(--border)'}`,
      }}
    >
      <span>{children}</span>
      {count != null && (
        <span className="text-[10px] opacity-70">{count}</span>
      )}
    </button>
  );
}

function EmptyState({ filter }: { filter: Filter }) {
  const messages: Record<Filter, { emoji: string; title: string; sub: string }> = {
    all:        { emoji: '🎙️', title: 'No assignments yet', sub: 'When the owner sends you a project, it\'ll appear here.' },
    urgent:     { emoji: '✨', title: 'Nothing urgent', sub: 'No retakes, comments, or near-deadlines. You\'re ahead.' },
    recording:  { emoji: '🎤', title: 'No active recording', sub: 'Pick up an assignment to start recording sections.' },
    review:     { emoji: '👀', title: 'Nothing in review', sub: 'Submitted takes will show up here while the owner reviews.' },
    completed:  { emoji: '🏁', title: 'No completed projects yet', sub: 'Wrapped projects land here as a record of your work.' },
  };
  const m = messages[filter];
  return (
    <div className="text-center py-16 rounded-2xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="text-4xl mb-2">{m.emoji}</div>
      <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{m.title}</p>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{m.sub}</p>
    </div>
  );
}

function AssignmentCard({ a }: { a: Assignment }) {
  const status = STATUS_STYLES[a.status] || STATUS_STYLES.assigned;
  const dl = deadlineInfo(a.deadline);
  const progress = a.total_sections > 0 ? Math.round((a.approved_sections / a.total_sections) * 100) : 0;
  const uploadedCount = a.total_sections - a.pending_sections;
  const dlColor = dl.tone === 'overdue' || dl.tone === 'urgent' ? '#ef4444' : dl.tone === 'soon' ? '#f97316' : 'var(--text-muted)';
  const flagged = a.retake_sections > 0 || a.unread_owner_comments > 0 || dl.tone === 'overdue' || dl.tone === 'urgent';

  return (
    <Link href={`/narrate/${a.share_token}`} className="block">
      <div
        className="rounded-2xl p-4 transition-all hover:translate-y-[-1px]"
        style={{
          background: 'var(--bg-secondary)',
          border: flagged ? '1px solid rgba(239,68,68,0.35)' : '1px solid var(--border)',
        }}
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {a.project_title || 'Untitled project'}
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: status.bg, color: status.text }}>
                {status.label}
              </span>
              {a.retake_sections > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: 'rgba(239,68,68,0.18)', color: '#ef4444' }}>
                  🔁 {a.retake_sections} retake{a.retake_sections === 1 ? '' : 's'}
                </span>
              )}
              {a.unread_owner_comments > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: 'rgba(124,58,237,0.18)', color: '#a78bfa' }}>
                  💬 {a.unread_owner_comments} new
                </span>
              )}
            </div>

            {/* Progress bar */}
            <div className="flex items-center gap-2 mb-2">
              <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${progress}%`,
                    background: progress >= 100 ? '#22c55e' : 'linear-gradient(90deg, #7c3aed, #06b6d4)',
                  }}
                />
              </div>
              <span className="text-[10px] shrink-0 font-medium" style={{ color: progress >= 100 ? '#22c55e' : 'var(--text-muted)' }}>
                {a.approved_sections}/{a.total_sections}
              </span>
            </div>

            <div className="flex items-center gap-3 flex-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {a.total_words > 0 && <span>📝 {a.total_words.toLocaleString()} words</span>}
              {uploadedCount > 0 && uploadedCount < a.total_sections && (
                <span>🎤 {uploadedCount}/{a.total_sections} uploaded</span>
              )}
              {a.submitted_sections > 0 && (
                <span style={{ color: '#3b82f6' }}>● {a.submitted_sections} pending review</span>
              )}
              {a.deadline && (
                <span style={{ color: dlColor, marginLeft: 'auto', fontWeight: dl.tone === 'urgent' || dl.tone === 'overdue' ? 600 : 400 }}>
                  {dl.tone === 'urgent' || dl.tone === 'overdue' ? '⏰ ' : ''}{dl.text}
                </span>
              )}
            </div>
          </div>

          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-1 shrink-0" style={{ color: 'var(--text-muted)' }}>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </div>
    </Link>
  );
}
