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

  it('bake without safe-top positions OST in the lower-center safe area (Phase 1.5 Bug C)', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
    });
    // Phase 1.5 (Bug C): the previous "within the scene" wording let
    // year-shaped OST values land near the top edge where the
    // dispatcher's 7.8% center-crop sliced into them. The new wording
    // anchors the text to the lower-center safe area and explicitly
    // bans the top edge.
    expect(out.prompt).toContain('in the lower-center portion of the frame');
    expect(out.prompt).toContain('never near the top edge');
    expect(out.prompt).not.toContain('within the scene');
  });

  it('bake mode appends an explicit anti-top-edge reinforcement clause for text/numerals (Phase 1.5 Bug C)', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: '1945',
      onScreenTextMode: 'bake',
    });
    // The reinforcement is what stops the diffusion model from
    // treating year-shaped values as title graphics and placing them
    // flush against the top edge.
    expect(out.prompt).toContain('AT LEAST 15% empty margin from the top edge');
    expect(out.prompt).toContain(
      'Any hand-lettered text, title, or numeral inside the picture sits AT LEAST 15% inside from the top edge — never touching it.',
    );
  });

  it('overlay mode omits the OST-specific anti-top-edge reinforcement', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: '1945',
      onScreenTextMode: 'overlay',
    });
    // The reinforcement is gated on shouldBakeOst — when the OST is
    // rendered as a Remotion overlay (not baked into the diffusion),
    // the model has no text to mis-place, so the additional clause
    // would just add prompt overhead for no benefit.
    expect(out.prompt).not.toContain('AT LEAST 15% empty margin');
    expect(out.prompt).not.toContain('Any hand-lettered text, title, or numeral');
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
    // Phase 1.5 (Bug C): the OST-bake path now appends an explicit
    // anti-top-edge reinforcement clause AND tightens the OST position
    // wording with the "well inside the visible safe area, never near
    // the top edge" trailing constraint. Both are gated on
    // shouldBakeOst — only this snapshot needs the updated expectation
    // (the section-title snapshot below has no OST so it's unaffected).
    expect(out.prompt).toBe(
      SAFE_EDGE_PREFIX
      + 'Any hand-lettered text, title, or numeral inside the picture sits AT LEAST 15% inside from the top edge — never touching it.\n\n'
      + 'Wide composition with an empty open sky or plain low-detail background across the upper portion of the frame. All characters, faces, objects, and key details sit in the lower portion.\n\n'
      + 'Hand-lettered text "EUREKA" drawn large in bold marker style in the lower portion of the frame, well inside the visible safe area, never near the top edge, in the illustration\'s own style. The text must sit with AT LEAST 15% empty margin from the top edge of the canvas.\n\n'
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

// ─── Phase 2 (Character Bible) — augmenter integration ──────────────────────

describe('augmentCellPrompt — character bible (Phase 2)', () => {
  const BASE = {
    promptCap: SINGLE_SHOT_PROMPT_CAP,
  };

  it('prepends the character bible at the VERY TOP of the final prompt', () => {
    const out = augmentCellPrompt({
      ...BASE,
      prompt: 'A wide shot of the burning house.',
      characterDescriptions: {
        george: 'Gray hair, mustache, dark vest.',
        jennie: 'Yellow dress, brown hair.',
      },
    });
    // The bible MUST come before the safe-edge directive so the
    // model sees the reference at the top of its prompt window.
    const biblePos = out.prompt.indexOf('Character reference for this scene:');
    const safeEdgePos = out.prompt.indexOf('Composition fits fully inside');
    const bodyPos = out.prompt.indexOf('A wide shot of the burning house.');
    expect(biblePos).toBeGreaterThanOrEqual(0);
    expect(safeEdgePos).toBeGreaterThan(biblePos);
    expect(bodyPos).toBeGreaterThan(safeEdgePos);
    expect(out.prompt).toContain('- george: Gray hair, mustache, dark vest.');
    expect(out.prompt).toContain('- jennie: Yellow dress, brown hair.');
  });

  it('omits the bible when characterDescriptions is undefined (back-compat)', () => {
    const out = augmentCellPrompt({
      ...BASE,
      prompt: 'A scene body.',
    });
    expect(out.prompt).not.toContain('Character reference for this scene:');
  });

  it('omits the bible when characterDescriptions is empty', () => {
    const out = augmentCellPrompt({
      ...BASE,
      prompt: 'A scene body.',
      characterDescriptions: {},
    });
    expect(out.prompt).not.toContain('Character reference for this scene:');
  });

  it('counts the bible in fixedOverhead so the body budget shrinks accordingly', () => {
    const withoutBible = augmentCellPrompt({
      ...BASE,
      prompt: 'Body.',
    });
    const withBible = augmentCellPrompt({
      ...BASE,
      prompt: 'Body.',
      characterDescriptions: {
        george: 'Gray hair, mustache, dark vest, brown trousers, suspenders.',
      },
    });
    expect(withBible.fixedOverhead).toBeGreaterThan(withoutBible.fixedOverhead);
    expect(withBible.promptBudget).toBeLessThan(withoutBible.promptBudget);
  });
});
