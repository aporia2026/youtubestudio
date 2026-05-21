# 2026-05-21 — Phase 5: per-row on-screen-text mode toggle

**Status:** Approved (Option A picked over Tesseract+Flux-Fill alternative). Implements text protection without OCR, without inpainting, without new downloads.

## Goal

Stop baking on-screen text into diffusion prompts when the user just wants a clean text overlay at render time. Diffusion models garble text (especially after i2v). Remotion can render clean readable text on top of a clean image — same end result, zero garbling, zero new dependencies.

Three modes per row:

| Mode | Image generation | Render-time overlay (LowerThird) | When to use |
|---|---|---|---|
| `bake` | OST text directive injected into the prompt; text rendered as part of the image | **Suppressed** for this shot (avoids dual-render with the baked text) | In-world signage, hand-lettered captions, posters — when the text should move with the scene (animates with Wan i2v) |
| `overlay` | No OST directive — image generates clean | **Renders** the LowerThird with `row.on_screen_text` | Default for most rows: guaranteed legible text, no garbling, branded type |
| `none` | No OST directive | **Suppressed** | Pure b-roll with no text at all |

Doc-level default: `on_screen_text_mode_default`. New docs get `'overlay'`. Existing docs (no field) fall back to `'bake'` for back-compat — **but** the per-shot `suppressLowerThird` flag now kicks in for baked rows, which silently fixes the existing dual-render footgun (text in image + LowerThird overlay showing the same words).

## What changes

### 1. Types — `src/app/(app)/production-doc/page.tsx`

Add to `ProductionRow`:

```ts
on_screen_text_mode?: 'bake' | 'overlay' | 'none';
```

Add to `ProductionDoc`:

```ts
on_screen_text_mode_default?: 'bake' | 'overlay' | 'none';
```

No DB migration — production_doc rows are JSONB on `user_history.doc`; new optional fields are accepted automatically.

### 2. Image route — `src/app/api/generate/production-doc/image/route.ts`

- Accept `onScreenTextMode?: 'bake' | 'overlay' | 'none'` in the POST body.
- Normalize: anything other than the three literals → `'bake'` (back-compat).
- If mode is `'overlay'` or `'none'`, skip the OST directive entirely (the lines that build `ostLeadingDirective` / `ostTrailingDirective`).
- Log the resolved mode in the existing `[prodoc image-gen] canvas resolved` info log.

### 3. Editor dispatch — `src/app/(app)/production-doc/page.tsx`

Same pattern as Phase 0's `sectionTitleLayout` plumbing. Six call sites:

- `runGenerateAllStillsLocal` (local Flux batch button)
- `failedImagePlan` planner + push
- `emptyImagePlan` planner + push
- `runRetryFailedImages` caller (forwards from plan item)
- `runGenerateEmptyImages` caller (forwards from plan item)
- Main `generateImageForRow` orchestrator + two onRetry handlers + the per-row Generate flow

Each pulls `row.on_screen_text_mode ?? doc.on_screen_text_mode_default` and forwards.

### 4. Remotion mapping — `src/remotion/utils.ts`

In `productionDocToVideoConfig()`, the shot-build loop:

```ts
const ostMode = row.on_screen_text_mode ?? doc.on_screen_text_mode_default ?? 'bake';
const ostText = (row.on_screen_text || '').trim();
const showOstAsOverlay = ostMode === 'overlay' && ostText.length > 0;
const suppressLowerThird = ostMode !== 'overlay';

// existing:
title: ostText || undefined,            // unchanged — keeps narration metadata
onScreenText: showOstAsOverlay ? ostText : undefined,
suppressLowerThird,                     // NEW per-shot field
```

Today only `onScreenText` drives the LowerThird; switching to `showOstAsOverlay` means:
- `bake` → `onScreenText: undefined`, `suppressLowerThird: true` → no overlay (text is in the image)
- `overlay` → `onScreenText: <text>`, `suppressLowerThird: false` → overlay shows
- `none` → `onScreenText: undefined`, `suppressLowerThird: true` → nothing

### 5. Remotion VideoShot type — `src/remotion/types.ts`

Add `suppressLowerThird?: boolean` to `VideoShot`.

### 6. YouTubeVideo composition — `src/remotion/compositions/YouTubeVideo.tsx`

Lines 339 + 345 — switch the prop from doc-level only to per-shot with fallback:

```ts
suppressLowerThird={shot.suppressLowerThird ?? suppressLowerThirds}
```

Doc-level `suppressLowerThirds` stays as a "force suppress everywhere" emergency hatch for power users.

### 7. UI — per-row + doc-level controls

- **Per-row:** small segmented control beside the OST input in `SectionRowControls.tsx`: `Overlay / Bake / None`. Tooltip on each option explains the trade-off. Defaults to the doc-level value when the row's field is unset.
- **Doc-level:** existing settings menu (where `section_title_layout_default` already lives) gets one more row. Default for new docs: `'overlay'`.

### 8. Auto-pipeline

`src/lib/auto-pipeline/stages/generate-production-doc.ts` — set `on_screen_text_mode_default: 'overlay'` on the generated doc. Per-row mode stays undefined (inherits the doc default).

### 9. Settings audit (rule 15)

What's exposed:
- Per-row OST mode picker (3 options).
- Doc-level OST mode default in the doc settings panel.

What stays implicit:
- Per-shot `suppressLowerThird` is derived from the mode, not exposed directly. The existing doc-level `suppressLowerThirds` "force-all-off" stays as a power-user knob.

## Test plan

- **Unit test**: `productionDocToVideoConfig` resolution table — for each of the 9 cases (3 row modes × 3 doc defaults), assert the resolved `onScreenText` and `suppressLowerThird` on the produced shot. Specifically include the "missing mode + missing default → bake" back-compat case.
- **Manual smoke** (local):
  1. Create a row with OST="BREAKING NEWS", mode='overlay'. Generate locally. → Image has no text, render preview shows a LowerThird bar with "BREAKING NEWS".
  2. Switch the same row to mode='bake'. Regenerate. → Image has hand-lettered text; LowerThird does NOT show.
  3. Switch to mode='none'. Regenerate. → Image is plain; LowerThird does NOT show.
- **Existing-doc regression**: open a doc generated before this change. Verify the LowerThird is now hidden for OST-bearing rows (the existing dual-render is fixed) while the baked text in the underlying images remains visible.

## Observability (rule 14)

- `[prodoc image-gen] canvas resolved` log gets a `ost_mode` field.
- `productionDocToVideoConfig` adds an info log per doc summarising mode distribution: `{ bake: 3, overlay: 8, none: 1 }` — helps debug "why does shot 7 not show its text" reports.

## Security + safety (rule 13)

No new attack surface. The mode field is parsed against a literal-union allowlist; unknown values fall back to `'bake'`. No new external calls, no new env vars, no new persisted resources outside the existing JSONB doc.

## Out of scope

- Tesseract OCR + Flux Fill inpainting — explicitly rejected in favor of this design.
- Existing image regeneration on mode-switch — user re-runs the per-row Generate when they want the image side to catch up. A future polish could show a "mode mismatch" badge on rows whose saved still was generated under a different mode.
- Animated text overlays (kinetic typography) — out of scope. LowerThird's existing slide-in animation is the v1 motion.
- Custom per-row font / color override — overlay uses the brand kit's `fontFamily` + `primaryColor` for now. A custom-typography pass is a separate later phase.
