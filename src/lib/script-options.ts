// Shared type + helpers for user-configurable script constraints.
// These flow end-to-end: Generator UI → generate API → prompt (to override
// defaults) → QA page → QA API → QA prompt (to not penalize the absence of
// elements the user explicitly opted out of).

export interface ScriptConstraints {
  /** Skip the hook entirely — open directly in-scene / mid-action / with the
   *  story, with no attention-grabber or warm-up. */
  skipHook?: boolean;
  /** Skip all subscribe/like/notification-bell calls-to-action. */
  skipSubscribeCTA?: boolean;
  /** Skip all "click the link in the description / first comment" style
   *  off-platform CTAs and promo links. */
  skipClickableLinks?: boolean;
  /** Free-form user-authored exclusions (one per entry). Passed verbatim to
   *  both the generation and QA prompts so the model treats them as hard rules. */
  custom?: string[];
}

export const EMPTY_CONSTRAINTS: ScriptConstraints = {
  skipHook: false,
  skipSubscribeCTA: false,
  skipClickableLinks: false,
  custom: [],
};

export function hasAnyConstraint(c: ScriptConstraints | undefined | null): boolean {
  if (!c) return false;
  return Boolean(
    c.skipHook || c.skipSubscribeCTA || c.skipClickableLinks ||
    (c.custom && c.custom.some(x => x.trim()))
  );
}

/** Produce a prompt section describing the user's constraints. Used by BOTH
 *  scriptGenerationPrompt (so the generator produces a constraint-respecting
 *  script) and scriptQAPrompt (so the reviewer knows not to flag missing hooks
 *  etc. as issues). Returns an empty string when there are no constraints. */
export function buildConstraintsPromptBlock(c: ScriptConstraints | undefined | null): string {
  if (!hasAnyConstraint(c)) return '';
  const rules: string[] = [];
  if (c!.skipHook) {
    rules.push('• **NO HOOK / ATTENTION-GRABBER.** Do NOT write a hook section. Open directly in-scene, mid-action, mid-sentence, or with the first beat of the story/topic itself. No "In this video", no shock stat, no dramatic teaser — just go.');
  }
  if (c!.skipSubscribeCTA) {
    rules.push('• **NO SUBSCRIBE / LIKE / BELL CTAs.** Do not write any subscribe reminder, like request, notification-bell prompt, or any equivalent channel-growth ask anywhere in the script.');
  }
  if (c!.skipClickableLinks) {
    rules.push('• **NO OFF-PLATFORM LINKS / "click the link" CTAs.** Do not reference "link in description", "first comment", "down below", any promo code, affiliate link, website shoutout, or "click here for…" prompts.');
  }
  const customTrimmed = (c!.custom || []).map(s => s.trim()).filter(Boolean);
  if (customTrimmed.length) {
    rules.push('• **Additional user-authored exclusions (treat as hard rules):**');
    for (const x of customTrimmed) rules.push(`    — ${x}`);
  }
  return `\n\n## USER-AUTHORED SCRIPT CONSTRAINTS (HARD RULES — VIOLATING ANY OF THESE IS A FAILURE):
${rules.join('\n')}
`;
}

/** Produce a QA-side instruction block describing the same constraints, but
 *  re-framed so the reviewer knows what NOT to penalize. This rewrites the
 *  relevant rubric categories in-place for this run. */
export function buildQAConstraintsPromptBlock(c: ScriptConstraints | undefined | null): string {
  if (!hasAnyConstraint(c)) return '';
  const notes: string[] = [];
  if (c!.skipHook) {
    notes.push('• The user explicitly opted out of a hook. DO NOT flag "missing hook" or "weak hook" or "no attention-grabber" as issues. Instead, re-interpret the "hook_strength" category as **"opening impact"** — how effective is the first 10–15 seconds at dropping the viewer in-scene? Score on that, not on whether a traditional hook exists.');
  }
  if (c!.skipSubscribeCTA) {
    notes.push('• The user explicitly opted out of subscribe/like/bell CTAs. DO NOT flag their absence as an issue in "cta_effectiveness" or anywhere else. Re-interpret "cta_effectiveness" as **"ending impact / loop closure"** — does the closing land and make the viewer want to watch another of this creator\'s videos organically?');
  }
  if (c!.skipClickableLinks) {
    notes.push('• The user explicitly opted out of "link in description" / "click here" style CTAs. DO NOT flag their absence. Do not suggest adding them in `rewrite_suggestions` or `critical_issues`.');
  }
  const customTrimmed = (c!.custom || []).map(s => s.trim()).filter(Boolean);
  if (customTrimmed.length) {
    notes.push('• Additional user-authored exclusions — do NOT flag the absence of these as issues and do not suggest adding them:');
    for (const x of customTrimmed) notes.push(`    — ${x}`);
  }
  return `\n\n## USER-AUTHORED SCRIPT CONSTRAINTS (scoring rules for this review):
${notes.join('\n')}

When producing \`critical_issues\`, \`rewrite_suggestions\`, or category \`fix\` text, make sure every suggestion is compatible with the constraints above. Suggestions that would violate them must not appear.
`;
}
