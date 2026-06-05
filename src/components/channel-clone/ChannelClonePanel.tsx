'use client';

/**
 * Channel-clone UI panel (M2).
 *
 * Six sections, each surfaced when its prerequisite state is ready:
 *   1. Intake form — URL paste + sample-count + frame-interval.
 *   2. Live job status — polls GET /jobs/[id] every few seconds.
 *   3. Analysis trigger + results — text DNA + visual profile.
 *   4. Topics — pick how many; render the list as a radio picker.
 *   5. Hooks — picks a topic, generates the 5 archetypes, radio picker.
 *   6. Script + audit history — picks a hook + threshold + iterations,
 *      runs the fix-loop, shows score-per-iteration plus the final
 *      approved script.
 *
 * Still deliberately raw on layout polish — that lands in M5. The
 * goal here is to exercise the full intake → analyze → topic → hook
 * → script + audit-fix loop end-to-end against real channels.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChannelCloneAnalysis,
  ChannelCloneJobState,
  ChannelCloneJobStatus,
  ChannelCloneVisualProfile,
} from '@/lib/channel-clone/types';
import { CHANNEL_CLONE_CANDIDATE_PRESETS } from '@/lib/channel-clone/match-style-preset';

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
  const [topicCount, setTopicCount] = useState<5 | 10 | 15>(10);
  const [chosenTopicIndex, setChosenTopicIndex] = useState<number | null>(null);
  const [chosenHookIndex, setChosenHookIndex] = useState<number | null>(null);
  const [threshold, setThreshold] = useState<80 | 90 | 95 | 100>(90);
  const [maxIterations, setMaxIterations] = useState<1 | 3 | 5>(3);
  const [stylePresetIdHint, setStylePresetIdHint] = useState<string>('auto');
  const [job, setJob] = useState<JobView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'analyze' | 'topics' | 'hooks' | 'script' | 'rowify'>(null);
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
      pollHandle.current = setTimeout(() => { void pollOnce(jobId); }, POLL_INTERVAL_MS * 2);
    }
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setJob(null);
    setChosenTopicIndex(null);
    setChosenHookIndex(null);
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

  const runStage = useCallback(
    async (
      stage: 'analyze' | 'topics' | 'hooks' | 'script' | 'rowify',
      body: Record<string, unknown>,
    ) => {
      if (!job) return;
      setBusy(stage);
      console.info(`[channel-clone ui ${stage}-submit]`, { jobId: job.id, ...body });
      try {
        const res = await fetch(`/api/channel-clone/${stage}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: job.id, ...body }),
        });
        const data = await res.json();
        if (!res.ok) {
          console.warn(`[channel-clone ui ${stage}-failed]`, { status: res.status, error: data?.error });
        } else {
          console.info(`[channel-clone ui ${stage}-done]`, { status: data?.status });
        }
        void pollOnce(job.id);
      } catch (err) {
        console.error(`[channel-clone ui ${stage}-error]`, err);
      } finally {
        setBusy(null);
      }
    },
    [job, pollOnce],
  );

  const state = job?.state;
  const hasIntake = !!state?.intake;
  const hasAnalysis = !!state?.analysis;
  const hasTopics = !!state?.topics && state.topics.length > 0;
  const hasHooks = !!state?.hooks && state.hooks.length > 0;
  const hasApprovedScript = !!state?.approvedScript;
  const hasRows = !!state?.productionRows && state.productionRows.length > 0;

  return (
    <div className="space-y-6 rounded-lg border border-neutral-800 bg-neutral-950/40 p-5 text-sm">
      <header>
        <h2 className="text-base font-medium text-neutral-100">Clone a channel</h2>
        <p className="mt-1 text-xs text-neutral-400">
          Paste a YouTube channel URL (or any video from it). The pipeline analyzes its style DNA, generates topic ideas, engineers hooks, and runs the script through an audit-fix loop until the score clears your threshold.
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
            disabled={submitting || !!(job && ACTIVE_STATUSES.includes(job.status))}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Picker label="Sample videos" value={sampleVideoCount} onChange={(n) => setSampleVideoCount(n as 3 | 5 | 8)} options={[3, 5, 8]} disabled={submitting} />
          <Picker label="Frame interval (sec)" value={frameIntervalSec} onChange={(n) => setFrameIntervalSec(n as 5 | 10 | 15)} options={[5, 10, 15]} disabled={submitting} />
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
          {hasIntake && state?.intake && (
            <div className="space-y-1 text-xs text-neutral-300">
              <p>
                <span className="text-neutral-400">Channel:</span>{' '}
                <a href={state.intake.sourceChannelUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                  {state.intake.sourceChannelName ?? state.intake.sourceChannelHandle ?? state.intake.sourceChannelUrl}
                </a>
              </p>
              <p>
                <span className="text-neutral-400">Sample videos:</span>{' '}
                {state.intake.sampleVideos.length} — transcripts:{' '}
                {state.intake.sampleVideos.filter((v) => v.transcript).length} — frames total:{' '}
                {state.intake.sampleVideos.reduce((a, v) => a + v.frameLocalPaths.length, 0)}
              </p>
            </div>
          )}

          {/* ── Stage 1: Analyze ───────────────────────────────── */}
          {hasIntake && !hasAnalysis && (
            <button
              type="button"
              onClick={() => runStage('analyze', {})}
              disabled={busy === 'analyze'}
              className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
            >
              {busy === 'analyze' ? 'Analyzing channel…' : 'Run channel analysis'}
            </button>
          )}
          {hasAnalysis && state?.analysis && (
            <AnalysisView analysis={state.analysis} visualProfile={state.visualProfile} />
          )}

          {/* ── Stage 2: Topics ────────────────────────────────── */}
          {hasAnalysis && !hasTopics && (
            <div className="space-y-2 border-t border-neutral-800 pt-3">
              <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Topics</h4>
              <Picker label="How many ideas?" value={topicCount} onChange={(n) => setTopicCount(n as 5 | 10 | 15)} options={[5, 10, 15]} />
              <button
                type="button"
                onClick={() => runStage('topics', { topicCount })}
                disabled={busy === 'topics'}
                className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
              >
                {busy === 'topics' ? 'Generating topics…' : `Generate ${topicCount} topic ideas`}
              </button>
            </div>
          )}
          {hasTopics && state?.topics && (
            <TopicPicker
              topics={state.topics}
              chosenIndex={chosenTopicIndex ?? state.selectedTopicIndex ?? null}
              setChosenIndex={setChosenTopicIndex}
              onConfirm={() => {
                const idx = chosenTopicIndex ?? state.selectedTopicIndex;
                if (idx) void runStage('hooks', { selectedTopicIndex: idx });
              }}
              busy={busy === 'hooks'}
              disabled={hasHooks}
            />
          )}

          {/* ── Stage 3: Hooks ─────────────────────────────────── */}
          {hasHooks && state?.hooks && (
            <HookPicker
              hooks={state.hooks}
              chosenIndex={chosenHookIndex ?? state.selectedHookIndex ?? null}
              setChosenIndex={setChosenHookIndex}
              threshold={threshold}
              setThreshold={setThreshold}
              maxIterations={maxIterations}
              setMaxIterations={setMaxIterations}
              onConfirm={() => {
                const idx = chosenHookIndex ?? state.selectedHookIndex;
                if (idx) void runStage('script', { selectedHookIndex: idx, threshold, maxIterations });
              }}
              busy={busy === 'script'}
              disabled={hasApprovedScript}
            />
          )}

          {/* ── Stage 4: Script + audit history ────────────────── */}
          {state?.auditHistory && state.auditHistory.length > 0 && (
            <AuditHistoryView auditHistory={state.auditHistory} threshold={threshold} />
          )}
          {state?.approvedScript && (
            <ApprovedScriptView approvedScript={state.approvedScript} />
          )}

          {/* ── Stage 5: Rowify ─────────────────────────────────── */}
          {hasApprovedScript && !hasRows && (
            <div className="space-y-2 border-t border-neutral-800 pt-3">
              <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Production rows</h4>
              <p className="text-xs text-neutral-500">
                Convert the approved script into scene-by-scene image prompts matched to a style preset. The output drops into the existing image-gen pipeline as-is.
              </p>
              <label className="block">
                <span className="text-xs text-neutral-400">Style preset</span>
                <select
                  value={stylePresetIdHint}
                  onChange={(e) => setStylePresetIdHint(e.target.value)}
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
                  disabled={busy === 'rowify'}
                >
                  <option value="auto">Auto-match from visual profile</option>
                  {CHANNEL_CLONE_CANDIDATE_PRESETS.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => runStage('rowify', stylePresetIdHint === 'auto' ? {} : { stylePresetId: stylePresetIdHint })}
                disabled={busy === 'rowify'}
                className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
              >
                {busy === 'rowify' ? 'Generating production rows…' : 'Generate production rows'}
              </button>
            </div>
          )}
          {hasRows && state?.productionRows && (
            <RowifyView
              rows={state.productionRows}
              presetId={state.chosenStylePresetId ?? 'unknown'}
            />
          )}
        </section>
      )}
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────

