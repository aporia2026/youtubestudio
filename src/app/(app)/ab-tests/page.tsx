'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AB_TEST_TITLE_MAX_LENGTH,
  type AbTestRow,
  type AbTestSnapshotRow,
  type AbTestStatus,
  type AbTestVariant,
  type AbTestVariantSummary,
} from '@/lib/ab-tests-types';

interface ChannelListItem {
  id: string;
  name: string;
  channel_id: string;
  oauth_connected: boolean;
}

interface DetailPayload {
  test: AbTestRow;
  snapshots: AbTestSnapshotRow[];
  summary: { a: AbTestVariantSummary; b: AbTestVariantSummary };
}

export default function AbTestsPage() {
  const [tests, setTests] = useState<AbTestRow[]>([]);
  const [channels, setChannels] = useState<ChannelListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // Create-form state
  const [newChannelDbId, setNewChannelDbId] = useState('');
  const [newVideoId, setNewVideoId] = useState('');
  const [newTitleA, setNewTitleA] = useState('');
  const [newTitleB, setNewTitleB] = useState('');
  const [newThumbA, setNewThumbA] = useState('');
  const [newThumbB, setNewThumbB] = useState('');

  // Expanded detail state
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [chRes, abRes] = await Promise.all([
          fetch('/api/channels'),
          fetch('/api/ab-tests?limit=100'),
        ]);
        if (cancelled) return;
        if (chRes.ok) setChannels(((await chRes.json()).channels as ChannelListItem[]) || []);
        if (abRes.ok) setTests(((await abRes.json()).tests as AbTestRow[]) || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshList() {
    const r = await fetch('/api/ab-tests?limit=100', { cache: 'no-store' });
    if (r.ok) setTests(((await r.json()).tests as AbTestRow[]) || []);
  }

  async function loadDetail(id: string) {
    setDetailBusy(true);
    try {
      const r = await fetch(`/api/ab-tests/${id}`, { cache: 'no-store' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${r.status}`);
      }
      const payload = (await r.json()) as DetailPayload;
      setDetail(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load test');
      setDetail(null);
    } finally {
      setDetailBusy(false);
    }
  }

  async function handleToggle(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    await loadDetail(id);
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/ab-tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelDbId: newChannelDbId || null,
          youtubeVideoId: newVideoId.trim(),
          variantATitle: newTitleA.trim(),
          variantBTitle: newTitleB.trim(),
          variantAThumbnailUrl: newThumbA.trim() || null,
          variantBThumbnailUrl: newThumbB.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      // Reset + refresh
      setNewVideoId('');
      setNewTitleA('');
      setNewTitleB('');
      setNewThumbA('');
      setNewThumbB('');
      setShowCreate(false);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  }

  async function handleSwap(id: string, toVariant: AbTestVariant) {
    setDetailBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ab-tests/${id}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toVariant }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      await loadDetail(id);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Swap failed');
    } finally {
      setDetailBusy(false);
    }
  }

  async function handleSnapshot(id: string) {
    setDetailBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ab-tests/${id}/snapshot`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      await loadDetail(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snapshot failed');
    } finally {
      setDetailBusy(false);
    }
  }

  async function handleConclude(id: string, winner: AbTestVariant) {
    if (!confirm(`Push variant ${winner.toUpperCase()} live and conclude this test?`)) return;
    setDetailBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ab-tests/${id}/conclude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winner }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      await loadDetail(id);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Conclude failed');
    } finally {
      setDetailBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this A/B test? Snapshots will be deleted too.')) return;
    setDetailBusy(true);
    try {
      await fetch(`/api/ab-tests/${id}`, { method: 'DELETE' });
      setOpenId(null);
      setDetail(null);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDetailBusy(false);
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">A/B Tests</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Native YouTube title + thumbnail experiments. Push variant A or B live, snapshot Analytics, pick the winner.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="btn-primary text-sm"
        >
          {showCreate ? 'Cancel' : '＋ New test'}
        </button>
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          {error}
        </div>
      )}

      {showCreate && (
        <div className="glass rounded-xl p-5 mb-6">
          <h2 className="text-lg font-semibold mb-4">New A/B test</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Channel" hint="The OAuth-connected channel that owns the video.">
              <select
                value={newChannelDbId}
                onChange={(e) => setNewChannelDbId(e.target.value)}
                className="input-field"
              >
                <option value="">— pick a channel —</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.oauth_connected}>
                    {c.name}{c.oauth_connected ? '' : ' (not connected)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="YouTube video id" hint='Just the 11-char id, e.g. "dQw4w9WgXcQ".'>
              <input
                type="text"
                value={newVideoId}
                onChange={(e) => setNewVideoId(e.target.value)}
                className="input-field"
                placeholder="dQw4w9WgXcQ"
              />
            </Field>
            <Field label="Variant A — title">
              <input
                type="text"
                maxLength={AB_TEST_TITLE_MAX_LENGTH}
                value={newTitleA}
                onChange={(e) => setNewTitleA(e.target.value)}
                className="input-field"
              />
              <CharCounter value={newTitleA} max={AB_TEST_TITLE_MAX_LENGTH} />
            </Field>
            <Field label="Variant B — title">
              <input
                type="text"
                maxLength={AB_TEST_TITLE_MAX_LENGTH}
                value={newTitleB}
                onChange={(e) => setNewTitleB(e.target.value)}
                className="input-field"
              />
              <CharCounter value={newTitleB} max={AB_TEST_TITLE_MAX_LENGTH} />
            </Field>
            <Field label="Variant A — thumbnail URL (optional)">
              <input
                type="url"
                value={newThumbA}
                onChange={(e) => setNewThumbA(e.target.value)}
                className="input-field"
                placeholder="https://…"
              />
            </Field>
            <Field label="Variant B — thumbnail URL (optional)">
              <input
                type="url"
                value={newThumbB}
                onChange={(e) => setNewThumbB(e.target.value)}
                className="input-field"
                placeholder="https://…"
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !newVideoId.trim() || !newTitleA.trim() || !newTitleB.trim()}
              className="btn-primary text-sm"
            >
              {creating ? 'Creating…' : 'Create test'}
            </button>
          </div>
        </div>
      )}

      {tests.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center" style={{ color: 'var(--text-muted)' }}>
          No A/B tests yet.{' '}
          <Link href="/thumbnails" className="underline">Generate variants on /thumbnails</Link>{' '}
          first if you don&apos;t have URLs ready.
        </div>
      ) : (
        <div className="space-y-3">
          {tests.map((t) => (
            <div key={t.id} className="glass rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => handleToggle(t.id)}
                className="w-full px-5 py-4 flex items-center gap-4 text-left"
              >
                <StatusBadge status={t.status} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{shortVideo(t.youtube_video_id)} — A vs B</div>
                  <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                    A: {truncate(t.variant_a_title, 60)} · B: {truncate(t.variant_b_title, 60)}
                  </div>
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Live: {t.live_variant.toUpperCase()}
                  {t.winner && ` · 🏆 ${t.winner.toUpperCase()}`}
                </div>
              </button>
              {openId === t.id && (
                <div className="border-t px-5 py-5" style={{ borderColor: 'var(--border)' }}>
                  {detailBusy && !detail ? (
                    <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</div>
                  ) : detail ? (
                    <DetailView
                      payload={detail}
                      busy={detailBusy}
                      onSwap={(variant) => handleSwap(t.id, variant)}
                      onSnapshot={() => handleSnapshot(t.id)}
                      onConclude={(winner) => handleConclude(t.id, winner)}
                      onDelete={() => handleDelete(t.id)}
                    />
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
    </div>
  );
}

function CharCounter({ value, max }: { value: string; max: number }) {
  const pct = value.length / max;
  const color = pct > 0.95 ? '#f87171' : pct > 0.8 ? '#fbbf24' : 'var(--text-muted)';
  return (
    <div className="text-[10px] mt-1 text-right" style={{ color }}>
      {value.length}/{max}
    </div>
  );
}

function StatusBadge({ status }: { status: AbTestStatus }) {
  const styles: Record<AbTestStatus, { bg: string; color: string; label: string }> = {
    draft: { bg: 'rgba(120,120,120,0.15)', color: 'var(--text-muted)', label: 'Draft' },
    running: { bg: 'rgba(34,197,94,0.15)', color: '#4ade80', label: 'Running' },
    concluded: { bg: 'rgba(168,85,247,0.15)', color: '#c084fc', label: 'Concluded' },
  };
  const s = styles[status];
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: s.bg, color: s.color }}
    >
      {s.label}
    </span>
  );
}

function DetailView({
  payload,
  busy,
  onSwap,
  onSnapshot,
  onConclude,
  onDelete,
}: {
  payload: DetailPayload;
  busy: boolean;
  onSwap: (v: AbTestVariant) => void;
  onSnapshot: () => void;
  onConclude: (v: AbTestVariant) => void;
  onDelete: () => void;
}) {
  const { test, snapshots, summary } = payload;
  const concluded = test.status === 'concluded';
  const swapDisabled = busy || concluded;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <VariantCard
          variant="a"
          title={test.variant_a_title}
          thumbnailUrl={test.variant_a_thumbnail_url}
          live={test.live_variant === 'a'}
          winner={test.winner === 'a'}
          summary={summary.a}
          onSwap={() => onSwap('a')}
          onConclude={() => onConclude('a')}
          swapDisabled={swapDisabled || test.live_variant === 'a'}
          concludeDisabled={busy || concluded}
        />
        <VariantCard
          variant="b"
          title={test.variant_b_title}
          thumbnailUrl={test.variant_b_thumbnail_url}
          live={test.live_variant === 'b'}
          winner={test.winner === 'b'}
          summary={summary.b}
          onSwap={() => onSwap('b')}
          onConclude={() => onConclude('b')}
          swapDisabled={swapDisabled || test.live_variant === 'b'}
          concludeDisabled={busy || concluded}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Started: {test.started_at ? new Date(test.started_at).toLocaleString() : '—'}
          {test.last_swapped_at && ` · Last swap: ${new Date(test.last_swapped_at).toLocaleString()}`}
          {test.concluded_at && ` · Concluded: ${new Date(test.concluded_at).toLocaleString()}`}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onSnapshot}
            disabled={busy || test.status === 'draft'}
            className="text-xs px-3 py-1.5 rounded"
            style={{ background: 'rgba(59,130,246,0.12)', color: '#60a5fa' }}
            title={test.status === 'draft' ? 'Push a variant live first' : 'Pull latest YouTube Analytics'}
          >
            ↻ Snapshot
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
          >
            Delete
          </button>
        </div>
      </div>

      {snapshots.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
            Snapshot history ({snapshots.length})
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
                  <Th>When</Th>
                  <Th>Variant</Th>
                  <Th>Impressions</Th>
                  <Th>Views</Th>
                  <Th>CTR</Th>
                  <Th>AVD (s)</Th>
                  <Th>Subs</Th>
                </tr>
              </thead>
              <tbody>
                {[...snapshots].reverse().map((s) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <Td>{new Date(s.captured_at).toLocaleString()}</Td>
                    <Td>{s.variant.toUpperCase()}</Td>
                    <Td>{fmtNum(s.impressions)}</Td>
                    <Td>{fmtNum(s.views)}</Td>
                    <Td>{fmtPct(s.ctr_percentage)}</Td>
                    <Td>{fmtNum(s.average_view_duration_seconds)}</Td>
                    <Td>{fmtNum(s.subscribers_gained)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function VariantCard({
  variant,
  title,
  thumbnailUrl,
  live,
  winner,
  summary,
  onSwap,
  onConclude,
  swapDisabled,
  concludeDisabled,
}: {
  variant: AbTestVariant;
  title: string;
  thumbnailUrl: string | null;
  live: boolean;
  winner: boolean;
  summary: AbTestVariantSummary;
  onSwap: () => void;
  onConclude: () => void;
  swapDisabled: boolean;
  concludeDisabled: boolean;
}) {
  return (
    <div
      className="rounded-lg p-4"
      style={{
        border: live ? '2px solid #4ade80' : '1px solid var(--border)',
        background: 'var(--bg-card)',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>
          Variant {variant.toUpperCase()}
          {live && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>LIVE</span>}
          {winner && <span className="ml-2">🏆</span>}
        </div>
      </div>
      {thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnailUrl}
          alt={`Variant ${variant} thumbnail`}
          style={{
            width: '100%',
            aspectRatio: '16 / 9',
            objectFit: 'cover',
            borderRadius: 6,
            marginBottom: 8,
            background: '#000',
          }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            aspectRatio: '16 / 9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: 12,
            border: '1px dashed var(--border)',
            borderRadius: 6,
            marginBottom: 8,
          }}
        >
          (no thumbnail — title-only swap)
        </div>
      )}
      <p className="text-sm font-medium mb-3 leading-snug" style={{ color: 'var(--text-primary)' }}>
        {title}
      </p>
      <div className="grid grid-cols-3 gap-2 mb-3 text-center">
        <Stat label="CTR" value={fmtPct(summary.ctr_percentage)} />
        <Stat label="Views" value={fmtNum(summary.views)} />
        <Stat label="Impr." value={fmtNum(summary.impressions)} />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSwap}
          disabled={swapDisabled}
          className="flex-1 text-xs py-1.5 rounded"
          style={{
            background: swapDisabled ? 'rgba(120,120,120,0.10)' : 'rgba(59,130,246,0.12)',
            color: swapDisabled ? 'var(--text-muted)' : '#60a5fa',
          }}
        >
          {live ? 'Already live' : `Push ${variant.toUpperCase()} live`}
        </button>
        <button
          type="button"
          onClick={onConclude}
          disabled={concludeDisabled}
          className="text-xs px-3 py-1.5 rounded"
          style={{
            background: concludeDisabled ? 'rgba(120,120,120,0.10)' : 'rgba(168,85,247,0.12)',
            color: concludeDisabled ? 'var(--text-muted)' : '#c084fc',
          }}
          title={`Pick ${variant.toUpperCase()} as the winner`}
        >
          🏆
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '6px 10px',
        textAlign: 'left',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
        fontSize: '0.7rem',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: '6px 10px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
      {children}
    </td>
  );
}

function shortVideo(id: string): string {
  return id.length > 11 ? id.slice(0, 11) + '…' : id;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
}

function fmtNum(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

function fmtPct(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return `${n.toFixed(2)}%`;
}
