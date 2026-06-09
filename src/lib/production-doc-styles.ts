/**
 * Production-doc visual styles — both built-in and user-saved.
 *
 * A "style" used to be a single suffix string (cinematic, animation_2d, …)
 * appended verbatim to every AI image prompt. That's still here, but a
 * style now also carries:
 *
 *   - mixing_rules        — free-form instructions injected into the
 *                           system prompt that tell the model when to
 *                           mix AI-generated visuals with real stock
 *                           assets (logos, screenshots, photos)
 *   - allow_overlay_stock — when true, the model is allowed to populate
 *                           the per-row `overlay_stock_terms` field so
 *                           the editor composites a real asset on top
 *                           of the AI doodle in post
 *
 * Built-ins live in this file as constants. User-saved styles live in
 * the `production_doc_styles` table and are workspace-scoped. Callers
 * that want both should hit `listAllStyles(workspaceId)`.
 *
 * The legacy preset ids (cinematic, animation_2d, etc.) keep their
 * stable string ids so any old saved data — history entries, schedule
 * patches, persisted form state — keeps resolving correctly.
 */
import { sql } from '@vercel/postgres';

/** A fully-resolved style payload — what the prompt builder consumes. */
export interface ResolvedStyle {
  /** Stable id. Built-ins keep their legacy slug; saved styles use the row UUID. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Optional one-liner shown under the label. */
  description?: string;
  /** Suffix appended verbatim to every AI image prompt. */
  ai_image_suffix: string;
  /** Free-form rules injected into the system prompt. Optional. */
  mixing_rules?: string;
  /** True if rows may populate `overlay_stock_terms` for editor composites. */
  allow_overlay_stock: boolean;
  /** "built-in" for hardcoded entries, "saved" for DB rows. */
  origin: 'built-in' | 'saved';
  // --- v2 fields (migration 0080) — undefined for built-ins ---
  /** Plain-English style descriptor written by the user in the editor.
   *  Distinct from `ai_image_suffix` so legacy prompt-builder paths keep
   *  working unchanged for built-ins. */
  style_prompt?: string;
  /** Per-style preferred cloud model id (`flux2-pro-i2i` etc). Dispatcher
   *  reads this; falls back to workspace default when undefined. */
  preferred_cloud_model?: string;
  /** Bumps on every mutating edit. Pinned onto test renders and (future)
   *  generated images so the system can tell which version of the style
   *  produced which output. */
  version?: number;
  /** Soft signal — last time the user clicked "this is good" in the
   *  editor. NOT a save-gate; the council rejected gate-on-approval as
   *  theatre. */
  approved_at?: string;
  /** Owner-private visibility marker. NULL/undefined ⇒ workspace-wide
   *  (legacy and shared styles); set ⇒ private to that collaborator. */
  owner_id?: string;
  // --- v3 (2026-05-22): native ref support on built-ins ---
  /** Static reference images bundled with a built-in style. Public
   *  URLs under `/style-refs/<style-id>/<filename>` — files live in
   *  the repo at `public/style-refs/...`. No DB rows, no R2 uploads,
   *  no seeder ceremony. When set on a built-in, the i2i dispatcher
   *  uses these refs the same way it uses DB-backed saved-style
   *  refs. Saved styles never set this (their refs live in the
   *  `style_reference_images` table); it's the marker for "this
   *  style ships with refs out of the box". */
  built_in_refs?: readonly { filename: string; mime_type: string }[];
  /** Per-style preferred default for `ProductionDoc.on_screen_text_mode_default`.
   *  When set, the production-doc generation route writes this onto the
   *  doc so every row inherits the right OST treatment from the start
   *  without the user (or LLM) needing to flip 130 toggles. Styles whose
   *  on-screen text renders as a real visual treatment (yellow bubble
   *  callouts in `doodle_explainer_2`, etc.) set this to `'overlay'`;
   *  styles that have no special OST treatment leave it undefined and
   *  fall through to the legacy `'bake'` default. */
  default_on_screen_text_mode?: 'overlay' | 'bake' | 'none';
  /** For SAVED styles only: the built-in id this style was derived from
   *  (e.g. a saved style "Yoav's wifi doodle" derived from
   *  `doodle_explainer_2`). Threaded through so downstream callers can
   *  resolve a saved-style UUID to its built-in parent for variant /
   *  feature-gating decisions — e.g. SceneRouter's yellow lower-third
   *  routing and the production-doc auto-flip of `on_screen_text_mode_default`.
   *  Built-ins leave this undefined. PR 1 of
   *  `_plans/2026-06-02-editor-ost-styling-and-positioning.md`. */
  based_on_built_in?: string;
}

/** Shape of a row in the `production_doc_styles` table. */
export interface SavedStyleRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  ai_image_suffix: string;
  mixing_rules: string | null;
  allow_overlay_stock: boolean;
  based_on_built_in: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // --- v2 columns (migration 0080) ---
  owner_id: string | null;
  draft: boolean;
  approved_at: string | null;
  version: number;
  style_prompt: string | null;
  preferred_cloud_model: string | null;
}

/**
 * Built-in style registry. Order here is the order shown in the picker.
 * Adding a new built-in:
 *   1. Append to BUILT_IN_STYLES
 *   2. Use a stable, namespaced id (e.g. 'doodle_explainer'). Don't
 *      reuse legacy ids like 'animation_2d'.
 *   3. If it bundles mixing_rules, set allow_overlay_stock: true so
 *      the prompt actually emits the overlay column.
 */
