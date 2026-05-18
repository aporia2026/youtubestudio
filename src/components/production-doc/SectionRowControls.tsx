"use client";

/**
 * Inline section-zoom controls rendered in each production-doc row.
 *
 * Three knobs:
 *  - "Zoom to" — pick a thumbnail region (or none).
 *  - "Section title" — text shown as a stripe across the top of frame
 *    for the row's full duration.
 *  - "Transition…" — opens a dialog overriding the doc-level
 *    transition kind, speed, and easing for this specific row.
 *
 * Stateless wrt the row data: parent owns the row, this component just
 * fires change handlers per field. The transition dialog manages its
 * own working copy so the user can tinker without immediately writing
 * to the doc (the save happens on "Done").
 *
 * Phase 4 of `_plans/2026-05-13-thumbnail-zoom-section-divider.md`.
 */
import { useMemo, useState } from 'react';
import type {
  ThumbnailTransitionConfig,
  VideoThumbnail,
} from '@/remotion/types';
import { regionColorFor } from './ThumbnailRegionEditor';
import { TransitionDialog } from './TransitionDialog';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a user-typed hex into the canonical `#rrggbb` form, or `null`
 *  if it isn't a valid 6-digit hex. Accepts the leading `#` optionally,
 *  and is case-insensitive — `ff00aa`, `#FF00AA`, and `#ff00aa` all map
 *  to `#ff00aa`. Short-form (3-digit) hex is rejected on purpose; the
 *  renderer + swatch downstream expect exactly 6 digits. */
