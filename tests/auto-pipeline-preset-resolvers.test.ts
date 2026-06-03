import { describe, it, expect } from 'vitest';
import {
  resolveScriptRules,
  resolveScriptStyleId,
  resolveQaConfig,
  resolveNarrationConfig,
  resolveIdeaConfig,
} from '../src/lib/auto-pipeline/preset-resolvers';
import type {
  PipelinePreset,
  ScriptPreset,
  QaPreset,
  NarrationPreset,
  IdeaPreset,
} from '../src/lib/auto-pipeline/types';

/**
 * Pure-function tests for the bundle resolvers. The four resolvers
 * are the single source of truth that every stage handler reads
 * from; getting their fallback chain wrong silently changes what the
 * model receives. Per-field fallback (bundle wins per field, not per
 * block) is the property that protects users who partially migrate
 * to the bundle.
 */

// ─── Test fixtures ──────────────────────────────────────────────────

function basePreset(overrides: Partial<PipelinePreset> = {}): PipelinePreset {
  return {
    id: 'p1',
    workspace_id: 'ws1',
    name: 'Test',
    niche: null,
    ideas_count_default: 5,
    idea_context_jsonb: null,
    script_rules_jsonb: null,
    target_spoken_words: null,
    qa_min_score: 75,
    qa_max_iterations: 3,
    script_gate_enabled: true,
    production_doc_style_id: null,
    script_style_preset_id: null,
    narration_deadline_days: 7,
    fallback_chains_jsonb: null,
    video_editor_collaborator_id: null,
    thumbnail_template_id: null,
    seo_template_id: null,
    script_preset_id: null,
    qa_preset_id: null,
    narration_preset_id: null,
    idea_preset_id: null,
    pacing_profile: null,
    script_preset: null,
    qa_preset: null,
    narration_preset: null,
    idea_preset: null,
    ...overrides,
  };
}

function scriptBundle(overrides: Partial<ScriptPreset> = {}): ScriptPreset {
  return {
    id: 's1',
    workspace_id: 'ws1',
    name: 'Script',
    description: null,
    tone: null,
    style_note: null,
    audience: null,
    target_duration_minutes: null,
    additional_context: null,
    reference_context: null,
    script_style_preset_id: null,
    constraints_jsonb: null,
    ...overrides,
  };
}

function qaBundle(overrides: Partial<QaPreset> = {}): QaPreset {
  return {
    id: 'q1',
    workspace_id: 'ws1',
    name: 'QA',
    description: null,
    min_score: 75,
    max_iterations: 3,
    pre_check_enabled: null,
    generator_v2_enabled: null,
    ...overrides,
  };
}

function narrationBundle(overrides: Partial<NarrationPreset> = {}): NarrationPreset {
  return {
    id: 'n1',
    workspace_id: 'ws1',
    name: 'Narration',
    description: null,
    deadline_days: 7,
    preferred_narrator_collaborator_id: null,
    voice_settings_jsonb: null,
    ...overrides,
  };
}

function ideaBundle(overrides: Partial<IdeaPreset> = {}): IdeaPreset {
  return {
    id: 'i1',
    workspace_id: 'ws1',
    name: 'Idea',
    description: null,
    niche_default: null,
    ideas_count_default: 5,
    focus: null,
    audience: null,
    video_type: null,
    reference_context: null,
    reddit_context: null,
    ...overrides,
  };
}

// ─── resolveScriptRules ─────────────────────────────────────────────

