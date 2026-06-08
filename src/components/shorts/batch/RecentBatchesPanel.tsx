'use client';

/**
 * RecentBatchesPanel — list of the workspace's recent batches with
 * a "Continue" link to /shorts/batch/[id]. Shown at the top of
 * /shorts/batch so the user can resume in-progress runs or revisit
 * completed ones.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ShortsBatchRow, ShortsBatchStatus } from '@/lib/shorts-batches-types';

export function RecentBatchesPanel() {
  const [batches, setBatches] = useState<ShortsBatchRow[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    fetch('/api/shorts/batches')
      .then((r) => (r.ok ? r.json() : { batches: [] }))
      .then((data: { batches?: ShortsBatchRow[] }) => {
        setBatches(data.batches ?? []);
      })
      .catch(() => setBatches([]));
  }, []);

  if (!batches || batches.length === 0) return null;

  return (
    <div className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-sm font-medium text-[var(--text-primary)]">
          Recent batches ({batches.length})
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {collapsed ? '▸ show' : '▾ hide'}
        </span>
      </button>

      {!collapsed && (
        <ul className="mt-3 space-y-1">
          {batches.slice(0, 8).map((b) => (
            <li key={b.id}>
              <Link
                href={`/shorts/batch/${b.id}`}
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-white/[0.05]"
              >
                <StatusBadge status={b.status} />
                <span className="flex-1 truncate text-[var(--text-primary)]">
                  {b.name ?? `Batch ${b.id.slice(0, 8)}`}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  {b.totals?.planned ?? 0} shorts · {formatDate(b.created_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ShortsBatchStatus }) {
  const map: Record<ShortsBatchStatus, { label: string; cls: string }> = {
    setup: { label: 'Draft', cls: 'bg-white/[0.08] text-[var(--text-secondary)]' },
    generating: { label: 'Generating', cls: 'bg-[var(--accent-purple)]/20 text-[var(--accent-purple-bright)]' },
    review: { label: 'Review', cls: 'bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)]' },
    uploading: { label: 'Uploading', cls: 'bg-[var(--accent-cyan)]/15 text-[var(--accent-cyan)]' },
    done: { label: 'Done', cls: 'bg-[var(--accent-green)]/15 text-[var(--accent-green)]' },
    failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300' },
  };
  const { label, cls } = map[status];
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}
