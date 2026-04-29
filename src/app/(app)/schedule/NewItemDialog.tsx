'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { ScheduleStatus, RecurrenceRule } from '@/lib/schedule';
import type { Channel } from './types';
import { RecurrenceEditor } from './RecurrenceEditor';

type Props = {
  channels: Channel[];
  statuses: ScheduleStatus[];
  defaultChannelId?: string | null;
  onClose: () => void;
  onCreated: () => void;
};

export function NewItemDialog({ channels, statuses, defaultChannelId, onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [status, setStatus] = useState(statuses[0]?.key ?? 'idea');
  const [channelIds, setChannelIds] = useState<string[]>(defaultChannelId ? [defaultChannelId] : []);
  const [notes, setNotes] = useState('');
  const [recurrence, setRecurrence] = useState<RecurrenceRule | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!title.trim() && !scheduledFor) {
      toast.error('Give it at least a title or a date');
      return;
    }
    setSubmitting(true);
    const res = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        status,
        notes: notes.trim() || null,
        channel_ids: channelIds,
        recurrence,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error('Could not create item');
      return;
    }
    const data = await res.json();
    toast.success(data.expanded ? `Created ${data.expanded} items` : 'Created');
    onCreated();
  }

  function toggleChannel(id: string) {
    setChannelIds(cs => cs.includes(id) ? cs.filter(x => x !== id) : [...cs, id]);
  }

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40 flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.5)' }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-lg rounded-xl p-5 max-h-[85vh] overflow-y-auto"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>New video slot</h2>
            <button onClick={onClose} className="p-1" style={{ color: 'var(--text-muted)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: 'var(--text-muted)' }}>Title</div>
              <input autoFocus value={title}
                onChange={e => setTitle(e.currentTarget.value)}
                placeholder="e.g. How antivirus engines actually detect zero-days"
                className="w-full px-3 py-2 rounded text-sm"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
                  style={{ color: 'var(--text-muted)' }}>When</div>
                <input type="datetime-local" value={scheduledFor}
                  onChange={e => setScheduledFor(e.currentTarget.value)}
                  className="w-full px-3 py-2 rounded text-sm"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
                  style={{ color: 'var(--text-muted)' }}>Status</div>
                <select value={status} onChange={e => setStatus(e.currentTarget.value)}
                  className="w-full px-3 py-2 rounded text-sm"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                >
                  {statuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: 'var(--text-muted)' }}>Channels (select one or more)</div>
              <div className="flex flex-wrap gap-2">
                {channels.map(c => {
                  const on = channelIds.includes(c.id);
                  return (
                    <button key={c.id} onClick={() => toggleChannel(c.id)}
                      className="px-2 py-1 rounded-full text-xs"
                      style={{
                        background: on ? (c.account_color || '#7c3aed') + '33' : 'var(--bg-tertiary)',
                        color: on ? (c.account_color || 'white') : 'var(--text-muted)',
                        border: `1px solid ${on ? (c.account_color || '#7c3aed') : 'var(--border)'}`,
                      }}>
                      {c.name}
                    </button>
                  );
                })}
                {channels.length === 0 && (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No channels yet</div>
                )}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: 'var(--text-muted)' }}>Notes (optional)</div>
              <textarea value={notes} onChange={e => setNotes(e.currentTarget.value)}
                rows={3}
                className="w-full px-3 py-2 rounded text-sm resize-y"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              />
            </div>

            <details>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}>Recurrence</summary>
              <div className="mt-3">
                <RecurrenceEditor value={recurrence} hasChildren={false} onChange={setRecurrence} onRegenerate={() => {}} />
              </div>
            </details>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm"
              style={{ color: 'var(--text-muted)' }}>Cancel</button>
            <button onClick={submit} disabled={submitting}
              className="px-4 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)', color: 'white' }}>
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
