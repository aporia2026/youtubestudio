'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { getFeatureDefaultModelId } from '@/lib/ai-models';

type Suggestion = { title: string; reason: string; source: 'idea' | 'new'; matched_idea_title?: string };

type Props = {
  channelId: string | null;
  channelName: string;
  onClose: () => void;
  onCreated: () => void;
};

export function SuggestNextDialog({ channelId, channelName, onClose, onCreated }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/schedule/ai/suggest-next', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel_id: channelId,
            modelId: getFeatureDefaultModelId('schedule-suggest'),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        setSuggestions(data.suggestions || []);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'AI suggestion failed');
        onClose();
      } finally {
        setLoading(false);
      }
    })();
  }, [channelId, onClose]);

  async function addToSchedule(s: Suggestion) {
    setAdding(s.title);
    const res = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: s.title,
        channel_ids: channelId ? [channelId] : [],
        status: 'idea',
        notes: `AI suggestion: ${s.reason}`,
      }),
    });
    setAdding(null);
    if (!res.ok) { toast.error('Could not add'); return; }
    toast.success('Added to schedule');
    onCreated();
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
          className="w-full max-w-xl rounded-xl"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 30px 80px rgba(0,0,0,0.5)' }}
        >
          <div className="flex items-center justify-between px-5 py-3"
            style={{ borderBottom: '1px solid var(--border)' }}>
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                What to make next
              </h2>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>AI-picked from your backlog + ideas · {channelName}</div>
            </div>
            <button onClick={onClose} style={{ color: 'var(--text-muted)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div className="p-5 space-y-3">
            {loading && (
              <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                Thinking…
              </div>
            )}
            {!loading && suggestions?.length === 0 && (
              <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No suggestions — try saving some ideas first.
              </div>
            )}
            {suggestions?.map((s, i) => (
              <div key={i} className="p-3 rounded-lg"
                style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{s.title}</div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                    style={{
                      background: s.source === 'idea' ? 'rgba(16,185,129,0.15)' : 'rgba(124,58,237,0.15)',
                      color: s.source === 'idea' ? '#10b981' : '#7c3aed',
                    }}>
                    {s.source === 'idea' ? 'From library' : 'New angle'}
                  </span>
                </div>
                <div className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>{s.reason}</div>
                <button
                  onClick={() => addToSchedule(s)}
                  disabled={adding === s.title}
                  className="text-xs px-3 py-1.5 rounded font-medium"
                  style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)', color: 'white' }}>
                  {adding === s.title ? 'Adding…' : '+ Add to schedule'}
                </button>
              </div>
            ))}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
