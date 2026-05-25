/**
 * Pre-QA self-check (Lever B of the QA hardening plan).
 *
 * Runs ONCE per fresh script generation, between writing the draft and
 * handing it to the critic panel. One LLM call asks the generator to:
 *
 *   1. Self-critique against the same 10 rubric categories the critics
 *      use (hook strength, retention, content quality, etc.).
 *   2. Identify the single weakest section (a paragraph or contiguous
 *      block of the script).
 *   3. Rewrite that section to address the weakness.
 *
 * The rewrite is spliced back into the original script. If the model
 * declines to rewrite (self-score >= the keep-as-is threshold), the
 * script passes through untouched. Either way the critics see the
 * exact text the user would ship; the self-check is invisible to the
 * downstream panel.
 *
 * Cost: one extra LLM call per first-pass script. Earns back the cost
 * any time it eliminates a qa-retry iteration. Verified against the
 * Wave 1 telemetry table (`video_stage_transitions`) once enough
 * scripts have flowed through.
 *
 * Standards: the prompt instructs the self-critic to grade at NUCLEAR
 * level — same bar the auto-pipeline's critic panel applies. We are
 * raising first-pass quality, never lowering the QA threshold.
 *
 * Observability per standing rule 14:
 *   [qa pre-check decision] kept | rewrote
 *   [qa pre-check self-score] numeric
 *   [qa pre-check rewrite-len] original + improved char counts
 */

// Server-only by virtue of importing generateText (which uses server APIs).
// We deliberately do not `import 'server-only'` because the package is not
// installed in this project; the runtime guard is implicit through the
// import chain.
import { generateText } from '@/lib/ai';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { logger } from '@/lib/logger';
import { SCRIPT_CRITICS } from './prompts';

/**
 * Threshold below which a rewrite is applied. The self-critic scores 0
 * to 100 on the same scale as the critic panel; anything at or above
 * this value is treated as "good enough on first draft, do not risk
 * making it worse by rewriting." Tuned conservatively: rewrites only
 * when there is real upside.
 */
const REWRITE_THRESHOLD = 90;

/**
 * Minimum length of a flagged section before we are willing to splice
 * a rewrite. Below this, the section is too small for the splice to
 * be safe (the model can mistakenly identify a single sentence as the
 * weakest "section," and replacing one sentence with a paragraph
 * disrupts pacing). Words, not characters, because word counts are
 * more stable across formatting differences.
 */
const MIN_SECTION_WORDS = 25;

export interface PreQaSelfCheckInput {
  scriptText: string;
  niche: string;
  /** Model id to use. Caller passes the script-generator's model so the
   *  self-check happens "in voice" — the same model that wrote the
   *  draft is the right one to revise it. */
  modelId: string;
  /** Spend-logging context. The self-check is logged under
   *  `pipeline_pre_qa_self_check` so it shows up separately from
   *  primary script generation in cost reports. */
  spend?: {
    workspaceId: string;
    projectId?: string | null;
    sourceScriptId?: string | null;
  };
}

export interface PreQaSelfCheckResult {
  /** Final script text. Either the original (kept) or the original with
   *  one section replaced by the rewrite (rewrote). */
  scriptText: string;
  /** What the self-check decided. */
  decision: 'kept' | 'rewrote' | 'skipped';
  /** Self-rated overall score (0-100), or null when skipped / parse failed. */
  selfScore: number | null;
  /** When `decision === 'rewrote'`, the section that was replaced. */
  rewroteSection?: {
    original: string;
    improved: string;
    reason: string;
    weaknessCategory: string;
  };
  /** When `decision === 'skipped'`, the reason. */
  skipReason?: string;
}

/**
 * Run the self-check pass. Resilient: any LLM failure or parse error
 * falls back to returning the original script with `decision: 'skipped'`
 * so the auto-pipeline never blocks on a self-check problem.
 */
