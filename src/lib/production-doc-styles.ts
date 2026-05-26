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
    // override via PATCH. Updated 2026-05-24: NanoBanana Pro retired
    // in favour of NanoBanana 2 (Gemini 3.1 Flash, cheaper + faster
    // + 14 refs vs 8). Same `image_input` field shape.
    preferred_cloud_model: 'nano-banana-2-i2i',
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
      'FORBIDDEN: textbook-style labeled diagrams — do NOT draw arrows pointing to written labels that name parts of the scene ("Huge Slab of Snow", "Dangerous Slope", "Unsuspecting Campers"). That kind of annotation is a chart, not a story panel. Captions, scene labels, and time stamps are rendered SEPARATELY on top by the player as yellow bubble overlays — the picture itself should not contain those annotations. Speech bubbles for character dialogue ARE allowed (e.g. a character saying "Fascinating" in a cartoon balloon). NOT photorealistic, NOT 3D rendered, NOT anime, NOT manga.',
    built_in_refs: [
      { filename: '01-composite-cartoon-book-with-framed-real-photo.jpg', mime_type: 'image/jpeg' },
      { filename: '02-pure-illustration-cartoon-building-pale-blue.jpg',  mime_type: 'image/jpeg' },
      { filename: '03-lone-stick-figure-frowning.jpg',                    mime_type: 'image/jpeg' },
      // #04 + #10 swapped 2026-05-25 from generic character poses to
      // raised-arm-no-hand frames after the first test render produced
      // a giant detailed waving hand. The model's prior for "waving =
      // anatomical hand" overrode the text negatives — only a visual
      // ref of the no-hand pose actually overrides it.
      { filename: '04-stick-figure-raised-arm-no-hand-angry.jpg',         mime_type: 'image/jpeg' },
      { filename: '05-color-composition-globe-with-computer-callouts.jpg',mime_type: 'image/jpeg' },
      { filename: '06-object-network-laptops-arrows.jpg',                 mime_type: 'image/jpeg' },
      { filename: '07-icon-composition-tv-with-deleted-files-x.jpg',      mime_type: 'image/jpeg' },
      { filename: '08-framed-real-photo-inside-cartoon-tv.jpg',           mime_type: 'image/jpeg' },
      { filename: '09-yellow-bubble-text-standalone-within-hours.jpg',    mime_type: 'image/jpeg' },
      { filename: '10-stick-figure-raised-arm-no-hand-calm.jpg',          mime_type: 'image/jpeg' },
      { filename: '11-yellow-text-overlaid-on-globe-scene.jpg',           mime_type: 'image/jpeg' },
      { filename: '12-stick-figure-single-red-accent.jpg',                mime_type: 'image/jpeg' },
      { filename: '13-framed-real-photo-pure-centrifuges.jpg',            mime_type: 'image/jpeg' },
      { filename: '14-close-up-character-face.jpg',                       mime_type: 'image/jpeg' },
    ],
    // Same i2i model as Doodle Explainer — nano-banana-2-i2i takes 14
    // refs (vs Atlas I2I's 4-ref ceiling). Atlas is cheaper per image
    // but the motif breadth here needs more than 4 anchors.
    preferred_cloud_model: 'nano-banana-2-i2i',
    mixing_rules: [
      '== STYLE REFERENCE: PAINT EXPLAINER ==',
      '',
      'Frame samples from the reference video live in hiccup-analysis/paint-ref/. Every rule below is reverse-engineered from those frames — not theoretical. visual_type defaults to "Animation".',
      '',
      '== VARIANT GROUPS — REQUIRED, NOT OPTIONAL (READ THIS FIRST) ==',
      '',
      'This is the SINGLE MOST IMPORTANT instruction in this style. The "near-static animation" feel is what makes the reference video feel alive — the magnifying glass appears, then a red X is drawn over it; the sun is bright, then a small sunspot appears, then the spot grows; the character stands neutral, then a question mark appears above their head, then their eyebrows shoot up.',
      '',
      'HARD COUNT REQUIREMENT — the doc MUST contain variant groups at this rate:',
      '  • Docs of 30-60 rows total → at least 4 variant groups',
      '  • Docs of 60-100 rows total → at least 7 variant groups',
      '  • Docs of 100+ rows total → at least 10 variant groups',
      '',
      'If you finish the doc with FEWER variant groups than that, re-read the script and find sequences you missed. Variant groups are CHEAPER per row than independent rows (~$0.011 vs ~$0.04 via Atlas Edit) so they\'re a strict win even if you\'re uncertain.',
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
      '== CORE PRINCIPLE: SIMPLE, COLORFUL, FLEXIBLE, BALANCED ==',
      '',
      'The reference style is SIMPLE drawings (not detailed illustration), COLORFUL (multi-color per frame), and FLEXIBLE (composition adapts to the beat). Be open-minded — sometimes one character, sometimes a group; sometimes white background, sometimes a colored sky or a real photo backdrop; sometimes a close-up portrait, sometimes a wide landscape. There is NO single template. The constant is: hand-drawn-feeling lines, soft color fills, generous breathing room, the beat\'s ONE focal idea clear.',
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
  };
}