export const BUILT_IN_STYLES: readonly ResolvedStyle[] = Object.freeze([
  {
    id: 'cinematic',
    label: 'Cinematic',
    ai_image_suffix:
      'cinematic live-action photography, dramatic lighting, anamorphic lens, movie-grade color grading, film grain, 8K quality',
    allow_overlay_stock: false,
    origin: 'built-in',
  },
  {
    id: 'animation_2d',
    label: '2D Animation',
    ai_image_suffix:
      '2D flat vector animation style, vibrant saturated colors, clean crisp outlines, motion-graphics aesthetic, NOT photorealistic, NOT a photograph',
    allow_overlay_stock: false,
    origin: 'built-in',
  },
  {
    id: 'animation_3d',
    label: '3D Animation',
    ai_image_suffix:
      '3D CGI render, Blender/Cinema4D quality, studio lighting, smooth shading, high-poly models, NOT photorealistic photography',
    allow_overlay_stock: false,
    origin: 'built-in',
  },
  {
    id: 'documentary',
    label: 'Documentary',
    ai_image_suffix:
      'documentary photography, handheld camera feel, natural available light, authentic candid moment, journalistic realism',
    allow_overlay_stock: false,
    origin: 'built-in',
  },
  {
    id: 'stock',
    label: 'Stock Photo',
    ai_image_suffix:
      'professional stock photo, clean commercial photography, bright natural lighting, sharp focus, Getty/Shutterstock quality',
    allow_overlay_stock: false,
    origin: 'built-in',
  },
  {
    id: 'tech',
    label: 'Tech / SaaS',
    ai_image_suffix:
      'dark UI background, neon glow accents, cyberpunk aesthetic, blue and purple lighting, holographic data visualization, 8K ultra-detailed',
    allow_overlay_stock: false,
    origin: 'built-in',
  },
  {
    id: 'viral',
    label: 'Viral / Trendy',
    ai_image_suffix:
      'bold high-contrast social media aesthetic, saturated colors, dramatic lighting, Gen-Z energy, YouTube thumbnail quality',
    allow_overlay_stock: false,
    origin: 'built-in',
  },
  {
    id: 'whiteboard',
    label: 'Whiteboard',
    ai_image_suffix:
      'whiteboard animation style, hand-drawn black marker sketch on white background, educational explainer, minimal and clean, NOT photorealistic',
    allow_overlay_stock: false,
    origin: 'built-in',
  },
  /**
   * Doodle Explainer — the style the user dialed in for the dark-web video.
   * Stick figure scenes with thick black outlines and saturated accents,
   * plus the ability to drop a real logo / screenshot / photo on top of
   * the doodle when the script names a specific real-world subject.
   */
  {
    id: 'doodle_explainer',
    label: 'Doodle Explainer',
    description: 'Hand-drawn stick-figure scenes with real logos / screenshots overlaid where useful',
    ai_image_suffix:
      'minimalist hand-drawn stick figure doodle, thick uneven black outlines, simple circular heads, plain white background, flat shadowless lighting, vibrant saturated accent colors, 2D flat vector animation style, clean crisp outlines, motion-graphics aesthetic, NOT photorealistic, NOT a photograph',
    // v3 (2026-05-22): bundled refs. Files live at
    // public/style-refs/Doodle-explainer/<filename>. Position 0 is
    // the strongest anchor — magnifying-glass exemplifies the line
    // weight + colour palette best.
    built_in_refs: [
      { filename: 'stick-figure-magnifying-glass-phone.png', mime_type: 'image/png' },
      { filename: 'stick-figure-hacker-laptop.png',          mime_type: 'image/png' },
      { filename: 'stick-figure-tracked-by-location.png',    mime_type: 'image/png' },
      { filename: 'stick-figure-hacker-deceives-guard.png',  mime_type: 'image/png' },
      { filename: 'stick-figure-soldiers-running.png',       mime_type: 'image/png' },
    ],
    // v3 (2026-05-22): pin the i2i model used for this built-in.
    // Built-ins carry this field so the dispatcher routes the right
    // way without falling back to the workspace default. Saved styles
    // override via PATCH. Updated 2026-05-27: switched to Atlas i2i
    // per user direction "default for everything to be gpt 2 atlas".
    // Atlas i2i caps at 4 refs vs Kie's 14; for v1 doodle (5 refs)
    // we lose 1 ref. Trade-off accepted in exchange for ~73% cost
    // reduction and unified provider with the variant edit path.
    preferred_cloud_model: 'gpt-image-2-atlas-i2i',
    mixing_rules: [
      'This is a hand-drawn doodle style. The default for almost every row is "Animation" with a pure stick-figure ai_image_prompt — keep that as your base.',
      '',
      'BUT — when the script names a recognisable real-world subject, populate `overlay_stock_terms` so the editor can composite a real asset on top of the doodle in post. Use these triggers:',
      '',
      '  • Named company / brand (Apple, Google, YouTube, FBI, Reddit, 4chan, …) → overlay_stock_terms: "<brand> logo official PNG"',
      '  • Named software, app, website, or UI (Tor browser, iPhone settings, Genesis Market, Pegasus spyware) → overlay_stock_terms: "<thing> screenshot" or "<thing> homepage"',
      '  • Named real person who can plausibly be photographed (Ross Ulbricht, a public-figure CEO) → overlay_stock_terms: "<name> photograph"',
      '  • Named physical place / event with a recognisable photo (San Francisco Public Library, undersea cable map) → overlay_stock_terms: "<place> photograph"',
      '',
      'When you populate overlay_stock_terms:',
      '  • visual_type STAYS as "Animation" (or "Statistics" / "Cutaway" if those fit better) — do NOT switch to "Screen Recording" or "B-Roll". The new field is the signal that this is a composite row.',
      '  • The `ai_image_prompt` still describes a complete stand-alone doodle scene. Picture the doodle leaving an empty area where the real asset will land (e.g. "stick figure points at a blank rectangle on the wall" or "doodle laptop with a blank glowing screen") — but DO NOT mention the real logo / screenshot in the AI prompt itself, because the AI image generator will draw a stylised fake of it. The real one is overlaid by the editor.',
      '  • Add a short `notes` line telling the editor what to overlay and where (e.g. "Composite: drop the real Apple logo onto the blank rectangle in the doodle").',
      '',
      'Otherwise (the script is talking about a generic concept, an unnamed character, or an everyday object) — leave overlay_stock_terms empty and keep the row pure doodle.',
      '',
      'Aim for roughly 1 in 4 to 1 in 6 rows being composite. Too many real overlays breaks the cohesive doodle feel; too few wastes the chance to ground the video in real references.',
    ].join('\n'),
    allow_overlay_stock: true,
    origin: 'built-in',
  },
  /**
   * Doodle Explainer 2 — refined variant modelled on a specific set of
   * reference YouTube videos (see `refs/`). Same hand-drawn family as
   * `doodle_explainer` but tighter on three axes:
   *
   *   1. Persistent bold black hand-drawn title at the top of every frame.
   *   2. Muted palette — black-on-white dominant, with pale blue / pale
   *      yellow / light gray accents and only the occasional saturated
   *      colour (red for danger). Not Doodle Explainer's "vibrant" feel.
   *   3. Real-photo overlays render as inset rectangles with a thick
   *      coloured border (orange / red / blue / black) — the framed-photo
   *      treatment seen across all three source videos.
   *
   * Phase 1 of a 3-phase build (plan: `_plans/2026-05-25-doodle-explainer-2-built-in.md`):
   *   - Phase 1 (this entry): style definition + bundled refs.
   *   - Phase 2 (`_plans/2026-05-25-style-aware-overlay-text.md`): yellow
   *     bubble-font rendering of `on_screen_text` when this style is
   *     selected. Until Phase 2 lands, on_screen_text falls back to the
   *     generic Remotion lower-third treatment.
   *   - Phase 3 (`_plans/2026-05-25-near-static-variants.md`): true
   *     near-static animation via grouped rows (one base image + N
   *     micro-edited variants via Atlas Edit). Until Phase 3 lands, the
   *     mixing rules still describe scenes well-suited to that pattern
   *     so the base images carry the right composition.
   */
  {
    id: 'doodle_explainer_2',
    label: 'Doodle Explainer 2',
    description:
      'Tighter doodle aesthetic — bold black title at top, muted palette, framed real-photo overlays, yellow-bubble callouts. Modelled on specific reference videos.',
    ai_image_suffix:
      // Style derived from the Paint Explainer reference video — see
      // hiccup-analysis/paint-ref/ for the frame samples that this prompt
      // was reverse-engineered from. The style is NOT "wordless single-
      // subject minimalist doodle" (an earlier, wrong revision of this
      // suffix). The reference is closer to a low-effort hand-drawn
      // children's storybook page: stick-figure-style characters with
      // light clothing detail, multi-element scenes when the narrative
      // calls for them, varied backgrounds (white default but also blue
      // sky / gray sky / starry space / real photographs as backdrops),
      // and many color accents (orange fire, yellow stars, red exclam,
      // blue clothing, green virus, brown paper, gray clouds).
      //
      // The ONE thing that IS forbidden: textbook-style labeled diagrams
      // with arrows pointing to written labels of scene parts. That's
      // what made the prior Avalanche-Danger output look like an
      // infographic. Speech bubbles and incidental text on props (book
      // titles, scroll squiggles, etc.) are FINE — they're part of the
      // scene, not annotation.
      'Hand-drawn cartoon doodle in the style of the Paint Explainer reference video — thin black ink outlines on a varied background (often white, sometimes a colored sky, sometimes a real photograph as a backdrop, sometimes a simple gradient). Stick-figure-style characters with light clothing detail: lab coats with soft gray or pale-color fill, ties in blue or red, beards / hair in gray, round glasses with thin frames, defined eyebrows and small expressive mouths. Multiple characters and props can share the frame when the narrative needs them — this is storybook composition, not a single-subject minimalist study. ' +
      // The character anatomy rule — preserved from the original because
      // it's the most reliable visual fingerprint of the style. The
      // refs include a few explicit no-hand frames so the model has both
      // text negation + visual examples to lean on.
      'CHARACTER ANATOMY: heads are slightly imperfect circles (often with a soft cream / pale gray interior fill, not pure white), eyes can be small dots OR small rectangles for glasses lenses, eyebrows are short curved strokes (calm, raised in surprise, or downturned in anger), mouths range from a single line to a wide O of surprise to gritted teeth. Body is a thin single-stroke line down to feet. Arms END IN A LINE TIP — no anatomical hand, no fingers, no palm, no fist. The ONLY time a hand is drawn is when the character is gripping a specific visible object (holding a scroll, a quill, a magnifying glass) — then draw the smallest nub of a hand needed to grip it, never anatomical. Lines are wobbly, slightly imperfect, freehand — NOT clean vector, NOT polished. ' +
      // Color guidance — extracted from real frames: oranges and reds
      // for fire/danger; yellows for stars, sun, callout-bubble accents;
      // blues for sky / ties / books; greens for biological / nature;
      // grays for clouds / clothing / hair; pinks/browns for props.
      'COLOR: this style uses MANY accent colors, applied to props, clothing, and atmospheric elements. Common palette: saturated orange/red (fire, danger, exclamation, blood), warm yellow (stars, sun, energy, light), pale yellow (callout bubbles), pale-to-saturated blue (sky backgrounds, clothing, water, technology), soft green (nature, biology, virus, fungi), gray (clouds, smoke, hair, beard, lab coat fill, stone walls), brown / tan (paper, scrolls, ground, wood), pink (accent props like magnifying glass handles). Characters CAN have lightly-colored clothing — a gray lab coat with a blue or red tie, a brown robe, a gray beard. Use color liberally — black-on-white only is too monotonous and not faithful to the reference. ' +
      // Backgrounds — many options. Plain white is the default for
      // character-focused beats; colored backgrounds and real-photo
      // backgrounds are common for atmospheric / location / historical
      // beats.
      'BACKGROUND: vary by content. Default = clean white space for character close-ups and dialogue beats. Use a SOFT BLUE SKY + GREEN OR BROWN GROUND for outdoor scenes. Use DARK BLUE WITH STARS for space / night scenes. Use GRAY CLOUDS for danger / atmosphere. The reference also occasionally uses a real photograph (a map, a portrait, a landscape) as a backdrop with cartoon elements drawn on top — a powerful storytelling device. ' +
      // The hard NO: labeled-diagram style. This is the one thing the
      // image model defaults to (because the built-in refs #05 and #06
      // contain labeled diagrams) and the one thing that makes the
      // output look like a textbook instead of a storybook.
      'FORBIDDEN: textbook-style labeled diagrams — do NOT draw arrows pointing to written labels that name parts of the scene ("Huge Slab of Snow", "Dangerous Slope", "Unsuspecting Campers"). That kind of annotation is a chart, not a story panel. Captions, scene labels, and time stamps are rendered SEPARATELY on top by the player as yellow bubble overlays — the picture itself should not contain those annotations. Speech bubbles for character dialogue ARE allowed (e.g. a character saying "Fascinating" in a cartoon balloon). NOT photorealistic, NOT 3D rendered, NOT anime, NOT manga. ' +
      // 2026-05-29: BAKED TYPOGRAPHY block. Previously taught visually by
      // ref #09 ("Highlight" word). That ref was moved out after the
      // literal word leaked into nearly every output regardless of what
      // on_screen_text was set to. Now the typography teaching lives in
      // the suffix text so the model still gets the style cue without
      // a leaking subject. Wording is deliberately style-descriptive,
      // never naming a specific example word that could be copied.
      'BAKED TYPOGRAPHY: when the row\'s prompt asks for hand-lettered text in the scene (a baked OST string), draw the EXACT characters supplied by the prompt — never substitute, paraphrase, or add filler text the prompt did not request. Render the requested characters in YELLOW COMIC-BOLD: thick saturated-yellow fill, surrounded by a black wobbly hand-drawn outline of consistent thickness, no shadow, no gradient, no other decoration. Glyphs sit on a slight irregular baseline (not perfectly straight) and have the same imperfect freehand quality as the rest of the illustration\'s lines. If the prompt does NOT request baked text, the scene contains NO baked words at all — speech bubbles for character dialogue are allowed; freestanding label words invented by the model are NOT.',
    built_in_refs: [
      // ORDER MATTERS. Atlas i2i caps at 4 refs/call and the dispatcher
      // takes the FIRST 4 entries from this array. Positions 1-4 are the
      // four style pillars — face anatomy, body anatomy + no-hand rule,
      // typography, framed-photo composition — picked as PURE style
      // anchors with minimum subject content (refs teach style, not
      // content; the prompt invents subjects). Positions 5-9 are legacy
      // refs kept on disk for reference but never sent to Atlas; they
      // remain documented here so future curation rounds can see what
      // was previously bundled. See plan
      // _plans/2026-05-28-doodle-2-authenticity-round.md (R1).
      //
      // Curation history:
      // - Refs 01 + 02 moved to _review-not-doodle-2/ 2026-05-28 after
      //   the same book + building + bloody painting trio appeared in
      //   nearly every scene of every video. #01 was a COMPOSITE (book
      //   + framed bloody painting); #02 was a lone blue building. Both
      //   ranked in the top-4 and bled their subjects into every output.
      // - Refs 07, 08, 11 were dropped in commit eb25c18 ("stop WANNACRY
      //   bleed") because they stayed too subject-coded after text
      //   removal (deleted-files X, padlocked TV, globe text overlay).
      // - Refs 04, 09, 13 were regenerated 2026-05-28 via Atlas GPT
      //   Image 2 t2i ($0.036 for all 4 candidates, ref-01 candidate
      //   rejected — see scripts/generate-doodle-2-ref-candidates.ts).
      // - Numbering gap (missing 07, 08, 11) preserved so the fix
      //   script's `--only N` indexing stays aligned with motif comments.
      //
      // The style pillars. Catalog = truth: this list is exactly
      // what Atlas sees. Legacy refs (03, 05, 06, 10, 12) remain on
      // disk at public/style-refs/Doodle-explainer-2/ for future
      // curation rounds but are no longer registered. Position order is
      // locked in case Atlas ever drops below 4 input slots — first
      // slot is the most-loaded.
      //
      // Phase 1.6 (Bug 4): the framed-forest ref (13) was relocated to
      // _review-not-doodle-2/ after Sodder QA b30b8d1e showed it
      // bleeding into unrelated scenes (rows 16, 17, 21) — Atlas
      // treated it as a content reference, stamping the forest into
      // the investigator desk + close-up + final-shot rows. The
      // "realistic photo can integrate into the cartoon" signal is
      // still carried by the mixing_rules prose (PILLAR 1) and the
      // ai_image_suffix's framed-photo language; the visual demo is
      // queued for a follow-up round where we curate a subject-
      // neutral realistic photo replacement (textured paper,
      // abstract brushwork close-up, etc.). Memory rule:
      // feedback_refs_teach_style_only.md.
      { filename: '14-close-up-character-face.jpg',                       mime_type: 'image/jpeg' },
      { filename: '04-stick-figure-neutral-pointing-no-hand.jpg',         mime_type: 'image/jpeg' },
      // Ref #09 (yellow "Highlight" typography) was MOVED to
      // _review-not-doodle-2/ on 2026-05-29 after user reported the
      // literal word "Highlight" bleeding into nearly every generated
      // frame, regardless of what on_screen_text was set to. The
      // negative-instruction language in the per-ref roles ("does NOT
      // mean the word 'Highlight' should appear anywhere") could not
      // overpower the visual evidence — i2i models obey what they SEE
      // in the ref, not what the prompt asks them to ignore. Memory
      // rule: feedback_refs_teach_style_only.md.
      //
      // The yellow-comic-bold typography teaching previously carried
      // by this ref now lives in the ai_image_suffix text (look for
      // "BAKED TYPOGRAPHY" below) so the model still gets the style
      // cue without the leaking subject. A subject-neutral
      // replacement ref (e.g. yellow comic-bold abstract shapes or a
      // yellow speech-balloon outline without readable letters) is the
      // proper long-term fix — slot intentionally left empty in the
      // catalog until a clean ref is curated.
    ],
    // Updated 2026-05-27: switched to Atlas i2i per user direction
    // "default for everything to be gpt 2 atlas, not just for edits".
    // Atlas i2i caps at 4 refs vs Kie's 14 — the catalog above is now
    // exactly 4 refs (trimmed 2026-05-28 from a 9-ref bundle after
    // confirming positions 5-9 were never sent). The earlier plan
    // rejected this trade-off (motif breadth), but the trimmed suffix
    // (commits c5b3538 + 84745ae) now carries the color + framed-photo
    // + realistic-object vocabulary in text, partially compensating
    // for the lost visual anchors. Unifies the provider with the
    // variant edit path (Atlas GPT Image 2 Edit) and cuts base-image
    // cost ~73%.
    preferred_cloud_model: 'gpt-image-2-atlas-i2i',
    mixing_rules: [
      '== CRITICAL: MOTION COLLAGE IS THE #1 PRIORITY ==',
      '',
      '⚠️ READ THIS FIRST. UNDER-EMITTING motion_collage rows is the SINGLE biggest failure mode of this style. Videos that ship with low motion_collage counts look static and lifeless compared to the reference videos. Every script in this niche (real-life mystery, disaster, true crime, history) is FULL of physical motion — and EVERY motion beat is a motion_collage candidate.',
      '',
      'DEFAULT ASSUMPTION: For ANY row whose narration describes a physical action, change of state, motion, or visual transformation — the answer is `shot_kind: "motion_collage"`. Static Animation is the EXCEPTION, not the default.',
      '',
      'HARD MINIMUM: ~40% of all narrative rows MUST be motion_collage. For a 24-row doc, that means 9-11 motion_collage rows minimum. A doc with fewer than 7 motion_collage rows on a typical script is broken — go back and find more. (Bumped from 30% in PR3 of 2026-06-03 plan — videos felt static at the old floor.)',
      '',
      'ASK YOURSELF FOR EACH ROW: "Does the narration describe something CHANGING — a position, a state, a quantity, a visibility?" If yes → motion_collage. If the answer is "no, it\'s purely descriptive (a static fact / a still scene / a label / a definition)" → static Animation. There is no middle ground.',
      '',
      'EXAMPLES of beats that MUST be motion_collage (each emerged as static Animation in past production runs — DO NOT repeat that mistake):',
      '  • "The servers flood the New York Stock Exchange with millions of trades" → motion_collage (flood = motion)',
      '  • "$10 million vanishes from the ledger every minute" → motion_collage (vanishing IS motion)',
      '  • "Engineers scrambling, frantically pulling cables" → motion_collage (scrambling/pulling = motion)',
      '  • "The Orbiter ripped to shreds in the Martian atmosphere" → motion_collage (ripping = motion)',
      '  • "The processor returned 1.33373" → motion_collage (number changing on screen = motion)',
      '  • "Millions of chips cascading down an assembly line" → motion_collage (cascading = motion)',
      '  • "Dropped off a cliff edge, hitting absolute zero" → motion_collage (dropping = motion)',
      '  • "The wallet permanently freezes" → motion_collage (freezing = transformation)',
      '  • "He executes a command" → motion_collage (executing = motion in this context)',
      '  • "The rocket pivots 90 degrees and disintegrates" → motion_collage (pivoting + disintegrating = motion)',
      '  • "Numbers rapidly drain in real-time, flashing red" → motion_collage',
      '  • "A massive fireball ripples outwards" → motion_collage',
      '  • "A satellite blinks out, flatline tone sounds" → motion_collage',
      '  • "The S3 system goes dark" → motion_collage (going dark = transformation)',
      '',
      'SELF-CHECK BEFORE SUBMITTING: Count your motion_collage rows. If the count is below 40% of total narrative rows, go BACK and find motion you missed. The script ALWAYS has more motion than your first pass identified. Re-read every row asking "what changes in this beat?" — if anything changes, it\'s motion_collage.',
      '',
      'ZERO-TOLERANCE for "I left it Animation because I\'m not sure". When in doubt → motion_collage. The cost of over-emitting (~$0.054 per shot) is dwarfed by the cost of a video that looks static.',
      '',
      '== PRODUCTION NOTES — IGNORE [SFX:] AND [VISUAL CUE:] LINES ==',
      '',
      'Scripts often include production notes wrapped in square brackets — `[SFX: Sharp Keyboard Clack]`, `[VISUAL CUE: A trader stares at a terminal]`, `[ON-SCREEN TEXT - KNIGHT CAPITAL]`. These are NOT narration. They are stage directions for the editor.',
      '',
      'HARD RULE: Do NOT emit rows for production-note lines. The narration is the PROSE between the bracket-wrapped notes. Treat `[SFX: ...]` and `[VISUAL CUE: ...]` lines as METADATA: read them as hints about what the editor intended for the surrounding prose, but never make them their own row.',
      '',
      'When `[VISUAL CUE: ...]` describes a specific visual you should produce, USE that information to inform the prompt of the SURROUNDING narration row — not as its own row. Example: if the script has `[VISUAL CUE: Massive ledger graphic with red numbers draining]` followed by "$10 million vanishes every minute", create ONE motion_collage row for the "$10 million vanishes" beat with the visual cue baked into the panel descriptions.',
      '',
      '== STYLE REFERENCE: PAINT EXPLAINER ==',
      '',
      'Frame samples from the reference video live in hiccup-analysis/paint-ref/. Every rule below is reverse-engineered from those frames — not theoretical. visual_type defaults to "Animation".',
      '',
      '== SHOT TYPE — ALWAYS ANIMATION FOR NARRATIVE BEATS ==',
      '',
      'Every row that narrates the story is `visual_type: "Animation"`. The doodle aesthetic is what makes this style consistent — it must apply to every beat the viewer sees.',
      '',
      'Do NOT use `"Statistics"`, `"Title Card"`, `"Talking Head"`, or `"Screen Recording"` for mid-script narrative rows. Those types emit an empty `ai_image_prompt` by design, the image-gen pipeline cannot generate a doodle for them, and the editor surfaces only a stock-search affordance — none of which the viewer wants when the narration is moving the story forward.',
      '',
      'Use the typed exceptions ONLY in these specific cases:',
      '  • `"Title Card"` — only for explicit `<<TITLE_N>>` sentinel rows. The opening title slot and any explicit chapter heading in the script. NEVER for a short factual narration row that "feels like a title" (e.g. "No bones. No teeth. No clothing." is NOT a Title Card — it\'s a stark Animation beat).',
      '  • `"Talking Head"` — only when the script explicitly cues a narrator-on-camera shot (rare).',
      '  • `"Screen Recording"` — only when the script explicitly references a screen capture (e.g. tech tutorials; rare in narrative-story content).',
      '  • `"Statistics"` — DO NOT USE in this style. Numbers that pop on screen go in `on_screen_text` on an Animation row instead. Render the number as part of the doodle scene.',
      '',
      'Default for every other row: Animation, with a hand-drawn doodle scene in `ai_image_prompt`. If you are unsure, the answer is Animation.',
      '',
      '== VARIANT GROUPS — REQUIRED, NOT OPTIONAL (READ THIS FIRST) ==',
      '',
      'This is the SINGLE MOST IMPORTANT instruction in this style. The reference videos are essentially STACKED VARIANT GROUPS from start to finish — every ~3-5 seconds is a fresh base composition with 1-3 additive variants layered on top. The video stays visually alive because the picture EVOLVES while the camera holds still.',
      '',
      'THE ADDITIVE FRAME-BY-FRAME PATTERN — this is the canonical execution. Take a base composition, then for each subsequent narration beat, ADD ONE small thing to the same picture. Do not redraw the scene. Do not move the camera. The composition is locked; the small additions accumulate.',
      '',
      'Worked example — Stone Age Brain Surgery (a 12-second segment of the reference video, three back-to-back variant groups):',
      '',
      '  Group 1 — "Two cavemen on a stone plain":',
      '    base    → 2 stick-figure cavemen standing on a stone plain with mountains behind, neutral expressions',
      '    + add 1 → SAME scene, left caveman now has BLOOD dripping from the side of his head + his hand raised to it (he\'s hurt)',
      '    + add 2 → SAME scene, right caveman now has open mouth + both arms raised wide + a "?" floating above his head (he\'s confused)',
      '',
      '  Group 2 — "Stone flint tools" (new composition starts):',
      '    base    → two gray stone arrowhead/flint shapes lying on plain white background, no character',
      '    + add 1 → SAME flints, ADD a stone knife with brown-wrapped handle next to them',
      '',
      '  Group 3 — "Close-up of patient" (new composition starts):',
      '    base    → close-up of a single bald-ish character with worried eyes, fur shoulder wrap, plain white background',
      '    + add 1 → SAME close-up, ADD a stitched wound across the forehead with red bruise tint',
      '    + add 2 → SAME close-up (with wound), ADD red "Impossible" text appearing to the right of the head',
      '',
      'Three groups, 8 total rows of video, in 12 seconds. That is the maximum density observed in the reference video. The TARGET density for our docs is lower — see below.',
      '',
      'TARGET RATIO — ~50% of rows MUST belong to variant groups, ~50% are fresh compositions. THIS IS A FLOOR YOU SHOULD AIM ABOVE, NOT A CEILING TO STAY UNDER. Undershoot is the common failure mode: LLMs default to "every beat gets its own fresh scene" because each beat reads as logically distinct. That habit produces a slideshow of unrelated pictures and breaks the evolving-picture feel that defines this style. The viewer should feel scenes BREATHE — a held composition unfolding across 2-4 narration beats — not snap to a new picture every line. (Bumped from 40% in PR3 of 2026-06-03 plan.)',
      '',
      '  • A variant group is 2-4 contiguous rows sharing the same composition with ONE additive delta per row.',
      '  • A fresh composition is a single row that introduces a new camera, new location, new character, or new subject focus.',
      '  • For a typical 60-100 row doc, expect ~15-22 variant groups covering ~38-55 of the rows; the remaining ~22-45 rows are fresh.',
      '  • For shorter docs (15-25 rows), expect 4-6 variant groups covering ~9-13 rows.',
      '  • For longer docs (100+ rows), scale proportionally — aim for ~50% rows-in-groups.',
      '',
      'SCAN FIRST, THEN WRITE — Before drafting any rows, READ THE SCRIPT TWICE. On the second pass, find every sequence of 2-4 consecutive narration beats that COULD share a held composition. Mark them. THEN write the rows: each marked sequence becomes a variant group (same composition, additive deltas), and the remaining beats become fresh rows. This pre-pass is what gets the ratio above 50%. Skipping it is what keeps it below 40%.',
      '',
      'COST + QUALITY: variant groups are CHEAPER per row than independent rows (~$0.011 vs ~$0.04 via Atlas Edit) AND they produce more visually coherent output (the renderer reuses one base image with deltas instead of regenerating with different seeds). So when in doubt between grouping and not, GROUP. Erring slightly above 50% is fine. Erring well above 70% makes the video feel mechanical; erring below 30% loses the evolving-picture feel that defines the style.',
      '',
      'Don\'t force variants where they DON\'T belong (e.g. a brand-new location, a totally different character, a hard topic cut). But don\'t avoid them when 2-3 consecutive narration beats naturally share a held subject. The TRIGGER criteria below are intentionally broad — if a sequence of beats meets ANY of them, group it.',
      '',
      '== COUNT-PRECISE VARIANTS — STATE THE TARGET, NOT THE DELTA ==',
      '',
      'When a variant changes the NUMBER of people / figures / characters in the scene, write the `variant_edit_prompt` in PRESERVATION form (state the target count), NOT in SUBTRACTION form (state how many to remove). Atlas Edit\'s count compliance under subtraction-style instructions is variable — past QA showed the model thinning crowds more aggressively than asked ("base shows 7 figures, variant shows 5" when only 1 was supposed to leave).',
      '',
      'WRONG (subtraction form — Atlas may thin the crowd unpredictably):',
      '  variant_edit_prompt: "remove the extra two children so only George, Jennie, and four are left"',
      '  variant_edit_prompt: "fewer figures in the scene"',
      '  variant_edit_prompt: "minus two kids"',
      '',
      'RIGHT (preservation form — Atlas can reason about a target state directly):',
      '  variant_edit_prompt: "Show exactly George + Jennie + 4 children visible (6 figures total). No other figures."',
      '  variant_edit_prompt: "Keep exactly 3 stick-figure soldiers in the foreground. Do not add or remove any."',
      '  variant_edit_prompt: "5 figures total — the original family minus the eldest son. Same poses; do not add bystanders."',
      '',
      'Rules:',
      '- When the count CHANGES from base to variant, state the EXACT new count as a number ("6 figures total", "exactly 3 children").',
      '- When the count DOES NOT CHANGE but the variant otherwise modifies the scene, you do NOT need to mention count — the server-side preservation hint already protects it for doodle_explainer_2 variants.',
      '- Name the SPECIFIC figures that remain, not just the count. "6 figures total" is OK; "George + Jennie + 4 children, 6 total" is BETTER. The named identities help Atlas pick which to keep.',
      '- For variants that ADD a figure, write "Add Maurice running out behind them. 7 figures total now." — both the addition and the new total.',
      '',
      'WORKED EXAMPLE — Sodder Children "five missing" beat:',
      '  Base ("George, Jennie, and four children escaped"): scene shows 6 figures.',
      '  Variant ("But five of the children never came out"): we want to imply the 5 missing children, but only George + Jennie + 4 escaping children are VISIBLE at the doorway.',
      '    WRONG: "remove the extra figures" — Atlas may remove the parents too.',
      '    RIGHT: "Show exactly George + Jennie + 4 children at the doorway (6 figures total). Add wisps of smoke rising behind them to imply the missing children inside."',
      '',
      'SECOND WORKED EXAMPLE — Real-life mystery script (Mary Celeste discovery, a six-beat sequence yielding three variant groups + one fresh row):',
      '',
      '  Beat 1 narration: "Sailors aboard the Dei Gratia spotted something strange in the Atlantic."',
      '  Beat 2 narration: "A two-masted brigantine drifting under partial sail, with no one at the helm."',
      '  Beat 3 narration: "When the Dei Gratia crew climbed aboard, they found an empty deck."',
      '  Beat 4 narration: "No people. No signs of struggle. No blood."',
      '  Beat 5 narration: "The cargo was untouched. The captain\'s log had been updated nine days earlier."',
      '  Beat 6 narration: "A breakfast was still set on the galley table."',
      '',
      '  GROUP 1 (beats 1-2, "ship from a distance"):',
      '    base    → wide view of an empty brigantine drifting on a gray Atlantic, viewed from the Dei Gratia\'s rail, two stick-figure sailors at the foreground pointing toward it',
      '    + var 1 → SAME scene, ADD a thought-bubble "?" above one sailor\'s head and a slight tilt of the foreground figures\' heads (registering that nothing is wrong but no one is on board)',
      '',
      '  GROUP 2 (beats 3-4, "boarding the empty deck"):',
      '    base    → two Dei Gratia sailors stepping onto the Mary Celeste\'s deck, the deck behind them stretching empty into the distance, ropes coiled, no people',
      '    + var 1 → SAME scene, ADD wide-open mouths on both sailors (surprise) and small motion lines above their heads as they freeze',
      '    + var 2 → SAME scene (with the surprise), ADD a small red "no blood" or "no struggle" marker as a label callout in the upper right',
      '',
      '  GROUP 3 (beats 5-6, "the captain\'s cabin and galley"):',
      '    base    → interior of the captain\'s cabin with an open logbook on a wooden table, a quill beside it, the cabin lit by a single porthole',
      '    + var 1 → SAME cabin, ADD a small dated entry visible on the logbook page',
      '    + var 2 → SAME cabin angle but the camera is now in the galley adjacent — wait, NO: this would change the location, so this is a BAD variant. Instead make beat 6 a fresh row, not a variant.',
      '',
      '  ROW for beat 6 (FRESH, not variant): galley table with a half-eaten breakfast — a plate, a cup, an uneaten biscuit — no people in the room.',
      '',
      '  Result: 6 beats → 3 groups + 1 fresh row = 7 rows total, 5 rows in groups, ratio = 5/7 = 0.71. Above the floor, well within the target band for this kind of held-investigation sequence. This is the cadence we want for real-life mystery / true-crime / disaster / discovery scripts.',
      '',
      'NOTICE: the example deliberately includes a REJECTED variant (group 3 var 2 would have changed location) to model the discipline — when an additive delta would break the "same composition" rule, split it off as a fresh row instead of forcing the variant.',
      '',
      'Valid additive deltas (any of these is one variant):',
      '  • Add a small prop to the scene ("add a red question mark above the figure\'s head", "add a stone knife next to the flints", "add a small green virus splat next to the character")',
      '  • Modify a character\'s expression / pose ("open the mouth into a wide O of surprise", "raise both arms in confusion", "drop the eyebrows downward in a frown")',
      '  • Add a wound / injury / mark on a body or object ("add blood dripping from the side of the head", "add a stitched scar across the forehead", "draw a red X over the magnifying glass")',
      '  • Add a colored emphasis word to the scene ("add red text reading \'Impossible\' to the right of the character\'s head" or — preferred — leave the image alone and put \'Impossible\' in this row\'s on_screen_text instead, since the player will overlay it cleanly)',
      '  • Add motion lines or atmospheric elements ("add small snowflakes falling across the upper half of the frame", "add a few wind swirls behind the figure")',
      '  • Highlight a region with a small visual marker ("add a glowing yellow halo around the sun", "add a thin red circle around the third item on the desk")',
      '',
      'Bad deltas — DO NOT do these:',
      '  • Redraw the whole scene from a different angle',
      '  • Change the character\'s clothing or identity between variants',
      '  • Add a new background, new ground, new sky — backgrounds stay locked across the group',
      '  • Move the camera, zoom in, change framing',
      '  • Add multiple new elements at once — variants are ONE thing at a time',
      '',
      'TRIGGER — broad, content-agnostic. Use a variant group whenever 2-4 CONSECUTIVE rows in the script share ANY of:',
      '  • Same place (a tent, a lab, a room, a sky, a mountain slope, a screen)',
      '  • Same character or group (one figure, three bystanders, a scientist at a desk)',
      '  • Same object as the focus (a magnifying glass, a book, a planet, a piece of paper, a phone)',
      '  • An evolving environmental moment (snow getting heavier, sky getting darker, sun activity increasing)',
      '  • A character\'s evolving state (calm → noticing → reacting; reading → finding something → alarmed)',
      '  • A "before-during-after" sequence of one event (object intact → object cracks → object shattered)',
      '',
      'This is NOT just for character reactions. EXPOSITION scenes use variants too — describing one location across 2-4 consecutive narration beats, with a small visual change between each frame, is the most common pattern in the reference. Examples for an avalanche / mountain script:',
      '',
      '  • Base: stick figure standing on a snowy slope looking up at the mountain.',
      '  • Variant 1: same scene, add a single small snowflake near their head.',
      '  • Variant 2: same scene, add more snowflakes falling across the upper half of the frame, sky slightly grayer.',
      '  • Variant 3: same scene, mountain peak now releases a gray slab of snow at the top, character still standing.',
      '',
      'Each variant has its own narration beat ("they set up camp", "the wind picked up", "then the snow started falling harder", "and that\'s when the slope above gave way"). The PICTURE evolves; the camera doesn\'t move. That\'s the Paint Explainer feel.',
      '',
      'How to emit — quick reference (full schema later in this doc):',
      '  • Same `group_id` on every row in the group.',
      '  • `variant_index: 0` on the BASE row, populate `ai_image_prompt` normally.',
      '  • `variant_index: 1, 2, 3` on derived rows. LEAVE `ai_image_prompt` EMPTY on derived rows. Populate `variant_edit_prompt` with the SMALLEST delta from the base ("add a small red question mark above the figure\'s head, keep everything else identical").',
      '  • Cap: 4 rows per group (1 base + 3 variants).',
      '  • Variant rows must be CONTIGUOUS in the row list — no other rows interleaved.',
      '',
      'SELF-CHECK BEFORE SUBMITTING — Count your rows. Count rows with a non-empty `group_id`. Divide. If the ratio is below 0.35, you almost certainly missed variant opportunities. Go back and find at least 1-2 more held-scene sequences and group them. The fix is fast: pick two consecutive rows whose narration shares a place, subject, or evolving state, give them the same `group_id`, set the first to `variant_index: 0` and the second to `variant_index: 1`, move the second\'s `ai_image_prompt` into a short `variant_edit_prompt` ("ADD …, keep everything else identical"). Repeat until the ratio is ≥0.35. Do not submit a doc below 0.30 unless the script genuinely has zero held-scene sequences (rare — most real-life-story scripts have several).',
      '',
      '== CORE PRINCIPLE: SIMPLE, COLORFUL, FLEXIBLE, BALANCED ==',
      '',
      'The reference style is SIMPLE drawings (not detailed illustration), COLORFUL (multi-color per frame), and FLEXIBLE (composition adapts to the beat). Be open-minded — sometimes one character, sometimes a group; sometimes white background, sometimes a colored sky or a real photo backdrop; sometimes a close-up portrait, sometimes a wide landscape. There is NO single template. The constant is: hand-drawn-feeling lines, soft color fills, generous breathing room, the beat\'s ONE focal idea clear.',
      '',
      'REFS TEACH STYLE, YOU INVENT SUBJECTS. The 4 reference images bundled with this style teach the model what doodle_explainer_2 LOOKS LIKE — line weight, character anatomy, framing, typography, and the framed-real-photo composition. They are NOT a menu of subjects to put in scenes. INVENT fresh subjects per beat from the script. If two consecutive shots feel like the same picture, the second one is wrong — change the camera, change the subject, change the composition. Every shot answers "what is this beat about?" with a different visual answer than the shot before it. The viewer should never feel like they\'re watching the same picture restated.',
      '',
      'EXPLICIT PER-REF ROLES — read this carefully, the refs have been a source of bleed in past versions of this style:',
      '  • Ref #14 (close-up character face) teaches the FACE ANATOMY (slightly imperfect circle head, small dot eyes, raised eyebrows, small expressive mouth) and the close-up framing. It does NOT mean every scene shows a head-and-shoulders close-up. The actual character + expression + framing for each scene is decided by the script.',
      '  • Ref #04 (stick figure neutral pointing, no hand) teaches the BODY ANATOMY + the no-hand rule (arms end in line tips, never anatomical hands). It does NOT mean every scene shows a single character pointing. The pose, the action, the number of characters all come from the script.',
      // Ref #09 description removed 2026-05-29 — the ref itself was
      // moved to _review-not-doodle-2/ because the literal word
      // "Highlight" was bleeding into every output. Typography teaching
      // moved into the prompt suffix (BAKED TYPOGRAPHY section). Slot
      // reserved for a subject-neutral replacement ref.
      '  • Ref #13 (sunlit forest in a framed black rounded rectangle) teaches the FRAMED-REAL-PHOTO COMPOSITION — a wobbly thin black rounded-rectangle frame containing a real photo, placed in part of the frame with cartoon elements around it. It does NOT mean forests should appear in scenes. The photo subject is whatever the script\'s scene is actually about — a person, a building, a football stadium, a lab interior, a city street, a vintage object, a piece of equipment, a historical event, ANYTHING the narration calls for. The forest in the ref is a placeholder. Treat it as a stand-in for "the relevant real photograph for THIS beat."',
      '',
      'Stay BALANCED — not locked to single-subject minimalism (which made earlier outputs feel empty), not crammed full of figures and props (which made the "1959" output feel like a garage sale). Pick the element count that serves the narration beat, no more.',
      '',
      '== COMPOSITION — ELEMENT COUNT IS THE BALANCE LEVER ==',
      '',
      'Looking at frame samples across the 3 reference videos (paint-ref/, paint-ref-2/, paint-ref-3/), the element count varies BY BEAT. These are observed distributions, NOT quotas — let each beat\'s content decide. Stay inside the range:',
      '',
      '  • ~50% of beats → ONE main element (a single character close-up, a single prop, an empty cave entrance with no character at all). Spare and focused.',
      '  • ~30% of beats → TWO main elements (character + thing they\'re reacting to, character + their tool).',
      '  • ~15% of beats → 3-6 elements MAX for a group/landscape beat (3 hikers looking up at a meteor, 5 bystanders + a mysterious figure in a street).',
      '  • ~5% of beats → a SIDE-BY-SIDE COMPARISON: 2 portraits of the same character with one small visible change between them, often with a red/orange arrow showing progression (the RAT-DRIVEN BLACK DEATH style — concerned face → terrified face).',
      '',
      'HARD CEILING: never 10+ elements in one frame. The recent "1959" output had ten stick figures, multiple campfires, an axe, a backpack, a sign, and multiple swirling wind lines all scattered around. That\'s a garage sale, not a storybook panel. Pick 1-3 main subjects and let the rest of the frame BREATHE.',
      '',
      'When picking element count, ask: "what is the ONE thing this narration beat is about?" Build around that. Multi-element does NOT mean cram-everything-in; it means "let the supporting beat-relevant element appear alongside the main subject when both belong in the same picture."',
      '',
      'GOOD framings (each tied to a reference frame in hiccup-analysis/paint-ref*/):',
      '  • Solo character close-up — head + shoulders fill the frame, maybe with a speech bubble. Examples: the bald-with-sunglasses-and-goatee Pronunciation Book character; the lab-coat scientist saying "Fascinating".',
      '  • Solo environment — no character, just a place / object. Examples: the brown-arched cave entrance with light-blue glow inside; falling orange meteor pieces in gray clouds.',
      '  • Character + one prop they\'re using — close composition, both fill the frame together. Examples: a scientist hunched over a laptop with wavy lines on screen; a bearded historian holding a scroll with a red feather quill.',
      '  • Character + the thing they\'re looking at, with negative space between — wider composition. Examples: scientist on the left + green virus splat on the right; character + cartoon book on a real map backdrop.',
      '  • Small group (3-5) — anonymous bystanders in a row, identical-looking, no individual detail; one of them visually distinct (the all-black ninja with a ? head in the middle of plain bystanders).',
      '  • Real-photo backdrop + cartoon foreground — real Reddit screenshot with a cartoon character overlaid; real map with a cartoon book sitting on top.',
      '  • Side-by-side variant comparison — 2 portraits of the same character with a red/orange arrow between them showing progression in ONE frame (RAT-DRIVEN BLACK DEATH).',
      '',
      'BAD framings (NEVER do these):',
      '  • A diagram with handwritten labels and arrows pointing FROM a label TO parts of the picture ("Huge Slab of Snow ↗", "Dangerous Slope ↘", "Unsuspecting Campers ↗"). That\'s a chart, not a story panel. The recent "Avalanche Danger" output is the canonical bad example.',
      '  • The same pattern applied to yellow callouts: a yellow callout label with red/orange arrows pointing FROM the label TO a part of the scene ("AVALANCHE JUST STARTING ↘"). The "FINAL TENSION" output did this — DON\'T. Yellow callouts are FLOATING labels (rendered by the player as overlays), not pointers.',
      '  • An "infographic" or "schematic" layout — anything that looks like a textbook explanation.',
      '  • 10+ characters / props scattered randomly across the frame. Pick 1-3 and let the rest breathe.',
      '',
      '== CHAINED VARIANTS — REAL MOTION ARCS VIA `variant_derives_from_previous` ==',
      '',
      'Most variant groups are SIBLINGS — variant 1 and variant 2 both edit the BASE image independently, each adding a small static change ("blood drips from his head" / "his mouth opens in surprise"). The viewer perceives slight variation, not continuous motion.',
      '',
      'Some narration beats describe a REAL PROGRESSION — a single physical motion that completes across multiple consecutive rows. Examples:',
      '  • "the door cracks open, then swings wide, then slams shut" — a continuous arc of the same door',
      '  • "George slowly raises the photograph to his eyes" across two beats — one arm motion progressing',
      '  • "the fire grows from a flicker to consuming the whole roof" across three beats — escalation',
      '  • "a character walks from the foreground to the doorway" — locomotion across frames',
      '',
      'For groups like THIS, set `variant_derives_from_previous: true` on EVERY variant row (variant_index > 0) in the group. The server then routes variant N\'s Atlas Edit through the PREVIOUS variant\'s image instead of the base, so variant 2 builds on variant 1 instead of restating it. The animation reads as one continuous motion, not three siblings.',
      '',
      'Default = OMIT (parallel siblings). Only set `variant_derives_from_previous: true` when the narration is unambiguously a continuous motion arc. If you are unsure, leave it omitted — siblings are the safer default and reproduce the reference videos\' typical animation feel.',
      '',
      'RULES:',
      '- Set on EVERY variant row in the chained group (variant_index 1, 2, 3 — never on the base variant_index 0).',
      '- Do NOT chain a group whose variants describe INDEPENDENT additions ("add a hat" then "add a coat") — those are siblings.',
      '- Cap chain depth at 3 variants (base + V1 + V2 + V3 = 4 rows). Each chained Edit adds small drift; longer chains compound it into visible identity decay.',
      '- The variant_edit_prompt for a chained row should describe what changes from the PREVIOUS variant, not from the base ("the photograph is now at eye level" — not "the photograph is now at eye level vs starting at his side").',
      '',
      'WORKED EXAMPLE — Sodder Children script, if it had a motion arc:',
      '  Suppose rows 18 + 19 + 20 narrated "George slowly raises the photograph to his eyes."',
      '    Row 18 (base): close-up of George holding the photograph at his side',
      '    Row 19 (variant 1, `variant_derives_from_previous: true`): photograph rising to chest level',
      '    Row 20 (variant 2, `variant_derives_from_previous: true`): photograph at eye level, George studying it',
      '    Result: a smooth rising-arm arc across three beats.',
      '  Contrast — rows 12 + 13 ("He had reasons. The fire ladder he kept was missing."):',
      '    Same group_id, but each beat shows a DIFFERENT visual (George\'s reflective close-up, then the ladder spot) — these are SIBLINGS, not a chain. Leave `variant_derives_from_previous` OMITTED.',
      '',
      '== MOTION COLLAGE — REAL FRAME-BY-FRAME MOTION ==',
      '',
      'When a beat describes REAL PHYSICAL MOTION that an additive variant cannot capture — a character running across the room, a logo assembling piece-by-piece, a glass falling and shattering, a hand typing rapidly, a text message typing itself out, an object falling through frame, fire growing from a flicker to consuming a whole roof in one beat — emit `shot_kind: "motion_collage"` instead of forcing the motion into a variant group. Motion collage produces ONE generation containing N keyframes in a grid; the pipeline slices the result into N keyframes and the renderer plays them hard-cut over the row\'s duration.',
      '',
      '== MOTION COLLAGE — HARD TRIGGER WORDS ==',
      '',
      'When the narration of a SINGLE row contains ANY of the following physical-motion verbs, **motion_collage IS the right answer**. Do NOT default to a static row. Do NOT split the motion across multiple variant rows.',
      '',
      '  HARD-TRIGGER VERBS — any of these in ONE row\'s narration → emit motion_collage:',
      '    • tipped / tipping / tips / heeled / leans / leaned / topples / topple',
      '    • fell / falling / falls / dropped / drops / collapsed / collapses / collapsing',
      '    • sank / sinks / sinking / sunk / submerged / submerging',
      '    • rose / rises / rising / lifted / lifting / climbed / climbing / ascended',
      '    • ran / runs / running / sprinted / sprinting / dashed / dashes',
      '    • walked / walking / strode / striding (only when crossing the frame, not standing in place)',
      '    • flew / flies / flying / soared / soaring / hovered',
      '    • exploded / exploding / explodes / shattered / shatters / shattering / burst / bursts',
      '    • grew / growing / spread / spreading / consumed / consuming (when describing fire / fluid / wave / smoke / virus)',
      '    • typed / typing / wrote / writing (when describing text or letters appearing one at a time)',
      '    • assembled / assembling / dissolved / dissolving / transformed / transforming',
      '    • opened / opening / closed / closing (only when describing a door / mouth / book swinging visibly)',
      '    • crashed / crashing / smashed / impacting',
      '    • pulled / pulling / pushed / pushing (when the object is in continuous motion across the beat)',
      '',
      '  EXAMPLES — script line → correct shot_kind:',
      '    "The Vasa heeled hard to port."                              → motion_collage (heeled)',
      '    "Water poured in through the open gun ports."                → motion_collage (poured)',
      '    "The ship sank in 32 meters of water."                       → motion_collage (sank)',
      '    "George ran from the burning house to the truck."            → motion_collage (ran)',
      '    "A meteor crashed into the Siberian tundra."                 → motion_collage (crashed)',
      '    "The crowd gathered at the docks."                           → Animation (no motion verb on a single subject)',
      '    "The Vasa was the most powerful warship ever built."         → Animation (static description)',
      '',
      'WHEN MULTIPLE TRIGGERS APPEAR IN ONE ROW (e.g. "the ship heeled hard, then water poured in"), still emit ONE motion_collage row — pick the dominant motion (the verb that drives the beat) and let the secondary motion happen in later panels (water in panels 3-4 of a heeling collage).',
      '',
      'UNDER-USE is the real failure mode. If you finish the doc with fewer than ONE motion_collage row per hard-trigger verb in the script, you missed motion. Videos need movement to feel alive — go back, find every trigger, convert those rows.',
      '',
      'CADENCE — AIM HIGH: emit ONE motion_collage row PER hard-trigger verb in the script, at minimum. A typical 24-row mystery/disaster doc should produce 5-8 motion_collage rows, NOT 2-3. Real-life history scripts are FULL of motion verbs — ships heel and sink, fires grow, characters run and fall, objects break and assemble. Every one of those is a motion_collage candidate.',
      '',
      'TRIGGER GENEROUSLY — when in doubt, emit motion_collage. Examples that should ALL be motion_collage:',
      '  • "the ship cast off and began its first sail" — casting off IS motion (ship leaves dock, sails fill)',
      '  • "the crowd gathered at the harbor" — gathering IS motion (people arrive, fill space)',
      '  • "smoke filled the room" — filling IS motion (smoke spreads)',
      '  • "the door creaked open" — opening IS motion',
      '  • "the body slumped to the floor" — slumping IS motion',
      '  • "rain pounded the roof" — pounding IS continuous motion',
      '  • "she pulled the trigger" — pulling IS motion',
      '  • "the building swayed" — swaying IS motion',
      '  • "lightning struck the mast" — striking IS motion',
      '  • "ice cracked under their feet" — cracking IS motion (lines spread)',
      '',
      'SOFT-TRIGGER VERBS that ALSO warrant motion_collage when they describe a SINGLE BEAT of physical change:',
      '  • cast off / set sail / launched / departed / arrived / docked',
      '  • gathered / scattered / dispersed / fled / chased / circled',
      '  • filled / spread / poured / spilled / leaked / oozed',
      '  • cracked / split / tore / ripped / shattered / snapped',
      '  • bent / twisted / curled / coiled / wrapped',
      '  • slumped / collapsed / sagged / drooped',
      '  • pulled / pushed / dragged / shoved / tossed / threw',
      '  • struck / pounded / hammered / smashed',
      '  • swayed / rocked / tilted / leaned',
      '',
      'TARGET BAND for typical real-life mystery/disaster/discovery scripts:',
      '  - 15-25 rows: aim for 6-10 motion_collage shots (~35-45% of rows)',
      '  - 26-40 rows: aim for 11-16 motion_collage shots (~38-45% of rows)',
      '  - 41+ rows: aim for ~40% of rows being motion_collage',
      '',
      'If you finish drafting and the count is below the target band, GO BACK and find more triggers. Every script has more motion than you initially think — re-read each row\'s script_text looking for ANY verb that implies physical change, and lean toward motion_collage.',
      '',
      'WHEN TO USE:',
      '  • Character locomotion across the frame (running, walking, climbing, falling, jumping)',
      '  • An object physically moving (door opening, ball bouncing, paper falling, smoke rising, water pouring)',
      '  • A transformation arc happening in ONE beat (fire growing, ice melting, fluid spreading, container filling)',
      '  • Text or a logo appearing piece-by-piece or letter-by-letter',
      '  • A piece of evidence being assembled / disassembled in real time',
      '  • Any "before → during → after → after → after" sequence happening inside one narration beat',
      '',
      'WHEN NOT TO USE:',
      '  • Static or slow narration beats — use regular Animation rows.',
      '  • Topic / camera pivot — use `shot_kind: "hard_cut"`.',
      '  • Held-scene reaction beats (eyebrow raises, mouth opens in surprise across 2-3 narration lines) — use the variant group system. Additive deltas on a held scene already give you that without the motion-collage machinery.',
      '  • Two characters in the same shot with motion on BOTH — pick ONE motion per shot. Two simultaneous motions in one grid drift unpredictably.',
      '',
      'GRID SIZE: pick the smallest grid that fits the motion arc. Most cases are `{cols:2, rows:2}` (4 keyframes — the classic "before / starting / mid / end" arc). Use `{cols:3, rows:2}` (6 frames) when the motion needs a clearer middle. Use `{cols:3, rows:3}` (9 frames) ONLY for elaborate sequences that genuinely need 9 distinct moments. HARD CAP: 16 panels total (server-side enforced via MAX_COLLAGE_CELLS). Anything larger is rejected before the AI call.',
      '',
      'PREFER SQUARE GRIDS (2×2 / 3×3 / 4×4) for tightest fit — non-square grids (3×2, 4×3) produce non-16:9 panels which the renderer crops to 16:9, losing some vertical content. Square grids preserve the 16:9 ratio exactly because the source collage is 16:9 itself.',
      '',
      'EMITTING THE FIELDS:',
      '  • `shot_kind: "motion_collage"`',
      '  • `motion_collage_grid: { cols, rows }` (e.g. `{cols:2, rows:2}` = 4 frames)',
      '  • `motion_collage_panel_prompts: ["<panel 1>", "<panel 2>", ...]`',
      '    Length MUST be cols × rows EXACTLY. Order: left-to-right, then top-to-bottom (panel 0 = top-left, last panel = bottom-right).',
      '  • Leave `ai_image_prompt` EMPTY on motion_collage rows. The pipeline composes the full collage prompt from `motion_collage_panel_prompts`.',
      '  • `script_text`, `on_screen_text`, `overlay_stock_terms`, `notes` work normally — the row is still an ordinary narration beat surrounded by the same chrome (yellow callout, section title at the top).',
      '',
      'PER-PANEL PROMPT RULES:',
      '  • **KEEP PANEL PROMPTS SHORT — 80-150 CHARACTERS MAX.** Longer panel prompts (200+ chars) push Atlas toward dense, detail-filled output that breaks the sparse doodle aesthetic. Write only what changes + minimal scene anchor. The pipeline composer + style refs + suffix carry the rest.',
      '  • SUBJECT-FIRST framing — start each panel with the moving subject, NOT the wide setting. The refs convey "what kind of scene this is"; your panel prompt conveys "what changes this frame".',
      '    GOOD (87 chars): "Stick figure runner mid-stride, right foot lifting from the brown ground. Same scene."',
      '    BAD (210 chars): "Wide harbor view of the entire dock with several ships in the distance, blue water spreading to the horizon, a clear sky above, and a stick figure runner mid-stride near the foreground. Same scene as before."',
      '  • Describe the moving element\'s STATE at THIS panel, not the action ITSELF.',
      '    GOOD: "the runner\'s right foot is mid-stride, left foot is planted"',
      '    BAD: "the runner takes a step"',
      '  • ELEMENT-SCALE IS LOCKED. The motion you depict must be TRANSLATION (position), ROTATION, POSE / EXPRESSION change, or a PROGRESSIVE STROKE (line / arrow being drawn). It must NEVER be the element growing, shrinking, expanding, or filling the frame. Props, signs, icons, labels, and characters keep the SAME SIZE across every panel. A warning triangle that "appears small in panel 1 and huge in panel 4" is WRONG — that scale change is forbidden. If the beat sounds like "the alarm grows", depict it as the alarm SHAKING or its rays EXTENDING outward (translation), NOT the icon enlarging.',
      '    FORBIDDEN words (any one of these in a panel prompt = wrong motion type): "grows", "growing", "gets bigger", "gets larger", "becomes large", "enlarges", "swells", "expands", "shrinks", "fills the frame", "dominating", "looms", "more prominent", "scaled up", "blown up", "huge", "tiny" — when used to convey size change between panels.',
      '    ALLOWED motions: a character walking, an arm raising, a head turning, a prop sliding from left to right, a triangle rotating, an arrow being drawn stroke by stroke, a stick figure changing pose / expression, text appearing letter by letter, a hand pointing to different sticky notes in sequence.',
      '  • SAME-SCENE anchor — end each panel with a short "Same scene." or "Same composition." marker so the model knows to lock the camera + background.',
      '  • SPARSE COMPOSITION — describe only what the viewer NEEDS to see. Avoid filler details (clouds, distant ships, intricate carvings, dense crowds) that turn the doodle into an illustration. The refs show the sparseness floor; match it.',
      '  • For text-appears-by-letter motion, each panel shows the partial string up to that panel:',
      '    Panel 1: "H", Panel 2: "HE", Panel 3: "HEL", Panel 4: "HELP".',
      '  • Stick to ONE motion per shot. Don\'t cram a character running AND a logo assembling AND fire growing into the same grid — that drifts.',
      '',
      'EXAMPLE — Rewriting verbose prompts to sparse ones:',
      '  Verbose (BAD, ~220 chars): "Wide Stockholm harbor view with the Vasa upright on calm blue water, sails full and unfurled, busy docks and shoreline in the distance, dramatic sky above, with crowds of onlookers visible along the pier."',
      '  Sparse (GOOD, ~95 chars): "The Vasa ship upright on calm water, sails full, small crowd silhouettes on the dock. Same scene."',
      '  → The sparse version forces Atlas to leave white space around the ship instead of cramming the frame full of harbor detail.',
      '',
      'CADENCE: motion_collage is a SPICE, not a staple. Aim for at most ~1 motion_collage shot per 15-20 rows. Over-using it makes the video feel like an animated short instead of a documentary doodle. Under-use is the safer failure mode — almost every beat works fine as a regular Animation row or a variant group; only reach for motion_collage when the narration genuinely describes one continuous motion arc within ONE beat.',
      '',
      'WORKED EXAMPLE — "George ran from the burning house to the truck":',
      '  shot_kind: "motion_collage"',
      '  motion_collage_grid: { cols: 3, rows: 2 }    // 6 keyframes',
      '  motion_collage_panel_prompts: [',
      '    "wide shot of the burning Sodder house on the left, the family truck parked far right, George standing just outside the front door starting to lift his right foot. Flames on the roof. Brown ground. Sky gray with smoke.",',
      '    "same wide shot, same house and truck and smoke; George now 1/5 of the way across, both feet mid-air, arms swinging in stride.",',
      '    "same wide shot, same house and truck and smoke; George now 2/5 across, right foot planted on the brown ground, left foot lifting.",',
      '    "same wide shot, same house and truck and smoke; George now 3/5 across, both feet mid-air again, arms swinging in opposition.",',
      '    "same wide shot, same house and truck and smoke; George now 4/5 across, right foot landing near the truck.",',
      '    "same wide shot, same house and truck and smoke; George at the truck, hand on the driver-side door handle, looking back at the burning house."',
      '  ]',
      '',
      'The narration "George ran from the burning house to the truck" plays over all 6 frames; each frame holds ~400 ms; the brain reads it as continuous motion. ONE generation cost.',
      '',
      '== MOTION COLLAGE — EXACT JSON ROW SHAPE (READ THIS BEFORE EMITTING) ==',
      '',
      'When a row is a motion_collage shot, emit ALL FIVE of the fields below in the row JSON. Missing any of `shot_kind`, `motion_collage_grid`, or `motion_collage_panel_prompts` makes the row UNRENDERABLE — the pipeline cannot generate it and the editor cannot edit it. This was the #1 LLM-compliance bug on the first production run, so make this section concrete.',
      '',
      'GRID SIZE: prefer 3×3 (9 panels) as the default for any motion that takes more than a tiny gesture. 2×2 (4 panels) is only appropriate for a SINGLE small movement (one head turn, one arm raise) — it forces such a large per-panel delta that the image model re-imagines composition every frame and the result reads as jumpy. Anything bigger than a single gesture (running, falling, building a structure, transforming) needs 3×3 or larger so the per-panel motion delta stays small enough that the image model preserves composition.',
      '',
      'CANONICAL JSON for a motion_collage row — copy this structure verbatim, then swap the contents:',
      '',
      '```json',
      '{',
      '  "timecode": "0:37",',
      '  "script_text": "The Vasa heeled hard to port.",',
      '  "visual_type": "Animation",',
      '  "visual_description": "Nine-panel motion collage of the Vasa heeling left in small stages, from upright to dangerous angle.",',
      '  "stock_search_terms": "ship heeling, listing ship, naval disaster",',
      '  "ai_image_prompt": "",',
      '  "on_screen_text": "",',
      '  "notes": "",',
      '  "shot_kind": "motion_collage",',
      '  "motion_collage_grid": { "cols": 3, "rows": 3 },',
      '  "motion_collage_panel_prompts": [',
      '    "Wide harbor view, the Vasa standing upright on calm blue water, sky above, distant docks. Stick-figure crew on deck. Hand-drawn doodle style.",',
      '    "Same wide harbor view; ship tilted 8 degrees to port, masts barely leaning left.",',
      '    "Same wide harbor view; ship tilted 16 degrees to port, masts leaning a bit further.",',
      '    "Same wide harbor view; ship tilted 25 degrees to port, deck angle visibly steepening.",',
      '    "Same wide harbor view; ship tilted 35 degrees to port, crew shifting weight to stay upright.",',
      '    "Same wide harbor view; ship tilted 45 degrees, crew starting to slide toward the rail.",',
      '    "Same wide harbor view; ship tilted 55 degrees, deck nearly vertical, crew gripping ropes.",',
      '    "Same wide harbor view; ship tilted 65 degrees, masts low over the water.",',
      '    "Same wide harbor view; ship tilted 75 degrees, masts touching the water, crew clinging on."',
      '  ]',
      '}',
      '```',
      '',
      'Note the per-panel deltas: ~8-10 degrees each, NOT 25-degree jumps between four panels. Small steps preserve composition; big steps break it.',
      '',
      'FIELDS TO PAY ATTENTION TO — these are the four bugs that hit the first run:',
      '',
      '  1. **`visual_type` is "Animation"** — NOT "motion_collage", NOT "Title Card", NOT "B-Roll". motion_collage is a `shot_kind`, NOT a visual_type. The visual_type stays "Animation" so the row renders through the same animation pipeline as every other doodle shot. If you put "motion_collage" or "Title Card" here, the editor categorises the row wrong and the renderer fails to mount the motion-collage scene.',
      '',
      '  2. **`ai_image_prompt` is an EMPTY STRING** (`""`), not a description. The image-gen pipeline ignores this field on motion_collage rows; it composes the prompt from `motion_collage_panel_prompts` instead. Putting text here is harmless but wasted tokens.',
      '',
      '  3. **`shot_kind: "motion_collage"`** is REQUIRED. Without it the row falls through to the regular Animation render path and your motion_collage_panel_prompts are silently ignored. This is the #1 missing-field bug from the first production run.',
      '',
      '  4. **`motion_collage_grid`** is REQUIRED and must be `{ "cols": <int>, "rows": <int> }`. `motion_collage_panel_prompts` is REQUIRED and its length MUST equal `cols × rows`. The pipeline rejects mismatched rows BEFORE making any AI call (validation error surfaces in the editor inspector).',
      '',
      'SELF-CHECK BEFORE SUBMITTING — Scan every row. For each row whose narration contains a hard-trigger verb (heeled, sank, ran, fell, …):',
      '  • Does the row JSON contain `shot_kind: "motion_collage"`? If NO, this row is a missed motion_collage emission. Fix it.',
      '  • Does it contain `motion_collage_grid` AND `motion_collage_panel_prompts`? If only one of the two, the row is unrenderable. Fix.',
      '  • Is `visual_type` set to "Animation"? If "Title Card" or "motion_collage" or anything else, the renderer routes wrong. Fix.',
      '',
      '== CHARACTERS — RECURRING IDENTITY VIA `character_id` ==',
      '',
      'For every RECURRING named character in the script, pick a stable, short, lowercase-with-dashes slug and set it as `character_id` on EVERY row showing that character. This is what keeps "George at row 4" looking like "George at row 12" across non-consecutive shots.',
      '',
      'How it works server-side (you do NOT manage the cache — just emit consistent ids):',
      '- FIRST row with a given character_id: pipeline generates fresh via Atlas i2i with the 4 style refs (full $0.04 cost) and caches the result.',
      '- EVERY subsequent row with the same character_id: pipeline calls Atlas Edit on the cached base with the new scene as the edit prompt (cheaper $0.011 AND preserves the character\'s face, hair, body, and clothing identical to the cached base).',
      '- Result: same George — same face, same hair, same shirt and suspenders — across every scene he appears in, regardless of how many rows apart.',
      '',
      'The output JSON schema below treats `character_id` as an OPTIONAL per-row field — emit it as `"character_id": "<slug>"` on every qualifying row; omit the key entirely on non-qualifying rows.',
      '',
      'RULES for emitting `character_id`:',
      '- Use a 1-3 word lowercase-with-dashes slug tied to content: "george", "jennie", "louis-as-adult", "napoleon", "the-mailman", "scientist-1".',
      '- **Pronouns and implicit references count.** If the script says "George went to bed" on one row and "he had reasons" on a later row, BOTH rows feature George. Both get `character_id = "george"`. Resolve every "he / she / his / her / they (singular)" against the most recently named character in the script and tag accordingly. The cache cannot reuse George\'s identity across rows the LLM forgot to tag.',
      '- **The visual is what matters, not the script grammar.** If the row\'s `visual_description` shows George\'s face / body / pose, the row features George — even if the narration line itself is reflective ("He had reasons.") or location-anchored ("His house went up in flames."). Apply `character_id` based on what the VIEWER sees, not what the SENTENCE names.',
      '- Set it on EVERY row featuring that character — including variant rows (variants still need character_id even though their `ai_image_prompt` is empty; the cache key still applies).',
      '- Different characters get DIFFERENT slugs.',
      '- Same person at different life-stages with VISIBLY DIFFERENT appearance gets DIFFERENT slugs: "louis-child" vs "louis-as-adult". (Same person at the same life-stage but different mood/pose = same slug.)',
      '- One-off characters who only appear in ONE row: leave `character_id` undefined. The cache only pays off across multiple rows.',
      '- Generic unnamed people (anonymous bystanders, crowd, generic investigators, generic firefighters): leave `character_id` undefined.',
      '- Group scenes (multiple recurring characters in one frame): set `character_id` to whichever character is the DOMINANT focus of that row. Atlas Edit can only preserve one character\'s identity per call; the others will drift.',
      '',
      'WORKED EXAMPLE — Sodder Children script:',
      '  Row 1 ("George went to bed thinking his family was safe"): character_id = "george"',
      '  Row 4 ("George, Jennie, and four children escaped through the front"): character_id = "george" (he\'s the dominant figure leading the escape; Jennie + kids drift)',
      '  Row 7 ("When the fire department finally arrived..."): no character_id (generic firefighters)',
      '  Row 9 ("George spent the rest of his life refusing to believe..."): character_id = "george"',
      '  Row 13 ("A photograph that looked like Louis as an adult"): character_id = "louis-as-adult"',
      '  Row 14 ("Anonymous tips arrived for decades"): no character_id (no specific character on screen)',
      '  Row 18 ("George died in 1969"): character_id = "george"',
      '  Result: "george" appears in 4 rows → 1 fresh i2i + 3 Atlas Edits = $0.073 vs $0.16 if all fresh, AND George looks identical across all 4 shots.',
      '',
      '== CHARACTER BIBLE — DOC-LEVEL `character_descriptions` MAP ==',
      '',
      'Atlas Edit can preserve only ONE source image\'s content per call. On a row with multiple recurring characters ("George + Jennie escape"), the cache anchors the dominant character (`character_id`) but the OTHERS would still drift on every row.',
      '',
      'Solution: emit a doc-level `doodle_explainer_2_character_descriptions` map at the top level of the output JSON. Keys are the same character_id slugs you use on rows; values are 1-2 sentence visual descriptions of distinctive PAINTABLE features.',
      '',
      'The server prepends a "character reference" block to every row\'s prompt at image-gen time, so the model has consistent reference language for every recurring character — even those the cache can\'t anchor on a given row.',
      '',
      'RULES for `character_descriptions`:',
      '- One entry per UNIQUE character_id used anywhere in the doc.',
      '- Slug key MUST match exactly the character_id slug you use on rows.',
      '- 1-2 SENTENCES per description. Hard cap ~200 chars per value — long descriptions waste prompt budget.',
      '- Describe DISTINCTIVE, VISIBLE, PAINTABLE features only: clothing color & shape, hair color & style, age & build, distinctive accessories (glasses, hat, beard). NOT personality, NOT backstory, NOT non-visible attributes.',
      '- Be SPECIFIC, not generic. "An old man" → useless. "Gray hair and mustache, dark vest over white shirt, brown trousers, ~60 years old" → useful.',
      '- Lowercase slug keys; sentence-case descriptions.',
      '',
      'WORKED EXAMPLE for the Sodder Children script:',
      '  doodle_explainer_2_character_descriptions: {',
      '    "george": "Gray hair and mustache, dark vest over white shirt, brown trousers, suspenders, ~50 years old, often holds a hat.",',
      '    "jennie": "Yellow dress with brown apron, brown hair pulled back in a bun, ~40 years old, slender build.",',
      '    "louis-as-adult": "Tall, brown coat over white shirt, short brown beard, ~30 years old, serious expression."',
      '  }',
      '',
      '== SCENES — RECURRING LOCATION IDENTITY VIA `scene_id` ==',
      '',
      'Parallel to `character_id` but for the BACKGROUND / SETTING. When the same LOCATION or significant recurring OBJECT appears across multiple rows (the same house, the same desk, the same street corner), pick a stable slug and set it as `scene_id` on EVERY row showing that location. The pipeline keys a per-doc scene cache by this value: first row generates fresh, subsequent rows reuse the same canvas via Atlas Edit so the architecture / palette / window layout stay identical across non-consecutive shots.',
      '',
      'The output JSON schema below treats `scene_id` as an OPTIONAL per-row field — emit it as `"scene_id": "<slug>"` on every qualifying row; omit the key entirely on non-qualifying rows.',
      '',
      'RULES for emitting `scene_id`:',
      '- Use a 1-3 word lowercase-with-dashes slug tied to the LOCATION or OBJECT: `"sodder-house"`, `"family-home-exterior"`, `"investigator-desk"`, `"the-cabin-interior"`, `"main-street"`.',
      '- Set it on EVERY row showing that location — including variant rows (the cache key applies to variants too).',
      '- The visual is what matters, not the script grammar. If the row\'s visual_description shows the family home (whether the script says "the house was on fire" or "they ran out the front door"), the row\'s scene IS the family home. Apply scene_id based on the VISUAL.',
      '- One-off locations / generic backgrounds (a plain white close-up against nothing, a generic rubble pile shown once): leave `scene_id` undefined. The cache only pays off across multiple rows.',
      '- Different angles of the SAME location share the same scene_id. The Atlas Edit pass can shift the camera; identity preservation is on the architecture, not the camera angle.',
      '- Visibly different locations get DIFFERENT slugs (`"sodder-house-exterior"` vs `"sodder-house-cellar"` when the script visits both interior + exterior).',
      '- Plain-white-background character close-ups are NOT scenes. The scene cache anchors a setting; an empty white field has nothing to anchor.',
      '',
      'PRECEDENCE — character_id wins over scene_id on mixed rows. When a row has BOTH `character_id` AND `scene_id` AND both have cache entries, the dispatcher hits the character cache. Atlas Edit can only preserve one source image\'s content per call; character identity (face / hair / clothing) is more visually load-bearing than location identity. The scene drifts slightly on mixed rows, but the character stays anchored — and the scene cache still saves cost on character-less rows where the scene is the main thing.',
      '',
      'WORKED EXAMPLE — Sodder Children script:',
      '  Row 0 ("On Christmas Eve 1945, in Fayetteville, West Virginia"): scene_id = "sodder-house" (establishing wide of the family home)',
      '  Row 1 ("George went to bed thinking his family was safe"): scene_id = "sodder-house" AND character_id = "george" (character wins precedence; scene still cached for later character-less rows)',
      '  Row 2 ("Hours later, the family home was on fire"): scene_id = "sodder-house" (same house, now burning — Atlas Edit modifies the cached base to add flames)',
      '  Row 7 ("When the fire department finally arrived..."): scene_id = "sodder-house" (firefighters in front of the same house)',
      '  Row 8 ("They searched the rubble"): scene_id = "sodder-house-rubble" (visibly different — collapsed ruin, new cache entry)',
      '  Row 17 ("For decades the family received anonymous tips"): scene_id = "investigator-desk" (completely different location, new slug)',
      '  Row 19 ("rumors of children being smuggled..."): scene_id = "investigator-desk"',
      '  Result: "sodder-house" appears in 4 rows → 1 fresh i2i + 3 Atlas Edits, same house exterior across the arc. "investigator-desk" appears in 2 rows → 1 fresh i2i + 1 Atlas Edit, same desk.',
      '',
      '== REALISM — GROUND THE STORY IN REALITY ==',
      '',
      'We tell stories from real life. Competitor channels in this genre lean heavily on realism to make their videos feel authentic and professional, and we do the same. Realism has TWO pillars in this style. The general stick-figure doodle look STAYS DOMINANT — realism is additive texture, not a replacement style.',
      '',
      '--- PILLAR 1: REAL PHOTOGRAPHS COMPOSITED INTO SCENES ---',
      '',
      'TRIGGER a real-photo composition (Pattern A or Pattern B below) on EVERY one of these:',
      '  • Named person (historical figure, scientist, celebrity, witness, perpetrator, victim, expert)',
      '  • Named place (city, country, building, landmark, region, specific location)',
      '  • Named brand, product, organization, company, agency',
      '  • Named event with photographic record (war, disaster, launch, ceremony, attack, rescue)',
      '  • Specific dated object that has a strong real-world referent (e.g. a particular vintage TV set, a specific model of car, an iconic piece of equipment)',
      '',
      'Pattern A — FULL REAL-PHOTO BACKGROUND, cartoon foreground. The real photo fills the frame; ONE stick-figure character or ONE small cartoon prop sits on top of it. Use for setting establishment ("this happened at the Pentagon", "the witnesses gathered outside the courthouse"). Set `overlay_stock_terms` to the relevant search query (e.g. "Pentagon aerial 1970s", "courthouse steps").',
      '',
      'Pattern B — FRAMED REAL PHOTO inside a doodle scene. A thin black wobbly rounded-rectangle frame (~8px corner radius) contains the real photo; the framed photo sits next to or beside cartoon elements. Ref #13 (framed sunlit forest) is the style anchor for this composition — BUT THE FOREST IS A PLACEHOLDER. Do NOT default to forests. The photo subject must be whatever the current beat is about: a person\'s headshot when the script names a person, a stadium when the script mentions one, a lab interior for a research scene, a city street for a location, a vintage object, a piece of equipment, a historical event — anything the narration calls for. Treat ref #13 as "here is what the FRAME looks like and where the photo sits in the composition"; the photo itself comes from the script content. Use when the scene is about a named entity AND a character\'s reaction in the same beat ("the witness described seeing this" → framed photo of the actual location/object next to a startled stick figure).',
      '',
      'CADENCE FLOOR: at minimum one real-photo beat for every 8-12 rows. A factual / historical / news script that mentions many named entities can sit closer to one per 4-6 rows. If you finish the doc and a named person, place, brand, or event passed through without a real-photo composition, you missed it — go back and add it. NEVER skip `overlay_stock_terms` on a row that mentions a named entity.',
      '',
      '--- PILLAR 2: SPECIFIC, NAMED REAL-WORLD PROPS IN CARTOON FORM ---',
      '',
      'When the script calls for a prop, NAME the specific real-world referent in the `ai_image_prompt`. Generic shapes feel like stock clipart; named specific objects feel deliberate.',
      '',
      'BAD (generic, feels generated): "a phone", "a notebook", "a car", "a weapon", "a computer", "a camera", "a watch"',
      'GOOD (specific, feels researched): "a Bakelite rotary phone with a coiled black cord", "a yellow legal pad with handwritten notes in blue ballpoint", "a 1973 olive-green Pontiac with a vinyl roof", "a Colt 1911 service pistol", "a beige IBM 5150 with a green monochrome monitor", "a Polaroid SX-70 instant camera", "a Casio digital watch with a black plastic band"',
      '',
      'The prop is STILL DRAWN IN THE DOODLE STYLE — thick wobbly black ink outlines, flat color fills, no photorealism, no 3D rendering. We are not switching to realism; we are giving the LLM (and viewer) a specific real-world reference so the doodled prop is recognizable instead of generic.',
      '',
      'WHEN TO BE SPECIFIC vs. GENERIC: be specific when the prop carries the narrative weight of the beat ("she picked up the phone" → name the phone). Stay generic when the prop is background dressing ("books on a shelf" can stay "books on a shelf"). Roughly: if the camera would linger on it for >0.5s, name it.',
      '',
      'PERIOD ACCURACY: when the script is set in a specific decade or era, the named props should match that era. A 1970s scene gets a rotary phone, not an iPhone. A 1990s scene gets a CRT computer monitor, not a flat panel. Use the script\'s temporal context to drive the prop choice.',
      '',
      '== ARROWS — TIGHT RULES ==',
      '',
      'Arrows DO appear in the reference, but for ONLY two purposes:',
      '',
      '  • PROGRESSION between 2 side-by-side states of the same subject — a red/orange curved arrow from portrait A to portrait B showing "this then became this" (RAT-DRIVEN BLACK DEATH). Use ONLY in the rare side-by-side variant frame, not in normal scenes.',
      '  • MOTION TRAILS following a moving object — the trail of a meteor, the path of a fireball, the trajectory of an avalanche slab sliding down a slope. The arrow IS the motion; nothing labels anything.',
      '',
      'Arrows are FORBIDDEN for labeling: do not draw arrows pointing from a text label to a scene part, or from a yellow callout to a scene part. Callouts float; they don\'t point.',
      '',
      '== AI_IMAGE_PROMPT — FORBIDDEN PHRASES (PREVENT LABELED-DIAGRAM OUTPUT) ==',
      '',
      'NEVER write ANY of these phrases inside `ai_image_prompt`:',
      '',
      '  • "labeled", "with a label", "with labels"',
      '  • "with an arrow pointing to", "arrows pointing to", "with arrows labeled"',
      '  • "text reading X", "with the words", "captioned with"',
      '  • "title at the top of the image", "heading inside the image" (the section title is rendered separately by the player)',
      '  • "diagram", "infographic", "schematic", "explanatory chart"',
      '  • "annotation", "annotated", "callout label pointing to"',
      '',
      'Callout-style text (time markers, statistics, names, emphasis phrases, scene labels like "AVALANCHE DANGER") goes to `on_screen_text` — the player renders it as a yellow bubble overlay ON TOP of the AI image. The AI image must not contain that text inside the picture.',
      '',
      'ALLOWED inside the picture: character speech bubbles (cartoon balloon with a short word like "Fascinating" or "Oh no") — these are scene content, not annotations. Incidental writing on props is fine too (squiggly mock-writing on a scroll, the colored cover of a book without a readable title). Real photographs that contain real text (a map with city names, a book cover) are also fine when used as a backdrop.',
      '',
      '== CHARACTER VARIETY ==',
      '',
      'The reference video uses a CAST of recurring character types — pick the one that fits the beat, not always the same lab-coat scientist:',
      '',
      '  • The Scientist / Narrator — stick figure with a soft-gray-fill lab coat, blue or red tie, round glasses with thin frames, defined eyebrows. The most common recurring narrator. Use for explanatory beats, dialogue beats, "fascinating" reactions.',
      '  • The Historian / Witness — older stick figure with gray hair and gray beard, holding a scroll or quill, sometimes in a brown robe. Use for historical-account beats.',
      '  • The Female / Distressed — stick figure with brown hair, slight pink tint to the eyes, sometimes with hair-strand detail. Use for victim / sufferer / generic-female beats (RAT-DRIVEN BLACK DEATH used this).',
      '  • The Bald Specialist — bald-headed stick figure with thick black sunglasses, an earring stud, a small goatee. Different from the scientist — used for "cool" or assertive narration beats (PRONUNCIATION BOOK COUNTDOWN).',
      '  • Generic Bystander — plain stick figure, no clothing detail, no facial accessories, just a circle head + line body. Use for crowds, anonymous groups, "unsuspecting people" reactions.',
      '  • The Mystery Figure — entirely-black silhouette with a ? mark for a head, or a black head with hidden features. Use for unidentified / suspicious / unknown subjects (THE BLACK-CLAD NINJA).',
      '  • The Astronaut / Specialist — stick figure with a simple white spacesuit, fishbowl helmet outline, blue or red badges. Use for space / aerospace beats.',
      '  • The Patient / Subject — stick figure in a gown, often in a context (hospital bed, lab table). Use for medical / experimental beats.',
      '',
      'Characters can have lightly-colored clothing (gray, blue, brown, red). Heads are doodle circles with a soft cream / pale gray interior fill — not pure white. Arms still END IN A LINE TIP, no anatomical hand (the reference keeps this rule even on detailed characters).',
      '',
      'Multiple characters in one frame is fine when the beat needs it — but cap it: 3-6 for a group beat, never 10+. Group them spatially (a tight cluster or an evenly-spaced row, not random scatter). Identical bystander figures lined up in a row is a real pattern (THE BLACK-CLAD NINJA).',
      '',
      '== BACKGROUND — VARY BY CONTENT ==',
      '',
      'Pure white is the DEFAULT for character-focused or dialogue beats. Other backgrounds are required for atmospheric / location / historical beats:',
      '',
      '  • Soft blue sky + green or brown ground — outdoor day scenes, anyone-on-Earth moments',
      '  • Dark blue with stars — space, night, distant astronomical events',
      '  • Gray clouds — danger, foreboding, atmospheric tension',
      '  • Gray walls / interior — corporate spaces, ISS interiors, sterile rooms',
      '  • Tan / brown — historical, paper, ancient',
      '  • A REAL PHOTOGRAPH as backdrop — a map, a portrait, a landscape — with cartoon elements drawn on top. Describe this in `ai_image_prompt` as e.g. "a real photograph of a medieval map of Europe fills the background, with a hand-drawn cartoon book sitting on top".',
      '',
      'Don\'t force every shot to pure white — monotonous pure-white outputs are the most common visual failure mode. The reference varies backgrounds heavily.',
      '',
      '== COLOR PALETTE — USE MULTIPLE COLORS PER FRAME ==',
      '',
      'Black-on-white only is NOT the style. The reference uses many colors at once:',
      '',
      '  • Saturated orange and red — fire, meteor trails, lava, blood, exclamation, danger',
      '  • Warm yellow — stars, sun rays, energy, light beams',
      '  • Pale-to-saturated blue — sky, water, ties, technology, cold',
      '  • Soft green — virus, plant, nature, biological',
      '  • Gray — clouds, smoke, hair, beard, lab-coat fill, walls, asphalt',
      '  • Brown / tan — paper, scrolls, ground, wood, ancient',
      '  • Pink — accent props (a magnifying glass handle, a feather quill)',
      '',
      'A typical reference frame uses 3-5 colors at once. Black ink is the OUTLINE; colors fill specific elements. Don\'t restrict to "one accent per row" — that\'s too austere.',
      '',
      '== ON_SCREEN_TEXT — TARGET ~35-45% OF NON-TITLE ROWS ==',
      '',
      'Yellow-bubble callouts are a core motif but not on every frame. Roughly 35-45% of non-title frames in the reference carry a yellow callout; the rest are pure illustration with just the section title at the top.',
      '',
      'Populate `on_screen_text` when the script content includes:',
      '  • A specific name being introduced ("Gervase of Canterbury", "Coronal Mass Ejection", "WannaCry")',
      '  • A specific time / date / duration ("In May 2017", "Within hours", "1054 AD")',
      '  • A number / quantity / statistic ("$4 billion", "9 hikers", "72 seconds")',
      '  • A short emphasis phrase (3-5 words tops, can be ALL CAPS: "NO WARNING", "SOLD OUT")',
      '  • A foreign / technical term needing reinforcement ("Subzero", "Hypothermia", "Stuxnet")',
      '',
      'Leave `on_screen_text` empty when the picture already tells the story — character-only reactions, atmospheric environment shots, recap grids. Yellow bubbles on every frame becomes wallpaper; selective use makes them land.',
      '',
      'Leave `on_screen_text_mode` undefined (it inherits the doc default of "overlay"). NEVER set it to "bake".',
      '',
      '== SECTION TITLE vs PER-ROW OST — DIFFERENT SLOTS ==',
      '',
      '  • The SECTION TITLE (set on title-card rows via `section_title` and inherited by every subsequent row in that section) renders as a bold black hand-drawn label at the TOP of every frame — like "WANNACRY" persisting across every shot in the WannaCry section. The player renders this; the AI image generator should NEVER include it.',
      '  • The PER-ROW `on_screen_text` is the YELLOW BUBBLE callout (mid-frame). Always overlay, never bake.',
      '',
      '== OVERLAY_STOCK_TERMS — ~30% OF NON-TITLE ROWS ==',
      '',
      'The reference video grounds storytelling in REAL evidence — actual photographs of locations, people, products, events — used in THREE patterns:',
      '',
      '  Pattern A: real photo as the FULL BACKGROUND, cartoon elements drawn on top. Use for historical / geographical context (a medieval map of Europe with a cartoon book on it, a real space photograph behind a cartoon scientist). Powerful for grounding a beat in a real place / time.',
      '',
      '  Pattern B: real photo inset inside a cartoon picture frame — a thick-bordered rectangle in a cartoon scene with the real photo composited inside. Use for "here\'s what that actually looked like" moments.',
      '',
      '  Pattern C: a grid of 4-6 real-photo thumbnails with short black captions under each. Use for recap shots ("the unsolved cases we covered").',
      '',
      'Populate `overlay_stock_terms` (target ~1 in 3 non-title rows) for:',
      '  • Real public figure → "<name> photograph" (e.g. "Gervase of Canterbury photograph", "Igor Dyatlov photograph")',
      '  • Real brand or product → "<brand> logo official PNG" or "<product> photograph"',
      '  • Real specific location → "<place> photograph" (e.g. "Dyatlov Pass mountains photograph", "Ural mountains photograph")',
      '  • Real software, app, website, UI → "<thing> screenshot"',
      '  • Real famous event with iconic imagery → "<event> photograph"',
      '  • Historical document / map / artifact → "<thing> photograph" (e.g. "medieval map of Europe")',
      '',
      'When `overlay_stock_terms` is populated, the `ai_image_prompt` should leave room for the real photo to land:',
      '  • For Pattern A: "[cartoon foreground description], with a real photograph of [thing] filling the background". The editor composites the real photo behind the cartoon foreground.',
      '  • For Pattern B: "[cartoon scene with] a thick-black-bordered rectangle on the wall, rectangle is empty white inside" — leaves a slot for the editor to drop the real photo.',
      '',
      'Always add a `notes` line so the editor knows what to composite where: "Composite: real photo of Dyatlov Pass mountains fills the empty rectangle on the right; black border."',
      '',
      '== VARIANT GROUPS — TARGET 1 PER 5-8 NON-TITLE ROWS (USE THEM AGGRESSIVELY) ==',
      '',
      'A variant group is 2-4 CONSECUTIVE rows sharing the same composition with subtle deltas — the "near-static animation" feel. The reference video uses this CONSTANTLY: the magnifying glass appears, then the red X is drawn over it; the character stands, then the question mark appears above their head, then they react; the sun is bright, then a sunspot appears, then the spot grows into a coronal mass ejection.',
      '',
      'USE a variant group whenever 2-4 consecutive script beats happen at the SAME visual moment / SAME composition. The trigger is broader than "reactive characters" — any sequence of beats describing one evolving scene works:',
      '',
      '  • Character standing still → small red question mark appears above their head → they react (eyebrows down, mouth open)',
      '  • An empty cartoon TV → crack lines appear on the screen → a red X is drawn over the cracked screen',
      '  • A scientist looking at a clean petri dish → a small green splotch appears → the splotch spreads into a full virus',
      '  • A bright yellow sun → a small dark sunspot appears → the spot grows into a coronal mass ejection',
      '  • A character holding a closed book → the book opens → a small icon appears on the open page',
      '  • A magnifying glass on a wall → a tiny crack appears below it → a red X is drawn over the crack',
      '  • Three bystanders looking calmly at the sky → their eyebrows raise → mouths drop open in shock',
      '',
      'Default to a variant group when the script has any sequence of 2+ beats describing one evolving moment. Variants cost ~$0.011 vs ~$0.04 for an independent row — CHEAPER and they make the video feel alive instead of static.',
      '',
      'How to emit a variant group:',
      '  • Pick a fresh `group_id` (any short stable string). Use the SAME `group_id` on every row in the group.',
      '  • The BASE row: `variant_index: 0`. Populate `ai_image_prompt` with the scene at rest (the neutral starting frame). The base goes through the regular i2i path against the bundled style refs.',
      '  • Variant rows: `variant_index: 1, 2, 3` (cap at 3 variants per group → 4 rows max). LEAVE `ai_image_prompt` EMPTY. Populate `variant_edit_prompt` with the SMALLEST POSSIBLE delta from the base. Good deltas:',
      '      "add a small red question mark floating above the figure\'s head, keep everything else identical"',
      '      "open the eyes wider into surprised oval shapes, mouth into a small O, keep everything else identical"',
      '      "add a small yellow lightbulb above the figure\'s head, keep everything else identical"',
      '      "draw a red X mark over the TV screen, keep everything else identical"',
      '      "add small snowflakes falling across the upper half of the frame, keep everything else identical"',
      '  • Bad `variant_edit_prompt`: re-describing the whole scene, asking for layout changes, asking for new background elements — those drift away from the base.',
      '  • Each variant row keeps its OWN `script_text` (one beat of narration), its OWN short `timecode`, and its OWN `on_screen_text` (yellow callout if any).',
      '  • Variant rows MUST be contiguous in the row list — no other rows interleaved between siblings of the same group.',
      '',
      'When NOT to use a variant group: the script moves to a DIFFERENT scene (different subject, different setting, different action). Those are standalone rows.',
      '',
      'Concrete JSON shape for a 3-row variant group (1 base + 2 variants). All other row fields work normally on each row:',
      '',
      '```json',
      '{',
      '  "timecode": "0:24",',
      '  "script_text": "She paused.",',
      '  "visual_type": "Animation",',
      '  "visual_description": "Close-up stick figure character standing still, arms by sides.",',
      '  "ai_image_prompt": "Close-up of a hand-drawn stick figure character facing the camera, arms by sides, neutral expression — small dot eyes, tiny mouth, head is an empty circle outline. Plain white background. [style suffix appended automatically.]",',
      '  "group_id": "rxn-pause-1",',
      '  "variant_index": 0',
      '}',
      ',',
      '{',
      '  "timecode": "0:25",',
      '  "script_text": "Her eyes widened.",',
      '  "visual_type": "Animation",',
      '  "visual_description": "Same composition as base; only the eyes change shape.",',
      '  "ai_image_prompt": "",',
      '  "group_id": "rxn-pause-1",',
      '  "variant_index": 1,',
      '  "variant_edit_prompt": "open the eyes wider into surprised oval shapes, keep everything else identical"',
      '}',
      ',',
      '{',
      '  "timecode": "0:26",',
      '  "script_text": "Then a frown.",',
      '  "visual_type": "Animation",',
      '  "visual_description": "Same composition; only the brows + mouth change.",',
      '  "ai_image_prompt": "",',
      '  "group_id": "rxn-pause-1",',
      '  "variant_index": 2,',
      '  "variant_edit_prompt": "drop the eyebrows downward in a frown and turn the mouth into a small downturned curve, keep everything else identical"',
      '}',
      '```',
      '',
      'Notice: only the BASE has a populated `ai_image_prompt`. Variant rows leave it empty and instead populate `variant_edit_prompt`. The editor\'s variant dispatcher composes the final prompt for the Atlas Edit model from both — you don\'t need to repeat scene description on variant rows.',
    ].join('\n'),
    allow_overlay_stock: true,
    origin: 'built-in',
    // The doodle-yellow LowerThird variant in src/remotion/components/LowerThird.tsx
    // is the visual treatment for this style's on-screen text. The renderer
    // already routes styleId=doodle_explainer_2 → variant='doodle-yellow'
    // (see SceneRouter in YouTubeVideo.tsx). For that LowerThird path to
    // fire, the OST mode has to be 'overlay' — otherwise the text is sent
    // to the diffusion prompt and the AI paints it directly into the image
    // (which is what the user saw when the doc default fell through to
    // 'bake': small black text in the image corner instead of the chunky
    // yellow bubble). Pinning the doc-level default here removes the need
    // for the LLM or the user to flip ~131 toggles by hand.
    default_on_screen_text_mode: 'overlay',
  },
  /**
   * Paint Explainer V1 — motion-driven sibling of doodle_explainer_2.
   *
   * Same hand-drawn aesthetic family (white canvas, wobbly black outlines,
   * big open red mouths, yellow comic-bold labels), but the renderer
   * treats each row as a static AI base + procedural motion overlays
   * rather than a static still. Variants come from code-driven Remotion
   * components animating layers on top of one base — no per-variant
   * re-generation — so the viewer reads each shot as one scene that
   * lives, not a sequence of redrawn frames that flicker.
   *
   * Three new ProductionRow fields drive this:
   *   - `character_id`      — recurring-character cache key
   *   - `shot_kind`         — 'static' | 'motion' | 'hard_cut'
   *   - `motion_beats[]`    — code-side overlays (mouth_swap, label_pop, …)
   *
   * Plus one doc-level field: `paint_explainer_v1_character_cache`.
   *
   * Full architecture, cost model, PR breakdown, settings audit, and
   * security plan live in
   * `_plans/2026-05-28-paint-explainer-v1-architecture.md`. The
   * upstream viability test that gated this plan is at
   * `_plans/2026-05-28-paint-explainer-v1-viability-test.md`.
   *
   * Phased delivery — DO NOT EXPECT FULL MOTION RENDERING UNTIL PR 5:
   *   - PR 1 (this entry): style registration + schema fields +
   *     atlas-mouth-removal helper. Renderer falls back to static behaviour
   *     for any row whose `shot_kind` is unset OR whose Remotion
   *     component isn't wired yet.
   *   - PR 2: <ScribbleDraw>, <LabelPopOn>, alignment-JSON viseme wiring.
   *   - PR 3: pacing (LLM emits 2× shot count) + hard cuts.
   *   - PR 4: real-photo cadence to 50% on factual rows.
   *   - PR 5: <PropSlideIn>, <MicroWiggle>, vision-pass anchor resolver.
   *   - PR 6: polish + optional retrofit onto doodle_explainer_2.
   *
   * Refs: borrowed from doodle_explainer_2's bundle (Atlas i2i caps at
   * 4 inputs). Curated for paint_explainer_v1: one close-up character
   * (mouth-swap target), one expressive full-body, one yellow-label
   * example, one framed-photo composite. Paint-Explainer-specific refs
   * can replace these later once the user curates a dedicated set.
   */
  {
    id: 'paint_explainer_v1',
    label: 'Paint Explainer V1',
    description: 'Motion-driven explainer modelled on the Paint Explainer YouTube genre — same hand-drawn family as Doodle Explainer 2, but each shot ships as a static base + Remotion procedural motion overlays (mouth-swap, label pop-on, prop slide-in, scribble draw-on) rather than a static still.',
    ai_image_suffix: [
      'Hand-drawn doodle in the Paint Explainer style — pure white canvas,',
      'thick uneven black ink outlines (intentional wobble, not vector-clean),',
      'flat fills only with no shading or texture, generous negative space.',
      'Stick-figure character anatomy: large round white head, simple oval-shape',
      'eyes (filled black), eyebrows as thin angled lines for emotion, big open',
      'red-interior mouth (deep red ~#E53E3E with thick black outline), stick',
      'limbs with rounded mitten hands and oval feet. Saturated accents used',
      'sparingly: goldenrod yellow for labels, sky blue for backgrounds, brown',
      'for period scenes, black-only for space. No gradients except on cosmic',
      'phenomena (sun, fire, explosions). No shadows on characters or props.',
      'No labelled diagrams. Single focal idea per frame. Real photos, when',
      'present, framed inside a thin black rounded-corner rectangle (~8px',
      'radius), never floating to the edge.',
      // 2026-05-29: BAKED TYPOGRAPHY block, mirroring the
      // doodle_explainer_2 suffix. Compensates for the loss of ref #09
      // (yellow "Highlight" typography) which was moved out after the
      // literal word bled into every output. See the matching note in
      // the doodle_explainer_2 ai_image_suffix.
      'BAKED TYPOGRAPHY: when the row\'s prompt asks for hand-lettered text',
      'in the scene (a baked OST string or motion_beats label_pop with',
      'render_baked), draw the EXACT characters supplied by the prompt — never',
      'substitute, paraphrase, or add filler text the prompt did not request.',
      'Render the requested characters in YELLOW COMIC-BOLD: thick saturated-',
      'yellow fill, surrounded by a black wobbly hand-drawn outline of consistent',
      'thickness, no shadow, no gradient, no other decoration. Glyphs sit on a',
      'slight irregular baseline (not perfectly straight) and have the same',
      'imperfect freehand quality as the rest of the illustration\'s lines. If',
      'the prompt does NOT request baked text, the scene contains NO baked',
      'words at all — speech bubbles for character dialogue are allowed;',
      'freestanding label words invented by the model are NOT.',
    ].join(' '),
    built_in_refs: [
      // Curated subset from doodle_explainer_2's bundle. Atlas i2i caps at 4
      // refs; the four picked here cover the four visual pillars of the
      // genre: character close-up (mouth swap target), expressive full body,
      // yellow-label typography, framed real-photo composition.
      // Swapped 2026-05-28: ref #01 (composite book + bloody painting) was
      // moved to _review-not-doodle-2/ after it bled into every doodle_2
      // output; #13 (framed real-photo pure centrifuges) carries the same
      // framed-photo pillar without the loud subject anchors.
      // Filenames updated 2026-05-28 in lockstep with the
      // doodle_explainer_2 ref refresh — same three slots (04, 09,
      // 13) were swapped for fresh style-neutral candidates generated
      // via Atlas t2i. paint_explainer_v1 shares the bundle so it
      // inherits the upgrades for free.
      //
      // Phase 1.6 (Bug 4): the framed-forest ref (13) was dropped from
      // BOTH styles in lockstep — paint_explainer_v1 inherited the
      // same content-bleed risk from sharing the bundle. See the
      // matching note in the doodle_explainer_2 catalog above for the
      // full reasoning.
      { filename: '14-close-up-character-face.jpg', mime_type: 'image/jpeg' },
      { filename: '04-stick-figure-neutral-pointing-no-hand.jpg', mime_type: 'image/jpeg' },
      // Ref #09 dropped 2026-05-29 in lockstep with doodle_explainer_2.
      // See the matching comment block in the doodle_explainer_2
      // built_in_refs above for the full rationale (bleed of literal
      // "Highlight" word; typography teaching moved into the suffix).
    ],
    // Refs above live under public/style-refs/Doodle-explainer-2/ (shared
    // with doodle_explainer_2). When a dedicated Paint-Explainer-v1 ref
    // bundle is curated, move these to public/style-refs/Paint-explainer-v1/
    // and update the loader resolution in `loadStyleReferences`.
    preferred_cloud_model: 'gpt-image-2-atlas-i2i',
    mixing_rules: [
      'This is the Paint Explainer V1 style — a sibling of Doodle Explainer 2 with the same hand-drawn aesthetic, but the renderer animates each shot through Remotion procedural overlays instead of generating per-variant still images. Treat every row as a static AI base + a list of motion_beats; the motion is what carries the shot.',
      '',
      'REFS TEACH STYLE, YOU INVENT SUBJECTS. The 4 reference images bundled with this style (shared with doodle_explainer_2) teach the model what the visual aesthetic LOOKS LIKE — line weight, character anatomy, framing, typography, and the framed-real-photo composition. They are NOT a menu of subjects to put in scenes. INVENT fresh subjects per beat from the script. If two consecutive shots feel like the same picture, the second one is wrong — change the camera, change the subject, change the composition. The viewer should never feel like they\'re watching the same picture restated.',
      '',
      'EXPLICIT PER-REF ROLES — read this carefully, refs have been a source of subject-bleed in past versions of the parent style:',
      '  • Ref #14 (close-up character face) teaches the FACE ANATOMY (slightly imperfect circle head, small dot eyes, raised eyebrows, small expressive mouth) and the close-up framing. It does NOT mean every scene is a head-and-shoulders close-up. The actual character + expression + framing comes from the script.',
      '  • Ref #04 (stick figure neutral pointing, no hand) teaches the BODY ANATOMY + the no-hand rule (arms end in line tips, never anatomical hands). It does NOT mean every scene shows a single character pointing. The pose, the action, the number of characters all come from the script.',
      // Ref #09 description removed 2026-05-29 in lockstep with
      // doodle_explainer_2. See the matching note there. Typography
      // teaching moved into the suffix; on_screen_text and
      // motion_beats.label_pop continue to drive label text.
      '  • Ref #13 (sunlit forest in a framed black rounded rectangle) teaches the FRAMED-REAL-PHOTO COMPOSITION — a wobbly thin black rounded-rectangle frame containing a real photo. It does NOT mean forests should appear in scenes. The photo subject is whatever the script\'s scene is actually about — a person, a building, a football stadium, a lab interior, a city street, a vintage object, ANYTHING the narration calls for. The forest in the ref is a placeholder. Treat it as a stand-in for "the relevant real photograph for THIS beat."',
      '',
      'PACING — Target median shot length 2.5–3.0 seconds. For a 5-minute video that means ~100–120 rows, roughly double the row count of a Doodle Explainer 2 doc on the same script. This is the SINGLE most important rule for matching the genre — slower pacing reads as "explainer" instead of "Paint Explainer."',
      '',
      'PACING SELF-CHECK — Before you finish: (a) count your rows. For a 5-min script, < 80 rows means your shots are too long — go back and split. A row that says "Captain Briggs left New York on November 7, 1872 carrying 1,700 barrels of denatured alcohol" should be TWO rows: the leaving-New-York beat and the cargo-detail beat. (b) Scan your timecodes. If you see any shot > 5 seconds and it isn\'t a held title card / recap grid, split it. (c) Verify rhythm variety — don\'t make every shot 2.7s exactly; mix short punches (1.5–2s) with breathing shots (3–4s) around the 2.75s median.',
      '',
      'CHARACTERS — The narrator-mascot is the recurring centerpiece. Identify it on the first row it appears and set `character_id: "explainer-base"` (or another stable slug if the script names them). Reuse the SAME `character_id` on every subsequent row that shows the same character. The image-gen pipeline keys a per-video cache by this id so the base + mouth-removed pair gets generated once and reused. Named guests get their own ids (e.g. `character_id: "napoleon"`). Rows without a recurring character leave `character_id` undefined.',
      '',
      'SHOT KIND — Three values, each with a clear purpose:',
      '  • `shot_kind: "motion"` — character rows where motion_beats are emitted. The renderer mounts <MotionScene> which composites mouth-swap / label-pop / scribble-draw / real-photo-punch beats. Use on every character-with-narration row.',
      '  • `shot_kind: "hard_cut"` — the FIRST row of a new topic / beat / segment. The renderer disables the cross-fade entirely so this row snaps into view, which reads as "new thought" instead of "continuation of last thought." Use on:',
      '       - first row of a new section after a title card',
      '       - the row where the narrative pivots ("But then…", "The most likely explanation came much later…", "Here\'s where it gets weird.")',
      '       - any moment where the on-screen subject changes completely (close-up character → wide environment shot, or one named character → a different named character)',
      '     The cross-fade default is ~250 ms of dissolve — slow enough that pivots feel like the previous thought is bleeding into the next. The genre default is a snap cut on pivots; explicit `hard_cut` is how you get it.',
      '  • `shot_kind: "static"` (or undefined) — held title cards, full-bleed real photos, section dividers, recap grids. Anything where the renderer\'s default Ken-Burns-or-still path is the right behaviour.',
      '',
      'HARD CUT CADENCE — Aim for roughly 1 in 4 to 1 in 6 rows being a hard cut. Too few and the video reads as one continuous breath; too many and the snap-cut intensity stops registering. Cluster hard cuts around the script\'s actual narrative pivots, not on every row mechanically.',
      '',
      'MOTION BEATS — Emit `motion_beats[]` on rows where the renderer should animate. Cap at 8 beats per row (server-side enforced). Kinds:',
      '  • `mouth_swap` — character talking; renderer cycles closed/mid/open mouth states. Use when the row has a character speaking. Beat covers the row\'s talking duration. Anchor is auto-mouth (the renderer calibrates).',
      '  • `scribble_draw` — base image reveals as a stroke-by-stroke drawing-in-progress. Use for "this is the thing being explained" reveal moments. Typical duration 1000–1500ms.',
      '  • `label_pop` — yellow comic-bold bubble label scale-pops on for emphasis. `payload.text` is the word/phrase. Anchor is `auto-eyes` (above the character) OR a specific xPct/yPct on environment shots.',
      '  • `prop_slide` — separate transparent prop slides in from offscreen. `payload.propPromptHint` describes the prop for the image-gen pipeline to generate ahead of render.',
      '  • `micro_wiggle` — ambient transform on character body, runs continuously during character shots when no other motion is active.',
      '  • `real_photo_punch` — real photo composited inside the thin black rounded frame, punches in with overshoot.',
      '',
      'REAL-PHOTO MIX — Target ~50% of factual rows carrying a real-photo overlay. (Doodle Explainer 2 targets a lower floor of ~1 real-photo beat per 8-12 rows; Paint Explainer V1 leans more heavily on real photos to match competitor channels in this genre.) Trigger `overlay_stock_terms` on EVERY named person, place, brand, product, or event in the script. NEVER skip a named entity.',
      '',
      'REAL-PHOTO SELF-CHECK — Before you finish, walk the script once and list every PROPER NOUN: every person, every place, every brand, every product, every dated event, every named historical artifact. Now scan your rows: did each of those proper nouns get either `overlay_stock_terms` on the row where it\'s introduced OR a `real_photo_punch` motion beat? If you missed any — go back and add. A 5-minute script about real history with no real photos is the single most common cadence failure on this style.',
      '',
      'TWO WAYS to surface a real photo (use the right one for the row):',
      '  • `overlay_stock_terms: "<query>"` on the ROW. Use for STATIC / hard-cut rows where the photo is the row\'s primary visual focal point for the full duration of the row (full-frame background OR a held framed photo). The renderer fetches the photo via the existing stock pipeline and composites with the polaroid frame automatically.',
      '  • `motion_beats: [{kind: "real_photo_punch", startMs, durationMs}]` on a MOTION row. Use for character rows where the photo punches in for a moment of emphasis (e.g. the narrator says "Captain Briggs" and the polaroid pops on next to the character for 2 seconds, then disappears). The renderer pulls the photo URL from the row\'s `overlay_stock_terms` automatically — don\'t duplicate.',
      '',
      'CONCRETE EXAMPLE — narrator-mascot says "The ship was the Mary Celeste":',
      '  {',
      '    "timecode": "0:32",',
      '    "character_id": "explainer-base",',
      '    "shot_kind": "motion",',
      '    "ai_image_prompt": "[narrator stick figure pointing right at empty space]",',
      '    "overlay_stock_terms": "Mary Celeste ship photograph 1872",',
      '    "motion_beats": [',
      '      {"kind": "mouth_swap", "startMs": 0, "durationMs": 2000},',
      '      {"kind": "real_photo_punch", "startMs": 600, "durationMs": 1800, "anchor": {"kind": "specific", "xPct": 75, "yPct": 50}}',
      '    ]',
      '  }',
      '',
      'PATTERNS — Pattern A is a full real-photo background with cartoon foreground (one stick figure or one small cartoon prop on top of the photo). Pattern B is a framed real photo inset inside a doodle scene; the renderer composites with the thin black rounded frame automatically when style is paint_explainer_v1.',
      '',
      'PHOTO SUBJECT — The subject of every real photo must come from the script content. Ref #13 (sunlit forest) is the style anchor for the framed-photo COMPOSITION, but the forest is a PLACEHOLDER. Do NOT default to forests. The photo on each real-photo row must match what the narration is about: a person\'s headshot when the script names a person, a stadium when the script mentions one, a lab interior for a research scene, a vintage object when the script references a specific era. Treat ref #13 as "this is what the frame looks like and where the photo sits"; the photo itself comes from the script.',
      '',
      'AI IMAGE PROMPT — Same rules as Doodle Explainer 2: pure stick-figure doodle, no labelled diagrams, no baked-in text, white background, leave empty space where real-photo overlays will land. The general doodle stick-figure look STAYS DOMINANT — realism is additive texture from real-photo overlays and from specific prop naming (below), not a switch to a different drawing style.',
      '',
      'SPECIFIC NAMED PROPS — When the script calls for a prop, NAME the specific real-world referent in the `ai_image_prompt`. Generic shapes feel like stock clipart; named specific objects feel deliberate.',
      '  BAD (generic): "a phone", "a notebook", "a car", "a weapon", "a camera"',
      '  GOOD (specific): "a Bakelite rotary phone with a coiled black cord", "a yellow legal pad with handwritten notes in blue ballpoint", "a 1973 olive-green Pontiac", "a Colt 1911 service pistol", "a Polaroid SX-70 instant camera"',
      'The prop is STILL DRAWN IN THE DOODLE STYLE — thick wobbly black ink outlines, flat color fills, no photorealism. The specific name just lets the LLM draw a recognizable doodle of THAT object instead of a generic shape. Apply when the prop carries narrative weight (the camera lingers >0.5s on it). Stay generic for background dressing. Match period to the script\'s temporal context (1970s scenes get rotary phones, not iPhones).',
      '',
      'PHASED ROLLOUT — Until PR 5 ships, the renderer may not yet support every motion_beats kind. Unrecognised kinds are skipped silently (the row still renders the static base + Ken Burns as before). Emit motion_beats anyway — they serve as forward-compatible production-doc data.',
    ].join('\n'),
    allow_overlay_stock: true,
    origin: 'built-in',
    // Same yellow-bubble LowerThird visual as doodle_explainer_2 — the
    // renderer's existing variant='doodle-yellow' branch in SceneRouter
    // is style-agnostic on the OST mode, so paint_explainer_v1 inherits
    // it for free as long as default_on_screen_text_mode is 'overlay'.
    default_on_screen_text_mode: 'overlay',
  },
]);

