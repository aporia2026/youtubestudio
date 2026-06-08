# Shorts: Bulk Generation + YouTube Upload

**Status**: Approved (Option B), execution starting 2026-06-08
**Owner**: yoavm7-code
**Approach**: Option B — Full bulk workflow with dedicated batch page (stepper), first-class `shorts_batches` table, purpose-built review queue, quota-aware uploader.

## Goal

Let the user pick a bulk of shorts ideas, generate them all in one go (voiceover + SEO + render auto-applied), preview every output, then upload each to a YouTube channel — optionally scheduled — with full YouTube metadata controls (title, description, tags, language, playlist, category, made-for-kids, privacy).

## Why this matters

Today the user can only create shorts one at a time. Going from "I have 10 ideas" to "10 shorts published" takes 10 trips through the editor, 10 voice picks, 10 manual SEO edits, and there is no YouTube upload at all — they have to download each rendered file and upload through YouTube Studio. This compounds quickly. The bulk flow collapses the whole pipeline into one screen and makes scheduled batch publishing a first-class workflow.

## Constraints (verified)

- **YouTube upload quota**: Per the [Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost) verified 2026-06-08, `videos.insert` costs **~100 units** per call (Google dropped this from ~1,600 on 2025-12-04). Default daily quota is 10,000 units → **~100 uploads/day per Google Cloud project**. For 5–10 batch sizes, quota is effectively a non-issue. The UI still surfaces a "remaining quota today" meter for visibility but won't gate normal batches.
- **Batch size target**: 5–10 shorts per batch (confirmed). Architecture supports more but UX is tuned for this range.
- **OAuth already wired**: `src/lib/google-oauth.ts:10` already requests `youtube.upload` scope. Encrypted token storage in `oauth_tokens` table per `channel_id`. Refresh handled. `src/lib/youtube-publish.ts` already does `videos.update` (snippet + thumbnail). We add `videos.insert` (resumable upload) + `playlistItems.insert`.
- **YouTube field hard limits**: title ≤ 100 chars, description ≤ 5000 chars, tags combined ≤ 500 chars (including comma separators per YouTube's accounting), category required, `status.selfDeclaredMadeForKids` (COPPA) required.
- **Read-only API gaps** (verified 2026-06-08 against the official Data API v3 video resource docs): `contentDetails.contentRating.ytRating='ytAgeRestricted'` and `paidProductPlacementDetails.hasPaidProductPlacement` are present on the resource but are NOT writable via `videos.insert` or `videos.update` — they can only be set in YouTube Studio. The UI surfaces both toggles per short; for any short with either flag set, the post-upload state shows a "Finish in Studio" deep link to `https://studio.youtube.com/video/{videoId}/edit` and tracks whether the user has completed it.
- **Time / scheduling**: YouTube stores `publishAt` as UTC ISO 8601. User-facing picker must use IANA timezones. Default timezone = browser-detected (`Intl.DateTimeFormat().resolvedOptions().timeZone`), overridable in settings + per-batch.
- **Vercel function budget**: ≤ 300s per invocation. Bulk generation runs via tick cron, not a single long request.
- **Channel scoping**: shorts are scoped by `workspace_id` + optional `project_id`. Upload tokens are keyed by `channel_id`. We resolve the upload target via `user_settings.active_channel_id` (the channel the user has selected in the top-bar switcher), with an optional batch-level override.

## Cost (10-short batch, rough; verify live before production use)

- ElevenLabs voiceover (multilingual-v2, ~15s each): ~$0.10–0.30 × 10 ≈ **$1–3**
- LLM SEO (one call per short, Sonnet 4.6): ~$0.02 × 10 ≈ **$0.20**
- Image gen + render: already in your normal per-short cost; not net-new
- YouTube upload: **$0** but quota-limited as above
- **Marginal batch cost: ~$2–5 on top of existing per-short cost**

## Requirements

### User-facing

1. Multi-select on the shorts ideas surface (existing inbox + create flow).
2. New page `/shorts/batch` with stepper:
   1. Pick ideas (preserves existing inbox cards, adds checkboxes + counter)
   2. Batch setup form (voice, language, default playlist, category, tags pool, description template with `{{title}}` / `{{hook}}` / `{{payoff}}` placeholders, default privacy, default schedule cadence, made-for-kids default)
   3. Generation progress (per-short rows with stage badges, errors, retry)
   4. Review queue (card grid: video preview, editable metadata, per-card schedule picker)
   5. Schedule + upload (single "Upload all approved" action, sequential drain, live progress)
3. Each card in the review queue has all YouTube metadata exposed (title, description, tags as tokens, category, language, playlist multi-select, privacy, made-for-kids toggle, age-restricted (18+) toggle, paid-promotion disclosure toggle, AI-content-disclosure toggle, publish-at picker with timezone selector). Made-for-kids, paid-promotion, and AI-content-disclosure are mandatory YouTube fields and ship with batch-level defaults that cascade from `UserSettings`.
4. SEO-generated title / description / tags pre-fill every card. User can accept, regenerate, or hand-edit.
5. Schedule picker: date + time + IANA timezone dropdown (defaulted to browser detect).
6. Quota meter: shows remaining YouTube quota for the day and warns when the planned upload set would exceed it.

### System-facing

7. `shorts_batches` table tracks the cohort (batch_id, idea source, defaults, status counts, created_by).
8. New batch orchestrator runs generation stages per short with concurrency cap (3 parallel) and tick budget control.
9. New uploader handles resumable upload (`uploadType=resumable`), playlist insert, schedule semantics (`privacyStatus=private` + `publishAt` for scheduled, `public/private/unlisted` immediate for unscheduled).
10. Quota awareness: track `videos.insert` calls per day per channel; surface in UI; refuse to start an upload that would breach the day's budget unless user confirms partial.

## Chosen approach (Option B detail)

### Data model

**Migration `0122_create_shorts_batches.ts`** (new):

```sql
CREATE TABLE shorts_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  created_by UUID REFERENCES collaborators(id) ON DELETE SET NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'setup',  -- setup|generating|review|uploading|done|failed
  defaults JSONB NOT NULL DEFAULT '{}'::jsonb, -- voice, language, category, playlistIds, tagsPool, descriptionTemplate, privacy, scheduleCadence, madeForKids, timezone
  totals JSONB NOT NULL DEFAULT '{}'::jsonb, -- {planned, generated, failed, uploaded, scheduled}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shorts_batches_workspace ON shorts_batches(workspace_id, created_at DESC);
```

**Migration `0123_add_youtube_columns_to_shorts.ts`** (new):

```sql
ALTER TABLE shorts
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES shorts_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS youtube_video_id TEXT,
  ADD COLUMN IF NOT EXISTS youtube_status TEXT, -- pending|uploading|uploaded|scheduled|published|failed
  ADD COLUMN IF NOT EXISTS youtube_publish_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS youtube_metadata JSONB DEFAULT '{}'::jsonb, -- title, description, tags[], categoryId, language, playlistIds[], privacy, madeForKids
  ADD COLUMN IF NOT EXISTS youtube_uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS youtube_upload_error TEXT;

CREATE INDEX idx_shorts_batch ON shorts(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_shorts_youtube_status ON shorts(youtube_status) WHERE youtube_status IS NOT NULL;
```

**`UserSettings` extensions** in `src/lib/user-settings.ts`:

- `default_voice_preset_id?: string | null`
- `default_youtube_category_id?: string | null`
- `default_youtube_language?: string | null`
- `default_youtube_made_for_kids?: boolean | null`
- `default_timezone?: string | null` (IANA; null → browser detect)
- `default_batch_description_template?: string | null`

### TypeScript types

New file `src/lib/shorts-batches-types.ts` for `ShortsBatchRow`, `ShortsBatchDefaults`, `YoutubeUploadMetadata`, `YoutubeBatchStatus`. Mirrors the existing `shorts-types.ts` style.

### Libraries

- **`src/lib/youtube-upload.ts`** (new): resumable `videos.insert` per the YouTube Data API v3 protocol. Three-step: init session (POST returns `Location` header), PUT video bytes in one shot for our file size (renders top out under 100 MB so streaming chunks isn't needed), parse JSON response. Handles `publishAt` semantics: if scheduling, force `privacyStatus=private` at insert. Returns `{ videoId, status, publishAt? }`.
- **`src/lib/youtube-playlists.ts`** (new): `listPlaylists(accessToken, channelId)` for the dropdown, `addVideoToPlaylists(accessToken, videoId, playlistIds[])` for after-upload attachment.
- **`src/lib/youtube-categories.ts`** (new): static list of YouTube video categories with their numeric IDs (no API call needed; the list is stable — sourced from `videoCategories.list` with regionCode=US, baked in). Includes the canonical short-form categories.
- **`src/lib/youtube-quota.ts`** (new): track `videos.insert` calls per channel per UTC day in a new lightweight `youtube_quota_usage` table (added in the same migration as `youtube_columns`). Functions: `getRemainingUploadQuota(channelId)`, `recordUploadCharge(channelId, units)`. Conservative — only counts our own charges; quota seen by user may differ if other systems are also using the project.
- **`src/lib/shorts-batches.ts`** (new): CRUD + state machine for batches. `createBatch()`, `getBatch()`, `listBatchShorts()`, `updateBatchTotals()`, `claimNextBatchTick()`.

### Orchestrator

**`src/lib/shorts-batch-orchestrator.ts`** (new): tick-based, mirrors `auto-pipeline/orchestrator.ts` pattern. Stages per short, run in order:

1. `extract_from_idea` — calls existing `extractShortFromIdea` (already in `src/lib/shorts.ts`).
2. `generate_voiceover` — calls existing `generateShortVoiceover` with batch's default voice.
3. `generate_seo` — calls existing shorts SEO generator, persists `seo_result`, then maps top-graded title/description/tags into `youtube_metadata` as the editable seed.
4. `generate_assets` — defers to existing asset-tick cron (`run-asset-tick`); orchestrator polls `generation_progress`.
5. `render` — defers to existing render path; orchestrator polls `rendered_video_url`.
6. `ready_for_review` — marks short ready; batch advances when all shorts hit this or `failed`.

Concurrency cap of 3 parallel shorts per tick (claim-many pattern with `FOR UPDATE SKIP LOCKED`). Each stage logs `[shorts-batch <stage>]` with the short_id, batch_id, duration, and outcome.

**`src/lib/shorts-batch-uploader.ts`** (new): drains the "approved + queued for upload" set from a batch. Per short:

1. Verify channel OAuth token (`getValidAccessToken(channelId)`).
2. Check daily upload quota; refuse if it would breach.
3. Download rendered video from R2 to a temp Buffer (renders are < 100 MB).
4. Call `youtube-upload.ts` with metadata + (privacyStatus, publishAt).
5. Call `youtube-playlists.ts` to attach to selected playlists.
6. Record quota charge. Persist `youtube_video_id`, `youtube_status`, `youtube_uploaded_at`.
7. On failure, persist `youtube_upload_error`, leave the short re-uploadable.

### API routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/shorts/batches` | POST | Create batch from selected idea_ids + defaults |
| `/api/shorts/batches/[id]` | GET | Batch + child shorts + totals |
| `/api/shorts/batches/[id]` | PATCH | Update defaults (only while status=setup) |
| `/api/shorts/batches/[id]/run-tick` | POST | Drain one tick of generation (called by client poll OR cron) |
| `/api/shorts/batches/[id]/upload-all` | POST | Kick off uploader for all approved shorts |
| `/api/shorts/[id]/youtube-metadata` | PATCH | Update per-short metadata (title, description, tags, etc.) |
| `/api/shorts/[id]/youtube-upload` | POST | Upload a single short (manual one-off) |
| `/api/youtube/channel/[channelId]/playlists` | GET | List playlists for the dropdown |
| `/api/youtube/channel/[channelId]/quota` | GET | Remaining upload quota for today |

All routes resolve `workspaceId` from session, scope all reads, and require the user to have access to the channel (via existing `channels.workspace_id` check).

### UI

- New page `src/app/(app)/shorts/batch/page.tsx` with stepper component.
- New components in `src/components/shorts/batch/`:
  - `BatchStepper.tsx` — top progress nav
  - `Step1IdeaPicker.tsx` — checkbox-augmented idea grid (reuses idea card)
  - `Step2BatchSetup.tsx` — form with voice picker, language, category, playlist multi-select, description template editor with placeholder hints, tag pool, default privacy, schedule cadence picker
  - `Step3GenerationProgress.tsx` — per-short stage rows with retry; polls `/run-tick` every 2s
  - `Step4ReviewQueue.tsx` — card grid; each card uses `BatchShortReviewCard.tsx`
  - `BatchShortReviewCard.tsx` — video preview, collapsible metadata editor, schedule picker, approve button
  - `Step5ScheduleUpload.tsx` — summary view, quota meter, "Upload all approved" button, live upload progress
  - `TimezoneSelect.tsx` — IANA timezone dropdown (reused across batch + settings)
  - `TagTokenInput.tsx` — tag chips with char-count guard against the 500-char combined limit
  - `PlaylistMultiSelect.tsx` — fetches `/api/youtube/channel/[channelId]/playlists`
- Multi-select toolbar on existing `src/app/(app)/shorts/page.tsx` — checkboxes appear in select-mode; "Start batch with selected" routes to `/shorts/batch?ideaIds=...`.

### Settings audit (rule 15)

New settings surface in the existing settings panel under a new "Shorts batch defaults" section:

- Default voice preset (dropdown from existing voice presets)
- Default YouTube category (dropdown)
- Default YouTube language (ISO 639-1 dropdown)
- Default made-for-kids (Yes / No / Ask each batch)
- Default age-restricted 18+ (default Off)
- Default paid-promotion disclosure (default Off)
- Default AI-content disclosure (default On — this pipeline generates with AI; user can flip per-short)
- Default timezone (IANA, with "Browser auto" sentinel)
- Default description template (textarea with placeholder hints)

All settings cascade as the prefill for new batches; per-batch overrides are first-class in step 2.

### Security (rule 13)

- `videos.insert` uses the existing encrypted-at-rest token store (`oauth_tokens.access_token_encrypted`).
- All routes scope by `workspace_id` derived from session — never trust client-supplied `workspaceId`.
- Channel-level permission: every YouTube call resolves `channel_id` → `getValidAccessToken(channelId)` → if the channel's workspace_id does not match the session's, return 403.
- `madeForKids` mandatory in the form (no silent default) to comply with COPPA — YouTube will reject without it.
- Tag input validates combined length ≤ 500 chars server-side too (defense in depth — client guard is for UX only).
- No PII or token material in logs. Log only IDs.
- Resumable upload session URL is one-shot and is never logged.

### Observability (rule 14)

Log namespaces (all `console.info` with `[namespace step]` prefix and a structured second arg):

- `[shorts-batch create]` — batch_id, workspace_id, idea_count, channel_id
- `[shorts-batch claim-tick]` — batch_id, claimed_short_ids, concurrency
- `[shorts-batch stage extract]`, `[stage voiceover]`, `[stage seo]`, `[stage assets]`, `[stage render]`, `[stage ready]` — short_id, duration_ms, outcome
- `[shorts-batch stage error]` — short_id, stage, error message (sanitized)
- `[shorts-upload start]`, `[shorts-upload chunk]`, `[shorts-upload complete]`, `[shorts-upload error]` — short_id, channel_id, video_id (post-upload), bytes, duration_ms
- `[shorts-upload playlist-add]` — video_id, playlist_ids, results
- `[shorts-upload quota]` — channel_id, day, units_charged, remaining
- `[shorts-upload publish-at]` — video_id, publish_at_utc, source_tz

### Testing (rule 18)

Unit tests in `tests/`:

- `tests/shorts-batches.test.ts` — create batch, state transitions (setup → generating → review → uploading → done), totals math, defaults validation.
- `tests/youtube-upload.test.ts` — resumable session init, body assembly, scheduling semantics (publishAt forces private), tag combined length validation, title/description length guards.
- `tests/youtube-playlists.test.ts` — playlist list parsing, multi-playlist add success + partial failure handling.
- `tests/youtube-quota.test.ts` — daily window math, charge accumulation across UTC day rollover.
- `tests/timezone-conversion.test.ts` — IANA TZ + local time → UTC ISO 8601, DST edge cases (spring-forward, fall-back), invalid timezone fallback.
- `tests/tag-token-validation.test.ts` — combined length accounting, duplicate prevention, casing.
- `tests/batch-defaults-merge.test.ts` — defaults → per-short metadata seeding, SEO output mapping.
- Bug-fix tests: any issue surfaced in QA gets a regression test before fix lands.

End-to-end / integration: deferred to a smoke run with a real test channel before declaring the feature done.

### Rejected alternatives (with reasons)

- **Option A — Lean MVP**: Smaller build, but the bulk flow ends up bolted onto the existing per-short editor. Worse first-time UX for the explicit batch workflow the user asked for. Wins only on "ship the soonest" tradeoff; we're not in that mode.
- **Option C — Reuse the long-form auto-pipeline orchestrator**: Cleanest architecturally long-term but requires refactoring the long-form orchestrator first (different state shape: flat columns vs JSONB progress). Risk to long-form pipeline outweighs the maintenance win for now. Revisit once shorts batch ships and stabilizes.

### Out of scope (deferred)

- Multi-channel upload from one batch (one batch → one channel for now).
- Per-short thumbnail picker (uses the rendered first frame; thumbnail UI is its own feature).
- Captions / subtitles upload alongside the video (YouTube auto-captions for now; manual `.srt` upload is a follow-up).
- Re-upload / replace flow.
- Bulk SEO re-grading after manual edits.
- Quota auto-spread across multiple days (the scheduler lets the user do this manually; auto-spread is v2).
- Localized titles / descriptions (`localizations` API).
- A/B title test creation from batch (would integrate with existing A/B feature).

## Open questions

- **Timezone default**: going with browser-detect via `Intl.DateTimeFormat().resolvedOptions().timeZone` and an override in settings. Confirm if you want a different default.
- **Multi-channel handling**: assuming one workspace = one active channel for now (`user_settings.active_channel_id`). If you upload to multiple channels regularly, we add a channel picker to step 2.
- **Made-for-kids default**: defaulting to **No** for typical content creators. If your channel is kid-targeted, change the default in settings.

## Execution phases

1. **Migrations + types** — `shorts_batches` table, new `shorts` columns, `youtube_quota_usage` table, TS types.
2. **YouTube libs** — `youtube-upload.ts` (resumable insert), `youtube-playlists.ts`, `youtube-categories.ts`, `youtube-quota.ts` + their unit tests.
3. **Batch domain** — `shorts-batches.ts` CRUD + state, `shorts-batch-orchestrator.ts`, `shorts-batch-uploader.ts` + tests.
4. **API routes** — batch CRUD, run-tick, upload-all, single-upload, metadata patch, playlists list, quota.
5. **UI step 1** — multi-select on shorts page + idea picker step.
6. **UI step 2** — batch setup form.
7. **UI step 3** — generation progress.
8. **UI step 4** — review queue with metadata editor.
9. **UI step 5** — schedule + upload + quota meter.
10. **Settings** — new defaults section in user settings UI.
11. **Observability sweep** — verify all log namespaces fire correctly.
12. **Extreme QA pass** — golden path + edge cases + adjacent regressions.
13. **Smoke run on a real test channel** before declaring done.
