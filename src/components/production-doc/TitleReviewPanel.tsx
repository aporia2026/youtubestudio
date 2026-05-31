'use client';

/**
 * Pre-flight title-review panel for the production-doc page.
 *
 * Renders ABOVE the Generate button. The user opens it (or clicks
 * "Detect titles") and gets the list of `##` headings the server-side
 * extractor would have detected. They can:
 *   - Edit the text of any detected title.
 *   - Delete a false-positive detection (×).
 *   - Add a missed title at a chosen position (+ Add).
 *
 * Reordering detected titles is intentionally not supported — title
 * order is determined by the position of `##` markers in the script.
 * To reorder, the user edits the script directly.
 * The final ordered list flows into `/api/generate/production-doc` as
 * `userTitles`. When the user never opens this panel, no override is
 * sent and the extractor's output is used unchanged.
 *
 * Background:
 *   - The detection endpoint is GET-shaped (`POST /detect-titles`) and
 *     mirrors the exact pre-pass the generation route runs, so the
 *     preview cannot drift from what the LLM eventually sees.
 *   - "Stale" badge fires when the script changes after the last
 *     detect — the sentinels in `userTitles` would no longer line up.
 *
 * See `_plans/2026-05-31-preflight-title-review.md`.
 */

import { useEffect, useMemo, useState } from 'react';

/** Shape returned by /api/generate/production-doc/detect-titles. */
interface DetectedTitle {
  text: string;
  sentinel: string;
  originalLine: string;
}

/** What the panel hands back to the generation request. Mirrors the
 *  `UserTitleSpec` server type — see `src/lib/script-titles.ts`. */
export interface UserTitleSpec {
  text: string;
  sourceSentinel?: string;
  insertAfterSentinel?: string | null;
  deleted?: boolean;
}

/** Internal row state. Either a kept/edited detected row or an added one. */
type RowState =
  | { kind: 'detected'; sentinel: string; text: string; originalText: string }
  | { kind: 'added'; id: string; text: string; insertAfterSentinel: string | null };

export interface TitleReviewPanelProps {
  /** Current script text — the panel watches this to mark itself stale. */
  script: string;
  /** Whether a generation is in flight. Disables all controls. */
  disabled?: boolean;
  /** Called when the user changes the title list so the parent can
   *  forward it to /production-doc on submit. `null` ⇒ no overrides
   *  (panel never opened or was reset). */
  onChange: (userTitles: UserTitleSpec[] | null) => void;
}

