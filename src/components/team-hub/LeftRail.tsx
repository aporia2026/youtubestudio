'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  type RosterEntry,
  type RosterGroup,
  ROSTER_GROUP_LABELS,
  ROSTER_GROUP_ORDER,
  entryGroups,
  isIdle,
  totalWorkCount,
} from '@/lib/team-hub-types';

/**
 * Left rail of /team-hub. Searchable, role-grouped roster of every
 * collaborator + channel editor in the workspace.
 *
 * Filter chips at the top narrow the visible set:
 *   - all          → everyone with any work or no filter applied
 *   - has-work     → entries with at least one active assignment / link
 *   - idle-7d      → entries idle for 7+ days (or never accessed)
 *
 * Selection is reflected back to the parent via `onSelect`. The currently
 * selected entry id is highlighted; clicking the same row again is a
 * no-op (parent decides whether re-clicking does anything).
 */

export const LEFT_RAIL_FILTERS = ['all', 'has-work', 'idle-7d'] as const;
export type LeftRailFilter = (typeof LEFT_RAIL_FILTERS)[number];

const FILTER_LABELS: Record<LeftRailFilter, string> = {
  'all': 'All',
  'has-work': 'Has work',
  'idle-7d': 'Idle 7d+',
};

const ROLE_DOT_COLOR: Record<RosterGroup, string> = {
  narrator: '#7c3aed',
  editor: '#3b82f6',
  reviewer: '#06b6d4',
  client: '#eab308',
  channel_editor: '#f59e0b',
};

interface LeftRailProps {
  entries: RosterEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (s: string) => void;
  filter: LeftRailFilter;
  onFilterChange: (f: LeftRailFilter) => void;
  onAddPerson: () => void;
  loading: boolean;
}

function applyFilter(entry: RosterEntry, filter: LeftRailFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'has-work') return totalWorkCount(entry) > 0;
  if (filter === 'idle-7d') return isIdle(entry, 7);
  return true;
}

function applySearch(entry: RosterEntry, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (entry.name.toLowerCase().includes(needle)) return true;
  if (entry.email && entry.email.toLowerCase().includes(needle)) return true;
  if (entry.channel_name && entry.channel_name.toLowerCase().includes(needle)) return true;
  return false;
}

export function LeftRail({
  entries,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  onAddPerson,
  loading,
}: LeftRailProps) {
  const grouped = useMemo(() => {
    const filtered = entries.filter((e) => applyFilter(e, filter) && applySearch(e, search));
    const map = new Map<RosterGroup, RosterEntry[]>();
    for (const g of ROSTER_GROUP_ORDER) map.set(g, []);
    for (const e of filtered) {
      for (const g of entryGroups(e)) {
        map.get(g)!.push(e);
      }
    }
    return map;
  }, [entries, filter, search]);

  const totalVisible = useMemo(() => {
    let n = 0;
    for (const list of grouped.values()) n += list.length;
    return n;
  }, [grouped]);

  return (
    <aside
      className="flex flex-col shrink-0 h-full border-r"
      style={{
        width: 280,
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
      }}
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
            Team
          </h2>
          <button
            onClick={onAddPerson}
            className="text-xs px-2.5 py-1 rounded-md font-medium text-white"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
            title="Add a new collaborator or channel editor"
          >
            + Add
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search name or email"
            className="w-full pl-8 pr-3 py-1.5 rounded-md text-xs outline-none"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
          />
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{ color: 'var(--text-muted)' }}
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>

        {/* Filter chips */}
        <div className="flex gap-1">
          {LEFT_RAIL_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => onFilterChange(f)}
              className="text-[10px] px-2 py-1 rounded-full font-medium transition-colors"
              style={{
                background: filter === f ? 'rgba(124,58,237,0.18)' : 'transparent',
                color: filter === f ? '#a78bfa' : 'var(--text-muted)',
                border: `1px solid ${filter === f ? '#a78bfa' : 'var(--border)'}`,
              }}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable roster */}
      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
            Loading roster…
          </div>
        ) : totalVisible === 0 ? (
          <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
            {search || filter !== 'all'
              ? 'No matches.'
              : 'No team members yet. Click + Add to start.'}
          </div>
        ) : (
          ROSTER_GROUP_ORDER.map((group) => {
            const list = grouped.get(group) || [];
            if (list.length === 0) return null;
            return (
              <section key={group} className="mb-2">
                <header className="px-4 py-1.5 flex items-center justify-between">
                  <span
                    className="text-[10px] uppercase tracking-wider font-semibold"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {ROSTER_GROUP_LABELS[group]}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {list.length}
                  </span>
                </header>
                <div className="space-y-px">
                  {list.map((entry) => (
                    <RosterRow
                      key={`${group}:${entry.id}`}
                      entry={entry}
                      group={group}
                      selected={entry.id === selectedId}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}

interface RosterRowProps {
  entry: RosterEntry;
  group: RosterGroup;
  selected: boolean;
  onSelect: (id: string) => void;
}

function RosterRow({ entry, group, selected, onSelect }: RosterRowProps) {
  const work = totalWorkCount(entry);
  const subtitle =
    entry.kind === 'channel_editor'
      ? `Editor of ${entry.channel_name ?? 'channel'}`
      : work > 0
        ? `${work} active`
        : entry.email ?? 'No active work';

  return (
    <motion.button
      type="button"
      onClick={() => onSelect(entry.id)}
      whileHover={{ x: 2 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      className="w-full text-left px-4 py-2 flex items-center gap-3 transition-colors"
      style={{
        background: selected ? 'rgba(124,58,237,0.14)' : 'transparent',
        borderLeft: `2px solid ${selected ? ROLE_DOT_COLOR[group] : 'transparent'}`,
      }}
    >
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white shrink-0"
        style={{ background: entry.color }}
      >
        {(entry.name || '?')[0]?.toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-[12px] font-medium truncate"
          style={{ color: selected ? '#fff' : 'var(--text-primary)' }}
        >
          {entry.name}
        </div>
        <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
          {subtitle}
        </div>
      </div>
      {work > 0 && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
          style={{ background: 'rgba(124,58,237,0.2)', color: '#c4b5fd' }}
        >
          {work}
        </span>
      )}
    </motion.button>
  );
}
