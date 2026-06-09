# 2026-06-08 — Editor crash recovery + render-loop hunt

## User report

> "Everytime I resize and other different edits, I get this error and
> need to restart everything I did from scratch!!! Why if there is an
> issue, it is losing all my work?!?!"

Screenshot: React minified error #185 ("Maximum update depth
exceeded") with a generic "Try Again" boundary that wipes local state.

## Two distinct problems

### A. Work loss on crash (FIXED in this commit)

Even if we never find the loop's root cause, losing every unsaved
edit on a transient React crash is unacceptable. The editor's auto-
save debounces 800ms after the last keystroke; everything edited in
that window vanishes on a crash because:

- The error boundary unmounts the editor tree and re-mounts from
  fresh props (server-loaded version).
- There's no localStorage mirror — only `editor:timeline:*` user
  preferences exist there, nothing about doc state.
- The `beforeunload` keepalive PATCH at use-editor-store.tsx:409 only
  triggers on tab close, not on a React error.

### B. The infinite render loop itself (still hunting)

Symptom: React error #185 (Maximum update depth exceeded). The
agent's first-pass hypotheses (`performSave` instability, inline
TransformOverlay callbacks, ResizeObserver) all check out — none of
them actually loops:

- `performSave` is `useCallback(..., [projectId])` and projectId is
  stable → callback is stable.
- TransformOverlay routes `onChange` / `onCommit` through refs
  (lines 161-168) specifically to defend against parent re-renders.
- `ResizeObserver` calls `setCanvasRect` only when dimensions
  actually change; React bails out on same-value setState.

The loop is somewhere else. Layer A protects work while we keep
hunting.

## Layer A — localStorage draft backup

### Storage model

`src/lib/editor/draft-storage.ts` (new) owns all reads / writes.
Pure helpers + thin localStorage wrappers, fully unit-tested at
`tests/draft-storage.test.ts` (13 cases).

Key: `editor:draft:<projectId>`. Value envelope:

```ts
interface DraftEnvelope {
  v: 1;
  savedAt: number;        // epoch ms
  baseVersion: number;    // server version the edits sit on top of
  payload: DraftPayload;  // same shape as `persistableFromState`
}
```

### Lifecycle

In `src/lib/editor/use-editor-store.tsx`:

1. **Write effect** — fires on every state change. When `isDirty`,
   serialises the persistable state into the envelope and writes
   synchronously. When `!isDirty` (initial load or after a successful
   PATCH), drops the entry so the next mount doesn't re-offer a
   superseded draft. The localStorage write happens BEFORE the next
   render can throw, so any React crash on that same tick preserves
   the just-dispatched edits.

2. **Mount-time recovery probe** — runs once. Reads the draft and
   calls `decideRecovery(draft, state.version)`:
   - `'restore'` (same baseVersion as server) → exposes
     `recoverableDraft` so the editor can show the banner.
   - `'stale'` (server moved past the draft while we were away) →
     clears the entry + logs.
   - `'none'` → noop.

3. **Accept / Discard handlers** — exposed from the hook:
   - `acceptRecoverableDraft()` dispatches a new `RESTORE_DRAFT`
     command that loads the payload AND flips `isDirty: true` so the
     next 800ms autosave persists it to the server.
   - `discardRecoverableDraft()` just clears the localStorage entry.

### Banner

`src/app/(app)/edit/[projectId]/EditorClient.tsx` renders a sticky
amber banner above the preview when `recoverableDraft !== null`,
with Restore / Discard buttons. Disappears the moment either action
fires.

### New store command

`RESTORE_DRAFT` shares its reducer case with `RESET_FROM_SERVER` —
identical payload load, with one difference:

```ts
isDirty: cmd.type === 'RESTORE_DRAFT',
```

That single line is the whole behaviour change.

## Why localStorage, not IndexedDB / SessionStorage / IndexedDB

- **Synchronous** — must complete before the next render tick can
  throw.
- **Survives reloads** — sessionStorage wouldn't.
- **Per-device, per-origin** — no cross-device leaks; no server
  trust.
- The 5 MB cap is plenty for any reasonable doc (the user's 274-row
  doc serialises to ~150 KB).

## Observability

New log namespaces:

- `[editor draft] recoverable draft detected` — mount-time probe.
- `[editor draft] discarding stale draft` — mount-time probe sees
  server has moved past.
- `[editor draft] accepting recovered draft` — user clicked Restore.
- `[editor draft] discarding recovered draft (user choice)` — user
  clicked Discard.
- `[editor draft] localStorage quota exceeded; crash recovery disabled`
  — pathological case, logged once per mount.
- `[editor draft banner] restored` / `[editor draft banner] discarded`
  — UI confirmation.

## Tests

`tests/draft-storage.test.ts` — 13 cases:
- `draftStorageKey` shape.
- `decideRecovery` truth table (restore / stale / none).
- Round-trip write→read.
- Per-project isolation.
- `clearDraft` removes.
- Malformed JSON / unknown schema version / missing doc → null.
- Quota exceeded → ok=false reason='quota' (no throw).

