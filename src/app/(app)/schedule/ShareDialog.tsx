'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

type Share = {
  id: string;
  token: string;
  channel_id: string | null;
  label: string | null;
  expires_at: string | null;
  created_at: string;
};

type Props = {
  channelId: string | null;
  channelName: string;
  onClose: () => void;
};

export function ShareDialog({ channelId, channelName, onClose }: Props) {
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [expiresDays, setExpiresDays] = useState<number | ''>('');
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    const res = await fetch('/api/schedule/share');
    const data = await res.json();
    setShares((data.shares || []).filter((s: Share) =>
      channelId ? s.channel_id === channelId : s.channel_id == null,
    ));
    setLoading(false);
  }
  useEffect(() => { load();   }, [channelId]);

  async function create() {
    setCreating(true);
    const expires_at = expiresDays
      ? new Date(Date.now() + Number(expiresDays) * 86400000).toISOString()
      : null;
    // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
    const res = await fetch('/api/schedule/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, label: label.trim() || null, expires_at }),
    });
    setCreating(false);
    if (!res.ok) { toast.error('Could not create link'); return; }
    const data = await res.json();
    const url = `${window.location.origin}/share/${data.share.token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied to clipboard');
    } catch {
      toast.message('Link created — copy it below');
    }
    setLabel('');
    setExpiresDays('');
    load();
  }

  async function revoke(id: string) {
    if (!window.confirm('Revoke this share link?')) return;
    // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
    const res = await fetch(`/api/schedule/share?id=${id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Revoked'); load(); }
    else toast.error('Failed');
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
          className="w-full max-w-lg rounded-xl"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Share read-only link</h2>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Anyone with the URL can view · {channelName}</div>
            </div>
            <button onClick={onClose} style={{ color: 'var(--text-muted)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div className="p-5 space-y-4">
            {/* Create */}
            <div className="space-y-2 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
              <input value={label} onChange={e => setLabel(e.currentTarget.value)}
                placeholder="Label (optional — e.g. 'editor Jane')"
                className="w-full px-3 py-2 rounded text-sm"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              />
              <div className="flex items-center gap-2">
                <select value={expiresDays} onChange={e => setExpiresDays(e.currentTarget.value ? Number(e.currentTarget.value) : '')}
                  className="px-2 py-1.5 rounded text-sm"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
                  <option value="">Never expires</option>
                  <option value={1}>1 day</option>
                  <option value={7}>1 week</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                </select>
                <button onClick={create} disabled={creating}
                  className="ml-auto px-3 py-1.5 rounded text-sm font-medium"
                  style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)', color: 'white' }}>
                  {creating ? 'Creating…' : 'Create link'}
                </button>
              </div>
            </div>

            {/* Existing */}
            {loading ? (
              <div className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>Loading…</div>
            ) : shares.length === 0 ? (
              <div className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>No active links for this scope.</div>
            ) : (
              <div className="space-y-2">
                {shares.map(s => {
                  const url = `${window.location.origin}/share/${s.token}`;
                  const expired = s.expires_at && new Date(s.expires_at) < new Date();
                  return (
                    <div key={s.id} className="p-2.5 rounded-lg"
                      style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', opacity: expired ? 0.5 : 1 }}>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                          {s.label || 'Untitled link'}
                          {expired && <span className="ml-1 text-[10px]" style={{ color: '#ef4444' }}>· expired</span>}
                        </div>
                        <button onClick={() => revoke(s.id)}
                          className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Revoke
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <input readOnly value={url}
                          onClick={e => (e.currentTarget as HTMLInputElement).select()}
                          className="flex-1 px-2 py-1 rounded text-xs font-mono"
                          style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                        />
                        <button onClick={async () => { await navigator.clipboard.writeText(url); toast.success('Copied'); }}
                          className="text-xs px-2 py-1 rounded"
                          style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                          Copy
                        </button>
                      </div>
                      {s.expires_at && !expired && (
                        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          Expires {new Date(s.expires_at).toLocaleString()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
