# Local b-roll via ComfyUI — lean mean local video creation machine

**Date:** 2026-05-20
**Status:** Approved direction, alternatives rejected, ready to implement
**Owner:** Yoav
**Topology:** Local-only first (Vercel-deployed app untouched). `next dev` on the user's PC talks to ComfyUI at `localhost:8188`.
**Hardware target:** RTX 5070 Ti 16GB VRAM, 64GB RAM, ~1.5TB free on D:
**Files touched:** `src/lib/visual-generator/` (new), `src/lib/comfyui/` (new), `src/lib/production-doc-styles.ts` (add `local_workflow_id`), `src/components/local-studio/` (new), `src/app/local-studio/` (new route), `src/app/api/local-studio/*` (new routes), `src/remotion/scenes/*` (text-overlay reuse for v3a parity), new migration for `local_broll_jobs` table

## The ask

Build a free, local, lean alternative to the existing Kie.ai b-roll pipeline. The deployed Vercel app keeps working unchanged. On the user's own machine (`next dev`), a new `/local-studio` surface generates images and short clips via ComfyUI running on `localhost:8188`, reusing the **production-doc style system** and **voiceover → production-doc → render** flow that already exists. Per-row override lets specific shots still hit Kie.ai (Veo 3.1 / Sora 2 / Kling) when the local quality gap matters.

## Why local — and the brutal-honest gap

| Surface | Local quality vs cloud | Verdict |
|---|---|---|
| **Images** | HiDream-I1 (MIT) currently #1 open-weight, beats Flux 2 dev Turbo on Artificial Analysis Arena. Flux.1-schnell (Apache 2.0) for fast iteration. | **Production-ready.** Local is genuinely competitive with your Flux 2 Pro / Grok Imagine for 80%+ of b-roll. |
| **Video** | Wan 2.2 I2V 14B (Apache 2.0) is the truly-open SOTA today. LTX-2.3 (Community license, free <$10M revenue) is fast iteration. | **6–12 months behind** Veo 3.1 / Sora 2 / Kling 3.0 on hero shots. Real and visible. Acceptable for fill b-roll; not for the money shot. |

**Therefore: hybrid**. Local is the default; per-row "use kie.ai" override stays alive for any shot where the gap is visible.

## Goals

