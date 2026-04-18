/**
 * Script-panel runner — 3-phase deliberative panel for script QA.
 *
 *   Phase 1: three specialists (Hook Coach, Substance Auditor, Flow Critic)
 *            draft independent reviews in parallel.
 *   Phase 2: deliberation — each specialist reads peer drafts and issues
 *            a DeliberationNote (stances on peer flags + updated own
 *            score/categories/issues).
 *   Phase 3: Chair (Gemini 3.1 Pro) synthesizes drafts + deliberations
 *            into the legacy-compatible ScriptPanelVerdict shape.
 *
 * The verdict's top-level shape intentionally matches what
 * /api/generate/script-validated's old QA produced, so the client code
 * that consumes { overall_score, categories, critical_issues, rewrite_suggestions,
 * title_suggestions, thumbnail_ideas, next_pass_focus } continues to work.
 * The new fields (chair_summary, consensus_pass, weighted_score,
 * deliberations) are additive.
 */

import { generateText, getModelById } from '@/lib/ai';
import { parseLlmJson } from '@/lib/parse-llm-json';
import type {
  ScriptCriticContext,
  ScriptCriticReport,
  ScriptDeliberationNote,
  ScriptPanelVerdict,
  ScriptPeerResponse,
  ScriptStance,
  ScriptSeverity,
  CategoryScore,
  ScriptCategoryKey,
  CriticalIssue,
  RewriteSuggestion,
  ScriptCriticId,
  ScriptCharter,
  ScriptCharterContribution,
} from './types';
import {
  SCRIPT_CRITICS,
  HOOK_COACH,
  SUBSTANCE_AUDITOR,
  FLOW_CRITIC,
  buildDraftPrompt,
  buildDeliberationPrompt,
  buildChairPrompt,
  buildCharterContributionPrompt,
  buildCharterSynthesisPrompt,
  CATEGORY_OWNER,
} from './prompts';

const CHAIR_MODEL = 'kie-gemini-3.1-pro';

/** Safe JSON parse — treat malformed model output as a recoverable error,
 *  not a crash. Returns null on failure so callers can substitute a
 *  fallback shape without propagating a parse exception up through
 *  Promise.all (which would fail the whole panel). */
function safeParseLlmJson<T>(raw: string): T | null {
  try { return parseLlmJson(raw) as T; }
  catch { return null; }
}

export interface RunScriptPanelResult {
  verdict: ScriptPanelVerdict;
  drafts: ScriptCriticReport[];
  deliberations: ScriptDeliberationNote[];
  charter?: ScriptCharter;
}

interface RunScriptPanelArgs extends ScriptCriticContext {
  /** Pre-existing charter — caller (the route) passes this on retry
   *  attempts so the panel doesn't re-align every retry. When absent, a
   *  charter is produced at the top of this call and returned so the
   *  caller can cache it. */
  charter?: ScriptCharter;
}

/** Run the 4-phase panel: Charter → Drafts → Deliberation → Chair.
 *
 *  Attempt 1 runs the charter; subsequent attempts can reuse the returned
 *  charter. All three specialist phases use the caller's modelId; the
 *  Chair always defaults to Gemini 3.1 Pro with a fallback when that
 *  model isn't provisioned. */
