# GPT Image 2 Edit — configurable Atlas/Kie primary with automatic fallback

**Date:** 2026-05-29
**Owner:** info@flexelent.com (yoavm7-code)
**Trigger:** Atlas Cloud account hit `402 insufficient balance` mid-session, surfacing the cost-vs-resilience tradeoff of hardcoding a single vendor for all five GPT Image 2 Edit flows.

---

## 1. Goal

Replace the hardcoded `generateAtlasEdit` + `optionId: 'gpt-image-2-atlas-edit'` calls with a single helper that:

1. Reads a user-controlled setting picking **Atlas** or **Kie** as the primary vendor for the GPT Image 2 edit operation.
2. On failure of the primary, automatically falls back to the other vendor.
3. Logs loudly when fallback fires so cost surprises are visible (rule 14).
4. Applies uniformly to all five Atlas-Edit consumers — editor variant button + four auto-pipeline flows.

**Net behaviour the user sees today:** when Atlas balance empties, variants and pipeline edits keep working (on Kie) instead of erroring out. The picker in editor settings shows which path is currently primary.

## 2. Constraints

- Kie has **no `gpt-image-2-edit` endpoint** — verified against docs.kie.ai on 2026-05-29. The closest functional equivalent is `gpt-image-2-image-to-image` (accepts `input_urls: [sourceUrl] + prompt + aspect_ratio + resolution`). We map "edit" → Kie i2i for this plan.
- Atlas Edit returns 1536×1024 (3:2) and the existing pipeline crops to 16:9 downstream. Kie i2i can request 16:9 directly. The new helper must absorb the per-vendor crop divergence so callers stay simple.
- The auto-pipeline runs server-side (cron-driven). It cannot read browser `localStorage`. The setting must be readable from a server context.
- This setting is per-user, not per-workspace (one user's cost preference, not a team policy).

## 3. Requirements

- The setting persists across machines (per the existing `user_settings` pattern; rule 7 of CLAUDE.md plus the project's Phase 3.1 cross-machine sync).
- The setting is reachable from the editor settings panel; default is **Atlas primary → Kie fallback** (current cost-optimal behaviour).
- Fallback never silently masks repeated primary failures — every fallback is logged at `info`, and consecutive fallbacks within one project run emit a `warn` so a sustained Atlas outage shows up in the console (rule 14).
- Cost accounting (`markDelivered` `costUsd`) reflects the vendor that actually delivered, not the configured primary.
- Test coverage: unit tests for the dispatcher's primary/fallback branching, plus an integration test for the variant pipeline path against mocked vendor calls.

## 4. Five flows to migrate

All currently route through `generateAtlasEdit` directly:

| # | Flow                              | Call site                                                                                                    |
|---|-----------------------------------|--------------------------------------------------------------------------------------------------------------|
| 1 | Editor variant button             | `POST /api/generate/production-doc/image/edit` → `atlas` branch (`route.ts:288`)                             |
| 2 | Variant pipeline (auto)           | `auto-pipeline/production-doc-image-gen.ts:404` (variant generation)                                         |
| 3 | Character continuity              | `auto-pipeline/production-doc-image-gen.ts:667` (character_cache continuation)                               |
| 4 | Scene continuity                  | `auto-pipeline/production-doc-image-gen.ts:794` (scene_cache continuation)                                   |
| 5 | Mouth-removal pre-pass            | `auto-pipeline/production-doc-image-gen.ts:520` (`generateMouthRemovedForCharacter` via `atlas-mouth-removal`) |

**Note (collage is out of scope):** the collage path uses `generateAtlasT2I` (text-to-image), not `generateAtlasEdit`. Its mis-labelled `[atlas-edit-failed pipeline collage]` log line is a separate cleanup. Migrating the T2I path to a Kie equivalent is a different decision (different model surface, different prompt composer, different cost profile) — track it separately if Atlas T2I balance becomes a recurring problem.

## 5. Design

### 5.1 Setting

Single new key, two values: `'atlas-primary'` | `'kie-primary'`. Default `'atlas-primary'`.

- Persisted server-side in `user_settings.encrypted_settings.gpt_image_2_edit_primary` (`UserSettings` interface in `src/lib/user-settings.ts`).
- Mirrored to `localStorage` under `editor.imageEdit.gptImage2Primary` so the editor reads it without an async fetch (sync via the existing Phase 3.1 `mutate()` outbox).
- Settings panel surface: new picker in `EditorPrefsPanel` titled **"GPT Image 2 edit provider"** with one dropdown, two options. Recommended copy:
  - "Atlas (cheaper, ~$0.011/edit) → Kie fallback"
  - "Kie (~$0.05/edit) → Atlas fallback"

### 5.2 Dispatcher helper

New module `src/lib/gpt-image-2-edit.ts`:

```ts
export interface Gpt2EditOpts {
  prompt: string;
  /** Single source image URL for the edit. (Atlas Edit + Kie i2i both
   *  accept multi-input arrays, but every current caller passes exactly
   *  one image. Multi-input support is a follow-up if/when a caller
   *  needs it.) */
  sourceImageUrl: string;
  /** Primary vendor from user setting. */
  primary: 'atlas' | 'kie';
}

export interface Gpt2EditResult {
  url: string;
  /** 'atlas' or 'kie' — which vendor actually served the call. May
   *  differ from `opts.primary` when fallback fired. */
  vendorUsed: 'atlas' | 'kie';
  fallbackUsed: boolean;
  costUsd: number;
  durationMs: number;
  providerRequestId: string | null;
}

export async function generateGptImage2Edit(opts: Gpt2EditOpts): Promise<Gpt2EditResult>;
```

The helper:

1. Tries the primary. Per-vendor branches handle the size/crop divergence:
   - Atlas → `generateAtlasEdit({ size: '1536x1024', quality: 'low' })` + center-crop to 16:9.
   - Kie → `createKieTask('gpt-image-2-image-to-image', { prompt, input_urls: [src], aspect_ratio: '16:9', resolution: '1K' })` + `pollKieResult` (no extra crop; Kie returns 16:9 directly).
2. On primary failure, logs `[gpt2-edit fallback] primary={primary} reason={msg}` at `warn` and tries the other vendor.
3. On both failing, throws with both error messages preserved.
4. Returns `{ vendorUsed, fallbackUsed, costUsd, ... }` so callers can attribute cost correctly.

### 5.3 Wiring the five callers

- **Edit route** (`/api/generate/production-doc/image/edit`): the `atlas` case in the switch becomes a call into `generateGptImage2Edit` with `primary` read from the requester's `user_settings`. The route still accepts `optionId: 'gpt-image-2-atlas-edit'` from the client (so existing clients don't break), but treats it as "use the GPT Image 2 edit family" regardless of which vendor the setting picks. We deprecate the literal `'atlas'` in the option id later by adding a `'gpt-image-2-edit'` option that supersedes `'gpt-image-2-atlas-edit'`, leaving the latter as an alias.
- **Pipeline variant generation**: replaces `generateAtlasEdit(...)` + crop with `generateGptImage2Edit(...)`. Caller's existing upscale + R2 mirror chain runs against the returned URL unchanged.
- **Character continuity / scene continuity**: same pattern.
- **Mouth-removal**: `atlas-mouth-removal.ts` becomes `gpt-image-2-mouth-removal.ts` (or stays at the same path with a renamed internal call) using the new helper. The mouth-removal prompt is unchanged.
- **Collage cells**: same pattern.

### 5.4 Cost telemetry

`markDelivered` already takes `costUsd`. The dispatcher returns the real cost based on which vendor served:

- Atlas: `0.011` (existing constant).
- Kie i2i: `0.05` (per `image-models-i2i.ts:151`).

This means a single fallback edit silently costs 4.5× the expected amount. The dispatcher emits a `warn` so it's visible, but the user only sees the aggregated billing impact in the cost dashboard. Acceptable trade-off given the alternative is the whole project failing.

## 6. Alternatives considered

### A. Toggle, no fallback (single picker, no auto-recovery)

Simplest. User picks one vendor; the other never runs. **Rejected** because it's exactly the brittle state we're escaping — when the picked vendor's balance empties or its API has an outage, every flow fails.

### B. Two independent pickers (primary + fallback, each can be Atlas/Kie/None)

Most explicit. Allows "Kie only, no fallback" for strict cost control. **Rejected** because (a) the user picked the single-dropdown option in the prior alignment turn, (b) the matrix has only four meaningful combinations (Atlas-only, Kie-only, A→K, K→A) and a two-dropdown UI is overkill for that, (c) lazy-user bar (rule 10) — one dropdown with two values reads instantly.

### C. Per-flow override (different primary for variants vs character_cache, etc.)

Most flexible. **Rejected** as premature. No evidence anyone wants the mouth-removal flow to use a different vendor than the variant flow. We can add per-flow overrides later if the need surfaces; the dispatcher already takes `primary` as a parameter so per-call overrides are a one-line change.

### D. Top up Atlas instead of building anything (do nothing)

Cheapest in dev time, no code change. **Recommended as a parallel action** — the user should top up Atlas independently of this plan because (a) Atlas remains the cheaper provider even after this work lands, (b) this plan doesn't change the default, so an empty Atlas balance still triggers the fallback path on every call until the balance is refilled. The plan addresses *resilience and choice*; the immediate cost-of-empty-balance problem is solved by funding the account.

---

**Chosen path: design 5 with alternative A's setting shape but A's fallback turned on by default.** Single dropdown, two values, fallback always firing on primary failure, with a clear `warn` log when it fires so the user sees the cost shift.

## 7. Implementation order

1. **`src/lib/gpt-image-2-edit.ts`** — new dispatcher helper. Pure function; takes `primary`, returns `{ vendorUsed, fallbackUsed, costUsd, ... }`. Unit-tested against mocked vendor functions.
2. **`src/lib/user-settings.ts`** — extend `UserSettings` interface with `gpt_image_2_edit_primary?: 'atlas' | 'kie' | null`. Update `parseUserSettings` to accept it. Default behaviour when absent: `'atlas'` (no breaking change).
3. **`src/lib/editor/settings.ts`** — add `getGptImage2EditPrimary()` / `setGptImage2EditPrimary()` for the editor's localStorage mirror. Sync via the Phase 3.1 mutate() pattern so the server-side row stays current.
4. **`src/app/api/generate/production-doc/image/edit/route.ts`** — replace the `atlas` switch case with a call to `generateGptImage2Edit`, reading `primary` from the session's `user_settings`. Keep `optionId: 'gpt-image-2-atlas-edit'` accepted for back-compat; add a new `'gpt-image-2-edit'` option id as the canonical alias.
5. **`src/lib/image-edit-pricing.ts`** — add a `'gpt-image-2-edit'` option whose backend kind is `{ kind: 'gpt-image-2-edit' }` (new variant). Mark `'gpt-image-2-atlas-edit'` as deprecated alias in a comment.
6. **`src/lib/auto-pipeline/production-doc-image-gen.ts`** — replace each `generateAtlasEdit(...)` call with `generateGptImage2Edit(...)`. The pipeline needs to know the owner's primary preference; thread it through from the stage-handler context that already loads the owner's `user_settings`. (If no such load exists yet for image gen, this PR adds the read; cost is one row from `user_settings` per pipeline tick, negligible.)
7. **`src/lib/atlas-mouth-removal.ts`** — same migration. Mouth-removal-specific prompt unchanged.
8. **`src/components/settings/EditorPrefsPanel.tsx`** — add the dropdown. Two options, default selected per stored setting, save through `mutate()`.
9. **`src/components/production-doc/editor/VariantPanel.tsx`** — update the helper text at line 547 ("Atlas GPT Image 2 Edit composes this...") to no longer say "Atlas" — it's now "GPT Image 2 Edit" generically, with the active vendor shown in the inline cost preview.
10. **Tests**: `tests/gpt-image-2-edit-dispatch.test.ts` covering primary success, primary failure → fallback success, both fail, and the cost-attribution paths. Update `tests/chained-variants-dispatch.test.ts` to assert the dispatcher is invoked instead of `generateAtlasEdit` directly.

## 8. Security (rule 13)

- The new setting only stores a non-secret enum (`'atlas' | 'kie'`). No new attack surface in `user_settings`.
- Both vendor calls already SSRF-check the source URL via `checkSafePublicUrl` at the edit route. The new helper inherits that — it only accepts a URL parameter; it does not re-fetch arbitrary URLs.
- API keys (`ATLAS_CLOUD_API_KEY`, `KIE_API_KEY`) stay server-side, read inside `generateAtlasEdit` / `createKieTask`. The dispatcher never sees them.
- Failure messages from each vendor are passed through to logs but truncated to 200 chars (existing pattern in the pipeline error logs) to avoid leaking signed-URL query strings.
- Rate-limit unchanged at the route layer (20/min/IP). The dispatcher's fallback does NOT consume a second rate-limit slot — same outer request, two backend attempts.

## 9. Observability (rule 14)

New log lines (all server-side via `logger.info` / `logger.warn`):

- `[gpt2-edit dispatch] start { primary, sourceUrlPreview, promptChars }`
- `[gpt2-edit dispatch] primary-ok { primary, durationMs, costUsd }`
- `[gpt2-edit fallback] primary-failed { primary, reason }` (warn)
- `[gpt2-edit fallback] fallback-ok { fallback, durationMs, costUsd }`
- `[gpt2-edit dispatch] both-failed { primaryReason, fallbackReason }` (error)

The existing `[atlas-edit-failed pipeline ...]` error logs in `production-doc-image-gen.ts` get renamed to `[gpt2-edit-failed pipeline ...]` so they no longer mis-attribute the failure to Atlas when the actual failure was Kie. The label stays grep-able for the existing dashboards.

Cost telemetry: every `markDelivered` call passes the actual `costUsd` returned by the dispatcher (`0.011` or `0.05`), not a hard-coded value. The `provider_generations` row's `provider` column reflects `vendorUsed` so the cost dashboard groups invoices by the vendor that actually served, not the configured primary.

## 10. Settings audit (rule 15)

New control: **GPT Image 2 edit provider**.

- Location: `EditorPrefsPanel`, in an existing "Image generation" group if one exists; otherwise a new "Image generation" group placed alongside the existing "Image edit prices" toggle. Both belong together.
- Default: `'atlas-primary'` (no behaviour change for existing users).
- Label: "GPT Image 2 edit provider"
- Options:
  - "Atlas (cheaper, ~$0.011/edit) — falls back to Kie if Atlas fails"
  - "Kie (~$0.05/edit) — falls back to Atlas if Kie fails"
- Help text under the dropdown: "Affects all GPT Image 2 edits — variants, character continuity, scene continuity, mouth removal, collage cells. Fallback is automatic."

No other controls exposed in this PR. Per-flow overrides, hard-disable fallback, and a hard cost cap are listed as follow-ups below.

## 11. Cost impact (rule 8)

| Scenario                                | Cost / edit | Δ vs Atlas |
|----------------------------------------|-------------|------------|
| Atlas primary, Atlas succeeds          | $0.011      | baseline   |
| Atlas primary, Atlas fails → Kie       | $0.05       | +$0.039    |
| Kie primary, Kie succeeds              | $0.05       | +$0.039    |
| Kie primary, Kie fails → Atlas         | $0.011      | baseline   |

A typical 12-shot project with 2 variants each (24 edits) plus a chained character_cache pass (~10 edits) costs:

- All-Atlas:  34 × $0.011 = **$0.37**
- All-Kie:    34 × $0.05  = **$1.70**
- Atlas with fallback firing on 10% of calls: ~$0.51 (+$0.14)

Verified Atlas pricing 2026-05-25; Kie pricing inferred from `image-models-i2i.ts:151` annotation. Per rule 8, before merging this plan I should confirm Kie's current `gpt-image-2-image-to-image` price against the live Kie pricing dashboard (their docs page omitted the number).

## 12. Risks and open questions

- **Kie's actual `gpt-image-2-image-to-image` price not on the public docs page.** Need to verify before merge — if it's significantly higher than the $0.05 estimate, the fallback path costs more than this plan budgets. Mitigation: a hard cost cap (a future setting) lets the user disable the fallback when Kie's price moves.
- **Atlas-only behavioural assumptions.** The variant prompt composer (`composeVariantEditRequest`) is tuned around Atlas Edit's identity-preservation. Kie's i2i may handle the same prompt differently. We may need a Kie-specific prompt suffix. Mitigation: implementation step 1's dispatcher tests use real vendor calls on a smoke test branch (mirror of `scripts/smoke-atlas-edit-character-continuity.ts`) before the PR ships.
- **Settings load cost in the pipeline.** Each pipeline tick already does a workspace settings load; adding the user settings read is one more row. If the workload becomes large, cache it.
- **Per-row override.** A power user might want one specific variant to force Kie. Out of scope for this PR; the helper signature already supports a per-call `primary` override so the UI follow-up is small.

## 13. Follow-ups (not in this PR)

- **Thread `ownerId` from stage handlers into the four pipeline call sites.** Today the pipeline path passes `ownerId: null` for `generateVariantImage` / `generateMouthRemovedForCharacter` / etc. — so `getUserSettings('')` returns defaults and the pipeline always picks Atlas as primary. The dispatcher's automatic fallback to Kie still fires when Atlas fails, so resilience is intact, but the user's "make Kie primary" preference does NOT propagate to the auto-pipeline. Wiring this requires reading `pipeline_runs.created_by` (or `pipeline_run_videos.created_by` if added) and threading it through `runOneVideo` → stage handlers → image-gen helpers. Tracked separately because it touches many stage handlers; this PR's blast radius stays in the image-gen helpers + editor route.
- Per-flow override (mouth-removal stays on Atlas even when variants are on Kie).
- Hard cost cap that disables the fallback once a monthly spend threshold is hit.
- Verify Kie's `gpt-image-2-image-to-image` price against the live pricing dashboard and update the `costUsdPerImage` annotation in `image-models-i2i.ts`.
- Add a "current primary" badge to the variant button so the user sees which vendor will run before clicking.
