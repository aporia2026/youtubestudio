'use client';

/**
 * Use-template dropdown (Plan 2).
 *
 * Mounts above the upload form on the channel-clone landing page.
 * Hidden when no templates exist (don't add noise — rule 10 lazy
 * user). When templates are present:
 *
 *   - Renders a single-row card with a `<select>` listing template
 *     name + video count + KB size.
 *   - "Start from this template" button POSTs to
 *     /api/channel-clone/intake-upload with `fromTemplateId` and
 *     navigates to the new job's detail page.
 *   - A small "Delete" link next to each option offers in-place
 *     destruction so the operator doesn't need a separate page for
 *     basic management.
 *
 * See _plans/2026-06-07-channel-clone-preset-templates.md.
 */

import { useCallback, useEffect, useState } from 'react';

interface TemplateListItem {
  id: string;
  name: string;
  bytes: number;
  videoCount: number;
  sourceChannelName: string | null;
  createdAt: string;
}

export interface UseTemplateDropdownProps {
  /** Notify parent when a new job has been kicked off from a
   *  template so the parent can navigate to that job. */
  onJobStarted: (jobId: string) => void;
}

export function UseTemplateDropdown({ onJobStarted }: UseTemplateDropdownProps) {
  const [templates, setTemplates] = useState<TemplateListItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [busy, setBusy] = useState<'idle' | 'starting' | 'deleting'>('idle');
  const [error, setError] = useState<string | null>(null);

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
      if (!selectedId && data.templates?.length) {
        setSelectedId(data.templates[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleStart = useCallback(async () => {
    if (busy !== 'idle' || !selectedId) return;
    setBusy('starting');
    setError(null);
    // eslint-disable-next-line no-console
    console.info('[channel-clone templates ui]', { action: 'start-from-template', templateId: selectedId });
    try {
      const res = await fetch('/api/channel-clone/intake-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromTemplateId: selectedId }),
      });
      const data = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) {
        setError(data.error ?? `Start failed (${res.status})`);
        return;
      }
      onJobStarted(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('idle');
    }
  }, [busy, selectedId, onJobStarted]);

  const handleDelete = useCallback(async () => {
    if (busy !== 'idle' || !selectedId) return;
    const target = templates?.find((t) => t.id === selectedId);
    if (!target) return;
    if (!window.confirm(`Delete template "${target.name}"? This frees the storage and cannot be undone.`)) return;
    setBusy('deleting');
    setError(null);
    try {
      const res = await fetch(`/api/channel-clone/templates/${selectedId}`, { method: 'DELETE' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(`Delete failed (${res.status}): ${text.slice(0, 200)}`);
        return;
      }
      // Drop locally + refresh so the next selection is sensible.
      setSelectedId('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('idle');
    }
  }, [busy, selectedId, templates, refresh]);

  // Hide entirely when no templates exist — rule 10 (no noise for
  // the lazy user). Loading state shows nothing either, intentional
  // so the dropdown doesn't flash for the common no-templates case.
  if (templates === null) return null;
  if (templates.length === 0) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
        Re-use a saved template
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={busy !== 'idle'}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100 outline-none focus:border-neutral-500"
          style={{ minWidth: 240, maxWidth: 380 }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.videoCount} {t.videoCount === 1 ? 'video' : 'videos'} · {formatBytes(t.bytes)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={busy !== 'idle' || !selectedId}
          className="rounded bg-neutral-200 px-3 py-1 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
        >
          {busy === 'starting' ? 'Starting…' : 'Start from this template'}
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={busy !== 'idle' || !selectedId}
          className="text-[10px] text-red-300 underline-offset-2 hover:underline disabled:text-neutral-500"
        >
          {busy === 'deleting' ? 'Deleting…' : 'Delete'}
        </button>
      </div>
      {error && <p className="mt-2 text-[10px] text-red-300">{error}</p>}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
