# Thumbnail concepts — let the LLM SEE the reference image

**Date:** 2026-05-18
**Status:** Approved
**Owner:** Yoav
**Files touched:** `src/app/(app)/thumbnails/page.tsx`, `src/app/api/thumbnails/generate/route.ts`, `src/lib/prompts.ts`

## Problem

On `/thumbnails`, the user uploads a reference image (e.g. a 3×6 grid of clean tile-style thumbnails) and asks for "same style with an image for every title". The system generates concepts in a completely different style (one composite scene, shocked face, big yellow sticker text).

Root cause: the reference image only reaches `/api/thumbnails/image` (per-card image generation). The upstream `/api/thumbnails/generate` (which writes each concept's `image_generation_prompt`) is text-only — it never sees the reference. So the concept generator writes the standard YouTube formula, and the per-card prompts that drive the final images describe that formula, overriding the i2i style hint.

## Goals

1. The concept generator can see the reference image and write `image_generation_prompt` values that match its style.
2. The reference image styling propagates through to each generated thumbnail naturally (because each prompt now describes the right style), with no extra i2i tricks required.
3. Backwards compatible: if no reference image is uploaded, behavior is unchanged.

## Constraints

- Must not break the existing per-card "Generate Image" flow.
- Must not crash on a non-vision model — degrade gracefully or fail loud with a clear message.
- SSRF-safe — match the existing competitor-thumbnail-analyze pattern (`resolveAndPinSafeUrl`).
- Size-cap the fetched image (≤8 MB, matches existing pattern).
- No regressions for runs without a reference image.

## Approach (chosen)

**Wire the reference image into the concept generator, multimodally.**

1. **Client** (`page.tsx`):
   - `generateConcepts()` already has `referenceImageUrl` in state. Send it in the POST body alongside `title/niche/script/description`.
   - When the user has a reference + has picked a non-vision model, show a toast warning suggesting a vision-capable model. Don't block — let them generate anyway, but make the gap visible.

2. **API** (`/api/thumbnails/generate`):
   - Accept optional `referenceImageUrl` in the body.
   - If present:
     - Validate model is vision-capable (allowlist mirroring the competitor-thumbnail route).
     - SSRF-pin-and-fetch the URL (`resolveAndPinSafeUrl`).
     - Cap declared + actual buffer at 8 MB.
     - Base64-encode + capture mime type.
     - Pass `image: { base64, mimeType }` into `generateText`.
   - If validation fails: return 400 with a clear, actionable message (don't silently drop the image).

3. **Prompt** (`thumbnailConceptPrompt`):
   - Accept new optional `hasReferenceImage: boolean`.
   - When true, prepend a STYLE-LOCK section in the user message telling the model:
     "A reference image is attached. EVERY concept's `image_generation_prompt` must describe a thumbnail in that *exact visual style* — match the layout, color treatment, level of detail, typography density, whether faces are used, and the relationship between visual and label. This is non-negotiable. The 5 concepts may differ in subject and emotional trigger but the visual language stays constant."
   - This shifts the model from "default YouTube formula" to "vary the *content*, hold the *style*".

## Rejected alternatives

- **Option B (text-only description workaround):** put a verbal style spec in the description field. Works in a pinch but the user has to maintain a verbose description and the model can still hallucinate; it doesn't solve the structural blind spot.
- **Force i2i in the per-card step with a strong "match exactly" prompt suffix:** doesn't work — GPT Image 2 i2i with a grid reference still follows its prompt more than its reference, and other i2i models behave similarly. Fix has to be upstream.
- **Build a separate "style extraction" pre-step that turns the image into a written style spec, then feeds that to the text-only concept generator:** more moving parts, more failure points, more spend. Direct multimodal call is simpler.

## Security

- The reference URL is user-supplied. We pin DNS + block private ranges via `resolveAndPinSafeUrl` (already used by the competitor route).
- Cap fetched buffer at 8 MB. Reject content-length > 8 MB before reading, then re-check after the read.
- Only HTTPS allowed (enforced by `assertSafePublicUrl`).
- Vision-model allowlist: explicit set; reject everything else with a 400.
- No new logs of image content. Only log the URL host + byte size + duration.

## Observability

Per rule 14, log at each step. Namespace `[thumb-concepts]`:

- `[thumb-concepts] generate start` — `{ modelId, niche, has_reference: bool }`
- `[thumb-concepts] reference fetch` — `{ host, bytes, duration_ms }`
- `[thumb-concepts] reference rejected` — `{ reason }` when SSRF/size/format fails
- `[thumb-concepts] model not vision` — `{ modelId }` when a reference was given on a non-vision model
- `[thumb-concepts] generate done` — `{ concepts_count, duration_ms }`

Client side, single `console.info('[thumbnails generate] sending', { hasReference, model })` line in `generateConcepts()`.

## Settings (rule 15)

Nothing new to expose. The reference-image upload, model picker, and image-generation toggle are already user-controlled. No new defaults are being baked in — when a reference is present, we use it; when not, the prompt is unchanged.

## QA plan

Golden path:
- Upload reference → pick a vision-capable model → generate concepts → confirm the 5 `image_generation_prompt` fields describe thumbnails matching the reference's style (no faces if the reference has none, grid-card layout if the reference is grid-card, etc.).
- Generate per-card images and confirm the visual style now reads as the reference's style.

Edge cases:
- No reference uploaded → behave exactly as before (no image sent, no change in output).
- Reference uploaded + non-vision model picked → toast warning on the client, server logs `[thumb-concepts] model not vision`, returns 400 with a "pick a vision-capable model" message.
- Reference URL is a private IP / localhost → SSRF guard rejects with a clear 400.
- Reference URL is huge (≥8 MB) → rejected with a 413-style "too large" error.
- Reference URL 404s → 502 with "failed to fetch reference image".

Regressions to check:
- Per-card "Generate Image" still works for both T2I and I2I models.
- History restore still works (reference URL is not persisted in the concept history yet — that's a separate concern, out of scope here).
- Schedule-link prefill still works.

## Out of scope

- Persisting the reference URL into thumbnail history (so it auto-restores). Worth doing later but not part of this fix.
- Showing the user a side-by-side "reference vs first generated image" comparison preview.
- Multi-reference (more than one style anchor).
