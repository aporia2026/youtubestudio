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
 * Bulk-apply / clear-overrides actions (see `_plans/2026-05-25-editor-bulk-apply-actions.md`)
 * are surfaced as a compact secondary row under each field. They mirror
 * production-doc's semantics: "Apply to all" sets the doc-level default
 * for the field (so per-row overrides keep sticking out); "Clear
 * overrides" wipes every row's per-row override of that field. Both
 * actions are optional props — when the parent doesn't pass them the
 * row hides itself so this component still works in any host.
 *
 * Range-apply (e.g. shots N..M) is intentionally not included — the
 * editor has no range UI for these fields yet. See the plan for the
 * v2 carve-out.
 */

import { useEffect, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';

type SectionLayout = 'overlay' | 'letterbox';

type OstMode = 'overlay' | 'bake' | 'none';

interface ShotLayoutControlsProps {
  row: ProductionDoc['rows'][number];
  /** Doc-level fallbacks — the "Default" affordance reads these so
   *  the user sees what behaviour kicks in when the per-row override
   *  is cleared. */
  docSectionTitleLayoutDefault: SectionLayout | undefined;
  docPillarboxColorDefault: string | undefined;
  docSceneZoomDefault: number | undefined;
  docSceneFadeDefault: boolean | undefined;
  /** Doc-level fallback for the per-row on-screen-text mode. */
  docOnScreenTextModeDefault: OstMode | undefined;
  onUpdate: (patch: Partial<ProductionDoc['rows'][number]>) => void;
  /** Total row count in the doc — used by Clear-overrides to label
   *  the disabled state correctly (a single-row doc has nothing to
   *  clear). When undefined we render the buttons in their normal
   *  state and let the parent's no-op handler do the right thing. */
  totalRows?: number;
  // ─── Bulk-apply / clear-overrides handlers ───────────────────────
  //
  // Each pair targets one of the five per-row layout fields. When
  // any prop is undefined the corresponding row of secondary buttons
  // hides itself, so this component still renders cleanly in hosts
  // that don't wire bulks.
  //
  // "Apply to all" sets the matching doc-level default. It does NOT
  // stamp the value onto every row — per-row overrides stay intact,
  // mirroring production-doc's model.
  // "Clear overrides" wipes every row's per-row override of that
  // field via a PATCH_ROW loop in the parent.
  onApplySectionTitleLayoutToAll?: (layout: SectionLayout) => void;
  onClearSectionTitleLayoutOverrides?: () => void;
  onApplyPillarboxColorToAll?: (color: string) => void;
  onClearPillarboxColorOverrides?: () => void;
  onApplySceneZoomToAll?: (zoom: number) => void;
  onClearSceneZoomOverrides?: () => void;
  /** Scene-fade has tri-state semantics. The "Apply to all" handler
   *  receives the *effective* boolean (what the renderer would use
   *  right now for this row) — passing `undefined` is meaningless
   *  here. */
  onApplySceneFadeToAll?: (sceneFade: boolean) => void;
  onClearSceneFadeOverrides?: () => void;
  onApplyOstModeToAll?: (mode: OstMode | undefined) => void;
  onClearOstModeOverrides?: () => void;
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
  docOnScreenTextModeDefault,
  onUpdate,
  onApplySectionTitleLayoutToAll,
  onClearSectionTitleLayoutOverrides,
  onApplyPillarboxColorToAll,
  onClearPillarboxColorOverrides,
  onApplySceneZoomToAll,
  onClearSceneZoomOverrides,
  onApplySceneFadeToAll,
  onClearSceneFadeOverrides,
  onApplyOstModeToAll,
  onClearOstModeOverrides,
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
            <BulkActionsRow
              onApplyToAll={
                onApplySectionTitleLayoutToAll
                  ? () => onApplySectionTitleLayoutToAll(effectiveLayout)
                  : undefined
              }
              applyDisabled={effectiveLayout === (docSectionTitleLayoutDefault ?? 'letterbox')}
              onClearOverrides={onClearSectionTitleLayoutOverrides}
            />
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
            <BulkActionsRow
              onApplyToAll={
                onApplyPillarboxColorToAll
                  ? () => onApplyPillarboxColorToAll(effectivePillar.toLowerCase())
                  : undefined
              }
              applyDisabled={
                effectivePillar.toLowerCase() === (docPillarboxColorDefault ?? '#ffffff').toLowerCase()
              }
              onClearOverrides={onClearPillarboxColorOverrides}
            />
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
            <BulkActionsRow
              onApplyToAll={
                onApplySceneZoomToAll
                  ? () => onApplySceneZoomToAll(effectiveZoom)
                  : undefined
              }
              applyDisabled={effectiveZoom === (docSceneZoomDefault ?? 100)}
              onClearOverrides={onClearSceneZoomOverrides}
            />
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
            <BulkActionsRow
              onApplyToAll={
                onApplySceneFadeToAll
                  ? () => onApplySceneFadeToAll(Boolean(row.scene_fade ?? docSceneFadeDefault ?? true))
                  : undefined
              }
              applyDisabled={
                Boolean(row.scene_fade ?? docSceneFadeDefault ?? true) ===
                Boolean(docSceneFadeDefault ?? true)
              }
              onClearOverrides={onClearSceneFadeOverrides}
            />
          </div>

          {/* On-screen text mode — overlay (Remotion renders a
              LowerThird), bake (text already in image pixels), none
              (suppress). Tri-state + Default like scene_fade. The
              prod-doc page has the same control inline on each row
              (production-doc/page.tsx:7731). */}
          <div>
            <div className="text-[10px] mb-1" style={{ color: 'var(--fg-muted)' }}>
              On-screen text mode
            </div>
            <div className="flex gap-1">
              {([
                {
                  label: `Default${
                    docOnScreenTextModeDefault
                      ? ` (${docOnScreenTextModeDefault})`
                      : ' (bake)'
                  }`,
                  value: undefined,
                },
                { label: 'Overlay', value: 'overlay' as const },
                { label: 'Bake', value: 'bake' as const },
                { label: 'None', value: 'none' as const },
              ] as const).map((opt) => {
                const isActive = row.on_screen_text_mode === opt.value;
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => {
                      console.info('[editor shot-layout ost-mode] changed', {
                        from: row.on_screen_text_mode,
                        to: opt.value,
                      });
                      onUpdate({ on_screen_text_mode: opt.value });
                    }}
                    className="text-[10px] px-1.5 py-1 rounded border transition-colors"
                    style={{
                      borderColor: isActive
                        ? 'var(--editor-accent, #a78bfa)'
                        : 'var(--card-border)',
                      color: isActive
                        ? 'var(--editor-accent, #a78bfa)'
                        : 'var(--fg)',
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <BulkActionsRow
              onApplyToAll={
                onApplyOstModeToAll
                  ? () => onApplyOstModeToAll(row.on_screen_text_mode ?? docOnScreenTextModeDefault)
                  : undefined
              }
              applyDisabled={
                (row.on_screen_text_mode ?? docOnScreenTextModeDefault) === docOnScreenTextModeDefault
              }
              onClearOverrides={onClearOstModeOverrides}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Bulk-action affordance ────────────────────────────────────────────────
//
// Small secondary row rendered under each field. Reads as "advanced" —
// muted text, dotted underline, no border — so it never competes with
// the primary controls. Self-hides when neither handler is passed.

function BulkActionsRow({
  onApplyToAll,
  applyDisabled,
  onClearOverrides,
}: {
  onApplyToAll?: () => void;
  applyDisabled?: boolean;
  onClearOverrides?: () => void;
}): React.ReactElement | null {
  if (!onApplyToAll && !onClearOverrides) return null;
  return (
    <div className="flex gap-2 mt-1 text-[10px]" style={{ color: 'var(--fg-muted)' }}>
      {onApplyToAll && (
        <button
          type="button"
          onClick={onApplyToAll}
          disabled={applyDisabled}
          className="underline decoration-dotted underline-offset-2 disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
          title={
            applyDisabled
              ? 'This shot already matches the doc default — nothing to apply.'
              : 'Make this the default for every shot. Per-shot overrides stay until you clear them.'
          }
        >
          Apply to all
        </button>
      )}
      {onApplyToAll && onClearOverrides && <span aria-hidden>·</span>}
      {onClearOverrides && (
        <button
          type="button"
          onClick={onClearOverrides}
          className="underline decoration-dotted underline-offset-2"
          title="Reset every shot to the doc default for this field."
        >
          Clear overrides
        </button>
      )}
    </div>
  );
}
