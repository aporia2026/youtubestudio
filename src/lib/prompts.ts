// All AI prompts for the YouTube Studio system
import { buildConstraintsPromptBlock, buildQAConstraintsPromptBlock, type ScriptConstraints } from './script-options';
import { buildBrandKitPromptBlock, type ChannelBrandKit } from './channel-brand-kit';

/** Words-per-minute baseline used everywhere we convert between script
 *  duration and word count. Matches `estimateDuration` in lib/utils.ts —
 *  if you change one, change the other. */
export const SCRIPT_WPM = 140;

/** Convert a target duration in minutes to a target spoken-word count
 *  (excluding [VISUAL CUE: ...] / [PAUSE] / [SFX: ...] markers, which
 *  countWords also strips so the two sides agree). */
export function targetWordsForDuration(minutes: number): number {
  return Math.round(minutes * SCRIPT_WPM);
}

/** Per-section word budget for the structure block in the user prompt.
 *  Lets the model "see" how the total breaks down so it can't quietly
 *  finish the script at 800 words when 2100 was asked. */
function sectionWordBudget(targetWords: number, skipHook: boolean): {
  hook: number;
  intro: number;
  main: number;
  outro: number;
  perMainSection: number;
} {
  // Hook ~3%, intro ~5%, main ~85%, outro ~7% of total. When the hook is
  // skipped, the freed budget rolls into MAIN since `main` is computed
  // as the remainder so the four buckets always sum to targetWords.
  const hookShare = skipHook ? 0 : 0.03;
  const introShare = 0.05;
  const outroShare = 0.07;
  const hook = Math.round(targetWords * hookShare);
  const intro = Math.round(targetWords * introShare);
  const outro = Math.round(targetWords * outroShare);
  const main = Math.max(targetWords - hook - intro - outro, 0);
  // Default to 4 main sections when computing per-section budget.
  const perMainSection = Math.round(main / 4);
  return { hook, intro, main, outro, perMainSection };
}

/**
 * Render the style-preset block injected into the user prompt below
 * the reference-context block and above the structure. Returns an
 * empty string when no preset is supplied — the calling template's
 * surrounding whitespace already handles spacing so byte-identical
 * output when this block is empty preserves the legacy prompt shape
 * for backwards compat.
 */
function buildStylePresetPromptBlock(preset?: ScriptStylePreset | null): string {
  if (!preset) return '';
  const desc = preset.description?.trim();
  const rules = preset.mixing_rules?.trim();
  if (!desc && !rules) {
    // Style with only a label is too thin to inject as a guidance
    // block — silently omit. The label alone is already covered by
    // the top-level `style` free-text param.
    return '';
  }
  const lines: string[] = [
    '',
    `## STYLE PRESET — "${preset.label}":`,
    'These are the producer-curated style directives. Treat them as voice/aesthetic guardrails for THIS script. They sit BELOW any USER DIRECTION block above but ABOVE the generic structure template.',
    '',
  ];
  if (desc) lines.push(`**Style summary:** ${desc}`);
  if (rules) lines.push(`**Mixing rules:**\n${rules}`);
  return lines.join('\n');
}

/**
 * Render the style-preset block for the thumbnail prompt. The
 * thumbnail variant differs from the script variant: `ai_image_suffix`
 * is the load-bearing field here (it ends up in every concept's
 * image_generation_prompt). Mixing rules + description shape the
 * composition; the suffix anchors the eventual image gen call.
 */
function buildThumbnailStylePresetBlock(preset?: ThumbnailStylePreset | null): string {
  if (!preset) return '';
  const desc = preset.description?.trim();
  const rules = preset.mixing_rules?.trim();
  const suffix = preset.ai_image_suffix?.trim();
  if (!desc && !rules && !suffix) return '';
  const lines: string[] = [
    '',
    `## STYLE PRESET — "${preset.label}":`,
    'Lock every concept to this style. Treat it as the operator-curated visual identity for this video. Each concept varies in content but the style stays constant.',
    '',
  ];
  if (desc) lines.push(`**Style summary:** ${desc}`);
  if (rules) lines.push(`**Mixing rules:**\n${rules}`);
  if (suffix) lines.push(`**Image suffix:** \`${suffix}\` — every concept\'s \`image_generation_prompt\` must end with this suffix verbatim (see the JSON spec below).`);
  return lines.join('\n');
}

/**
 * Shape the script prompt builder accepts for a resolved style preset
 * (the `production_doc_styles` row, or a built-in slug, after passing
 * through `resolveStyle`). Only the fields that meaningfully shape a
 * SCRIPT are surfaced here — `ai_image_suffix` is image-specific and
 * deliberately excluded; thumbnail generation uses that field via its
 * own prompt builder.
 */
export interface ScriptStylePreset {
  /** Human-readable name for the prompt to reference. */
  label: string;
  /** Optional one-liner describing what this style is. */
  description?: string;
  /** Free-form mixing rules from `production_doc_styles.mixing_rules`. */
  mixing_rules?: string;
}

export function scriptGenerationPrompt({
  topic,
  niche,
  targetDurationMinutes,
  targetAudience,
  tone,
  style,
  additionalContext,
  referenceContext,
  constraints,
  brandKit,
  stylePreset,
}: {
  topic: string;
  niche: string;
  targetDurationMinutes: number;
  targetAudience?: string;
  tone?: string;
  style?: string;
  additionalContext?: string;
  referenceContext?: string;
  constraints?: ScriptConstraints;
  /** Per-channel brand kit. When present, its directives override the
   *  generic style guidance further down in the prompt. Pass `null` (or
   *  omit) when no channel is active or its kit is empty. */
  brandKit?: ChannelBrandKit | null;
  /** Optional resolved style preset (built-in slug or saved row,
   *  pre-resolved via `resolveStyle`). When present, the style's
   *  label/description/mixing_rules are injected into the user
   *  prompt as a STYLE PRESET block. When absent, the prompt is
   *  byte-identical to the pre-preset version — backwards compat. */
  stylePreset?: ScriptStylePreset | null;
}): { system: string; user: string } {
  const wordsPerMinute = SCRIPT_WPM;
  const targetWords = targetDurationMinutes * wordsPerMinute;
  // Floor the model has to clear. We treat anything under this as a
  // generation failure on the server and run an expansion pass.
  const minWords = Math.round(targetWords * 0.92);
  const maxWords = Math.round(targetWords * 1.15);
  const budget = sectionWordBudget(targetWords, !!constraints?.skipHook);

  const styleInstructions: Record<string, string> = {
    'Story-driven': `\n**STYLE-SPECIFIC: STORY-DRIVEN**
- Structure this as a narrative with characters, conflict, and resolution
- Use chronological or dramatic story structure, not listicle format
- Build emotional investment in the characters/situation before the payoff
- Create suspense — withhold key information until the perfect moment`,
    'Tutorial': `\n**STYLE-SPECIFIC: TUTORIAL**
- Structure as clear, numbered steps the viewer can follow along
- Each step must be actionable and specific — no vague advice
- Anticipate where viewers will get stuck and address it proactively
- Include "checkpoint" moments: "If you've done this correctly, you should see..."`,
    'Comparison': `\n**STYLE-SPECIFIC: COMPARISON**
- Present both sides fairly before revealing your verdict
- Use specific criteria/metrics to compare, not just feelings
- Include a clear winner or recommendation at the end
- Address "it depends" scenarios with specific use cases`,
    'Opinion / Commentary': `\n**STYLE-SPECIFIC: OPINION/COMMENTARY**
- Lead with your strongest, most controversial take
- Back every opinion with specific evidence or experience
- Acknowledge the strongest counter-argument, then dismantle it
- End with a call to discussion, not just agreement`,
    'Top 10 List': `\n**STYLE-SPECIFIC: TOP 10 LIST**
- Build ascending energy — save the most impactful for last
- Each entry needs its own mini-hook and surprising angle
- Add brief personal takes between entries to keep it from feeling robotic
- Include at least one unexpected/controversial pick`,
    'Documentary': `\n**STYLE-SPECIFIC: DOCUMENTARY**
- Use investigative tone — reveal information as if uncovering it in real time
- Include multiple perspectives and sources
- Build a larger thesis that connects individual facts
- End with implications for the viewer's own life`,
  };
  const styleNote = styleInstructions[style || ''] || '';
  const brandKitBlock = buildBrandKitPromptBlock(brandKit);
  const stylePresetBlock = buildStylePresetPromptBlock(stylePreset);

  return {
    system: `You are the world's top YouTube scriptwriter. You've written scripts for 50M+ subscriber channels. Every script you produce is IMMEDIATELY publish-ready — no QA pass needed.

You specialize in the "${niche}" niche. Your scripts consistently score 85+ on brutal quality reviews because you internalize these standards AS YOU WRITE:

## RULE PRECEDENCE (READ THIS FIRST):
If the user's brief contains a "USER DIRECTION" block at the top of the user message, treat every rule in it as a HARD RULE that overrides any conflicting default in this system prompt or the structure template below. Example: if USER DIRECTION says "6 sections" and the default structure says "4 main sections", you produce 6. If USER DIRECTION says "open cold with the first title", you skip the warm-up entirely. User direction never gets softened, summarised, or reinterpreted.

## GROUND EVERY CLAIM IN CURRENT, VERIFIABLE REALITY:
- Use specific, recent data — named sources, real incidents, actual numbers, exact dates. The viewer must feel they're hearing fresh reporting, not a recycled blog post.
- Prefer concrete examples from the last 24 months when the topic admits them. Evergreen analogies are fine for framing but never the whole substance.
- Do NOT fabricate statistics, quotes, recent events, or names. If you're not confident a specific number / date / quote is accurate, omit it or pick a different real example you do know — never invent. A vivid, true generality beats a fake specific.
- "Recently…" / "In a 2025 study…" / "Last quarter…" claims must be ones you actually know. If you can't ground the recency, drop the time marker and keep the substance.

## YOUR WRITING DNA:

**HOOK MASTERY** (first 10-15 seconds):
- Open with a gut-punch: a disturbing fact, a counterintuitive claim, or a scenario that creates instant dread/curiosity
- NO generic openers. NO "Have you ever wondered." NO "In today's world." Start mid-action, mid-thought, mid-crisis
- The viewer must feel physically unable to click away within the first sentence

**HUMAN AUTHENTICITY** (zero tolerance for AI smell):
- Write EXACTLY how a confident expert TALKS on camera — not how they write
- Use contractions always (you're, it's, that's, don't, won't, can't)
- Include natural speech patterns: "Look,", "Here's the thing —", "And honestly?", "No, seriously.", "Think about it."
- Vary sentence length deliberately. Some sentences are three words. Others build momentum through a longer, rolling rhythm that pulls the viewer forward before snapping back to a short punch.
- NEVER use: "Furthermore", "In conclusion", "It's worth noting", "Let's dive in", "without further ado", "In today's fast-paced world", "At the end of the day", "buckle up", "game-changer", "navigate", "landscape", "realm", "crucial", "vital"

**PACING & RETENTION**:
- Every 45-60 seconds needs a pattern interrupt — a new angle, a surprising reveal, a direct challenge to the viewer
- Build tension before payoffs. Don't give answers immediately — make the viewer earn them
- Use cliffhangers between sections: tease what's coming before delivering it
- Dead zones kill retention. If a section doesn't create urgency, curiosity, or emotion — cut it or rewrite it

**SUBSTANCE & DEPTH**:
- Include SPECIFIC data, numbers, examples, real names, real incidents — not vague generalizations
- Every claim needs proof or at least a vivid illustration
- Analogies must be original and memorable, not clichéd
- Show expertise through specificity, not through saying "as an expert"

**NATURAL SPEECH FLOW**:
- Read every sentence aloud mentally. If it sounds awkward spoken, rewrite it
- Avoid subordinate clause chains. Break them into punchy sequences
- Use intentional repetition for emphasis. Use intentional fragments. For impact.
- Rhetorical questions should feel natural, not forced

**ENGAGEMENT ARCHITECTURE**:
- Every section must end with a reason to keep watching
- CTAs should feel organic, not bolted on
- The outro should connect back to the hook — create a satisfying loop
- Leave the viewer with ONE powerful thought they'll remember

**LENGTH DISCIPLINE — NON-NEGOTIABLE**:
- The duration target is the spoken length the narrator will deliver at ${wordsPerMinute} words per minute
- Spoken words = every word the narrator says out loud, EXCLUDING bracketed cues like [VISUAL CUE: ...], [PAUSE], [SFX: ...], [B-ROLL: ...] (these don't count toward duration)
- Hitting the spoken word count is a HARD requirement, not a suggestion. Going short is worse than going long — a 6-minute script returned for a 15-minute slot is a complete failure regardless of quality
- Do NOT pad with filler, repetition, or generic sentences to hit the target. Hit it through real substance: more specific examples, more concrete data points, deeper exploration of each angle, additional pattern interrupts, more sensory detail in stories
- Plan the section budget BEFORE you start writing. If a section runs short, expand it with another concrete example or a deeper layer of insight — never with empty calories${brandKitBlock}`,

    user: `Write a complete, publish-ready YouTube script that would score 85+ on a Nuclear QA review.
${additionalContext && additionalContext.trim() ? `
## USER DIRECTION — HARD RULES (override every default below when they conflict):
${additionalContext.trim()}

These rules are binding. Read them again before you start writing, and again before you stop. If anything below this block conflicts with a rule here, the user direction wins — re-budget word counts, change the section count, skip openings, adjust structure as needed to comply.
` : ''}
**Topic:** ${topic}
**Niche:** ${niche}
**Target Duration:** ${targetDurationMinutes} minutes
**SPOKEN WORD COUNT (HARD REQUIREMENT):** ${targetWords} words minimum (range ${minWords}–${maxWords}). Spoken words exclude all bracketed cues like [VISUAL CUE: ...], [PAUSE], [SFX: ...]. Anything below ${minWords} words is a generation failure and will be rejected. The narrator speaks at ~${wordsPerMinute} wpm — at that pace, ${targetWords} words is exactly ${targetDurationMinutes} minutes. This is the most important constraint in this brief.
**Tone:** ${tone || 'Engaging, authoritative but friendly'}
**Style:** ${style || 'Educational explainer'}
**Target Audience:** ${targetAudience || 'General audience interested in ' + niche}
${referenceContext ? `\n## REFERENCE VIDEO ANALYSIS (deep analysis of videos you must learn from):

${referenceContext}

## HOW TO USE REFERENCE VIDEOS:
- Study each reference video's breakdown above — thumbnail strategy, hook technique, pacing, storytelling, engagement mechanics, and creator fingerprint
- ACTIVELY REPLICATE the specific techniques that made those videos successful
- Adapt their proven structure, energy patterns, and engagement mechanics to this topic
- For each major section of your script, consciously draw from the reference videos' techniques
- Match their pacing rhythm, transition style, and audience address patterns
- Use similar emotional triggers and curiosity mechanisms adapted to this topic
- If multiple references are provided, synthesize the best elements from each` : ''}
${styleNote}${stylePresetBlock}

## Structure (follow precisely — word counts are SPOKEN words, excluding [VISUAL CUE: ...] / [PAUSE] / [SFX: ...]):

${constraints?.skipHook
  ? `1. **OPENING** (~${budget.intro > 0 ? Math.round(budget.intro * 0.4) : 30} spoken words): NO hook. Open directly in-scene, mid-action, mid-sentence, or with the first beat of the story itself. The viewer should feel like they just walked into a moment already in progress. No warm-up, no attention-grabber, no "In this video", no teaser stat.`
  : `1. **HOOK** (~${budget.hook} spoken words / first 10-15 seconds): Gut-punch opening. No warm-up. Drop the viewer into the most compelling moment of the topic. Make them feel something immediately — fear, shock, curiosity, outrage.`}

2. **INTRO** (~${budget.intro} spoken words / 20-40 seconds): Quick context. Why should THEY care? What's at stake for them personally? Tease the structure: "By the end of this video, you'll know X, Y, and Z."

3. **MAIN CONTENT** (~${budget.main} spoken words total — this is the bulk of the script): ${additionalContext && additionalContext.trim()
  ? `by default 4 distinct sections, each ~${budget.perMainSection} spoken words. **If USER DIRECTION at the top of this brief specifies a different section count, follow the user's count and split ~${budget.main} words evenly across them instead — do NOT keep 4 sections out of inertia.**`
  : `4 distinct sections, each ~${budget.perMainSection} spoken words.`} Each section MUST contain:
   - A mini-hook that re-engages attention
   - At least 2 specific examples with real names, numbers, dates
   - At least one analogy or visual metaphor
   - A pattern interrupt or surprise reveal
   - A bridge to the next section that creates anticipation
   - Enough depth and concrete substance to fully fill its word budget without filler. If a section feels short, add another example or go deeper on one — do NOT pad with rhetorical questions, generic statements, or repetition.

${constraints?.skipSubscribeCTA || constraints?.skipClickableLinks
  ? `4. **OUTRO** (~${budget.outro} spoken words / 20-30 seconds): Circle back to the opening. Deliver a final insight that reframes everything. ${constraints?.skipSubscribeCTA ? 'Do NOT include any subscribe / like / bell CTAs.' : 'CTA that feels natural.'} ${constraints?.skipClickableLinks ? 'Do NOT reference any links, promo codes, or "link in description" prompts.' : ''} ${!constraints?.skipSubscribeCTA && !constraints?.skipClickableLinks ? 'Tease next video.' : 'End on a thought, not a request.'}`
  : `4. **OUTRO** (~${budget.outro} spoken words / 20-30 seconds): Circle back to the hook. Deliver a final insight that reframes everything. CTA that feels natural. Tease next video.`}

The four budgets above sum to ~${targetWords} spoken words, which is the target. Do NOT skip sections or shorten them to "tighten" the script — every section's word target is binding.

## Format:
- Use [VISUAL CUE: description] for B-roll/visual suggestions
- Use [PAUSE] for dramatic effect
- Use **BOLD** for emphasis
- Mark sections with ## Section Name

## OUTPUT RULES — STRICTLY ENFORCED (the script is fed directly to a narrator who reads everything that isn't a bracketed cue):
- Do NOT inline word counts, running totals, duration estimates, or self-tracking notes anywhere in the script. No "(Word count so far: …)", no "(Spoken words: 84)", no trailing "**TOTAL SPOKEN WORD COUNT: …**" line, no "Estimated duration: …" annotations. Anything outside [brackets] gets read aloud.
- Do NOT include citation markers like [1], [3][6], or footnote-style references. Attribute stats inline ("a 2024 FTC report found…") instead.
- Do NOT add meta-commentary, preambles, or self-summaries (e.g. "Here's the script:", "I've structured this as…", "Verified.", "Excludes brackets."). Output the script ONLY.
- Markdown emphasis (**bold**) on individual words/phrases is fine — the asterisks are stripped before display — but do not wrap entire summary lines or metadata blocks in bold.
${buildConstraintsPromptBlock(constraints)}
## FINAL CHECK BEFORE YOU FINISH:
1. Count the spoken words in your draft silently (everything outside [brackets]). It must be at least ${minWords}. The count is for your own verification — do NOT write it into the script.
2. If you are below ${minWords} spoken words, you are NOT done. Go back to the most underdeveloped sections and expand them with more concrete examples, more specific data, deeper exploration — never with filler, repetition, or generic statements.
3. Re-scan and DELETE any line containing a word count, running total, duration estimate, citation marker, or meta-commentary before output. None of those exist in the final script.${additionalContext && additionalContext.trim() ? `
4. **Re-read the USER DIRECTION block at the top of this brief.** For each rule there, point to the exact passage of your draft that satisfies it. If any rule is unsatisfied — wrong section count, wrong opening style, missing element, anything — rewrite the affected passage NOW before output. User direction is binding; an otherwise-great script that ignores it is a failure.
5. Sanity-check every specific data point (numbers, dates, quotes, named events). If you're not confident a specific is accurate, replace it with a real example you do know — never leave a fabricated specific in the final script.
6. Only output when the spoken-word total is in the ${minWords}–${maxWords} range, every USER DIRECTION rule is satisfied, and no metadata lines remain.` : `
4. Sanity-check every specific data point (numbers, dates, quotes, named events). If you're not confident a specific is accurate, replace it with a real example you do know — never leave a fabricated specific in the final script.
5. Only output when the spoken-word total is in the ${minWords}–${maxWords} range AND no metadata lines remain.`}

Write the complete script now. Make it exceptional, AND make it the right length.`,
  };
}

/** Prompt that asks the model to expand an existing draft to hit the
 *  required spoken-word count. Used by the script route when the first
 *  pass came back materially shorter than the duration target — instead
 *  of leaving the user with a 6-minute script for a 15-minute slot, the
 *  server reruns the model with this prompt and substitutes the longer
 *  version into the response stream.
 *
 *  The expansion pass is allowed to rewrite passages but MUST preserve
 *  the script's identity (topic, hook, narrative arc, format markers,
 *  user-imposed constraints) — we want the same script, longer, not a
 *  brand new one. */
export function scriptExpansionPrompt({
  draftScript,
  topic,
  niche,
  targetDurationMinutes,
  currentSpokenWords,
  constraints,
}: {
  draftScript: string;
  topic: string;
  niche: string;
  targetDurationMinutes: number;
  currentSpokenWords: number;
  constraints?: ScriptConstraints;
}): { system: string; user: string } {
  const targetWords = targetDurationMinutes * SCRIPT_WPM;
  const minWords = Math.round(targetWords * 0.92);
  const maxWords = Math.round(targetWords * 1.15);
  const deficit = Math.max(0, targetWords - currentSpokenWords);

  return {
    system: `You are a world-class YouTube script editor. You take publish-ready scripts that came back too short for their duration target and expand them with substance until they hit the required length.

ABSOLUTE RULES:
- Return the COMPLETE expanded script — not a diff, not a summary, not the additions only.
- Preserve the original script's identity: same topic, same hook (or same skip-hook opening), same narrative arc, same section structure, same format markers ([VISUAL CUE: ...], [PAUSE], **BOLD**, ## section headers), same tone.
- Expand by adding REAL substance: more specific examples (real names / numbers / dates), more concrete data, deeper exploration of each angle, additional pattern interrupts, more sensory detail. Never pad with filler, generic statements, or rhetorical-question repetition.
- Keep every existing strong line. Don't rewrite passages that already work — extend around them.
- Honor every constraint listed below. Do NOT re-introduce a hook / CTA / link if the user disabled it.
- No meta-commentary, no "here's the expanded script:" preamble, no notes at the end. Output the script only.
- Do NOT inline word counts, running totals, duration estimates, citation markers ([1], [3][6]), or any "(Spoken words: …)" / "(Word count so far: …)" / "**TOTAL SPOKEN WORD COUNT: …**" annotations. The script feeds straight to a narrator who reads everything that isn't a [bracketed cue]. If the input draft contains any of these, REMOVE them in your output.`,

    user: `# Current Draft (${currentSpokenWords} spoken words — too short)
**Topic:** ${topic}
**Niche:** ${niche}
**Duration target:** ${targetDurationMinutes} minutes at ${SCRIPT_WPM} wpm = ${targetWords} spoken words
**Required range:** ${minWords}–${maxWords} spoken words (spoken = everything outside [brackets])
**Deficit:** ~${deficit} spoken words missing

\`\`\`
${draftScript}
\`\`\`

# Task
Expand this script so the spoken-word total lands in the ${minWords}–${maxWords} range. Add substance, not filler. Keep the existing structure and identity. Output the complete expanded script.
${buildConstraintsPromptBlock(constraints)}
## FINAL CHECK BEFORE YOU FINISH:
1. Count the spoken words in your output silently (everything outside [brackets]). Do not write the count into the script.
2. If still below ${minWords}, keep expanding the underdeveloped sections with more concrete substance.
3. Re-scan and DELETE any line that's a word count, running total, duration estimate, citation marker, or meta-commentary — even if it was in the input draft.
4. Only output when the spoken-word total is in the ${minWords}–${maxWords} range AND no metadata lines remain.`,
  };
}

