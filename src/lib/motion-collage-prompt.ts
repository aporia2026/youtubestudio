/**
 * Compose per-panel prompts into a single N×M motion-collage
 * instruction sent to the image model. Distinct from
 * `composeCollagePrompt` (in `./collage-prompt.ts`), which produces a
 * "4 DISTINCT scenes" instruction for the cost-optimization collage
 * path: this composer produces the OPPOSITE instruction — every panel
 * must be the SAME scene with one moving element advancing — which is
 * what makes the sliced output read as motion when played in sequence.
 *
 * Used by `generateMotionCollage` in the auto-pipeline AND
 * (eventually) by the manual editor path when a user opens the Shot
 * Inspector to re-roll a motion_collage row. See
 * `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.
 *
 * `reinforced = true` appends a stronger directive that re-states the
 * same-scene constraint. Used on the retry pass when the slicer flags
 * a malformed grid (panels that drift in composition / camera /
 * character between frames).
 */

export interface ComposeMotionCollagePromptArgs {
  panelPrompts: readonly string[];
  cols: number;
  rows: number;
  /** Optional doc-level character bible. Prepended ONCE before the
   *  panel list (not per panel) so recurring characters keep
   *  consistent appearance across the grid without inflating each
   *  panel prompt. Same shape as
   *  `ProductionDoc.doodle_explainer_2_character_descriptions`. */
  characterDescriptions?: Record<string, string>;
  /** Optional style suffix appended after the panel list. Mirrors the
   *  `ai_image_suffix` field of the doodle_explainer_2 style. The
   *  caller (auto-pipeline) reads this off the resolved style and
   *  passes it through. */
  styleSuffix?: string;
  /** When true, append a stronger directive re-stating the same-scene
   *  constraint. The auto-pipeline flips this on the retry attempt
   *  after the slicer's malformed check fires. */
  reinforced?: boolean;
}

export function composeMotionCollagePrompt(args: ComposeMotionCollagePromptArgs): string {
  const { panelPrompts, cols, rows, characterDescriptions, styleSuffix, reinforced } = args;
  const N = cols * rows;
  if (panelPrompts.length !== N) {
    throw new Error(
      `composeMotionCollagePrompt: expected ${N} panels for ${cols}×${rows}, got ${panelPrompts.length}`,
    );
  }

  // Header — names the grid, fixes the same-scene constraint upfront.
  const header =
    `A ${cols}×${rows} grid storyboard of ${N} consecutive keyframes from one continuous motion arc, `
    + `separated by a thin neutral grey border (10px) between every panel. `
    + `The composition, character, camera angle, background, lighting, and props are IDENTICAL across every panel `
    + `— ONLY the moving element advances frame-by-frame as listed below.`;

  // Optional character bible — prepended ONCE so each panel benefits
  // without inflating per-panel prompt length.
  const bibleBlock = buildCharacterBibleBlock(characterDescriptions);

  // Panel listing. Labels indicate position so the model knows which
  // cell receives which prompt; "Panel 1 (top-left)" + "Panel N
  // (bottom-right)" anchor the corners.
  const lines: string[] = [];
  for (let i = 0; i < N; i++) {
    const label = `Panel ${i + 1}${cornerLabel(i, cols, rows)}`;
    lines.push(`${label}: ${panelPrompts[i]}`);
  }
  const panelList = lines.join('\n');

  // Style suffix — same string the per-shot generation appends today,
  // applied once at the end so the model treats it as global vocabulary
  // rather than per-cell padding.
  const suffixBlock = styleSuffix ? `\n\nSTYLE: ${styleSuffix}` : '';

  const base = [header, bibleBlock, panelList].filter(Boolean).join('\n\n') + suffixBlock;
  if (!reinforced) return base;

  return (
    base
    + '\n\nIMPORTANT: Every panel must show the SAME scene, the SAME character identity, the SAME camera angle, '
    + 'and the SAME background. Do NOT redraw the scene from a different angle, do NOT change the character\'s '
    + 'clothing or face, do NOT introduce new background elements. ONLY the moving element advances panel by panel.'
  );
}

/**
 * Per-panel prompt composer — used when generateMotionCollage calls
 * Atlas i2i ONCE PER PANEL (plan §D, the quality fix) instead of one
 * call producing an N×M grid. Each panel call gets the full Atlas
 * resolution + refs budget, matching single-shot output quality.
 *
 * The trick is keeping subject continuity between sibling panels — each
 * call is independent, so the prompt has to be self-contained but ALSO
 * communicate that this is one frame of a motion sequence. Three layers:
 *   1. CHARACTER bible — recurring character appearance rules
 *   2. SCENE context — "frame N of TOTAL in a continuous motion sequence;
 *      same composition / camera / background as every other frame"
 *   3. THIS FRAME — the LLM-emitted panel prompt (which the LLM ALSO
 *      seeds with "same scene, only X advances" language)
 * Plus a STYLE suffix appended at the end.
 *
 * Independent calls + refs + "same scene" prompt language are enough to
 * keep the panels visually consistent (verified by the single-shot
 * outputs that look beautiful with the same exact infrastructure).
 */
