import { describe, expect, it } from 'vitest';
import {
  buildDoodleVariantPrompt,
  clampVariantCount,
  parseDoodleVariantResult,
} from '@/lib/shorts-doodle-prompt';
import type { ShortCaptionChunk } from '@/lib/shorts-render-types';

function captionsOfLength(n: number): ShortCaptionChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    start_ms: i * 1000,
    end_ms: (i + 1) * 1000,
    text: `caption ${i}`,
  }));
}

describe('clampVariantCount', () => {
  it('returns 0 when there are no captions', () => {
    expect(clampVariantCount(6, 0)).toBe(0);
  });

  it('uses the default (6) when the request is non-finite', () => {
    expect(clampVariantCount(NaN, 10)).toBe(6);
    expect(clampVariantCount(Infinity, 10)).toBe(6);
    expect(clampVariantCount(0, 10)).toBe(6);
  });

  it('clamps the request to the absolute max (10)', () => {
    expect(clampVariantCount(50, 50)).toBe(10);
  });

  it('clamps the request to the caption count when smaller than the max', () => {
    expect(clampVariantCount(6, 3)).toBe(3);
  });

  it('rounds floats', () => {
    expect(clampVariantCount(4.6, 20)).toBe(5);
  });
});

describe('buildDoodleVariantPrompt', () => {
  const captions = captionsOfLength(8);

  it('embeds the niche and script in the user prompt', () => {
    const { user } = buildDoodleVariantPrompt({
      shortScript: 'Stop tying your shoes that way.',
      captions,
      niche: 'life hacks',
    });
    expect(user).toContain('life hacks');
    expect(user).toContain('Stop tying your shoes');
  });

  it('asks for the requested number of variants', () => {
    const { system, user } = buildDoodleVariantPrompt({
      shortScript: 'x',
      captions,
      niche: 'x',
      maxVariants: 4,
    });
    expect(system).toMatch(/ONE base scene \+ 4 sibling variants/);
    expect(user).toContain('4 sibling variants');
  });

  it('clamps maxVariants to the caption count', () => {
    const { system } = buildDoodleVariantPrompt({
      shortScript: 'x',
      captions: captionsOfLength(3),
      niche: 'x',
      maxVariants: 50,
    });
    expect(system).toMatch(/ONE base scene \+ 3 sibling variants/);
  });

  it('shows the caption chunks with their indices so the model can ground variants', () => {
    const { user } = buildDoodleVariantPrompt({
      shortScript: 'x',
      captions,
      niche: 'x',
    });
    for (let i = 0; i < captions.length; i++) {
      expect(user).toContain(`[${i}] caption ${i}`);
    }
  });

  it('demands strict JSON output with the contract shape', () => {
    const { system } = buildDoodleVariantPrompt({ shortScript: 'x', captions, niche: 'x' });
    expect(system).toMatch(/STRICTLY this JSON shape/);
    expect(system).toContain('base_prompt');
    expect(system).toContain('caption_chunk_start_index');
    expect(system).toContain('edit_prompt');
  });

  it('lists the Doodle visual contract guardrails', () => {
    const { system } = buildDoodleVariantPrompt({ shortScript: 'x', captions, niche: 'x' });
    // The middle-60% safe-zone rule is the load-bearing piece — fail loud
    // if a future rewrite drops it.
    expect(system).toMatch(/MIDDLE 60%|middle 60%/);
    expect(system).toMatch(/stick-figure|hand-drawn/);
    // No motion within a frame — comes from the user's "Atlas Edit
    // variants from a base, NEVER Remotion motion on a static image" memory.
    expect(system).toMatch(/sibling-frame|sibling/);
    expect(system).toMatch(/NO motion within a frame|NEVER ask for camera moves/);
  });

  it('truncates very long scripts to stay within budget', () => {
    const huge = 'word '.repeat(5000);
    const { user } = buildDoodleVariantPrompt({ shortScript: huge, captions, niche: 'x' });
    expect(user.length).toBeLessThan(8000);
  });
});