## Layer B — render loop hunt (FIXED 2026-06-09)

### Root cause

The loop's culprit was `@xzdarcy/react-timeline-editor`, the
`react-virtualized`-backed timeline library that `CapCutVideoLane`
mounts inside `TimelineV2`. The library's `<Timeline>` component runs
this effect (see `node_modules/@xzdarcy/react-timeline-editor/dist/index.es.js`
around line 9307):

```js
lr(() => {
  Te(Yl(c, { scale: S })), j(c);   // j === useState setter
}, [c, R, z, S]);                    // c === editorData
```

When the `c` (editorData) dep is a **new reference** on every parent
render, the effect fires per render, calls `j(c)` (setState), which
re-renders. The new render flushes another `editorData` reference
down (because `CapCutVideoLane`'s `useMemo` rebuilds on every
upstream dep ref change), which fires the effect again. Internally,
the library wraps Grid / MultiGrid / CollectionView from
`react-virtualized` — class components with ~14 `forceUpdate()` call
sites, each of which may re-enter the cycle. At 60+ ticks/sec,
React's max-update guard trips and throws #185.

### Trigger

`TransformOverlay`'s corner-drag (image resize) dispatches a
**transient** `PATCH_ROW` per pointermove with the new
`image_x_pct` / `image_y_pct` / `image_scale_pct` / `image_rotation_deg`
values. Transient skips the dirty flag but still updates `state.doc`,
which makes `videoConfig` rebuild (new `shots[]` reference), which
makes `CapCutVideoLane`'s `editorData` rebuild (new reference) —
even though none of the timeline-visible fields actually changed.
That's the new reference the library sees, and the loop starts.

The team's earlier mitigations (hoisting `style` / `onChange` to
module scope, ref-routing `playheadMs` / `selection`) were
**necessary but not sufficient**: they stabilized the leaf props
but left `editorData` itself rebuilding every tick. The
`buildEditorData` `useMemo` had `[config.shots, rowImages,
rowTransitions, rowTrims]` as deps — and EVERY one of those got a
new reference on every transient PATCH_ROW.

### Fix

A content-keyed cache for `editorData` in
`src/components/editor/timeline-v2/CapCutVideoLane.tsx`:

1. New pure helper `buildEditorDataSignature(shots, rowImages,
   rowTransitions, rowTrims)` returns a primitive string covering
   ONLY the fields the lane actually renders:
   `startMs`, `durationMs`, `shotKind`, `visualType`, `sceneType`,
   `videoUrl` presence (for the hasBroll flag), `rowImages[i]`,
   `rowTransitions[i]`, `rowTrims[i].trimStartMs/trimEndMs`.
2. Image-transform fields (`imageXPct`, `imageYPct`,
   `imageScalePct`, `imageRotationDeg`) are **deliberately
   excluded**. The timeline lane never reads them; including them
   would defeat the whole purpose.
3. `editorData` is computed via a `useRef`-backed cache keyed by the
   signature. Cache hit ⇒ return the same `LibRow[]` reference;
   cache miss ⇒ rebuild and update the cache.

Effect chain after the fix:

- TransformOverlay drag → transient PATCH_ROW → state.doc changes →
  videoConfig rebuilds → CapCutVideoLane re-renders → signature
  computed from primitive fields **is identical** → cached editorData
  reference returned → LibTimeline's `[c, R, z, S]` deps unchanged →
  effect does NOT fire → no setState → no forceUpdate cascade → no
  crash. ✓

### Observability

- `[capcut-video-lane editor-data] rebuild` logs ONLY on actual
  signature changes (timing / image assignment / trim / transition
  / shot kind moves). Silent during image-transform drags — the case
  this cache exists to absorb.

### Tests

`tests/capcut-video-lane-adapter.test.ts` — 13 new cases covering:
- Stable across re-built input references with identical content.
- **Stable across imageXPct / imageYPct / imageScalePct /
  imageRotationDeg changes** (the load-bearing case).
- Changes on insert / delete / duration shift / startMs shift /
  shotKind / visualType / image URL swap / transition flip / trim
  change / videoUrl toggle.
- Defensive: undefined trim/transition maps equivalent to empty
  objects; sparse `rowImages` is stable across re-renders.

### What this DOESN'T fix

- The 800ms autosave debounce window still loses **transient** drag
  values on a crash — Layer A's localStorage draft only mirrors
  `isDirty: true` state, and transient PATCH_ROW deliberately skips
  the dirty flag. With Layer B preventing the crash in the first
  place, that gap stops mattering for the reported failure mode.
  If a different crash class shows up later, we'd need to mirror
  transient state too (cost: ~60 writes/sec during drags).

## Out of scope

- Replacing the error boundary's "Try Again" with a localStorage-
  aware "Recover" flow. The next mount auto-detects the draft; the
  generic Try Again already works because it remounts the editor.
- Server-side draft sync (multi-device crash recovery). Single-
  device localStorage covers the reported case; cross-device is a
  larger project.
