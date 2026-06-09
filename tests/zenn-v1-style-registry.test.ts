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

  it('does not opt into the doodle-yellow LowerThird variant', () => {
    // Zenn's emphasis text is bold red hand-lettered with optional
    // wavy underline — NOT the yellow comic-bold bubble that
    // doodle_explainer_2 / paint_explainer_v1 use. PR 6 will add a
    // `variant='zenn-red-label'` branch in SceneRouter and flip
    // this. Until then it stays undefined (or 'bake') so we don't
    // accidentally render the wrong-looking yellow bubble.
    expect(entry?.default_on_screen_text_mode).not.toBe('overlay');
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
});
