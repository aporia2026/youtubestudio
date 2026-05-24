# Registry cleanup + system auto-upscale + 2×2 collage batching

**Date:** 2026-05-24
**Status:** Drafted, awaiting approval
**Owner:** info@flexelent.com

## Goal

Three related changes, delivered in order. Each is independently
valuable and the later ones build on the earlier ones.

- **Phase 1 — Image model registry cleanup.** Replace the current
  `nano-banana` (Gemini 2.5 Flash) entry with NanoBanana 2 (Gemini
  3.1 Flash). Remove NanoBanana Pro from the i2i registry entirely.
  Lock every kie.ai image model to **1K** at the code level (it's
  already hardcoded, but enforce it so future edits can't slip in
  a higher tier).
- **Phase 2 — System-wide auto-upscale.** Every cloud (kie.ai) image
  generation in the app gets a uniform post-generation upscale pass
  through Recraft Crisp Upscale ($0.0025/image, ~4×). Production
  doc, thumbnails, image edits, auto-pipeline — all of it.
- **Phase 3 — 2×2 collage batching + tester.** In the production-doc
  flow, every group of 4 sequential shots is generated as a single
  2×2 collage (1K, 16:9 cells), upscaled by Phase 2, then cropped
  server-side into 4 per-shot images. Cuts kie.ai generation cost
  ~70–75% per group. Ships with a debug panel in the editor where
  the user can paste 4 prompts and see the full pipeline run.

## Why this shape

The manager's insight (collage at 1K → upscale → crop) fixes the
resolution objection on collage mode: each cropped quadrant ends up
at ~2K on the long edge instead of ~960×540, matching or beating
today's per-shot quality. The same upscale step is independently
valuable everywhere else in the app, so it ships as its own primitive
that the collage feature consumes. The registry cleanup is unrelated
in mechanism but tied in spirit — we're committing to "1K + upscale"
as the single image-quality path, and the registry should reflect
that (no more multi-resolution knobs, no more deprecated NanoBanana
versions).

## Constraints / decisions (locked with user)

### Phase 1 — Registry
- Replace t2i `nano-banana` (`google/nano-banana`, Gemini 2.5 Flash)
  with NanoBanana 2 (`nano-banana-2`, Gemini 3.1 Flash, $0.04/1K).
  Keep the same `value: 'nano-banana'` id so existing rows that
  picked it keep working — only the underlying `kieModel` and label
  change.
- Remove `nano-banana-pro-i2i` from `image-models-i2i.ts` entirely.
- Add NanoBanana 2 to `image-models-i2i.ts` as the new default
  cloud i2i model (`value: 'nano-banana-2-i2i'`, same `image_input`
  refs field, `maxRefs: 14` per spec).
- Set `DEFAULT_CLOUD_I2I_MODEL = 'nano-banana-2-i2i'`.
- **Migration:** read-time silent fallback. When `getI2IModelSpec`
  is called with an unknown value (e.g. an old DB row storing
  `'nano-banana-pro-i2i'`), log a warning and resolve to the new
  default. No DB migration script.
- **Hard 1K enforcement:** add an assertion at the bottom of
  `buildKieImageInput` and `buildKieI2IInput` that throws if any
  caller passes `resolution !== '1K'`. Add a code comment at the
  top of `image-models.ts` and `image-models-i2i.ts` explaining the
  policy: we always use 1K because every cloud generation gets
  upscaled in Phase 2. Bumping past 1K wastes money for zero gain.

### Phase 2 — Upscale
- **Provider:** Recraft Crisp Upscale on kie.ai
  (`recraft/crisp-upscale`), $0.0025/image, ~4× factor.
- **Chokepoint:** wrap `src/lib/kie-poll.ts:pollKieResult` with a
  new `pollKieResultThenUpscale` helper so all 7 cloud surfaces
  opt in by changing one line.
- **Skip rule 1:** local ComfyUI generations are NOT upscaled
  (preserves the $0/image LOCAL_STUDIO=1 promise).
- **Skip rule 2:** images already wider than 2000px on the long edge
  are NOT upscaled (no quality gain, save $0.0025 + latency).
- **Failure mode:** retry once on 429/timeout/error, then return the
  un-upscaled image with a warning log + UI toast.
- **Scope:** truly everywhere — including image-edit/eraser/smart-edit.
- **Out of scope:** video / b-roll (Recraft is image-only).
- **Kill switch:** env flag `AUTO_UPSCALE_ENABLED` (default `true`).

