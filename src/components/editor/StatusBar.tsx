'use client';

/**
 * Editor bottom status bar — replaces the static help strip that
 * previously sat at the bottom of `/edit/[projectId]`.
 *
 * Phase 3 of `_plans/2026-05-19-editor-production-doc-parity.md`.
 * The old strip showed keyboard hints in dense bold text and the
 * owner mistook it for a broken toolbar. The status bar shows what's
 * actually useful at a glance:
 *
 *   • Playhead position and total duration.
 *   • Selected shot index + the first words of its script.
 *   • Render-readiness checklist (✓ doc, ✓ images, ✓ VO, ✓ captions,
 *     ✓ animations, ✓ overlays) so the operator knows the project's
 *     state at a glance, not by clicking around.
 *   • A `?` button that opens the keyboard-shortcut hints overlay —
 *     same content as the old strip, but opt-in, not permanent.
 *
 * The component takes only primitive props so it's trivially memo-
 * friendly. Every value displayed comes from the editor's already-
 * computed state — no extra fetches.
 */

import { useState } from 'react';

interface ReadinessCounts {
  /** Number of shots in the doc. */
  shotCount: number;
  /** Number of shots with a generated still URL. */
  imageCount: number;
  /** Number of shots with a ready B-roll clip. */
  clipCount: number;
  /** Number of shots with an `overlay_stock_terms` value. */
  overlayPlannedCount: number;
  /** Number of shots whose overlay has been fetched (status === 'done'). */
  overlayReadyCount: number;
  /** Whether a voiceover URL is set on the project. */
  hasVoiceover: boolean;
  /** Whether a captions bundle exists for the current voiceover. */
  hasCaptions: boolean;
}

interface StatusBarProps {
  playheadMs: number;
  totalDurationMs: number;
  selection: number | null;
  selectionScriptPreview: string | null;
  saveStatusLabel: string;
  readiness: ReadinessCounts;
  /** Whether to render the `?` keyboard-shortcut button. Falls back
   *  to `true` when omitted so the existing call sites don't change
   *  behavior. Wired from `editor.statusBar.showShortcutHints` in
   *  `src/lib/editor/settings.ts`. */
  showShortcutHints?: boolean;
}

function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

