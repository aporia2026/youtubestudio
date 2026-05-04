/**
 * Built-in visual styles for the Production Doc generator.
 *
 * A style is more than a one-line suffix — it can also carry mixing rules
 * that teach the model when to populate a per-row `overlay_stock_terms`
 * field so the editor can composite real assets (logos, screenshots,
 * photos) on top of the AI-generated visual in post.
 *
 * This file is intentionally pure (no DB imports) so it's safe to import
 * from both server routes and client components.
 */

export interface ResolvedStyle {
  /** Stable id used by the picker, history entries, and schedule metadata. */
  id: string;
  /** Human label shown to the user. */
  label: string;
  /** Suffix appended verbatim to every AI image prompt. */
  ai_image_suffix: string;
  /** Free-form rules injected into the system prompt — optional. */
  mixing_rules?: string;
  /** True if rows may populate `overlay_stock_terms` for editor composites. */
  allow_overlay_stock: boolean;
}

export const BUILT_IN_STYLES: readonly ResolvedStyle[] = Object.freeze([
  {
    id: 'cinematic',
    label: 'Cinematic',
    ai_image_suffix:
      'cinematic live-action photography, dramatic lighting, anamorphic lens, movie-grade color grading, film grain, 8K quality',
    allow_overlay_stock: false,
  },
  {
    id: 'animation_2d',
    label: '2D Animation',
    ai_image_suffix:
      '2D flat vector animation style, vibrant saturated colors, clean crisp outlines, motion-graphics aesthetic, NOT photorealistic, NOT a photograph',
    allow_overlay_stock: false,
  },
  {
    id: 'animation_3d',
    label: '3D Animation',
    ai_image_suffix:
      '3D CGI render, Blender/Cinema4D quality, studio lighting, smooth shading, high-poly models, NOT photorealistic photography',
    allow_overlay_stock: false,
  },
  {
    id: 'documentary',
    label: 'Documentary',
    ai_image_suffix:
      'documentary photography, handheld camera feel, natural available light, authentic candid moment, journalistic realism',
    allow_overlay_stock: false,
  },
  {
    id: 'stock',
    label: 'Stock Photo',
    ai_image_suffix:
      'professional stock photo, clean commercial photography, bright natural lighting, sharp focus, Getty/Shutterstock quality',
    allow_overlay_stock: false,
  },
  {
    id: 'tech',
    label: 'Tech / SaaS',
    ai_image_suffix:
      'dark UI background, neon glow accents, cyberpunk aesthetic, blue and purple lighting, holographic data visualization, 8K ultra-detailed',
    allow_overlay_stock: false,
  },
  {
    id: 'viral',
    label: 'Viral / Trendy',
    ai_image_suffix:
      'bold high-contrast social media aesthetic, saturated colors, dramatic lighting, Gen-Z energy, YouTube thumbnail quality',
    allow_overlay_stock: false,
  },
  {
    id: 'whiteboard',
    label: 'Whiteboard',
    ai_image_suffix:
      'whiteboard animation style, hand-drawn black marker sketch on white background, educational explainer, minimal and clean, NOT photorealistic',
    allow_overlay_stock: false,
  },
  {
    id: 'doodle_explainer',
    label: 'Doodle Explainer',
    ai_image_suffix:
      'minimalist hand-drawn stick figure doodle, thick uneven black outlines, simple circular heads, plain white background, flat shadowless lighting, vibrant saturated accent colors, 2D flat vector animation style, clean crisp outlines, motion-graphics aesthetic, NOT photorealistic, NOT a photograph',
    allow_overlay_stock: true,
    mixing_rules: [
      'This is a hand-drawn doodle style. The default for almost every row is "Animation" with a pure stick-figure ai_image_prompt — keep that as your base.',
      '',
      'BUT — when the script names a recognisable real-world subject, populate `overlay_stock_terms` so the editor can composite a real asset on top of the doodle in post. Use these triggers:',
      '',
      '  • Named company / brand (Apple, Google, YouTube, FBI, Reddit, Microsoft, …) → overlay_stock_terms: "<brand> logo official PNG"',
      '  • Named software, app, website, or UI (Tor browser, iPhone settings, Genesis Market, Pegasus spyware, ChatGPT homepage) → overlay_stock_terms: "<thing> screenshot" or "<thing> homepage"',
      '  • Named real person who can plausibly be photographed (Ross Ulbricht, a public-figure CEO) → overlay_stock_terms: "<name> photograph"',
      '  • Named physical place / event with a recognisable photo (San Francisco Public Library, undersea cable map) → overlay_stock_terms: "<place> photograph"',
      '  • Named computer virus / malware / hack / breach (Stuxnet, WannaCry, MGM hack, Change Healthcare attack) → overlay_stock_terms: "<thing> news photo" or "<thing> ransom note screenshot"',
      '  • Named hardware / product (specific GPU, console, gadget) → overlay_stock_terms: "<product> product shot"',
      '',
      'Also weight the niche heavily — if the niche is cybersecurity and the script mentions any tool, malware, breach, or platform by name, that is a strong trigger to populate overlay_stock_terms even if the rule above is borderline.',
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
  },
]);

const BY_ID = new Map<string, ResolvedStyle>(BUILT_IN_STYLES.map((s) => [s.id, s]));

/** Look up a built-in style by id. Returns null for unknown ids. */
export function getBuiltInStyle(id: string): ResolvedStyle | null {
  return BY_ID.get(id) ?? null;
}

/** Lightweight payload for the picker — avoids shipping mixing_rules text to every page render. */
export interface StylePickerOption {
  id: string;
  label: string;
}

export const STYLE_PICKER_OPTIONS: readonly StylePickerOption[] = Object.freeze(
  BUILT_IN_STYLES.map((s) => ({ id: s.id, label: s.label })),
);