### Phase 3 — Collage
- **Grouping:** sequential — shots 1–4, 5–8, …. Tail group of <4
  falls back to single calls.
- **Gutter:** thin neutral border between cells in the generation
  prompt, cropped out at the slicing step.
- **Eligible models:** all 5 kie.ai t2i models — Flux 2 Pro, GPT
  Image 2, Ideogram v3 Quality/Turbo, Grok Imagine, NanoBanana 2
  (post Phase 1 swap). Local models NOT eligible (no upscale → 540px
  quadrants).
- **Re-roll:** per-shot Regenerate stays single-image.
- **Triggers:** "Generate all missing stills" batch button AND fresh
  production-doc generation. NOT per-shot regen.
- **Malformed handling:** detect heuristically, retry collage once,
  then fall back to 4 individual single-image calls.
- **Default:** opt-in setting, off at launch.
- **Tester:** collapsible debug panel inside the production-doc
  editor. 4 prompt textareas + model picker + "Run pipeline" button.
  Shows the raw 1K collage, the upscaled collage, and the 4 cropped
  shots side-by-side. Hidden behind a debug flag so it doesn't
  clutter the editor for normal users.

## Phase 1 — Registry cleanup

### Changes

1. **`src/lib/image-models.ts`**
   - Update the `nano-banana` entry (line 72):
     - `kieModel: 'google/nano-banana'` → `kieModel: 'nano-banana-2'`
     - `label: 'Google NanoBanana'` → `label: 'Google NanoBanana 2'`
     - `hint`: `'Google Gemini 3.1 Flash Image — fast, accurate text rendering'`
   - In `buildKieImageInput`, the `google/` branch becomes a check on
     the new `nano-banana-2` model string. The `image_size: '16:9'`
     and `output_format: 'png'` shape stays — NanoBanana 2 accepts
     both. Add `resolution: '1K'` for explicitness.
   - Top-of-file comment block: add a paragraph stating "All cloud
     models in this registry are pinned to 1K. Every cloud generation
     is upscaled to ~4K via Recraft Crisp Upscale in the dispatcher
     pipeline. Bumping any model to 2K/4K wastes money for zero gain."
   - End of `buildKieImageInput`: assert
     `if (input.resolution && input.resolution !== '1K') throw ...`.

2. **`src/lib/image-models-i2i.ts`**
   - Delete the `nano-banana-pro-i2i` entry (lines 91–104) entirely.
   - Add a `nano-banana-2-i2i` entry at the same position:
     ```
     {
       value: 'nano-banana-2-i2i',
       label: 'Reference-driven (NanoBanana 2)',
       provider: 'kie',
       kieModel: 'nano-banana-2',
       refsField: 'image_input',
       maxRefs: 14,
       extraInput: { aspect_ratio: '16:9', resolution: '1K' },
       hint: 'Default for ref-bearing styles. Gemini 3.1 Flash, ~$0.04/image, supports 14 references.',
       costUsdPerImage: 0.04,
     }
     ```
   - Update `DEFAULT_CLOUD_I2I_MODEL` from `'nano-banana-pro-i2i'` to
     `'nano-banana-2-i2i'`.
   - In `getI2IModelSpec`, add read-time fallback:
     when an unknown value is requested, log
     `[i2i registry] unknown model {value} → falling back to default`
     and return `getI2IModelSpec(DEFAULT_CLOUD_I2I_MODEL)`. Keep this
     so old DB rows storing `'nano-banana-pro-i2i'` resolve cleanly.
   - End of `buildKieI2IInput`: same 1K assertion as t2i.
   - Top-of-file comment: same 1K-policy paragraph as t2i.

3. **Tests:**
   - `tests/image-models-1k-enforcement.test.ts` — new file. Asserts:
     - Every Kie spec's `extraInput.resolution`, if present, is `'1K'`.
     - `buildKieImageInput` throws when monkey-patched to produce a
       non-1K resolution.
     - `buildKieI2IInput` ditto.
     - `getI2IModelSpec('nano-banana-pro-i2i')` returns the new
       NanoBanana 2 default spec (fallback works).
   - Update any existing test that hardcodes `'nano-banana-pro-i2i'`
     or `'google/nano-banana'` to match the new ids/strings.

### Migration safety

