/**
 * Lean Shorts QA — Phase 15.2.
 *
 * Single AI call grades a short_native script against 5 Shorts-specific
 * criteria + computes the hook score deterministically (Phase 1 helper),
 * returning a composite verdict + 3 concrete fixes.
 *
 * Why "lean":
 *   The long-form `/critics` panel runs a 5-call charter → draft →
 *   deliberation → chair loop because a 10-minute script has 100+
 *   decision points worth pressure-testing. A 60-second Short has 5
 *   meaningful decision points (hook / payoff / density / loop / safe-
 *   zone) and a single grader fits the surface. Cost ~$0.02 vs ~$0.30.
 *
 * Five criteria (all 0..1):
 *   - hookStrength     — deterministic, via hook-scoring.ts on first
 *                        ~1.5s of script.
 *   - threeSecondRule  — AI: does the script earn the second 3 seconds?
 *                        I.e., does line 2 deliver enough that a swipe
 *                        feels like a loss?
 *   - payoffClarity    — AI: does the last line land a payoff that
 *                        reframes or completes the hook?
 *   - captionReadable  — AI: are sentences under ~12 words, fragment-
 *                        friendly, easy to caption-on-screen?
 *   - loopPotential    — AI: does the close want to send the viewer back
 *                        to the open? Bonus when the payoff IS the hook
 *                        recontextualised.
 *   - verticalSafeZone — AI: does the script's emotional arc complete in
 *                        ≤60s of speech? Penalises scripts that need a
 *                        second beat to make sense.
 *
 * Composite is a weighted average; weights mirror the criteria order in
 * the plan §7 Phase 2. The grader returns BOTH per-criterion scores AND
 * 3 specific fixes targeting the lowest-scored criteria.
 */

import { parseLlmJson } from './parse-llm-json';
import { scoreHook } from './hook-scoring';

export interface ShortsQaInput {
  /** The script text — should be the short_script body, not the title. */
  scriptText: string;
  /** Optional hook to score independently. If absent, we slice the first
   *  ~1.5s of speech from `scriptText` (~3.5 words at WORDS_PER_SECOND). */
  hookText?: string;
  /** Optional payoff line. If absent we use the script's last sentence. */
  payoffText?: string;
}

export interface ShortsQaCriterionScore {
  /** 0..1. */
  score: number;
  /** One-line explanation. */
  reason: string;
}

export interface ShortsQaResult {
  /** Composite 0..1. */
  composite: number;
  /** Deterministic hook score (Phase 1 helper). */
  hookStrength: ShortsQaCriterionScore;
  /** AI-graded criteria. */
  threeSecondRule: ShortsQaCriterionScore;
  payoffClarity: ShortsQaCriterionScore;
  captionReadable: ShortsQaCriterionScore;
  loopPotential: ShortsQaCriterionScore;
  verticalSafeZone: ShortsQaCriterionScore;
  /** Concrete fixes ordered by impact — usually 3. */
  fixes: string[];
}

// Weights — sum = 1. Tuned together. Hook gets the largest slice because
// the algorithm's first signal is swipe-away in the first second.
const W_HOOK = 0.3;
const W_3S = 0.15;
const W_PAYOFF = 0.2;
const W_CAPTION = 0.1;
const W_LOOP = 0.1;
const W_SAFEZONE = 0.15;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Slices the first ~1.5s of speech from a script. The hook-scoring
 *  helper's minimum is 3 words (under-3 hits a 0.3 floor); 4 words at
 *  the 2.33 wps cadence lands near the 1.5s mark. Caller passes
 *  `hookText` directly when they already have it (e.g. from the row's
 *  `hook` column). */
export function takeHookSlice(text: string): string {
  if (!text) return '';
  const words = text.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 4).join(' ');
}

/** Pure composite math — exported so tests can verify weights without
 *  burning an AI call. */
export function composeQaScore(parts: {
  hookStrength: number;
  threeSecondRule: number;
  payoffClarity: number;
  captionReadable: number;
  loopPotential: number;
  verticalSafeZone: number;
}): number {
  const composite =
    W_HOOK * clamp01(parts.hookStrength) +
    W_3S * clamp01(parts.threeSecondRule) +
    W_PAYOFF * clamp01(parts.payoffClarity) +
    W_CAPTION * clamp01(parts.captionReadable) +
    W_LOOP * clamp01(parts.loopPotential) +
    W_SAFEZONE * clamp01(parts.verticalSafeZone);
  return Number(clamp01(composite).toFixed(3));
}

/** Builds the AI prompt for the 5 AI-graded criteria. The deterministic
 *  hook score is computed by the orchestrator, NOT by the LLM, so we
 *  don't ask the model to score the hook (it's prone to inflation). */
