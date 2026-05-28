/**
 * N Levels Explained — pure module
 *
 * Format that produces a YouTube thumbnail as N vertical slices stacked side
 * by side, with a large grunge title bar at the bottom ("[N] LEVELS OF
 * [TOPIC] [EXPLAINED]"). Each slice represents one step / level in a
 * progressive narrative — typical use: "7 Levels of Dark Web Mysteries",
 * "5 Levels of Cybersecurity Breaches".
 *
 * Pure module: no network, no React, no Next.js. Mirrors the shape of the
 * sibling `topic-card-grid.ts` module so both formats share the same
 * mental model for callers.
 *
 * Three public surfaces:
 *  - `nLevelsLlmPrompt(...)` — Step 1 prompt builder (LLM level list).
 *  - `nLevelsImagePrompt(...)` — Step 2 prompt builder (GPT Image 2).
 *  - `computeRegions(...)` — deterministic region rectangles for each slice.
 *
 * Following the Phase 1.5 lessons learned from Topic Card Grid:
 *  - No forced colour palette. Each slice picks colours that fit its content.
 *  - Real recognisable visuals are encouraged (logos, screens, characters)
 *    over abstract icons whenever they exist.
 *  - No banlist by default. The simplicity-and-recognisability bar lives in
 *    the prompt language. We retain the structure so we can re-add narrow
 *    bans cheaply if a specific failure mode emerges.
 */

import type { ThumbnailRegion } from '@/remotion/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NLevel {
  /** Number rendered as "LEVEL N" at the top of the slice. Typically the
   *  1-based position in the sequence but can be any positive integer —
   *  e.g. a 2-slice grid labelled `[1, 7]` ("level 1 and level 7") with
   *  the middle steps elided. Order of slices on the canvas follows the
   *  array order, NOT the numeric value. */
  level: number;
  /** Short label shown under the LEVEL number. 1–4 words ideally.
   *  OPTIONAL — when empty, the slice renders only the "LEVEL N" heading
   *  with no subtitle (matches the most common pattern in successful
   *  "N LEVELS OF" thumbnails on YouTube). */
  label?: string;
  /** Concrete description of the most recognisable depiction of this level's
   *  subject. Real logos, real screens, real characters preferred over
   *  abstract icons. */
  illustration_concept: string;
  /** Optional per-level accent color (e.g. green for "passive recon", red
   *  for "exfiltration"). Soft hint to the image model by default; can be
   *  omitted to let the model pick what fits. */
  accent_color?: string;
  /** When true, the image prompt treats `accent_color` as authoritative —
   *  the model is instructed to use that exact color as the slice's
   *  dominant background at full saturation, not as a vibe nudge. When
   *  false or undefined, the color is passed as a soft "(accent hint)"
   *  the model may freely reinterpret. Lock state is per-slice; LLM-
   *  suggested colors default to unlocked. */
  accent_color_locked?: boolean;
}

export interface LevelListResult {
  levels: NLevel[];
  /** The topic that goes into the "[N] LEVELS OF [TOPIC]" bottom title.
   *  The LLM may refine the user's topic to fit the format's typography
   *  (caps, brevity); the user-provided version is preserved separately.
   *  May be empty when the bottom title bar is disabled. */
  title_topic: string;
  /** Defaults to "EXPLAINED"; users can omit or change. Tagged below the
   *  topic in a red rectangle. Ignored when the bottom title bar is off. */
  title_tagline: string;
  /** Optional free-form note from the LLM that we forward to the image
   *  prompt (e.g. "use a progressive cool-to-warm palette across slices").
   *  Sanitised before use. */
  notes_for_image_model?: string;
}

export interface NLevelsLayout {
  /** Output image width in pixels. */
  width: number;
  /** Output image height in pixels. */
  height: number;
  /** Number of vertical slices. */
  count: number;
  /** Pixel height of the grunge title bar at the bottom of the canvas. */
  bottomBandHeight: number;
  /** Pixel gutter between adjacent slices. The reference style has slices
   *  edge-to-edge with thin dividers only; we keep a small visual gutter
   *  for the region math but default it to 0 px for tight stacking. */
  gutter: number;
  /** Pixel margin on left/right/top of the slices area. Defaults to 0. */
  outerMargin: number;
}

