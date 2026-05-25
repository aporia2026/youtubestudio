# Plan: `doodle_explainer_2` built-in style (Phase 1)

**Date:** 2026-05-25
**Status:** Approved, executing now
**Phase:** 1 of 3 in the "Doodle Explainer 2" series
- Phase 2: `_plans/2026-05-25-style-aware-overlay-text.md`
- Phase 3: `_plans/2026-05-25-near-static-variants.md`

## Goal

Add a new built-in production-doc visual style, `doodle_explainer_2`, modelled exactly on three reference YouTube videos the user dropped in `refs/`. The style should produce hand-drawn cartoon scenes with:

- Pure white background, always.
- A persistent bold black hand-drawn title at the top of every frame.
- Stick-figure characters with thick uneven black outlines, circular heads, dot eyes.
- Muted palette: mostly black-on-white with pale blue, pale yellow, light gray accents and one occasional saturated colour (red for danger).
- Centered subjects with generous white space.
- Real photos / screenshots inserted as inset rectangles with a thick coloured border.

Phase 2 will add yellow-bubble on-screen text rendering. Phase 3 will add true variant support. Phase 1 only ships the style entry + refs.

## Constraints

- **Schema:** Use the existing `ResolvedStyle` shape in [src/lib/production-doc-styles.ts:28](src/lib/production-doc-styles.ts#L28). No schema changes in this phase.
- **Ref cap:** `nano-banana-2-i2i` accepts at most 14 reference images per call (already documented in the existing Doodle Explainer entry). Atlas I2I caps at 4. We need >4 refs to capture the breadth of this aesthetic, so we keep `preferred_cloud_model: 'nano-banana-2-i2i'` and bundle exactly 14 of the 41 extracted frames.
- **Coexistence:** Existing `doodle_explainer` built-in stays untouched. New entry has its own stable id (`doodle_explainer_2`) so old saved docs that reference `doodle_explainer` keep resolving.
- **No cost change today.** Per-call cost is identical to existing Doodle Explainer ($0.025 for nano-banana-2-i2i).

## Requirements

- New style is visible in the Visual Styles modal with a lock icon, listed under "BUILT-IN" after `Doodle Explainer`.
- New style has a one-line `description` so the picker tooltip is meaningful.
- Calling `getBuiltInStyle('doodle_explainer_2')` returns the resolved style.
- A production-doc row generated with this style produces an image that visually matches the refs (verified by eye on a test render in Phase 1 QA).
- `mixing_rules` include:
  - Pure illustration default, same overlay logic as Doodle Explainer for real-world subjects.
  - **New:** explicit "framed rectangle with thick coloured border" treatment when overlaying real photos (matches `v1_frame_005s`, `v3_frame_045s`, `v2_frame_090s`).
  - **New:** `on_screen_text` population guidance: populate it for time markers, statistics, foreign terms, and key punchlines. Leave `on_screen_text_mode` defaulting to `'overlay'` (Phase 2 will make the visual treatment style-aware; Phase 1 just gets the candidate text into the field so Phase 2 has data to render).
  - **New:** a *prompting hint* about the near-static animation pattern — describe scenes so the same composition can plausibly be re-edited with a brow/mouth/hand change. Even though Phase 1 doesn't generate variants, this makes the base image well-suited for Phase 3.

## Chosen approach

Append exactly one new entry to `BUILT_IN_STYLES` in [src/lib/production-doc-styles.ts:105](src/lib/production-doc-styles.ts#L105), after the existing `doodle_explainer` entry. Bundle 14 refs at `public/style-refs/Doodle-explainer-2/`.

### 14 chosen reference frames

Picked for breadth (every motif in the source videos covered at least once) and quality:

| # | Source frame | Why chosen |
|---|---|---|
| 1 | `v1_frame_005s.jpg` | Composite: cartoon book + framed real photo with thick black border |
| 2 | `v1_frame_045s.jpg` | Pure illustration: cartoon building with pale blue accents |
| 3 | `v1_frame_150s.jpg` | Canonical lone stick figure, frowning |
| 4 | `v1_frame_240s.jpg` | Multi-stick-figure scene (`Cursed Teletubbies` doorway) |
| 5 | `v2_frame_005s.jpg` | Color composition: globe with computer callouts |
| 6 | `v2_frame_020s.jpg` | Object network: 5 laptops connected by arrows |
| 7 | `v2_frame_045s.jpg` | Icon composition: TV with deleted files X |
| 8 | `v2_frame_090s.jpg` | Framed real photo (Windows XP screen inside cartoon TV) |
| 9 | `v2_t028.jpg` | Yellow bubble text standalone (`Within hours`) |
| 10 | `v2_t065.jpg` | Stick figure expression base (matches user's wannacry refs) |
| 11 | `v2_t075.jpg` | Yellow text overlaid on illustrated scene (`150 countries` over globe) |
| 12 | `v3_frame_020s.jpg` | Stick figure with single saturated-red accent (skull) |
| 13 | `v3_frame_045s.jpg` | Pure framed real photo (centrifuges) |
| 14 | `v3_frame_240s.jpg` | Close-up character face — different framing |

### 5 frames intentionally dropped (over the 14 cap)

- `v1_frame_020s.jpg` (B&W photos inside a TV magnifying glass — cluttered, hard to read)
- `v1_frame_090s.jpg` (chain + framed photo — weaker version of motif covered by #1)
- `v2_frame_150s.jpg` (ILOVEYOU computer — redundant with #7 and #8)
- `v2_frame_240s.jpg` (MyDoom file icon — low information)
- `v3_frame_090s.jpg` (framed YouTube screenshot — redundant)
- `v3_frame_150s.jpg` (empty black TV — too sparse)

## Alternatives rejected

1. **Replace existing `doodle_explainer` in place.** Rejected: would silently break any production doc that has `'doodle_explainer'` pinned as its `style_id`. The new aesthetic is tighter; it's a different style, not an upgrade.
2. **Use Atlas I2I as `preferred_cloud_model`.** Rejected: Atlas I2I caps at 4 refs ([src/lib/image-models-i2i.ts:172](src/lib/image-models-i2i.ts#L172)). The motif breadth here genuinely needs more refs. Atlas is ~73% cheaper per image, but for I2I the 4-ref ceiling forces too much information loss.
3. **Bundle all 18 of the original frames + the 23 v2-extra frames.** Rejected: exceeds 14-ref cap; the dispatcher silently drops anything beyond the cap, so over-bundling is invisible bloat.
4. **Bundle only 5 refs (matching existing Doodle Explainer count).** Rejected: this style has more motifs to cover (framed photos, yellow text, expression variants) than Doodle Explainer. 14 is the model ceiling and we should use it.

## Open questions

None blocking Phase 1.

## Phase 1 QA checklist

- [ ] `tsc --noEmit` clean
- [ ] Files exist at `public/style-refs/Doodle-explainer-2/<14 filenames>` and are loadable
- [ ] `getBuiltInStyle('doodle_explainer_2')` returns the new style
- [ ] `listAllStyles(workspaceId)` includes it
- [ ] Visual Styles modal renders it under BUILT-IN with a lock icon
- [ ] Selecting it in a production doc and generating a test image produces output visually consistent with the refs (human-eye check)
- [ ] Existing `doodle_explainer` still works unchanged
