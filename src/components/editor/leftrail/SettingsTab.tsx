'use client';

/**
 * Settings tab — Phase 3 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Hosts the per-project doc-level toggles that used to be top-toolbar
 * pill-buttons (Animate / Stills, Lower-3rd on/off, Overlays auto-
 * fetch). Each one flips a single flag through SET_FLAGS so undo /
 * redo / autosave all pick it up.
 *
 * Per-device editor prefs (default zoom level, show thumbnails, etc.)
 * already live in `/settings → 🎬 Editor`. This tab is for *project*
 * flags only.
 */

import type { ProjectPayloadFlags } from '@/lib/project/payload';

interface SettingsTabProps {
  flags: ProjectPayloadFlags;
  onSetFlags: (patch: Partial<ProjectPayloadFlags>) => void;
  /** Doc-level `overlays_disabled` lives on the doc, not the flags
   *  object — we mirror it here via a separate callback so the UI
   *  stays uniform. */
  overlaysDisabledOnDoc: boolean;
  onToggleOverlaysDisabledOnDoc: () => void;
  // ─── Batch D: scene timing ──────────────────────────────────────
  /** Per-doc override of the workspace minimum scene duration (ms).
   *  Falls back to workspace default when undefined. */
  docMinSceneMs: number | undefined;
  /** Per-doc override of the tail buffer after a row's narration
   *  ends (ms). Falls back to workspace default when undefined. */
  docTailBufferMs: number | undefined;
  /** Patches `doc.min_scene_ms` / `doc.tail_buffer_ms` through
   *  PATCH_DOC. Pass `undefined` to clear and inherit the workspace
   *  default. */
  onSetSceneTiming: (patch: { min_scene_ms?: number; tail_buffer_ms?: number }) => void;
}

export function SettingsTab({
  flags,
  onSetFlags,
  overlaysDisabledOnDoc,
  onToggleOverlaysDisabledOnDoc,
  docMinSceneMs,
  docTailBufferMs,
  onSetSceneTiming,
}: SettingsTabProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <ToggleRow
        label="Animate scenes"
        subtitle={
          flags.animateScenes
            ? 'B-roll clips play in their shots when ready'
            : 'Every shot renders as a still + Ken Burns'
        }
        checked={flags.animateScenes}
        onChange={(v) => onSetFlags({ animateScenes: v })}
      />
      <ToggleRow
        label="Lower-thirds"
        subtitle={
          flags.suppressLowerThirds
            ? 'Hidden across all shots'
            : 'Visible — on-screen text renders as a lower-third'
        }
        checked={!flags.suppressLowerThirds}
        onChange={(v) => onSetFlags({ suppressLowerThirds: !v })}
      />
      <ToggleRow
        label="Auto-fetch overlays"
        subtitle={
          overlaysDisabledOnDoc
            ? 'Skipped — brand mentions stay baked into ai_image_prompt'
            : 'Brave Search → RMBG → smart placement runs for each row'
        }
        checked={!overlaysDisabledOnDoc}
        onChange={() => onToggleOverlaysDisabledOnDoc()}
      />

      {/* Batch D — scene timing. Doc-level overrides of the workspace
          min-scene-duration and tail-buffer-after-narration. */}
      <div className="space-y-3 mt-2 pt-3" style={{ borderTop: '1px solid var(--editor-edge)' }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
          Scene timing
        </div>
        <SliderRow
          label="Min scene duration"
          unit="ms"
          min={1500}
          max={5000}
          step={100}
          value={docMinSceneMs}
          fallback={2400}
          subtitle={
            docMinSceneMs !== undefined
              ? 'Doc override active'
              : 'Inheriting workspace default (2400 ms)'
          }
          onChange={(v) => onSetSceneTiming({ min_scene_ms: v })}
        />
        <SliderRow
          label="Tail buffer after narration"
          unit="ms"
          min={0}
          max={2000}
          step={50}
          value={docTailBufferMs}
          fallback={400}
          subtitle={
            docTailBufferMs !== undefined
              ? 'Doc override active'
              : 'Inheriting workspace default (400 ms)'
          }
          onChange={(v) => onSetSceneTiming({ tail_buffer_ms: v })}
        />
      </div>

      <p className="text-[10px] mt-2 px-1" style={{ color: 'var(--fg-muted)' }}>
        Per-device viewing preferences (default zoom, thumbnails on/off,
        keyboard hints) live in{' '}
        <a href="/settings" className="underline" style={{ color: 'var(--editor-accent)' }}>
          Settings → 🎬 Editor
        </a>
        .
      </p>
    </div>
  );
}

function SliderRow({
  label,
  unit,
  min,
  max,
  step,
  value,
  fallback,
  subtitle,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number | undefined;
  fallback: number;
  subtitle: string;
  onChange: (next: number | undefined) => void;
}) {
  const effective = value ?? fallback;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>
          {label}
        </span>
        <span className="text-[10px] tabular-nums ed-mono" style={{ color: 'var(--fg)' }}>
          {effective} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={effective}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        aria-label={label}
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
          {subtitle}
        </span>
        {value !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-[10px] underline"
            style={{ color: 'var(--fg-muted)' }}
            title="Clear doc-level override; inherit workspace default"
          >
            clear
          </button>
        )}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  subtitle,
  checked,
  onChange,
}: {
  label: string;
  subtitle: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className="flex items-start gap-3 p-2 rounded-md cursor-pointer"
      style={{
        background: 'var(--editor-panel)',
        border: '1px solid var(--editor-edge)',
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>
          {label}
        </div>
        <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
          {subtitle}
        </div>
      </div>
      <span
        className="relative inline-block shrink-0 rounded-full transition-colors mt-0.5"
        style={{
          width: 30,
          height: 16,
          background: checked ? 'var(--editor-accent)' : 'var(--editor-edge-strong)',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only"
        />
        <span
          className="absolute rounded-full transition-transform bg-white"
          style={{
            top: 2,
            left: 2,
            width: 12,
            height: 12,
            transform: `translateX(${checked ? '14px' : '0px'})`,
          }}
        />
      </span>
    </label>
  );
}