export function scriptQAPrompt({
  script,
  passNumber,
  previousFeedback,
  niche,
  aggressiveness,
  constraints,
  additionalContext,
  brandKit,
}: {
  script: string;
  passNumber: number;
  previousFeedback?: string;
  niche: string;
  aggressiveness: 'standard' | 'brutal' | 'nuclear';
  constraints?: ScriptConstraints;
  /** Reviewer-side direction merged from a saved template + per-call extra
   *  context. Surfaced near the top of the user prompt so the reviewer
   *  applies the user's recurring critique style (e.g. "be brutally
   *  direct, flag every passive sentence") on top of the aggressiveness
   *  setting. Skipped when empty. */
  additionalContext?: string;
  /** Per-channel brand kit. When present, the reviewer flags violations
   *  (banned-phrase use, off-tone passages, missing required phrases) on
   *  top of the standard QA criteria. */
  brandKit?: ChannelBrandKit | null;
}): { system: string; user: string } {
  const aggressivenessInstructions = {
    standard: 'Be thorough and constructive. Point out all issues clearly.',
    brutal: 'Be brutally honest. No sugar-coating. Treat this like a top YouTube creator reviewing amateur work. Every weakness must be called out explicitly.',
    nuclear: `You are the HARSHEST script critic alive. You've helped 100M-subscriber channels and you have ZERO tolerance for mediocrity.
    Tear this script apart. Every cliché, every weak hook, every boring section, every missed opportunity — EXPOSE IT ALL.
    If this script aired as-is, explain exactly why it would fail. Be specific, merciless, and brutally actionable.
    Your feedback will make or break this channel's success. Act like it.`,
  };

  // Always include human authenticity as a core criterion
  const humanAuthenticityNote = `
CRITICAL QA CRITERIA YOU MUST ALWAYS CHECK:

1. **AI Detection Test**: Does this script sound like a human wrote it, or does it reek of AI?
   Look for: generic openers ("In today's world...", "Have you ever wondered..."),
   robotic transitions ("Furthermore", "In conclusion", "It's worth noting that"),
   AI buzzwords ("navigate", "landscape", "realm", "crucial", "vital", "game-changer", "buckle up", "without further ado", "Let's dive in"),
   overly formal language for YouTube, repetitive sentence structures, lack of personality.
   Flag every AI-sounding phrase specifically — quote the exact phrase from the script.

2. **Natural Speaking Rhythm**: Read every sentence aloud mentally. Does it FLOW naturally when spoken?
   Identify sentences that are too long, awkward to speak, or sound like written text.
   Flag exact sentences that would trip up a speaker.

3. **Pacing & Engagement Velocity**: Is every single sentence earning its place?
   Identify where the energy dies, where explanations drag, where the viewer would reach for their phone.
   Each "dead zone" must be identified by its section/position.

4. **Logic & Coherence**: Does the content flow logically from point to point?
   Are there jumps in logic? Missing explanations? Claims without backing?
   Does the ending follow from the setup?`;

  const brandKitBlock = buildBrandKitPromptBlock(brandKit);
  const brandKitReviewerNote = brandKitBlock
    ? `\n\n5. **Channel Brand Kit Compliance**: The author has supplied a brand kit (below). Flag every violation as a critical issue: any banned phrase used verbatim, any required phrase missing, any tone/sentence-length deviation from the kit, any topics_to_avoid present, any topics_to_emphasize ignored. Quote the offending passage exactly.${brandKitBlock}`
    : '';

  return {
    system: `You are a world-class YouTube content strategist and script analyst. You have deep expertise in the "${niche}" niche. ${aggressivenessInstructions[aggressiveness]}

## RULE PRECEDENCE (READ FIRST):
If the user prompt opens with a "USER RULES" block, treat each rule there as a binding requirement the script MUST satisfy. Walk through the script and decide, per rule, whether it is RESPECTED or VIOLATED — quoting the exact passage that proves either way. Every VIOLATED rule is logged as a \`critical_issues\` entry with severity "critical" and a specific fix. Do not ignore, paraphrase, or "soften" the user's rules; if a rule conflicts with your default reviewer instincts, the user's rule wins.

## VERIFY GROUNDING IN CURRENT REALITY:
- Flag every specific stat, date, name, or quote in the script that looks fabricated, generic, or suspiciously vague ("studies show…", "experts say…", "recently…" with no specifics). Hallucinated specifics are a critical issue, even when the prose around them reads well.
- Flag claims that contradict widely-known recent context (events, public figures, technologies). A confidently wrong sentence is worse than a vague true one.
- When a number / date / quote looks suspiciously precise, call it out explicitly under \`critical_issues\` and ask for either a real source or replacement.

${humanAuthenticityNote}${brandKitReviewerNote}

Your analysis must always be actionable — for every problem you find, provide a specific fix.`,

    user: `Perform a ${aggressiveness.toUpperCase()} QA review of this YouTube script. This is Pass #${passNumber}.
${additionalContext && additionalContext.trim() ? `
## USER RULES — VALIDATE COMPLIANCE FOR EACH:
${additionalContext.trim()}

For every rule above, walk through the script and decide RESPECTED or VIOLATED. Quote the exact passage that proves your verdict. Every VIOLATED rule MUST appear in \`critical_issues\` with severity "critical" and a concrete rewrite. Do not paraphrase the rules — keep the user's wording verbatim when citing them. Re-read this block again before you finalise your verdict.
` : ''}
${buildQAConstraintsPromptBlock(constraints)}
${previousFeedback ? `## Previous QA Feedback (Pass ${passNumber - 1}):\n${previousFeedback}\n\nIMPORTANT SCORING RULES FOR FOLLOW-UP PASSES:
- If previous issues were FIXED, the score for those categories MUST increase significantly (at least +15-25 points per fixed category)
- Only deduct points for genuinely NEW problems, not re-stating things that were already addressed
- Give credit where it's due — if the hook was rewritten and is now strong, score it high even in Nuclear mode
- The overall score should reflect the CURRENT quality of the script, not carry over penalties from previous passes
- A script that has been through fixes should realistically score 15-25+ points higher than the previous pass unless the fixes were poorly applied

Focus on whether those issues were fixed (give full credit if yes), and find NEW problems.\n\n---\n` : ''}

## Script to Review:
\`\`\`
${script}
\`\`\`

## Provide your analysis in this EXACT JSON format:
\`\`\`json
{
  "overall_score": <0-100 integer>,
  "verdict": "<one powerful sentence verdict>",
  "will_it_perform": "<yes/maybe/no + brief reason>",
  "categories": {
    "hook_strength": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "issues": ["<specific issue 1>", "<specific issue 2>"],
      "fix": "<specific rewrite suggestion>"
    },
    "retention_potential": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "weak_spots": ["<timestamp or section where viewers will drop off>"],
      "fix": "<specific improvement>"
    },
    "content_quality": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "missing_elements": ["<what's missing>"],
      "fix": "<specific improvement>"
    },
    "audience_targeting": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "fix": "<specific improvement>"
    },
    "cta_effectiveness": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "fix": "<specific improvement>"
    },
    "seo_optimization": {
      "score": <0-100>,
      "assessment": "<keyword usage, title potential, searchability>",
      "fix": "<specific improvement>"
    },
    "pacing_flow": {
      "score": <0-100>,
      "assessment": "<detailed assessment — where does energy die? what sections drag?>",
      "dead_zones": ["<exact section/sentence where pacing collapses>"],
      "fix": "<specific improvement>"
    },
    "human_authenticity": {
      "score": <0-100>,
      "ai_smell_level": "none|low|medium|high|extreme",
      "assessment": "<does this sound human? would a viewer notice it's AI-written?>",
      "ai_phrases_found": ["<exact AI-sounding phrase 1>", "<exact phrase 2>"],
      "fix": "<how to make it sound more human and authentic>"
    },
    "natural_speech": {
      "score": <0-100>,
      "assessment": "<does this read naturally when spoken aloud? awkward sentences?>",
      "awkward_sentences": ["<exact sentence that's hard to speak naturally>"],
      "fix": "<rewrite suggestions for natural spoken delivery>"
    },
    "logic_coherence": {
      "score": <0-100>,
      "assessment": "<does the script flow logically? are there gaps in reasoning?>",
      "logic_gaps": ["<specific gap or jump in logic>"],
      "fix": "<how to fix the logical flow>"
    }
  },
  "critical_issues": [
    {
      "severity": "critical|major|minor",
      "location": "<where in the script>",
      "issue": "<what's wrong>",
      "fix": "<exact fix or rewrite>"
    }
  ],
  "strengths": ["<what's actually good>"],
  "rewrite_suggestions": [
    {
      "original": "<exact text from script>",
      "improved": "<your improved version>",
      "reason": "<why this is better>"
    }
  ],
  "title_suggestions": ["<5 potential video titles>"],
  "thumbnail_ideas": ["<2-3 thumbnail concepts>"],
  "next_pass_focus": "<what to focus on in the next QA pass>"
}
\`\`\`

Return ONLY valid JSON. No text before or after.`,
  };
}

