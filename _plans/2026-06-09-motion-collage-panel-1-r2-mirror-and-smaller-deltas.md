# Motion-collage: persist panel 0 + reduce per-panel composition drift

Date: 2026-06-09
Status: Approved

## Problem

Two complaints from the editor:

1. **Panel 1 of every motion collage shows as a black rectangle with "Panel 1 of 4" overlaid.**
   The overlay is the browser's `<img alt>` fallback text — the URL is dead. Confirmed regression from commit `d526ec70 fix(motion-collage): native 16:9 panel 0 — no more top/bottom crop`.
   Before: Atlas T2I → 1536×1024 → `cropToAspectAndUpload` (R2 upload as a side effect) → 1536×864 R2 URL → Recraft upscale (1536 < 2000 threshold, runs) → persistent Kie/Recraft URL.
   After: Atlas T2I → 2560×1440 → crop step removed → Recraft upscale skipped (2560 > 2000) → **raw Atlas CDN URL** persisted in `motion_collage_panel_urls[0]`. Atlas URLs are ephemeral. URL works long enough for panels 1..N to chain off it, then expires and the editor renders a broken image.
   Panels 2..N stay alive because they go through `generateGptImage2Edit` → Atlas Edit at 1536×1024 → `cropToAspectAndUpload` → R2 URL — separate code path that kept its persistence step.

2. **Composition drifts visibly across panels.** Character/background/object positions shift between panels even when the user only asked for a single motion. Result: jumpy, not animated. Architectural limitation of chained Atlas Edit; the model re-imagines composition every call. Existing dual-input anchor mitigation isn't enough when each panel's prompt asks for a big delta (e.g. "George 1/3 across" → "George 2/3 across").

## Goals

1. Panel 1's URL is persistent — survives indefinitely after generation.
2. Auto-filled panel prompts ask the image model for smaller per-step changes, so composition drift between consecutive panels is less visible.
3. Default grid for new conversions has enough frames that small deltas can still cover the motion.

## Non-goals

- No backfill script for existing docs with broken panel 1 — user regenerates the row or runs single-panel regen.
- No change to the dual-input / fan-out chain logic itself.
- No image-to-video alternative (conflicts with user's saved "near-static animation = Atlas Edit variants" rule).
- No new user-facing settings — the smaller-delta rules are quality fixes, not preferences.

## Approach

### Fix 1 — R2 mirror for panel 0

Add a helper next to `cropToAspectAndUpload` in `src/lib/image-gen-dispatch.ts`:

```ts
export async function mirrorImageToR2(srcUrl: string, r2KeyPrefix: string): Promise<string>
```

Fetches the source bytes, uploads to R2 under the given prefix, returns the R2 download URL. No crop, no re-encode (preserve the source bytes verbatim to keep PNG transparency / quality intact).

In `src/lib/auto-pipeline/production-doc-image-gen.ts`, `generateMotionCollage`'s panel 0 block:
- After `generateAtlasI2I` / `generateAtlasT2I` returns, call `mirrorImageToR2(atlasUrl, 'prodoc-images-motion-collage-panel-0')` before the upscale step.
- Use the R2 URL as the `croppedUrl` input to `upscaleViaRecraft` (upscale still skips because 2560 > 2000, but returns the R2 URL unchanged).
- The `panel0FromCache` Atlas-Edit branch is already persistent via `generateGptImage2Edit` → `cropToAspectAndUpload`; no change there.

Add a namespaced log: `[motion-collage panel-0-mirror]` carrying source vs. mirrored URL preview, bytes, and ms. Grep target for "did panel 0 persist?".

### Fix 2 — Smaller deltas, more panels

Two coordinated changes.

**A) LLM panel-fill prompt** (`src/lib/motion-collage-panel-fill.ts`):

Add a new section MOTION DELTA right after ELEMENT-SCALE IS LOCKED. Core rules:
- The delta between consecutive panels should be SMALL — a single limb segment moving, a head turning a few degrees, one prop sliding a short distance.
- It is BETTER for the final panel to show "the motion is nearly complete" than for each panel to leap 1/N of the way. Tiny deltas read as smoother motion than evenly-divided large jumps.
- Anti-pattern: "panel 1: at start. panel 2: 1/3 way. panel 3: 2/3 way. panel 4: at end." This invites the image model to re-imagine composition every step.
- Good pattern: "panel 1: at start. panel 2: tiny step forward, leading foot leaving ground. panel 3: foot landing, trailing foot lifting. panel 4: trailing foot mid-stride." Each step is a small visual change.