export function TitleReviewPanel({ script, disabled, onChange }: TitleReviewPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detected, setDetected] = useState<DetectedTitle[] | null>(null);
  const [detectedFromScript, setDetectedFromScript] = useState<string | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [detectWarnings, setDetectWarnings] = useState<string[]>([]);

  // Stale guard: if the script changes after detection, the sentinels we
  // captured no longer line up. Warn the user and require re-detect.
  const isStale = detectedFromScript !== null && detectedFromScript !== script;

  // Forward user edits to the parent. We push `null` when no detect has
  // happened yet so the parent omits `userTitles` (back-compat path).
  useEffect(() => {
    if (detected === null) {
      onChange(null);
      return;
    }
    if (isStale) {
      // Stale — don't send overrides built from outdated sentinels.
      onChange(null);
      return;
    }
    const specs: UserTitleSpec[] = [];
    const seenDetectedSentinels = new Set<string>();
    for (const r of rows) {
      if (r.kind === 'detected') {
        seenDetectedSentinels.add(r.sentinel);
        specs.push({ text: r.text, sourceSentinel: r.sentinel });
      } else {
        specs.push({ text: r.text, insertAfterSentinel: r.insertAfterSentinel });
      }
    }
    // Detected titles the user removed: explicitly mark deleted so the
    // server-side warning counter increments correctly. Detected
    // sentinels missing from the user's list AND not in `seen` get a
    // `deleted: true` entry pinned to the originalLine restoration path.
    for (const d of detected) {
      if (!seenDetectedSentinels.has(d.sentinel)) {
        specs.push({ text: d.text, sourceSentinel: d.sentinel, deleted: true });
      }
    }
    onChange(specs);
  }, [rows, detected, isStale, onChange]);

  const runDetect = async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      const res = await fetch('/api/generate/production-doc/detect-titles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Detection failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { titles: DetectedTitle[]; warnings: string[] };
      setDetected(data.titles);
      setDetectedFromScript(script);
      setDetectWarnings(data.warnings ?? []);
      setRows(
        data.titles.map((t) => ({
          kind: 'detected' as const,
          sentinel: t.sentinel,
          text: t.text,
          originalText: t.text,
        })),
      );
      setExpanded(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Detection failed';
      setDetectError(msg);
    } finally {
      setDetecting(false);
    }
  };

  // The "insert after" picker for added rows uses the current ORDERED
  // sequence of detected sentinels as positions. Added rows have no
  // sentinel of their own (they're position-relative to detected ones).
  const insertPositions = useMemo(() => {
    const detectedSentinels = rows
      .filter((r): r is Extract<RowState, { kind: 'detected' }> => r.kind === 'detected')
      .map((r) => ({ sentinel: r.sentinel, text: r.text }));
    return [{ sentinel: null as string | null, label: 'At start of script' }].concat(
      detectedSentinels.map((d) => ({ sentinel: d.sentinel, label: `After "${d.text}"` })),
    );
  }, [rows]);

  const updateText = (idx: number, text: string) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, text } : r)));
  };

  const deleteRow = (idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const addRow = (insertAfterSentinel: string | null) => {
    setRows((prev) => [
      ...prev,
      {
        kind: 'added',
        id: `added-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: '',
        insertAfterSentinel,
      },
    ]);
  };

  const resetToDetected = () => {
    if (!detected) return;
    setRows(
      detected.map((t) => ({
        kind: 'detected' as const,
        sentinel: t.sentinel,
        text: t.text,
        originalText: t.text,
      })),
    );
  };

  const headerText = detected === null
    ? 'Review titles before generating'
    : isStale
      ? `Titles need re-detection — script changed`
      : `${rows.length} title${rows.length === 1 ? '' : 's'} ready for generation`;

  return (
    <div
      className="rounded-lg"
      style={{
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid rgba(124,58,237,0.18)',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        disabled={disabled}
        style={{
          color: 'var(--text-secondary)',
          borderBottom: expanded ? '1px solid rgba(124,58,237,0.15)' : 'none',
        }}
      >
        <span className="text-sm font-medium">
          <span style={{ marginRight: 8 }}>{expanded ? '▾' : '▸'}</span>
          {headerText}
        </span>
        {isStale && (
          <span
            className="text-[10px] px-2 py-0.5 rounded"
            style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24' }}
          >
            stale
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 py-3 space-y-3">
          {detected === null && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Click below to detect the <code>##</code> headings in your script. You can then edit,
              delete, or add titles before generating.
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runDetect}
              disabled={disabled || detecting || !script.trim()}
              className="text-xs px-3 py-1 rounded"
              style={{
                background: 'rgba(124,58,237,0.18)',
                color: 'var(--accent-purple-bright)',
                border: '1px solid rgba(124,58,237,0.28)',
              }}
            >
              {detecting ? 'Detecting…' : detected === null ? 'Detect titles from script' : 'Re-detect from script'}
            </button>
            {detected !== null && (
              <button
                type="button"
                onClick={resetToDetected}
                disabled={disabled || detecting}
                className="text-xs px-2 py-1 rounded"
                style={{ color: 'var(--text-muted)' }}
              >
                Reset to detected
              </button>
            )}
          </div>

          {detectError && (
            <div
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
            >
              {detectError}
            </div>
          )}

          {detectWarnings.length > 0 && (
            <ul
              className="text-xs space-y-0.5"
              style={{ color: '#fbbf24' }}
            >
              {detectWarnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
            </ul>
          )}

          {detected !== null && rows.length === 0 && (
            <p className="text-xs italic" style={{ color: 'var(--text-muted)' }}>
              No titles. Add one below, or add <code>## Heading</code> lines to your script and re-detect.
            </p>
          )}

          {rows.length > 0 && (
            <div className="space-y-1">
              {rows.map((row, idx) => (
                <div key={row.kind === 'detected' ? row.sentinel : row.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={row.text}
                    onChange={(e) => updateText(idx, e.target.value)}
                    placeholder={row.kind === 'added' ? 'New title text…' : ''}
                    disabled={disabled}
                    className="input-field flex-1 text-sm"
                    style={
                      row.kind === 'added'
                        ? { borderColor: 'rgba(124,58,237,0.4)' }
                        : undefined
                    }
                  />
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                    style={{
                      color: row.kind === 'detected' ? 'var(--text-muted)' : 'var(--accent-purple-bright)',
                      background: row.kind === 'detected' ? 'transparent' : 'rgba(124,58,237,0.12)',
                    }}
                  >
                    {row.kind === 'detected' ? 'detected' : 'added'}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteRow(idx)}
                    disabled={disabled}
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ color: '#f87171' }}
                    title="Remove this title"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {detected !== null && (
            <AddTitleControl
              insertPositions={insertPositions}
              disabled={disabled}
              onAdd={addRow}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface AddTitleControlProps {
  insertPositions: { sentinel: string | null; label: string }[];
  disabled?: boolean;
  onAdd: (insertAfterSentinel: string | null) => void;
}

function AddTitleControl({ insertPositions, disabled, onAdd }: AddTitleControlProps) {
  const [picking, setPicking] = useState(false);
  if (!picking) {
    return (
      <button
        type="button"
        onClick={() => setPicking(true)}
        disabled={disabled}
        className="text-xs px-2 py-1 rounded"
        style={{
          color: 'var(--accent-purple-bright)',
          border: '1px dashed rgba(124,58,237,0.4)',
        }}
      >
        + Add title
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Insert</span>
      <select
        className="input-field text-xs flex-1"
        defaultValue=""
        onChange={(e) => {
          const val = e.target.value;
          const pos = insertPositions.find((p) => (p.sentinel ?? '__START__') === (val || '__START__'));
          if (!pos) return;
          onAdd(pos.sentinel);
          setPicking(false);
        }}
        disabled={disabled}
      >
        <option value="" disabled>Pick a position…</option>
        {insertPositions.map((p) => (
          <option key={p.sentinel ?? '__start__'} value={p.sentinel ?? ''}>
            {p.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => setPicking(false)}
        className="text-xs px-2 py-1 rounded"
        style={{ color: 'var(--text-muted)' }}
      >
        Cancel
      </button>
    </div>
  );
}
