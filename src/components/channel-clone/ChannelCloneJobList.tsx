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
import { useEffect, useState } from 'react';
import type { ChannelCloneJobStatus } from '@/lib/channel-clone/types';

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

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch('/api/channel-clone/jobs')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

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
    <ul className="space-y-2">
      {jobs.map((j) => <JobCard key={j.id} job={j} />)}
    </ul>
  );
}

function JobCard({ job }: { job: JobListItem }) {
  return (
    <li>
      <Link
        href={`/channel-clone/${job.id}`}
        className="block space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3 text-xs hover:border-neutral-600 hover:bg-neutral-900"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 truncate">
            <span className="font-medium text-neutral-200">{job.summary.sourceChannelName ?? job.sourceChannelUrl}</span>
            <span className="ml-2 truncate text-[10px] text-neutral-500">{job.sourceCanonicalUrl}</span>
          </div>
          <StatusPill status={job.status} />
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
