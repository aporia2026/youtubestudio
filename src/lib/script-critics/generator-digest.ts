/**
 * Generator-side digest of the critic rubric (Lever C of the QA hardening plan).
 *
 * The auto-pipeline's script generator already has a strong system prompt with
 * a "NEVER use" phrase list. This module produces an additional, concise digest
 * that says explicitly: "you will be graded by a 3-critic panel on these 10
 * categories, here are the painful deductions you can avoid." The generator
 * targets the bar it knows it will be measured against.
 *
 * The digest is generated from SCRIPT_CRITICS at runtime, so flipping
 * QA_RUBRIC_V2_ENABLED automatically surfaces the V2 rubric to the generator
 * without any code change here.
 *
 * Cost discipline: the digest is ~350-500 words. It is appended to the system
 * prompt, which means it pays one extra token cost per script generation, but
 * it benefits from Anthropic prompt caching on subsequent generations in the
 * same workspace (the system prompt portion is stable). The net cost per
 * script is small; the value (one fewer qa_retry on average) easily covers it.
 */
import { SCRIPT_CRITICS } from './skills/load';

/**
 * The hard-coded shortlist of "auto-deduct" phrases the panel flags. These
 * are surfaced separately from the rubric body because they are the single
 * highest source of lost points in natural_speech + human_authenticity, and
 * the generator should not even produce them in a first draft.
 *
 * Stays in lockstep with the substance-auditor + flow-critic deduction
 * lists. If a phrase is added to one of the .v2.md files, add it here too.
 */
const AUTO_DEDUCT_PHRASES = [
  'let\'s dive in',
  'navigate (this/the)',
  'landscape',
  'realm',
  'buckle up',
  'without further ado',
  'delve',
  'in today\'s world',
  'more important than ever',
  'rest assured',
  'look no further',
  'robust',
  'the truth is',
  'at the end of the day',
  'in conclusion',
];

/**
 * Build a digest block to be APPENDED (not replace) to the generator's
 * system prompt. Caller is responsible for the feature-flag gate.
 */
export function buildCriticRubricDigest(): string {
  const criticBlock = SCRIPT_CRITICS.map(c => {
    const owned = c.owned.join(', ');
    return `- **${c.persona.split('—')[0].trim()}** — owns: ${owned}. Mission: ${c.mission}`;
  }).join('\n');

  const deductLines = AUTO_DEDUCT_PHRASES.map(p => `  - "${p}"`).join('\n');

  return [
    '',
    '## WHAT THE QA PANEL WILL DO TO THIS SCRIPT (read carefully — this is what you are targeting):',
    '',
    'A 3-critic panel grades every script you write on 10 categories total. The auto-pipeline only ships scripts that reach a score of 100 in NUCLEAR mode across multiple passes. Your goal is to ace it on the first attempt so no retries are needed.',
    '',
    'The critics + their owned categories:',
    criticBlock,
    '',
    'The panel applies explicit deductions per category. The biggest single source of lost points is the natural_speech + human_authenticity deduction list. You can avoid losing dozens of points just by NEVER producing the following phrases:',
    deductLines,
    '',
    'Other structural deductions you can pre-empt:',
    '  - Generic openers ("In today\'s world", "Have you ever wondered", "Welcome back") in the hook: -15.',
    '  - Filler greeting ("Hey guys", "What\'s up everyone") as the opening line: -10.',
    '  - Premature CTA (subscribe / like before any content): -20.',
    '  - Hook makes a claim the script never delivers: -30 (clickbait penalty).',
    '  - Em-dash used where a comma or period would feel natural to a human: -5 per occurrence (max -15). Use commas, periods, or "and" instead.',
    '  - Zero contractions in a script over 800 words: -15.',
    '  - Section longer than 80 words with no internal beat (no short sentence, no claim, no twist): -12 per occurrence.',
    '  - Bland transitions ("Now let\'s move on", "Moving on", "Next up") repeated: -10 per occurrence after the second.',
    '  - Robotic transition words as section starters ("Furthermore", "Moreover", "Additionally"): -5 per occurrence.',
    '',
    'What a 100-score hook looks like (the pattern, niche-agnostic): bold specific claim → time-bounded or measurable payoff → explicit viewer outcome → curiosity gap. Zero filler. Zero AI cliché. No premature CTA.',
    '',
    'Write to this bar. The first thing the panel will do is read your script aloud mentally; if any sentence feels like a written essay rather than something a YouTuber would actually say on camera, they deduct.',
  ].join('\n');
}
