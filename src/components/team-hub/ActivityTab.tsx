'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import type { RosterEntry, SurfaceDescriptor } from '@/lib/team-hub-types';
import type { ActivityEvent } from '@/lib/team-hub-activity-db';

/**
 * Activity tab — time-ordered feed of every visible event for the
 * selected collaborator. Channel editors don't have an activity feed in
 * v1 (their work flows through schedule_items which we don't enumerate
 * here yet) so they get an explanatory empty state.
 *
 * Each event row carries an optional click-through that opens the right
 * pane on the relevant surface (e.g. take comment → open the take's
 * thread). Events without a meaningful surface (review-version uploads
 * — too far from a single review-pane mount) just render as static.
 */

interface ActivityTabProps {
  entry: RosterEntry;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

interface EventPayload {
  take_id?: string;
  take_number?: number;
  section_label?: string | null;
  section_number?: number;
  project_id?: string;
  project_title?: string | null;
  version_id?: string;
  version_number?: number;
  uploaded_by?: string | null;
  review_project_id?: string;
  comment_id?: string;
  author_name?: string;
  author_role?: 'owner' | 'narrator';
  posted_by_owner?: boolean;
  text?: string;
  action_type?: string;
  surface?: string;
  surface_target_id?: string | null;
  result?: 'success' | 'failure';
  error_message?: string | null;
}

function timeAgo(s: string): string {
  const diff = Date.now() - new Date(s).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const TYPE_ICON: Record<string, string> = {
  take_uploaded: '🎤',
  narration_take_comment: '💬',
  review_version_uploaded: '🎬',
  review_comment: '✍️',
  act_as: '🪪',
};

const TYPE_TINT: Record<string, string> = {
  take_uploaded: '#a78bfa',
  narration_take_comment: '#67e8f9',
  review_version_uploaded: '#60a5fa',
  review_comment: '#67e8f9',
  act_as: '#facc15',
};

export function ActivityTab({ entry, onOpenSurface }: ActivityTabProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (entry.kind !== 'collaborator') {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch(`/api/team-hub/${entry.id}/activity`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [entry]);

  useEffect(() => {
    load();
  }, [load]);

  if (entry.kind === 'channel_editor') {
    return (
      <div className="px-6 py-10">
        <div
          className="rounded-xl p-6 text-center"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            No activity feed for channel editors
          </h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Their work flows through the schedule. Open the Tasks tab and click "Open their schedule slice" to see what they've touched.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="px-6 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
        Loading activity…
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

  if (events.length === 0) {
    return (
      <div className="px-6 py-10 text-center">
        <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Nothing here yet
        </h3>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Events appear as {entry.name} uploads takes, posts comments, or you act on their behalf.
        </p>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 space-y-2">
      {events.map((event, idx) => (
        <ActivityRow key={`${event.event_type}:${event.target_id}:${idx}`} event={event} onOpenSurface={onOpenSurface} />
      ))}
    </div>
  );
}

function ActivityRow({
  event,
  onOpenSurface,
}: {
  event: ActivityEvent;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}) {
  const tint = TYPE_TINT[event.event_type] ?? 'var(--text-muted)';
  const icon = TYPE_ICON[event.event_type] ?? '•';
  const payload = event.payload as EventPayload;

  const description = describe(event.event_type, payload);
  const surface = surfaceForEvent(event.event_type, payload);

  const onClick = () => {
    if (surface) onOpenSurface(surface);
  };

  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={!surface}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      className="w-full text-left rounded-lg p-3 flex items-start gap-3 transition-colors disabled:cursor-default"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-sm shrink-0"
        style={{ background: 'rgba(255,255,255,0.05)' }}
      >
        <span style={{ filter: 'grayscale(0)' }}>{icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
          {description.headline}
        </div>
        {description.body && (
          <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
            {description.body}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: tint }}>
          {labelFor(event.event_type)}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {timeAgo(event.event_at)}
        </span>
      </div>
    </motion.button>
  );
}

// ── Per-event-type description + surface mapping ───────────────────

function describe(
  type: string,
  p: EventPayload,
): { headline: string; body?: string } {
  switch (type) {
    case 'take_uploaded': {
      const sec = p.section_label || (p.section_number != null ? `Section ${p.section_number}` : 'Section');
      return {
        headline: `Uploaded take ${p.take_number ?? ''} for ${p.project_title ?? 'project'}`,
        body: sec,
      };
    }
    case 'narration_take_comment': {
      const who = p.posted_by_owner ? `Owner (as ${p.author_name ?? 'them'})` : (p.author_name ?? 'Someone');
      return {
        headline: `${who} posted a take comment`,
        body: p.text ?? undefined,
      };
    }
    case 'review_version_uploaded':
      return {
        headline: `Uploaded review version ${p.version_number ?? ''} for ${p.project_title ?? 'project'}`,
        body: p.uploaded_by ?? undefined,
      };
    case 'review_comment': {
      const who = p.posted_by_owner ? `Owner (as ${p.author_name ?? 'them'})` : (p.author_name ?? 'Someone');
      return {
        headline: `${who} posted a review comment`,
        body: p.text ?? undefined,
      };
    }
    case 'act_as': {
      const tag = p.result === 'failure' ? '(failed)' : '';
      return {
        headline: `Owner acted as them: ${p.action_type ?? 'unknown'} ${tag}`.trim(),
        body: p.error_message ? p.error_message : (p.surface ?? undefined),
      };
    }
    default:
      return { headline: type };
  }
}

function surfaceForEvent(type: string, p: EventPayload): SurfaceDescriptor | null {
  switch (type) {
    case 'take_uploaded':
    case 'narration_take_comment':
      return p.take_id ? { kind: 'takes', id: p.take_id } : null;
    case 'review_version_uploaded':
    case 'review_comment':
      return p.review_project_id ? { kind: 'review', id: p.review_project_id } : null;
    case 'act_as':
      // The audit-log row captures the surface kind + target id, so we
      // can deep-link there if the surface kind is one of our descriptors.
      if (
        p.surface &&
        p.surface_target_id &&
        (p.surface === 'narration_take_comment')
      ) {
        return { kind: 'takes', id: p.surface_target_id };
      }
      return null;
    default:
      return null;
  }
}

function labelFor(type: string): string {
  switch (type) {
    case 'take_uploaded': return 'TAKE';
    case 'narration_take_comment': return 'TAKE COMMENT';
    case 'review_version_uploaded': return 'VERSION';
    case 'review_comment': return 'REVIEW COMMENT';
    case 'act_as': return 'ACT AS';
    default: return type.toUpperCase();
  }
}