export async function runPreQaSelfCheck(input: PreQaSelfCheckInput): Promise<PreQaSelfCheckResult> {
  const original = input.scriptText;
  if (!original.trim()) {
    return { scriptText: original, decision: 'skipped', selfScore: null, skipReason: 'empty script' };
  }

  logger.info('[qa pre-check] start', {
    niche: input.niche,
    model_id: input.modelId,
    script_chars: original.length,
  });

  const { system, user } = buildSelfCheckPrompt(original, input.niche);

  let raw: string;
  try {
    raw = await generateText({
      modelId: input.modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 4000,
      // Low temp for grading; rewrites need some creativity but the
      // self-check is mostly diagnostic. 0.4 splits the difference.
      temperature: 0.4,
      cache: true,
      spend: input.spend
        ? { ...input.spend, featureArea: 'pipeline_pre_qa_self_check' }
        : undefined,
    });
  } catch (err) {
    logger.warn('[qa pre-check] llm-error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return { scriptText: original, decision: 'skipped', selfScore: null, skipReason: 'llm error' };
  }

  let parsed: SelfCheckRaw | null = null;
  try {
    parsed = parseLlmJson(raw) as SelfCheckRaw;
  } catch {
    logger.warn('[qa pre-check] parse-error', { raw_preview: raw.slice(0, 200) });
    return { scriptText: original, decision: 'skipped', selfScore: null, skipReason: 'parse error' };
  }

  const selfScore = clamp01to100(Number(parsed.self_score) || 0);

  // High self-score → keep the original. Don't risk regressing a good draft.
  if (selfScore >= REWRITE_THRESHOLD) {
    logger.info('[qa pre-check] decision', {
      decision: 'kept',
      self_score: selfScore,
      threshold: REWRITE_THRESHOLD,
    });
    return { scriptText: original, decision: 'kept', selfScore };
  }

  const sectionOriginal = String(parsed.weakest_section?.original || '').trim();
  const sectionImproved = String(parsed.weakest_section?.improved || '').trim();
  const sectionReason = String(parsed.weakest_section?.reason || '').slice(0, 400);
  const weaknessCategory = String(parsed.weakest_section?.category || '').slice(0, 80);

  // Validity gates: the model must have identified a substantial section
  // that actually appears in the script, and produced a non-trivial rewrite.
  if (!sectionOriginal || !sectionImproved) {
    logger.info('[qa pre-check] decision', {
      decision: 'kept',
      self_score: selfScore,
      reason: 'no actionable rewrite returned',
    });
    return { scriptText: original, decision: 'kept', selfScore };
  }

  if (wordCount(sectionOriginal) < MIN_SECTION_WORDS) {
    logger.info('[qa pre-check] decision', {
      decision: 'kept',
      self_score: selfScore,
      reason: 'flagged section too small to splice safely',
      section_words: wordCount(sectionOriginal),
    });
    return { scriptText: original, decision: 'kept', selfScore };
  }

  // Locate the section in the original script. Allow whitespace
  // differences (the model may normalise line breaks) by collapsing
  // runs of whitespace before searching.
  const splicedScript = spliceSection(original, sectionOriginal, sectionImproved);
  if (splicedScript === null) {
    logger.warn('[qa pre-check] splice-failed', {
      self_score: selfScore,
      reason: 'flagged section text not found in script',
    });
    return { scriptText: original, decision: 'kept', selfScore, skipReason: 'splice failed' };
  }

  logger.info('[qa pre-check] decision', {
    decision: 'rewrote',
    self_score: selfScore,
    weakness_category: weaknessCategory,
    original_section_chars: sectionOriginal.length,
    improved_section_chars: sectionImproved.length,
    script_chars_before: original.length,
    script_chars_after: splicedScript.length,
  });

  return {
    scriptText: splicedScript,
    decision: 'rewrote',
    selfScore,
    rewroteSection: {
      original: sectionOriginal,
      improved: sectionImproved,
      reason: sectionReason,
      weaknessCategory,
    },
  };
}

interface SelfCheckRaw {
  self_score?: number;
  weakest_section?: {
    original?: string;
    improved?: string;
    reason?: string;
    category?: string;
  };
}

function buildSelfCheckPrompt(scriptText: string, niche: string): { system: string; user: string } {
  // Concatenate the three critic rubrics so the self-check grades against
  // the same bar the panel will. Pulled from SCRIPT_CRITICS so adding a
  // new critic in `skills/*.md` automatically widens the self-check.
  const rubricBlock = SCRIPT_CRITICS.map(c =>
    `## ${c.persona}\nMission: ${c.mission}\nRubric:\n${c.rubric}`,
  ).join('\n\n');

  const system = [
    `You are the script's own author, acting as your harshest self-critic before the script ships to the critic panel. Niche: "${niche}".`,
    '',
    'Grade at NUCLEAR level — zero tolerance for mediocrity. The panel that reviews this next will not score above 100, and the panel only ships scripts that reach 100 on multiple passes. Your job is to make their job easier by catching the worst weakness FIRST.',
    '',
    'The same 10-category rubric the panel uses:',
    '',
    rubricBlock,
    '',
    'PROCESS:',
    '  1. Read the script.',
    '  2. Score it 0-100 against the full rubric (nuclear-mode harshness).',
    '  3. Identify the SINGLE weakest contiguous section — usually one paragraph or one section of the script.',
    '  4. Rewrite that section so it would score significantly higher on the category it failed in.',
    '',
    'CONSTRAINTS:',
    `  - If you can honestly grade the script ≥ ${REWRITE_THRESHOLD}, return { "self_score": <n>, "weakest_section": null } — do NOT invent a weakness.`,
    '  - The rewrite must replace the EXACT original text. Quote it verbatim in `weakest_section.original` so it can be spliced back into the script.',
    `  - The flagged section must be at least ${MIN_SECTION_WORDS} words. Sub-sentence nits are out of scope.`,
    '  - Do NOT change the script\'s topic, length target, or overall structure.',
    '  - Do NOT add an introduction explaining what you did. JSON only.',
    '',
    'Output ONLY JSON of shape:',
    `{
  "self_score": number,                  // 0-100 nuclear-mode grade
  "weakest_section": {
    "category": string,                  // which of the 10 rubric categories this fails (e.g. "hook_strength", "human_authenticity")
    "reason": string,                    // one sentence: why this section underperforms
    "original": string,                  // VERBATIM text from the script (≥ ${MIN_SECTION_WORDS} words)
    "improved": string                   // your rewrite of that section, addressing the reason
  } | null                               // null only when self_score ≥ ${REWRITE_THRESHOLD}
}`,
    '',
    'Output nothing except the JSON object.',
  ].join('\n');

  const user = [
    'SCRIPT TO SELF-CHECK:',
    '```',
    scriptText,
    '```',
    '',
    'Output the JSON object.',
  ].join('\n');

  return { system, user };
}

/**
 * Replace one section of the script with the rewrite. Looks for the
 * exact original text first; if not found, tries a whitespace-tolerant
 * match where runs of whitespace are collapsed to a single space.
 * Returns null when neither match succeeds — the caller treats this as
 * "splice failed, keep the original."
 *
 * Single replacement only — if the same passage appears twice in the
 * script (unusual but possible), only the first instance is replaced.
 * The model is instructed to quote verbatim so collisions are rare.
 */
function spliceSection(script: string, original: string, improved: string): string | null {
  // Exact match first.
  const exactIdx = script.indexOf(original);
  if (exactIdx >= 0) {
    return script.slice(0, exactIdx) + improved + script.slice(exactIdx + original.length);
  }

  // Whitespace-tolerant match. Build a position map from collapsed
  // script -> original script indices so we can splice precisely
  // even when the model normalised line breaks.
  const { collapsed, indexMap } = collapseWhitespaceWithIndex(script);
  const originalCollapsed = original.replace(/\s+/g, ' ').trim();
  const collapsedIdx = collapsed.indexOf(originalCollapsed);
  if (collapsedIdx < 0) return null;

  const startInScript = indexMap[collapsedIdx];
  const endInScript = indexMap[collapsedIdx + originalCollapsed.length - 1] + 1;
  if (typeof startInScript !== 'number' || typeof endInScript !== 'number') return null;

  return script.slice(0, startInScript) + improved + script.slice(endInScript);
}

/** Collapse whitespace and produce an index map from the collapsed
 *  string back to the original. indexMap[i] = original-string index of
 *  the i-th character in the collapsed string. */
function collapseWhitespaceWithIndex(s: string): { collapsed: string; indexMap: number[] } {
  const collapsed: string[] = [];
  const indexMap: number[] = [];
  let lastWasWs = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!lastWasWs && collapsed.length > 0) {
        collapsed.push(' ');
        indexMap.push(i);
        lastWasWs = true;
      }
    } else {
      collapsed.push(ch);
      indexMap.push(i);
      lastWasWs = false;
    }
  }
  // Trim trailing whitespace.
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === ' ') {
    collapsed.pop();
    indexMap.pop();
  }
  return { collapsed: collapsed.join(''), indexMap };
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function clamp01to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