export function applyFixesPrompt({
  script,
  qaFeedback,
  approvedFixes,
  constraints,
}: {
  script: string;
  qaFeedback: string;
  approvedFixes: string[];
  constraints?: ScriptConstraints;
}): { system: string; user: string } {
  return {
    system: `You are an elite YouTube scriptwriter performing a COMPREHENSIVE rewrite based on QA feedback.

YOUR MISSION: Produce a dramatically improved version of the script. Not a patch job — a proper rewrite that addresses every approved fix AND elevates the overall quality.

CRITICAL RULES:
1. Apply every approved fix thoroughly — don't just tweak a word, rewrite the entire surrounding paragraph to make the fix feel natural and integrated
2. While applying fixes, also improve adjacent sentences for flow, pacing, and impact
3. The output must sound 100% human — conversational, punchy, natural spoken rhythm
4. Maintain the original topic, structure, and key points — but make every sentence BETTER
5. If a fix says "improve the hook" — don't just edit the hook, make it genuinely gripping
6. If a fix says "better pacing" — actually restructure the section for energy and momentum
7. Return ONLY the complete rewritten script — no commentary, no headers, just the script
8. The rewritten script should score AT LEAST 15-20 points higher than the original on a QA review`,

    user: `Rewrite this script applying ALL the approved fixes. Don't just patch — produce a significantly better version.

## Original Script:
\`\`\`
${script}
\`\`\`

## QA Analysis (understand what's weak):
${qaFeedback}

## Approved Fixes (apply ALL of these):
${approvedFixes.map((fix, i) => `${i + 1}. ${fix}`).join('\n')}
${buildConstraintsPromptBlock(constraints)}
Return the complete rewritten script with these fixes applied. Nothing else — just the script.`,
  };
}

export function ideaGenerationPrompt({
  niche,
  count,
  audience,
  existingTitles,
  focus,
  referenceContext,
  redditContext,
  videoType,
}: {
  niche: string;
  count: number;
  audience?: string;
  existingTitles?: string[];
  focus?: 'trending' | 'evergreen' | 'controversial' | 'beginner' | 'mixed';
  videoType?: string;
  referenceContext?: string;
  redditContext?: string;
}): { system: string; user: string } {
  const videoTypeLabels: Record<string, string> = {
    'explainer': 'Explainer — break down complex topics into clear, digestible content',
    'story': 'Story / Narrative — story-driven with a compelling beginning, middle, and end',
    'tutorial': 'Tutorial / How-To — step-by-step instructional content viewers can follow along',
    'listicle': 'Top 10 / Listicle — ranked lists, countdowns, or compilations',
    'comparison': 'Comparison / Versus — A vs B, product showdowns, or head-to-head debates',
    'reaction': 'Reaction / Commentary — react to news, trends, or other content with personality',
    'case-study': 'Case Study / Deep Dive — in-depth analysis of a specific real-world example',
    'myth-busting': 'Myth Busting — debunk common misconceptions and bad advice',
    'challenge': 'Challenge / Experiment — try something and document the results',
    'interview': 'Interview / Q&A — expert conversations or audience Q&A format',
    'behind-scenes': 'Behind the Scenes — process reveals, day-in-the-life, or making-of content',
    'news-update': 'News / Breaking Update — timely coverage of industry news and developments',
    'opinion': 'Hot Take / Opinion — bold, opinionated take on a polarizing topic',
  };
  const videoTypeInstruction = videoType && videoTypeLabels[videoType]
    ? `\n**Video Type:** ALL ideas MUST be formatted as: ${videoTypeLabels[videoType]}. Every idea should fit this format specifically.`
    : '';

  return {
    system: `You are a viral YouTube content strategist with deep expertise in the "${niche}" niche. You have an uncanny ability to predict which video ideas will explode in views. You understand search intent, trending topics, audience psychology, and the YouTube algorithm intimately.`,

    user: `Generate ${count} high-potential YouTube video ideas for the "${niche}" niche.

**Target Audience:** ${audience || 'People interested in ' + niche}
**Focus Type:** ${focus || 'mixed'} content${videoTypeInstruction}
${existingTitles?.length ? `**Already Done (avoid overlap):**\n${existingTitles.slice(0, 10).map(t => `- ${t}`).join('\n')}` : ''}
${referenceContext ? `\n## REFERENCE VIDEO DEEP ANALYSIS (forensic breakdown of successful videos — use these as blueprints):

${referenceContext}

## HOW TO USE REFERENCE VIDEOS FOR IDEA GENERATION:
- Each reference video above has been deeply analyzed — study the thumbnail strategy, hook technique, content structure, pacing, engagement mechanics, and what makes it work
- Generate ideas that REPLICATE the proven success patterns from these videos
- Adapt their formats, hooks, storytelling techniques, and engagement mechanics to new topics
- For each idea, you MUST explain exactly which techniques you borrowed from which reference video
- Don't just copy topics — copy the MECHANICS that made those videos succeed (hook style, structure, pacing, emotional triggers, curiosity gaps)
- If a reference video's thumbnail strategy works, suggest a similar approach for the new idea
- Study the weaknesses identified in references and ensure your ideas avoid them` : ''}
${redditContext ? `\n## REDDIT RESEARCH (real discussions, pain points, and questions from actual users):

${redditContext}

## HOW TO USE REDDIT DATA:
- These are REAL discussions from people in this niche — their questions, frustrations, debates, and pain points are gold for video ideas
- Study the top comments — they reveal what people ACTUALLY care about (not what SEO tools suggest)
- High-upvote posts = validated demand. High-comment posts = controversial/engaging topics
- Use specific pain points, questions, and debates from these posts as the foundation for your ideas
- For each idea inspired by Reddit, you MUST cite the exact post title and URL` : ''}

For each idea, think:
- What is someone SEARCHING for right now?
- What question keeps them up at night?
- What would make them click IMMEDIATELY?
- What's currently trending but NOT over-saturated?

## Return EXACTLY this JSON format:
\`\`\`json
{
  "ideas": [
    {
      "title": "<click-optimized video title>",${referenceContext || redditContext ? `
      "inspiration_sources": {
        "from_reference_videos": ${referenceContext ? `[
          {
            "video_title": "<exact title of the reference video>",
            "techniques_borrowed": "<specific techniques: hook style, structure, pacing, engagement, storytelling>",
            "how_adapted": "<how you adapted those techniques for this idea>"
          }
        ]` : `[]`},
        "from_reddit": ${redditContext ? `[
          {
            "post_title": "<EXACT title of the Reddit post — copy from the data above>",
            "post_url": "<EXACT URL of the Reddit post — copy from the data above>",
            "subreddit": "<r/subreddit name>",
            "what_was_taken": "<the specific question, pain point, or insight from the post or its top comments>",
            "how_adapted": "<how that discussion became this video idea>"
          }
        ]` : `[]`}
      },` : ''}
      "hook": "<opening line that would make viewers stop scrolling>",
      "description": "<2-3 sentence video description>",
      "why_it_will_perform": "<specific, logic-based reason with data backing — e.g. 'This keyword gets 90K monthly searches with only 12 competing videos above 100K views. Conversion rate for cybersecurity queries is 3x the platform average.'>",
      "performance_breakdown": {
        "search_volume": "<estimated monthly search volume and trend direction>",
        "competition_level": "low|medium|high",
        "competition_reasoning": "<why competition is at that level with specifics>",
        "monetization_potential": "<RPM range and why this niche pays well/poorly>",
        "audience_size": "<estimated addressable audience size and growth trend>",
        "virality_factors": ["<factor 1 — why people would share this>", "<factor 2>"],
        "historical_evidence": "<examples of similar videos that performed well — with rough view counts>"
      },
      "search_intent": "<what people are searching that leads here>",
      "target_audience_segment": "<specific sub-audience>",
      "estimated_difficulty": "easy|medium|hard",
      "content_type": "explainer|tutorial|comparison|opinion|story|list",
      "trend_status": "trending|evergreen|rising|declining",
      "estimated_views_potential": "10K-50K|50K-200K|200K-1M|1M+",
      "confidence_score": <1-10 integer representing your confidence this will hit the estimated views>,
      "best_time_to_publish": "<strategic timing recommendation>",
      "thumbnail_concept": "<visual thumbnail description>",
      "tags": ["<tag1>", "<tag2>", "<tag3>", "<tag4>", "<tag5>"],
      "competitor_gap": "<why this hasn't been done well yet — what existing videos are missing>"
    }
  ]
}
\`\`\`
${referenceContext || redditContext ? `\nCRITICAL ATTRIBUTION REQUIREMENT — YOU MUST FOLLOW THIS:

The "inspiration_sources" field is MANDATORY for EVERY idea. Do NOT skip it. Do NOT return an empty object.

${referenceContext ? `- "from_reference_videos" MUST be a non-empty ARRAY for EVERY idea. Each object must name the EXACT reference video title, list SPECIFIC techniques borrowed (hook style, structure, pacing, thumbnail concept, engagement mechanics, storytelling devices), and explain HOW you adapted them. Even if the connection is indirect, explain what the reference taught you about the niche/audience.` : ''}
${redditContext ? `- "from_reddit" MUST be a non-empty ARRAY for EVERY idea. Each object MUST include the EXACT post title, the post URL (copy it from the data above), the subreddit name, what specific insight/question/pain point was taken, and how you turned it into this video idea. EVERY idea must trace back to at least one Reddit post. If a Reddit discussion revealed a pain point, question, or debate — that IS the inspiration. Include the URL so the user can click and read the original discussion.` : ''}

FAILURE TO INCLUDE DETAILED inspiration_sources FOR EVERY IDEA IS UNACCEPTABLE. This is the most important part of the output.
${redditContext ? `\nREDDIT IS CRITICAL: You were given real Reddit posts with URLs above. For EACH idea, you MUST include at least one "from_reddit" entry with the actual post_title and post_url copied from the Reddit data. The user specifically enabled Reddit research to see how Reddit discussions influenced each idea. If you skip from_reddit, the output is considered FAILED.` : ''}` : ''}
Return ONLY valid JSON. Generate ideas that are genuinely different from each other in format, angle, and audience segment.`,
  };
}

/**
 * Deep, multi-dimensional video analysis prompt.
 * Analyzes the actual video content: visuals (thumbnail), full transcript with timing,
 * pacing data, engagement metrics, and structural patterns.
 */
