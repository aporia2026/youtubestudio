'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { formatNumber } from '@/lib/utils';
import { GenerateDescriptionModal } from '@/components/channel/GenerateDescriptionModal';

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
  has_api_key: boolean;
  oauth_connected: boolean;
}

interface VideoItem {
  video_id: string;
  title: string;
  thumbnail_url: string;
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
  const [hasOAuthConfig, setHasOAuthConfig] = useState(false);
  const [filterAccount, setFilterAccount] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  // Thumbnail upload state
  const [thumbnailModal, setThumbnailModal] = useState<{ channelId: string; channelName: string } | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [uploadingThumbnail, setUploadingThumbnail] = useState<string | null>(null);
  // Channel description + AI-generator state. Description is what gets
  // persisted to channels.description on create; brief is what gets stored
  // alongside it so the next regeneration prefills with the prior brief.
  const [channelDescription, setChannelDescription] = useState('');
  const [channelDescriptionBrief, setChannelDescriptionBrief] = useState('');
  const [descModalOpen, setDescModalOpen] = useState(false);

  useEffect(() => {
    fetchChannels();
    checkApiKey();
  }, []);

  // Handle OAuth callback query params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    if (oauth === 'success') {
      toast.success('YouTube channel connected successfully!');
      fetchChannels();
    } else if (oauth === 'denied') {
      toast.error('YouTube authorization was denied');
    } else if (oauth === 'error') {
      toast.error('OAuth connection failed — please try again');
    }
    // Clean up URL
    if (oauth) {
      window.history.replaceState({}, '', '/channel');
    }
  }, []);

  async function checkApiKey() {
    try {
      const res = await fetch('/api/channel/status');
      if (res.ok) {
        const data = await res.json();
        setHasApiKey(data.hasApiKey);
        setHasOAuthConfig(data.hasOAuthConfig);
      }
    } catch {}
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
          // Optional — fall through to the YouTube-fetched About when blank.
          description: channelDescription.trim() || undefined,
          descriptionBrief: channelDescriptionBrief.trim() || undefined,
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      toast.success('Channel added!');
      setChannelUrl(''); setChannelNiche(''); setAccountLabel(''); setAccountEmail(''); setAccountApiKey('');
      setChannelDescription(''); setChannelDescriptionBrief('');
      fetchChannels();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add channel');
    } finally { setAddingChannel(false); }
  }

  async function connectOAuth(channelId: string) {
    window.location.href = `/api/auth/google?channelId=${channelId}`;
  }

  async function disconnectOAuth(channelId: string) {
    if (!confirm('Disconnect YouTube OAuth for this channel?')) return;
    setDisconnecting(channelId);
    try {
      const res = await fetch('/api/auth/google/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
      });
      if (!res.ok) throw new Error('Disconnect failed');
      toast.success('YouTube disconnected');
      fetchChannels();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Disconnect failed');
    } finally { setDisconnecting(null); }
  }

  async function syncChannel(channelId: string) {
    setSyncing(channelId);
    try {
      const res = await fetch(`/api/channels/${channelId}/sync`, { method: 'POST' });
      if (!res.ok) { const e = await res.json().catch(() => ({ error: 'Sync failed' })); throw new Error(e.error); }
      toast.success('Channel synced!');
      fetchChannels();
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Sync failed'); }
    finally { setSyncing(null); }
  }

  async function analyzeChannel(channelId: string) {
    toast.info('Analyzing channel... This may take a moment.');
    try {
      const res = await fetch(`/api/channels/${channelId}/analyze`, { method: 'POST' });
      if (!res.ok) { const e = await res.json().catch(() => ({ error: 'Analysis failed' })); throw new Error(e.error); }
      toast.success('Analysis complete!');
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Analysis failed'); }
  }

  async function deleteChannel(channelId: string) {
    if (!confirm('Remove this channel?')) return;
    try {
      await fetch(`/api/channels/${channelId}`, { method: 'DELETE' });
      setChannels(prev => prev.filter(c => c.id !== channelId));
      toast.success('Channel removed');
    } catch { toast.error('Failed to remove channel'); }
  }

  async function openThumbnailModal(channel: Channel) {
    setThumbnailModal({ channelId: channel.id, channelName: channel.name });
    setLoadingVideos(true);
    setVideos([]);
    try {
      const res = await fetch(`/api/channels/${channel.id}`);
      if (res.ok) {
        const data = await res.json();
        setVideos(data.videos || []);
      }
    } catch {} finally { setLoadingVideos(false); }
  }

  async function uploadThumbnailFile(videoId: string, file: File) {
    if (!thumbnailModal) return;
    setUploadingThumbnail(videoId);
    try {
      const formData = new FormData();
      formData.append('channelId', thumbnailModal.channelId);
      formData.append('videoId', videoId);
      formData.append('image', file);

      const res = await fetch('/api/youtube/thumbnail', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success('Thumbnail uploaded to YouTube!');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally { setUploadingThumbnail(null); }
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

      {/* API Key / OAuth Status */}
      {!hasApiKey && !hasOAuthConfig && (
        <div className="glass rounded-xl p-5 mb-6" style={{
          border: '1px solid rgba(245,158,11,0.3)',
          background: 'rgba(245,158,11,0.05)',
        }}>
          <div className="flex items-start gap-4">
            <span className="text-2xl">⚠️</span>
            <div className="flex-1">
              <h3 className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                No YouTube Connection Configured
              </h3>
              <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                Set <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-secondary)' }}>GOOGLE_CLIENT_ID</code> + <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-secondary)' }}>GOOGLE_CLIENT_SECRET</code> for OAuth, or <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-secondary)' }}>YOUTUBE_API_KEY</code> for read-only access.
              </p>
            </div>
          </div>
        </div>
      )}

      {hasOAuthConfig && (
        <div className="glass rounded-xl p-5 mb-6" style={{
          border: '1px solid rgba(16,185,129,0.3)',
          background: 'rgba(16,185,129,0.05)',
        }}>
          <div className="flex items-start gap-4">
            <span className="text-2xl">🔗</span>
            <div className="flex-1">
              <h3 className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                YouTube OAuth Ready
              </h3>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Add a channel below, then click <strong>Connect YouTube</strong> to authorize full access (upload thumbnails, manage videos).
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
          {/* Description (optional on add — falls back to the YouTube About if left blank) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                Description <span style={{ color: 'var(--text-muted)' }}>(optional — uses YouTube About if blank)</span>
              </label>
              <button
                type="button"
                onClick={() => setDescModalOpen(true)}
                disabled={!channelUrl.trim()}
                className="text-xs flex items-center gap-1 transition-colors"
                style={{
                  color: channelUrl.trim() ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                  cursor: channelUrl.trim() ? 'pointer' : 'not-allowed',
                }}
                title={channelUrl.trim() ? 'Generate with AI' : 'Add a YouTube URL or @handle first'}
              >
                ✨ Generate with AI
              </button>
            </div>
            <textarea
              value={channelDescription}
              onChange={e => setChannelDescription(e.target.value)}
              placeholder="Write or generate the channel's About copy. Leave blank to use the description from YouTube."
              rows={4}
              className="input-field"
              style={{ resize: 'vertical' }}
            />
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
                      <div className="flex items-start gap-4 flex-wrap">
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
                            {channel.oauth_connected && (
                              <span className="text-xs px-2 py-0.5 rounded-full" style={{
                                background: 'rgba(16,185,129,0.15)',
                                color: '#10b981',
                                border: '1px solid rgba(16,185,129,0.3)',
                              }}>
                                OAuth Connected
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
                        <div className="flex gap-2 shrink-0 flex-wrap">
                          {/* OAuth Connect/Disconnect */}
                          {hasOAuthConfig && !channel.oauth_connected && (
                            <button
                              onClick={() => connectOAuth(channel.id)}
                              className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5"
                              style={{
                                background: 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(6,182,212,0.2))',
                                border: '1px solid rgba(16,185,129,0.4)',
                                color: '#10b981',
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                                <polyline points="10 17 15 12 10 7" />
                                <line x1="15" y1="12" x2="3" y2="12" />
                              </svg>
                              Connect YouTube
                            </button>
                          )}
                          {channel.oauth_connected && (
                            <>
                              <button
                                onClick={() => openThumbnailModal(channel)}
                                className="btn-secondary text-sm"
                                title="Upload thumbnails to videos"
                              >
                                🖼️ Thumbnails
                              </button>
                              <button
                                onClick={() => disconnectOAuth(channel.id)}
                                disabled={disconnecting === channel.id}
                                className="px-3 py-1.5 rounded-lg text-sm transition-all"
                                style={{
                                  background: 'rgba(239,68,68,0.1)',
                                  border: '1px solid rgba(239,68,68,0.3)',
                                  color: '#ef4444',
                                }}
                              >
                                {disconnecting === channel.id ? <div className="spinner" style={{ width: 14, height: 14 }} /> : 'Disconnect'}
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => syncChannel(channel.id)}
                            disabled={syncing === channel.id || (!hasApiKey && !channel.has_api_key && !channel.oauth_connected)}
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
                          <a
                            href={`/channel/${channel.id}/description`}
                            className="btn-secondary text-sm"
                            title="Edit the YouTube About description — or regenerate it with AI"
                          >
                            ✨ Description
                          </a>
                          <a
                            href={`/channel/${channel.id}/brand-kit`}
                            className="btn-secondary text-sm"
                            title="Voice / tone / banned-phrase guidance auto-piped into script generation when this channel is active"
                          >
                            📝 Script kit
                          </a>
                          <a
                            href={`/channel/${channel.id}/visual-brand-kit`}
                            className="btn-secondary text-sm"
                            title="Fonts, colors, and logo used by the Remotion video renderer for every video on this channel"
                          >
                            🎨 Visual kit
                          </a>
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

      {/* Thumbnail Upload Modal */}
      <AnimatePresence>
        {thumbnailModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={() => setThumbnailModal(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="glass rounded-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto"
              style={{ border: '1px solid var(--border)' }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                  Upload Thumbnail — {thumbnailModal.channelName}
                </h2>
                <button onClick={() => setThumbnailModal(null)} className="text-lg" style={{ color: 'var(--text-muted)' }}>✕</button>
              </div>
              <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                Select a video and upload a custom thumbnail image.
              </p>

              {loadingVideos ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-lg animate-pulse" style={{ background: 'var(--bg-secondary)' }} />)}
                </div>
              ) : videos.length === 0 ? (
                <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
                  <p>No videos found. Sync your channel first.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {videos.map(video => (
                    <div key={video.video_id} className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                      {video.thumbnail_url && (
                        <img src={video.thumbnail_url} alt="" className="w-24 h-14 rounded object-cover shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{video.title}</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{video.video_id}</p>
                      </div>
                      <label className="btn-primary text-xs cursor-pointer shrink-0 flex items-center gap-1">
                        {uploadingThumbnail === video.video_id ? (
                          <><div className="spinner" style={{ width: 12, height: 12 }} /> Uploading...</>
                        ) : (
                          <>🖼️ Upload</>
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          disabled={uploadingThumbnail !== null}
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (file) uploadThumbnailFile(video.video_id, file);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI description generator — shared with /channel/[id]/description.
          Unconnected mode here (no channelId yet) so it uses the form's
          current name (the URL doubles as the name until YouTube resolves
          the real one server-side) and niche. */}
      <GenerateDescriptionModal
        open={descModalOpen}
        onClose={() => setDescModalOpen(false)}
        channelName={channelUrl}
        channelNiche={channelNiche}
        initialBrief={channelDescriptionBrief}
        currentDescription={channelDescription || undefined}
        onApply={({ description, brief }) => {
          setChannelDescription(description);
          setChannelDescriptionBrief(brief);
          toast.success('Description applied — review then save');
        }}
      />
    </div>
  );
}
