# Thumbnail Format: Topic Card Grid

**Date:** 2026-05-19
**Status:** Pending approval
**Owner:** Yoav
**Prereq:** `_plans/2026-05-18-thumbnail-reference-multimodal.md` (multimodal reference image — shipped 2026-05-18)

---

## Goal

A new thumbnail "Format" that produces, in one click, a single grid-card-style YouTube thumbnail in the exact style of the user's references — black canvas, N×M cards in a grid with white gutters, each card framed by a black border, top portion an isolated single-icon illustration, bottom strip a clean white label band with the card's title in a hand-drawn-style font. The format must:

- Match the reference's structural language (grid, gutters, borders, label strip, font feel).
- **Produce per-card illustrations that are visually appealing, relevant, and SIMPLE — one bold central icon, no embedded text, no busy detail, no UI screenshots, no human faces unless absolutely required by the topic.** Cards must read clearly at the YouTube mobile thumbnail size (~168×94 px). This is the most important content constraint and the reason the user's prior runs produced "messy" output.

---

## Anatomy of the target style

Decomposed precisely so the implementation can lock onto every element:

1. **Canvas**
   - Aspect: 16:9 (YouTube standard).
   - Background: solid pure black.

2. **Grid**
   - N rows × M columns, exact count enforced by prompt.
   - White gutters between cards (~12-16 px equivalent in 1280×720), even on all sides including the canvas edges.
   - All cards same size; grid is uniform, not freeform.

3. **Card frame**
   - 2-3 px solid black border on every card (visible against the white gutter, separates one card from the next).
   - Two stacked regions per card: top illustration (≈80% height), bottom label strip (≈20% height).
   - Hairline divider (1 px black) between the illustration region and the label strip.

4. **Per-card illustration (the simplicity rule)**
   - Black or very dark background.
   - **One bold central icon or symbol**, vertically centered, generously padded from the card edges.
   - Color palette per card: black + 1–2 accent colors (red/amber dominant; green/blue allowed sparingly to match topic).
   - **No embedded text** inside the illustration (no captions, no labels, no UI mockups with words, no numbers as the primary subject unless the topic is a date and the date is the icon itself).
   - **No multi-subject scenes.** One subject only — a worm, a heart, a padlock, a USB stick, a flag, a server, a key. The user's earlier reference (cyber-attacks 3×6) violates this rule on most of its cards (e.g. AOHell shows a person + monitor + interface; Stuxnet shows centrifuges + USB + chart). We are intentionally simpler.
   - No human faces unless the topic is literally a person and there is no usable symbol.
   - Lighting: rim-lit / glow-from-behind / soft-vignette consistent across all cards.

5. **Label strip**
   - Pure white background, full card width.
   - Black text, centered, vertically centered in the strip.
   - Font: hand-drawn humanist style (Caveat / Patrick Hand / Architects Daughter feel). The reference image is the primary anchor for the model; the prompt also describes it verbally as backup.
   - Title length: 1–4 words. Long titles are split to two lines max.

6. **Color cohesion**
   - One global palette across all cards in a single thumbnail (e.g. red-on-black across all 18 cards, not red on some and green on others). The LLM step picks the palette based on niche; the image prompt enforces it.

---

## Why this is achievable today

GPT Image 2 (autoregressive, `gpt-image-2-image-to-image`) is uniquely strong at:
- Rendering legible, consistent typography across many small regions in one image (unlike diffusion models, which mangle text).
- Following structural instructions like "N×M grid" and "no embedded text inside region X".
- Inheriting visual style from a reference image when used in i2i mode.

The user's own reference grids were produced with GPT Image 2 — proof of capability. The current failure mode in the existing thumbnails page is direction, not model capability: the concept generator writes the standard "shocked-face composite scene" prompts, then GPT Image 2 dutifully renders that. Lock the direction, lock the model, and the model produces the format.

---

## Pipeline (two server-side calls per generation)

### Step 1 — LLM "card list" generation (multimodal)