**B) Default grid bump** (`src/components/editor/inspector/ConvertToMotionCollageButton.tsx`):

Change `DEFAULT_GRID` from `{ cols: 2, rows: 2 }` (4 panels) to `{ cols: 3, rows: 3 }` (9 panels). User can still pick 2×2 from the preset row; the default just gives the LLM more frames to spread small deltas across.

**C) Doc-generation canonical example** (`src/lib/production-doc-styles.ts`):

Update the `doodle_explainer_2` mixing-rules CANONICAL JSON example to show a 3×3 grid, with a note that 2×2 is only appropriate for very small motions (a single arm raise, a head turn). The existing 6-panel running example stays as the second worked example.

## Security / safety

- `mirrorImageToR2` is a fail-fast path — it throws on fetch failure, on R2 upload failure, on missing bucket config. Panel 0 generation already wraps the whole block in try/catch and surfaces `panel_0_threw:*` to the caller, so a mirror failure naturally becomes a panel-0 failure (not a silent broken-URL). This matches the rest of the pipeline's posture.
- The new R2 prefix `prodoc-images-motion-collage-panel-0` is its own key prefix so existing R2 lifecycle rules + storage metrics show motion-collage panel 0 distinctly from the other paths.

## Observability

- New log namespace: `[motion-collage panel-0-mirror]` — emitted on every mirror, with `bytes`, `ms`, `src_url_preview`, `r2_url_preview`. When the user reports "panel 1 still broken," grep this first.
- Existing `[motion-collage pipeline] panel done` log gets the panel-0 URL in its `url` field — already there; the change is that the URL is now an R2 URL not an Atlas one.

## Testing

- `tests/motion-collage-validation.test.ts` — extend the happy-path test to assert `mirrorImageToR2` is called once for panel 0 on the non-cache branches, and the returned URL flows into `panelResults[0]`. Mock `mirrorImageToR2` to return a distinct sentinel URL.
- `tests/motion-collage-panel-fill.test.ts` — extend with one new case asserting the system prompt contains the new MOTION DELTA section's anti-pattern marker (a unique sentinel string from the new copy).

## Cost implications

- Fix 1: zero extra cost. The mirror replaces a non-persistence with an R2 upload — pennies per million.
- Fix 2: default grid bump 2×2 → 3×3 = 4 → 9 panels = **2.25× per-row image-gen cost on newly-converted rows**. Current per-shot ≈ $0.054 (1 panel-0 + 3 Atlas Edits). New ≈ $0.121 (1 panel-0 + 8 Atlas Edits). Existing rows are unaffected until the user changes their grid.
- User explicitly accepted this tradeoff when picking "Smaller deltas, more panels."

## Alternatives rejected

1. **Revert d526ec70.** Loses the ~7.8% top/bottom crop fix that commit shipped. Going back to 1536×1024 + crop means labels and character heads start clipping at the edge again.
2. **Image-to-video for motion shots** (e.g. Kling i2v on panel 0). Best motion quality, but conflicts with the user's saved rule "near-static animation = Atlas Edit variants" — that rule exists because i2v adds $0.30-1.00 per shot and the user already decided the bill isn't worth it for this style.
3. **Keep 2×2 default, only change prompt rules.** Smaller deltas across 4 panels means the final panel barely shows the motion completing. The grid bump is what lets the small-delta rule actually depict full motions.

## Out of scope / follow-ups

- Existing collages with a broken panel 1: user runs single-panel regen (or full row regen) per affected row. A backfill script that re-mirrors expired Atlas URLs to R2 is **possible** but would require fetching from Atlas with the original prediction id — most likely those preds have garbage-collected by now. Skip unless the user asks.
- If 3×3 default still produces visible drift after this ships, the next escalation is 4×3 (12 panels) as the default and/or further tightening the per-panel prompt cap from 80-150 chars to 50-100 chars (forces more terse, smaller deltas).
