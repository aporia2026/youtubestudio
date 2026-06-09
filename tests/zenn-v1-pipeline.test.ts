import { describe, expect, it } from 'vitest';
import {
  buildCharacterBankPrompt,
  fillWorldPalette,
  normalizeZennCharacterId,
  planCharacterBankWork,
  planWorldPaletteWork,
} from '@/lib/auto-pipeline/stages/generate-zenn-v1-images';
import { getStageHandler } from '@/lib/auto-pipeline/orchestrator';
import {
  ACTIVE_STAGES,
  FAILURE_STAGES,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
} from '@/lib/auto-pipeline/types';

// ─── normalizeZennCharacterId ───────────────────────────────────────
//
// The normalizer is the security boundary against runaway character
// banks: two near-duplicate slugs ("Hero 1" and "hero-1") must
// collapse to the same canonical key. Without this, a chatty LLM
// could blow the per-doc cap by emitting 50 variants of the same
// underlying character. Plan §6.

describe('normalizeZennCharacterId', () => {
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

  it('collapses near-duplicates to the same canonical form', () => {
    // The whole point — these all describe one character to the LLM
    // but render as separate strings until the normalizer dedupes them.
    expect(normalizeZennCharacterId('Hero 1')).toBe('hero-1');
    expect(normalizeZennCharacterId('HERO-1')).toBe('hero-1');
    expect(normalizeZennCharacterId('hero_1')).toBe('hero-1');
    expect(normalizeZennCharacterId('Hero.1')).toBe('hero-1');
  });
});

// ─── buildCharacterBankPrompt ───────────────────────────────────────
//
// The prompt is the LLM contract for the character bank entry. The
// tests pin the two structural pieces (the slug appears, the hint is
// embedded when present and dropped when not) but stay quiet on the
// exact wording — that's expected to evolve as the PR 5 work tunes
// the prompt for the actual LLM.

describe('buildCharacterBankPrompt', () => {
  it('embeds the character_id slug verbatim', () => {
    const out = buildCharacterBankPrompt('curly-haired-hunter', 'irrelevant hint');
    expect(out).toContain('"curly-haired-hunter"');
  });

  it('embeds the appearance hint when supplied', () => {
    const out = buildCharacterBankPrompt('mouse', 'a grey field mouse with whiskers');
    expect(out).toContain('a grey field mouse with whiskers');
  });

  it('omits the hint clause when no hint is supplied', () => {
    const out = buildCharacterBankPrompt('mouse', '');
    expect(out).not.toContain('Appearance hint');
  });

  it('handles whitespace-only hints as no-hint', () => {
    const out = buildCharacterBankPrompt('mouse', '   ');
    expect(out).not.toContain('Appearance hint');
  });

  it('falls back to a generic slug when the id is empty', () => {
    // The actual cap is the planning step; this is defense in depth
    // so a corrupted row never produces a prompt with `"" "` in it.
    const out = buildCharacterBankPrompt('', 'hint');
    expect(out).toContain('"character"');
  });
});

// ─── planCharacterBankWork ──────────────────────────────────────────
//
// The planner is the load-bearing piece for idempotency + cost
// control. It MUST: (a) skip characters already in the bank, (b)
// dedupe near-duplicate slugs, (c) preserve first-seen ordering for
// stable re-tick behavior, (d) honor the 12-character hard cap.

interface PlanTestRow {
  zenn_character_id?: string;
  ai_image_prompt?: string;
}

interface PlanTestDoc {
  rows: PlanTestRow[];
  zenn_v1_character_bank?: Record<string, { base_url: string; first_seen_row_index: number }>;
}

const docWithRows = (rows: PlanTestRow[]): PlanTestDoc => ({ rows });

