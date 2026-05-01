'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { NotificationBell } from '@/components/dashboard/NotificationBell';
import { MessagesLink } from '@/components/messages/MessagesLink';
import { AvailabilityToggle } from '@/components/dashboard/AvailabilityToggle';
import { NotificationPrefsPanel } from '@/components/dashboard/NotificationPrefsPanel';
import { ViewModeToggle, loadViewMode, saveViewMode, type AssignmentViewMode } from '@/components/dashboard/ViewModeToggle';

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
type SortField = 'title' | 'status' | 'versions' | 'refs' | 'deadline' | 'updated';
type SortDir = 'asc' | 'desc';

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
  const [viewMode, setViewMode] = useState<AssignmentViewMode>('cards');
  const [sortField, setSortField] = useState<SortField>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => { setViewMode(loadViewMode('editor', 'cards')); }, []);
  const updateViewMode = (m: AssignmentViewMode) => { setViewMode(m); saveViewMode('editor', m); };

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
            <MessagesLink token={token} />
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

        {/* Filter pills + search + view toggle */}
        <section className="mb-4 flex items-center gap-2 flex-wrap">
          <FilterPill active={filter === 'all'} onClick={() => setFilter('all')} count={assignments.length}>All</FilterPill>
          <FilterPill active={filter === 'urgent'} onClick={() => setFilter('urgent')} tone="urgent" count={buckets.urgent.length}>Urgent</FilterPill>
          <FilterPill active={filter === 'editing'} onClick={() => setFilter('editing')} count={buckets.editing.length}>Editing</FilterPill>
          <FilterPill active={filter === 'review'} onClick={() => setFilter('review')} count={buckets.review.length}>In review</FilterPill>
          <FilterPill active={filter === 'completed'} onClick={() => setFilter('completed')} count={buckets.completed.length}>Completed</FilterPill>
          <div className="ml-auto flex items-center gap-2">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="px-3 py-1.5 rounded-lg text-xs"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', minWidth: 180 }}
            />
            <ViewModeToggle mode={viewMode} onChange={updateViewMode} />
          </div>
        </section>

        {/* Assignments list — renders one of three views based on viewMode */}
        <section className="mb-8">
          {filtered.length === 0 ? (
            <EmptyState filter={filter} />
          ) : viewMode === 'kanban' ? (
            <KanbanView assignments={filtered} token={token} />
          ) : viewMode === 'table' ? (
            <TableView
              assignments={filtered}
              token={token}
              sortField={sortField}
              sortDir={sortDir}
              onSort={f => {
                if (f === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                else { setSortField(f); setSortDir('desc'); }
              }}
            />
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

// ─── Kanban view ────────────────────────────────────────────────────────────

const KANBAN_COLUMNS: Array<{ key: string; label: string; statuses: string[]; color: string }> = [
  { key: 'pending',  label: 'New',         statuses: ['assigned'],              color: '#eab308' },
  { key: 'editing',  label: 'Editing',     statuses: ['editing'],               color: '#a78bfa' },
  { key: 'review',   label: 'In review',   statuses: ['submitted'],             color: '#3b82f6' },
  { key: 'done',     label: 'Done',        statuses: ['approved', 'completed'], color: '#22c55e' },
];

function KanbanView({ assignments, token }: { assignments: Assignment[]; token: string }) {
  const grouped = useMemo(() => {
    const m: Record<string, Assignment[]> = {};
    for (const col of KANBAN_COLUMNS) m[col.key] = [];
    for (const a of assignments) {
      const col = KANBAN_COLUMNS.find(c => c.statuses.includes(a.status));
      if (col) m[col.key].push(a);
      else m['pending'].push(a);
    }
    return m;
  }, [assignments]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {KANBAN_COLUMNS.map(col => {
        const items = grouped[col.key] || [];
        return (
          <div
            key={col.key}
            className="rounded-xl p-3 flex flex-col"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', minHeight: 200 }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{col.label}</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${col.color}22`, color: col.color }}>{items.length}</span>
            </div>
            <div className="space-y-2 flex-1">
              {items.length === 0 ? (
                <p className="text-[11px] text-center py-4" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>—</p>
              ) : items.map(a => <KanbanCard key={a.id} a={a} token={token} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({ a, token }: { a: Assignment; token: string }) {
  const dl = deadlineInfo(a.deadline);
  const flagged = dl.tone === 'overdue' || dl.tone === 'urgent';
  const dlColor = dl.tone === 'overdue' || dl.tone === 'urgent' ? '#ef4444' : dl.tone === 'soon' ? '#f97316' : 'var(--text-muted)';

  return (
    <Link href={`/editor/${token}/${a.project_id}`} className="block">
      <div
        className="rounded-lg p-2.5 transition-all hover:translate-y-[-1px]"
        style={{
          background: 'var(--bg-primary)',
          border: flagged ? '1px solid rgba(239,68,68,0.35)' : '1px solid var(--border)',
        }}
      >
        <p className="text-xs font-semibold mb-1.5 line-clamp-2" style={{ color: 'var(--text-primary)' }}>
          {a.project_title}
        </p>
        <div className="flex items-center gap-2 flex-wrap text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {a.uploaded_version_count > 0 && <span style={{ color: '#22c55e' }}>📤 v{a.uploaded_version_count}</span>}
          {a.image_ref_count > 0 && <span>🖼️ {a.image_ref_count}</span>}
          {a.voiceover_count > 0 && <span>🎙️</span>}
        </div>
        {a.deadline && (
          <p className="text-[10px] mt-1.5" style={{ color: dlColor, fontWeight: dl.tone === 'urgent' || dl.tone === 'overdue' ? 600 : 400 }}>
            {dl.tone === 'urgent' || dl.tone === 'overdue' ? '⏰ ' : ''}{dl.text}
          </p>
        )}
      </div>
    </Link>
  );
}

// ─── Table view ─────────────────────────────────────────────────────────────

function TableView({
  assignments,
  token,
  sortField,
  sortDir,
  onSort,
}: {
  assignments: Assignment[];
  token: string;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (f: SortField) => void;
}) {
  const sorted = useMemo(() => {
    const list = [...assignments];
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sortField) {
        case 'title':    return ((a.project_title || '').localeCompare(b.project_title || '')) * dir;
        case 'status':   return a.status.localeCompare(b.status) * dir;
        case 'versions': return (a.uploaded_version_count - b.uploaded_version_count) * dir;
        case 'refs':     return ((a.image_ref_count + a.youtube_ref_count) - (b.image_ref_count + b.youtube_ref_count)) * dir;
        case 'deadline': {
          const av = a.deadline ? new Date(a.deadline).getTime() : Infinity;
          const bv = b.deadline ? new Date(b.deadline).getTime() : Infinity;
          return (av - bv) * dir;
        }
        case 'updated':  return (new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()) * dir;
      }
    });
    return list;
  }, [assignments, sortField, sortDir]);

  const headers: Array<{ key: SortField; label: string; align?: 'left' | 'right' | 'center' }> = [
    { key: 'title',    label: 'Project' },
    { key: 'status',   label: 'Status' },
    { key: 'versions', label: 'Versions', align: 'center' },
    { key: 'refs',     label: 'Refs', align: 'center' },
    { key: 'deadline', label: 'Deadline' },
    { key: 'updated',  label: 'Updated' },
  ];

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
              {headers.map(h => {
                const active = sortField === h.key;
                return (
                  <th
                    key={h.key}
                    onClick={() => onSort(h.key)}
                    className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-semibold cursor-pointer select-none transition-colors"
                    style={{
                      color: active ? '#a78bfa' : 'var(--text-muted)',
                      textAlign: h.align || 'left',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      {h.label}
                      <span style={{ opacity: active ? 1 : 0.3, fontSize: 9 }}>
                        {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </span>
                  </th>
                );
              })}
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {sorted.map(a => <TableRow key={a.id} a={a} token={token} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableRow({ a, token }: { a: Assignment; token: string }) {
  const status = STATUS_STYLES[a.status] || STATUS_STYLES.assigned;
  const dl = deadlineInfo(a.deadline);
  const dlColor = dl.tone === 'overdue' || dl.tone === 'urgent' ? '#ef4444' : dl.tone === 'soon' ? '#f97316' : 'var(--text-muted)';
  const updated = new Date(a.updated_at);
  const updatedLabel = (() => {
    const ms = Date.now() - updated.getTime();
    const day = 1000 * 60 * 60 * 24;
    if (ms < day) return 'today';
    if (ms < day * 2) return 'yesterday';
    if (ms < day * 7) return `${Math.floor(ms / day)}d ago`;
    return updated.toLocaleDateString();
  })();

  const navigate = () => { window.location.href = `/editor/${token}/${a.project_id}`; };
  return (
    <tr
      role="link"
      tabIndex={0}
      aria-label={`Open ${a.project_title}`}
      className="cursor-pointer transition-colors group focus:outline-none"
      style={{ borderBottom: '1px solid var(--border)' }}
      onClick={navigate}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(); } }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,58,237,0.05)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      onFocus={e => (e.currentTarget.style.background = 'rgba(124,58,237,0.10)')}
      onBlur={e => (e.currentTarget.style.background = 'transparent')}
    >
      <td className="px-3 py-2.5">
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{a.project_title}</span>
      </td>
      <td className="px-3 py-2.5">
        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: status.bg, color: status.text }}>
          {status.label}
        </span>
      </td>
      <td className="px-3 py-2.5 text-center">
        {a.uploaded_version_count > 0 ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(34,197,94,0.18)', color: '#22c55e' }}>
            v{a.uploaded_version_count}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)', opacity: 0.5 }}>—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-center" style={{ color: 'var(--text-muted)' }}>
        <span className="inline-flex items-center gap-2">
          {a.image_ref_count > 0 && <span title={`${a.image_ref_count} image references`}>🖼️ {a.image_ref_count}</span>}
          {a.youtube_ref_count > 0 && <span title={`${a.youtube_ref_count} YouTube references`}>📺 {a.youtube_ref_count}</span>}
          {a.voiceover_count > 0 && <span title="Voiceover ready">🎙️</span>}
          {a.image_ref_count + a.youtube_ref_count + a.voiceover_count === 0 && <span style={{ opacity: 0.5 }}>—</span>}
        </span>
      </td>
      <td className="px-3 py-2.5">
        {a.deadline ? (
          <span style={{ color: dlColor, fontWeight: dl.tone === 'urgent' || dl.tone === 'overdue' ? 600 : 400 }}>
            {dl.text}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)', opacity: 0.5 }}>—</span>
        )}
      </td>
      <td className="px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>{updatedLabel}</td>
      <td className="px-2 py-2.5 text-right">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-30 group-hover:opacity-100 transition-opacity inline-block" style={{ color: 'var(--text-muted)' }}>
          <path d="M9 18l6-6-6-6" />
        </svg>
      </td>
    </tr>
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
