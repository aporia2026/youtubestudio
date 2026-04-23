'use client';

import { motion } from 'framer-motion';
import type { Channel } from './types';

type Props = {
  channels: Channel[];
  selectedId: string | null;       // null = "All channels"
  counts: Record<string, number>;  // channel id → count, key "__all" for total
  onSelect: (id: string | null) => void;
};

export function ChannelTabs({ channels, selectedId, counts, onSelect }: Props) {
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
    </div>
  );
}

function Tab({ active, onClick, color, label, count, allMode }: {
  active: boolean;
  onClick: () => void;
  color: string;
  label: string;
  count: number;
  allMode?: boolean;
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
    >
      {!allMode && (
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
