/**
 * Shorts SEO optimizer. Takes the details of a Short the user already
 * made — title, description, length, and optionally the long-form video
 * it was cut from — and returns a few graded options for a better title,
 * description, and hashtag set.
 *
 * Distinct from `shorts.ts` (which extracts a brand-new Short from a long
 * script). This module never touches a script body; it optimizes the
 * metadata of an existing Short and persists an `external_seo` row.
 *
 * The pure parts (prompt builder, JSON parser) are exported for tests so
 * the optimization logic can be verified without burning model calls.
 *
 * See `_plans/2026-06-01-shorts-seo-optimizer.md`.
 */
import { sql } from '@vercel/postgres';
import { generateText } from './ai';
import { parseLlmJson } from './parse-llm-json';
import { logger } from './logger';
import { getEffectiveModelId } from './model-defaults';
import {
  type GradedHashtagSet,
  type GradedSuggestion,
  type ShortSeoResult,
} from './shorts-types';

// ---------------------------------------------------------------------------
// Pure prompt + parsing
// ---------------------------------------------------------------------------

export interface BuildShortSeoPromptArgs {
  /** The title the user gave their existing Short. */
  enteredTitle: string;
  /** The description the user gave their existing Short. */
  enteredDescription: string;
  /** Length of the Short in seconds (informational — shapes hook pacing advice). */
  lengthSeconds: number;
  niche: string;
  /** Title of the source long-form video, when one was linked. */
  sourceVideoTitle?: string;
  /** Active script of the source long-form video, when available. Sliced
   *  before it reaches the prompt so a huge script can't blow the budget. */
  sourceVideoScript?: string;
}

