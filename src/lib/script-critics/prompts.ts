/**
 * Prompts for the script-critic panel and the Chair.
 *
 * Each critic owns a SLICE of the original monolithic scriptQA rubric —
 * this is what prevents the "one harsh prompt grades everything" problem
 * that was producing universally low scores.
 *
 *   Hook Coach          → hook_strength, retention_potential, cta_effectiveness
 *   Substance Auditor   → content_quality, logic_coherence, audience_targeting,
 *                         seo_optimization, human_authenticity
 *   Flow Critic         → pacing_flow, natural_speech
 *
 * Categories are disjoint by design so the Chair's merge step is
 * deterministic: each category has one owner.
 */

import type { ScriptCriticContext, ScriptCriticId, ScriptCategoryKey, ScriptCriticReport, ScriptDeliberationNote, ScriptCharter, ScriptCharterContribution } from './types';

// ─── Charter prompts ───────────────────────────────────────────────────────

export function buildCharterContributionPrompt(spec: SpecSpec, ctx: ScriptCriticContext): { system: string; user: string } {
  const system = [
    `You are a ${spec.persona}. Before the panel scores this script, you are contributing to a CHARTER — the shared agreement on what matters most for THIS script (not in general).`,
    '',
    `MISSION: ${spec.mission}`,
    '',
    'Declare your charter position. Keep each field short and specific to this script\'s niche and topic.',
    '',
    'Output ONLY JSON of shape:',
    `{
  "redLines": [string],           // max 3 — hard fails in YOUR domain
  "priorityRules": [string],      // max 3 — tradeoffs for THIS script
  "nonGoals": [string],           // max 3 — things you\'re willing to deprioritize for this
  "anchor90": string,             // what 90/100 looks like on this script through your lens
  "anchor75": string,             // what "not passing" looks like
  "summary": string               // one paragraph
}`,
    '',
    'Output nothing except the JSON object.',
  ].join('\n');

  const user = [
    `NICHE: ${ctx.niche}`,
    'SCRIPT PREVIEW (first 800 chars):',
    '```',
    ctx.script.slice(0, 800),
    '```',
    '',
    'Given this script\'s topic and niche, declare your charter. Output JSON only.',
  ].join('\n');

  return { system, user };
}

export function buildCharterSynthesisPrompt(contributions: ScriptCharterContribution[], ctx: ScriptCriticContext): { system: string; user: string } {
  const system = [
    `You are the CHAIR of a 3-critic script-review panel (Hook Coach, Substance Auditor, Flow Critic). Niche: ${ctx.niche}.`,
    '',
    'Your job: synthesize the three critics\' charter contributions into a shared agreement everyone will grade against. Dedupe red lines, resolve priority conflicts, write a 2-sentence mission, and produce calibrated score anchors for THIS script.',
    '',
    'Output ONLY JSON of shape:',
    `{
  "mission": string,                // 2 sentences
  "redLines": [string],             // 3–5 deduped + ranked
  "perCritic": {
    "hook-coach":        { "priorityRule": string, "nonGoals": [string], "anchor90": string, "anchor75": string },
    "substance-auditor": { "priorityRule": string, "nonGoals": [string], "anchor90": string, "anchor75": string },
    "flow-critic":       { "priorityRule": string, "nonGoals": [string], "anchor90": string, "anchor75": string }
  },
  "scoringAnchors": {
    "ninetyFive": string,           // what 95/100 looks like
    "eightyFive": string,           // what 85 looks like (pass-threshold)
    "seventy":    string            // what "not passing" looks like
  },
  "chairSummary": string
}`,
    '',
    'Output nothing except the JSON object.',
  ].join('\n');

  const user = [
    'PANEL CONTRIBUTIONS:',
    ...contributions.map(c => [
      `── ${c.critic.toUpperCase()} ──`,
      `  summary: ${c.summary}`,
      c.redLines.length > 0 ? `  red lines: ${c.redLines.map(r => `"${r}"`).join(' · ')}` : '',
      c.priorityRules.length > 0 ? `  priorities: ${c.priorityRules.map(r => `"${r}"`).join(' · ')}` : '',
      c.nonGoals.length > 0 ? `  non-goals: ${c.nonGoals.map(r => `"${r}"`).join(' · ')}` : '',
      `  anchor90: ${c.anchor90}`,
      `  anchor75: ${c.anchor75}`,
      '',
    ].join('\n')),
    'Synthesize the charter. Output JSON only.',
  ].join('\n');

  return { system, user };
}

