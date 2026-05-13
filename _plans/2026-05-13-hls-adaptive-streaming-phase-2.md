# HLS Adaptive Streaming for Review — Phase 2 backlog

**Date:** 2026-05-13
**Status:** Backlog — not in flight. Revisit after measuring Phase 1 wins.
**Predecessor:** `_plans/2026-05-13-review-player-fixes-phase-1.md`

## Why this is *not* in Phase 1

The user's stated pain — "videos must load and play much smoother and faster" — was investigated. The single biggest contributor to felt slowness on the current setup was the hover-preview `<video>` mounting eagerly with `preload="auto"` and stealing bandwidth from the main player before the user even hovered (`src/components/review/ReviewTimeline.tsx:50-54` in the pre-fix version). HLS does **not** fix that contention — HLS would introduce a *different* set of byte fetches alongside the same eager-preview problem.

Phase 1 ships the cheap wins (lazy preview, fetchPriority, softer stall, timing instrumentation) so we can **measure** before paying for HLS infra. If, after Phase 1, the timing logs (toggle with `localStorage.reviewPlayerTiming = '1'`) still show p50 time-to-first-frame > 3s or p95 > 8s on the user's network, HLS becomes worth the investment.

## What HLS would actually buy us

- **Adaptive bitrate.** Reviewers on bad networks (hotel WiFi, mobile data) automatically downshift to 720p or 480p instead of stalling.
- **Faster seeks.** Native HLS uses small segments (~6s each), so seeking only fetches the segment containing the target, not a giant mp4 byte range.
- **Better CDN cache hit rate.** Static `.m3u8` + `.ts` segments cache well on CloudFront / R2's CDN; presigned mp4 URLs do not.

What HLS does **not** buy:

- Faster first-byte latency (it can be *worse* — manifest → segment chain).
- Lower R2 egress for short videos (more total requests, similar total bytes).
- Free fixes for the hover-preview double-stream.

## Options matrix (current pricing — verify again before commit)

### A. New Lambda with ffmpeg layer

- **Cost:** ~$0.02 per 13-min video transcoded.
- **Lift:** New Lambda function, IaC deployment (the existing `remotion-lambda` setup is Remotion-only and cannot be repurposed), ffmpeg layer build, orchestration code, status polling.
- **Limits:** 15-minute Lambda execution ceiling — tight for any future 30+ minute review video.
- **Failure modes:** Layer drift, ffmpeg version pinning, cold-start latency.
- **Verdict:** Cheapest by far but most code to own.

### B. AWS MediaConvert

- **Cost:** ~$0.29 per 13-min video for three renditions (1080p / 720p / 480p) HEVC + AAC.
- **Lift:** Job submission API + status polling. No code to maintain for the transcode itself. Output lands in S3 or directly in R2 via destination IAM.
- **Limits:** None practical.
- **Verdict:** Best balance of cost and effort. Recommended if HLS is greenlit.

### C. Cloudflare Stream

- **Cost:** ~$0.065 per 13-min video stored + $1 per 1000 min delivered.
- **Lift:** Move video storage off R2 to Cloudflare Stream. Architectural change to upload pipeline + storage migration.
- **Verdict:** Cheap and clean, but breaks the "all our blob is R2" architecture.

### D. Mux

- **Cost:** ~$0.52 per 13-min video encoded + per-minute storage + per-minute streaming.
- **Lift:** Vendor switch, mux-uploader integration, mux-player integration.
- **Verdict:** Most expensive. Worth it if we also need analytics, captions, or ABR LL-HLS streaming — features we don't currently use.

## Concrete steps if greenlit (assuming MediaConvert)

1. **Add S3 destination bucket** (or R2 with MediaConvert's S3-compatible writer).
2. **Add MediaConvert job preset** for three-rendition HLS output (1920×1080, 1280×720, 854×480 — all H.264, AAC).
3. **Schema migration**: `review_versions.hls_manifest_url`, `review_versions.transcode_status` ('pending' | 'transcoding' | 'ready' | 'failed').
4. **Upload completion hook**: After R2 PUT completes (extend `PATCH /api/review/[token]/upload-video`), enqueue a MediaConvert job pointing at the R2 object. Persist `transcode_status='pending'` and the MediaConvert job ID.
5. **Status polling**: New cron route `/api/cron/poll-transcodes` (every 30s) that fetches `pending` rows, queries MediaConvert for job status, updates the row when done. Or use a MediaConvert → SNS → webhook for push.
6. **Playback route update**: `/api/review/[token]` returns `hls_manifest_url` (if ready) alongside `video_url` (always present as mp4 fallback). The client prefers HLS when present.
7. **Client player swap**:
   - Mount `hls.js` (Chrome / Firefox / Edge — load only when needed via dynamic import).
   - Use native HLS on Safari (`video.canPlayType('application/vnd.apple.mpegurl')`).
   - Fallback to existing mp4 `src` if HLS unavailable or `transcode_status !== 'ready'`.
8. **Hover-preview**: Use HLS's `currentLevel = lowestQuality` so preview seeks fetch the lowest rendition's segment (fast).
9. **Backfill**: Background job to MediaConvert all existing `review_versions.r2_key` rows with `hls_manifest_url IS NULL`.
10. **UI for transcoding state**: When `transcode_status === 'pending'` or `'transcoding'`, show a "Transcoding HD — playing original" badge but still play the mp4 fallback. So reviewers never wait on transcode to start watching.

## Effort estimate

1.5–2 engineering days for the MediaConvert path, **plus** the half-day backfill window for any existing videos. Add buffer for AWS IAM and CORS plumbing (always more painful than expected).

## Open questions (decide before committing)

- Do we serve HLS through Cloudflare R2's CDN (cheaper) or through CloudFront (faster TLS handshake, more knobs)?
- DRM? Not currently a requirement, but if we ever ship publicly we should plan widevine + AES-128 at minimum.
- Captions / subtitles? HLS supports WebVTT side-loading. We already have voiceover alignment data — could double as cheap auto-captions.
- Do we keep the mp4 in R2 after transcode (for fallback + downloads), or delete it to save storage?

## Trigger condition to revisit

After Phase 1 ships, leave the `reviewPlayerTiming` flag on for one week. If aggregated p50 time-to-first-frame stays under 2.5s on the team's typical networks, HLS is not worth the spend. If it spikes on slow networks (which the timing logs will show), revisit this plan.
