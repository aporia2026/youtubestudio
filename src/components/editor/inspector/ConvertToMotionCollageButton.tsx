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

const DEFAULT_GRID = { cols: 2, rows: 2 } as const;
const DEFAULT_PANEL_COUNT = DEFAULT_GRID.cols * DEFAULT_GRID.rows;

export function ConvertToMotionCollageButton({
  row,
  shotIndex,
  doc,
  effectiveStyleSlug,
  onUpdateRow,
}: ConvertToMotionCollageButtonProps): React.ReactElement | null {
  const [converting, setConverting] = useState(false);

  // Gates — same precedence as production-doc's convert button, but
  // accepts saved-style UUIDs via effectiveStyleSlug too.
  const resolvedSlug = effectiveStyleSlug ?? doc.style_preset;
  const isDoodleDoc = resolvedSlug === 'doodle_explainer_2';
  if (!isDoodleDoc) return null;
  if (row.visual_type === 'Title Card') return null;
  if (row.shot_kind === 'motion_collage') return null;

  async function handleConvert(): Promise<void> {
    if (converting) return;
    setConverting(true);
    // Snapshot the source content BEFORE the row mutation clears
    // ai_image_prompt — the auto-fill needs the script + visual_description
    // + baseImagePrompt to decompose the beat into keyframes.
    const captured = {
      grid: DEFAULT_GRID,
      scriptText: row.script_text ?? '',
      visualDescription: row.visual_description,
      baseImagePrompt: row.ai_image_prompt,
      existingPanels: Array.from({ length: DEFAULT_PANEL_COUNT }, () => ''),
    };
    console.info('[editor motion-collage convert]', {
      shotIndex,
      from: row.shot_kind ?? row.visual_type ?? '(undefined)',
      grid: DEFAULT_GRID,
      hasScript: captured.scriptText.length > 0,
      hasVisualDesc: Boolean(captured.visualDescription?.trim()),
    });
    // Flip the row first so the inspector re-routes to
    // InspectorMotionCollagePanel and the user sees the grid UI
    // immediately — even before the auto-fill returns.
    onUpdateRow({
      shot_kind: 'motion_collage',
      visual_type: 'Animation',
      motion_collage_grid: DEFAULT_GRID,
      motion_collage_panel_prompts: Array.from(
        { length: DEFAULT_PANEL_COUNT },
        () => '',
      ),
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
        motion_collage_panel_prompts: data.panelPrompts.slice(0, DEFAULT_PANEL_COUNT),
      });
      const filled = data.panelPrompts.filter((p) => p.trim()).length;
      console.info('[editor motion-collage convert] autofill success', {
        shotIndex,
        filled,
        total: DEFAULT_PANEL_COUNT,
      });
      toast.success(
        `Converted to motion collage · ${filled} panel${filled === 1 ? '' : 's'} auto-filled. Click ↯ Generate when ready.`,
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

  return (
    <div
      className="p-3 border-b"
      style={{ borderColor: 'var(--card-border)' }}
    >
      <button
        type="button"
        onClick={() => void handleConvert()}
        disabled={converting}
        className="text-[11px] px-2.5 py-1.5 rounded font-semibold w-full"
        style={{
          background: converting ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.20)',
          color: '#a78bfa',
          border: '1px solid rgba(124,58,237,0.45)',
          cursor: converting ? 'wait' : 'pointer',
        }}
        title="Convert this row to a motion collage: one row, N keyframes that play hard-cut over the row's duration. Best for showing real motion (running, falling, transforming). Auto-fills the panel prompts from the row's narration."
      >
        {converting ? '↯ Converting + auto-filling…' : '↯ Convert to motion collage'}
      </button>
      <div
        className="text-[10px] mt-1"
        style={{ color: 'var(--fg-muted)' }}
      >
        Seeds a 2×2 grid and auto-fills panel prompts from this row&apos;s narration.
      </div>
    </div>
  );
}
