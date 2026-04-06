'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { formatNumber } from '@/lib/utils';

interface Channel {
  id: string;
  channel_id: string;
  name: string;
  handle: string;
  subscriber_count: number;
  video_count: number;
  niche: string;
  thumbnail_url: string;
  last_synced_at: string;
  account_label: string | null;
  account_email: string | null;
  account_color: string | null;
  notes: string | null;
}

const ACCOUNT_COLORS = [
  { color: '#7c3aed', label: 'Purple' },
  { color: '#ef4444', label: 'Red' },
  { color: '#10b981', label: 'Green' },
  { color: '#3b82f6', label: 'Blue' },
  { color: '#f59e0b', label: 'Amber' },
  { color: '#ec4899', label: 'Pink' },
  { color: '#06b6d4', label: 'Cyan' },
  { color: '#8b5cf6', label: 'Violet' },
];

export default function ChannelPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingChannel, setAddingChannel] = useState(false);
  const [channelUrl, setChannelUrl] = useState('');
  const [channelNiche, setChannelNiche] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountColor, setAccountColor] = useState('#7c3aed');
  const [accountApiKey, setAccountApiKey] = useState('');
  const [syncing, setSyncing] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [filterAccount, setFilterAccount] = useState<string | null>(null);

  useEffect(() => {
    fetchChannels();
    checkApiKey();
  }, []);

  async function checkApiKey() {
    const res = await fetch('/api/channel/status');
    const data = await res.json();
    setHasApiKey(data.hasApiKey);
  }

  async function fetchChannels() {
    try {
      const res = await fetch('/api/channels');
      const data = await res.json();
      setChannels(data.channels || []);
    } catch { } finally { setLoading(false); }
  }

  async function addChannel() {
    if (!channelUrl.trim()) return;
    setAddingChannel(true);
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: channelUrl,
          niche: channelNiche,
          accountLabel: accountLabel || undefined,
          accountEmail: accountEmail || undefined,
          accountColor,
          accountApiKey: accountApiKey || undefined,
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      toast.success('Channel added!');
      setChannelUrl(''); setChannelNiche(''); setAccountLabel(''); setAccountEmail(''); setAccountApiKey('');
      fetchChannels();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add channel');
    } finally { setAddingChannel(false); }
  }

  async function syncChannel(channelId: string) {
    setSyncing(channelId);
    try {
      await fetch(`/api/channels/${channelId}/sync`, { method: 'POST' });
      toast.success('Channel synced!');
      fetchChannels();
    } catch { toast.error('Sync failed'); }
    finally { setSyncing(null); }
  }

  async function analyzeChannel(channelId: string) {
    toast.info('Analyzing channel... This may take a moment.');
    try {
      await fetch(`/api/channels/${channelId}/analyze`, { method: 'POST' });
      toast.success('Analysis complete!');
    } catch { toast.error('Analysis failed'); }
  }

  async function deleteChannel(channelId: string) {
    if (!confirm('Remove this channel?')) return;
    try {
      await fetch(`/api/channels/${channelId}`, { method: 'DELETE' });
      setChannels(prev => prev.filter(c => c.id !== channelId));
      toast.success('Channel removed');
    } catch { toast.error('Failed to remove channel'); }
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(239,68,68,0.3), rgba(245,158,11,0.2))', border: '1px solid rgba(239,68,68,0.3)' }}>
            <span className="text-lg">📡</span>
          </div>
          <span className="badge badge-pink">YouTube Integration</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Channel Integration</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Connect your YouTube channels to analyze performance and get data-driven recommendations
        </p>
      </div>

      {/* API Key Status */}
      {!hasApiKey && (
        <div className="glass rounded-xl p-5 mb-6" style={{
          border: '1px solid rgba(245,158,11,0.3)',
          background: 'rgba(245,158,11,0.05)',
        }}>
          <div className="flex items-start gap-4">
            <span className="text-2xl">⚠️</span>
            <div className="flex-1">
              <h3 className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                No Global YouTube API Key
              </h3>
              <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                Set <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-secondary)' }}>YOUTUBE_API_KEY</code> in Vercel for a default key, or add a per-channel key below.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Add Channel */}
      <div className="glass rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Add Channel</h2>
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>YouTube Channel</label>
              <input
                value={channelUrl}
                onChange={e => setChannelUrl(e.target.value)}
                placeholder="YouTube channel URL or @handle"
                className="input-field"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>Niche</label>
              <input
                value={channelNiche}
                onChange={e => setChannelNiche(e.target.value)}
                placeholder="e.g. Tech, Gaming"
                className="input-field"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>Account Name</label>
              <input
                value={accountLabel}
                onChange={e => setAccountLabel(e.target.value)}
                placeholder="e.g. Main, Client A, Side Project"
                className="input-field"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>Account Email</label>
              <input
                value={accountEmail}
                onChange={e => setAccountEmail(e.target.value)}
                placeholder="email@example.com"
                className="input-field"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>
                YouTube API Key <span style={{ color: 'var(--text-muted)' }}>(optional — overrides global key)</span>
              </label>
              <input
                type="password"
                value={accountApiKey}
                onChange={e => setAccountApiKey(e.target.value)}
                placeholder="AIza... (uses global key if empty)"
                className="input-field"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>Color</label>
              <div className="flex gap-1.5 mt-1">
                {ACCOUNT_COLORS.map(c => (
                  <button key={c.color} onClick={() => setAccountColor(c.color)}
                    className="w-6 h-6 rounded-full transition-all"
                    title={c.label}
                    style={{
                      background: c.color,
                      border: accountColor === c.color ? '2px solid white' : '2px solid transparent',
                      boxShadow: accountColor === c.color ? `0 0 0 2px ${c.color}` : 'none',
                    }} />
                ))}
              </div>
            </div>
          </div>
        </div>
        <button
          onClick={addChannel}
          disabled={!channelUrl.trim() || addingChannel}
          className="btn-primary mt-4 text-sm"
        >
          {addingChannel ? <><div className="spinner" style={{ width: 14, height: 14 }} />Adding...</> : '➕ Add Channel'}
        </button>
      </div>

      {/* Account filter */}
      {(() => {
        const accounts = Array.from(new Set(channels.map(c => c.account_label || 'Unassigned')));
        const filtered = filterAccount
          ? channels.filter(c => (c.account_label || 'Unassigned') === filterAccount)
          : channels;

        return (
          <>
            {channels.length > 0 && accounts.length > 1 && (
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Filter:</span>
                <button onClick={() => setFilterAccount(null)}
                  className="px-3 py-1 rounded-full text-xs transition-all"
                  style={{
                    background: !filterAccount ? 'rgba(124,58,237,0.2)' : 'var(--bg-secondary)',
                    border: `1px solid ${!filterAccount ? 'var(--accent-purple)' : 'var(--border)'}`,
                    color: !filterAccount ? 'var(--accent-purple-bright)' : 'var(--text-secondary)',
                  }}>
                  All ({channels.length})
                </button>
                {accounts.map(acc => {
                  const accChannels = channels.filter(c => (c.account_label || 'Unassigned') === acc);
                  const color = accChannels[0]?.account_color || '#7c3aed';
                  return (
                    <button key={acc} onClick={() => setFilterAccount(filterAccount === acc ? null : acc)}
                      className="px-3 py-1 rounded-full text-xs transition-all flex items-center gap-1.5"
                      style={{
                        background: filterAccount === acc ? `${color}20` : 'var(--bg-secondary)',
                        border: `1px solid ${filterAccount === acc ? color : 'var(--border)'}`,
                        color: filterAccount === acc ? color : 'var(--text-secondary)',
                      }}>
                      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                      {acc} ({accChannels.length})
                    </button>
                  );
                })}
              </div>
            )}

            {/* Channels list */}
            {loading ? (
              <div className="space-y-3">
                {[1, 2].map(i => <div key={i} className="glass rounded-xl p-6 animate-pulse" style={{ height: 100 }} />)}
              </div>
            ) : channels.length === 0 ? (
              <div className="glass rounded-xl p-16 text-center" style={{ color: 'var(--text-muted)' }}>
                <div className="text-5xl mb-4">📡</div>
                <p className="text-lg font-medium mb-2" style={{ color: 'var(--text-primary)' }}>No channels yet</p>
                <p className="text-sm">Add your YouTube channel above to get started</p>
              </div>
            ) : (
              <div className="space-y-4">
                {filtered.map(channel => {
                  const acColor = channel.account_color || '#7c3aed';
                  return (
                    <motion.div
                      key={channel.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="glass rounded-xl p-5"
                      style={{ borderLeft: `3px solid ${acColor}` }}
                    >
                      <div className="flex items-start gap-4">
                        {channel.thumbnail_url ? (
                          <img src={channel.thumbnail_url} alt="" width={56} height={56} className="w-14 h-14 rounded-full object-cover" />
                        ) : (
                          <div className="w-14 h-14 rounded-full flex items-center justify-center text-2xl"
                            style={{ background: 'var(--bg-secondary)' }}>📺</div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{channel.name}</h3>
                            {channel.account_label && (
                              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${acColor}20`, color: acColor, border: `1px solid ${acColor}40` }}>
                                {channel.account_label}
                              </span>
                            )}
                          </div>
                          {channel.handle && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{channel.handle}</p>}
                          <div className="flex items-center gap-4 mt-2 text-xs flex-wrap" style={{ color: 'var(--text-muted)' }}>
                            <span>👥 {formatNumber(channel.subscriber_count)} subscribers</span>
                            <span>🎬 {channel.video_count} videos</span>
                            {channel.niche && <span className="badge badge-purple text-xs">{channel.niche}</span>}
                            {channel.account_email && <span>📧 {channel.account_email}</span>}
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => syncChannel(channel.id)}
                            disabled={syncing === channel.id || (!hasApiKey && !channel.account_color)}
                            className="btn-secondary text-sm"
                          >
                            {syncing === channel.id ? <div className="spinner" style={{ width: 14, height: 14 }} /> : '🔄 Sync'}
                          </button>
                          <button
                            onClick={() => analyzeChannel(channel.id)}
                            className="btn-primary text-sm"
                          >
                            📊 Analyze
                          </button>
                          <button
                            onClick={() => deleteChannel(channel.id)}
                            className="p-2 rounded-lg text-xs transition-all"
                            style={{ color: '#ef4444', background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                            title="Remove channel"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      {channel.last_synced_at && (
                        <p className="text-xs mt-3 pt-3" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
                          Last synced: {new Date(channel.last_synced_at).toLocaleDateString()}
                        </p>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
