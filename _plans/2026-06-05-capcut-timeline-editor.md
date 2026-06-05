# CapCut-quality Timeline Editor — Plan

**Date:** 2026-06-05
**Status:** Awaiting sign-off
**Source ask:** "Cutting, trimming, splitting wherever I need on the timeline and resizing those pieces (shortening etc.) with dragging — extremely flawlessly, exactly like CapCut."

## Goals

Ship a timeline editor that lets the user manipulate the finished video produced by the pipeline — cut, trim, split, drag-resize — with CapCut-equivalent feel for those four operations. The editor edits the production-doc in place; the existing Remotion render path reads the edited fields and produces the final MP4.

## Constraints

- **Option A locked in by the user:** adopt [`@xzdarcy/react-timeline-editor`](https://github.com/xzdarcy/react-timeline-editor) (MIT, 70+ examples in docs, drag-to-trim + drag-to-move + grid/auxiliary snap built in). Split-at-playhead implemented on top.
- **Edit-state already exists** on `ProductionRow` (`trim_start_ms`, `trim_end_ms`, `duration_override_ms`, `pin_duration`, `muted`, `transition_in`) and is already read by `BRollScene` + `MotionScene`. The editor does not introduce a new render path; it just mutates these fields and the existing render reflects the edits.
- **Source of truth stays the production-doc.** No separate "edit project" table. Every timeline interaction maps to a `ProductionDoc` mutation persisted via the existing `updateProductionDocEntry()` flow.
- **Mounted on `/video-studio`** — the page already has the Remotion `<Player />` for preview. Editor lives below the player, the player auto-rerenders as the doc mutates.
- **CapCut-equivalent feel** for the four locked operations only. Not aiming for CapCut feature parity overall (no motion graphics editor, no titles editor, no audio mixer).
- **Performance budget:** drag-trim and drag-move stay under 16ms per frame at 100-row docs. Bundle adds ≤80KB gzipped.

## User flow

1. User opens `/video-studio` after a render produces a Remotion-playable production-doc.
2. Player at top shows live preview; updates as the user edits.
3. Below the player: timeline with one track per row category (video, voiceover, overlays — v1 is video only).
4. **Trim:** drag a clip edge to set `trim_start_ms` / `trim_end_ms`. Live preview reflects the change while dragging. Magnetic snap to playhead and to neighbouring clip edges.
5. **Drag-resize duration:** drag the clip body to scale `duration_override_ms`. Pins `pin_duration: true` so the auto-cascade doesn't fight the user.
6. **Split at playhead:** `S` key (or Split button) splits the clip under the playhead at the exact playhead time. Implemented as: clone the row, set the first row's `trim_end_ms` to playhead - rowStart, the second row's `trim_start_ms` to playhead - rowStart. Both rows pin duration.
7. **Cut (delete clip):** `Delete` key or context-menu Delete. Removes the row from the doc.
8. **Drag-move (reorder):** drag a clip horizontally to reorder. Wires into existing `reorderProductionDocState()`.
9. **Undo / Redo:** `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` via the existing production-doc history layer.
10. Hit "Render" → existing `POST /api/render/video` path → new MP4 reflects the edits.

## Architecture

### Data model — no schema migration

Every editor action maps to an existing ProductionRow field. No new columns, no new tables.

| Editor action | Mutates |
|---|---|
| Trim clip start | `row.trim_start_ms` |
| Trim clip end | `row.trim_end_ms` |
| Drag-resize duration | `row.duration_override_ms` + `row.pin_duration = true` |
| Split at playhead | New row inserted; `row.trim_end_ms` set on first half, `row.trim_start_ms` set on second half, both rows pin duration |
| Cut clip | Row removed from `doc.rows[]` |
| Drag-reorder | Row order in `doc.rows[]` (existing `reorderProductionDocState()`) |
| Toggle mute | `row.muted` |
| Cross-fade on transition | `row.transition_in = 'cross-fade'` |

Doc persistence: every mutation calls `updateProductionDocEntry(historyEntryId, { doc: nextDoc })` — same flow the row editor uses today. No new persistence layer.

### Files added

```
src/components/timeline-editor/
  ├── TimelineEditor.tsx                  — top-level, owns the <Timeline /> + playhead sync
  ├── timeline-data-adapter.ts            — pure: ProductionDoc ↔ TimelineRow[] + TimelineAction[]
  ├── timeline-mutations.ts               — pure: trim/split/cut/move helpers, return next ProductionDoc
  ├── timeline-keybindings.ts             — pure: keymap (S / Del / Cmd+Z / arrows)
  ├── TimelineClipCard.tsx                — custom getActionRender for clip visuals
  └── TimelineToolbar.tsx                 — play/pause, zoom in/out, snap toggle, render button
src/lib/timeline-editor/
  └── frame-math.ts                        — pure: ms↔seconds↔frame conversions tied to FPS
tests/
  ├── timeline-data-adapter.test.ts        — round-trip ProductionDoc ↔ timeline data
  ├── timeline-mutations.test.ts           — split/trim/cut/move correctness
  └── frame-math.test.ts                   — frame snap, ms rounding
```

### Files modified

- `src/app/(app)/video-studio/page.tsx` — mount `<TimelineEditor doc={doc} onDocChange={persistDoc} player={playerRef}/>` below the existing player.
- `package.json` — add `@xzdarcy/react-timeline-editor`.

### Wiring

```
                  ┌─────────────────────────────────┐
                  │     <Player />  (existing)      │
                  │     reads VideoConfig            │
                  └────────────────┬────────────────┘
                                   │ playheadTimeMs (state)
        ┌──────────────────────────┴──────────────────────────┐
        │              <TimelineEditor />                      │
        │                                                       │
        │   ProductionDoc ←─ timelineDataAdapter ─→ TimelineRow[]│
        │                                                       │
        │   user drags → onActionResizing → mutateRowTrim()    │
        │   user splits → S key → splitRowAtPlayhead()         │
        │   user reorders → onActionMoveEnd → moveRow()        │
        │                                                       │
        │   each mutation → updateProductionDocEntry()         │
        │   player reads updated doc → preview reflects edit   │
        └───────────────────────────────────────────────────────┘
```

### Frame-accurate scrubbing

Library uses seconds as float. Conversion layer in `frame-math.ts`:
- `msToSec(ms)` / `secToMs(sec)` / `msToFrames(ms, fps)` / `framesToMs(f, fps)`
- All `onActionResizing` callbacks snap to nearest frame: `snapMs = framesToMs(Math.round(msToFrames(rawMs, fps)), fps)`
- Default fps = 30 (matches existing Remotion compositions). Configurable in Settings.

### Snap behavior (the part that makes it feel CapCut-like)

Library exposes `gridSnap` and auxiliary line snap. We use both:
- **Grid snap:** snaps to frame boundaries (set `scaleSplitCount` so each subdivision is 1 frame at current zoom).
- **Auxiliary snap:** snaps to playhead and to adjacent clip edges (built into the library).
- **Snap distance:** 6 pixels by default (matches CapCut). User-configurable in Settings.

### Split-at-playhead

Not in the library; ~40 lines in `timeline-mutations.ts`:

```ts
function splitRowAtPlayheadMs(
  doc: ProductionDoc,
  playheadMsAbsolute: number,
): ProductionDoc {
  // 1. Find row under playhead by walking durations.
  const idx = rowIndexAt(doc.rows, playheadMsAbsolute);
  if (idx < 0) return doc;
  const row = doc.rows[idx];
  const rowStartMs = rowStartAt(doc.rows, idx);
  const localCutMs = playheadMsAbsolute - rowStartMs;
  if (localCutMs < FRAME_MS || localCutMs > rowDurationMs(row) - FRAME_MS) return doc;

  // 2. Clone row; first half gets trim_end_ms; second half gets trim_start_ms.
  const firstHalf: ProductionRow = {
    ...row,
    trim_end_ms: (row.trim_end_ms ?? 0) + (rowDurationMs(row) - localCutMs),
    pin_duration: true,
  };
  const secondHalf: ProductionRow = {
    ...row,
    trim_start_ms: (row.trim_start_ms ?? 0) + localCutMs,
    pin_duration: true,
  };
  const nextRows = [
    ...doc.rows.slice(0, idx),
    firstHalf,
    secondHalf,
    ...doc.rows.slice(idx + 1),
  ];
  return { ...doc, rows: nextRows };
}
```

Unit-tested for: cut at exact playhead, cut on a row with existing trim, cut at frame boundary edge cases.

## Alternatives considered + rejected

- **Build from scratch (Option B):** rejected by user. Estimated 4–8 weeks for CapCut polish.
- **Commercial SDK (Option C — Editframe / Shotstack):** rejected by user. Adds vendor lock and monthly cost.
- **Mount on production-doc page instead of video-studio:** rejected because video-studio already has the Player + render-kickoff button. Co-locating editor + preview is the canonical CapCut layout.
- **Audio-waveform on the timeline:** deferred to v2. v1 ships a single video track + a non-interactive voiceover indicator bar.

## Cost analysis (rule 8)

- **Library:** MIT, free. No subscription, no per-render fees.
- **Bundle:** ~60–80 KB gzipped (the library + our adapter). Lazy-loaded — the editor is dynamic-imported with `ssr: false` like the existing Player, so the landing page isn't penalised.
- **Per render:** zero — render still uses the existing `POST /api/render/video` Lambda/Vercel path. Editing produces no LLM or AI spend.
- **Engineering:** budget 5–8 days of focused work for the v1 covering the four locked operations + undo/redo. Polish for CapCut-feel parity (snap distance tuning, drag-latency optimisation, frame-perfect scrubbing) absorbs another 3–5 days. **Total: 8–13 days of focused work.**

## Security (rule 13)

- **Trust boundary:** the editor mutates a ProductionDoc that the user already owns. No new data flows in or out. The existing `updateProductionDocEntry()` is workspace-scoped via `session.ws`. We inherit that.
- **Render trigger:** unchanged — same `POST /api/render/video` route, same auth, same cost cap.
- **No new subprocess / no new external service.** No new attack surface.
- **Undo/redo storage:** lives in client-side state. Bounded buffer (50 entries default) so memory doesn't grow unbounded on long editing sessions.

## Observability (rule 14)

Namespaced logs on every editor action:

```
[timeline-editor trim]      { rowId, edge: 'start' | 'end', oldMs, newMs, fps }
[timeline-editor split]     { rowId, atMs, newRowIds: [a, b] }
[timeline-editor cut]       { rowId, durationMs }
[timeline-editor move]      { rowId, fromIndex, toIndex }
[timeline-editor resize]    { rowId, oldMs, newMs }
[timeline-editor undo]      { stackDepth, action }
[timeline-editor redo]      { stackDepth, action }
[timeline-editor save]      { historyEntryId, mutations: N, durationMs }
[timeline-editor render]    { historyEntryId, totalRows, totalDurationMs }
```

All to the existing `logger.info` channel — Vercel function logs + browser console (timeline lives client-side).

## Settings (rule 15)

New entries in the user's existing per-feature settings layer:

- `timeline.fps` — 24 / 30 / 60 (default 30, matches Remotion compositions)
- `timeline.snapPx` — 0 / 4 / 6 / 10 (default 6)
- `timeline.snapToFrames` — boolean (default true)
- `timeline.snapToPlayhead` — boolean (default true)
- `timeline.snapToClipEdges` — boolean (default true)
- `timeline.defaultCrossFadeMs` — 0 / 100 / 250 / 500 (default 0 — no auto cross-fade on split)
- `timeline.undoBufferSize` — 20 / 50 / 100 (default 50)
- `timeline.zoomDefault` — px per second (default 100)

Mounted in `Settings → Editor` (new sub-page). Reads via `getPref()` / writes via `setPref()` — same pattern as paint_explainer_v1 settings.

## Testing (rule 18)

**Unit (Vitest, hits 100% of the pure helpers):**
- `frame-math.test.ts` — ms↔frame conversions at 24/30/60 fps, frame-boundary snap
- `timeline-data-adapter.test.ts` — round-trip ProductionDoc ↔ TimelineRow[]; mute, trim, duration overrides preserved
- `timeline-mutations.test.ts`:
  - `trim()` — trim_start_ms / trim_end_ms set correctly, cannot trim past row duration
  - `splitRowAtPlayheadMs()` — exact cut, cut on row with existing trim, no-op at row edges, two halves cover the original duration
  - `cutRow()` — removes correct row, downstream indices unchanged
  - `moveRow()` — handles drag-left, drag-right, edge cases (drag to start, drag to end)
- `timeline-keybindings.test.ts` — keymap dispatches the right mutation

**Integration (manual QA gate before merge):**
- Drag-trim on a doc with 30 rows — observe the player reflecting the trim live
- Split-at-playhead on a row mid-clip — render the result, confirm MP4 has the cut
- Reorder 5 rows — confirm order persists, render reflects new order
- Undo 10 actions, redo 10 actions — state matches snapshot at every step
- Lambda render of a fully-edited doc — confirm trim/split/cut land in the final MP4

**Performance regression test:**
- Render a 100-row doc into the timeline — first paint <500ms, drag-trim frame budget <16ms (browser perf profiler).

## Open questions

1. **Undo/redo source** — do we extend the existing production-doc history layer or build a timeline-local stack? The existing history layer persists every mutation as a separate `user_history` row, which is expensive for fine-grained editor actions. **Default proposal:** client-side stack of 50 (configurable); ⌘+S or onBlur batches and persists the result via `updateProductionDocEntry()`.
2. **Voiceover track display** — non-interactive bar (just shows duration), waveform (looks better but ~30KB more bundle), or hidden in v1?
3. **Cross-fade on split** — default to 0ms (matches CapCut) or 100ms (smoother)? Configurable in Settings either way.
4. **Multi-select** — CapCut supports shift-click to select multiple clips and bulk-trim. v1 scope?
5. **Keyboard customisation** — fixed keys (`S`, `Del`, arrows) or user-configurable? Default: fixed for v1.

## Rollout

| Milestone | Estimate | Deliverable |
|---|---|---|
| M1 — Library spike + data adapter | 1 day | `npm install`, `<TimelineEditor />` mounted on `/video-studio` showing the doc's rows as clips. Read-only. |
| M2 — Trim + drag-resize wire-up | 1–2 days | onActionResizing → row.trim_start_ms / trim_end_ms persistence; player reflects the trim live |
| M3 — Split-at-playhead + cut | 1 day | `S` key splits; `Del` cuts; both round-tripped through render |
| M4 — Drag-reorder + transitions | 1 day | onActionMoveEnd → reorderProductionDocState; cross-fade toggle on transition_in |
| M5 — Undo/redo + keybindings + snap | 1–2 days | Cmd+Z/Cmd+Shift+Z stack of 50; arrow-key nudge; aux-line snap tuning |
| M6 — Settings + observability + polish | 1 day | Settings → Editor sub-page; all logs namespaced; performance regression test |
| M7 — Manual QA on a real rendered doc | 1 day | Drive the editor against a real channel-clone output, render, watch the MP4 |
| **Total** | **7–10 focused days** | v1 ready |

## Out of scope (v1)

- Audio waveform display + audio-track editing
- Per-clip volume keyframes, fade-in/out curves
- Title text editor (the V2.0 publish-pack already produces these as data)
- Color grading, filters, LUTs
- Multi-segment cross-fades (just on/off in v1)
- Mobile / touch interactions (desktop drag-only)
- Variable playback speed per clip (slow-mo, time-stretch)
- Picture-in-picture, multi-camera
- Real-time collaborative editing
- Auto-cut on silence detection
- Beat detection / music-synced cuts

These can land in v2 if v1 ships and proves the pattern.
