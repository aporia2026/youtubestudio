'use client';

/**
 * Persistent strip rendered at the top of every Create-hub tool page when
 * the URL carries `?videoId=`. The visible Wave 1 win: every tool stops
 * opening blank because the strip carries the current video forward, and
 * Prev / Next move through the stage chain without losing context.
 *
 * Layout (left to right):
 *
 *   [channel chip]  [video title]  ·  Stage: [named]  ·  QA: 84/100   [◀ Prev]  [Next ▶]   [↗]
 *
 * Behaviour:
 *   - Returns null when no `?videoId=` so non-tool pages are untouched.
 *   - One round-trip on mount to /api/videos/[id]; the response also carries
 *     enough info to compute Prev/Next URLs without a second call.
 *   - Refetches on tab focus, matching ScheduleLinkBanner.
 *   - Next button on an auto-managed video shows the gate's reason on hover
 *     and on click (toast) instead of advancing — the strip never
 *     mis-promises the user that a click will succeed.
 *   - All visible labels are plain English. "Stage 4 of 10" only shows on
 *     hover, never as the primary label (Outsider council feedback).
 *
 * Observability: namespaced console logs at every meaningful step
 * (`[video-context-strip load]`, `[video-context-strip advance]`,
 * `[video-context-strip gated]`) per standing rule 14.
 */

import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { VideoStageId } from '@/lib/video-stages';
import { usePresenceHeartbeat } from './use-presence';

interface ChannelChip {
  id: string;
  name: string;
  account_color: string | null;
}

interface NeighborRef {
  stage: VideoStageId;
  label: string;
  href: string;
}

interface VideoStripData {
  id: string;
  title: string;
  current_stage: VideoStageId;
  current_stage_label: string;
  current_stage_index: number;
  is_auto_managed: boolean;
  channel: ChannelChip | null;
  latest_qa_score: number | null;
  latest_qa_aggressiveness: string | null;
  pipeline_stage: string | null;
  neighbors: { prev: NeighborRef | null; next: NeighborRef | null };
}

const STAGE_CHAIN_LENGTH = 10;

/**
 * Top-of-page strip. Renders nothing when no `?videoId=` is present, so it
 * is safe to mount globally in AppLayout without poisoning non-tool pages.
 */
