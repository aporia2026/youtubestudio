'use client';

/**
 * Per-shot layout controls — Batch C of
 * `_plans/2026-05-20-editor-prod-doc-parity-batches.md`.
 *
 * Compact accordion section for the editor's Inspector Shot tab.
 * Surfaces four fields production-doc has on every row but the
 * editor never exposed:
 *
 *   - Section title layout (overlay vs letterbox) — only meaningful
 *     when the row carries a `section_title` stripe.
 *   - Pillarbox color (per-row override of doc default).
 *   - Scene zoom (50-200%, per-row override of doc default).
 *   - Scene fade (default / cut / fade tri-state, per-row override
 *     of doc default).
 *
 * Stateless wrt the row — every change fires an `onUpdate` callback
 * with a partial-row patch the parent dispatches through PATCH_ROW.
 * Undo / autosave handle the rest.
 *
 * Bulk-edit actions production-doc has (apply-to-range,
 * apply-to-all, clear-overrides) are NOT included here — they're
 * production-doc's specialty. The editor inspector is per-shot.
 */

import { useEffect, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';

type SectionLayout = 'overlay' | 'letterbox';

interface ShotLayoutControlsProps {
  row: ProductionDoc['rows'][number];
  /** Doc-level fallbacks — the "Default" affordance reads these so
   *  the user sees what behaviour kicks in when the per-row override
   *  is cleared. */
  docSectionTitleLayoutDefault: SectionLayout | undefined;
  docPillarboxColorDefault: string | undefined;
  docSceneZoomDefault: number | undefined;
  docSceneFadeDefault: boolean | undefined;
  onUpdate: (patch: Partial<ProductionDoc['rows'][number]>) => void;
}

function isValidHex(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s);
}

