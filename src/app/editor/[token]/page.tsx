'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { NotificationBell } from '@/components/dashboard/NotificationBell';
import { AvailabilityToggle } from '@/components/dashboard/AvailabilityToggle';
import { NotificationPrefsPanel } from '@/components/dashboard/NotificationPrefsPanel';

interface Assignment {
  id: string;
  project_id: string;
  status: string;
  deadline: string | null;
  editor_notes: string | null;
  review_project_id: string | null;
  project_title: string;
  project_niche: string;
  project_topic: string | null;
  project_status: string;
  image_ref_count: number;
  voiceover_count: number;
  youtube_ref_count: number;
  uploaded_version_count: number;
  updated_at: string;
}

interface EditorInfo {
  id: string;
  name: string;
  email: string | null;
  color: string;
}

interface ReviewOnlyEntry {
  link_id: string;
  share_token: string;
  permission: string;
  label: string | null;
  created_at: string;
  review_project_id: string;
  project_title: string;
  review_status: string;
}

const STATUS_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  assigned:  { label: 'New',          bg: 'rgba(234,179,8,0.18)',  text: '#eab308' },
  editing:   { label: 'Editing',      bg: 'rgba(124,58,237,0.22)', text: '#a78bfa' },
  submitted: { label: 'In review',    bg: 'rgba(59,130,246,0.18)', text: '#3b82f6' },
  approved:  { label: 'Approved',     bg: 'rgba(34,197,94,0.18)',  text: '#22c55e' },
  completed: { label: 'Completed',    bg: 'rgba(34,197,94,0.18)',  text: '#22c55e' },
};

type Filter = 'all' | 'urgent' | 'editing' | 'review' | 'completed';

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