describe('parseDoodleVariantResult', () => {
  const valid = JSON.stringify({
    base_prompt:
      'A surprised cartoon character with round glasses standing in the middle of a white frame, holding a brown scroll, slight imperfect ink lines.',
    variants: [
      { caption_chunk_start_index: 0, edit_prompt: "The character's eyebrows raise and a yellow exclamation appears beside their head." },
      { caption_chunk_start_index: 3, edit_prompt: 'A small red flame appears on the brown scroll the character is holding.' },
      { caption_chunk_start_index: 6, edit_prompt: 'The background shifts from white to a soft blue sky with a single sun.' },
    ],
  });

  it('parses a well-formed response', () => {
    const r = parseDoodleVariantResult(valid, 8);
    expect(r.base_prompt).toMatch(/cartoon character/);
    expect(r.variants.length).toBe(3);
    expect(r.variants[0]!.caption_chunk_start_index).toBe(0);
    expect(r.variants[2]!.caption_chunk_start_index).toBe(6);
  });

  it('handles fenced JSON', () => {
    const fenced = '```json\n' + valid + '\n```';
    expect(() => parseDoodleVariantResult(fenced, 8)).not.toThrow();
  });

  it('throws on a missing or too-short base_prompt', () => {
    const bad = JSON.stringify({
      base_prompt: 'too short',
      variants: [{ caption_chunk_start_index: 0, edit_prompt: 'A change happens.' }],
    });
    expect(() => parseDoodleVariantResult(bad, 4)).toThrow(/base_prompt/);
  });

  it('throws when no variants survive validation', () => {
    const empty = JSON.stringify({
      base_prompt: 'A long-enough base scene description for the parser.',
      variants: [],
    });
    expect(() => parseDoodleVariantResult(empty, 4)).toThrow(/no usable variants/);
  });

  it('drops variants with non-numeric or negative chunk indexes', () => {
    const mixed = JSON.stringify({
      base_prompt: 'A long-enough base scene description for the parser.',
      variants: [
        { caption_chunk_start_index: 0, edit_prompt: 'Valid change here.' },
        { caption_chunk_start_index: -1, edit_prompt: 'Skipped (negative).' },
        { caption_chunk_start_index: 'two', edit_prompt: 'Skipped (string).' },
      ],
    });
    const r = parseDoodleVariantResult(mixed, 4);
    expect(r.variants.length).toBe(1);
  });

  it('clamps hallucinated out-of-range indexes to the last caption', () => {
    const tooFar = JSON.stringify({
      base_prompt: 'A long-enough base scene description for the parser.',
      variants: [
        { caption_chunk_start_index: 999, edit_prompt: 'Variant pointed past the end.' },
      ],
    });
    const r = parseDoodleVariantResult(tooFar, 6);
    expect(r.variants[0]!.caption_chunk_start_index).toBe(5);
  });

  it('dedupes variants that share the same chunk index', () => {
    const dupes = JSON.stringify({
      base_prompt: 'A long-enough base scene description for the parser.',
      variants: [
        { caption_chunk_start_index: 2, edit_prompt: 'First change here.' },
        { caption_chunk_start_index: 2, edit_prompt: 'Second change.' },
      ],
    });
    const r = parseDoodleVariantResult(dupes, 5);
    expect(r.variants.length).toBe(1);
  });

  it('drops variants with edit prompts shorter than 10 chars', () => {
    const tooShort = JSON.stringify({
      base_prompt: 'A long-enough base scene description for the parser.',
      variants: [
        { caption_chunk_start_index: 0, edit_prompt: 'short' },
        { caption_chunk_start_index: 1, edit_prompt: 'A proper change description.' },
      ],
    });
    const r = parseDoodleVariantResult(tooShort, 4);
    expect(r.variants.length).toBe(1);
  });

  it('sorts variants by chunk index', () => {
    const out_of_order = JSON.stringify({
      base_prompt: 'A long-enough base scene description for the parser.',
      variants: [
        { caption_chunk_start_index: 5, edit_prompt: 'Variant at five.' },
        { caption_chunk_start_index: 1, edit_prompt: 'Variant at one.' },
        { caption_chunk_start_index: 3, edit_prompt: 'Variant at three.' },
      ],
    });
    const r = parseDoodleVariantResult(out_of_order, 7);
    expect(r.variants.map((v) => v.caption_chunk_start_index)).toEqual([1, 3, 5]);
  });

  it('throws on unrecoverable input', () => {
    expect(() => parseDoodleVariantResult('not json', 4)).toThrow(/parse/i);
  });
});
