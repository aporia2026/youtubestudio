---
date: 2026-06-04
status: foundations-shipped — route wiring pending
branch: claude/video-creation-ui-pqXzS
follows_up_on: _plans/2026-06-04-topic-card-grid-circle-parity.md
---

# Per-Card Generation Pipeline for Topic Card Grid

## Why

The user has been seeing crowded rows in AI-generated topic-card grids despite multiple text-prompt fixes (`gutter * 1.8` row spacing, explicit "vertical gap 1.8–2× horizontal" instruction). Root cause: **the AI image model produces all N discs + spacing + labels in one render**, and image AI models are bad at precise grid layout — they follow the bundled reference image's visual layout more strongly than any text instruction.

The structural fix: **generate each card's illustration in a SEPARATE AI call**, then composite with our existing `buildCircleCellOverlay` which already produces SCP-style perfect spacing. Our code controls the layout; the AI only supplies illustrations.

The Phase 3 server composite work (`commit 177498a`) already accepts uploads and composites them onto a perfectly-spaced canvas. What's missing is feeding it AI-generated illustrations in pure-prompt mode.

## What's already shipped

`src/lib/thumbnail-formats/topic-card-grid-per-card.ts` + `tests/topic-card-grid-per-card.test.ts` (15 tests green).

Two exports:

### `buildPerCardPrompt(input: PerCardPromptInput): string`

Builds the text prompt for ONE card. Output is 1024×1024 square illustration suitable for downstream circle-crop. Inputs:

- `card: TopicCard` — subject + label
- `styleHeader: string` — shared style block prepended to every per-card prompt in a batch. Carries palette / line weight / illustration conventions so the N independent calls produce a coherent set.
- `cardShape: CardShape` — `'circle'` adds an explicit "corners will be clipped" warning. `'square'` skips it.
- `backgroundColor?: string` — optional explicit background. Falls back to `card.accent_color` when omitted.

### `runPerCardGeneration(input: PerCardRunnerInput): Promise<PerCardRunnerResult[]>`

Concurrency-limited parallel runner. Inputs:

- `cards: TopicCard[]` — the batch
- `styleHeader`, `cardShape` — threaded to every prompt
- `generate: (prompt, card) => Promise<Buffer>` — injected AI call. Route injects `generateImageOpenAI`; tests inject a stub.
- `concurrency?: number` — default 4, clamps to card count.

Returns a stable-order result array. Per-card errors are captured in `result.error` — the runner never throws. Caller decides retry / fallback / ship-partial policy.

## What's left — route wiring

Touch [src/app/api/thumbnails/format/topic-card-grid/image/route.ts](src/app/api/thumbnails/format/topic-card-grid/image/route.ts). Specific changes:

### 1. Add a new mode flag

Request body extension:

```ts
generationMode?: 'one-shot' | 'per-card';
```

Default: `'one-shot'` (existing behaviour preserved). Editor sends `'per-card'` when the user opts in.

### 2. Branch the AI call

