'use client';

import { motion } from 'framer-motion';
import type { Channel } from './types';

export const UNASSIGNED_CHANNEL_ID = '__unassigned';

type Props = {
  channels: Channel[];
  selectedId: string | null;       // null = "All channels", "__unassigned" = orphans
  counts: Record<string, number>;  // channel id → count, "__all" for total, "__unassigned" for orphans
  onSelect: (id: string | null) => void;
};

export function ChannelTabs({ channels, selectedId, counts, onSelect }: Props) {
  const unassignedCount = counts[UNASSIGNED_CHANNEL_ID] ?? 0;
  return (
    <div className="flex items-center gap-1 mb-4 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
      <Tab
        active={selectedId === null}
        onClick={() => onSelect(null)}
        color="#7c3aed"
        label="All channels"
        count={counts.__all ?? 0}
        allMode
      />
      {channels.map(c => (
        <Tab
          key={c.id}
          active={selectedId === c.id}
          onClick={() => onSelect(c.id)}
          color={c.account_color || '#7c3aed'}
          label={c.name}
          count={counts[c.id] ?? 0}
        />
      ))}
      {unassignedCount > 0 && (
        <Tab
          active={selectedId === UNASSIGNED_CHANNEL_ID}
          onClick={() => onSelect(UNASSIGNED_CHANNEL_ID)}
          color="#f59e0b"
          label="Unassigned"
          count={unassignedCount}
          unassigned
        />
      )}
    </div>
  );
}

function Tab({ active, onClick, color, label, count, allMode, unassigned }: {
  active: boolean;
  onClick: () => void;
  color: string;
  label: string;
  count: number;
  allMode?: boolean;
  unassigned?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all"
      style={{
        background: active ? `${color}22` : 'var(--bg-secondary)',
        color: active ? color : 'var(--text-secondary)',
        border: `1px solid ${active ? color + '55' : 'var(--border)'}`,
      }}
      title={unassigned ? 'Items not assigned to any channel yet — bulk-assign from the list view' : undefined}
    >
      {!allMode && !unassigned && (
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      )}
      {allMode && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" rx="1"/>
          <rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/>
          <rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
      )}
      {unassigned && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      )}
      <span>{label}</span>
      <span
        className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
        style={{
          background: active ? color + '33' : 'var(--bg-tertiary)',
          color: active ? color : 'var(--text-muted)',
        }}
      >
        {count}
      </span>
      {active && (
        <motion.div
          layoutId="channel-tab-underline"
          className="absolute left-2 right-2 -bottom-1 h-0.5 rounded-full"
          style={{ background: color }}
        />
      )}
    </button>
  );
}
