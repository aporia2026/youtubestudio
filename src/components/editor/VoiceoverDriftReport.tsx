'use client';

/**
 * Voiceover-drift report — Phase 3 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * For each row in the doc this surfaces:
 *   – the narration's estimated duration (word_count / speaking_pace)
 *   – the shot's effective on-screen duration
 *   – the drift between them
 *
 * Negative drift = narration overruns the shot (audio truncates,
 * the next shot starts mid-sentence). Positive drift = the shot
 * lingers after narration ends (dead air, but at least nothing
 * gets cut off).
 *
 * Phase 3 ships estimate-only — no per-row alignment fetch and no
 * audio retiming. The plan's "actually re-pace the VO" requires
 * either whole-VO regeneration through ElevenLabs (loses voice
 * consistency between sessions) or ffmpeg `atempo` retiming of
 * already-aligned segments (no ffmpeg integration yet). Both are
 * follow-ups; this commit gives the user actionable data without
 * promising the system can't deliver.
 */
import { useMemo } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import { rowStartTimesMs } from '@/lib/editor/store';

interface DriftRow {
  shotIndex: number;
  wordCount: number;
  /** Estimated narration duration in ms from word count + WPM. */
  estimatedNarrationMs: number;
  /** Effective shot duration (override or natural). */
  shotDurationMs: number;
  /** Shot duration − narration. Negative = narration overruns. */
  driftMs: number;
  severity: 'overrun' | 'tight' | 'comfortable' | 'dead-air';
}

interface VoiceoverDriftReportProps {
  doc: ProductionDoc;
  onClose: () => void;
  onJumpToShot: (shotIndex: number) => void;
}

const SEVERITY_THRESHOLDS = {
  /** Drift below this is "overrun" — narration spills past the shot. */
  overrun: 0,
  /** Drift below this (and ≥ overrun) is "tight" — within 500 ms. */
  tight: 500,
  /** Drift above this is "dead-air" — shot lingers > 2 s after narration. */
  deadAir: 2000,
};

function classify(driftMs: number): DriftRow['severity'] {
  if (driftMs < SEVERITY_THRESHOLDS.overrun) return 'overrun';
  if (driftMs < SEVERITY_THRESHOLDS.tight) return 'tight';
  if (driftMs > SEVERITY_THRESHOLDS.deadAir) return 'dead-air';
  return 'comfortable';
}

function severityLabel(s: DriftRow['severity']): string {
  switch (s) {
    case 'overrun':
      return 'overrun';
    case 'tight':
      return 'tight';
    case 'comfortable':
      return 'OK';
    case 'dead-air':
      return 'dead air';
  }
}

function severityColor(s: DriftRow['severity']): string {
  switch (s) {
    case 'overrun':
      return '#f87171';
    case 'tight':
      return '#fbbf24';
    case 'comfortable':
      return '#10b981';
    case 'dead-air':
      return '#a78bfa';
  }
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function fmt(ms: number): string {
  const sign = ms < 0 ? '−' : '+';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(1)}s`;
}

export function VoiceoverDriftReport({
  doc,
  onClose,
  onJumpToShot,
}: VoiceoverDriftReportProps): React.ReactElement {
  const rows: DriftRow[] = useMemo(() => {
    const wpm = doc.speaking_pace_wpm || 150;
    const starts = rowStartTimesMs(doc);
    return doc.rows.map((row, i) => {
      const wordCount = countWords(row.script_text || '');
      const estimatedNarrationMs = wordCount > 0 ? Math.round((wordCount / wpm) * 60_000) : 0;
      const naturalDuration =
        i + 1 < starts.length ? starts[i + 1] - starts[i] : 0;
      const shotDurationMs =
        typeof row.duration_override_ms === 'number'
          ? row.duration_override_ms
          : naturalDuration;
      const driftMs = shotDurationMs - estimatedNarrationMs;
      return {
        shotIndex: i,
        wordCount,
        estimatedNarrationMs,
        shotDurationMs,
        driftMs,
        severity: classify(driftMs),
      };
    });
  }, [doc]);

  const counts = useMemo(() => {
    const out = { overrun: 0, tight: 0, comfortable: 0, 'dead-air': 0 };
    for (const r of rows) out[r.severity] += 1;
    return out;
  }, [rows]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0, 0, 0, 0.65)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="rounded-lg border max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden"
        style={{ borderColor: 'var(--card-border)', background: 'var(--card-bg)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Voiceover drift report"
      >
        <header
          className="px-5 py-4 flex items-center justify-between border-b"
          style={{ borderColor: 'var(--card-border)' }}
        >
          <div>
            <div className="text-sm font-semibold">Voiceover drift report</div>
            <div className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>
              Estimated narration vs. shot duration · {doc.speaking_pace_wpm || 150} wpm
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2 py-1 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: 'var(--card-border)' }}
          >
            Close
          </button>
        </header>

        <div
          className="px-5 py-3 border-b text-xs flex flex-wrap gap-3"
          style={{ borderColor: 'var(--card-border)' }}
        >
          <Summary count={counts.overrun} label="overrun" color={severityColor('overrun')} />
          <Summary count={counts.tight} label="tight" color={severityColor('tight')} />
          <Summary count={counts.comfortable} label="OK" color={severityColor('comfortable')} />
          <Summary count={counts['dead-air']} label="dead air" color={severityColor('dead-air')} />
        </div>

        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0" style={{ background: 'var(--card-bg)' }}>
              <tr style={{ color: 'var(--fg-muted)' }}>
                <th className="text-left px-3 py-2 font-medium">Shot</th>
                <th className="text-right px-3 py-2 font-medium">Words</th>
                <th className="text-right px-3 py-2 font-medium">Narr.</th>
                <th className="text-right px-3 py-2 font-medium">Shot</th>
                <th className="text-right px-3 py-2 font-medium">Drift</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.shotIndex}
                  className="border-t hover:bg-white/5 cursor-pointer transition-colors"
                  style={{ borderColor: 'var(--card-border)' }}
                  onClick={() => {
                    onJumpToShot(r.shotIndex);
                    onClose();
                  }}
                >
                  <td className="px-3 py-2">{r.shotIndex + 1}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.wordCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                    {(r.estimatedNarrationMs / 1000).toFixed(1)}s
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                    {(r.shotDurationMs / 1000).toFixed(1)}s
                  </td>
                  <td
                    className="px-3 py-2 text-right tabular-nums"
                    style={{ color: severityColor(r.severity) }}
                  >
                    {fmt(r.driftMs)}
                  </td>
                  <td className="px-3 py-2" style={{ color: severityColor(r.severity) }}>
                    {severityLabel(r.severity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer
          className="px-5 py-3 border-t text-[11px]"
          style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
        >
          <strong>Click a row</strong> to select it on the timeline.{' '}
          <strong>Overrun</strong> means the narration is longer than the shot —
          resize the shot or shorten the script.{' '}
          Audio retiming + voiceover regeneration land in follow-up commits.
        </footer>
      </div>
    </div>
  );
}

function Summary({
  count,
  label,
  color,
}: {
  count: number;
  label: string;
  color: string;
}): React.ReactElement {
  return (
    <span className="tabular-nums">
      <span style={{ color }}>●</span> {count} {label}
    </span>
  );
}
