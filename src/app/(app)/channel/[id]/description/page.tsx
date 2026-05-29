'use client';

/**
 * Channel description editor — sibling to /brand-kit and /visual-brand-kit.
 * Edits the YouTube "About" copy on a single channel and persists the brief
 * that produced it, so the next time the user opens this page the AI
 * generator prefills with the prior brief.
 *
 * Save endpoint: PATCH /api/channels/[id] (description + description_brief
 * only — that route is scoped on purpose).
 */

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { GenerateDescriptionModal } from '@/components/channel/GenerateDescriptionModal';

export default function ChannelDescriptionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [channelName, setChannelName] = useState('');
  const [description, setDescription] = useState('');
  const [brief, setBrief] = useState('');
  const [modalOpen, setModalOpen] = useState(false);

  // Initial values snapshot — used to compute the "unsaved changes" badge.
  const [initial, setInitial] = useState({ description: '', brief: '' });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch(`/api/channels/${id}`);
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || 'Failed to load channel');
        }
        const { channel } = (await res.json()) as {
          channel: { name?: string; description?: string | null; description_brief?: string | null };
        };
        if (cancelled) return;
        const desc = channel.description ?? '';
        const br = channel.description_brief ?? '';
        setChannelName(channel.name ?? '');
        setDescription(desc);
        setBrief(br);
        setInitial({ description: desc, brief: br });
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited PATCH RPC - awaits and uses response
      const res = await fetch(`/api/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim() || null,
          descriptionBrief: brief.trim() || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Save failed');
      }
      const { description: savedDesc, description_brief: savedBrief } = (await res.json()) as {
        description: string | null;
        description_brief: string | null;
      };
      setDescription(savedDesc ?? '');
      setBrief(savedBrief ?? '');
      setInitial({ description: savedDesc ?? '', brief: savedBrief ?? '' });
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded && !error) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>;
  }

  const dirty = description !== initial.description || brief !== initial.brief;
  const ytLimit = 1000; // YouTube About hard limit — surface so the user sees overage
  const overLimit = description.length > ytLimit;

  return (
    <div style={{ padding: 24, maxWidth: 920, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <Link
          href="/channel"
          style={{ fontSize: 13, color: 'var(--text-muted)', textDecoration: 'none' }}
          className="hover:underline"
        >
          ← All channels
        </Link>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', marginTop: 6 }}>
          Channel description{channelName ? ` — ${channelName}` : ''}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
          The YouTube &ldquo;About&rdquo; copy for this channel. Generate with AI from a brief, or edit by hand.
        </p>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          Other settings:{' '}
          <Link href={`/channel/${id}/brand-kit`} className="hover:underline" style={{ color: 'var(--text-secondary)' }}>
            script brand kit
          </Link>
          {' · '}
          <Link href={`/channel/${id}/visual-brand-kit`} className="hover:underline" style={{ color: 'var(--text-secondary)' }}>
            visual brand kit
          </Link>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#ef4444',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={onSave} className="space-y-5">
        {/* Description */}
        <div className="glass rounded-xl p-5" style={{ border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-2">
            <div>
              <label className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                About description
              </label>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Pastes directly into YouTube&rsquo;s channel About field.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="text-xs flex items-center gap-1"
              style={{ color: 'var(--accent-purple-bright)' }}
            >
              ✨ Generate with AI
            </button>
          </div>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Empty — click Generate with AI to draft a description, or write one by hand."
            rows={Math.min(20, Math.max(8, description.split('\n').length + 1))}
            className="w-full px-3 py-2 rounded-lg text-sm"
            style={{
              background: 'var(--bg-secondary)',
              border: `1px solid ${overLimit ? 'rgba(239,68,68,0.5)' : 'var(--border)'}`,
              color: 'var(--text-primary)',
              resize: 'vertical',
            }}
          />
          <div className="flex items-center justify-between text-xs mt-1.5">
            <span style={{ color: overLimit ? '#fca5a5' : 'var(--text-muted)' }}>
              {description.length.toLocaleString()} / {ytLimit.toLocaleString()} chars
              {overLimit ? ' — YouTube will reject anything over 1,000 chars when you paste this in.' : ''}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>~{description.trim().split(/\s+/).filter(Boolean).length} words</span>
          </div>
        </div>

        {/* Brief — read-mostly. Editable so the user can tune without
            re-opening the modal, but the primary writer is the modal. */}
        <div className="glass rounded-xl p-5" style={{ border: '1px solid var(--border)' }}>
          <label className="text-sm font-semibold mb-1 block" style={{ color: 'var(--text-primary)' }}>
            Brief (saved alongside the description)
          </label>
          <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
            What you told the AI to write about. Stored so the next regeneration prefills with this brief — edit it any time.
          </p>
          <textarea
            value={brief}
            onChange={e => setBrief(e.target.value)}
            placeholder="No brief stored yet. Open the generator to write one."
            rows={4}
            className="w-full px-3 py-2 rounded-lg text-sm"
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              resize: 'vertical',
            }}
          />
        </div>

        {/* Save bar */}
        <div className="flex items-center justify-between pt-1">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {dirty
              ? 'Unsaved changes'
              : savedAt
                ? `Saved ${new Date(savedAt).toLocaleTimeString()}`
                : 'No changes'}
          </div>
          <button
            type="submit"
            disabled={saving || !dirty}
            className="btn-primary"
            style={{ opacity: !dirty || saving ? 0.5 : 1, cursor: !dirty || saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? (
              <>
                <div className="spinner" style={{ width: 14, height: 14 }} />
                Saving…
              </>
            ) : (
              'Save'
            )}
          </button>
        </div>
      </form>

      <GenerateDescriptionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        channelId={id}
        initialBrief={brief}
        currentDescription={description || undefined}
        onApply={({ description: newDesc, brief: newBrief }) => {
          setDescription(newDesc);
          setBrief(newBrief);
        }}
      />
    </div>
  );
}