function normalizeHex(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const m = /^#?([0-9a-f]{6})$/.exec(trimmed);
  return m ? `#${m[1]}` : null;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface SectionRowControlsProps {
  rowIndex: number;
  /** Total row count in the parent doc — used to validate the upper
   *  bound of the "apply to range" picker so the user can't type a row
   *  number past the end of the doc. */
  totalRows: number;
  /** Composite thumbnail. When undefined the row has no thumbnail-zoom
   *  controls to show — only the scene-fade pill renders. */
  thumbnail: VideoThumbnail | undefined;
  zoomTo: string | undefined;
  sectionTitle: string | undefined;
  /** When this row has a section title, controls whether the stripe overlays
   *  the full-frame scene ('overlay', legacy) or sits above a letterboxed
   *  scene container ('letterbox', new default since 2026-05-17). Undefined
   *  is treated as the doc-level default (or 'letterbox') downstream. */
  sectionTitleLayout: 'overlay' | 'letterbox' | undefined;
  /** Doc-level fallback for the stripe layout. Mirrors the pillarbox-default
   *  pattern: rows that haven't been customized render with this value;
   *  rows with their own `sectionTitleLayout` keep theirs. */
  sectionTitleLayoutDefault: 'overlay' | 'letterbox' | undefined;
  /** Per-row fill color for the letterbox pillarbox area. Hex `#RRGGBB`.
   *  When undefined, falls back to the doc-level default, then to white. */
  pillarboxColor: string | undefined;
  /** Doc-level fallback for pillarbox color. Surfaced here so the swatch
   *  on the row picker shows the *effective* color the renderer will use
   *  when the row hasn't been customized. */
  pillarboxColorDefault: string | undefined;
  /** Per-row static-zoom percentage on the rendered visual. 100 = no zoom.
   *  Undefined falls back to the doc-level default, then to 100. */
  sceneZoom: number | undefined;
  /** Doc-level fallback for `sceneZoom`. Surfaces in the row UI so the
   *  displayed value reflects what the renderer will actually use. */
  sceneZoomDefault: number | undefined;
  transition: ThumbnailTransitionConfig | undefined;
  defaultTransition: ThumbnailTransitionConfig | undefined;
  /** Per-row scene-fade override. `undefined` inherits the doc default.
   *  `true` forces the cross-fade, `false` forces a hard cut. See
   *  `_plans/2026-05-17-scene-transition-controls.md`. */
  sceneFade: boolean | undefined;
  /** Doc-level scene-fade default — surfaced here so the "Default" pill
   *  label can show the *effective* behaviour (e.g. "Default (Cut)"). */
  sceneFadeDefault: boolean | undefined;
  onChangeZoomTo: (regionId: string | undefined) => void;
  onChangeSectionTitle: (title: string | undefined) => void;
  onChangeSectionTitleLayout: (layout: 'overlay' | 'letterbox' | undefined) => void;
  onChangePillarboxColor: (color: string | undefined) => void;
  onChangeTransition: (t: ThumbnailTransitionConfig | undefined) => void;
  onChangeSceneFade: (next: boolean | undefined) => void;
  /** Update this row's static zoom. `undefined` clears the per-row value
   *  so the doc-level default takes over. */
  onChangeSceneZoom: (next: number | undefined) => void;
  /** Promote this row's effective zoom to the doc-level default. */
  onApplySceneZoomToAll: (zoom: number) => void;
  /** Clear every row's `scene_zoom` so they all inherit the doc default. */
  onClearSceneZoomOverrides: () => void;
  /** Apply `title` to every row from `startRow` to `endRow` inclusive
   *  (0-indexed). The parent walks the doc and sets each row's
   *  `section_title` to the same value in one update. */
  onApplyTitleToRange: (startRow: number, endRow: number, title: string) => void;
  /** Set the doc-level pillarbox color default. Per-row overrides are
   *  left intact (see `onClearPillarboxOverrides` for the matching wipe). */
  onApplyPillarboxColorToAll: (color: string) => void;
  /** Clear every row's per-row `pillarbox_color` override so they all
   *  inherit the doc-level default. */
  onClearPillarboxOverrides: () => void;
  /** Set the doc-level stripe-layout default. Per-row overrides are left
   *  intact (see `onClearStripeLayoutOverrides`). */
  onApplyStripeLayoutToAll: (layout: 'overlay' | 'letterbox') => void;
  /** Clear every row's per-row `section_title_layout` override so they
   *  all inherit the doc-level default. */
  onClearStripeLayoutOverrides: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SectionRowControls({
  rowIndex, totalRows, thumbnail, zoomTo, sectionTitle,
  sectionTitleLayout, sectionTitleLayoutDefault,
  pillarboxColor, pillarboxColorDefault,
  sceneZoom, sceneZoomDefault,
  transition, defaultTransition,
  sceneFade, sceneFadeDefault,
  onChangeZoomTo, onChangeSectionTitle, onChangeSectionTitleLayout,
  onChangePillarboxColor, onChangeTransition, onChangeSceneFade,
  onApplyTitleToRange,
  onApplyPillarboxColorToAll, onClearPillarboxOverrides,
  onApplyStripeLayoutToAll, onClearStripeLayoutOverrides,
  onChangeSceneZoom, onApplySceneZoomToAll, onClearSceneZoomOverrides,
}: SectionRowControlsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Inline "apply to range" picker — collapsed by default, expands into
  // a 2-input row when the chip is clicked. State lives here (not in the
  // parent) because it's transient editor UI, not part of the doc.
  const [rangeOpen, setRangeOpen] = useState(false);
  // 1-indexed end row for display; the picker shows the user the same
  // numbers they see in the # column. Default: 4 rows ahead, clamped.
  const [rangeEndDisplay, setRangeEndDisplay] = useState<string>(
    () => String(Math.min(rowIndex + 5, totalRows)),
  );
  // Local section-title draft so typing doesn't fire the parent's save
  // on every keystroke. Commits on blur or Enter. Stays in sync with
  // external changes (e.g. undo from elsewhere) by detecting prop drift
  // inline — the React-recommended alternative to a setState-in-effect.
  const [titleDraft, setTitleDraft] = useState(sectionTitle ?? '');
  const [lastSyncedTitle, setLastSyncedTitle] = useState(sectionTitle ?? '');
  if ((sectionTitle ?? '') !== lastSyncedTitle) {
    setLastSyncedTitle(sectionTitle ?? '');
    setTitleDraft(sectionTitle ?? '');
  }

  // Pillarbox color draft (hex input). Same prop-drift pattern as titleDraft.
  // The committed source of truth is whichever of `pillarboxColor` or
  // `pillarboxColorDefault` is effective; we surface that as the draft so
  // the user sees the live value even when this row hasn't been customized.
  const effectivePillarbox = (pillarboxColor || pillarboxColorDefault || '#ffffff').toLowerCase();
  const [pillarboxDraft, setPillarboxDraft] = useState(effectivePillarbox);
  const [lastSyncedPillarbox, setLastSyncedPillarbox] = useState(effectivePillarbox);
  if (effectivePillarbox !== lastSyncedPillarbox) {
    setLastSyncedPillarbox(effectivePillarbox);
    setPillarboxDraft(effectivePillarbox);
  }

  // Defensive: thumbnail is optional now (a doc may not have one and the
  // parent still wants the scene-fade pill to render). Falling back to an
  // empty regions array keeps every downstream derivation safe to evaluate
  // before the conditional render below.
  const regions = thumbnail?.regions ?? [];
  const regionIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    regions.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [regions]);

  const zoomRegion = zoomTo ? regions.find(r => r.id === zoomTo) : undefined;
  const zoomColor = zoomRegion ? regionColorFor(regionIndexMap.get(zoomRegion.id) ?? 0) : null;

  // Three-state scene-fade pill semantics:
  //  - undefined  → "Default" (inherits the doc-level toggle)
  //  - true       → "Fade"    (force fade even if doc default is off)
  //  - false      → "Cut"     (force hard cut even if doc default is on)
  // The label on "Default" reflects what the doc default will actually
  // resolve to so the row reads honestly when the user inspects it.
  const effectiveDocDefault = sceneFadeDefault ?? true;
  const sceneFadeLabel =
    sceneFade === undefined
      ? `Default (${effectiveDocDefault ? 'Fade' : 'Cut'})`
      : sceneFade
        ? 'Fade'
        : 'Cut';
  const cycleSceneFade = () => {
    // Tri-state cycle: Default → Fade → Cut → Default.
    const next: boolean | undefined =
      sceneFade === undefined ? true : sceneFade === true ? false : undefined;
    console.info('[ui scene-fade] row override', {
      rowIndex,
      from: sceneFade,
      to: next,
    });
    onChangeSceneFade(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 150 }}>
      {/* Thumbnail-zoom controls only make sense when the doc carries a
          composite thumbnail. Without one, we still render the scene-fade
          pill at the bottom so every row stays controllable. */}
      {thumbnail && (
        <>
      {/* Mini-preview of the assigned region (when one is set). */}
      {zoomRegion && (
        <RegionMiniCrop region={zoomRegion} thumbnail={thumbnail} color={zoomColor ?? '#8b5cf6'} />
      )}

      {/* Zoom to dropdown */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {zoomColor && !zoomRegion && (
          <span
            aria-hidden
            style={{
              width: 8, height: 8, borderRadius: 2,
              background: zoomColor, flexShrink: 0,
              boxShadow: `0 0 0 1px ${zoomColor}66`,
            }}
          />
        )}
        <select
          value={zoomTo ?? ''}
          onChange={(e) => onChangeZoomTo(e.target.value || undefined)}
          disabled={regions.length === 0}
          title={regions.length === 0 ? 'Upload + mark regions on the thumbnail first' : 'Zoom this section into a thumbnail region'}
          style={{
            flex: 1,
            fontSize: 11,
            padding: '4px 6px',
            borderRadius: 4,
            background: 'rgba(255,255,255,0.04)',
            color: regions.length === 0 ? 'var(--text-muted)' : 'var(--text)',
            border: '1px solid rgba(255,255,255,0.10)',
            cursor: regions.length === 0 ? 'not-allowed' : 'pointer',
            minWidth: 0,
          }}
        >
          <option value="">— No zoom —</option>
          {regions.map(r => (
            <option key={r.id} value={r.id}>
              {r.label || `Region ${(regionIndexMap.get(r.id) ?? 0) + 1}`}
            </option>
          ))}
        </select>
      </div>

      {/* Section title input */}
      <input
        type="text"
        placeholder="Section title…"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={() => {
          const next = titleDraft.trim();
          if (next === (sectionTitle ?? '')) return;
          onChangeSectionTitle(next || undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setTitleDraft(sectionTitle ?? ''); (e.target as HTMLInputElement).blur(); }
        }}
        style={{
          fontSize: 11,
          padding: '4px 6px',
          borderRadius: 4,
          background: 'rgba(255,255,255,0.04)',
          color: 'var(--text)',
          border: '1px solid rgba(255,255,255,0.10)',
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />

      {/* Apply title to a row range — collapsed by default. Lets the editor
          fill a whole section with one title in one action instead of
          retyping it on every row. Uses the value currently in the title
          input (titleDraft), not the persisted sectionTitle, so the user
          can type-then-apply in one flow without committing first. */}
      {titleDraft.trim() && !rangeOpen && rowIndex + 1 < totalRows && (
        <button
          type="button"
          onClick={() => setRangeOpen(true)}
          title="Set this section title on a range of rows in one action"
          style={{
            fontSize: 10,
            padding: '3px 6px',
            borderRadius: 4,
            background: 'rgba(34,211,238,0.10)',
            color: '#22d3ee',
            border: '1px solid rgba(34,211,238,0.30)',
            cursor: 'pointer',
            textAlign: 'left',
            alignSelf: 'flex-start',
          }}
        >
          ⤓ Apply to range…
        </button>
      )}

      {rangeOpen && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 6px',
            borderRadius: 4,
            background: 'rgba(34,211,238,0.08)',
            border: '1px solid rgba(34,211,238,0.30)',
            fontSize: 10,
            color: 'var(--text-muted)',
          }}
        >
          <span>Rows {rowIndex + 1}</span>
          <span>→</span>
          <input
            type="number"
            min={rowIndex + 2}
            max={totalRows}
            value={rangeEndDisplay}
            onChange={(e) => setRangeEndDisplay(e.target.value)}
            style={{
              fontSize: 10,
              padding: '2px 4px',
              borderRadius: 3,
              background: 'rgba(0,0,0,0.20)',
              color: 'var(--text)',
              border: '1px solid rgba(255,255,255,0.10)',
              outline: 'none',
              width: 42,
              boxSizing: 'border-box',
            }}
          />
          <button
            type="button"
            onClick={() => {
              const title = titleDraft.trim();
              if (!title) {
                setRangeOpen(false);
                return;
              }
              // Parse + clamp the end-row input. 1-indexed for display;
              // convert to 0-indexed for the callback. Lower bound is the
              // CURRENT row (so the range always includes the originating
              // row); upper bound is the last row in the doc.
              const parsed = parseInt(rangeEndDisplay, 10);
              const endDisplay = Number.isFinite(parsed)
                ? Math.min(Math.max(parsed, rowIndex + 1), totalRows)
                : rowIndex + 1;
              onApplyTitleToRange(rowIndex, endDisplay - 1, title);
              setRangeOpen(false);
            }}
            style={{
              fontSize: 10,
              padding: '3px 6px',
              borderRadius: 3,
              background: 'rgba(34,211,238,0.20)',
              color: '#22d3ee',
              border: '1px solid rgba(34,211,238,0.45)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setRangeOpen(false)}
            style={{
              fontSize: 10,
              padding: '3px 6px',
              borderRadius: 3,
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.10)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Stripe ↔ scene layout + pillarbox color — only shown when this
          row has a section title set. The layout choice is per-row by
          default, with two extra controls below (Apply to all rows,
          Reset all rows) so the editor can promote a row's choice to a
          doc-wide default in one click. The pillarbox color is shown
          only in letterbox mode (overlay mode doesn't show bars). */}
      {(sectionTitle?.trim() || titleDraft.trim()) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Stripe layout
          </span>
          <div
            role="group"
            aria-label="Stripe layout"
            style={{
              display: 'flex',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.10)',
              overflow: 'hidden',
            }}
          >
            {(['letterbox', 'overlay'] as const).map((opt) => {
              const effective = sectionTitleLayout ?? sectionTitleLayoutDefault ?? 'letterbox';
              const active = effective === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    console.info('[ui row-layout] toggled', {
                      rowIndex,
                      from: effective,
                      to: opt,
                    });
                    onChangeSectionTitleLayout(opt);
                  }}
                  title={opt === 'letterbox'
                    ? 'Scene shrinks to fit below the stripe — image always fully visible'
                    : 'Stripe overlays full-frame scene (legacy) — top of image may be covered'}
                  style={{
                    flex: 1,
                    fontSize: 10,
                    padding: '3px 6px',
                    background: active ? 'rgba(34,211,238,0.18)' : 'rgba(255,255,255,0.02)',
                    color: active ? '#22d3ee' : 'var(--text-muted)',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: active ? 600 : 400,
                    textTransform: 'capitalize',
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>

          {/* Doc-level layout actions. "Apply to all" promotes the current
              row's layout to the doc default (overrides on other rows
              stay intact). "Reset overrides" wipes every row's per-row
              layout so they all inherit the doc default. */}
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              onClick={() => {
                const effective = sectionTitleLayout ?? sectionTitleLayoutDefault ?? 'letterbox';
                console.info('[ui layout-apply-all] clicked', { rowIndex, layout: effective });
                onApplyStripeLayoutToAll(effective);
              }}
              title="Make this layout the doc-wide default for new and uncustomized rows"
              style={{
                flex: 1,
                fontSize: 10,
                padding: '3px 6px',
                borderRadius: 3,
                background: 'rgba(34,211,238,0.08)',
                color: '#22d3ee',
                border: '1px solid rgba(34,211,238,0.25)',
                cursor: 'pointer',
              }}
            >
              Apply to all
            </button>
            <button
              type="button"
              onClick={() => {
                console.info('[ui layout-clear-overrides] clicked', { rowIndex });
                onClearStripeLayoutOverrides();
              }}
              title="Clear every row's per-row layout override so they all use the doc default"
              style={{
                flex: 1,
                fontSize: 10,
                padding: '3px 6px',
                borderRadius: 3,
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid rgba(255,255,255,0.10)',
                cursor: 'pointer',
              }}
            >
              Reset overrides
            </button>
          </div>

          {(sectionTitleLayout ?? sectionTitleLayoutDefault ?? 'letterbox') === 'letterbox' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label
                  htmlFor={`pillarbox-color-${rowIndex}`}
                  style={{ fontSize: 10, color: 'var(--text-muted)' }}
                  title="Color used for the bars on the sides of the image when it doesn't fill the area below the stripe"
                >
                  Pillarbox
                </label>
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    background: effectivePillarbox,
                    border: '1px solid rgba(255,255,255,0.15)',
                  }}
                />
                <input
                  id={`pillarbox-color-${rowIndex}`}
                  type="text"
                  inputMode="text"
                  spellCheck={false}
                  autoComplete="off"
                  value={pillarboxDraft}
                  placeholder="#ffffff"
                  onChange={(e) => setPillarboxDraft(e.target.value)}
                  onBlur={() => {
                    const normalized = normalizeHex(pillarboxDraft);
                    if (!normalized) {
                      // Revert the draft to the last good value so the user
                      // doesn't end up staring at an invalid string.
                      setPillarboxDraft(effectivePillarbox);
                      return;
                    }
                    if (normalized === effectivePillarbox) {
                      setPillarboxDraft(normalized);
                      return;
                    }
                    console.info('[ui pillarbox-color] changed', {
                      rowIndex,
                      from: pillarboxColor ?? pillarboxColorDefault ?? '#ffffff',
                      to: normalized,
                    });
                    setPillarboxDraft(normalized);
                    onChangePillarboxColor(normalized);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      (e.currentTarget as HTMLInputElement).blur();
                    } else if (e.key === 'Escape') {
                      setPillarboxDraft(effectivePillarbox);
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  style={{
                    width: 78,
                    fontSize: 11,
                    padding: '2px 4px',
                    borderRadius: 3,
                    background: 'rgba(0,0,0,0.20)',
                    color: 'var(--text)',
                    border: `1px solid ${normalizeHex(pillarboxDraft) ? 'rgba(255,255,255,0.15)' : 'rgba(248,113,113,0.55)'}`,
                    outline: 'none',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    letterSpacing: 0.2,
                  }}
                  aria-label="Pillarbox color (hex)"
                  aria-invalid={normalizeHex(pillarboxDraft) ? undefined : true}
                />
                {pillarboxColor && (
                  <button
                    type="button"
                    onClick={() => {
                      console.info('[ui pillarbox-color] changed', {
                        rowIndex,
                        from: pillarboxColor,
                        to: pillarboxColorDefault ?? '#ffffff',
                      });
                      onChangePillarboxColor(undefined);
                    }}
                    title="Reset to doc default"
                    style={{
                      fontSize: 10,
                      padding: '2px 5px',
                      borderRadius: 3,
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid rgba(255,255,255,0.10)',
                      cursor: 'pointer',
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  onClick={() => {
                    const normalized = normalizeHex(pillarboxDraft) ?? effectivePillarbox;
                    console.info('[ui pillarbox-apply-all] clicked', { rowIndex, color: normalized });
                    onApplyPillarboxColorToAll(normalized);
                  }}
                  title="Make this color the doc-wide default for new and uncustomized rows"
                  style={{
                    flex: 1,
                    fontSize: 10,
                    padding: '3px 6px',
                    borderRadius: 3,
                    background: 'rgba(168,85,247,0.10)',
                    color: '#c084fc',
                    border: '1px solid rgba(168,85,247,0.30)',
                    cursor: 'pointer',
                  }}
                >
                  Apply to all
                </button>
                <button
                  type="button"
                  onClick={() => {
                    console.info('[ui pillarbox-clear-overrides] clicked', { rowIndex });
                    onClearPillarboxOverrides();
                  }}
                  title="Clear every row's per-row pillarbox color so they all use the doc default"
                  style={{
                    flex: 1,
                    fontSize: 10,
                    padding: '3px 6px',
                    borderRadius: 3,
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    cursor: 'pointer',
                  }}
                >
                  Reset overrides
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Static zoom on the rendered image / video. Independent of the
          section-title block — every row gets this control, since every
          row may have an image or B-roll clip to zoom. Animation (Ken
          Burns / clip motion) is preserved; only the static scale
          changes. Apply-to-all + Reset-overrides mirror the pillarbox /
          stripe-layout patterns above. */}
      {(() => {
        const effectiveZoom =
          typeof sceneZoom === 'number'
            ? sceneZoom
            : typeof sceneZoomDefault === 'number'
            ? sceneZoomDefault
            : 100;
        const clamped = Math.max(50, Math.min(200, Math.round(effectiveZoom)));
        const commit = (next: number) => {
          const c = Math.max(50, Math.min(200, Math.round(next)));
          onChangeSceneZoom(c === 100 && typeof sceneZoomDefault !== 'number' ? undefined : c);
        };
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Zoom
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                onClick={() => commit(clamped - 5)}
                disabled={clamped <= 50}
                title="Zoom out by 5%"
                style={{
                  fontSize: 11,
                  width: 22,
                  height: 22,
                  borderRadius: 3,
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-muted)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  cursor: clamped <= 50 ? 'not-allowed' : 'pointer',
                }}
              >
                −
              </button>
              <input
                type="number"
                min={50}
                max={200}
                step={5}
                value={clamped}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  if (Number.isFinite(parsed)) commit(parsed);
                }}
                style={{
                  width: 52,
                  fontSize: 11,
                  padding: '2px 4px',
                  borderRadius: 3,
                  background: 'rgba(0,0,0,0.20)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  outline: 'none',
                  textAlign: 'center',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
                aria-label="Scene zoom percentage"
              />
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>%</span>
              <button
                type="button"
                onClick={() => commit(clamped + 5)}
                disabled={clamped >= 200}
                title="Zoom in by 5%"
                style={{
                  fontSize: 11,
                  width: 22,
                  height: 22,
                  borderRadius: 3,
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-muted)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  cursor: clamped >= 200 ? 'not-allowed' : 'pointer',
                }}
              >
                +
              </button>
              {typeof sceneZoom === 'number' && (
                <button
                  type="button"
                  onClick={() => {
                    console.info('[ui scene-zoom] cleared', { rowIndex });
                    onChangeSceneZoom(undefined);
                  }}
                  title="Reset to doc default"
                  style={{
                    fontSize: 10,
                    padding: '2px 5px',
                    borderRadius: 3,
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                onClick={() => {
                  console.info('[ui scene-zoom-apply-all] clicked', { rowIndex, zoom: clamped });
                  onApplySceneZoomToAll(clamped);
                }}
                title="Make this zoom the doc-wide default for new and uncustomized rows"
                style={{
                  flex: 1,
                  fontSize: 10,
                  padding: '3px 6px',
                  borderRadius: 3,
                  background: 'rgba(34,197,94,0.10)',
                  color: '#4ade80',
                  border: '1px solid rgba(34,197,94,0.30)',
                  cursor: 'pointer',
                }}
              >
                Apply to all
              </button>
              <button
                type="button"
                onClick={() => {
                  console.info('[ui scene-zoom-clear-overrides] clicked', { rowIndex });
                  onClearSceneZoomOverrides();
                }}
                title="Clear every row's per-row zoom so they all use the doc default"
                style={{
                  flex: 1,
                  fontSize: 10,
                  padding: '3px 6px',
                  borderRadius: 3,
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  cursor: 'pointer',
                }}
              >
                Reset overrides
              </button>
            </div>
          </div>
        );
      })()}

      {/* Transition override button */}
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        title="Configure how the camera enters/exits this section"
        style={{
          fontSize: 11,
          padding: '6px 8px',
          minHeight: 28,
          borderRadius: 4,
          background: transition ? 'rgba(168,85,247,0.18)' : 'transparent',
          color: transition ? '#c084fc' : 'var(--text-muted)',
          border: `1px solid ${transition ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.10)'}`,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {transition ? '⚙ Custom transition' : '⚙ Transition…'}
      </button>

      {dialogOpen && (
        <TransitionDialog
          title={`Section transition · shot ${rowIndex + 1}`}
          description="Overrides the doc default for this specific row."
          current={transition}
          fallback={defaultTransition}
          resetLabel="Reset to default"
          onSave={(t) => { onChangeTransition(t); setDialogOpen(false); }}
          onReset={() => { onChangeTransition(undefined); setDialogOpen(false); }}
          onClose={() => setDialogOpen(false)}
        />
      )}
        </>
      )}

      {/* Scene-fade override pill — always rendered, regardless of whether
          the doc has a thumbnail. Tri-state cycle: Default → Fade → Cut.
          Override state is highlighted; Default is shown muted so the row
          reads as "inherits". */}
      <button
        type="button"
        onClick={cycleSceneFade}
        title="Click to cycle: Default (inherits doc) → Fade → Cut → Default"
        style={{
          fontSize: 11,
          padding: '6px 8px',
          minHeight: 28,
          borderRadius: 4,
          background:
            sceneFade === undefined
              ? 'transparent'
              : sceneFade
                ? 'rgba(34,211,238,0.10)'
                : 'rgba(239,68,68,0.10)',
          color:
            sceneFade === undefined
              ? 'var(--text-muted)'
              : sceneFade
                ? '#22d3ee'
                : '#f87171',
          border: `1px solid ${
            sceneFade === undefined
              ? 'rgba(255,255,255,0.10)'
              : sceneFade
                ? 'rgba(34,211,238,0.30)'
                : 'rgba(239,68,68,0.30)'
          }`,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        ⇋ Scene fade: {sceneFadeLabel}
      </button>
    </div>
  );
}

// ─── Sub-component: mini cropped preview of the assigned region ────────────────

interface RegionMiniCropProps {
  region: import('@/remotion/types').ThumbnailRegion;
  thumbnail: VideoThumbnail;
  color: string;
}

/**
 * 24px-tall (approximately) crop of the assigned region, scanned from
 * the thumbnail via CSS background-position. Lets the creator confirm
 * at-a-glance which tile a row points at without re-opening the editor.
 */
function RegionMiniCrop({ region, thumbnail, color }: RegionMiniCropProps) {
  // Defend against zero region dimensions (a corrupt persisted region).
  const rw = Math.max(region.w, 1);
  const rh = Math.max(region.h, 1);
  // Preview width caps at 150px (row column is narrow); height scales with aspect ratio
  // but capped to keep rows compact.
  const previewWidth = 150;
  const previewHeight = Math.max(20, Math.min(54, Math.round(previewWidth * (rh / rw))));
  const bgScale = previewWidth / rw;

  return (
    <div
      style={{
        width: previewWidth,
        height: previewHeight,
        backgroundImage: `url(${thumbnail.imageUrl})`,
        backgroundSize: `${thumbnail.width * bgScale}px ${thumbnail.height * bgScale}px`,
        backgroundPosition: `-${region.x * bgScale}px -${region.y * bgScale}px`,
        backgroundRepeat: 'no-repeat',
        border: `1.5px solid ${color}`,
        borderRadius: 3,
      }}
      title={`Zoom target: ${region.label || 'Untitled region'}`}
      aria-label={`Zoom target: ${region.label || 'Untitled region'}`}
    />
  );
}
