'use client';

/**
 * Minimal channel-clone UI panel (M1).
 *
 * Three sections:
 *   1. Intake form — URL paste + sample-count + frame-interval.
 *      Submits to POST /api/channel-clone/intake, receives a jobId,
 *      and starts polling.
 *   2. Live status — polls GET /api/channel-clone/jobs/[id] every
 *      few seconds while the job's status is *_running. Surfaces
 *      the last_error if the runner failed.
 *   3. Analysis trigger — appears once status is `intake_complete`.
 *      POSTs to /api/channel-clone/analyze and renders the parsed
 *      analysis JSON.
 *
 * Deliberately minimal in v1 — paint, polish, and tighter layout
 * land in M5. The point now is to exercise the full intake →
 * analyze loop end-to-end so we can validate the V2.0 prompts on
 * real channels.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelCloneAnalysis, ChannelCloneJobState, ChannelCloneJobStatus } from '@/lib/channel-clone/types';

interface JobView {
  id: string;
  sourceChannelUrl: string;
  sourceCanonicalUrl: string;
  status: ChannelCloneJobStatus;
  state: ChannelCloneJobState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

const ACTIVE_STATUSES: ChannelCloneJobStatus[] = [
  'intake_pending',
  'intake_running',
  'analyze_running',
  'topics_running',
  'hooks_running',
  'script_running',
  'rowify_running',
  'publish_pack_running',
];

const POLL_INTERVAL_MS = 4000;

export function ChannelClonePanel() {
  const [url, setUrl] = useState('');
  const [sampleVideoCount, setSampleVideoCount] = useState<3 | 5 | 8>(5);
  const [frameIntervalSec, setFrameIntervalSec] = useState<5 | 10 | 15>(10);
  const [job, setJob] = useState<JobView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const pollHandle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollHandle.current) {
      clearTimeout(pollHandle.current);
      pollHandle.current = null;
    }
  }, []);

  const pollOnce = useCallback(async (jobId: string) => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch(`/api/channel-clone/jobs/${jobId}`);
      if (!res.ok) {
        console.warn('[channel-clone poll] non-OK', { status: res.status });
        return;
      }
      const data = (await res.json()) as JobView;
      setJob(data);
      if (ACTIVE_STATUSES.includes(data.status)) {
        pollHandle.current = setTimeout(() => { void pollOnce(jobId); }, POLL_INTERVAL_MS);
      } else {
        stopPolling();
      }
    } catch (err) {
      console.error('[channel-clone poll] error', err);
      // back off but keep trying
      pollHandle.current = setTimeout(() => { void pollOnce(jobId); }, POLL_INTERVAL_MS * 2);
    }
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setJob(null);
    stopPolling();
    console.info('[channel-clone ui intake-submit]', { url, sampleVideoCount, frameIntervalSec });
    try {
      const res = await fetch('/api/channel-clone/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, sampleVideoCount, frameIntervalSec }),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) {
        setSubmitError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      console.info('[channel-clone ui intake-accepted]', { jobId: data.jobId });
      void pollOnce(data.jobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [url, sampleVideoCount, frameIntervalSec, pollOnce, stopPolling]);

  const handleAnalyze = useCallback(async () => {
    if (!job) return;
    setAnalyzing(true);
    console.info('[channel-clone ui analyze-submit]', { jobId: job.id });
    try {
      const res = await fetch('/api/channel-clone/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.warn('[channel-clone ui analyze-failed]', { status: res.status, error: data?.error });
      } else {
        console.info('[channel-clone ui analyze-done]', { status: data?.status });
      }
      void pollOnce(job.id);
    } catch (err) {
      console.error('[channel-clone ui analyze-error]', err);
    } finally {
      setAnalyzing(false);
    }
  }, [job, pollOnce]);

  return (
    <div className="space-y-6 rounded-lg border border-neutral-800 bg-neutral-950/40 p-5 text-sm">
      <header>
        <h2 className="text-base font-medium text-neutral-100">Clone a channel</h2>
        <p className="mt-1 text-xs text-neutral-400">
          Paste a YouTube channel URL (or any video from that channel). Pipeline downloads sample videos, extracts frames + transcripts, and analyzes the channel's style DNA + audience profile.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block">
          <span className="text-xs text-neutral-400">YouTube channel or video URL</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/@Zenn"
            required
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 placeholder-neutral-500 focus:border-neutral-500 focus:outline-none"
            disabled={submitting || (!!job && ACTIVE_STATUSES.includes(job.status))}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-neutral-400">Sample videos</span>
            <select
              value={sampleVideoCount}
              onChange={(e) => setSampleVideoCount(Number(e.target.value) as 3 | 5 | 8)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
              disabled={submitting}
            >
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={8}>8</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-neutral-400">Frame interval (sec)</span>
            <select
              value={frameIntervalSec}
              onChange={(e) => setFrameIntervalSec(Number(e.target.value) as 5 | 10 | 15)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
              disabled={submitting}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={15}>15</option>
            </select>
          </label>
        </div>
        <button
          type="submit"
          disabled={submitting || !url.trim()}
          className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
        >
          {submitting ? 'Starting intake…' : 'Start intake'}
        </button>
        {submitError && <p className="text-xs text-red-400">{submitError}</p>}
      </form>

      {job && (
        <section className="space-y-3 border-t border-neutral-800 pt-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Job</h3>
            <span className="font-mono text-[10px] text-neutral-500">{job.id}</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status={job.status} />
            <span className="text-xs text-neutral-400">updated {new Date(job.updatedAt).toLocaleTimeString()}</span>
          </div>
          {job.lastError && (
            <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{job.lastError}</p>
          )}
          {job.state.intake && (
            <div className="space-y-1 text-xs text-neutral-300">
              <p>
                <span className="text-neutral-400">Channel:</span>{' '}
                <a href={job.state.intake.sourceChannelUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                  {job.state.intake.sourceChannelName ?? job.state.intake.sourceChannelHandle ?? job.state.intake.sourceChannelUrl}
                </a>
              </p>
              <p>
                <span className="text-neutral-400">Sample videos:</span>{' '}
                {job.state.intake.sampleVideos.length} — transcripts:{' '}
                {job.state.intake.sampleVideos.filter((v) => v.transcript).length} — frames total:{' '}
                {job.state.intake.sampleVideos.reduce((a, v) => a + v.frameLocalPaths.length, 0)}
              </p>
            </div>
          )}
          {job.status === 'intake_complete' && !job.state.analysis && (
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={analyzing}
              className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
            >
              {analyzing ? 'Analyzing channel…' : 'Run channel analysis'}
            </button>
          )}
          {job.state.analysis && <AnalysisView analysis={job.state.analysis} />}
        </section>
      )}
    </div>
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
    <span className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${colour}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function AnalysisView({ analysis }: { analysis: ChannelCloneAnalysis }) {
  return (
    <div className="space-y-2 rounded border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-300">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span><span className="text-neutral-500">Niche:</span> {analysis.niche}</span>
        <span><span className="text-neutral-500">Sub-niche:</span> {analysis.subNiche}</span>
        <span><span className="text-neutral-500">Format:</span> {analysis.contentFormat}</span>
        <span><span className="text-neutral-500">WPS:</span> {analysis.wpsEstimate.toFixed(2)}</span>
        <span><span className="text-neutral-500">Avg words:</span> {analysis.avgVideoWordCount}</span>
      </div>
      <p><span className="text-neutral-500">Hook architecture:</span> {analysis.hookArchitecture}</p>
      <p><span className="text-neutral-500">Identity promise:</span> {analysis.audiencePsychology.identityPromise}</p>
      <p><span className="text-neutral-500">Channel's enemy:</span> {analysis.audiencePsychology.channelsEnemy}</p>
      <details className="pt-2">
        <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">Full style DNA + signature phrases</summary>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-2 text-[10px] text-neutral-300">
          {JSON.stringify(analysis, null, 2)}
        </pre>
      </details>
    </div>
  );
}