**Model:** Default `kie-gemini-2.5-pro` (vision-capable, multimodal — sees the reference, available on the user's existing Kie account). User can override with any model in the existing `CONCEPT_VISION_MODELS` set.

**Inputs:**
- `title` (the video title)
- `niche`
- `script` (optional)
- `description` (optional)
- `gridRows`, `gridCols` (chosen by user; total = N×M cards)
- `referenceImage` (multimodal attachment — either the user's upload OR the curated default — see "Reference image strategy" below)

**System prompt** (excerpt — full text in code):

> You are designing a YouTube thumbnail in the "Topic Card Grid" format. Given a video title and script, you produce a list of EXACTLY N cards that together cover the video's content at a glance. Every card must be:
> - Conceptually distinct from every other card.
> - Visually expressible as ONE bold central icon or symbol — no scenes, no people, no embedded text, no UI screenshots, no busy detail.
> - Mobile-readable: the icon idea must be recognisable at 168×94 px.
>
> Topics that resist iconification (e.g. abstract concepts) should be rendered as the closest concrete symbol (e.g. "security awareness" → a shield; "data breach" → a broken padlock).
>
> Cards are ordered left-to-right, top-to-bottom in the grid.

**Output JSON schema** (validated server-side):

```json
{
  "cards": [
    {
      "index": 1,
      "label": "Morris Worm",
      "icon_concept": "a single glowing green worm/glitch glyph centred on black, no text, no monitor, no scene",
      "accent_color": "#3ade7a"
    }
    // ... exactly gridRows * gridCols entries
  ],
  "global_palette": {
    "background": "#000000",
    "primary_accent": "#e63a3a",
    "secondary_accent": "#ffb238"
  },
  "title_band_position": "below_image",
  "notes_for_image_model": "Apply rim lighting consistently across all cards. Keep illustrations isolated — no card should bleed visual elements into adjacent cards."
}
```

Validation: card count MUST equal `gridRows * gridCols`. Each `icon_concept` MUST be free of these banned phrases: `text`, `caption`, `screenshot`, `UI`, `interface`, `person`, `face`, `crowd`, `scene`. Failed validation → one retry with stricter instruction → fail with a clear error.

### Step 2 — GPT Image 2 i2i composite

**Model:** `gpt-image-2-i2i` (Kie endpoint). Hard-locked for this format — no override.

**Inputs:**
- Reference image (same one used in Step 1).
- Constructed prompt (template below).
- Aspect 16:9, resolution 1K.

**Prompt template** (constructed server-side from Step 1's output):

```
Create a YouTube thumbnail in the "Topic Card Grid" format, 16:9.

LAYOUT (strict):
- A pure black canvas.
- {N} rows × {M} columns grid of identical-size cards = {N*M} cards total.
- White gutters of even width separating every card (including the outer canvas edge).
- Each card has a 2-3 px solid black border framing it.
- Each card is split into two stacked regions:
  • Top region (~80% height): the illustration.
  • Bottom region (~20% height): a pure white horizontal strip containing the card's label.
- A 1 px black hairline separates the illustration region from the white label strip.

PER-CARD ILLUSTRATION RULES (strict):
- Dark background (black or near-black).
- ONE bold central icon or symbol per card — vertically and horizontally centred, generously padded.
- NO embedded text anywhere inside the illustration.
- NO UI screenshots, NO interface mockups, NO multi-subject scenes.
- NO human faces unless the listed icon_concept explicitly calls for one.
- Color treatment: black background with the accent color noted per card; overall palette across all cards: background {global_palette.background}, primary accent {global_palette.primary_accent}, secondary accent {global_palette.secondary_accent}.
- Apply consistent rim lighting / soft glow across every card.
- Each icon must be recognisable at 168×94 px (YouTube mobile thumbnail size).

LABEL STRIP RULES (strict):
- Pure white background.
- Card label rendered in a hand-drawn humanist font matching the attached reference image's typography (think Caveat / Patrick Hand feel — slight slope, friendly weight, NOT a system sans-serif).
- Label color: solid black.
- Centred horizontally and vertically in the strip.
- Labels go ONLY in the white strip — never overlapping the illustration.

CARD ORDER (left-to-right, top-to-bottom — render exactly these {N*M} cards in this order):

1. Label: "{cards[0].label}" — Illustration: {cards[0].icon_concept}
2. Label: "{cards[1].label}" — Illustration: {cards[1].icon_concept}
...
{N*M}. Label: "{cards[N*M-1].label}" — Illustration: {cards[N*M-1].icon_concept}

ADDITIONAL DIRECTIVES:
- Match the LAYOUT and TYPOGRAPHY of the attached reference image precisely.
- KEEP per-card illustrations SIMPLER than the reference image. The reference shows busy detailed cards; we want clean, iconic, mobile-readable cards. One bold symbol per card, nothing more.
- The grid must contain EXACTLY {N*M} cards — not more, not fewer.
- Do not add a master title, watermark, channel logo, or any text outside the cards.

{notes_for_image_model}
```

Built dynamically. Token budget: GPT Image 2 i2i prompts go up to ~5000 chars per existing Kie image route — the worst-case 6×3 grid produces about 3000 chars, within budget.

### Output

A single image URL returned by Kie.ai. Displayed in the page as one large preview with Download / Copy URL / "Set as YouTube Thumbnail" actions, same as the existing flow but without the 5-concept card stack.

---

## Reference image strategy

The reference image carries two signals: layout structure (grid, gutters, borders) and typography (font feel). For consistency on first-run users who haven't uploaded anything, we ship a **curated default reference** for this format:

- A single 1280×720 PNG, hand-curated to represent the target style with clean, simple per-card icons (NOT the user's busy cyber-attacks example).
- Lives in `public/thumbnail-formats/topic-card-grid-default.png`.
- Generated once by us via GPT Image 2 with this same prompt template + a generic content list (e.g. "fitness apps: weights, water, sleep, steps, heart, scale") so the reference itself follows the simplicity rule.
- Stored in the repo and committed; not regenerated at runtime.

UI: the reference image upload becomes optional for this format. If the user uploads one, theirs is used; otherwise the curated default is used. The curated default is visible as a preview thumbnail in the UI so the user knows the baseline style.

---

## UI/UX changes

All inside the existing `/thumbnails` page — no new route. The page picks up a "Format" mode that swaps the right panel and parts of the left panel.

### Left panel additions

Above the existing `AI Model` field, add a `Format` dropdown:
- `Free-form (5 concepts)` — current behavior, default.
- `Topic Card Grid` — new.
- (Placeholder for future: `N Levels Explained`.)

When `Topic Card Grid` is selected:
- A `Grid size` selector appears (radio group or compact dropdown): `2×2 (4 cards)`, `2×3 (6)`, `3×3 (9)`, `3×4 (12)`, `4×3 (12)`, `4×4 (16)`, `3×6 (18)`, `4×6 (24)`. Default `3×3`.
- The `Image Generation` section collapses to a fixed display: "Image model: GPT Image 2 (locked for this format)". No model picker. Existing `Image Generation` toggle is hidden (always on for this format).
- The Text Overlay & Style block is hidden (typography is driven by the reference image; embedded text is banned per the simplicity rule).
- A new small inline notice next to the reference upload: "Optional — uses our curated style if you don't upload one. Your upload locks the typography to your font."
- The `Generate Concepts` button changes to `Generate Thumbnail`.

### Right panel changes

- Loading state: a single skeleton card (not the 5-card stack).
- Result: one large image preview with Download / Copy URL / Set-as-Thumbnail actions.
- Below the image: a collapsed details accordion showing the LLM-generated card list (label + icon concept per card) so the user can see what was rendered and decide whether to regenerate.
- A `Regenerate` button (re-runs both steps with same inputs) and a `Regenerate with new card list` button (re-runs LLM step with `temperature=0.9` to vary the cards).

### History

Same history machinery, but each entry stores:
- `format: 'topic-card-grid'`
- `gridRows`, `gridCols`
- The full `cards` list from Step 1.
- The final `imageUrl`.

Restore loads the form fields and shows the result. Re-running uses the stored card list as a "seed" the LLM can edit (future enhancement — not v1).

---

## Failure modes and recovery

The prompt is tight, but the model is non-deterministic. Real failures we will hit:

| Failure mode | Detection | Recovery |
|---|---|---|
| Wrong card count (e.g. asked for 18, got 16) | Hard to detect automatically without a vision pass; user sees it in the preview | "Regenerate" button. Add a `?expected_cards=N` annotation in telemetry so we can measure rate. |
| Embedded text leaks into illustrations | Same as above (visual) | Prompt has explicit ban repeated 3×; if it persists across regenerations, the icon_concept itself probably mentions text — Step 1 validation catches that pre-emptively. |
| Cards merge / borders missing | Visual | Regenerate. If frequent, tighten "2-3 px solid black border, clearly visible against the white gutter" — already in prompt. |
| Font drifts from the reference | Visual | If user uploaded a reference, theirs is the anchor; if not, the curated default's font is what comes out. Mismatch with user expectation is honest at the UI level via the "uses our curated style" notice. |
| LLM returns invalid JSON / wrong card count | `parseLlmJson` + count check | One automatic retry with `temperature=0.5` and a tightened instruction ("Return EXACTLY {N} cards. The previous attempt returned {got}, which is invalid."). Fail with a clear error after the retry. |
| LLM proposes a banned icon_concept (e.g. contains "screenshot") | Server-side validation post-Step-1 | Auto-rewrite: ask the LLM to revise just the offending card with a same-prompt retry. Cap at 3 rewrites; fail clearly if still bad. |
| GPT Image 2 returns non-image (Kie error) | Existing kie-poll error handler | Bubble up; same as existing per-card "Generate Image" path. |
| Cost spike | Telemetry on cost-per-generation | Visible in spend log via `featureArea: 'thumbnail_format_topic_card_grid'`. |

---

## Security (rule 13)

No new attack surface beyond what the multimodal reference image fix already covered (SSRF guard on the optional uploaded reference URL — already implemented + already relaxed to `assertSafePublicUrl` due to the R2 dispatcher issue).

Specifically:
- The curated default reference is a static file in `public/` — no user influence.
- The user's optional uploaded reference goes through the same SSRF check.
- The LLM-generated card list is validated against a server-side banlist (`text`, `screenshot`, `UI`, etc.) BEFORE being interpolated into the GPT Image 2 prompt — prompt-injection-resistant by construction.
- Card labels are limited to 50 chars and stripped of newlines/control chars before interpolation.
- No PII flows through this feature; no logs of image bytes.

---

## Observability (rule 14)

Namespace: `[thumb-format-grid]`. Log at every step.

Server (`/api/thumbnails/format/topic-card-grid/route.ts`):
- `[thumb-format-grid] start` — `{ modelId, gridRows, gridCols, has_user_reference: bool }`
- `[thumb-format-grid] llm step done` — `{ duration_ms, cards_count, validation_passed: bool, retries_used }`
- `[thumb-format-grid] llm validation failed` — `{ reason, offending_card_index }`
- `[thumb-format-grid] image step start` — `{ prompt_chars }`
- `[thumb-format-grid] image step done` — `{ duration_ms, task_id }`
- `[thumb-format-grid] done` — `{ total_ms, image_url_host }`
- `[thumb-format-grid] error` — `{ stage, detail }`

Client:
- `console.info('[thumbnails format-grid] sending', { gridRows, gridCols, modelId, hasUserReference })` before the request.
- `console.info('[thumbnails format-grid] received', { imageUrl, cardsCount })` after.

Spend logs: `featureArea: 'thumbnail_format_topic_card_grid'` so we can see cost-per-generation in the existing spend dashboard.

---

## Settings (rule 15)

What gets exposed as user settings:

1. **Format dropdown** — already a per-generation control. Not a global default in v1; if the user wants a permanent default later, add it under Settings → Thumbnails. Out of scope for v1.
2. **Default grid size for Topic Card Grid** — exposed under Settings → Thumbnails → "Default grid size for Topic Card Grid", default `3×3`. Persisted in `localStorage` like the existing thumbnail style prefs.
3. **Use curated reference vs always require upload** — not exposed; the behavior is "use curated if no upload" which is the right default. No knob.

Nothing else is hardcoded that the user might want to flip.

---

## Cost (rule 8)

Per generation:
- 1 × LLM call to `kie-gemini-2.5-pro` (default) — ~500 tokens in (system + user + image), ~1500 tokens out (card list JSON). At Kie's listed pricing of $1.25/M in, $5/M out (per `ai-models.ts`), that's ~$0.0001 + ~$0.0075 ≈ **$0.008 per call**.
- 1 × GPT Image 2 i2i call. Kie.ai's published price for GPT Image 2 has been around $0.04–$0.10 per 1K image at the time of this plan — **verify on the Kie dashboard before merge** per principle 8.

Total per-thumbnail: roughly **$0.05–$0.11**. Compared to the existing "Free-form 5 concepts + 5 separate image generations" path (~$0.25–$0.50), this is cheaper, not more expensive.

Per-generation cost is shown to the user post-generation as a small `Cost: ~$X.XX` line under the image, sourced from the spend log row (same pattern used elsewhere).

---

## File-level change list

New:
- `src/lib/thumbnail-formats/topic-card-grid.ts` — pure module with the prompt builders, the validation schema, and the banned-phrase list.
- `src/app/api/thumbnails/format/topic-card-grid/route.ts` — the new endpoint that runs the two-step pipeline.
- `public/thumbnail-formats/topic-card-grid-default.png` — curated default reference (one-time generated by us).
- `_plans/2026-05-19-thumbnail-format-topic-card-grid.md` — this plan.

Modified:
- `src/app/(app)/thumbnails/page.tsx` — add Format dropdown, grid size selector, swap the right panel when Topic Card Grid is selected, wire to the new endpoint, history entry shape change.
- `src/lib/history.ts` — extend `ThumbnailHistoryEntry` with optional `format`, `gridRows`, `gridCols`, `formatCards` fields. Old entries (no format set) continue rendering as the free-form 5-concept view.
- `src/lib/prompts.ts` — add `topicCardGridLlmPrompt({ title, niche, script, description, gridRows, gridCols })` builder. Reuses the multimodal `image` plumbing on `generateText` (already shipped).
- `src/app/api/thumbnails/generate/route.ts` — unchanged (free-form path stays as-is).

Unchanged but relevant:
- `src/app/api/thumbnails/image/route.ts` — still used for the free-form per-card path. The new format calls `gpt-image-2-image-to-image` directly via the same `createKieTask`/`pollKieResult` helpers, not through `/api/thumbnails/image`, because the format endpoint owns its own prompt construction.
- `src/lib/ai.ts` — already supports `image` via the Kie path (shipped 2026-05-18).

---

## QA plan

Golden path:
1. Pick `Topic Card Grid`, grid `3×3`, niche `Cybersecurity & Antivirus`, title `Every Major Cyber Attack in History Explained in 8 Minutes`, paste script, no reference upload.
2. Click `Generate Thumbnail`.
3. Expect: one 16:9 image with 9 cards in 3×3, black canvas + white gutters + black-bordered cards, single icon per card, white label band per card with the card title, no embedded text in any illustration. Curated-default-style typography.
4. Open the cards-list accordion — confirm 9 distinct labels + icon concepts.

Edge cases:
- Grid `2×2` → 4 cards. Should look spacious, not stretched.
- Grid `4×6` → 24 cards. Highest density; confirm cards stay readable.
- User uploads their own reference (the existing cyber-attacks 3×6) → the model uses their font and structural language but still keeps cards simple (banlist enforces it).
- Title in a language with non-Latin script — confirm labels render (out of scope to guarantee; surface a warning if the model misrenders).
- Script empty, niche empty → LLM should still produce sensible cards from the title alone.
- LLM returns 8 cards instead of 9 → server retries once, then surfaces an error.
- LLM proposes `icon_concept` containing `screenshot` → server rewrites that card, max 3 rewrites.

Regressions to verify:
- Free-form 5-concept path still works (unchanged code).
- Per-concept "Generate Image" on the free-form path still works.
- History restore for both free-form entries and new format entries.
- Schedule-link prefill still works on the page.
- The reference-image SSRF guard still allows R2 URLs (verified on 2026-05-18 fix).

---

## Out of scope

- The `N Levels Explained` format. Lands in a follow-up plan once Topic Card Grid is proven.
- Custom font upload. The reference image carries the font signal — adding a separate font field would either be unused (if we don't composite) or trigger the full compositor build (path B from the earlier discussion). Park.
- A "side-by-side compare" view of reference vs generated. Useful future polish, not v1.
- A drag-replace canvas editor over the generated grid. Path C from the earlier discussion. Park.
- Multi-language label rendering guarantees.
- Variable per-card aspect (some cards big, some small). The format is uniform-grid by design.

---

## Open questions for sign-off

1. **Curated default reference image.** I'll generate it once via GPT Image 2 with the simplicity-locked prompt and commit it. Do you want to approve the rendered PNG before it lands, or fine to ship whatever first looks right?
2. **Grid sizes.** Is the list `2×2, 2×3, 3×3, 3×4, 4×3, 4×4, 3×6, 4×6` the right set, or do you want others (e.g. 5×3, 2×4)?
3. **Title language.** Your examples are English. Hebrew-titled videos — should labels stay English (transliteration) or use Hebrew? GPT Image 2's Hebrew rendering is good but not as reliable as English; flagging up-front.
4. **Default LLM model.** I've set `kie-gemini-2.5-pro` as the default for this format. OK or do you prefer Claude Sonnet 4.6 (direct, vision)?
