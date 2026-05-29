'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

type SavedView = {
  id: string;
  name: string;
  channel_id: string | null;
  config: { view?: string; status?: string | null; q?: string | null; density?: string | null };
};

type Props = {
  channelId: string | null;
  currentConfig: { view: string; status: string | null; q: string; density?: string };
  onApply: (v: SavedView) => void;
};

export function SavedViewsMenu({ channelId, currentConfig, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[]>([]);
  const [newName, setNewName] = useState('');

  async function load() {
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    const res = await fetch('/api/schedule/saved-views');
    const data = await res.json();
    setViews(data.views || []);
  }
  useEffect(() => { if (open) load(); }, [open]);

  async function save() {
    if (!newName.trim()) return;
    // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
    const res = await fetch('/api/schedule/saved-views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newName.trim(),
        channel_id: channelId,
        config: currentConfig,
      }),
    });
    if (!res.ok) { toast.error('Could not save view'); return; }
    setNewName('');
    toast.success('View saved');
    load();
  }

  async function remove(id: string) {
    // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
    const res = await fetch(`/api/schedule/saved-views/${id}`, { method: 'DELETE' });
    if (res.ok) { load(); toast.success('Removed'); }
  }

  // Split views into scope-matching vs other
  const matching = views.filter(v => v.channel_id === channelId);
  const others = views.filter(v => v.channel_id !== channelId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title="Saved views"
        className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
        Views
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="absolute right-0 mt-2 w-72 rounded-lg z-40 overflow-hidden"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 10px 40px rgba(0,0,0,0.4)' }}
            >
              <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
                  style={{ color: 'var(--text-muted)' }}>
                  Save current view
                </div>
                <div className="flex gap-1.5">
                  <input value={newName} onChange={e => setNewName(e.currentTarget.value)}
                    onKeyDown={e => { if (e.key === 'Enter') save(); }}
                    placeholder="Name this view"
                    className="flex-1 px-2 py-1 text-xs rounded"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  />
                  <button onClick={save} disabled={!newName.trim()}
                    className="text-xs px-2 py-1 rounded"
                    style={{
                      background: newName.trim() ? 'var(--accent-purple-bright)' : 'var(--bg-tertiary)',
                      color: newName.trim() ? 'white' : 'var(--text-muted)',
                    }}>
                    Save
                  </button>
                </div>
              </div>

              {matching.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold"
                    style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}>
                    This scope
                  </div>
                  {matching.map(v => (
                    <Row key={v.id} v={v} onApply={() => { onApply(v); setOpen(false); }} onRemove={() => remove(v.id)} />
                  ))}
                </>
              )}

              {others.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold"
                    style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}>
                    Other scopes
                  </div>
                  {others.map(v => (
                    <Row key={v.id} v={v} onApply={() => { onApply(v); setOpen(false); }} onRemove={() => remove(v.id)} />
                  ))}
                </>
              )}

              {matching.length === 0 && others.length === 0 && (
                <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
                  No saved views yet.
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({ v, onApply, onRemove }: { v: SavedView; onApply: () => void; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 hover:bg-white/5">
      <button onClick={onApply} className="flex-1 text-left text-sm" style={{ color: 'var(--text-primary)' }}>
        {v.name}
        <span className="text-[10px] ml-2" style={{ color: 'var(--text-muted)' }}>
          {v.config.view ?? '—'}{v.config.status ? ` · ${v.config.status}` : ''}
        </span>
      </button>
      <button onClick={onRemove} title="Remove" style={{ color: 'var(--text-muted)' }}>✕</button>
    </div>
  );
}
