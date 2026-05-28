import { describe, expect, it } from 'vitest';
import { autoGroupVariants, DEFAULT_SUBTLE_MOTION_DELTA } from '@/lib/auto-group-variants';

// Build a minimal row for testing. The function only reads
// `ai_image_prompt`, `visual_type`, and the mutable `group_id` /
// `variant_index` / `variant_edit_prompt` fields; everything else is
// pass-through.
function row(prompt: string, opts: { visual_type?: string; group_id?: string } = {}) {
  return {
    timecode: '0:00',
    script_text: 'narration here',
    visual_type: opts.visual_type ?? 'Animation',
    visual_description: 'desc',
    ai_image_prompt: prompt,
    ...(opts.group_id ? { group_id: opts.group_id } : {}),
  };
}

const STONE_AGE_BASE =
  'two stick-figure cavemen standing on a stone plain looking at each other, mountains behind them, neutral expressions, soft cream skin tone, the left caveman wears a yellow zigzag tunic, the right one has long hair and brown wrap';

const STONE_AGE_VARIANT_1 =
  'two stick-figure cavemen standing on a stone plain looking at each other, mountains behind them, the left caveman now has blood dripping from the side of his head and his hand raised to it, soft cream skin tone, yellow zigzag tunic and brown wrap';

const STONE_AGE_VARIANT_2 =
  'two stick-figure cavemen standing on a stone plain, the left caveman still has blood on his head and hand raised, the right caveman now has open mouth and both arms raised wide with a red question mark floating above his head, mountains behind';

describe('autoGroupVariants — happy path on the Stone Age sequence', () => {
  it('groups 3 consecutive similar rows into a single variant group', () => {
    const rows = [
      row(STONE_AGE_BASE),
      row(STONE_AGE_VARIANT_1),
      row(STONE_AGE_VARIANT_2),
    ];
    const result = autoGroupVariants(rows);
    expect(result.groupCount).toBe(1);
    expect(result.mergedRowCount).toBe(2);

    // Base row keeps its prompt and gets variant_index = 0.
    expect(rows[0].ai_image_prompt).toBe(STONE_AGE_BASE);
    expect((rows[0] as Record<string, unknown>).variant_index).toBe(0);
    expect(typeof (rows[0] as Record<string, unknown>).group_id).toBe('string');

    // Variant rows lose their prompt and gain variant_index + delta.
    expect(rows[1].ai_image_prompt).toBe('');
    expect((rows[1] as Record<string, unknown>).variant_index).toBe(1);
    expect((rows[1] as Record<string, unknown>).variant_edit_prompt).toEqual(
      expect.stringMatching(/blood.*hand/i),
    );

    expect(rows[2].ai_image_prompt).toBe('');
    expect((rows[2] as Record<string, unknown>).variant_index).toBe(2);
    expect((rows[2] as Record<string, unknown>).variant_edit_prompt).toEqual(
      expect.stringMatching(/red question mark|arms raised wide/i),
    );

    // All three share the same group_id.
    const gid = (rows[0] as Record<string, unknown>).group_id;
    expect((rows[1] as Record<string, unknown>).group_id).toBe(gid);
    expect((rows[2] as Record<string, unknown>).group_id).toBe(gid);
  });

  it('uses the imperative voice in extracted deltas (add / draw / ...)', () => {
    const rows = [row(STONE_AGE_BASE), row(STONE_AGE_VARIANT_1)];
    autoGroupVariants(rows);
    const delta = (rows[1] as Record<string, unknown>).variant_edit_prompt as string;
    expect(delta).toMatch(/^keep the base composition identical, (add|draw|place|show|put|make|change|raise|drop|open|close|highlight|colour|color)\b/i);
  });
});