export function buildShortsQaPrompt(input: ShortsQaInput): { system: string; user: string } {
  return {
    system: `You are a Shorts QA grader. Score the script against FIVE criteria, each 0.0–1.0. Return STRICT JSON with no prose.

Each criterion:

1. **three_second_rule** — does line 2 give enough that the viewer feels swiping = loss? 0.0 = filler. 1.0 = swipe = regret.
2. **payoff_clarity** — does the final line LAND a payoff (resolution / reframe / specific CTA)? 0.0 = generic. 1.0 = sharp + specific.
3. **caption_readable** — sentence length, fragment use, on-screen-text friendliness. 0.0 = long unreadable prose. 1.0 = punchy + scannable.
4. **loop_potential** — does the close make the viewer want to re-watch / scroll back? 0.0 = dead end. 1.0 = circular / payoff IS the hook recontextualised.
5. **vertical_safe_zone** — does the emotional arc COMPLETE in ≤60s? Penalise scripts needing a second beat. 0.0 = needs more time. 1.0 = self-contained.

Then propose THREE concrete fixes targeting the lowest-scored criteria. One sentence each. Specific. No "consider improving X" — write the actual rewrite or instruction.

Output JSON only:

{
  "three_second_rule":   { "score": 0.0, "reason": "..." },
  "payoff_clarity":      { "score": 0.0, "reason": "..." },
  "caption_readable":    { "score": 0.0, "reason": "..." },
  "loop_potential":      { "score": 0.0, "reason": "..." },
  "vertical_safe_zone":  { "score": 0.0, "reason": "..." },
  "fixes": ["fix 1", "fix 2", "fix 3"]
}`,
    user: `Script:
"""
${input.scriptText.trim()}
"""

${input.payoffText ? `Payoff line: "${input.payoffText.trim()}"\n` : ''}Grade now. JSON only.`,
  };
}

interface RawCriterion {
  score: unknown;
  reason: unknown;
}

interface RawQa {
  three_second_rule?: RawCriterion;
  payoff_clarity?: RawCriterion;
  caption_readable?: RawCriterion;
  loop_potential?: RawCriterion;
  vertical_safe_zone?: RawCriterion;
  fixes?: unknown;
}

function parseCriterion(raw: RawCriterion | undefined, fallbackReason: string): ShortsQaCriterionScore {
  const score = raw && typeof raw.score === 'number' && Number.isFinite(raw.score)
    ? clamp01(raw.score)
    : 0.5;
  const reason = raw && typeof raw.reason === 'string' && raw.reason.trim().length > 0
    ? raw.reason.trim().slice(0, 200)
    : fallbackReason;
  return { score: Number(score.toFixed(3)), reason };
}

/** Parse the LLM's structured-output response. Tolerates missing fields by
 *  defaulting them to score=0.5 with a fallback reason. */
export function parseShortsQa(raw: string): Omit<ShortsQaResult, 'hookStrength' | 'composite'> {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse Shorts QA JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Shorts QA response was not a JSON object.');
  }
  const r = parsed as RawQa;
  const fixes = Array.isArray(r.fixes)
    ? r.fixes.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).slice(0, 5)
    : [];
  return {
    threeSecondRule: parseCriterion(r.three_second_rule, 'Could not score 3-second rule.'),
    payoffClarity: parseCriterion(r.payoff_clarity, 'Could not score payoff clarity.'),
    captionReadable: parseCriterion(r.caption_readable, 'Could not score caption readability.'),
    loopPotential: parseCriterion(r.loop_potential, 'Could not score loop potential.'),
    verticalSafeZone: parseCriterion(r.vertical_safe_zone, 'Could not score vertical safe-zone.'),
    fixes,
  };
}

/** Orchestrator-agnostic assembler — combines the deterministic hook
 *  score (Phase 1 helper) with the AI-graded criteria. Caller decides
 *  the orchestration shape (server route, background job, etc.) so this
 *  stays trivially testable. */
export function assembleQaResult(input: ShortsQaInput, parsed: Omit<ShortsQaResult, 'hookStrength' | 'composite'>): ShortsQaResult {
  const hookText = input.hookText ?? takeHookSlice(input.scriptText);
  const hook = scoreHook(hookText);
  const hookStrength: ShortsQaCriterionScore = {
    score: hook.score,
    reason: hook.reasons.join(' • ') || 'Hook scored by hook-scoring.ts',
  };
  const composite = composeQaScore({
    hookStrength: hookStrength.score,
    threeSecondRule: parsed.threeSecondRule.score,
    payoffClarity: parsed.payoffClarity.score,
    captionReadable: parsed.captionReadable.score,
    loopPotential: parsed.loopPotential.score,
    verticalSafeZone: parsed.verticalSafeZone.score,
  });
  return {
    composite,
    hookStrength,
    threeSecondRule: parsed.threeSecondRule,
    payoffClarity: parsed.payoffClarity,
    captionReadable: parsed.captionReadable,
    loopPotential: parsed.loopPotential,
    verticalSafeZone: parsed.verticalSafeZone,
    fixes: parsed.fixes,
  };
}
