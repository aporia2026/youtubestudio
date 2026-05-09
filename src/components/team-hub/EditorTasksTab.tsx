'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  type SurfaceDescriptor,
  type RosterEntry,
} from '@/lib/team-hub-types';
import type { EditorTaskRow } from '@/lib/team-hub-tasks-db';

/**
 * Editor command center on the Tasks tab. Lists every editor_assignment
 * for the selected editor with inline status / deadline edits and the
 * action shortcuts that matter for editing work:
 *
 *   - Open editor workspace → right pane mounts <EditorTab projectId={...} />
 *   - Open review session   → right pane mounts <ReviewPage ownerProjectId={...} />
 *   - Quick chat            → /messages?with=<editor_id>
 *
 * Lightweight inline edits write through PATCH /api/team-hub/editor-assignment/[id],
 * which is the workspace-scoped counterpart to the legacy unauthed PATCH on
 * /api/projects/[id]/editors/[assignmentId].
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

function timeAgo(s: string | null): string {
  if (!s) return 'never';
  const diff = Date.now() - new Date(s).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function deadlineHint(deadline: string | null): { text: string; tone: 'normal' | 'soon' | 'overdue' } {
  if (!deadline) return { text: 'No deadline', tone: 'normal' };
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms < 0) {
    const d = Math.floor(-ms / (24 * 60 * 60 * 1000));
    return { text: d === 0 ? 'Overdue today' : `Overdue ${d}d`, tone: 'overdue' };
  }
  const d = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (d <= 2) return { text: d === 0 ? 'Due today' : `Due in ${d}d`, tone: 'soon' };
  return { text: `Due in ${d}d`, tone: 'normal' };
}

interface EditorTasksTabProps {
  entry: RosterEntry;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

export function EditorTasksTab({ entry, onOpenSurface }: EditorTasksTabProps) {
  const [tasks, setTasks] = useState<EditorTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    <div className="px-6 py-5 space-y-3">
      {tasks.map((task) => (
        <EditorTaskCard
          key={task.id}
          task={task}
          editorId={entry.id}
          onChangeStatus={(s) => patchAssignment(task.id, { status: s })}
          onChangeDeadline={(d) => patchAssignment(task.id, { deadline: d })}
          onOpenSurface={onOpenSurface}
        />
      ))}
    </div>
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
            <span>{task.uploaded_version_count} version{task.uploaded_version_count === 1 ? '' : 's'} uploaded</span>
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
                background: dl.tone === 'overdue' ? 'rgba(239,68,68,0.15)' : dl.tone === 'soon' ? 'rgba(249,115,22,0.15)' : 'rgba(255,255,255,0.04)',
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