export function StatusBar({
  playheadMs,
  totalDurationMs,
  selection,
  selectionScriptPreview,
  saveStatusLabel,
  readiness,
  showShortcutHints = true,
}: StatusBarProps) {
  const [showShortcuts, setShowShortcuts] = useState(false);

  return (
    <div
      className="rounded-lg border px-3 py-2 flex items-center gap-4 text-xs"
      style={{
        borderColor: 'var(--card-border)',
        color: 'var(--fg-muted)',
        background: 'var(--bg-secondary, transparent)',
      }}
    >
      {/* Playhead clock */}
      <span className="tabular-nums shrink-0" title="Playhead position / total duration">
        <span style={{ color: 'var(--fg)' }}>{fmtClock(playheadMs)}</span>
        <span> / {fmtClock(totalDurationMs)}</span>
      </span>

      {/* Vertical divider */}
      <span aria-hidden style={{ width: 1, height: 14, background: 'var(--card-border)' }} />

      {/* Selection */}
      <span className="min-w-0 flex-1 truncate" title="Selected shot">
        {selection !== null && selectionScriptPreview ? (
          <>
            <span style={{ color: 'var(--fg)' }}>Shot {selection + 1}</span>
            <span> · {truncate(selectionScriptPreview, 80)}</span>
          </>
        ) : (
          <span>No shot selected — click a tile to inspect it</span>
        )}
      </span>

      {/* Readiness checklist — each pill is its own subcomponent so a
          missing piece is obvious at a glance. Hover surfaces the
          exact counts. */}
      <div className="hidden md:flex items-center gap-1.5 shrink-0">
        <ReadyPill
          ok={readiness.imageCount === readiness.shotCount}
          partial={readiness.imageCount > 0 && readiness.imageCount < readiness.shotCount}
          label={`Images ${readiness.imageCount}/${readiness.shotCount}`}
          title={`${readiness.imageCount} of ${readiness.shotCount} shots have a generated still`}
        />
        <ReadyPill
          ok={readiness.hasVoiceover}
          partial={false}
          label={readiness.hasVoiceover ? 'VO ✓' : 'VO —'}
          title={readiness.hasVoiceover ? 'Voiceover attached' : 'No voiceover yet'}
        />
        <ReadyPill
          ok={readiness.hasCaptions}
          partial={false}
          label={readiness.hasCaptions ? 'Captions ✓' : 'Captions —'}
          title={readiness.hasCaptions ? 'Caption bundle present' : 'No captions yet — Generate captions to add'}
        />
        <ReadyPill
          ok={readiness.clipCount > 0}
          partial={false}
          label={`Clips ${readiness.clipCount}`}
          title={`${readiness.clipCount} shots have a ready B-roll clip`}
        />
        {readiness.overlayPlannedCount > 0 && (
          <ReadyPill
            ok={readiness.overlayReadyCount === readiness.overlayPlannedCount}
            partial={
              readiness.overlayReadyCount > 0 &&
              readiness.overlayReadyCount < readiness.overlayPlannedCount
            }
            label={`Overlays ${readiness.overlayReadyCount}/${readiness.overlayPlannedCount}`}
            title={`${readiness.overlayReadyCount} of ${readiness.overlayPlannedCount} planned overlays fetched`}
          />
        )}
      </div>

      {/* Save status reads in plain English. Color comes from the
          parent's existing badge — duplicated here so a glance at the
          bottom of the screen confirms persistence. */}
      <span className="shrink-0 tabular-nums" title="Last save status">
        {saveStatusLabel}
      </span>

      {/* Keyboard shortcuts surfaced behind a `?` so they're
          discoverable without taking permanent real estate. Gated by
          the `editor.statusBar.showShortcutHints` setting so a power
          user who doesn't want the `?` can opt out. */}
      {showShortcutHints && (
        <button
          type="button"
          onClick={() => setShowShortcuts((v) => !v)}
          aria-label="Toggle keyboard shortcuts"
          title="Keyboard shortcuts"
          className="shrink-0 w-5 h-5 rounded-full border text-[10px] font-semibold cursor-pointer transition-colors hover:bg-white/5"
          style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
        >
          ?
        </button>
      )}

      {showShortcuts && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setShowShortcuts(false)}
        >
          <div
            className="rounded-xl max-w-md w-full p-5 text-sm"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--card-border)', color: 'var(--fg)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold mb-3">Keyboard shortcuts</h3>
            <dl className="space-y-1.5">
              <Shortcut k="B" desc="Split shot at playhead" />
              <Shortcut k="Delete" desc="Ripple-delete selected shot" />
              <Shortcut k="Shift + Delete" desc="Blank-delete (keeps the slot)" />
              <Shortcut k="M" desc="Mute / unmute selected shot" />
              <Shortcut k="+ / =" desc="Zoom timeline in" />
              <Shortcut k="- / _" desc="Zoom timeline out" />
              <Shortcut k="Cmd/Ctrl + Z" desc="Undo" />
              <Shortcut k="Cmd/Ctrl + Shift + Z" desc="Redo" />
              <Shortcut k="Cmd/Ctrl + S" desc="Save now" />
              <Shortcut k="Drag tile edge" desc="Resize shot duration" />
              <Shortcut k="Drag top handle" desc="Reorder shots" />
            </dl>
            <button
              type="button"
              onClick={() => setShowShortcuts(false)}
              className="mt-4 text-xs px-3 py-1.5 rounded border hover:bg-white/5 transition-colors"
              style={{ borderColor: 'var(--card-border)' }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReadyPill({
  ok,
  partial,
  label,
  title,
}: {
  ok: boolean;
  partial: boolean;
  label: string;
  title: string;
}) {
  const color = ok
    ? '#22c55e'
    : partial
      ? '#f59e0b'
      : 'var(--fg-muted)';
  const bg = ok
    ? 'rgba(34, 197, 94, 0.10)'
    : partial
      ? 'rgba(245, 158, 11, 0.10)'
      : 'transparent';
  return (
    <span
      title={title}
      className="text-[10px] px-1.5 py-0.5 rounded-md tabular-nums"
      style={{ color, background: bg }}
    >
      {label}
    </span>
  );
}

function Shortcut({ k, desc }: { k: string; desc: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <kbd
        className="text-[11px] px-1.5 py-0.5 rounded border font-mono tabular-nums"
        style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
      >
        {k}
      </kbd>
      <span style={{ color: 'var(--fg-muted)' }}>{desc}</span>
    </div>
  );
}
