/**
 * Shared types for the script-critic panel.
 *
 * The panel runs four phases (Charter → Drafts → Deliberation → Chair).
 * Types here describe the shapes each phase produces and the final
 * legacy-compatible ScriptPanelVerdict the route consumes.
 */

export type ScriptCriticId = 'hook-coach' | 'substance-auditor' | 'flow-critic';

export type ScriptCategoryKey =
  | 'hook_strength'
  | 'retention_potential'
  | 'content_quality'
  | 'audience_targeting'
  | 'cta_effectiveness'
  | 'seo_optimization'
  | 'pacing_flow'
  | 'human_authenticity'
  | 'natural_speech'
  | 'logic_coherence';

export type ScriptStance = 'concur' | 'defer' | 'counter' | 'escalate';

export type ScriptSeverity = 'minor' | 'major' | 'critical';

export type ScriptAggressiveness = 'standard' | 'brutal' | 'nuclear';

export interface CategoryScore {
  score: number;
  assessment: string;
  issues: string[];
  fix: string;
}

export interface CriticalIssue {
  severity: ScriptSeverity;
  location: string;
  issue: string;
  fix: string;
  originatingCritic?: ScriptCriticId;
}

export interface RewriteSuggestion {
  original: string;
  improved: string;
  reason: string;
}

export interface ScriptCriticContext {
  script: string;
  niche: string;
  passNumber: number;
  previousFeedback?: string;
  aggressiveness: ScriptAggressiveness;
  modelId: string;
}

export interface ScriptPeerResponse {
  targetCritic: ScriptCriticId;
  targetCategory?: ScriptCategoryKey;
  stance: ScriptStance;
  reasoning: string;
}

export interface ScriptCriticReport {
  critic: ScriptCriticId;
  overall_score: number;
  summary: string;
  categories: Partial<Record<ScriptCategoryKey, CategoryScore>>;
  critical_issues: CriticalIssue[];
  strengths: string[];
}

export interface ScriptDeliberationNote {
  critic: ScriptCriticId;
  peerResponses: ScriptPeerResponse[];
  updatedScore: number;
  updatedCategories: Partial<Record<ScriptCategoryKey, CategoryScore>>;
  updatedIssues: CriticalIssue[];
  summary: string;
  myNonNegotiables: string[];
  myWillingToAccept: string[];
  myPredictedScoreIfBundleApplied: number;
}

export interface ScriptCharterContribution {
  critic: ScriptCriticId;
  redLines: string[];
  priorityRules: string[];
  nonGoals: string[];
  anchor90: string;
  anchor75: string;
  summary: string;
}

export interface ScriptCharterPerCritic {
  priorityRule: string;
  nonGoals: string[];
  anchor90: string;
  anchor75: string;
}

export interface ScriptCharter {
  mission: string;
  redLines: string[];
  perCritic: Partial<Record<ScriptCriticId, ScriptCharterPerCritic>>;
  scoringAnchors: {
    ninetyFive: string;
    eightyFive: string;
    seventy: string;
  };
  contributions: ScriptCharterContribution[];
  chairSummary: string;
}

export interface ScriptPanelVerdict {
  overall_score: number;
  weighted_score: number;
  verdict: string;
  will_it_perform: string;
  categories: Record<ScriptCategoryKey, CategoryScore>;
  critical_issues: CriticalIssue[];
  strengths: string[];
  rewrite_suggestions: RewriteSuggestion[];
  title_suggestions: string[];
  thumbnail_ideas: string[];
  next_pass_focus: string;
  consensus_pass: boolean;
  chair_summary: string;
  deliberations: ScriptDeliberationNote[];
  bundle_unanimous?: boolean;
  dissent?: Array<{ critic: ScriptCriticId; objection: string }>;
  per_critic_predictions?: Partial<Record<ScriptCriticId, number>>;
  charter?: ScriptCharter;
}
