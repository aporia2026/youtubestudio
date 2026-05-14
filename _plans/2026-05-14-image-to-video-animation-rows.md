# Image-to-Video for Animation Rows

**Date:** 2026-05-14
**Branch:** phase-1-foundation
**Status:** in progress

## Goal

When a production-doc row's `visual_type` is `Animation` (or any other type where the user wants real motion), generating a B-roll clip should produce an **image-to-video** rendering of the row's already-generated still — not a text-to-video Sora 2 / Veo 3 clip that has no relationship to the still. The resulting video must replace the static-image-plus-Ken-Burns rendering currently used by `BRollScene`.

## Why

Today every shot in the Remotion render is a flat PNG wrapped in `<KenBurns>` (zoom/pan). That's wrong for Animation rows whose prompts describe actions the model is supposed to animate (e.g. "a stick figure walks up and draws a red X across the map"). The action is baked into the still as an end-state — Remotion has no information to play it out. We need actual video. Image-to-video models preserve the still's style and add prompt-guided motion, which is exactly the right pipeline for this.

Secondary motivation: the existing B-roll pipeline (text-to-video via Sora 2 / Veo 3) fights the user's chosen 2D doodle style because `buildBrollPrompt` hardcodes a "Photoreal, no on-screen text, no watermarks" tail. For 2D / illustrated rows this is actively wrong.

## Constraints

- **Cost ceiling per Animation row: ~$0.50.** A 30-row doc with 15 Animation rows must stay under ~$10 worth of generations.
- **No new external services** beyond Kie.ai. We already have a working Kie wrapper, polling, and retry; this work is additive.
- **No regressions to existing text-to-video B-roll generation.** Users currently using Sora 2 for B-Roll rows must keep that path working unchanged.
- **Renderer must fall back to the still** when (a) no clip has been generated, (b) the clip failed, or (c) the clip URL is unreachable.

## Decisions (taken with user 2026-05-14)

- **Default model: Kling 2.5 turbo image-to-video, 10s.** $0.42 per generation. Kling preserves illustrated/2D styles well.
- **Full picker available** with grouped sections: "Animate this image" (image-to-video) and "Generate from text" (text-to-video).
- **User can set their own default**, stored per-user in the database (not per-workspace, not localStorage).
- **On rows with no still image yet**, the B-roll button is disabled with a hint when the user's default is an image-to-video model. No silent fallback to text-to-video.

## Pricing reference (live as of 2026-05-14, sourced from kie.ai pricing screens)

| Model id (Kie) | Mode | Duration | $/clip |
|---|---|---|---|
| `kling/v2-5-turbo-i2v-10s` | i2v | 10s | $0.42 (DEFAULT) |
| `kling/v2-5-turbo-i2v-5s` | i2v | 5s | $0.21 |
| `kling/v2-6-i2v-10s` (no audio) | i2v | 10s | $0.55 |
| `kling/v2-6-i2v-5s` (no audio) | i2v | 5s | $0.275 |
| `runway/image-to-video-10s-720p` | i2v | 10s | $0.15 |
| `runway/image-to-video-5s-720p` | i2v | 5s | $0.06 |
| `runway/image-to-video-5s-1080p` | i2v | 5s | $0.15 |
| `sora-2/text-to-video` (existing) | t2v | 8s | unverified |
| `veo3/fast/text-to-video` (existing) | t2v | 8s | $0.40 |
| `veo3/quality/text-to-video` (existing) | t2v | 8s | $2.00 |

Exact Kie model id strings will be confirmed against `docs.kie.ai` during implementation — the formats above are inferred from the existing wrapper's pattern and the docs we could load. Sora 2 t2v's $/clip was not on the public Kie pricing page at time of writing; verify in the Kie dashboard before relying on it.

## Implementation steps

### 1. Storage (no new migration)
- Re-use the existing `collaborators.encrypted_settings` JSON blob (added by migration 0003, surfaced via `src/lib/user-settings.ts`).
- Add `default_broll_model_id?: string | null` to the `UserSettings` interface and the parser.
- Absence (or a stored id no longer in the registry) falls back to `DEFAULT_BROLL_MODEL_ID`.

### 2. Model registry ([src/lib/broll-types.ts](src/lib/broll-types.ts))
- Add `kind: 'text-to-video' | 'image-to-video'` to `BrollModelDescriptor`
- Add a `priceUsd` field (display only — never used to bill)
- Add the image-to-video entries from the table above
- Change `DEFAULT_BROLL_MODEL_ID` to `'kling-2-5-turbo-i2v-10s'`. The existing constant is used as the fallback when no per-user default is set.

### 3. Prompt builder ([src/lib/broll.ts](src/lib/broll.ts))
- `buildBrollPrompt` takes a new arg `mode: 't2v' | 'i2v'`. When `mode === 'i2v'`, drop the cinematic tail entirely and replace with a motion-only tail: "Subtle character motion matching the described action. No camera shake, no scene changes, no added text."
- The existing `'t2v'` path keeps the photoreal tail unchanged.

