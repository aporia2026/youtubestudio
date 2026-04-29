'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';

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
  assigned:  { label: 'New',          bg: 'rgba(234,179,8,0.15)',  text: '#eab308' },
  editing:   { label: 'In progress',  bg: 'rgba(124,58,237,0.18)', text: '#a78bfa' },
  submitted: { label: 'Submitted',    bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  approved:  { label: 'Approved',     bg: 'rgba(34,197,94,0.15)',  text: '#22c55e' },
  completed: { label: 'Completed',    bg: 'rgba(34,197,94,0.15)',  text: '#22c55e' },
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

export default function EditorDashboard({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [editor, setEditor] = useState<EditorInfo | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [reviewOnly, setReviewOnly] = useState<ReviewOnlyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (error || !editor) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-xl font-bold mb-2">Invalid dashboard link</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Ask the project owner to send you a fresh link.</p>
        </div>
      </div>
    );
  }

  const active = assignments.filter(a => a.status !== 'completed' && a.status !== 'approved');
  const done = assignments.filter(a => a.status === 'completed' || a.status === 'approved');

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white" style={{ background: editor.color }}>
            {(editor.name || '?')[0].toUpperCase()}
          </div>
          <div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Welcome back,</p>
            <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{editor.name}</h1>
          </div>
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          Click any project to view the script, references, thumbnails, and upload the finished video.
        </p>
      </header>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Active" value={active.length} accent="#a78bfa" />
        <Stat label="Submitted" value={assignments.filter(a => a.status === 'submitted').length} accent="#3b82f6" />
        <Stat label="Completed" value={done.length} accent="#22c55e" />
      </div>

      <section className="mb-8">
        <h2 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
          Active queue
        </h2>
        {active.length === 0 ? (
          <div className="text-center py-12 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No active projects assigned.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {active.map(a => <AssignmentCard key={a.id} a={a} token={token} />)}
          </div>
        )}
      </section>

      {reviewOnly.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
            Review access only
          </h2>
          <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
            These projects gave you a review link but weren&apos;t formally assigned to you as an editor — so the script and references aren&apos;t available here. You can still watch + comment.
          </p>
          <div className="space-y-2">
            {reviewOnly.map(r => (
              <a
                key={r.link_id}
                href={`/review/${r.share_token}`}
                target="_blank"
                rel="noreferrer"
                className="block rounded-xl p-4 transition-all hover:translate-y-[-1px]"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {r.project_title}
                  </h3>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}>
                    Review only · {r.permission}
                  </span>
                </div>
                {r.label && <p className="text-[11px] italic mt-1" style={{ color: 'var(--text-muted)' }}>{r.label}</p>}
              </a>
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
            Completed ({done.length})
          </h2>
          <div className="space-y-2">
            {done.map(a => <AssignmentCard key={a.id} a={a} token={token} compact />)}
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

function AssignmentCard({ a, token, compact }: { a: Assignment; token: string; compact?: boolean }) {
  const status = STATUS_STYLES[a.status] || STATUS_STYLES.assigned;
  const deadline = formatDeadline(a.deadline);

  return (
    <Link href={`/editor/${token}/${a.project_id}`} className="block">
      <div
        className="rounded-xl p-4 transition-all hover:translate-y-[-1px]"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          opacity: compact ? 0.7 : 1,
        }}
      >
        <div className="flex items-center justify-between mb-2 gap-2">
          <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {a.project_title}
          </h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: status.bg, color: status.text }}>
            {status.label}
          </span>
        </div>

        {!compact && (
          <>
            <div className="flex items-center gap-3 flex-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {a.image_ref_count > 0 && <span>🖼️ {a.image_ref_count} ref{a.image_ref_count === 1 ? '' : 's'}</span>}
              {a.voiceover_count > 0 && <span>🎙️ Voiceover ready</span>}
              {a.youtube_ref_count > 0 && <span>📺 {a.youtube_ref_count} YouTube ref{a.youtube_ref_count === 1 ? '' : 's'}</span>}
              {a.uploaded_version_count > 0 && (
                <span style={{ color: '#22c55e' }}>📤 {a.uploaded_version_count} version{a.uploaded_version_count === 1 ? '' : 's'} uploaded</span>
              )}
              {deadline && (
                <span style={{ color: deadline.urgent ? '#ef4444' : 'var(--text-muted)', marginLeft: 'auto' }}>
                  {deadline.text}
                </span>
              )}
            </div>

            {a.editor_notes && (
              <p className="text-xs mt-2 italic line-clamp-2" style={{ color: '#06b6d4' }}>
                {a.editor_notes}
              </p>
            )}
          </>
        )}
      </div>
    </Link>
  );
}
