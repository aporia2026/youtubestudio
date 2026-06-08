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

## Layer B — render loop hunt (deferred)

I've ruled out the obvious suspects. The next steps require live
runtime evidence the user can capture:

1. With the dev React build installed, the full unminified message
   will name the exact component + setState call.
2. The user can paste the stack trace from the error boundary.

Until then, Layer A keeps work safe. Layer B fix lands as a separate
commit.

## Out of scope

- Replacing the error boundary's "Try Again" with a localStorage-
  aware "Recover" flow. The next mount auto-detects the draft; the
  generic Try Again already works because it remounts the editor.
- Server-side draft sync (multi-device crash recovery). Single-
  device localStorage covers the reported case; cross-device is a
  larger project.
