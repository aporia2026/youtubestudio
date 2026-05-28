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
    // v2 framing fix added a parenthetical reminder after the trailing
    // OST. The trailing directive now reads:
    //   Text shown: "EUREKA" (moderate size, well clear of top and bottom edges).
    expect(out.prompt).toContain('Text shown: "EUREKA"');
    expect(out.prompt).toContain('well clear of top and bottom edges');
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
  // module docstring. The 2026-05-28 framing fix consolidated the
  // directive into a single canonical 15% statement and removed the
  // separate ostSafeEdgeReinforcement to stop directive-stacking
  // producing tiny floating-head outputs on close-ups.
  const SAFE_EDGE_HEAD = 'Wide composition with empty whitespace padding across the top 15% and bottom 15% of the canvas.';

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
    const topIdx = out.prompt.indexOf('Bias the upper portion of the central safe zone');
    expect(edgeIdx).toBe(0);
    expect(topIdx).toBeGreaterThan(edgeIdx);
  });

  it('mentions "central 70%" exactly once and "15%" within an expected bound (no directive-stacking)', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'overlay',
    });
    // The 2026-05-28 framing fix removed `ostSafeEdgeReinforcement`
    // because re-stating the same constraint in multiple directive
    // names caused tiny floating-head outputs. Keep this assertion to
    // prevent re-introducing the bug.
    //
    // v2 framing fix: the OST directive now explicitly mentions "15%"
    // once more (anti-bottom-edge clause specific to text). That's
    // OK because the OST directive is GATED by shouldBakeOst — when
    // OST is overlay/none, no extra "15%" mention happens. The cap
    // below is sized to accommodate the bake path (3 from safe-edge
    // + 1 from OST anti-bottom-edge).
    const centralCount = (out.prompt.match(/central 70%/g) ?? []).length;
    const bandsCount = (out.prompt.match(/15%/g) ?? []).length;
    expect(centralCount).toBe(1);
    // safeEdgeDirective: "top 15%" + "bottom 15%" + "outer 15% bands" = 3
    // ostLeadingDirective (bake-only): "AT LEAST 15% empty whitespace below it" = 1
    // Total when baked: 4. When not baked: 3.
    expect(bandsCount).toBeLessThanOrEqual(4);
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
    expect(out.prompt).toContain('Bias the upper portion of the central safe zone');
  });

  it('suppressed when layout is letterbox', () => {
    const out = augmentCellPrompt({
      ...BASE,
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'letterbox',
    });
    expect(out.safeTop).toBe(false);
    expect(out.prompt).not.toContain('Bias the upper portion of the central safe zone');
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

  it('safe-top + bake combo positions OST in the lower portion of the safe zone', () => {
    const out = augmentCellPrompt({
      ...BASE,
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'overlay',
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
    });
    expect(out.safeTop).toBe(true);
    expect(out.ostBaked).toBe(true);
    expect(out.prompt).toContain('in the lower portion of the central safe zone');
    // v2 framing fix: even in the safe-top + bake combo, the OST must
    // still respect the bottom edge (the section-stripe-overlay case
    // doesn't change the bottom-edge constraint).
    expect(out.prompt).toContain('NEVER near the bottom edge');
  });

  it('bake without safe-top names BOTH top and bottom edges as no-go zones (2026-05-28 v2 framing fix)', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
    });
    // v2 framing fix: the OST directive itself now names BOTH top and
    // bottom edges explicitly. v1 only mentioned the top edge (relying
    // on safeEdgeDirective's global "bottom 15%" to cover the bottom),
    // but the OST-specific position language won the priority fight
    // with the global constraint and the model placed letter baselines
    // flush at the bottom edge on long OST strings. Naming both edges
    // inside the OST directive fixes the priority issue.
    expect(out.prompt).toContain('NEVER near the top edge');
    expect(out.prompt).toContain('NEVER near the bottom edge');
    expect(out.prompt).not.toContain('within the scene');
  });

  it('bake mode caps OST size at 20% of canvas height (2026-05-28 v2 framing fix)', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: '30,000 APPOINTMENTS',
      onScreenTextMode: 'bake',
    });
    // v1 framing fix said "drawn large in bold marker style" with no
    // size bound. On long OST strings the model produced text at ~30%
    // of canvas height, which guaranteed the bottom edge would be hit
    // regardless of position language. v2 fixes this by explicitly
    // capping size before mentioning position.
    expect(out.prompt).toContain('NO MORE than 20% of the total canvas height');
    expect(out.prompt).toContain('letters are NOT oversized');
  });

  it('bake mode asserts at least 15% empty whitespace below the lowest baseline (2026-05-28 v2)', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: 'APPOINTMENTS',
      onScreenTextMode: 'bake',
    });
    // Letter descenders ('y', 'p', 'g', 'q', 'j') extend below the
    // baseline; on all-caps text the baseline IS the lowest pixel.
    // Either way the directive must name the "lowest baseline of every
    // letter" so the model treats the descender as the relevant edge.
    expect(out.prompt).toContain('lowest baseline of every letter');
    expect(out.prompt).toContain('AT LEAST 15% empty whitespace below it before the bottom edge');
    expect(out.prompt).toContain('Letters must NEVER touch or cross the bottom edge');
  });

  it('overlay mode omits the OST-specific position clause entirely', () => {
    const out = augmentCellPrompt({
      ...BASE,
      onScreenText: '1945',
      onScreenTextMode: 'overlay',
    });
    // Overlay OST is composited by Remotion at render time — the
    // diffusion model has no text to mis-place, so the position clause
    // would add prompt overhead for no benefit.
    expect(out.prompt).not.toContain('Hand-lettered text');
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
    'Wide composition with empty whitespace padding across the top 15% and bottom 15% of the canvas. All characters, faces, text, props, and key details occupy the central 70% of the frame, with generous vertical breathing room. The image will be cropped at the top and bottom — anything placed in the outer 15% bands is lost. No element touches or extends past any edge of the canvas.\n\n';

  it('snapshots sectionTitle + overlay + bake OST', () => {
    const out = augmentCellPrompt({
      prompt: 'A scientist',
      onScreenText: 'EUREKA',
      onScreenTextMode: 'bake',
      sectionTitle: 'Chapter 1',
      sectionTitleLayout: 'overlay',
      promptCap: SINGLE_SHOT_PROMPT_CAP,
    });
    // 2026-05-28 v2 framing fix: ostLeadingDirective now caps size at
    // 20% of canvas height and names BOTH top + bottom edges as
    // no-go zones inside the directive itself (was relying on the
    // canonical safeEdgeDirective's global "bottom 15%" to apply to
    // OST, which the model ignored under priority competition with
    // the OST-specific position language).
    expect(out.prompt).toBe(
      SAFE_EDGE_PREFIX
      + 'Bias the upper portion of the central safe zone toward an empty open sky or plain low-detail background. All characters, faces, objects, and key details sit in the lower portion of the safe zone.\n\n'
      + 'Hand-lettered text "EUREKA" drawn in bold marker style at a moderate readable size (the text occupies NO MORE than 20% of the total canvas height; letters are NOT oversized), positioned in the lower portion of the central safe zone, slightly below the vertical middle, NEVER near the top edge and NEVER near the bottom edge, in the illustration\'s own style. The full text — including the lowest baseline of every letter — sits with AT LEAST 15% empty whitespace below it before the bottom edge of the canvas. Letters must NEVER touch or cross the bottom edge.\n\n'
      + 'A scientist'
      + '\n\nText shown: "EUREKA" (moderate size, well clear of top and bottom edges).',
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
    const safeEdgePos = out.prompt.indexOf('Wide composition with empty whitespace padding');
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
