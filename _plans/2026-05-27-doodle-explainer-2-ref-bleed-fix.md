# Plan: `doodle_explainer_2` ref-bleed + edge-crop fix

**Date:** 2026-05-27
**Status:** Approved, executing now
**Triggered by:** Production output on project `7fafe333-e199-4a87-bb55-ee51ba904889`
showing baked-in "WANNACRY" text + padlock motifs in unrelated content, plus
cropped section title at top + cropped callout at bottom.

## Goal

Stop the doodle_explainer_2 i2i pipeline from bleeding WannaCry-specific text
and motifs into outputs, and stop generated images from being cropped at the
top or bottom edges.

## Findings (root cause)

The `nano-banana-2-i2i` model receives the 14 reference frames bundled under
[public/style-refs/Doodle-explainer-2/](public/style-refs/Doodle-explainer-2/)
as visual style guides. i2i models faithfully reproduce **what is in the refs**
— including baked-on text. All 14 refs have a subject-specific heading drawn
into the top of the frame (`Wannacry`, `Russian Sleep Experiment`, `Stairs in
the Woods`, `Stuxnet`, `YouAreAnIdiot`, `Goggle.com`) and several carry
subject-coded visual motifs (padlock-on-screen callouts, skull-and-crossbones,
red X over deleted files, nuclear centrifuges).