export interface ComposePerPanelPromptArgs {
  panelPrompt: string;
  panelIndex: number; // 0-based
  totalPanels: number;
  /** Optional doc-level character bible. Prepended for every panel. */
  characterDescriptions?: Record<string, string>;
  /** Optional style suffix — the doodle_explainer_2 ai_image_suffix. */
  styleSuffix?: string;
}

export function composePerPanelPrompt(args: ComposePerPanelPromptArgs): string {
  const { panelPrompt, panelIndex, totalPanels, characterDescriptions, styleSuffix } = args;
  const bibleBlock = buildCharacterBibleBlock(characterDescriptions);
  // Scene context is intentionally TIGHT. The previous version's
  // "continuous motion sequence" framing primed Atlas to render
  // visually dense, illustrative output instead of the sparse doodle
  // aesthetic the refs anchor. Now the context just says "same scene
  // as the other frames" — the WORK of matching the refs' sparseness
  // is done by the density directive at the end.
  const sceneContext = totalPanels > 1
    ? `Frame ${panelIndex + 1} of ${totalPanels} — same scene as every other frame in this sequence, only the moving element advances.`
    : '';
  const frameBlock = panelPrompt;
  // Sparseness directive — CRITICAL counter-weight to the LLM's
  // tendency to write verbose, detail-rich panel prompts. Atlas faithfully
  // renders every described element, so a 200-char panel prompt with
  // "Wide Stockholm harbor view with the Vasa upright on calm water,
  // sails full, docks and shoreline in the distance, dramatic sky..."
  // produces a fully filled-frame illustration — visually beautiful but
  // OFF the doodle aesthetic that lives on plain white backgrounds with
  // generous empty space. The directive below tells Atlas to match the
  // sparseness of the STYLE REFERENCE IMAGES (the 4 doodle anchors)
  // regardless of how verbose the panel description was.
  const sparsenessDirective =
    'CRITICAL DENSITY RULE — Render this as a SPARSE hand-drawn doodle that matches the style reference images\' density exactly: '
    + 'large areas of PLAIN WHITE BACKGROUND, minimal scene clutter, simple silhouettes, generous empty space around every figure. '
    + 'DO NOT fill the frame edge-to-edge with detail. '
    + 'DO NOT add busy crowds, intricate ornamental carvings, dense rigging webs, heavy cross-hatching, or photorealistic shading. '
    + 'When the panel description mentions background elements (docks, shoreline, buildings, clouds), sketch them MINIMALLY — '
    + 'a few thin black lines suggesting presence, NOT a fully rendered scene. '
    + 'The style reference images are the ground truth for "how much detail to draw" — match their sparseness, not the panel description\'s wordiness.';
  const suffixBlock = styleSuffix ? `\n\nSTYLE: ${styleSuffix}` : '';
  return [bibleBlock, sceneContext, frameBlock, sparsenessDirective].filter(Boolean).join('\n\n') + suffixBlock;
}

/** Short corner annotation for the four corner panels of a grid; empty
 *  string for interior panels. Helps the model orient the layout
 *  beyond the bare cell number. */
function cornerLabel(i: number, cols: number, rows: number): string {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const isTop = row === 0;
  const isBottom = row === rows - 1;
  const isLeft = col === 0;
  const isRight = col === cols - 1;
  if (isTop && isLeft) return ' (top-left)';
  if (isTop && isRight) return ' (top-right)';
  if (isBottom && isLeft) return ' (bottom-left)';
  if (isBottom && isRight) return ' (bottom-right)';
  return '';
}

/** Build a compact character-bible block from the doc-level map.
 *  Returns an empty string when no entries are supplied — the caller
 *  filters empty sections so the prompt stays tight. */
function buildCharacterBibleBlock(descriptions: Record<string, string> | undefined): string {
  if (!descriptions) return '';
  const entries = Object.entries(descriptions).filter(([slug, desc]) => slug.trim() && desc.trim());
  if (entries.length === 0) return '';
  const body = entries.map(([slug, desc]) => `  - ${slug}: ${desc.trim()}`).join('\n');
  return `CHARACTER REFERENCE (apply consistently across every panel):\n${body}`;
}
