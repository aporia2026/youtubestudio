/**
 * Verb scrubber for motion collage panel prompts + variant edit prompts.
 *
 * PR4 of `_plans/2026-06-03-production-doc-flow-stabilization.md`.
 *
 * The motion-collage prompts already include a forbidden-words list,
 * but image diffusion models interpret natural language loosely. When
 * a panel description literally says "the warning grows larger," the
 * model treats "grows" as a license to scale the prop frame-by-frame
 * — exactly the drift the user reported. The reinforced "DISREGARD if
 * it says grows" directive helps but is bypassed ~30% of the time.
 *
 * This module pre-processes the per-panel text BEFORE it reaches the
 * model, replacing forbidden scale/size verbs with structurally-
 * equivalent translate/rotate/draw phrasing. The model never sees the
 * dangerous words. Defense in depth alongside the prompt directive.
 *
 * Pure helper. No IO. Tested in `tests/verb-scrubber.test.ts`.
 */

/**
 * A single scrub rule. `pattern` is matched case-insensitively; the
 * replacement preserves the surrounding sentence structure.
 *
 * Order matters: more specific phrasings come before generic verbs so
 * "gets bigger" matches before the bare "gets" never trips a false
 * positive on neutral phrasing.
 */
interface ScrubRule {
  /** Case-insensitive regex source. Anchored on word boundaries inside
   *  the source so it doesn't match mid-word (e.g. "grows" but not
   *  "growths"). */
  pattern: RegExp;
  /** Neutral replacement text. Picks a translate/rotate/draw verb that
   *  preserves the panel-prompt's narrative intent without giving the
   *  model permission to rescale. */
  replacement: string;
  /** Human-readable label for diagnostic logs. */
  label: string;
}

const RULES: ReadonlyArray<ScrubRule> = [
  // ─── Multi-word "gets/becomes <size>" first (most specific) ────────
  { pattern: /\bgets\s+(bigger|larger|huge|massive)\b/gi, replacement: 'is drawn in', label: 'gets-bigger' },
  { pattern: /\bgets\s+(smaller|tinier|shrunk)\b/gi, replacement: 'is partially erased', label: 'gets-smaller' },
  { pattern: /\bbecomes\s+(bigger|larger|huge|massive)\b/gi, replacement: 'is drawn in', label: 'becomes-bigger' },
  { pattern: /\bbecomes\s+(smaller|tinier|shrunk)\b/gi, replacement: 'is partially erased', label: 'becomes-smaller' },
  { pattern: /\bbecome(s)?\s+more\s+prominent\b/gi, replacement: 'is positioned at the frame center', label: 'become-prominent' },
  // ─── "Fills/dominates the frame" phrasings ──────────────────────────
  // Optional qualifier ("the entire", "the whole", "the full") between
  // the verb and the noun — LLMs love this padding.
  { pattern: /\bfills?\s+(?:the\s+)?(?:entire\s+|whole\s+|full\s+)?(?:screen|frame|canvas)\b/gi, replacement: 'is positioned at the frame center', label: 'fills-frame' },
  { pattern: /\bdominat(?:es|ed|ing)\s+(?:the\s+)?(?:entire\s+|whole\s+|full\s+)?(?:screen|frame|scene|canvas)\b/gi, replacement: 'is positioned at the frame center', label: 'dominates-frame' },
  { pattern: /\b(?:takes?\s+over|takes?\s+up)\s+(?:the\s+)?(?:entire\s+|whole\s+|full\s+)?(?:screen|frame|canvas)\b/gi, replacement: 'is positioned at the frame center', label: 'takes-over-frame' },
  // ─── Single-word size verbs ────────────────────────────────────────
  { pattern: /\b(grows?|growing|grew|grown)\b/gi, replacement: 'is drawn in', label: 'grows' },
  { pattern: /\b(enlarges?|enlarging|enlarged)\b/gi, replacement: 'is drawn in', label: 'enlarges' },
  { pattern: /\b(swells?|swelling|swelled|swollen)\b/gi, replacement: 'is drawn in', label: 'swells' },
  { pattern: /\b(expands?|expanding|expanded)\b/gi, replacement: 'extends from its position', label: 'expands' },
  { pattern: /\b(shrinks?|shrinking|shrunk|shrank)\b/gi, replacement: 'is partially erased', label: 'shrinks' },
  { pattern: /\b(loom|looms|looming|loomed)\b/gi, replacement: 'is drawn larger from the same position', label: 'looms' },
  // ─── Adjective phrasings ───────────────────────────────────────────
  { pattern: /\b(scaled?\s+up|blown\s+up)\b/gi, replacement: 'drawn in at full size', label: 'scaled-up' },
  { pattern: /\b(scaled?\s+down)\b/gi, replacement: 'drawn at reduced detail', label: 'scaled-down' },
];

export interface ScrubResult {
  /** Text with every match replaced. Safe to feed to Atlas / Gemini /
   *  any image model. */
  text: string;
  /** Per-rule hit count. Useful for the `[motion-collage scrub]`
   *  diagnostic log so we can see HOW OFTEN the LLM is sneaking
   *  forbidden verbs past the prompt directive. */
  replacements: Array<{ label: string; count: number }>;
}

/**
 * Scrub every scale/size verb out of `input`, replacing with neutral
 * translate/rotate/draw phrasing. Returns the new text plus a hit
 * count per rule. The hit count is non-zero only when the LLM emitted
 * a forbidden verb the prompt directive failed to suppress.
 */
export function scrubScaleVerbs(input: string): ScrubResult {
  if (!input) return { text: '', replacements: [] };
  let text = input;
  const hits: Array<{ label: string; count: number }> = [];
  for (const rule of RULES) {
    let count = 0;
    text = text.replace(rule.pattern, () => {
      count += 1;
      return rule.replacement;
    });
    if (count > 0) hits.push({ label: rule.label, count });
  }
  return { text, replacements: hits };
}
