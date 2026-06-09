/**
 * Registry of thumbnail-page visual styles.
 *
 * This is intentionally separate from the production-doc style registry
 * at `src/lib/production-doc-styles.ts`. Although the two share visual
 * vocabulary (the doodle-explainer family lives in both), they have
 * different consumers (one is YouTube thumbnails, one is per-row video
 * frames), different model providers (this lane is Kie GPT Image 2 t2i;
 * production-doc is Atlas i2i), and different prompt shapes (here the
 * hook text is the focal element; there the row narration is). A shared
 * registry would couple two divergent codepaths through a single type;
 * keeping them parallel lets each evolve.
 *
 * Architecture / rollout plan:
 *   `_plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md`.
 */

export interface ThumbnailStyle {
  /** Stable slug. Persisted in user settings and in
   *  `DoodleExplainerHistoryPayload.styleId`. Renaming is a breaking
   *  change; add a new style instead. */
  id: string;
  /** Human-readable label shown in the style picker. */
  label: string;
  /** One-paragraph description. Surfaced under the picker as a hint. */
  description: string;
  /** Suffix glued onto every image-gen prompt under this style. Carries
   *  the entire visual contract — line weight, color rules, character
   *  anatomy, framing, typography. For t2i models (no refs) this IS the
   *  style; for i2i models it complements the ref bundle. */
  ai_image_suffix: string;
  /** Optional curated ref bundle for i2i models. Filenames relative to
   *  `public/style-refs/<style-folder>/`. Empty / undefined for t2i-only
   *  styles like the current paint-explainer doodle entry. */
  built_in_refs?: Array<{ filename: string; mime_type: string }>;
  /** Folder under `public/style-refs/` that holds `built_in_refs`.
   *  Required when `built_in_refs` is set. */
  refs_folder?: string;
  /** Default image model id (matches `MODEL_MAP` keys in
   *  `src/app/api/thumbnails/image/route.ts` and `IMAGE_MODELS` on the
   *  thumbnails page). Used when the user hasn't overridden the model
   *  for this style. */
  preferred_image_model: string;
  /** Default text-overlay style preset id (matches `STYLE_PRESETS` ids
   *  on the thumbnails page). The doodle style ships with
   *  `bold-impact` because the hook text in the reference channel is
   *  always thick wobbly hand-lettered bold. */
  preferred_text_style_preset?: string;
  /** Character expressions the style supports as a structured input.
   *  Only the doodle / paint-explainer family uses this today. Other
   *  styles that emerge from cinematic / photo references won't have
   *  a character-expression axis and leave this undefined. */
  supported_character_expressions?: string[];
  /** Background scene presets offered by the style's panel. The user
   *  can also pick "custom" and type a free-text scene. */
  supported_background_scenes?: Array<{ id: string; label: string; promptHint: string }>;
}