The text-prompt rules in
[src/lib/production-doc-styles.ts:529](src/lib/production-doc-styles.ts#L529)
that say "the AI image generator should NEVER include [the section title]"
are addressed to the **script-writing LLM**, not to the diffusion model.
Diffusion models do not reliably honor "do not draw X" when refs show X on
every frame.

Separately, [src/lib/prompt-augmentation.ts:120](src/lib/prompt-augmentation.ts#L120)
adds a `safeTopDirective` only when the section-title layout is `overlay` —
no equivalent safe-bottom directive exists at all. The "THINK AHEAD!" callout
bleeding off the bottom edge of the second sample image is a direct
consequence.

### Deeper cropping investigation (2026-05-27, after user pushback)

User flagged that top-title bleed is NOT the only cropping cause. Investigation found two additional cropping vectors:

**3. The Atlas GPT-Image-2 i2i path crops 7.8% off the top and bottom.**
Atlas's GPT-Image-2 family only accepts square / 3:2 sizes; the dispatcher
generates at 1536×1024 then center-crops to 1536×864 (16:9). That crop
removes 80 px from the TOP and another 80 px from the BOTTOM — 7.8% per
edge. Any element the model placed in those edge bands is destroyed by
the crop, even though the model itself drew the image "correctly" within
its 3:2 canvas. The user confirmed their project uses Atlas OR Kie
GPT-Image-2 (NOT nano-banana — `nano-banana-2-i2i` returns 16:9 natively
and skips the crop step). The crop comes from
[generateImageWithRefsAtlas in image-gen-i2i.ts:625](src/lib/image-gen-i2i.ts#L625)
and the spec entry for `gpt-image-2-atlas-i2i` at
[image-models-i2i.ts:163](src/lib/image-models-i2i.ts#L163).

Implication: the safe-edge directive must guard a band wider than 7.8%
to leave any of the model's intended margin alive after the crop. The
plan now sets the directive to **10%** (~2% headroom over the crop).

**4. The pipeline variant edit path skipped the crop step entirely.**
[production-doc-image-gen.ts:247](src/lib/auto-pipeline/production-doc-image-gen.ts#L247)
called `generateAtlasEdit({size: '1536x1024'})` then went straight to
`upscaleViaRecraft` — no `cropTo16x9AndUpload` in between. The collage
route ([collage/route.ts:259](src/app/api/generate/production-doc/collage/route.ts#L259))
and the t2i dispatcher both do the crop; the pipeline variant path was
the lone gap. Result: variant images were stored at 3:2, then displayed
in a 16:9 BRollScene slot with `object-fit: cover`, which sliced ~10%
off the top AND bottom at render time. Different mechanism than the
dispatcher crop, but identical user-visible effect.

Fixed in this plan by adding the missing `cropTo16x9AndUpload` call
between Atlas Edit and the Recraft upscale.

## Constraints

- **i2i model cap:** `nano-banana-2-i2i` accepts at most 14 ref images per
  call. We drop 3 and keep 11 — well below the cap, plenty of headroom.
- **No schema changes.** Style id stays `doodle_explainer_2`; only the
  bundled image files under `public/style-refs/Doodle-explainer-2/` change.
- **Atlas Edit needs public URLs** — refs must be uploaded to R2 with a
  temporary prefix before each edit call.
- **Cost ceiling: $0.50.** 11 edits × ~$0.011 + retries + one test render.

## Requirements

1. After this plan ships, regenerating any row on project `7fafe333` with
   `style_preset='doodle_explainer_2'` produces an image that:
   - Does NOT contain the word "Wannacry", "Stuxnet", or any other
     subject-specific text leaked from the refs.
   - Does NOT contain a padlock-on-screen icon, red skull-and-crossbones, or
     red-X-over-files unless the script topic genuinely calls for it.
   - Keeps all illustration content fully inside the 1920×1080 canvas with at
     least 6% padding from every edge.
2. Existing style id `doodle_explainer_2` continues to resolve via
   `getBuiltInStyle('doodle_explainer_2')`.
3. The 3 dropped refs (07, 08, 11) are removed from disk and the count is
   verifiably 11 after the change.

## Chosen approach

Three independent changes, executed in order:

### A. Reference image cleanup (11 edits, 3 drops)

Per-ref triage based on visual inspection of all 14 refs:

| # | Action | What changes |
|---|---|---|
| 01 | Erase text | Remove "Russian Sleep Experiment" heading + "creepypasta wiki" corner watermark |
| 02 | Erase text | Remove "Russian Sleep Experiment" heading |
| 03 | Erase text | Remove "Stairs in the Woods" heading |
| 04 | Erase text | Remove "Wannacry" heading |
| 05 | Erase text + edit motif | Remove "Wannacry"; replace padlock-on-screen icons in the four callouts with neutral computer-monitor icons |
| 06 | Erase text + edit motif | Remove "Wannacry"; replace red skull-and-crossbones on center laptop with a neutral exclamation/alert icon |
| 07 | **Drop** | Subject-coded TV-with-red-X is unrecoverable as a neutral example |
| 08 | **Drop** | Subject-coded Windows-XP-inside-TV is unrecoverable as a neutral example |
| 09 | Erase text + edit motif | Remove "Wannacry" heading; replace "Within hours" yellow bubble text with a placeholder like "Example text" (the bubble shape is the demo, not the words) |
| 10 | Erase text | Remove "Wannacry" heading |
| 11 | **Drop** | Subject-coded globe-with-padlocks is unrecoverable AND redundant with edited #5 |
| 12 | Erase text | Remove "Stuxnet" heading (red skull head is a generic horror motif, keep) |
| 13 | Erase text + edit motif | Remove "Stuxnet" heading; replace centrifuge photo inside the frame with a generic mountain/landscape photo (the framed-photo-inset PATTERN is the demo, the subject is the leak) |
| 14 | Erase text | Remove "Goggle.com" heading |

Implementation: one-off Node script at
`scripts/fix-doodle-explainer-2-refs.ts` that, for each ref needing edits:
1. Uploads the source ref to R2 under prefix `tmp-doodle-ref-edits/`.
2. Calls `generateAtlasEdit` from `src/lib/atlas-cloud-images.ts` with the
   appropriate per-ref prompt and `size: '1536x1024'`.
3. Downloads the result, saves to `public/style-refs/Doodle-explainer-2/`
   (overwriting the original).
4. Cleans up the temp R2 object.
5. Logs each step via `console.info('[fix-refs ...]')` for observability.

The script is idempotent — re-running it edits the already-edited refs again.
**The user reviews each output before re-running.** If an edit comes back
visibly broken (Atlas refused, drew over the wrong region, mangled the doodle
style), the user can keep the original by manually restoring from git.

### B. Safe-edge directive in prompt-augmentation

Update [src/lib/prompt-augmentation.ts:120](src/lib/prompt-augmentation.ts#L120)
to always prepend a safe-edge directive (currently only safe-top fires, and
only for the `overlay` layout):

```
Composition fits fully inside the visible frame with AT LEAST 10% empty
margin from every edge. No text, faces, callouts, props, titles, or
background elements extend within 10% of the top, bottom, left, or right
edge of the canvas. All important content is centered in the inner 80%
of the frame.
```

Always-on. The cost is ~310 chars of prompt budget (well under the
SINGLE_SHOT_PROMPT_CAP of 2000).

Margin sized at 10% (not the typical 5–6%) specifically to outlive the
Atlas dispatcher's 7.8% center-crop. Repetition of the numeric value +
edge enumeration is deliberate — diffusion models obey concrete numbers
more reliably than abstract "safe area" language.

This is style-agnostic and helps every i2i style, not just doodle_explainer_2.

### B′. Wire the missing crop in the pipeline variant path

Add the dispatcher-style `cropTo16x9AndUpload` between `generateAtlasEdit`
and `upscaleViaRecraft` in
[production-doc-image-gen.ts:247](src/lib/auto-pipeline/production-doc-image-gen.ts#L247).
Without this, the variant lands at 3:2 in storage and gets sliced by
`object-fit: cover` at render time. With the crop wired in, variant
outputs match the base-image aspect contract (always 16:9 in storage).

### C. Verification on project 7fafe333

After A and B ship:
1. Open the failing project in the editor.
2. Identify 3-5 rows that previously showed the bleed.
3. Click regenerate. Verify outputs:
   - No "Wannacry" anywhere.
   - No padlock-on-screen unless the row's topic justifies it.
   - All composition stays inside the canvas.

## Alternatives rejected

1. **Drop more aggressively (refs 05/06/13 too — leaves 8 refs).** Rejected:
   user explicitly chose the 11-ref bundle. The motif edits on 05/06/13 are
   cheap enough that we don't need to lose those compositional examples.
2. **Re-extract refs from a different doodle-explainer source video.** Rejected:
   largest scope of work and not needed today. May revisit later if the
   editing pass produces visible quality loss.
3. **Negative-prompt + safe-edge directives only (no ref changes).** Rejected:
   the user picked option 1 (erase text from refs) over option 4 (prompts
   only) because i2i model weight on refs typically beats negative prompts.
   Listed for completeness.
4. **Atlas T2I to fully regenerate each ref from scratch.** Rejected: T2I
   loses the exact stick-figure style that makes the refs valuable as i2i
   guides. Edit preserves the doodle style; T2I would produce a different
   style entirely.
5. **Manual edits in Photoshop/GIMP.** Rejected: user picked Atlas Edit via
   script. Manual gives perfect control but costs the user ~30 minutes of
   hand-editing.

## Open questions

None blocking execution.

## Security

- The script writes to R2 under a temp prefix and reads back the Atlas
  output URLs. R2 keys live in env vars (already provisioned). Atlas API key
  also in env.
- The 11 edited refs are checked into git under `public/style-refs/`.
  They contain no PII or secrets — just doodle illustrations.
- No user-supplied data crosses this path; the script is operator-only and
  runs locally.

## Observability

- The script logs every step with `[fix-refs <step>]` namespacing:
  - `[fix-refs upload]` per ref uploaded to R2
  - `[fix-refs atlas-edit]` per Atlas call with prompt + duration + cost
  - `[fix-refs download]` per result saved to local disk
  - `[fix-refs skip]` per ref skipped (drop list)
  - `[fix-refs done]` final summary with total cost
- The `augmentCellPrompt` change inherits the existing
  `[prompt-augmentation truncated]` log line; no new log needed since the
  directive is fixed-overhead and won't cause truncation.

## Settings audit

Nothing user-facing changes here — this is a built-in style internal fix.
No new toggles to expose. The 6% safe-edge margin in the augmentation
directive is a global default; if a future style needs a different margin,
that becomes a per-style override on `ResolvedStyle` — out of scope today.

## QA checklist

- [ ] 11 ref files exist in `public/style-refs/Doodle-explainer-2/`, all with
      no baked-on text
- [ ] 3 dropped refs (07, 08, 11) are removed from disk
- [ ] `getBuiltInStyle('doodle_explainer_2')` still resolves
- [ ] `tsc --noEmit` clean
- [ ] `augmentCellPrompt` returns the safe-edge directive in its output
      `prompt` field (add a unit test or eyeball it)
- [ ] Regenerating a row on project 7fafe333 produces an output free of the
      bleed (human-eye verification on the canvas)
