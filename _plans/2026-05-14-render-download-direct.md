---
title: Bypass download proxy for render outputs (video-studio, production-doc, shorts)
date: 2026-05-14
status: approved
---

## Goal

Same root cause as `2026-05-14-review-download-direct-r2.md`: the
`/api/download-proxy` Vercel function has a 300s `maxDuration` cap, and
long-form video renders can exceed that. Bypass the proxy for the three
remaining "download my render" surfaces:

- video-studio "Download MP4" button (top bar + bottom export panel).
- production-doc "Download MP4" button (via `VideoPlayer`).
- shorts "↓ Download" link.

## Constraints

- Must work for both render backends (`RENDER_BACKEND=vercel` writes to R2,
  `RENDER_BACKEND=lambda` writes to the per-region Remotion Lambda S3
  bucket). The client must not need to know which backend produced the file.
- Lambda outputs use `privacy: 'public'`, so a raw S3 URL works for a
  navigation GET — but S3 only honors `response-content-disposition` when
  the request is signed. We must presign with AWS creds to bake the
  `Content-Disposition: attachment` header in.
- Shorts always run on the Vercel backend today; no Lambda path needed
  there.
- `VideoPlayer` is shared between video-studio and production-doc. The
  fix must flow through one prop change, not surface-specific patches.

## Approach

The render poll endpoints (`/api/render/video`, `/api/render/short`) gain
a `downloadUrl` field next to `outputUrl`. The polling client tracks both:
`outputUrl` stays as-is for in-page playback; `downloadUrl` is what the
Download anchor points at.

### Backend dispatch in `/api/render/video`

Inside the GET poll route, after the job row is loaded:

- If `lambda_render_id` IS NULL → Vercel R2 render. Key is
  `buildRenderKey(renderId)`. Mint via
  `getRenderDownloadAttachmentUrl(renderId, filename)`.
- Else → Lambda S3 render. Parse bucket + key from `output_url` (or use
  `lambda_bucket` + extracted key). Mint via the new
  `getLambdaOutputDownloadUrl(outputUrl, filename)` helper.

The mint runs only when `status === 'done'` and `output_url` is set —
matches the existing condition for `outputUrl` being meaningful.

### Backend dispatch in `/api/render/short`

Always Vercel R2 today. Mint via
`getShortRenderDownloadAttachmentUrl(renderId, filename)`. No Lambda
branch needed.

## Files

**New**

- `src/lib/lambda-s3.ts`
  - `parseLambdaOutputUrl(url)` — extracts `{ bucket, region, key }` from
    the virtual-hosted and path-style URL shapes that `progress.outputFile`
    can return. Returns `null` if the URL is unrecognized (caller falls
    back to surfacing no `downloadUrl`).
  - `getLambdaOutputDownloadUrl(url, filename)` — presigns a
    `GetObjectCommand` with `ResponseContentDisposition` set. Uses
    `REMOTION_AWS_*` (falling back to `AWS_*`) creds, the region parsed
    from the URL, and a 24h TTL.
  - Lazy-cached `S3Client` per region (same pattern as `r2.ts`).

**Modified**

- `src/lib/r2.ts`
  - Add `getRenderDownloadAttachmentUrl(renderId, filename)` —
    convenience wrapper using `buildRenderKey(renderId)`.
  - Add `getShortRenderDownloadAttachmentUrl(renderId, filename)` —
    convenience wrapper using `buildShortRenderKey(renderId)`.

- `src/app/api/render/video/route.ts`
  - In the GET handler, after the job is loaded/refreshed, compute
    `downloadUrl` based on the Vercel/Lambda branch. Include it in the
    JSON response.

- `src/app/api/render/short/route.ts`
  - In the GET handler, compute `downloadUrl` via
    `getShortRenderDownloadAttachmentUrl(renderId, filename)`. Include in
    response.

- `src/components/video/VideoPlayer.tsx`
  - Add `downloadUrl?: string` prop. Anchor at line 132 uses `downloadUrl`
    when present; falls back to nothing rendered when absent (no proxy
    hop).
  - Drop the `downloadHref` import + usage.
  - The `download={...}` attribute stays (no-op cross-origin but harmless;
    keeps same-origin scenarios working if any future caller passes one).

- `src/app/(app)/video-studio/page.tsx`
  - Track `renderDownloadUrl` state alongside `renderOutputUrl`. Set both
    from the poll response. Pass `downloadUrl` to `<VideoPlayer />`. The
    bottom export-panel anchor (line ~1204) switches from `downloadHref`
    to `renderDownloadUrl`.
  - Drop the `downloadHref` import.

- `src/app/(app)/production-doc/page.tsx`
  - Track `renderDownloadUrl` state alongside `renderOutputUrl`. Update
    `VideoPlayerMemo` to forward `downloadUrl` to the underlying
    `<VideoPlayer />`. Set both URLs from the poll response.

- `src/app/(app)/shorts/page.tsx`
  - Per-row poll tracks `downloadUrl` alongside `outputUrl`. The
    Download anchor (line ~566) uses `downloadUrl`. Drop `downloadHref`
    usage where applicable.

## Filename strategy

Server-minted filenames so the user sees consistent names regardless of
which surface kicked off the render:

- Long-form: `render-{renderId}.mp4`. Could be enhanced later to use the
  production-doc title + version, but that data is not on `render_jobs`
  today and adding it is out of scope.
- Shorts: `short-{shortId-prefix}.mp4` (matches the current client-side
  convention). We'd need the shortId on `render_jobs` to do this; it's
  not there yet, so we fall back to `short-{renderId}.mp4`.

Filenames are sanitized by `buildAttachmentDisposition` in `r2.ts`
anyway, so any string passes safely.

## Alternatives rejected

- **Add a `/api/render/<type>/<renderId>/download` route that 302s to a
  freshly-minted URL.** Slightly safer against URL expiry, but the
  client already polls every 2–3s while the render is in flight, and
  once done the URL is needed in the open download tab. 24h TTL covers
  any realistic flow; reloading the page re-mints. Not worth the extra
  route and per-click function invocation.

- **Skip the Lambda branch and accept that long-form Lambda renders go
  through the proxy.** Defeats the point — Lambda is the path that
  produces the largest files (and the user's recent commits are all
  Lambda fixes, so it's actively in use).

## Security review

- The Lambda S3 helper needs AWS creds that the codebase already has
  via `REMOTION_AWS_ACCESS_KEY_ID` / `AWS_ACCESS_KEY_ID`. Same trust
  boundary as `kickOffLambdaRender`. No new surface.
- Bucket parsing whitelist: only `remotionlambda-*` buckets pass the
  helper's regex. Same posture as `/api/download-proxy`'s allowlist,
  preventing a malformed `output_url` from being used to fetch arbitrary
  S3 objects under our creds.
- Lambda outputs are configured `privacy: 'public'` already, so the
  presigned attachment URL grants no access the existing playback URL
  doesn't already grant. The override only changes `Content-Disposition`.
- All filenames are sanitized via `buildAttachmentDisposition`.

## Cost review

- Same as the review fix: zero new Vercel function compute on the hot
  download path. Presigning is cheap HMAC, run once per poll.

## Open questions

None blocking. Future enhancement: thread the production-doc title +
version (or the short's title) onto `render_jobs` so download filenames
are human-meaningful instead of opaque renderIds.
