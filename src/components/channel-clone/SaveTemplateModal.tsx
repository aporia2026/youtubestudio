'use client';

/**
 * Save-as-template modal (Plan 2).
 *
 * Pops from the run-detail page's "Save as template" button. Fields:
 *   - Name (required, defaults to the source channel name)
 *   - One-line summary of what will be saved (video count + source)
 *
 * Submits to POST /api/channel-clone/templates. On 409 with
 * `replace: true`, re-prompts with a confirm-replace UI before
 * re-submitting with `replaceExisting=true`.
 *
 * See _plans/2026-06-07-channel-clone-preset-templates.md.
 */

import { useCallback, useEffect, useState } from 'react';

export interface SaveTemplateModalProps {
  jobId: string;
  /** Defaults to "Clone of {channelName}" but the operator can edit. */
  defaultName: string;
  /** Surface this to the operator so they know exactly what's about
   *  to be persisted. */
  summary: {
    videoCount: number;
    sourceChannelName: string | null;
  };
  open: boolean;
  onClose: () => void;
  onSaved: (template: { id: string; name: string; bytes: number; videoCount: number }) => void;
}

interface ApiPostResponse {
  ok?: boolean;
  template?: { id: string; name: string; bytes: number; videoCount: number };
  error?: string;
  replace?: boolean;
  existingTemplateId?: string;
}

export function SaveTemplateModal({
  jobId,
  defaultName,
  summary,
  open,
  onClose,
  onSaved,
}: SaveTemplateModalProps) {
  const [name, setName] = useState<string>(defaultName);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<boolean>(false);

  // Reset internal state every time the modal opens fresh.
  useEffect(() => {
    if (open) {
      setName(defaultName);
      setSaving(false);
      setError(null);
      setConfirmReplace(false);
    }
  }, [open, defaultName]);

  const submit = useCallback(
    async (replaceExisting: boolean) => {
      if (!name.trim()) {
        setError('Name is required');
        return;
      }
      setSaving(true);
      setError(null);
       
      console.info('[channel-clone templates ui]', { action: 'save-start', jobId, name, replaceExisting });
      try {
        const res = await fetch('/api/channel-clone/templates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId, name: name.trim(), replaceExisting }),
        });
        const data = (await res.json().catch(() => ({}))) as ApiPostResponse;
        if (res.status === 409 && data.replace) {
          // Existing template with the same name — confirm overwrite.
          setConfirmReplace(true);
          setSaving(false);
          return;
        }
        if (!res.ok || !data.ok || !data.template) {
          setError(data.error ?? `Save failed (${res.status})`);
          setSaving(false);
          return;
        }
         
        console.info('[channel-clone templates ui]', { action: 'save-done', templateId: data.template.id });
        onSaved(data.template);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSaving(false);
      }
    },
    [name, jobId, onSaved, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="w-full max-w-md space-y-3 rounded border border-neutral-700 bg-neutral-900 p-4">
        <header className="space-y-1">
          <h2 className="text-sm font-semibold text-neutral-100">Save as template</h2>
          <p className="text-[11px] text-neutral-400">
            Saves the {summary.videoCount} reference {summary.videoCount === 1 ? 'video' : 'videos'} and
            this run's configuration under a name you can re-spin later. Video files are copied into
            template storage so the template survives deleting this job.
          </p>
        </header>

        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Name</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              setConfirmReplace(false);
            }}
            disabled={saving}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-neutral-500 disabled:opacity-60"
          />
        </label>

        {summary.sourceChannelName && (
          <p className="text-[10px] text-neutral-500">
            Source: <span className="text-neutral-300">{summary.sourceChannelName}</span>
          </p>
        )}

        {confirmReplace && (
          <div className="rounded border border-amber-900 bg-amber-950/30 p-2 text-[11px] text-amber-200">
            A template named "{name}" already exists. Save again to replace it? The existing
            template's files will be removed.
          </div>
        )}

        {error && <p className="text-[11px] text-red-300">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded px-3 py-1 text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit(confirmReplace)}
            disabled={saving || !name.trim()}
            className="rounded bg-neutral-200 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
          >
            {saving ? 'Saving…' : confirmReplace ? 'Replace existing' : 'Save template'}
          </button>
        </div>
      </div>
    </div>
  );
}
