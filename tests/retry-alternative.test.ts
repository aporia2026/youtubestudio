/**
 * Unit tests for the channel-clone mid-run model picker helpers.
 *
 * The helpers are pure (no React, no I/O) so we exercise the full
 * `AI_MODELS` registry directly. Tests live in tests/ alongside the
 * rest of the project's vitest suites.
 *
 * See `_plans/2026-06-07-channel-clone-mid-run-model-picker-cross-provider.md`.
 */

import { describe, expect, it } from 'vitest';
import {
  getCompatibleModelsForStage,
  isModelCompatibleWithStage,
  pickRetryAlternative,
  stageToAppFeature,
  type ChannelCloneRetryStage,
} from '@/lib/channel-clone/retry-alternative';
import { AI_MODELS, APP_FEATURES, getModelById } from '@/lib/ai-models';

const TEXT_STAGES: ChannelCloneRetryStage[] = [
  'topics',
  'hooks',
  'script',
  'rowify',
  'publish-pack',
];

describe('retry-alternative: isModelCompatibleWithStage', () => {
  it('returns false for ids not in the registry', () => {
    expect(isModelCompatibleWithStage('totally-fake-model', 'topics')).toBe(false);
  });

  it('accepts every registered model on text-only stages', () => {
    for (const stage of TEXT_STAGES) {
      for (const m of AI_MODELS) {
        expect(
          isModelCompatibleWithStage(m.id, stage),
          `${m.id} should be allowed on ${stage}`,
        ).toBe(true);
      }
    }
  });

  it('blocks Perplexity Sonar on the multimodal analyze stage', () => {
    expect(isModelCompatibleWithStage('sonar', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('sonar-pro', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('sonar-reasoning', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('sonar-reasoning-pro', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('sonar-deep-research', 'analyze')).toBe(false);
  });

  it('blocks OpenAI o-series on analyze (image input not wired on chat completions)', () => {
    expect(isModelCompatibleWithStage('o3', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('o3-mini', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('o4-mini', 'analyze')).toBe(false);
  });

  it('blocks Kie GPT Codex variants on analyze (no image surface in responses payload)', () => {
    expect(isModelCompatibleWithStage('kie-gpt-5-codex', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('kie-gpt-5-1-codex', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('kie-gpt-5-2-codex', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('kie-gpt-5-3-codex', 'analyze')).toBe(false);
    expect(isModelCompatibleWithStage('kie-gpt-5-4-codex', 'analyze')).toBe(false);
  });

  it('allows Anthropic flagships on analyze (image input wired)', () => {
    expect(isModelCompatibleWithStage('claude-opus-4-8', 'analyze')).toBe(true);
    expect(isModelCompatibleWithStage('claude-sonnet-4-6', 'analyze')).toBe(true);
    expect(isModelCompatibleWithStage('claude-haiku-4-5-20251001', 'analyze')).toBe(true);
  });

  it('allows GPT-5 family and GPT-4.1 family on analyze', () => {
    expect(isModelCompatibleWithStage('gpt-5.4-mini', 'analyze')).toBe(true);
    expect(isModelCompatibleWithStage('gpt-5.5', 'analyze')).toBe(true);
    expect(isModelCompatibleWithStage('gpt-4.1', 'analyze')).toBe(true);
    expect(isModelCompatibleWithStage('gpt-4o', 'analyze')).toBe(true);
  });

  it('allows Kie Gemini family on analyze', () => {
    expect(isModelCompatibleWithStage('kie-gemini-2.5-flash', 'analyze')).toBe(true);
    expect(isModelCompatibleWithStage('kie-gemini-3-pro', 'analyze')).toBe(true);
    expect(isModelCompatibleWithStage('kie-gemini-3-5-flash', 'analyze')).toBe(true);
  });

  it('restricts voice-profile to Gemini-family ids only', () => {
    // Allowed
    expect(isModelCompatibleWithStage('kie-gemini-2.5-flash', 'voice-profile')).toBe(true);
    expect(isModelCompatibleWithStage('kie-gemini-3-5-flash', 'voice-profile')).toBe(true);
    expect(isModelCompatibleWithStage('gemini-2.5-pro', 'voice-profile')).toBe(true);
    // Blocked — no audio surface in current routers
    expect(isModelCompatibleWithStage('claude-opus-4-8', 'voice-profile')).toBe(false);
    expect(isModelCompatibleWithStage('gpt-5.4-mini', 'voice-profile')).toBe(false);
    expect(isModelCompatibleWithStage('sonar', 'voice-profile')).toBe(false);
  });
});

describe('retry-alternative: getCompatibleModelsForStage', () => {
  it('returns every model on a text stage', () => {
    expect(getCompatibleModelsForStage('topics')).toHaveLength(AI_MODELS.length);
  });

  it('removes the blocked ids on analyze without losing anything else', () => {
    const all = AI_MODELS.length;
    const filtered = getCompatibleModelsForStage('analyze');
    // 5 sonar + 3 o-series + 5 kie codex = 13 known blocks
    expect(filtered.length).toBe(all - 13);
    // No surviving entries should be in the blocklist.
    for (const m of filtered) {
      expect(isModelCompatibleWithStage(m.id, 'analyze')).toBe(true);
    }
  });

  it('returns only gemini-named entries on voice-profile', () => {
    const filtered = getCompatibleModelsForStage('voice-profile');
    for (const m of filtered) {
      expect(m.id).toMatch(/gemini/);
    }
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('preserves AI_MODELS source order so the picker UI is stable', () => {
    const filtered = getCompatibleModelsForStage('analyze');
    const filteredIds = filtered.map((m) => m.id);
    const sourceIds = AI_MODELS
      .filter((m) => isModelCompatibleWithStage(m.id, 'analyze'))
      .map((m) => m.id);
    expect(filteredIds).toEqual(sourceIds);
  });
});

describe('retry-alternative: pickRetryAlternative cross-provider heuristic', () => {
  it('jumps Anthropic → OpenAI mid-tier', () => {
    expect(pickRetryAlternative('claude-opus-4-8', 'topics')).toBe('gpt-5.4-mini');
    expect(pickRetryAlternative('claude-sonnet-4-6', 'script')).toBe('gpt-5.4-mini');
    expect(pickRetryAlternative('claude-haiku-4-5-20251001', 'rowify')).toBe('gpt-5.4-mini');
  });

  it('jumps OpenAI → Anthropic balanced', () => {
    expect(pickRetryAlternative('gpt-5.5', 'topics')).toBe('claude-sonnet-4-6');
    expect(pickRetryAlternative('gpt-5.4-mini', 'script')).toBe('claude-sonnet-4-6');
    expect(pickRetryAlternative('gpt-4.1-mini', 'rowify')).toBe('claude-sonnet-4-6');
  });

  it('jumps Kie Claude → direct Anthropic', () => {
    expect(pickRetryAlternative('kie-claude-opus-4-7', 'topics')).toBe('claude-opus-4-7');
    expect(pickRetryAlternative('kie-claude-sonnet-4-6', 'script')).toBe('claude-sonnet-4-6');
    expect(pickRetryAlternative('kie-claude-haiku-4-5', 'rowify')).toBe('claude-haiku-4-5-20251001');
  });

  it('jumps Kie GPT → direct OpenAI when an equivalent exists', () => {
    expect(pickRetryAlternative('kie-gpt-5-5', 'topics')).toBe('gpt-5.5');
    expect(pickRetryAlternative('kie-gpt-5-4', 'script')).toBe('gpt-5.4');
    expect(pickRetryAlternative('kie-gpt-5-2', 'rowify')).toBe('gpt-5.2');
  });

  it('falls back to Sonnet 4.6 when no Kie mapping exists', () => {
    // Codex variants don't have a direct equivalent in the registry —
    // and they're blocked on analyze anyway, so the helper falls
    // through to the safe Anthropic default.
    expect(pickRetryAlternative('kie-gpt-5-codex', 'topics')).toBe('claude-sonnet-4-6');
    expect(pickRetryAlternative('kie-gemini-3-pro', 'topics')).toBe('claude-sonnet-4-6');
  });

  it('jumps direct Google → Kie equivalent', () => {
    expect(pickRetryAlternative('gemini-2.5-flash', 'topics')).toBe('kie-gemini-2.5-flash');
    expect(pickRetryAlternative('gemini-3-pro', 'topics')).toBe('kie-gemini-3-pro');
  });

  it('jumps Perplexity → Anthropic balanced', () => {
    expect(pickRetryAlternative('sonar-pro', 'topics')).toBe('claude-sonnet-4-6');
    expect(pickRetryAlternative('sonar-reasoning-pro', 'script')).toBe('claude-sonnet-4-6');
  });

  it('falls back to Sonnet 4.6 for unknown model ids', () => {
    expect(pickRetryAlternative('totally-unknown', 'topics')).toBe('claude-sonnet-4-6');
    expect(pickRetryAlternative('', 'script')).toBe('claude-sonnet-4-6');
  });

  it('never returns a stage-incompatible model on analyze', () => {
    // Sonar would jump to Anthropic (compatible) — but verify the
    // assertion in case a future heuristic change picks a blocked one.
    const result = pickRetryAlternative('sonar', 'analyze');
    expect(isModelCompatibleWithStage(result, 'analyze')).toBe(true);
  });

  it('returns a registry-resolvable id for every plausible input', () => {
    const inputs = [
      'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
      'gpt-5.5', 'gpt-5.4-mini', 'gpt-4.1',
      'kie-claude-opus-4-7', 'kie-claude-sonnet-4-6', 'kie-gpt-5-5',
      'kie-gemini-2.5-flash', 'kie-gemini-3-5-flash',
      'gemini-2.5-flash', 'gemini-3-pro',
      'sonar', 'sonar-pro',
      'unknown-x',
    ];
    for (const id of inputs) {
      const picked = pickRetryAlternative(id, 'topics');
      expect(getModelById(picked), `${id} → ${picked}`).toBeDefined();
    }
  });
});

describe('retry-alternative: stageToAppFeature', () => {
  it('maps every LLM stage to a registered AppFeature', () => {
    const registered = new Set<string>(APP_FEATURES.map((f) => f.id));
    const stages: ChannelCloneRetryStage[] = [
      'analyze', 'topics', 'hooks', 'script', 'rowify', 'publish-pack',
    ];
    for (const stage of stages) {
      const feature = stageToAppFeature(stage);
      expect(feature, `${stage} should map to a feature`).not.toBeNull();
      expect(registered.has(feature ?? ''), `${feature} should be in APP_FEATURES`).toBe(true);
    }
  });

  it('returns null for non-LLM stages', () => {
    expect(stageToAppFeature('intake')).toBeNull();
    expect(stageToAppFeature('handoff')).toBeNull();
  });

  it('returns the Plan 1 voice-profile feature id, even before it lands in the registry', () => {
    // Defensive: we want the mapping to be stable so the picker
    // doesn't need a code change when Plan 1 ships its AppFeature.
    expect(stageToAppFeature('voice-profile')).toBe('channel-clone-voice-profile');
  });
});
