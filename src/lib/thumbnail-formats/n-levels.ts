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
  /** 1-based position in the slice sequence (left to right). */
  level: number;
  /** Short label shown under the LEVEL number. 1–4 words ideally. */
  label: string;
  /** Concrete description of the most recognisable depiction of this level's
   *  subject. Real logos, real screens, real characters preferred over
   *  abstract icons. */
  illustration_concept: string;
  /** Optional per-level accent color (e.g. green for "passive recon", red
   *  for "exfiltration"). Soft hint to the image model; can be omitted to
   *  let the model pick what fits. */
  accent_color?: string;
}

export interface LevelListResult {
  levels: NLevel[];
  /** The topic that goes into the "[N] LEVELS OF [TOPIC]" bottom title.
   *  The LLM may refine the user's topic to fit the format's typography
   *  (caps, brevity); the user-provided version is preserved separately. */
  title_topic: string;
  /** Defaults to "EXPLAINED"; users can omit or change. Tagged below the
   *  topic in a red rectangle. */
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
): NLevelsLayout {
  return {
    width,
    height,
    count,
    bottomBandHeight: Math.round(height * DEFAULT_TITLE_BAND_FRACTION),
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
export function validateLevelList(
  levels: NLevel[],
  expectedCount: number,
): ValidationResult {
  if (!Array.isArray(levels)) return { ok: false, reason: 'levels is not an array' };
  if (levels.length !== expectedCount) {
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
    if (!label) return { ok: false, reason: `Level ${i + 1} has no label.`, offending_level_index: i };
    if (!concept) return { ok: false, reason: `Level ${i + 1} has no illustration_concept.`, offending_level_index: i };
    if (label.length > 60) {
      return { ok: false, reason: `Level ${i + 1} label is too long (${label.length} chars; max 60).`, offending_level_index: i };
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
   *  BREACHES"). The LLM may refine for typography. */
  titleTopic: string;
  /** Defaults to "EXPLAINED"; users can pass "" to hide. */
  titleTagline?: string;
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
  const tagline = titleTagline === undefined ? 'EXPLAINED' : titleTagline;

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

The bottom title is fixed structure:
- Line 1: "${count} LEVELS OF" (white grunge)
- Line 2: "[TOPIC]" (yellow grunge, larger, where TOPIC = the topic you refine for this video)${tagline ? `
- Line 3: "[${tagline}]" (red, smaller, in a red-tinted box)` : ''}

For the topic, the user provided: "${titleTopic}". You may refine it for typography (caps, brevity, punch) — keep it 2-5 words, ALL CAPS, sounds like a YouTube title block.

A reference image is attached to this message. Match its STRUCTURE precisely (slice layout, level number + label typography, bottom grunge title typography). Do NOT inherit its specific palette or per-slice content.

Return JSON only — no prose, no markdown fences. Schema:

{
  "levels": [
    { "level": 1, "label": "<short ALL CAPS>", "illustration_concept": "<concrete description of the most recognisable depiction of this level's subject>", "accent_color": "<hex if a specific accent matters, otherwise omit>" }
  ],
  "title_topic": "<refined ALL CAPS topic, 2-5 words>",
  "title_tagline": ${tagline ? `"${tagline}"` : '""'},
  "notes_for_image_model": "<one short sentence of overall style guidance, optional>"
}

The levels array MUST contain EXACTLY ${count} entries, in narrative order.`;

  const userParts: string[] = [];
  userParts.push(`**Video Title:** ${title}`);
  userParts.push(`**Niche:** ${niche}`);
  userParts.push(`**Levels:** ${count} (you produce exactly ${count} entries, in narrative order)`);
  userParts.push(`**Title topic (suggested):** ${titleTopic}`);
  if (tagline) userParts.push(`**Title tagline:** ${tagline}`);
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

export interface ImagePromptInput {
  levels: NLevel[];
  count: number;
  titleTopic: string;
  titleTagline?: string;
  notesForImageModel?: string;
}

/**
 * Step 2 prompt. Constructed server-side after the user has reviewed and
 * possibly edited the level list. Hard-locks the layout in writing,
 * enumerates every level explicitly, and pre-sanitises every interpolated
 * string so a malicious or sloppy edit can't smuggle conflicting
 * instructions in.
 */
export function nLevelsImagePrompt(input: ImagePromptInput): string {
  const { levels, count, titleTopic, titleTagline, notesForImageModel } = input;
  const tagline = titleTagline === undefined ? 'EXPLAINED' : titleTagline;
  const safeNotes = notesForImageModel ? sanitizeForPrompt(notesForImageModel, 300) : '';
  const safeTopic = sanitizeForPrompt(titleTopic, 60);
  const safeTagline = sanitizeForPrompt(tagline, 30);

  const levelLines = levels
    .map((l) => {
      const label = sanitizeForPrompt(l.label, 60);
      const concept = sanitizeForPrompt(l.illustration_concept, 250);
      const accent = l.accent_color ? ` (accent hint: ${sanitizeForPrompt(l.accent_color, 16)})` : '';
      return `LEVEL ${l.level} — "${label}": ${concept}${accent}`;
    })
    .join('\n');

  return `Create a YouTube thumbnail in the "N Levels Explained" format, 16:9.

LAYOUT (strict):
- The canvas is split into TWO horizontal regions, stacked top to bottom:
  • TOP 70% — the slices region: ${count} VERTICAL slices side by side, edge-to-edge with thin dividers (no large gutters). Each slice fills its full height.
  • BOTTOM 30% — the title bar: a single large grunge/distressed title strip across the full width.

SLICES REGION (strict):
- ${count} vertical slices arranged left to right.
- Each slice contains, from top to bottom:
  • A bold "LEVEL N" heading (where N is the slice's 1-based number). Numbers visually prominent (large bold sans-serif). White or near-white on the slice's background.
  • Directly below: the slice's short label in bold ALL-CAPS sans-serif (same colour as the LEVEL heading or a fitting contrast). 1–2 lines max.
  • Filling the rest of the slice height: the illustration — depicting the level's subject as recognisably as possible.
- Each slice has its OWN background and colour treatment that fits its content. A "passive reconnaissance" slice might be cool green; an "exfiltration" slice deep red. Visual progression across slices is a feature.
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

TITLE BAR (strict, fixed structure):
- Pure black background across the full canvas width, filling the bottom 30%.
- Three centred lines of grunge/distressed typography stacked vertically:
  • Line 1: "${count} LEVELS OF" — bold sans-serif, WHITE, slightly distressed.
  • Line 2: "${safeTopic}" — bold sans-serif, YELLOW grunge texture, larger than line 1 (the visual focal point of the title bar).${safeTagline ? `
  • Line 3: "[${safeTagline}]" — bold sans-serif, RED text on a darker red-tinted rectangle, smaller than line 2.` : ''}
- Typography matches the attached reference image's title-bar treatment (grunge, distressed edges, bold display weight).

LEVELS (render exactly these ${count} slices, left to right):

${levelLines}

ABSOLUTE REQUIREMENTS — DO NOT VIOLATE:
- The slices region MUST contain EXACTLY ${count} slices. Not one more, not one fewer.
- One focal subject per slice — no multi-subject collages within a single slice.
- The bottom 30% MUST be the title bar with the three centred grunge lines above (lines 1 and 2 always; line 3 only if a tagline was provided).
- Do NOT add a master title above the slices or anywhere else outside the bottom title bar.
- Match the LAYOUT (vertical slices + bottom title bar) and the TYPOGRAPHY of the attached reference image precisely. Do NOT inherit the reference's specific palette or per-slice content — those are dictated by THIS level list and topic.

${safeNotes ? `STYLE NOTE: ${safeNotes}` : ''}`.trim();
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