export default function EditorDashboard({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [editor, setEditor] = useState<EditorInfo | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [reviewOnly, setReviewOnly] = useState<ReviewOnlyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    fetch(`/api/editor-dashboard/${token}`)
      .then(async r => {
        if (!r.ok) { setError(true); return; }
        const data = await r.json();
        setEditor(data.editor);
        setAssignments(data.assignments);
        setReviewOnly(data.reviewOnly || []);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [token]);

  const buckets = useMemo(() => {
    const now = Date.now();
    const editing = assignments.filter(a => a.status === 'assigned' || a.status === 'editing');
    const review = assignments.filter(a => a.status === 'submitted');
    const completed = assignments.filter(a => a.status === 'approved' || a.status === 'completed');
    const active = assignments.filter(a => a.status !== 'completed' && a.status !== 'approved');
    const urgent = assignments.filter(a => {
      if (a.status === 'completed' || a.status === 'approved') return false;
      if (a.deadline && new Date(a.deadline).getTime() - now <= 1000 * 60 * 60 * 24 * 3) return true;
      return false;
    });
    return { editing, review, completed, active, urgent };
  }, [assignments]);

  const metrics = useMemo(() => {
    const totalProjects = assignments.length;
    const versions = assignments.reduce((a, x) => a + x.uploaded_version_count, 0);
    const completionRate = totalProjects > 0
      ? Math.round((buckets.completed.length / totalProjects) * 100)
      : 0;
    return { totalProjects, versions, completionRate };
  }, [assignments, buckets.completed.length]);

  const filtered = useMemo(() => {
    let list = assignments;
    if (filter === 'urgent') list = buckets.urgent;
    else if (filter === 'editing') list = buckets.editing;
    else if (filter === 'review') list = buckets.review;
    else if (filter === 'completed') list = buckets.completed;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(a => (a.project_title || '').toLowerCase().includes(q));
    }
    return list;
  }, [assignments, buckets, filter, search]);

  if (loading) return <SplashLoader />;
  if (error || !editor) return <SplashError />;

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <div className="max-w-6xl mx-auto px-6 py-8">
        <header className="flex items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center text-base font-bold text-white shadow-lg"
              style={{ background: `linear-gradient(135deg, ${editor.color}, ${editor.color}99)` }}
            >
              {(editor.name || '?')[0].toUpperCase()}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Editor dashboard
              </p>
              <h1 className="text-2xl font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
                Hey {editor.name.split(' ')[0]} 👋
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
            <AvailabilityToggle token={token} role="editor" />
            <NotificationPrefsPanel token={token} role="editor" />
          </section>
        )}

        {/* Hero stats */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <HeroStat
            value={buckets.urgent.length}
            label="Urgent"
            sub={buckets.urgent.length === 0 ? 'No tight deadlines' : 'Due in ≤ 3 days'}
            tone={buckets.urgent.length > 0 ? 'urgent' : 'good'}
          />
          <HeroStat
            value={buckets.active.length}
            label="In progress"
            sub={`${buckets.editing.length} editing · ${buckets.review.length} in review`}
            tone="info"
          />
          <HeroStat
            value={metrics.versions}
            label="Versions shipped"
            sub="Across all your projects"
            tone="info"
          />
          <HeroStat
            value={`${metrics.completionRate}%`}
            label="Completion rate"
            sub={`${buckets.completed.length} of ${metrics.totalProjects} projects done`}
            tone={metrics.completionRate >= 80 ? 'good' : 'info'}
          />
        </section>

        {/* Filter pills + search */}
        <section className="mb-4 flex items-center gap-2 flex-wrap">
          <FilterPill active={filter === 'all'} onClick={() => setFilter('all')} count={assignments.length}>All</FilterPill>
          <FilterPill active={filter === 'urgent'} onClick={() => setFilter('urgent')} tone="urgent" count={buckets.urgent.length}>Urgent</FilterPill>
          <FilterPill active={filter === 'editing'} onClick={() => setFilter('editing')} count={buckets.editing.length}>Editing</FilterPill>
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

        {/* Assignments list */}
        <section className="mb-8">
          {filtered.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            <div className="space-y-2.5">
              {filtered.map(a => <AssignmentCard key={a.id} a={a} token={token} />)}
            </div>
          )}
        </section>

        {/* Review-only — separated since these aren't assignments */}
        {reviewOnly.length > 0 && (
          <section className="mb-8">
            <h2 className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
              Review access only
            </h2>
            <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
              Projects shared with you for review. The script and references aren&apos;t available here — you can still watch and comment.
            </p>
            <div className="space-y-2">
              {reviewOnly.map(r => (
                <a
                  key={r.link_id}
                  href={`/review/${r.share_token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-xl p-3 transition-all hover:translate-y-[-1px]"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{r.project_title}</h3>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: 'rgba(6,182,212,0.18)', color: '#06b6d4' }}>
                      Review only · {r.permission}
                    </span>
                  </div>
                  {r.label && <p className="text-[11px] italic mt-1" style={{ color: 'var(--text-muted)' }}>{r.label}</p>}
                </a>
              ))}
            </div>
          </section>
        )}
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
      {count != null && (<span className="text-[10px] opacity-70">{count}</span>)}
    </button>
  );
}

function EmptyState({ filter }: { filter: Filter }) {
  const messages: Record<Filter, { emoji: string; title: string; sub: string }> = {
    all:        { emoji: '🎬', title: 'No assignments yet', sub: 'When the owner assigns you a project, it\'ll appear here.' },
    urgent:     { emoji: '✨', title: 'Nothing urgent', sub: 'No tight deadlines. You\'re ahead.' },
    editing:    { emoji: '✂️', title: 'Nothing to edit', sub: 'Pick up an assignment to get started.' },
    review:     { emoji: '👀', title: 'Nothing in review', sub: 'Submitted versions show up here while the owner reviews.' },
    completed:  { emoji: '🏁', title: 'No completed projects', sub: 'Wrapped projects land here as a record of your work.' },
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

function AssignmentCard({ a, token }: { a: Assignment; token: string }) {
  const status = STATUS_STYLES[a.status] || STATUS_STYLES.assigned;
  const dl = deadlineInfo(a.deadline);
  const dlColor = dl.tone === 'overdue' || dl.tone === 'urgent' ? '#ef4444' : dl.tone === 'soon' ? '#f97316' : 'var(--text-muted)';
  const flagged = dl.tone === 'overdue' || dl.tone === 'urgent';

  return (
    <Link href={`/editor/${token}/${a.project_id}`} className="block">
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
              <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{a.project_title}</h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: status.bg, color: status.text }}>{status.label}</span>
              {a.uploaded_version_count > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: 'rgba(34,197,94,0.18)', color: '#22c55e' }}>
                  📤 v{a.uploaded_version_count}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {a.image_ref_count > 0 && <span>🖼️ {a.image_ref_count} ref{a.image_ref_count === 1 ? '' : 's'}</span>}
              {a.voiceover_count > 0 && <span>🎙️ Voiceover ready</span>}
              {a.youtube_ref_count > 0 && <span>📺 {a.youtube_ref_count} YouTube</span>}
              {a.deadline && (
                <span style={{ color: dlColor, marginLeft: 'auto', fontWeight: dl.tone === 'urgent' || dl.tone === 'overdue' ? 600 : 400 }}>
                  {dl.tone === 'urgent' || dl.tone === 'overdue' ? '⏰ ' : ''}{dl.text}
                </span>
              )}
            </div>

            {a.editor_notes && (
              <p className="text-[11px] mt-2 italic line-clamp-2" style={{ color: '#06b6d4' }}>
                {a.editor_notes}
              </p>
            )}
          </div>

          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-1 shrink-0" style={{ color: 'var(--text-muted)' }}>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </div>
    </Link>
  );
}