const BUILT_IN_BY_ID = new Map<string, ResolvedStyle>(BUILT_IN_STYLES.map((s) => [s.id, s]));

/** Look up a built-in style by id. Returns null for unknown ids. */
export function getBuiltInStyle(id: string): ResolvedStyle | null {
  return BUILT_IN_BY_ID.get(id) ?? null;
}

/**
 * Load every built-in + every saved style visible to the caller, in a
 * single list: built-ins first (registry order), then saved styles
 * (most-recently-updated first).
 *
 * Visibility rules (v2, migration 0080):
 *   - `draft = false` always — drafts are in-progress styles still in
 *     the editor; they must not appear in pickers anywhere else.
 *   - Workspace-wide styles (`owner_id IS NULL`) are always visible to
 *     every workspace member.
 *   - Owner-private styles (`owner_id IS NOT NULL`) are only visible to
 *     the matching collaborator. Pass `ownerId = session.uid` to
 *     include the current user's private styles; omit / pass null to
 *     show workspace-wide only (back-compat with v1 callers).
 */
export async function listAllStyles(
  workspaceId: string,
  ownerId?: string | null,
): Promise<ResolvedStyle[]> {
  // Two-arg branch: when ownerId is supplied, the predicate becomes
  // `(owner_id IS NULL OR owner_id = ownerId)`. When omitted, only
  // workspace-wide styles (owner_id IS NULL) are returned. Splitting
  // the queries keeps each predicate a static template literal — the
  // `@vercel/postgres` `sql` tag composes badly with conditional
  // sub-expressions, and the duplication is two lines.
  const { rows } = ownerId
    ? await sql<SavedStyleRow>`
        SELECT id, workspace_id, name, description,
               ai_image_suffix, mixing_rules, allow_overlay_stock,
               based_on_built_in, created_by, created_at, updated_at,
               owner_id, draft, approved_at, version,
               style_prompt, preferred_cloud_model
        FROM production_doc_styles
        WHERE workspace_id = ${workspaceId}
          AND draft = FALSE
          AND (owner_id IS NULL OR owner_id = ${ownerId})
        ORDER BY updated_at DESC
      `
    : await sql<SavedStyleRow>`
        SELECT id, workspace_id, name, description,
               ai_image_suffix, mixing_rules, allow_overlay_stock,
               based_on_built_in, created_by, created_at, updated_at,
               owner_id, draft, approved_at, version,
               style_prompt, preferred_cloud_model
        FROM production_doc_styles
        WHERE workspace_id = ${workspaceId}
          AND draft = FALSE
          AND owner_id IS NULL
        ORDER BY updated_at DESC
      `;
  const saved: ResolvedStyle[] = rows.map(savedRowToResolved);
  return [...BUILT_IN_STYLES, ...saved];
}

