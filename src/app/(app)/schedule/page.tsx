'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { ListView } from './ListView';
import { CalendarView } from './CalendarView';
import { SpreadsheetView } from './SpreadsheetView';
import { KanbanView } from './KanbanView';
import { ItemDetail } from './ItemDetail';
import { NewItemDialog } from './NewItemDialog';
import { ChannelTabs, UNASSIGNED_CHANNEL_ID } from './ChannelTabs';
import { ExportMenu } from './ExportMenu';
import { HealthWidget } from './HealthWidget';
import { CommandPalette } from './CommandPalette';
import { SuggestNextDialog } from './SuggestNextDialog';
import { ShareDialog } from './ShareDialog';
import { SavedViewsMenu } from './SavedViewsMenu';
import { ChecklistTemplatesDialog } from './ChecklistTemplatesDialog';
import type { Channel } from './types';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import { listSeries, type Series } from '@/lib/series';

type ViewMode = 'list' | 'calendar' | 'spreadsheet' | 'kanban';

const VIEW_TABS: Array<{ key: ViewMode; label: string; icon: React.ReactNode }> = [
  { key: 'kanban',      label: 'Kanban',      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="4" height="15" rx="1"/></svg> },
  { key: 'calendar',    label: 'Calendar',    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
  { key: 'list',        label: 'List',        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> },
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
  const channelId = search.get('channel');        // null | "<uuid>" | "__unassigned"
  // `channelId` carries the virtual "__unassigned" sentinel for tab UI, but
  // downstream dialogs/APIs expect a real UUID or null — using `realChannelId`
  // for those prevents "__unassigned" from leaking into SQL uuid casts.
  const realChannelId: string | null = channelId === UNASSIGNED_CHANNEL_ID ? null : channelId;
  const viewParam = (search.get('view') ?? 'kanban') as ViewMode;
  const view: ViewMode = ['list', 'calendar', 'spreadsheet', 'kanban'].includes(viewParam) ? viewParam : 'kanban';
  const statusFilter = search.get('status');
  const searchText = search.get('q') ?? '';
  const seriesFilter = search.get('series');         // null | "<uuid>"
  const groupBySeries = search.get('group') === 'series';
  const density = (search.get('density') === 'compact' ? 'compact' : 'comfortable') as 'comfortable' | 'compact';

  const [items, setItems] = useState<ScheduleItem[]>([]);         // channel-scoped items
  const [allCounts, setAllCounts] = useState<Record<string, number>>({}); // tabs counts across channels
  const [channels, setChannels] = useState<Channel[]>([]);
  const [statuses, setStatuses] = useState<ScheduleStatus[]>([]);
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  // Cmd+K / Ctrl+K opens command palette; "n" creates a new item when nothing's focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(p => !p);
      } else if (!typing && e.key === 'n') {
        e.preventDefault();
        setCreating(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    if (seriesFilter) params.set('series_id', seriesFilter);
    const res = await fetch(`/api/schedule?${params.toString()}`);
    const data = await res.json();
    setItems(data.items || []);
  }, [channelId, statusFilter, searchText, seriesFilter]);

  // Fetch the unfiltered set once to compute channel-tab counts, and refresh on mutations.
  const fetchCounts = useCallback(async () => {
    const res = await fetch('/api/schedule');
    const data = await res.json();
    const all: ScheduleItem[] = data.items || [];
    const counts: Record<string, number> = { __all: all.length };
    let unassigned = 0;
    for (const it of all) {
      const channels = it.channels ?? [];
      if (channels.length === 0) unassigned++;
      for (const c of channels) {
        counts[c.id] = (counts[c.id] ?? 0) + 1;
      }
    }
    counts[UNASSIGNED_CHANNEL_ID] = unassigned;
    setAllCounts(counts);
  }, []);

  // Channels + counts fetch ONCE on mount + on explicit mutations (via fetchCounts called from patch/delete).
  // Changing filters must not re-download these.
  useEffect(() => {
    fetch('/api/channels').then(r => r.json()).then(d => setChannels(d.channels || []));
    fetchCounts();
  }, [fetchCounts]);

  // If the user is viewing Unassigned and the count drops to 0 (e.g. they
  // just bulk-assigned the last orphan), the tab disappears from the header
  // but the URL still reads `?channel=__unassigned` — scope title stays as
  // "Unassigned" over an empty list. Send them back to All channels.
  useEffect(() => {
    if (channelId === UNASSIGNED_CHANNEL_ID && (allCounts[UNASSIGNED_CHANNEL_ID] ?? 0) === 0 && Object.keys(allCounts).length > 0) {
      updateUrl({ channel: null });
    }
  }, [channelId, allCounts, updateUrl]);

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
    // Unassigned tab uses the global default pipeline — realChannelId strips "__unassigned".
    const url = realChannelId ? `/api/schedule/statuses?channel_id=${realChannelId}` : '/api/schedule/statuses';
    fetch(url, { signal: controller.signal })
      .then(r => r.json()).then(d => setStatuses(d.statuses || []))
      .catch(err => { if (err.name !== 'AbortError') console.error(err); });
    return () => controller.abort();
  }, [realChannelId]);

  // Load series for the filter dropdown. Cheap list fetch (lib has a 30s cache).
  useEffect(() => {
    listSeries({ channelId: realChannelId || undefined }).then(setSeriesList).catch(() => {});
  }, [realChannelId]);

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

  // When "Group by series" is on, sort items so parts of the same series sit
  // next to each other, ordered by part_number. Keeps series-less items at the
  // top so the default experience doesn't surprise users who haven't adopted
  // the feature yet.
  const displayItems = useMemo(() => {
    if (!groupBySeries) return items;
    return [...items].sort((a, b) => {
      const aHas = a.series_title ? 1 : 0;
      const bHas = b.series_title ? 1 : 0;
      if (aHas !== bHas) return aHas - bHas; // unseried first
      if (aHas && bHas) {
        const byTitle = (a.series_title || '').localeCompare(b.series_title || '');
        if (byTitle !== 0) return byTitle;
        return (a.part_number || 0) - (b.part_number || 0);
      }
      // Fallback: preserve original order
      return 0;
    });
  }, [items, groupBySeries]);

  const isUnassignedScope = channelId === UNASSIGNED_CHANNEL_ID;
  const scopeLabel = isUnassignedScope ? 'Unassigned' : (selectedChannel?.name ?? 'All channels');
  const scopeColor = isUnassignedScope ? '#f59e0b' : (selectedChannel?.account_color ?? '#7c3aed');

  return (
    <div className="min-h-screen" data-density={density} style={{ background: 'var(--bg-primary)' }}>
      <div className="max-w-[1600px] mx-auto px-6 py-6">
        {/* Header — title reflects the active channel scope */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-5 gap-3">
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
                {isUnassignedScope
                  ? 'Videos not assigned to any channel — select and assign them in bulk from the list view'
                  : selectedChannel
                    ? `Schedule for ${selectedChannel.name}`
                    : 'Plan, track, and edit every video across your channels'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <HealthWidget items={items} statuses={statuses} onSelect={setSelected} />
            <button
              onClick={() => setSuggestOpen(true)}
              title="AI suggests what to make next"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.4)' }}
            >
              ✨ What next
            </button>
            <button
              onClick={() => setShareOpen(true)}
              title="Create a read-only share link"
              className="p-2 rounded-lg"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
            </button>
            <button
              onClick={() => setPaletteOpen(true)}
              title="Command palette (Cmd+K)"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              ⌘K
            </button>
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

          {seriesList.length > 0 && (
            <select
              value={seriesFilter ?? ''}
              onChange={e => updateUrl({ series: e.target.value || null })}
              className="px-3 py-1.5 rounded-md text-sm"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Filter by series"
            >
              <option value="">All series</option>
              {seriesList.map(s => (
                <option key={s.id} value={s.id}>📺 {s.title}{s.part_count ? ` (${s.part_count})` : ''}</option>
              ))}
            </select>
          )}

          {seriesList.length > 0 && (
            <label className="flex items-center gap-1.5 px-2 py-1.5 rounded text-xs cursor-pointer"
              style={{ background: groupBySeries ? 'rgba(6,182,212,0.15)' : 'var(--bg-tertiary)', color: groupBySeries ? '#06b6d4' : 'var(--text-muted)', border: '1px solid var(--border)' }}>
              <input
                type="checkbox"
                checked={groupBySeries}
                onChange={e => updateUrl({ group: e.target.checked ? 'series' : null })}
                style={{ accentColor: '#06b6d4' }}
              />
              Group by series
            </label>
          )}

          <input
            type="text"
            placeholder="Search title or notes"
            defaultValue={searchText}
            onKeyDown={e => { if (e.key === 'Enter') updateUrl({ q: (e.currentTarget.value || null) }); }}
            onBlur={e => updateUrl({ q: (e.currentTarget.value || null) })}
            className="flex-1 min-w-[200px] px-3 py-1.5 rounded-md text-sm"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          />

          {(statusFilter || searchText || seriesFilter || groupBySeries) && (
            <button
              onClick={() => updateUrl({ status: null, q: null, series: null, group: null })}
              className="text-xs px-2 py-1 rounded"
              style={{ color: 'var(--text-muted)' }}
            >
              Clear filters
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setTemplatesOpen(true)}
              title="Edit stage checklists"
              className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
              ☑ Checklists
            </button>
            <SavedViewsMenu
              channelId={realChannelId}
              currentConfig={{ view, status: statusFilter, q: searchText, density }}
              onApply={v => updateUrl({
                view: v.config.view ?? 'kanban',
                status: v.config.status ?? null,
                q: v.config.q ?? null,
                density: v.config.density ?? null,
                channel: v.channel_id,
              })}
            />
          </div>
          <button
            onClick={() => updateUrl({ density: density === 'compact' ? null : 'compact' })}
            title={density === 'compact' ? 'Switch to comfortable density' : 'Switch to compact density'}
            className="p-2 rounded-lg text-xs"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
          >
            {density === 'compact'
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17" x2="21" y2="17"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>}
          </button>

          <div className="flex gap-1 p-1 rounded-lg"
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
        <motion.div key={`${view}-${channelId ?? 'all'}-${groupBySeries ? 'g' : 'u'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {loading ? (
            <div className="py-20 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>
          ) : view === 'kanban' ? (
            <KanbanView items={displayItems} statuses={statuses} channels={channels}
              onSelect={setSelected} onPatch={patchItem} />
          ) : view === 'list' ? (
            <ListView items={displayItems} statuses={statuses} channels={channels}
              onSelect={setSelected} onPatch={patchItem} onDelete={deleteItem}
              onRefresh={() => { fetchItems(); fetchCounts(); }} />
          ) : view === 'calendar' ? (
            <CalendarView items={displayItems} statuses={statuses} channelId={realChannelId}
              onSelect={setSelected} onPatch={patchItem} />
          ) : (
            <SpreadsheetView items={displayItems} statuses={statuses} channels={channels}
              onSelect={setSelected} onPatch={patchItem} onDelete={deleteItem} onRefresh={fetchItems} />
          )}
        </motion.div>
      </div>

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          channels={channels}
          statuses={statuses}
          allItems={items}
          onClose={() => setSelected(null)}
          onPatch={patchItem}
          onDelete={deleteItem}
          onRefresh={fetchItems}
          onSelectItem={setSelected}
        />
      )}

      {creating && (
        <NewItemDialog
          channels={channels}
          statuses={statuses}
          defaultChannelId={realChannelId}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); fetchItems(); fetchCounts(); }}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={items}
        channels={channels}
        statuses={statuses}
        onGoto={updateUrl}
        onSelectItem={setSelected}
        onNewItem={() => setCreating(true)}
        onPatch={patchItem}
      />

      {suggestOpen && (
        <SuggestNextDialog
          channelId={realChannelId}
          channelName={scopeLabel}
          onClose={() => setSuggestOpen(false)}
          onCreated={() => { setSuggestOpen(false); fetchItems(); fetchCounts(); }}
        />
      )}

      {shareOpen && (
        <ShareDialog
          channelId={realChannelId}
          channelName={scopeLabel}
          onClose={() => setShareOpen(false)}
        />
      )}

      {templatesOpen && (
        <ChecklistTemplatesDialog
          channelId={realChannelId}
          channelName={scopeLabel}
          statuses={statuses}
          onClose={() => setTemplatesOpen(false)}
        />
      )}
    </div>
  );
}
