'use client';

/**
 * /recover-lost-images — one-off recovery tool (2026-05-22).
 *
 * Background:
 *   Generated image URLs (and overlay URLs, and B-roll clip references)
 *   were silently lost in three race conditions before the 2026-05-22
 *   atomic row-asset fix. The URLs themselves were never gone from
 *   the *client* — they sat in the `production_doc_history`
 *   localStorage cache the legacy `updateProductionDocEntry` writes
 *   to. The server's `user_history` row simply never received them.
 *
 *   This page walks the local cache, compares each entry against the
 *   server, and re-attaches anything the server doesn't already have.
 *   Idempotent and safe to re-run.
 *
 * Why a dedicated page (vs. a console snippet):
 *   The user paid real money for generations that the server lost.
 *   A discoverable UI with a progress indicator and a clear summary
 *   beats a "paste this into the console" recipe — rule 10 (lazy
 *   user), and rule 12 (be honest about the damage and the path
 *   back).
 *
 * Scope: production-doc rows only — rowImages + rowOverlays +
 * rowVideoClips. Editor-only state isn't in the legacy cache, so it
 * doesn't apply.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  getProductionDocHistoryCached,
  type ProductionDocHistoryEntry,
} from '@/lib/history';

interface ServerState {
  rowImages: Record<number, string>;
  rowOverlays: Record<number, { status: string; url?: string }>;
  rowVideoClips: Record<number, { status: string; videoUrl?: string; durationSeconds?: number; brollClipId?: string }>;
  rowCount: number;
}

interface ScanRow {
  id: string;
  title: string;
  topic: string;
  timestamp: number;
  local: {
    images: Record<number, string>;
    overlays: Record<number, { status: string; url?: string }>;
    clips: Record<number, string>;
  };
  serverState: ServerState | null;
  loadError: string | null;
  missingImages: number;
  missingOverlays: number;
  missingClips: number;
  // recover state
  status: 'pending' | 'scanning' | 'ready' | 'recovering' | 'done' | 'error';
  recovered: { images: number; overlays: number; clips: number };
  errors: string[];
}

function uuidLike(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function fetchServerState(projectId: string): Promise<ServerState | null> {
  // eslint-disable-next-line no-restricted-syntax -- GET, read
  const res = await fetch(`/api/edit/${encodeURIComponent(projectId)}`, { credentials: 'same-origin' });
  if (!res.ok) return null;
  const body = (await res.json()) as { payload?: { rowImages?: unknown; rowOverlays?: unknown; rowVideoClips?: unknown; doc?: { rows?: unknown[] } } };
  const payload = body.payload ?? {};
  const rowImages = (typeof payload.rowImages === 'object' && payload.rowImages !== null && !Array.isArray(payload.rowImages))
    ? (payload.rowImages as Record<number, string>)
    : {};
  const rowOverlays = (typeof payload.rowOverlays === 'object' && payload.rowOverlays !== null && !Array.isArray(payload.rowOverlays))
    ? (payload.rowOverlays as Record<number, { status: string; url?: string }>)
    : {};
  const rowVideoClips = (typeof payload.rowVideoClips === 'object' && payload.rowVideoClips !== null && !Array.isArray(payload.rowVideoClips))
    ? (payload.rowVideoClips as Record<number, { status: string; videoUrl?: string; durationSeconds?: number; brollClipId?: string }>)
    : {};
  const rowCount = Array.isArray(payload.doc?.rows) ? payload.doc!.rows!.length : 0;
  return { rowImages, rowOverlays, rowVideoClips, rowCount };
}

function diffMissing(local: ScanRow['local'], server: ServerState | null) {
  if (!server) return { missingImages: 0, missingOverlays: 0, missingClips: 0 };
  let missingImages = 0;
  let missingOverlays = 0;
  let missingClips = 0;
  for (const k of Object.keys(local.images)) {
    if (!server.rowImages[Number(k)]) missingImages++;
  }
  for (const k of Object.keys(local.overlays)) {
    const v = local.overlays[Number(k)];
    if (!v?.url) continue;
    if (!server.rowOverlays[Number(k)]?.url) missingOverlays++;
  }
  for (const k of Object.keys(local.clips)) {
    if (!local.clips[Number(k)]) continue;
    if (!server.rowVideoClips[Number(k)]?.brollClipId) missingClips++;
  }
  return { missingImages, missingOverlays, missingClips };
}

function buildScanRowFromEntry(entry: ProductionDocHistoryEntry): ScanRow {
  // The legacy cache stored rowVideoClips as `Record<number, string>` (clip
  // id only) — the new shape is the richer object. Normalize so the diff
  // logic can work uniformly without checking both shapes.
  const clips: Record<number, string> = {};
  if (entry.rowVideoClips && typeof entry.rowVideoClips === 'object') {
    for (const [k, v] of Object.entries(entry.rowVideoClips as Record<string, unknown>)) {
      if (typeof v === 'string') clips[Number(k)] = v;
      else if (v && typeof v === 'object' && 'brollClipId' in v && typeof (v as { brollClipId?: unknown }).brollClipId === 'string') {
        clips[Number(k)] = (v as { brollClipId: string }).brollClipId;
      }
    }
  }
  return {
    id: entry.id,
    title: entry.title || entry.topic || '(untitled)',
    topic: entry.topic ?? '',
    timestamp: entry.timestamp,
    local: {
      images: entry.rowImages && typeof entry.rowImages === 'object' ? entry.rowImages : {},
      overlays: entry.rowOverlays && typeof entry.rowOverlays === 'object' ? entry.rowOverlays : {},
      clips,
    },
    serverState: null,
    loadError: null,
    missingImages: 0,
    missingOverlays: 0,
    missingClips: 0,
    status: 'pending',
    recovered: { images: 0, overlays: 0, clips: 0 },
    errors: [],
  };
}

async function postRowAsset(
  projectId: string,
  rowIndex: number,
  slot: 'image' | 'overlay' | 'clip',
  value: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
  const res = await fetch(`/api/edit/${encodeURIComponent(projectId)}/row-asset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rowIndex, slot, value }),
    credentials: 'same-origin',
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => '');
  return { ok: false, reason: `${res.status}: ${text.slice(0, 200)}` };
}

export default function RecoverLostImagesPage() {
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [recoverAllRunning, setRecoverAllRunning] = useState(false);

  const scan = useCallback(async () => {
    setScanState('scanning');
    const entries = getProductionDocHistoryCached();
    const candidates = entries
      .filter(uuidLike.bind(null) ? ((e: ProductionDocHistoryEntry) => uuidLike(e.id)) : () => true)
      .filter((e: ProductionDocHistoryEntry) => {
        const hasImages = e.rowImages && Object.keys(e.rowImages).length > 0;
        const hasOverlays = e.rowOverlays && Object.values(e.rowOverlays).some((v) => v?.url);
        const hasClips = e.rowVideoClips && Object.keys(e.rowVideoClips).length > 0;
        return hasImages || hasOverlays || hasClips;
      })
      .map(buildScanRowFromEntry);
    console.info('[recover] candidates from localStorage', {
      total_entries: entries.length,
      with_assets: candidates.length,
    });
    setRows(candidates);
    // Fetch server state in parallel — small set, can be racey.
    const updated = await Promise.all(
      candidates.map(async (r) => {
        try {
          const server = await fetchServerState(r.id);
          const diff = diffMissing(r.local, server);
          return { ...r, serverState: server, ...diff, status: 'ready' as const };
        } catch (err) {
          return { ...r, loadError: err instanceof Error ? err.message : String(err), status: 'error' as const };
        }
      }),
    );
    setRows(updated);
    setScanState('done');
  }, []);

  // Auto-scan on mount — the page is single-purpose, no reason to wait
  // for the user to click a button before showing what's recoverable.
  useEffect(() => {
    void scan();
  }, [scan]);

  const recoverOne = useCallback(async (rowIdx: number) => {
    setRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, status: 'recovering' } : r)));
    const row = rows[rowIdx];
    if (!row || !row.serverState) return;
    const errors: string[] = [];
    let imageRecovered = 0;
    let overlayRecovered = 0;
    let clipRecovered = 0;
    // Images
    for (const [k, url] of Object.entries(row.local.images)) {
      const idx = Number(k);
      if (row.serverState.rowImages[idx]) continue;
      const out = await postRowAsset(row.id, idx, 'image', url);
      if (out.ok) imageRecovered++;
      else errors.push(`image[${idx}] failed: ${out.reason}`);
    }
    // Overlays
    for (const [k, v] of Object.entries(row.local.overlays)) {
      const idx = Number(k);
      if (!v?.url) continue;
      if (row.serverState.rowOverlays[idx]?.url) continue;
      const out = await postRowAsset(row.id, idx, 'overlay', v);
      if (out.ok) overlayRecovered++;
      else errors.push(`overlay[${idx}] failed: ${out.reason}`);
    }
    // Clips — legacy clip cache stored only the clip id. Re-attach as a
    // bare `{ status: 'ready', brollClipId }` row; the renderer can
    // re-fetch the video URL via /api/broll/{id} at load time.
    for (const [k, clipId] of Object.entries(row.local.clips)) {
      const idx = Number(k);
      if (row.serverState.rowVideoClips[idx]?.brollClipId) continue;
      const out = await postRowAsset(row.id, idx, 'clip', { status: 'ready', brollClipId: clipId });
      if (out.ok) clipRecovered++;
      else errors.push(`clip[${idx}] failed: ${out.reason}`);
    }
    setRows((prev) =>
      prev.map((r, i) =>
        i === rowIdx
          ? {
              ...r,
              status: 'done',
              recovered: {
                images: imageRecovered,
                overlays: overlayRecovered,
                clips: clipRecovered,
              },
              errors,
            }
          : r,
      ),
    );
    if (errors.length === 0) {
      toast.success(`${row.title}: recovered ${imageRecovered} image(s), ${overlayRecovered} overlay(s), ${clipRecovered} clip(s).`);
    } else {
      toast.error(`${row.title}: ${errors.length} errors. Check console for detail.`);
      console.error('[recover] errors for project', row.id, errors);
    }
  }, [rows]);

  const recoverAll = useCallback(async () => {
    setRecoverAllRunning(true);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]?.status === 'done') continue;
      if (rows[i]?.missingImages === 0 && rows[i]?.missingOverlays === 0 && rows[i]?.missingClips === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await recoverOne(i);
    }
    setRecoverAllRunning(false);
  }, [rows, recoverOne]);

  const totals = rows.reduce(
    (acc, r) => ({
      docs: acc.docs + (r.missingImages + r.missingOverlays + r.missingClips > 0 ? 1 : 0),
      images: acc.images + r.missingImages,
      overlays: acc.overlays + r.missingOverlays,
      clips: acc.clips + r.missingClips,
    }),
    { docs: 0, images: 0, overlays: 0, clips: 0 },
  );

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 className="font-bold" style={{ fontSize: 28, color: 'var(--text-primary)', marginBottom: 6 }}>
        Recover lost generated assets
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5, marginBottom: 18 }}>
        Scans the production-doc history stored in this browser for generated images, overlays, and
        B-roll clip references that never reached the server (a pre-2026-05-22 bug silently dropped
        these in some cases). Anything found locally that's missing on the server can be re-attached
        with one click. Safe to run repeatedly — already-attached items are skipped.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanState === 'scanning'}
          className="px-3 py-1.5 rounded text-sm"
          style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', cursor: 'pointer' }}
        >
          {scanState === 'scanning' ? 'Scanning…' : 'Re-scan'}
        </button>
        {totals.docs > 0 && (
          <button
            type="button"
            onClick={() => void recoverAll()}
            disabled={recoverAllRunning}
            className="px-3 py-1.5 rounded text-sm font-semibold"
            style={{
              background: 'rgba(124,58,237,0.20)',
              color: '#a78bfa',
              border: '1px solid rgba(124,58,237,0.45)',
              cursor: 'pointer',
            }}
          >
            {recoverAllRunning ? 'Recovering…' : `Recover all (${totals.images} images, ${totals.overlays} overlays, ${totals.clips} clips across ${totals.docs} doc${totals.docs === 1 ? '' : 's'})`}
          </button>
        )}
      </div>

      {scanState === 'done' && rows.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          No production-doc entries with local rowImages/rowOverlays/rowVideoClips found in this
          browser. If you generated assets on a different device, switch to that browser and run
          this page there.
        </p>
      )}

      {rows.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
          {rows.map((r, i) => {
            const missing = r.missingImages + r.missingOverlays + r.missingClips;
            return (
              <div
                key={r.id}
                style={{
                  padding: 12,
                  borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    id: {r.id} · saved {new Date(r.timestamp).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                    Local: {Object.keys(r.local.images).length} images, {Object.values(r.local.overlays).filter((v) => v?.url).length} overlays, {Object.keys(r.local.clips).length} clips
                    {r.serverState && (
                      <>
                        {' · Server: '}
                        {Object.keys(r.serverState.rowImages).length} images, {Object.keys(r.serverState.rowOverlays).length} overlays, {Object.keys(r.serverState.rowVideoClips).length} clips
                      </>
                    )}
                    {r.loadError && <span style={{ color: '#f87171', marginLeft: 8 }}>· server load failed: {r.loadError}</span>}
                  </div>
                  {missing > 0 && (
                    <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 4 }}>
                      ⚠ {r.missingImages} image(s), {r.missingOverlays} overlay(s), {r.missingClips} clip(s) missing from server
                    </div>
                  )}
                  {r.status === 'done' && (
                    <div style={{ fontSize: 11, color: '#34d399', marginTop: 4 }}>
                      ✓ Recovered {r.recovered.images} image(s), {r.recovered.overlays} overlay(s), {r.recovered.clips} clip(s)
                      {r.errors.length > 0 && (
                        <span style={{ color: '#f87171', marginLeft: 8 }}>
                          · {r.errors.length} error(s) — see console
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={r.status === 'recovering' || r.status === 'done' || missing === 0 || !r.serverState}
                  onClick={() => void recoverOne(i)}
                  className="px-3 py-1.5 rounded text-sm"
                  style={{
                    background: missing === 0 ? 'var(--bg-card)' : 'rgba(124,58,237,0.18)',
                    color: missing === 0 ? 'var(--text-muted)' : '#a78bfa',
                    border: '1px solid var(--border)',
                    cursor: r.status === 'recovering' || r.status === 'done' || missing === 0 ? 'not-allowed' : 'pointer',
                    minWidth: 110,
                  }}
                >
                  {r.status === 'recovering' ? 'Recovering…' : r.status === 'done' ? 'Done ✓' : missing === 0 ? 'Up to date' : 'Recover'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ marginTop: 18, fontSize: 11, color: 'var(--text-muted)' }}>
        Notes: only this browser's localStorage can be scanned. If you generated assets on another
        browser/device, run this page there too. Re-running the scan refreshes the server state.
      </p>
    </div>
  );
}