/**
 * Resolve a style id (built-in or saved) into the full payload the
 * prompt builder expects. Returns null if the id matches neither, or
 * if the saved style is invisible to this caller (different owner) —
 * the caller should treat that as "no style" rather than failing the
 * generation.
 *
 * Draft rows are NEVER returned by this function. The editor reads
 * drafts via a dedicated path (`getDraftStyle`) — every other surface
 * sees only saved styles.
 */
export async function resolveStyle(
  id: string | null | undefined,
  workspaceId: string,
  ownerId?: string | null,
): Promise<ResolvedStyle | null> {
  if (!id) return null;
  const builtIn = BUILT_IN_BY_ID.get(id);
  if (builtIn) return builtIn;

  const { rows } = ownerId
    ? await sql<SavedStyleRow>`
        SELECT id, workspace_id, name, description,
               ai_image_suffix, mixing_rules, allow_overlay_stock,
               based_on_built_in, created_by, created_at, updated_at,
               owner_id, draft, approved_at, version,
               style_prompt, preferred_cloud_model
        FROM production_doc_styles
        WHERE id = ${id} AND workspace_id = ${workspaceId}
          AND draft = FALSE
          AND (owner_id IS NULL OR owner_id = ${ownerId})
        LIMIT 1
      `
    : await sql<SavedStyleRow>`
        SELECT id, workspace_id, name, description,
               ai_image_suffix, mixing_rules, allow_overlay_stock,
               based_on_built_in, created_by, created_at, updated_at,
               owner_id, draft, approved_at, version,
               style_prompt, preferred_cloud_model
        FROM production_doc_styles
        WHERE id = ${id} AND workspace_id = ${workspaceId}
          AND draft = FALSE
          AND owner_id IS NULL
        LIMIT 1
      `;
  return rows[0] ? savedRowToResolved(rows[0]) : null;
}