describe('resolveScriptRules', () => {
  it('returns all-undefined when nothing is set', () => {
    expect(resolveScriptRules(basePreset())).toEqual({
      tone: undefined,
      style: undefined,
      audience: undefined,
      additionalContext: undefined,
      referenceContext: undefined,
      targetDurationMinutes: undefined,
      constraints: undefined,
    });
  });

  it('reads from the inline script_rules_jsonb when no bundle', () => {
    const preset = basePreset({
      script_rules_jsonb: {
        tone: 'urgent',
        style: 'tight',
        audience: 'devs',
        additionalContext: 'mention X',
        targetDurationMinutes: 9,
      },
    });
    const r = resolveScriptRules(preset);
    expect(r.tone).toBe('urgent');
    expect(r.style).toBe('tight');
    expect(r.audience).toBe('devs');
    expect(r.additionalContext).toBe('mention X');
    expect(r.targetDurationMinutes).toBe(9);
  });

  it('bundle wins over inline when both set', () => {
    const preset = basePreset({
      script_rules_jsonb: { tone: 'inline-tone', audience: 'inline-aud' },
      script_preset: scriptBundle({ tone: 'bundle-tone', audience: 'bundle-aud' }),
    });
    expect(resolveScriptRules(preset).tone).toBe('bundle-tone');
    expect(resolveScriptRules(preset).audience).toBe('bundle-aud');
  });

  it('per-field fallback: bundle tone + inline audience both surface', () => {
    const preset = basePreset({
      script_rules_jsonb: { audience: 'inline-aud' },
      script_preset: scriptBundle({ tone: 'bundle-tone' }),
    });
    const r = resolveScriptRules(preset);
    expect(r.tone).toBe('bundle-tone');
    expect(r.audience).toBe('inline-aud');
  });

  it('treats empty strings on bundle as not-set (falls through to inline)', () => {
    const preset = basePreset({
      script_rules_jsonb: { tone: 'inline-tone' },
      script_preset: scriptBundle({ tone: '' }),
    });
    expect(resolveScriptRules(preset).tone).toBe('inline-tone');
  });

  it('treats whitespace-only inline strings as not-set', () => {
    const preset = basePreset({
      script_rules_jsonb: { tone: '   ' },
    });
    expect(resolveScriptRules(preset).tone).toBeUndefined();
  });

  it('maps style_note → style (the prompt builder param)', () => {
    const preset = basePreset({
      script_preset: scriptBundle({ style_note: 'short sentences' }),
    });
    expect(resolveScriptRules(preset).style).toBe('short sentences');
  });

  it('maps additional_context → additionalContext', () => {
    const preset = basePreset({
      script_preset: scriptBundle({ additional_context: 'mention X once' }),
    });
    expect(resolveScriptRules(preset).additionalContext).toBe('mention X once');
  });

  it('numeric target_duration_minutes from bundle wins over inline', () => {
    const preset = basePreset({
      script_rules_jsonb: { targetDurationMinutes: 5 },
      script_preset: scriptBundle({ target_duration_minutes: 12 }),
    });
    expect(resolveScriptRules(preset).targetDurationMinutes).toBe(12);
  });

  it('constraints: bundle wins as a whole object', () => {
    const preset = basePreset({
      script_rules_jsonb: { constraints: { fromInline: true } },
      script_preset: scriptBundle({ constraints_jsonb: { fromBundle: true } }),
    });
    expect(resolveScriptRules(preset).constraints).toEqual({ fromBundle: true });
  });
});

// ─── resolveScriptStyleId ───────────────────────────────────────────

describe('resolveScriptStyleId', () => {
  it('returns null when nothing is set', () => {
    expect(resolveScriptStyleId(basePreset())).toBeNull();
  });

  it('uses production_doc_style_id when no closer fallback is set', () => {
    expect(
      resolveScriptStyleId(basePreset({ production_doc_style_id: 'visual-1' })),
    ).toBe('visual-1');
  });

  it('preset.script_style_preset_id wins over production_doc_style_id', () => {
    expect(
      resolveScriptStyleId(
        basePreset({
          production_doc_style_id: 'visual-1',
          script_style_preset_id: 'script-1',
        }),
      ),
    ).toBe('script-1');
  });

  it('bundle.script_preset.script_style_preset_id wins over everything', () => {
    expect(
      resolveScriptStyleId(
        basePreset({
          production_doc_style_id: 'visual-1',
          script_style_preset_id: 'script-1',
          script_preset: scriptBundle({ script_style_preset_id: 'bundle-1' }),
        }),
      ),
    ).toBe('bundle-1');
  });
});

// ─── resolveQaConfig ────────────────────────────────────────────────

