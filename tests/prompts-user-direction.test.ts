/**
 * The script generator and QA reviewer both accept a freeform
 * `additionalContext` string — the user's rules for this specific
 * video ("divide into 6 sections", "open cold on the first title",
 * etc.). When that input was being buried as a single `**Additional
 * Context:**` field halfway through a 200-line prompt, the model
 * routinely ignored it.
 *
 * This file pins the new contract:
 *   1. The script user message opens with a USER DIRECTION block
 *      explicitly framed as HARD RULES that override later defaults.
 *   2. The script FINAL CHECK asks the model to re-verify each user
 *      rule before output.
 *   3. The QA reviewer prompt opens with a USER RULES block that
 *      instructs the reviewer to mark each rule RESPECTED / VIOLATED
 *      and escalate violations to critical_issues.
 *   4. Both system prompts carry a "ground in current reality" /
 *      "no fabricated specifics" directive.
 *   5. When `additionalContext` is empty, none of the user-direction
 *      scaffolding renders (no empty-block noise).
 */
import { describe, expect, it } from 'vitest';
import { scriptGenerationPrompt, scriptQAPrompt, seoOptimizationPrompt } from '@/lib/prompts';

const baseScriptInput = {
  topic: 'How ransomware works',
  niche: 'Cybersecurity',
  targetDurationMinutes: 10,
};

describe('scriptGenerationPrompt — user direction precedence', () => {
  it('places USER DIRECTION at the top of the user message, above topic/niche', () => {
    const { user } = scriptGenerationPrompt({
      ...baseScriptInput,
      additionalContext: 'Open cold on the first section title. Divide into 6 sections, not 4.',
    });
    const directionIdx = user.indexOf('USER DIRECTION');
    const topicIdx = user.indexOf('**Topic:**');
    expect(directionIdx).toBeGreaterThan(-1);
    expect(topicIdx).toBeGreaterThan(-1);
    expect(directionIdx).toBeLessThan(topicIdx);
  });

  it('frames USER DIRECTION as HARD RULES that override defaults', () => {
    const { user } = scriptGenerationPrompt({
      ...baseScriptInput,
      additionalContext: 'Divide into 6 sections',
    });
    expect(user).toMatch(/USER DIRECTION.*HARD RULES/);
    expect(user).toMatch(/override every default/i);
  });

  it('embeds the verbatim user direction so the model sees the exact wording', () => {
    const rules = 'Use only 2024-2025 examples. Cap each section at 200 words.';
    const { user } = scriptGenerationPrompt({
      ...baseScriptInput,
      additionalContext: rules,
    });
    expect(user).toContain(rules);
  });

  it('softens the default 4-section structure so user-specified counts win', () => {
    const { user } = scriptGenerationPrompt({
      ...baseScriptInput,
      additionalContext: 'Divide into 6 sections',
    });
    // The block must explicitly tell the model to follow the user's
    // count instead of staying on 4 out of inertia.
    expect(user).toMatch(/If USER DIRECTION at the top of this brief specifies a different section count/);
  });

  it('adds a verification step in the FINAL CHECK that re-reads user direction', () => {
    const { user } = scriptGenerationPrompt({
      ...baseScriptInput,
      additionalContext: 'Open cold',
    });
    const finalCheckIdx = user.indexOf('FINAL CHECK BEFORE YOU FINISH');
    expect(finalCheckIdx).toBeGreaterThan(-1);
    const finalCheckSlice = user.slice(finalCheckIdx);
    expect(finalCheckSlice).toMatch(/Re-read the USER DIRECTION/);
  });

  it('omits the USER DIRECTION block entirely when additionalContext is empty', () => {
    const { user } = scriptGenerationPrompt({ ...baseScriptInput, additionalContext: '' });
    expect(user).not.toContain('USER DIRECTION');
  });

  it('omits the USER DIRECTION block when additionalContext is whitespace-only', () => {
    const { user } = scriptGenerationPrompt({ ...baseScriptInput, additionalContext: '   \n  ' });
    expect(user).not.toContain('USER DIRECTION');
  });
});

describe('scriptGenerationPrompt — current-data grounding', () => {
  it('instructs the writer in the system prompt to ground claims in current, verifiable reality', () => {
    const { system } = scriptGenerationPrompt(baseScriptInput);
    expect(system).toMatch(/GROUND EVERY CLAIM IN CURRENT, VERIFIABLE REALITY/);
    expect(system).toMatch(/Do NOT fabricate/);
  });

  it('asks the writer to sanity-check specific data points before output', () => {
    const { user } = scriptGenerationPrompt(baseScriptInput);
    expect(user).toMatch(/[Ss]anity-check every specific data point/);
  });
});