/**
 * Fetch a draft style for the editor — bypasses the `draft=false` filter
 * `resolveStyle` enforces. Use this ONLY from the style editor UI; every
 * other consumer should go through `resolveStyle`.
 *
 * Returns null if the row doesn't exist or the caller doesn't own it.
 * Workspace-wide drafts are not a concept (drafts are always owned).
 */
export async function getDraftStyle(
  id: string,
  workspaceId: string,
  ownerId: string,
): Promise<ResolvedStyle | null> {
  const { rows } = await sql<SavedStyleRow>`
    SELECT id, workspace_id, name, description,
           ai_image_suffix, mixing_rules, allow_overlay_stock,
           based_on_built_in, created_by, created_at, updated_at,
           owner_id, draft, approved_at, version,
           style_prompt, preferred_cloud_model
    FROM production_doc_styles
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND owner_id = ${ownerId}
    LIMIT 1
  `;
  return rows[0] ? savedRowToResolved(rows[0]) : null;
}

/**
 * Guard for mutating endpoints (PATCH / DELETE / refs upload).
 *
 * A style is mutable by:
 *   - its owner (`owner_id = userId`), OR
 *   - any workspace member if it's workspace-wide (`owner_id IS NULL`)
 *
 * Returns the row when the guard passes; throws a tagged error
 * otherwise so the API layer can map it to the right HTTP status
 * (404 vs 403).
 */