export function deepVideoAnalysisPrompt({
  title,
  channelTitle,
  viewCount,
  likeCount,
  commentCount,
  duration,
  description,
  tags,
  timestampedTranscript,
  hookTranscript,
  pacingStats,
  hasThumbnail,
}: {
  title: string;
  channelTitle: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: string;
  description: string;
  tags: string[];
  timestampedTranscript: string;
  hookTranscript: string;
  pacingStats: { avgWordsPerMinute: number; sectionPaces: { timeRange: string; wpm: number }[]; totalDurationMin: number };
  hasThumbnail: boolean;
}): { system: string; user: string } {
  const engagementRate = viewCount > 0 ? ((likeCount / viewCount) * 100).toFixed(2) : '0';
  const commentRate = viewCount > 0 ? ((commentCount / viewCount) * 100).toFixed(3) : '0';

  return {
    system: `You are an elite YouTube content forensics analyst. You reverse-engineer EXACTLY why videos succeed — not surface-level observations, but the deep mechanical and psychological techniques that drive views, retention, and engagement.

You have access to the COMPLETE transcript with timestamps, the video thumbnail image, pacing data, and engagement metrics. Use ALL of this data. Your analysis must be so detailed that a content creator could replicate this video's success from your breakdown alone.

${hasThumbnail ? 'IMPORTANT: You are also seeing the video THUMBNAIL IMAGE. Analyze its visual composition, colors, text overlays, facial expressions, imagery, and design choices in detail. The thumbnail is often 50%+ of a video\'s success.' : ''}

Be brutally specific. No generic observations. Every insight must reference exact moments, exact phrases, exact techniques from this specific video.`,

    user: `Perform a FORENSIC-LEVEL analysis of this YouTube video. Dissect EVERYTHING — visuals, content, structure, pacing, language, psychology, engagement mechanics.

## VIDEO METADATA
**Title:** ${title}
**Channel:** ${channelTitle}
**Views:** ${viewCount.toLocaleString()}
**Likes:** ${likeCount.toLocaleString()} (${engagementRate}% engagement rate)
**Comments:** ${commentCount.toLocaleString()} (${commentRate}% comment rate)
**Duration:** ${duration}
**Tags:** ${tags.join(', ') || 'none'}
**Description (first 500 chars):** ${description.slice(0, 500)}

## PACING DATA
**Average WPM:** ${pacingStats.avgWordsPerMinute}
**Total Duration:** ${pacingStats.totalDurationMin} minutes
**Section-by-section pacing:**
${pacingStats.sectionPaces.map(s => `  ${s.timeRange}: ${s.wpm} WPM`).join('\n')}

## HOOK (first 30 seconds — verbatim):
${hookTranscript}

## FULL TIMESTAMPED TRANSCRIPT:
${timestampedTranscript}

---

Return your analysis as this EXACT JSON structure. Be exhaustive and specific:

\`\`\`json
{
  "thumbnail_analysis": {
    "visual_composition": "<describe layout, focal points, rule of thirds, visual hierarchy>",
    "colors_and_contrast": "<dominant colors, contrast strategy, emotional color psychology>",
    "text_overlays": "<any text on thumbnail — font, size, message, positioning>",
    "facial_expressions_people": "<faces shown, expressions, eye contact with viewer, emotional trigger>",
    "clickability_score": "<1-10 with specific reasoning>",
    "what_makes_it_click_worthy": "<the psychological trigger — curiosity gap, shock, promise, fear, etc.>"
  },
  "hook_breakdown": {
    "opening_technique": "<exact technique: question, shocking stat, story drop, controversy, cold open, etc.>",
    "first_sentence_verbatim": "<exact first sentence spoken>",
    "curiosity_mechanism": "<how they create the need to keep watching>",
    "time_to_hook_seconds": "<how many seconds before viewer is hooked>",
    "emotional_trigger": "<fear, curiosity, outrage, excitement, empathy — be specific>",
    "retention_prediction": "<what % of viewers likely stay past 30 seconds and why>"
  },
  "content_structure": {
    "format_type": "<explainer, story, tutorial, listicle, comparison, rant, documentary, etc.>",
    "sections": [
      {
        "timestamp": "<MM:SS-MM:SS>",
        "label": "<section name>",
        "purpose": "<what this section achieves for the viewer>",
        "technique": "<key technique used in this section>"
      }
    ],
    "narrative_arc": "<how tension/interest builds and resolves across the full video>",
    "information_density": "<how much value is packed per minute — sparse, medium, dense>",
    "transition_style": "<how sections connect — hard cuts, bridges, callbacks, teasers>"
  },
  "pacing_analysis": {
    "overall_tempo": "<fast/medium/slow with nuance>",
    "energy_map": "<describe how energy shifts across the video — where it peaks, where it dips>",
    "speed_variations": "<where they speed up (excitement) or slow down (emphasis)>",
    "pause_usage": "<how silence/pauses are used for dramatic effect>",
    "dead_zones": "<any timestamps where energy dies and viewers likely drop off>",
    "retention_architecture": "<how pacing is designed to prevent drop-off>"
  },
  "language_and_voice": {
    "vocabulary_level": "<grade level, jargon density, accessibility>",
    "tone_profile": "<detailed tone: not just 'casual' but 'casual-authoritative with self-deprecating humor'>",
    "signature_phrases": ["<exact phrases this creator repeats or uses distinctively>"],
    "speech_patterns": "<sentence length variation, rhetorical questions, direct address, storytelling devices>",
    "power_words": ["<emotionally charged words used frequently>"],
    "personality_markers": "<what makes this person's voice unique vs generic YouTube>",
    "audience_address_style": "<how they talk TO the viewer — 'you', 'we', direct challenges, etc.>"
  },
  "storytelling_techniques": {
    "narrative_devices": ["<specific devices: foreshadowing, callbacks, cliffhangers, payoffs, reveals, contrast>"],
    "emotional_arc": "<how emotions shift through the video — map the journey>",
    "tension_building": "<how they create and sustain tension before reveals>",
    "example_usage": "<how they use examples, anecdotes, case studies — frequency and style>",
    "analogy_style": "<types of analogies used — simple, complex, humorous, visual>"
  },
  "engagement_mechanics": {
    "pattern_interrupts": [
      {
        "timestamp": "<MM:SS>",
        "technique": "<what they do to re-grab attention>"
      }
    ],
    "curiosity_gaps": ["<moments where they tease information to keep viewers watching>"],
    "calls_to_action": ["<every CTA — subscribe, comment, like — exact wording and placement>"],
    "audience_participation": "<how they involve the viewer — questions, challenges, polls, 'comment below'>",
    "rewatch_triggers": "<elements that might make someone watch again or share>"
  },
  "visual_production_cues": {
    "inferred_visuals": "<from transcript context clues, what B-roll, graphics, demonstrations, screen recordings likely appear>",
    "visual_cue_density": "<how often the video likely changes visual context — cuts per minute estimation>",
    "on_screen_text_usage": "<inferred from transcript pacing — where key points are likely shown as text>",
    "production_level": "<low/medium/high/cinematic — based on channel and content style>"
  },
  "seo_and_discovery": {
    "title_technique": "<why the title works — keywords, emotional triggers, format>",
    "search_intent_match": "<what someone searching would type to find this>",
    "suggested_video_potential": "<why YouTube's algorithm would recommend this>",
    "tag_strategy": "<analysis of tags used>"
  },
  "creator_fingerprint": "<2-3 sentences capturing the UNIQUE essence of this creator's style — what makes them different from everyone else in their niche. This should be so specific that you could identify their video from the description alone.>",
  "replicable_elements": [
    "<specific, actionable technique 1 that can be copied>",
    "<specific, actionable technique 2>",
    "<specific, actionable technique 3>",
    "<specific, actionable technique 4>",
    "<specific, actionable technique 5>"
  ],
  "what_makes_it_work": "<the single most important reason this video performs well — the core mechanic, not a surface observation>",
  "weaknesses": ["<genuine weaknesses or missed opportunities in this video>"]
}
\`\`\`

Return ONLY valid JSON. No text before or after. Be ruthlessly specific — reference exact timestamps, exact quotes, exact techniques. Generic analysis is WORTHLESS.`,
  };
}

export function urlContentAnalysisPrompt(url: string, rawContent: string): { system: string; user: string } {
  return {
    system: `You are an expert content analyst. Extract and synthesize key information from web content for YouTube script research purposes.`,
    user: `Analyze this content from URL: ${url}

## Raw Content:
${rawContent.slice(0, 8000)}

## Extract and provide:
1. **Main Topic/Subject**: What is this about?
2. **Key Points** (bullet list): The 5-10 most important pieces of information
3. **Quotes/Statistics**: Any notable quotes, stats, or data points
4. **Relevance for YouTube**: How could this be used in a YouTube script?
5. **Content Summary**: 2-3 paragraph summary
6. **Potential Script Angles**: 3 ways this content could be used in a video

Format your response clearly with these sections.`,
  };
}

export function channelAnalysisPrompt(channelData: {
  name: string;
  videos: Array<{ title: string; views: number; likes: number; date: string }>;
  niche: string;
}): { system: string; user: string } {
  return {
    system: `You are a YouTube growth strategist analyzing channel performance data to identify opportunities and patterns.`,
    user: `Analyze this YouTube channel's performance:

**Channel:** ${channelData.name}
**Niche:** ${channelData.niche}

**Recent Videos:**
${channelData.videos.map(v => `- "${v.title}" | ${v.views.toLocaleString()} views | ${v.likes.toLocaleString()} likes | ${v.date}`).join('\n')}

## Provide analysis:
1. **Top Performing Content Patterns**: What topics/formats get the most views?
2. **Underperforming Content**: What's not working?
3. **Content Gaps**: What's missing that the audience clearly wants?
4. **Growth Opportunities**: Specific actionable recommendations
5. **Optimal Posting Cadence**: What posting frequency seems to work?
6. **Title Analysis**: What title patterns perform best?
7. **Next 5 Video Recommendations**: Based on this data, what should they make next?`,
  };
}

// ============================================================
// FEATURE: SEO Title & Description Optimizer
// ============================================================

export function seoOptimizationPrompt({
  topic,
  niche,
  script,
  targetKeywords,
  existingTitle,
  additionalContext,
}: {
  topic: string;
  niche: string;
  script?: string;
  targetKeywords?: string;
  existingTitle?: string;
  /** Reusable SEO template + per-call extra rules merged by the
   *  client. Surfaced as USER DIRECTION at the top of the user prompt
   *  so the model applies it to every output (title shortlist,
   *  description body, hashtags, tags, chapters) — not just the
   *  field it appears closest to. Skipped when empty. */
  additionalContext?: string;
}): { system: string; user: string } {
  return {
    system: `You are the world's top YouTube SEO strategist. You've optimized metadata for channels with 50M+ subscribers. You understand YouTube's algorithm, search ranking factors, and click psychology at an expert level.

## RULE PRECEDENCE (READ FIRST):
If the user message opens with a "USER DIRECTION" block, treat every rule there as a HARD RULE the SEO package must satisfy — applies equally to titles, description, hashtags, tags, and chapter labels. The user's rules override any conflicting default in this prompt (length targets, structure suggestions, hashtag count, brand voice, etc.). Do not soften, summarise, or reinterpret them — match their wording where relevant and verify in the JSON that you actually honoured each rule.

## GROUND CLAIMS IN CURRENT, VERIFIABLE REALITY:
- The description, chapter labels, and any "year"/"month"/"recently"-style markers must use current, accurate references — fabricated dates or fake citations tank YouTube's quality signals and the viewer's trust.
- Prefer concrete, recent framings (e.g. "2025 guide", "this quarter") only when you're confident they're accurate; otherwise drop the time marker and keep the substance.
- Never invent statistics, named studies, or quoted experts into the description. A vivid true generality beats a fake specific.

## YOUR SEO KNOWLEDGE:

**TITLE OPTIMIZATION (ranked by impact):**
- Primary keyword MUST appear in the first 40 characters — YouTube weights early words exponentially more
- Optimal length: 47-55 characters (truncates at ~70 desktop, ~50 mobile)
- CTR triggers that measurably boost clicks: numbers ("7 Ways"), brackets/parentheses "[2025 Guide]", power words (Ultimate, Proven, Secret, Shocking), question format, current year
- Titles with brackets increase CTR by ~38% (HubSpot/Backlinko data)
- NEVER use ALL CAPS for more than one word — YouTube may penalize
- Avoid clickbait that causes high bounce rate — the algorithm will bury it
- Each title should work as both a search result AND a suggested video recommendation

**DESCRIPTION OPTIMIZATION:**
- First 150 characters are CRITICAL — this is the "above the fold" text shown in search results. Must contain primary keyword and a compelling hook
- Total length: 200-500 words for optimal ranking
- Keyword density: 1-2% (natural, not stuffed)
- Structure: hook paragraph > timestamps > keyword-rich body > links/CTAs > hashtags
- Include 3-5 hashtags at the END — first 3 appear above the video title on YouTube
- Timestamps improve CTR and watch time; format: 0:00 Section Name

**TAG OPTIMIZATION:**
- Tags have diminished importance but still matter for misspelling coverage and related-video suggestions
- First tag = exact primary keyword
- Mix of broad and long-tail tags (8-15 tags total)
- 500 character limit
- Tags should mirror terms used in title and description

**ALGORITHM PRIORITIES (2025-2026 ranking):**
1. Click-through rate (CTR)
2. Average view duration / retention
3. Session watch time
4. Engagement (likes, comments, shares)
5. Keyword relevance (title > description > tags > transcript)`,

    user: `Generate a COMPLETE, publish-ready SEO optimization package for this YouTube video.
${additionalContext && additionalContext.trim() ? `
## USER DIRECTION — HARD RULES (apply to every field below: titles, description, hashtags, tags, chapters):
${additionalContext.trim()}

These rules are binding. Re-read them before you produce the description in particular — that's where they matter most. If anything else in this brief conflicts with a rule here, the user direction wins.
` : ''}
**Topic:** ${topic}
**Niche:** ${niche}
${existingTitle ? `**Current Title:** ${existingTitle}` : ''}
${targetKeywords ? `**Target Keywords:** ${targetKeywords}` : ''}
${script ? `**Script Content (for chapter extraction and keyword analysis):**\n${script.slice(0, 6000)}` : ''}

## Return this EXACT JSON format:

\`\`\`json
{
  "titles": [
    {
      "title": "<optimized title, 47-55 chars>",
      "score": <0-100 composite SEO+CTR score>,
      "character_count": <number>,
      "primary_keyword_position": <character position where primary keyword starts>,
      "breakdown": {
        "keyword_placement": { "score": <0-100>, "detail": "<where keywords appear and why>" },
        "length_optimization": { "score": <0-100>, "detail": "<character count analysis>" },
        "ctr_triggers": { "score": <0-100>, "triggers_found": ["<number>", "<bracket>", "<power word>"], "detail": "<what psychological triggers are used>" },
        "emotional_pull": { "score": <0-100>, "emotion": "<curiosity/fear/excitement/shock/etc>", "detail": "<why someone would click>" },
        "search_intent_match": { "score": <0-100>, "detail": "<does this match what people actually search for?>" }
      },
      "style": "<question|how-to|listicle|shocking-stat|controversy|transformation>"
    }
  ],
  "description": {
    "above_fold": "<first 150 characters — must contain primary keyword and hook. This appears in search results.>",
    "full_description": "<complete 200-400 word description with natural keyword placement, structured paragraphs, CTAs>",
    "hashtags": ["<3-5 relevant hashtags without # symbol>"]
  },
  "tags": [
    {
      "tag": "<tag text>",
      "type": "primary|secondary|long-tail|misspelling",
      "relevance": <1-10>
    }
  ],
  "chapters": [
    {
      "timestamp": "<0:00 format>",
      "title": "<chapter title — keyword-rich, 3-6 words>"
    }
  ],
  "seo_analysis": {
    "primary_keyword": "<the main keyword this video should rank for>",
    "secondary_keywords": ["<3-5 supporting keywords>"],
    "search_volume_estimate": "<estimated monthly searches for primary keyword>",
    "competition_assessment": "<low/medium/high with reasoning>",
    "ranking_strategy": "<1-2 sentence strategy — which search queries this will capture>"
  }
}
\`\`\`

Generate exactly 8 title variants using DIFFERENT styles (question, how-to, listicle, shocking stat, controversy, transformation, curiosity gap, authority). Score each honestly — not every title should be 90+. Generate 12-15 tags. If script is provided, extract 5-8 logical chapters.

Return ONLY valid JSON.`,
  };
}

// ============================================================
// FEATURE: AI Thumbnail Concept Generator
// ============================================================

/**
 * Shape the thumbnail prompt builder accepts for a resolved style
 * preset. Differs from `ScriptStylePreset` in that `ai_image_suffix`
 * IS load-bearing here — it gets appended to every concept's
 * `image_generation_prompt` so downstream Midjourney/DALL·E prompts
 * inherit the style verbatim.
 */
export interface ThumbnailStylePreset {
  label: string;
  description?: string;
  mixing_rules?: string;
  ai_image_suffix?: string;
}

