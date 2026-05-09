'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  type SurfaceDescriptor,
  type RosterEntry,
} from '@/lib/team-hub-types';
import type { ReviewerTaskRow } from '@/lib/team-hub-tasks-db';

/**
 * Reviewer / client command center on the Tasks tab. Shows every
 * review_share_link granted to the collaborator, scoped to the
 * workspace.
 *
 * Lighter than the narrator / editor tabs: reviewers are passive
 * participants, so the inline edits the owner cares about are revoke +
 * permission level. The action shortcuts are:
 *
 *   - Open review session (read-only) → right pane mounts <ReviewPage … />
 *   - Quick chat                        → /messages?with=<reviewer_id>
 *   - Copy review link                  → puts the share URL on clipboard
 */

const PERM_OPTIONS = ['view-only', 'can-comment', 'can-annotate'] as const;
type Perm = (typeof PERM_OPTIONS)[number];

const PERM_COLOR: Record<Perm, { bg: string; text: string }> = {
  'view-only':    { bg: 'rgba(255,255,255,0.05)', text: 'var(--text-muted)' },
  'can-comment':  { bg: 'rgba(6,182,212,0.18)',   text: '#67e8f9' },
  'can-annotate': { bg: 'rgba(124,58,237,0.18)',  text: '#a78bfa' },
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

interface ReviewerTasksTabProps {
  entry: RosterEntry;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

export function ReviewerTasksTab({ entry, onOpenSurface }: ReviewerTasksTabProps) {
  const [tasks, setTasks] = useState<ReviewerTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
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
    <div className="px-6 py-5 space-y-3">
      {tasks.map((task) => (
        <ReviewerTaskCard
          key={task.id}
          task={task}
          reviewerId={entry.id}
          onOpenSurface={onOpenSurface}
        />
      ))}
    </div>
  );
}

interface CardProps {
  task: ReviewerTaskRow;
  reviewerId: string;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

function ReviewerTaskCard({ task, reviewerId, onOpenSurface }: CardProps) {
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
            <span>{task.access_count} visit{task.access_count === 1 ? '' : 's'}</span>
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
