'use client';

/**
 * Inline "Convert to motion collage" button for the Shot inspector.
 *
 * PR 4 of `_plans/2026-06-02-editor-motion-collage-support.md` (the
 * piece the first pass skipped). Surfaces an explicit button — NOT a
 * dropdown entry under Shot Type — per the user's resolved Q2 in the
 * plan: "explicit button in the inspector body".
 *
 * Gating:
 *   - Only shows when the doc's style resolves to doodle_explainer_2
 *     (literal slug OR a saved style derived from doodle).
 *   - Hidden on Title Card rows (those don't generate images).
 *   - Hidden when the row is ALREADY a motion collage (covered by
 *     InspectorMotionCollagePanel's "← Revert to regular row").
 *
 * On click:
 *   1. PATCH_ROW flips shot_kind = 'motion_collage', visual_type =
 *      'Animation', seeds a 2×2 grid with empty panel prompts, clears
 *      image_url + motion_collage_image_url + motion_collage_panel_urls.
 *   2. POST /api/generate/production-doc/motion-collage/panels with the
 *      row's narration content so the four empty panels auto-fill from
 *      the script. Mirrors production-doc's convert flow verbatim.
 *      Cheap LLM call; no image gen here.
 *
 * Once the row is converted, `InspectorMotionCollagePanel` mounts in
 * the inspector (via the existing `shotKind === 'motion_collage'`
 * branch) and the user gets the full grid + panel-prompts + generate +
 * lightbox UI from PR 3.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import type { ProductionDoc } from '@/remotion/utils';

interface ConvertToMotionCollageButtonProps {
  row: ProductionDoc['rows'][number];
  shotIndex: number;
  doc: ProductionDoc;
  /** Resolved built-in slug from the EditorClient's styles fetch. Lets
   *  this button fire on saved styles derived from doodle_explainer_2
   *  (UUID style_preset) — same fix as PR 1 of the OST plan. Falls
   *  back to the literal slug check when undefined. */
  effectiveStyleSlug?: string;
  onUpdateRow: (patch: Partial<ProductionDoc['rows'][number]>) => void;
}

/** Grid presets — identical to the post-convert MotionCollageRowEditor's
 *  picker. Capped at 16 cells (= MAX_COLLAGE_CELLS). Ordered smallest
 *  first so the picker reads left-to-right small → big. */
const GRID_PRESETS: ReadonlyArray<{ cols: number; rows: number; label: string }> = [
  { cols: 2, rows: 2, label: '2×2' },
  { cols: 3, rows: 2, label: '3×2' },
  { cols: 2, rows: 3, label: '2×3' },
  { cols: 3, rows: 3, label: '3×3' },
  { cols: 4, rows: 3, label: '4×3' },
  { cols: 4, rows: 4, label: '4×4' },
];

// 2026-06-10 — back to 3×3 (9 panels). The earlier revert to 2×2
// (commit 03ac5b42) was a stopgap because synchronous bulk generation
// from the browser tab blew the 300 s function budget on Kie. The
// async pipeline shipped in Phases 1–3 of
// `_plans/2026-06-09-motion-collage-async-bulk-regen.md` removes that
// constraint:
//   - Bulk regen now enqueues server-side and returns in <1 s; the
//     browser tab can close.
//   - Per-collage chunked progress splits the work across multiple
//     auto-pipeline ticks (3 Kie panels / tick × 3 ticks fits comfortably
//     inside the 255 s per-tick budget for a full 9-panel row).
//   - Editor polling surfaces panels as they land without a reload.
// 9 panels lets the MOTION DELTA rules in `motion-collage-panel-fill.ts`
// breathe — tiny per-step changes still cover the full motion arc,
// which is what produced the better composition continuity 03ac5b42
// had to give up.
// Cost note: ~2.25× the per-row image-gen cost vs. 2×2; the per-call
// cost cap on /bulk-regen ($10 default) protects against runaway spend.
const DEFAULT_GRID = GRID_PRESETS[3];