describe('resolveQaConfig', () => {
  it('returns inline values when no bundle', () => {
    const c = resolveQaConfig(
      basePreset({ qa_min_score: 80, qa_max_iterations: 4 }),
    );
    expect(c.minScore).toBe(80);
    expect(c.maxIterations).toBe(4);
    expect(c.preCheckEnabled).toBe('inherit');
    expect(c.generatorV2Enabled).toBe('inherit');
  });

  it('bundle wins for min_score + max_iterations', () => {
    const c = resolveQaConfig(
      basePreset({
        qa_min_score: 80,
        qa_max_iterations: 4,
        qa_preset: qaBundle({ min_score: 90, max_iterations: 5 }),
      }),
    );
    expect(c.minScore).toBe(90);
    expect(c.maxIterations).toBe(5);
  });

  it("returns 'inherit' for null tri-state values", () => {
    const c = resolveQaConfig(
      basePreset({
        qa_preset: qaBundle({ pre_check_enabled: null, generator_v2_enabled: null }),
      }),
    );
    expect(c.preCheckEnabled).toBe('inherit');
    expect(c.generatorV2Enabled).toBe('inherit');
  });

  it('passes through explicit on / off toggles', () => {
    const c = resolveQaConfig(
      basePreset({
        qa_preset: qaBundle({ pre_check_enabled: 'on', generator_v2_enabled: 'off' }),
      }),
    );
    expect(c.preCheckEnabled).toBe('on');
    expect(c.generatorV2Enabled).toBe('off');
  });
});

// ─── resolveNarrationConfig ─────────────────────────────────────────

describe('resolveNarrationConfig', () => {
  it('returns inline deadline + nulls when no bundle', () => {
    const c = resolveNarrationConfig(basePreset({ narration_deadline_days: 14 }));
    expect(c.deadlineDays).toBe(14);
    expect(c.preferredNarratorCollaboratorId).toBeNull();
    expect(c.voiceSettings).toBeNull();
  });

  it('bundle deadline wins over inline', () => {
    const c = resolveNarrationConfig(
      basePreset({
        narration_deadline_days: 7,
        narration_preset: narrationBundle({ deadline_days: 21 }),
      }),
    );
    expect(c.deadlineDays).toBe(21);
  });

  it('surfaces bundle narrator + voice settings', () => {
    const c = resolveNarrationConfig(
      basePreset({
        narration_preset: narrationBundle({
          preferred_narrator_collaborator_id: 'narr-1',
          voice_settings_jsonb: { speed: 1.1 },
        }),
      }),
    );
    expect(c.preferredNarratorCollaboratorId).toBe('narr-1');
    expect(c.voiceSettings).toEqual({ speed: 1.1 });
  });
});

// ─── resolveIdeaConfig ──────────────────────────────────────────────

describe('resolveIdeaConfig', () => {
  it('returns mostly-nulls + defaults when nothing is set', () => {
    const c = resolveIdeaConfig(basePreset());
    expect(c.niche).toBeNull();
    expect(c.ideasCountDefault).toBe(5);
    expect(c.focus).toBeNull();
    expect(c.audience).toBeNull();
    expect(c.videoType).toBeNull();
    expect(c.referenceContext).toBeNull();
    expect(c.redditContext).toBeNull();
  });

  it("falls back to preset.niche when bundle's niche_default is unset", () => {
    expect(resolveIdeaConfig(basePreset({ niche: 'cybersec' })).niche).toBe('cybersec');
  });

  it("bundle's niche_default wins over preset.niche", () => {
    expect(
      resolveIdeaConfig(
        basePreset({
          niche: 'cybersec',
          idea_preset: ideaBundle({ niche_default: 'productivity' }),
        }),
      ).niche,
    ).toBe('productivity');
  });

  it("falls back to ideas_count_default when bundle's is unset", () => {
    expect(
      resolveIdeaConfig(basePreset({ ideas_count_default: 8 })).ideasCountDefault,
    ).toBe(8);
  });

  it('rejects unknown focus values from inline JSON', () => {
    expect(
      resolveIdeaConfig(
        basePreset({ idea_context_jsonb: { focus: 'random-string' } }),
      ).focus,
    ).toBeNull();
  });

  it("passes through valid focus values from the bundle", () => {
    expect(
      resolveIdeaConfig(
        basePreset({ idea_preset: ideaBundle({ focus: 'controversial' }) }),
      ).focus,
    ).toBe('controversial');
  });

  it('reads audience / videoType / referenceContext / redditContext from inline', () => {
    const c = resolveIdeaConfig(
      basePreset({
        idea_context_jsonb: {
          audience: 'devs',
          videoType: '10-min explainer',
          referenceContext: 'ref',
          redditContext: 'r/cybersec',
        },
      }),
    );
    expect(c.audience).toBe('devs');
    expect(c.videoType).toBe('10-min explainer');
    expect(c.referenceContext).toBe('ref');
    expect(c.redditContext).toBe('r/cybersec');
  });
});
