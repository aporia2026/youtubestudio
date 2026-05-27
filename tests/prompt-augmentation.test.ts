import { describe, expect, it, vi } from 'vitest';
import {
  augmentCellPrompt,
  COLLAGE_CELL_PROMPT_CAP,
  SINGLE_SHOT_PROMPT_CAP,
} from '@/lib/prompt-augmentation';

// Silence the truncation log line — it's tested separately via the
// `truncated` flag on the return value.
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const BASE = {
  prompt: 'A scientist holding a glowing test tube in a dim lab',
  promptCap: SINGLE_SHOT_PROMPT_CAP,
} as const;

describe('augmentCellPrompt — OST baking', () => {
  it('bake mode with text produces leading + trailing OST directives', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
    });
    expect(out.ostBaked).toBe(true);
    expect(out.prompt).toContain('Hand-lettered text "EUREKA"');
    expect(out.prompt).toContain('Text shown: "EUREKA".');
    // Trailing directive must sit AFTER the body (late tokens are weighted).
    const bodyIdx = out.prompt.indexOf(BASE.prompt);
    const trailingIdx = out.prompt.indexOf('Text shown:');
    expect(trailingIdx).toBeGreaterThan(bodyIdx);
  });

  it('overlay mode produces no OST directives even with text', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
      onScreenTextMode: 'overlay',
    });
    expect(out.ostBaked).toBe(false);
    expect(out.prompt).not.toContain('Hand-lettered');
    expect(out.prompt).not.toContain('Text shown');
  });

  it('none mode produces no OST directives even with text', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
      onScreenTextMode: 'none',
    });
    expect(out.ostBaked).toBe(false);
    expect(out.prompt).not.toContain('Hand-lettered');
  });

  it('bake mode with empty text produces no OST directives', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: '',
      onScreenTextMode: 'bake',
    });
    expect(out.ostBaked).toBe(false);
    expect(out.prompt).not.toContain('Hand-lettered');
  });

  it('omitted onScreenTextMode defaults to bake (back-compat)', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
    });
    expect(out.ostBaked).toBe(true);
  });

  it('sanitises newlines and caps OST length at 120 chars', () => {
    const longText = 'a'.repeat(200) + '\n\nINJECTED';
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: longText,
      onScreenTextMode: 'bake',
    });
    // 120-char cap means INJECTED never reaches the prompt.
    expect(out.prompt).not.toContain('INJECTED');
    // No raw newlines from the user input.
    expect(out.prompt).not.toMatch(/[\r\n]INJECTED/);
  });

  it('escapes double quotes inside OST so they cannot break the directive string', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'SAY "HI"',
      onScreenTextMode: 'bake',
    });
    expect(out.prompt).toContain('Hand-lettered text "SAY \\"HI\\""');
  });
});

describe('augmentCellPrompt — safe-edge guard', () => {
  // The safe-edge directive is always-on (no input gates it off) so it
  // appears on every output. See the always-on history note in the
  // module docstring.
  const SAFE_EDGE_HEAD = 'Composition fits fully inside the visible frame with AT LEAST 10% empty margin from every edge.';

  it('always prepends the safe-edge directive — minimal input', () => {
    const out = augmentCellPrompt({ ...BASE });
    expect(out.safeEdge).toBe(true);
    expect(out.prompt.startsWith(SAFE_EDGE_HEAD)).toBe(true);
  });

  it('always prepends the safe-edge directive — full input', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'overlay',
      styleSheetDescription: 'flat 2D vector',
    });
    expect(out.safeEdge).toBe(true);
    expect(out.prompt.startsWith(SAFE_EDGE_HEAD)).toBe(true);
  });

  it('safe-edge sits before safe-top in the final prompt', () => {
    const out = augmentCellPrompt({
      ...BASE,
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'overlay',
    });
    const edgeIdx = out.prompt.indexOf(SAFE_EDGE_HEAD);
    const topIdx = out.prompt.indexOf('Wide composition with an empty open sky');
    expect(edgeIdx).toBe(0);
    expect(topIdx).toBeGreaterThan(edgeIdx);
  });
});

describe('augmentCellPrompt — safe-top bias', () => {
  it('fires only when sectionTitle non-empty AND layout is overlay', () => {
    const out = augmentCellPrompt({
      ...BASE,
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'overlay',
    });
    expect(out.safeTop).toBe(true);
    expect(out.prompt).toContain('Wide composition with an empty open sky');
  });

  it('suppressed when layout is letterbox', () => {
    const out = augmentCellPrompt({
      ...BASE,
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'letterbox',
    });
    expect(out.safeTop).toBe(false);
    expect(out.prompt).not.toContain('Wide composition with an empty open sky');
  });

  it('suppressed when sectionTitle is empty', () => {
    const out = augmentCellPrompt({
      ...BASE,
      sectionTitle: '',
      sectionTitleLayout: 'overlay',
    });
    expect(out.safeTop).toBe(false);
  });

  it('omitted sectionTitleLayout defaults to letterbox → no safe-top', () => {
    const out = augmentCellPrompt({
      ...BASE,
      sectionTitle: 'Chapter 1',
    });
    expect(out.safeTop).toBe(false);
  });

  it('safe-top + bake combo positions OST in the lower portion', () => {
    const out = augmentCellPrompt({
      ...BASE,
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'overlay',
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
    });
    expect(out.safeTop).toBe(true);
    expect(out.ostBaked).toBe(true);
    expect(out.prompt).toContain('in the lower portion of the frame');
  });

  it('bake without safe-top positions OST within the scene', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
    });
    expect(out.prompt).toContain('within the scene');
    expect(out.prompt).not.toContain('in the lower portion');
  });
});