describe('planCharacterBankWork', () => {
  it('returns an empty array for an empty doc', () => {
    expect(planCharacterBankWork(docWithRows([]) as never)).toEqual([]);
  });

  it('returns one entry per unique character_id with first-seen row index', () => {
    const plan = planCharacterBankWork(
      docWithRows([
        { zenn_character_id: 'hero', ai_image_prompt: 'hero pose 1' },
        { zenn_character_id: 'villain', ai_image_prompt: 'villain pose 1' },
        { zenn_character_id: 'hero', ai_image_prompt: 'hero pose 2' },
      ]) as never,
    );
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ canonicalId: 'hero', firstSeenRowIndex: 0 });
    expect(plan[1]).toMatchObject({ canonicalId: 'villain', firstSeenRowIndex: 1 });
  });

  it('extracts the appearanceHint from the first row featuring the character', () => {
    // The hint comes from the FIRST row's ai_image_prompt, not any
    // later row. This keeps the bank prompt deterministic on re-tick
    // (rows can change between ticks, but the first row's prompt
    // is the most authoritative description).
    const plan = planCharacterBankWork(
      docWithRows([
        { zenn_character_id: 'hero', ai_image_prompt: 'tall grey hero standing' },
        { zenn_character_id: 'hero', ai_image_prompt: 'hero running away' },
      ]) as never,
    );
    expect(plan[0].appearanceHint).toBe('tall grey hero standing');
  });

  it('skips characters already in the bank', () => {
    const plan = planCharacterBankWork(
      {
        rows: [
          { zenn_character_id: 'hero' },
          { zenn_character_id: 'villain' },
        ],
        zenn_v1_character_bank: {
          hero: { base_url: 'https://r2.example/hero.jpg', first_seen_row_index: 0 },
        },
      } as never,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].canonicalId).toBe('villain');
  });

  it('treats a bank entry without base_url as not-yet-generated', () => {
    // Defense in depth: a partial bank entry (e.g. mid-write crash)
    // should NOT count as "already in the bank" — we want the next
    // tick to retry generation.
    const plan = planCharacterBankWork(
      {
        rows: [{ zenn_character_id: 'hero' }],
        zenn_v1_character_bank: {
          hero: { base_url: '', first_seen_row_index: 0 } as never,
        },
      } as never,
    );
    expect(plan).toHaveLength(1);
  });

  it('collapses near-duplicate slugs to a single bank entry', () => {
    // "Hero 1", "hero-1", "HERO_1" all normalize to "hero-1". The
    // first slug seen wins as the canonicalId (used to build the
    // prompt + lookup key).
    const plan = planCharacterBankWork(
      docWithRows([
        { zenn_character_id: 'Hero 1' },
        { zenn_character_id: 'hero-1' },
        { zenn_character_id: 'HERO_1' },
      ]) as never,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].canonicalId).toBe('Hero 1');
  });

  it('honors the 12-character hard cap', () => {
    // The defensive cap protects against a runaway LLM emitting
    // hundreds of one-shot character_ids. Real Zenn videos use 3-7
    // characters; 12 is a generous ceiling.
    const manyRows: PlanTestRow[] = [];
    for (let i = 0; i < 20; i++) {
      manyRows.push({ zenn_character_id: `character-${i}` });
    }
    const plan = planCharacterBankWork(docWithRows(manyRows) as never);
    expect(plan).toHaveLength(12);
    // Earliest-seen characters are kept, later ones dropped.
    expect(plan[0].canonicalId).toBe('character-0');
    expect(plan[11].canonicalId).toBe('character-11');
  });

  it('skips rows missing zenn_character_id', () => {
    const plan = planCharacterBankWork(
      docWithRows([
        { ai_image_prompt: 'unrelated shot' },
        { zenn_character_id: '', ai_image_prompt: 'blank id' },
        { zenn_character_id: 'hero', ai_image_prompt: 'real character' },
      ]) as never,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].canonicalId).toBe('hero');
    expect(plan[0].firstSeenRowIndex).toBe(2);
  });

  it('skips rows whose slug normalizes to empty', () => {
    // "!!!" normalizes to "" — that's not a real character, drop it.
    const plan = planCharacterBankWork(
      docWithRows([
        { zenn_character_id: '!!!' },
        { zenn_character_id: 'hero' },
      ]) as never,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].canonicalId).toBe('hero');
  });
});

// ─── planWorldPaletteWork ───────────────────────────────────────────

