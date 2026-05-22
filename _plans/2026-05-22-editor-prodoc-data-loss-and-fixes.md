# 2026-05-22 — Stop the editor/prod-doc asset clobber + two adjacent fixes

## Goals

1. **Stop silent asset loss between editor and production-doc.** Today, the
   editor and the prod-doc both PATCH the full canonical `ProjectPayload` to
   the same row. Whichever page last fires a debounced save wins, and the
   loser's contributions to the asset maps (`rowImages`, `rowOverlays`,
   `rowVideoClips`, `doc.thumbnail`) are erased. Commit `b603dab` added an
   atomic `row-asset` endpoint that only protects writes routed through it.
   Every other code path (regeneration, voiceover, brand kit edit, etc.)
   still clobbers.
2. **Make `thumbnail_zoom_to` win over a per-row `imageUrl`** so the section
   divider zoom shows when the user has assigned a region — currently a
   stale per-row generated image silently suppresses the zoom.
3. **Add drag-to-scrub on the timeline playhead** so users can grab the
   marker and drag it to seek, matching the affordance every NLE has.

## Why now

User report (2026-05-22): "the editor is not showing the animations/images
in the player! Shows just some of them, It all came from production doc!
And when going back to production doc, All animations and images are gone!"
Also "the timeline marker cannot be dragged" and "Where is the zoom effect
on thumbnail for titles?!"

The data-loss bug is destroying real work and must stop today.

## Approach (decided 2026-05-22 with the owner)

### Fix #1 — Server-side asset merge in `saveProjectPatch`

Replace the JSONB column with an "asset-merging full replace":

- Load the current row payload (already validated/migrated).
- For the three asset maps (`rowImages`, `rowOverlays`, `rowVideoClips`),
  union the existing entries with the incoming entries. Incoming wins on
  per-key collisions (regenerated assets correctly replace).
- For `doc.thumbnail.regions` (composite section thumbnail): same union —
  region drawing edits must not be silently dropped by an editor save that
  was started before the user added regions on the prod-doc.
- All other fields (top-level scalars, `doc.rows`, `doc.thumbnail.imageUrl`,
  `flags`, brand kit, captions, alignment): client wins. Reorders, deletes,
  edits propagate normally.
- Keep the optimistic version check on the WRITE — but if the version
  check fails AND the only differences are in the protected maps, retry
  with the merged payload at the new version. This collapses benign
  races (prod-doc just wrote an asset; editor debounce fired at the old
  version) into a successful merged save instead of a 409.

Edge case — deletes: if a row is removed from `doc.rows`, the corresponding
`rowImages[idx]` entry will linger. Orphan entries are inert (no row to
render them). Acceptable for the emergency fix; can be GC'd later.

### Fix #2 — `thumbnail_zoom_to` wins in `SceneRouter`

In `src/remotion/compositions/YouTubeVideo.tsx`, current logic suppresses
the thumbnail-zoom scene when `shot.imageUrl || shot.videoUrl` is set. Flip
the precedence: if `shot.thumbnailZoomTo` resolves to a region AND the doc
carries a thumbnail composite, dispatch to `ThumbnailZoomScene` regardless
of whether a per-row image exists. The per-row image becomes a fallback
only when the row has no zoom target.

This matches user intent — assigning a region is the explicit signal "I
want the zoom here." A generated row image is an earlier auto-pipeline
artifact, not an override.

### Fix #3 — Drag-to-scrub handle on the playhead

`PlayheadOverlay` in `TimelineV2.tsx` has `pointer-events-none`. Keep the
vertical line non-interactive (so clicks pass through to lanes underneath)
but add a small **grabbable diamond head** at the top of the marker with
`pointer-events: auto` and `cursor: ew-resize`. On `pointerdown` the head
captures the pointer and emits `onSeek(timeFromX)` on every `pointermove`
until `pointerup`. The existing `onSeek` plumbing handles the rest.

## Alternatives rejected

- **Route every write through atomic endpoints (`jsonb_set`).** Cleaner
  long-term, but 1–2 days of work touching every save path. Tracked as
  follow-up; emergency merge ships today.
- **Client-side reconciliation on 409.** Editor reloads on 409, merges its
  in-flight state, re-PATCHes. Doable but adds a long-tail of UI churn
  (jumpy state, lost local edits) and still requires server cooperation
  to fetch the current payload. Server merge is simpler and quieter.
- **Make the whole ruler drag-to-scrub instead of a head.** Wider hit
  area, but the marker itself stays non-interactive, which is exactly
  what the user just complained about. Add the head; can add ruler-drag
  later if the head alone is not enough.

## Security & safety (rule 13)

- **No new attack surface.** The merge runs against payloads that already
  passed `validatePayload` (URL safety, key shape, etc.). The merge
  preserves entries the client never sent — if those were unsafe they
  would have been rejected at write time on the previous save. Defense
  in depth: re-validate the merged result before writing.
- **No widened scoping.** The SQL still requires `workspace_id` +
  `collaborator_id` match. A merge against a row outside the caller's
  scope is impossible (the row read returns 0 rows; falls through to
  `not_found`).
- **Rate limit unchanged.** 120 PATCH/min/IP still applies.

## Observability (rule 14)

- `[project payload save] merged` log emitted when the asset merge
  preserves keys the client didn't send. Includes counts per map and
  which keys were preserved. Lets us see in production whether the
  merge is doing real work (and how often clients are racing).
- `[project payload save] merge-retry` log when a 409 was upgraded to
  a successful merged save at the new version.
- `[scene router] thumbnail-zoom won over row image` log when the new
  precedence rule overrides what the old rule would have picked, so we
  can confirm in the console the section divider is firing for the
  right reason.
- `[playhead scrub] start/move/end` logs gated on a debug flag, so we
  can verify the drag is reaching `onSeek`.

## Settings audit (rule 15)

- Thumbnail-zoom precedence: no setting — the new behavior matches user
  intent (region assignment = explicit zoom). If a future user wants the
  old behavior, expose `preferRowImageOverZoom` as a per-row checkbox.
  Not adding now; would clutter the inspector for a contrarian case.
- Playhead scrub: no setting needed. Drag is universally expected.
- Server merge: no setting — security/data-integrity feature, not a
  preference.

## QA plan (rule 6)

Golden path:
1. Open prod-doc, generate row images, navigate to editor → all images
   present in player.
2. Edit something in the editor (e.g., trim a shot), wait for autosave,
   navigate back to prod-doc → all images still present, edit persisted.
3. Open prod-doc, upload section thumbnail, mark 3 regions, assign each
   to a shot → section dividers show the zoom in the player, even when
   those shots have row images.
4. Drag the playhead marker left and right on the timeline → seek
   tracks the mouse position, audio scrubs.

Edge cases:
5. Two tabs open on the same project, both editing → still version-
   protected for non-asset fields; asset maps merge.
6. Editor saves with an empty `rowImages` (e.g., a fresh state) → server
   merge preserves all existing images.
7. Editor regenerates an existing image → new URL wins on that key.
8. Playhead drag past the timeline edges → clamped to [0, totalDuration].
9. Thumbnail composite present but no regions drawn yet → no zoom
   shows, scene router falls through normally.
10. Thumbnail-zoom shot also has an animation generated → zoom wins, the
    animation video is unused for that shot.
