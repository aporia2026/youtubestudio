'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import { statusColor, daysInStage, isStuck } from '@/lib/schedule';
import type { Channel } from './types';
import { EditorAvatar } from './EditorPicker';

type Props = {
  items: ScheduleItem[];
  statuses: ScheduleStatus[];
  channels: Channel[];
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Partial<ScheduleItem>) => void;
};

/** WIP limit (visual warning, not enforced). Tuned for a solo-creator flow. */
const SOFT_CAP = 8;

export function KanbanView({ items, statuses, channels, onSelect, onPatch }: Props) {
  const [dragOver, setDragOver] = useState<string | null>(null);

  const byStatus = useMemo(() => {
    const map = new Map<string, ScheduleItem[]>();
    for (const s of statuses) map.set(s.key, []);
    for (const it of items) {
      if (!map.has(it.status)) map.set(it.status, []);
      map.get(it.status)!.push(it);
    }
    // Sort within column by scheduled date (nulls last), then by title.
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const aTime = a.scheduled_for ? new Date(a.scheduled_for).getTime() : Infinity;
        const bTime = b.scheduled_for ? new Date(b.scheduled_for).getTime() : Infinity;
        if (aTime !== bTime) return aTime - bTime;
        return a.title.localeCompare(b.title);
      });
    }
    return map;
  }, [items, statuses]);

  function handleDrop(e: React.DragEvent, targetStatus: string) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    setDragOver(null);
    const item = items.find(i => i.id === id);
    if (!item || item.status === targetStatus) return;
    onPatch(id, { status: targetStatus });
  }

  if (statuses.length === 0) {
    return (
      <div className="py-20 text-center rounded-lg"
        style={{ background: 'var(--bg-secondary)', border: '1px dashed var(--border)', color: 'var(--text-muted)' }}>
        No status pipeline configured yet.
      </div>
    );
  }

  const channelsById = new Map(channels.map(c => [c.id, c]));

  return (
    <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }}>
      {statuses.map(st => {
        const columnItems = byStatus.get(st.key) ?? [];
        const over = columnItems.length > SOFT_CAP;
        const isOverTarget = dragOver === st.key;
        return (
          <div
            key={st.key}
            onDragOver={e => { e.preventDefault(); setDragOver(st.key); }}
            onDragLeave={() => setDragOver(d => d === st.key ? null : d)}
            onDrop={e => handleDrop(e, st.key)}
            className="flex flex-col w-72 shrink-0 rounded-lg"
            style={{
              background: isOverTarget ? `${st.color}11` : 'var(--bg-secondary)',
              border: `1px solid ${isOverTarget ? st.color : 'var(--border)'}`,
              transition: 'background 120ms, border-color 120ms',
            }}
          >
            {/* Column header */}
            <div className="flex items-center justify-between px-3 py-2.5 rounded-t-lg"
              style={{ borderBottom: '1px solid var(--border)', background: `${st.color}15` }}>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: st.color }} />
                <span className="text-sm font-semibold" style={{ color: st.color }}>{st.label}</span>
                <span className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: `${st.color}22`, color: st.color }}>
                  {columnItems.length}
                </span>
              </div>
              {over && (
                <span className="text-[10px] px-1.5 py-0.5 rounded"
                  title={`More than ${SOFT_CAP} items — consider advancing some`}
                  style={{ background: 'rgba(245,158,11,0.2)', color: '#f59e0b' }}>
                  heavy
                </span>
              )}
            </div>

            {/* Cards */}
            <div className="flex-1 p-2 space-y-2 min-h-[80px]">
              {columnItems.length === 0 && (
                <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                  Drop items here
                </div>
              )}
              {columnItems.map(it => {
                const stuck = isStuck(it);
                const days = daysInStage(it);
                const primaryChannel = it.channels?.[0];
                const accent = primaryChannel
                  ? channelsById.get(primaryChannel.id)?.account_color ?? st.color
                  : st.color;
                const checklistTotal = it.checklist?.length ?? 0;
                const checklistDone = it.checklist?.filter(c => c.done).length ?? 0;
                return (
                  <motion.div
                    key={it.id}
                    draggable
                    // framer-motion narrows onDragStart to pointer drag events (for its own
                    // gesture system). Cast to React.DragEvent so we can reach dataTransfer
                    // for the native HTML5 drag the `draggable` attribute enables.
                    onDragStart={(e) => (e as unknown as React.DragEvent).dataTransfer.setData('text/plain', it.id)}
                    onClick={() => onSelect(it.id)}
                    whileHover={{ y: -2 }}
                    className="p-2.5 rounded-md cursor-pointer"
                    style={{
                      background: 'var(--bg-tertiary)',
                      borderLeft: `3px solid ${accent}`,
                      border: `1px solid ${stuck ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
                      borderLeftWidth: '3px',
                      borderLeftColor: accent,
                      boxShadow: stuck ? '0 0 0 1px rgba(239,68,68,0.2) inset' : undefined,
                    }}
                  >
                    <div className="text-sm font-medium mb-1.5 line-clamp-2" style={{ color: 'var(--text-primary)' }}>
                      {it.title || 'Untitled'}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {it.scheduled_for && (
                        <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)' }}>
                          {new Date(it.scheduled_for).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                      {checklistTotal > 0 && (
                        <span className="px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--bg-secondary)', color: checklistDone === checklistTotal ? '#10b981' : 'var(--text-muted)' }}>
                          ☑ {checklistDone}/{checklistTotal}
                        </span>
                      )}
                      {stuck && days != null && (
                        <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                          stuck {days}d
                        </span>
                      )}
                      {it.pillar && (
                        <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
                          #{it.pillar}
                        </span>
                      )}
                      {it.series_title && (
                        <span className="px-1.5 py-0.5 rounded" title={`Series: ${it.series_title}`} style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}>
                          📺 {it.series_title}{it.part_number ? ` · Pt ${it.part_number}` : ''}
                        </span>
                      )}
                      {it.script_id && (
                        <span className="px-1.5 py-0.5 rounded" title="Has script" style={{ background: 'var(--bg-secondary)' }}>📝</span>
                      )}
                      {(it.thumbnail_a_url || it.thumbnail_b_url) && (
                        <span className="px-1.5 py-0.5 rounded" title="Has thumbnail" style={{ background: 'var(--bg-secondary)' }}>🖼️</span>
                      )}
                      {(() => {
                        // Feature run markers. custom_fields is JSONB so these keys may
                        // be absent — reading through a narrow lens keeps TS happy.
                        const cf = (it.custom_fields ?? {}) as Record<string, unknown>;
                        const qa = cf.latest_qa as { score?: number } | undefined;
                        const hasProdDoc = !!cf.latest_production_doc;
                        const seo = cf.latest_seo as { best_score?: number } | undefined;
                        const youtube = it.youtube_url;
                        return (
                          <>
                            {typeof qa?.score === 'number' && (
                              <span
                                className="px-1.5 py-0.5 rounded"
                                title={`Latest QA score: ${qa.score}/100`}
                                style={{
                                  background: qa.score >= 80 ? 'rgba(16,185,129,0.15)' : qa.score >= 60 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                                  color:      qa.score >= 80 ? '#10b981'               : qa.score >= 60 ? '#f59e0b'               : '#ef4444',
                                }}>
                                🔬 {qa.score}
                              </span>
                            )}
                            {hasProdDoc && (
                              <span className="px-1.5 py-0.5 rounded" title="Has production doc" style={{ background: 'var(--bg-secondary)' }}>🎬</span>
                            )}
                            {seo && (
                              <span className="px-1.5 py-0.5 rounded" title={`SEO optimized${typeof seo.best_score === 'number' ? ` · top score ${seo.best_score}` : ''}`} style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}>🔍</span>
                            )}
                            {youtube && (
                              <span className="px-1.5 py-0.5 rounded" title="Published on YouTube" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>📺</span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    {/* Channel chips + editor avatar */}
                    {((it.channels?.length ?? 0) > 1 || it.editor_name) && (
                      <div className="flex items-center gap-1.5 mt-1.5">
                        {(it.channels?.length ?? 0) > 1 && (
                          <div className="flex -space-x-1">
                            {it.channels!.slice(0, 3).map(c => (
                              <div key={c.id}
                                className="w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center border"
                                style={{ background: c.account_color || '#7c3aed', color: 'white', borderColor: 'var(--bg-tertiary)' }}
                                title={c.name}>
                                {c.name.charAt(0).toUpperCase()}
                              </div>
                            ))}
                          </div>
                        )}
                        {it.editor_name && (
                          <div className="flex items-center gap-1 ml-auto" title={`Editor: ${it.editor_name}`}>
                            <EditorAvatar
                              name={it.editor_name}
                              color={(it.channels ?? []).find(c => c.id === it.editor_channel_id)?.account_color ?? null}
                              size={14}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
