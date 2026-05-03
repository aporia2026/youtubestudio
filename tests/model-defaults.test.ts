import { describe, expect, it } from 'vitest';
import {
  decodeScope,
  encodeScope,
} from '@/lib/model-defaults';
import {
  APP_FEATURES,
  FEATURE_SECTIONS,
  resolveFeatureModelId,
  getFeatureSpec,
  type ModelDefaultsBlob,
} from '@/lib/ai-models';

describe('model-defaults: scope codec', () => {
  it('round-trips workspace scope', () => {
    const s = decodeScope('workspace');
    expect(s).toEqual({ kind: 'workspace' });
    expect(encodeScope({ kind: 'workspace' })).toBe('workspace');
  });

  it('round-trips section scope for every known section', () => {
    for (const section of FEATURE_SECTIONS) {
      const enc = encodeScope({ kind: 'section', section: section.id });
      expect(enc).toBe(`section:${section.id}`);
      const dec = decodeScope(enc);
      expect(dec).toEqual({ kind: 'section', section: section.id });
    }
  });

  it('round-trips feature scope for every registered feature', () => {
    for (const feature of APP_FEATURES) {
      const enc = encodeScope({ kind: 'feature', feature: feature.id });
      expect(enc).toBe(`feature:${feature.id}`);
      const dec = decodeScope(enc);
      expect(dec).toEqual({ kind: 'feature', feature: feature.id });
    }
  });

  it('returns null for unknown sections and features so the resolver ignores them', () => {
    expect(decodeScope('section:bogus')).toBeNull();
    expect(decodeScope('feature:nope')).toBeNull();
    expect(decodeScope('garbage')).toBeNull();
    expect(decodeScope('')).toBeNull();
  });
});

describe('model-defaults: resolveFeatureModelId precedence', () => {
  function blob(partial: Partial<ModelDefaultsBlob>): ModelDefaultsBlob {
    return { workspace: null, sections: {}, features: {}, ...partial };
  }

  it('uses the feature override when set, even if section + workspace are also set', () => {
    const result = resolveFeatureModelId('script-generator', blob({
      workspace: 'claude-haiku-4-5-20251001',
      sections: { create: 'claude-opus-4-6' },
      features: { 'script-generator': 'claude-sonnet-4-6' },
    }));
    expect(result).toBe('claude-sonnet-4-6');
  });

  it('falls through to section override when no feature override', () => {
    const result = resolveFeatureModelId('script-generator', blob({
      workspace: 'claude-haiku-4-5-20251001',
      sections: { create: 'claude-opus-4-6' },
    }));
    expect(result).toBe('claude-opus-4-6');
  });

  it('falls through to workspace override when no feature or section override', () => {
    const result = resolveFeatureModelId('script-generator', blob({
      workspace: 'claude-haiku-4-5-20251001',
    }));
    expect(result).toBe('claude-haiku-4-5-20251001');
  });

  it('falls through to the feature\'s hardcoded default when nothing is overridden', () => {
    const spec = getFeatureSpec('script-generator')!;
    const result = resolveFeatureModelId('script-generator', null);
    expect(result).toBe(spec.defaultModelId);
  });

  it('ignores overrides pointing to a model id that is not in the registry', () => {
    const spec = getFeatureSpec('script-generator')!;
    const result = resolveFeatureModelId('script-generator', blob({
      workspace: 'invented-model-id',
      sections: { create: 'also-invented' },
      features: { 'script-generator': 'still-fake' },
    }));
    expect(result).toBe(spec.defaultModelId);
  });

  it('cross-section overrides do not leak: a Grow override does not affect a Create feature', () => {
    const spec = getFeatureSpec('script-generator')!;
    const result = resolveFeatureModelId('script-generator', blob({
      sections: { grow: 'claude-opus-4-6' },
    }));
    expect(result).toBe(spec.defaultModelId);
  });

  it('every feature has a registered defaultModelId in AI_MODELS', () => {
    for (const feature of APP_FEATURES) {
      const result = resolveFeatureModelId(feature.id, null);
      expect(result, `feature ${feature.id} → default ${feature.defaultModelId}`).toBe(feature.defaultModelId);
    }
  });
});

describe('model-defaults: APP_FEATURES catalogue invariants', () => {
  it('every feature belongs to a known section', () => {
    const sectionIds = new Set(FEATURE_SECTIONS.map((s) => s.id));
    for (const f of APP_FEATURES) {
      expect(sectionIds.has(f.section), `feature ${f.id} → section ${f.section}`).toBe(true);
    }
  });

  it('feature ids are unique', () => {
    const ids = APP_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every section has at least one feature OR is documented as having none (e.g. collaborate)', () => {
    const counts = new Map<string, number>();
    for (const f of APP_FEATURES) counts.set(f.section, (counts.get(f.section) ?? 0) + 1);
    for (const s of FEATURE_SECTIONS) {
      // 'collaborate' has no AI features today — that's intentional.
      if (s.id === 'collaborate') continue;
      expect(counts.get(s.id) ?? 0, `section ${s.id} should have at least one feature`).toBeGreaterThan(0);
    }
  });
});
