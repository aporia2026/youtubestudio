'use client';

/**
 * Dedicated list view for channel-clone templates (Plan 2 deferred
 * follow-up).
 *
 * Differs from `<UseTemplateDropdown>` (the dropdown above the
 * upload form on /channel-clone): this is the management surface.
 * Renders one row per live template with size + age + per-row delete
 * + a single "Start a new run" button that hands the workspace's
 * intake-upload route a `fromTemplateId`.
 *
 * Bottom-of-list totals so the operator sees their full template
 * storage footprint at a glance (rule 8 — cost transparency).
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface TemplateListItem {
  id: string;
  name: string;
  bytes: number;
  videoCount: number;
  sourceChannelName: string | null;
  createdAt: string;
}

export function ChannelCloneTemplatesList() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/channel-clone/templates');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(`Could not load templates (${res.status}): ${text.slice(0, 200)}`);
        return;
      }
      const data = (await res.json()) as { templates: TemplateListItem[] };
      setTemplates(data.templates ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleStart = useCallback(
    async (templateId: string) => {
      if (busyId) return;
      setBusyId(templateId);
      setError(null);
      try {
        const res = await fetch('/api/channel-clone/intake-upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fromTemplateId: templateId }),
        });
        const data = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
        if (!res.ok || !data.jobId) {
          setError(data.error ?? `Start failed (${res.status})`);
          setBusyId(null);
          return;
        }
        router.push(`/channel-clone/${data.jobId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusyId(null);
      }
    },
    [busyId, router],
  );

  const handleDelete = useCallback(
    async (templateId: string, name: string) => {
      if (busyId) return;
      if (!window.confirm(`Delete template "${name}"? This frees the storage and cannot be undone.`)) return;
      setBusyId(templateId);
      setError(null);
      try {
        const res = await fetch(`/api/channel-clone/templates/${templateId}`, { method: 'DELETE' });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          setError(`Delete failed (${res.status}): ${text.slice(0, 200)}`);
          return;
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh],
  );

  if (templates === null) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }
  if (templates.length === 0) {
    return (
      <p className="rounded border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-400">
        No saved templates yet. Complete an upload-intake run on{' '}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- help-text link inside an empty-state placeholder; prefetch overhead not worth it for a rarely-followed link. */}
        <a href="/channel-clone" className="text-blue-400 hover:underline">
          the channel-clone page
        </a>{' '}
        and press "Save as template" to create your first one.
      </p>
    );
  }

  const totalBytes = templates.reduce((acc, t) => acc + t.bytes, 0);

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {templates.map((t) => (
          <li key={t.id} className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate font-medium text-neutral-100">{t.name}</p>
                <p className="text-xs text-neutral-400">
                  {t.videoCount} {t.videoCount === 1 ? 'video' : 'videos'} · {formatBytes(t.bytes)} · saved{' '}
                  {formatRelativeTime(t.createdAt)}
                </p>
                {t.sourceChannelName && (
                  <p className="text-[10px] text-neutral-500">Source: {t.sourceChannelName}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleStart(t.id)}
                  disabled={busyId !== null}
                  className="rounded bg-neutral-200 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
                >
                  {busyId === t.id ? 'Working…' : 'Start a new run'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(t.id, t.name)}
                  disabled={busyId !== null}
                  className="text-xs text-red-300 underline-offset-2 hover:underline disabled:text-neutral-500"
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-500">
        {templates.length} {templates.length === 1 ? 'template' : 'templates'} · total {formatBytes(totalBytes)} of
        R2 storage.
      </p>
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'recently';
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
