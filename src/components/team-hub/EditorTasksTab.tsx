'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  type SurfaceDescriptor,
  type RosterEntry,
} from '@/lib/team-hub-types';
import type { EditorTaskRow } from '@/lib/team-hub-tasks-db';
import {
  TaskListToolbar,
  useTaskListControls,
  type AssignmentViewMode,
  type SortOption,
  type FilterOption,
  type SortState,
  compareValues,
  dateMs,
  deadlineHint,
  groupByStatus,
  matchesSearch,
  timeAgo,
} from './task-views';

/**
 * Editor command center on the Tasks tab. Mirror of NarratorTasksTab
 * with editor-specific data shape, statuses, and kanban columns.
 *
 * Inline status / deadline edits hit PATCH
 * /api/team-hub/editor-assignment/[id] — the workspace-scoped wrapper
 * around updateEditorAssignment.
 */

const STATUS_OPTIONS = ['assigned', 'editing', 'submitted', 'approved', 'completed'] as const;
type Status = (typeof STATUS_OPTIONS)[number];

const STATUS_COLOR: Record<Status, { bg: string; text: string }> = {
  assigned:  { bg: 'rgba(234,179,8,0.15)',  text: '#facc15' },
  editing:   { bg: 'rgba(124,58,237,0.18)', text: '#a78bfa' },
  submitted: { bg: 'rgba(59,130,246,0.15)', text: '#60a5fa' },
  approved:  { bg: 'rgba(34,197,94,0.18)',  text: '#4ade80' },
  completed: { bg: 'rgba(34,197,94,0.18)',  text: '#4ade80' },
};