export function thumbnailConceptPrompt({
  title,
  niche,
  script,
  description,
  hasReferenceImage,
  stylePreset,
}: {
  title: string;
  niche: string;
  script?: string;
  description?: string;
  /** When true, a reference image is attached to the user message as a
   *  multimodal block. The prompt switches on a STYLE-LOCK clause that
   *  forces every concept's `image_generation_prompt` to describe a
   *  thumbnail in that exact visual language — see _plans/2026-05-18-
   *  thumbnail-reference-multimodal.md for the rationale. */
  hasReferenceImage?: boolean;
  /** Optional resolved style preset (built-in slug or saved row,
   *  pre-resolved via `resolveStyle`). When present the style's
   *  ai_image_suffix is appended to every concept's image generation
   *  prompt; mixing_rules drive composition guidance. When absent the
   *  prompt is byte-identical to the pre-preset version. */
  stylePreset?: ThumbnailStylePreset | null;
}): { system: string; user: string } {
  const nicheStyles: Record<string, string> = {
    'Gaming': 'Bright neon colors, character close-ups, minimal text, action shots. High saturation.',
    'Education': 'Clean backgrounds, before/after splits, numbered lists, professional feel. Blue/white tones.',
    'Technology': 'Product hero shots on clean backgrounds, comparison layouts, brand colors. Minimalist.',
    'Finance': 'Professional headshots, green/gold schemes, data visualizations, money imagery.',
    'Entertainment': 'Exaggerated facial expressions, bright solid backgrounds, 2-3 word text. High energy.',
    'Health': 'Clean, aspirational imagery, before/after transformations, natural tones.',
    'Science': 'Dramatic visuals, space/nature imagery, bold contrasting text. Curiosity-driven.',
    'Cooking': 'Overhead food shots, vibrant colors, close-up textures, warm lighting.',
  };
  const nicheHint = nicheStyles[niche] || 'Adapt to this niche\'s visual conventions while standing out from competitors.';

  const stylePresetBlock = buildThumbnailStylePresetBlock(stylePreset);
  const suffixForPrompts = stylePreset?.ai_image_suffix?.trim() || '';

  return {
    system: `You are an elite YouTube thumbnail designer and click psychology expert. You've designed thumbnails for channels with 100M+ views. You understand the science of what makes people click — visual hierarchy, emotional triggers, color psychology, and the split-second decision viewers make when scrolling.

## THUMBNAIL DESIGN PRINCIPLES (research-backed):

**FACE & EMOTION (highest CTR impact ~30%):**
- Thumbnails with expressive human faces get ~30% higher CTR
- Extreme emotions (shock, joy, disgust, fear) outperform neutral expressions
- Eyes must be visible and "making contact" with the viewer
- Face should occupy 30-50% of vertical space

**CONTRAST & COLOR (~20% CTR impact):**
- High contrast between subject and background is essential
- 3-color rule: limit palette to 2-3 dominant colors
- Yellow/red/orange elements outperform cool tones for attention
- Background must be visually distinct from YouTube's white/dark UI

**TEXT OVERLAY (~15% CTR impact):**
- Maximum 3-5 words — must be readable at 168x94px (mobile size)
- Large bold sans-serif fonts (Impact, Bebas Neue, Montserrat Black)
- Text should COMPLEMENT the title, not repeat it
- High contrast text with stroke/shadow for legibility
- No more than 25-30% of thumbnail area

**COMPOSITION (~15% CTR impact):**
- Rule of thirds — subject on left or right third
- Subject occupies 40-60% of frame
- Avoid cluttered backgrounds — negative space draws the eye
- Safe zones: avoid bottom-right (timestamp overlay) and edges (cropping)

**THUMBNAIL-TITLE SYNERGY (~10% CTR impact):**
- Thumbnail and title should tell a COMBINED story
- Thumbnail creates the question, title provides the context (or vice versa)
- Never repeat the exact title text in the thumbnail

**NICHE-SPECIFIC for "${niche}":**
${nicheHint}`,

    user: `${hasReferenceImage ? `## STYLE-LOCK — READ THIS FIRST

A reference image is attached to this message. It defines the **exact visual style** the user wants for every thumbnail in this set.

Study the reference carefully and lock onto its visual language:
- Overall layout (single hero scene? grid of tile-cards? split panel? card with caption band?)
- Subject treatment (real photographs? illustrated icons? 3D renders? mixed?)
- Use of human faces (present? absent? close-up? wide?)
- Level of visual detail (busy and packed? clean and minimal? mid-density?)
- Text-to-image ratio (text-heavy? text minimal? text in a band below the image?)
- Color treatment (saturated? muted? high-contrast? specific palette?)
- Typography (style, weight, placement)
- Background treatment (solid, gradient, photo, environmental)
- Framing and edges (full-bleed, bordered tile, drop-shadow card)

**Every concept's \`image_generation_prompt\` MUST describe a thumbnail in this exact style.** The 5 concepts vary in *content* (subject, focal moment, emotional trigger, color accents within the established palette) but the *visual language stays constant*. This is non-negotiable — do not drift toward the generic "shocked-face composite scene" YouTube formula unless the reference itself is in that style.

If the reference shows isolated tile-cards with a single visual per card and a label band, do not invent composite scenes with multiple subjects. If the reference uses no human faces, do not introduce them. If the reference is minimal, do not make it busy. Mirror what you see.

The score/composition/text-overlay/color-palette fields below should also reflect the reference's choices, not default YouTube best-practice averages.

---

` : ''}Design 5 distinct thumbnail concepts for this YouTube video. Each must be a different creative direction that a designer could execute immediately.

**Video Title:** ${title}
**Niche:** ${niche}
${description ? `**Video Description:** ${description.slice(0, 500)}` : ''}
${script ? `**Script Excerpt (for context):** ${script.slice(0, 2000)}` : ''}
${stylePresetBlock}

## Return this EXACT JSON format:

\`\`\`json
{
  "concepts": [
    {
      "concept_name": "<short creative name, e.g. 'The Shocked Expert'>",
      "creative_direction": "<1 sentence — what's the visual story?>",
      "composition": {
        "layout": "<describe the spatial arrangement — what's where>",
        "focal_point": "<what the eye hits first>",
        "background": "<background treatment — solid, gradient, blurred photo, etc.>",
        "subject_position": "<left-third, center, right-third>"
      },
      "face_and_people": {
        "included": true,
        "expression": "<specific emotion — not just 'surprised' but 'mouth-open shock with raised eyebrows'>",
        "positioning": "<how they're framed — close-up, waist-up, full body>",
        "eye_contact": "<looking at camera, looking at text/object, looking off-frame>"
      },
      "text_overlay": {
        "text": "<2-4 words MAX>",
        "font_style": "<bold sans-serif, handwritten, etc.>",
        "position": "<where on the thumbnail>",
        "color": "<text color with contrast reasoning>",
        "effect": "<stroke, shadow, glow, none>"
      },
      "color_palette": {
        "primary": "<hex + name>",
        "secondary": "<hex + name>",
        "accent": "<hex + name>",
        "psychology": "<why these colors work for this content>"
      },
      "emotional_trigger": "<the specific psychological trigger — curiosity gap, fear of missing out, shock, transformation, before/after>",
      "ctr_prediction": {
        "score": <0-100>,
        "breakdown": {
          "face_impact": { "score": <0-100>, "reason": "<why>" },
          "contrast_and_visibility": { "score": <0-100>, "reason": "<why>" },
          "text_readability": { "score": <0-100>, "reason": "<why>" },
          "emotional_pull": { "score": <0-100>, "reason": "<why>" },
          "title_synergy": { "score": <0-100>, "reason": "<how thumbnail + title work together>" },
          "niche_fit": { "score": <0-100>, "reason": "<why>" }
        }
      },
      "image_generation_prompt": "<detailed prompt for Midjourney/DALL-E to generate this thumbnail — include style, composition, lighting, camera angle, color grading${hasReferenceImage ? '. CRITICAL: open the prompt by describing the visual style of the attached reference image in concrete terms (layout, subject treatment, face/no-face, density, palette, typography placement) so the image model reproduces that style. Only after the style is locked in writing should the concept-specific content follow' : ''}${suffixForPrompts ? `. Then APPEND verbatim at the end of the prompt: \`${suffixForPrompts}\` — this is the style preset's image suffix and must be the trailing portion of every concept's image_generation_prompt without modification` : ''}>",
      "why_it_works": "<1-2 sentences — the core psychological reason this thumbnail will get clicks>",
      "mobile_test": "<will this be legible and impactful at 168x94 pixels? what might get lost?>"
    }
  ],
  "niche_best_practices": [
    "<specific thumbnail tip for ${niche} niche>"
  ],
  "common_mistakes_to_avoid": [
    "<mistake 1>",
    "<mistake 2>",
    "<mistake 3>"
  ],
  "a_b_test_recommendation": "<which 2 concepts to A/B test first and why>"
}
\`\`\`

Make each concept GENUINELY different — different emotions, different compositions, different color schemes. At least one should be unconventional/risky. Score honestly — most thumbnails score 50-75, only exceptional ones hit 85+.

Return ONLY valid JSON.`,
  };
}

// ============================================================
// FEATURE: Competitor Outlier Analysis
// ============================================================

export function competitorOutlierPrompt({
  channelName,
  niche,
  videos,
  medianViews,
  avgEngagement,
}: {
  channelName: string;
  niche: string;
  videos: Array<{ title: string; views: number; likes: number; comments: number; date: string; outlierScore: number }>;
  medianViews: number;
  avgEngagement: number;
}): { system: string; user: string } {
  const outliers = videos.filter(v => v.outlierScore >= 3);
  const underperformers = videos.filter(v => v.outlierScore < 0.5);

  return {
    system: `You are a YouTube competitive intelligence analyst. You reverse-engineer WHY specific videos from competitor channels massively outperform or underperform their channel average. Your insights are actionable — a creator should be able to replicate a competitor's success from your analysis.`,

    user: `Analyze this competitor channel's performance patterns and extract actionable intelligence.

**Channel:** ${channelName}
**Niche:** ${niche}
**Median Views:** ${medianViews.toLocaleString()}
**Avg Engagement Rate:** ${(avgEngagement * 100).toFixed(1)}%

## OUTLIER VIDEOS (performing ${'>'}3x above median):
${outliers.length > 0 ? outliers.map(v =>
  `- "${v.title}" | ${v.views.toLocaleString()} views (${v.outlierScore.toFixed(1)}x median) | ${v.likes} likes, ${v.comments} comments | ${v.date}`
).join('\n') : 'None found'}

## UNDERPERFORMERS (below 0.5x median):
${underperformers.length > 0 ? underperformers.slice(0, 5).map(v =>
  `- "${v.title}" | ${v.views.toLocaleString()} views (${v.outlierScore.toFixed(1)}x median) | ${v.date}`
).join('\n') : 'None found'}

## ALL RECENT VIDEOS:
${videos.slice(0, 30).map(v =>
  `- "${v.title}" | ${v.views.toLocaleString()} views | ${v.outlierScore.toFixed(1)}x | ${v.date}`
).join('\n')}

## Return this JSON format:

\`\`\`json
{
  "channel_strategy": "<2-3 sentences describing their overall content strategy>",
  "what_works": [
    {
      "pattern": "<specific pattern that drives views>",
      "evidence": "<which videos prove this>",
      "replicable": "<how YOU could use this pattern>"
    }
  ],
  "what_fails": [
    {
      "pattern": "<what doesn't work>",
      "evidence": "<which videos prove this>",
      "lesson": "<what to avoid>"
    }
  ],
  "outlier_breakdown": [
    {
      "title": "<exact outlier video title>",
      "why_it_exploded": "<specific reasons — topic timing, title technique, search trend, controversy>",
      "replicable_elements": ["<element 1>", "<element 2>"]
    }
  ],
  "content_gaps": ["<topic/format this channel hasn't covered that you could own>"],
  "title_patterns": {
    "winning_formulas": ["<title pattern that gets high views>"],
    "losing_formulas": ["<title pattern that underperforms>"]
  },
  "upload_strategy": "<frequency, timing, consistency assessment>",
  "threat_level": "<low/medium/high — how much of a competitive threat is this channel to you>",
  "steal_these_ideas": [
    {
      "idea": "<specific video idea inspired by their success>",
      "based_on": "<which of their videos inspired this>",
      "your_angle": "<how to make it yours, not a copy>"
    }
  ]
}
\`\`\`

Return ONLY valid JSON.`,
  };
}

// ============================================================
// FEATURE: Competitor Deep Analysis (v2 — zero-hallucination)
// ============================================================

export function competitorDeepAnalysisPrompt({
  channelName,
  subscriberCount,
  niche,
  analyticsJson,
  topVideos,
  bottomVideos,
  outlierVideos,
  sampleComments,
}: {
  channelName: string;
  subscriberCount: number;
  niche: string;
  analyticsJson: string;
  topVideos: Array<{ title: string; views: number; likes: number; comments: number; durationSec: number; tags: string[]; publishedAt: string; videoId: string }>;
  bottomVideos: Array<{ title: string; views: number; likes: number; comments: number; durationSec: number; tags: string[]; publishedAt: string; videoId: string }>;
  outlierVideos: Array<{ title: string; views: number; outlierScore: number; videoId: string }>;
  sampleComments: Array<{ videoTitle: string; videoId: string; comments: { text: string; likes: number }[] }>;
}): { system: string; user: string } {
  return {
    system: `You are a senior YouTube competitive intelligence analyst producing a BRUTALLY DETAILED, PROFESSIONAL, DATA-DRIVEN audit of a competitor channel.

ABSOLUTE RULES — violating any of these makes the entire analysis invalid:
1. ZERO HALLUCINATIONS. Every quantitative claim must cite a number present in the analytics bundle I provide. Do not invent views, rates, dates, or trends.
2. Every qualitative claim about a specific video MUST cite a concrete video title AND its video_id from the data I provide, in the form: "\\"Title Here\\" (videoId: ABC123)".
3. If the data is insufficient to support a claim, write "insufficient data" instead of guessing. It is better to say less than to fabricate.
4. Do not reference any competitor, creator, or trend that is not present in the data I provide.
5. Numbers must match the analytics bundle exactly. Percentages, counts, and averages are already computed — use them verbatim.

Your output is structured JSON. Be ruthless, specific, and actionable.`,

    user: `Analyze this YouTube competitor. All numbers below are pre-computed from real YouTube API data. Use them — do not recompute or invent new numbers.

**Channel:** ${channelName} (${subscriberCount.toLocaleString()} subscribers)
**User's niche:** ${niche}

## COMPUTED ANALYTICS BUNDLE (verbatim — cite these numbers):
\`\`\`json
${analyticsJson}
\`\`\`

## TOP PERFORMERS (top 10% by views):
${topVideos.map(v => `- "${v.title}" (videoId: ${v.videoId}) — ${v.views.toLocaleString()} views, ${v.likes.toLocaleString()} likes, ${v.comments.toLocaleString()} comments, ${v.durationSec}s, tags: [${v.tags.slice(0, 8).join(', ')}], published ${v.publishedAt.slice(0, 10)}`).join('\n')}

## BOTTOM PERFORMERS (bottom 10% by views):
${bottomVideos.map(v => `- "${v.title}" (videoId: ${v.videoId}) — ${v.views.toLocaleString()} views, ${v.likes.toLocaleString()} likes, ${v.comments.toLocaleString()} comments, ${v.durationSec}s, tags: [${v.tags.slice(0, 8).join(', ')}], published ${v.publishedAt.slice(0, 10)}`).join('\n')}

## OUTLIERS (≥3x median views):
${outlierVideos.length ? outlierVideos.map(v => `- "${v.title}" (videoId: ${v.videoId}) — ${v.views.toLocaleString()} views, ${v.outlierScore.toFixed(1)}x median`).join('\n') : 'None'}

## SAMPLE AUDIENCE COMMENTS (top comments on top-performing videos):
${sampleComments.length ? sampleComments.map(s => `### "${s.videoTitle}" (videoId: ${s.videoId})\n${s.comments.slice(0, 8).map(c => `  - "${c.text.replace(/\n/g, ' ').slice(0, 180)}" (${c.likes} likes)`).join('\n')}`).join('\n\n') : 'No comments sampled'}

---

Return ONLY this JSON (no prose outside the JSON):

\`\`\`json
{
  "executive_summary": "<3-5 sentences: who this channel is, what they do, their dominant strategy, and the single biggest insight from the data. Cite at least 2 hard numbers from the analytics bundle.>",
  "threat_level": "<low|medium|high|critical>",
  "threat_justification": "<1-2 sentences citing subscriber count, median views, and momentum from the analytics>",
  "performance_snapshot": {
    "median_views": 0,
    "p90_views": 0,
    "median_engagement_pct": 0,
    "uploads_per_week": 0,
    "consistency_score": 0,
    "momentum": "steady",
    "momentum_pct": 0,
    "interpretation": "<2-3 sentence plain-English reading of these numbers>"
  },
  "what_they_do_right": [
    { "strength": "<specific>", "quantitative_evidence": "<cite exact numbers>", "video_examples": ["\\"Title\\" (videoId: ABC)"], "why_it_works": "<mechanism>", "replicable_tactic": "<one concrete action>" }
  ],
  "what_they_do_wrong": [
    { "weakness": "<specific>", "quantitative_evidence": "<cite exact numbers>", "video_examples": ["\\"Title\\" (videoId: XYZ)"], "cost_to_them": "<impact>", "lesson_for_user": "<what to avoid>" }
  ],
  "top_video_deep_dives": [
    {
      "video_title": "<exact title>",
      "video_id": "<exact videoId>",
      "views": 0,
      "outlier_multiple": 0,
      "why_it_succeeded": {
        "title_mechanics": "<analysis citing concrete title elements>",
        "duration_fit": "<alignment with best bucket>",
        "tag_strategy": "<which tags and overlap with tagsInTopPerformers>",
        "publish_timing": "<day/hour vs bestDayByAvgViews>",
        "audience_signal": "<what comments praise — or 'insufficient data'>"
      },
      "replicable_elements": ["<element 1>", "<element 2>", "<element 3>"]
    }
  ],
  "bottom_video_postmortems": [
    {
      "video_title": "<exact title>",
      "video_id": "<exact videoId>",
      "views": 0,
      "views_vs_median_pct": 0,
      "why_it_underperformed": {
        "title_issues": "<specific flaws referencing actual title text>",
        "duration_mismatch": "<if matching worstBucket>",
        "tag_gap": "<missing tags from winning set>",
        "timing_issue": "<if on a weak day/hour>"
      },
      "lesson": "<one sentence>"
    }
  ],
  "title_formula_extraction": {
    "winning_patterns": [ { "pattern": "<describe>", "evidence_videos": ["\\"Title\\" (videoId: X)"], "stat": "<cite from analytics>" } ],
    "losing_patterns": [ { "pattern": "<describe>", "evidence_videos": ["\\"Title\\" (videoId: X)"], "stat": "<cite>" } ],
    "recommended_title_templates": ["<template 1>", "<template 2>", "<template 3>"]
  },
  "cadence_verdict": {
    "assessment": "<healthy|inconsistent|sparse|flooded>",
    "evidence": "<cite uploadsPerWeek, consistencyScore, medianGapDays>",
    "best_publishing_window": "<cite bestDayByAvgViews and bestHourByAvgViews>",
    "recommendation": "<concrete action>"
  },
  "duration_strategy": {
    "their_best_bucket": "<from analytics>",
    "their_worst_bucket": "<from analytics>",
    "avg_views_by_bucket": "<one-line summary>",
    "recommendation_for_user": "<target duration>"
  },
  "audience_insights": {
    "what_audience_loves": ["<pattern 1>", "<pattern 2>"],
    "what_audience_complains_about": ["<criticism 1>"],
    "audience_quotes": [ { "quote": "<verbatim>", "video_id": "<id>", "likes": 0 } ],
    "sentiment_verdict": "<predominantly positive|mixed|hostile|insufficient data>",
    "note": "<if no comments: 'No comments sampled — skip'>"
  },
  "content_gaps_for_user": [
    { "gap": "<topic/format not covered>", "opportunity": "<why user could win>", "adjacent_evidence": "<what IS in their content>" }
  ],
  "steal_these_ideas": [
    {
      "video_idea_title": "<concrete title>",
      "inspired_by": "<competitor video title + videoId>",
      "your_angle": "<differentiator>",
      "target_duration_seconds": 0,
      "recommended_tags": ["<tag 1>"],
      "hook_suggestion": "<one-line hook>"
    }
  ],
  "thumbnail_strategy_hypothesis": "<1-2 sentences based on title cues>",
  "one_page_action_plan": ["<action 1>", "<action 2>", "<action 3>", "<action 4>", "<action 5>"],
  "data_quality_note": "<honest limitations, e.g. 'only 42 videos in dataset', 'no comments available'>"
}
\`\`\`

Return ONLY valid JSON. No prose outside the JSON.`,
  };
}

