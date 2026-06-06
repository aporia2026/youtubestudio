'use client';

/**
 * Recent channel-clone jobs list for the standalone /channel-clone
 * landing page. Loads from GET /api/channel-clone/jobs, renders a
 * compact card per job that deep-links to /channel-clone/[id].
 *
 * Per-card summary shows status pill + how far the run got
 * (intake / analysis / topic / hook / script / rows / publish-pack
 * / handoff), so the user can find the right run-to-resume without
 * opening each one.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChannelCloneJobStatus } from '@/lib/channel-clone/types';

const ACTIVE_STATUSES: ChannelCloneJobStatus[] = [
  'intake_pending',
  'intake_running',
  'analyze_running',
  'topics_running',
  'hooks_running',
  'script_running',
  'rowify_running',
  'publish_pack_running',
  'handoff_running',
];

interface JobListItem {
  id: string;
  sourceChannelUrl: string;
  sourceCanonicalUrl: string;
  status: ChannelCloneJobStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  summary: {
    hasIntake: boolean;
    hasAnalysis: boolean;
    topicCount: number;
    hookCount: number;
    approvedScriptWords: number | null;
    auditFinalScore: number | null;
    rowCount: number;
    hasPublishPack: boolean;
    handoffPipelineRunVideoId: string | null;
    sourceChannelName: string | null;
  };
}

export function ChannelCloneJobList() {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchJobs = useCallback(() => {
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    return fetch('/api/channel-clone/jobs')
      .then((r) => r.json())
      .then((data) => {
        setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    void fetchJobs();
  }, [fetchJobs]);

  if (error) {
    return <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>;
  }
  if (jobs === null) {
    return <p className="text-xs text-neutral-500">Loading…</p>;
  }
  if (jobs.length === 0) {
    return <p className="text-xs text-neutral-500">No runs yet. Start one below.</p>;
  }
  return (
    <CollapsibleJobList jobs={jobs} onChanged={() => void fetchJobs()} />
  );
}

/** Top-level collapsible wrapper. Default-CLOSED because the list
 *  grows quickly during iteration on the channel-clone feature
 *  itself and the user asked for it to be tucked away. One click
 *  expands. When expanded, the toolbar adds bulk actions: select-
 *  all, delete-selected, delete-failed, delete-all. */
