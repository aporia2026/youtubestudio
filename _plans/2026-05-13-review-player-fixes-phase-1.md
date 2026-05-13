# Review Player Fixes — Phase 1

**Date:** 2026-05-13
**Status:** Approved, in implementation
**Scope:** `src/components/review/*` and `src/components/review/CommentPanel.tsx`. Server-side untouched.

## Goals

Make the video-review screen at `/review/[token]` and the owner playback view feel like a real product:

1. **Scrubbing works.** Drag, click, and keyboard all seek reliably. Bar is visible at a glance.
2. **Playback feels smoother and faster on first load.**
3. **When viewing vN, the reviewer can see prior-version comments — and which ones the editor claims to have fixed — without losing the current-version context.**

## Constraints

- One PR. No new vendors. No new infra. No new DB tables.
- Reuse the existing `getCommentsForProject` payload — it already includes all versions' comments with `version_number`.
- Cannot break the owner-side and token-side codepaths; both share `ReviewPage`.
- No new dependencies (no hls.js this phase).
- Keep keyboard shortcuts working.

## Diagnosis (verified in the code, not guessed)

**Scrubber broken:**
- `ReviewTimeline.tsx:170-176` only handles `onClick`. No drag chain (`mousedown` → window `mousemove` → window `mouseup`). The thumb at line 283-286 looks draggable but isn't.
- Bar is `h-2` (8px). Hard to see, hard to hit.
- Comment markers use `e.stopPropagation()` on click — clicking near a marker accidentally clicks the marker instead of seeking.

**Sluggish playback:**
- `ReviewTimeline.tsx:50-54` calls `v.load()` on the hover-preview `<video>` the moment the URL is known, with `preload="auto"`. That's a parallel R2 fetch before the user has hovered, competing with the main `<video>`'s buffer.
- Main video has no `fetchpriority` attribute.
- Stall recovery at `ReviewPlayer.tsx:281` re-nudges after 3.5s, which on slow networks can compound back-and-forth seeks.

**Prior-version comment access:**
- `ReviewPage.tsx:336-349` — the 30s polling loop fetches **only the active version's comments** and overwrites `data.comments`. So after 30s, any prior-version comment vanishes from the panel even with "All versions" toggled.
- The "All versions" toggle is binary — no per-comment version tag, no fix-status surfacing, no visual distinction on the timeline.
- The data model already supports the fix linkage (`fix_for_comment_id` in `review_comments`). It just isn't surfaced.

## Approach

### A. Scrubber rebuild (`ReviewTimeline.tsx`)

- Add drag scrubbing: `onMouseDown` on the bar → starts a drag, attaches `mousemove` + `mouseup` to `window`. While dragging, pause the video and seek live. On release, resume if was playing.
- Add touch equivalents (`touchstart` / `touchmove` / `touchend`) so the same logic works on iPad.
- Bar height: idle `4px`, hover/drag `10px` with smooth transition. Wrapper is `h-5` so the hit area is always ~20px even when bar is thin (YouTube pattern).
- Thumb: idle `0px` (hidden), hover/drag `14px` filled circle.
- Comment markers stay clickable, **but** their `onClick` no longer just calls `onSeek` — it also calls a passed-in `onMarkerClick(commentId)` so the comment scrolls into view in the panel. Also remove `stopPropagation` since the parent's drag handler is on `mousedown`, not `click`.
- Keep the hover preview, but its visibility is unchanged.

### B. Lazy hover-preview + fetchpriority (`ReviewTimeline.tsx`, `ReviewPlayer.tsx`)

- Remove the eager `v.load()` in `ReviewTimeline.tsx:50-54`.
- The hover-preview `<video>` element renders only after the first hover (`hasEverHovered` boolean state). Once mounted, it stays mounted for the rest of the session.
- `preload="metadata"` instead of `auto` so the second stream only fetches the moov, not the bytes.
- Add `fetchPriority="high"` to the main video element. (Chromium honors this; other browsers ignore it without error.)
- Bump `STALL_RECOVERY_MS` from 3500 → 6000. Cap nudge attempts at 2 (was 3).