export function VideoContextStrip(): React.ReactElement | null {
  const router = useRouter();
  const search = useSearchParams();
  const pathname = usePathname();
  const videoId = search?.get('videoId') ?? null;

  const [data, setData] = useState<VideoStripData | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  // Presence heartbeat: pulse every 20s while this video is open.
  // Returns the full workspace snapshot; we pluck out the entry for
  // the current video to render the "who else has it open" badge.
  const presenceSnapshot = usePresenceHeartbeat(videoId);
  const presenceForThisVideo = (videoId && presenceSnapshot[videoId]) || [];

  const refresh = useCallback(async () => {
    if (!videoId) return;
    setLoading(true);
    console.info('[video-context-strip load] start', { videoId, pathname });
    try {
      const [videoRes, neighborsRes] = await Promise.all([
        fetch(`/api/videos/${videoId}`),
        fetch(`/api/videos/${videoId}/neighbors`),
      ]);
      if (!videoRes.ok) {
        // 404 is the expected "this video does not exist (any more) in
        // your workspace" — silently unmount the strip. Other statuses
        // log so we know something is misconfigured.
        if (videoRes.status === 404) {
          console.info('[video-context-strip load] not_found', { videoId });
        } else {
          console.warn('[video-context-strip load] fail', { videoId, status: videoRes.status });
        }
        setData(null);
        return;
      }
      const videoJson = await videoRes.json();
      const neighborsJson = neighborsRes.ok ? await neighborsRes.json() : null;
      const merged: VideoStripData = {
        id: videoJson.video.id,
        title: videoJson.video.title,
        current_stage: videoJson.video.current_stage,
        current_stage_label: videoJson.video.current_stage_label,
        current_stage_index: videoJson.video.current_stage_index,
        is_auto_managed: videoJson.video.is_auto_managed,
        channel: videoJson.video.channel,
        latest_qa_score: videoJson.video.latest_qa_score,
        latest_qa_aggressiveness: videoJson.video.latest_qa_aggressiveness,
        pipeline_stage: videoJson.video.pipeline?.stage ?? null,
        neighbors: neighborsJson?.neighbors ?? { prev: null, next: null },
      };
      setData(merged);
      console.info('[video-context-strip load] ok', {
        videoId,
        current_stage: merged.current_stage,
        is_auto_managed: merged.is_auto_managed,
        has_prev: !!merged.neighbors.prev,
        has_next: !!merged.neighbors.next,
      });
    } catch (err) {
      console.error('[video-context-strip load] error', err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [videoId, pathname]);

  // Initial load + refetch when ?videoId= changes.
  useEffect(() => {
    if (videoId) {
      void refresh();
    } else {
      setData(null);
    }
  }, [videoId, refresh]);

  // Refetch on tab focus so a stage advance in another tab is reflected here.
  useEffect(() => {
    if (!videoId) return;
    function onVisible() {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refresh();
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [videoId, refresh]);

  /**
   * Prev is pure navigation: jump back to the previous stage's tool page
   * with the videoId preserved. No DB write — the user is just looking,
   * not regressing the stage. If they actually want to undo a forward
   * advance they should use the new tool's editing affordances.
   */
  const handlePrev = useCallback(() => {
    if (!data?.neighbors.prev) return;
    console.info('[video-context-strip prev] navigate', {
      videoId: data.id,
      from_stage: data.current_stage,
      to_stage: data.neighbors.prev.stage,
    });
    router.push(data.neighbors.prev.href);
  }, [data, router]);

  /**
   * Next advances the stage (DB write via advanceVideo) and then
   * navigates. Auto-managed videos are short-circuited with a toast
   * showing the gate's reason; no request is fired in that case.
   */
  const handleNext = useCallback(async () => {
    if (!data?.neighbors.next) return;
    const neighbor = data.neighbors.next;

    if (data.is_auto_managed) {
      const reason = buildAutoManagedHint(data);
      toast.warning(reason, { duration: 6000 });
      console.info('[video-context-strip gated] auto-managed advance refused', {
        videoId: data.id,
        pipeline_stage: data.pipeline_stage,
      });
      return;
    }

    setAdvancing(true);
    console.info('[video-context-strip advance] start', {
      videoId: data.id,
      from_stage: data.current_stage,
      to_stage: neighbor.stage,
    });
    try {
      const res = await fetch(`/api/videos/${data.id}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStage: neighbor.stage, source: 'strip-next' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = (json as { error?: string }).error ?? 'Could not advance the video';
        console.warn('[video-context-strip advance] fail', { status: res.status, message });
        toast.error(message, { duration: 6000 });
        return;
      }
      console.info('[video-context-strip advance] ok', { videoId: data.id, to_stage: neighbor.stage });
      toast.success(`Moved to ${neighbor.label}`);
      router.push(neighbor.href);
    } catch (err) {
      console.error('[video-context-strip advance] error', err);
      toast.error('Could not advance the video');
    } finally {
      setAdvancing(false);
    }
  }, [data, router]);

  // No video selected → no strip. Non-tool pages keep their existing chrome.
  if (!videoId) return null;

  // Loading skeleton: a thin placeholder bar so the strip's presence doesn't
  // shift the layout when data arrives.
  if (loading && !data) {
    return (
      <div
        className="border-b px-4 py-2 text-xs"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', color: 'var(--text-muted)' }}
        aria-busy="true"
      >
        Loading video context…
      </div>
    );
  }

  // Loaded but the video isn't in this workspace (or was deleted).
  if (!data) {
    return (
      <div
        className="border-b px-4 py-2 text-xs flex items-center justify-between"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', color: 'var(--text-muted)' }}
      >
        <span>The linked video is not available.</span>
        <button
          type="button"
          className="hover:underline"
          onClick={() => router.replace(pathname ?? '?')}
          style={{ color: 'var(--text-muted)' }}
        >
          Unlink
        </button>
      </div>
    );
  }

  const accent = data.channel?.account_color ?? 'var(--accent-purple)';
  const stageHover = `Stage ${data.current_stage_index + 1} of ${STAGE_CHAIN_LENGTH} · ${data.current_stage_label}`;

  return (
    <div
      className="border-b flex items-center gap-3 px-4 py-2 flex-wrap text-sm"
      style={{
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
      }}
      data-testid="video-context-strip"
    >
      {/* Channel chip */}
      {data.channel ? (
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium"
          style={{
            background: `${accent}22`,
            color: accent,
            border: `1px solid ${accent}44`,
          }}
          title={`Channel: ${data.channel.name}`}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: accent }} aria-hidden />
          {data.channel.name}
        </span>
      ) : (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No channel
        </span>
      )}

      {/* Title */}
      <span className="font-medium truncate flex-1 min-w-0" style={{ color: 'var(--text-primary)' }} title={data.title}>
        {data.title || 'Untitled video'}
      </span>

      {/* Stage badge — named, not numbered. Hover shows the count. */}
      <span
        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
        title={stageHover}
      >
        <span style={{ color: 'var(--text-muted)' }}>Stage:</span>
        <span>{data.current_stage_label}</span>
      </span>

      {/* Latest QA score (only shown when we have one). Inline because for
          auto-managed videos this is the single most important piece of
          context — the user wants to know "did the script pass." */}
      {data.latest_qa_score !== null && (
        <span
          className="text-xs px-2 py-0.5 rounded"
          style={{
            background: data.latest_qa_score >= 100 ? 'var(--accent-green)22' : 'var(--bg-primary)',
            color: data.latest_qa_score >= 100 ? 'var(--accent-green)' : 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
          title={
            data.latest_qa_aggressiveness
              ? `Latest QA pass: ${data.latest_qa_score}/100 in ${data.latest_qa_aggressiveness} mode`
              : `Latest QA pass: ${data.latest_qa_score}/100`
          }
        >
          QA {data.latest_qa_score}/100
        </span>
      )}

      {/* Who else has this video open. Excludes the current user so
          the badge only shows "others." Avatars are first-letter initials
          in a colored circle — small, glanceable, no extra data fetched. */}
      {presenceForThisVideo.filter(p => p.userId).length > 1 && (
        <div className="flex items-center gap-0.5" title="Other teammates have this video open">
          {presenceForThisVideo
            .slice(0, 4)
            .map(p => (
              <span
                key={p.userId}
                className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[10px] font-semibold"
                style={{
                  background: p.color || 'var(--accent-cyan)',
                  color: 'white',
                  border: '1px solid var(--bg-secondary)',
                  marginLeft: -4,
                }}
                title={p.name ?? 'Teammate'}
              >
                {(p.name ?? '?').charAt(0).toUpperCase()}
              </span>
            ))}
        </div>
      )}

      {/* Auto-managed badge — sets expectation that Next is gated. */}
      {data.is_auto_managed && (
        <Link
          href={`/pipeline`}
          className="text-xs px-2 py-0.5 rounded hover:underline"
          style={{
            background: 'var(--accent-cyan)22',
            color: 'var(--accent-cyan-bright)',
            border: '1px solid var(--accent-cyan)44',
          }}
          title="This video is being driven by the auto-pipeline. Use the Pipeline page to act on it."
        >
          Auto-pipeline
        </Link>
      )}

      {/* Prev / Next */}
      <div className="flex items-center gap-1.5">
        <PrevNextButton
          direction="prev"
          neighbor={data.neighbors.prev}
          disabled={advancing}
          onClick={handlePrev}
        />
        <PrevNextButton
          direction="next"
          neighbor={data.neighbors.next}
          disabled={advancing || (data.is_auto_managed && !!data.neighbors.next)}
          onClick={handleNext}
          autoManagedHint={data.is_auto_managed ? buildAutoManagedHint(data) : null}
        />
      </div>

      {/* Command Center link — placeholder route until Wave 2; for Wave 1 it
          deep-links to the schedule view filtered to this video. */}
      <Link
        href={`/schedule?focus=${encodeURIComponent(data.id)}`}
        className="text-xs px-2 py-1 rounded"
        style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
        title="Open in Schedule"
      >
        ↗
      </Link>
    </div>
  );
}

function PrevNextButton(props: {
  direction: 'prev' | 'next';
  neighbor: NeighborRef | null;
  disabled: boolean;
  onClick: () => void;
  autoManagedHint?: string | null;
}): React.ReactElement {
  const { direction, neighbor, disabled, onClick, autoManagedHint } = props;
  const isPrev = direction === 'prev';
  const label = neighbor ? `${isPrev ? '◀ ' : ''}${neighbor.label}${isPrev ? '' : ' ▶'}` : isPrev ? '◀' : '▶';
  const title = !neighbor
    ? isPrev
      ? 'No earlier stage'
      : 'No later stage'
    : autoManagedHint && !isPrev
      ? autoManagedHint
      : isPrev
        ? `Go back to ${neighbor.label}`
        : `Advance to ${neighbor.label}`;
  const enabled = !!neighbor && !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      title={title}
      className="text-xs px-2.5 py-1 rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        background: 'transparent',
        color: enabled ? 'var(--text-primary)' : 'var(--text-muted)',
        border: '1px solid var(--border)',
      }}
    >
      {label}
    </button>
  );
}

function buildAutoManagedHint(data: VideoStripData): string {
  if (data.current_stage === 'qa' && data.latest_qa_score !== null) {
    const aggr = data.latest_qa_aggressiveness ?? 'nuclear';
    return `Auto-managed: QA ${data.latest_qa_score}/100 in ${aggr} mode. Pipeline gate decides when to advance — open the Pipeline page to retry or adjust the preset.`;
  }
  if (data.pipeline_stage === 'waiting_narration' || data.pipeline_stage === 'narration_overdue') {
    return 'Auto-managed: waiting on narrator. Open the Pipeline page to mark narration done or extend the deadline.';
  }
  if (data.pipeline_stage === 'awaiting_script_gate') {
    return 'Auto-managed: at the script gate. Keep, regenerate, or kill from the Pipeline page.';
  }
  return 'Auto-managed by the auto-pipeline. Open the Pipeline page to act on this video.';
}
