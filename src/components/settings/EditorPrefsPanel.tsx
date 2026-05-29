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
  getAudioLaneHeight,
  getDefaultPlaybackRate,
  getDefaultZoomLevel,
  getGptImage2EditPrimary,
  getLeftRailDefaultTab,
  getPreviewFitMode,
  getShowShortcutHints,
  getShowThumbnails,
  getVideoLaneHeight,
  setAudioLaneHeight,
  setAutoRegenCaptions,
  setDefaultPlaybackRate,
  setDefaultZoomLevel,
  setGptImage2EditPrimary,
  setLeftRailDefaultTab,
  setPreviewFitMode,
  setShowShortcutHints,
  setShowThumbnails,
  setVideoLaneHeight,
  type Gpt2EditPrimary,
  type LeftRailTab,
  type PlaybackRateValue,
  type PreviewFitMode,
} from '@/lib/editor/settings';

const LEFT_RAIL_TAB_OPTIONS: Array<{ value: LeftRailTab; label: string }> = [
  { value: 'shots', label: 'Shots' },
  { value: 'media', label: 'Media' },
  { value: 'audio', label: 'Audio' },
  { value: 'captions', label: 'Captions' },
  { value: 'ai', label: 'AI Tools' },
  { value: 'settings', label: 'Settings' },
];

