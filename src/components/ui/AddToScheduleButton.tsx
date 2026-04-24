'use client';

// Inverse of the ScheduleLinkBanner: lets a standalone feature run drop its
// output into the schedule as a new item, so no generation is "lost" without
// a schedule home. Remembers the last-used channel in localStorage so the
// common single-channel creator has a one-click flow.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useRouter, useSearchParams } from 'next/navigation';
import { SCHEDULE_LINK_PARAM } from '@/lib/schedule-link';

type Channel = { id: string; name: string; account_color: string | null };

const LAST_CHANNEL_KEY = 'schedule:last-used-channel-id';

type Props = {
  /** Title for the new schedule item (usually the feature's topic). */
  title: string;
  /** Freeform context written into the item's notes field. */
  notes?: string;
  /** Content pillar/category hint written into `pillar`. */
  pillar?: string;
  /** Optional: starting status for the new item. Defaults to "idea". */
  initialStatus?: string;
  /** When true (default), replaces the page's URL with `?scheduleItemId=newId`
   *  so the current page becomes "linked" to the new item and subsequent
   *  completions write back. Set false if you just want a one-shot add. */
  autoLink?: boolean;
  className?: string;
  label?: string;
};

export function AddToScheduleButton({
  title, notes, pillar, initialStatus = 'idea', autoLink = true, className = '', label = '+ Add to schedule',
}: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [open, setOpen] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/channels').then(r => r.json()).then(d => {
      const list: Channel[] = d.channels || [];
      setChannels(list);
      if (list.length) {
        const last = typeof window !== 'undefined' ? localStorage.getItem(LAST_CHANNEL_KEY) : null;
        setChannelId(list.some(c => c.id === last) ? last : list[0].id);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function submit() {
    if (!title.trim()) { toast.error('Needs a title'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          status: initialStatus,
          notes: notes?.trim() || null,
          channel_ids: channelId ? [channelId] : [],
          custom_fields: pillar ? { } : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Failed'); return; }
      const newId: string | undefined = data.item?.id ?? data.id;
      if (!newId) { toast.error('No id returned'); return; }

      // If a pillar was suggested, stamp it via a follow-up PATCH (POST route
      // doesn't accept pillar directly — single source of truth for optional
      // fields is the PATCH handler).
      if (pillar) {
        await fetch(`/api/schedule/${newId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pillar }),
        });
      }
      if (channelId) localStorage.setItem(LAST_CHANNEL_KEY, channelId);

      toast.success('Added to schedule', {
        action: { label: 'Open', onClick: () => window.open(`/schedule?channel=${channelId ?? ''}`, '_blank') },
      });
      setOpen(false);

      // Auto-link: replace current URL so any subsequent completions on this
      // page write back to the freshly-created item.
      if (autoLink) {
        const params = new URLSearchParams(search?.toString() ?? '');
        params.set(SCHEDULE_LINK_PARAM, newId);
        router.replace(`?${params.toString()}`, { scroll: false });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (channels.length === 0) return null;

  return (
    <div ref={popRef} className={`relative inline-block ${className}`}>
      <button
        onClick={() => setOpen(v => !v)}
        disabled={!title.trim()}
        className="btn-secondary text-xs px-3 py-1.5"
        style={{ opacity: title.trim() ? 1 : 0.5 }}
        title={title.trim() ? 'Save this as a new video in your schedule' : 'Needs a title first'}
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 w-72 p-3 rounded-lg space-y-2"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}
        >
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            Add to schedule
          </div>
          <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }} title={title}>
            {title}
          </div>
          <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            Channel
            <select
              value={channelId ?? ''}
              onChange={e => setChannelId(e.currentTarget.value || null)}
              className="px-2 py-1 rounded text-sm"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="">(Unassigned)</option>
              {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={() => setOpen(false)} className="text-xs px-2 py-1" style={{ color: 'var(--text-muted)' }}>Cancel</button>
            <button onClick={submit} disabled={submitting}
              className="text-xs px-3 py-1 rounded-md"
              style={{ background: 'var(--accent-purple-bright)', color: 'white', opacity: submitting ? 0.6 : 1 }}>
              {submitting ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