// ─── Layout math ────────────────────────────────────────────────────────────

/** Default canvas size. 16:9 at the resolution GPT Image 2 reliably renders
 *  via Kie's 1K aspect ratio bucket. */
export const DEFAULT_CANVAS = { width: 1280, height: 720 } as const;

/** Default bottom title bar height as a fraction of canvas height. The
 *  reference examples (7 Levels of Dark Web, 7 Levels of Cyber Security
 *  Breaches) both use roughly 30% of the canvas for the title bar. */
export const DEFAULT_TITLE_BAND_FRACTION = 0.30;

export function makeDefaultLayout(
  count: number,
  width: number = DEFAULT_CANVAS.width,
  height: number = DEFAULT_CANVAS.height,
  showBottomTitle: boolean = false,
): NLevelsLayout {
  return {
    width,
    height,
    count,
    // When the bottom title bar is disabled, slices fill the whole canvas
    // (the dominant pattern in the most successful "N LEVELS OF" thumbnails
    // on YouTube — see the user's references). Title bar stays available as
    // an opt-in for the grunge-title style.
    bottomBandHeight: showBottomTitle ? Math.round(height * DEFAULT_TITLE_BAND_FRACTION) : 0,
    gutter: 0,
    outerMargin: 0,
  };
}

/**
 * Compute the rectangle for each slice in the format. Returned in left-to-
 * right order so callers can pair them with the `NLevel.level` 1-based
 * numbering directly. Each slice is the FULL vertical strip from the top of
 * the canvas down to the start of the bottom title bar — production-doc's
 * zoom feature treats this as one zoomable region per level.
 *
 * `mkId` lets tests inject a deterministic id generator; production callers
 * pass `crypto.randomUUID`.
 */
export function computeRegions(
  layout: NLevelsLayout,
  labels: string[],
  mkId: () => string,
): ThumbnailRegion[] {
  const { width, height, count, bottomBandHeight, gutter: g, outerMargin: om } = layout;
  const sliceAreaH = height - bottomBandHeight - om; // top margin only (no bottom margin above the band)
  const sliceW = (width - 2 * om - (count - 1) * g) / count;
  const regions: ThumbnailRegion[] = [];
  for (let i = 0; i < count; i++) {
    const x = om + i * (sliceW + g);
    const y = om;
    regions.push({
      id: mkId(),
      label: labels[i] ?? `Level ${i + 1}`,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(sliceW),
      h: Math.round(sliceAreaH),
    });
  }
  return regions;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Subjects the model should not produce. Intentionally empty post-r1 of the
 * Topic Card Grid format — competitor analysis showed every "banned" pattern
 * (UI screenshots, faces, scenes) is exactly what wins. We keep the array
 * structure so a future narrow ban can drop in cheaply.
 */
export const ILLUSTRATION_CONCEPT_BANLIST: readonly { match: RegExp; reason: string }[] = [
  // Intentionally empty. Mirror the lesson from topic-card-grid r1.5.
];

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; offending_level_index?: number };

/**
 * Validate a level list against the slice count + per-level field presence.
 * Caller chooses what to do on `ok: false` — typically: one retry with a
 * tightened prompt citing the specific offending level, then surface to the
 * user.
 */
/**
 * Validate a level list.
 *
 * `expectedCount` is a soft hint: if non-null, the validator returns an
 * error when `levels.length !== expectedCount`. Step 1 (LLM card list)
 * uses this to enforce the count the user asked for. Step 2 (image
 * render) passes `null` because the user may have deleted slices in the
 * review step — what matters is just that there's at least one slice
 * and all surviving slices are well-formed.
 *
 * Labels are OPTIONAL — empty labels render as "LEVEL N" alone.
 */