export async function assertStyleOwnership(
  styleId: string,
  workspaceId: string,
  userId: string,
): Promise<SavedStyleRow> {
  const { rows } = await sql<SavedStyleRow>`
    SELECT id, workspace_id, name, description,
           ai_image_suffix, mixing_rules, allow_overlay_stock,
           based_on_built_in, created_by, created_at, updated_at,
           owner_id, draft, approved_at, version,
           style_prompt, preferred_cloud_model
    FROM production_doc_styles
    WHERE id = ${styleId} AND workspace_id = ${workspaceId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    const err = new Error(`Style ${styleId} not found in workspace ${workspaceId}`);
    (err as Error & { code?: string }).code = 'STYLE_NOT_FOUND';
    throw err;
  }
  const row = rows[0];
  // Draft + workspace-wide is forbidden state. Schema-side CHECK
  // (migration 0081) makes it impossible, but defense-in-depth here
  // makes the contract explicit and survives any future migration
  // that relaxes the CHECK. Treats it as 404 (not 403) so the
  // existence of a malformed row isn't leaked.
  if (row.draft && row.owner_id === null) {
    const err = new Error(`Style ${styleId} is in an invalid draft state`);
    (err as Error & { code?: string }).code = 'STYLE_NOT_FOUND';
    throw err;
  }
  // Owner-private: only the owner can mutate. Drafts are ALWAYS
  // owner-private (enforced above), so the same check covers
  // "another user can't grab my in-progress draft via PATCH"
  // (which was the original IMPORTANT finding from QA).
  // Workspace-wide (owner_id IS NULL): any workspace member can
  // mutate, matching the legacy v1 behaviour for shared styles.
  if (row.owner_id !== null && row.owner_id !== userId) {
    const err = new Error(`Style ${styleId} is private to another user`);
    (err as Error & { code?: string }).code = 'STYLE_FORBIDDEN';
    throw err;
  }
  return row;
}

function savedRowToResolved(row: SavedStyleRow): ResolvedStyle {
  return {
    id: row.id,
    label: row.name,
    description: row.description ?? undefined,
    ai_image_suffix: row.ai_image_suffix,
    mixing_rules: row.mixing_rules ?? undefined,
    allow_overlay_stock: row.allow_overlay_stock,
    origin: 'saved',
    style_prompt: row.style_prompt ?? undefined,
    preferred_cloud_model: row.preferred_cloud_model ?? undefined,
    version: row.version,
    approved_at: row.approved_at ?? undefined,
    owner_id: row.owner_id ?? undefined,
    based_on_built_in: row.based_on_built_in ?? undefined,
  };
}
