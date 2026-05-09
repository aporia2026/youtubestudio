'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  type SurfaceDescriptor,
  type RosterEntry,
} from '@/lib/team-hub-types';
import type { NarratorTaskRow } from '@/lib/team-hub-tasks-db';

/**
 * Narrator command center on the Tasks tab. Lists every assignment for
 * the selected narrator (any status) and offers per-row inline edits +
 * action shortcuts.
 *
 * Mounted only when the selected entry has the 'narrator' role. The
 * orchestrator picks the right tab template based on entry.roles.
 *
 * The lightweight actions (status, deadline) write through the existing
 * /api/narrator/assignments/[id] PUT handler — no new endpoint needed.
 * Heavy actions (Open script, Open take comments, Quick chat) emit a
 * SurfaceDescriptor or hand off to a navigation handler so the parent
 * page owns where the right pane points.
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

interface NarratorTasksTabProps {
  /** Narrator collaborator. */
  entry: RosterEntry;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

export function NarratorTasksTab({ entry, onOpenSurface }: NarratorTasksTabProps) {
  const [tasks, setTasks] = useState<NarratorTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
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

  // Inline mutators — optimistic update + rollback on failure.
  const patchAssignment = useCallback(
    async (id: string, fields: Partial<Pick<NarratorTaskRow, 'status' | 'deadline'>>) => {
      const before = tasks;
      setTasks(tasks.map((t) => (t.id === id ? { ...t, ...fields } : t)));
      try {
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
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Assign {entry.name} to a project from the project page.
        </p>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-3">
      {tasks.map((task) => (
        <NarratorTaskRow
          key={task.id}
          task={task}
          narratorId={entry.id}
          onChangeStatus={(s) => patchAssignment(task.id, { status: s })}
          onChangeDeadline={(d) => patchAssignment(task.id, { deadline: d })}
          onOpenSurface={onOpenSurface}
        />
      ))}
    </div>
  );
}

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
      {/* Top row: project + status + deadline */}
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
            <span>{task.approved_sections}/{task.total_sections} approved</span>
            <span>·</span>
            <span>Last accessed {timeAgo(task.last_accessed_at)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Status select. Renders styled like a chip but is a real select for keyboard a11y. */}
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

          {/* Deadline pill, click to edit. */}
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
              title="Click to edit deadline"
            >
              {dl.text}
            </button>
          )}
        </div>
      </div>

      {/* Action strip */}
      <div className="flex items-center gap-2 flex-wrap">
        <ActionButton
          label="Open script"
          onClick={() =>
            // Project page hosts the script editor. Surface kind 'script'
            // mounts that page in an iframe (commit 9 wires the iframe).
            onOpenSurface({ kind: 'script', id: task.project_id })
          }
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
