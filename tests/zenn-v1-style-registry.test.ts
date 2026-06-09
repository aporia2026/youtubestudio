import { describe, expect, it } from 'vitest';
import { BUILT_IN_STYLES, getBuiltInStyle } from '@/lib/production-doc-styles';

// ─── zenn_v1 style registry entry ───────────────────────────────────
//
// The registry entry is the one place that ties the AI image suffix,
// the bundled refs, the mixing rules, and the preferred cloud model
// together. A typo here propagates into every generation. These tests
// pin the shape so regressions are caught at the test level rather
// than at the next QA render. See `_plans/2026-06-10-zenn-v1-style.md`.

describe('zenn_v1 registry entry', () => {
  const entry = getBuiltInStyle('zenn_v1');

  it('is registered in BUILT_IN_STYLES', () => {
    expect(entry).not.toBeNull();
    expect(BUILT_IN_STYLES.some((s) => s.id === 'zenn_v1')).toBe(true);
  });

  it('has the expected canonical fields', () => {
    expect(entry?.id).toBe('zenn_v1');
    expect(entry?.label).toBe('Zenn V1');
    expect(entry?.origin).toBe('built-in');
    expect(typeof entry?.description).toBe('string');
    expect((entry?.description ?? '').length).toBeGreaterThan(20);
  });

  it('pins the image provider to Kie gpt-image-2 i2i (user decision 2026-06-10)', () => {
    // The user explicitly chose Kie AI gpt-image-2 as the image
    // provider for zenn_v1. Pricing accepted. If this assertion
    // fails, the registry was edited to a different provider — that
    // is a real product decision and the user needs to be in the
    // loop. See plan §11.
    expect(entry?.preferred_cloud_model).toBe('gpt-image-2-i2i');
  });

  it('bundles at least one ref for Mode A under Zenn-v1/', () => {
    const refs = entry?.built_in_refs ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(1);
    // Each ref carries a filename + mime_type — the loader downstream
    // depends on both fields being present.
    for (const ref of refs) {
      expect(ref.filename).toMatch(/\.(jpg|jpeg|png)$/i);
      expect(ref.mime_type).toMatch(/^image\//);
    }
  });

  it('disallows overlay_stock_terms — Zenn videos use zero photographic content', () => {
    // Confirmed in plan §1: "Real-photo polaroid punch-in. Zenn uses
    // zero photographic content." Setting allow_overlay_stock to
    // true here would let the LLM emit stock-photo URLs that the
    // pipeline would then fetch and composite, breaking the style.
    expect(entry?.allow_overlay_stock).toBe(false);
  });

  it('opts into overlay OST mode so ZennScene renders the red label overlay', () => {
    // PR 6.5 flipped this from undefined (the PR 1 floor) to
    // 'overlay'. Zenn rows route through ZennScene which renders
    // its OWN red hand-lettered overlay — the doodle-yellow
    // LowerThird never mounts because BRollScene is never reached
    // for zenn_v1 rows. Setting 'overlay' here tells the LLM to
    // emit `on_screen_text_mode: 'overlay'` on every row so the
    // text doesn't get baked into the AI image as a fallback.
    expect(entry?.default_on_screen_text_mode).toBe('overlay');
  });

  it('has a non-empty ai_image_suffix that teaches Mode A anatomy + typography', () => {
    const suffix = entry?.ai_image_suffix ?? '';
    expect(suffix.length).toBeGreaterThan(200);
    // Smoke checks: the suffix should mention the load-bearing
    // visual elements. These are not exhaustive — a full content
    // audit lives in the QA render pass — but they catch the case
    // where the suffix was accidentally truncated or replaced.
    expect(suffix.toLowerCase()).toContain('stick');
    expect(suffix.toLowerCase()).toContain('white');
    expect(suffix.toLowerCase()).toContain('grey');
  });

  it('has mixing_rules that document mode dispatch + character persistence', () => {
    const rules = entry?.mixing_rules ?? '';
    expect(rules.length).toBeGreaterThan(500);
    // Load-bearing keywords the LLM needs to see. Same caveat as
    // above — not a full content audit, just regression-protection
    // for the structurally-required terms.
    expect(rules).toContain('zenn_mode');
    expect(rules).toContain('zenn_character_id');
    expect(rules).toContain('zenn_world_overlay');
    // Forward-compatibility data the renderer ignores in PR 1.
    expect(rules.toLowerCase()).toContain('canvas_reveal');
    // The hard 12-character cap is a load-bearing piece of the cost
    // story — if it disappears from the prompt, the LLM can blow
    // the budget.
    expect(rules).toContain('12');
  });

  // ─── PR 5 additions ────────────────────────────────────────────────
  //
  // PR 5 widens the mixing_rules to teach the LLM the actual
  // canvas_reveal layer shape (PR 4 had no concrete example) and the
  // mode-pick reason field used for diagnostics. These tests pin the
  // load-bearing field names so a future copy edit can't silently
  // drop them.

  it('teaches the canvas_reveal layer field names from the PR 4 schema', () => {
    const rules = entry?.mixing_rules ?? '';
    // The four field names the LLM must emit on each layer entry.
    // Without these in the prompt, the LLM will guess the shape and
    // produce malformed entries that the pipeline silently drops.
    expect(rules).toContain('prompt_hint');
    expect(rules).toContain('reveal_at_ms');
    expect(rules).toContain('duration_ms');
    expect(rules).toContain('fade_in_ms');
    // The collapsed canvas_layer_add semantics (fade_in_ms = 0)
    // must surface explicitly — without this the LLM never picks
    // it and we lose the snappy "thing appears" beat.
    expect(rules).toContain('canvas_layer_add');
  });

  it('teaches the zenn_mode_reason diagnostic field', () => {
    const rules = entry?.mixing_rules ?? '';
    expect(rules).toContain('zenn_mode_reason');
    // The reason field is purely diagnostic; the mixing_rules must
    // be explicit that the renderer + pipeline ignore it, otherwise
    // future copy edits might wire it to actual behavior and break
    // the contract.
    expect(rules.toLowerCase()).toContain('diagnostic');
  });

  it('still ships at least three concrete CONCRETE EXAMPLE blocks', () => {
    // Concrete examples are how the LLM actually copies the schema
    // shape. PR 5 adds the canvas_reveal example so all three modes
    // (Mode A static, Mode B scene world, Mode A canvas_reveal) have
    // a worked example for the LLM to copy from.
    const rules = entry?.mixing_rules ?? '';
    const matches = rules.match(/CONCRETE EXAMPLE/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
