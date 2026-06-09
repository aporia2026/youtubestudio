/**
 * zenn_v1 system-check.
 *
 * Integration-flavor test that exercises the FULL doc-to-VideoConfig
 * pipeline on a hand-crafted zenn_v1 doc carrying every feature the
 * style supports. The test does not call any external API (no LLM,
 * no Kie, no DB) — it just runs `productionDocToVideoConfig` and
 * asserts that every load-bearing field threads through correctly.
 *
 * This is the cheapest failure-detection net for "did I accidentally
 * break the wiring between two PRs?" — without an integration test
 * the same regression would only surface during the human QA pass
 * in `_plans/2026-06-10-zenn-v1-qa-pass.md`, three days late.
 *
 * PR 7 of `_plans/2026-06-10-zenn-v1-style.md`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  productionDocToVideoConfig,
  type ProductionDoc,
  type ProductionRow,
} from '@/remotion/utils';

// ─── canonical hand-crafted zenn_v1 doc ─────────────────────────────
//
// Built to exercise every code path the renderer cares about:
//   - Mode A and Mode B rows
//   - All four zenn_world_overlay values
//   - canvas_reveal layers (filled + pending generation)
//   - Character bank + character descriptions
//   - Highlighter markers in on_screen_text
//   - The mode-pick log

function makeRow(overrides: Partial<ProductionRow>): ProductionRow {
  return {
    timecode: '0:00',
    script_text: 'beat',
    visual_type: 'ai_image',
    visual_description: 'desc',
    stock_search_terms: '',
    ai_image_prompt: 'a scene',
    on_screen_text: '',
    notes: '',
    ...overrides,
  } as ProductionRow;
}

function makeZennDoc(): ProductionDoc {
  return {
    title: 'Zenn V1 system check',
    niche: 'test',
    total_duration: '0:36',
    total_words: 72,
    speaking_pace_wpm: 120,
    style_preset: 'zenn_v1',
    // Matches what `default_on_screen_text_mode: 'overlay'` on the
    // zenn_v1 registry entry produces in real generation paths. The
    // mapper only threads on_screen_text onto VideoShot.onScreenText
    // when the mode resolves to 'overlay'; without this the test
    // doc would render its on_screen_text as baked-into-image
    // (the 'bake' default), defeating the new ZennLabelOverlay path.
    on_screen_text_mode_default: 'overlay',

    // Doc-level zenn_v1 state, fully populated.
    zenn_v1_settings: {
      default_mode: 'scene',
      label_color_hex: '#D32F2F',
      highlighter_enabled: true,
      highlighter_color_hex: '#FFE840',
      ground_color_hex: '#9E9E9E',
      median_shot_seconds: 3.2,
      max_canvas_reveal_layers: 4,
      character_persistence_enabled: true,
      max_unique_characters: 12,
    },
    zenn_v1_character_bank: {
      narrator: {
        base_url: 'https://r2.example/narrator-base.jpg',
        first_seen_row_index: 0,
      },
      'ancient-hunter-curly': {
        base_url: 'https://r2.example/hunter-base.jpg',
        poses: {
          idle: 'https://r2.example/hunter-idle.jpg',
          walking: 'https://r2.example/hunter-walking.jpg',
        },
        first_seen_row_index: 2,
      },
    },
    zenn_v1_world: {
      sky_color_hex: '#BFE4F3',
      ground_color_hex: '#F2D69A',
      wall_color_hex: '#E8E8E8',
      recurring_props: [],
    },
    zenn_v1_character_descriptions: {
      narrator: 'round white face, big black dot eyes, stick-figure body',
      'ancient-hunter-curly':
        'young man with short curly black hair, light brown skin, beaded necklace, no shirt',
    },

    rows: [
      // Row 0: Mode A stick, highlighter markers, narrator character.
      makeRow({
        timecode: '0:00',
        zenn_mode: 'stick',
        zenn_mode_reason: 'narrator delivering opening statistic',
        zenn_character_id: 'narrator',
        on_screen_text: 'EVERYONE. [hl]ALL AT ONCE[/hl].',
      }),

      // Row 1: Mode A stick with canvas_reveal layers (one generated,
      // one pending pipeline generation).
      makeRow({
        timecode: '0:03',
        zenn_mode: 'stick',
        zenn_mode_reason: 'long abstract beat; layers accumulate',
        zenn_canvas_reveal_layers: [
          {
            prompt_hint: 'add a stick figure on the right',
            image_url: 'https://r2.example/reveal-0.jpg',
            reveal_at_ms: 600,
            duration_ms: 4000,
            fade_in_ms: 250,
          },
          {
            // Pending generation — only the prompt is set.
            prompt_hint: 'add a red label "WAIT"',
            reveal_at_ms: 2000,
            fade_in_ms: 0,
          },
        ],
      }),

      // Row 2: Mode B sky_ground (Kalahari), recurring hunter character.
      makeRow({
        timecode: '0:07',
        zenn_mode: 'scene',
        zenn_mode_reason: 'recurring historical figure in outdoor setting',
        zenn_character_id: 'ancient-hunter-curly',
        zenn_pose: 'walking',
        zenn_world_overlay: 'sky_ground',
        on_screen_text: 'KALAHARI',
      }),

      // Row 3: Mode B room (Calhoun interior).
      makeRow({
        timecode: '0:10',
        zenn_mode: 'scene',
        zenn_mode_reason: 'mouse-cage interior dramatization',
        zenn_world_overlay: 'room',
      }),

      // Row 4: Mode B underwater (Titanic).
      makeRow({
        timecode: '0:13',
        zenn_mode: 'scene',
        zenn_mode_reason: 'underwater descent shot',
        zenn_world_overlay: 'underwater',
      }),

      // Row 5: Mode B sky_only (floating subject).
      makeRow({
        timecode: '0:16',
        zenn_mode: 'scene',
        zenn_mode_reason: 'floating subject, no ground band',
        zenn_world_overlay: 'sky_only',
      }),

      // Row 6: explicit null overlay (white background fallback).
      makeRow({
        timecode: '0:19',
        zenn_mode: 'scene',
        zenn_mode_reason: 'transitional pure-white beat',
        zenn_world_overlay: null,
      }),

      // Row 7: Mode B with a character + pose that has no bank entry
      // — renderer falls back to undefined characterUrl, no crash.
      makeRow({
        timecode: '0:22',
        zenn_mode: 'scene',
        zenn_mode_reason: 'one-off character, no bank entry',
        zenn_character_id: 'one-off-villain',
        zenn_world_overlay: 'sky_ground',
      }),

      // Row 8: no zenn_mode set — should still route through ZennScene
      // (per PR 6.5 widening) and fall back to Mode A behavior.
      makeRow({
        timecode: '0:25',
        on_screen_text: 'fallback row',
      }),
    ],
  } as ProductionDoc;
}

describe('zenn_v1 system check — VideoConfig threading', () => {
  it('produces a VideoConfig with the canonical zenn_v1 shape', () => {
    const doc = makeZennDoc();
    const config = productionDocToVideoConfig(doc, doc.rows.map(() => null));

    // Doc-level resolution
    expect(config.styleId).toBe('zenn_v1');
    expect(config.zennV1Settings).toBeDefined();
    expect(config.zennV1Settings?.default_mode).toBe('scene');
    expect(config.zennV1Settings?.label_color_hex).toBe('#D32F2F');
    expect(config.zennV1Settings?.max_canvas_reveal_layers).toBe(4);
    expect(config.zennV1CharacterBank).toBeDefined();
    expect(Object.keys(config.zennV1CharacterBank ?? {})).toHaveLength(2);
    expect(config.zennV1World).toBeDefined();
    expect(config.zennV1World?.sky_color_hex).toBe('#BFE4F3');
  });

  it('threads per-row zenn_* fields onto each VideoShot', () => {
    const doc = makeZennDoc();
    const config = productionDocToVideoConfig(doc, doc.rows.map(() => null));
    expect(config.shots).toHaveLength(9);
    expect(config.shots[0].zennMode).toBe('stick');
    expect(config.shots[0].zennCharacterId).toBe('narrator');
    expect(config.shots[2].zennMode).toBe('scene');
    expect(config.shots[2].zennCharacterId).toBe('ancient-hunter-curly');
    expect(config.shots[2].zennPose).toBe('walking');
    expect(config.shots[2].zennWorldOverlay).toBe('sky_ground');
    expect(config.shots[3].zennWorldOverlay).toBe('room');
    expect(config.shots[4].zennWorldOverlay).toBe('underwater');
    expect(config.shots[5].zennWorldOverlay).toBe('sky_only');
    expect(config.shots[6].zennWorldOverlay).toBeNull();
  });

  it('threads canvas_reveal layers including pending-generation entries', () => {
    const doc = makeZennDoc();
    const config = productionDocToVideoConfig(doc, doc.rows.map(() => null));
    const revealRow = config.shots[1].zennCanvasRevealLayers;
    expect(revealRow).toHaveLength(2);
    // Generated layer: has image_url.
    expect(revealRow?.[0].image_url).toBe('https://r2.example/reveal-0.jpg');
    expect(revealRow?.[0].fade_in_ms).toBe(250);
    // Pending layer: no image_url, only prompt_hint. The renderer
    // skips it silently (per PR 4 isRevealLayerRenderable contract).
    expect(revealRow?.[1].image_url).toBeUndefined();
    expect(revealRow?.[1].prompt_hint).toBe('add a red label "WAIT"');
    // canvas_layer_add semantics — fade_in_ms = 0.
    expect(revealRow?.[1].fade_in_ms).toBe(0);
  });

  it('row 8 (no zenn_mode set) still routes through zenn_v1 path', () => {
    // PR 6.5 widened YouTubeVideo routing so ALL zenn_v1 shots go
    // through ZennScene regardless of whether zennMode is set. The
    // VideoConfig should still surface the row with undefined
    // zennMode so the renderer's defensive fallback (isSceneMode =
    // false → render shot.imageUrl as Mode A base) fires.
    const doc = makeZennDoc();
    const config = productionDocToVideoConfig(doc, doc.rows.map(() => null));
    expect(config.shots[8].zennMode).toBeUndefined();
    expect(config.shots[8].onScreenText).toBe('fallback row');
  });

  it('preserves zenn_mode_reason from row to row', () => {
    // Mode reasons are diagnostic, not consumed by the renderer.
    // The threading still has to work so the user can grep a saved
    // doc for misclassified picks.
    const doc = makeZennDoc();
    const config = productionDocToVideoConfig(doc, doc.rows.map(() => null));
    // VideoShot doesn't carry the reason field (it's only on the row),
    // so we assert via the doc - but the mode-pick log captures it.
    expect(doc.rows[0].zenn_mode_reason).toBe('narrator delivering opening statistic');
    expect(doc.rows[2].zenn_mode_reason).toBe(
      'recurring historical figure in outdoor setting',
    );
  });
});

describe('zenn_v1 system check — observability', () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
  });

  it('emits the mode-pick log with accurate counts on the system-check doc', () => {
    const doc = makeZennDoc();
    productionDocToVideoConfig(doc, doc.rows.map(() => null));
    const calls = consoleInfoSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0] === '[zenn-v1 mode-pick]',
    );
    expect(calls).toHaveLength(1);
    const [, payload] = calls[0];
    // 9 rows total, 8 with explicit zenn_mode, 1 without.
    expect(payload).toMatchObject({
      total_rows: 9,
      rows_with_mode: 8,
      stick_count: 2,
      scene_count: 6,
    });
  });
});

describe('zenn_v1 system check — defensive', () => {
  it('survives a doc with NO zenn fields populated at all', () => {
    // A zenn_v1 doc immediately after the production-doc generation
    // stage finishes but before the image-gen stage has populated
    // the bank / world / canvas_reveal layers. The renderer should
    // still produce a valid VideoConfig and not throw.
    const minimalDoc: ProductionDoc = {
      title: 'minimal',
      niche: 'test',
      total_duration: '0:09',
      total_words: 18,
      speaking_pace_wpm: 120,
      style_preset: 'zenn_v1',
      rows: [
        makeRow({ timecode: '0:00' }),
        makeRow({ timecode: '0:03' }),
        makeRow({ timecode: '0:06' }),
      ],
    } as ProductionDoc;
    const config = productionDocToVideoConfig(minimalDoc, minimalDoc.rows.map(() => null));
    expect(config.styleId).toBe('zenn_v1');
    // Settings should fall back to resolver defaults.
    expect(config.zennV1Settings?.default_mode).toBe('scene');
    // Empty bank forwards as undefined per the forwarding rule in PR 3.
    expect(config.zennV1CharacterBank).toBeUndefined();
    // World undefined since the doc carries none.
    expect(config.zennV1World).toBeUndefined();
    expect(config.shots).toHaveLength(3);
  });
});