At [route.ts:663 (the `generateImageOpenAI` call)](src/app/api/thumbnails/format/topic-card-grid/image/route.ts#L663) — when `generationMode === 'per-card'`:

- Skip the single mega-prompt AI call.
- Build a `styleHeader` from the existing style block (extract from `topicCardGridImagePrompt`'s style section, OR generate a focused one from `style` / `styleFreeForm`).
- Call `runPerCardGeneration({ cards, styleHeader, cardShape, generate, concurrency: 4 })` where `generate` is a wrapper around `generateImageOpenAI` that returns the bytes.
- Substitute a WHITE `aiBytes` placeholder (the size of the final canvas) so the existing layout/composite math at [line 684+](src/app/api/thumbnails/format/topic-card-grid/image/route.ts#L684) keeps working — every cell ends up being painted by the composite anyway.
- Map every successful per-card result into the `cellUploads` array. The composite already knows what to do with uploads.

### 3. Handle per-card failures

If any per-card call fails:

- Option A (recommended): substitute a `card.accent_color`-coloured square placeholder for the failed card and continue. User sees a coloured disc with the label, can right-click → regenerate that one card.
- Option B: fail the whole request with a 502 listing which card indexes failed.

Pick A — partial-success delivery matches the existing pattern (uploads that 404 fail loudly, but the composite degrades gracefully on missing cutouts at [line 752](src/app/api/thumbnails/format/topic-card-grid/image/route.ts#L752)).

### 4. Cost audit

Each per-card `generateImageOpenAI` call should call `recordIntent` + `markDelivered` separately so the spend report shows per-card line items. Don't double-bill — skip the audit row on the mega-call when `generationMode === 'per-card'`.

Expected per-render cost: `N × 0.041` USD at GPT Image 2 medium 1024×1024. For 3×3 = $0.37 vs $0.04 for one-shot. **Flag this in the editor UI before the user hits Generate** — a tooltip or a small "9 calls × $0.04 = $0.36" note next to the toggle.

### 5. Editor toggle

Add a "Generation mode" segmented control to `TopicCardGridPanel.tsx`:

- `[One-shot] [Per-card (sharper layout)]`
- Default: One-shot
- Tooltip on Per-card: "Generates each card separately for perfect spacing. Costs N × per-card call."
- Persist to localStorage as `topic_card_grid_default_generation_mode`.

### 6. Tests

- Mock the AI call and assert the route, in per-card mode, builds the right number of cellUploads and feeds them into applyCellUploads.
- Assert partial-failure substitution doesn't crash the composite.
- Assert one-shot mode is unaffected (regression).

## Estimate

For a focused fresh session: **2–3 hours**.

- Route wiring: 1.5 h (the route is dense; tracing all the upload / cutout / cost-audit paths needs care).
- Editor UI: 30 min.
- Tests: 1 h.
- Manual QA + cost verification: 30 min.

## Risks

1. **OpenAI rate limits**. Per-card mode fires 4 concurrent calls. Org-level limits should accommodate this for a single user, but a viral spike could 429. Mitigation: the runner's concurrency parameter is already plumbed — drop to 2 if we hit limits.

2. **Style drift across cards.** The `styleHeader` is the lever — if cards still look like a yard sale, beef up the header with more explicit visual conventions (line weight in pixels, exact palette hex codes, "no scenes, no landscapes" reinforcement). Iterate on the header without touching the architecture.

3. **Cost surprise.** A user running a 5×5 grid (25 cards) at $0.04 each = $1 per render. They could blow through credits fast. The cost flag in the editor is non-negotiable.

4. **AI failure rate.** GPT Image 2 sometimes returns content-policy refusals on subjects the model thinks are sensitive (CIA, MKUltra, etc.). With 9 independent calls instead of 1, the failure rate compounds. Partial-success substitution (option A above) keeps the user moving.

## Open questions

- **Cheaper model option?** Per-card calls at $0.04 add up. Alternative cheaper models that produce 1024×1024 single illustrations: Replicate `bytedance/sdxl-lightning-4step` (~$0.003), Replicate `black-forest-labs/flux-schnell` (~$0.003), Kie GPT-Image-2 standard tier (~$0.02). The user should pick — per memory we never default model choices without asking.

- **Reuse the existing reference image?** When generating per-card, attaching the grid reference image to each call would confuse the AI (it expects a grid, we want a single illustration). Skip the reference attachment in per-card mode.

- **Mix uploads + AI-generated cards in the same render?** If the user uploaded 3 of 9 cards and wants AI for the other 6 — easy: only call `runPerCardGeneration` for cards without an upload. The existing `uploads` array semantics already handle the mix.

## How to resume

```bash
git checkout claude/video-creation-ui-pqXzS
git pull
npm install
npm test tests/topic-card-grid-per-card.test.ts  # 15 tests, should pass
```

Then implement the route wiring per section above. The hard parts (prompt builder, concurrency runner, error semantics, tests) are done — what's left is mostly threading existing pieces together in `route.ts`.
