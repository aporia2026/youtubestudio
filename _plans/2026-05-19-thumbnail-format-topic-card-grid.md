# Thumbnail Format: Topic Card Grid

**Date:** 2026-05-19
**Status:** Pending approval (revised after feedback round 1)
**Owner:** Yoav
**Prereq:** `_plans/2026-05-18-thumbnail-reference-multimodal.md` (multimodal reference image — shipped 2026-05-18)

## Revision log

**2026-05-19 r2 — feedback incorporated:**
- Grid size: presets PLUS a custom mode (manual rows × cols).
- LLM model: user-pickable with workspace default; new `thumbnail-format-grid` AppFeature key feeds the existing per-feature resolver.
- Image model: default `gpt-image-2-i2i`, user can override with a warning.
- **Two-step flow**: LLM generates card list → user reviews/edits inline → user clicks Generate Image. Plus a "pre-fill" advanced mode where the user types titles up-front and skips the LLM. Plus a "trust me, generate everything" shortcut.
- **Region marking**: regions computed deterministically from the layout math and returned with the image URL. Auto-flow into production-doc.
- Outer spacing: explicit — outer margin equals inter-card gutter on all four sides of the canvas.
- Curated default reference: generated once by us, committed, approved by user before merge.
- Language: English only for v1 (no Hebrew label rendering).

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
   - **Outer margin**: white space around the entire grid on all four sides (top, bottom, left, right) of the canvas. Width = same as inter-card gutter, so the spacing reads as uniform. The references the user provided show this clearly on the 2×3 antivirus/ransomware examples; we standardize on this regardless of grid size.
   - **Inter-card gutters**: white, even on all sides between cards.
   - Both outer margin and gutters scale with output resolution. At 1280×720 (default): ~14 px. At 1920×1080: ~21 px. (Proportion: ~1.1% of canvas width.)
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

## Pipeline (two-step, with mandatory user review between steps)

The pipeline is split into two server-side calls separated by an editable UI step. This is the change from r1 — the user has confirmed the LLM sometimes picks wrong card titles from the script, and they want a chance to fix them before the (more expensive) image call runs.

```
[User input: title, niche, script, grid size, model, optional reference]
                            │
                            ▼
              ┌─────────────────────────────┐
              │  Step 1 — LLM card list     │   (cheap, fast)
              │  Output: { cards[], palette}│
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │  USER REVIEW + EDIT         │   (UI step, no API call)
              │  - Edit any label           │
              │  - Edit any icon_concept    │
              │  - Reorder cards            │
              │  - Add/remove (if grid       │
              │    custom mode)              │
              └─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │  Step 2 — GPT Image 2 i2i   │   (expensive, slow)
              │  Output: imageUrl + regions │
              └─────────────────────────────┘
```

Two shortcut modes the user can pick instead of the default flow:

- **"Pre-fill mode"** — user provides the card list themselves up-front (paste a comma-separated list of labels), the LLM only fills in `icon_concept` per label. Useful when the user knows exactly what the cards should be and doesn't want the LLM second-guessing the topics.
- **"One-shot mode"** — skip the review step. Step 1 → Step 2 immediately. For confident runs / regenerations.

The default is **two-step with review**. The shortcut modes are surfaced as smaller buttons next to the main "Generate" CTA.

### Step 1 — LLM "card list" generation (multimodal)

**Model:** User-pickable from the AI Model dropdown that already exists on the page. The format-grid feature gets its own `AppFeature` key (`'thumbnail-format-grid'`) so the existing per-feature default-model resolver picks up workspace overrides automatically. Default: `kie-gemini-2.5-pro` (matches what the user has been using). Any model in the existing `CONCEPT_VISION_MODELS` set is allowed.

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

**Model:** Defaults to `gpt-image-2-i2i` (Kie endpoint) — the only model that reliably renders the format's typography. The user can override via the Image Model dropdown, but if they pick anything else the UI shows a warning: "GPT Image 2 i2i is recommended for this format. Other models will produce a different style and likely mangle the per-card typography." We don't block — the user owns the choice.

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