function CollapsibleJobList({ jobs, onChanged }: { jobs: JobListItem[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState<null | 'selected' | 'failed' | 'all'>(null);

  const failedCount = useMemo(
    () => jobs.filter((j) => j.status.endsWith('_failed') || j.status === 'cancelled').length,
    [jobs],
  );

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = jobs.length > 0 && selected.size === jobs.length;
  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.size === jobs.length ? new Set() : new Set(jobs.map((j) => j.id))));
  }, [jobs]);

  const bulkDelete = useCallback(
    async (mode: 'selected' | 'failed' | 'all') => {
      let body: object;
      let confirmMsg: string;
      if (mode === 'selected') {
        if (selected.size === 0) return;
        body = { ids: [...selected] };
        confirmMsg = `Delete ${selected.size} selected run${selected.size === 1 ? '' : 's'} permanently? This cannot be undone. Active runs whose rows are deleted will stop silently.`;
      } else if (mode === 'failed') {
        if (failedCount === 0) return;
        body = { scope: 'failed' };
        confirmMsg = `Delete all ${failedCount} failed/cancelled run${failedCount === 1 ? '' : 's'} permanently? This cannot be undone.`;
      } else {
        if (jobs.length === 0) return;
        body = { scope: 'all' };
        confirmMsg = `Delete ALL ${jobs.length} runs permanently? This cannot be undone. Active runs will stop silently.`;
      }
      if (!window.confirm(confirmMsg)) return;
      setBulkBusy(mode);
      try {
        const res = await fetch('/api/channel-clone/jobs/bulk-delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data?.error ?? `Bulk delete failed (${res.status})`);
          return;
        }
        setSelected(new Set());
        onChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBulkBusy(null);
      }
    },
    [selected, failedCount, jobs.length, onChanged],
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-300 hover:border-neutral-600 hover:bg-neutral-900"
      >
        <span>
          <span className="text-neutral-400">{open ? '▼' : '▶'}</span>
          <span className="ml-2">{jobs.length} run{jobs.length === 1 ? '' : 's'}</span>
          {failedCount > 0 && (
            <span className="ml-2 text-[10px] text-red-400">({failedCount} failed)</span>
          )}
        </span>
        <span className="text-[10px] text-neutral-500">click to {open ? 'collapse' : 'expand'}</span>
      </button>
      {open && (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-[10px]">
            <label className="flex items-center gap-1.5 text-neutral-300 hover:text-neutral-100">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-3 w-3 cursor-pointer accent-neutral-300"
              />
              <span>select all</span>
            </label>
            <span className="text-neutral-500">·</span>
            <span className="text-neutral-400">
              {selected.size === 0 ? 'none selected' : `${selected.size} selected`}
            </span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void bulkDelete('selected')}
                disabled={selected.size === 0 || bulkBusy !== null}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono uppercase tracking-wide text-neutral-300 hover:border-red-700 hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {bulkBusy === 'selected' ? 'Deleting…' : `✕ Delete selected (${selected.size})`}
              </button>
              <button
                type="button"
                onClick={() => void bulkDelete('failed')}
                disabled={failedCount === 0 || bulkBusy !== null}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono uppercase tracking-wide text-neutral-300 hover:border-red-700 hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {bulkBusy === 'failed' ? 'Deleting…' : `✕ Delete failed (${failedCount})`}
              </button>
              <button
                type="button"
                onClick={() => void bulkDelete('all')}
                disabled={jobs.length === 0 || bulkBusy !== null}
                className="rounded border border-red-900 bg-red-950/40 px-2 py-1 font-mono uppercase tracking-wide text-red-300 hover:border-red-700 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {bulkBusy === 'all' ? 'Deleting…' : `✕ Delete all (${jobs.length})`}
              </button>
            </span>
          </div>
          <ul className="space-y-2">
            {jobs.map((j) => (
              <JobCard
                key={j.id}
                job={j}
                onChanged={onChanged}
                selected={selected.has(j.id)}
                onToggleSelect={() => toggleOne(j.id)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function JobCard({
  job,
  onChanged,
  selected,
  onToggleSelect,
}: {
  job: JobListItem;
  onChanged: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const isActive = ACTIVE_STATUSES.includes(job.status);
  return (
    <li>
      <Link
        href={`/channel-clone/${job.id}`}
        className={`block space-y-2 rounded border p-3 text-xs hover:border-neutral-600 hover:bg-neutral-900 ${
          selected ? 'border-neutral-400 bg-neutral-900' : 'border-neutral-800 bg-neutral-950'
        }`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              aria-label="Select for bulk action"
              className="h-3 w-3 shrink-0 cursor-pointer self-center accent-neutral-300"
            />
            <span className="min-w-0 truncate">
              <span className="font-medium text-neutral-200">{job.summary.sourceChannelName ?? job.sourceChannelUrl}</span>
              <span className="ml-2 truncate text-[10px] text-neutral-500">{job.sourceCanonicalUrl}</span>
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isActive && <CancelButton jobId={job.id} onCancelled={onChanged} />}
            <DeleteButton jobId={job.id} onDeleted={onChanged} />
            <StatusPill status={job.status} />
          </div>
        </div>
        <ProgressDots summary={job.summary} />
        <div className="flex items-baseline justify-between text-[10px] text-neutral-500">
          <span>updated {new Date(job.updatedAt).toLocaleString()}</span>
          {job.summary.handoffPipelineRunVideoId && (
            <span className="font-mono text-emerald-400">handed off</span>
          )}
        </div>
        {job.lastError && (
          <p className="truncate rounded border border-red-900 bg-red-950/40 px-2 py-1 text-[10px] text-red-300" title={job.lastError}>
            {job.lastError}
          </p>
        )}
      </Link>
    </li>
  );
}

/** Cancel control on a recent-runs card. Lives inside the card's
 *  <Link> wrapper, so the click handler must stopPropagation +
 *  preventDefault to keep the cancel from doubling as a navigation
 *  to /channel-clone/[id]. */
function CancelButton({ jobId, onCancelled }: { jobId: string; onCancelled: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (cancelling) return;
      if (!window.confirm('Stop this run? Work done so far will be preserved on the job.')) return;
      setCancelling(true);
      try {
        const res = await fetch(`/api/channel-clone/jobs/${jobId}/cancel`, { method: 'POST' });
        if (!res.ok) {
          // Surface as alert rather than a per-card error state —
          // these cards are dense and an inline string would crowd
          // the layout; the alert text is dismissable.
          const data = await res.json().catch(() => ({}));
          alert(data?.error ?? `Could not cancel (${res.status})`);
          return;
        }
        onCancelled();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setCancelling(false);
      }
    },
    [cancelling, jobId, onCancelled],
  );
  return (
    <button
      type="button"
      onClick={(e) => void handleClick(e)}
      disabled={cancelling}
      title="Stop this run. Work done so far is kept on the job."
      className="rounded border border-red-900 bg-red-950/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-red-300 hover:border-red-700 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {cancelling ? 'Stopping…' : 'Stop'}
    </button>
  );
}

/** Per-run delete control. Wrapped inside the card's <Link>, so the
 *  click handler stops navigation. Confirm dialog so a slip doesn't
 *  destroy a run the user wanted to inspect. After success the
 *  parent re-fetches to drop the card. */
function DeleteButton({ jobId, onDeleted }: { jobId: string; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (deleting) return;
      if (!window.confirm('Delete this run permanently? This cannot be undone.')) return;
      setDeleting(true);
      try {
        const res = await fetch(`/api/channel-clone/jobs/${jobId}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(data?.error ?? `Could not delete (${res.status})`);
          return;
        }
        onDeleted();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setDeleting(false);
      }
    },
    [deleting, jobId, onDeleted],
  );
  return (
    <button
      type="button"
      onClick={(e) => void handleClick(e)}
      disabled={deleting}
      title="Delete this run permanently."
      aria-label="Delete run"
      className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-neutral-400 hover:border-red-700 hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {deleting ? '…' : '✕'}
    </button>
  );
}

function StatusPill({ status }: { status: ChannelCloneJobStatus }) {
  const colour = status.endsWith('_failed')
    ? 'bg-red-900/60 text-red-300 border-red-800'
    : status.endsWith('_complete')
    ? 'bg-emerald-900/60 text-emerald-300 border-emerald-800'
    : status.endsWith('_running') || status === 'intake_pending'
    ? 'bg-amber-900/60 text-amber-300 border-amber-800'
    : 'bg-neutral-800 text-neutral-300 border-neutral-700';
  return (
    <span className={`inline-flex shrink-0 items-center rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${colour}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function ProgressDots({ summary }: { summary: JobListItem['summary'] }) {
  const dots = [
    { label: 'Intake', on: summary.hasIntake },
    { label: 'Analyze', on: summary.hasAnalysis },
    { label: 'Topics', on: summary.topicCount > 0 },
    { label: 'Hooks', on: summary.hookCount > 0 },
    { label: 'Script', on: summary.approvedScriptWords !== null },
    { label: 'Rows', on: summary.rowCount > 0 },
    { label: 'Pack', on: summary.hasPublishPack },
    { label: 'Handoff', on: !!summary.handoffPipelineRunVideoId },
  ];
  return (
    <div className="flex items-center gap-1">
      {dots.map((d, i) => (
        <span
          key={i}
          title={d.label}
          className={`inline-block h-1.5 w-1.5 rounded-full ${d.on ? 'bg-emerald-500' : 'bg-neutral-700'}`}
        />
      ))}
      {summary.auditFinalScore !== null && (
        <span className="ml-2 font-mono text-[10px] text-neutral-500">
          audit {summary.auditFinalScore.toFixed(1)}/10
        </span>
      )}
      {summary.approvedScriptWords !== null && (
        <span className="ml-2 font-mono text-[10px] text-neutral-500">
          {summary.approvedScriptWords}w
        </span>
      )}
    </div>
  );
}