describe('autoGroupVariants — caps and limits', () => {
  it('caps a group at 4 rows (1 base + 3 variants) by default', () => {
    const baseLike = (extra: string) =>
      `a cartoon stick figure scientist with gray lab coat and blue tie standing in front of a chalkboard with a serious expression and a small pen in hand${extra ? ', ' + extra : ''}`;
    const rows = [
      row(baseLike('')),
      row(baseLike('a small red question mark appears above the head')),
      row(baseLike('the question mark grows larger and turns yellow')),
      row(baseLike('the lab coat is now stained with green liquid splotches')),
      row(baseLike('the figure is now waving both arms wildly in panic')),
    ];
    autoGroupVariants(rows);
    expect((rows[0] as Record<string, unknown>).variant_index).toBe(0);
    expect((rows[1] as Record<string, unknown>).variant_index).toBe(1);
    expect((rows[2] as Record<string, unknown>).variant_index).toBe(2);
    expect((rows[3] as Record<string, unknown>).variant_index).toBe(3);
    // 5th row is similar but exceeds the cap → must remain standalone.
    expect((rows[4] as Record<string, unknown>).variant_index).toBeUndefined();
    expect((rows[4] as Record<string, unknown>).group_id).toBeUndefined();
  });

  it('honors a custom maxGroupSize', () => {
    const baseLike = (extra: string) =>
      `cartoon scientist holding a beaker of blue liquid${extra ? ', ' + extra : ''}`;
    const rows = [
      row(baseLike('')),
      row(baseLike('the liquid turns red')),
      row(baseLike('the liquid is now bubbling vigorously')),
    ];
    autoGroupVariants(rows, { maxGroupSize: 2 });
    expect((rows[0] as Record<string, unknown>).variant_index).toBe(0);
    expect((rows[1] as Record<string, unknown>).variant_index).toBe(1);
    // 3rd row falls outside the 2-row cap.
    expect((rows[2] as Record<string, unknown>).variant_index).toBeUndefined();
  });
});

describe('autoGroupVariants — eligibility skips', () => {
  it('skips Title Card / Talking Head / Screen Recording rows', () => {
    const rows = [
      row(STONE_AGE_BASE, { visual_type: 'Title Card' }),
      row(STONE_AGE_VARIANT_1, { visual_type: 'Title Card' }),
      row(STONE_AGE_VARIANT_2, { visual_type: 'Title Card' }),
    ];
    const result = autoGroupVariants(rows);
    expect(result.groupCount).toBe(0);
    expect((rows[0] as Record<string, unknown>).variant_index).toBeUndefined();
  });

  it('respects rows that already carry a group_id (LLM already grouped them)', () => {
    const rows = [
      row(STONE_AGE_BASE, { group_id: 'preexisting-id' }),
      row(STONE_AGE_VARIANT_1, { group_id: 'preexisting-id' }),
    ];
    const result = autoGroupVariants(rows);
    expect(result.groupCount).toBe(0);
    // Pre-existing group_id preserved unchanged.
    expect((rows[0] as Record<string, unknown>).group_id).toBe('preexisting-id');
    expect((rows[1] as Record<string, unknown>).group_id).toBe('preexisting-id');
  });

  it('skips rows whose ai_image_prompt is too short', () => {
    const rows = [row('short'), row('also short')];
    const result = autoGroupVariants(rows);
    expect(result.groupCount).toBe(0);
  });
});