A single image URL returned by Kie.ai, **plus a deterministic regions array** (see next section). Displayed in the page as one large preview with Download / Copy URL / "Set as YouTube Thumbnail" actions, same as the existing flow but without the 5-concept card stack.

---

## Region marking (production-doc ready)

The existing production-doc thumbnail flow has an "Auto-detect regions" button that sends the thumbnail to a vision model to identify each panel of a collage. Since this format owns the layout math, **we can compute every region deterministically and return it with the image URL** — no vision pass needed when the thumbnail lands in production-doc.

### Computation

Given output dimensions `W × H` (default 1280 × 720), grid `rows × cols`, outer margin `OM`, inter-card gutter `G`:

```
card_w = (W − 2·OM − (cols − 1)·G) / cols
card_h = (H − 2·OM − (rows − 1)·G) / rows

For each (row r, col c):
  x = OM + c · (card_w + G)
  y = OM + r · (card_h + G)
  region.full_card  = { x, y, w: card_w, h: card_h }
  region.illustration = { x, y, w: card_w, h: card_h * 0.80 }
  region.label_strip  = { x, y: y + card_h * 0.80, w: card_w, h: card_h * 0.20 }
```

We default to `OM = G = round(W * 0.011)` (≈14 px at 1280, 21 px at 1920) — see anatomy section.

### Output shape

The format's API response carries the regions alongside `imageUrl`:

```ts
{
  imageUrl: string;
  regions: ThumbnailRegion[]; // same shape as src/remotion/types.ts
}
```

Where each entry's `label` is the card's label (same one in the white strip), `id` is a fresh uuid, and `(x, y, w, h)` is the **full card** rectangle (illustration + label strip) — this matches what the production-doc region editor expects for a zoom target.

### Wiring

Three places consume this:

1. **Thumbnail history entry** — stores `regions` alongside the imageUrl so a restored entry brings the regions with it (no re-computation, no vision call).
2. **Schedule-link saver** — when the user presses the existing "Save to schedule item" CTA on the thumbnails page, the `buildPatch` extends to include `thumbnail_regions: regions`. Project / schedule-item / production-doc schema already accepts a regions array on the linked thumbnail (verified against existing ThumbnailRegionEditor consumer in `src/components/production-doc/ThumbnailRegionEditor.tsx`).
3. **"Set as YouTube Thumbnail"** flow — when the user pushes the image to a channel video via the existing dialog, the regions ride along on the same payload. The downstream channel/video record already stores regions when present.

Net effect: when the user generates a Topic Card Grid thumbnail and lands it on a section divider in production-doc, the regions are already there. The "Auto-detect regions" button becomes a no-op fallback for non-grid thumbnails.

### Edge cases

- **User uses one-shot mode and the model produces a wrong card count** (asked for 9, got 8): the computed regions assume 9; the 9th region maps to empty canvas. The user sees the misalignment in the preview and regenerates. We can also do a vision-based sanity check post-generation but it's not worth the cost for v1; visual review catches it.
- **User overrides the image model** (e.g. picks Nano Banana): regions still computed deterministically — they describe the INTENDED layout, even if the actual rendered image doesn't match. We surface a warning at save-time: "Regions assume the Topic Card Grid layout. Your generated image used a different model; regions may not align."

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

**Grid size — presets + custom:**
- A row of preset chips: `2×2`, `2×3`, `3×3`, `3×4`, `4×3`, `4×4`, `3×6`, `4×6`. Default `3×3`.
- After the chips, a `Custom…` chip that reveals two number inputs labelled "Rows" and "Cols" (1–8 each), live-validated. The count below updates ("12 cards"). Custom is its own grid value — picking a preset clears custom and vice versa.