const FILTER_KEYS = ['all', 'urgent', 'editing', 'submitted', 'completed'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const SORT_FIELDS = [
  'project_title',
  'status',
  'deadline',
  'unresolved',
  'versions',
  'last_accessed_at',
  'updated_at',
] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SORT_OPTIONS: readonly SortOption<SortField>[] = [
  { field: 'updated_at', label: 'Last update' },
  { field: 'deadline', label: 'Deadline' },
  { field: 'project_title', label: 'Project' },
  { field: 'status', label: 'Status' },
  { field: 'unresolved', label: 'Unresolved comments' },
  { field: 'versions', label: 'Versions uploaded' },
  { field: 'last_accessed_at', label: 'Last opened' },
];

const KANBAN_COLUMNS = [
  { key: 'assigned', label: 'Assigned', statuses: ['assigned'] as readonly string[], color: '#facc15' },
  { key: 'editing', label: 'Editing', statuses: ['editing'] as readonly string[], color: '#a78bfa' },
  { key: 'submitted', label: 'Submitted', statuses: ['submitted'] as readonly string[], color: '#60a5fa' },
  { key: 'done', label: 'Done', statuses: ['approved', 'completed'] as readonly string[], color: '#4ade80' },
] as const;
type KanbanKey = (typeof KANBAN_COLUMNS)[number]['key'];

interface EditorTasksTabProps {
  entry: RosterEntry;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

export function EditorTasksTab({ entry, onOpenSurface }: EditorTasksTabProps) {
  const [tasks, setTasks] = useState<EditorTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const controls = useTaskListControls<FilterKey, SortField>({
    roleKey: 'team-hub-editor',
    defaultFilter: 'all',
    defaultSort: { field: 'updated_at', direction: 'desc' },
    allowedFilters: FILTER_KEYS,
    allowedSortFields: SORT_FIELDS,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/team-hub/${entry.id}/editor-tasks`, { cache: 'no-store' });
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

  const patchAssignment = useCallback(
    async (id: string, fields: Partial<Pick<EditorTaskRow, 'status' | 'deadline'>>) => {
      const before = tasks;
      setTasks(tasks.map((t) => (t.id === id ? { ...t, ...fields } : t)));
      try {
        const res = await fetch(`/api/team-hub/editor-assignment/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success('Updated');
      } catch {
        setTasks(before);
        toast.error('Failed to update');
      }
    },
    [tasks],
  );

  const buckets = useMemo(() => bucketize(tasks), [tasks]);

  const visible = useMemo(() => {
    let list = applyFilter(tasks, controls.filter, buckets);
    if (controls.search.trim()) {
      list = list.filter((t) => matchesSearch([t.project_title], controls.search));
    }
    return [...list].sort(makeSorter(controls.sort));
  }, [tasks, buckets, controls.filter, controls.search, controls.sort]);

  const filterOptions: readonly FilterOption<FilterKey>[] = useMemo(
    () => [
      { key: 'all', label: 'All', count: tasks.length },
      { key: 'urgent', label: 'Urgent', count: buckets.urgent.length, tone: buckets.urgent.length > 0 ? 'urgent' : undefined },
      { key: 'editing', label: 'Editing', count: buckets.editing.length },
      { key: 'submitted', label: 'Submitted', count: buckets.submitted.length },
      { key: 'completed', label: 'Completed', count: buckets.completed.length },
    ],
    [tasks.length, buckets],
  );

  if (loading) {
    return (
      <div className="px-6 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
        Loading editor tasks…
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
          No editor assignments yet
        </h3>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Assign {entry.name} to a project from the project page.
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
        <EditorTaskBody
          tasks={visible}
          view={controls.view}
          editorId={entry.id}
          onChangeStatus={(id, s) => patchAssignment(id, { status: s })}
          onChangeDeadline={(id, d) => patchAssignment(id, { deadline: d ?? undefined })}
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
  tasks: EditorTaskRow[];
  view: AssignmentViewMode;
  editorId: string;
  onChangeStatus: (id: string, status: string) => void;
  onChangeDeadline: (id: string, deadline: string | null) => void;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

function EditorTaskBody(props: BodyProps) {
  if (props.view === 'kanban') return <KanbanView {...props} />;
  if (props.view === 'table') return <TableView {...props} />;
  return <CardsView {...props} />;
}

function CardsView({ tasks, editorId, onChangeStatus, onChangeDeadline, onOpenSurface }: BodyProps) {
  return (
    <div className="px-6 py-5 space-y-3">
      {tasks.map((task) => (
        <EditorTaskCard
          key={task.id}
          task={task}
          editorId={editorId}
          onChangeStatus={(s) => onChangeStatus(task.id, s)}
          onChangeDeadline={(d) => onChangeDeadline(task.id, d)}
          onOpenSurface={onOpenSurface}
        />
      ))}
    </div>
  );
}

function KanbanView({ tasks, onOpenSurface }: BodyProps) {
  const grouped = useMemo(
    () => groupByStatus<EditorTaskRow, KanbanKey>(tasks, KANBAN_COLUMNS, 'assigned'),
    [tasks],
  );

  return (
    <div className="px-6 py-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
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

function KanbanCard({ task, onOpenSurface }: { task: EditorTaskRow; onOpenSurface: (s: SurfaceDescriptor) => void }) {
  const dl = deadlineHint(task.deadline);
  const dlColor = dl.tone === 'overdue' ? '#fda4af' : dl.tone === 'soon' ? '#fb923c' : 'var(--text-muted)';

  return (
    <button
      onClick={() => onOpenSurface({ kind: 'editor-tab', id: task.project_id })}
      className="w-full text-left rounded-lg p-2.5"
      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
    >
      <p className="text-xs font-semibold mb-1.5 line-clamp-2" style={{ color: 'var(--text-primary)' }}>
        {task.project_title || 'Untitled'}
      </p>
      <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span>
          {task.uploaded_version_count} version{task.uploaded_version_count === 1 ? '' : 's'}
        </span>
        {task.deadline && <span style={{ color: dlColor }}>{dl.text}</span>}
      </div>
      {task.unresolved_review_comment_count > 0 && (
        <p className="text-[10px] mt-1" style={{ color: '#fb923c' }}>
          {task.unresolved_review_comment_count} unresolved
        </p>
      )}
    </button>
  );
}

function TableView({ tasks, onOpenSurface, onChangeStatus, onChangeDeadline }: BodyProps) {
  return (
    <div className="px-6 py-5">
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                <Th>Project</Th>
                <Th>Status</Th>
                <Th align="right">Versions</Th>
                <Th align="right">Unresolved</Th>
                <Th>Deadline</Th>
                <Th>Last accessed</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <EditorTableRow
                  key={task.id}
                  task={task}
                  onOpenSurface={onOpenSurface}
                  onChangeStatus={(s) => onChangeStatus(task.id, s)}
                  onChangeDeadline={(d) => onChangeDeadline(task.id, d)}
                />
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

function EditorTableRow({
  task,
  onOpenSurface,
  onChangeStatus,
  onChangeDeadline,
}: {
  task: EditorTaskRow;
  onOpenSurface: (s: SurfaceDescriptor) => void;
  onChangeStatus: (s: string) => void;
  onChangeDeadline: (d: string | null) => void;
}) {
  const status = (STATUS_OPTIONS as readonly string[]).includes(task.status)
    ? (task.status as Status)
    : 'assigned';
  const sc = STATUS_COLOR[status];
  const dl = deadlineHint(task.deadline);
  const dlColor = dl.tone === 'overdue' ? '#fda4af' : dl.tone === 'soon' ? '#fb923c' : 'var(--text-muted)';

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td className="px-3 py-2.5">
        <a
          href={`/projects/${task.project_id}`}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium hover:underline"
          style={{ color: 'var(--text-primary)' }}
        >
          {task.project_title || 'Untitled'}
        </a>
      </td>
      <td className="px-3 py-2.5">
        <select
          value={status}
          onChange={(e) => onChangeStatus(e.target.value)}
          className="appearance-none text-[10px] px-2 py-0.5 rounded-full font-medium capitalize cursor-pointer outline-none"
          style={{ background: sc.bg, color: sc.text, border: `1px solid ${sc.text}30` }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s} style={{ background: '#1a1a1a', color: '#fff' }}>
              {s}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {task.uploaded_version_count}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: task.unresolved_review_comment_count > 0 ? '#fb923c' : 'var(--text-muted)' }}>
        {task.unresolved_review_comment_count}
      </td>
      <td className="px-3 py-2.5">
        <input
          type="date"
          value={task.deadline?.slice(0, 10) ?? ''}
          onChange={(e) => onChangeDeadline(e.target.value || null)}
          className="bg-transparent outline-none text-[11px]"
          style={{ color: dlColor, colorScheme: 'dark' }}
        />
      </td>
      <td className="px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>
        {timeAgo(task.last_accessed_at)}
      </td>
      <td className="px-3 py-2.5 text-right">
        <button
          onClick={() => onOpenSurface({ kind: 'editor-tab', id: task.project_id })}
          className="text-[11px] px-2 py-0.5 rounded-md font-medium"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
        >
          Workspace
        </button>
      </td>
    </tr>
  );
}

interface CardProps {
  task: EditorTaskRow;
  editorId: string;
  onChangeStatus: (s: string) => void;
  onChangeDeadline: (d: string | null) => void;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

function EditorTaskCard({ task, editorId, onChangeStatus, onChangeDeadline, onOpenSurface }: CardProps) {
  const [editingDeadline, setEditingDeadline] = useState(false);
  const [draftDeadline, setDraftDeadline] = useState(task.deadline?.slice(0, 10) ?? '');

  const status = (STATUS_OPTIONS as readonly string[]).includes(task.status)
    ? (task.status as Status)
    : 'assigned';
  const sc = STATUS_COLOR[status];
  const dl = deadlineHint(task.deadline);

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
          <a
            href={`/projects/${task.project_id}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm font-semibold hover:underline"
            style={{ color: 'var(--text-primary)' }}
          >
            {task.project_title || 'Untitled project'}
          </a>
          <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>
              {task.uploaded_version_count} version{task.uploaded_version_count === 1 ? '' : 's'} uploaded
            </span>
            {task.unresolved_review_comment_count > 0 && (
              <>
                <span>·</span>
                <span style={{ color: '#fb923c' }}>
                  {task.unresolved_review_comment_count} unresolved comment{task.unresolved_review_comment_count === 1 ? '' : 's'}
                </span>
              </>
            )}
            <span>·</span>
            <span>Last accessed {timeAgo(task.last_accessed_at)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <select
              value={status}
              onChange={(e) => onChangeStatus(e.target.value)}
              className="appearance-none text-[11px] px-2.5 py-1 pr-6 rounded-full font-medium capitalize cursor-pointer outline-none"
              style={{ background: sc.bg, color: sc.text, border: `1px solid ${sc.text}30` }}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s} style={{ background: '#1a1a1a', color: '#fff' }}>
                  {s}
                </option>
              ))}
            </select>
            <svg
              className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none"
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={sc.text} strokeWidth="2.5"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>

          {editingDeadline ? (
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={draftDeadline}
                onChange={(e) => setDraftDeadline(e.target.value)}
                className="text-[11px] px-2 py-1 rounded-md outline-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <button
                onClick={() => {
                  onChangeDeadline(draftDeadline || null);
                  setEditingDeadline(false);
                }}
                className="text-[11px] px-2 py-1 rounded-md font-medium text-white"
                style={{ background: '#7c3aed' }}
              >
                Save
              </button>
              <button
                onClick={() => {
                  setDraftDeadline(task.deadline?.slice(0, 10) ?? '');
                  setEditingDeadline(false);
                }}
                className="text-[11px] px-2 py-1 rounded-md"
                style={{ color: 'var(--text-muted)' }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingDeadline(true)}
              className="text-[11px] px-2 py-1 rounded-full font-medium"
              style={{
                background:
                  dl.tone === 'overdue'
                    ? 'rgba(239,68,68,0.15)'
                    : dl.tone === 'soon'
                      ? 'rgba(249,115,22,0.15)'
                      : 'rgba(255,255,255,0.04)',
                color: dl.tone === 'overdue' ? '#fda4af' : dl.tone === 'soon' ? '#fb923c' : 'var(--text-muted)',
                border: '1px solid var(--border)',
              }}
            >
              {dl.text}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <ActionButton
          label="Open editor workspace"
          onClick={() => onOpenSurface({ kind: 'editor-tab', id: task.project_id })}
        />
        <ActionButton
          label="Open review session"
          disabled={!task.review_project_id}
          tooltip={!task.review_project_id ? 'No review version uploaded yet' : undefined}
          onClick={() =>
            task.review_project_id && onOpenSurface({ kind: 'review', id: task.review_project_id })
          }
        />
        <ActionButton
          label="Quick chat"
          onClick={() => {
            window.location.href = `/messages?with=${editorId}`;
          }}
        />
      </div>
    </motion.div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  tooltip,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tooltip?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      className="text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
    >
      {label}
    </button>
  );
}

// ── Pure helpers ────────────────────────────────────────────────────

interface Buckets {
  urgent: EditorTaskRow[];
  editing: EditorTaskRow[];
  submitted: EditorTaskRow[];
  completed: EditorTaskRow[];
}

function bucketize(rows: readonly EditorTaskRow[]): Buckets {
  const now = Date.now();
  const buckets: Buckets = { urgent: [], editing: [], submitted: [], completed: [] };
  for (const a of rows) {
    if (a.status === 'completed' || a.status === 'approved') {
      buckets.completed.push(a);
      continue;
    }
    const dueSoon =
      a.deadline && new Date(a.deadline).getTime() - now <= 3 * 24 * 60 * 60 * 1000;
    const hasUnresolved = a.unresolved_review_comment_count > 0;
    if (dueSoon || hasUnresolved) buckets.urgent.push(a);
    if (a.status === 'editing') buckets.editing.push(a);
    if (a.status === 'submitted') buckets.submitted.push(a);
  }
  return buckets;
}

function applyFilter(rows: EditorTaskRow[], filter: FilterKey, buckets: Buckets): EditorTaskRow[] {
  switch (filter) {
    case 'all':
      return rows;
    case 'urgent':
      return buckets.urgent;
    case 'editing':
      return buckets.editing;
    case 'submitted':
      return buckets.submitted;
    case 'completed':
      return buckets.completed;
  }
}

function makeSorter(state: SortState<SortField>): (a: EditorTaskRow, b: EditorTaskRow) => number {
  return (a, b) => {
    switch (state.field) {
      case 'project_title':
        return compareValues(a.project_title ?? '', b.project_title ?? '', state.direction);
      case 'status':
        return compareValues(a.status, b.status, state.direction);
      case 'deadline':
        return compareValues(dateMs(a.deadline), dateMs(b.deadline), state.direction);
      case 'unresolved':
        return compareValues(a.unresolved_review_comment_count, b.unresolved_review_comment_count, state.direction);
      case 'versions':
        return compareValues(a.uploaded_version_count, b.uploaded_version_count, state.direction);
      case 'last_accessed_at':
        return compareValues(dateMs(a.last_accessed_at), dateMs(b.last_accessed_at), state.direction);
      case 'updated_at':
        return compareValues(dateMs(a.updated_at), dateMs(b.updated_at), state.direction);
    }
  };
}
