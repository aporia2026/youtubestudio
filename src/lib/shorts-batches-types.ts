/**
 * Client-safe types for the Shorts bulk-batch + YouTube-upload feature.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * The orchestrator + uploader live in server-only modules; this file
 * holds only the shapes that both the API + the React components
 * consume, so editor components can import without dragging the
 * pipeline into the browser bundle.
 *
 * Field-level conventions match `shorts-types.ts`:
 *   - JSONB columns are typed as concrete TS interfaces here so
 *     callers don't have to assert against `unknown`.
 *   - Anything nullable in SQL is `T | null` in TS (never `undefined`).
 *   - Time fields persisted as `TIMESTAMPTZ` surface as ISO `string`
 *     after the DB round-trip.
 */

import type { ShortRow } from './shorts-types';

/** YouTube publish privacy. Matches the API's `status.privacyStatus`. */
export type YoutubePrivacy = 'public' | 'unlisted' | 'private';

/** Per-short editable metadata, mirrors the YouTube videos.insert
 *  `snippet` + `status` blocks (the subset we expose in the review
 *  queue). Persisted as `shorts.youtube_metadata` JSONB. Every field
 *  is optional so a partial PATCH from the editor merges cleanly. */
export interface YoutubeUploadMetadata {
  /** YouTube title — hard 100-char limit, validated server-side. */
  title?: string;
  /** YouTube description — hard 5000-char limit, validated server-side. */
  description?: string;
  /** Tags (NOT hashtags). YouTube enforces a combined 500-char limit
   *  including the comma separators it inserts between entries; the
   *  TagTokenInput component + the server route both guard this. */
  tags?: string[];
  /** YouTube category numeric id (string in the API). See
   *  `youtube-categories.ts` for the canonical list. */
  categoryId?: string;
  /** ISO 639-1 default language for the snippet (e.g. 'en'). */
  defaultLanguage?: string;
  /** Playlists to attach the video to after upload. Empty / absent
   *  means no playlist attachment. */
  playlistIds?: string[];
  /** Privacy at the time of publish. When `youtube_publish_at` is set
   *  on the parent short, the uploader still sends `private` at insert
   *  and YouTube flips to this value at publishAt. */
  privacy?: YoutubePrivacy;
  /** COPPA mandatory. The uploader refuses to submit if this is
   *  absent — YouTube rejects videos without an explicit declaration. */
  madeForKids?: boolean;
  /** Age-restricted (18+ only) flag. Most channels leave this off.
   *  YouTube exposes this via `status.selfDeclaredMadeForKids=false`
   *  + the age-gate flag on contentRating; the exact Data API v3
   *  field is verified in the uploader. */
  ageRestricted?: boolean;
  /** Paid-promotion disclosure — "contains paid product placement,
   *  sponsorship, or endorsement." YouTube requires a truthful
   *  declaration. Surfaced in the review queue as a toggle; default
   *  is false unless the user opts in at the batch level. */
  paidPromotion?: boolean;
  /** AI-content disclosure per YouTube's altered-content rules
   *  (realistic-looking synthetic scene, real person made to say /
   *  do something, real footage altered). This app generates with
   *  AI, so the uploader defaults to true when the field is absent;
   *  the user can flip off in the review queue if a specific short
   *  doesn't meet the "realistic-looking scene" criterion (e.g.
   *  obviously-stylised doodle art). */
  aiContentDisclosure?: boolean;
}

/** Batch-level state machine. Mirrors the CHECK in migration 0122. */
export type ShortsBatchStatus =
  | 'setup'      // user is filling in defaults / picking ideas
  | 'generating' // orchestrator is producing shorts
  | 'review'     // all shorts ready (or failed), awaiting human approval
  | 'uploading'  // uploader is draining the approved set
  | 'done'       // every approved short uploaded (some may have failed)
  | 'failed';    // batch-level abort (rare; per-short failures stay in `review`)

/** Schedule cadence applied across a batch — used to auto-stagger
 *  publish times during step 5. `manual` means the user picks per-short
 *  with no auto-fill. */
export type ScheduleCadence =
  | 'manual'
  | 'every_30_min'
  | 'every_hour'
  | 'every_3_hours'
  | 'every_6_hours'
  | 'daily_morning'   // 09:00 in batch timezone, one per day
  | 'daily_evening';  // 18:00 in batch timezone, one per day

/** Batch defaults — the form state from step 2. Stored as
 *  `shorts_batches.defaults` JSONB and applied as the seed for each
 *  short's `youtube_metadata` after SEO generation. Per-short overrides
 *  in step 4 are the source of truth at upload time. */