### C. Fix 30s poll (`ReviewPage.tsx`)

- Change the poll to refetch the full `dataUrl` (returns all-version comments) instead of `commentsListUrl(activeVersionId)`.
- Diff-merge: only replace `comments`, keep `versions`/`project`/etc untouched to avoid unrelated re-renders.

### D. Prior-version surfacing

The cleanest way is to compute, in `ReviewPage`, two derived comment lists:

```
const currentVersionComments = data.comments.filter(c => c.version_id === activeVersionId);
const priorVersionComments = data.comments.filter(c => c.version_id !== activeVersionId && (versionNumber of c < activeVersionNumber));
```

Pass `priorVersionComments` to:

1. **`ReviewTimeline`** — render as small dashed/ghost markers ABOVE the bar with the version-color, click jumps to that timestamp on the current video. Hover shows the comment text and status badge.
2. **`CommentPanel`** — new collapsible "From previous versions" section above the current list. Each row shows:
   - `vN` chip
   - timestamp (click jumps)
   - excerpt
   - status badge:
     - ✅ Fixed → there's a comment in v(current) with `fix_for_comment_id === priorComment.id`
     - ✓ Resolved → `priorComment.resolved === true` and no fix-note
     - 🟡 Open → neither

Resolved or fixed comments are dimmed; open ones are bright so the reviewer's eye lands on what still needs checking.

### E. Timing instrumentation (`ReviewPlayer.tsx`)

Add lightweight `performance.now()` markers to `console.info` once per session:

- `time_to_metadata` — from src set to `loadedmetadata`
- `time_to_first_frame` — from src set to `loadeddata`
- `time_to_canplaythrough` — from src set to `canplaythrough`
- `stall_count`, `total_stall_ms`

Gated behind `localStorage.reviewPlayerTiming === '1'`. So in dev we can compare before/after.

### F. QA pass

- Click on timeline → seeks.
- Drag thumb left/right while paused → seeks live.
- Drag thumb left/right while playing → pauses during drag, resumes on release.
- Touch drag on iPad emulator → works.
- Click on a comment marker → seeks AND highlights the comment in the panel.
- Open hover preview by mousing over → renders the right frame (existing guard at `ReviewTimeline.tsx:206` still active).
- View v2 of a project that has unresolved v1 comments → see "From previous versions (N open)" section + ghost markers.
- Editor uploads v3 and adds fix-notes for v2 comments → those v2 comments show ✅ Fixed when viewing v3.
- Switch active version → prior-version derivation re-runs.
- 30s poll fires → no longer wipes prior-version comments.
- Stall test: throttle network in DevTools, confirm spinner appears but nudge is less aggressive.
- Owner mode (`ownerProjectId`) — confirm all of the above works there too (shared component).
- Single video version (no v(N-1)) → "From previous versions" section hidden, no ghost markers.
- Comparison view modes (Side by Side / Onion Skin / Swipe) — confirm not regressed; their renderer is `ComparisonView`, not touched here.

## Out of scope (Phase 2 — see separate plan)

- HLS adaptive streaming
- Real R2 CDN caching for presigned URLs
- Pre-generated sprite thumbnails for instant scrub preview

## Security / safety review

- All changes are client-side rendering and event handling. No new endpoints, no new auth surface, no new logging that could leak PII.
- The `commentsListUrl` poll replacement reuses the existing `dataUrl` route which is already gated by the share-token. No new data exposure.
- The "previous versions" section only renders comments the user is **already authorized to see** (server filters by token's project).

## Files touched

- `src/components/review/ReviewTimeline.tsx`
- `src/components/review/ReviewPlayer.tsx`
- `src/components/review/ReviewPage.tsx`
- `src/components/review/CommentPanel.tsx`
- `src/components/review/CommentItem.tsx` (small: accept optional `versionNumber` and `fixStatus` props for the ghost rows)

## Open questions

None. User confirmed: "Phase 1 only: cheap wins + measure".
