# 2026-06-08 — Erase white-fill for sketch styles + OST-mode wiring

Two editor fixes landed today, filed from the same user QA session.

## Bug A — Duplicate text in generated images

### Symptom

"START POINT" appears twice on screen: once baked into the doodle's
pixels (the AI drew it during generation) and once again as a yellow
overlay rendered by Remotion's LowerThird layer.

### Root cause

The editor's three image-gen call sites send `onScreenText` but never
forward `onScreenTextMode`. The `/api/generate/production-doc/image`
route defaults the mode to `'bake'` for back-compat ([route.ts:121-124](src/app/api/generate/production-doc/image/route.ts#L121-L124))
when the field is missing — so the AI gets the bake directive, draws
the text into the pixels, AND the Remotion overlay still renders
because `on_screen_text_mode` on the row resolves to `'overlay'` at
render time.

### Fix

Forward the row's resolved OST mode in all three editor call sites
via the existing `resolveOstRendering` helper. Sites touched in
`src/app/(app)/edit/[projectId]/EditorClient.tsx`:

1. `generateCollageChunk` — the bulk collage worker.
2. `generateOne` — the bulk single worker.
3. `editor-regen` — the per-shot Regenerate button.

No new tests — the mode resolution flows through `resolveOstRendering`
which is already exhaustively tested at [tests/ost-mode-resolution.test.ts](tests/ost-mode-resolution.test.ts).
Typecheck catches signature mismatch.

## Bug B — Erase action produces noisy mosaic on doodle styles

### Symptom

When the user erases part of a hand-drawn doodle (via Brush →
Erase), the result has a wide horizontal band of high-frequency
multi-coloured noise where the painted region was, instead of
clean white canvas.

### Root cause

The erase action always routes through `ideogram/v3-edit` per
[image-edit-pricing.ts:303](src/lib/image-edit-pricing.ts#L303). Ideogram
v3 is a photo-realistic diffusion model. Hand-drawn black-line art on
a plain white background is out-of-distribution for it — when asked to
"rebuild the background seamlessly to match the surrounding image" it
has nothing photographic to anchor on and hallucinates the noisy
mosaic. The integration is technically correct (mask polarity,
dimensions, request shape all match the docs); the model just isn't
fit for this style family.

### Fix

Style-aware erase routing. For the four white-background sketch
styles (`doodle_explainer`, `doodle_explainer_2`,
`paint_explainer_v1`, `whiteboard`), bypass Ideogram entirely and do a
deterministic client-side canvas composite — paint pure white over
every pixel covered by the brush mask, upload the result to R2 via
the existing `/api/uploads/image` presign, and commit the URL.

Photo / cinematic / stock / user-defined styles still route through
Ideogram. The detector returns `false` for user-defined style UUIDs
deliberately — we don't want to silently white-fill a custom style
the user expected to be inpainted.

### Files

- `src/lib/sketch-style.ts` — `isWhiteBackgroundSketchStyle(styleId)`
  closed-set detector. Tested at [tests/sketch-style.test.ts](tests/sketch-style.test.ts).
- `src/lib/editor/white-fill-erase.ts` — `compositeWhiteFill` pure
  pixel logic + `buildWhiteFillBlob` canvas wrapper + `eraseViaWhiteFill`
  full upload pipeline. Pure pixel logic tested at
  [tests/white-fill-erase.test.ts](tests/white-fill-erase.test.ts).
- `src/app/(app)/edit/[projectId]/EditorClient.tsx` — erase handler
  branches on `isWhiteBackgroundSketchStyle(state.doc.style_preset)`.
- `src/app/(app)/production-doc/page.tsx` — same branch on the
  production-doc page's brush editor.

### Why not server-side composite?

The client already has the source image and the mask blob in scope,
plus a working R2 upload via `/api/uploads/image`. Server-side would
mean teaching the erase route to fetch + manipulate image binaries
with `sharp` or similar, doubling the bytes over the wire and adding
a code path the route doesn't currently have. Client composite is
free, instant, and zero new server attack surface.

### Observability

New log namespaces:

- `[editor image-edit] erase` with `{ rowIndex, style, via: 'white-fill' | 'ideogram' }`
- `[editor image-edit] erase success` with `{ rowIndex, via }`
- `[prodoc image-edit] erase success` with `{ rowIndex, via }`

### Cost impact

White-fill saves ~$0.04 per erase action on sketch-style projects.
Photo-style projects unchanged.

### Out of scope

- A per-user Settings toggle to override the auto-routing (e.g. force
  Ideogram on doodle, force white-fill on photo). The user explicitly
  chose the auto-detect path; expose a knob later if real cases come up.
- Server-side compositing fallback. The client path covers the
  reported case; if R2 presign ever breaks, the user sees a clear
  error toast.
- Improving Ideogram behaviour on sketch styles itself — not in our
  control.
