'use client';

/**
 * Client wrapper for /timeline-editor/[id]. Fetches the saved
 * ProductionDoc from /api/history/[id], threads it through the
 * useDocHistory hook, mounts the editor, and persists the current
 * state via PATCH /api/history/[id] when the user clicks Save.
 *
 * Why not auto-save: every drag tick would call commit:false and
 * we'd POST hundreds of times per second. Explicit save matches
 * the production-doc page's existing pattern + the plan §M5
 * "batched save on blur / explicit Save" decision.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import { useDocHistory } from '@/lib/timeline-editor/use-doc-history';

const TimelineEditor = dynamic(
  () => import('./TimelineEditor').then((m) => m.TimelineEditor),
  {
    ssr: false,
    loading: () => <p className="text-xs text-neutral-500">Loading timeline…</p>,
  },
);

interface HistoryFetchPayload {
  id?: string;
  kind?: string;
  payload?: { doc?: ProductionDoc; [key: string]: unknown };
  error?: string;
}

export function TimelineEditorByIdClient({ historyEntryId }: { historyEntryId: string }) {
  const [loaded, setLoaded] = useState<{ doc: ProductionDoc; rest: Record<string, unknown> } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  // Fetch the doc once on mount. We keep the rest of the payload
  // around so saving back doesn't drop any fields the timeline
  // editor doesn't touch (image_url, thumbnail data, etc.).
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch(`/api/history/${historyEntryId}`)
      .then(async (r) => {
        const data = (await r.json()) as HistoryFetchPayload;
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(data.error ?? `Request failed (${r.status})`);
          return;
        }
        const payload = data.payload ?? {};
        const doc = payload.doc;
        if (!doc || typeof doc !== 'object') {
          setLoadError('History entry has no doc payload.');
          return;
        }
        const { doc: _omitted, ...rest } = payload;
        setLoaded({ doc, rest });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [historyEntryId]);

  return loaded
    ? <Editor loaded={loaded} historyEntryId={historyEntryId} saving={saving} setSaving={setSaving} saveError={saveError} setSaveError={setSaveError} lastSavedAt={lastSavedAt} setLastSavedAt={setLastSavedAt} />
    : <div className="rounded border border-neutral-800 bg-neutral-950 p-4 text-xs text-neutral-300">
        {loadError ? (
          <p className="text-red-300">Could not load: {loadError}</p>
        ) : (
          <p className="text-neutral-500">Loading the production-doc…</p>
        )}
      </div>;
}

// Once the doc is loaded we mount this inner component so the
// hook's `initial` is the loaded value (useDocHistory's initial
// only runs once — we don't want it called with a placeholder
// then reset on every fetch).
function Editor({
  loaded, historyEntryId, saving, setSaving, saveError, setSaveError, lastSavedAt, setLastSavedAt,
}: {
  loaded: { doc: ProductionDoc; rest: Record<string, unknown> };
  historyEntryId: string;
  saving: boolean;
  setSaving: (v: boolean) => void;
  saveError: string | null;
  setSaveError: (v: string | null) => void;
  lastSavedAt: number | null;
  setLastSavedAt: (v: number | null) => void;
}) {
  const history = useDocHistory<ProductionDoc>(loaded.doc);
  const dirty = useMemo(() => history.pointer > 0 || history.size > 1, [history.pointer, history.size]);
  const savedDocRef = useRef(loaded.doc);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/history/${historyEntryId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { ...loaded.rest, doc: history.current } }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      savedDocRef.current = history.current;
      setLastSavedAt(Date.now());
      // Reset the undo stack to a single entry so dirty=false until
      // the next mutation.
      history.reset(history.current);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [history, historyEntryId, loaded.rest, setSaving, setSaveError, setLastSavedAt]);

  // Cmd/Ctrl+S also triggers save. We add this to the window
  // (not the timeline container) so it works anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (!saving && dirty) void handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSave, saving, dirty]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-950 p-2 text-xs">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="rounded bg-neutral-200 px-3 py-1 font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
        >
          {saving ? 'Saving…' : dirty ? 'Save (Cmd/Ctrl+S)' : 'Saved'}
        </button>
        {lastSavedAt !== null && !dirty && (
          <span className="text-[10px] text-neutral-500">last saved {new Date(lastSavedAt).toLocaleTimeString()}</span>
        )}
        {dirty && lastSavedAt !== null && (
          <span className="text-[10px] text-amber-400">unsaved changes</span>
        )}
        {saveError && (
          <span className="text-[10px] text-red-300">{saveError}</span>
        )}
      </div>
      <TimelineEditor
        doc={history.current}
        onDocChange={history.setDoc}
        onUndo={history.undo}
        onRedo={history.redo}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
      />
    </div>
  );
}
