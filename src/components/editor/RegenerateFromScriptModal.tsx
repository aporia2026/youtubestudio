'use client';

/**
 * Regenerate-from-script modal — Phase 5 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Shows the current script (every row's script_text joined with
 * double newlines) in an editable textarea. On "Regenerate" the
 * endpoint runs the production-doc generator on the new script and
 * MERGES with the existing doc per the per-field editedAt rule —
 * manual edits made AFTER the regen started survive; everything
 * else gets the new generator output.
 *
 * The merge is server-side; this modal is a thin client.
 */
import { useCallback, useState, useMemo } from 'react';
import type { ProductionDoc } from '@/remotion/utils';

interface RegenerateFromScriptModalProps {
  projectId: string;
  doc: ProductionDoc;
  onClose: () => void;
  /** Caller reloads from server on success so the merged doc lands
   *  in editor state with its bumped version. */
  onSuccess: () => Promise<void> | void;
}

const ROW_SEPARATOR = '\n\n';

export function RegenerateFromScriptModal({
  projectId,
  doc,
  onClose,
  onSuccess,
}: RegenerateFromScriptModalProps): React.ReactElement {
  const initialScript = useMemo(
    () =>
      doc.rows
        .map((r) => (r.script_text ?? '').trim())
        .filter((t) => t.length > 0)
        .join(ROW_SEPARATOR),
    [doc.rows],
  );

  const [draft, setDraft] = useState(initialScript);
  const [regenState, setRegenState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const handleRegenerate = useCallback(async () => {
    if (!draft.trim()) {
      setRegenState({ kind: 'error', message: 'Script is empty.' });
      return;
    }
    setRegenState({ kind: 'running' });
    try {
      const res = await fetch(`/api/edit/${encodeURIComponent(projectId)}/regenerate-from-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newScript: draft }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Regen failed: HTTP ${res.status}`);
      }
      await onSuccess();
    } catch (err) {
      setRegenState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [draft, onSuccess, projectId]);

  const charCount = draft.length;
  const wordCount = draft.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0, 0, 0, 0.65)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="rounded-lg border max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden"
        style={{ borderColor: 'var(--card-border)', background: 'var(--card-bg)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Regenerate doc from script"
      >
        <header
          className="px-5 py-4 border-b"
          style={{ borderColor: 'var(--card-border)' }}
        >
          <div className="text-sm font-semibold">Regenerate doc from script</div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--fg-muted)' }}>
            Edit the script below and click Regenerate. The production-doc
            generator runs on the new text; per-field edits you made survive
            via the editor&apos;s edit-tracking rule. Editor-only fields
            (durations, trims, picked clips, transitions, mutes) carry over
            untouched.
          </div>
        </header>

        <div className="flex-1 overflow-hidden p-4 flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 w-full text-xs rounded border p-3 resize-none font-mono"
            style={{
              borderColor: 'var(--card-border)',
              background: 'var(--bg)',
              color: 'var(--fg)',
              minHeight: 320,
            }}
            spellCheck
            placeholder="Edit the full narration script…"
          />
          <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--fg-muted)' }}>
            <span className="tabular-nums">
              {wordCount.toLocaleString()} words · {charCount.toLocaleString()} chars
            </span>
            <span>
              Rows in current doc: <strong style={{ color: 'var(--fg)' }}>{doc.rows.length}</strong>
            </span>
          </div>
          {regenState.kind === 'error' && (
            <div className="text-[10px] p-2 rounded border" style={{ borderColor: '#f87171', color: '#fca5a5' }}>
              {regenState.message}
            </div>
          )}
        </div>

        <footer
          className="px-5 py-3 border-t flex items-center justify-between gap-2"
          style={{ borderColor: 'var(--card-border)' }}
        >
          <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
            Captions cached from the old VO will become stale after row counts shift.
            Regen captions after the doc settles.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={regenState.kind === 'running'}
              className="text-xs px-3 py-1.5 rounded border hover:bg-white/5 transition-colors disabled:opacity-50"
              style={{ borderColor: 'var(--card-border)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void handleRegenerate(); }}
              disabled={regenState.kind === 'running' || draft === initialScript}
              className="text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
              style={{
                borderColor: 'var(--accent-purple-bright, #a78bfa)',
                color: 'var(--accent-purple-bright, #a78bfa)',
              }}
            >
              {regenState.kind === 'running' ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
