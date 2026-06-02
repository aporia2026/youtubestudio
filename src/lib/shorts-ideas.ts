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

export interface ShortsIdeasInput {
  niche: string;
  /** Optional extra context — recent video themes, channel voice notes. */
  context?: string;
  /** How many ideas to ask for. Clamped to [3, 15] in the prompt. */
  count?: number;
}

const MIN_COUNT = 3;
const MAX_COUNT = 15;
const DEFAULT_COUNT = 8;

export function clampCount(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(n)));
}

export function buildShortsIdeasPrompt(input: ShortsIdeasInput): { system: string; user: string } {
  const count = clampCount(input.count);
  return {
    system: `You are a YouTube Shorts strategist with a track record of 1M-view openers. Generate ${count} hook-first idea pitches for a single channel/niche.

Every idea must:

1. **Open with a literal HOOK line** — the first 1–3 spoken seconds. NOT a topic title. Examples: "You're tying your shoes wrong.", "Why most diet ads are lying to you.", "Nobody tells you what happens at 30,000 ft."

2. **Resolve in ≤60 seconds** — full arc fits in a vertical Short. If the idea needs 2 minutes, cut it.

3. **Be visually 9:16-native** — single subject, vertical-friendly composition. No side-by-side comparisons, no busy infographics, no wide landscape shots that lose half the frame.

4. **Have a payoff that LANDS** — the closing line reframes the hook OR delivers a specific takeaway. Not "subscribe for more".

5. **Pass the Shorts-shelf sniff test** — contrarian claim, lesser-known fact, visceral demonstration, did-you-know reveal, or tight one-trick tutorial.

NEVER USE: "navigate", "landscape", "realm", "buckle up", "let's dive in", "without further ado", "in today's fast-paced world", "game-changer", "today we're going to", "hey guys".

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
    user: `Niche: ${input.niche}
${input.context ? `Context: ${input.context}\n` : ''}
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
