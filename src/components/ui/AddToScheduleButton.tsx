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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch('/api/channels', { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        if (!mountedRef.current) return;
        const list: Channel[] = d.channels || [];
        setChannels(list);
        if (list.length) {
          const last = typeof window !== 'undefined' ? localStorage.getItem(LAST_CHANNEL_KEY) : null;
          setChannelId(list.some(c => c.id === last) ? last : list[0].id);
        }
      })
      .catch(err => { if (err.name !== 'AbortError') console.error(err); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function submit() {
    if (!title.trim()) { toast.error('Needs a title'); return; }
    setSubmitting(true);
    try {
      // Server accepts `pillar` on POST now, so we save the artifact in one
      // round-trip. No follow-up PATCH means no silent half-written state.
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          status: initialStatus,
          notes: notes?.trim() || null,
          channel_ids: channelId ? [channelId] : [],
          pillar: pillar?.trim() || null,
        }),
      });
      const data = await res.json();
      if (!mountedRef.current) return;
      if (!res.ok) { toast.error(data.error || 'Failed'); return; }
      const newId: string | undefined = data.item?.id ?? data.id;
      if (!newId) { toast.error('No id returned'); return; }

      if (channelId) localStorage.setItem(LAST_CHANNEL_KEY, channelId);

      toast.success('Added to schedule', {
        action: {
          label: 'Open',
          onClick: () => window.open(`/schedule?channel=${channelId ?? ''}`, '_blank'),
        },
      });
      setOpen(false);

      // Auto-link: replace current URL so any subsequent completions on this
      // page write back to the freshly-created item. The feature page's
      // preload effect uses functional setters (`prev || item.value`), so
      // the URL change won't clobber state the user has already entered.
      if (autoLink) {
        const params = new URLSearchParams(search?.toString() ?? '');
        params.set(SCHEDULE_LINK_PARAM, newId);
        router.replace(`?${params.toString()}`, { scroll: false });
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  // Render even with zero channels — offer (Unassigned) so a brand-new user
  // isn't silently blocked from adding generations to the schedule.
  const noChannelsAllowed = channels.length === 0;

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
          className="absolute right-0 top-full mt-1 z-30 w-72 max-w-[calc(100vw-2rem)] p-3 rounded-lg space-y-2"
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
              autoFocus
              value={channelId ?? ''}
              onChange={e => setChannelId(e.currentTarget.value || null)}
              className="px-2 py-1 rounded text-sm"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="">(Unassigned)</option>
              {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {noChannelsAllowed && (
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                No channels configured yet — it will be saved as Unassigned.
              </span>
            )}
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
