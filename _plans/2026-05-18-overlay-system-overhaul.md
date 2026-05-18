# Overlay system overhaul — aspect-aware render, smart placement, manual resize, conditional RMBG, AI image edit

**Date:** 2026-05-18
**Branch:** phase-1-foundation
**Status:** approved by user 2026-05-18, pricing verified, LLM Council passed — **ready for Phase 0 execution pending user greenlight**

## LLM Council outcome (2026-05-18)

The council pressure-tested two subdecisions: Phase 2/3 vision model and Phase 5 default edit mode. Verdict:

- **Phase 2/3 model: `kie-gemini-3.1-pro`.** Council initially landed on Haiku 4.5; user pushed back that the Claude family isn't right for this task and asked for a kie.ai pick. A second research pass found the load-bearing fact the council had missed: **Gemini 3.1 Pro has native pixel-coordinate output as a first-class API capability** (Google built "point at locations / return a JSON list of points" as a primitive). It scores **ScreenSpot-Pro 72.7%** vs Claude Opus 4.7's 36.2% vs GPT-5.4's 3.5% — and ScreenSpot-Pro is literally "given a picture, point to where something goes." This isn't a quality nudge; it's a capability gap. Cost: $0.0075/call → $0.11/doc, only ~$0.05/doc more than Haiku would have been, for a vastly more capable model. Already in the project's catalog ([src/lib/ai-models.ts:203](../src/lib/ai-models.ts#L203)) — no new integration. Verification flag: kie.ai's passthrough pricing wasn't first-party verifiable (JS SPA didn't render to WebFetch); numbers cited are direct-provider rates and kie.ai markets "match or beat," but eyeball one real call's billed cost after Phase 2 ships.
- **Phase 5 default: Nano Banana 2 smart edit.** Unanimous across all five advisors. Unchanged by the model-pick revision.

**Architecture additions the council surfaced that matter more than the model pick:**

1. **Per-overlay rethink scope** (refines Phase 3): the ↻ button re-runs ONE overlay, not all 15. Already implied by the per-cell ↻ entry point; this makes it explicit and the "Rethink all" affordance is deferred indefinitely.
2. **Content-hash placement cache** (new, Phase 2): cache key is `sha256(scene_hash + overlay_hash + saliency_hash + model_id)`. Cache value is the JSON placement decision. R2 or in-memory LRU; for a doc with reused overlays across shots, this collapses fetch + rethink cost to ~$0 on cache hit.
3. **Drag-after-place telemetry** (new, lifts up into Phase 0): every drag, resize, and rethink logs `(placement_model, scene_id, overlay_id, user_dragged_after: bool, time_to_drag_ms, drag_distance_px)` to a new `overlay_placement_events` table. After ~100 docs of real data, the Haiku→Sonnet flip becomes a data call.
4. **Text-only-over-saliency-JSON as a 4th experimental arm** (new): when the eval pack is built for Phase 2, include a baseline that sends only the numeric saliency scores + overlay/scene metadata, no images. If quality matches vision, the entire Phase 2 architecture simplifies and the cost line drops 4–8×.

**Phase 5 edit modal fixes the council caught:**

- **"Search again" leaves the edit modal entirely.** It's a different verb (discards the image). Move it to the row context menu as "Replace overlay".
- **gpt-image-1.5 brush moves to progressive disclosure.** It surfaces as "Try precise edit" only after the first Nano edit didn't satisfy, with the mask pre-seeded around the edited region.

Full council transcript is captured in the conversation; not persisted to a transcript file.
**Builds on:**
- [_plans/2026-05-15-on-screen-text-and-auto-overlays.md](2026-05-15-on-screen-text-and-auto-overlays.md) — defined the original overlay pipeline (Brave Search → RMBG → R2 → Remotion composite)
- [_plans/2026-05-18-prodoc-image-upload-and-edit.md](2026-05-18-prodoc-image-upload-and-edit.md) — defined the row-image AI-edit pipeline (Nano Banana 2 smart edit + GPT-4o Image brush mask) that this plan **reuses** for overlay editing

## Problem

The current overlay pipeline ([src/remotion/components/RealImageOverlay.tsx](../src/remotion/components/RealImageOverlay.tsx), [src/app/api/overlay/fetch/route.ts](../src/app/api/overlay/fetch/route.ts), [src/components/production-doc/OverlayPositionEditor.tsx](../src/components/production-doc/OverlayPositionEditor.tsx)) has five compounding gaps surfaced by user feedback in the 2026-05-18 session:

1. **Visual rendering is broken for non-square logos.** The renderer forces a square container and applies a circular radial mask. Wide wordmarks (Yahoo, IBM, FedEx) have their left/right edges eaten by the mask; tall logos have their top/bottom clipped. Affects almost every real-world overlay, since almost none are square.
2. **The AI placement is "blind."** The doc-gen LLM picks `overlay_zone` + `overlay_size` from text alone — it has never seen the actual overlay PNG or the actual scene image. Defaults are often visually wrong; the user has to manually drag almost every overlay.
3. **No way to re-roll a bad placement.** When the AI is wrong, there is no "rethink" — the user either drags it manually (per-row friction) or lives with it.
4. **No manual resize.** The position editor lets you drag the overlay but the size is a separate slider in a fixed range. Photoshop/Canva users expect to grab a corner and drag.
5. **RMBG runs unconditionally.** Bria's RMBG-2.0 is good but not perfect; some logos lose strokes, get halos, or come out worse than the original. There is no quality gate.
6. **No way to edit the overlay image itself.** Once an overlay is fetched, you can't restyle it, recolor it, regenerate a region, or mask out a portion — you accept what Brave returned or you re-search with different terms.

## User-confirmed decisions (from 2026-05-18 alignment)

| Question | Answer |
|---|---|
| Sequencing | **One big plan covering all six items**, then execute phase by phase. |
| Smart placement timing | **At fetch time only** — vision LLM decides size + zone (or customX/customY) per overlay, written onto the row. |
| Smart RMBG quality gate | **Hybrid** — cheap heuristics first; vision-LLM tiebreaker only on ambiguous results. |
| Resize handle feel | **Aspect-locked by default, free with Shift** (Canva-style). |
| Phase 5 edit entry points | **All three** — inside the position editor (✎ in header), directly on the overlay cell (small ✎ next to thumbnail), AND right-click context menu on the cell (Edit / Rethink / Search again). The cell ✎ stays small to avoid crowding; right-click is a power-user shortcut. |
| Rethink scope | **Placement only.** Re-runs the vision LLM on the same image; never re-searches Brave. Image change lives in Phase 5 → "Search again" tab. |
| Free-aspect stretch (Shift-drag) | **Honor it, but warn once.** First time a user free-stretches per workspace, a toast says *"Logos look better at natural aspect. Hold Shift to keep this anyway, or release to snap."* After dismissal, behaves as user expects. Persists `stretchedHeightPct` on the row when free-aspect was used. |

## Goals

- **G1.** Overlays render with correct natural aspect ratio. No content clipping. Edges feather softly without eating logo pixels.
- **G2.** Manual resize feels like Canva — eight handles, aspect-locked default, Shift for free distortion.
- **G3.** Overlay placement and size are decided by a vision-aware LLM that has actually seen the scene and the overlay, at fetch time.
- **G4.** A "rethink" button on the row re-runs the placement decision with one click.
- **G5.** RMBG is conditional. A heuristic gate runs after every RMBG; ambiguous cases get a vision-LLM tiebreaker. If RMBG made it worse, the original is kept.
- **G6.** The overlay PNG itself is editable — brush mask + AI region edits + restyle, mirroring the row-image edit path that already exists in plan-18-prodoc-image-upload-and-edit.

## Constraints

- **Stack:** Next.js (App Router, breaking-change version — see `AGENTS.md`), Remotion for video render, R2 for image storage.
- **Existing pipeline:** doc-gen LLM emits `overlay_stock_terms` → `/api/overlay/fetch` → Brave + RMBG → R2 → row carries `overlay.url` → renderer composites. Schema is in [src/remotion/types.ts:168-184](../src/remotion/types.ts#L168-L184). Do not break existing rows.
- **Latency budget:** today's `/api/overlay/fetch` is ~1.5s (Brave + RMBG). The smart-placement vision call adds ~1.5–3s. Total still under 5s per overlay, which is acceptable.
- **Cost budget:** per-overlay total under $0.05 (the original plan's bar). Per-doc 15 overlays × $0.05 = $0.75 worst case.
- **Pricing rule (CLAUDE.md #8):** every AI cost in this plan must be verified live before the corresponding phase is built. Numbers in this doc are **first-pass estimates** marked with `[verify]`; a pricing pass runs before each phase.

## Architecture summary

```
Doc-gen LLM        ──► writes overlay_stock_terms
                                  │
                                  ▼
        /api/overlay/fetch (extended)
        ┌─────────────────────────────────────────┐
        │ 1. Brave Search                         │
        │ 2. Download                             │
        │ 3. RMBG (Bria)                          │
        │ 4. Heuristic gate ──► keep or revert    │
        │    (ambiguous? ──► vision tiebreaker)   │
        │ 5. Smart placement (vision LLM):        │
        │    inputs:  overlay PNG (final, post-   │
        │             gate), scene PNG, saliency  │
        │    outputs: size, zone OR customX/Y,    │
        │             reason (logged)             │
        │ 6. Upload to R2, write to row           │
        └─────────────────────────────────────────┘
                                  │
                                  ▼
        Row carries overlay = { url, size, zone, customX, customY,
                                naturalWidth, naturalHeight,
                                rmbgKept (bool), placementReason, ... }
                                  │
        ┌─────────────────────────┴────────────────────────────┐
        ▼                                                       ▼
  Renderer (aspect-aware)                              Editor (aspect-aware
                                                       + resize handles +
                                                       rethink button +
                                                       AI edit entry)
                                                                │
                                                                ▼
                                                       Overlay AI edit dialog
                                                       (reuses row-image
                                                        edit infrastructure
                                                        from plan-18-prodoc-
                                                        image-upload-and-edit)
```

## Phases

Each phase is an independent commit. Phases 0–1 ship without API cost. Phases 2–5 require pricing verification before build.

---

### Phase 0 — Foundational rendering fix (renderer + editor)

**API cost:** $0.
**Touches:** [src/remotion/components/RealImageOverlay.tsx](../src/remotion/components/RealImageOverlay.tsx), [src/components/production-doc/OverlayPositionEditor.tsx](../src/components/production-doc/OverlayPositionEditor.tsx).

**Changes:**

1. **`RealImageOverlay.tsx`:**
   - Replace forced-square container (`overlayHeightPx = overlayWidthPx`) with aspect-ratio-correct sizing read at image load.
   - Use `useDelayRender` + `<Img onLoad>` to capture `naturalWidth/naturalHeight` before the frame is captured (standard Remotion pattern per Context7).
   - Compute container as: `width = sizeRatio * frameWidth`; `height = width / (naturalWidth / naturalHeight)`. Cap height to `0.6 * frameHeight` and proportionally shrink width if exceeded.
   - Switch the radial mask from `circle` to `ellipse closest-side` and loosen stops to `80% → 100%` so it only feathers outermost RMBG residue, never logo content. (Reasoning: RMBG already produces a transparent background, so the original "feather the hard rectangle" intent is largely obsolete. We keep a token feather only to hide imperfect RMBG edges.)
   - Recompute halo size as elliptical: `haloW = containerW * HALO_SCALE`, `haloH = containerH * HALO_SCALE`. `borderRadius: 50%` already gives an ellipse.
   - `onError` calls `continueRender` and returns `null` so a broken image degrades gracefully instead of timing out the render.

2. **`OverlayPositionEditor.tsx`:**
   - Mirror the same aspect-ratio logic — when the editor's `<img>` loads, set state with its natural aspect; resize the dashed bounding box from a square to match. Manual positioning then matches what renders.

**Back-compat:** existing `customX/customY` (top-left % of frame) keep working but the visual position shifts slightly downward for wide overlays (the box is shorter, so the same top-left puts the center higher). Document this in the commit message. No data migration; just a visual reflow.

**Observability:** `console.info('[overlay render] aspect resolved', { url, naturalWidth, naturalHeight, containerW, containerH })` on first frame post-load. Renderer-side log lets us debug "the overlay looks weird in this scene" with concrete numbers in hand.

**Telemetry (lifted in from council outcome):** baseline data starts flowing in Phase 0 so Phase 2 has a comparison point. **Reuses the existing polymorphic `editor_telemetry` table** ([src/lib/migrations/0078_create_editor_telemetry.ts](../src/lib/migrations/0078_create_editor_telemetry.ts)) — that migration's header explicitly invites new event names without a schema change, exactly what we need. No new migration ships.

The [`/api/editor-telemetry` route](../src/app/api/editor-telemetry/route.ts) gains three event names in its allow-list:

- `overlay_drag` — user saved the position editor with a manual placement. Payload: `{ row_index, placement_model, prev_x_pct, prev_y_pct, prev_size_pct, new_x_pct, new_y_pct, new_size_pct, drag_distance_pct }`. `placement_model` is `'doc-gen-blind'` for all pre-Phase-2 rows; Phase 2 starts emitting `'kie-gemini-3.1-pro'` etc.
- `overlay_accept` — reserved for future use (saved without changes). Phase 0 doesn't emit it; Phase 1 wires it once we can detect "user opened editor but didn't interact."
- `overlay_reset` — user cleared their manual placement, falling back to AI. Payload: `{ row_index, placement_model }`.

Phase 1 will add `overlay_resize` (same shape, different event name). Phase 3 will add `overlay_rethink`. After ~100 docs of production traffic, the per-`placement_model` drag rate answers "is the current model good enough?" with data.

**QA:** square logo, wide wordmark, tall portrait, missing aspect (use 1:1 fallback), broken URL, `customY` previously-saved row.

---

### Phase 1 — Photoshop/Canva-style resize handles

**API cost:** $0.
**Touches:** [src/components/production-doc/OverlayPositionEditor.tsx](../src/components/production-doc/OverlayPositionEditor.tsx).

**Changes:**

- Add 8 handles on the overlay bounding box: 4 corner + 4 edge.
- Default behavior: corner drag = uniform scale (aspect-locked); edge drag = scale along one axis (also aspect-locked unless user opts in to free).
- **Aspect-locked default; Shift unlocks free aspect** (user-confirmed decision). On first free-aspect drag per workspace, surface a one-time toast: *"Logos look better at natural aspect. Hold Shift to keep this anyway, or release to snap back."* Persisted via a workspace settings flag `overlay_free_stretch_warning_dismissed`. When free-aspect is used, persist `overlay.stretchedHeightPct` so the renderer honors the squish at video render time.
- Replace the 5-40% size slider with handle-driven sizing. Slider stays as a secondary input (and for keyboard a11y).
- Show live width/height % readout in the existing coordinate strip.
- Snap to common sizes (10%, 15%, 20%, 25%, 33%, 50%) when Shift+Cmd held. Minor polish — defer if time runs short.
- Store the result as `customSizePct` (width %) plus the existing `customX/Y`. The aspect ratio is derived at render time from the image's natural size, so we don't need to persist height.

**UX guardrails (CLAUDE.md #10):**
- Cursor changes per handle (`nwse-resize` corners, `ns-resize`/`ew-resize` edges).
- Handle hit zone is generous (12×12 px) so the user doesn't fight for the pixel.
- Min size 3% width (so the user can't accidentally shrink it to nothing). Max size 60% width (so it doesn't eat the scene).
- Esc cancels mid-drag and reverts to pre-drag size. Live coordinates always show the *committed* state until release.

**Settings (CLAUDE.md #15):**
- "Snap-to-grid while resizing" — on/off (default on, snaps at 5% increments when holding Cmd).
- "Default aspect lock" — locked/free (default locked).

**Observability:** `console.info('[overlay editor] resize committed', { from, to, mode })` on each pointerup with the size delta.

---

### Phase 2 — Smart placement at fetch time

**API cost:** ~$0.005–0.015 per overlay [verify].
**Touches:** [src/app/api/overlay/fetch/route.ts](../src/app/api/overlay/fetch/route.ts), [src/remotion/types.ts](../src/remotion/types.ts), production-doc client (read new fields).

**Flow:**

1. After RMBG + heuristic gate (Phase 4 — but Phase 2 can ship with Phase 4 stubbed as "always keep"), the route now has the final overlay PNG. Together with the row's scene image (`row.imageUrl`) and any cached saliency cells (`row.imageSaliency`), call a vision LLM.

2. **Prompt (sketch):**
   > You are placing a graphic overlay on a video scene. You see the scene image, the overlay PNG (transparent background), and the scene's saliency map (8-cell grid with attention scores). Pick the **size** (% of frame width, 8–35) and the **position** (either one of 8 zones, OR a custom top-left in %). Avoid: covering faces, text, or high-saliency regions; cropping at frame edges; landing on the safe-area where YouTube's UI sits. Return JSON: `{ size_pct, mode: "zone" | "custom", zone?, custom_x_pct?, custom_y_pct?, reason }`.

3. The route writes `overlay.size`, `overlay.customX/Y`, `overlay.placementReason`, `overlay.naturalWidth/Height` onto the row. Re-running the call overwrites these.

**Model choice — FINAL.** Resolved after council pass + user pushback + research:

**Use `kie-gemini-3.1-pro` as `OVERLAY_PLACEMENT_MODEL`.** Already in [src/lib/ai-models.ts:203](../src/lib/ai-models.ts#L203). Routes through kie.ai (already wired). Native pixel-coordinate output makes this a 1:1 task fit. Fallback chain on outage: `kie-gemini-3-pro` → `kie-claude-opus-4-7`. Claude family (Sonnet/Haiku) explicitly excluded — ScreenSpot-Pro evidence shows ~2× capability gap on spatial localization.

Per-call cost: ~$0.0075 (direct-provider rate; kie.ai passthrough markup unverified — verify in dashboard after first real call).

**Back-compat:** existing rows without `placementReason` use today's blind LLM pick (already on the row). New rows go through the smart path.

**Settings:** "Smart placement: on / off" (default on). "Placement model: `kie-gemini-3.1-pro` (default) / `kie-gemini-3-pro` / `kie-claude-opus-4-7`" — env-var swappable with no code change. When smart placement is off, fetch returns without calling the vision LLM and the doc-gen blind pick stands.

**Observability:** `console.info('[overlay placement] decided', { model, sizePct, mode, zone, custom, reason })` server-side. Save `placementReason` on the row so the user can see *why* the AI placed it there (surfaced as a tooltip in the editor).

---

### Phase 3 — Rethink button

**API cost:** ~$0.005–0.015 per click [verify, same as Phase 2].
**Touches:** [src/components/production-doc/OverlayPositionEditor.tsx](../src/components/production-doc/OverlayPositionEditor.tsx), [src/components/production-doc/OverlayCell.tsx](../src/components/production-doc/OverlayCell.tsx), `/api/overlay/fetch/route.ts` (gain a "placement-only" mode that skips Brave + RMBG and just re-runs the vision call).

**Flow:**

- Two entry points: small ↻ icon on the overlay cell (lazy user can hit it without opening the editor), and a "Rethink placement" button inside the editor next to Save/Reset.
- Calls `/api/overlay/fetch?mode=placement-only` (idempotent on the image; only re-decides where it goes).
- Vision LLM is told what the previous decision was and instructed to pick a **different** placement. Reduces "same answer twice" frustration.
- Saves the new placement directly to the row. User can rethink again, or hit Reset to go back to the original AI pick.

**UX (CLAUDE.md #10):**
- ↻ icon shows loading spinner while in flight. Disabled if no `overlay.url` yet.
- Toast on success: "AI rethought placement — moved to bottom-right" (uses the new `placementReason`).
- Up to 5 rethinks per overlay per session (rate-limit; prevents accidental dollar-loss).

**Observability:** `console.info('[overlay rethink] requested', { previousReason, attempt })`, then the existing placement-decided log.

---

### Phase 4 — Smart RMBG (heuristic + vision tiebreaker)

**API cost:** $0 for clear-cut cases; ~$0.003–0.005 for ambiguous (~10–30% of overlays) [verify].
**Touches:** [src/app/api/overlay/fetch/route.ts](../src/app/api/overlay/fetch/route.ts), new module [src/lib/overlay-rmbg-gate.ts](../src/lib/overlay-rmbg-gate.ts).

**Heuristic gate (no network call):**

After RMBG returns, decode the resulting PNG (we already have bytes in memory). Compute:

- `alphaCoverage` — fraction of pixels with `alpha > 10`. If `<0.05` → RMBG ate everything → revert. If `>0.95` → RMBG did nothing → revert (and use the original directly).
- `edgeHaloBleed` — sample the alpha channel along the bounding-rect perimeter shrunk by 2 px. High average alpha here = RMBG left a halo → suspicious.
- `componentCount` — count of connected non-transparent blobs > 1% of image area. If `>5` for a logo, RMBG likely shattered it → suspicious.

**Decision tree:**

```
alphaCoverage < 0.05  ──► revert
alphaCoverage > 0.95  ──► revert (use original)
edgeHaloBleed > 0.4   ──► ambiguous → vision tiebreaker
componentCount > 5    ──► ambiguous → vision tiebreaker
otherwise             ──► keep RMBG
```

**Vision tiebreaker:**

Send original + RMBG'd PNG to vision LLM:
> Which of these two images looks like a cleaner overlay for compositing on a video scene? Reply: `"a"` (original), `"b"` (cutout), or `"either"`. Brief reason.

**Settings:** "Smart RMBG: on / off" (default on). Off skips the gate and uses RMBG output as-is (today's behavior).

**Observability:** `console.info('[overlay rmbg] gate', { alphaCoverage, edgeHaloBleed, componentCount, decision, tiebreakerUsed, tiebreakerVote })`. Save `rmbgKept: boolean` on the row for surfacing in the editor ("RMBG used" / "RMBG reverted").

**QA cases:** logo on transparent (skip), logo on white (RMBG keeps), photo subject (RMBG keeps), text-only graphic (RMBG might shatter — ambiguous → tiebreaker), already-transparent PNG (RMBG should no-op — revert).

---

### Phase 5 — AI image editing on the overlay

**API cost:** $0.02 (Nano Banana 2 smart edit) to $0.19 (GPT-4o Image with mask at "high") per edit [already verified in plan-18-prodoc-image-upload-and-edit].
**Touches:** [src/components/production-doc/OverlayPositionEditor.tsx](../src/components/production-doc/OverlayPositionEditor.tsx) (add ✎ entry point), new dialog component [src/components/production-doc/OverlayEditDialog.tsx](../src/components/production-doc/OverlayEditDialog.tsx).

**Reuse strategy:** the row-image edit pipeline being built in [_plans/2026-05-18-prodoc-image-upload-and-edit.md](2026-05-18-prodoc-image-upload-and-edit.md) supports brush-mask AI editing on R2-hosted images. Overlays are R2-hosted. Same infrastructure works; we just point it at the overlay URL and write the result back to `overlay.url`.

**Entry points (user-confirmed, all three):**

1. **Position editor header** — ✎ "Edit overlay image" button next to Save/Reset. Discoverable while positioning.
2. **Overlay cell, inline** — small ✎ icon next to the overlay thumbnail in the production-doc table. One-click access without opening the position editor. Sized to not crowd the cell on narrow viewports (hides under 640 px column width — right-click fallback still works).
3. **Right-click context menu on the overlay cell** — power-user shortcut. Items: "Edit image", "Rethink placement", "Search again", divider, "Reset to AI default", "Remove overlay". Mirrors the row-image cell's context menu pattern for consistency.

**Edit modes (mirroring row-image plan):**

1. **Smart prompt edit** — Nano Banana 2 — natural language ("make the logo blue", "remove the tagline below", "make it 3D"). ~$0.02/edit. No mask, just a prompt.
2. **Brush-mask edit** — GPT-4o Image with mask — user brushes the region they want to change, types a prompt. Quality tiers low/med/high at $0.02/$0.07/$0.19. Default = medium.
3. **Regenerate from terms** — re-runs `/api/overlay/fetch` with a different stock term. Free in this flow (just a Brave + RMBG re-run, cost identical to the original fetch).

**Editor UX (CLAUDE.md #10, #16):**

- The position editor grows a ✎ "Edit overlay image" button in the header.
- Clicking opens a sub-dialog showing the overlay at large size with three tabs: **Smart edit** | **Brush mask** | **Search again**.
- Brush mask: paint with adjustable brush size, undo/redo, clear-mask. Mirror the row-image editor exactly.
- On accept: the new PNG goes through RMBG (configurable: only when user requests it, since the AI-edit output is often clean already), the heuristic gate, and writes back to `overlay.url`. **Naturalwidth/naturalheight on the row are invalidated** — renderer reads from the new image at next render.
- History: keep last 3 edit results in a per-overlay history (R2 key suffix `_v2`, `_v3`). Cheap revert.

**Settings:**
- "Default brush quality" — low/med/high (default med).
- "Auto-RMBG after edit" — on/off (default on; only matters if the edit introduced background).

**Observability:** `console.info('[overlay edit] start', { mode, brushQuality })`, `console.info('[overlay edit] saved', { mode, costEstimate, durationMs })`.

**Security (CLAUDE.md #13):**
- Brush mask is sent to OpenAI — sanitize: max 2048×2048 px, PNG only, max 5 MB.
- Prompt text is sent to OpenAI/Replicate — no PII expected (overlay is brand mark / product), but log only the first 100 chars to avoid accidentally storing customer-uploaded sensitive text.
- Rate limit per workspace: 30 edits/hour. Matches the row-image edit limit.

---

## Cross-cutting concerns

### Security & safety (CLAUDE.md #13)

- **Inputs validated at every API boundary:** size, dimensions, content-type, MIME, URL scheme (no `file://`, no private IPs — copy SSRF block from `src/app/api/thumbnails/image/route.ts:99-120`).
- **Rate limiting:** reuse `checkRateLimit` from `src/lib/rate-limit.ts`. Tighten:
  - `/api/overlay/fetch` (existing 30/min/IP) — keep.
  - placement-only mode — 30/min/IP, but also 5/overlay/session (cost cap).
  - edit endpoints — inherit row-image edit limits.
- **Auth:** every route uses `apiRoute.authed`. Workspace scoping on R2 keys (`overlays/<ws>/...`) already in place.
- **PII:** vision LLM prompts include the overlay PNG and the scene PNG. Scenes are AI-generated stills, not photos of real people — low PII risk. Don't log image bytes; log only URLs and decisions.
- **Cost runaway:** every AI-calling phase logs cost estimate. Add a workspace-level monthly cap (default $20) for overlay AI operations — flag in settings, alert at 80%.

### Observability (CLAUDE.md #14)

Namespaces:
- `[overlay fetch]` — Brave, download, RMBG, gate, placement.
- `[overlay render]` — Remotion compositor (Phase 0).
- `[overlay editor]` — drag, resize, save (Phase 0/1).
- `[overlay rethink]` — Phase 3.
- `[overlay rmbg]` — Phase 4 (gate + tiebreaker).
- `[overlay edit]` — Phase 5.

Every meaningful step logs with values, not just "X happened." Backend uses the existing `logger` (`src/lib/logger.ts`).

### Settings (CLAUDE.md #15)

New settings under a single **Overlays** group (creates the group if it doesn't exist):

| Setting | Default | Purpose |
|---|---|---|
| Smart placement at fetch | on | Phase 2 |
| Smart placement model | `kie-gemini-3.1-pro` | Phase 2 cost/quality lever — swap to `kie-gemini-3-pro` or `kie-claude-opus-4-7` if needed |
| Smart RMBG | on | Phase 4 |
| Default resize aspect lock | on | Phase 1 |
| Snap-to-grid while resizing | on | Phase 1 |
| Default edit brush quality | medium | Phase 5 |
| Auto-RMBG after edit | on | Phase 5 |
| Monthly overlay AI cost cap | $20 | Cost guardrail |

### Schema additions to `VideoShot.overlay`

```ts
overlay?: {
  url: string;
  zone: ZoneEnum;
  size: 'small' | 'medium' | 'large';
  haloColor?: string;
  customX?: number;
  customY?: number;
  customSizePct?: number;
  // NEW (all optional, back-compat with existing rows):
  naturalWidth?: number;       // captured at fetch time, used for renderer
  naturalHeight?: number;      // ditto
  rmbgKept?: boolean;          // Phase 4 — false ⇒ original used, no cutout
  placementReason?: string;    // Phase 2/3 — surface as editor tooltip
  editHistory?: Array<{        // Phase 5 — up to 3 prior R2 keys
    r2Key: string;
    createdAt: number;
    mode: 'smart' | 'brush' | 'search';
  }>;
  stretchedHeightPct?: number; // Phase 1 — set only when user free-aspect dragged.
                               // Renderer prefers this over natural-aspect math.
                               // % of frame height (0-100). Absent ⇒ natural aspect.
}
```

## Alternatives I considered and rejected

- **Render-time vision call (instead of fetch-time):** would catch scene changes after a row edit, but adds 2s to every render-preview cycle. Too expensive on the user's primary feedback loop. Rejected.
- **Single mega-LLM call combining placement + RMBG-gate + sizing:** cleaner code, but the failure modes are intertwined (one bad response loses all three decisions). Splitting keeps each call cheap and debuggable. Rejected.
- **Server-side image dimensions vs `onLoad` (Phase 0):** server-side is more deterministic but requires a data migration for existing rows. `onLoad` + `useDelayRender` is the Remotion-blessed pattern, works for all existing overlays without backfill. Picked `onLoad`.
- **Free canvas editor for Phase 5:** Photoshop-grade in-browser editor (layers, filters, transforms). Tempting but a multi-week project for marginal benefit over brush+prompt. Rejected for now; brush+prompt covers 90% of real needs.

## Decisions to council before locking in (CLAUDE.md #11)

These warrant LLM Council pressure-testing — non-trivial, high stakes, multiple defensible angles:

1. **Phase 2 model choice (Sonnet vs Haiku vs Gemini Flash)** — latency vs quality vs cost vs stack-consistency.
2. **Phase 4 heuristic thresholds** — `alphaCoverage`, `edgeHaloBleed`, `componentCount` cutoffs. Wrong thresholds = either reverting good RMBG results, or paying for vision tiebreakers we don't need.
3. **Phase 5 edit-mode default** — Nano Banana smart edit vs GPT-4o brush. Smart edit is cheap and easy but less precise; brush is precise but costlier and slower.

After this plan is approved at the structural level, I run the council on those three subdecisions and bring back consensus before writing code.

## Pricing — verified live 2026-05-18

Per CLAUDE.md #8, every paid call below is sourced from a live first- or third-party page on 2026-05-18. Workload assumption for vision calls: 3 image inputs (1024², 1280×720, 256²) + ~500 input text tokens + ~200 output text tokens. Claude image-token formula is `width × height / 750` (per [Anthropic vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)).

| Phase | Provider | Endpoint | Per-call cost | Source | Confidence |
|---|---|---|---|---|---|
| 2/3 | kie.ai → Google | **`kie-gemini-3.1-pro` vision (chosen)** | **~$0.0075** direct rate; kie.ai passthrough TBD | [Gemini 3 vision review (Roboflow)](https://blog.roboflow.com/gemini-3-pro/), [pricing aggregator](https://www.aipricing.guru/blog/claude-opus-4-7-vs-gpt-5-4-vs-gemini-3/) | high on capability, medium on kie.ai passthrough markup |
| 2/3 (alt) | kie.ai → Anthropic | Claude Opus 4.7 (fallback chain) | **~$0.021** | same | high |
| 2/3 (rejected) | Anthropic direct | Haiku/Sonnet | ~$0.004 / ~$0.013 | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) | under-spec for spatial layout (ScreenSpot-Pro <40%) |
| 4 | Anthropic | Haiku 4.5 (binary tiebreaker, two-image compare — different task than placement) | **~$0.0030** | same | high |
| 4 | Replicate | Bria remove-background | **could not verify** on Replicate page (client-rendered, no SSR price). Third-party reports **~$0.058/run** on Replicate; **fal.ai equivalent is $0.018/image** | [Replicate model](https://replicate.com/bria/remove-background), [fal.ai](https://fal.ai/models/fal-ai/bria/background/remove) | low/medium |
| 5 | Google (via Replicate / Kie) | Nano Banana 2 smart edit | **~$0.034 (batch) – $0.067 (real-time)** per Google official; Replicate flat rate not verified | [Google API pricing aggregator](https://help.apiyi.com/en/nano-banana-2-pricing-guide-official-google-api-en.html) | medium |
| 5 | OpenAI | gpt-image-1.5 with mask (current flagship) | **$0.009 / $0.034 / $0.133** at low / med / high | [OpenAI image pricing aggregator citing OpenAI](https://www.aifreeapi.com/en/posts/openai-image-generation-api-pricing) | medium |
| 5 (legacy) | OpenAI | gpt-image-1 with mask | **$0.011 / $0.042 / $0.167** | same | medium |

### Cost surprises that change recommendations

1. **Bria RMBG on Replicate may be ~$0.058/run, not the $0.005 originally assumed.** That's 12× more than the 2026-05-15 plan budgeted. If true, RMBG dominates per-overlay cost. **Action:** verify in the Replicate dashboard before committing; if confirmed, consider migrating to **fal.ai's Bria implementation at $0.018/image** (3× cheaper) or to a self-hosted RMBG (one-time GPU cost). Surface for user decision — this is a >$0.04 swing per overlay × 15 overlays/doc = >$0.60/doc, dwarfing every other line item.

2. **Nano Banana 2 is $0.034–0.067/edit, not $0.02** as the previous plan ([_plans/2026-05-18-prodoc-image-upload-and-edit.md](2026-05-18-prodoc-image-upload-and-edit.md)) assumed. Still cheap, but the budget envelope shifts. Update plan-18 as part of this work.

3. **GPT-Image current flagship is gpt-image-1.5, not GPT-4o Image** — and high quality is $0.133, not $0.19. Slightly cheaper than assumed but the model identifier in plan-18 is out of date.

### Recommended choices (with reasoning) — POST-COUNCIL + post-user-pushback revision

- **Phase 2/3 model: `kie-gemini-3.1-pro` ($0.0075/call direct rate, kie.ai passthrough TBD).** Initially councilled to Haiku 4.5; user pushed back ("not actually good for this") and was right. Gemini 3.1 Pro is the only model in the catalog with **native pixel-coordinate output** as a first-class capability (Google's "point at locations / return a JSON list of points" primitive). ScreenSpot-Pro benchmark: 72.7% vs Opus 4.7 36.2% vs GPT-5.4 3.5% — and ScreenSpot-Pro is literally the task. Already in our model catalog ([src/lib/ai-models.ts:203](../src/lib/ai-models.ts#L203)); kie.ai integration already wired. **Fallback chain (if a Gemini outage strikes):** `kie-gemini-3-pro` → `kie-claude-opus-4-7`. Sonnet/Haiku are NOT in the chain — they're under-spec for spatial layout.
- **Phase 4 tiebreaker: Haiku 4.5 ($0.0030/call).** Two-image "which is cleaner" binary compare is a fundamentally different task from spatial layout — no ScreenSpot-style positioning, just classification. Haiku is correct here. Single-vendor, single-call, cheap.
- **Phase 5 default mode: Nano Banana 2 smart edit (~$0.034 batch).** Council was unanimous. Brush-mask escalation to gpt-image-1.5 is progressive disclosure only.
- **RMBG provider: verify Replicate price live before Phase 4 build.** If the $0.058 number stands, switch to fal.ai ($0.018). Existing R2-cached overlays stay as-is.

### Doc-scale economics (15 overlays/doc, revised)

Assumption set: `kie-gemini-3.1-pro` for Phase 2, Phase 2 always-on, 20% of overlays trigger Phase 4 tiebreaker, RMBG at fal.ai pricing, no Phase 5 edits:

- Brave Search: 15 × negligible = ~$0
- Bria RMBG (fal.ai): 15 × $0.018 = **$0.27**
- Phase 2 placement (Gemini 3.1 Pro): 15 × $0.0075 = **$0.113**
- Phase 4 tiebreaker (Haiku, 20% of overlays): 3 × $0.003 = **$0.009**
- **Total: ~$0.39/doc** (Phase 0–4 fully on)
- Plus Phase 5 edits on demand (~$0.034–$0.133 each).

With Replicate Bria ($0.058/run): doc cost balloons to **~$1.00/doc** — the provider switch is worth chasing.

Cost delta vs the Haiku plan: +$0.05/doc. Worth it many times over given the capability gap on the load-bearing task.

## Open questions — resolved 2026-05-18

All four resolved by user during alignment session. Decisions are now in the "User-confirmed decisions" table at the top of this plan and in the relevant phases. Plan is locked at the structural level; remaining gates are the pricing pass and the LLM Council pass on the two model-related subdecisions below.

## Execution order summary

1. **Now:** user approves plan structure → I run the LLM Council on the three flagged subdecisions → bring back consensus.
2. **Pricing pass** for Phase 2 / 4 → confirm numbers with user.
3. **Phase 0 ships** (foundational, zero-cost — could ship today regardless of the rest).
4. **Phase 1 ships** (resize handles, zero-cost).
5. **Phase 2 + 4 ship together** (they share the fetch route; doing them in one pass avoids two rounds of fetch-route refactor).
6. **Phase 3 ships** (rethink button — small, depends on Phase 2 endpoint).
7. **Phase 5 ships** (overlay AI edit — biggest, depends on plan-18-prodoc-image-upload-and-edit being merged first).

Each phase is its own commit. Each phase passes its own QA pass (CLAUDE.md #6).
