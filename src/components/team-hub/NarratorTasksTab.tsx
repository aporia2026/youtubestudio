'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  type SurfaceDescriptor,
  type RosterEntry,
} from '@/lib/team-hub-types';
import type { NarratorTaskRow } from '@/lib/team-hub-tasks-db';
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
 * Narrator command center on the Tasks tab. Lists every assignment for
 * the selected narrator (any status) with three view modes (Cards /
 * Kanban / Table), filter chips, sort, and search.
 *
 * Lightweight inline edits (status select, deadline picker) write
 * through PUT /api/narrator/assignments/[id] with optimistic update +
 * rollback on failure.
 */

const STATUS_OPTIONS = [
  'assigned',
  'received',
  'recording',
  'submitted',
  'revisions',
  'approved',
  'completed',
] as const;
type Status = (typeof STATUS_OPTIONS)[number];

const STATUS_COLOR: Record<Status, { bg: string; text: string }> = {
  assigned:  { bg: 'rgba(234,179,8,0.15)',  text: '#facc15' },
  received:  { bg: 'rgba(6,182,212,0.15)',  text: '#67e8f9' },
  recording: { bg: 'rgba(124,58,237,0.18)', text: '#a78bfa' },
  submitted: { bg: 'rgba(59,130,246,0.15)', text: '#60a5fa' },
  revisions: { bg: 'rgba(249,115,22,0.18)', text: '#fb923c' },
  approved:  { bg: 'rgba(34,197,94,0.18)',  text: '#4ade80' },
  completed: { bg: 'rgba(34,197,94,0.18)',  text: '#4ade80' },
};

