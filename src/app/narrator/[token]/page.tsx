'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';

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
}

interface NarratorInfo {
  id: string;
  name: string;
  email: string | null;
  color: string;
}

const STATUS_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  assigned:   { label: 'New',          bg: 'rgba(234,179,8,0.15)',  text: '#eab308' },
  received:   { label: 'Received',     bg: 'rgba(6,182,212,0.15)',  text: '#06b6d4' },
  recording:  { label: 'Recording',    bg: 'rgba(124,58,237,0.18)', text: '#a78bfa' },
  submitted:  { label: 'Submitted',    bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  revisions:  { label: 'Revisions',    bg: 'rgba(239,68,68,0.15)',  text: '#ef4444' },
  approved:   { label: 'Approved',     bg: 'rgba(34,197,94,0.15)',  text: '#22c55e' },
  completed:  { label: 'Completed',    bg: 'rgba(34,197,94,0.15)',  text: '#22c55e' },
};

function formatDeadline(d: string | null): { text: string; urgent: boolean } | null {
  if (!d) return null;
  const date = new Date(d);
  const now = new Date();
  const ms = date.getTime() - now.getTime();
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  if (ms < 0) return { text: `Overdue · ${date.toLocaleDateString()}`, urgent: true };
  if (days === 0) return { text: 'Due today', urgent: true };
  if (days === 1) return { text: 'Due tomorrow', urgent: true };
  if (days <= 3) return { text: `Due in ${days} days`, urgent: true };
  return { text: `Due ${date.toLocaleDateString()}`, urgent: false };
}

export default function NarratorDashboard({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [narrator, setNarrator] = useState<NarratorInfo | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (error || !narrator) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Invalid dashboard link</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Ask the project owner to send you a fresh link.</p>
        </div>
      </div>
    );
  }

  const active = assignments.filter(a => a.status !== 'completed' && a.status !== 'approved');
  const done = assignments.filter(a => a.status === 'completed' || a.status === 'approved');
  const needsAction = active.filter(a => a.status === 'revisions' || a.status === 'assigned' || a.retake_sections > 0);

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white" style={{ background: narrator.color }}>
            {(narrator.name || '?')[0].toUpperCase()}
          </div>
          <div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Welcome back,</p>
            <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{narrator.name}</h1>
          </div>
        </div>
      </header>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Active" value={active.length} accent="#a78bfa" />
        <Stat label="Needs your attention" value={needsAction.length} accent={needsAction.length > 0 ? '#ef4444' : 'var(--text-muted)'} />
        <Stat label="Completed" value={done.length} accent="#22c55e" />
      </div>

      {/* Active assignments */}
      <section className="mb-8">
        <h2 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
          Active queue
        </h2>
        {active.length === 0 ? (
          <div className="text-center py-12 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No active assignments. Nice work.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {active.map(a => <AssignmentCard key={a.id} a={a} />)}
          </div>
        )}
      </section>

      {/* Completed */}
      {done.length > 0 && (
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
            Completed ({done.length})
          </h2>
          <div className="space-y-2">
            {done.map(a => <AssignmentCard key={a.id} a={a} compact />)}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <p className="text-2xl font-bold leading-none mb-1" style={{ color: accent }}>{value}</p>
      <p className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</p>
    </div>
  );
}

function AssignmentCard({ a, compact }: { a: Assignment; compact?: boolean }) {
  const status = STATUS_STYLES[a.status] || STATUS_STYLES.assigned;
  const deadline = formatDeadline(a.deadline);
  const progress = a.total_sections > 0 ? Math.round((a.approved_sections / a.total_sections) * 100) : 0;
  const needsAttention = a.status === 'revisions' || a.retake_sections > 0 || a.unread_owner_comments > 0;

  return (
    <Link href={`/narrate/${a.share_token}`} className="block">
      <div
        className="rounded-xl p-4 transition-all hover:translate-y-[-1px]"
        style={{
          background: 'var(--bg-secondary)',
          border: needsAttention ? '1px solid rgba(239,68,68,0.3)' : '1px solid var(--border)',
          opacity: compact ? 0.7 : 1,
        }}
      >
        <div className="flex items-center justify-between mb-2 gap-2">
          <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {a.project_title || 'Untitled project'}
          </h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0"
            style={{ background: status.bg, color: status.text }}>
            {status.label}
          </span>
        </div>

        {!compact && (
          <>
            {/* Progress bar */}
            <div className="flex items-center gap-2 mb-2">
              <div className="flex-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #22c55e)' }} />
              </div>
              <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                {a.approved_sections}/{a.total_sections} approved
              </span>
            </div>

            <div className="flex items-center gap-3 flex-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {a.retake_sections > 0 && (
                <span style={{ color: '#ef4444' }}>● {a.retake_sections} retake{a.retake_sections === 1 ? '' : 's'} requested</span>
              )}
              {a.submitted_sections > 0 && (
                <span style={{ color: '#3b82f6' }}>● {a.submitted_sections} pending review</span>
              )}
              {a.pending_sections > 0 && (
                <span>○ {a.pending_sections} not started</span>
              )}
              {a.unread_owner_comments > 0 && (
                <span style={{ color: '#a78bfa' }}>💬 {a.unread_owner_comments} new comment{a.unread_owner_comments === 1 ? '' : 's'}</span>
              )}
              {deadline && (
                <span style={{ color: deadline.urgent ? '#ef4444' : 'var(--text-muted)', marginLeft: 'auto' }}>
                  {deadline.text}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </Link>
  );
}