- `I2I_MODEL_VALUES` is the styles validator allow-list (line 179).
  Removing `nano-banana-pro-i2i` from `I2I_MODELS` removes it from
  this list too. Old rows in `production_doc_styles` storing the
  old value will fail the validator if it runs on read. Solution:
  the read-time fallback in `getI2IModelSpec` happens BEFORE the
  validator path in the dispatcher; verify during implementation
  that no read path validates the raw string against `I2I_MODEL_VALUES`
  without going through `getI2IModelSpec` first. If any does, add the
  fallback there too.
- Audit downstream callers of `'nano-banana-pro'` (the kieModel
  string, not the registry value): `scripts/style-spike.ts`,
  `scripts/style-spike-debug.ts`, `_plans/*`. Scripts are
  one-off; update or leave for archival. Plans are historical
  documents; do not edit.

## Phase 2 — System-wide upscale

### Surface inventory (verified)

Cloud surfaces that get the upscale (all flow through `kie-poll.ts`):
1. `src/app/api/generate/production-doc/image/route.ts:463-464`
2. `src/app/api/generate/production-doc/image/edit/route.ts`
3. `src/app/api/thumbnails/format/n-levels/image/route.ts`
4. `src/app/api/thumbnails/format/topic-card-grid/image/route.ts`
5. `src/app/api/thumbnails/image/route.ts`
6. `src/lib/auto-pipeline/image-gen.ts:69-80` (cron batch)
7. The collage path from Phase 3

Explicitly skipped:
- `src/app/api/generate/style-sheet/route.ts` — ComfyUI-only
- `src/app/api/local-studio/generate/route.ts` — local only
- `src/app/api/broll/route.ts` — video, out of scope

### Implementation outline

1. **New file `src/lib/upscale.ts`** with one function
   `upscaleViaRecraft(imageUrl, opts?): Promise<string>`.
   - Probes input dimensions via sharp metadata on the existing R2
     mirror. Skips if long edge > 2000px.
   - Calls `createKieTask('recraft/crisp-upscale', { image: imageUrl })`
     then `pollKieResult` (re-uses existing helpers).
   - Retries once on 429 / timeout / non-200 terminal.
   - On second failure: returns the original `imageUrl`, logs warning.
   - On success: mirrors the upscaled result to R2 using the same
     pattern as `route.ts:484-503`.

2. **Wire into `src/lib/kie-poll.ts`** — new wrapper
   `pollKieResultThenUpscale(taskId, apiKey, { skipUpscale })`.
   Existing `pollKieResult` unchanged; callers opt in by switching.

3. **Per-route switch** — each of the 7 routes swaps the call in
   one line.

4. **Env kill-switch** — short-circuits when
   `process.env.AUTO_UPSCALE_ENABLED === 'false'`.

### Cost & latency impact

- **Cost:** +$0.0025 per cloud generation. At 1000 gens/month: +$2.50.
  At 10k: +$25.
- **Latency:** Recraft poll typically 5–15s. Retry adds up to ~15s.
  Per-shot regen goes from ~10–30s → ~15–45s. Batch of 100 shots
  adds roughly 8–25 minutes. Acceptable per user; logged here.

## Phase 3 — Collage batching + tester

### Prompt template

```
A 2x2 grid collage of 4 distinct 16:9 cinematic scenes, separated
by a thin neutral grey border (10px). Each cell is a complete,
standalone scene with no visual elements bleeding into adjacent cells.

Top-left: <prompt for shot N>
Top-right: <prompt for shot N+1>
Bottom-left: <prompt for shot N+2>
Bottom-right: <prompt for shot N+3>
```

- Border is requested in the prompt AND cropped out at the slice
  step using fixed pixel ratios.
- Per-row style preset directives prepend the whole block, not each
  cell — the 4 shots in a group share style.

### Generation aspect / resolution

- Request **16:9** at **1K** (Phase 1 hard-enforces this). The 2×2
  of four 16:9 cells composes naturally to 16:9 outer.
- After Phase 2 upscale, the 1920×1080 collage becomes ~7680×4320
  (Recraft 4×). Each quadrant ~3840×2160 minus gutter trim →
  ~3800×2120, comfortably 4K per shot.

### Slicing

- New utility `src/lib/collage-slicer.ts` with one function
  `sliceCollage(upscaledUrl): Promise<[string, string, string, string]>`.
