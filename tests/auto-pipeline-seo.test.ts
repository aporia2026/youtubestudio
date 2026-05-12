import { describe, expect, it } from 'vitest';
import {
  PIPELINE_STAGES,
  ACTIVE_STAGES,
  TERMINAL_STAGES,
  FAILURE_STAGES,
  isActiveStage,
  isTerminalStage,
} from '@/lib/auto-pipeline/types';
import { getStageHandler } from '@/lib/auto-pipeline/orchestrator';
import { buildSeoAdditionalContext } from '@/lib/auto-pipeline/stages/generate-seo';
import { DEFAULT_FALLBACK_CHAINS } from '@/lib/ai-models';

describe('SEO stage — types + dispatch', () => {
  it('generating_seo is registered as an active stage', () => {
    expect(PIPELINE_STAGES.includes('generating_seo' as never)).toBe(true);
    expect(ACTIVE_STAGES.has('generating_seo')).toBe(true);
    expect(isActiveStage('generating_seo')).toBe(true);
  });

  it('seo_failed is registered as a terminal failure stage', () => {
    expect(PIPELINE_STAGES.includes('seo_failed' as never)).toBe(true);
    expect(TERMINAL_STAGES.has('seo_failed')).toBe(true);
    expect(FAILURE_STAGES.has('seo_failed')).toBe(true);
    expect(isTerminalStage('seo_failed')).toBe(true);
  });

  it('orchestrator dispatches generating_seo to a handler', () => {
    const handler = getStageHandler('generating_seo');
    expect(handler).not.toBeNull();
  });

  it('seo_failed has no handler (terminal — cron skips)', () => {
    expect(getStageHandler('seo_failed')).toBeNull();
  });

  it('seo-optimizer is in DEFAULT_FALLBACK_CHAINS', () => {
    expect(DEFAULT_FALLBACK_CHAINS['seo-optimizer']).toBeDefined();
    expect(DEFAULT_FALLBACK_CHAINS['seo-optimizer']!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildSeoAdditionalContext', () => {
  it('returns empty string for blank input', () => {
    expect(buildSeoAdditionalContext('')).toBe('');
    expect(buildSeoAdditionalContext('   ')).toBe('');
    expect(buildSeoAdditionalContext('\n\n\t')).toBe('');
  });

  it('wraps template content in a STYLE / DIRECTION block', () => {
    const out = buildSeoAdditionalContext('Always use the number 7. Never clickbait.');
    expect(out).toContain('STYLE / DIRECTION (from saved template):');
    expect(out).toContain('Always use the number 7. Never clickbait.');
  });

  it('trims input before wrapping', () => {
    const out = buildSeoAdditionalContext('   trimmed content   \n');
    expect(out).toContain('STYLE / DIRECTION (from saved template):\ntrimmed content');
    // Output starts directly with the wrapper, no leading whitespace.
    expect(out.startsWith('STYLE / DIRECTION')).toBe(true);
  });
});
