# Render-state hardening — production-doc reliability fixes (Phase 1)

**Date**: 2026-05-17
**Branch**: phase-1-foundation
**Status**: approved by user, ready to implement
**Predecessor**: this is the response to three bug reports:
  1. Rendered MP4 ignores production-doc settings (animations, overlay-suppression).
  2. Preview narration desyncs from frames.
  3. Refresh loses paid generated assets.

## Goals

Stop the money bleed on bug 3, fix preview desync (bug 2), and confirm bug 1
is a downstream symptom that resolves once bug 3 is fixed.

## Root causes (verified from code reading, not guessed)

### Bug 3 — refresh loses assets. Three independent failure modes:

1. **BrollCell mount-hydration doesn't notify parent.**
   [BrollCell.tsx:395-425](src/components/production-doc/BrollCell.tsx#L395-L425)
   reads the per-cell localStorage map, fetches `/api/broll/{id}`, then calls
   raw `setClip(data.clip)` at [line 415](src/components/production-doc/BrollCell.tsx#L415).
   The bridge to parent (`onClipChangeRef.current?.(next)`) only fires inside
   `updateClip` at [line 355-371](src/components/production-doc/BrollCell.tsx#L355-L371).
   Result: cells visually show "ready", but `rowVideoClips` at the page level
   stays `{}`. The renderer reads from parent state → produces stills-only MP4.

2. **History sidebar restore wipes overlays and never restores clips.**
   [page.tsx:5341-5347](src/app/(app)/production-doc/page.tsx#L5341-L5347)
   explicitly clears `setRowOverlays({})` on history-entry click. No equivalent
   `if (entry.rowVideoClips)` branch exists, so clips are dropped silently too.
   Users who navigate via the sidebar lose every generated asset for the
   restored doc.

3. **Bundled-localStorage persist fails silently.**
   [page.tsx:2551-2574](src/app/(app)/production-doc/page.tsx#L2551-L2574) writes
   `prodoc_last_result` on every change. The catch at line 2562 only
   `console.warn`s on quota exceeded — no toast, no UI signal. Long docs with
   many image URLs can plausibly push past 5MB and start failing without the
   user knowing.

### Bug 1 — rendered MP4 "ignores settings". Downstream symptom of bug 3.

The render route DOES receive `suppressLowerThirds` correctly (verified
[page.tsx:3523](src/app/(app)/production-doc/page.tsx#L3523) →
[route.ts:246](src/app/api/render/video/route.ts#L246) → preserved by
`absolutizeMediaUrls`). BRollScene + ScreenMockupScene gate on it correctly.

**But:** when bug 3 wipes a row's `imageUrl` AND `videoUrl`,
[utils.ts:433-434](src/remotion/utils.ts#L433-L434) sets `hasVisual = false` →
`inferSceneType` reroutes by `visual_type` text → "fact"/"stat"/"text"/"quote"
rows route to [TextRevealScene](src/remotion/scenes/TextRevealScene.tsx) which
renders `shot.onScreenText` as its centerpiece and never checks
`suppressLowerThird` (by design — it's a text-only scene). So the user sees
big text wherever the row's image was lost.

Fix bug 3, this symptom goes with it. **No change to TextRevealScene** —
it's working as designed.

### Bug 2 — preview narration desync.

[VideoPlayerMemo at page.tsx:547-561](src/app/(app)/production-doc/page.tsx#L547-L561)
builds its `VideoConfig` without the `alignment` option. Render route
[page.tsx:3537-3548](src/app/(app)/production-doc/page.tsx#L3537-L3548) and the
dev Studio handoff [page.tsx:5259-5267](src/app/(app)/production-doc/page.tsx#L5259-L5267)
also miss alignment. The page state has it (in `voiceoverAlignment` /
`alignmentStatus`) — it's just not threaded into the config build.

## Phase 1 changes (this PR)

### Renderer / config plumbing
- `VideoPlayerMemo` accepts an optional `voiceoverAlignment` prop and passes it
  through to `productionDocToVideoConfig`. Page passes the current
  `voiceoverAlignment` state when status is `'ready'`.

### BrollCell — bridge mount-hydration to parent
- The hydration-from-localStorage useEffect at
  [BrollCell.tsx:395-425](src/components/production-doc/BrollCell.tsx#L395-L425)
  swaps its raw `setClip(data.clip); setPhase(...)` calls for `updateClip(data.clip)`.
  `updateClip` already fires `onClipChange` (the bridge to parent state) and
  re-persists the row-signature map. One-line fix.
- Defensive log: `console.info('[broll hydrate]', { rowIndex, rowSignature, clipId, status })`.

### Pre-render verification (the "block render if mismatched" UI)
- New helper `findMissingClipsForRender(doc, rowVideoClips)`:
  - For each row's signature, read the per-cell localStorage map.
  - If the map has a clipId but `rowVideoClips[i]` is missing or not 'ready',
    add `{ rowIndex, clipId, signature }` to the result.
- `startVideoRender` calls this BEFORE creating the config. If non-empty:
  - Toast suppressed; show a modal: "{N} clips generated for this doc aren't
    loaded in this session. Reload them now? You already paid for these."
  - Primary action **[Reload missing clips]** — fetch each `/api/broll/{id}`,
    fire `handleBrollClipChange` for each, re-run the check until empty,
    then continue with the render.
  - Secondary action **[Render anyway]** — explicit confirm required, logs
    `[render skipped-reload]` with the missing rows.
  - Cancel — closes the modal, doesn't render.

### History sidebar restore — stop wiping assets
- Always restore `rowVideoClips` and `rowOverlays` from the entry if present;
  fall back to `{}` only when the entry has nothing.
- Start persisting both on the entry: extend the entry-write at
  [page.tsx:2565-2573](src/app/(app)/production-doc/page.tsx#L2565-L2573) so the
  background patch includes `rowVideoClips` (map of `rowIndex` → `clipId`) and
  `rowOverlays` (map of `rowIndex` → `{ status, url }`). Old entries with no
  clip/overlay fields still load cleanly; we fall back to per-cell mount
  hydration for them.
- Even when the entry has these maps, BrollCell mount hydration still runs as a
  belt-and-braces second layer.

### Bundled localStorage — visible failure
- Catch block at [page.tsx:2562](src/app/(app)/production-doc/page.tsx#L2562)
  upgrades from `console.warn` to a `toast.warning` on first failure per
  session: "Session storage is full — generated assets may not survive a
  refresh. Use 'New Session' to clear old work." (Don't spam; track with a
  `useRef` flag.)
- Stripping the bundle: if total payload size > 4MB, drop `rowOverlays` (heavier
  due to base64-ish strings in `state.url`) before retrying so at least the doc
  + rowImages + rowVideoClips survive.

## Observability (rule 14)

- `[broll hydrate]` — every BrollCell mount-hydration. `{ rowIndex, signature, clipId, status }`.
- `[render preflight]` — pre-render check result. `{ missingClipCount, rowIndexes }`.
- `[render skipped-reload]` — user clicked "Render anyway" with missing assets.
- `[history restore]` — sidebar entry click. `{ entryId, hadClips, hadOverlays, hadImages }`.
- `[persist quota]` — first persist failure per session. One emit, then quiet.

## Settings (rule 15)

No new settings. This is reliability work, not UI features.

## Security / safety (rule 13)

- Three new optional persisted fields on the history entry (clips, overlays):
  optional records of typed values. No user-provided strings rendered as HTML.
- Pre-render verification fetches `/api/broll/{id}` — already auth-scoped by
  the existing route. No new attack surface.

## Cost (rule 8)

Zero. This is purely reliability — actually *saves* the user money by stopping
the silent asset loss.

## Out of scope (Phase 2, follow-up plan)

- Add a `production_doc_id` column to `broll_clips` and a corresponding filter
  to `/api/broll`. Update every clip-create callsite to pass the doc id.
- Mount-time DB hydration: on page mount, query
  `/api/broll?productionDocId={historyEntryId}` and populate `rowVideoClips`
  from the result. Same for overlays.
- Cross-device recovery: opening the doc on a different device pulls assets
  from the DB instead of relying on localStorage.

Phase 2 is the truly ironclad version. Phase 1 covers same-device refresh and
history-sidebar restore, which is the user's reported failure mode today.

## QA (rule 6)

Golden path:
1. Generate a doc with 5 rows. Generate a still + animate each row.
2. Hard refresh. Expect: every cell + row state intact, no toast.
3. Click Render → MP4 includes animations + no spurious overlays.

Edge cases:
1. Generate 3 of 5 row clips. Refresh. Open browser DevTools → manually delete
   `prodoc_last_result` from localStorage. Refresh again. Click Render. Expect:
   modal "3 clips generated but not loaded" → click Reload → state hydrates →
   render proceeds with animations.
2. Click a history sidebar entry. Expect: doc + rowImages + clips + overlays
   all restore. Render produces correct MP4.
3. Quota: write a junk 5MB string to localStorage, then mutate doc. Expect: toast warning.
4. Old history entry (no clip/overlay fields stored): restore. Expect: doc +
   rowImages load; cells then mount-hydrate from their own localStorage map and
   bridge to parent state (the bridge bug fix).

Regression checks:
- Existing render flow still works when nothing is missing (no modal shown).
- "Animate all" batch flow still pushes stubs through `handleBrollClipChange`.
- Existing `rowBatchStubs` adoption path in BrollCell still works (separate
  effect from mount-hydration).

## Files touched

- `src/components/production-doc/BrollCell.tsx` — mount-hydration bridge.
- `src/app/(app)/production-doc/page.tsx`:
  - `VideoPlayerMemo` accepts + passes alignment.
  - `startVideoRender` calls preflight; renders modal.
  - History restore re-includes clips + overlays.
  - Entry-write patches clips + overlays.
  - Quota toast on persist failure.
- `src/lib/history.ts` (or wherever `updateProductionDocEntry` is typed) — extend
  the entry type to include `rowVideoClips?: Record<number, string>` and
  `rowOverlays?: Record<number, { status, url }>`. Optional fields only, no
  migration needed.

New file:
- `src/components/production-doc/MissingClipsModal.tsx` — the pre-render
  verification UI.