export function buildShortSeoPrompt(args: BuildShortSeoPromptArgs): { system: string; user: string } {
  const { enteredTitle, enteredDescription, lengthSeconds, niche } = args;
  const sourceTitle = args.sourceVideoTitle?.trim();
  const sourceScript = args.sourceVideoScript?.trim();

  return {
    system: `You are the world's top YouTube Shorts SEO strategist. You have optimized metadata for Shorts that pulled tens of millions of views. You understand the vertical-feed algorithm, Shorts search, and click psychology at an expert level.

You are given a Short the creator ALREADY made (its current title, description, and length). Your job is to rewrite the metadata for maximum reach. You are NOT writing a script and NOT changing the video — only the title, description, and hashtags.

## SHORTS METADATA RULES (2026):

**TITLES:**
- Shorts titles are short and punchy. Aim for under 60 characters; the front of the title is read first in the feed and in search.
- Front-load the primary keyword / the hook. Curiosity, a bold claim, a number, or a "how/why" framing all lift taps.
- One title can carry a trailing #hashtag, but keep the readable hook first.
- Never use ALL CAPS for more than one word. No fake clickbait the video does not pay off — high bounce buries a Short fast.

**DESCRIPTIONS:**
- The first line is what shows; it must contain the primary keyword and a reason to keep watching.
- Keep it tight: 1 to 4 short lines. Shorts descriptions are skimmed, not read.
- End with hashtags. Always include #Shorts plus 3 to 7 niche/topic hashtags.

**HASHTAGS:**
- Always include "Shorts" as one of the tags.
- Mix one or two broad niche tags with several specific topic tags.
- Store each tag WITHOUT the leading '#'. No spaces inside a tag.

## GROUND CLAIMS IN REALITY:
Do not invent statistics, fake dates, or quoted experts. A vivid true line beats a fake specific.

## OUTPUT:
Return STRICT JSON only — no prose before or after, no markdown fence required. Grade every option honestly on a 0-100 scale (not everything is a 95). Give a one-line rationale for each.`,

    user: `Optimize the SEO metadata for this existing YouTube Short.

**Niche:** ${niche}
**Length:** ${lengthSeconds} seconds
**Current title:** ${enteredTitle}
**Current description:**
"""
${enteredDescription}
"""
${sourceTitle ? `\n**Source long-form video this Short was cut from:** ${sourceTitle}\nAlign the Short's keywords and framing with this parent video so they reinforce each other in search.` : ''}
${sourceScript ? `\n**Source video script (context for keywords / accuracy):**\n"""\n${sourceScript.slice(0, 4000)}\n"""` : ''}

Return this EXACT JSON shape:

{
  "primary_keyword": "<the main keyword this Short should rank for>",
  "titles": [
    { "text": "<optimized title, under ~60 chars>", "score": <0-100>, "rationale": "<one line: why this works>" }
  ],
  "descriptions": [
    { "text": "<optimized description, 1-4 short lines, hashtags at the end>", "score": <0-100>, "rationale": "<one line>" }
  ],
  "hashtag_sets": [
    { "tags": ["Shorts", "<tag>", "<tag>"], "score": <0-100>, "rationale": "<one line>" }
  ],
  "notes": "<one or two sentences of overall SEO advice for this Short>"
}

Generate 4 distinct title options (different angles: curiosity, how/why, number/list, bold claim), 3 description options, and 2 hashtag sets. Return ONLY valid JSON.`,
  };
}

// ---------------------------------------------------------------------------
// Native Short SEO — Phase 15.2
// ---------------------------------------------------------------------------
//
// `buildShortSeoPrompt` above optimizes a Short the USER ALREADY MADE
// (paste-and-grade flow). For Shorts we generated in-app via the extractor
// or Mode C, the SEO input shape is different — we have the actual script,
// hook, and payoff, not a user-typed title/description pair.
//
// `buildNativeShortSeoPrompt` reframes the task: "given a generated Short
// script, write the title + description + hashtags". Output shape is the
// SAME ShortSeoResult so `parseShortSeoResult` is reused without a sibling
// parser — one fewer thing to keep in sync.
//
// Native-specific rules (verified 2026-06-02 via WebSearch):
//   - Description target ≤150 chars (the part above the fold on mobile).
//   - 3-5 hashtags max (more than 15 = ALL hashtags ignored; we cap further).
//   - No #Shorts injection — YouTube auto-classifies 9:16 ≤180s. Saves a
//     precious title char.
//   - No chapters — Shorts don't render chapters in the vertical feed.

export interface BuildNativeShortSeoPromptArgs {
  /** The current title from the row, if any (extractor often supplies one). */
  generatedTitle?: string;
  /** The Short's spoken script — used to extract keywords + framing. */
  shortScript: string;
  /** The literal hook line — load-bearing for the title. */
  hook?: string;
  /** The literal payoff line. */
  payoff?: string;
  /** Length in seconds (informational). */
  lengthSeconds: number;
  niche: string;
  /** Title of the source long-form video, when this Short was derived. */
  sourceVideoTitle?: string;
}

export function buildNativeShortSeoPrompt(
  args: BuildNativeShortSeoPromptArgs,
): { system: string; user: string } {
  const sourceTitle = args.sourceVideoTitle?.trim();
  return {
    system: `You are the world's top YouTube Shorts SEO strategist. You write metadata for Shorts that the algorithm RECOGNISES and surfaces.

You are given a Short SCRIPT we GENERATED — not a user-pasted Short. The video does not exist yet. Your job is to write the title, description, and hashtags that will give this Short the best chance on the vertical feed + Shorts search.

## SHORTS METADATA RULES (verified June 2026):

**TITLES:**
- Under 60 characters. Front-load the hook or the primary keyword. The first 35-40 chars are what's read in the feed.
- DO NOT inject #Shorts in the title. YouTube auto-classifies 9:16 video ≤180s — the hashtag wastes chars and provides zero categorisation lift.
- Curiosity / bold-claim / specific-number framings beat list-style titles on Shorts.
- Never ALL CAPS for more than one word. No fake clickbait — high bounce buries a Short fast.

**DESCRIPTIONS:**
- Target ≤150 characters. Mobile-feed users see only the above-the-fold cut; longer text is wasted.
- One short line of context + hashtags. Do not write paragraphs.
- No chapters — they don't render in the vertical feed.

**HASHTAGS:**
- 3 to 5 hashtags max. More than 5 = diminishing returns; more than 15 = YouTube ignores them all.
- DO NOT include "Shorts" — see title rule.
- Mix one broad niche tag with 2-4 specific topic tags. Store each WITHOUT the leading '#'. No spaces inside a tag.

## GROUND CLAIMS IN REALITY:
Do not invent statistics, fake dates, or quoted experts. A vivid true line beats a fake specific.

## OUTPUT:
Return STRICT JSON only — no prose before or after, no markdown fence. Grade every option 0-100 (not everything is a 95). One-line rationale for each.`,
    user: `Write SEO metadata for this generated YouTube Short.

**Niche:** ${args.niche}
**Length:** ${args.lengthSeconds} seconds
${args.generatedTitle ? `**Working title:** ${args.generatedTitle}\n` : ''}${args.hook ? `**Hook line:** ${args.hook}\n` : ''}${args.payoff ? `**Payoff line:** ${args.payoff}\n` : ''}**Short script:**
"""
${args.shortScript.trim().slice(0, 4000)}
"""
${sourceTitle ? `\n**Source long-form video:** ${sourceTitle}\nAlign the Short's keywords + framing with this parent video so they reinforce each other in search.\n` : ''}
Return this EXACT JSON shape:

{
  "primary_keyword": "<the main keyword this Short should rank for>",
  "titles": [
    { "text": "<title, under 60 chars, NO #Shorts>", "score": <0-100>, "rationale": "<one line>" }
  ],
  "descriptions": [
    { "text": "<description ≤150 chars including hashtags at end, no chapters, no #Shorts>", "score": <0-100>, "rationale": "<one line>" }
  ],
  "hashtag_sets": [
    { "tags": ["<3-5 tags, NO 'Shorts'>"], "score": <0-100>, "rationale": "<one line>" }
  ],
  "notes": "<one or two sentences of overall SEO advice>"
}

Generate 4 distinct title options (curiosity / bold claim / number / how-why), 3 description options, and 2 hashtag sets. Return ONLY valid JSON.`,
  };
}

/** Coerce an unknown to a 0-100 integer score, defaulting to 0. */
function toScore(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toGradedSuggestions(raw: unknown): GradedSuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const text = typeof o.text === 'string' ? o.text.trim() : '';
      return {
        text,
        score: toScore(o.score),
        rationale: typeof o.rationale === 'string' ? o.rationale.trim() : '',
      };
    })
    .filter((s) => s.text.length > 0);
}

function toHashtagSets(raw: unknown): GradedHashtagSet[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(o.tags)
        ? o.tags
            .map((t) => (typeof t === 'string' ? t.trim().replace(/^#+/, '').replace(/\s+/g, '') : ''))
            .filter((t) => t.length > 0)
        : [];
      return {
        tags,
        score: toScore(o.score),
        rationale: typeof o.rationale === 'string' ? o.rationale.trim() : '',
      };
    })
    .filter((s) => s.tags.length > 0);
}

/**
 * Parse the optimizer's structured response. Tolerates fenced JSON,
 * extra prose, and minor schema drift, normalising every field. Throws
 * only when nothing usable comes back (no JSON, or zero title options),
 * so the caller can surface a uniform error.
 */
export function parseShortSeoResult(raw: string): ShortSeoResult {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse JSON from optimizer response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Could not parse JSON from optimizer response: not an object.');
  }
  const obj = parsed as Record<string, unknown>;
  const titles = toGradedSuggestions(obj.titles);
  if (titles.length === 0) {
    throw new Error('Optimizer returned no usable title options.');
  }
  return {
    primary_keyword: typeof obj.primary_keyword === 'string' ? obj.primary_keyword.trim() : '',
    titles,
    descriptions: toGradedSuggestions(obj.descriptions),
    hashtag_sets: toHashtagSets(obj.hashtag_sets),
    notes: typeof obj.notes === 'string' ? obj.notes.trim() : '',
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface OptimizeShortSeoArgs {
  workspaceId: string;
  /** Source long-form video (a `projects` row). Optional — null when the
   *  Short isn't tied to a created video. Already verified workspace-owned
   *  by the route before it reaches here. */
  projectId: string | null;
  enteredTitle: string;
  enteredDescription: string;
  lengthSeconds: number;
  niche: string;
  sourceVideoTitle?: string;
  sourceVideoScript?: string;
  modelId?: string;
}

/**
 * Run the optimizer and persist an `external_seo` shorts row. Returns the
 * new row id + the parsed result so the UI can render without a follow-up
 * GET.
 */
export async function optimizeAndSaveShortSeo(
  args: OptimizeShortSeoArgs,
): Promise<{ id: string; result: ShortSeoResult }> {
  const modelId = args.modelId || (await getEffectiveModelId(args.workspaceId, 'shorts-seo'));
  const lengthSeconds = Math.max(1, Math.min(600, Math.round(args.lengthSeconds) || 1));

  const { system, user } = buildShortSeoPrompt({
    enteredTitle: args.enteredTitle,
    enteredDescription: args.enteredDescription,
    lengthSeconds,
    niche: args.niche,
    sourceVideoTitle: args.sourceVideoTitle,
    sourceVideoScript: args.sourceVideoScript,
  });

  const raw = await generateText({
    modelId,
    systemPrompt: system,
    prompt: user,
    maxTokens: 4000,
    temperature: 0.7,
    spend: {
      workspaceId: args.workspaceId,
      projectId: args.projectId ?? null,
      featureArea: 'shorts_seo',
      metadata: { length_seconds: lengthSeconds, has_source_video: args.projectId !== null },
    },
  });

  let result: ShortSeoResult;
  try {
    result = parseShortSeoResult(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('shorts SEO optimization failed', { detail, raw_preview: raw.slice(0, 400) });
    throw new Error(`Optimizer returned a malformed response: ${detail}`);
  }

  // Sanity-derived estimate kept consistent with extracted rows: the
  // length the user typed IS the duration for an external Short.
  const { rows } = await sql<{ id: string }>`
    INSERT INTO shorts (
      workspace_id, project_id, kind,
      title, source_title, source_description,
      estimated_duration_seconds, seo_result,
      ai_model, generation_params
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.projectId}::uuid,
      'external_seo',
      ${args.enteredTitle || null},
      ${args.enteredTitle || null},
      ${args.enteredDescription || null},
      ${lengthSeconds},
      ${JSON.stringify(result)}::jsonb,
      ${modelId},
      ${JSON.stringify({ niche: args.niche, lengthSeconds, hasSourceVideo: args.projectId !== null })}::jsonb
    )
    RETURNING id
  `;
  return { id: rows[0]!.id, result };
}
