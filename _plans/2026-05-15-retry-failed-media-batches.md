# Retry Failed Media Batches + Always-On Counters

**Date:** 2026-05-15
**Project:** youtubestudio-live → Production Doc
**Scope:** UI + state-only change in [src/app/(app)/production-doc/page.tsx](../src/app/(app)/production-doc/page.tsx). No new APIs, no schema changes, no library additions.

## Goal

Give the user one-click retry of every failed still-image generation, and one-click retry of every failed animation, plus an always-visible counter that shows how many of each have succeeded vs. failed for the current doc.

## Requirements (from the alignment pass)

1. Two separate buttons: one for failed **still images**, one for failed **video animations**. The user does not want one combined batch.
2. Animation retries use the user's **current default model** (mirroring how "Animate all" already works), not the model that was on the failed row.
3. Counters are visible at all times once a doc exists, even when nothing has failed — so the user can confirm "all green" at a glance.
4. Retries run sequentially, one row at a time (same cadence as "Animate all").

## Approach

### State derivations (memoised in the page component)

- `imageStats` — walk `rowImages`, count `status === 'done'` (succeeded) and `status === 'error'` (failed).
- `videoStats` — walk `rowVideoClips`, count `status === 'ready'` (succeeded) and `status === 'failed'` (failed).
- `failedImagePlan` — list of `{ rowIndex, prompt }` for rows where `rowImages[i].status === 'error'` AND `row.ai_image_prompt` is non-empty. Rows without a prompt are skipped (they were never AI-generated to begin with).
- `failedVideoPlan` — same shape as the existing `animateAllPlan`, but filtered to rows whose `rowVideoClips[i].status === 'failed'`. Inherits all existing eligibility gates from `animateAllPlan` (lock-as-still skip, model-kind/still pairing, min description length).

### Actions

- `runRetryFailedImages` — sequential loop over `failedImagePlan`, calling the existing `generateImageForRow(rowIndex, prompt)` per row. Tracks progress via a new `retryingImages` state. No confirm dialog (matches the per-row Retry button's behaviour).
- `runRetryFailedVideos` — near-identical clone of `runAnimateAll`: confirm-dialog with cost estimate, sequential `kickoffBrollGeneration` per failed row, push stubs into `rowBatchStubs`, mirror status into `rowVideoClips`. Tracks progress via a new `retryingVideos` state.

### UI

New compact bar inserted between the legend and the existing animate-scenes toolbar (only when `doc` is present). Two cells:

- **Left cell — Images**: `📷 Images: N✓ · M✗` plus a `↻ Retry M failed` button when M > 0. Button disabled mid-retry; spinner + `Retrying X/Y…` while running.
- **Right cell — Videos**: `🎬 Videos: A✓ · B✗` plus a `↻ Retry B failed` button when B > 0 AND `animateScenes === true`. Same disabled / spinner pattern.

Counters are always visible (the user explicitly asked for that), regardless of whether anything has failed.

## Edge cases walked through

- Retry-images while initial `generateImages` batch is still running → blocked by `retryingImages` guard.
- Retry-videos when `animatingAll` is running → blocked by reusing the same guard (no concurrent batches).
- Failed video on a row whose still also failed → skipped by the i2v-needs-still gate (same as `animateAllPlan`); the user is expected to retry images first, then videos.
- Locked-as-still row that had a previous failed video → skipped (consistent with `animateAllPlan`).
- Row whose description is too short → skipped (consistent with `animateAllPlan`).
- Doc regenerate → all state resets to `[]` / `{}`; counters and plans go to zero. No stale UI.
- After retry succeeds for some rows and fails for others → counters update live as each row resolves (image: instant; video: when the BrollCell's poll flips status).

## Rejected alternatives

- **One combined retry button.** User explicitly asked for two separate buttons. Rejected.
- **Retry using the row's original failed model.** User explicitly chose "current default model". Rejected.
- **Show only when failures exist.** User wants always-visible counters. Rejected.

## Security / safety

No new attack surface — buttons hit existing authed routes (`/api/generate/production-doc/image`, `/api/broll`) that the per-row Retry button already invokes. Cost confirmation is preserved on the video batch.

## Out of scope

- Workspace-wide retry (this only operates on the current doc's rows).
- Retry-with-different-model UI (user picked "current default model").
- Toasts on every individual row finish (would spam — only one summary toast at end).