export function ShotLayoutControls({
  row,
  docSectionTitleLayoutDefault,
  docPillarboxColorDefault,
  docSceneZoomDefault,
  docSceneFadeDefault,
  onUpdate,
}: ShotLayoutControlsProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  // Local draft for the pillarbox hex so the input is editable
  // character-by-character without firing an `onUpdate` every keystroke.
  const [colorDraft, setColorDraft] = useState(row.pillarbox_color ?? '');
  useEffect(() => {
    setColorDraft(row.pillarbox_color ?? '');
  }, [row.pillarbox_color]);

  const effectiveLayout = row.section_title_layout ?? docSectionTitleLayoutDefault ?? 'letterbox';
  const effectivePillar = row.pillarbox_color ?? docPillarboxColorDefault ?? '#ffffff';
  const effectiveZoom = row.scene_zoom ?? docSceneZoomDefault ?? 100;
  const effectiveFade = row.scene_fade ?? docSceneFadeDefault;

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
        style={{ color: 'var(--fg)' }}
      >
        <span className="font-medium">Layout</span>
        <span className="text-[10px] tabular-nums ed-mono" style={{ color: 'var(--fg-muted)' }}>
          {open ? '▾' : '▸'}{' '}
          {effectiveLayout} · zoom {effectiveZoom}%
        </span>
      </button>

      {open && (
        <div className="space-y-2 pt-1">
          {/* Section title layout — only meaningful when a section_title is set */}
          <div>
            <div className="text-[10px] mb-1" style={{ color: 'var(--fg-muted)' }}>
              Section-title layout
            </div>
            <div className="flex gap-1">
              {(['overlay', 'letterbox'] as const).map((opt) => {
                const isActive = effectiveLayout === opt;
                const isOverride = row.section_title_layout === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => onUpdate({ section_title_layout: opt })}
                    className="text-[10px] px-2 py-1 rounded border transition-colors"
                    style={{
                      borderColor: isActive ? 'var(--editor-accent, #a78bfa)' : 'var(--card-border)',
                      color: isActive ? 'var(--editor-accent, #a78bfa)' : 'var(--fg)',
                      fontWeight: isOverride ? 600 : 400,
                    }}
                    title={opt === 'overlay' ? 'Stripe overlaps the full-frame scene' : 'Stripe sits above a letterboxed scene'}
                  >
                    {opt}
                  </button>
                );
              })}
              {row.section_title_layout !== undefined && (
                <button
                  type="button"
                  onClick={() => onUpdate({ section_title_layout: undefined })}
                  className="text-[10px] px-2 py-1 rounded"
                  style={{ color: 'var(--fg-muted)' }}
                  title="Clear per-row override; inherit doc default"
                >
                  clear
                </button>
              )}
            </div>
          </div>

          {/* Pillarbox color — text + swatch */}
          <div>
            <div className="text-[10px] mb-1" style={{ color: 'var(--fg-muted)' }}>
              Pillarbox color
              {row.pillarbox_color === undefined && (
                <span> · inherits {docPillarboxColorDefault ?? '#ffffff'}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={isValidHex(colorDraft) ? colorDraft : effectivePillar}
                onChange={(e) => {
                  setColorDraft(e.target.value);
                  onUpdate({ pillarbox_color: e.target.value });
                }}
                style={{
                  width: 28,
                  height: 24,
                  padding: 0,
                  border: '1px solid var(--card-border)',
                  borderRadius: 4,
                  background: 'transparent',
                  cursor: 'pointer',
                }}
                aria-label="Pillarbox color picker"
              />
              <input
                type="text"
                value={colorDraft}
                onChange={(e) => setColorDraft(e.target.value)}
                onBlur={() => {
                  if (isValidHex(colorDraft)) {
                    onUpdate({ pillarbox_color: colorDraft.toLowerCase() });
                  } else if (colorDraft.trim() === '') {
                    onUpdate({ pillarbox_color: undefined });
                  }
                }}
                placeholder="#ffffff"
                className="flex-1 text-xs rounded border px-2 py-1 ed-mono"
                style={{
                  borderColor: 'var(--card-border)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                }}
              />
              {row.pillarbox_color !== undefined && (
                <button
                  type="button"
                  onClick={() => onUpdate({ pillarbox_color: undefined })}
                  className="text-[10px] px-2 py-1 rounded"
                  style={{ color: 'var(--fg-muted)' }}
                  title="Clear per-row override; inherit doc default"
                >
                  clear
                </button>
              )}
            </div>
          </div>

          {/* Scene zoom — 50-200% slider */}
          <div>
            <div className="text-[10px] mb-1" style={{ color: 'var(--fg-muted)' }}>
              Scene zoom {row.scene_zoom !== undefined ? '(overridden)' : `· inherits ${docSceneZoomDefault ?? 100}%`}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={50}
                max={200}
                step={5}
                value={effectiveZoom}
                onChange={(e) => onUpdate({ scene_zoom: Number(e.target.value) })}
                className="flex-1"
                aria-label="Scene zoom"
              />
              <span className="text-[10px] tabular-nums w-10 text-right ed-mono" style={{ color: 'var(--fg)' }}>
                {effectiveZoom}%
              </span>
              {row.scene_zoom !== undefined && (
                <button
                  type="button"
                  onClick={() => onUpdate({ scene_zoom: undefined })}
                  className="text-[10px] px-2 py-1 rounded"
                  style={{ color: 'var(--fg-muted)' }}
                  title="Clear per-row override; inherit doc default"
                >
                  clear
                </button>
              )}
            </div>
          </div>

          {/* Scene fade — tri-state radio */}
          <div>
            <div className="text-[10px] mb-1" style={{ color: 'var(--fg-muted)' }}>
              Scene fade
            </div>
            <div className="flex gap-1">
              {([
                { label: `Default${effectiveFade === undefined && docSceneFadeDefault === false ? ' (cut)' : effectiveFade === undefined && docSceneFadeDefault !== false ? ' (fade)' : ''}`, value: undefined },
                { label: 'Cut', value: false },
                { label: 'Fade', value: true },
              ] as const).map((opt) => {
                const isActive = row.scene_fade === opt.value;
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => {
                      // `transition_in === 'cross-fade'` silently
                      // overrides `scene_fade=false` in the renderer's
                      // resolution (see remotion/utils.ts:856). Without
                      // this coupling, clicking "Cut" left the timeline
                      // cross-fade active and the user saw "fade still
                      // appears even though I turned it off." So when
                      // the user picks Cut, also clear transition_in;
                      // when they pick Fade, set transition_in=null so
                      // a stale 'cross-fade' value can't shadow scene
                      // fade. Default leaves both undefined.
                      const patch: { scene_fade: boolean | undefined; transition_in?: 'cross-fade' | null } =
                        { scene_fade: opt.value };
                      if (opt.value === false) patch.transition_in = null;
                      if (opt.value === true) patch.transition_in = null;
                      onUpdate(patch);
                    }}
                    className="text-[10px] px-2 py-1 rounded border transition-colors"
                    style={{
                      borderColor: isActive ? 'var(--editor-accent, #a78bfa)' : 'var(--card-border)',
                      color: isActive ? 'var(--editor-accent, #a78bfa)' : 'var(--fg)',
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