const PAINT_EXPLAINER_V1_DOODLE_SUFFIX = [
  // Visual contract — mirrors the paint_explainer_v1 production-doc
  // suffix at src/lib/production-doc-styles.ts:1196-1227 but tuned for
  // 16:9 thumbnails where the hook text is the focal element, not a
  // beat-level label. Kie GPT Image 2 t2i is text-only (no refs), so
  // every signal that anchors the style has to live in this string.
  'Hand-drawn doodle thumbnail in the Paint Explainer YouTube style — pure white or single-flat-color background (white, sky blue, brown cave, deep black space, or underwater blue depending on the scene), 16:9 horizontal composition.',
  'Thick uneven black ink outlines (intentional hand-drawn wobble, NOT vector-clean), flat fills only with absolutely no shading or texture, generous negative space.',
  'Stick-figure character anatomy: large round white head, simple oval-shape eyes (filled black), thin angled eyebrows that carry the emotion, expressive open red-interior mouth (deep red ~#E53E3E with thick black outline), stick limbs with rounded mitten hands and oval feet. Show ONE clear emotion on the face — confused, worried, surprised, deadpan, curious — never neutral.',
  'Saturated accent colors used sparingly: goldenrod yellow for hook text, sky blue for bright scenes, brown for period / cave scenes, black for space, deep red for character mouth interior. NO gradients except on natural phenomena (sun, fire, explosions, lava, ocean depth). NO drop shadows on characters or props. NO photorealism.',
  'HOOK TYPOGRAPHY (the most important element of the thumbnail) — render the supplied hook phrase EXACTLY as given, never substitute or paraphrase. Style: THICK saturated-yellow comic-bold fill, surrounded by a chunky wobbly hand-drawn black outline of consistent thickness, NO drop shadow, NO gradient, NO 3D extrusion, NO other decoration. Glyphs sit on a slight irregular baseline (not perfectly straight) with the same imperfect freehand quality as the line work. Hook text takes 25-40% of the frame, positioned for maximum first-glance readability at YouTube thumbnail size (320px wide). Sometimes the hook is a single dominant word, sometimes a 2-3 word phrase — match the layout to the count.',
  'COMPOSITION — One focal idea per thumbnail. Either character-on-left + hook-on-right, character-centered + hook-above-or-below, or split-scene with a red arrow callout pointing at the subject. Pick whichever frames the hook strongest. The viewer must understand the curiosity gap at a glance — that is the entire purpose of this style.',
  'EXTRAS the style allows: a single red arrow pointing at the subject (thick wobbly outline, flat red fill), small simple props relevant to the topic (a rock, a banana peel, a hammock, a question mark), real photos framed inside a wobbly thin black rounded-rectangle (~8px radius corners, never floating to the edge).',
  'EXTRAS the style FORBIDS: labelled diagrams, dense small text outside the hook phrase, drop shadows, photorealism, vector-perfect lines, neon glow, glassmorphism, gradients on character / props, more than one character unless the topic explicitly requires it (e.g. comparison thumbnails), background scenery that competes with the hook for attention.',
].join(' ');

export const THUMBNAIL_STYLES: ThumbnailStyle[] = [
  {
    id: 'paint_explainer_v1_doodle',
    label: 'Doodle Explainer',
    description: 'Hand-drawn doodle character + big bold yellow hook word on a clean background. Modelled on the Paint Explainer YouTube genre (high-contrast curiosity-gap thumbnails like @Zenn0009).',
    ai_image_suffix: PAINT_EXPLAINER_V1_DOODLE_SUFFIX,
    // T2i-only today — Kie GPT Image 2 t2i doesn't take refs. The fresh
    // bundle the user curates from the Zenn0009 channel will live at
    // public/style-refs/Paint-explainer-thumbnails/ and feed an i2i
    // fallback when one is added (Phase 2 follow-up). Until then the
    // suffix above carries the full visual contract.
    refs_folder: 'Paint-explainer-thumbnails',
    preferred_image_model: 'gpt-image-2-t2i',
    preferred_text_style_preset: 'bold-impact',
    supported_character_expressions: [
      'confused',
      'worried',
      'deadpan',
      'surprised',
      'curious',
      'shocked',
      'thinking',
      'overwhelmed',
    ],
    supported_background_scenes: [
      { id: 'plain-white', label: 'Plain white', promptHint: 'pure white canvas background, no scenery' },
      { id: 'sky', label: 'Sky / outdoors', promptHint: 'flat sky-blue background, maybe a small sun, no clouds detail' },
      { id: 'cave', label: 'Cave / prehistoric', promptHint: 'brown cave wall background with a small campfire glow in one corner' },
      { id: 'space', label: 'Space', promptHint: 'flat black space background with a few simple white star dots, optional small planet' },
      { id: 'underwater', label: 'Underwater', promptHint: 'deep blue underwater background with a few simple bubbles' },
      { id: 'inside-room', label: 'Inside a room', promptHint: 'minimal indoor scene, one wall line and a floor line, no furniture detail unless plot-relevant' },
      { id: 'custom', label: 'Custom scene', promptHint: '' },
    ],
  },
];

/**
 * Resolve a style by id. Returns `undefined` for unknown ids so the
 * caller can decide whether to fall back to a default or surface an
 * error — this lets old history entries with a since-removed style
 * still render through a fallback path instead of crashing.
 */
export function resolveThumbnailStyle(id: string | undefined | null): ThumbnailStyle | undefined {
  if (!id) return undefined;
  return THUMBNAIL_STYLES.find(s => s.id === id);
}

/** Default style id used when no user setting / payload override is
 *  present. Today this is the only style in the registry, but the
 *  constant exists so the default isn't hardcoded across the codebase. */
export const DEFAULT_THUMBNAIL_STYLE_ID = 'paint_explainer_v1_doodle';