**Image model — defaults locked-recommended but overridable:**
- A small Image Model dropdown appears with `GPT Image 2 (Image-to-Image) — recommended` as the highlighted default. Other i2i models are pickable but selecting them shows an inline warning under the dropdown: "This format is calibrated for GPT Image 2. Other models will produce a different style."
- T2I models are NOT in this list (the reference image is mandatory for the format's typography lock).

**Hidden / collapsed:**
- The existing Text Overlay & Style block is hidden (typography is driven by the reference image; embedded text is banned per the simplicity rule).
- The "Enable image generation" toggle is hidden — always on for this format.

**Reference image:**
- Small inline notice next to the reference upload: "Optional — uses our curated style if you don't upload one. Your upload locks the typography to your font."
- Preview shows whichever reference is active (user-uploaded OR the curated default).

**Mode chips for the generation flow:**
- A small row of three mode chips above the main CTA: `Review cards` (default), `Pre-fill cards`, `One-shot`.
  - `Review cards`: standard two-step flow (LLM → review → image).
  - `Pre-fill cards`: a `Card titles` textarea appears below the script field — one title per line. Step 1 only fills in icon concepts.
  - `One-shot`: skip review, run both steps back-to-back.
- The CTA label changes with the mode:
  - `Generate card list` (Review cards)
  - `Generate thumbnail` (Pre-fill cards — runs both because the user already provided titles)
  - `Generate thumbnail` (One-shot)

### Right panel — TWO states

**State A — after Step 1 (Review mode):**
The right panel shows an editable card table. One row per card with:
- Drag handle (reorder)
- `#` column (index)
- `Label` text input
- `Icon concept` text input (longer, with placeholder showing the model's suggestion)
- `Accent color` swatch (click to edit; defaults to the global palette)
- A small "🗑 Delete" button (only enabled when in Custom grid mode where total cards is the count of rows)

Below the table:
- Validation banner showing card count vs grid count. If they don't match, the `Generate Image` button is disabled with a clear message.
- A `Regenerate card list` button (re-runs Step 1, temp 0.9, discards edits with confirm).
- The primary `Generate Image` button.
- An estimated cost line: "≈ $0.05–$0.11 per generation" (sourced from the format's cost projection).

**State B — after Step 2 (image rendered):**
- Single large image preview with Download / Copy URL / Set-as-Thumbnail / "Copy regions JSON" actions.
- A collapsed accordion showing the final card list (read-only) for reference.
- A `Region overlay` toggle that draws the computed region boxes over the preview — visual sanity check that the rendered grid lines up with our region math.
- A `Regenerate image` button (re-runs Step 2 only, same card list) and an `Edit cards` button (returns to State A).

### History

Same history machinery, but each entry stores:
- `format: 'topic-card-grid'`
- `gridRows`, `gridCols`, `gridMode: 'preset' | 'custom'`
- `mode: 'review' | 'pre-fill' | 'one-shot'` (the flow mode the user generated under)
- The full **edited** `cards` list (post-review, the one that was actually fed to Step 2).
- The final `imageUrl`.
- The computed `regions` array.
- The reference image URL that was used (so restore + regenerate uses the same anchor).
- The LLM model used + the image model used.

Restore loads the form fields, the card list (in editable form), and the result image. The user can immediately tweak any card and click `Regenerate image` without re-paying for Step 1.

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

Namespace: `[thumb-format-grid]`. Log at every step in every endpoint.

Server — `/api/thumbnails/format/topic-card-grid/cards`:
- `[thumb-format-grid cards] start` — `{ modelId, gridRows, gridCols, mode, has_user_reference, prefilled_count }`
- `[thumb-format-grid cards] validation failed` — `{ reason, offending_card_index, retries_so_far }`
- `[thumb-format-grid cards] done` — `{ duration_ms, cards_count, retries_used }`
- `[thumb-format-grid cards] error` — `{ stage, detail }`

Server — `/api/thumbnails/format/topic-card-grid/image`:
- `[thumb-format-grid image] start` — `{ imageModelId, gridRows, gridCols, cards_count, prompt_chars, has_user_reference }`
- `[thumb-format-grid image] regions computed` — `{ regions_count, outer_margin, gutter, card_w, card_h }`
- `[thumb-format-grid image] done` — `{ duration_ms, task_id, image_url_host }`
- `[thumb-format-grid image] error` — `{ stage, detail }`

Client:
- `console.info('[thumbnails format-grid cards] requesting', { gridRows, gridCols, modelId, mode })`
- `console.info('[thumbnails format-grid cards] received', { cardsCount, editsApplied: 0 })`
- `console.info('[thumbnails format-grid image] requesting', { cardsCount, imageModelId, editsApplied })`
- `console.info('[thumbnails format-grid image] received', { imageUrl, regionsCount })`

Spend logs: two separate entries per generation —
- `featureArea: 'thumbnail_format_topic_card_grid_cards'` for Step 1 (LLM)
- `featureArea: 'thumbnail_format_topic_card_grid_image'` for Step 2 (image)

So the cost dashboard can attribute cleanly even when the user runs Step 1 multiple times before locking in a card list.

---

## Settings (rule 15)

What gets exposed as user settings:

1. **Format dropdown** — already a per-generation control. Not a global default in v1; if the user wants a permanent default later, add it under Settings → Thumbnails. Out of scope for v1.
2. **Default grid size for Topic Card Grid** — exposed under Settings → Thumbnails → "Default grid size for Topic Card Grid", default `3×3`. Persisted in `localStorage` like the existing thumbnail style prefs.
3. **Use curated reference vs always require upload** — not exposed; the behavior is "use curated if no upload" which is the right default. No knob.

Nothing else is hardcoded that the user might want to flip.

---

## Cost (rule 8)

The two-step flow lets the user pay for Step 1 separately from Step 2, which is the right shape: regenerate-card-list is cheap, regenerate-image is expensive.

Per Step 1 (LLM card list):
- 1 × LLM call to `kie-gemini-2.5-pro` (default) — ~500 tokens in (system + user + image), ~1500 tokens out (card list JSON). At Kie's listed pricing of $1.25/M in, $5/M out (per `ai-models.ts`), that's ~$0.0001 + ~$0.0075 ≈ **$0.008 per Step 1 call**.

Per Step 2 (image):
- 1 × GPT Image 2 i2i call. Kie.ai's published price for GPT Image 2 has been around $0.04–$0.10 per 1K image at the time of this plan — **verify on the Kie dashboard before merge** per principle 8.

Per full generation (Step 1 + Step 2): roughly **$0.05–$0.11**. Per re-generate-card-list: just Step 1, ~$0.008. Per re-generate-image (same cards): just Step 2.

Compared to the existing "Free-form 5 concepts + 5 separate image generations" path (~$0.25–$0.50), this is cheaper end-to-end and lets the user iterate on the card list without burning image-generation budget.

Per-generation cost is shown to the user post-generation:
- Below the card-list table on State A: `Step 1 cost: ~$X.XX` and `Estimated Step 2: $0.05–$0.10`.
- Below the result image on State B: `This generation: ~$X.XX (cards ~$0.01 + image ~$X.XX)`.

Sourced from the spend log rows; same pattern used elsewhere.

---

## File-level change list

New:
- `src/lib/thumbnail-formats/topic-card-grid.ts` — pure module with the LLM prompt builder, the image-prompt builder, the card-list validation schema, the banned-phrase list, and the **region computation function** (pure: `computeRegions(width, height, rows, cols, outerMargin, gutter): ThumbnailRegion[]`). Unit-testable in isolation.
- `src/app/api/thumbnails/format/topic-card-grid/cards/route.ts` — Step 1 endpoint. Inputs: `{ modelId, title, niche, script?, description?, gridRows, gridCols, mode, referenceImageUrl?, prefilledLabels? }`. Returns: `{ cards: [...], global_palette: {...} }`.
- `src/app/api/thumbnails/format/topic-card-grid/image/route.ts` — Step 2 endpoint. Inputs: `{ imageModelId?, cards: [...], global_palette: {...}, gridRows, gridCols, referenceImageUrl?, outputWidth?, outputHeight? }`. Returns: `{ imageUrl, regions, taskId }`. Computes regions deterministically before calling the image model so the response is one round-trip.
- `public/thumbnail-formats/topic-card-grid-default.png` — curated default reference (one-time generated by us; user approves before merge).
- `_plans/2026-05-19-thumbnail-format-topic-card-grid.md` — this plan.

Modified:
- `src/app/(app)/thumbnails/page.tsx` — add Format dropdown, grid-size selector (presets + custom), mode chips (Review / Pre-fill / One-shot), the new editable card table (State A right panel), the result panel with region overlay toggle (State B), wire to the two new endpoints, history entry shape change.
- `src/lib/history.ts` — extend `ThumbnailHistoryEntry` with optional `format`, `gridRows`, `gridCols`, `gridMode`, `mode`, `formatCards`, `regions`, `formatReferenceImageUrl`, `formatImageModel` fields. Old entries (no format set) continue rendering as the free-form 5-concept view.
- `src/lib/ai-models.ts` — add `'thumbnail-format-grid'` to the `AppFeature` union and a corresponding `AppFeatureSpec` so the per-feature default-model resolver picks it up. Default model: `kie-gemini-2.5-pro`.
- `src/lib/prompts.ts` — re-export `topicCardGridLlmPrompt` and `topicCardGridImagePrompt` builders from `thumbnail-formats/topic-card-grid.ts` for symmetry with the existing prompt exports.
- `src/app/api/thumbnails/generate/route.ts` — unchanged (free-form path stays as-is).

Schedule-link / saver integration:
- The existing `ScheduleSaverRegistration` on `thumbnails/page.tsx` extends its `buildPatch` so the patch carries `thumbnail_regions: regions` whenever the active result is a format-grid generation.
- No schema change needed on the receiving side — production-doc + ThumbnailRegionEditor already accept a `regions` array on a thumbnail record.

Unchanged but relevant:
- `src/app/api/thumbnails/image/route.ts` — still used for the free-form per-card path. The new format endpoints call `gpt-image-2-image-to-image` directly via the same `createKieTask`/`pollKieResult` helpers, not through `/api/thumbnails/image`, because the format endpoint owns its own prompt construction.
- `src/lib/ai.ts` — already supports `image` via the Kie path (shipped 2026-05-18).
- `src/app/api/production-doc/thumbnail/auto-regions/route.ts` — unchanged. Becomes a fallback used only when a thumbnail wasn't produced by this format.

---

## QA plan

Golden path (Review mode — default):
1. Pick `Topic Card Grid`, grid `3×3`, mode `Review cards`, niche `Cybersecurity & Antivirus`, title `Every Major Cyber Attack in History Explained in 8 Minutes`, paste script, no reference upload.
2. Click `Generate card list`. Right panel shows 9 editable rows.
3. Confirm all 9 labels are distinct and plausibly from the script. Edit one label (e.g. change "Solar Sunrise" → "First Nation-State Hack"); edit one icon concept.
4. Click `Generate Image`.
5. Expect: one 16:9 image with 9 cards in 3×3, black canvas + outer margin + white gutters + black-bordered cards, single icon per card, white label band per card with the EDITED card titles, no embedded text in any illustration. Curated-default-style typography.
6. Toggle `Region overlay` — confirm the 9 region boxes line up visually with the 9 cards.
7. Click `Set as YouTube Thumbnail` (or `Save to schedule item`) — confirm `thumbnail_regions` is persisted on the receiving record.

Golden path (Pre-fill mode):
1. Same starting state but pick `Pre-fill cards`.
2. Type 9 labels in the textarea, one per line.
3. Click `Generate thumbnail`.
4. Expect: Step 1 only fills in icon concepts for the provided labels; Step 2 generates the image with those exact labels.

Golden path (One-shot mode):
1. Same starting state but pick `One-shot`.
2. Click `Generate thumbnail`.
3. Expect: both steps run back-to-back without showing the review table.

Edge cases:
- Grid `2×2` → 4 cards. Should look spacious, not stretched.
- Grid `4×6` → 24 cards. Highest density; confirm cards stay readable.
- Custom grid `5×3` → 15 cards. Confirm validation accepts it and layout math holds.
- Custom grid `9×9` → 81 cards. Confirm we reject above the cap (max 8 each in plan).
- User uploads their own reference (the cyber-attacks 3×6) → the model uses their font and structural language but still keeps cards simple (banlist enforces it).
- User edits the card list to a count that doesn't match the grid (e.g. deletes a row in 3×3 leaving 8) → `Generate Image` is disabled with a clear validation message.
- Script empty, niche empty → LLM should still produce sensible cards from the title alone.
- LLM returns 8 cards instead of 9 → server retries once, then surfaces an error; review-mode UI still renders the 8 it got so the user can fix it.
- LLM proposes `icon_concept` containing `screenshot` → server rewrites that card, max 3 rewrites.
- User overrides the image model to Nano Banana → warning banner shown in left panel; warning persists on the result image; saved entry tags the image model used so the user can see why a future restore looks different.
- User picks `One-shot` then realises a label is wrong → clicks `Edit cards` on State B, lands back in the editable table with the actual card list, fixes label, clicks `Regenerate image` (Step 2 only — no new Step 1 spend).

Regressions to verify:
- Free-form 5-concept path still works (unchanged code).
- Per-concept "Generate Image" on the free-form path still works.
- History restore for both free-form entries and new format entries.
- Schedule-link prefill still works on the page.
- The reference-image SSRF guard still allows R2 URLs (verified on 2026-05-18 fix).
- Production-doc's `Auto-detect regions` still works on free-form thumbnails.

---

## Out of scope

- The `N Levels Explained` format. Lands in a follow-up plan once Topic Card Grid is proven.
- Custom font upload. The reference image carries the font signal — adding a separate font field would either be unused (if we don't composite) or trigger the full compositor build (path B from the earlier discussion). Park.
- A "side-by-side compare" view of reference vs generated. Useful future polish, not v1.
- A drag-replace canvas editor over the generated grid. Path C from the earlier discussion. Park.
- Multi-language label rendering guarantees.
- Variable per-card aspect (some cards big, some small). The format is uniform-grid by design.

---

## Open questions / decisions

Closed in r2:
- ~~**Title language.**~~ → English only for v1. Documented in revision log.
- ~~**Default LLM model.**~~ → `kie-gemini-2.5-pro` default, user-pickable, workspace default flows through the per-feature resolver. Documented.
- ~~**Grid sizes.**~~ → Presets `2×2, 2×3, 3×3, 3×4, 4×3, 4×4, 3×6, 4×6` + Custom mode (1–8 rows × 1–8 cols).
- ~~**Curated default reference image.**~~ → I'll generate it via GPT Image 2 with the simplicity-locked prompt; you approve before merge.

Still open:
1. **Approval gate for the curated default PNG.** Concretely: do you want me to commit a draft PNG as part of the build PR so you can see it in the diff, or generate and DM it to you before I start the PR? Both work — let me know your preferred review surface.
2. **Region overlay default state.** When State B renders, should `Region overlay` start ON or OFF? Default ON forces you to see whether regions align; default OFF gives a cleaner first-look. Lean ON.
3. **Two-step vs implicit auto-Step-1.** When the user picks `Topic Card Grid` and immediately clicks the CTA without changing the mode chip from default Review, the CTA reads `Generate card list`. Is that fine, or do you want it to always say `Generate thumbnail` and silently auto-advance the user through the review state? Lean keeping `Generate card list` — it sets expectations that the next click is the costly one.
4. **Custom grid max.** I capped Custom at 8×8 = 64 cards. Above that GPT Image 2 starts to drift. Are you OK with that cap, or do you want it tighter (4×4 max) / looser (10×10)?
