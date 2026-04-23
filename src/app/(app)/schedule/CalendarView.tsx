'use client';

import { useMemo, useState } from 'react';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import { statusColor } from '@/lib/schedule';

type Props = {
  items: ScheduleItem[];
  statuses: ScheduleStatus[];
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Partial<ScheduleItem>) => void;
};

function startOfMonth(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), 1);
  return x;
}

function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function CalendarView({ items, statuses, onSelect, onPatch }: Props) {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  const days = useMemo(() => {
    // Build a 6-row grid starting from the Sunday on/before day 1.
    const first = startOfMonth(cursor);
    const gridStart = new Date(first);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    const cells: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(d.getDate() + i);
      cells.push(d);
    }
    return cells;
  }, [cursor]);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, ScheduleItem[]>();
    for (const item of items) {
      if (!item.scheduled_for) continue;
      const d = new Date(item.scheduled_for);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [items]);

  const unscheduled = items.filter(i => !i.scheduled_for);

  function dayKey(d: Date) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }

  function handleDrop(e: React.DragEvent, targetDay: Date) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const existing = items.find(i => i.id === id);
    if (!existing) return;
    // Preserve existing time if scheduled, default to 12:00 when unscheduled.
    // NOTE: `|| 12` is wrong — it would rewrite 00:00 to noon. Use explicit ternary.
    const next = new Date(targetDay);
    if (existing.scheduled_for) {
      const when = new Date(existing.scheduled_for);
      next.setHours(when.getHours(), when.getMinutes(), 0, 0);
    } else {
      next.setHours(12, 0, 0, 0);
    }
    onPatch(id, { scheduled_for: next.toISOString() });
    setHoverDay(null);
  }

  return (
    <div className="flex gap-4">
      <div className="flex-1 rounded-lg overflow-hidden"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        {/* Month header */}
        <div className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <button onClick={() => setCursor(addMonths(cursor, -1))}
              className="p-1.5 rounded hover:bg-white/5"
              style={{ color: 'var(--text-secondary)' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <button onClick={() => setCursor(startOfMonth(new Date()))}
              className="text-xs px-2 py-1 rounded"
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
              Today
            </button>
            <button onClick={() => setCursor(addMonths(cursor, 1))}
              className="p-1.5 rounded hover:bg-white/5"
              style={{ color: 'var(--text-secondary)' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          </div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </div>
          <div className="w-20"></div>
        </div>

        {/* Weekday header */}
        <div className="grid grid-cols-7 text-xs font-medium"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
            <div key={d} className="px-2 py-2 text-center">{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7">
          {days.map(d => {
            const key = dayKey(d);
            const inMonth = d.getMonth() === cursor.getMonth();
            const isToday = sameDay(d, new Date());
            const cellItems = itemsByDay.get(key) ?? [];
            return (
              <div
                key={key}
                onDragOver={e => { e.preventDefault(); setHoverDay(key); }}
                onDragLeave={() => setHoverDay(h => h === key ? null : h)}
                onDrop={e => handleDrop(e, d)}
                className="min-h-[108px] p-1.5 relative transition-colors"
                style={{
                  background: hoverDay === key ? 'rgba(124,58,237,0.1)' : inMonth ? 'transparent' : 'rgba(0,0,0,0.15)',
                  borderRight: '1px solid var(--border)',
                  borderBottom: '1px solid var(--border)',
                  opacity: inMonth ? 1 : 0.5,
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium px-1.5 py-0.5 rounded"
                    style={{
                      color: isToday ? 'white' : 'var(--text-secondary)',
                      background: isToday ? 'var(--accent-purple-bright)' : 'transparent',
                    }}>
                    {d.getDate()}
                  </span>
                </div>
                <div className="space-y-1">
                  {cellItems.slice(0, 3).map(it => (
                    <div
                      key={it.id}
                      draggable
                      onDragStart={e => e.dataTransfer.setData('text/plain', it.id)}
                      onClick={() => onSelect(it.id)}
                      className="px-1.5 py-1 rounded text-[11px] cursor-pointer truncate"
                      style={{
                        background: statusColor(statuses, it.status) + '33',
                        color: 'var(--text-primary)',
                        borderLeft: `3px solid ${statusColor(statuses, it.status)}`,
                      }}
                      title={it.title}
                    >
                      {it.title || 'Untitled'}
                    </div>
                  ))}
                  {cellItems.length > 3 && (
                    <div className="text-[10px] px-1.5" style={{ color: 'var(--text-muted)' }}>
                      +{cellItems.length - 3} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Unscheduled sidebar */}
      <div className="w-64 rounded-lg"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wider"
          style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          Backlog · {unscheduled.length}
        </div>
        <div className="p-2 space-y-1 max-h-[600px] overflow-y-auto">
          {unscheduled.length === 0 && (
            <div className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
              Drop items here to unschedule
            </div>
          )}
          {unscheduled.map(it => (
            <div
              key={it.id}
              draggable
              onDragStart={e => e.dataTransfer.setData('text/plain', it.id)}
              onClick={() => onSelect(it.id)}
              className="px-2 py-1.5 rounded text-xs cursor-pointer"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                borderLeft: `3px solid ${statusColor(statuses, it.status)}`,
              }}
            >
              {it.title || 'Untitled'}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