// ============================================================
// FEATURE: Competitor Thumbnail Vision Analysis
// ============================================================

export function competitorThumbnailPrompt({
  videoTitle,
  views,
  outlierScore,
}: {
  videoTitle: string;
  views: number;
  outlierScore: number;
}): { system: string; user: string } {
  return {
    system: `You are a YouTube thumbnail design analyst. You analyze competitor thumbnails with forensic precision and produce actionable design briefs.

ABSOLUTE RULES:
1. Only describe what you can actually see in the image. Do not invent text, colors, objects, or faces not present.
2. If the image is blurry, low-res, or you cannot identify an element, say "unclear" rather than guessing.
3. Be specific about composition, color hex approximations, facial expression, text placement, visual hierarchy.`,
    user: `Analyze this YouTube thumbnail.

**Video title:** "${videoTitle}"
**Views:** ${views.toLocaleString()}
**Performance:** ${outlierScore.toFixed(1)}x channel median ${outlierScore >= 3 ? '(OUTLIER)' : outlierScore < 0.5 ? '(UNDERPERFORMER)' : '(average)'}

Return ONLY this JSON:

\`\`\`json
{
  "composition": {
    "layout": "<e.g. 'face left, text right'>",
    "focal_point": "<what draws the eye first>",
    "rule_of_thirds": "<observed or violated>",
    "visual_hierarchy_score": "<1-10 with justification>"
  },
  "colors": {
    "dominant_palette": ["<approx hex 1>", "<hex 2>", "<hex 3>"],
    "contrast_rating": "<high|medium|low>",
    "uses_saturation_pop": false,
    "color_psychology": "<emotions evoked>"
  },
  "text_overlay": {
    "present": false,
    "exact_text": "<verbatim or null>",
    "font_style": "<description>",
    "text_readability_at_small_size": "<high|medium|low>",
    "text_percent_of_frame": "<approx>"
  },
  "human_element": {
    "face_present": false,
    "facial_expression": "<shocked|excited|angry|serious|smiling|neutral|none>",
    "eye_contact_with_camera": false,
    "gesture": "<pointing|holding object|none|unclear>"
  },
  "subjects_and_objects": ["<item 1>"],
  "clickbait_elements": {
    "arrows_or_circles": false,
    "red_vs_green_contrast": false,
    "numbers_visible": false,
    "emotional_provocation": "<curiosity|fear|surprise|humor|none>"
  },
  "why_this_probably_worked_or_failed": "<2-3 sentences tying visual elements to performance>",
  "replicable_design_brief": {
    "layout_to_copy": "<description>",
    "color_direction": "<description>",
    "text_formula": "<if text present>",
    "emotional_target": "<feeling to evoke>",
    "specific_dos": ["<do 1>", "<do 2>", "<do 3>"],
    "specific_donts": ["<don't 1>", "<don't 2>"]
  }
}
\`\`\`

Return ONLY valid JSON.`,
  };
}

// ============================================================
// FEATURE: Competitor Video Forensics (Gemini native YouTube input)
// ============================================================

export function competitorVideoForensicsPrompt({
  videoTitle,
  channelName,
  views,
  likes,
  comments,
  outlierScore,
  durationSeconds,
  publishedAt,
  niche,
}: {
  videoTitle: string;
  channelName: string;
  views: number;
  likes: number;
  comments: number;
  outlierScore: number;
  durationSeconds: number;
  publishedAt: string;
  niche: string;
}): { system: string; user: string } {
  return {
    system: `You are a forensic video analyst for YouTube creators. You watch the ENTIRE video and produce a frame-accurate, audio-accurate, structurally-rigorous breakdown.

ABSOLUTE RULES — violating any of these makes the analysis invalid:
1. ZERO HALLUCINATIONS. Only describe what is actually visible or audible in the video. If something is unclear, say "unclear" — do not guess.
2. Quote on-screen text and spoken phrases VERBATIM. If you cannot make out a phrase, say "(inaudible)" or "(text unreadable)".
3. Every timestamp you provide must reference an event you actually saw at that timestamp. Format: [MM:SS] or [HH:MM:SS].
4. Do not invent statistics, brand mentions, sponsorships, or facts that are not stated/shown in the video.
5. Be specific — "the host" not "they"; "a red graphic with the text 'BREAKING'" not "some text appears".
6. If the video is region-blocked, age-restricted, or otherwise inaccessible, return a JSON object with only the field {"error": "Video inaccessible: <reason>"} and nothing else.

Your output is a structured JSON document. Be ruthless, specific, and useful.`,

    user: `Watch this YouTube video in full and produce a forensic analysis.

**Video metadata (do not invent — these are pre-known facts):**
- Title: "${videoTitle}"
- Channel: ${channelName}
- Views: ${views.toLocaleString()}
- Likes: ${likes.toLocaleString()}
- Comments: ${comments.toLocaleString()}
- Duration: ${Math.floor(durationSeconds / 60)}:${(durationSeconds % 60).toString().padStart(2, '0')}
- Outlier score: ${outlierScore.toFixed(2)}x channel median ${outlierScore >= 3 ? '(MASSIVE OUTLIER)' : outlierScore < 0.5 ? '(UNDERPERFORMER)' : '(typical)'}
- Published: ${publishedAt.slice(0, 10)}
- User's niche (for relevance scoring): ${niche}

Return ONLY this JSON (no prose outside the JSON):

\`\`\`json
{
  "video_summary": {
    "one_line_pitch": "<what is this video actually about, in one sentence>",
    "core_promise_to_viewer": "<what the title/thumbnail promises and whether the video delivers>",
    "delivers_on_promise": "<yes|partial|no — with one-sentence justification>"
  },

  "hook_analysis": {
    "first_15_seconds_transcript": "<verbatim spoken words in the first 15 seconds — or '(no narration)'>",
    "first_15_seconds_visuals": "<what is shown on screen in the first 15s — be specific about cuts, b-roll, text>",
    "hook_type": "<question|stat|claim|story|cold-open|teaser|controversy|other>",
    "hook_effectiveness_score": "<1-10 with one-sentence justification>",
    "retention_risk_in_hook": "<what might cause viewers to drop off in the first 30s>"
  },

  "structural_breakdown": [
    { "timestamp": "[MM:SS]", "section": "<intro|context|main-point|demo|tangent|sponsor|cta|outro>", "description": "<what happens here, 1 sentence>", "purpose": "<what role this plays in the video's argument>" }
  ],

  "pacing_and_editing": {
    "estimated_cuts_per_minute": "<rough estimate based on observation>",
    "cut_style": "<jump-cut|smooth|cinematic|talking-head-static|mixed>",
    "b_roll_density": "<heavy|moderate|sparse|none>",
    "music_present": "<yes-throughout|yes-intermittent|no>",
    "music_style": "<description if present>",
    "energy_curve": "<one-sentence description of how energy ebbs and flows>",
    "dead_zones": ["<timestamp + reason where attention may drop>"]
  },

  "on_screen_graphics": {
    "lower_thirds": "<yes|no — describe style if yes>",
    "text_overlays_present": "<yes|no>",
    "key_text_overlays": [ { "timestamp": "[MM:SS]", "verbatim_text": "<exact text>", "purpose": "<emphasis|stat|quote|chapter|cta>" } ],
    "graphics_quality": "<professional|amateur|stock|none>",
    "branded_elements": "<watermark|intro-bumper|outro-card|none — describe>"
  },

  "verbal_content": {
    "transcript_excerpts": [
      { "timestamp": "[MM:SS]", "verbatim_quote": "<exact spoken words>", "why_notable": "<rhetorical device, key claim, emotional moment, etc>" }
    ],
    "speaking_style": "<calm|energetic|conversational|scripted|rant|teaching|sales>",
    "filler_words_observed": "<low|moderate|heavy>",
    "claims_made": [
      { "claim": "<exact claim>", "evidence_provided_in_video": "<what evidence the host shows or cites>", "verifiable": "<yes|no|requires-external-check>" }
    ]
  },

  "visual_production": {
    "setting": "<studio|home-office|outdoor|on-location|screen-capture|mixed>",
    "lighting": "<professional-key-fill|natural|harsh|soft|low — be specific>",
    "color_grading": "<warm|cool|neutral|stylized — describe>",
    "camera_setup": "<single-static|multi-angle|moving|gimbal|webcam — describe>",
    "host_appearance": "<describe presentation: attire, demeanor, gestures — only what's visible>",
    "backdrop_elements": ["<element 1 visible behind host>"]
  },

  "monetization_signals": {
    "sponsor_segment_present": "<yes|no>",
    "sponsor_timestamp": "<[MM:SS] or null>",
    "sponsor_brand": "<name if mentioned, or null>",
    "sponsor_integration_quality": "<seamless|abrupt|skippable-clearly-marked|na>",
    "affiliate_or_product_mentions": ["<product 1 mentioned with timestamp>"],
    "merch_or_own_product_pitch": "<yes|no — describe if yes>"
  },

  "calls_to_action": [
    { "timestamp": "[MM:SS]", "cta_type": "<like|subscribe|comment|click-link|buy|next-video|newsletter>", "verbatim": "<exact words>", "placement_quality": "<natural|forced|too-early|effective>" }
  ],

  "thumbnail_vs_video_alignment": {
    "title_promise_kept": "<yes|partial|no>",
    "clickbait_assessment": "<honest|mild-clickbait|heavy-clickbait|misleading>",
    "satisfaction_prediction": "<a viewer who clicked expecting X — were they satisfied? Why?>"
  },

  "audience_targeting": {
    "assumed_knowledge_level": "<beginner|intermediate|advanced|mixed>",
    "language_complexity": "<simple|moderate|technical>",
    "cultural_or_regional_signals": ["<observed signal>"],
    "ideal_viewer_persona": "<one-sentence description of who this video is FOR>"
  },

  "what_made_it_work_or_fail": {
    "top_3_strengths": [
      { "strength": "<specific>", "timestamp_evidence": "[MM:SS]", "explanation": "<1 sentence>" }
    ],
    "top_3_weaknesses": [
      { "weakness": "<specific>", "timestamp_evidence": "[MM:SS]", "explanation": "<1 sentence>" }
    ],
    "single_biggest_lesson": "<one paragraph — the most important takeaway, tied to the outlier score>"
  },

  "replicable_playbook_for_user": {
    "structural_template": "<a reusable structural skeleton based on this video>",
    "hook_template": "<a fill-in-the-blanks hook the user could adapt>",
    "must_steal_techniques": ["<technique 1>", "<technique 2>", "<technique 3>"],
    "do_not_copy": ["<element 1 that won't work for the user>", "..."],
    "estimated_production_difficulty": "<easy|medium|hard|very-hard>",
    "estimated_production_cost": "<low|medium|high — with brief justification>"
  },

  "data_quality_note": "<honest disclosure of any analysis limitations — e.g. 'video too long for full coverage', 'audio quality made some quotes unreadable', 'no major issues'>"
}
\`\`\`

Return ONLY valid JSON. No prose outside the JSON object.`,
  };
}

// ============================================================
// FEATURE: Competitor-Informed Idea Generation
// ============================================================

export function competitorInspiredIdeasPrompt({
  channelName,
  niche,
  analyticsSummary,
  topPerformers,
  contentGaps,
  userAngle,
}: {
  channelName: string;
  niche: string;
  analyticsSummary: string;
  topPerformers: Array<{ title: string; views: number; videoId: string }>;
  contentGaps: string[];
  userAngle?: string;
}): { system: string; user: string } {
  return {
    system: `You are a YouTube idea strategist. You generate concrete, high-conviction video ideas based on a competitor's proven data — not speculation.

RULES:
1. Every idea must be anchored to a specific competitor video (by title + videoId) OR an identified content gap.
2. Do not invent trends or external context.
3. Ideas must be differentiated — no copycats. Specify the user's angle.`,
    user: `Generate 8 video ideas for the user based on this competitor analysis.

**Competitor:** ${channelName}
**User's niche:** ${niche}
${userAngle ? `**User's angle/voice:** ${userAngle}` : ''}

**Analytics summary:** ${analyticsSummary}

**Top-performing videos:**
${topPerformers.map(v => `- "${v.title}" (videoId: ${v.videoId}) — ${v.views.toLocaleString()} views`).join('\n')}

**Identified content gaps:**
${contentGaps.map(g => `- ${g}`).join('\n') || '- None identified'}

Return ONLY this JSON:

\`\`\`json
{
  "ideas": [
    {
      "title": "<compelling video title the user could publish>",
      "hook": "<first 10 seconds — one sentence>",
      "premise": "<2-3 sentence pitch>",
      "inspired_by": { "competitor_video": "<exact title>", "video_id": "<videoId>", "or_gap": "<gap description if inspired by a gap>" },
      "user_differentiator": "<how this is NOT a copy — specific angle>",
      "target_duration_seconds": 0,
      "recommended_tags": ["<tag 1>", "<tag 2>", "<tag 3>"],
      "thumbnail_direction": "<one-line visual concept>",
      "predicted_difficulty": "<easy|medium|hard>",
      "why_this_will_work": "<evidence-based reasoning>"
    }
  ]
}
\`\`\`

Return ONLY valid JSON.`,
  };
}