1. Generate b-roll (stills + ≤10s clips) locally via ComfyUI, **$0 marginal cost**, from inside the YT Studio app.
2. Reuse `production_doc_styles` 1:1 — same picker, same suffixes, same `mixing_rules` / `allow_overlay_stock` semantics.
3. Per-row toggle: **still image** (Flux/HiDream) vs **image-to-video clip** (LTX-2.3 fast / Wan 2.2 quality).
4. Cross-row visual consistency via local reference chaining (Flux Redux / IP-Adapter) — parity with the May 20 consistency plan.
5. Text/number preservation in i2v via OCR + Flux Fill scrub + Remotion text composite — parity with v3a.
6. One-click "render entire doc locally" with voiceover → final MP4 via existing Remotion pipeline.
7. Friendly UI for a lazy user — no node graphs in the YT Studio surface. (ComfyUI's own UI remains available for power tasks; **SwarmUI** can be installed alongside as a friendlier direct ComfyUI frontend, optional.)

## Non-goals (v1)

- No tunneling, ngrok, RunPod, or cloud-hosted ComfyUI. Pure local.
- No replacing the existing Kie.ai b-roll pipeline in the deployed Vercel app — local is additive, gated by `LOCAL_STUDIO=1`.
- No local LLM. Prompt-writing stays on Claude/Gemini in the cloud (cheap, faster, better quality).
- No multi-user, no auth on the ComfyUI endpoint (bound to `127.0.0.1` already).
- No LoRA training in v1.
- No ControlNet / depth / pose conditioning in v1 (Phase 8 polish at earliest).

## Constraints

- ComfyUI URL must validate to localhost only — defense in depth even though prod doesn't use it.
- Local feature must NOT bundle into the Vercel production build. Gated by `LOCAL_STUDIO=1` env flag at build/runtime.
- Security/safety baked in from day one (rule 13). Observability baked in from day one (rule 14). Settings audit before "done" (rule 15).
- Cost: **$0 marginal per local generation**. Hybrid rows hitting kie.ai pay the existing kie price; no change.

## Decisions (aligned with user 2026-05-20)

| Decision | Choice |
|---|---|
| Topology | **Local-only**, design for future flip to hosted/tunneled by abstraction (not implementation). |
| Primary use case | **B-roll for production docs** (stills + clips), with image-only generation also supported. |
| Image vs clip decision | **Per-row toggle** (user picks). Optionally auto-decided in a later phase. |
| Video models | **Hybrid: local-first + per-row kie.ai fallback** for hero shots. |
| Image model lineup | Flux.1-schnell (Apache, fast) + HiDream-I1 (MIT, top quality) primary. Flux.1-dev kept for non-commercial / private use; Qwen-Image Q5 for typography. |
| Video model lineup | LTX-2.3 22B distilled fp8 (fast preview) + Wan 2.2 I2V 14B Q5_K_M GGUF (quality). LTX 0.9.5 deleted. |
| Consistency | Reference chaining via **Flux Redux** v1; **style sheet** v2 (later phase). Parity with cloud consistency plan. |
| Text protection | **OCR + Flux Fill scrub + Remotion text composite** locally — parity with cloud v3a. |
| UI surface | New `/local-studio` route, plus per-row buttons on existing production-doc UI. **SwarmUI optional** as a direct-ComfyUI alternative for power users. |
| Council pass | Skipped per user — decision shape was clear after iteration. |

## Pre-existing work to build on (do NOT rebuild)

1. **`production_doc_styles`** ([src/lib/production-doc-styles.ts](src/lib/production-doc-styles.ts)) — built-in + saved styles, `ai_image_suffix`, `mixing_rules`, `allow_overlay_stock`. The local generator reads these unchanged.
2. **Production-doc UI** — per-row image generation + animate buttons. We add a sibling button group, don't fork the UI.
3. **Remotion render pipeline** ([src/remotion/scenes/BRollScene.tsx](src/remotion/scenes/BRollScene.tsx)) — the i2v text-composite layer from the cloud v3a plan is reused as-is for local. Local `broll_clips`-equivalent rows expose the same `textOverlays` prop.
4. **Voiceover upload** — Phase 7 work already lets a user attach a voiceover to a doc. We chain off this.
5. **Brand-kit + per-channel styles** — local generation inherits them via the same resolver path.
6. **The May 20 consistency plan** — local mirrors v1 (reference chaining) and v3a (text protection). Settings labels (rule 15) lifted 1:1 so users see one consistent surface across cloud + local generation.

## Architecture

```
YT Studio (next dev, LOCAL_STUDIO=1)
    │
    ├─ src/app/local-studio/page.tsx ........ Friendly UI: prompt + style picker + size + run
    ├─ src/app/api/local-studio/generate ... POST: enqueue job, return job_id
    ├─ src/app/api/local-studio/status ..... GET:  poll job, stream progress
    ├─ src/app/api/local-studio/outputs .... GET:  fetch generated image/video bytes
    │
    └─ src/lib/visual-generator/ ............ INTERFACE — swappable backend
         ├─ types.ts ........................ VisualGenerator interface
         ├─ comfyui-local.ts ................ implements via src/lib/comfyui/*
         └─ (future) replicate.ts / runpod.ts

src/lib/comfyui/
    ├─ client.ts ........................... Typed wrapper over ComfyUI HTTP + WebSocket
    │      ├─ submitWorkflow(graph): { prompt_id }
    │      ├─ pollHistory(prompt_id): { outputs, status }
    │      ├─ connectWebSocket(prompt_id): EventEmitter (live progress)
    │      └─ fetchOutput(filename, subfolder, type): Blob
    │
    ├─ workflows/ .......................... Workflow JSON templates with placeholders
    │      ├─ flux-schnell-t2i.json
    │      ├─ flux-dev-t2i.json
    │      ├─ hidream-i1-dev-t2i.json
    │      ├─ qwen-image-t2i.json
    │      ├─ flux-redux-chain.json
    │      ├─ flux-fill-inpaint.json
    │      ├─ ltx-2.3-i2v.json
    │      └─ wan-2.2-i2v.json
    │
    ├─ workflow-fill.ts .................... Inject {prompt}, {seed}, {width}, {height},
    │                                        {style_suffix}, {ref_image}, etc. into a template
    │
    └─ style-mapping.ts .................... production-doc style id → {workflow, model, sampler,
                                              steps, cfg, recommended_dimensions}

src/lib/local-broll/
    ├─ types.ts ............................ LocalBrollJob row shape
    ├─ orchestrator.ts ..................... Per-row generate-image / generate-clip dispatchers
    ├─ chain.ts ............................ Reference chaining (anchor + Redux-conditioned)
    ├─ text-protect.ts ..................... OCR + Flux Fill scrub pipeline
    └─ pipeline.ts ......................... Whole-doc batch: voiceover + rows → Remotion render
```

**Backend swap path**: `visual-generator/comfyui-local.ts` implements a thin `VisualGenerator` interface. A future `runpod.ts` or `replicate.ts` is a config switch, not a rewrite. Calling code (orchestrator, chain, text-protect) doesn't know which backend it's hitting.

## Implementation — phased (small, high-signal first)

Each phase ships something **usable** independently. No big-bang merge.

### Phase 1 — Image MVP (~1 day)

**Ships:** `/local-studio` page that generates a single image from a prompt + style + size. Uses Flux.1-schnell or Flux.1-dev (already on disk).

1. `src/lib/comfyui/client.ts` — typed HTTP wrapper (submit, history, fetch output).
2. `src/lib/comfyui/workflow-fill.ts` — placeholder injection.
3. `src/lib/comfyui/workflows/flux-schnell-t2i.json` + `flux-dev-t2i.json` — start with 2 workflows.
4. `src/lib/visual-generator/types.ts` + `comfyui-local.ts` (image methods only).
5. `src/lib/comfyui/style-mapping.ts` — map each built-in style to a default workflow + params.
6. `src/app/local-studio/page.tsx` — prompt textarea + style picker (uses `listAllStyles()` — built-ins + saved) + size dropdown + run button + image preview + history.
7. `src/app/api/local-studio/generate/route.ts` + `status/route.ts` — gate on `LOCAL_STUDIO=1`.
8. **Observability**: `[local-studio submit]`, `[local-studio poll]`, `[local-studio complete]` with values not just events.
9. **Security**: validate ComfyUI URL is localhost, reject anything else.

**Smoke test**: open `/local-studio`, type "a foxhound running through autumn forest, cinematic", pick "Cinematic" style, click Run → an image appears.

### Phase 1.5 — HiDream-I1 + Qwen-Image (~½ day)

**Ships:** model picker on `/local-studio` lets you pick Flux schnell / Flux dev / HiDream-I1 / Qwen-Image. Style mapping updated so styles can opt into different default models.

1. Download `hidream_i1_dev_fp8.safetensors` (~12 GB) + needed text encoders + VAE.
2. Download Qwen-Image Q5_K_M GGUF (~14 GB) — for typography-heavy stills.
3. New workflows: `hidream-i1-dev-t2i.json`, `qwen-image-t2i.json`.
4. Update style-mapping: e.g. "documentary photo" → HiDream; "infographic with text labels" → Qwen.

### Phase 2 — Reference chaining (consistency v1, ~1 day)

**Ships:** per-doc anchor image + every subsequent generation chains against it. Local parity with the May 20 consistency plan's v1.

1. Download **Flux Redux** (Comfy-Org repo, ~3–5 GB).
2. New workflow `flux-redux-chain.json` — takes `{anchor_image}` + `{prompt}` + `{style_suffix}` and emits a new image in the anchor's visual language.
3. `src/lib/local-broll/chain.ts` — wraps the orchestrator: first generation is t2i, subsequent generations route through Redux with the anchor.
4. Migration: new `local_broll_jobs` table with `doc_id`, `anchor_url`, `is_anchor`, `chained_from`, output URL, status.
5. UI: "Re-anchor from this image" button (parity with cloud), per-doc "Keep images consistent" toggle (default ON).

### Phase 3 — Image-to-video (LTX-2.3 + Wan 2.2, ~1–2 days)

**Ships:** "Make it move" button on the local-studio page and a per-row option. Two video models — fast (LTX-2.3) and quality (Wan 2.2).

1. Download LTX-2.3 22B distilled fp8 (~13 GB).
2. Download Wan 2.2 I2V Q5_K_M GGUF — **both** HighNoise + LowNoise parts (MoE architecture, ~7 GB each ≈ 14 GB), + umt5-xxl text encoder, + wan2.1 VAE.
3. New workflows: `ltx-2.3-i2v.json`, `wan-2.2-i2v.json`.
4. `VisualGenerator.generateClip(image, prompt, options)` — picks model based on user selection or row config.
5. Output goes to ComfyUI/output as `.webp` animated or `.webm` (Remotion handles both).
6. **Live progress** via ComfyUI WebSocket — show step count + ETA in UI.

### Phase 4 — Production-doc per-row integration (~1–2 days)

**Ships:** the existing production-doc UI gets a new button group per row: **"Local image"** / **"Local clip"** (next to existing Veo/Sora/Kling buttons). Reads the row's style, generates, stores URL on the row.

1. New API routes `/api/local-studio/doc/[docId]/row/[rowIndex]/{image,clip}`.
2. Per-row UI buttons mirror the existing cloud b-roll buttons (rule 16 — same affordance).
3. The doc-level anchor (Phase 2) is inherited; row 1's local image becomes the anchor unless one already exists.
4. **Per-row kie.ai override**: right-click → "Use kie.ai instead (Veo 3.1 / Sora 2 / Kling)" — falls through to the existing cloud path.
5. Cost gauge in doc header sums kie.ai-routed rows only — local rows cost $0.

### Phase 5 — Text protection (i2v v3a parity, ~1–2 days)

**Ships:** when a row's still has text/numbers/logos, i2v never warps them. Parity with the May 20 consistency plan v3a.

1. Download `flux1-fill-dev.safetensors` (already in Comfy-Org/flux1-dev repo, ~16 GB) — Flux's inpainting variant.
2. Tesseract.js OCR step in `src/lib/local-broll/text-protect.ts` (same module name + interface as the cloud `still-text-protect.ts` so the Remotion layer is identical).
3. New workflow `flux-fill-inpaint.json` — takes still + mask, returns scrubbed image.
4. Compose pipeline: OCR → mask → scrub via Flux Fill → i2v on scrubbed image → Remotion composites text back via the existing `BRollScene.textOverlays` prop from the cloud plan.
5. Per-doc toggle "Auto-protect text in animations" (default ON), per-row "Skip text protection for this scene".

### Phase 6 — Voiceover-driven batch pipeline (~1–2 days)

**Ships:** one-click "Generate entire doc locally" on a doc that has voiceover uploaded.

1. Iterate rows: for each, dispatch local image or local clip per the row's toggle.
2. Anchor chain stays consistent across the batch.
3. As outputs land, attach URLs to the doc rows (idempotent via row signature).
4. Once all rows are ready, hand off to the existing Remotion render — same code path as the cloud doc render today.
5. Progress UI: queue view showing per-row status, ETA, partial outputs.

### Phase 7 — Style sheet (consistency v2, ~2 days)

**Ships:** parity with cloud v2. A per-doc "world sheet" image (character poses + palette + line-weight) is generated once at doc init; every row chains against the sheet, not against scene 1.

1. New workflow `style-sheet-t2i.json` (uses Flux + Redux or HiDream).
2. Multimodal prompt-writer hook (cloud LLM sees the sheet when writing per-row prompts) — uses existing thumbnail-reference multimodal pattern.
3. Per-style `has_protagonist` field for "sheet shows character vs props-only".

### Phase 8 — Polish, presets, gallery, settings, SwarmUI integration (ongoing)

- User-saved combos ({style + model + dimensions + duration}).
- Per-project gallery of past generations + retries.
- Settings audit (rule 15) — see below.
- Optional: install SwarmUI alongside as a friendlier direct ComfyUI frontend for power tasks not exposed in `/local-studio`.

## Settings audit (rule 15)

New `localStudio.*` group in the existing settings layer. Plain-English labels.

**Per-user defaults** (in `collaborators.encrypted_settings`):
- `local_studio.enabled`: master switch
- `local_studio.comfyui_url`: default `http://localhost:8188`, validated to localhost-only
- `local_studio.default_image_model`: Flux.1-schnell | Flux.1-dev | HiDream-I1 | Qwen-Image (default: HiDream-I1)
- `local_studio.default_video_model`: LTX-2.3 fast | Wan 2.2 quality (default: LTX-2.3 fast for iteration)
- `local_studio.auto_open_comfyui_on_app_start`: true/false (default: false)
- `local_studio.output_destination`: "project-attached" | "ephemeral" (default: project-attached)

**Per-doc** (matches cloud consistency plan's wording exactly — single mental model):
- "Keep images visually consistent" (default ON) — toggles reference chaining + style sheet
- "Auto-protect text and numbers when animating" (default ON) — toggles v3a Option D
- "Use local generation by default" (default ON when `LOCAL_STUDIO=1`)

**Per-row** (right-click menu):
- "Re-anchor from this image"
- "Skip text protection for this scene"
- "Use kie.ai instead" (overrides to cloud) — picker shows Veo 3.1 / Sora 2 / Kling / etc.
- "Pin model: …" — override the default local model

**Per-style** (style editor):
- Style has a new `local_workflow_id?: string` optional field — overrides the default style→workflow mapping for power users.

## Security (rule 13)

- **Localhost-only enforcement**: `comfyui_url` validated server-side via existing `assertSafeLocalhostUrl` pattern (similar to `assertSafePublicUrl` used in the cloud SSRF block). Reject any non-`127.0.0.1` / non-`localhost` URL. No tunneling support in v1 = no SSRF surface from the local feature.
- **Build gate**: `LOCAL_STUDIO=1` env flag check at the top of every local route + at build time via a `process.env.LOCAL_STUDIO !== '1' ? null : <Page />` pattern so the entire surface short-circuits in prod builds.
- **No prompt logging to Vercel**: all `[local-studio *]` logs stay on `console.info` for the local `next dev` only — never wired to `logger.info` (which would ship them to prod log search).
- **Workflow JSON tampering**: workflow templates ship in-repo, not loaded from external sources. No user-supplied workflow JSON in v1.
- **OCR text sensitivity** (Phase 5): same rule as cloud — log region count + duration, never log OCR'd text content.
- **No cost-bomb surface**: local generation costs nothing, so rate limiting is for UX (queue management), not abuse defense.

## Observability (rule 14)

Namespaces with concrete values, mirroring the cloud consistency plan's style:

- `[local-studio submit]` — `{ workflow, model, prompt: prompt.slice(0,80), width, height, seed }`
- `[local-studio queue]` — `{ prompt_id, queue_position }`
- `[local-studio progress]` — `{ prompt_id, step, total_steps, eta_seconds }` (from WebSocket)
- `[local-studio complete]` — `{ prompt_id, duration_ms, output_url, size_bytes }`
- `[local-studio error]` — `{ prompt_id, step, error_message, retryable }`
- `[local-studio chain]` — `{ docId, anchor_url, rowIndex }` / `ok { resultUrl, duration_ms }` / `fallback_t2i { reason }` (Phase 2)
- `[local-studio text-protect ocr]` — `{ region_count, duration_ms }` (Phase 5)
- `[local-studio text-protect scrub]` — `{ scrubbed_url, duration_ms }` / `skip { reason }` (Phase 5)
- `[local-studio batch]` — `{ docId, row_count, completed, failed }` (Phase 6)

Per rule 14: log **values**, not just events. Boolean / count / duration / url-slice in every line so we can grep a console paste back to the broken step.

## Cost (rule 8)

| Step | Cost | Verified |
|---|---|---|
| Local image generation (any model) | **$0** | Local compute only |
| Local i2v generation (any model) | **$0** | Local compute only |
| Local reference chaining (Flux Redux) | **$0** | Local |
| Local OCR (Tesseract.js) | **$0** | Local |
| Local text scrub (Flux Fill) | **$0** | Local |
| Per-row kie.ai fallback (hero shots) | Existing kie.ai price | Quoted in [broll-types.ts](src/lib/broll-types.ts) |
| Cloud LLM prompt-writing | Existing Anthropic/Google price | Already in `ai_spend_log` |
| Electricity at full GPU tilt | ~300W (~$0.10/hr at average US rates) | Negligible |

**Net cost per video**: kie.ai-routed rows only. A doc with 30 rows where 5 hit kie.ai for hero shots costs ~5 × per-row cloud price; the other 25 cost $0. Compared to today's full-cloud cost, this is roughly an **80–90% reduction** on docs that opt into local-first.

## QA plan (run before declaring each phase done)

**Phase 1:**
- Open `/local-studio` in `next dev` → page loads, ComfyUI status indicator is green.
- Generate an image with each built-in style ("Cinematic", "2D Animation", etc.) → output respects the style suffix.
- Kill ComfyUI mid-generation → UI shows "ComfyUI offline", retry available.
- Set ComfyUI URL to a non-localhost address → server rejects with clear error.
- `LOCAL_STUDIO` unset → `/local-studio` returns 404.

**Phase 2 (chaining):**
- Generate doc with 5 rows → confirm visual identity carries across rows 2–5.
- Re-anchor from row 3 → later rows show "style stale" hint.
- Toggle "Keep consistent" OFF mid-doc → subsequent rows use plain t2i.

**Phase 3 (video):**
- Generate a clip from a still with each video model → outputs land in ComfyUI/output, playable in browser.
- 16GB VRAM under load — confirm no OOM via `nvidia-smi` during Wan 2.2 inference.

**Phase 4 (production-doc integration):**
- Per-row "Local image" button on existing doc UI → image generated + attached to row.
- Per-row "Use kie.ai instead" → falls through to existing cloud flow unchanged.
- Cost gauge in doc header sums kie.ai rows only.

**Phase 5 (text protection):**
- Still with prominent number "07" → OCR detects, Flux Fill scrubs, i2v plays, Remotion composites "07" back at the right bbox.
- Force OCR failure → fallback to direct i2v, error logged, no user-visible crash.

**Phase 6 (batch):**
- Doc with 30 rows + voiceover → one-click generate → all rows complete → Remotion render → MP4 plays.

**Regressions (rule 6 — extreme QA):**
- Existing cloud b-roll flow unchanged (Phase 4 must be purely additive).
- Existing production-doc UI unchanged when `LOCAL_STUDIO=0`.
- Remotion render pipeline still works on docs with mixed local + cloud rows.
- `ai_spend_log` still captures every cloud call (no spend leaks).

## Open questions

1. **Wan 2.2 MoE on 16GB** — both HighNoise + LowNoise files need to load. Confirm in Phase 3 that swapping between them within a single workflow doesn't OOM. Fallback: use only LowNoise (single-stage), accept quality trade.
2. **Flux Redux vs IP-Adapter for chaining** — Redux is simpler (single node); IP-Adapter offers more control. Ship Redux v1; evaluate IP-Adapter if anchoring strength is wrong.
3. **Tesseract.js in `next dev`** — local-only context, no Vercel function bundle size constraint. Should just work; verify in Phase 5.
4. **SwarmUI alongside ComfyUI** — both can run, sharing the same model directory. Useful as a power-user surface for tasks not exposed in `/local-studio`. Document but don't gate v1 on it.
5. **Output storage** — local outputs land in `ComfyUI/output/`. Should they also be copied into the project's Vercel Blob namespace for cross-device access? Default v1: local-only (no copy). Add copy as a per-doc setting in Phase 6.

## Alternatives rejected

- **Tunneled ComfyUI from prod Vercel** — adds infra, auth, and 24/7 PC uptime requirement. User explicitly wants "local-only, lean mean". Defer to a future plan.
- **RunPod / hosted ComfyUI** — costs reappear (~$0.30/hr). Defeats the cost story.
- **Build a friendly UI on top of ComfyUI as a separate desktop app** — doesn't integrate with production-doc / voiceover / styles. Wrong shape.
- **Replace cloud b-roll entirely** — quality gap on hero shots is real; users would notice. Hybrid is correct.
- **Local LLM for prompt writing** — Claude/Gemini are cheap, faster, and better. Don't fight a battle we'd lose.
- **Wan 2.5 / 2.6 / 2.7** — weights not actually released as of 2026-05-20 despite Apache 2.0 marketing claims. Together AI hosts via API only. Re-evaluate when official HF weights land.
- **HunyuanImage 3.0** — 80B params, needs data-center hardware. Not feasible on 16GB.
- **Fooocus** — LTS / dead, no Flux 2 or SD3 support. Skip.

## Model lineup — definitive list with licenses

| Model | License | Size | Phase | Status |
|---|---|---|---|---|
| Flux.1-schnell fp8 | **Apache 2.0** ✅ | 16 GB | 1 | ✅ Downloaded |
| Flux.1-dev fp8 | ⚠ FLUX.1-dev (non-commercial) | 16 GB | 1 | ✅ Downloaded (private use only) |
| **HiDream-I1 dev fp8** | **MIT** ✅ | ~12 GB | 1.5 | ⏳ To download |
| **Qwen-Image Q5_K_M GGUF** | **Apache 2.0** ✅ | ~14 GB | 1.5 | ⏳ To download |
| **Flux Redux** (style ref) | Apache 2.0 | ~3–5 GB | 2 | ⏳ To download |
| **LTX-2.3 22B distilled fp8** | ⚠ LTX-2 Community (free <$10M rev) | ~13 GB | 3 | ⏳ To download |
| **Wan 2.2 I2V 14B (HighNoise + LowNoise Q5_K_M)** | **Apache 2.0** ✅ | ~14 GB total | 3 | ⏳ To download |
| **Flux Fill dev** | (Flux dev license — non-commercial) | 16 GB | 5 | ⏳ To download |
| ~~LTX-Video 0.9.5~~ | RAIL-M (restrictive) | 5.9 GB | — | 🗑 Delete (superseded by LTX-2.3) |

**Commercial licensing caveat**: Flux.1-dev and Flux Fill dev are non-commercial. If YT Studio is treated as a commercial product, lean on **Flux.1-schnell (Apache 2.0)**, **HiDream-I1 (MIT)**, and **Qwen-Image (Apache 2.0)** for production paths. Document this in the settings UI so users picking dev know what they're agreeing to.

## Implementation order (smallest, highest-signal first)

1. **Phase 1** — Image MVP with Flux (already on disk, fastest path to "working"). Validates the entire stack.
2. **Phase 1.5** — HiDream + Qwen-Image (quality + typography). Re-evaluate Flux.1-dev necessity once HiDream is in.
3. **Phase 3** — Image-to-video (LTX-2.3 fast + Wan 2.2 quality). Big user-visible jump.
4. **Phase 2** — Reference chaining. Foundation for any multi-row production use.
5. **Phase 4** — Production-doc per-row integration. Connects local to the real pipeline.
6. **Phase 5** — Text protection. Required before docs with text can use local i2v.
7. **Phase 6** — Voiceover-driven batch + Remotion handoff. End-to-end MP4 from local.
8. **Phase 7** — Style sheet. Cross-row identity perfection.
9. **Phase 8** — Polish + SwarmUI optional layer + presets + gallery.

Each step is independently shippable and reversible. Per-doc toggles default OFF for new doc-affecting features so existing docs aren't destabilised.

---

## TL;DR for the future Claude session that picks this up

- **Local-only ComfyUI b-roll inside YT Studio.** Vercel prod untouched.
- **Free** for the local path; **hybrid** per-row override keeps kie.ai (Veo 3.1 / Sora 2 / Kling) for hero shots where the open-source quality gap is visible.
- **Truly open-source today**: Wan 2.2 (Apache 2.0), HiDream-I1 (MIT), Qwen-Image (Apache), Flux.1-schnell (Apache). **Not** Wan 2.5+ (no weights released yet despite marketing).
- **Consistency** via Flux Redux (v1) + style sheet (v2), parity with [_plans/2026-05-20-cross-style-consistency-and-i2v-text-protection.md](_plans/2026-05-20-cross-style-consistency-and-i2v-text-protection.md).
- **Text protection** via OCR + Flux Fill scrub + Remotion composite, parity with the same cloud plan's v3a.
- **UI**: `/local-studio` page + per-row buttons on existing production-doc. SwarmUI optional as a power-user companion.
- **Phase 1 already executable** with Flux on disk — start there.

## Sources

- [HiDream-I1 ComfyUI native workflow + fp8 setup](https://comfyui-wiki.com/en/tutorial/advanced/image/hidream/i1-t2i)
- [Wan 2.2 I2V official HuggingFace (Apache 2.0)](https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B)
- [Wan 2.2 I2V GGUF quants (QuantStack)](https://huggingface.co/QuantStack/Wan2.2-I2V-A14B-GGUF)
- [LTX-2.3 fp8 on HuggingFace](https://huggingface.co/Lightricks/LTX-2.3-fp8)
- [Qwen-Image GGUF quants (city96)](https://huggingface.co/city96/Qwen-Image-gguf)
- [Comfy-Org/flux1-dev (includes flux1-fill-dev.safetensors)](https://huggingface.co/Comfy-Org/flux1-dev)
- [SwarmUI repo](https://github.com/mcmonkeyprojects/SwarmUI)
- [ComfyUI HTTP + WebSocket API docs (Comfy-Org/ComfyUI)](https://github.com/comfyanonymous/ComfyUI)
- [May 20 cross-style consistency plan (this repo)](_plans/2026-05-20-cross-style-consistency-and-i2v-text-protection.md)
