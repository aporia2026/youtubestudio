'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  type SurfaceDescriptor,
  type RosterEntry,
} from '@/lib/team-hub-types';
import type { ReviewerTaskRow } from '@/lib/team-hub-tasks-db';
import {
  TaskListToolbar,
  useTaskListControls,
  type AssignmentViewMode,
  type SortOption,
  type FilterOption,
  type SortState,
  compareValues,
  dateMs,
  matchesSearch,
  timeAgo,
} from './task-views';

/**
 * Reviewer / client command center on the Tasks tab. Same toolbar
 * pattern as the narrator + editor tabs, scoped to review_share_links.
 *
 * Lighter than the other roles: reviewers are passive participants, so
 * the "edits" the owner cares about here are revoke + permission level
 * (deferred — currently the chip is read-only). Kanban groups by
 * activity bucket since review_share_links don't carry a status enum.
 */

const PERM_OPTIONS = ['view-only', 'can-comment', 'can-annotate'] as const;
type Perm = (typeof PERM_OPTIONS)[number];

const PERM_COLOR: Record<Perm, { bg: string; text: string }> = {
  'view-only':    { bg: 'rgba(255,255,255,0.05)', text: 'var(--text-muted)' },
  'can-comment':  { bg: 'rgba(6,182,212,0.18)',   text: '#67e8f9' },
  'can-annotate': { bg: 'rgba(124,58,237,0.18)',  text: '#a78bfa' },
};

