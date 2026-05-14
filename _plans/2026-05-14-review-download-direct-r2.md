---
title: Bypass download proxy for review videos
date: 2026-05-14
status: approved
---

## Goal

Make the "Download v{N}" button on the review pages produce a complete, playable MP4
for any render size — including the 4 GB long-form renders that are currently
getting truncated mid-stream.

## Constraints

- Must work for both the reviewer token-portal (`/review/[token]`) and the owner
  playback surface (`/(app)/reviews/[id]/play`) without code duplication.
- Cannot rely on raising Vercel function `maxDuration` — even the 900s cap on
  Pro would not cover the largest renders on slow client connections, and the
  function compute cost grows linearly with download time for bytes that do not
  need a function to touch them.
- Cannot break the playback `<video>` URL (it is signed for 7 days and used by
  range-fetch playback) or the existing narrator / voiceover downloads (which
  rely on `/api/download-proxy` to MIME-sniff and add a file extension).
- Must keep the filename behavior the user sees today: `{project title} - v{N}.mp4`.
- No new env vars, no new infrastructure.

## Requirements

- One click → file downloads to disk with the right filename, end-to-end stream.
- Owner admin per-version icons get the same fix; same root cause.
- 4 GB downloads complete (limit moves from "Vercel function timeout" to
  "client connection holds long enough" — which it already does on R2 directly).

## Root cause

`handleDownloadCurrent` in [`ReviewPage.tsx`](../src/components/review/ReviewPage.tsx)
clicks an anchor at `/api/download-proxy?u=<r2-url>`. The proxy is a Node.js
Vercel function with `maxDuration = 300`. For a 4 GB file at typical client
bandwidth (~1–10 MB/s), the function is killed by Vercel before the byte stream
finishes. The browser receives `~400 MB` of the response, sees the connection
close cleanly, and writes a partial MP4 — which is unplayable because the `moov`
atom lives at the end of the file (Windows surfaces this as `0xC00D36E5`).

## Chosen approach: direct presigned download from R2

Mint a presigned GET URL with `ResponseContentDisposition` baked into the
signature. R2 then serves the bytes directly to the user's browser with
`Content-Disposition: attachment; filename="..."`. No Vercel function in the
middle, no `maxDuration`, no `Cache-Control: max-age=60` footgun, no Active CPU
cost per download.

### Changes

1. **`src/lib/r2.ts`**
   - Add `getDownloadAttachmentUrlForBucket(bucket, key, filename)`: signs a
     `GetObjectCommand` with `ResponseContentDisposition` set to an RFC 5987
     `attachment; filename="…"; filename*=UTF-8''…` header. 24h TTL.
   - Add `getDownloadAttachmentUrl(key, filename)` review-bucket wrapper.
   - Add `buildReviewDownloadFilename(projectTitle, versionNumber)`: returns
     the canonical `{safe title} - v{N}.mp4` filename. Mirrors the sanitization
     currently inlined in `ReviewPage.tsx`.

2. **`src/app/api/review/[token]/route.ts`** and
   **`src/app/api/review/projects/[id]/playback/route.ts`**
   - Alongside the existing `video_url` per version, mint `download_url`
     using `buildReviewDownloadFilename(project.title, v.version_number)`.

3. **`src/app/api/review/projects/[id]/route.ts`**
   - Same addition for the admin per-version download icon on the owner page.

4. **`src/components/review/ReviewPage.tsx`**
   - `Version` interface gains `download_url: string | null`.
   - `handleDownloadCurrent` clicks an anchor at `v.download_url` directly
     (no proxy, no `<a download>` attribute needed — R2's response header is
     authoritative cross-origin).
   - Drop the unused `downloadStreaming` import.

5. **`src/app/(app)/reviews/[id]/page.tsx`**
   - Per-version download anchor (line ~619) switches from
     `downloadHref(v.video_url, …)` to `v.download_url`.
   - `Version` interface gains `download_url: string | null`.

6. **`src/lib/download-file.ts`**
   - Delete `downloadStreaming` (no remaining callers after this fix).
   - Keep `downloadHref` and `downloadCrossOriginFile` — still used by
     narrator-take, voiceover, and any same-origin downloads.

## Alternatives rejected

- **Raise `maxDuration` to 900s on Pro.** Defers the bug at 4× compute cost
  per download. Still breaks on the largest renders or slowest connections.
  No payoff for the cost.
- **Stream via Edge / Fluid Compute with a different runtime.** Edge has
  similar wall-clock caps. Fluid Compute does not eliminate `maxDuration`,
  it changes how the time is metered. Doesn't solve the problem.
- **Mint the URL on click via a small API endpoint.** Adds a round-trip and
  a Vercel function invocation per download. Slightly safer against URL
  expiry, but 24h TTL is comfortably longer than any realistic open-page
  session. Not worth the complexity for now.

## Security review

- The presigned download URL grants exactly the same R2 read access as the
  existing presigned playback URL — both expire, both target one specific
  object key. No new attack surface.
- Filename is encoded with `encodeURIComponent` before insertion into the
  RFC 5987 `filename*` parameter, and the ASCII fallback strips CR/LF/quote/
  backslash. No header-injection vector.
- Reviewer tokens already grant playback access to the same bytes; exposing
  a download variant changes nothing about who can see the file.
- The download URL is rendered into the page on initial load. It is no more
  sensitive than the existing playback URL on the same response.

## Cost review

- Per-download cost goes from "Vercel Node.js function streaming 4 GB for up
  to 5 minutes" → **zero Vercel function compute**. R2 egress on Cloudflare
  is already free.
- Presigning is a CPU-bound HMAC computation, executed once per page load
  per version. Negligible.

## Open questions

None.