export async function runScriptPanel(args: RunScriptPanelArgs): Promise<RunScriptPanelResult> {
  const ctx: ScriptCriticContext = {
    script: args.script,
    niche: args.niche,
    passNumber: args.passNumber,
    previousFeedback: args.previousFeedback,
    aggressiveness: args.aggressiveness,
    modelId: args.modelId,
  };

  // ─── Phase 0: Charter ───────────────────────────────────────────────────
  // Runs ONCE per run. Caller is responsible for passing `args.charter`
  // on retry attempts so we don't re-align every attempt. On attempt 1
  // (no charter supplied), we run it and return it so the caller can
  // cache.
  let charter = args.charter;
  if (!charter) {
    charter = await runScriptCharter(ctx).catch(() => undefined);
  }

  // ─── Phase 1: drafts ─────────────────────────────────────────────────────
  const drafts = await Promise.all(
    SCRIPT_CRITICS.map(async (spec): Promise<ScriptCriticReport> => {
      const { system, user, userCachePrefix } = buildDraftPrompt(spec, ctx, charter);
      try {
        const raw = await generateText({
          modelId: ctx.modelId,
          prompt: user,
          systemPrompt: system,
          maxTokens: 3000,
          temperature: 0.3,
          cache: true,
          userCachePrefix,
        });
        const parsed = safeParseLlmJson<RawDraftOutput>(raw);
        // Malformed model output — fall back to an empty draft with a
        // critical error issue so the Chair knows this specialist
        // couldn't weigh in. Without this, parseLlmJson throwing would
        // cascade through Promise.all and kill all three drafts.
        if (!parsed) return emptyDraft(spec.id, 'Model returned unparseable JSON.');
        return normalizeDraft(spec.id, parsed);
      } catch (err) {
        return emptyDraft(spec.id, `Draft failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  // ─── Phase 2: deliberation ──────────────────────────────────────────────
  const deliberations = await Promise.all(
    SCRIPT_CRITICS.map(async (spec): Promise<ScriptDeliberationNote> => {
      const ownDraft = drafts.find(d => d.critic === spec.id)!;
      const peerDrafts = drafts.filter(d => d.critic !== spec.id);
      const { system, user, userCachePrefix } = buildDeliberationPrompt(spec, ctx, ownDraft, peerDrafts, charter);
      try {
        const raw = await generateText({
          modelId: ctx.modelId,
          prompt: user,
          systemPrompt: system,
          maxTokens: 3000,
          temperature: 0.25,
          cache: true,
          userCachePrefix,
        });
        const parsed = safeParseLlmJson<RawDeliberationOutput>(raw);
        // Malformed deliberation → carry draft forward (same effect as
        // generateText throwing). Either way the critic's draft numbers
        // survive; we just lose the peer-stance updates for this critic.
        if (!parsed) {
          return {
            critic: spec.id,
            peerResponses: [],
            updatedScore: ownDraft.overall_score,
            updatedCategories: ownDraft.categories,
            updatedIssues: ownDraft.critical_issues,
            summary: `Deliberation JSON unparseable; draft used as-is.`,
            myNonNegotiables: [],
            myWillingToAccept: [],
            myPredictedScoreIfBundleApplied: ownDraft.overall_score,
          };
        }
        return normalizeDeliberation(spec.id, ownDraft, parsed);
      } catch {
        // Deliberation failed — carry draft forward without peer responses.
        return {
          critic: spec.id,
          peerResponses: [],
          updatedScore: ownDraft.overall_score,
          updatedCategories: ownDraft.categories,
          updatedIssues: ownDraft.critical_issues,
          summary: `Deliberation skipped; draft used as-is.`,
          myNonNegotiables: [],
          myWillingToAccept: [],
          myPredictedScoreIfBundleApplied: ownDraft.overall_score,
        };
      }
    }),
  );

  // ─── Phase 3: Chair ──────────────────────────────────────────────────────
  // The Chair defaults to Gemini 3.1 Pro (confirmed by user). If that model
  // isn't available in the current environment (e.g. Kie API key missing,
  // model not provisioned), we fall back to the user's modelId with a
  // warning baked into the chair_summary. Previously a missing Kie model
  // would crash the whole panel with an uncaught generateText error.
  const chairModelId = getModelById(CHAIR_MODEL) ? CHAIR_MODEL : ctx.modelId;
  const chairFellBack = chairModelId !== CHAIR_MODEL;

  const { system: chairSystem, user: chairUser, userCachePrefix: chairPrefix } = buildChairPrompt(ctx, drafts, deliberations, charter);
  let chairParsed: RawChairOutput | null = null;
  let chairError: string | null = null;
  try {
    const chairRaw = await generateText({
      modelId: chairModelId,
      prompt: chairUser,
      systemPrompt: chairSystem,
      maxTokens: 6000,
      temperature: 0.25,
      cache: true,
      userCachePrefix: chairPrefix,
    });
    chairParsed = safeParseLlmJson<RawChairOutput>(chairRaw);
    if (!chairParsed) chairError = 'Chair JSON unparseable — using deliberation consensus directly.';
  } catch (err) {
    chairError = `Chair call failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const verdict = normalizeChair(chairParsed ?? {}, drafts, deliberations);
  // Annotate the chair_summary if we fell back or errored so the caller
  // can surface it — otherwise the user sees a confident verdict that
  // never actually had a Chair synthesis behind it.
  const prefixBits: string[] = [];
  if (chairFellBack) prefixBits.push(`[Chair fell back from ${CHAIR_MODEL} to ${chairModelId}]`);
  if (chairError) prefixBits.push(`[${chairError}]`);
  if (prefixBits.length > 0) {
    verdict.chair_summary = `${prefixBits.join(' ')}\n${verdict.chair_summary}`.slice(0, 1400);
    // When Chair errored outright, consensus_pass can never be true —
    // shipping on a failed Chair would violate the panel's guarantee.
    if (chairError) verdict.consensus_pass = false;
  }

  // Attach per-critic predictions, unanimity check, and charter to the
  // verdict. The Chair LLM may also emit `bundle_unanimous` directly —
  // we AND it with our objective check so a hallucinated "unanimous:
  // true" can't overwrite a real non-negotiable conflict.
  const perCriticPredictions: Partial<Record<ScriptCriticId, number>> = {};
  for (const note of deliberations) perCriticPredictions[note.critic] = note.myPredictedScoreIfBundleApplied;
  const objectiveCheck = checkScriptBundleUnanimity(verdict, deliberations);
  const llmSaysUnanimous = (chairParsed && typeof (chairParsed as { bundle_unanimous?: boolean }).bundle_unanimous === 'boolean')
    ? (chairParsed as { bundle_unanimous: boolean }).bundle_unanimous
    : true;
  const bundleUnanimous = llmSaysUnanimous && objectiveCheck.unanimous;
  const dissent: ScriptPanelVerdict['dissent'] = bundleUnanimous
    ? []
    : [
        ...((chairParsed as { dissent?: Array<{ critic: string; objection: string }> } | null)?.dissent ?? [])
          .map(d => ({ critic: validCritic(d.critic) ?? 'hook-coach', objection: String(d.objection || '').slice(0, 400) }))
          .filter(d => d.objection),
        ...objectiveCheck.violations,
      ];

  verdict.bundle_unanimous = bundleUnanimous;
  verdict.dissent = dissent;
  verdict.per_critic_predictions = perCriticPredictions;
  verdict.charter = charter;

  return { verdict, drafts, deliberations, charter };
}

// ─── Charter runner (Phase 0) ──────────────────────────────────────────────

async function runScriptCharter(ctx: ScriptCriticContext): Promise<ScriptCharter> {
  const contributions = await Promise.all(
    SCRIPT_CRITICS.map(async (spec): Promise<ScriptCharterContribution> => {
      const { system, user } = buildCharterContributionPrompt(spec, ctx);
      try {
        const raw = await generateText({
          modelId: ctx.modelId,
          prompt: user,
          systemPrompt: system,
          maxTokens: 1500,
          temperature: 0.3,
          cache: true,
        });
        const parsed = safeParseLlmJson<RawContribution>(raw);
        if (!parsed) return stubContribution(spec.id);
        return {
          critic: spec.id,
          redLines: cleanStrArr(parsed.redLines, 3, 200),
          priorityRules: cleanStrArr(parsed.priorityRules, 3, 200),
          nonGoals: cleanStrArr(parsed.nonGoals, 3, 200),
          anchor90: String(parsed.anchor90 || '').slice(0, 240),
          anchor75: String(parsed.anchor75 || '').slice(0, 240),
          summary: String(parsed.summary || '').slice(0, 600),
        };
      } catch {
        return stubContribution(spec.id);
      }
    }),
  );

  // Chair synthesis for charter — uses same Chair-model fallback logic
  // as Phase 3 below.
  const chairModelId = getModelById(CHAIR_MODEL) ? CHAIR_MODEL : ctx.modelId;
  const { system, user } = buildCharterSynthesisPrompt(contributions, ctx);
  const raw = await generateText({
    modelId: chairModelId,
    prompt: user,
    systemPrompt: system,
    maxTokens: 2500,
    temperature: 0.25,
    cache: true,
  });
  const parsed = safeParseLlmJson<RawCharterSynthesis>(raw) ?? {};
  const perCritic: ScriptCharter['perCritic'] = {};
  const ids: ScriptCriticId[] = ['hook-coach', 'substance-auditor', 'flow-critic'];
  for (const id of ids) {
    const entry = parsed.perCritic?.[id];
    if (!entry) continue;
    perCritic[id] = {
      priorityRule: String(entry.priorityRule || '').slice(0, 300),
      nonGoals: cleanStrArr(entry.nonGoals, 3, 200),
      anchor90: String(entry.anchor90 || '').slice(0, 240),
      anchor75: String(entry.anchor75 || '').slice(0, 240),
    };
  }
  return {
    mission: String(parsed.mission || '').slice(0, 400),
    redLines: cleanStrArr(parsed.redLines, 5, 260),
    perCritic,
    scoringAnchors: {
      ninetyFive: String(parsed.scoringAnchors?.ninetyFive || '').slice(0, 300),
      eightyFive: String(parsed.scoringAnchors?.eightyFive || '').slice(0, 300),
      seventy: String(parsed.scoringAnchors?.seventy || '').slice(0, 300),
    },
    contributions,
    chairSummary: String(parsed.chairSummary || '').slice(0, 1200),
  };
}

function stubContribution(critic: ScriptCriticId): ScriptCharterContribution {
  return { critic, redLines: [], priorityRules: [], nonGoals: [], anchor90: '', anchor75: '', summary: 'Charter contribution unavailable.' };
}

function cleanStrArr(v: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(s => String(s || '').slice(0, maxLen)).filter(Boolean).slice(0, max);
}

interface RawContribution {
  redLines?: string[];
  priorityRules?: string[];
  nonGoals?: string[];
  anchor90?: string;
  anchor75?: string;
  summary?: string;
}

interface RawCharterSynthesis {
  mission?: string;
  redLines?: string[];
  perCritic?: Record<string, { priorityRule?: string; nonGoals?: string[]; anchor90?: string; anchor75?: string }>;
  scoringAnchors?: { ninetyFive?: string; eightyFive?: string; seventy?: string };
  chairSummary?: string;
}

/** Objective unanimity check for the script panel. A rewrite_suggestion
 *  or critical_issue "touches" a non-negotiable if they share a 5+ char
 *  keyword. Fuzzy but catches the obvious conflicts. */
function checkScriptBundleUnanimity(
  verdict: ScriptPanelVerdict,
  deliberations: ScriptDeliberationNote[],
): { unanimous: boolean; violations: Array<{ critic: ScriptCriticId; objection: string }> } {
  const violations: Array<{ critic: ScriptCriticId; objection: string }> = [];
  const bundleText = [
    ...verdict.critical_issues.map(c => `${c.location} ${c.issue} ${c.fix}`),
    ...verdict.rewrite_suggestions.map(r => `${r.original} ${r.improved} ${r.reason}`),
  ].join(' ').toLowerCase();
  for (const note of deliberations) {
    for (const nn of note.myNonNegotiables) {
      const tokens = nn.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 5);
      if (tokens.some(t => bundleText.includes(t))) {
        violations.push({
          critic: note.critic,
          objection: `Bundle overlaps ${note.critic}'s non-negotiable: "${nn}"`,
        });
        break;
      }
    }
  }
  return { unanimous: violations.length === 0, violations };
}

/** Minimal valid draft for a critic whose LLM call failed or whose output
 *  was unparseable. Emits one `critical` issue so the Chair can see this
 *  specialist couldn't weigh in; everything else is zeroed. */
function emptyDraft(critic: ScriptCriticId, reason: string): ScriptCriticReport {
  return {
    critic,
    overall_score: 0,
    summary: `${critic} draft unavailable — ${reason}`,
    categories: {},
    critical_issues: [{
      severity: 'critical',
      location: 'panel',
      issue: `${critic} failed to produce a review: ${reason}`,
      fix: 'Re-run — transient model error.',
      originatingCritic: critic,
    }],
    strengths: [],
  };
}

// ─── Normalization ──────────────────────────────────────────────────────────
// The model sometimes returns extra keys, missing keys, or wrong types; the
// normalizers here give us stable output shape regardless of model noise.

interface RawDraftOutput {
  overall_score?: number;
  summary?: string;
  categories?: Record<string, Partial<CategoryScore>>;
  critical_issues?: Array<Partial<CriticalIssue>>;
  strengths?: string[];
}

interface RawDeliberationOutput {
  summary?: string;
  updated_score?: number;
  peer_responses?: Array<{ targetCritic?: string; targetCategory?: string; stance?: string; reasoning?: string }>;
  updated_categories?: Record<string, Partial<CategoryScore>>;
  updated_issues?: Array<Partial<CriticalIssue>>;
  my_non_negotiables?: string[];
  my_willing_to_accept?: string[];
  my_predicted_score_if_bundle_applied?: number;
}

interface RawChairOutput {
  overall_score?: number;
  verdict?: string;
  will_it_perform?: string;
  consensus_pass?: boolean;
  chair_summary?: string;
  categories?: Record<string, Partial<CategoryScore>>;
  critical_issues?: Array<Partial<CriticalIssue>>;
  strengths?: string[];
  rewrite_suggestions?: Array<Partial<RewriteSuggestion>>;
  title_suggestions?: string[];
  thumbnail_ideas?: string[];
  next_pass_focus?: string;
}

function normalizeDraft(critic: ScriptCriticId, raw: RawDraftOutput): ScriptCriticReport {
  const owned = ownedCategories(critic);
  const categories: Partial<Record<ScriptCategoryKey, CategoryScore>> = {};
  for (const key of owned) {
    const entry = raw.categories?.[key];
    if (entry) categories[key] = normalizeCategoryScore(entry);
  }
  const overall = typeof raw.overall_score === 'number'
    ? clamp01to100(raw.overall_score)
    : meanOfCategories(categories);
  return {
    critic,
    overall_score: overall,
    summary: String(raw.summary || '').slice(0, 800),
    categories,
    critical_issues: normalizeIssues(raw.critical_issues, critic),
    strengths: (raw.strengths || []).map(s => String(s).slice(0, 200)).filter(Boolean),
  };
}

function normalizeDeliberation(
  critic: ScriptCriticId,
  draft: ScriptCriticReport,
  raw: RawDeliberationOutput,
): ScriptDeliberationNote {
  const owned = ownedCategories(critic);
  const updatedCategories: Partial<Record<ScriptCategoryKey, CategoryScore>> = {};
  for (const key of owned) {
    const entry = raw.updated_categories?.[key];
    if (entry) updatedCategories[key] = normalizeCategoryScore(entry);
    else if (draft.categories[key]) updatedCategories[key] = draft.categories[key];
  }
  const updatedScore = typeof raw.updated_score === 'number'
    ? clamp01to100(raw.updated_score)
    : draft.overall_score;
  const peerResponses: ScriptPeerResponse[] = (raw.peer_responses || [])
    .map(p => ({
      targetCritic: validCritic(p.targetCritic) ?? critic,
      targetCategory: p.targetCategory && owned.includes(p.targetCategory as ScriptCategoryKey) ? undefined : (p.targetCategory as ScriptCategoryKey | undefined),
      stance: validStance(p.stance),
      reasoning: String(p.reasoning || '').slice(0, 400),
    }))
    .filter(p => p.reasoning);
  // Commitments (new) — default to safe values when the model omits them
  // so the rest of the pipeline has stable numbers to compare against.
  const myNonNegotiables = cleanStrArr(raw.my_non_negotiables, 4, 200);
  const myWillingToAccept = cleanStrArr(raw.my_willing_to_accept, 4, 200);
  const myPredictedScoreIfBundleApplied = typeof raw.my_predicted_score_if_bundle_applied === 'number'
    ? clamp01to100(raw.my_predicted_score_if_bundle_applied)
    : updatedScore;

  return {
    critic,
    peerResponses,
    updatedScore,
    updatedCategories,
    updatedIssues: normalizeIssues(raw.updated_issues, critic),
    summary: String(raw.summary || '').slice(0, 600),
    myNonNegotiables,
    myWillingToAccept,
    myPredictedScoreIfBundleApplied,
  };
}

function normalizeChair(
  raw: RawChairOutput,
  drafts: ScriptCriticReport[],
  deliberations: ScriptDeliberationNote[],
): ScriptPanelVerdict {
  // Merge categories: Chair's value if present; otherwise owner-critic's
  // post-deliberation value; otherwise a zero stub so the 10-category
  // contract holds.
  const allKeys: ScriptCategoryKey[] = [
    'hook_strength', 'retention_potential', 'content_quality', 'audience_targeting',
    'cta_effectiveness', 'seo_optimization', 'pacing_flow', 'human_authenticity',
    'natural_speech', 'logic_coherence',
  ];
  const categories = {} as Record<ScriptCategoryKey, CategoryScore>;
  for (const key of allKeys) {
    const chairEntry = raw.categories?.[key];
    if (chairEntry) {
      categories[key] = normalizeCategoryScore(chairEntry);
      continue;
    }
    const owner = CATEGORY_OWNER[key];
    const note = deliberations.find(d => d.critic === owner);
    if (note?.updatedCategories[key]) {
      categories[key] = note.updatedCategories[key]!;
      continue;
    }
    const draft = drafts.find(d => d.critic === owner);
    if (draft?.categories[key]) {
      categories[key] = draft.categories[key]!;
      continue;
    }
    categories[key] = { score: 70, assessment: 'Not scored by panel.', issues: [], fix: '' };
  }

  // Overall & weighted score.
  const overall = typeof raw.overall_score === 'number'
    ? clamp01to100(raw.overall_score)
    : meanOfCategoryRecord(categories);
  const weighted = domainWeightedMean(categories, deliberations);

  // Critical issues — prefer Chair's (deduped) list; fall back to union if
  // Chair omitted. Cap at 12 to keep the UI manageable.
  const critical = (raw.critical_issues && raw.critical_issues.length > 0)
    ? normalizeIssues(raw.critical_issues)
    : unionIssues(drafts, deliberations);

  const rewrite: RewriteSuggestion[] = (raw.rewrite_suggestions || [])
    .map(r => ({
      original: String(r.original || '').slice(0, 500),
      improved: String(r.improved || '').slice(0, 500),
      reason: String(r.reason || '').slice(0, 300),
    }))
    .filter(r => r.original && r.improved)
    .slice(0, 8);

  const consensusPass = !!raw.consensus_pass
    && overall >= 85
    && !critical.some(c => c.severity === 'critical');

  return {
    overall_score: overall,
    weighted_score: weighted,
    verdict: String(raw.verdict || '').slice(0, 300),
    will_it_perform: String(raw.will_it_perform || '').slice(0, 200),
    categories,
    critical_issues: critical,
    strengths: (raw.strengths || []).map(s => String(s).slice(0, 200)).filter(Boolean).slice(0, 10),
    rewrite_suggestions: rewrite,
    title_suggestions: (raw.title_suggestions || []).map(s => String(s).slice(0, 140)).filter(Boolean).slice(0, 5),
    thumbnail_ideas: (raw.thumbnail_ideas || []).map(s => String(s).slice(0, 200)).filter(Boolean).slice(0, 3),
    next_pass_focus: String(raw.next_pass_focus || '').slice(0, 500),
    consensus_pass: consensusPass,
    chair_summary: String(raw.chair_summary || '').slice(0, 1200),
    deliberations,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeCategoryScore(raw: Partial<CategoryScore>): CategoryScore {
  return {
    score: clamp01to100(Number(raw.score) || 0),
    assessment: String(raw.assessment || '').slice(0, 600),
    issues: (raw.issues || []).map(i => String(i).slice(0, 300)).filter(Boolean).slice(0, 8),
    fix: String(raw.fix || '').slice(0, 400),
  };
}

function normalizeIssues(raw: Array<Partial<CriticalIssue>> | undefined, originator?: ScriptCriticId): CriticalIssue[] {
  return (raw || [])
    .map(i => ({
      severity: validSeverity(i.severity),
      location: String(i.location || '').slice(0, 200),
      issue: String(i.issue || '').slice(0, 400),
      fix: String(i.fix || '').slice(0, 400),
      originatingCritic: originator,
    }))
    .filter(i => i.issue);
}

function ownedCategories(critic: ScriptCriticId): ScriptCategoryKey[] {
  switch (critic) {
    case 'hook-coach': return HOOK_COACH.owned;
    case 'substance-auditor': return SUBSTANCE_AUDITOR.owned;
    case 'flow-critic': return FLOW_CRITIC.owned;
  }
}

function meanOfCategories(cats: Partial<Record<ScriptCategoryKey, CategoryScore>>): number {
  const values = Object.values(cats).filter((v): v is CategoryScore => !!v).map(v => v.score);
  if (values.length === 0) return 0;
  return values.reduce((n, s) => n + s, 0) / values.length;
}

function meanOfCategoryRecord(cats: Record<ScriptCategoryKey, CategoryScore>): number {
  const values = Object.values(cats).map(v => v.score);
  return values.reduce((n, s) => n + s, 0) / values.length;
}

/** Domain-weighted score: categories owned by a critic whose deliberation
 *  changed their score within ±3 points of their draft (a "confident"
 *  position) get 1.5×; categories owned by critics whose deliberation
 *  updated their score >10 points (indicating they conceded) get 0.85×.
 *  Everything else is 1.0×. */
function domainWeightedMean(cats: Record<ScriptCategoryKey, CategoryScore>, deliberations: ScriptDeliberationNote[]): number {
  const draftByCritic = new Map<ScriptCriticId, number>();
  const updatedByCritic = new Map<ScriptCriticId, number>();
  for (const note of deliberations) {
    updatedByCritic.set(note.critic, note.updatedScore);
  }
  // Reconstruct "draft score per critic" by reading category entries —
  // we don't have the raw draft score here, but the updatedScore vs the
  // category score is enough signal for stability.
  for (const note of deliberations) {
    const own = ownedCategories(note.critic);
    const scores: number[] = [];
    for (const k of own) {
      const v = note.updatedCategories[k];
      if (v) scores.push(v.score);
    }
    if (scores.length > 0) {
      draftByCritic.set(note.critic, scores.reduce((a, b) => a + b, 0) / scores.length);
    }
  }
  let num = 0;
  let den = 0;
  for (const [key, cat] of Object.entries(cats) as [ScriptCategoryKey, CategoryScore][]) {
    const owner = CATEGORY_OWNER[key];
    const draft = draftByCritic.get(owner);
    const updated = updatedByCritic.get(owner);
    let weight = 1.0;
    if (typeof draft === 'number' && typeof updated === 'number') {
      const delta = Math.abs(updated - draft);
      if (delta <= 3) weight = 1.5;
      else if (delta > 10) weight = 0.85;
    }
    num += cat.score * weight;
    den += weight;
  }
  return den === 0 ? 0 : num / den;
}

function unionIssues(drafts: ScriptCriticReport[], deliberations: ScriptDeliberationNote[]): CriticalIssue[] {
  // Prefer deliberation's updated issues (they reflect what stuck after
  // peer-review) over draft's raw issues.
  const map = new Map<string, CriticalIssue>();
  for (const d of drafts) {
    for (const ci of d.critical_issues) map.set(`${ci.severity}|${ci.location}|${ci.issue.slice(0, 60)}`, ci);
  }
  for (const note of deliberations) {
    for (const ci of note.updatedIssues) map.set(`${ci.severity}|${ci.location}|${ci.issue.slice(0, 60)}`, ci);
  }
  return [...map.values()].slice(0, 12);
}

function validSeverity(s: unknown): ScriptSeverity {
  if (s === 'minor' || s === 'major' || s === 'critical') return s;
  return 'minor';
}

function validStance(s: unknown): ScriptStance {
  if (s === 'concur' || s === 'defer' || s === 'counter' || s === 'escalate') return s;
  return 'concur';
}

function validCritic(s: unknown): ScriptCriticId | null {
  if (s === 'hook-coach' || s === 'substance-auditor' || s === 'flow-critic') return s;
  return null;
}

function clamp01to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
