# Channel-Clone Intake on Vercel Sandbox

**Date:** 2026-06-06
**Status:** Implementing
**Branch:** claude/video-creation-ui-pqXzS

## Problem

Channel-clone intake spawns `yt-dlp` (Python) and `ffmpeg` as local
child processes. That works under `npm run dev` but fails on Vercel
deploys because neither binary is on the function runtime's PATH:

> Could not list channel videos: yt-dlp not found. Install via `pip install yt-dlp`…

Today's `assertIntakeAvailable()` guard hard-fails in production unless
the operator sets `CHANNEL_CLONE_ALLOW_PROD_INTAKE=1`, which was always
a placeholder for "future work."

## Decision

Run yt-dlp + ffmpeg inside a Vercel Sandbox microVM, per-intake. The
serverless function reaches into the sandbox via the `@vercel/sandbox`
SDK, runs the same commands we run locally today, and reads the
results back over the SDK.

Why this path (already decided by the user, recorded here for the
plan record):
- Free path (YouTube Data API + youtube-transcript npm) would skip
  real video frame extraction — a meaningful fidelity loss for the
  "visual style DNA" the analyze stage builds.
- Local-only would hide the feature in production, defeating the
  point of shipping it.

## Cost (rule 8 — verified online)

- **Active CPU**: $0.128–$0.221/hour (regional). Use ~$0.15/hr average.
- **Memory**: $0.0106–$0.0183/GB-hr.
- **Creations**: $0.60 per million ($0.0000006 each — negligible).
- A 5-video intake at ~90s wall-time, ~1 vCPU active, ~1 GB memory:
  90s × ($0.15/3600) + 90s × 1 GB × ($0.013/3600) ≈ **$0.0040 per
  intake**.
- 1000 intakes ≈ $4. Hobby plan has a free monthly allotment that
  most users won't exceed.

## Architecture

```
[Vercel Function: runIntake]
  │
  ├─ createIntakeSandbox()  ← @vercel/sandbox.create({runtime:'python3.13'})
  │     └─ apt-get install -y ffmpeg
  │     └─ pip install --quiet yt-dlp
  │
  ├─ for each video:
  │     ├─ yt-dlp <args>           (in sandbox)  → metadata, SRT path
  │     ├─ ffmpeg -ss …            (in sandbox)  → N frame files
  │     ├─ sandbox.readFile(srt)   → transcript text
  │     ├─ sandbox.readFile(mid-frame) → Buffer → base64 (the only
  │     │                                 frame the analyze stage
  │     │                                 actually consumes)
  │     └─ store {transcript, representativeFrameBase64, frameCount}
  │
  └─ sandbox.stop()
```

## Schema migration

`ChannelCloneSampleVideo` shape change:

```diff
- videoLocalPath: string;
- frameLocalPaths: string[];
+ frameCount: number;
+ representativeFrameBase64: string | null;
+ representativeFrameMimeType: 'image/jpeg' | 'image/png' | null;
```

`ChannelCloneIntakeResult.tempDirPath` removed (no longer meaningful —
the sandbox owns the path lifecycle).

These fields live in `state_jsonb` (Postgres JSONB), so the schema
change is data-only — no SQL migration. Old jobs with the legacy
shape will fail the analyze stage's frame load (current behavior is
also failure on missing path), so we add a back-compat read path that
tolerates either shape.

## Files

| File | Change |
| --- | --- |
| `package.json` | add `@vercel/sandbox` dependency |
| `src/lib/channel-clone/sandbox-runtime.ts` | NEW — create/destroy + exec wrappers |
| `src/lib/channel-clone/yt-dlp.ts` | replace child_process with sandbox.runCommand |
| `src/lib/channel-clone/ffmpeg.ts` | same |
| `src/lib/channel-clone/types.ts` | shape change for sampleVideo |
| `src/lib/channel-clone/intake-runner.ts` | own sandbox lifecycle, read frame back |
| `src/lib/channel-clone/analyze-runner.ts` | read base64 from job state, not disk |
| `src/components/channel-clone/ChannelClonePanel.tsx` | display `frameCount` not `frameLocalPaths.length` |

## Security (rule 13)

- Sandbox is a Firecracker microVM — strong isolation from our
  function and from other workloads.
- The same `validateYoutubeUrl` guard runs before any sandbox work.
- Commands are passed argv-array (no shell), same as today.
- The sandbox token (`VERCEL_OIDC_TOKEN`) is read from env, never
  logged, never echoed. Locally devs pull via `vercel env pull`.
- Stderr is captured for logs but not echoed to the user (same as
  today's spawn flow).
- The sandbox auto-stops after the function returns; no orphan VMs.

## Observability (rule 14)

Existing log namespaces stay; just the implementation behind them
changes. Add one new namespace:

- `[channel-clone sandbox]` — start/install/destroy + exit codes
  per command. Logged at info on success, error on failure.

## Testing (rule 18)

Pure helpers (URL validation, caption cleaner, etc.) keep their
existing tests. The sandbox wiring is integration code — it cannot
be unit tested without a real Vercel OIDC token, so:

- Add unit tests for the new schema-mapping helpers (frame buffer →
  base64 + mimetype).
- The end-to-end intake gets a manual QA pass on a Vercel preview
  with `vercel env pull` already done.

## Settings (rule 15)

No new user-facing settings — the sandbox is an implementation
detail. The existing `sampleVideoCount` and `frameIntervalSec`
controls still apply.

## Rollout

1. Land code on the branch.
2. User runs `vercel env pull` to ensure `VERCEL_OIDC_TOKEN` is in
   local `.env.development.local`.
3. Vercel preview build picks up the change; user retries intake
   on the same channel URL.
4. Watch the new `[channel-clone sandbox]` logs to confirm install
   succeeded.