export interface ShortsBatchDefaults {
  /** ElevenLabs / Google voice id used by the voiceover stage. */
  voiceId?: string;
  /** ISO 639-1 language code, propagated to `defaultLanguage` and
   *  passed to the SEO + voiceover stages for tone matching. */
  language?: string;
  /** YouTube category numeric id. */
  categoryId?: string;
  /** Default playlist attachments. */
  playlistIds?: string[];
  /** Description template — supports `{{title}}`, `{{hook}}`,
   *  `{{payoff}}` placeholders that get expanded per-short. */
  descriptionTemplate?: string;
  /** Suggested tags applied to every short. Per-short edits in the
   *  review queue add/remove from this seed. */
  tagsPool?: string[];
  /** Default privacy for unscheduled uploads. */
  defaultPrivacy?: YoutubePrivacy;
  /** Schedule cadence applied at step 5 when staggering publish
   *  times across the approved set. */
  scheduleCadence?: ScheduleCadence;
  /** COPPA — same field as the per-short YoutubeUploadMetadata, kept
   *  separately at the batch level so the user picks it once. */
  madeForKids?: boolean;
  /** Batch-level default for the per-short ageRestricted flag. */
  ageRestricted?: boolean;
  /** Batch-level default for the per-short paidPromotion flag. */
  paidPromotion?: boolean;
  /** Batch-level default for the per-short aiContentDisclosure flag.
   *  When absent, the uploader treats it as `true` since the batch
   *  pipeline generates with AI. */
  aiContentDisclosure?: boolean;
  /** IANA timezone for schedule pickers (e.g. 'America/New_York').
   *  Persisted at the batch level so a refresh of the review queue
   *  doesn't reset the picker's TZ. */
  timezone?: string;
  /** First scheduled publish time as an ISO string in the batch's
   *  timezone. Subsequent shorts get staggered from this via
   *  `scheduleCadence`. Absent ⇒ "publish immediately" for the whole
   *  batch (or per-short manual picks). */
  scheduleStartAt?: string;
}

/** Denormalised counters persisted on `shorts_batches.totals`. The
 *  per-short rows in `shorts` are authoritative; this is a cache for
 *  cheap dashboard reads. */
export interface ShortsBatchTotals {
  /** Number of shorts the batch was created with. Set at create
   *  time and never recomputed. */
  planned: number;
  /** Number of shorts that completed every generation stage. */
  generated: number;
  /** Number of shorts that failed any generation stage. */
  failed: number;
  /** Number of shorts that landed on YouTube (uploaded or scheduled). */
  uploaded: number;
  /** Subset of `uploaded` that have a non-null `youtube_publish_at`
   *  (i.e. scheduled, not yet public). */
  scheduled: number;
}

/** Database row shape — mirrors the `shorts_batches` table from
 *  migration 0122. */
export interface ShortsBatchRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  created_by: string | null;
  name: string | null;
  status: ShortsBatchStatus;
  defaults: ShortsBatchDefaults;
  totals: ShortsBatchTotals;
  created_at: string;
  updated_at: string;
}

/** Per-short YouTube state derived from the columns added in
 *  migration 0123. Mirrors the SQL CHECK. */
export type ShortYoutubeStatus =
  | 'pending'    // queued for upload, not started
  | 'uploading'  // videos.insert in flight
  | 'uploaded'   // success, no publishAt (privacy resolved immediately)
  | 'scheduled'  // success, publishAt in the future
  | 'published'  // publishAt has passed (informational; YouTube is source of truth)
  | 'failed';    // upload failed; see `youtube_upload_error`

/** Convenience: a batch + its child shorts, returned by GET
 *  `/api/shorts/batches/[id]`. */
export interface ShortsBatchWithShorts {
  batch: ShortsBatchRow;
  shorts: ShortRow[];
}

/** Result of the per-tick batch orchestrator run. Mirrors the
 *  auto-pipeline orchestrator's outcome shape. */
export interface BatchTickResult {
  batch_id: string;
  claimed: number;       // shorts started this tick
  advanced: number;      // shorts that completed a stage this tick
  failed: number;        // shorts that hit an error this tick
  done: boolean;         // batch transitioned to 'review' or 'done'
  duration_ms: number;
}

/** Result of a single videos.insert upload. */
export interface YoutubeUploadResult {
  videoId: string;
  status: ShortYoutubeStatus;
  publishAtUtc: string | null;
}

/** Per-playlist attachment outcome. Mirrors what
 *  `addVideoToPlaylists` (in `youtube-playlists.ts`) returns. Lives
 *  here so client components can type-check upload responses without
 *  importing the server-only uploader. */
export interface PlaylistAttachmentResult {
  playlistId: string;
  success: boolean;
  error: string | null;
}

/** Result for a single short upload — same shape whether the caller
 *  invoked the one-off path or the drain-all path. */
export interface SingleShortUploadOutcome {
  shortId: string;
  ok: boolean;
  videoId: string | null;
  status: ShortYoutubeStatus | null;
  playlistResults: PlaylistAttachmentResult[];
  error: string | null;
}

/** Result for the drain-all path — one outcome per short the
 *  uploader picked up plus any that were skipped. */
export interface BatchUploadOutcome {
  batchId: string;
  processed: SingleShortUploadOutcome[];
  /** Shorts that were in the batch but skipped (e.g. not yet
   *  rendered, already uploaded). The UI can show "X skipped:
   *  awaiting render" if the count is non-zero. */
  skipped: Array<{ shortId: string; reason: string }>;
}
