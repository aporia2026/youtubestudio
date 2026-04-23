'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import type { Channel } from './types';

export type Command = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  items: ScheduleItem[];
  channels: Channel[];
  statuses: ScheduleStatus[];
  onGoto: (patch: { channel?: string | null; view?: string; status?: string | null }) => void;
  onSelectItem: (id: string) => void;
  onNewItem: () => void;
  onPatch: (id: string, patch: Partial<ScheduleItem>) => void;
};

export function CommandPalette({
  open, onClose, items, channels, statuses,
  onGoto, onSelectItem, onNewItem, onPatch,
}: Props) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      // Focus after animation
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];

    cmds.push({ id: 'new', label: 'New video slot', hint: 'Create', group: 'Actions', run: onNewItem });
    cmds.push({ id: 'view-list', label: 'Switch to List view', group: 'Views', run: () => onGoto({ view: 'list' }) });
    cmds.push({ id: 'view-calendar', label: 'Switch to Calendar view', group: 'Views', run: () => onGoto({ view: 'calendar' }) });
    cmds.push({ id: 'view-spreadsheet', label: 'Switch to Spreadsheet view', group: 'Views', run: () => onGoto({ view: 'spreadsheet' }) });
    cmds.push({ id: 'view-kanban', label: 'Switch to Kanban view', group: 'Views', run: () => onGoto({ view: 'kanban' }) });

    cmds.push({ id: 'ch-all', label: 'All channels', group: 'Channels', run: () => onGoto({ channel: null }) });
    for (const c of channels) {
      cmds.push({ id: `ch-${c.id}`, label: c.name, hint: 'Channel', group: 'Channels', run: () => onGoto({ channel: c.id }) });
    }

    for (const s of statuses) {
      cmds.push({
        id: `filter-${s.key}`, label: `Filter: ${s.label}`, hint: 'Status filter', group: 'Filters',
        run: () => onGoto({ status: s.key }),
      });
    }
    cmds.push({ id: 'filter-clear', label: 'Clear status filter', group: 'Filters', run: () => onGoto({ status: null }) });

    // Per-item commands: open + move-to-status shortcuts for the top 40 items (capped).
    for (const it of items.slice(0, 40)) {
      cmds.push({
        id: `open-${it.id}`,
        label: it.title || 'Untitled',
        hint: `Open · ${it.status}`,
        group: 'Items',
        run: () => onSelectItem(it.id),
      });
      for (const s of statuses) {
        if (s.key === it.status) continue;
        cmds.push({
          id: `move-${it.id}-${s.key}`,
          label: `Move "${(it.title || 'Untitled').slice(0, 40)}" → ${s.label}`,
          hint: 'Status',
          group: 'Move',
          run: () => onPatch(it.id, { status: s.key }),
        });
      }
    }

    return cmds;
  }, [channels, statuses, items, onGoto, onSelectItem, onNewItem, onPatch]);

  // Fuzzy-ish: keep order, match by substring across label+hint+group.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands.slice(0, 20);
    const tokens = needle.split(/\s+/);
    return commands.filter(c => {
      const hay = `${c.label} ${c.hint ?? ''} ${c.group}`.toLowerCase();
      return tokens.every(t => hay.includes(t));
    }).slice(0, 30);
  }, [q, commands]);

  useEffect(() => { setIdx(0); }, [q]);

  function run(c: Command) {
    c.run();
    onClose();
  }

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4"
        style={{ background: 'rgba(0,0,0,0.6)' }}
      >
        <motion.div
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); const c = filtered[idx]; if (c) run(c); }
            else if (e.key === 'Escape') onClose();
          }}
          className="w-full max-w-lg rounded-xl overflow-hidden"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }}
        >
          <div className="flex items-center gap-2 px-3 py-2.5"
            style={{ borderBottom: '1px solid var(--border)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.currentTarget.value)}
              placeholder="Type a command — move, filter, open, switch view…"
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--text-primary)' }}
            />
            <span className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
              ESC
            </span>
          </div>
          <div className="max-h-[50vh] overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="px-4 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No matches
              </div>
            )}
            {filtered.map((c, i) => (
              <button
                key={c.id}
                onClick={() => run(c)}
                onMouseEnter={() => setIdx(i)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm"
                style={{
                  background: i === idx ? 'rgba(124,58,237,0.15)' : 'transparent',
                  color: 'var(--text-primary)',
                }}
              >
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                  {c.group}
                </span>
                <span className="flex-1 truncate">{c.label}</span>
                {c.hint && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{c.hint}</span>}
              </button>
            ))}
          </div>
          <div className="px-3 py-2 text-[10px] flex items-center justify-between"
            style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            <span>↑↓ Navigate · ↵ Run</span>
            <span>Cmd/Ctrl+K to toggle</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
