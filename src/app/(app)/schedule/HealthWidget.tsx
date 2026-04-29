'use client';

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import { daysInStage, isStuck } from '@/lib/schedule';

type Props = {
  items: ScheduleItem[];
  statuses: ScheduleStatus[];
  onSelect: (id: string) => void;
};

export function HealthWidget({ items, statuses, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  const health = useMemo(() => {
    // Compute `now` inside the memo so we don't force the memo to recompute
    // every render (a fresh Date() would change the deps reference each time).
    const now = new Date();
    const stuck = items.filter(it => isStuck(it));
    // Upcoming: scheduled in the next 14 days but still in early stages.
    const in14d = new Date(now.getTime() + 14 * 86400000);
    const upcoming = items.filter(it => {
      if (!it.scheduled_for) return false;
      const d = new Date(it.scheduled_for);
      return d >= now && d <= in14d && !['ready', 'published'].includes(it.status);
    });
    const upcomingShort = upcoming.filter(it => {
      const days = Math.floor((new Date(it.scheduled_for!).getTime() - now.getTime()) / 86400000);
      return days < 3;
    });
    const nothingScheduled = upcoming.length === 0;
    const statusBreakdown: Record<string, number> = {};
    for (const s of statuses) statusBreakdown[s.key] = 0;
    for (const it of items) statusBreakdown[it.status] = (statusBreakdown[it.status] ?? 0) + 1;

    // Pillar gap detection: for every pillar that has appeared on any item,
    // check when it was last touched. Flag pillars untouched for >14 days.
    const pillarLastSeen = new Map<string, Date>();
    for (const it of items) {
      if (!it.pillar) continue;
      const stamp = new Date(it.updated_at);
      const cur = pillarLastSeen.get(it.pillar);
      if (!cur || stamp > cur) pillarLastSeen.set(it.pillar, stamp);
    }
    const neglectedPillars = Array.from(pillarLastSeen.entries())
      .map(([pillar, seen]) => ({
        pillar,
        daysSince: Math.floor((now.getTime() - seen.getTime()) / 86400000),
      }))
      .filter(x => x.daysSince > 14)
      .sort((a, b) => b.daysSince - a.daysSince);

    return { stuck, upcoming, upcomingShort, nothingScheduled, statusBreakdown, neglectedPillars };
  }, [items, statuses]);

  const signals: Array<{ severity: 'high' | 'medium' | 'low'; label: string; detail: string }> = [];
  if (health.stuck.length > 0) {
    signals.push({
      severity: 'high',
      label: `${health.stuck.length} stuck`,
      detail: 'Items haven\'t moved in a while',
    });
  }
  if (health.upcomingShort.length > 0) {
    signals.push({
      severity: 'high',
      label: `${health.upcomingShort.length} due soon`,
      detail: 'Scheduled within 3 days but not ready',
    });
  }
  if (health.nothingScheduled) {
    signals.push({
      severity: 'medium',
      label: 'empty pipeline',
      detail: 'Nothing scheduled in the next 14 days',
    });
  }
  if (health.neglectedPillars.length > 0) {
    const top = health.neglectedPillars[0];
    signals.push({
      severity: 'medium',
      label: `pillar gap: ${top.pillar}`,
      detail: `No item in #${top.pillar} for ${top.daysSince} days`,
    });
  }
  if (signals.length === 0) {
    signals.push({ severity: 'low', label: 'on track', detail: 'No red flags right now' });
  }

  const worstSeverity = signals.some(s => s.severity === 'high') ? 'high'
    : signals.some(s => s.severity === 'medium') ? 'medium' : 'low';
  const severityColor = worstSeverity === 'high' ? '#ef4444'
    : worstSeverity === 'medium' ? '#f59e0b' : '#10b981';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all"
        style={{
          background: `${severityColor}15`,
          color: severityColor,
          border: `1px solid ${severityColor}55`,
        }}
        title="Backlog health"
      >
        <span className="w-2 h-2 rounded-full" style={{ background: severityColor }} />
        Health
        {health.stuck.length + health.upcomingShort.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ background: `${severityColor}33` }}>
            {health.stuck.length + health.upcomingShort.length}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="absolute right-0 mt-2 w-80 rounded-lg z-40 overflow-hidden"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 10px 40px rgba(0,0,0,0.4)' }}
            >
              <div className="px-3 py-2 text-[10px] uppercase tracking-wider font-semibold"
                style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                Backlog health
              </div>

              {/* Signals */}
              <div className="px-3 py-2 space-y-1.5">
                {signals.map((s, i) => {
                  const c = s.severity === 'high' ? '#ef4444' : s.severity === 'medium' ? '#f59e0b' : '#10b981';
                  return (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="mt-1 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c }} />
                      <div>
                        <div className="font-medium" style={{ color: c }}>{s.label}</div>
                        <div style={{ color: 'var(--text-muted)' }}>{s.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Stuck list */}
              {health.stuck.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold"
                    style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
                    Stuck items
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {health.stuck.slice(0, 8).map(it => (
                      <button key={it.id}
                        onClick={() => { onSelect(it.id); setOpen(false); }}
                        className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-white/5">
                        <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {it.title || 'Untitled'}
                        </div>
                        <div style={{ color: '#ef4444' }}>
                          {daysInStage(it)}d in {it.status}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Pillars */}
              {health.neglectedPillars.length > 0 && (
                <div className="px-3 py-2 border-t" style={{ borderColor: 'var(--border)' }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
                    style={{ color: 'var(--text-muted)' }}>Pillar gaps</div>
                  <div className="space-y-0.5">
                    {health.neglectedPillars.slice(0, 5).map(g => (
                      <div key={g.pillar} className="flex items-center text-[11px]">
                        <span className="flex-1" style={{ color: 'var(--text-secondary)' }}>#{g.pillar}</span>
                        <span style={{ color: '#f59e0b' }}>{g.daysSince}d</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Status breakdown */}
              <div className="px-3 py-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <div className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
                  style={{ color: 'var(--text-muted)' }}>Pipeline</div>
                <div className="space-y-0.5">
                  {statuses.map(s => {
                    const n = health.statusBreakdown[s.key] ?? 0;
                    return (
                      <div key={s.key} className="flex items-center gap-2 text-[11px]">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
                        <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{n}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