export function ConvertToMotionCollageButton({
  row,
  shotIndex,
  doc,
  effectiveStyleSlug,
  onUpdateRow,
}: ConvertToMotionCollageButtonProps): React.ReactElement | null {
  const [converting, setConverting] = useState(false);
  // User-selected grid for the convert. Persisted to local state only —
  // grid changes after conversion happen through MotionCollageRowEditor.
  // Default to the smallest grid (2×2) because it's the cheapest to
  // auto-fill + regenerate, and a user who wants more can swap up
  // before clicking convert.
  const [selectedGrid, setSelectedGrid] = useState<{ cols: number; rows: number }>(
    DEFAULT_GRID,
  );

  // Gates (kept tight):
  //   - Hidden on Title Card rows (image-less typography, can't be a collage).
  //   - Hidden on already-motion-collage rows (the panel inspector's
  //     "← Revert" button covers the reverse direction).
  //
  // The doodle-style gate the first cut had was removed (2026-06-02)
  // after a user-reported bug: a confirmed doodle doc with a saved-style
  // UUID (style 521adb81-...) hid the button silently because the DB
  // row's `based_on_built_in` link was never backfilled. The motion-
  // collage pipeline IS doodle-specific (panel prompts inherit doodle
  // style refs server-side), but hiding the button on legitimate doodle
  // docs because of a data gap is worse UX than showing it everywhere
  // and letting the panel-gen result speak for itself. We surface the
  // resolved style in the tooltip so the user sees what we'll send.
  if (row.visual_type === 'Title Card') return null;
  if (row.shot_kind === 'motion_collage') return null;
  // Resolved slug used purely for the tooltip so the user can see
  // which style the panel-gen call will use. Empty string when the
  // doc has no style at all (the auto-fill server-side helper still
  // works, just with no style suffix).
  const resolvedSlug = effectiveStyleSlug ?? doc.style_preset ?? '';

  async function handleConvert(): Promise<void> {
    if (converting) return;
    setConverting(true);
    const panelCount = selectedGrid.cols * selectedGrid.rows;
    // Snapshot the source content BEFORE the row mutation clears
    // ai_image_prompt — the auto-fill needs the script + visual_description
    // + baseImagePrompt to decompose the beat into keyframes.
    const captured = {
      grid: selectedGrid,
      scriptText: row.script_text ?? '',
      visualDescription: row.visual_description,
      baseImagePrompt: row.ai_image_prompt,
      existingPanels: Array.from({ length: panelCount }, () => ''),
    };
    console.info('[editor motion-collage convert]', {
      shotIndex,
      from: row.shot_kind ?? row.visual_type ?? '(undefined)',
      grid: selectedGrid,
      panelCount,
      hasScript: captured.scriptText.length > 0,
      hasVisualDesc: Boolean(captured.visualDescription?.trim()),
    });
    // Flip the row first so the inspector re-routes to
    // InspectorMotionCollagePanel and the user sees the grid UI
    // immediately — even before the auto-fill returns.
    onUpdateRow({
      shot_kind: 'motion_collage',
      visual_type: 'Animation',
      motion_collage_grid: selectedGrid,
      motion_collage_panel_prompts: Array.from({ length: panelCount }, () => ''),
      ai_image_prompt: '',
      image_url: undefined,
      motion_collage_image_url: undefined,
      motion_collage_panel_urls: undefined,
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- LLM RPC; awaits + reads response
      const res = await fetch('/api/generate/production-doc/motion-collage/panels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid: captured.grid,
          scriptText: captured.scriptText,
          visualDescription: captured.visualDescription,
          baseImagePrompt: captured.baseImagePrompt,
          existingPanels: captured.existingPanels,
          stylePreset: doc.style_preset,
          characterDescriptions: doc.doodle_explainer_2_character_descriptions,
        }),
      });
      const data = (await res.json()) as { panelPrompts?: string[]; error?: string };
      if (!res.ok || !Array.isArray(data.panelPrompts)) {
        const msg = data.error ?? `Auto-fill failed (HTTP ${res.status})`;
        toast.error(msg);
        console.warn('[editor motion-collage convert] autofill failed', {
          shotIndex,
          error: msg,
        });
        return;
      }
      // The row was flipped with empty panels; merge the LLM result in.
      onUpdateRow({
        motion_collage_panel_prompts: data.panelPrompts.slice(0, panelCount),
      });
      const filled = data.panelPrompts.filter((p) => p.trim()).length;
      console.info('[editor motion-collage convert] autofill success', {
        shotIndex,
        filled,
        total: panelCount,
      });
      toast.success(
        `Converted to motion collage · ${filled} of ${panelCount} panel${panelCount === 1 ? '' : 's'} auto-filled.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Auto-fill failed';
      toast.error(msg);
      console.warn('[editor motion-collage convert] autofill threw', {
        shotIndex,
        error: msg,
      });
    } finally {
      setConverting(false);
    }
  }

  const panelCount = selectedGrid.cols * selectedGrid.rows;

  return (
    <div
      className="p-3 border-b"
      style={{ borderColor: 'var(--card-border)' }}
    >
      {/* Grid picker — same preset set as MotionCollageRowEditor's
          post-convert picker, so the user can lock in a non-default
          grid (3×3, 4×4, etc.) before they spend an auto-fill call.
          Grid is also editable after conversion via the same
          presets in the panel editor. */}
      <div className="flex items-center gap-1 flex-wrap mb-2">
        <span
          className="text-[10px]"
          style={{ color: 'var(--fg-muted)' }}
        >
          Grid:
        </span>
        {GRID_PRESETS.map((preset) => {
          const active =
            preset.cols === selectedGrid.cols && preset.rows === selectedGrid.rows;
          return (
            <button
              key={preset.label}
              type="button"
              disabled={converting}
              onClick={() => setSelectedGrid({ cols: preset.cols, rows: preset.rows })}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                background: active
                  ? 'rgba(124,58,237,0.25)'
                  : 'rgba(255,255,255,0.04)',
                color: active ? '#a78bfa' : 'var(--fg)',
                border: active
                  ? '1px solid rgba(124,58,237,0.45)'
                  : '1px solid var(--card-border)',
                cursor: converting ? 'wait' : 'pointer',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontWeight: active ? 600 : 400,
              }}
              title={`${preset.label} — ${preset.cols * preset.rows} keyframes`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => void handleConvert()}
        disabled={converting}
        className="text-[11px] px-2.5 py-1.5 rounded font-semibold w-full"
        style={{
          background: converting
            ? 'rgba(124,58,237,0.10)'
            : 'rgba(124,58,237,0.20)',
          color: '#a78bfa',
          border: '1px solid rgba(124,58,237,0.45)',
          cursor: converting ? 'wait' : 'pointer',
        }}
        title={`Convert this row to a motion collage at ${selectedGrid.cols}×${selectedGrid.rows} (= ${panelCount} keyframes).${resolvedSlug ? ` Style: ${resolvedSlug}.` : ''} Best for real motion (running, falling, transforming). Auto-fills panel prompts from the row's narration.`}
      >
        {converting
          ? `↯ Converting + auto-filling ${panelCount} panels…`
          : `↯ Convert to motion collage (${selectedGrid.cols}×${selectedGrid.rows})`}
      </button>
      <div
        className="text-[10px] mt-1"
        style={{ color: 'var(--fg-muted)' }}
      >
        Auto-fills {panelCount} panel prompts from this row&apos;s narration.
        You can still change the grid after conversion.
      </div>
    </div>
  );
}
