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
  ProgressLogEntry,
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
  'handoff_running',
];

const POLL_INTERVAL_MS = 4000;

export interface ChannelClonePanelProps {
  /** Resume an existing job by id (e.g. when mounted on
   *  /channel-clone/[id]). When omitted, the panel renders the
   *  empty new-job form. */
  initialJobId?: string;
}

interface CostSummary {
  jobId: string;
  perStage: { featureArea: string; totalUsd: number; calls: number; inputTokens: number; outputTokens: number }[];
  totals: { totalUsd: number; calls: number; inputTokens: number; outputTokens: number };
}

interface PipelinePresetSummary {
  id: string;
  name: string;
  niche: string | null;
}

export function ChannelClonePanel({ initialJobId }: ChannelClonePanelProps = {}) {
  const [url, setUrl] = useState('');
  const [sampleVideoCount, setSampleVideoCount] = useState<3 | 5 | 8>(5);
  const [frameIntervalSec, setFrameIntervalSec] = useState<5 | 10 | 15>(10);
  const [topicCount, setTopicCount] = useState<5 | 10 | 15>(10);
  const [chosenTopicIndex, setChosenTopicIndex] = useState<number | null>(null);
  const [chosenHookIndex, setChosenHookIndex] = useState<number | null>(null);
  const [threshold, setThreshold] = useState<80 | 90 | 95 | 100>(90);
  const [maxIterations, setMaxIterations] = useState<1 | 3 | 5>(3);
  const [stylePresetIdHint, setStylePresetIdHint] = useState<string>('auto');
  const [handoffPresetId, setHandoffPresetId] = useState<string>('auto');
  const [pipelinePresets, setPipelinePresets] = useState<PipelinePresetSummary[]>([]);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'analyze' | 'topics' | 'hooks' | 'script' | 'rowify' | 'handoff' | 'publish-pack'>(null);
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

  // Resume an existing job when initialJobId is supplied. Single
  // poll kickstart — the recursive setTimeout inside pollOnce keeps
  // going while the job is in an active status.
  useEffect(() => {
    if (initialJobId) {
      void pollOnce(initialJobId);
    }
  }, [initialJobId, pollOnce]);

  // Load cost summary whenever we have a job. Re-pulls on every
  // status change so the UI reflects fresh spend immediately after
  // a stage completes.
  useEffect(() => {
    if (!job) {
      setCost(null);
      return;
    }
    let cancelled = false;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch(`/api/channel-clone/jobs/${job.id}/cost`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setCost(data as CostSummary); })
      .catch(() => { /* non-fatal — cost is informational */ });
    return () => { cancelled = true; };
  }, [job?.id, job?.status]);

  // Load this workspace's pipeline_presets once. Used by the
  // pre-handoff preset picker so the user can pin a specific preset
  // (defaults to "auto" which lets the handoff runner pick the
  // workspace's first).
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch(`/api/auto-pipeline/presets`)
      .then((r) => (r.ok ? r.json() : { presets: [] }))
      .then((data) => {
        if (cancelled) return;
        const arr = Array.isArray(data?.presets) ? data.presets : [];
        setPipelinePresets(arr.map((p: { id: string; name: string; niche?: string | null }) => ({
          id: p.id,
          name: p.name,
          niche: p.niche ?? null,
        })));
      })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

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
      stage: 'analyze' | 'topics' | 'hooks' | 'script' | 'rowify' | 'handoff' | 'publish-pack',
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
  const hasPublishPack = !!state?.publishPack;

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
            {ACTIVE_STATUSES.includes(job.status) && (
              <CancelButton
                jobId={job.id}
                onCancelled={() => { void pollOnce(job.id); }}
              />
            )}
          </div>
          {job.lastError && (
            <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{job.lastError}</p>
          )}
          {state?.progressLog && state.progressLog.length > 0 && (
            <ProgressLogView entries={state.progressLog} active={ACTIVE_STATUSES.includes(job.status)} />
          )}
          {cost && cost.totals.calls > 0 && <CostSummaryView cost={cost} />}
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
                {state.intake.sampleVideos.reduce((a, v) => a + v.frameCount, 0)}
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
            <AnalysisView
              analysis={state.analysis}
              visualProfile={state.visualProfile}
              onRegenerate={busy !== 'analyze' ? () => {
                if (confirm('Re-run channel analysis? Downstream stages (topics, hooks, script…) will reference the new analysis on the NEXT regenerate but will not be wiped automatically.')) {
                  void runStage('analyze', {});
                }
              } : undefined}
              regenerating={busy === 'analyze'}
            />
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
              onRegenerate={busy !== 'topics' ? () => {
                if (confirm(`Regenerate ${topicCount} topics? This wipes the current topic list AND every downstream stage (hooks, script, rows, publish pack).`)) {
                  void runStage('topics', { topicCount });
                }
              } : undefined}
              regenerating={busy === 'topics'}
              topicCount={topicCount}
              setTopicCount={setTopicCount}
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
              onRegenerate={busy !== 'hooks' && state.selectedTopicIndex ? () => {
                if (confirm('Regenerate the 5 hooks for the selected topic? This wipes the current hook list AND any approved script + audit history.')) {
                  void runStage('hooks', { selectedTopicIndex: state.selectedTopicIndex });
                }
              } : undefined}
              regenerating={busy === 'hooks'}
            />
          )}

          {/* ── Stage 4: Script + audit history ────────────────── */}
          {state?.auditHistory && state.auditHistory.length > 0 && (
            <AuditHistoryView auditHistory={state.auditHistory} threshold={threshold} />
          )}
          {state?.approvedScript && (
            <ApprovedScriptView
              approvedScript={state.approvedScript}
              onRegenerate={busy !== 'script' && state.selectedHookIndex ? () => {
                if (confirm(`Rewrite the script and re-run the audit-fix loop (threshold ${threshold}, up to ${maxIterations} iterations)? This wipes the current script + audit history.`)) {
                  void runStage('script', { selectedHookIndex: state.selectedHookIndex, threshold, maxIterations });
                }
              } : undefined}
              regenerating={busy === 'script'}
            />
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
              stylePresetIdHint={stylePresetIdHint}
              setStylePresetIdHint={setStylePresetIdHint}
              onRegenerate={busy !== 'rowify' ? () => {
                void runStage('rowify', stylePresetIdHint === 'auto' ? {} : { stylePresetId: stylePresetIdHint });
              } : undefined}
              regenerating={busy === 'rowify'}
            />
          )}

          {/* ── Stage 6: Handoff to auto-pipeline ─────────────────── */}
          {hasRows && !state?.handoff && (
            <div className="space-y-2 border-t border-neutral-800 pt-3">
              <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Send to production pipeline</h4>
              <p className="text-xs text-neutral-500">
                Promote the rowified doc into the existing auto-pipeline. Creates a new project, script, and pipeline_run_videos row at <code className="text-neutral-300">generating_production_doc_images</code> so the cron picks it up and runs image generation.
              </p>
              <label className="block">
                <span className="text-xs text-neutral-400">Pipeline preset</span>
                <select
                  value={handoffPresetId}
                  onChange={(e) => setHandoffPresetId(e.target.value)}
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
                  disabled={busy === 'handoff' || pipelinePresets.length === 0}
                >
                  <option value="auto">Auto — workspace's first preset</option>
                  {pipelinePresets.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.niche ? ` · ${p.niche}` : ''}</option>
                  ))}
                </select>
                {pipelinePresets.length === 0 && (
                  <span className="mt-1 block text-[10px] text-amber-400">No presets found — create one in Auto-pipeline → Presets first.</span>
                )}
              </label>
              <button
                type="button"
                onClick={() => runStage('handoff', handoffPresetId === 'auto' ? {} : { presetId: handoffPresetId })}
                disabled={busy === 'handoff' || pipelinePresets.length === 0}
                className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
              >
                {busy === 'handoff' ? 'Handing off…' : 'Send to production pipeline'}
              </button>
            </div>
          )}
          {state?.handoff && (
            <HandoffView
              handoff={state.handoff}
              handoffHistory={state.handoffHistory ?? []}
              pipelinePresets={pipelinePresets}
              handoffPresetId={handoffPresetId}
              setHandoffPresetId={setHandoffPresetId}
              onReHandoff={busy !== 'handoff' && pipelinePresets.length > 0 ? () => {
                if (confirm('Hand off again with this preset? A NEW pipeline_run_video will be created; the previous one keeps running on its own.')) {
                  void runStage('handoff', handoffPresetId === 'auto' ? {} : { presetId: handoffPresetId });
                }
              } : undefined}
              reHandingOff={busy === 'handoff'}
            />
          )}

          {/* ── Stage 7: Publish pack ─────────────────────────────── */}
          {hasApprovedScript && !hasPublishPack && (
            <div className="space-y-2 border-t border-neutral-800 pt-3">
              <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Publish pack</h4>
              <p className="text-xs text-neutral-500">
                Generate the launch packaging: 5 thumbnail concepts, 5 title candidates, description, ~30 SEO tags, 3 pinned-comment options, optimal upload time, and a 30-day content calendar — all in one shot.
              </p>
              <button
                type="button"
                onClick={() => runStage('publish-pack', {})}
                disabled={busy === 'publish-pack'}
                className="w-full rounded bg-neutral-200 px-4 py-2 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
              >
                {busy === 'publish-pack' ? 'Building publish pack…' : 'Build publish pack'}
              </button>
            </div>
          )}
          {state?.publishPack && (
            <PublishPackView
              pack={state.publishPack}
              onRegenerate={busy !== 'publish-pack' ? () => {
                void runStage('publish-pack', {});
              } : undefined}
              regenerating={busy === 'publish-pack'}
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

function RegenerateLink({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500 hover:text-neutral-200 disabled:cursor-not-allowed disabled:text-neutral-600"
    >
      <span aria-hidden>↻</span>
      <span>{busy ? 'Working…' : 'Regenerate'}</span>
    </button>
  );
}

/** Live progress console — bound to `state_jsonb.progressLog`. Each
 *  poll cycle refreshes the array, the list scrolls to bottom on new
 *  entries, and the colour-coded `step` chip lets the user scan the
 *  log for "where is it stuck?" at a glance. */
function ProgressLogView({ entries, active }: { entries: ProgressLogEntry[]; active: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Anchor to bottom whenever a new entry lands so the user sees
    // the live edge of the run without having to scroll manually.
    el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  // Render newest 100 entries — older are kept on the row for the
  // server log but not worth scrolling through.
  const visible = entries.slice(-100);
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-neutral-400">
          Live progress
        </span>
        <span className="font-mono text-[10px] text-neutral-500">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          {active && (
            <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 align-middle" aria-label="running" />
          )}
        </span>
      </header>
      <div ref={scrollRef} className="max-h-48 overflow-y-auto px-3 py-1.5 font-mono text-[10px] leading-relaxed">
        {visible.map((e, i) => (
          <ProgressLogRow key={`${e.ts}-${i}`} entry={e} />
        ))}
      </div>
    </div>
  );
}

function ProgressLogRow({ entry }: { entry: ProgressLogEntry }) {
  const levelColour =
    entry.level === 'error' ? 'text-red-300' : entry.level === 'warn' ? 'text-amber-300' : 'text-neutral-300';
  // Step chip — predictable colour per known namespace; falls back
  // to grey for new ones so the UI doesn't break on schema growth.
  const stepColour =
    entry.step === 'sandbox' ? 'bg-violet-900/50 text-violet-200 border-violet-800'
    : entry.step === 'yt-dlp' ? 'bg-blue-900/50 text-blue-200 border-blue-800'
    : entry.step === 'ffmpeg' ? 'bg-emerald-900/50 text-emerald-200 border-emerald-800'
    : entry.step === 'intake' ? 'bg-amber-900/50 text-amber-200 border-amber-800'
    : entry.step === 'analyze' || entry.step === 'topics' || entry.step === 'hooks' || entry.step === 'script' || entry.step === 'rowify' || entry.step === 'publish-pack' || entry.step === 'handoff'
      ? 'bg-cyan-900/50 text-cyan-200 border-cyan-800'
      : 'bg-neutral-800 text-neutral-300 border-neutral-700';
  const time = entry.ts.slice(11, 19); // hh:mm:ss out of an ISO string
  const dataString = entry.data && Object.keys(entry.data).length > 0
    ? Object.entries(entry.data)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
    : '';
  return (
    <div className={`flex items-baseline gap-2 ${levelColour}`}>
      <span className="text-neutral-600">{time}</span>
      <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${stepColour}`}>
        {entry.step}
      </span>
      <span className="truncate">
        {entry.msg}
        {dataString && <span className="ml-2 text-neutral-500">{dataString}</span>}
      </span>
    </div>
  );
}

/** Per-job cancel control. POSTs to /jobs/[id]/cancel and reflects
 *  in-flight state so the user can't double-click. The endpoint
 *  flips status to 'cancelled' atomically; the parent's poll loop
 *  picks up the new status on its next tick. */
function CancelButton({ jobId, onCancelled }: { jobId: string; onCancelled: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleClick = useCallback(async () => {
    if (cancelling) return;
    if (!window.confirm('Stop this run? Work done so far will be preserved on the job.')) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/channel-clone/jobs/${jobId}/cancel`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      onCancelled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }, [cancelling, jobId, onCancelled]);
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={cancelling}
        title="Stop this run. Work done so far is kept on the job."
        className="rounded border border-red-900 bg-red-950/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-red-300 hover:border-red-700 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {cancelling ? 'Stopping…' : 'Stop'}
      </button>
      {error && <span className="text-[10px] text-red-300">{error}</span>}
    </span>
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

function AnalysisView({
  analysis, visualProfile, onRegenerate, regenerating,
}: {
  analysis: ChannelCloneAnalysis;
  visualProfile?: ChannelCloneVisualProfile;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  return (
    <div className="space-y-2 rounded border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-300">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Channel analysis</h4>
        {onRegenerate && <RegenerateLink onClick={onRegenerate} busy={regenerating} />}
      </div>
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
  onRegenerate, regenerating, topicCount, setTopicCount,
}: {
  topics: NonNullable<ChannelCloneJobState['topics']>;
  chosenIndex: number | null;
  setChosenIndex: (n: number) => void;
  onConfirm: () => void;
  busy: boolean;
  disabled: boolean;
  onRegenerate?: () => void;
  regenerating?: boolean;
  topicCount: 5 | 10 | 15;
  setTopicCount: (n: 5 | 10 | 15) => void;
}) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Topics — pick one</h4>
        {onRegenerate && (
          <div className="flex items-center gap-2">
            <select
              value={topicCount}
              onChange={(e) => setTopicCount(Number(e.target.value) as 5 | 10 | 15)}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-200"
              disabled={regenerating}
            >
              {[5, 10, 15].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <RegenerateLink onClick={onRegenerate} busy={regenerating} />
          </div>
        )}
      </div>
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
  onRegenerate, regenerating,
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
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Hooks — pick one</h4>
        {onRegenerate && <RegenerateLink onClick={onRegenerate} busy={regenerating} />}
      </div>
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

function ApprovedScriptView({
  approvedScript, onRegenerate, regenerating,
}: {
  approvedScript: NonNullable<ChannelCloneJobState['approvedScript']>;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Approved script — {approvedScript.wordCount} words · final score {approvedScript.finalScore.toFixed(1)}/10
        </h4>
        {onRegenerate && <RegenerateLink onClick={onRegenerate} busy={regenerating} />}
      </div>
      <pre className="whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-200">
        {approvedScript.text}
      </pre>
    </div>
  );
}

function CostSummaryView({ cost }: { cost: CostSummary }) {
  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
  const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
  return (
    <details className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
      <summary className="cursor-pointer">
        <span className="font-medium text-neutral-200">LLM spend so far: {fmtUsd(cost.totals.totalUsd)}</span>
        <span className="ml-2 font-mono text-[10px] text-neutral-500">
          {cost.totals.calls} calls · {fmtTok(cost.totals.inputTokens)} in / {fmtTok(cost.totals.outputTokens)} out
        </span>
      </summary>
      <ul className="mt-2 space-y-1 text-[11px]">
        {cost.perStage.map((s) => (
          <li key={s.featureArea} className="grid grid-cols-[1fr_max-content_max-content_max-content] items-baseline gap-x-3">
            <span className="font-mono text-neutral-400">{s.featureArea.replace(/^channel_clone_?/, '')}</span>
            <span className="font-mono text-neutral-500">{s.calls}×</span>
            <span className="font-mono text-neutral-500">{fmtTok(s.inputTokens)}/{fmtTok(s.outputTokens)}</span>
            <span className="font-mono text-neutral-200">{fmtUsd(s.totalUsd)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PublishPackView({
  pack, onRegenerate, regenerating,
}: {
  pack: NonNullable<ChannelCloneJobState['publishPack']>;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  return (
    <div className="space-y-3 border-t border-neutral-800 pt-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Publish pack</h4>
        {onRegenerate && <RegenerateLink onClick={onRegenerate} busy={regenerating} />}
      </div>

      <details open className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-neutral-200">Titles ({pack.titles.length})</summary>
        <ol className="mt-2 space-y-1 pl-4">
          {pack.titles.map((t, i) => (
            <li key={i}>
              <div className="text-neutral-200">{t.text}</div>
              <div className="text-[10px] italic text-neutral-500">{t.ctrReasoning}</div>
            </li>
          ))}
        </ol>
      </details>

      <details className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-neutral-200">Description + SEO</summary>
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-neutral-500">Description</p>
            <pre className="mt-1 whitespace-pre-wrap text-neutral-300">{pack.description}</pre>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-neutral-500">Tags ({pack.tags.length})</p>
            <p className="text-neutral-400">{pack.tags.join(', ')}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-neutral-500">Category</p>
            <p className="text-neutral-300">{pack.categoryRecommendation}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-neutral-500">Optimal upload time</p>
            <p className="text-neutral-300">{pack.optimalUploadTime}</p>
          </div>
        </div>
      </details>

      <details className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-neutral-200">Pinned comment options (3)</summary>
        <ol className="mt-2 space-y-1 pl-4 text-neutral-300">
          {pack.pinnedCommentOptions.map((c, i) => <li key={i}>{c}</li>)}
        </ol>
      </details>

      <details className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-neutral-200">Thumbnail concepts ({pack.thumbnailConcepts.length})</summary>
        <ul className="mt-2 space-y-2">
          {pack.thumbnailConcepts.map((c, i) => (
            <li key={i} className="rounded border border-neutral-800 bg-neutral-900 p-2">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[10px] text-neutral-500">concept {i + 1}</span>
                <span className="rounded border border-amber-800 bg-amber-950/40 px-2 py-0.5 font-mono text-[10px] uppercase text-amber-300">{c.emotionTrigger}</span>
              </div>
              <p className="text-neutral-200">{c.visualConcept}</p>
              <p className="text-[10px] text-neutral-500">Text overlay: <span className="text-amber-300">{c.textOverlay}</span></p>
              <p className="text-[10px] text-neutral-500">Contrast: {c.colorContrastStrategy}</p>
              <details>
                <summary className="cursor-pointer text-[10px] text-neutral-500 hover:text-neutral-300">image prompt</summary>
                <p className="mt-1 whitespace-pre-wrap text-[10px] text-neutral-400">{c.fullImagePrompt}</p>
              </details>
              <p className="text-[10px] italic text-neutral-500">{c.ctrReasoning}</p>
            </li>
          ))}
        </ul>
      </details>

      <details className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-neutral-200">30-day content calendar</summary>
        <ul className="mt-2 space-y-1">
          {pack.contentCalendar.map((c) => (
            <li key={c.day} className="grid grid-cols-[max-content_1fr_max-content_max-content] gap-x-3 text-[11px]">
              <span className="font-mono text-neutral-500">d{c.day.toString().padStart(2, '0')}</span>
              <span className="text-neutral-200">{c.title}</span>
              <span className="text-neutral-500">{c.contentPillar}</span>
              <span className="font-mono text-neutral-500">{c.difficulty}/10</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function HandoffView({
  handoff, handoffHistory, pipelinePresets, handoffPresetId, setHandoffPresetId, onReHandoff, reHandingOff,
}: {
  handoff: NonNullable<ChannelCloneJobState['handoff']>;
  handoffHistory: NonNullable<ChannelCloneJobState['handoffHistory']>;
  pipelinePresets: PipelinePresetSummary[];
  handoffPresetId: string;
  setHandoffPresetId: (s: string) => void;
  onReHandoff?: () => void;
  reHandingOff?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded border border-emerald-900 bg-emerald-950/30 p-3 text-xs text-neutral-200">
        <h4 className="text-xs font-medium uppercase tracking-wide text-emerald-300">Handed off to production pipeline</h4>
        <p>The auto-pipeline cron will pick up this video on its next tick and run image generation.</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[10px] text-neutral-300">
          <dt className="text-neutral-500">Run</dt><dd>{handoff.pipelineRunId}</dd>
          <dt className="text-neutral-500">Video</dt><dd>{handoff.pipelineRunVideoId}</dd>
          <dt className="text-neutral-500">Project</dt><dd>{handoff.projectId}</dd>
          <dt className="text-neutral-500">Script</dt><dd>{handoff.scriptId}</dd>
          <dt className="text-neutral-500">Idea</dt><dd>{handoff.ideaId}</dd>
          <dt className="text-neutral-500">Preset</dt><dd>{handoff.presetId}</dd>
          <dt className="text-neutral-500">When</dt><dd>{new Date(handoff.handedOffAt).toLocaleString()}</dd>
        </dl>
        <p className="pt-1">
          <a href="/pipeline" className="text-blue-400 hover:underline">Open auto-pipeline dashboard →</a>
        </p>
      </div>

      {handoffHistory.length > 0 && (
        <details className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
          <summary className="cursor-pointer text-neutral-300">Previous handoffs ({handoffHistory.length})</summary>
          <ul className="mt-2 space-y-2">
            {[...handoffHistory].reverse().map((h, i) => (
              <li key={i} className="space-y-1 rounded border border-neutral-800 bg-neutral-900 p-2">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 font-mono text-[10px] text-neutral-400">
                  <dt className="text-neutral-500">Video</dt><dd>{h.pipelineRunVideoId}</dd>
                  <dt className="text-neutral-500">Preset</dt><dd>{h.presetId}</dd>
                  <dt className="text-neutral-500">When</dt><dd>{new Date(h.handedOffAt).toLocaleString()}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </details>
      )}

      {onReHandoff && (
        <div className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
          <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Hand off again</h4>
          <p className="text-[10px] text-neutral-500">
            Creates a NEW pipeline_run_video. The old one keeps running on its own.
          </p>
          <label className="block">
            <span className="text-xs text-neutral-400">Pipeline preset</span>
            <select
              value={handoffPresetId}
              onChange={(e) => setHandoffPresetId(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
              disabled={reHandingOff || pipelinePresets.length === 0}
            >
              <option value="auto">Auto — workspace's first preset</option>
              {pipelinePresets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.niche ? ` · ${p.niche}` : ''}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={onReHandoff}
            disabled={reHandingOff || pipelinePresets.length === 0}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-4 py-2 font-medium text-neutral-100 hover:border-neutral-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {reHandingOff ? 'Handing off again…' : 'Hand off again'}
          </button>
        </div>
      )}
    </div>
  );
}

function RowifyView({
  rows, presetId, stylePresetIdHint, setStylePresetIdHint, onRegenerate, regenerating,
}: {
  rows: NonNullable<ChannelCloneJobState['productionRows']>;
  presetId: string;
  stylePresetIdHint: string;
  setStylePresetIdHint: (s: string) => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  return (
    <div className="space-y-2 border-t border-neutral-800 pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Production rows ({rows.length})
        </h4>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-neutral-500">style: {presetId}</span>
          {onRegenerate && (
            <>
              <select
                value={stylePresetIdHint}
                onChange={(e) => setStylePresetIdHint(e.target.value)}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-200"
                disabled={regenerating}
              >
                <option value="auto">auto-match</option>
                {CHANNEL_CLONE_CANDIDATE_PRESETS.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              <RegenerateLink onClick={onRegenerate} busy={regenerating} />
            </>
          )}
        </div>
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