export function formatCharterForScriptPrompt(charter: ScriptCharter, criticId?: ScriptCriticId): string {
  const lines: string[] = [];
  lines.push('── PANEL CHARTER (the panel agreed on this BEFORE scoring — grade against it) ──');
  lines.push(`MISSION: ${charter.mission}`);
  if (charter.redLines.length > 0) {
    lines.push('RED LINES:');
    charter.redLines.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
  }
  lines.push('SCORING ANCHORS FOR THIS SCRIPT:');
  lines.push(`  95 = ${charter.scoringAnchors.ninetyFive}`);
  lines.push(`  85 = ${charter.scoringAnchors.eightyFive}`);
  lines.push(`  <85 = ${charter.scoringAnchors.seventy}`);
  if (criticId && charter.perCritic[criticId]) {
    const per = charter.perCritic[criticId]!;
    lines.push(`YOUR CHARTER ENTRY: ${per.priorityRule}`);
    if (per.nonGoals.length > 0) lines.push(`  non-goals: ${per.nonGoals.join(' · ')}`);
    lines.push(`  anchor 90: ${per.anchor90}`);
    lines.push(`  anchor 75: ${per.anchor75}`);
  }
  lines.push('───────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

export const CATEGORY_OWNER: Record<ScriptCategoryKey, ScriptCriticId> = {
  hook_strength: 'hook-coach',
  retention_potential: 'hook-coach',
  cta_effectiveness: 'hook-coach',
  content_quality: 'substance-auditor',
  logic_coherence: 'substance-auditor',
  audience_targeting: 'substance-auditor',
  seo_optimization: 'substance-auditor',
  human_authenticity: 'substance-auditor',
  pacing_flow: 'flow-critic',
  natural_speech: 'flow-critic',
};

// Critic specs (persona, mission, owned categories, rubric) are loaded from
// skills/*.md so non-devs can edit them without touching TS. See skills/load.ts
// for the frontmatter format. Body of each .md file is the rubric verbatim —
// preserve any numbering / formatting you write there, it reaches the LLM
// unchanged.
export { HOOK_COACH, SUBSTANCE_AUDITOR, FLOW_CRITIC, SCRIPT_CRITICS } from './skills/load';
import type { SkillSpec } from './skills/load';
type SpecSpec = SkillSpec;

const AGGRESSIVENESS_INSTRUCTIONS = {
  standard: 'Be thorough and constructive. Point out all issues clearly.',
  brutal: 'Be brutally honest. No sugar-coating. Treat this like a top YouTube creator reviewing amateur work. Every weakness must be called out explicitly.',
  nuclear: `You are the HARSHEST critic alive in your domain. Zero tolerance for mediocrity. Tear this apart where it deserves it. If the script would fail in your domain, explain exactly why. But STAY IN YOUR LANE — do not grade categories other critics own.`,
} as const;

// ─── Phase 1: draft prompts ────────────────────────────────────────────────

/** Prompt shape used by all three critic phases. `userCachePrefix` holds
 *  the stable portion of the user message (charter + script) so the
 *  generateText Anthropic branch can place a cache_control breakpoint on
 *  it. `user` is the per-call varying tail (pass number, feedback,
 *  drafts, deliberations, response instructions). Non-Anthropic providers
 *  see the prefix concatenated back in via mergeUserCachePrefix — message
 *  semantics are identical, only the cache breakpoint differs. */
export interface CriticPromptBundle {
  system: string;
  user: string;
  userCachePrefix?: string;
}

export function buildDraftPrompt(spec: SpecSpec, ctx: ScriptCriticContext, charter?: ScriptCharter): CriticPromptBundle {
  const ownedList = spec.owned.map(c => `  • ${c}`).join('\n');
  const aggr = AGGRESSIVENESS_INSTRUCTIONS[ctx.aggressiveness];

  const system = [
    `You are a ${spec.persona}. You specialize in the "${ctx.niche}" niche. ${aggr}`,
    '',
    `MISSION: ${spec.mission}`,
    '',
    'YOU ONLY GRADE THESE CATEGORIES (do NOT score categories outside this list):',
    ownedList,
    '',
    'YOUR RUBRIC:',
    spec.rubric,
    '',
    'SCORING CALIBRATION (0–100 scale, stay in your lane):',
    '  95–100 = exceptional, top 1% of YouTube',
    '  85–94  = strong, ready to publish',
    '  75–84  = solid but has noticeable weaknesses in YOUR domain',
    '  60–74  = mediocre — real problems in YOUR domain',
    '  <60    = weak, needs major rework in YOUR domain',
    '',
    'CRITICAL: Do NOT penalize the script for issues outside your owned categories. If the hook is brilliant but the fact-structure is weak, Hook Coach scores high and flags nothing structural — that\'s the Substance Auditor\'s job.',
    '',
    'Output ONLY JSON of shape:',
    `{
  "overall_score": number,          // 0–100, weighted mean of YOUR owned categories
  "summary": string,                // 2–3 sentences
  "categories": {                   // include ONLY your owned keys
${spec.owned.map(k => `    "${k}": { "score": number, "assessment": string, "issues": [string], "fix": string }`).join(',\n')}
  },
  "critical_issues": [
    { "severity": "minor"|"major"|"critical", "location": string, "issue": string, "fix": string }
  ],
  "strengths": [string]
}`,
    '',
    'Output nothing except the JSON object. No prose. No code fences.',
  ].join('\n');

  const { userCachePrefix, user } = buildDraftUserPrompt(ctx, spec.id, charter);
  return { system, user, userCachePrefix };
}

function buildDraftUserPrompt(
  ctx: ScriptCriticContext,
  criticId?: ScriptCriticId,
  charter?: ScriptCharter,
): { userCachePrefix: string; user: string } {
  // Cacheable prefix: charter + script. Stable across all 3 parallel critics
  // in a pass and across all convergence iterations within a run — first call
  // writes the cache, every subsequent call reads. Per-call variance (pass
  // number, feedback, response instruction) stays in the tail.
  const prefixParts: string[] = [];
  if (charter) {
    prefixParts.push(formatCharterForScriptPrompt(charter, criticId));
    prefixParts.push('');
  }
  prefixParts.push('SCRIPT:');
  prefixParts.push('```');
  prefixParts.push(ctx.script);
  prefixParts.push('```');
  const userCachePrefix = prefixParts.join('\n');

  const tail: string[] = [];
  tail.push('');
  tail.push(`Pass #${ctx.passNumber} review of this YouTube script in the "${ctx.niche}" niche.`);
  if (ctx.previousFeedback) {
    tail.push('');
    tail.push(`PRIOR-PASS FEEDBACK (the script has been revised to address these):`);
    tail.push(ctx.previousFeedback);
    tail.push('');
    tail.push('SCORING RULE for follow-up passes:');
    tail.push('  - If issues were fixed, the relevant category scores MUST increase significantly (+15 to +25).');
    tail.push('  - Only deduct for NEW issues, not re-stating prior ones that were addressed.');
    tail.push('  - Be fair — penalizing a fixed hook is how critics lose trust.');
  }
  tail.push('');
  tail.push('Respond with the JSON object and nothing else.');
  return { userCachePrefix, user: tail.join('\n') };
}

// ─── Phase 2: deliberation prompts ─────────────────────────────────────────

export function buildDeliberationPrompt(
  spec: SpecSpec,
  ctx: ScriptCriticContext,
  ownDraft: ScriptCriticReport,
  peerDrafts: ScriptCriticReport[],
  charter?: ScriptCharter,
): CriticPromptBundle {
  const system = [
    `You are a ${spec.persona}. You drafted a review of a YouTube script. So did your peers.`,
    '',
    'Now you are in DELIBERATION. You see everyone\'s drafts and must take a stance on peers\' issues, then UPDATE your own score and issues.',
    '',
    'FOUR STANCES:',
    '  • CONCUR — you agree with the peer\'s flag.',
    '  • DEFER — peer is the domain authority; withdraw your overlapping flag.',
    '  • COUNTER — peer is wrong in their domain (rare — usually stay in your lane).',
    '  • ESCALATE — peer under-graded severity; this is worse than they said.',
    '',
    'RULES:',
    '  1. STAY IN YOUR LANE. Do not grade categories outside your ownership. If you raised a flag that belongs to another critic\'s domain, DEFER.',
    '  2. HELP THE TEAM. If a peer already captured an issue better than you did, DEFER.',
    '  3. UPDATE HONESTLY. If peers revealed something you missed INSIDE your domain, update DOWN. If peers convinced you your concern was outside your lane or a nit, update UP.',
    '  4. NO NEW WORK — do not invent flags unrelated to the deliberation.',
    '',
    '',
    'YOU ALSO COMMIT TO (used by Chair to build a unanimous rewrite direction and by the oscillation check):',
    '  • myNonNegotiables: up to 4 phrases — rewrites that WOULD DROP your score. Be specific.',
    '  • myWillingToAccept: up to 4 phrases — rewrites you\'d welcome.',
    '  • myPredictedScoreIfBundleApplied: 0–100, the score you COMMIT to on the next pass IF the Chair\'s rewrite respects your non-negotiables. If next-pass actual drops > 7 below this, the rewrite bundle is ROLLED BACK.',
    '',
    'Output ONLY JSON of shape:',
    `{
  "summary": string,
  "updated_score": number,
  "peer_responses": [
    { "targetCritic": "hook-coach"|"substance-auditor"|"flow-critic",
      "targetCategory": string?,
      "stance": "concur"|"defer"|"counter"|"escalate",
      "reasoning": string
    }
  ],
  "updated_categories": {
${spec.owned.map(k => `    "${k}": { "score": number, "assessment": string, "issues": [string], "fix": string }`).join(',\n')}
  },
  "updated_issues": [
    { "severity": "minor"|"major"|"critical", "location": string, "issue": string, "fix": string }
  ],
  "my_non_negotiables": [string],
  "my_willing_to_accept": [string],
  "my_predicted_score_if_bundle_applied": number
}`,
    '',
    'Output nothing except the JSON object.',
  ].join('\n');

  // Stable across critics, iterations, and deliberation phase: charter + script.
  // Per-critic draft + peer drafts vary and stay in the tail.
  const prefixParts: string[] = [];
  if (charter) {
    prefixParts.push(formatCharterForScriptPrompt(charter, spec.id));
    prefixParts.push('');
  }
  prefixParts.push('SCRIPT (verbatim — re-read before deliberating):');
  prefixParts.push('```');
  prefixParts.push(ctx.script);
  prefixParts.push('```');
  const userCachePrefix = prefixParts.join('\n');

  const tail: string[] = [];
  tail.push('');
  tail.push('YOUR DRAFT:');
  tail.push(`  overall_score: ${ownDraft.overall_score}`);
  tail.push(`  summary: ${ownDraft.summary}`);
  tail.push('  critical_issues:');
  for (const ci of ownDraft.critical_issues) {
    tail.push(`    · [${ci.severity}] ${ci.location}: ${ci.issue}`);
  }
  tail.push('');
  tail.push('PEER DRAFTS:');
  for (const peer of peerDrafts) {
    tail.push(`  ── ${peer.critic} · score ${peer.overall_score}`);
    tail.push(`     summary: ${peer.summary}`);
    tail.push('     critical_issues:');
    for (const ci of peer.critical_issues) {
      tail.push(`       · [${ci.severity}] ${ci.location}: ${ci.issue}`);
    }
  }
  tail.push('');
  tail.push('Respond with the JSON object and nothing else.');
  return { system, user: tail.join('\n'), userCachePrefix };
}

// ─── Phase 3: Chair prompt ─────────────────────────────────────────────────

export function buildChairPrompt(
  ctx: ScriptCriticContext,
  drafts: ScriptCriticReport[],
  deliberations: ScriptDeliberationNote[],
  charter?: ScriptCharter,
): CriticPromptBundle {
  const system = [
    `You are the CHAIR of a YouTube-script review panel. Three specialist critics (Hook Coach, Substance Auditor, Flow Critic) have drafted independent reviews, deliberated as a team, and published COMMITMENTS (non-negotiables, willing-to-accept, predicted-score-if-bundle-applied). Niche: "${ctx.niche}".`,
    '',
    'Your job in one synthesis pass:',
    '  (1) MERGE CATEGORIES — each critic owns specific categories; take each critic\'s post-deliberation number for the categories they own.',
    '  (2) COMPUTE OVERALL — weighted mean of all 10 categories.',
    '  (3) DEDUPE CRITICAL ISSUES — if two critics raised the same issue, keep one (owned by the domain authority).',
    '  (4) BUILD A UNANIMOUS REWRITE DIRECTION — your rewrite_suggestions + critical_issues must NOT propose changes that touch any critic\'s non-negotiable. If you can\'t find a set of rewrites that respects all non-negotiables, return FEWER rewrites (or none) and report dissent rather than shipping an oscillating bundle.',
    '  (5) RULE on CONSENSUS PASS — ships when: no critical unresolved issues AND overall ≥ 85 AND bundle_unanimous is true.',
    '  (6) EXPLAIN — one-paragraph synthesis.',
    '',
    'Output ONLY JSON of shape:',
    `{
  "overall_score": number,           // 0–100, your computed weighted mean
  "verdict": string,                 // one powerful sentence
  "will_it_perform": string,         // "yes" | "maybe" | "no" + brief reason
  "consensus_pass": boolean,
  "bundle_unanimous": boolean,       // true iff your rewrite suggestions avoid every critic's non-negotiable
  "dissent": [                       // populate only when bundle_unanimous=false
    { "critic": "hook-coach"|"substance-auditor"|"flow-critic", "objection": string }
  ],
  "chair_summary": string,           // one paragraph synthesis
  "categories": {                    // ALL 10 keys, merged from owner critics
    "hook_strength": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "retention_potential": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "content_quality": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "audience_targeting": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "cta_effectiveness": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "seo_optimization": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "pacing_flow": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "human_authenticity": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "natural_speech": { "score": number, "assessment": string, "issues": [string], "fix": string },
    "logic_coherence": { "score": number, "assessment": string, "issues": [string], "fix": string }
  },
  "critical_issues": [
    { "severity": "minor"|"major"|"critical", "location": string, "issue": string, "fix": string }
  ],
  "strengths": [string],
  "rewrite_suggestions": [
    { "original": string, "improved": string, "reason": string }
  ],
  "title_suggestions": [string],     // 5 potential titles
  "thumbnail_ideas": [string],       // 2–3 thumbnail concepts
  "next_pass_focus": string          // what to focus on next pass
}`,
    '',
    'Output nothing except the JSON object.',
  ].join('\n');

  // Stable prefix: charter + script. Chair runs once per panel run, but on
  // retry the same charter + script are reused — caching holds across retries.
  const prefixParts: string[] = [];
  if (charter) {
    prefixParts.push(formatCharterForScriptPrompt(charter));
    prefixParts.push('');
  }
  prefixParts.push('── SCRIPT ──');
  prefixParts.push('```');
  prefixParts.push(ctx.script);
  prefixParts.push('```');
  const userCachePrefix = prefixParts.join('\n');

  const parts: string[] = [];
  parts.push('── DRAFTS ──');
  for (const d of drafts) {
    parts.push(`${d.critic.toUpperCase()} · score ${d.overall_score}`);
    parts.push(`  summary: ${d.summary}`);
    parts.push(`  owned categories:`);
    for (const [k, v] of Object.entries(d.categories)) {
      if (!v) continue;
      parts.push(`    ${k}: ${v.score}/100 — ${v.assessment}`);
      for (const issue of v.issues) parts.push(`      issue: ${issue}`);
    }
    parts.push(`  critical_issues:`);
    for (const ci of d.critical_issues) parts.push(`    · [${ci.severity}] ${ci.location}: ${ci.issue} → ${ci.fix}`);
    parts.push('');
  }
  parts.push('── DELIBERATION + COMMITMENTS ──');
  for (const note of deliberations) {
    parts.push(`${note.critic.toUpperCase()} · post-deliberation score ${note.updatedScore}`);
    parts.push(`  summary: ${note.summary}`);
    if (note.myNonNegotiables.length > 0) {
      parts.push(`  🚫 NON-NEGOTIABLES (bundle MUST NOT touch these):`);
      for (const nn of note.myNonNegotiables) parts.push(`      · ${nn}`);
    }
    if (note.myWillingToAccept.length > 0) {
      parts.push(`  ✓ willing to accept: ${note.myWillingToAccept.join(' · ')}`);
    }
    parts.push(`  📊 PREDICTED NEXT-PASS SCORE IF BUNDLE APPLIED: ${note.myPredictedScoreIfBundleApplied} (committed; rollback if actual drops >7 below)`);
    for (const pr of note.peerResponses) {
      parts.push(`    → ${pr.stance.toUpperCase()} ${pr.targetCritic}${pr.targetCategory ? ` [${pr.targetCategory}]` : ''}: ${pr.reasoning}`);
    }
    for (const [k, v] of Object.entries(note.updatedCategories)) {
      if (!v) continue;
      parts.push(`  ${k}: ${v.score}/100 — ${v.assessment}`);
    }
    parts.push('');
  }
  parts.push('');
  parts.push('Respond with the JSON object and nothing else.');
  return { system, user: parts.join('\n'), userCachePrefix };
}