describe('autoGroupVariants — boundary cases that should NOT group', () => {
  it('does not group two unrelated scenes', () => {
    const rows = [
      row(
        'a single doodle stick figure scientist standing alone on a pure white background looking down at an empty petri dish in their hand',
      ),
      row(
        'a wide cartoon landscape of red rocky desert with two cartoon cactuses and a small adobe house under a bright orange sun, no character visible',
      ),
    ];
    const result = autoGroupVariants(rows);
    expect(result.groupCount).toBe(0);
    expect((rows[0] as Record<string, unknown>).variant_index).toBeUndefined();
    expect((rows[1] as Record<string, unknown>).variant_index).toBeUndefined();
  });

  it('does not group when the variant has no novel content (just a rewording)', () => {
    const rows = [
      row(
        'a single doodle stick figure scientist standing alone on a pure white background looking down at an empty petri dish in their hand',
      ),
      row(
        'a doodle stick figure scientist standing alone on white background looking down at an empty petri dish in their hand',
      ),
    ];
    const result = autoGroupVariants(rows);
    // Same content reworded → no extractable delta → no group.
    expect(result.groupCount).toBe(0);
  });

  it('does not group unrelated scenes that share a long appended style suffix (the user-reported tent/bodies/avalanche bug)', () => {
    // Reproduces the 2026-05-27 bug: with the trimmed doodle_explainer_2
    // suffix (~560 chars) appended to every row's ai_image_prompt by
    // attachStyleSuffixToRows, three semantically-unrelated Dyatlov Pass
    // scenes were being grouped because the ~60 shared suffix tokens
    // alone pushed overlapSimilarity above the 0.55 threshold. The
    // common-suffix strip in overlapSimilarity should let the scene
    // bodies dominate the comparison again.
    const SUFFIX =
      ' Hand-drawn stick-figure cartoon on plain white background, child-like freehand pen-and-ink style, asdfmovie / Cyanide & Happiness aesthetic. Thick uneven black ink lines. Muted flat color fills (pale blue, pale yellow, light gray) on scene props — buildings, books, icons, signs. Occasional saturated red for danger or alarm. Real photos and realistic objects integrate naturally with the cartoon — e.g. a doodle character holding a photographic real product, or a framed real photograph with a thick coloured border embedded in the scene. Generous white space.';

    const rows = [
      row('Wide shot of tiny hikers on a snowy mountain slope, bleak daylight, empty white space, ominous mood.' + SUFFIX),
      row('Medium shot of a torn tent with a jagged slit, cold moonlight, tense stillness.' + SUFFIX),
      row('Close-up of a cracked hiking boot and broken gear in snow, harsh contrast, grim insert.' + SUFFIX),
      row('Wide shot of a snow slab sliding over a tent, pale daylight, explanatory diagram feel.' + SUFFIX),
    ];
    const result = autoGroupVariants(rows);
    // Each scene is a completely different beat (hikers walking, torn
    // tent, broken gear, avalanche diagram). None should group.
    expect(result.groupCount).toBe(0);
    for (const r of rows) {
      expect((r as Record<string, unknown>).variant_index).toBeUndefined();
      expect((r as Record<string, unknown>).group_id).toBeUndefined();
    }
  });
});

describe('autoGroupVariants — interleaving with standalone rows', () => {
  it('forms multiple groups interleaved with standalones (Stone Age 3 groups in sequence)', () => {
    const groupA1 = STONE_AGE_BASE;
    const groupA2 = STONE_AGE_VARIANT_1;
    const standalone = 'a wide cartoon landscape of a snowy mountain peak with no character, dramatic gray sky and small swirling wind lines';
    const groupB1 = 'two cartoon stone flints lying on plain white background, gray with chipped edges, no character';
    const groupB2 = 'two cartoon stone flints lying on white background, gray with chipped edges, AND a third stone knife with a brown-wrapped handle next to them';

    const rows = [row(groupA1), row(groupA2), row(standalone), row(groupB1), row(groupB2)];
    const result = autoGroupVariants(rows);

    expect(result.groupCount).toBe(2);
    expect(result.mergedRowCount).toBe(2);

    // Group A: rows 0 + 1
    const gidA = (rows[0] as Record<string, unknown>).group_id;
    expect((rows[1] as Record<string, unknown>).group_id).toBe(gidA);
    expect((rows[0] as Record<string, unknown>).variant_index).toBe(0);
    expect((rows[1] as Record<string, unknown>).variant_index).toBe(1);

    // Standalone row 2 — no group assignment.
    expect((rows[2] as Record<string, unknown>).group_id).toBeUndefined();
    expect((rows[2] as Record<string, unknown>).variant_index).toBeUndefined();

    // Group B: rows 3 + 4 (different group_id from A).
    const gidB = (rows[3] as Record<string, unknown>).group_id;
    expect(gidB).not.toBe(gidA);
    expect((rows[4] as Record<string, unknown>).group_id).toBe(gidB);
  });
});

describe('autoGroupVariants — returns are stable and mutate-in-place', () => {
  it('returns the same array reference passed in', () => {
    const rows = [row(STONE_AGE_BASE), row(STONE_AGE_VARIANT_1)];
    const result = autoGroupVariants(rows);
    expect(result.rows).toBe(rows);
  });

  it('produces no groups on an empty array', () => {
    const rows: ReturnType<typeof row>[] = [];
    const result = autoGroupVariants(rows);
    expect(result.groupCount).toBe(0);
    expect(result.mergedRowCount).toBe(0);
    expect(result.identicalPromptMerges).toBe(0);
    expect(result.rows).toBe(rows);
  });
});