const FILTER_KEYS = ['all', 'urgent', 'recording', 'review', 'completed'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const SORT_FIELDS = [
  'project_title',
  'status',
  'deadline',
  'progress',
  'last_accessed_at',
  'updated_at',
] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SORT_OPTIONS: readonly SortOption<SortField>[] = [
  { field: 'updated_at', label: 'Last update' },
  { field: 'deadline', label: 'Deadline' },
  { field: 'project_title', label: 'Project' },
  { field: 'status', label: 'Status' },
  { field: 'progress', label: 'Progress' },
  { field: 'last_accessed_at', label: 'Last opened' },
];

const KANBAN_COLUMNS = [
  { key: 'pending', label: 'Pending', statuses: ['assigned'] as readonly string[], color: '#facc15' },
  { key: 'recording', label: 'Recording', statuses: ['received', 'recording'] as readonly string[], color: '#a78bfa' },
  { key: 'review', label: 'In review', statuses: ['submitted', 'revisions'] as readonly string[], color: '#60a5fa' },
  { key: 'done', label: 'Done', statuses: ['approved', 'completed'] as readonly string[], color: '#4ade80' },
] as const;
type KanbanKey = (typeof KANBAN_COLUMNS)[number]['key'];

interface NarratorTasksTabProps {
  entry: RosterEntry;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

export function NarratorTasksTab({ entry, onOpenSurface }: NarratorTasksTabProps) {
  const [tasks, setTasks] = useState<NarratorTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const controls = useTaskListControls<FilterKey, SortField>({
    roleKey: 'team-hub-narrator',
    defaultFilter: 'all',
    defaultSort: { field: 'updated_at', direction: 'desc' },
    allowedFilters: FILTER_KEYS,
    allowedSortFields: SORT_FIELDS,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch(`/api/team-hub/${entry.id}/narrator-tasks`, { cache: 'no-store' });
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
    async (id: string, fields: Partial<Pick<NarratorTaskRow, 'status' | 'deadline'>>) => {
      const before = tasks;
      setTasks(tasks.map((t) => (t.id === id ? { ...t, ...fields } : t)));
      try {
        // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
        const res = await fetch(`/api/narrator/assignments/${id}`, {
          method: 'PUT',
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

  // Pre-compute the per-bucket counts BEFORE applying the current
  // filter, so the chip labels reflect the full population (a "12
  // urgent" chip is the whole inbox's urgent count, not the visible
  // subset's).
  const buckets = useMemo(() => bucketize(tasks), [tasks]);

  // Apply filter → search → sort.
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
      { key: 'recording', label: 'Recording', count: buckets.recording.length },
      { key: 'review', label: 'In review', count: buckets.review.length },
      { key: 'completed', label: 'Completed', count: buckets.completed.length },
    ],
    [tasks.length, buckets],
  );

  if (loading) {
    return (
      <div className="px-6 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
        Loading tasks…
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
          No narrator assignments yet
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
        <NarratorTaskBody
          tasks={visible}
          view={controls.view}
          narratorId={entry.id}
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

// ── Body dispatch per view mode ─────────────────────────────────────

interface BodyProps {
  tasks: NarratorTaskRow[];
  view: AssignmentViewMode;
  narratorId: string;
  onChangeStatus: (id: string, status: string) => void;
  onChangeDeadline: (id: string, deadline: string | null) => void;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

function NarratorTaskBody(props: BodyProps) {
  if (props.view === 'kanban') return <KanbanView {...props} />;
  if (props.view === 'table') return <TableView {...props} />;
  return <CardsView {...props} />;
}

// ── Cards view ──────────────────────────────────────────────────────

function CardsView({ tasks, narratorId, onChangeStatus, onChangeDeadline, onOpenSurface }: BodyProps) {
  return (
    <div className="px-6 py-5 space-y-3">
      {tasks.map((task) => (
        <NarratorTaskRow
          key={task.id}
          task={task}
          narratorId={narratorId}
          onChangeStatus={(s) => onChangeStatus(task.id, s)}
          onChangeDeadline={(d) => onChangeDeadline(task.id, d)}
          onOpenSurface={onOpenSurface}
        />
      ))}
    </div>
  );
}

// ── Kanban view ─────────────────────────────────────────────────────

function KanbanView({ tasks, onOpenSurface }: BodyProps) {
  const grouped = useMemo(
    () => groupByStatus<NarratorTaskRow, KanbanKey>(tasks, KANBAN_COLUMNS, 'pending'),
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
                <p className="text-[11px] text-center py-4" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
                  —
                </p>
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

function KanbanCard({
  task,
  onOpenSurface,
}: {
  task: NarratorTaskRow;
  onOpenSurface: (s: SurfaceDescriptor) => void;
}) {
  const dl = deadlineHint(task.deadline);
  const progress = task.total_sections > 0 ? Math.round((task.approved_sections / task.total_sections) * 100) : 0;
  const dlColor = dl.tone === 'overdue' ? '#fda4af' : dl.tone === 'soon' ? '#fb923c' : 'var(--text-muted)';

  return (
    <button
      onClick={() => task.latest_take_id && onOpenSurface({ kind: 'takes', id: task.latest_take_id })}
      disabled={!task.latest_take_id}
      title={task.latest_take_id ? 'Open take comments' : 'No takes uploaded yet'}
      className="w-full text-left rounded-lg p-2.5 transition-colors disabled:cursor-default"
      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
    >
      <p className="text-xs font-semibold mb-1.5 line-clamp-2" style={{ color: 'var(--text-primary)' }}>
        {task.project_title || 'Untitled'}
      </p>
      <div className="h-1 rounded-full overflow-hidden mb-1.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${progress}%`,
            background: progress >= 100 ? '#4ade80' : 'linear-gradient(90deg, #7c3aed, #06b6d4)',
          }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span>
          {task.approved_sections}/{task.total_sections}
        </span>
        {task.deadline && <span style={{ color: dlColor }}>{dl.text}</span>}
      </div>
    </button>
  );
}

// ── Table view (Google-Sheets style) ────────────────────────────────

function TableView({ tasks, onOpenSurface, onChangeStatus, onChangeDeadline }: BodyProps) {
  return (
    <div className="px-6 py-5">
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                <Th>Project</Th>
                <Th>Status</Th>
                <Th align="center">Progress</Th>
                <Th>Deadline</Th>
                <Th>Last accessed</Th>
                <Th>Updated</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <NarratorTableRow
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
      style={{
        color: 'var(--text-muted)',
        textAlign: align ?? 'left',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {children}
    </th>
  );
}

function NarratorTableRow({
  task,
  onOpenSurface,
  onChangeStatus,
  onChangeDeadline,
}: {
  task: NarratorTaskRow;
  onOpenSurface: (s: SurfaceDescriptor) => void;
  onChangeStatus: (s: string) => void;
  onChangeDeadline: (d: string | null) => void;
}) {
  const status = (STATUS_OPTIONS as readonly string[]).includes(task.status)
    ? (task.status as Status)
    : 'assigned';
  const sc = STATUS_COLOR[status];
  const dl = deadlineHint(task.deadline);
  const progress = task.total_sections > 0 ? Math.round((task.approved_sections / task.total_sections) * 100) : 0;
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
        {(task.latest_take_duration_seconds != null || task.spoken_word_count > 0) && (
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {task.latest_take_duration_seconds != null && (
              <span title="Length of the most recent narration upload">
                {formatNarrationDuration(task.latest_take_duration_seconds)}
              </span>
            )}
            {task.latest_take_duration_seconds != null && task.spoken_word_count > 0 && ' · '}
            {task.spoken_word_count > 0 && (
              <span title="Spoken words in the script (production cues stripped)">
                {task.spoken_word_count.toLocaleString()} narrated words
              </span>
            )}
          </div>
        )}
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
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2 justify-center">
          <div className="flex-1 h-1 rounded-full overflow-hidden max-w-[80px]" style={{ background: 'rgba(255,255,255,0.05)' }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${progress}%`, background: progress >= 100 ? '#4ade80' : 'linear-gradient(90deg, #7c3aed, #06b6d4)' }}
            />
          </div>
          <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {task.approved_sections}/{task.total_sections}
          </span>
        </div>
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
      <td className="px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>
        {timeAgo(task.updated_at)}
      </td>
      <td className="px-3 py-2.5 text-right">
        <button
          onClick={() => task.latest_take_id && onOpenSurface({ kind: 'takes', id: task.latest_take_id })}
          disabled={!task.latest_take_id}
          className="text-[11px] px-2 py-0.5 rounded-md font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
        >
          Takes
        </button>
      </td>
    </tr>
  );
}

// ── Cards row (existing, unchanged behaviour) ────────────────────────

interface RowProps {
  task: NarratorTaskRow;
  narratorId: string;
  onChangeStatus: (s: string) => void;
  onChangeDeadline: (d: string | null) => void;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

function NarratorTaskRow({ task, narratorId, onChangeStatus, onChangeDeadline, onOpenSurface }: RowProps) {
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
          <div className="flex items-center gap-x-2 flex-wrap mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>
              {task.approved_sections}/{task.total_sections} approved
            </span>
            <span>·</span>
            <span>Last accessed {timeAgo(task.last_accessed_at)}</span>
            {task.latest_take_duration_seconds != null && (
              <>
                <span>·</span>
                <span title="Length of the most recent narration upload">
                  {formatNarrationDuration(task.latest_take_duration_seconds)}
                </span>
              </>
            )}
            {task.spoken_word_count > 0 && (
              <>
                <span>·</span>
                <span title="Spoken words in the script (production cues stripped)">
                  {task.spoken_word_count.toLocaleString()} narrated words
                </span>
              </>
            )}
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
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke={sc.text}
              strokeWidth="2.5"
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
                color:
                  dl.tone === 'overdue' ? '#fda4af' : dl.tone === 'soon' ? '#fb923c' : 'var(--text-muted)',
                border: '1px solid var(--border)',
              }}
              title="Click to edit deadline"
            >
              {dl.text}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <ActionButton
          label="Open script"
          onClick={() => onOpenSurface({ kind: 'script', id: task.project_id })}
        />
        <ActionButton
          label="Open take comments"
          disabled={!task.latest_take_id}
          tooltip={!task.latest_take_id ? 'No takes uploaded yet' : undefined}
          onClick={() => task.latest_take_id && onOpenSurface({ kind: 'takes', id: task.latest_take_id })}
        />
        <ActionButton
          label="Quick chat"
          onClick={() => {
            window.location.href = `/messages?with=${narratorId}`;
          }}
        />
        <span className="flex-1" />
        <CopyShareLink token={task.share_token} />
      </div>
    </motion.div>
  );
}

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tooltip?: string;
}

function ActionButton({ label, onClick, disabled, tooltip }: ActionButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      className="text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        background: 'rgba(255,255,255,0.04)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
      }}
    >
      {label}
    </button>
  );
}

function CopyShareLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={async () => {
        try {
          const url = `${window.location.origin}/narrate/${token}`;
          await navigator.clipboard.writeText(url);
          setCopied(true);
          toast.success('Share link copied');
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
      title="Copy the narrator's per-assignment share link"
    >
      {copied ? '✓ Copied' : 'Copy share link'}
    </button>
  );
}

// ── Pure helpers ────────────────────────────────────────────────────

/** Render a take's duration as `M:SS` (or `H:MM:SS` over an hour). Round
 *  to whole seconds so we don't show jittery fractions from the NUMERIC
 *  column. Returns empty string for non-finite / negative input so callers
 *  can fall back to omitting the segment entirely. */
function formatNarrationDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

interface Buckets {
  urgent: NarratorTaskRow[];
  recording: NarratorTaskRow[];
  review: NarratorTaskRow[];
  completed: NarratorTaskRow[];
}

function bucketize(rows: readonly NarratorTaskRow[]): Buckets {
  const now = Date.now();
  const buckets: Buckets = { urgent: [], recording: [], review: [], completed: [] };
  for (const a of rows) {
    if (a.status === 'completed' || a.status === 'approved') {
      buckets.completed.push(a);
      continue;
    }
    // Urgent: revisions OR within 3 days of deadline
    const dueSoon =
      a.deadline && new Date(a.deadline).getTime() - now <= 3 * 24 * 60 * 60 * 1000;
    if (a.status === 'revisions' || dueSoon) buckets.urgent.push(a);
    if (a.status === 'received' || a.status === 'recording' || a.status === 'assigned') {
      buckets.recording.push(a);
    }
    if (a.status === 'submitted' || a.status === 'revisions') {
      buckets.review.push(a);
    }
  }
  return buckets;
}

function applyFilter(rows: NarratorTaskRow[], filter: FilterKey, buckets: Buckets): NarratorTaskRow[] {
  switch (filter) {
    case 'all':
      return rows;
    case 'urgent':
      return buckets.urgent;
    case 'recording':
      return buckets.recording;
    case 'review':
      return buckets.review;
    case 'completed':
      return buckets.completed;
  }
}

function makeSorter(
  state: SortState<SortField>,
): (a: NarratorTaskRow, b: NarratorTaskRow) => number {
  return (a, b) => {
    switch (state.field) {
      case 'project_title':
        return compareValues(a.project_title ?? '', b.project_title ?? '', state.direction);
      case 'status':
        return compareValues(a.status, b.status, state.direction);
      case 'deadline':
        return compareValues(dateMs(a.deadline), dateMs(b.deadline), state.direction);
      case 'progress': {
        const ap = a.total_sections > 0 ? a.approved_sections / a.total_sections : 0;
        const bp = b.total_sections > 0 ? b.approved_sections / b.total_sections : 0;
        return compareValues(ap, bp, state.direction);
      }
      case 'last_accessed_at':
        return compareValues(dateMs(a.last_accessed_at), dateMs(b.last_accessed_at), state.direction);
      case 'updated_at':
        return compareValues(dateMs(a.updated_at), dateMs(b.updated_at), state.direction);
    }
  };
}