### 4. Kie request ([src/lib/broll.ts](src/lib/broll.ts))
- `kieCreateVideoTask` now branches on `model.kind`:
  - `t2v`: send `{ prompt, aspect_ratio, duration }` as today
  - `i2v`: send `{ prompt, image_url | image_urls: [stillImageUrl], duration | n_frames, aspect_ratio }`
    - The exact input shape varies per model; resolved by a small per-model `buildInput()` helper attached to each descriptor

### 5. Orchestrator + API route
- `StartBrollGenerationArgs` gains `stillImageUrl?: string`
- For `i2v` models, the orchestrator REQUIRES `stillImageUrl`; throws a 400 with "Generate the still image first" otherwise
- POST `/api/broll` accepts a new `stillImageUrl` field

### 6. User-default API
- New route `GET/PUT /api/user/preferences/broll-default`
- GET returns `{ modelId: string | null }`
- PUT body `{ modelId: string | null }`; null clears
- Server validates the modelId against `findBrollModel()` before persisting

### 7. BrollCell UI ([src/components/production-doc/BrollCell.tsx](src/components/production-doc/BrollCell.tsx))
- On mount, fetch the user's default and seed `modelId` with it (fall back to `DEFAULT_BROLL_MODEL_ID`)
- New prop `stillImageUrl?: string` — passed from the parent (existing `rowImages[i]?.imageUrl`)
- Generate button is **disabled** when the resolved model is i2v AND `stillImageUrl` is missing. Hint: "Generate the still first."
- Picker is grouped: "Animate this image" (i2v) on top, "Generate from text" (t2v) below. Each option shows label, duration, and price. Current default has a filled star; clicking the star on a different option calls PUT and re-renders.

### 8. Renderer wiring ([src/remotion/types.ts](src/remotion/types.ts), [src/remotion/scenes/BRollScene.tsx](src/remotion/scenes/BRollScene.tsx), [src/remotion/utils.ts](src/remotion/utils.ts))
- Add `videoUrl?: string` to `VideoShot`
- `productionDocToVideoConfig` takes a new optional `rowVideoClips: (string | null)[]` and populates `videoUrl` when the entry is non-null
- `BRollScene` renders `<OffthreadVideo>` (full-bleed, object-cover) when `videoUrl` exists, with `playbackRate=1`. When shot duration > clip duration, the trailing frames stay on the last visible frame (Remotion behavior of `<OffthreadVideo>` with no `endAt`). If `imageUrl` exists but not `videoUrl`, current Ken Burns path runs unchanged.

### 9. Production doc page hookup
- The existing per-row clip state (already maintained for the BrollCell badge) is collected into a parallel array passed to `productionDocToVideoConfig`. Only `status === 'ready'` clips with `video_url` non-null contribute.

## Out of scope (not in this PR)

- Auto-triggering generation for Animation rows. The user still clicks Generate per row.
- Cost prefetch / per-doc budget guardrails.
- Migrating the existing Sora 2 / Veo 3 picker UI to the new grouped layout. (It'll inherit it because BrollCell is shared.)
- Backfilling user-default for existing users. Absence ⇒ library default ⇒ Kling 2.5 turbo 10s.

## Open questions

- **`<OffthreadVideo>` vs `<Video>` for 1080p clips:** OffthreadVideo decodes in a worker which is gentler on Lambda renders but adds a ~1s preroll. Default to OffthreadVideo; revisit if we see render-time spikes.
- **Aspect-ratio mismatch:** Stills are 16:9. Some i2v models output non-standard sizes (Sora 2 i2v has `aspect_ratio: "landscape"` not `"16:9"`). The orchestrator's existing `supportedAspects` check will need a per-descriptor translation function.

## QA checklist (run before declaring done)

- [ ] Generate i2v clip on a row with a still image — clip plays in the Remotion preview at the correct shot time
- [ ] Generate i2v clip on a row WITHOUT a still — button is disabled with the hint visible
- [ ] Generate t2v clip on a B-Roll row with no still — works as today (no regression)
- [ ] Set a different model as default — refresh the page — picker still shows that default
- [ ] Delete a clip — Remotion preview returns to Ken Burns on the still
- [ ] Shot duration > clip duration — last frame freezes, no flash to black
- [ ] Shot duration < clip duration — clip plays from start until the shot ends, no overrun
- [ ] Cost spot check: one Kling 2.5 turbo 10s i2v generation in the Kie dashboard shows ≈ $0.42 deducted

## Security review

- API route `/api/user/preferences/broll-default` MUST be auth-gated via `apiRoute.authed`. Mutation only on the caller's own `collaborators.id`. No admin override path.
- New `stillImageUrl` param going to Kie must be either a Vercel Blob URL we issued OR an `https://` URL from a domain we trust. Reject `http:`, `file:`, `blob:`. The renderer already passes only Blob / R2 URLs so this is defense-in-depth.
- The Kie API key stays server-only; no change there.
- Cost ceiling enforcement: rate-limit /api/broll POST to existing per-workspace limits — the per-row cost ceiling is enforced at the UI by showing the price next to each model in the picker. No silent generation.