describe('planWorldPaletteWork', () => {
  it('returns an empty set for an empty doc', () => {
    const out = planWorldPaletteWork({ rows: [] } as never);
    expect(out.size).toBe(0);
  });

  it('collects unique overlay values across rows', () => {
    const out = planWorldPaletteWork({
      rows: [
        { zenn_world_overlay: 'sky_ground' },
        { zenn_world_overlay: 'sky_ground' },
        { zenn_world_overlay: 'room' },
      ],
    } as never);
    expect([...out].sort()).toEqual(['room', 'sky_ground']);
  });

  it('ignores null and undefined overlay values', () => {
    const out = planWorldPaletteWork({
      rows: [
        { zenn_world_overlay: null },
        { zenn_world_overlay: undefined },
        { zenn_world_overlay: 'sky_only' },
      ],
    } as never);
    expect([...out]).toEqual(['sky_only']);
  });

  it('ignores invalid overlay values', () => {
    // Defense in depth — a stale doc might carry an old vocabulary
    // value. The planner ignores anything outside the canonical
    // four-keyword set.
    const out = planWorldPaletteWork({
      rows: [
        { zenn_world_overlay: 'jungle' as never },
        { zenn_world_overlay: 'sky_ground' },
      ],
    } as never);
    expect([...out]).toEqual(['sky_ground']);
  });
});

// ─── fillWorldPalette ───────────────────────────────────────────────

describe('fillWorldPalette', () => {
  it('returns an empty shape when no overlays are in use', () => {
    const out = fillWorldPalette(undefined, new Set());
    expect(out).toEqual({});
  });

  it('fills unset hex fields with the defaults for the chosen overlay', () => {
    const out = fillWorldPalette(undefined, new Set(['sky_ground']));
    expect(out.sky_color_hex).toBe('#BFE4F3');
    expect(out.ground_color_hex).toBe('#F2D69A');
    expect(out.wall_color_hex).toBe('#E0E0E0');
    expect(out.recurring_props).toEqual([]);
  });

  it('preserves user-set hex fields', () => {
    const out = fillWorldPalette(
      { sky_color_hex: '#000000' },
      new Set(['sky_ground']),
    );
    expect(out.sky_color_hex).toBe('#000000');
    expect(out.ground_color_hex).toBe('#F2D69A');
  });

  it('preserves an existing recurring_props array', () => {
    const props = [{ name: 'firewood', image_url: 'https://r2.example/wood.jpg' }];
    const out = fillWorldPalette({ recurring_props: props }, new Set(['sky_ground']));
    expect(out.recurring_props).toBe(props);
  });

  it('picks the first overlay alphabetically when multiple are in use', () => {
    // Determinism: when a doc carries both sky_ground and room
    // overlays the renderer needs a coherent palette, not a flicker.
    // 'room' < 'sky_ground' alphabetically — room's defaults win.
    const out = fillWorldPalette(undefined, new Set(['sky_ground', 'room']));
    expect(out.sky_color_hex).toBe('#E8E8E8'); // room defaults
    expect(out.ground_color_hex).toBe('#9E9E9E');
  });

  it('is idempotent when run on an already-populated world def', () => {
    const populated = {
      sky_color_hex: '#FF0000',
      ground_color_hex: '#00FF00',
      wall_color_hex: '#0000FF',
      recurring_props: [],
    };
    const out = fillWorldPalette(populated, new Set(['sky_ground']));
    expect(out).toEqual(populated);
  });
});

// ─── orchestrator wiring + stage-name invariants ────────────────────
//
// The auto-pipeline.test.ts suite already iterates over PIPELINE_STAGES
// and ACTIVE_STAGES, so the membership invariants are auto-validated
// by that file. These checks are belt-and-suspenders on top:
// explicit assertions that the new stages exist and route correctly.

describe('zenn_v1 stage wiring', () => {
  it('registers generating_zenn_v1_images as an active stage', () => {
    expect(PIPELINE_STAGES.includes('generating_zenn_v1_images' as never)).toBe(true);
    expect(ACTIVE_STAGES.has('generating_zenn_v1_images')).toBe(true);
    expect(TERMINAL_STAGES.has('generating_zenn_v1_images')).toBe(false);
  });

  it('registers zenn_v1_images_failed as a terminal failure stage', () => {
    expect(PIPELINE_STAGES.includes('zenn_v1_images_failed' as never)).toBe(true);
    expect(TERMINAL_STAGES.has('zenn_v1_images_failed')).toBe(true);
    expect(FAILURE_STAGES.has('zenn_v1_images_failed')).toBe(true);
    expect(ACTIVE_STAGES.has('zenn_v1_images_failed')).toBe(false);
  });

  it('routes generating_zenn_v1_images to a real handler', () => {
    expect(getStageHandler('generating_zenn_v1_images')).not.toBeNull();
  });

  it('does not route the terminal failure stage to any handler', () => {
    expect(getStageHandler('zenn_v1_images_failed')).toBeNull();
  });
});
