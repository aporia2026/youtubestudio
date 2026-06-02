/**
 * Shorts Ideas — hook-first vertical idea generation. Phase 15.2.
 *
 * The long-form `idea-generator` asks for ideas tuned to 8–15 minute
 * videos. Shorts ideas are a different animal:
 *
 *   - HOOK-FIRST. Every idea opens with the literal first-3-seconds
 *     line, not a topic title. The hook IS the idea.
 *   - 60-SECOND PAYOFF. The idea has to make sense as a complete arc
 *     in ~45-60s — no 8-minute deep-dives carved into vertical.
 *   - VERTICAL-FRIENDLY. The visual concept fits in 9:16 without
 *     wide-shot crutches (no comparison-side-by-side, no busy infographic).
 *   - SHORTS-SHELF FIT. Topics that match the algorithm's known winners:
 *     contrarian claims, lesser-known facts, visceral demonstrations,
 *     "did-you-know" reveals, tight tutorials with one trick.
 *
 * Each generated idea carries:
 *   - hook        — literal first-3-seconds line (the strongest signal)
 *   - title       — 6–8 word punchy display title
 *   - payoff      — the literal closing line
 *   - thesis      — one sentence on what the Short PROVES (so QA + SEO
 *                   have something concrete to grade)
 *   - shotConcept — one line on the visual shape of the Short
 *
 * Output is sorted by the model's own confidence; UI pages can re-sort
 * by hook strength once they run each idea's hook through the Phase 1
 * scorer (deterministic, free).
 */

import { parseLlmJson } from './parse-llm-json';

export interface ShortIdea {
  hook: string;
  title: string;
  payoff: string;
  thesis: string;
  shotConcept: string;
  /** 0..1, the model's self-rated confidence the idea will land. */
  confidence: number;
}

/** Phase 15.8 — format hint vocabularies. Kept here (not the
 *  registry) because they live ONLY in the prompt + the picker UI;
 *  no DB column reads them. The lists are deliberately small so the
 *  model has clear choices and the UI fits chip rows. */
export const HOOK_STYLES = [
  'question',
  'number',
  'contrarian',
  'story',
  'fact-reveal',
  'youre-doing-it-wrong',
] as const;
export type HookStyle = (typeof HOOK_STYLES)[number];

export const TONES = [
  'irreverent',
  'authoritative',
  'wry',
  'earnest',
  'urgent',
] as const;
export type Tone = (typeof TONES)[number];

export const POVS = ['first-person', 'second-person', 'third-person'] as const;
export type PovStyle = (typeof POVS)[number];

const MIN_LENGTH_SEC = 15;
const MAX_LENGTH_SEC = 90;

export interface FormatHints {
  /** Target Short length in seconds. Clamped to [15, 90]. Optional. */
  targetLengthSec?: number;
  /** Hook-style archetype. Optional. */
  hookStyle?: HookStyle;
  /** Tone. Optional. */
  tone?: Tone;
  /** Point of view. Optional. */
  pov?: PovStyle;
}

export interface NicheContext {
  /** Free-text description from the workspace's niches table. */
  description?: string;
  /** Keyword chips from the same row. */
  keywords?: string[];
}

export interface ShortsIdeasInput {
  niche: string;
  /** Optional extra context — recent video themes, channel voice notes. */
  context?: string;
  /** How many ideas to ask for. Clamped to [3, 15] in the prompt. */
  count?: number;
  /** Phase 15.8 — format controls injected into the prompt. */
  formatHints?: FormatHints;
  /** Phase 15.8 — workspace niche details (description + keywords) the user
   *  picked from a dropdown. Auto-loaded when a niche row is picked. */
  nicheContext?: NicheContext;
  /** Phase 15.8 — series-locked intro/outro copy that should colour every
   *  idea in the batch. Comes from the Phase 15.6 Series engine. */
  seriesIntro?: string;
  seriesOutro?: string;
  /** Phase 15.8 — "Inspired by" titles. Top-performing recent Shorts on
   *  the user's channel, surfaced for stylistic priming WITHOUT copying. */
  inspiredByTitles?: string[];
  /** Phase 15.8 — recent titles the user has already covered, surfaced
   *  for negative priming ("don't propose topics that look like these"). */
  avoidTitles?: string[];
}

const MIN_COUNT = 3;
const MAX_COUNT = 15;
const DEFAULT_COUNT = 8;

export function clampCount(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(n)));
}

/** Clamp a target length to the doctrine window. Out-of-range or
 *  non-finite values return undefined so the prompt just omits the
 *  hint instead of forcing a bogus value on the model. */
