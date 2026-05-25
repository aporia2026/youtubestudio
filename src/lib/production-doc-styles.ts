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
      'extremely minimalist stick figure cartoon in the style of a child\'s freehand drawing, thin uneven hand-drawn black ink lines on plain pure white background, asdfmovie / Cyanide & Happiness aesthetic. CRITICAL ARM RULE: every arm is exactly one thin black line from shoulder to a clean dead-end tip — like a single chopstick. The arm has NO hand at the end. NO fingers, NO palm, NO thumb, NO wrist, NO knuckles, NO five-fingered hand, NO open hand, NO mitten, NO fist, NO defined hand of any kind. When the character is waving, the waving arm is JUST A LINE pointing up and to the side — the tip is a clean pencil stroke ending, nothing more. Same rule for pointing, gesturing, expressing emotion, standing, walking. The ONLY exception is when the action absolutely requires gripping a specific object that\'s visible in the same scene (typing on a keyboard the hand sits on, holding a tool, gripping a steering wheel) — in those cases draw the smallest possible nub, never anatomical. CHARACTERS: head is an empty circle outline with WHITE INTERIOR (no fill color, never yellow, never tinted), two small black dots for eyes (or two small black rectangles for glasses), tiny optional mouth as a dot or short curve, body and legs are thin single-stroke lines, legs end in clean line tips with NO feet. LINES are wobbly, imperfect, slightly wonky, freehand, NOT clean vector, NOT polished, NOT smooth. NO shading, NO gradients, NO drop shadows. Pure black ink only on the figure itself. Color (a single saturated red, or a pale blue / pale yellow / light gray fill) appears ONLY on specific scene props like a red skull, a blue book cover, a yellow building — NEVER on the character\'s body or head. NOT photorealistic, NOT 3D, NOT a photograph, NOT anime, NOT manga.',
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
      'This is a hand-drawn cartoon style with a very specific compositional grammar. Defaults for every row:',
      '',
      '  • visual_type defaults to "Animation".',
      '  • ai_image_prompt describes a single centered subject on a pure white background, hand-drawn cartoon look with thick black outlines, generous white space, muted palette (pale blue / pale yellow / light gray accents only; saturated red ONLY for blood, danger, or alarm).',
      '  • Compose scenes so the same composition could plausibly be re-drawn with a tiny brow / mouth / hand change. Aim for "single character or single object, clearly framed" over "busy multi-element scene". This is forward-looking groundwork for Phase 3 variant support; even today it produces cleaner images.',
      '',
      'ON-SCREEN TEXT (`on_screen_text`): populate it liberally — this style leans on yellow bubble-text callouts as a core motif. Use it for:',
      '',
      '  • Time markers ("In May 2017", "Within hours", "Three days later")',
      '  • Statistics or quantities ("150 countries", "$4 billion", "Within 24h")',
      '  • Foreign or technical terms being introduced ("Wannacrypt", "Stuxnet", "EternalBlue")',
      '  • Short punchlines or emphasis fragments (3-5 words max)',
      '',
      'Leave `on_screen_text_mode` defaulting to "overlay" so the text is rendered by the player at video-build time. (Until Phase 2 lands the visual treatment is the generic lower-third; once Phase 2 ships, this style renders these callouts in the chunky yellow bubble font seen in the refs.) Use "bake" only when you specifically want the text painted INTO the AI image at a precise spot the prompt describes; expect occasional misspellings if you do.',
      '',
      'OVERLAY STOCK (`overlay_stock_terms`): when the script names a recognisable real-world subject, populate this so the editor can composite a real asset on top of the cartoon in post. Triggers:',
      '',
      '  • Named company / brand → overlay_stock_terms: "<brand> logo official PNG"',
      '  • Named software, app, website, UI, or famous error screen → overlay_stock_terms: "<thing> screenshot"',
      '  • Named real person (public figure) → overlay_stock_terms: "<name> photograph"',
      '  • Named physical place / hardware / event with iconic imagery → overlay_stock_terms: "<thing> photograph"',
      '',
      'CRUCIAL — the framed-photo treatment. In this style, real photos and screenshots are NOT bare overlays; they appear as inset rectangles with a thick coloured border (orange, red, blue, or black, matching the scene mood). When you populate overlay_stock_terms, ALSO:',
      '',
      '  • Keep visual_type as "Animation" (or "Statistics" / "Cutaway"). Do NOT switch to "Screen Recording" or "B-Roll".',
      '  • Write `ai_image_prompt` to describe a complete cartoon scene that includes an empty bordered rectangle as a deliberate placeholder. Examples: "stick figure points to a thick-black-bordered rectangle on the wall, rectangle is empty white inside" or "cartoon TV with a thick grey bezel, screen is a thick-black-bordered empty rectangle". DO NOT mention the real subject in the AI prompt — the AI image generator will hallucinate a stylised fake.',
      '  • Add a short `notes` line telling the editor what to overlay, what border colour, and where. Example: "Composite: drop the real Windows XP wallpaper into the empty rectangle inside the cartoon TV; use a thick blue border to match the era."',
      '',
      'Otherwise (script talks about a generic concept, an unnamed character, an everyday object) — leave overlay_stock_terms empty and keep the row pure illustration.',
      '',
      'Aim for roughly 1 in 4 to 1 in 6 rows being a framed-photo composite. Too many breaks the cohesive cartoon feel; too few wastes the chance to ground the video in real evidence.',
    ].join('\n'),
    allow_overlay_stock: true,
    origin: 'built-in',
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
