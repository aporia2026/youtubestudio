'use client';

/**
 * Settings → Editor preferences panel.
 *
 * Phase 4b of `_plans/2026-05-19-editor-production-doc-parity.md`.
 * Surfaces the four per-device editor preference keys defined in
 * `src/lib/editor/settings.ts`:
 *
 *   - Default timeline zoom (int 1..10)
 *   - Show thumbnails on timeline tiles
 *   - Show the `?` keyboard-shortcut button in the status bar
 *   - Auto-regen captions when the voiceover URL changes
 *
 * Stored in localStorage — these are viewing preferences, not
 * project data. No server round-trip, no autosave, no auth: every
 * accessor in `settings.ts` is SSR-safe and returns the default
 * when localStorage is unreachable.
 *
 * The panel hydrates from localStorage on mount (best-effort —
 * defaults apply when nothing is set). Every change writes through
 * immediately; there's no Save button because the storage is
 * synchronous and per-device.
 */

import { useEffect, useState } from 'react';
import {
  getAutoRegenCaptions,
  getDefaultZoomLevel,
  getShowShortcutHints,
  getShowThumbnails,
  setAutoRegenCaptions,
  setDefaultZoomLevel,
  setShowShortcutHints,
  setShowThumbnails,
} from '@/lib/editor/settings';

export function EditorPrefsPanel() {
  const [zoomLevel, setZoomLevelState] = useState<number>(5);
  const [showThumbnails, setShowThumbnailsState] = useState<boolean>(true);
  const [showShortcutHints, setShowShortcutHintsState] = useState<boolean>(true);
  const [autoRegenCaptions, setAutoRegenCaptionsState] = useState<boolean>(false);

  // Hydrate from localStorage. Runs once on client mount; the
  // accessors return the default when nothing is stored, so this
  // never crashes on a brand-new install.
  useEffect(() => {
    setZoomLevelState(getDefaultZoomLevel());
    setShowThumbnailsState(getShowThumbnails());
    setShowShortcutHintsState(getShowShortcutHints());
    setAutoRegenCaptionsState(getAutoRegenCaptions());
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Editor preferences
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Viewing preferences for <code>/edit/[projectId]</code>. Saved on
          this device only — they do not sync across devices.
        </p>
      </div>

      {/* Default zoom — single slider with a live value readout. */}
      <Card title="Default timeline zoom" subtitle="Initial zoom level when the editor opens. 1 = whole video fits on screen, 10 = frame-level precision.">
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums w-6 text-right" style={{ color: 'var(--text-muted)' }}>
            1
          </span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={zoomLevel}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              setZoomLevelState(next);
              setDefaultZoomLevel(next);
            }}
            className="flex-1"
            aria-label="Default timeline zoom"
          />
          <span className="text-xs tabular-nums w-6" style={{ color: 'var(--text-muted)' }}>
            10
          </span>
          <span
            className="text-sm font-semibold tabular-nums w-10 text-center"
            style={{ color: 'var(--text-primary)' }}
          >
            {zoomLevel}×
          </span>
        </div>
      </Card>

      <Card
        title="Show thumbnails on timeline tiles"
        subtitle="When off, the timeline draws colored blocks instead of the per-shot generated still. Saves a bit on slow machines / large docs."
      >
        <Toggle
          checked={showThumbnails}
          onChange={(v) => {
            setShowThumbnailsState(v);
            setShowThumbnails(v);
          }}
        />
      </Card>

      <Card
        title="Show keyboard-shortcut hints"
        subtitle="The small `?` button in the editor's status bar. Toggle off if you know your shortcuts and want the cleanest UI."
      >
        <Toggle
          checked={showShortcutHints}
          onChange={(v) => {
            setShowShortcutHintsState(v);
            setShowShortcutHints(v);
          }}
        />
      </Card>

      <Card
        title="Auto-regenerate captions when the voiceover changes"
        subtitle="When on, swapping the voiceover URL automatically kicks off caption regeneration. Off by default because captions take ~30 s and cost a small API call."
      >
        <Toggle
          checked={autoRegenCaptions}
          onChange={(v) => {
            setAutoRegenCaptionsState(v);
            setAutoRegenCaptions(v);
          }}
        />
      </Card>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="p-4 rounded-xl border space-y-3"
      style={{ borderColor: 'var(--card-border)', background: 'var(--bg-secondary, transparent)' }}
    >
      <div>
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {title}
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {subtitle}
        </div>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center cursor-pointer gap-2">
      <span
        className="relative inline-block w-9 h-5 rounded-full transition-colors"
        style={{
          background: checked ? 'var(--accent-purple-bright, #a78bfa)' : 'var(--card-border)',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only"
        />
        <span
          className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
          style={{ transform: `translateX(${checked ? '18px' : '2px'})` }}
        />
      </span>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {checked ? 'On' : 'Off'}
      </span>
    </label>
  );
}