// ─── Phase 1.5 (Bug B) — identical-prompt fast-path ──────────────────────────
//
// The doodle_explainer_2 "near-static animation" pattern: the LLM emits the
// same `ai_image_prompt` on consecutive rows to signal "same scene, slight
// motion variation between frames." Pre-fix the auto-grouper bailed because
// `extractDelta` returned null (no suffix delta, no novel words). Now it
// synthesizes `DEFAULT_SUBTLE_MOTION_DELTA` so the existing variant
// dispatcher still runs Atlas Edit and produces a sibling frame. Spec:
// _plans/2026-05-28-doodle-2-phase-1-5-completion.md.

const SODDER_HOUSE_PROMPT =
  'A modest two-story family house at night with a warm window glow, George Sodder in a simple bed inside, looking calm and unaware. Dark blue sky, quiet yard, plain white space around the scene, wide angle, simple cartoon composition.';

describe('autoGroupVariants — identical-prompt fast-path (Phase 1.5 Bug B)', () => {
  it('groups two consecutive byte-identical prompts as a sibling pair with the default motion delta', () => {
    const rows = [row(SODDER_HOUSE_PROMPT), row(SODDER_HOUSE_PROMPT)];
    const result = autoGroupVariants(rows);

    expect(result.groupCount).toBe(1);
    expect(result.mergedRowCount).toBe(1);
    expect(result.identicalPromptMerges).toBe(1);

    expect(rows[0].ai_image_prompt).toBe(SODDER_HOUSE_PROMPT);
    expect((rows[0] as Record<string, unknown>).variant_index).toBe(0);

    expect(rows[1].ai_image_prompt).toBe('');
    expect((rows[1] as Record<string, unknown>).variant_index).toBe(1);
    expect((rows[1] as Record<string, unknown>).variant_edit_prompt).toBe(
      DEFAULT_SUBTLE_MOTION_DELTA,
    );

    const gid = (rows[0] as Record<string, unknown>).group_id;
    expect(typeof gid).toBe('string');
    expect((rows[1] as Record<string, unknown>).group_id).toBe(gid);
  });

  it('groups three consecutive byte-identical prompts with the default delta on both variants', () => {
    const rows = [
      row(SODDER_HOUSE_PROMPT),
      row(SODDER_HOUSE_PROMPT),
      row(SODDER_HOUSE_PROMPT),
    ];
    const result = autoGroupVariants(rows);

    expect(result.groupCount).toBe(1);
    expect(result.mergedRowCount).toBe(2);
    expect(result.identicalPromptMerges).toBe(2);

    expect((rows[1] as Record<string, unknown>).variant_edit_prompt).toBe(
      DEFAULT_SUBTLE_MOTION_DELTA,
    );
    expect((rows[2] as Record<string, unknown>).variant_edit_prompt).toBe(
      DEFAULT_SUBTLE_MOTION_DELTA,
    );
    expect((rows[1] as Record<string, unknown>).variant_index).toBe(1);
    expect((rows[2] as Record<string, unknown>).variant_index).toBe(2);
  });

  it('leaves an unrelated third row standalone after a duplicate pair', () => {
    const UNRELATED =
      'A cluttered investigation office with stacks of paper notes and tip letters covering a desk, anonymous handwriting, single hanging lamp, medium-wide composition.';
    const rows = [
      row(SODDER_HOUSE_PROMPT),
      row(SODDER_HOUSE_PROMPT),
      row(UNRELATED),
    ];
    const result = autoGroupVariants(rows);

    expect(result.groupCount).toBe(1);
    expect(result.mergedRowCount).toBe(1);
    expect(result.identicalPromptMerges).toBe(1);

    // Row 2 stays standalone — no group_id, no variant_index.
    expect((rows[2] as Record<string, unknown>).group_id).toBeUndefined();
    expect((rows[2] as Record<string, unknown>).variant_index).toBeUndefined();
    expect(rows[2].ai_image_prompt).toBe(UNRELATED);
  });

  it('non-identical "real delta" pairs do NOT bump identicalPromptMerges', () => {
    const rows = [row(STONE_AGE_BASE), row(STONE_AGE_VARIANT_1)];
    const result = autoGroupVariants(rows);
    expect(result.groupCount).toBe(1);
    expect(result.mergedRowCount).toBe(1);
    // The Stone Age pair has a real suffix delta — the counter stays at 0.
    expect(result.identicalPromptMerges).toBe(0);
    expect((rows[1] as Record<string, unknown>).variant_edit_prompt).not.toBe(
      DEFAULT_SUBTLE_MOTION_DELTA,
    );
  });
});
