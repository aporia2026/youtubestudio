# Shorter production-doc scenes + Grok Imagine, Veo 3.1, Runway models

**Date**: 2026-05-18
**Branch**: phase-1-foundation
**Status**: approved by user, ready to implement

## Problem

Two complaints from the user, addressed together because they touch the same
code path:

1. **Scenes are too long.** The production-doc prompt at
   `src/lib/prompts.ts:1944` instructs the LLM to make rows "6–10 seconds of
   spoken content". When a row's narration runs ≥10s the i2v clip animates
   the first ~10s and freezes the last frame for the remainder
   ([src/lib/broll-types.ts:364-366](src/lib/broll-types.ts#L364)). User
   describes this as "a very bad experience" even when the underlying clip
   is animated. There is a floor (`DEFAULT_MIN_SCENE_MS = 2000`) but **no
   ceiling**, so the model is free to bunch narration into long rows.

2. **Model coverage gaps.** Three model families on kie.ai are missing
   from the registry: Grok Imagine (i2v), Veo 3.1 (Lite/Fast/Quality), and
   Runway. The wire layer already has a `runway-generate` endpoint type
   stub at [src/lib/broll.ts:50-53](src/lib/broll.ts#L50-L53) but no Runway
   models are registered. Veo 3.1 uses a new endpoint
   (`/api/v1/veo/generate`) that the wire layer doesn't know about.

## User-confirmed decisions (already approved via question pass)

| Question | Answer |
|---|---|
| Target scene length | **4–6s balanced** — most scenes match a 5s i2v clip, snappier pacing |
| Long-narration overflow | **Split into 2+ visual rows** — same narration text, different visuals across rows |
| Grok Imagine variants | **One entry only**: 10s @ 720p i2v |
| Scope | **New + regenerated docs** — existing saved docs untouched until regenerated |

## Approach

### Part 1 — Tighten scene length (4–6s target, 7s hard cap)

**Three layers of defense:**

1. **Prompt change** — `productionDocPrompt()` in
   [src/lib/prompts.ts:1876-1951](src/lib/prompts.ts#L1876-L1951):
   - Change "Group sentences into segments of 6–10 seconds of spoken
     content" to "Group sentences into segments of **4–6 seconds** of
     spoken content. NEVER exceed 7 seconds in a single row. If a single
     sentence is too long, break it across multiple rows that share the
     same narration line at the sentence boundary but show different
     visuals."
   - Add a worked example block showing one 12s sentence split across
     two rows (timecode + script_text + distinct visual_description).
     Concrete examples land harder than rules on Claude/GPT.

2. **Post-validation pass** — new helper
   `validateAndSplitOverlongRows(rows, speakingPaceWpm)` in
   `src/lib/production-doc-postprocess.ts` (new file):
   - Walks the LLM output, computes `rowDurationSeconds` from word count
     and speaking pace.
   - For each row exceeding 7s: attempts an algorithmic split on sentence
     boundaries (`.`, `!`, `?`) so each resulting row is ≤6s.
   - If a single sentence alone exceeds 7s (no internal split point):
     leaves the row but flags it in a returned `warnings[]` array so the
     UI can surface a yellow indicator. **Honest trade-off**: we won't
     auto-LLM-rewrite for v1 — costs another model call per overflow
     and the user-facing impact is just "this single shot will freeze".
     Worth doing later if creators report it.
   - For rows produced by an algorithmic split: the visual fields
     (`visual_description`, `ai_image_prompt`) on the new row are
     duplicates of the source row. **This is a deliberate trade-off**:
     duplicate visuals on a split are still better than a frozen 12s
     animation. The user can edit the split row's visuals before
     animating if they want a distinct second shot. Surfaced in the
     warnings list so it's not silent.

3. **Generation route integration** —
   `/api/generate/production-doc/route.ts`:
   - After the LLM returns and rows are parsed, run them through
     `validateAndSplitOverlongRows`.
   - Persist a `generation_warnings: string[]` field alongside the doc
     content so the editor can render a "These rows were split because
     narration was too long" banner.

**Why three layers, not just the prompt?** LLMs are unreliable at length
constraints — even with a hard "NEVER exceed 7s" instruction, Claude/GPT
will produce occasional 9s rows. The prompt change cuts the rate by
maybe 80%; the post-validator catches the rest deterministically.

### Part 2 — Add Grok Imagine i2v (10s, 720p)

Single registry entry in [src/lib/broll-types.ts](src/lib/broll-types.ts):

```ts
function buildGrokImagineI2VBody(args: BuildBrollBodyArgs): Record<string, unknown> {
  return {
    model: 'grok-imagine/image-to-video',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    input: {
      image_urls: args.stillImageUrl ? [args.stillImageUrl] : [],
      prompt: args.prompt,
      mode: 'normal',
      duration: String(args.durationSeconds),  // 6-30, integer string
      resolution: '720p',
      aspect_ratio: args.aspectRatio,
      nsfw_checker: false,
    },
  };
}
```

Registry entry:
```ts
{
  id: 'grok-imagine-i2v-10s',
  label: 'Grok Imagine (10s, 720p)',
  kind: 'image-to-video',
  provider: 'kie',
  priceUsdLabel: '$0.70',  // ⚠ unverified, see "Cost" section
  priceUsd: 0.70,
  durationSeconds: 10,
  supportedAspects: ['16:9', '9:16', '1:1'],  // Grok also supports 2:3, 3:2
  endpoint: 'createTask',
  blurb: 'xAI Grok Imagine — newer i2v model from xAI.',
  buildBody: buildGrokImagineI2VBody,
}
```

Endpoint is the same `/api/v1/jobs/createTask` already used — no wire-layer change.

### Part 3 — Add Veo 3.1 (Lite, Fast, Quality)

**Wire-layer change first.** Veo 3.1 uses
`POST /api/v1/veo/generate`, not `/jobs/createTask`. Add a new endpoint
type to the descriptor:

```ts
// in BrollModelDescriptor
endpoint: 'createTask' | 'runway-generate' | 'veo-generate';

// in src/lib/broll.ts
const KIE_VEO_BASE = 'https://api.kie.ai/api/v1/veo';

function resolveCreateTaskUrl(endpoint: BrollModelDescriptor['endpoint']): string {
  if (endpoint === 'runway-generate') return `${KIE_RUNWAY_BASE}/generate`;
  if (endpoint === 'veo-generate') return `${KIE_VEO_BASE}/generate`;
  return `${KIE_BASE}/createTask`;
}
```

**Registry entries** — see "Open decisions" for which Veo 3.1 variants
to expose. Recommended minimum (assuming user wants i2v parity with
existing models):

- `veo-3-1-lite` (t2v) — most cost-effective
- `veo-3-1-lite` (i2v) — only if Lite supports `REFERENCE_2_VIDEO`
  (the kie.ai docs do not confirm; needs a test request before merging)
- `veo-3-1-fast` (t2v)
- `veo-3-1-fast` (i2v) — Fast explicitly supports `REFERENCE_2_VIDEO`
- `veo-3-1-quality` (t2v)
- `veo-3-1-quality` (i2v) — **deferred**. Quality's i2v mode is
  `FIRST_AND_LAST_FRAMES_2_VIDEO`, which requires TWO images (start +
  end). The production-doc flow only has one still per row, so the
  paradigm doesn't fit. Skip Quality i2v until we add a UX for picking
  end frames.

**Default duration** for Veo 3.1: 8s (matches existing veo-3-fast / veo-3-quality
durations — Veo 3 family has historically been 8s clips).

**Body builder** (one shared function, switches on model id):

```ts
function buildVeo31Body(args: BuildBrollBodyArgs, modelString: string, generationType: 'TEXT_2_VIDEO' | 'REFERENCE_2_VIDEO'): Record<string, unknown> {
  return {
    model: modelString,
    prompt: args.prompt,
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    aspect_ratio: args.aspectRatio,
    resolution: '720p',
    generationType,
    enableTranslation: false,  // we send English prompts already
    ...(generationType === 'REFERENCE_2_VIDEO' && args.stillImageUrl
      ? { imageUrls: [args.stillImageUrl] }
      : {}),
  };
}
```

### Part 4 — Add Runway

**Critical finding from the docs:** kie.ai's Runway endpoint exposes ONE
unified Runway product (no `model` parameter). The only knobs are
`duration` ∈ {5, 10}, `quality` ∈ {"720p", "1080p"}, and `imageUrl`
(presence ⇒ i2v). 10s + 1080p is blocked.

So Runway entries are tier-cross-products, not "model variants":

Recommended minimum set:
- `runway-i2v-5s-720p`
- `runway-i2v-10s-720p`
- `runway-t2v-5s-720p`
- `runway-t2v-10s-720p`

(Skipping 1080p for v1 — `clip-duration-fit` playback-rate compensation
makes 720p fine and 1080p costs more without a documented quality lift
at the small Production Doc render sizes.)

**Body builder:**

```ts
function buildRunwayBody(args: BuildBrollBodyArgs, hasImage: boolean): Record<string, unknown> {
  return {
    prompt: args.prompt,
    duration: args.durationSeconds === 10 ? 10 : 5,
    quality: '720p',
    ...(args.callbackUrl ? { callBackUrl: args.callbackUrl } : {}),
    ...(hasImage && args.stillImageUrl
      ? { imageUrl: args.stillImageUrl }
      : { aspectRatio: args.aspectRatio }),
  };
}
```

Note `aspectRatio` is only included for t2v — the docs say it's ignored
when `imageUrl` is provided. Field is `aspectRatio` (camelCase), NOT
`aspect_ratio`, unlike the other models. The wire-layer test will catch
typos.

## Files touched

| File | Change |
|---|---|
| `src/lib/prompts.ts` | Tighten timing language in `productionDocPrompt`, add split example |
| `src/lib/production-doc-postprocess.ts` | **NEW** — `validateAndSplitOverlongRows` |
| `src/app/api/generate/production-doc/route.ts` | Run post-validator, persist warnings |
| `src/lib/broll-types.ts` | Add `veo-generate` endpoint type, 4 new body builders, 8-10 registry entries (Grok×1, Veo 3.1 ×~5, Runway ×4) |
| `src/lib/broll.ts` | Add `KIE_VEO_BASE`, extend `resolveCreateTaskUrl` |
| `src/components/production-doc/BrollCell.tsx` | None — picker iterates `BROLL_MODELS`; new entries appear automatically |
| `tests/broll-models.test.ts` | Add body-builder tests for each new model |
| `tests/production-doc-postprocess.test.ts` | **NEW** — split-on-overflow unit tests |

## Approved decisions (locked)

- **D1 → option a**: hard cap at 7s + algorithmic split on sentence
  boundaries. Split rows duplicate visual fields; user can edit before
  animating.
- **D2 → option a**: 4 Veo 3.1 entries — Lite t2v, Fast t2v, Quality t2v,
  Fast i2v. Lite i2v and Quality i2v skipped (mode-support uncertainty
  and two-frame requirement respectively).
- **D3 → option a**: 4 Runway entries — i2v ×2 + t2v ×2 at 5s and 10s,
  720p only.
- **D4 → "user will paste prices"**: priceUsdLabel for every new entry
  comes from kie.ai pricing pasted by the user — no third-party estimates,
  no guesses. **BLOCKER on touching `BROLL_MODELS` until prices arrive.**
- **D5 → "group by family"**: BrollCell picker UI gets subheadings —
  Kling / Sora / Veo / Runway / Grok / Seedance / Other. Same model count,
  scannable layout. Within each family, i2v entries before t2v.
- **D6 → "add sora-2-i2v-15s"**: keep existing sora-2-i2v-10s entry, add
  new 15s entry. The body builder already picks `n_frames: '15'` when
  duration ≥13s ([broll-types.ts:164](src/lib/broll-types.ts#L164)).

## Expanded scope (after D-series)

| Family | Entries to add | Notes |
|---|---|---|
| Grok Imagine | 1 (i2v 10s 720p) | new model string `grok-imagine/image-to-video`, endpoint `createTask` |
| Veo 3.1 | 4 (Lite t2v, Fast t2v, Quality t2v, Fast i2v) | new endpoint type `veo-generate`, new wire-layer URL |
| Runway | 4 (i2v 5s, i2v 10s, t2v 5s, t2v 10s — all 720p) | uses existing `runway-generate` endpoint stub |
| Sora 2 | 1 (i2v 15s — new variant; 10s already registered) | reuses existing `buildSora2I2VBody` builder |
| Seedance | 6 (Seedance 2 i2v+t2v, Seedance 2 Fast i2v+t2v, Seedance 1.5 Pro i2v+t2v) | endpoint `createTask`, three new body builders |
| **Total** | **16 new entries** | picker goes from 9 → 25 entries |

The 16 number assumes the user picks every model. If picker-bloat becomes
real-world painful (creators report decision fatigue), revisit by hiding
older/lesser variants under an "advanced" toggle. Out of scope for this
branch.

## Files touched (revised count)

In addition to the prior list:
- `src/components/production-doc/BrollCell.tsx` — add family-grouping
  logic. Computed map `{ [familyName]: BrollModelDescriptor[] }` derived
  from `BROLL_MODELS`. Family inferred from `id` prefix or a new
  `family: string` field on the descriptor — **chosen: new field**, so
  the source of truth lives with each entry rather than a brittle
  startsWith() match.
- `src/lib/broll-types.ts` — add `family` field to `BrollModelDescriptor`
  with values `'kling' | 'sora' | 'veo' | 'runway' | 'grok' | 'seedance'`.
  Backfill on existing entries.

## Cost (rule 8) — LOCKED from kie.ai screenshots

All prices below verified against kie.ai's market catalogue (user
provided screenshots 2026-05-18). These are the `priceUsdLabel` values
that will be committed.

| Model | Modality | Tier | kie.ai price |
|---|---|---|---|
| Grok Imagine | i2v | 10s 720p ($0.015/sec) | **$0.15** |
| Sora 2 | i2v | 10s Standard | $0.15 (**fixes prior ~$1.00 mislabel**) |
| Sora 2 | i2v | 15s Standard (new) | $0.175 |
| Veo 3.1 Lite | t2v | 720p per video | $0.15 |
| Veo 3.1 Fast | t2v | 720p per video | $0.30 |
| Veo 3.1 Fast | i2v (REFERENCE_2_VIDEO) | 720p per video | $0.30 |
| Veo 3.1 Quality | t2v | 720p per video | $1.25 |
| Runway | i2v | 5s 720p | $0.06 |
| Runway | i2v | 10s 720p | $0.15 |
| Runway | t2v | 5s 720p | $0.06 |
| Runway | t2v | 10s 720p | $0.15 |
| Seedance 2 | i2v/t2v | 720p ($0.205/sec, no-video-input tier) | ~$1.03 per 5s |
| Seedance 2 Fast | i2v/t2v | 720p ($0.165/sec) | ~$0.83 per 5s |
| Seedance 1.5 Pro | i2v/t2v | 720p 8s no audio | $0.14 |

### Notable findings

1. **Sora 2 i2v was mislabeled in the existing registry as ~$1.00.** Actual
   kie.ai cost is $0.15 for 10s Standard. **This fix lands as part of
   this branch** so the picker stops misleading creators.
2. **Sora 2 has "stable" vs "Standard" pricing tiers** ($0.175 vs $0.15
   for 10s) and the existing body builder doesn't specify which one,
   so kie.ai picks the default. The label uses the cheaper Standard
   price. If kie.ai's silent default is actually "stable", we're
   off by $0.025/clip — within tolerance.
3. **Grok Imagine is one of the cheapest i2v options** at $0.015/sec
   ($0.15 for 10s 720p). Tied with Sora 2 Standard, 3× cheaper than
   Kling 2.5 Turbo 10s ($0.42). Worth considering for the default
   model in a future branch; deferred per user instruction to keep
   Kling as default for now.

Adding the post-validator and split logic is free (no extra LLM calls
in option a; one call per overflow row in option c — not picked).

## Security / safety (rule 13)

- No new persisted user data shapes; existing `broll_clips` table absorbs
  every new model id without schema changes.
- The post-validator runs server-side on already-validated LLM output —
  no new untrusted-input boundary. The split path operates on strings
  the LLM already produced and that we already pass through.
- Each new body builder hard-codes the model string. No string templating
  from user input into the `model` field.
- `nsfw_checker: false` on Grok Imagine matches the existing posture for
  Sora 2 / Kling. **Should we reconsider?** Probably yes for B-roll going
  out on public YouTube channels. Flagging for follow-up but not part of
  this branch.

## Observability (matches existing pattern)

- `[production-doc post-validate]` once per generation:
  `{ overlongRowCount, splitCount, warningCount }`
- `[broll model dispatch]` already exists in `broll.ts`; new endpoint
  type lands in its log line.

## QA (rule 6)

Golden path:
1. Generate a doc from a 90-word script (~40s narration). Expect every
   row ≤6s of narration. No `[post-validate]` splits triggered.
2. Generate a doc from a script containing a single 50-word sentence
   (forces ~22s narration in one row). Expect the post-validator to
   split it. Expect a warning surfaced in the doc UI.
3. Generate a doc, change model on a row to Grok Imagine, click Animate.
   Expect a `[broll model dispatch]` log with the kie createTask URL and
   a valid taskId returned.
4. Same for Veo 3.1 Lite t2v (no still required) and Runway i2v 5s.

Edge cases:
- Row with a single sentence that's >7s of narration (no split point).
  Expect: row left intact, warning emitted, no crash.
- All rows under 4s (very dense edit, lots of shots). Expect: no
  splitting, no warnings, doc renders normally.
- Existing pre-this-branch doc loaded in the editor. Expect: no errors,
  no retroactive splitting. New rules apply only on regeneration.
- Runway i2v + 1080p picked → should be rejected client-side (we don't
  expose this combo).

Regression check:
- Re-run existing tests in `tests/niche-finder-*.test.ts` and the broll
  type tests. Adding the new endpoint type must not break existing
  `findBrollModel` callers.
- Doc generation with a script that produced one specific output
  yesterday should NOT produce a wildly different row count today
  beyond what the new 4–6s rule would mathematically require. Keep a
  golden snapshot.

## Out of scope

- Auto-LLM rewrite for overflow rows (D1 option c) — future, costs money.
- Veo 3.1 Quality i2v (needs end-frame UX, separate feature).
- Runway 1080p tier (defer until creators ask).
- Retrofitting existing saved docs (user explicitly said "new + regenerated only").
- Changing `DEFAULT_BROLL_MODEL_ID` — user did not pick "make Grok the default",
  so Kling 2.5 Turbo stays the default.