describe('augmentCellPrompt — sheet description', () => {
  it('appends sheet description at the tail when non-empty', () => {
    const out = augmentCellPrompt({
      ...BASE,
      styleSheetDescription: 'flat 2D vector illustration, pastel palette',
    });
    expect(out.sheetDesc).toBe(true);
    expect(out.prompt.endsWith('flat 2D vector illustration, pastel palette.')).toBe(true);
    expect(out.prompt).toContain('Maintain visual continuity');
  });

  it('omits sheet description when empty', () => {
    const out = augmentCellPrompt({ ...BASE, styleSheetDescription: '' });
    expect(out.sheetDesc).toBe(false);
    expect(out.prompt).not.toContain('Maintain visual continuity');
  });

  it('sanitises newlines and caps at 240 chars', () => {
    const longDesc = 'b'.repeat(400) + '\n\nINJECTED_SHEET';
    const out = augmentCellPrompt({ ...BASE, styleSheetDescription: longDesc });
    expect(out.prompt).not.toContain('INJECTED_SHEET');
  });
});

describe('augmentCellPrompt — truncation', () => {
  it('does not truncate when the body fits within the budget', () => {
    const out = augmentCellPrompt({ ...BASE });
    expect(out.truncated).toBe(false);
    expect(out.finalBodyLen).toBe(BASE.prompt.length);
  });

  it('truncates the body when augmentation overhead pushes it past the cap', () => {
    const longBody = 'word '.repeat(200); // ~1000 chars
    const out = augmentCellPrompt({
      prompt: longBody,
      promptCap: COLLAGE_CELL_PROMPT_CAP,
    });
    expect(out.truncated).toBe(true);
    expect(out.prompt.length).toBeLessThanOrEqual(COLLAGE_CELL_PROMPT_CAP);
  });

  it('respects the minimum body budget of 200 chars even if overhead is huge', () => {
    // Force a large overhead by combining every directive at its cap.
    const out = augmentCellPrompt({
      prompt: 'short body',
      onScreenText: 'a'.repeat(120),
      onScreenTextMode: 'bake',
      sectionTitle: 'title',
      sectionTitleLayout: 'overlay',
      styleSheetDescription: 'c'.repeat(240),
      promptCap: COLLAGE_CELL_PROMPT_CAP,
    });
    expect(out.promptBudget).toBeGreaterThanOrEqual(200);
  });

  it('preserves the body verbatim when no per-input directives apply (safe-edge is still prepended)', () => {
    const body = 'A short scene';
    const out = augmentCellPrompt({
      prompt: body,
      promptCap: SINGLE_SHOT_PROMPT_CAP,
    });
    expect(out.truncated).toBe(false);
    expect(out.prompt.endsWith(body)).toBe(true);
    // Body sits intact after the safe-edge prefix.
    expect(out.finalBodyLen).toBe(body.length);
  });
});

describe('augmentCellPrompt — full prompt composition', () => {
  // Snapshot the exact assembled string for representative inputs so a
  // future edit to any directive surfaces here. Safe-edge is always-on
  // and leads every output.
  const SAFE_EDGE_PREFIX =
    'Composition fits fully inside the visible frame with AT LEAST 10% empty margin from every edge. No text, faces, callouts, props, titles, or background elements extend within 10% of the top, bottom, left, or right edge of the canvas. All important content is centered in the inner 80% of the frame.\n\n';

  it('snapshots sectionTitle + overlay + bake OST', () => {
    const out = augmentCellPrompt({
      prompt: 'A scientist',
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'overlay',
      promptCap: SINGLE_SHOT_PROMPT_CAP,
    });
    expect(out.prompt).toBe(
      SAFE_EDGE_PREFIX
      + 'Wide composition with an empty open sky or plain low-detail background across the upper portion of the frame. All characters, faces, objects, and key details sit in the lower portion.\n\n'
      + 'Hand-lettered text "EUREKA" drawn large in bold marker style in the lower portion of the frame, in the illustration\'s own style.\n\n'
      + 'A scientist'
      + '\n\nText shown: "EUREKA".',
    );
  });

  it('snapshots minimal input — body wrapped only by the safe-edge prefix', () => {
    const out = augmentCellPrompt({
      prompt: 'A scientist',
      promptCap: SINGLE_SHOT_PROMPT_CAP,
    });
    expect(out.prompt).toBe(SAFE_EDGE_PREFIX + 'A scientist');
    expect(out.fixedOverhead).toBe(SAFE_EDGE_PREFIX.length);
  });

  it('snapshots sheet-description-only case', () => {
    const out = augmentCellPrompt({
      prompt: 'A scientist',
      styleSheetDescription: 'flat 2D vector',
      promptCap: SINGLE_SHOT_PROMPT_CAP,
    });
    expect(out.prompt).toBe(
      SAFE_EDGE_PREFIX
      + 'A scientist\n\nMaintain visual continuity with the established style: flat 2D vector.',
    );
  });
});