describe('scriptQAPrompt — user rule validation', () => {
  const baseQAInput = {
    script: '## Section 1\nWelcome to the video. Today we discuss ransomware.',
    passNumber: 1,
    niche: 'Cybersecurity',
    aggressiveness: 'brutal' as const,
  };

  it('places USER RULES at the top of the user message, above the script', () => {
    const { user } = scriptQAPrompt({
      ...baseQAInput,
      additionalContext: 'Must have a cold open. No subscribe CTA.',
    });
    const rulesIdx = user.indexOf('USER RULES');
    const scriptIdx = user.indexOf('## Script to Review');
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeLessThan(scriptIdx);
  });

  it('directs the reviewer to mark each rule RESPECTED or VIOLATED and escalate violations', () => {
    const { user } = scriptQAPrompt({
      ...baseQAInput,
      additionalContext: 'Open cold',
    });
    expect(user).toMatch(/RESPECTED or VIOLATED/);
    expect(user).toMatch(/critical_issues/);
    expect(user).toMatch(/severity "critical"/);
  });

  it('keeps the system prompt precedence note so the reviewer applies user rules over defaults', () => {
    const { system } = scriptQAPrompt({ ...baseQAInput, additionalContext: 'irrelevant' });
    expect(system).toMatch(/RULE PRECEDENCE/);
    expect(system).toMatch(/user's rule wins/);
  });

  it('instructs the reviewer to flag fabricated / suspiciously vague specifics', () => {
    const { system } = scriptQAPrompt(baseQAInput);
    expect(system).toMatch(/VERIFY GROUNDING IN CURRENT REALITY/);
    expect(system).toMatch(/[Hh]allucinated specifics/);
  });

  it('omits the USER RULES block entirely when additionalContext is empty', () => {
    const { user } = scriptQAPrompt({ ...baseQAInput, additionalContext: '' });
    expect(user).not.toContain('USER RULES');
  });
});

describe('seoOptimizationPrompt — user direction propagates to titles + description + tags', () => {
  const baseSeoInput = {
    topic: 'How ransomware works in 2026',
    niche: 'Cybersecurity',
  };

  it('places USER DIRECTION at the top of the user message, above topic/niche', () => {
    const { user } = seoOptimizationPrompt({
      ...baseSeoInput,
      additionalContext: 'Description must mention "incident response" twice. No clickbait power words in titles.',
    });
    const directionIdx = user.indexOf('USER DIRECTION');
    const topicIdx = user.indexOf('**Topic:**');
    expect(directionIdx).toBeGreaterThan(-1);
    expect(topicIdx).toBeGreaterThan(-1);
    expect(directionIdx).toBeLessThan(topicIdx);
  });

  it('frames USER DIRECTION as HARD RULES that span every field', () => {
    const { user } = seoOptimizationPrompt({
      ...baseSeoInput,
      additionalContext: 'always include channel pillars in the description',
    });
    expect(user).toMatch(/USER DIRECTION.*HARD RULES/);
    // The block has to call out that it applies to description + titles +
    // tags + chapters, not just the field the picker happens to sit near
    // on the page. Otherwise the model only honours it for one output.
    expect(user).toMatch(/titles, description, hashtags, tags, chapters/);
  });

  it('embeds the verbatim user direction so the model sees the exact wording', () => {
    const rules = 'Description must open with the brand line: "WellnessBees — security, in plain English."';
    const { user } = seoOptimizationPrompt({ ...baseSeoInput, additionalContext: rules });
    expect(user).toContain(rules);
  });

  it('keeps the system prompt precedence note + grounding directives', () => {
    const { system } = seoOptimizationPrompt({ ...baseSeoInput, additionalContext: 'anything' });
    expect(system).toMatch(/RULE PRECEDENCE/);
    expect(system).toMatch(/GROUND CLAIMS IN CURRENT, VERIFIABLE REALITY/);
    expect(system).toMatch(/Never invent statistics/);
  });

  it('omits the USER DIRECTION block when additionalContext is empty', () => {
    const { user } = seoOptimizationPrompt({ ...baseSeoInput, additionalContext: '' });
    expect(user).not.toContain('USER DIRECTION');
  });

  it('omits the USER DIRECTION block when additionalContext is whitespace-only', () => {
    const { user } = seoOptimizationPrompt({ ...baseSeoInput, additionalContext: '  \n  ' });
    expect(user).not.toContain('USER DIRECTION');
  });
});
