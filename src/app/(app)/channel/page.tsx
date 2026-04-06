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
}

export default function ChannelPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingChannel, setAddingChannel] = useState(false);
  const [channelUrl, setChannelUrl] = useState('');
  const [channelNiche, setChannelNiche] = useState('');
  const [syncing, setSyncing] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);

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
        body: JSON.stringify({ url: channelUrl, niche: channelNiche }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      toast.success('Channel added!');
      setChannelUrl(''); setChannelNiche('');
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
      const res = await fetch(`/api/channels/${channelId}/analyze`, { method: 'POST' });
      const data = await res.json();
      // Show analysis in a modal or navigate
      toast.success('Analysis complete!');
    } catch { toast.error('Analysis failed'); }
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
      <div className="glass rounded-xl p-5 mb-6" style={{
        border: `1px solid ${hasApiKey ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)'}`,
        background: hasApiKey ? 'rgba(16,185,129,0.05)' : 'rgba(245,158,11,0.05)',
      }}>
        <div className="flex items-start gap-4">
          <span className="text-2xl">{hasApiKey ? '✅' : '⚠️'}</span>
          <div className="flex-1">
            <h3 className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
              YouTube Data API {hasApiKey ? 'Connected' : 'Not Configured'}
            </h3>
            {hasApiKey ? (
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                YouTube API is configured. You can add and sync channels.
              </p>
            ) : (
              <div>
                <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                  Add your YouTube Data API key to enable channel scraping and analysis.
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Set <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-secondary)' }}>YOUTUBE_API_KEY</code> in your Vercel environment variables.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Add Channel */}
      <div className="glass rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Add Channel</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <input
              value={channelUrl}
              onChange={e => setChannelUrl(e.target.value)}
              placeholder="YouTube channel URL or @handle"
              className="input-field"
            />
          </div>
          <div>
            <input
              value={channelNiche}
              onChange={e => setChannelNiche(e.target.value)}
              placeholder="Niche (optional)"
              className="input-field"
            />
          </div>
        </div>
        <button
          onClick={addChannel}
          disabled={!channelUrl.trim() || addingChannel}
          className="btn-primary mt-3 text-sm"
        >
          {addingChannel ? <><div className="spinner" style={{ width: 14, height: 14 }} />Adding...</> : '➕ Add Channel'}
        </button>
      </div>

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
          {channels.map(channel => (
            <motion.div
              key={channel.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass rounded-xl p-5"
            >
              <div className="flex items-start gap-4">
                {channel.thumbnail_url ? (
                  <img src={channel.thumbnail_url} alt="" className="w-14 h-14 rounded-full object-cover" />
                ) : (
                  <div className="w-14 h-14 rounded-full flex items-center justify-center text-2xl"
                    style={{ background: 'var(--bg-secondary)' }}>📺</div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{channel.name}</h3>
                  {channel.handle && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{channel.handle}</p>}
                  <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span>👥 {formatNumber(channel.subscriber_count)} subscribers</span>
                    <span>🎬 {channel.video_count} videos</span>
                    {channel.niche && <span className="badge badge-purple text-xs">{channel.niche}</span>}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => syncChannel(channel.id)}
                    disabled={syncing === channel.id || !hasApiKey}
                    className="btn-secondary text-sm"
                  >
                    {syncing === channel.id ? <div className="spinner" style={{ width: 14, height: 14 }} /> : '🔄 Sync'}
                  </button>
                  <button
                    onClick={() => analyzeChannel(channel.id)}
                    disabled={!hasApiKey}
                    className="btn-primary text-sm"
                  >
                    📊 Analyze
                  </button>
                </div>
              </div>
              {channel.last_synced_at && (
                <p className="text-xs mt-3 pt-3" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
                  Last synced: {new Date(channel.last_synced_at).toLocaleDateString()}
                </p>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