- Uses **sharp** (already in package.json at v0.34.5 — zero new deps).
- Trims outer/inner gutter before cropping. Configurable constants:
  `OUTER_TRIM_PCT = 1%`, `INNER_TRIM_PCT = 1%`. Tunable post-QA.
- Uploads each quadrant to R2 with the existing image upload path
  naming pattern. Returns the 4 R2 URLs.

### Malformed-result detection

Heuristic stack, cheapest first:
1. **Sharp histogram per quadrant** — if any quadrant is >90% one
   color, flag as malformed.
2. **Edge density per quadrant** — Sobel filter via sharp; near-zero
   edges → likely blank/uniform.
3. (Not v1) LLM vision check — too slow/costly for routine.

If malformed → retry collage once with a stronger prompt suffix
("Each cell must contain a unique, fully-rendered scene with clear
subject matter"). If second result also malformed → drop into per-
shot single-image calls for all 4.

### Cost picture (Phases 2+3 combined)

Per group of 4 shots:

| Model | Today (4 calls + 4 upscales after Phase 2) | Collage + 1 upscale | Savings |
|---|---|---|---|
| Flux 2 Pro | ~$0.16 + $0.01 = $0.17 | $0.04 + $0.0025 ≈ $0.0425 | **~75%** |
| Ideogram Quality | ~$0.20 + $0.01 = $0.21 | $0.05 + $0.0025 ≈ $0.0525 | **~75%** |
| NanoBanana 2 | ~$0.16 + $0.01 = $0.17 | $0.04 + $0.0025 ≈ $0.0425 | **~75%** |
| Grok Imagine | (cheap) + $0.01 | base + $0.0025 | **~70%+** |

### Triggers (UI surfaces)

- **"Generate all missing stills" batch button** in production-doc
  page (around `page.tsx:3254-3296`). When collage mode is on, the
  loop groups shots in chunks of 4 and calls a new
  `/api/generate/production-doc/collage` endpoint per group.
- **Fresh production-doc generation flow.** Same endpoint, called
  from wherever the "generate fresh doc" path triggers first-time
  image creation (located during implementation).
- **NOT the per-shot Regenerate** in `ShotInspector`.

### Collage tester (debug panel)

- New collapsible section in the production-doc editor, hidden
  unless `NEXT_PUBLIC_COLLAGE_TESTER=true` (or wherever the project
  already gates debug UI — verify during implementation; if no
  precedent exists, add this one). Header label: "Collage tester
  (debug)".
- 4 textareas labelled "Top-left", "Top-right", "Bottom-left",
  "Bottom-right".
- Model dropdown re-using `IMAGE_MODELS` (collage-eligible only).
- "Run pipeline" button. Hits a new dev-only endpoint
  `/api/dev/collage-test` that runs the same pipeline the real
  collage path uses: generate → upscale → slice.
- Output area shows three rows: (a) raw 1K collage from kie, (b)
  upscaled collage from Recraft, (c) the 4 cropped quadrants
  side-by-side with the prompt that produced each one beneath.
- "Save as project" button to stash a tester result on disk for
  later inspection — optional v1.
- The dev endpoint is gated server-side too: returns 404 unless
  `process.env.COLLAGE_TESTER_ENABLED === 'true'`. Defense in
  depth — even if the UI flag leaks, the endpoint stays closed
  in production.

## Security (rule 13)

- The Recraft endpoint takes a URL. We only ever pass URLs the
  server itself produced (Kie CDN / our R2 mirror) — never user
  input. No SSRF surface.
- Env vars `AUTO_UPSCALE_ENABLED` and `COLLAGE_TESTER_ENABLED` are
  server-only. No `NEXT_PUBLIC_` prefix.
- The collage tester debug panel uses a `NEXT_PUBLIC_COLLAGE_TESTER`
  flag for visibility but the endpoint enforces `COLLAGE_TESTER_ENABLED`
  server-side independently.
- Collage prompt template concatenates 4 row prompts. Existing prompt
  injection / safety filters apply unchanged.
- Rate limits on the t2i route (30/min IP + user) copy over to the
  collage route — not bypassed.
- No new PII surface. No new auth boundaries.
- Recraft is a third-party processor. Add to internal vendor list.
- Read-time fallback in `getI2IModelSpec` MUST log loudly so an
  attacker can't silently coerce model selection by storing
  garbage; the log line lets us spot abuse.

## Observability (rule 14)

All logs namespaced. Examples:

Phase 1:
- `[i2i registry] unknown model {value} → falling back to default { fallback }`
- `[image registry 1k-policy] blocked non-1K resolution { model, attemptedResolution }`

Phase 2:
- `[upscale recraft] start { taskId, sourceUrl, sourceLongEdge }`
- `[upscale recraft] skip too-large { sourceLongEdge, threshold: 2000 }`
- `[upscale recraft] skip kill-switch { AUTO_UPSCALE_ENABLED }`
- `[upscale recraft] success { taskId, ms, upscaledUrl }`
- `[upscale recraft] retry { taskId, attempt, error }`
- `[upscale recraft] failed graceful-fallback { taskId, error, originalUrl }`

Phase 3:
- `[collage generate] start { groupIndex, shotIndices, model }`
- `[collage generate] success { groupIndex, ms, kieUrl }`
- `[collage detect] result { groupIndex, malformedQuadrants: [...] }`
- `[collage generate] malformed retry { groupIndex }`
- `[collage generate] fallback to single-shot { groupIndex }`
- `[collage slice] success { groupIndex, quadrantUrls }`
- `[collage tester] run { user, model, hash-of-prompts }` (no raw
  prompts logged — could contain user secrets)

Client-side mirror in `EditorClient` and production-doc page when
collage mode triggers, so the user can see the savings path activated.

## Settings audit (rule 15)

New controls and where they live:

1. **`AUTO_UPSCALE_ENABLED` env flag** — server kill-switch. Not user-
   facing; lives in `.env`. Documented in the env-vars memory.
2. **`COLLAGE_TESTER_ENABLED` env flag** — server gate for the dev
   endpoint. Default off.
3. **`NEXT_PUBLIC_COLLAGE_TESTER` env flag** — client gate for the
   debug panel visibility. Default off.
4. **Collage mode toggle** — project-level, on `ProductionDoc` JSON:
   `collage_mode?: boolean` (default `false`). UI control: a single
   checkbox in the production-doc page settings panel, label
   "Generate 4 shots at once (cheaper, slight quality tradeoff)".
   Lives near the existing Image Model picker.
5. **(Not v1)** per-shot collage participation override.

## UX (rule 10 + rule 16)

- The collage toggle copy is plain language: "Generate 4 shots at
  once (~75% cheaper, slight quality tradeoff)" + tooltip: "We
  generate a single image with 4 scenes, upscale it, then crop into
  4 shots."
- Batch generation loading state: a single shared progress entry per
  group of 4 ("Generating shots 1–4 of 100…") instead of 4 stuck
  spinners on one underlying call.
- Per-shot re-roll: no UI change. Behaves exactly like today's
  single-image regen.
- Collage tester panel: collapsed by default. When opened, layout
  flows top-to-bottom: 4 prompt fields in a 2×2 grid (visually
  matching the output), then model picker, then Run button, then
  result area. Each result row labelled in plain English ("Raw 1K
  collage from generator", "Upscaled to ~4K", "Cropped shots").
- Fallback transparency: if the collage path falls back to 4 single-
  image calls, the user sees the normal per-shot loading states from
  that point — no scary warning. Logs are detailed for diagnosis.

## QA checklist (rule 6)

### Phase 1
- Open editor in a doc that previously selected the t2i `nano-banana`
  → label shows "Google NanoBanana 2" → Regenerate → request payload
  contains `model: 'nano-banana-2'`, `resolution: '1K'` → image lands.
- Open a style with `preferred_cloud_model: 'nano-banana-pro-i2i'`
  → `getI2IModelSpec` returns the NanoBanana 2 spec → log line
  observed → generation succeeds against the new model.
- Try to bump a resolution in code → 1K-enforcement test fails →
  proves the guard works.
- All existing tests pass after id/label updates.
- No remaining references to `nano-banana-pro` (kieModel) in
  non-archived code (`grep` clean).

### Phase 2
- Single per-shot regen end-to-end: image generated, upscale ran,
  R2 URL is upscaled version, dimensions ~4× input.
- Skip-if-large: feed in a >2000px source → upscale skipped, log
  shows skip reason, original URL returned.
- Recraft 429 path: mock 429 → one retry → graceful fallback with
  original URL. UI shows toast.
- Recraft timeout path: `pollKieResult`'s 285s ceiling applies;
  failure returns original URL.
- ComfyUI local generation: upscale path NOT touched, $0 promise
  preserved, no Recraft task created.
- B-roll generation: upscale path NOT touched.
- Thumbnail flows (N-Levels, Topic Card Grid, generic): each
  generates → upscaled output landed in R2.
- Image edit flow (eraser, smart edit): edited image is upscaled.
- Auto-pipeline cron thumbnail: end-to-end run, output is upscaled.
- Kill switch: `AUTO_UPSCALE_ENABLED=false` → every cloud surface
  skips the upscale, returns original URL, no Recraft task.

### Phase 3
- Collage mode toggle off → behavior identical to today.
- Collage mode toggle on, generate all missing stills with 16 shots
  → 4 collage calls, 4 upscale calls, 16 quadrants land in R2, each
  assigned to the correct shot row in order.
- Tail group of 3 shots (11-shot project → 2 collages + 1 single
  fallback). Verify the 11th shot is generated.
- Tail group of 1 shot → single fallback.
- Malformed result: manually craft a collage with one blank quadrant
  → heuristic flags it → retry path → if retry also malformed → 4
  single calls fire.
- Slicing: each quadrant has no visible border/gutter remnant.
- Cost telemetry: logs show 1 collage + 1 upscale per group.
- Fresh doc generation also routes through collage when toggle is on.
- Per-shot Regenerate after collage: stays single-image.
- Per-shot model override × collage (see open question 1).

### Collage tester
- With `NEXT_PUBLIC_COLLAGE_TESTER=true` + `COLLAGE_TESTER_ENABLED=true`:
  tester panel visible, endpoint reachable.
- With only the public flag: panel visible, endpoint returns 404.
- With neither: no panel, no endpoint.
- Fill 4 prompts, pick a model, Run → all 3 result rows render in
  order as each stage completes.
- Picking a non-eligible model is impossible (dropdown filtered).

## Alternatives rejected

- **Keep NanoBanana Pro alongside NanoBanana 2** — bloats the
  registry, splits user picks, and v2 covers v1's capability per
  the spec. Clean cut is simpler.
- **DB migration script for old `nano-banana-pro-i2i` rows** —
  read-time fallback is reversible and zero-risk; a destructive
  script is overkill for a deprecation that affects a handful of
  rows.
- **Allow 2K/4K on models that support it (NanoBanana 2, GPT Image 2)**
  — the user's explicit directive is "no more than 1K because we
  upscale everything". Honoured.
- **System-wide upscale that ALSO covers local ComfyUI** — breaks
  the $0/image promise; rejected.
- **Per-shot manual collage grouping** — over-scoped for v1.
- **Strict failure mode on upscale** — punishes user for vendor
  problem; rejected.
- **LLM vision check for collage malformed detection** — too slow
  and costly for the routine path.
- **Collage tester as its own page (`/dev/collage-tester`)** —
  user picked the in-editor debug panel for proximity to the real
  editor surfaces it tests against. Honoured.

## Open questions

1. **Per-shot model override × collage** — the per-shot image-model
   picker plan ([_plans/2026-05-24-per-shot-image-model-picker.md])
   is in flight. If a user sets per-shot model overrides AND turns
   on collage mode, what happens? Proposal: collage groups by
   contiguous-runs-of-same-model; runs of length <4 fall through to
   single-image calls. Confirm during Phase 3 implementation.
2. **Cheapest image dimensions probe** — sharp metadata on the R2
   mirror is the leading option; verify it's free of an extra HTTP
   fetch when the image is local to the request.
3. **Fresh-doc generation trigger location** — need to confirm
   during Phase 3 implementation; not in the surface map yet.
4. **Debug-flag precedent in the editor** — does any current debug
   UI in the editor already use a `NEXT_PUBLIC_*` gate? If yes,
   reuse it. If no, this introduces the convention.

## Delivery order

1. **Phase 1** (registry cleanup + 1K enforcement + tests).
2. Phase 1 QA pass.
3. **Phase 2** (upscale.ts + kie-poll wrapper + 7 route line-changes
   + env kill-switch + observability + QA).
4. Phase 2 QA pass.
5. **Phase 3** (collage route + slicer + detection + settings toggle
   + batch-button integration + tester panel + QA).
6. Phase 3 QA pass.
7. Update [_plans/2026-05-24-per-shot-image-model-picker.md] open
   question if it interacts.
8. Update [ROADMAP.md] in the same commits per the roadmap-location
   memory.
