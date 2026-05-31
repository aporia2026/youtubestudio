/**
 * Scene-to-scene fade resolution — pure helper.
 *
 * Centralises the "should this shot fade in?" decision so the
 * SceneRouter and the ThumbnailZoom routing path agree on the same
 * priority order:
 *
 *   1. `shot.shotKind === 'hard_cut'` (paint_explainer_v1) — forces
 *      `false` regardless of every other input. The genre default is
 *      snap entry. Mounted at the top because this is the load-
 *      bearing PR-3 behaviour: the LLM emits `shot_kind: 'hard_cut'`
 *      on topic transitions and the renderer respects it verbatim.
 *
 *   2. `shot.sceneFade` (per-row override from the editor's
 *      `transition_in: 'cross-fade'` or the doc-row's `scene_fade`).
 *
 *   3. `doc.scene_fade_enabled` (doc-level toggle in the editor).
 *
 *   4. Historical default: `true` (legacy projects fade by default).
 *
 * Pure: no React, no Remotion, no IO. Safe to call from server
 * (`productionDocToVideoConfig`) and renderer (`SceneRouter`).
 *
 * Plan: §15 PR 3 of
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */

export interface ResolveSceneFadeArgs {
  /** Per-row override. Comes from `shot.sceneFade` which was already
   *  resolved from either `row.scene_fade` or
   *  `row.transition_in === 'cross-fade'` upstream in
   *  `productionDocToVideoConfig`. Undefined means "no per-row override
   *  — fall through to doc default." */
  shotSceneFade?: boolean;
  /** Renderer shotKind. When `'hard_cut'`, the resolver returns
   *  `false` regardless of any other input. Other values are ignored
   *  by this resolver (they don't influence fade behaviour) —
   *  `'motion_collage'` rows STILL respect their own per-row
   *  `scene_fade` / doc default for the outer transition into the
   *  shot; the hard cuts BETWEEN panels are a separate concern handled
   *  inside `<MotionCollageScene>`. */
  shotKind?: 'static' | 'motion' | 'hard_cut' | 'motion_collage';
  /** Doc-level default from `ProductionDoc.scene_fade_enabled` /
   *  `VideoConfig.sceneFadeEnabled`. Undefined ⇒ historical default. */
  docSceneFadeEnabled?: boolean;
}

/**
 * Resolve whether the scene-to-scene cross-fade should fire for a
 * given shot.
 *
 * Mirrors the priority order documented in the file header above.
 * The function never throws; every input is treated as a value or
 * fallback, never an error condition.
 */
export function resolveSceneFade(args: ResolveSceneFadeArgs): boolean {
  // 1. paint_explainer_v1 hard cut wins everything. Architecture plan
  //    §15 PR 3: the genre default is snap entry, no transition.
  if (args.shotKind === 'hard_cut') return false;
  // 2. Per-row override.
  if (typeof args.shotSceneFade === 'boolean') return args.shotSceneFade;
  // 3. Doc-level default.
  if (typeof args.docSceneFadeEnabled === 'boolean') return args.docSceneFadeEnabled;
  // 4. Historical default — legacy projects fade by default.
  return true;
}
