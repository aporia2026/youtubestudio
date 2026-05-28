# Doodle Explainer 2 — Authenticity Round (Refs + Variants + Realism)

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** Awaiting approval before execution. Phase 0 (drop refs #01 + #02) already shipped this session.

---

## Why this exists

User flagged that nearly every scene of every video in the `doodle_explainer_2` style contains the same recurring elements: a school/office building, an open book, and a black painting with red blood blobs. Investigation confirmed root cause:

- Atlas i2i caps at 4 refs/call. The dispatcher sends the **first 4** entries from the catalog every call, ignoring the bottom 5 of 9.
- Ref #01 was a **composite** (book + framed bloody painting in one frame). The model was literally copying that pair into every output.
- Ref #02 was a lone blue building. Same single-subject bleed pattern.
- Both shipped because earlier curation treated them as "recoverable after text removal." They weren't — the subjects themselves were the bleed source.

User's verdict: the output feels "not authentic, like no effort was put in, unprofessional… I need more uniqueness, variety, the viewer needs to feel that thought was put into the video, not just generic images." Plus two follow-ups: (a) "more base+variants but balanced, not all the time" and (b) "more realistic objects, competitors are doing it." Plus the architectural principle: **"refs are mainly for style, look and feel. We should be creative about the rest."**

## Goals

1. Every scene looks visually distinct from every other scene.
2. Output feels deliberate and human, not template-generated.
3. Variant groups (held composition + additive deltas) appear at ~40% of rows, not on every shot.
4. Real photographs (objects, places, named entities) appear in scenes more often, matching the realism cadence of competitor channels.

## Constraints

- **No new ref sourcing.** User: "we still have refs don't we?" Work with the 9 remaining refs.
- **No per-scene ref selection logic.** User: "trust good curation alone." Refs are loaded the same way for every scene; selection happens at the catalog level via reordering / trimming.
- **No new paid services.** All changes are catalog edits + prompt edits. The `overlay_stock_terms` system (real photo fetching) already exists and is already paid for — we're tuning the trigger rate, not adding cost per scene.
- **Atlas i2i caps at 4 refs/call.** Whatever ends up in positions 1–4 of the catalog is the entire visual vocabulary the model sees.
- **Backwards compatibility:** the `paint_explainer_v1` style in the same file borrows from this ref bundle. Already updated this session to swap ref #01 for ref #13.

## Requirements

### R1 — Catalog reorder so top-4 are pure style anchors

Refs are for style, not subject. The top-4 must teach the model "what doodle_explainer_2 looks like" with the absolute minimum subject content the model can latch onto. Based on a per-ref review this session:

| Pos | Ref | Why |
|---|---|---|
| 1 | `14-close-up-character-face.jpg` | Teaches face anatomy + line style. No body, no props, no environment. |
| 2 | `04-stick-figure-raised-arm-no-hand-angry.jpg` | Teaches the no-hand stick anatomy + emotive close-up. |
| 3 | `09-yellow-bubble-text-standalone-within-hours.jpg` | Teaches the yellow comic-bold typography pillar. Text is generic ("Example text"). |
| 4 | `13-framed-real-photo-pure-centrifuges.jpg` | Teaches the framed-real-photo composition pillar — critical for the realism push (R4). |

Positions 5–9 stay in the catalog as legacy (never actually sent to Atlas):

| Pos | Ref | Status |
|---|---|---|
| 5 | `03-lone-stick-figure-frowning.jpg` | Clean style sample, deprioritized in favor of #14/#04 close-ups. |
| 6 | `10-stick-figure-raised-arm-no-hand-calm.jpg` | Near-duplicate of #04 with calm expression. |
| 7 | `12-stick-figure-single-red-accent.jpg` | Red skull is visually loud — kept off the top-4 to prevent skull-motif bleed. |
| 8 | `05-color-composition-globe-with-computer-callouts.jpg` | Subject-coded (globe + 4 computers). Bleeds globe+tech into every scene if surfaced. |
| 9 | `06-object-network-laptops-arrows.jpg` | Subject-coded (laptops + arrows). Bleeds tech-network into every scene if surfaced. |

**Open decision:** trim positions 5–9 entirely (cleanest, catalog reflects reality) or keep them as documented legacy (preserves history). Recommend trim — the catalog should be the truth.

### R2 — Mixing rules: dial variant target to ~40%

Current prompt demands "at least 35 variant groups" for 100+-row docs. With avg ~3 rows per group, that math forces >100% of rows into groups — the prompt is internally contradictory and the LLM is forced to guess.

Replace the hard count requirement with a clear ratio:

> **Target: ~40% of rows belong to a variant group (1 base + 1–3 variants). The remaining ~60% are fresh compositions. Variant groups are the texture, not the backbone.**
>
> A variant group is a sequence of 2–4 contiguous rows that share the same composition with one additive delta per row. Fresh compositions are single rows that introduce a new camera, location, character, or subject.
>
> Don't force variants where they don't belong. Don't avoid them when 2–3 consecutive narration beats naturally share a held subject. The pacing should breathe.

Keep all the existing TRIGGER criteria, valid deltas, bad deltas, and worked examples — those are good. Only the count requirement changes.

### R3 — Mixing rules: aggressive realism pattern

Add a new section to `mixing_rules` after the COMPOSITION block:

> **== REALISM — REAL PHOTOS ARE A FIRST-CLASS BEAT TYPE ==**
>
> Competitor channels in this genre lean heavily on real photographs to ground the story in reality. We do the same.
>
> **Trigger a real-photo composition (Pattern A or B) on EVERY one of these:**
> - Named person (historical figure, scientist, celebrity, witness, perpetrator)
> - Named place (city, country, building, landmark, region)
> - Named brand, product, or organization
> - Named event with photographic record (war, disaster, launch, ceremony)
> - Concrete object that has a strong real-world referent (a centrifuge, a particular type of weapon, a vintage TV set, a 1970s payphone)
>
> **Pattern A — Full real-photo background, cartoon foreground.** The real photo fills the frame; one stick-figure character or one small cartoon prop sits on top of it. Set `overlay_stock_terms` to the relevant search query.
>
> **Pattern B — Framed real photo inside a doodle scene.** A thin black rounded rectangle (~8px radius) frames the real photo, sitting next to or beside cartoon elements. The framed-photo composition pillar (ref #13) demonstrates this.
>
> **Target cadence:** at minimum one real-photo beat for every 8–12 rows. A factual / historical / news script can sit closer to one per 4–6 rows. If you finish the doc without a real photo on every named person and every named place, re-read the script and add them.

Also raise the existing `overlay_stock_terms` guidance from "when the row mentions a named entity" to "ALWAYS when the row mentions a named entity — never skip this."

### R4 — Mixing rules: "be creative with subjects" reinforcement

Refs teach style. The model needs explicit permission (and obligation) to invent fresh subjects.

Add to the CORE PRINCIPLE block:

> **The reference images teach line weight, color palette, character anatomy, framing, and typography. They do NOT teach what each scene should contain. Be inventive with subjects. If two consecutive shots feel like the same picture, the second one is wrong — change the camera, change the subject, change the composition. Every shot should answer "what is this scene about?" with a different visual answer than the shot before it.**

## Alternatives considered and rejected

1. **Per-scene ref selection** — Rejected by user as too complex. Would solve ref bleed cleanly but adds an LLM tagging step per scene and meaningful architectural complexity.
2. **Re-extract refs from Paint Explainer source frames** — Rejected by user ("we still have refs"). Would deepen the style fidelity but requires curation effort we don't need given the principle of "refs = style only."
3. **AI-generate neutral style refs** — Rejected by user implicitly. Risks homogenization and feels incestuous.
4. **Trim catalog to exactly 4 refs (the top-4 from R1)** — Held as an open decision in R1. Cleanest option; recommend.

## Phased delivery

### Phase 0 — Shipped this session
- Refs #01 + #02 moved to `public/style-refs/_review-not-doodle-2/`.
- Catalog entries removed for `doodle_explainer_2`.
- `paint_explainer_v1` catalog (in pending diff) updated to swap ref #01 for ref #13.
- Stale "14 bundled refs" comment fixed to reflect 9.

### Phase 1 — Catalog reorder (R1) — SHIPPED
- Reordered `built_in_refs` so positions 1–4 are: 14, 04, 09, 13.
- Trimmed positions 5–9 from the catalog (user confirmed). Files remain on disk under `Doodle-explainer-2/` for future curation rounds; just not registered.
- Updated the comment block above the catalog to document order-matters semantics.
- Side note shipped: regenerated refs 04, 09, 13 via Atlas GPT Image 2 t2i ($0.036 total) using `scripts/generate-doodle-2-ref-candidates.ts`. Candidate #1 (face close-up) was rejected; existing #14 kept. Originals archived in `_review-not-doodle-2/`.

### Phase 2 — Mixing rules update (R2 + R3 + R4) — SHIPPED
- Replaced the contradictory HARD COUNT REQUIREMENT with the ~40% rows-in-variant-groups ratio + acceptable-drift guidance.
- Added the REALISM section after COMPOSITION with both pillars: (1) real photographs composited via Pattern A/B with cadence floors, (2) specific named real-world props in cartoon form with period accuracy rules.
- Added "REFS TEACH STYLE, YOU INVENT SUBJECTS" to CORE PRINCIPLE, plus an EXPLICIT PER-REF ROLES block (added 2026-05-28 after user reinforcement) that names each of the 4 refs, what it teaches, and an explicit `does NOT mean X` disclaimer per ref. Specifically: ref #13 forest is documented as a placeholder — the photo subject must come from the script (person, stadium, lab, anything).
- Reinforced "forest is a placeholder, do NOT default to forests" in the REALISM Pattern B paragraph itself.

### Phase 2b — Observability (R-Obs) — SHIPPED
- Added `[production-doc variants]` log in `src/app/api/generate/production-doc/route.ts` after auto-grouping. Carries `{ totalRows, groupRows, freshRows, ratio, targetRatio: 0.4, withinTarget }`. This is the primary verification surface for the 40% target.
- Added `[production-doc overlay-stock terms]` log in the same file. Carries `{ totalRows, overlayRows, overlayRatio, meetsFloor, sampleTerms }`. Verifies named-entity coverage at the cadence floor of ≥0.08 (1 per 8-12 rows).

### Phase 3 — QA
- Generate one fresh production doc in `doodle_explainer_2` style from an existing script (a real-life story script — the target use case).
- Verify in the rendered doc:
  - No two consecutive scenes share the same composition unless they're an intentional variant group.
  - No book, no blue building, no bloody painting in any scene.
  - Variant groups account for ~35–45% of rows (40% ± 5).
  - Every named entity (person, place, brand) triggers `overlay_stock_terms` or a Pattern A/B real-photo composition.
- If any of those fail, iterate on the prompt before declaring done.

## Settings audit (CLAUDE.md rule 15)

Per-feature controls that could land in the Settings layer. None are wired today; flagging for a future Settings round, not this plan.

- `variant_group_target_ratio` — slider 0–80%, default 40%. Lets the user dial pacing per project.
- `real_photo_aggressiveness` — enum `subtle | balanced | competitor` (current default would be `competitor`). Maps to different cadence floors in the prompt.
- `ref_top_n_override` — integer 1–4, debug knob to bypass the catalog top-N and force a specific subset. Useful when QA-ing a new ref.

Intentionally NOT exposed: per-scene ref selection toggle (decision made at architecture level, not a runtime user control).

## Observability (CLAUDE.md rule 14)

Already in place from prior plans:
- `[production-doc style-refs]` namespace logs which refs were loaded for a style.
- `[image-gen i2i]` logs the actual refs sent to Atlas per call.

Add for this round:
- After variant-group generation, log `[production-doc variants]` with `{ totalRows, groupRows, ratio }` so we can verify the 40% target landed.
- After overlay-stock resolution, log `[overlay-stock terms]` with `{ rowIndex, term, matched }` so we can verify named entities are triggering.

## Security (CLAUDE.md rule 13)

N/A for this round. No new data flows, no new external services, no user-controlled inputs reaching new code paths. The `overlay_stock_terms` cadence change inherits the existing search-query sanitization in `src/app/api/overlay/fetch/route.ts`.

## Cost (CLAUDE.md rule 8)

- **Atlas i2i**: unchanged. Same 4 refs per call, same per-image cost.
- **Variant groups at 40%**: per the existing comment in `production-doc-styles.ts`, variant edits via Atlas Edit cost ~$0.011/row vs ~$0.04/row for fresh i2i. Shifting from the current ~35-group floor to a clear 40% ratio is **slightly cheaper or roughly flat** for most docs.
- **Real-photo overlays**: `overlay_stock_terms` triggers a Brave Search call (per the [Env vars provisioned](memory) note, already paid for) and an image fetch. Estimate +1 search/image per 8–12 rows on average. Negligible.

Net: this round is **slightly cheaper** than the status quo, not more expensive.

## Open questions

1. **Trim or retain positions 5–9 in the catalog?** Default = trim (catalog = truth). Confirm.
2. **"Realistic objects" interpretation:** is the user's intent (a) more real photographs composited into scenes, or (b) more realistically-drawn cartoon objects (recognizable phones, vintage TVs, specific weapons) within the doodle style? Current plan covers (a) aggressively. If (b) is also wanted, add a short prompt section that nudges the LLM toward identifiable real-world objects in cartoon form (e.g. "a Bakelite rotary phone, not a generic phone shape; a Samsonite-style brown leather briefcase, not a generic box").
3. **Does this generalize to `paint_explainer_v1`?** Same architecture, same Atlas cap. Worth a follow-up to apply the same realism pattern there once doodle_2 is verified.