function Picker({ label, value, onChange, options, disabled }: { label: string; value: number; onChange: (n: number) => void; options: number[]; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
        disabled={disabled}
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
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

function AnalysisView({ analysis, visualProfile }: { analysis: ChannelCloneAnalysis; visualProfile?: ChannelCloneVisualProfile }) {
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
      <p><span className="text-neutral-500">Channel&rsquo;s enemy:</span> {analysis.audiencePsychology.channelsEnemy}</p>
      {visualProfile && (
        <div className="mt-2 space-y-1 border-t border-neutral-800 pt-2">
          <p><span className="text-neutral-500">Art style:</span> {visualProfile.artStyle}</p>
          <p><span className="text-neutral-500">Mood:</span> {visualProfile.mood}</p>
          <p>
            <span className="text-neutral-500">Palette:</span>{' '}
            <span className="inline-flex items-center gap-1 align-middle">
              {visualProfile.paletteHex.map((hex) => (
                <span key={hex} className="inline-block h-3 w-3 rounded-sm border border-neutral-700" style={{ backgroundColor: hex }} title={hex} />
              ))}
              <span className="ml-1 font-mono text-[10px] text-neutral-500">{visualProfile.paletteHex.join(' · ')}</span>
            </span>
          </p>
        </div>
      )}
      <details className="pt-2">
        <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">Full style DNA + signature phrases</summary>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-2 text-[10px] text-neutral-300">
          {JSON.stringify({ analysis, visualProfile }, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function TopicPicker({
  topics, chosenIndex, setChosenIndex, onConfirm, busy, disabled,
}: {
  topics: NonNullable<ChannelCloneJobState['topics']>;
  chosenIndex: number | null;
  setChosenIndex: (n: number) => void;
  onConfirm: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Topics — pick one</h4>
      <ul className="space-y-1">
        {topics.map((t, i) => {
          const idx = i + 1;
          const checked = chosenIndex === idx;
          return (
            <li key={idx}>
              <label className={`flex cursor-pointer items-start gap-2 rounded border px-3 py-2 text-xs ${checked ? 'border-neutral-500 bg-neutral-900' : 'border-neutral-800 bg-neutral-950 hover:border-neutral-600'}`}>
                <input
                  type="radio"
                  name="topic"
                  className="mt-0.5"
                  checked={checked}
                  onChange={() => setChosenIndex(idx)}
                  disabled={disabled}
                />
                <div className="space-y-0.5">
                  <p className="font-medium text-neutral-200">{idx}. {t.title}</p>
                  <p className="text-neutral-400">{t.angle}</p>
                  <p className="text-neutral-500 italic">Hook seed: {t.hook}</p>
                  <p className="text-[10px] text-neutral-500">Difficulty: {t.difficulty}/10</p>
                </div>
              </label>
            </li>
          );
        })}
      </ul>
      {!disabled && (
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || !chosenIndex}
          className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
        >
          {busy ? 'Engineering 5 hooks…' : 'Engineer hooks for this topic'}
        </button>
      )}
    </div>
  );
}

function HookPicker({
  hooks, chosenIndex, setChosenIndex, threshold, setThreshold, maxIterations, setMaxIterations, onConfirm, busy, disabled,
}: {
  hooks: NonNullable<ChannelCloneJobState['hooks']>;
  chosenIndex: number | null;
  setChosenIndex: (n: number) => void;
  threshold: 80 | 90 | 95 | 100;
  setThreshold: (n: 80 | 90 | 95 | 100) => void;
  maxIterations: 1 | 3 | 5;
  setMaxIterations: (n: 1 | 3 | 5) => void;
  onConfirm: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Hooks — pick one</h4>
      <ul className="space-y-1">
        {hooks.map((h, i) => {
          const idx = i + 1;
          const checked = chosenIndex === idx;
          return (
            <li key={idx}>
              <label className={`flex cursor-pointer items-start gap-2 rounded border px-3 py-2 text-xs ${checked ? 'border-neutral-500 bg-neutral-900' : 'border-neutral-800 bg-neutral-950 hover:border-neutral-600'}`}>
                <input
                  type="radio"
                  name="hook"
                  className="mt-0.5"
                  checked={checked}
                  onChange={() => setChosenIndex(idx)}
                  disabled={disabled}
                />
                <div className="space-y-0.5">
                  <p className="font-medium text-neutral-200">{h.archetype}</p>
                  <p className="text-neutral-300">{h.text}</p>
                  <p className="text-[10px] text-neutral-500">{h.wordCount} words · ~{h.estimatedDurationSec.toFixed(1)}s</p>
                </div>
              </label>
            </li>
          );
        })}
      </ul>
      {!disabled && (
        <>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <Picker label="Audit threshold" value={threshold} onChange={(n) => setThreshold(n as 80 | 90 | 95 | 100)} options={[80, 90, 95, 100]} />
            <Picker label="Max audit→fix iterations" value={maxIterations} onChange={(n) => setMaxIterations(n as 1 | 3 | 5)} options={[1, 3, 5]} />
          </div>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !chosenIndex}
            className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
          >
            {busy ? 'Writing + auditing script…' : 'Write script with this hook'}
          </button>
        </>
      )}
    </div>
  );
}

function AuditHistoryView({ auditHistory, threshold }: { auditHistory: NonNullable<ChannelCloneJobState['auditHistory']>; threshold: number }) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Audit history</h4>
      <ul className="space-y-1 text-xs">
        {auditHistory.map((h) => {
          const pct = h.overall * 10;
          const passed = pct >= threshold;
          return (
            <li key={h.iteration} className={`flex items-baseline justify-between rounded border px-3 py-2 ${passed ? 'border-emerald-900 bg-emerald-950/30' : 'border-amber-900 bg-amber-950/20'}`}>
              <div>
                <span className="font-mono text-[10px] text-neutral-500">iter {h.iteration}</span>{' '}
                <span className="text-neutral-300">{h.verdict}</span>
              </div>
              <div className="font-mono text-neutral-200">
                {h.overall.toFixed(1)}/10 · {h.scriptWordCount}w
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ApprovedScriptView({ approvedScript }: { approvedScript: NonNullable<ChannelCloneJobState['approvedScript']> }) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        Approved script — {approvedScript.wordCount} words · final score {approvedScript.finalScore.toFixed(1)}/10
      </h4>
      <pre className="whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-200">
        {approvedScript.text}
      </pre>
    </div>
  );
}

function RowifyView({
  rows, presetId,
}: {
  rows: NonNullable<ChannelCloneJobState['productionRows']>;
  presetId: string;
}) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Production rows ({rows.length})
        </h4>
        <span className="font-mono text-[10px] text-neutral-500">style: {presetId}</span>
      </div>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="space-y-1 rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] text-neutral-500">{r.timecode}</span>
              <span className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
                r.visual_type === 'ai_image' ? 'border-violet-800 bg-violet-950/40 text-violet-300'
                : r.visual_type === 'stock' ? 'border-amber-800 bg-amber-950/40 text-amber-300'
                : 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
              }`}>
                {r.visual_type}
              </span>
            </div>
            <p className="text-neutral-200">{r.script_text}</p>
            <p className="text-neutral-400">{r.visual_description}</p>
            <details>
              <summary className="cursor-pointer text-[10px] text-neutral-500 hover:text-neutral-300">image prompt</summary>
              <p className="mt-1 whitespace-pre-wrap text-[10px] text-neutral-400">{r.ai_image_prompt}</p>
            </details>
            {r.on_screen_text && (
              <p className="text-[10px] text-neutral-500">on-screen: <span className="text-amber-300">{r.on_screen_text}</span></p>
            )}
            {r.notes && (
              <p className="text-[10px] italic text-neutral-500">{r.notes}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
