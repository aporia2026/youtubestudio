'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { ListView } from './ListView';
import { CalendarView } from './CalendarView';
import { SpreadsheetView } from './SpreadsheetView';
import { ItemDetail } from './ItemDetail';
import { NewItemDialog } from './NewItemDialog';
import { ChannelTabs } from './ChannelTabs';
import { ExportMenu } from './ExportMenu';
import type { Channel } from './types';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';

type ViewMode = 'list' | 'calendar' | 'spreadsheet';

const VIEW_TABS: Array<{ key: ViewMode; label: string; icon: React.ReactNode }> = [
  { key: 'list',        label: 'List',        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> },
  { key: 'calendar',    label: 'Calendar',    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
  { key: 'spreadsheet', label: 'Spreadsheet', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg> },
];

export default function SchedulePageWrapper() {
  // useSearchParams needs a Suspense boundary in Next 16.
  return (
    <Suspense fallback={<div className="py-20 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <SchedulePage />
    </Suspense>
  );
}

function SchedulePage() {
  const router = useRouter();
  const search = useSearchParams();

  // URL state is the source of truth so channel + view are shareable/bookmarkable.
  const channelId = search.get('channel');        // null | "<uuid>"
  const viewParam = (search.get('view') ?? 'list') as ViewMode;
  const view: ViewMode = ['list', 'calendar', 'spreadsheet'].includes(viewParam) ? viewParam : 'list';
  const statusFilter = search.get('status');
  const searchText = search.get('q') ?? '';

  const [items, setItems] = useState<ScheduleItem[]>([]);         // channel-scoped items
  const [allCounts, setAllCounts] = useState<Record<string, number>>({}); // tabs counts across channels
  const [channels, setChannels] = useState<Channel[]>([]);
  const [statuses, setStatuses] = useState<ScheduleStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // URL helpers — keep a single "update URL" function so we never drop existing params.
  const updateUrl = useCallback((patch: Record<string, string | null>) => {
    const params = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    }
    router.replace(`/schedule?${params.toString()}`, { scroll: false });
  }, [router, search]);

  const fetchItems = useCallback(async () => {
    const params = new URLSearchParams();
    if (channelId) params.set('channel_id', channelId);
    if (statusFilter) params.set('status', statusFilter);
    if (searchText) params.set('search', searchText);
    const res = await fetch(`/api/schedule?${params.toString()}`);
    const data = await res.json();
    setItems(data.items || []);
  }, [channelId, statusFilter, searchText]);

  // Fetch the unfiltered set once to compute channel-tab counts, and refresh on mutations.
  const fetchCounts = useCallback(async () => {
    const res = await fetch('/api/schedule');
    const data = await res.json();
    const all: ScheduleItem[] = data.items || [];
    const counts: Record<string, number> = { __all: all.length };
    for (const it of all) {
      for (const c of it.channels ?? []) {
        counts[c.id] = (counts[c.id] ?? 0) + 1;
      }
    }
    setAllCounts(counts);
  }, []);

  // Channels + counts fetch ONCE on mount + on explicit mutations (via fetchCounts called from patch/delete).
  // Changing filters must not re-download these.
  useEffect(() => {
    fetch('/api/channels').then(r => r.json()).then(d => setChannels(d.channels || []));
    fetchCounts();
  }, [fetchCounts]);

  // Items refetch when the scope (channel / status / search) changes.
  useEffect(() => {
    setLoading(true);
    let cancelled = false;
    fetchItems().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchItems]);

  // Statuses follow the active channel; abort-on-switch to avoid last-write-wins.
  useEffect(() => {
    const controller = new AbortController();
    const url = channelId ? `/api/schedule/statuses?channel_id=${channelId}` : '/api/schedule/statuses';
    fetch(url, { signal: controller.signal })
      .then(r => r.json()).then(d => setStatuses(d.statuses || []))
      .catch(err => { if (err.name !== 'AbortError') console.error(err); });
    return () => controller.abort();
  }, [channelId]);

  const patchItem = useCallback(async (id: string, patch: Partial<ScheduleItem> & { channel_ids?: string[] }) => {
    setItems(curr => curr.map(it => (it.id === id ? { ...it, ...patch } : it)));
    const res = await fetch(`/api/schedule/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast.error('Update failed');
      fetchItems();
    }
    // Channel assignments change the counts — refresh them if channel_ids was patched.
    if (patch.channel_ids) fetchCounts();
  }, [fetchItems, fetchCounts]);

  const deleteItem = useCallback(async (id: string, alsoChildren = false) => {
    const res = await fetch(`/api/schedule/${id}?children=${alsoChildren}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('Deleted');
      fetchItems();
      fetchCounts();
      if (selected === id) setSelected(null);
    } else {
      toast.error('Delete failed');
    }
  }, [fetchItems, fetchCounts, selected]);

  const selectedItem = useMemo(
    () => items.find(i => i.id === selected) ?? null,
    [items, selected],
  );

  const selectedChannel = useMemo(
    () => channels.find(c => c.id === channelId) ?? null,
    [channels, channelId],
  );

  const scopeLabel = selectedChannel?.name ?? 'All channels';
  const scopeColor = selectedChannel?.account_color ?? '#7c3aed';

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <div className="max-w-[1600px] mx-auto px-6 py-6">
        {/* Header — title reflects the active channel scope */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${scopeColor}, ${scopeColor}99)` }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{scopeLabel}</h1>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {selectedChannel
                  ? `Schedule for ${selectedChannel.name}`
                  : 'Plan, track, and edit every video across your channels'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ExportMenu items={items} statuses={statuses} scopeLabel={scopeLabel} />
            <button
              onClick={() => setCreating(true)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
              style={{ background: `linear-gradient(135deg, ${scopeColor}, #06b6d4)`, color: 'white' }}
            >
              + New video
            </button>
          </div>
        </div>

        {/* Channel tabs */}
        <ChannelTabs
          channels={channels}
          selectedId={channelId}
          counts={allCounts}
          onSelect={id => updateUrl({ channel: id })}
        />

        {/* Filter + view switcher */}
        <div className="flex flex-wrap items-center gap-2 mb-4 p-3 rounded-lg"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <select
            value={statusFilter ?? ''}
            onChange={e => updateUrl({ status: e.target.value || null })}
            className="px-3 py-1.5 rounded-md text-sm"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          >
            <option value="">All statuses</option>
            {statuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>

          <input
            type="text"
            placeholder="Search title or notes"
            defaultValue={searchText}
            onKeyDown={e => { if (e.key === 'Enter') updateUrl({ q: (e.currentTarget.value || null) }); }}
            onBlur={e => updateUrl({ q: (e.currentTarget.value || null) })}
            className="flex-1 min-w-[200px] px-3 py-1.5 rounded-md text-sm"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          />

          {(statusFilter || searchText) && (
            <button
              onClick={() => updateUrl({ status: null, q: null })}
              className="text-xs px-2 py-1 rounded"
              style={{ color: 'var(--text-muted)' }}
            >
              Clear filters
            </button>
          )}

          <div className="ml-auto flex gap-1 p-1 rounded-lg"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
            {VIEW_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => updateUrl({ view: tab.key })}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all"
                style={{
                  background: view === tab.key ? 'var(--bg-secondary)' : 'transparent',
                  color: view === tab.key ? scopeColor : 'var(--text-muted)',
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <motion.div key={`${view}-${channelId ?? 'all'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {loading ? (
            <div className="py-20 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>
          ) : view === 'list' ? (
            <ListView items={items} statuses={statuses} channels={channels}
              onSelect={setSelected} onPatch={patchItem} onDelete={deleteItem} />
          ) : view === 'calendar' ? (
            <CalendarView items={items} statuses={statuses}
              onSelect={setSelected} onPatch={patchItem} />
          ) : (
            <SpreadsheetView items={items} statuses={statuses} channels={channels}
              onSelect={setSelected} onPatch={patchItem} onDelete={deleteItem} onRefresh={fetchItems} />
          )}
        </motion.div>
      </div>

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          channels={channels}
          statuses={statuses}
          onClose={() => setSelected(null)}
          onPatch={patchItem}
          onDelete={deleteItem}
          onRefresh={fetchItems}
        />
      )}

      {creating && (
        <NewItemDialog
          channels={channels}
          statuses={statuses}
          defaultChannelId={channelId}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); fetchItems(); fetchCounts(); }}
        />
      )}
    </div>
  );
}