const FILTER_KEYS = ['all', 'unresolved', 'active', 'idle', 'expired'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const SORT_FIELDS = [
  'project_title',
  'permission',
  'expires_at',
  'last_accessed_at',
  'access_count',
  'unresolved',
  'created_at',
] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SORT_OPTIONS: readonly SortOption<SortField>[] = [
  { field: 'created_at', label: 'Created' },
  { field: 'last_accessed_at', label: 'Last opened' },
  { field: 'expires_at', label: 'Expires' },
  { field: 'project_title', label: 'Project' },
  { field: 'permission', label: 'Permission' },
  { field: 'access_count', label: 'Visits' },
  { field: 'unresolved', label: 'Unresolved comments' },
];

const KANBAN_COLUMNS = [
  { key: 'active', label: 'Active', color: '#4ade80' },
  { key: 'idle', label: 'Never opened', color: '#facc15' },
  { key: 'expired', label: 'Expired', color: '#fda4af' },
] as const;
type KanbanKey = (typeof KANBAN_COLUMNS)[number]['key'];

interface ReviewerTasksTabProps {
  entry: RosterEntry;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

export function ReviewerTasksTab({ entry, onOpenSurface }: ReviewerTasksTabProps) {
  const [tasks, setTasks] = useState<ReviewerTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const controls = useTaskListControls<FilterKey, SortField>({
    roleKey: 'team-hub-reviewer',
    defaultFilter: 'all',
    defaultSort: { field: 'created_at', direction: 'desc' },
    allowedFilters: FILTER_KEYS,
    allowedSortFields: SORT_FIELDS,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch(`/api/team-hub/${entry.id}/reviewer-tasks`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [entry.id]);

  useEffect(() => {
    load();
  }, [load]);

  const buckets = useMemo(() => bucketize(tasks), [tasks]);

  const visible = useMemo(() => {
    let list = applyFilter(tasks, controls.filter, buckets);
    if (controls.search.trim()) {
      list = list.filter((t) => matchesSearch([t.project_title, t.label], controls.search));
    }
    return [...list].sort(makeSorter(controls.sort));
  }, [tasks, buckets, controls.filter, controls.search, controls.sort]);

  const filterOptions: readonly FilterOption<FilterKey>[] = useMemo(
    () => [
      { key: 'all', label: 'All', count: tasks.length },
      {
        key: 'unresolved',
        label: 'Unresolved',
        count: buckets.unresolved.length,
        tone: buckets.unresolved.length > 0 ? 'urgent' : undefined,
      },
      { key: 'active', label: 'Active', count: buckets.active.length },
      { key: 'idle', label: 'Never opened', count: buckets.idle.length },
      { key: 'expired', label: 'Expired', count: buckets.expired.length },
    ],
    [tasks.length, buckets],
  );

  if (loading) {
    return (
      <div className="px-6 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
        Loading reviewer tasks…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-10 text-center text-xs" style={{ color: '#fda4af' }}>
        {error}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="px-6 py-10 text-center">
        <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          No review links granted yet
        </h3>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Share a review link with {entry.name} from any project's Reviews page.
        </p>
      </div>
    );
  }

  return (
    <>
      <TaskListToolbar
        total={tasks.length}
        visible={visible.length}
        search={controls.search}
        onSearchChange={controls.setSearch}
        filter={controls.filter}
        filterOptions={filterOptions}
        onFilterChange={controls.setFilter}
        sort={controls.sort}
        sortOptions={SORT_OPTIONS}
        onSortChange={controls.setSort}
        view={controls.view}
        onViewChange={controls.setView}
      />
      {visible.length === 0 ? (
        <EmptyResults filter={controls.filter} clear={() => controls.setFilter('all')} />
      ) : (
        <ReviewerTaskBody
          tasks={visible}
          view={controls.view}
          reviewerId={entry.id}
          onOpenSurface={onOpenSurface}
        />
      )}
    </>
  );
}

function EmptyResults({ filter, clear }: { filter: FilterKey; clear: () => void }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
        No tasks match the current filter ({filter}).
      </p>
      <button
        onClick={clear}
        className="text-[11px] px-3 py-1 rounded-md font-medium"
        style={{ background: 'rgba(124,58,237,0.18)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.4)' }}
      >
        Show all
      </button>
    </div>
  );
}

interface BodyProps {
  tasks: ReviewerTaskRow[];
  view: AssignmentViewMode;
  reviewerId: string;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

function ReviewerTaskBody(props: BodyProps) {
  if (props.view === 'kanban') return <KanbanView {...props} />;
  if (props.view === 'table') return <TableView {...props} />;
  return <CardsView {...props} />;
}

function CardsView({ tasks, reviewerId, onOpenSurface }: BodyProps) {
  return (
    <div className="px-6 py-5 space-y-3">
      {tasks.map((task) => (
        <ReviewerTaskCard key={task.id} task={task} reviewerId={reviewerId} onOpenSurface={onOpenSurface} />
      ))}
    </div>
  );
}

function KanbanView({ tasks, onOpenSurface }: BodyProps) {
  const grouped = useMemo(() => {
    const out: Record<KanbanKey, ReviewerTaskRow[]> = { active: [], idle: [], expired: [] };
    for (const t of tasks) {
      const expired = t.expires_at && new Date(t.expires_at).getTime() < Date.now();
      if (expired) out.expired.push(t);
      else if (!t.last_accessed_at) out.idle.push(t);
      else out.active.push(t);
    }
    return out;
  }, [tasks]);

  return (
    <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-3 gap-3">
      {KANBAN_COLUMNS.map((col) => {
        const list = grouped[col.key];
        return (
          <div
            key={col.key}
            className="rounded-xl p-3 flex flex-col"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', minHeight: 200 }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                  {col.label}
                </span>
              </div>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                style={{ background: `${col.color}22`, color: col.color }}
              >
                {list.length}
              </span>
            </div>
            <div className="space-y-2 flex-1">
              {list.length === 0 ? (
                <p className="text-[11px] text-center py-4" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>—</p>
              ) : (
                list.map((task) => <KanbanCard key={task.id} task={task} onOpenSurface={onOpenSurface} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({ task, onOpenSurface }: { task: ReviewerTaskRow; onOpenSurface: (s: SurfaceDescriptor) => void }) {
  return (
    <button
      onClick={() => onOpenSurface({ kind: 'review', id: task.review_project_id })}
      className="w-full text-left rounded-lg p-2.5"
      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
    >
      <p className="text-xs font-semibold mb-1.5 line-clamp-2" style={{ color: 'var(--text-primary)' }}>
        {task.label || task.project_title || 'Review project'}
      </p>
      <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span>{task.access_count} visit{task.access_count === 1 ? '' : 's'}</span>
        <span className="capitalize">{task.permission}</span>
      </div>
      {task.authored_unresolved_count > 0 && (
        <p className="text-[10px] mt-1" style={{ color: '#fb923c' }}>
          {task.authored_unresolved_count} unresolved
        </p>
      )}
    </button>
  );
}

function TableView({ tasks, onOpenSurface }: BodyProps) {
  return (
    <div className="px-6 py-5">
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                <Th>Project</Th>
                <Th>Permission</Th>
                <Th align="right">Visits</Th>
                <Th align="right">Unresolved</Th>
                <Th>Last opened</Th>
                <Th>Expires</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <ReviewerTableRow key={task.id} task={task} onOpenSurface={onOpenSurface} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-semibold"
      style={{ color: 'var(--text-muted)', textAlign: align ?? 'left', borderBottom: '1px solid var(--border)' }}
    >
      {children}
    </th>
  );
}

function ReviewerTableRow({
  task,
  onOpenSurface,
}: {
  task: ReviewerTaskRow;
  onOpenSurface: (s: SurfaceDescriptor) => void;
}) {
  const perm = (PERM_OPTIONS as readonly string[]).includes(task.permission)
    ? (task.permission as Perm)
    : 'view-only';
  const pc = PERM_COLOR[perm];
  const expired = task.expires_at && new Date(task.expires_at).getTime() < Date.now();

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td className="px-3 py-2.5">
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
          {task.label || task.project_title || 'Review project'}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <span
          className="text-[10px] px-2 py-0.5 rounded-full font-medium capitalize"
          style={{ background: pc.bg, color: pc.text, border: `1px solid ${pc.text}30` }}
        >
          {perm}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {task.access_count}
      </td>
      <td
        className="px-3 py-2.5 text-right tabular-nums"
        style={{ color: task.authored_unresolved_count > 0 ? '#fb923c' : 'var(--text-muted)' }}
      >
        {task.authored_unresolved_count}
      </td>
      <td className="px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>
        {timeAgo(task.last_accessed_at)}
      </td>
      <td className="px-3 py-2.5" style={{ color: expired ? '#fda4af' : 'var(--text-muted)' }}>
        {task.expires_at ? new Date(task.expires_at).toLocaleDateString() : 'No expiry'}
      </td>
      <td className="px-3 py-2.5 text-right">
        <button
          onClick={() => onOpenSurface({ kind: 'review', id: task.review_project_id })}
          className="text-[11px] px-2 py-0.5 rounded-md font-medium"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
        >
          Open
        </button>
      </td>
    </tr>
  );
}

function ReviewerTaskCard({
  task,
  reviewerId,
  onOpenSurface,
}: {
  task: ReviewerTaskRow;
  reviewerId: string;
  onOpenSurface: (s: SurfaceDescriptor) => void;
}) {
  const perm = (PERM_OPTIONS as readonly string[]).includes(task.permission)
    ? (task.permission as Perm)
    : 'view-only';
  const pc = PERM_COLOR[perm];
  const expired = task.expires_at && new Date(task.expires_at).getTime() < Date.now();
  const [copied, setCopied] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="rounded-xl p-4"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {task.label || task.project_title || 'Review project'}
          </div>
          <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>
              {task.access_count} visit{task.access_count === 1 ? '' : 's'}
            </span>
            <span>·</span>
            <span>Last opened {timeAgo(task.last_accessed_at)}</span>
            {task.authored_unresolved_count > 0 && (
              <>
                <span>·</span>
                <span style={{ color: '#fb923c' }}>
                  {task.authored_unresolved_count} of their comments unresolved
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className="text-[11px] px-2.5 py-1 rounded-full font-medium"
            style={{ background: pc.bg, color: pc.text, border: `1px solid ${pc.text}30` }}
          >
            {perm}
          </span>
          {expired && (
            <span
              className="text-[11px] px-2.5 py-1 rounded-full font-medium"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#fda4af', border: '1px solid #fda4af30' }}
            >
              Expired
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => onOpenSurface({ kind: 'review', id: task.review_project_id })}
          className="text-[11px] px-2.5 py-1 rounded-md font-medium"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
        >
          Open review session
        </button>
        <button
          onClick={() => {
            window.location.href = `/messages?with=${reviewerId}`;
          }}
          className="text-[11px] px-2.5 py-1 rounded-md font-medium"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
        >
          Quick chat
        </button>
        <span className="flex-1" />
        <button
          onClick={async () => {
            try {
              const url = `${window.location.origin}/review/${task.token}`;
              await navigator.clipboard.writeText(url);
              setCopied(true);
              toast.success('Review link copied');
              setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error('Could not copy');
            }
          }}
          className="text-[11px] px-2.5 py-1 rounded-md font-medium"
          style={{
            background: copied ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.04)',
            color: copied ? '#4ade80' : 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
        >
          {copied ? '✓ Copied' : 'Copy review link'}
        </button>
      </div>
    </motion.div>
  );
}

// ── Pure helpers ────────────────────────────────────────────────────

interface Buckets {
  unresolved: ReviewerTaskRow[];
  active: ReviewerTaskRow[];
  idle: ReviewerTaskRow[];
  expired: ReviewerTaskRow[];
}

function bucketize(rows: readonly ReviewerTaskRow[]): Buckets {
  const buckets: Buckets = { unresolved: [], active: [], idle: [], expired: [] };
  for (const t of rows) {
    const expired = t.expires_at && new Date(t.expires_at).getTime() < Date.now();
    if (expired) buckets.expired.push(t);
    else if (!t.last_accessed_at) buckets.idle.push(t);
    else buckets.active.push(t);
    if (t.authored_unresolved_count > 0) buckets.unresolved.push(t);
  }
  return buckets;
}

function applyFilter(
  rows: ReviewerTaskRow[],
  filter: FilterKey,
  buckets: Buckets,
): ReviewerTaskRow[] {
  switch (filter) {
    case 'all':
      return rows;
    case 'unresolved':
      return buckets.unresolved;
    case 'active':
      return buckets.active;
    case 'idle':
      return buckets.idle;
    case 'expired':
      return buckets.expired;
  }
}

function makeSorter(state: SortState<SortField>): (a: ReviewerTaskRow, b: ReviewerTaskRow) => number {
  return (a, b) => {
    switch (state.field) {
      case 'project_title':
        return compareValues(a.project_title ?? a.label ?? '', b.project_title ?? b.label ?? '', state.direction);
      case 'permission':
        return compareValues(a.permission, b.permission, state.direction);
      case 'expires_at':
        return compareValues(dateMs(a.expires_at), dateMs(b.expires_at), state.direction);
      case 'last_accessed_at':
        return compareValues(dateMs(a.last_accessed_at), dateMs(b.last_accessed_at), state.direction);
      case 'access_count':
        return compareValues(a.access_count, b.access_count, state.direction);
      case 'unresolved':
        return compareValues(a.authored_unresolved_count, b.authored_unresolved_count, state.direction);
      case 'created_at':
        return compareValues(dateMs(a.created_at), dateMs(b.created_at), state.direction);
    }
  };
}
