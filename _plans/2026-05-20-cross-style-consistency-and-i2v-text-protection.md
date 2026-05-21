# Cross-style image consistency + i2v text/number protection

**Date:** 2026-05-20
**Status:** Approved direction, alternatives rejected, ready to implement
**Owner:** Yoav
**Applies to:** every existing and future video style — doodle, cinematic, 2D animation, infographic, photoreal, anything we add. This is a system-level upgrade, not a doodle-only patch.
**Files touched:** `src/lib/production-doc-styles.ts`, `src/lib/prompts.ts`, `src/app/api/generate/production-doc/image/route.ts`, `src/app/api/generate/production-doc/image/edit/route.ts`, `src/lib/broll.ts`, `src/lib/broll-types.ts`, `src/lib/migrations/00XX_*` (two new migrations), `src/components/production-doc/*`, `src/remotion/scenes/BRollScene.tsx`

## The two problems

### Problem A — images within a single video aren't from "the same artist"

Today a style is a text suffix glued to every prompt ([production-doc-styles.ts:140-167](src/lib/production-doc-styles.ts#L140-L167)). Every image is generated independently — no seed carry-over, no reference image, no character sheet, no LoRA. Two stick figures from scene 1 and scene 7 of the same doodle video can have different head shapes, line weights, color palettes, and visual hand. The current suffix locks the *category* of look ("doodle"), not the *identity* of the look.

### Problem B — i2v warps existing text/numbers/logos into gibberish

The May 19 plan ([_plans/2026-05-19-overlay-controls-and-animation-text-preservation.md](_plans/2026-05-19-overlay-controls-and-animation-text-preservation.md)) shipped a strengthened prompt tail in [broll.ts](src/lib/broll.ts) and a `NO_TEXT_NEGATIVE_PROMPT` for Kling 2.5/2.6. It is the right first move and it isn't enough. **i2v models re-render every frame; prompt instructions are advisory, not enforced.** No phrasing will reliably stop Kling from morphing a "$1,234" or a clock face. We were fighting the architecture with a prompt — now we fight it with pixels.

## Goals

1. Every image in a video shares the same visual language — same character, palette, line weight, lighting, perspective, level of stylisation — for every style we ship.
2. i2v animation never warps text, digits, letters, logos, wordmarks, or symbols. Zero gibberish. Hard guarantee at the pixel level, not at the prompt level.
3. Both improvements apply automatically to existing styles AND to every future style — no per-style configuration burden.
4. Cost ceiling unchanged: per-Animation-row spend stays ≤ ~$0.50 (the May 14 plan's ceiling). Per-image-gen spend goes up by no more than ~30% on average.

## Non-goals

- LoRA training. We don't have the hosted-LoRA infra and the value/cost ratio is wrong for our volume.
- Replacing the existing image-model registry or i2v model registry. We're adding flows, not swapping models.
- Re-architecting how styles are *defined* — the text-suffix system stays. Consistency is added on top, not replacing it.
- Auto-detecting brand mentions and routing them differently (that's covered by the May 19 plan, already in flight).

## Constraints

- Must work with current Kie / R2 stack. No new providers in v1.
- Must not break docs already generated under the old flow. Old rows keep their old images.
- No regressions to existing i2v / t2v paths (Sora 2 t2v, Veo 3.1, Kling all-tiers stay working as today).
- Cost increase per video must be predictable and visible in the UI before the user clicks Generate.
- Security/safety baked in from day one (rule 13). Observability baked in from day one (rule 14). Settings audit before "done" (rule 15).

## Decisions (aligned with user 2026-05-20)

| Decision | Choice |
|---|---|
| Consistency scope | **v1: Reference chaining. v2: Style sheet.** Ship both — chaining first, style sheet after. |
| i2v hallucination scope | **Option D + Option E both.** D is the pixel-level fix; E is the cheaper-+-safer router. |
| Council pass | Skipped per user. Going straight to plan. |
| Apply to every style? | Yes. This is a system-wide upgrade, not a doodle-specific patch. |

## Pre-existing work we build on (do NOT rebuild)

1. **`google/nano-banana-edit` already wired** at [src/app/api/generate/production-doc/image/edit/route.ts](src/app/api/generate/production-doc/image/edit/route.ts). Takes `image_urls: [src]` + prompt and returns an edited image. ~$0.02/call. **This is the reference-chaining engine.** We don't add a new endpoint; we add a new *call site*.
2. **`gpt-4o-image-edit`** also wired in the same file with mask support (low=$0.02 / medium=$0.07 / high=$0.19). Available as a fallback for harder consistency cases.
3. **Multimodal-LLM-sees-reference pattern** from [_plans/2026-05-18-thumbnail-reference-multimodal.md](_plans/2026-05-18-thumbnail-reference-multimodal.md). Same shape works for style-sheet-aware prompt writing.
4. **i2v negative prompt + strengthened tail** in [broll.ts](src/lib/broll.ts) + [broll-types.ts](src/lib/broll-types.ts). Keep both — they cover the "no hallucinated new text" angle. The new work covers the orthogonal "no warping of existing text" angle.
5. **R2 image mirroring + saliency** already plumbed in the edit route. Re-use as-is.
6. **`computeImageSaliency`** at [src/lib/image-saliency.ts](src/lib/image-saliency.ts). Possibly useful as a starting point for the OCR/text-region detector.

---

## Implementation — phased

### v1 — Reference chaining (ships first, ~1-2 days)

**One sentence:** Scene 1 is the anchor. Every later scene is generated by `google/nano-banana-edit` with the anchor passed as `image_urls`, so it inherits the anchor's visual identity.

**Mechanism:**

1. Add `anchor_image_url` and `anchor_image_prompt` (text) columns to `production_doc` (or wherever the doc top-level state lives — to be confirmed during implementation; if it's a JSON blob, add fields there). New migration.
2. On the **first** image generation in a doc: generate normally via [src/app/api/generate/production-doc/image/route.ts](src/app/api/generate/production-doc/image/route.ts) (existing t2i flow). On success, write `anchor_image_url = result.imageUrl` and `anchor_image_prompt = prompt`.
3. On **every subsequent** image generation: detect that `anchor_image_url` exists and route to `google/nano-banana-edit` with:
   - `image_urls: [anchor_image_url]`
   - prompt = `"Generate a new scene in the EXACT same visual style, character design, palette, line weight, and level of detail as the reference image. Do not redraw the reference; create a different scene that looks like it came from the same artist's pen. The new scene: " + rowPrompt`
4. Add a "Re-anchor" button on the row UI: regenerate the anchor (calls the t2i path explicitly, ignoring chaining). When the user clicks this on row N, all later rows that were generated via chaining are flagged as `style_stale: true` so the editor shows a "regenerate" hint. (Behavior intentionally non-destructive — we don't auto-regenerate, we just flag.)
5. Add a per-doc "Use reference chaining" boolean, default ON for built-in styles, surfaced in the doc header. When OFF, every row uses the old independent t2i path (escape hatch for any case where chaining hurts more than it helps — e.g. a style that benefits from variety more than consistency).

**Cost impact:** ~$0.02 per chained image (nano-banana-edit) vs. ~$0.03-0.05 per t2i image (current). **Net: same or slightly cheaper.** Verify against the latest Kie pricing screen before commit per rule 8.

**Why nano-banana-edit specifically:** Gemini 2.5 Flash Image is the strongest semantic-style transfer model currently wired in Kie at this price point. It preserves style well without being a strict pixel-edit (which would over-anchor). The `gpt-4o-image-edit` path stays available as a per-row escape hatch via the existing UI.

### v2 — Style sheet (ships after v1, ~3-5 days)

**One sentence:** At the start of a doc, generate a single 16:9 "world sheet" image containing the protagonist (front + 3-quarter view), 2-3 key props, palette chips, and line-weight samples. Every row is chained against the sheet *instead of* against scene 1.

**Why this is better than chaining-to-scene-1:**

- Scene 1 is a *scene*, not a *style reference*. Chaining off it carries scene-specific content (background, camera angle, framing) into later rows. Chaining off a sheet carries only the visual language.
- Sheets are deliberately designed to anchor identity. They make every character draw consistently.
- LLM that writes per-row prompts can also see the sheet (multimodal pattern from the May 18 thumbnails plan) so the *prompts themselves* describe the world in the sheet's language.

**Mechanism:**

1. New endpoint `POST /api/generate/production-doc/style-sheet` — given doc id + style id + (optional) script summary, generates a 16:9 image with a layout prompt like:
   > A reference style sheet for a short video in the [style_label] style. Show: a main character drawn in three poses (front view, three-quarter view, action pose); 2-3 key visual props relevant to the video's topic; a horizontal palette strip with 5 color swatches; one line of sample line-weight strokes. All on a clean light background, organized as a grid. NO text, NO labels, NO captions — pure visual reference.
2. Store `style_sheet_url` + `style_sheet_prompt` on the doc.
3. Update `productionDocPrompt` ([src/lib/prompts.ts](src/lib/prompts.ts)) to accept the sheet as a multimodal input (same pattern as `2026-05-18-thumbnail-reference-multimodal.md`) and to write `ai_image_prompt` values that reference the sheet's character/palette/line-weight.
4. Per-row image generation, when `style_sheet_url` is present, chains against the sheet (not against scene 1).
5. UI: a small "Style sheet" thumbnail preview in the doc header, click to regenerate. Mirrors the existing reference-image upload pattern from /thumbnails.

**Cost impact:** +1 nano-banana-edit call per doc (~$0.02-0.05) to make the sheet. **Negligible.** Net per-row cost stays at chaining levels.

**Edge case:** when a doc has no protagonist (e.g. abstract infographic style), the sheet is generated as palette + line-weight + props only. The prompt builder branches on style metadata: `has_protagonist?: boolean` added to the style spec.

### v3a — i2v Option D (pixel-level text protection, ships after v1)

**One sentence:** OCR the still before i2v, inpaint detected text regions to blank, run i2v on the text-free still, composite the original text back in Remotion at render time.

**Mechanism:**

1. **New helper module** `src/lib/still-text-protect.ts` with a single async function `detectAndExtractText(stillImageUrl: string): Promise<{ regions: Array<{ bbox: [x,y,w,h], text: string, confidence: number }>, scrubbedImageUrl: string | null }>`.
2. **OCR step:** use **Tesseract.js** as v1 (free, runs in Node, good enough on rendered text which is typically large + high-contrast). If quality proves insufficient in QA, swap to a Replicate OCR model or Google Cloud Vision (~$1.50/1k reqs) per rule 8 cost analysis. **No cloud OCR in v1 unless Tesseract clearly fails QA** — keeps cost at zero.
3. **Detection threshold:** only protect regions where `confidence >= 0.65` AND the matched text is ≥ 2 chars. Single-char or noisy matches are ignored. Numeric-only regions get a lower threshold (0.50) since digit recognition is easier and digit warping is the most-reported failure mode.
4. **Scrubbing step:** if regions detected, send the still + a mask of the text bboxes to `gpt-4o-image-edit` with prompt `"Cleanly remove the masked text/digits, replace with the surrounding background or surface. Do not add any new content. Preserve everything else exactly."` Mask is generated server-side as a black/white PNG, white=preserve / black=regenerate (matches the existing edit-route mask convention). Result is the `scrubbedImageUrl`.
5. **i2v step:** if scrubbing succeeded, send `scrubbedImageUrl` to the i2v model. The model never sees the text — it cannot warp what isn't there.
6. **Composite step in Remotion:** new prop on `BRollScene` — `textOverlays: Array<{ bbox, text, fontSpec }>`. When present, render the original text as a typography layer over the playing i2v video at the bboxes. Text is read directly from the OCR result. Font is sniffed from the original still (heuristic: nearest match from a 4-font palette) OR rendered with the doc's default editorial font.
7. **Storage:** OCR results + scrubbed image URL + region metadata persist on the `broll_clips` row (new columns added via migration). Re-render is idempotent.
8. **Fallback:** if OCR fails OR scrubbing fails OR there are no text regions, fall back to the existing direct-i2v path with the strengthened prompt tail. No regression.

**Why this works where prompts don't:** the i2v model is no longer asked to "preserve" text — it never sees text. Text re-appears at render time via Remotion's `AbsoluteFill + AbsoluteText`, which is pixel-accurate by construction. The only failure mode is "OCR missed a region" — and missed regions still get the prompt-tail defense as a safety net.

**Cost impact:** +1 OCR call (free with Tesseract) + 1 gpt-4o-image-edit medium call ($0.07) on text-heavy stills only. **Worst case: +$0.07 per text-heavy clip.** OCR is local, no per-call cost.

### v3b — i2v Option E (content-routed model selection, ships alongside v3a)

**One sentence:** When OCR detects text regions in the still, route the i2v call to a text-safer model (Sora 2 i2v) instead of the user's default (typically Kling 2.5 Turbo).

**Mechanism:**

1. After OCR runs in v3a: if `regions.length > 0` AND the user hasn't explicitly pinned a model on this row, override the model from Kling-default to `sora-2-i2v-10s`.
2. UI shows a small badge `"auto-routed: Sora 2 (text-safer)"` on the cell so the user understands why their default was bypassed.
3. Per-doc setting (and per-user setting): "Auto-route text-heavy stills to text-safer i2v" — default ON, can be disabled.
4. Per-row override: right-click → "Pin model: Kling 2.5T" forces the default.

**Cost impact:** Sora 2 i2v 10s = $0.15, Kling 2.5T = $0.42. Routing **saves $0.27 per text-heavy clip**. Net spend goes *down* on the affected clips. (Verify Sora 2 pricing has not moved since 2026-05-18 before commit per rule 8.)

**Why both D and E:** D is the hard guarantee (the model never sees the text). E is the second layer — for any regions OCR misses or for clips where the user opts out of D, E gives the safest model. Together they cover the failure surface from both directions.

---

## Cost analysis (rule 8)

All prices verified or pending verification against current Kie pricing screens before commit. Verify before merging.

| Step | Model | Price/call | Verified? |
|---|---|---|---|
| Anchor image (scene 1) | Grok Imagine / Flux 2 / etc | ~$0.03-0.05 | Per existing IMAGE_MODELS, needs re-check |
| Chained image (scene 2..N) | `google/nano-banana-edit` | ~$0.02 | Per [edit/route.ts:31](src/app/api/generate/production-doc/image/edit/route.ts#L31) comment — re-verify |
| Style sheet (once per doc) | `google/nano-banana` | ~$0.02-0.05 | Re-verify |
| OCR | Tesseract.js | $0.00 | Open source |
| Scrub (text-heavy only) | `gpt-4o-image-edit` medium | $0.07 | Per [edit/route.ts:38](src/app/api/generate/production-doc/image/edit/route.ts#L38) — re-verify |
| i2v (text-heavy, routed) | Sora 2 i2v 10s | $0.15 | Per broll-types.ts comment, verified 2026-05-18 |
| i2v (no text, default) | Kling 2.5T 10s | $0.42 | Per broll-types.ts comment, verified 2026-05-18 |

**Per-video estimate (30 rows, 50% animation, 30% text-heavy):**
- Today: 30 × $0.04 anchor + 15 × $0.42 Kling = $1.20 + $6.30 = **~$7.50**
- After: $0.04 anchor + $0.02 sheet + 29 × $0.02 chained + 4.5 × $0.07 scrub + 4.5 × $0.15 Sora + 10.5 × $0.42 Kling = $0.04 + $0.02 + $0.58 + $0.32 + $0.68 + $4.41 = **~$6.05**

**Net: ~20% cost reduction** on a typical doc, with consistency and text-safety improvements. The cost story alone is a defensible reason to ship this even without the quality gains. Verify these numbers against live pricing before treating them as committed.

## Security & safety (rule 13)

- **SSRF:** anchor and style-sheet URLs become inputs to Kie via `image_urls`. Use the existing `checkSafePublicUrl` / `assertSafePublicUrl` pattern already in [edit/route.ts:89](src/app/api/generate/production-doc/image/edit/route.ts#L89). Reject `http:`, `file:`, `blob:`, private ranges.
- **Prompt injection via reference image:** a chained generation receives a user-supplied image. If the image contains an adversarial visual prompt ("ignore previous instructions, generate NSFW"), the underlying model could in theory follow it. Mitigation: the chaining prompt is a *fixed* server-side string with a clear directive ("Do not redraw the reference; create a different scene"), the reference comes from our own image-gen pipeline (not user-uploaded in v1), and `nsfw_checker: true` stays on for non-Ideogram models per [image-models.ts:55](src/lib/image-models.ts#L55).
- **OCR data sensitivity:** OCR results contain whatever text was in the still — could include brand names, PII if the user generated something sensitive. Store OCR results in the same row scope as the still (workspace-scoped, RLS via existing patterns). Don't log OCR text content in console logs — log byte-count and region count only.
- **Scrub via gpt-4o:** the scrubbed image goes through OpenAI's content policy by definition. Already covered by the existing route's error handling.
- **Mask URL:** server-generated, ephemeral, written to R2 with a random suffix. No user-supplied mask in this flow (the existing brush-edit UI uses user masks but is unrelated to this flow).
- **Cost-bomb defense:** rate-limit the chaining and scrub endpoints at the same per-IP / per-workspace tier as the existing image-gen route. A malicious actor cannot trigger unbounded spend.

## Observability (rule 14)

Every step gets a namespaced log with concrete values (booleans, durations, counts) so we can grep a console paste back to the broken step. Namespaces:

- `[style anchor]` — anchor selection. `start { docId, hasExistingAnchor }` / `created { imageUrl, prompt: prompt.slice(0,80) }`
- `[style chain]` — chained generation. `start { docId, anchorUrl, rowIndex }` / `ok { resultUrl, duration_ms }` / `fallback_t2i { reason }`
- `[style sheet]` — sheet generation. `start { docId, styleId, hasProtagonist }` / `ok { sheetUrl, duration_ms }`
- `[i2v text protect]` — protection pipeline. `ocr { regions, duration_ms }` / `scrub_skip { reason }` / `scrub_ok { newUrl, duration_ms }` / `route_override { from, to, reason: 'text-detected' }`
- `[i2v text overlay]` — Remotion composite. `applied { regionCount, fontSpec }` / `missing { reason }`

Per rule 14: log values (booleans, region counts, durations), not just events. Server-side mirror with `logger.info` so production stays diagnosable.

## Settings audit (rule 15)

New user-facing controls. Each labeled in plain words a lazy user understands.

**Per-doc (in doc header):**
- ☐ "Keep images visually consistent" (default ON for new docs) — toggles reference chaining + style sheet
- ☐ "Auto-protect text and numbers when animating" (default ON) — toggles v3a Option D
- ☐ "Auto-route text-heavy scenes to text-safer animator" (default ON) — toggles v3b Option E

**Per-row (right-click menu):**
- "Re-anchor from this image" — promote this row's image to the doc anchor
- "Skip text protection for this scene" — disable v3a for one scene
- "Pin animator: …" — override the auto-routed model

**Per-style (style editor):**
- Style has a new `has_protagonist?: boolean` field — drives whether the style sheet renders a character pose grid or props-only.

**User defaults (`collaborators.encrypted_settings`):**
- `consistency_mode: 'chain_and_sheet' | 'chain_only' | 'off'` — sticky preference, defaults to `chain_and_sheet` once v2 ships.

Settings are grouped: top of header = doc-level consistency; bottom of header = i2v safety. Plain English labels. No jargon ("anchor", "style sheet" are deliberately hidden from the user UI — they're internal terms; user sees "keep consistent" / "auto-protect text").

## Open questions

1. **Tesseract.js bundle size on Vercel functions** — Tesseract.js with English-only language data is ~2 MB. Confirm fits under the function size limit and cold-start is acceptable. If not, route OCR through a server-only Node API route (always cold-tolerable) or move to a Replicate OCR model. Verify before v3a implementation.
2. **Anchor sensitivity** — chained generations may over-anchor (every scene looks too much like scene 1). If QA finds this, lower the anchor's influence by adding a "vary the scene composition significantly" directive to the chain prompt OR move to gpt-4o-image-edit (looser style transfer than nano-banana). Decide empirically.
3. **Font matching in v3a composite** — sniffing the original still's font is hard. v1 ships with a 4-font heuristic palette (sans, serif, mono, hand). v2 could use OCR's font hints if any model exposes them, or generate the composite text in the doc's default editorial font (probably the cleanest answer).
4. **Backfill on existing docs** — for docs already generated under the old flow, do we offer a "regenerate all images with consistency" button, or leave existing docs alone? Recommend: leave alone, surface a hint banner "this doc was made before consistency — regenerate to update."

## Alternatives rejected

- **LoRA per style.** Strongest possible consistency but requires hosted LoRA training/serving infra we don't have. Cost and engineering both out of scope for now.
- **Seed-locking only.** Trivial to implement, but different prompts on the same seed still drift substantially. Net zero benefit when scenes describe different content (which is always).
- **Replacing Kling outright with Sora 2 for everything.** Sora 2 is cheaper per clip but Kling preserves 2D / illustrated styles markedly better on non-text scenes. Routing by content is strictly better than blanket switching.
- **OCR text → instruct i2v to "freeze these specific regions" via prompt.** Same architectural problem as the existing strengthened tail — prompts are advisory. Diffusion models do not honour prompt-level "freeze pixel X,Y" commands reliably. Pixel-level intervention is the only fix.
- **Frame-freeze post-hoc** (OCR the output video, detect drift, splice in the original text region). Possible but high engineering for marginal gain over Option D, which prevents the problem entirely.
- **Vertex AI Imagen 4 with multi-image reference.** Currently not exposed via Kie; would need direct Vertex integration. Re-evaluate in v3 if nano-banana-edit + sheet aren't enough.

## QA plan (run before declaring done)

**v1 — Reference chaining:**
- Generate a 5-row doodle doc → confirm rows 2-5 share scene 1's character / palette / line weight.
- Generate the same doc in cinematic style → confirm consistency holds (not doodle-only).
- Click "Re-anchor from this image" on row 3 → confirm rows 1-2 are flagged stale, rows 4-5 are flagged stale, button works.
- Toggle "Keep consistent" OFF mid-doc → confirm subsequent rows use plain t2i, previous chained rows untouched.
- Open an old doc (pre-v1) → confirm no automatic re-generation, hint banner visible.

**v2 — Style sheet:**
- Generate a new doc → confirm style sheet appears in doc header, contains character poses + palette + line-weight samples.
- Regenerate the sheet → confirm cache invalidates, next image-gen uses the new sheet.
- Style with `has_protagonist: false` → sheet renders props + palette only, no character grid.
- Click any thumbnail in the sheet preview → magnified view (UX nice-to-have).

**v3a — Text protection:**
- Generate a still with the number "07" prominently rendered → OCR detects it → scrub blanks it → i2v plays without "07" warping → Remotion composites "07" back at the right bbox, frozen across the clip.
- Repeat with a brand wordmark ("Microsoft").
- Generate a still with no text → confirm OCR skips, no scrub call, direct i2v as today.
- Force OCR failure (e.g. malformed image) → confirm fallback to direct-i2v path, error logged, no user-visible crash.
- Disable text protection for one row → confirm direct i2v on that row, protection still on for others.

**v3b — Content routing:**
- Generate a text-heavy still → confirm `auto-routed: Sora 2` badge appears on the cell, model field in DB shows `sora-2-i2v-10s`, $0.15 deducted.
- Disable auto-routing → confirm Kling is used as the user's default.
- Pin Kling on a text-heavy row → confirm routing skipped, Kling used.

**Regressions to check (rule 6 — extreme QA):**
- Existing text-to-video B-roll generation unchanged.
- Existing image-edit endpoint (brush UI) unchanged.
- Render pipeline for clips made BEFORE v3a (no text overlays stored) still renders correctly.
- Cost-budget gauges in the doc header reflect the new per-row prices correctly.
- The May 19 plan's strengthened prompt tail stays in place as the safety net.

## Out of scope

- LoRA / fine-tune training of any style.
- Multi-anchor blending (use 2+ anchors together).
- Auto-detecting from script text that a row will need text protection (we use OCR on the rendered still, which is more reliable than script parsing).
- Migration of existing docs.
- Style consistency across DIFFERENT docs (e.g. "all my channel's videos look the same"). That's a channel-level brand-kit problem, not addressed here.
- Per-row font matching beyond the 4-font heuristic palette.

## Implementation order (smallest, highest-signal first)

1. **v1 reference chaining** — schema migration + chaining call site in image route + per-doc toggle + tests. Smallest deliverable that moves the needle on Problem A.
2. **v3b content routing** — OCR module + router branch. Independently shippable from v3a; gives partial Problem-B improvement at zero cost.
3. **v3a text protection (full pipeline)** — scrub + Remotion composite. Heaviest piece; ship last in the i2v workstream.
4. **v2 style sheet** — endpoint + prompt builder update + UI. Ship after v1 + v3 are stable so we have a baseline to compare against.

Each step is independently shippable and reversible (per-doc toggle for v1, per-doc toggle for v3a/b, per-doc toggle for v2). No big-bang merge.

---

## TL;DR for the future Claude session that picks this up

- **Problem A** (consistency) is fixed by routing scene 2..N to `nano-banana-edit` with scene 1 as `image_urls`. The endpoint is [already wired](src/app/api/generate/production-doc/image/edit/route.ts) — repoint, don't rebuild.
- **Problem B** (i2v warps text) is fixed by OCR-ing the still, blanking text regions with `gpt-4o-image-edit`, running i2v on the blanked image, and compositing the original text back in Remotion. The i2v model never sees text → cannot warp text.
- Both apply to every style by virtue of operating at the pipeline level, not the prompt level.
- Cost goes *down* ~20% on a typical doc because routing text-heavy stills to Sora 2 saves more than the new OCR/scrub adds.
- Settings, security, observability, and QA sections above are the non-negotiable contract for "done."