export function EditorPrefsPanel() {
  const [zoomLevel, setZoomLevelState] = useState<number>(5);
  const [showThumbnails, setShowThumbnailsState] = useState<boolean>(true);
  const [showShortcutHints, setShowShortcutHintsState] = useState<boolean>(true);
  const [autoRegenCaptions, setAutoRegenCaptionsState] = useState<boolean>(false);
  const [leftRailTab, setLeftRailTabState] = useState<LeftRailTab>('shots');
  const [videoLaneH, setVideoLaneHState] = useState<number>(64);
  const [audioLaneH, setAudioLaneHState] = useState<number>(56);
  const [playbackRate, setPlaybackRateState] = useState<PlaybackRateValue>(1);
  const [fitMode, setFitModeState] = useState<PreviewFitMode>('contain');
  const [gpt2Primary, setGpt2PrimaryState] = useState<Gpt2EditPrimary>('atlas');

  // Hydrate from localStorage. Runs once on client mount; the
  // accessors return the default when nothing is stored, so this
  // never crashes on a brand-new install.
  useEffect(() => {
    setZoomLevelState(getDefaultZoomLevel());
    setShowThumbnailsState(getShowThumbnails());
    setShowShortcutHintsState(getShowShortcutHints());
    setAutoRegenCaptionsState(getAutoRegenCaptions());
    setLeftRailTabState(getLeftRailDefaultTab());
    setVideoLaneHState(getVideoLaneHeight());
    setAudioLaneHState(getAudioLaneHeight());
    setPlaybackRateState(getDefaultPlaybackRate());
    setFitModeState(getPreviewFitMode());
    setGpt2PrimaryState(getGptImage2EditPrimary());
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

      {/* Five new keys (2026-05-20). Mirror the order they affect the
          editor experience: layout → timeline → preview. */}

      <Card
        title="Default left-rail tab"
        subtitle="Which tab opens when you click an icon for the first time in a session. Subsequent clicks remember your last selection."
      >
        <select
          value={leftRailTab}
          onChange={(e) => {
            const next = e.target.value as LeftRailTab;
            setLeftRailTabState(next);
            setLeftRailDefaultTab(next);
          }}
          className="text-sm rounded-lg px-3 py-1.5"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
          }}
        >
          {LEFT_RAIL_TAB_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Card>

      <Card
        title="Video lane height"
        subtitle="Pixel height of the timeline's video track. Bigger = larger thumbnails; smaller = denser layout when the timeline gets crowded."
      >
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums w-10 text-right" style={{ color: 'var(--text-muted)' }}>
            32
          </span>
          <input
            type="range"
            min={32}
            max={128}
            step={4}
            value={videoLaneH}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              setVideoLaneHState(next);
              setVideoLaneHeight(next);
            }}
            className="flex-1"
            aria-label="Video lane height"
          />
          <span className="text-xs tabular-nums w-10" style={{ color: 'var(--text-muted)' }}>
            128
          </span>
          <span
            className="text-sm font-semibold tabular-nums w-14 text-center"
            style={{ color: 'var(--text-primary)' }}
          >
            {videoLaneH} px
          </span>
        </div>
      </Card>

      <Card
        title="Audio lane height"
        subtitle="Pixel height of the timeline's waveform track. Bigger waveforms make peaks easier to read at a glance."
      >
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums w-10 text-right" style={{ color: 'var(--text-muted)' }}>
            32
          </span>
          <input
            type="range"
            min={32}
            max={128}
            step={4}
            value={audioLaneH}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              setAudioLaneHState(next);
              setAudioLaneHeight(next);
            }}
            className="flex-1"
            aria-label="Audio lane height"
          />
          <span className="text-xs tabular-nums w-10" style={{ color: 'var(--text-muted)' }}>
            128
          </span>
          <span
            className="text-sm font-semibold tabular-nums w-14 text-center"
            style={{ color: 'var(--text-primary)' }}
          >
            {audioLaneH} px
          </span>
        </div>
      </Card>

      <Card
        title="Default playback rate"
        subtitle="Speed the transport bar opens at. Persists across editor sessions."
      >
        <div className="flex gap-1.5">
          {([0.5, 1, 1.5, 2] as const).map((rate) => {
            const isActive = playbackRate === rate;
            return (
              <button
                key={rate}
                type="button"
                onClick={() => {
                  setPlaybackRateState(rate);
                  setDefaultPlaybackRate(rate);
                }}
                className="text-sm px-3 py-1.5 rounded-lg transition-colors"
                style={{
                  background: isActive ? 'rgba(124,58,237,0.18)' : 'var(--bg-primary)',
                  border: '1px solid',
                  borderColor: isActive ? 'var(--accent-purple-bright)' : 'var(--border)',
                  color: isActive ? 'var(--accent-purple-bright)' : 'var(--text-primary)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {rate}×
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title="Preview fit mode"
        subtitle="How the video frame fits into the preview rectangle. Contain preserves the aspect ratio with letterboxing; Fill stretches edge-to-edge (may distort)."
      >
        <div className="flex gap-1.5">
          {(['contain', 'fill'] as const).map((mode) => {
            const isActive = fitMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setFitModeState(mode);
                  setPreviewFitMode(mode);
                }}
                className="text-sm px-3 py-1.5 rounded-lg transition-colors"
                style={{
                  background: isActive ? 'rgba(124,58,237,0.18)' : 'var(--bg-primary)',
                  border: '1px solid',
                  borderColor: isActive ? 'var(--accent-purple-bright)' : 'var(--border)',
                  color: isActive ? 'var(--accent-purple-bright)' : 'var(--text-primary)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {mode === 'contain' ? 'Contain (letterbox)' : 'Fill (stretch)'}
              </button>
            );
          })}
        </div>
      </Card>

      {/* GPT Image 2 edit provider. Drives the variant button + every
          Atlas-Edit auto-pipeline flow (character/scene continuity,
          mouth removal). The chosen vendor is primary; the other is
          the automatic fallback when the primary fails. See
          _plans/2026-05-29-gpt-image-2-edit-provider-fallback.md. */}
      <Card
        title="GPT Image 2 edit provider"
        subtitle="Drives variant generation, character/scene continuity, and mouth removal. The other vendor is the automatic fallback when the primary fails."
      >
        <div className="flex gap-1.5">
          {(['atlas', 'kie'] as const).map((vendor) => {
            const isActive = gpt2Primary === vendor;
            const label =
              vendor === 'atlas'
                ? 'Atlas (~$0.011/edit) → Kie fallback'
                : 'Kie (~$0.05/edit) → Atlas fallback';
            return (
              <button
                key={vendor}
                type="button"
                onClick={() => {
                  setGpt2PrimaryState(vendor);
                  setGptImage2EditPrimary(vendor);
                }}
                className="text-sm px-3 py-1.5 rounded-lg transition-colors"
                style={{
                  background: isActive ? 'rgba(124,58,237,0.18)' : 'var(--bg-primary)',
                  border: '1px solid',
                  borderColor: isActive ? 'var(--accent-purple-bright)' : 'var(--border)',
                  color: isActive ? 'var(--accent-purple-bright)' : 'var(--text-primary)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
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