export function clampTargetLength(n: number | undefined): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.max(MIN_LENGTH_SEC, Math.min(MAX_LENGTH_SEC, Math.round(n)));
}

const HOOK_STYLE_HINTS: Record<HookStyle, string> = {
  question: 'Open every hook with a question form ("Why...", "What if...", "Did you know...").',
  number: 'Open every hook with a specific concrete number ("3 reasons...", "By 27...", "1 in 4...").',
  contrarian: 'Open every hook with a contrarian / counter-intuitive claim that overturns common belief.',
  story: 'Open every hook in story-mode — drop the viewer mid-action ("She walked in and..." / "I was 14 when...").',
  'fact-reveal': 'Open every hook with a "Nobody tells you / No one knows" reveal that promises a lesser-known fact.',
  'youre-doing-it-wrong': "Open every hook with a 'You're doing it wrong' framing — call out a default behaviour as broken.",
};

const TONE_HINTS: Record<Tone, string> = {
  irreverent: 'Tone: irreverent, dry, willing to mock the niche\'s sacred cows.',
  authoritative: 'Tone: authoritative — speak as a teacher who has seen this 1000 times.',
  wry: 'Tone: wry / amused — small smirk in every line, never grim.',
  earnest: 'Tone: earnest — no irony, treat the viewer as a friend who genuinely wants to learn.',
  urgent: 'Tone: urgent — every line carries a "you need to know this NOW" pulse.',
};

const POV_HINTS: Record<PovStyle, string> = {
  'first-person': 'Point of view: first-person — speaker is the protagonist ("I tried...", "I noticed...").',
  'second-person': 'Point of view: second-person — speaker addresses the viewer directly ("You...", "Your...").',
  'third-person': 'Point of view: third-person narrator — speaker explains what happens to someone else.',
};

/** Builds an optional "doctrine block" injected into the system prompt
 *  when format hints are supplied. Pure-string composition — tested. */