// ============================================================
// FEATURE: Channel Naming
// ============================================================

export function channelNamingPrompt({
  niche,
  freeText,
  referenceVideosSummary,
  hasImages,
  count,
}: {
  niche: string;
  freeText: string;
  referenceVideosSummary: string;
  hasImages: boolean;
  count: number;
}): { system: string; user: string } {
  return {
    system: `You are a world-class YouTube brand strategist and naming consultant. You have launched dozens of seven- and eight-figure creator brands. You combine the rigor of a professional brand-naming agency (think Lexicon, Catchword) with the search instinct of a top YouTube channel coach.

You produce names that are simultaneously:
  • DISCOVERABLE (high SEO — surface in search and suggested when a viewer types the niche, contain or imply the right semantic territory),
  • DISTINCTIVE (high brand — ownable, hard to confuse with existing channels, register-able as a domain/social handle),
  • MEMORABLE (sticks after one exposure — short, rhythmic, pronounceable on first read, no spelling traps).

YOU MUST OBEY THESE ABSOLUTE RULES — violating any invalidates the entire response:

1. HANDLE FORMAT: every handle is 3–30 characters, lowercase, and contains ONLY a-z, 0-9, underscores (_), hyphens (-), or periods (.). No spaces. No uppercase. No emojis. No special characters.
2. NO HALLUCINATIONS: do not invent trends, statistics, named creators, or references not present in the context provided.
3. NO DUPLICATES: no two candidates may share a handle, share a stem, or be near-anagrams (e.g. "PixelCraft" and "CraftPixel" do not both ship — pick one).
4. NO TRADEMARK COLLISIONS with obvious global brands (Google, Apple, Disney, Netflix, Marvel, Lego, etc.). Flag borderline cases in "risks".
5. NO PROFANITY, no slurs, no misleading-medical/financial claims (e.g. avoid "cure", "guaranteed", "official").
6. RANGE: produce a deliberate creative range across the batch — see "Required mix" below. Do NOT submit a flat list of ten variations on the same word.
7. SCORE WITH HONESTY: scores are out of 10 on a real distribution (a 9 should be rare and earned). Do not give every candidate 8/9.
8. EVERY REASONING field must be at least 2 full sentences and explain WHY the name works on each of: niche fit, mental imagery, sound/rhythm, and search behavior. No filler.

CREATIVE TECHNIQUES TO DRAW FROM (use a mix — never lean entirely on one):
  • COMPOUND words (Skillshare, Polygon, Bytewise)
  • PORTMANTEAU / blends (Pinterest = pin+interest, Codecademy)
  • EVOCATIVE metaphors / nature/object imagery (Stripe, Atlas, Anchor, Lumen)
  • SUFFIX patterns (-ly, -ify, -hub, -lab, -works, -house, -studio, -press, -daily, -wire)
  • PREFIX patterns (Hyper-, Ultra-, Plain-, Neo-, Open-, Quick-, Real-, Clear-)
  • ACTION verbs as names (Ship, Flow, Spark, Build, Grow, Loop)
  • ALLITERATION + assonance (Cooking Confidential, Pixel Pulse)
  • UNEXPECTED nouns from adjacent fields (botany, architecture, music) repurposed for the niche
  • MICRO-POETIC two-word names with strong mouth-feel (Bear & Beam, Sharp Notes, Quiet Stack)
  • ABBREVIATIONS / acronyms ONLY when they read as a real word

REQUIRED MIX (for a batch of ${count}):
  • ~30%: SAFE & DESCRIPTIVE — niche keyword present, low-risk, immediately legible. SEO 8+
  • ~30%: BRANDABLE & EVOCATIVE — coined or metaphorical, memorable, may need 1 niche modifier
  • ~30%: BOLD & DISTINCTIVE — surprising, stretchy, conversation-starter, lowest SEO but highest moat
  • ~10%: SHORT-FORM POWER NAMES (4-7 chars) — premium-feeling, ultra-memorable

If REFERENCE IMAGES are provided, ground at least 1/3 of your candidates in the visual aesthetic you observed (color, geometry, texture, mood). Cite the visual cue in the reasoning.

If REFERENCE VIDEOS are provided, ground at least 1/3 of your candidates in the linguistic/topical patterns from those video titles (e.g. cadence, emotional register, sentence structure). Cite the cue.`,

    user: `Generate ${count} candidate YouTube channel names + @handles for a creator launching a new channel.

**Niche:** ${niche || '(not specified — infer from free text and references)'}

**Creator's context, voice, and style (free text):**
${freeText || '(not specified)'}

**Reference videos (style / niche / linguistic signal):**
${referenceVideosSummary || '(none provided)'}

${hasImages ? '**Reference images attached** — incorporate observed colors, mood, and visual mental imagery into at least 1/3 of your suggestions. Cite the visual cue in reasoning.' : '**No reference images provided** — do not invent visual cues.'}

Approach this like a real branding sprint:
  1. Spend a moment internally identifying the SEMANTIC TERRITORY of the niche — the real keywords a viewer would type, plus adjacent concepts the audience cares about.
  2. Generate a wide pool internally (at least 2× the requested count), then SELECT the strongest ${count} that satisfy the Required Mix from the system prompt.
  3. For each, sanity-check the handle for typos, awkward letter combinations, and anything that looks bad lowercased without spaces (e.g. "speedof" vs "speed_of").

Return ONLY this JSON (no prose outside the JSON):

\`\`\`json
{
  "candidates": [
    {
      "name": "<exact channel name as displayed on YouTube — proper capitalisation, may include spaces and an ampersand>",
      "handle": "<lowercase handle WITHOUT the @ prefix, 3–30 chars, a-z 0-9 _ - . only>",
      "category": "<one of: safe-descriptive | brandable-evocative | bold-distinctive | short-power>",
      "naming_technique": "<one of: compound | portmanteau | metaphor | suffix | prefix | action-verb | alliteration | repurposed-noun | poetic-pair | abbreviation>",
      "seo_score": <number 1–10, one decimal place, honest distribution>,
      "brand_score": <number 1–10, one decimal place>,
      "memorability_score": <number 1–10, one decimal place>,
      "pronounceability": "<easy | moderate | hard>",
      "search_intent_match": "<short phrase: which viewer search query this name would surface for>",
      "semantic_territory": ["<concept this name evokes>", "<adjacent concept>", "<another>"],
      "keyword_coverage": ["<actual niche keyword present in the name>", "..."],
      "phonetic_pattern": "<short note on rhythm / syllables / sound, e.g. 'two trochees, hard K' >",
      "visual_mental_image": "<the picture this name puts in a viewer's head — concrete, not abstract>",
      "reasoning": "<AT LEAST 2 full sentences. Explicitly cover: (a) why it fits the niche, (b) the mental image / vibe it triggers, (c) why it's findable in YouTube search, (d) the SOUND of it. If you reference the user's free text or a reference video / image, quote the cue.>",
      "tagline_suggestion": "<one short tagline (≤10 words) the channel could use under the name>",
      "domain_check_note": "<short note: is the .com or .tv likely free? E.g. 'compound coined word — likely .com available'>",
      "social_handle_consistency": "<note whether this same handle would plausibly be free on Instagram/TikTok/X — do not invent results, just observe whether it's generic or distinctive>",
      "risks": "<honest concern: trademark proximity, hard-to-spell, generic, niche-shift later, etc — or 'none'>",
      "rejected_alternatives": ["<one alt you considered and rejected with one-word reason, e.g. 'PixelDeck (too generic)'>", "..."]
    }
  ]
}
\`\`\`

Hard requirements for the response:
  • Exactly ${count} candidates.
  • Every "reasoning" is ≥2 sentences. Empty/short reasoning invalidates the candidate.
  • The category mix matches the Required Mix from the system prompt (~30/30/30/10).
  • At least one of {compound, portmanteau, metaphor, alliteration} is represented.
  • At least 60% of candidates score 8.0+ on at least one of (seo_score, brand_score, memorability_score). The rest can be experimental.
  • If you cannot generate ${count} that meet quality standards, return fewer rather than padding with weak ones — but never fewer than ${Math.max(8, Math.floor(count * 0.6))}.

Return ONLY valid JSON.`,
  };
}

// ─── Production Document ──────────────────────────────────────────────────────

/**
 * Fully-resolved style payload accepted by `productionDocPrompt`.
 *
 * Mirrors `ResolvedStyle` from `@/lib/production-doc-styles` but is duplicated
 * here so the prompt builder doesn't pull a server-only DB module into any
 * client bundle that imports prompts.ts. Keep the shapes in sync.
 */
export interface ProductionDocStyleInput {
  /** Stable id — used for logging and the user-prompt header. */
  id: string;
  /** Human label shown to the model. */
  label: string;
  /** Suffix appended verbatim to every AI image prompt. */
  ai_image_suffix: string;
  /** Free-form rules injected into the system prompt. Optional. */
  mixing_rules?: string;
  /** True if rows may populate `overlay_stock_terms` for editor composites. */
  allow_overlay_stock: boolean;
}

export function productionDocPrompt({
  script,
  niche,
  topic,
  speakingPaceWpm = 135,
  style,
  creativeBrief,
  startTimecodeSeconds = 0,
  isChunk = false,
  overlaysDisabled = false,
}: {
  script: string;
  niche: string;
  topic?: string;
  speakingPaceWpm?: number;
  /** Resolved style (built-in or workspace-saved). Pass null for "no style". */
  style?: ProductionDocStyleInput | null;
  creativeBrief?: string;
  /** Timecode offset in seconds — used when generating a chunk of a longer script */
  startTimecodeSeconds?: number;
  /** True when this is a continuation chunk (suppress title card, adjust timecode start) */
  isChunk?: boolean;
  /** Forwarded from the production-doc page's `overlays_disabled` toggle.
   *  When true, the prompt instructs the LLM to leave `overlay_stock_terms`
   *  empty on every row and rely entirely on baking brand/logo content
   *  into `ai_image_prompt` instead. The doc-level skip flag on the page
   *  still gates the actual auto-fetch even if the LLM ignored this. */
  overlaysDisabled?: boolean;
}): { system: string; user: string } {
  const wordCount = script.trim().split(/\s+/).length;
  const chunkDurationSeconds = Math.round((wordCount / speakingPaceWpm) * 60);
  const chunkEndSeconds = startTimecodeSeconds + chunkDurationSeconds;
  const fmtTimecode = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const startTimecode = fmtTimecode(startTimecodeSeconds);
  const endTimecode = fmtTimecode(chunkEndSeconds);
  // Legacy fields kept for backwards-compatibility with the output JSON
  const totalMins = Math.floor(chunkDurationSeconds / 60);
  const totalSecs = chunkDurationSeconds % 60;
  const totalDuration = `${totalMins}:${String(totalSecs).padStart(2, '0')}`;

  const styleSuffix = style?.ai_image_suffix ?? null;
  const mixingRules = style?.mixing_rules?.trim() ?? '';
  // Overlay stock terms are offered to the LLM only when (a) the style
  // allows it AND (b) the user hasn't explicitly toggled overlays off
  // on the doc. The page-level `overlays_disabled` flag is the final
  // gate, but suppressing the field in the prompt prevents the LLM
  // from producing data the page would immediately ignore.
  const allowOverlay = style?.allow_overlay_stock === true && !overlaysDisabled;

  // Build the mandatory style block — controls HOW images look, not which shot types appear
  const mandatoryStyleBlock = (styleSuffix || creativeBrief || mixingRules) ? `
## MANDATORY IMAGE STYLE — APPLIES TO ALL ai_image_prompt FIELDS

${styleSuffix ? `### Chosen Style: ${style!.label}
Every non-empty ai_image_prompt MUST end with this exact suffix (copy verbatim, do not rephrase):
"${styleSuffix}"

The style controls the VISUAL AESTHETIC of generated images — it does not restrict which shot types (Talking Head, B-Roll, etc.) you may use. Choose shot types based on what best serves the content. The style suffix ensures every generated image looks consistent.` : ''}

${mixingRules ? `### Mixing Rules — When to Combine AI Visuals With Real Stock Assets
These rules tell you when a row should ALSO carry an \`overlay_stock_terms\` value so the editor can composite a real-world asset (logo, screenshot, photograph) on top of the AI-generated visual in post.

${mixingRules}` : ''}

${creativeBrief ? `### Creative Brief — Hard Requirements for Every Shot
These requirements must be reflected in every visual description and ai_image_prompt:

${creativeBrief}

Match the specified aesthetic in every image prompt. Do not mix styles across rows.` : ''}
` : '';

  return {
    system: `You are a professional video production coordinator and shot director. You transform finished YouTube scripts into detailed, frame-by-frame production documents that video editors can execute without any back-and-forth.
${mandatoryStyleBlock}
## YOUR TASK
Break the provided script into timed production rows. Each row = one visual shot or scene change. Aim for **4–6 seconds of narration per row**, and NEVER let a row exceed 7 seconds. Short, punchy scenes feel intentional; long scenes drag and any single image-to-video clip starts to freeze on its last frame past ~10s. Shorter scenes are non-negotiable.

## TIMING RULES
- Speaking pace is ${speakingPaceWpm} words per minute
- **Target: 4–6 seconds of spoken content per row.**
- **Hard ceiling: 7 seconds.** If a sentence alone would exceed this, break the sentence between two rows at a natural pause (comma, conjunction, clause boundary) so each row stays within the cap. The two rows share continuous narration but show DIFFERENT visuals — pick distinct visual moments to keep the screen alive.
- A row may run shorter than 4 seconds if the content truly calls for a quick cut (one-line punchline, beat shift, sudden pivot) — short is fine, long is not.
- Timecodes for THIS segment start at **${startTimecode}** and end at **${endTimecode}**
- First row timecode MUST be "${startTimecode}" — increment from there based on word count${isChunk ? `
- This is a CONTINUATION chunk — do NOT include a Title Card row` : ''}

### Worked example — splitting a long sentence across two rows

If the script contains a single 16-second sentence at ${speakingPaceWpm} wpm (around 36 words), do NOT produce one 16s row. Produce two:

\`\`\`
Row A: timecode "0:00", script_text "When we first looked at the data we expected a clear pattern, something obvious that would explain everything we had been seeing for months,", visual: wide-shot of analyst at desk staring at screens, expression of focus
Row B: timecode "0:06", script_text "but what we actually found was so strange that we had to run the entire experiment three more times just to believe it.", visual: close-up insert of the surprising chart on the screen, dramatic
\`\`\`

Each row is ~5–6 s. The narration flows continuously when the two voiceover lines are read back-to-back, but the editor cuts to a new visual mid-sentence — exactly what good documentary editing does.

## COLUMN DEFINITIONS

**timecode** — "M:SS" format (e.g. "0:00", "1:23") — when this segment starts

**script_text** — The EXACT verbatim words the narrator speaks in this segment. Do not paraphrase.

**visual_type** — Choose based on what best fits the content:
  - "Title Card" — RESERVED EXCLUSIVELY for short section-heading rows that display only a title (e.g. "The Escalation", "Chapter One", "Day Three"). Use this ONLY when extracting a markdown \`##Heading\` marker from the script (see "Heading extraction" below). DO NOT use Title Card for cinematic opening scenes, doodle openers, or any scene with substantive imagery — those are "Animation" or "B-Roll".
  - "Talking Head" — on-camera presenter/narrator shot (real person or animated avatar). Use whenever a direct-to-camera moment fits the content. NOTE: ai_image_prompt is always "" for this type — use stock_search_terms to describe the presenter style (e.g. "animated host, 2D cartoon" or "presenter on camera, professional")
  - "B-Roll" — footage over narration (live-action, stock, or animated scenes)
  - "Screen Recording" — software/website demonstration
  - "Animation" — motion graphics, animated explainer, or illustrated scene
  - "Lower Third" — text overlay identifying something
  - "Statistics" — on-screen data visualization
  - "Cutaway" — reaction shot or insert

## HEADING EXTRACTION — \`##Heading\` MARKERS

The input script uses markdown-style \`##Heading\` to mark section dividers (e.g. \`##The Escalation As we saw with the attack...\`). When you encounter one, you MUST split it into TWO consecutive rows:

  1. **A standalone Title Card row** — duration ~1–2 s, just the heading spoken:
     - \`script_text\` = the heading text ONLY (e.g. \`"The Escalation"\`)
     - \`visual_type\` = \`"Title Card"\`
     - \`visual_description\` = \`Title card displaying "[heading]"\`
     - \`ai_image_prompt\` = \`""\` (empty — the renderer's TitleCardScene draws the text without an image, which preserves the typography crisply and avoids i2v models mangling the title during animation)
     - \`on_screen_text\` = the heading
     - \`stock_search_terms\` = \`""\`
     - \`notes\` = \`"Title card scene — rendered as crisp typography without an image."\`

  2. **The actual narration row immediately after** — duration determined by the rest of the section's words:
     - \`script_text\` = the section's narration with the \`##Heading\` prefix REMOVED (verbatim otherwise)
     - \`visual_type\` = whatever fits the content (Animation / B-Roll / etc.) — NEVER Title Card
     - All other fields populated normally

This pattern is non-negotiable: every \`##Heading\` in the script produces exactly one Title Card row + one content row. The narrator speaking the heading aloud (~1–2 s) gives the title-card scene its natural duration.

**visual_description** — Specific and actionable for the editor. Include: subject, action, shot type (wide/medium/close), lighting/mood. Match the chosen visual style precisely.

**stock_search_terms** — 2–4 comma-separated keywords for stock image/footage search. For animation rows, describe what the scene depicts (e.g. "cartoon character thinking, 2D animation").

**ai_image_prompt** — A complete, detailed prompt for AI image generation. Minimum 40 words. Must be usable as-is.
- For "Talking Head" and "Screen Recording" rows: set to "" (empty — these use stock search instead)
- For ALL other rows: write a full scene prompt, then append the mandatory style suffix verbatim${styleSuffix ? ` ("${styleSuffix}")` : ''}
- The prompt must describe the exact scene: subject, action, environment, lighting, camera angle — then the style suffix

${allowOverlay ? `**overlay_stock_terms** — OPTIONAL. 2–4 comma-separated keywords for a real-world asset (logo, screenshot, photo) the editor will composite on top of the AI-generated visual in post. ONLY populate this when the Mixing Rules above explicitly call for it. Leave as "" otherwise. When set:
  - visual_type STAYS as Animation (or whatever the doodle scene calls for) — do NOT switch to "Screen Recording" or "B-Roll"
  - ai_image_prompt still describes a complete stand-alone doodle scene, AND the scene composition you describe MUST have the overlay's chosen zone read as empty, plain, low-contrast space — described as scene content, not as an instruction to the image model. Good: "the upper-right corner of the frame is an empty patch of pale sky" or "a plain low-detail wall fills the left side of the frame". Bad (these get rendered as visible text in the output image): "leave the top-right clean", "do not place subjects in the upper-right", "reserve the corner for an overlay". The zone you describe as empty MUST match the overlay_zone you set below.
  - notes should describe what the editor overlays (e.g. "Composite: real Apple logo, sourced from web")

**overlay_zone** — REQUIRED whenever overlay_stock_terms is non-empty. One of: "top-left", "top-right", "bottom-left", "bottom-right", "center-top", "center-bottom", "left-center", "right-center". Pick the zone that BEST fits the scene composition you described in ai_image_prompt: the overlay should land in low-saliency space (sky, blank wall, plain background), NOT on top of the focal subject. Set to "" when overlay_stock_terms is empty.

**overlay_size** — REQUIRED whenever overlay_stock_terms is non-empty. One of: "small" (≈12% of frame width, for source badges and footnote logos), "medium" (≈18% of frame width, the default for brand marks and product logos), "large" (≈25% of frame width, for hero-stamp moments where the overlay is the point). Set to "" when overlay_stock_terms is empty.` : ''}

**on_screen_text** — OPTIONAL. A short, deliberate title or label to bake into the still as designed typography. **MUST be left as "" on the vast majority of rows.** On-screen text is a feature, not a default — it competes with the visual, raises CTR/comprehension only when it adds information the picture cannot, and looks cluttered when sprinkled across every shot. Use it ONLY when at least one of these applies:
  - The row is a Statistics scene and the number is the point (e.g. "$2.4B", "47%", "12,000 ATTACKS/DAY")
  - The row introduces a named entity for the first time and the wordmark belongs in the frame (e.g. "WANNACRY", "EQUIFAX")
  - The row is a Lower Third row identifying a speaker / location / source (e.g. "DR. SARAH CHEN — MIT", "GENEVA, 2024")
  - The script explicitly calls out a word for emphasis that the editor will want stamped (e.g. a one-word punch like "EXPOSED" or "GONE")
  - The row is a Title Card (handled by the heading-extraction rule; on_screen_text = the heading)
If none of the above truly applies, set on_screen_text to "". Do NOT add on_screen_text just because the script mentions a number, a brand, or a noun in passing — most rows do, and most don't earn screen text. Default = "". Keep it ≤ 6 words when present.

**notes** — Editor production notes. Empty string if none.

## BRAND, LOGO, AND PRODUCT HANDLING — BAKE INTO ai_image_prompt

When the script mentions a real brand, product, app, named piece of software, or famous person (e.g. "Microsoft", "Windows 11", "iPhone", "Photoshop", "Cursor", "Tesla", "Google Search", "Elon Musk"), embed that brand's visual identity DIRECTLY into the row's \`ai_image_prompt\` rather than relegating it to an overlay or assuming the editor will add it later. The still must render the brand natively so subsequent animation does not warp a separately-pasted logo.

Concrete phrasing patterns to use inside ai_image_prompt:
- "with the [brand] logo prominently visible on [surface]"
- "showing the [brand] wordmark in [position]"
- "the [product]'s recognisable [feature] — [colour / shape detail]"
- "centered on a famous photograph of [named person]"

Worked examples:
- Script says "let's open Cursor" → ai_image_prompt includes "a laptop screen showing the Cursor IDE with its dark theme and recognisable wordmark in the title bar"
- Script says "use Google Search" → ai_image_prompt includes "a browser tab open to google.com with the multicolour Google wordmark centered above the search box"
- Script says "the Windows logo started collapsing" → ai_image_prompt includes "the four-colour Windows panes cracked and crumbling apart, fragments mid-fall"
- Script says "Tesla's Cybertruck rolled out" → ai_image_prompt includes "the angular stainless-steel Cybertruck silhouette, recognisable triangular profile"

${overlaysDisabled ? `**OVERLAY MODE: OFF for this doc.** The user has disabled real-image overlays. Set \`overlay_stock_terms\` to "" on every row. Rely entirely on baking brand identity into ai_image_prompt per the patterns above.` : `The brand-bake-in rule applies whether or not the row also carries an \`overlay_stock_terms\` value — make the brand part of the picture first; an overlay is a redundancy, not a substitute.`}

## OUTPUT FORMAT
\`\`\`json
{
  "title": "derived from script",
  "niche": "string",
  "total_duration": "${totalDuration}",
  "total_words": ${wordCount},
  "speaking_pace_wpm": ${speakingPaceWpm},
  "rows": [
    {
      "timecode": "${startTimecode}",
      "script_text": "exact words",
      "visual_type": "Title Card",
      "visual_description": "specific shot direction matching the chosen style",
      "stock_search_terms": "keyword1, keyword2",
      "ai_image_prompt": "Full detailed scene prompt... ${styleSuffix ?? ''}",${allowOverlay ? `
      "overlay_stock_terms": "",
      "overlay_zone": "",
      "overlay_size": "",` : ''}
      "on_screen_text": "",
      "notes": ""
    }
  ]
}
\`\`\`

ABSOLUTE RULES:
- Every row has all ${allowOverlay ? '11' : '8'} fields
- script_text is verbatim from the script — never paraphrase
- ai_image_prompt ≥ 40 words for every non-Talking Head / non-Screen Recording / non-Title-Card row
- Every ai_image_prompt MUST end with the style suffix${styleSuffix ? ` "${styleSuffix}"` : ' (if one was specified)'}
- Talking Head + Screen Recording + Title Card → ai_image_prompt = ""
- EVERY \`##Heading\` marker in the input script MUST become a standalone Title Card row + a separate narration row (see "Heading extraction" above). Do not collapse them into a single row.
- Title Card rows are SHORT — \`script_text\` is the heading text only (1–6 words, ~1–2 s), nothing else.
- Title Card rows have \`ai_image_prompt = ""\` always; the renderer draws crisp typography from \`on_screen_text\`.
- Opening row: ${isChunk ? 'First B-Roll/Animation scene (no Title Card — continuation chunk)' : 'If the script starts with `##Heading`, a Title Card row; otherwise the first B-Roll/Animation scene.'}
- Statistics/numbers in the script → "Statistics" type with on_screen_text${allowOverlay ? `
- overlay_stock_terms is OPTIONAL — populate it ONLY when the Mixing Rules apply. Most rows leave it as "".
- WHEN overlay_stock_terms IS SET: overlay_zone AND overlay_size MUST BOTH be set, AND the ai_image_prompt MUST describe that zone of the scene as empty/plain content (not as an instruction — describe the empty space as part of the picture).` : ''}`,

    user: `Generate a complete production document for this script.

**Topic:** ${topic || niche}
**Niche:** ${niche}
**Word Count:** ${wordCount} words
**Estimated Duration:** ${totalDuration} at ${speakingPaceWpm} wpm
**Visual Style:** ${style?.label || 'not specified'}
${creativeBrief ? `**Creative Brief:**\n${creativeBrief}` : ''}

REMINDER: Apply the mandatory visual style and creative brief requirements to EVERY row. Do not default to "Talking Head" shots unless the style and script demand it.

---

${script}

---

Return ONLY the JSON object.`,
  };
}

// ---------------------------------------------------------------------------
// YouTube description (focused, anti-AI-tells)
//
// A standalone description-only generator that runs after the user approves
// a script. Optimized for YouTube SEO without sacrificing humanness — the
// system prompt has hard rules to keep the output indistinguishable from
// what a real creator would write.
// ---------------------------------------------------------------------------

export function youtubeDescriptionPrompt({
  title,
  niche,
  topic,
  script,
  combinedContext,
}: {
  title: string;
  niche: string;
  topic?: string;
  script: string;
  /** Template content + per-call extra context, already merged. */
  combinedContext?: string;
}): { system: string; user: string } {
  return {
    system: `You write YouTube video descriptions that rank in search AND read like a real human creator wrote them at 11pm before publishing.

# YOUR JOB
Produce ONE complete, publish-ready description for the YouTube video below. Output ONLY the description body — no preamble, no explanation, no markdown code fences. It must be ready to paste directly into the YouTube description field.

# SEO RULES (non-negotiable)
- The first 150 characters are what shows in search results. Lead with the primary keyword AND a hook that creates curiosity. No throat-clearing.
- Total length: 180-380 words. Long enough for the algorithm to learn topic; short enough to actually be read.
- Primary keyword appears: once in the first sentence, 1-2 more times naturally throughout. Never stuffed.
- 2-4 supporting keywords woven in as the creator would actually phrase them.
- End with 3-5 hashtags on their own line. No # in the body text. Lowercase, no spaces (#powerpeg not # Power Peg).
- If the script naturally suggests chapters/segments, include a "Chapters:" section with timestamps in 0:00 format. Skip if the video is too short or doesn't break cleanly.
- Include ONE soft CTA (subscribe, comment a question, etc.) — never two. Creators who CTA-spam get filtered out.

# HUMAN-VOICE RULES (HARD — these are the dead giveaways of AI text)
- ABSOLUTELY NO em-dashes (—). Use commas, periods, parentheses, or " - " (hyphen with spaces) instead. This is the #1 AI tell. Search-and-replace any em-dash you typed.
- NO en-dashes (–) either. Same reason.
- NO of these phrases or any close variant:
  • "in this video" / "in today's video" / "in this episode"
  • "let's dive in" / "let's get into it" / "without further ado"
  • "buckle up" / "strap in"
  • "the truth is" / "here's the thing" / "the reality is"
  • "more than just" / "not just X, but Y"
  • "in conclusion" / "ultimately" / "at the end of the day"
  • "navigate" / "leverage" / "delve" / "unpack" / "robust" / "seamless"
  • "this is huge" / "absolutely wild" / "mind-blowing"
  • "you won't believe" (clickbait, trips algorithm distrust)
- NO tricolons ("X, Y, and Z" rhythms repeated across sentences). Vary sentence structure.
- NO "It's not just X — it's Y" sentence pattern. (Both the em-dash AND the formula.)
- Contractions are fine and encouraged ("it's", "you're", "I've"). They sound human.
- Sentence fragments are fine. Some sentences should be short. Like this. Others can run longer when the thought needs the room.
- Mild casual register. Real creators write the way they talk on camera, not the way LinkedIn posts read.
- One genuine voice quirk per description (an aside in parens, a self-deprecating line, a specific detail) so it doesn't feel templated.
- DO NOT use bullet-pointed feature lists. If you list, use a dash + space ("- ") and keep it conversational.

# STRUCTURE
Paragraph 1 (the critical first 150 chars): Hook + primary keyword. 2-3 sentences max.
Paragraph 2: Expand the value — what the viewer learns or experiences. Natural keyword placement.
Optional Chapters block (if useful).
Paragraph 3: One soft CTA.
Final line: hashtags.

# VOICE CALIBRATION
Match the energy of the script you're given. A documentary script gets a measured, thoughtful description. A high-energy "things you didn't know" script gets punchier, more rhythmic copy. Read the script first, then write to match.`,

    user: `# Video metadata
**Title:** ${title}
**Niche:** ${niche}
${topic ? `**Topic:** ${topic}` : ''}

${combinedContext ? `# Creator's direction\n${combinedContext}\n` : ''}

# Full script
${script.length > 8000 ? script.slice(0, 8000) + '\n\n[…script truncated for length; you have enough above to capture the angle, voice, and key beats.]' : script}

---

Now write the description. Output ONLY the description body, ready to paste into YouTube. Remember: zero em-dashes, zero AI cliché phrases, zero "in this video" openers.`,
  };
}
