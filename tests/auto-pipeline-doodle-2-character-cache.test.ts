import { describe, expect, it } from 'vitest';
import {
  buildCharacterContinuationEditPrompt,
  generateCharacterContinuationImage,
} from '@/lib/auto-pipeline/production-doc-image-gen';

// ─── buildCharacterContinuationEditPrompt ────────────────────────────
//
// Pure helper that wraps a row's `ai_image_prompt` into an Atlas Edit
// instruction designed to preserve character identity from the cached
// base image. The exact wording was tuned via the smoke test at
// _plans/2026-05-28-atlas-edit-smoke/; changes here should be paired
// with another smoke run if the identity-preservation behaviour drifts.

describe('buildCharacterContinuationEditPrompt', () => {
  it('wraps the scene prompt with the identity-preservation preamble', () => {
    const out = buildCharacterContinuationEditPrompt('running through snow at night');
    expect(out).toContain('Modify this image to show the SAME character');
    expect(out).toContain('running through snow at night');
    expect(out).toContain('keep the character\'s face, hair, body proportions, clothing');
    expect(out).toContain('EXACTLY identical');
  });

  it('trims whitespace from the scene prompt before embedding', () => {
    const out = buildCharacterContinuationEditPrompt('   sad expression, holding a photo   ');
    // The trimmed version should appear inline without leading/trailing spaces.
    expect(out).toContain('new scene: sad expression, holding a photo.');
    expect(out).not.toContain('new scene:    ');
  });

  it('reinforces the doodle style so Atlas Edit does not switch aesthetics', () => {
    const out = buildCharacterContinuationEditPrompt('in a kitchen');
    expect(out).toContain('hand-drawn doodle style');
    expect(out).toContain('thick uneven black ink outlines');
  });

  it('produces a stable shape regardless of input length', () => {
    const short = buildCharacterContinuationEditPrompt('a');
    const long = buildCharacterContinuationEditPrompt('a'.repeat(500));
    // Both should start with the same preamble.
    expect(short.startsWith('Modify this image to show the SAME character')).toBe(true);
    expect(long.startsWith('Modify this image to show the SAME character')).toBe(true);
  });
});

// ─── generateCharacterContinuationImage input validation ──────────────
//
// The full Atlas Edit chain is integration-tested via the smoke script
// at scripts/smoke-atlas-edit-character-continuity.ts (costs ~$0.02 per
// run). Here we only verify the cheap input-validation guards so the
// stage handler can rely on consistent error-shape feedback when
// upstream data is bad.

describe('generateCharacterContinuationImage input validation', () => {
  it('returns error when baseImageUrl is empty', async () => {
    const result = await generateCharacterContinuationImage({
      baseImageUrl: '',
      characterId: 'george',
      newScenePrompt: 'running through snow',
    });
    expect(result.imageUrl).toBeUndefined();
    expect(result.error).toBe('empty_base_image_url');
    expect(result.costUsd).toBe(0);
  });

  it('returns error when baseImageUrl is only whitespace', async () => {
    const result = await generateCharacterContinuationImage({
      baseImageUrl: '   \n\t  ',
      characterId: 'george',
      newScenePrompt: 'running through snow',
    });
    expect(result.error).toBe('empty_base_image_url');
  });

  it('returns error when characterId is empty', async () => {
    const result = await generateCharacterContinuationImage({
      baseImageUrl: 'https://example.com/base.png',
      characterId: '',
      newScenePrompt: 'running through snow',
    });
    expect(result.error).toBe('empty_character_id');
    expect(result.costUsd).toBe(0);
  });

  it('returns error when newScenePrompt is empty', async () => {
    const result = await generateCharacterContinuationImage({
      baseImageUrl: 'https://example.com/base.png',
      characterId: 'george',
      newScenePrompt: '',
    });
    expect(result.error).toBe('empty_scene_prompt');
    expect(result.costUsd).toBe(0);
  });

  it('never throws on bad input — returns errors via the result envelope', async () => {
    // The stage handler expects { error } returns, not exceptions.
    // Confirms the contract: input validation failures are quiet
    // returns, not panics.
    await expect(
      generateCharacterContinuationImage({
        baseImageUrl: '',
        characterId: '',
        newScenePrompt: '',
      }),
    ).resolves.toBeDefined();
  });
});