export function buildDoctrineBlock(hints: FormatHints): string {
  const lines: string[] = [];
  const length = clampTargetLength(hints.targetLengthSec);
  if (length) {
    lines.push(`Target length: ~${length} seconds spoken — pace ideas so the body fits without rushing.`);
  }
  if (hints.hookStyle) {
    lines.push(HOOK_STYLE_HINTS[hints.hookStyle]);
  }
  if (hints.tone) {
    lines.push(TONE_HINTS[hints.tone]);
  }
  if (hints.pov) {
    lines.push(POV_HINTS[hints.pov]);
  }
  if (lines.length === 0) return '';
  return `

DOCTRINE (treat as hard constraints, not suggestions):
${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** Builds the niche context block. Optional — empty when neither the
 *  description nor keywords are supplied. */
export function buildNicheContextBlock(nc: NicheContext | undefined): string {
  if (!nc) return '';
  const desc = typeof nc.description === 'string' ? nc.description.trim() : '';
  const kws = Array.isArray(nc.keywords)
    ? nc.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, 30)
    : [];
  if (!desc && kws.length === 0) return '';
  const parts: string[] = [];
  if (desc) parts.push(`Niche description: ${desc.slice(0, 1000)}`);
  if (kws.length > 0) parts.push(`Niche keywords: ${kws.join(', ')}`);
  return `\n${parts.join('\n')}\n`;
}

/** Builds the series intro/outro context block. Optional. */
export function buildSeriesBlock(intro?: string, outro?: string): string {
  const introT = typeof intro === 'string' ? intro.trim() : '';
  const outroT = typeof outro === 'string' ? outro.trim() : '';
  if (!introT && !outroT) return '';
  const parts: string[] = ['', 'SERIES CONTEXT — every idea will run under a recurring series:'];
  if (introT) parts.push(`- Series intro (spoken on every episode): "${introT.slice(0, 280)}"`);
  if (outroT) parts.push(`- Series outro (spoken on every episode): "${outroT.slice(0, 280)}"`);
  parts.push('Hook should still stand alone — the intro plays BEFORE the hook, not as the hook.');
  return parts.join('\n') + '\n';
}

/** Builds the inspired-by / avoid lists block. Both lists are sliced
 *  to a sane cap to keep the prompt budget bounded. */
export function buildInspirationBlock(inspiredBy: string[] | undefined, avoid: string[] | undefined): string {
  const inspired = Array.isArray(inspiredBy)
    ? inspiredBy.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 8)
    : [];
  const avoidList = Array.isArray(avoid)
    ? avoid.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 20)
    : [];
  if (inspired.length === 0 && avoidList.length === 0) return '';
  const parts: string[] = [''];
  if (inspired.length > 0) {
    parts.push('INSPIRED BY (these recent Shorts performed well — pattern the energy, do NOT copy the topics):');
    parts.push(inspired.map((t) => `- "${t}"`).join('\n'));
  }
  if (avoidList.length > 0) {
    parts.push('AVOID (the user has already covered these — propose distinct topics):');
    parts.push(avoidList.map((t) => `- "${t}"`).join('\n'));
  }
  return parts.join('\n') + '\n';
}

export function buildShortsIdeasPrompt(input: ShortsIdeasInput): { system: string; user: string } {
  const count = clampCount(input.count);
  const doctrineBlock = input.formatHints ? buildDoctrineBlock(input.formatHints) : '';
  const nicheBlock = buildNicheContextBlock(input.nicheContext);
  const seriesBlock = buildSeriesBlock(input.seriesIntro, input.seriesOutro);
  const inspirationBlock = buildInspirationBlock(input.inspiredByTitles, input.avoidTitles);
  return {
    system: `You are a YouTube Shorts strategist with a track record of 1M-view openers. Generate ${count} hook-first idea pitches for a single channel/niche.

Every idea must:

1. **Open with a literal HOOK line** — the first 1–3 spoken seconds. NOT a topic title. Examples: "You're tying your shoes wrong.", "Why most diet ads are lying to you.", "Nobody tells you what happens at 30,000 ft."

2. **Resolve in ≤60 seconds** — full arc fits in a vertical Short. If the idea needs 2 minutes, cut it.

3. **Be visually 9:16-native** — single subject, vertical-friendly composition. No side-by-side comparisons, no busy infographics, no wide landscape shots that lose half the frame.

4. **Have a payoff that LANDS** — the closing line reframes the hook OR delivers a specific takeaway. Not "subscribe for more".

5. **Pass the Shorts-shelf sniff test** — contrarian claim, lesser-known fact, visceral demonstration, did-you-know reveal, or tight one-trick tutorial.

NEVER USE: "navigate", "landscape", "realm", "buckle up", "let's dive in", "without further ado", "in today's fast-paced world", "game-changer", "today we're going to", "hey guys".${doctrineBlock}

Output STRICTLY this JSON shape with no prose:

{
  "ideas": [
    {
      "hook": "<literal first 1-3 second line, 6-12 words>",
      "title": "<6-8 word punchy display title>",
      "payoff": "<literal closing line, 4-12 words>",
      "thesis": "<one sentence: what this Short PROVES>",
      "shotConcept": "<one line: the visual shape — what's on screen>",
      "confidence": 0.0
    }
  ]
}`,
    user: `Niche: ${input.niche}${nicheBlock}${seriesBlock}${input.context ? `Context: ${input.context}\n` : ''}${inspirationBlock}
Generate ${count} hook-first Shorts ideas now. JSON only.`,
  };
}

interface RawIdea {
  hook?: unknown;
  title?: unknown;
  payoff?: unknown;
  thesis?: unknown;
  shotConcept?: unknown;
  shot_concept?: unknown;
  confidence?: unknown;
}

function asTrimmed(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function parseConfidence(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.5;
  return Math.max(0, Math.min(1, raw));
}

/** Parse the LLM response. Throws if the response has no usable ideas
 *  but tolerates per-idea field gaps by skipping the bad rows. */
export function parseShortsIdeas(raw: string): ShortIdea[] {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse Shorts ideas JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Shorts ideas response was not a JSON object.');
  }
  const rawIdeas = (parsed as { ideas?: unknown }).ideas;
  if (!Array.isArray(rawIdeas)) {
    throw new Error('Shorts ideas response is missing the "ideas" array.');
  }
  const out: ShortIdea[] = [];
  for (const r of rawIdeas) {
    if (!r || typeof r !== 'object') continue;
    const idea = r as RawIdea;
    const hook = asTrimmed(idea.hook);
    const title = asTrimmed(idea.title);
    if (!hook || !title) continue; // hook + title are load-bearing
    out.push({
      hook,
      title,
      payoff: asTrimmed(idea.payoff),
      thesis: asTrimmed(idea.thesis),
      shotConcept: asTrimmed(idea.shotConcept ?? idea.shot_concept),
      confidence: parseConfidence(idea.confidence),
    });
  }
  if (out.length === 0) {
    throw new Error('No valid Shorts ideas in the response.');
  }
  return out;
}
