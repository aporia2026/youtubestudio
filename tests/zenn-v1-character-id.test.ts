import { describe, expect, it } from 'vitest';
import { normalizeZennCharacterId } from '@/remotion/zenn-character-id';
import { normalizeZennCharacterId as normalizeViaPipeline } from '@/lib/auto-pipeline/stages/generate-zenn-v1-images';

// ─── normalizeZennCharacterId (shared pure module) ──────────────────
//
// QA fix 2026-06-10 promoted this helper from a pipeline-private
// function to a shared `src/remotion/zenn-character-id.ts` module so
// the renderer can also use it. The pipeline file re-exports for
// back-compat with existing test imports.
//
// These tests pin the canonical contract once and assert that the
// pipeline's re-export is byte-identical so a future copy edit that
// drifts the two definitions apart breaks the test.

describe('normalizeZennCharacterId — canonical behavior', () => {
  it('lowercases', () => {
    expect(normalizeZennCharacterId('HERO')).toBe('hero');
    expect(normalizeZennCharacterId('Hero')).toBe('hero');
  });

  it('replaces runs of non-alphanumeric with a single hyphen', () => {
    expect(normalizeZennCharacterId('Hero 1')).toBe('hero-1');
    expect(normalizeZennCharacterId('hero___1')).toBe('hero-1');
    expect(normalizeZennCharacterId('hero . 1')).toBe('hero-1');
  });

  it('trims leading and trailing hyphens', () => {
    expect(normalizeZennCharacterId('-hero-')).toBe('hero');
    expect(normalizeZennCharacterId('   hero   ')).toBe('hero');
  });

  it('returns empty string for all-special-character input', () => {
    expect(normalizeZennCharacterId('!!!')).toBe('');
    expect(normalizeZennCharacterId('   ')).toBe('');
  });

  it('defends against undefined / null / non-string input', () => {
    // Pre-QA-fix version threw on non-string input. The shared
    // module is more defensive because the renderer might receive a
    // half-loaded shot from a malformed config.
    expect(normalizeZennCharacterId(undefined)).toBe('');
    expect(normalizeZennCharacterId(null)).toBe('');
    expect(normalizeZennCharacterId(123 as never)).toBe('');
  });
});

describe('normalizeZennCharacterId — pipeline / renderer parity', () => {
  it('the pipeline re-export produces byte-identical output to the shared module', () => {
    // The pipeline keeps a re-export of normalizeZennCharacterId so
    // existing callers (tests, the planner) keep working without an
    // import-path change. If the two definitions ever diverge, the
    // bank write side and the renderer read side fall out of sync
    // and case-variant slugs silently drop the character layer.
    const samples = [
      'hero',
      'Hero',
      'HERO',
      'Hero 1',
      'curly-haired-hunter',
      'Curly Haired Hunter',
      'CURLY_HAIRED_HUNTER',
      '!!!',
      '',
      '   ',
    ];
    for (const raw of samples) {
      expect(normalizeViaPipeline(raw)).toBe(normalizeZennCharacterId(raw));
    }
  });
});
