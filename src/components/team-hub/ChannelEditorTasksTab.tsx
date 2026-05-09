'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import type { RosterEntry } from '@/lib/team-hub-types';
import type { ChannelEditorTaskRow } from '@/lib/team-hub-tasks-db';

/**
 * Channel-editor command center on the Tasks tab. Lighter than the
 * other roles because channel editors don't have personal portals — the
 * canonical surface for their work is /schedule filtered by their id.
 *
 * Roster ids for channel editors are composite: `<editor>@<channel>`.
 * The page parses the composite id from the URL `?person=` and passes
 * the parts here so the read endpoint can scope by both.
 */

interface ChannelEditorTasksTabProps {
  entry: RosterEntry;
}

export function ChannelEditorTasksTab({ entry }: ChannelEditorTasksTabProps) {
  // entry.id was composed in team-hub-db.ts as '<editor_id>@<channel_id>'.
  // Defensive split — fall back to empty strings on bad input rather than
  // crashing the tab.
  const [editorId, channelId] = entry.id.split('@');

  const [task, setTask] = useState<ChannelEditorTaskRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!editorId || !channelId) {
      setError('Malformed channel-editor entry');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/team-hub/channel-editor-tasks?id=${editorId}&channel=${channelId}`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTask(data.task ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [editorId, channelId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="px-6 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
        Loading channel-editor tasks…
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="px-6 py-10 text-center text-xs" style={{ color: '#fda4af' }}>
        {error ?? 'Channel editor not found'}
      </div>
    );
  }

  return (
    <div className="px-6 py-5">
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="rounded-xl p-4"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {task.channel_name}
            </div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {entry.name} edits the schedule for this channel.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <Stat label="Upcoming items" value={task.upcoming_schedule_count} accent="#a78bfa" />
          <Stat label="Past items" value={task.past_schedule_count} accent="var(--text-muted)" />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={`/schedule?editor=${task.channel_editor_id}`}
            className="text-[11px] px-2.5 py-1 rounded-md font-medium"
            style={{
              background: 'linear-gradient(135deg, #7c3aed, #06b6d4)',
              color: '#fff',
            }}
          >
            Open their schedule slice ↗
          </a>
          <a
            href={`/channel/${task.channel_id}/brand-kit`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] px-2.5 py-1 rounded-md font-medium"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          >
            Channel brand kit
          </a>
        </div>
      </motion.div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
    >
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div className="text-xl font-bold mt-1" style={{ color: accent }}>
        {value}
      </div>
    </div>
  );
}
