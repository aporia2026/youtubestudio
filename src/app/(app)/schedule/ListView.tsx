'use client';

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import { statusColor, statusLabel } from '@/lib/schedule';
import type { Channel } from './types';

type Props = {
  items: ScheduleItem[];
  statuses: ScheduleStatus[];
  channels: Channel[];
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Partial<ScheduleItem>) => void;
  onDelete: (id: string, alsoChildren?: boolean) => void;
};

function formatWhen(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ListView({ items, statuses, onSelect, onPatch, onDelete }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  function toggle(id: string) {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  async function bulkStatus(status: string) {
    await Promise.all(Array.from(selected).map(id => onPatch(id, { status })));
    toast.success(`Updated ${selected.size} items`);
    setSelected(new Set());
  }
  async function bulkDelete() {
    if (!window.confirm(`Delete ${selected.size} items?`)) return;
    // Pass alsoChildren=true when the row is a recurrence parent so children
    // don't become orphaned. Row-level delete already does this.
    await Promise.all(
      Array.from(selected).map(id => {
        const it = items.find(x => x.id === id);
        return onDelete(id, !!it?.recurrence);
      }),
    );
    setSelected(new Set());
  }
  // Group by week bucket, plus a backlog for unscheduled.
  const groups = useMemo(() => {
    const byBucket = new Map<string, ScheduleItem[]>();
    for (const item of items) {
      const bucket = item.scheduled_for
        ? new Date(item.scheduled_for).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
        : 'Unscheduled (backlog)';
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket)!.push(item);
    }
    return Array.from(byBucket.entries());
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="py-20 text-center rounded-lg"
        style={{ background: 'var(--bg-secondary)', border: '1px dashed var(--border)', color: 'var(--text-muted)' }}>
        Nothing scheduled yet. Click <strong>New video</strong> or add an idea to the schedule.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="sticky top-4 z-10 flex items-center gap-2 px-3 py-2 rounded-lg"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--accent-purple-bright)', boxShadow: '0 4px 20px rgba(124,58,237,0.2)' }}
          >
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {selected.size} selected
            </span>
            <select
              onChange={e => { if (e.target.value) { bulkStatus(e.target.value); e.target.value = ''; } }}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
              <option value="">Set status…</option>
              {statuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <button onClick={bulkDelete}
              className="text-xs px-3 py-1 rounded-md"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
              Delete
            </button>
            <button onClick={() => setSelected(new Set())}
              className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
              Clear
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {groups.map(([bucket, list]) => (
        <div key={bucket}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color: 'var(--text-muted)' }}>{bucket} · {list.length}</h3>
          <div className="space-y-1.5">
            {list.map(item => (
              <motion.div
                key={item.id}
                whileHover={{ x: 2 }}
                onClick={() => onSelect(item.id)}
                className="group flex items-center gap-3 px-3 py-3 rounded-lg cursor-pointer transition-all"
                style={{
                  background: selected.has(item.id) ? 'rgba(124,58,237,0.1)' : 'var(--bg-secondary)',
                  border: `1px solid ${selected.has(item.id) ? 'var(--accent-purple-bright)' : 'var(--border)'}`,
                }}
              >
                <input type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                  onClick={e => e.stopPropagation()}
                  className="shrink-0" />
                {/* Status pill */}
                <select
                  value={item.status}
                  onClick={e => e.stopPropagation()}
                  onChange={e => onPatch(item.id, { status: e.target.value })}
                  className="px-2 py-1 rounded text-xs font-medium cursor-pointer"
                  style={{
                    background: statusColor(statuses, item.status) + '22',
                    color: statusColor(statuses, item.status),
                    border: `1px solid ${statusColor(statuses, item.status)}55`,
                  }}
                >
                  {statuses.map(s => <option key={s.key} value={s.key}>{statusLabel(statuses, s.key)}</option>)}
                </select>

                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {item.title || <span style={{ color: 'var(--text-muted)' }}>Untitled</span>}
                  </div>
                  <div className="text-xs flex items-center gap-2 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    <span>{formatWhen(item.scheduled_for)}</span>
                    {item.recurrence && <span>· recurring</span>}
                    {item.script_id && <span>· has script</span>}
                    {item.idea_id && <span>· from idea</span>}
                  </div>
                </div>

                {/* Channel chips */}
                <div className="flex -space-x-1">
                  {(item.channels ?? []).slice(0, 3).map(c => (
                    <div
                      key={c.id}
                      title={c.name}
                      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border-2"
                      style={{ background: c.account_color || '#7c3aed', color: 'white', borderColor: 'var(--bg-secondary)' }}
                    >
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                  ))}
                </div>

                <button
                  onClick={e => { e.stopPropagation(); onDelete(item.id, !!item.recurrence); }}
                  className="p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: 'var(--text-muted)' }}
                  title="Delete"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
                  </svg>
                </button>
              </motion.div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