export function validateLevelList(
  levels: NLevel[],
  expectedCount: number | null,
): ValidationResult {
  if (!Array.isArray(levels)) return { ok: false, reason: 'levels is not an array' };
  if (levels.length === 0) {
    return { ok: false, reason: 'At least one level is required.' };
  }
  if (expectedCount !== null && levels.length !== expectedCount) {
    return {
      ok: false,
      reason: `Expected exactly ${expectedCount} levels but got ${levels.length}.`,
    };
  }
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    if (!l || typeof l !== 'object') {
      return { ok: false, reason: `Level ${i + 1} is not an object.`, offending_level_index: i };
    }
    const label = (l.label || '').toString().trim();
    const concept = (l.illustration_concept || '').toString().trim();
    // Label is optional. When present we validate the length cap; when
    // empty the slice renders as "LEVEL N" with no subtitle.
    if (!concept) return { ok: false, reason: `Level ${i + 1} has no illustration_concept.`, offending_level_index: i };
    if (label.length > 60) {
      return { ok: false, reason: `Level ${i + 1} label is too long (${label.length} chars; max 60).`, offending_level_index: i };
    }
    if (!Number.isFinite(l.level) || l.level < 1 || l.level > 99) {
      return { ok: false, reason: `Level ${i + 1} has an invalid level number (must be 1-99, got ${l.level}).`, offending_level_index: i };
    }
    for (const banned of ILLUSTRATION_CONCEPT_BANLIST) {
      if (banned.match.test(concept)) {
        return {
          ok: false,
          reason: `Level ${i + 1} illustration_concept contains a banned concept (${banned.reason}).`,
          offending_level_index: i,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Strip control chars + clip length so user-edited or LLM-generated text
 * can't smuggle prompt-injection payloads into the image prompt.
 *
 * Codepoint filter for safety (a literal `[\x00-\x1F]` regex range in this
 * file kept getting written with embedded control bytes by tooling).
 */
export function sanitizeForPrompt(input: string, maxLen = 250): string {
  let out = '';
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 32 && code !== 127) {
      out += s.charAt(i);
    } else if (code === 9 || code === 10 || code === 13) {
      out += ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// ─── Prompt builders ────────────────────────────────────────────────────────

export interface LlmPromptInput {
  title: string;
  niche: string;
  script?: string;
  description?: string;
  count: number;
  /** The topic that goes in the bottom title bar (e.g. "CYBER SECURITY
   *  BREACHES"). The LLM may refine for typography. Optional — when the
   *  bottom title bar is disabled the LLM doesn't produce a refined topic
   *  and the image step skips the title bar entirely. */
  titleTopic?: string;
  /** Defaults to "EXPLAINED"; users can pass "" to hide. */
  titleTagline?: string;
  /** Whether the rendered thumbnail will include the grunge bottom title
   *  bar. Defaults false — most successful "N LEVELS OF" thumbnails on
   *  YouTube run without a bottom title bar at all. */
  showBottomTitle?: boolean;
  /** Pre-filled labels for "Pre-fill" mode. If present, the LLM only fills
   *  in `illustration_concept` per provided label and keeps the labels
   *  verbatim. */
  prefilledLabels?: string[];
}

/**
 * Step 1 prompt. The LLM produces an ordered level list + refined title.
 * Multimodal: the reference image is attached by the caller via
 * `generateText({ image })`; this prompt just refers to it.
 */
export function nLevelsLlmPrompt(input: LlmPromptInput): { system: string; user: string } {
  const { title, niche, script, description, count, titleTopic, titleTagline, prefilledLabels } = input;
  const usingPrefilled = !!prefilledLabels && prefilledLabels.length === count;
  const showBottomTitle = !!input.showBottomTitle;
  const tagline = titleTagline === undefined ? 'EXPLAINED' : titleTagline;
  const safeTitleTopic = (titleTopic ?? '').trim();

  const system = `You are designing a YouTube thumbnail in the "N Levels Explained" format. The thumbnail shows N vertical slices side-by-side across the top of the canvas, and a large grunge/distressed title bar across the bottom. Each slice represents one step in a progressive narrative — a level of depth, escalation, or expertise.

YOUR JOB: produce exactly ${count} level entries and refine the title for the bottom bar.

THE GOAL FOR EACH LEVEL: depict the subject in the most IMMEDIATELY RECOGNISABLE way possible. The viewer should be able to look at a slice and know what it represents in under a second — even at YouTube mobile size.

The most recognisable depictions are usually NOT abstract icons. They are:
- The subject's REAL BRAND LOGO when it's a company, app, or product (Tor, Google, Microsoft, etc.).
- The subject's REAL VISUAL IDENTITY when it's a piece of software, screen, or media.
- A REAL PRODUCT PHOTO when it's a physical thing.
- A REAL NEWS/HISTORICAL PHOTO when it's a public event.
- A REAL FACE/PHOTO when it's a named person.

Use an abstract symbol/icon ONLY when none of the above apply.

Each slice stands on its own:
- The slice's TOP shows "LEVEL ${'${'}n${'}'}" in bold (e.g. "LEVEL 1"), then a short label in bold caps below it (e.g. "PASSIVE RECONNAISSANCE"). Together they identify the slice.
- The slice's REMAINING SPACE holds the illustration — the recognisable depiction.
- Background and colours should fit the subject naturally. Cool greens for surveillance, warm reds for active threats, blues for technical infrastructure, etc. Do NOT force a uniform palette across slices — visual progression across the slices is part of the appeal.
- Mobile-readable. If a subject is detail-dense, frame the most iconic moment of it.

VISUAL DOMINANCE — TEXT INSIDE EACH SLICE MUST BE MINIMAL:
- The "LEVEL N" heading and the short label are the ONLY guaranteed text on a slice. Everything else in the slice is VISUAL.
- Inside the illustration itself: at most ONE additional short text element, and only when it is intrinsic to the subject's recognisable identity (a brand wordmark that IS the logo, a single iconic header from a recognised UI screen).
- DO NOT add stat captions, descriptive subtitles, factoid bullets, or news-headline summaries below the illustration.
- DO NOT add badges like "EXPLOITED", "DETECTED", "COMPROMISED".
- DO NOT compose multi-element labelled diagrams within a slice. Pick ONE iconic visual.
- DO NOT pad the slice with fake code, ASCII art, or made-up screen text just to fill space.
When in doubt: TIGHTER FRAMING with NO supplementary text. The level heading + label already identify the slice.

PROGRESSION: the N levels should form a coherent sequence. Order them so they tell a story — increasing depth, increasing danger, increasing technicality, etc. The user's video script (if provided) is the source of truth for what each level should be.

The label below each "LEVEL n" is short (1–4 words, ALL CAPS).

${showBottomTitle ? `The bottom title is fixed structure:
- Line 1: "${count} LEVELS OF" (white grunge)
- Line 2: "[TOPIC]" (yellow grunge, larger, where TOPIC = the topic you refine for this video)${tagline ? `
- Line 3: "[${tagline}]" (red, smaller, in a red-tinted box)` : ''}

For the topic, the user provided: "${safeTitleTopic}". You may refine it for typography (caps, brevity, punch) — keep it 2-5 words, ALL CAPS, sounds like a YouTube title block.

` : `There is NO bottom title bar in this thumbnail — the slices fill the whole canvas. You don't need to refine a "title_topic"; just emit an empty string for it.

`}A reference image is attached to this message. Match its STRUCTURE precisely (slice layout, level number + label typography${showBottomTitle ? ', bottom grunge title typography' : ', no bottom title bar'}). Do NOT inherit its specific palette or per-slice content.

Return JSON only — no prose, no markdown fences. Schema:

{
  "levels": [
    { "level": 1, "label": "<short ALL CAPS>", "illustration_concept": "<concrete description of the most recognisable depiction of this level's subject>", "accent_color": "<hex if a specific accent matters, otherwise omit>" }
  ],
  "title_topic": ${showBottomTitle ? '"<refined ALL CAPS topic, 2-5 words>"' : '""'},
  "title_tagline": ${showBottomTitle && tagline ? `"${tagline}"` : '""'},
  "notes_for_image_model": "<one short sentence of overall style guidance, optional>"
}

The levels array MUST contain EXACTLY ${count} entries, in narrative order.`;

  const userParts: string[] = [];
  userParts.push(`**Video Title:** ${title}`);
  userParts.push(`**Niche:** ${niche}`);
  userParts.push(`**Levels:** ${count} (you produce exactly ${count} entries, in narrative order)`);
  if (showBottomTitle) {
    userParts.push(`**Title topic (suggested):** ${safeTitleTopic}`);
    if (tagline) userParts.push(`**Title tagline:** ${tagline}`);
  } else {
    userParts.push(`**Bottom title bar:** disabled — slices fill the canvas, no master title text.`);
  }
  if (description) userParts.push(`**Video Description:** ${description.slice(0, 500)}`);
  if (script) userParts.push(`**Script (canonical source for level labels — extract the user's exact terminology, in narrative order):** ${script.slice(0, 12000)}`);
  if (usingPrefilled) {
    userParts.push(
      `**Pre-filled labels — use these verbatim, in this order, do not invent new ones:**\n${prefilledLabels!
        .map((l, i) => `LEVEL ${i + 1}: ${l}`)
        .join('\n')}\n\nYour job for these is to fill in only the illustration_concept and accent_color per level. Keep labels EXACTLY as given.`,
    );
  } else {
    userParts.push(
      `Pick ${count} distinct, narratively-ordered levels from the video. Each level should be a clear step in a progression (depth, escalation, expertise, etc.) — not all variations on one theme.`,
    );
  }

  return { system, user: userParts.join('\n\n') };
}

/** Mirror of `ThumbnailBrightness` in topic-card-grid — same three
 *  registers, same defaults. Re-exported here so consumers can import
 *  the type from whichever format module they're closer to. */
export type ThumbnailBrightness = 'bright' | 'mixed' | 'moody';
export type ThumbnailDetail = 'clean' | 'detailed';

export const DEFAULT_BRIGHTNESS: ThumbnailBrightness = 'bright';
export const DEFAULT_DETAIL: ThumbnailDetail = 'clean';

export interface ImagePromptInput {
  levels: NLevel[];
  count: number;
  /** When `showBottomTitle` is true, this is the topic that appears in the
   *  grunge bottom title bar. When false, the field is ignored. */
  titleTopic?: string;
  titleTagline?: string;
  /** Whether the rendered thumbnail includes the grunge bottom title bar.
   *  Defaults false. When false, slices fill the whole canvas. */
  showBottomTitle?: boolean;
  /** Whether per-slice labels render under each LEVEL N heading. Defaults
   *  true. When false, every slice renders as just "LEVEL N" regardless
   *  of any label text in the levels array. */
  showLevelLabels?: boolean;
  notesForImageModel?: string;
  /** Brightness register. Defaults to `'bright'` — explicitly kills
   *  the "later slices fade darker" pattern that the older default
   *  produced in 7 Levels renders. */
  brightness?: ThumbnailBrightness;
  /** Detail register. Defaults to `'clean'` — one bold iconic visual
   *  per slice. */
  detail?: ThumbnailDetail;
}

/**
 * Step 2 prompt. Constructed server-side after the user has reviewed and
 * possibly edited the level list. Hard-locks the layout in writing,
 * enumerates every level explicitly, and pre-sanitises every interpolated
 * string so a malicious or sloppy edit can't smuggle conflicting
 * instructions in.
 */
export function nLevelsImagePrompt(input: ImagePromptInput): string {
  const {
    levels,
    count,
    titleTopic,
    titleTagline,
    notesForImageModel,
    brightness = DEFAULT_BRIGHTNESS,
    detail = DEFAULT_DETAIL,
  } = input;
  const showBottomTitle = !!input.showBottomTitle;
  // Default true so callers that don't pass the flag get the historical
  // labels-on behaviour. Pass `false` to render only LEVEL N headings.
  const showLevelLabels = input.showLevelLabels !== false;
  const tagline = titleTagline === undefined ? 'EXPLAINED' : titleTagline;
  const safeNotes = notesForImageModel ? sanitizeForPrompt(notesForImageModel, 300) : '';
  const safeTopic = sanitizeForPrompt(titleTopic ?? '', 60);
  const safeTagline = sanitizeForPrompt(tagline, 30);

  const levelLines = levels
    .map((l) => {
      const label = sanitizeForPrompt(l.label ?? '', 60);
      const concept = sanitizeForPrompt(l.illustration_concept, 250);
      // Two color modes:
      //  - Locked: authoritative. The user picked this color and means it.
      //    The image model gets explicit "MUST be exactly this color at
      //    full saturation" language that overrides the "pick a fitting
      //    background" guidance further up in the prompt.
      //  - Unlocked (hint): the historical soft suggestion. The model is
      //    free to interpret loosely.
      let accent = '';
      if (l.accent_color) {
        const safeColor = sanitizeForPrompt(l.accent_color, 16);
        accent = l.accent_color_locked
          ? `. SLICE COLOR LOCK: the slice background MUST be ${safeColor} at full, vivid saturation. Do NOT darken, desaturate, tint, or shift the hue toward a moodier variant. The LEVEL heading and label stay white (or a clearly contrasting near-white) over this background.`
          : ` (accent hint: ${safeColor})`;
      }
      // Render with the slice's exact `level` number (user may have
      // assigned non-sequential numbers like [1, 7]). Heading depends on
      // the global showLevelLabels toggle AND the per-slice label data.
      let heading: string;
      if (!showLevelLabels) {
        // Global override: NO labels on any slice. Render only LEVEL N.
        heading = `LEVEL ${l.level} (NO SUBTITLE — render only the LEVEL ${l.level} heading at top of the slice, no second line of text)`;
      } else if (label) {
        heading = `LEVEL ${l.level} — "${label}"`;
      } else {
        heading = `LEVEL ${l.level} (NO SUBTITLE — render only the LEVEL ${l.level} heading at top of the slice, no second line of text)`;
      }
      return `${heading}: ${concept}${accent}`;
    })
    .join('\n');

  return `Create a YouTube thumbnail in the "N Levels Explained" format, 16:9.

LAYOUT (strict):
${showBottomTitle ? `- The canvas is split into TWO horizontal regions, stacked top to bottom:
  • TOP 70% — the slices region: ${count} VERTICAL slices side by side, edge-to-edge with thin dividers (no large gutters). Each slice fills its full height.
  • BOTTOM 30% — the title bar: a single large grunge/distressed title strip across the full width.` : `- ${count} VERTICAL slices side by side, edge-to-edge with thin dividers (no large gutters). The slices fill the ENTIRE canvas top to bottom — there is NO bottom title bar in this thumbnail.`}

SLICES REGION (strict):
- ${count} vertical slices arranged left to right, in the exact order listed below.
- Each slice contains, from top to bottom:
  • A bold "LEVEL N" heading. N is the slice's level NUMBER (taken verbatim from the list below — numbers do NOT have to be 1, 2, 3 sequentially; the user may have picked e.g. [1, 7] to skip middle steps. Render whatever number is given). Numbers visually prominent (large bold sans-serif). White or near-white on the slice's background.
  • DIRECTLY BELOW: the slice's short label in bold ALL-CAPS sans-serif (same colour as the LEVEL heading or a fitting contrast). 1–2 lines max. SOME SLICES HAVE NO LABEL — for those, render ONLY the LEVEL N heading at the top of the slice and leave the rest blank for the illustration. Don't invent a substitute label.
  • Filling the rest of the slice height: the illustration — depicting the level's subject as recognisably as possible.
- Each slice has its OWN background and colour treatment that fits its content. A "passive reconnaissance" slice might be cool green; an "exfiltration" slice deep red. Visual progression across slices is a feature. EXCEPTION: when a slice has an explicit "SLICE COLOR LOCK" instruction in its line below, that locked colour is authoritative; use it as the dominant background at full saturation regardless of what would otherwise "fit" the content. Do NOT darken or desaturate a locked colour for mood.
- Real brand logos, real software screens, real product photos, real characters, real news photos — whatever depicts each level's subject most recognisably. This is fair use under YouTube's policy.
- One focal subject per slice. No collages of unrelated elements.
- Recognisable at 168×94 px (YouTube mobile thumbnail size).

VISUAL DOMINANCE — TEXT INSIDE EACH SLICE MUST BE MINIMAL:
- The "LEVEL N" heading and the short label are the only guaranteed text on a slice. Everything else is VISUAL.
- Inside the illustration itself: at most ONE additional short text element, and only when it is intrinsic to the subject's recognisable identity (a brand wordmark that IS the logo, a single iconic UI header).
- DO NOT add stat captions, descriptive subtitles, factoid bullets, or news-headline summaries.
- DO NOT add badges like "EXPLOITED", "DETECTED", "COMPROMISED" inside the slice.
- DO NOT compose multi-element labelled diagrams within a slice.
- DO NOT pad the slice with ASCII art, fake code, or made-up screen text just to fill space.
When in doubt: TIGHTER FRAMING with NO supplementary text. The LEVEL heading + label already identify the slice.

CATEGORY vs. SPECIFIC RULE (most common failure mode):
- For SPECIFIC NAMED entities, use their canonical visual identity.
- For ABSTRACT CATEGORIES (process stages, attack types, security concepts), STRONGLY PREFER one bold iconic symbol per slice over a detail-faithful UI/dialog mockup. A LITTLE text is fine when iconic (a one-word stamp); what's NOT OK is multi-line body copy, rows of fake detection entries, multi-field UI mocks. Iconic, not example.

CATEGORY vs. SPECIFIC RULE (most common failure mode):
- For SPECIFIC NAMED entities (real brands, real software, real characters, real events): use their canonical visual identity (logo, famous screen, character render).
- For ABSTRACT CATEGORIES or stages of a process ("Passive Reconnaissance", "Active Probing", "Data Exfiltration", "Cover Tracks", etc.): STRONGLY PREFER one bold iconic symbol over a detail-faithful UI/dialog/scanner-table mockup. Categories don't have a canonical visual, so a realistic mockup degenerates into a text-heavy panel unreadable at thumbnail size.
  A LITTLE text is fine when it's iconic (a one-word stamp, a wordmark). What's NOT OK on a category slice: multi-line dialog body copy, rows of fake detection entries, multi-field email mocks, installer wizards with body paragraphs and multiple buttons. Iconic, not example.

SCRIPT FIDELITY — LABELS MUST MATCH WHAT THE USER WROTE:
- When a script is provided, the script is the canonical source of level content. Read it carefully.
- If the script names specific level/stage/step phrases (e.g. "Passive Reconnaissance", "Active Probing", "The Foothold"), use those EXACT phrases as level labels — character for character (UPPERCASED) — instead of paraphrasing.
- Order the levels exactly as the script presents them.
- DO NOT invent levels the script does not mention.
- DO NOT collapse two distinct stages the script lists separately into a single level.
- DO NOT split a single stage the script lists into two levels.
- If the script lists FEWER stages than the requested level count, pick the additional levels from the most natural adjacent stages the script implies.

${showBottomTitle ? `TITLE BAR (strict, fixed structure):
- Pure black background across the full canvas width, filling the bottom 30%.
- Three centred lines of grunge/distressed typography stacked vertically:
  • Line 1: "${count} LEVELS OF" — bold sans-serif, WHITE, slightly distressed.
  • Line 2: "${safeTopic}" — bold sans-serif, YELLOW grunge texture, larger than line 1 (the visual focal point of the title bar).${safeTagline ? `
  • Line 3: "[${safeTagline}]" — bold sans-serif, RED text on a darker red-tinted rectangle, smaller than line 2.` : ''}
- Typography matches the attached reference image's title-bar treatment (grunge, distressed edges, bold display weight).` : `NO BOTTOM TITLE BAR:
- The canvas does NOT contain a bottom title bar. The slices fill the entire canvas top-to-bottom.
- Do NOT add a "N LEVELS OF [TOPIC]" caption, a tagline tag, or any other master title text anywhere on the thumbnail. The LEVEL N / label inside each slice is the only text on the canvas.`}

LEVELS (render exactly these ${count} slices, left to right):

${levelLines}

ABSOLUTE REQUIREMENTS — DO NOT VIOLATE:
- The slices region MUST contain EXACTLY ${count} slices. Not one more, not one fewer.
- One focal subject per slice — no multi-subject collages within a single slice.
${showBottomTitle
  ? `- The bottom 30% MUST be the title bar with the three centred grunge lines above (lines 1 and 2 always; line 3 only if a tagline was provided).
- Do NOT add a master title above the slices or anywhere else outside the bottom title bar.`
  : `- There is NO bottom title bar. Do NOT add a master title, grunge caption, or any text outside the LEVEL N headings + per-slice labels.`}
- Match the LAYOUT (vertical slices${showBottomTitle ? ' + bottom title bar' : ''}) and the TYPOGRAPHY of the attached reference image precisely. Do NOT inherit the reference's specific palette or per-slice content — those are dictated by THIS level list${showBottomTitle ? ' and topic' : ''}.

${nLevelsBrightnessDirective(brightness)}

${nLevelsDetailDirective(detail)}

${safeNotes ? `STYLE NOTE: ${safeNotes}` : ''}`.trim();
}

/** Brightness directive specific to the n-levels format. The
 *  important addition vs topic-card-grid: explicit ban on the
 *  "later slices fade darker" pattern, which the analysis with the
 *  user identified as the single biggest issue with the existing
 *  7-levels renders. */
function nLevelsBrightnessDirective(value: ThumbnailBrightness): string {
  if (value === 'moody') {
    return `BRIGHTNESS — MOODY: cinematic, atmospheric, darker palettes are OK. Lean into the subject's natural mood.`;
  }
  if (value === 'mixed') {
    return `BRIGHTNESS — MIXED: each slice picks brightness to fit its subject. Earlier slices and later slices may differ in register; don't force progression.`;
  }
  return `BRIGHTNESS — BRIGHT (default):
- Every slice must render with a vibrant, well-lit palette throughout the sequence.
- HARD BAN on the "later slices fade darker" pattern. Slices 5, 6, 7 must be just as bright and saturated as slices 1, 2, 3. No graduated darkening across the row. No black-fade-to-the-right.
- Every slice background reads as a saturated, lively colour. Cell-to-cell progression is by HUE, not by brightness — go red → orange → yellow → green → teal → blue → purple, all at full saturation, instead of bright-red → dark-red → black-red.
- Even for inherently dark subjects (data exfiltration, criminal infrastructure), pick the most colourful framing the subject permits.
- The bar is "every slice still reads as a colourful object at YouTube mobile thumbnail size, including the rightmost slice". If a slice would otherwise be predominantly black, brighten its background or accents until that bar is met.`;
}

function nLevelsDetailDirective(value: ThumbnailDetail): string {
  if (value === 'detailed') {
    return `DETAIL — DETAILED: multi-element compositions and photoreal scenes are OK when the slice subject calls for them.`;
  }
  return `DETAIL — CLEAN (default):
- One bold iconic visual per slice. NO multi-element labelled diagrams, NO photoreal scenes packed with small props, NO multi-field UI mockups.
- Subjects render as a CHUNKY central image — single-glance readable, the bar the reference channels' slices meet.
- If a subject is detail-dense (a complex device, a screen with lots of UI), crop to the single most recognisable element instead of rendering the whole thing.
- Text inside the illustration stays minimal — at most one short brand wordmark or iconic header.
- Each slice must still read clearly at 168×94 px (YouTube mobile thumbnail size) — that's the only quality bar that matters.`;
}

// ─── JSON-shape helpers ─────────────────────────────────────────────────────

/**
 * Narrow the LLM's raw parsed JSON down to a `LevelListResult`. Throws with
 * a specific reason on shape errors so callers can return an actionable 400.
 *
 * Defensive: the LLM occasionally puts the levels array at the top level
 * instead of under `levels`, or returns a single object instead of an array.
 * We accept the common drift shapes and normalise.
 */
export function parseLevelListResult(raw: unknown, fallbackTitle: string, fallbackTagline: string): LevelListResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('LLM response is not an object.');
  }
  const obj = raw as Record<string, unknown>;
  const levelsRaw = Array.isArray(obj.levels)
    ? obj.levels
    : Array.isArray(obj.cards)
      ? (obj.cards as unknown[]) // tolerate the model copying the card-grid schema
      : Array.isArray(raw)
        ? raw
        : null;
  if (!levelsRaw) throw new Error('LLM response missing `levels` array.');

  const levels: NLevel[] = levelsRaw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Level ${i + 1} is not an object.`);
    }
    const e = entry as Record<string, unknown>;
    // Tolerate the older topic-card-grid shape that uses icon_concept.
    const concept = String(
      e.illustration_concept ?? e.icon_concept ?? '',
    ).trim();
    return {
      level: typeof e.level === 'number' ? e.level : i + 1,
      label: String(e.label ?? '').trim(),
      illustration_concept: concept,
      accent_color: e.accent_color ? String(e.accent_color) : undefined,
      // Pass through if the client sent it (e.g. via the image route's
      // re-validation). The LLM step itself never emits this — it's a
      // user-set per-slice flag that travels through the levels list.
      accent_color_locked: e.accent_color_locked === true ? true : undefined,
    };
  });

  const title_topic = obj.title_topic ? String(obj.title_topic).trim() : fallbackTitle;
  const title_tagline = obj.title_tagline === undefined
    ? fallbackTagline
    : String(obj.title_tagline).trim();

  return {
    levels,
    title_topic,
    title_tagline,
    notes_for_image_model: obj.notes_for_image_model
      ? String(obj.notes_for_image_model)
      : undefined,
  };
}
