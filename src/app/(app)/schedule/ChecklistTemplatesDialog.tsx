'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { ScheduleStatus } from '@/lib/schedule';

type Template = {
  id: string;
  channel_id: string | null;
  status: string;
  items: Array<{ text: string }>;
};

type Props = {
  channelId: string | null;
  channelName: string;
  statuses: ScheduleStatus[];
  onClose: () => void;
};

export function ChecklistTemplatesDialog({ channelId, channelName, statuses, onClose }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({}); // status → textarea lines
  const [savingKey, setSavingKey] = useState<string | null>(null);

  async function load() {
    const url = channelId
      ? `/api/schedule/checklist-templates?channel_id=${channelId}`
      : `/api/schedule/checklist-templates`;
    const res = await fetch(url);
    const data = await res.json();
    const list: Template[] = data.templates || [];
    setTemplates(list);
    const next: Record<string, string[]> = {};
    for (const s of statuses) {
      // Prefer a channel-scoped template; fall back to global default.
      const specific = list.find(t => t.status === s.key && t.channel_id === channelId);
      const global = list.find(t => t.status === s.key && t.channel_id == null);
      const chosen = specific ?? global;
      next[s.key] = (chosen?.items ?? []).map(i => i.text);
    }
    setDrafts(next);
  }

  useEffect(() => { load();   }, [channelId]);

  async function save(statusKey: string) {
    setSavingKey(statusKey);
    const items = (drafts[statusKey] ?? []).filter(Boolean).map(text => ({ text }));
    const res = await fetch('/api/schedule/checklist-templates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, status: statusKey, items }),
    });
    setSavingKey(null);
    if (!res.ok) { toast.error('Could not save template'); return; }
    toast.success('Saved');
    load();
  }

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40 flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.55)' }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-2xl rounded-xl max-h-[85vh] flex flex-col"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center justify-between px-5 py-3"
            style={{ borderBottom: '1px solid var(--border)' }}>
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Stage checklists
              </h2>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {channelId ? `Applied to: ${channelName}` : 'Global default (used when no channel-specific template exists)'}
              </div>
            </div>
            <button onClick={onClose} style={{ color: 'var(--text-muted)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="text-xs p-3 rounded-lg"
              style={{ background: 'rgba(124,58,237,0.08)', color: 'var(--text-secondary)', border: '1px solid rgba(124,58,237,0.3)' }}>
              One item per line. When an item advances to a stage, these get auto-appended to its checklist.
            </div>

            {statuses.map(s => (
              <div key={s.key} className="rounded-lg p-3"
                style={{ background: 'var(--bg-tertiary)', border: `1px solid ${s.color}33` }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                    <span className="text-sm font-semibold" style={{ color: s.color }}>{s.label}</span>
                  </div>
                  <button onClick={() => save(s.key)} disabled={savingKey === s.key}
                    className="text-xs px-2 py-1 rounded"
                    style={{ background: 'var(--accent-purple-bright)', color: 'white' }}>
                    {savingKey === s.key ? 'Saving…' : 'Save'}
                  </button>
                </div>
                <textarea
                  value={(drafts[s.key] ?? []).join('\n')}
                  onChange={e => setDrafts(d => ({ ...d, [s.key]: e.currentTarget.value.split('\n') }))}
                  rows={4}
                  placeholder={`Checklist for ${s.label.toLowerCase()}\n(one item per line)`}
                  className="w-full px-3 py-2 rounded text-sm font-mono"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
              </div>
            ))}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
