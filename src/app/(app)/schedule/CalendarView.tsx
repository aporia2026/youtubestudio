'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import { statusColor } from '@/lib/schedule';

type CompetitorEvent = { published_at: string; title: string; channel_name: string; view_count: number; outlier_score: number };

type Props = {
  items: ScheduleItem[];
  statuses: ScheduleStatus[];
  channelId: string | null;
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

export function CalendarView({ items, statuses, channelId, onSelect, onPatch }: Props) {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [heatmap, setHeatmap] = useState<(number | null)[][] | null>(null); // 7x24 median views
  const [showCompetitors, setShowCompetitors] = useState(false);
  const [competitorEvents, setCompetitorEvents] = useState<CompetitorEvent[]>([]);

  // Best-times heatmap per channel — use the per-weekday max across hours as the cell tint.
  useEffect(() => {
    if (!channelId) { setHeatmap(null); return; }
    const controller = new AbortController();
    fetch(`/api/schedule/best-times?channel_id=${channelId}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.grid) setHeatmap(d.grid); })
      .catch(err => { if (err.name !== 'AbortError') setHeatmap(null); });
    return () => controller.abort();
  }, [channelId]);

  useEffect(() => {
    if (!showCompetitors) return;
    const controller = new AbortController();
    fetch('/api/schedule/competitor-cadence', { signal: controller.signal })
      .then(r => r.ok ? r.json() : { events: [] })
      .then(d => setCompetitorEvents(d.events || []))
      .catch(err => { if (err.name !== 'AbortError') setCompetitorEvents([]); });
    return () => controller.abort();
  }, [showCompetitors]);

  // Keep refs up-to-date so the keydown listener reads current state without
  // being re-registered on every arrow press.
  const focusDayRef = useRef(focusDay);
  const cursorRef = useRef(cursor);
  useEffect(() => { focusDayRef.current = focusDay; }, [focusDay]);
  useEffect(() => { cursorRef.current = cursor; }, [cursor]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const fd = focusDayRef.current;
      if (!fd) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const [y, m, d] = fd.split('-').map(Number);
      const cur = new Date(y, m, d);
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = -1;
      else if (e.key === 'ArrowRight') delta = 1;
      else if (e.key === 'ArrowUp') delta = -7;
      else if (e.key === 'ArrowDown') delta = 7;
      else return;
      e.preventDefault();
      cur.setDate(cur.getDate() + delta);
      setFocusDay(`${cur.getFullYear()}-${cur.getMonth()}-${cur.getDate()}`);
      const c = cursorRef.current;
      if (cur.getMonth() !== c.getMonth() || cur.getFullYear() !== c.getFullYear()) {
        setCursor(new Date(cur.getFullYear(), cur.getMonth(), 1));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const competitorByDay = useMemo(() => {
    const map = new Map<string, CompetitorEvent[]>();
    for (const ev of competitorEvents) {
      const d = new Date(ev.published_at);
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(ev);
    }
    return map;
  }, [competitorEvents]);

  // Per-weekday heatmap intensity (normalized 0..1 of the median view count, max across hours).
  const weekdayIntensity = useMemo(() => {
    if (!heatmap) return null;
    const perDay = heatmap.map(row => {
      const vals = row.filter(v => v != null) as number[];
      return vals.length ? Math.max(...vals) : 0;
    });
    const max = Math.max(...perDay, 1);
    return perDay.map(v => (max > 0 ? v / max : 0));
  }, [heatmap]);

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
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <input type="checkbox" checked={showCompetitors} onChange={e => setShowCompetitors(e.currentTarget.checked)} />
              Competitors
            </label>
            {weekdayIntensity && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}
                title="Background tint: historical day-of-week view performance">
                🔥 heatmap
              </span>
            )}
          </div>
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
            const intensity = weekdayIntensity ? weekdayIntensity[d.getDay()] : 0;
            const heatBg = inMonth && intensity > 0
              ? `rgba(16,185,129,${Math.min(0.18, intensity * 0.18)})`
              : null;
            const competitorsToday = competitorByDay.get(key) ?? [];
            const isFocused = focusDay === key;
            return (
              <div
                key={key}
                tabIndex={0}
                onFocus={() => setFocusDay(key)}
                onDragOver={e => { e.preventDefault(); setHoverDay(key); }}
                onDragLeave={() => setHoverDay(h => h === key ? null : h)}
                onDrop={e => handleDrop(e, d)}
                className="min-h-[108px] p-1.5 relative transition-colors outline-none"
                style={{
                  background: hoverDay === key ? 'rgba(124,58,237,0.1)'
                    : heatBg ?? (inMonth ? 'transparent' : 'rgba(0,0,0,0.15)'),
                  borderRight: '1px solid var(--border)',
                  borderBottom: '1px solid var(--border)',
                  outline: isFocused ? '2px solid var(--accent-purple-bright)' : 'none',
                  outlineOffset: '-2px',
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
                {/* Competitor ghost markers (top-right corner) */}
                {showCompetitors && competitorsToday.length > 0 && (
                  <div className="absolute top-1 right-1 flex gap-0.5" title={competitorsToday.map(c => `${c.channel_name}: ${c.title}`).join('\n')}>
                    {competitorsToday.slice(0, 3).map((_, i) => (
                      <span key={i} className="w-1 h-1 rounded-full" style={{ background: '#f59e0b', opacity: 0.7 }} />
                    ))}
                    {competitorsToday.length > 3 && (
                      <span className="text-[8px]" style={{ color: '#f59e0b' }}>+{competitorsToday.length - 3}</span>
                    )}
                  </div>
                )}
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
