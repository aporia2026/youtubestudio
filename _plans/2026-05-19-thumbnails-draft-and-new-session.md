# Thumbnails — full-page draft auto-save + New Session button

**Date:** 2026-05-19
**Page:** `/thumbnails`

## Problem

The thumbnails page is a heavy editor: title, niche, script, description, format choice (free-form / topic-card-grid / n-levels), reference image, format-specific settings (N Levels count, level list, per-slice accent colors with lock states, bottom title bar settings, image model, picked labels), and an editable mid-flight level list before render. A page refresh blows almost all of it away.

The existing `WorkflowDraft` system (`src/lib/drafts.ts`) only persists `title / niche / modelId` for the thumbnails step. Everything else is local React state that dies on refresh.

There is also no "New Session" affordance: the only way to start fresh is to manually wipe every field, which is hostile to the lazy-user bar (rule 10).

## Goal

1. Every meaningful piece of in-progress work on `/thumbnails` survives a refresh (auto-save).
2. A prominent "New Session" button resets the page to a clean slate, confirming first if there's unsaved work.

## Scope

**In scope:**
- Persist all form inputs (title, niche, script, description, model, image model, format choice, reference image, text overlay settings, picked labels, schedule context).
- Persist the in-progress N Levels state: count, level list (labels, illustrations, accent colors, lock states), bottom title bar settings, mode, image model, refined topic, notes, prefilled labels.
- Persist the in-progress Topic Card Grid state too (mirroring N Levels).
- Auto-save on input change (debounced ~500ms).
- Hydrate from the active draft on mount, before first paint where possible.
- "New Session" button that resets all state + deletes the active draft, with confirm-before-destroy.
- Tiny status indicator (`Saved` / `Saving…` / `Draft restored`).

**Out of scope:**
- Thumbnail history (already exists — `HistoryPanel` slide-out drawer, with restore + per-entry delete + clear all).
- Multi-draft switching UI on this page (the existing `DraftsBanner` covers cross-page draft switching).
- DB sync of the new thumbnail state (the existing draft endpoint already round-trips the full draft object; we ride on that without changes).

## Chosen design

### Storage: extend `WorkflowDraft` with one nested object

Add a single optional field `thumbnailsState?: ThumbnailsDraftState` to `WorkflowDraft`. Backwards-compatible (old drafts without the field hydrate to empty). Stays attached to the existing draft ID, so a draft started on the Script page picks up its thumbnail state continuously and DB-syncs through the existing endpoint.

The alternative (separate localStorage key per page) was rejected because it would fragment the model: a draft would no longer be one object, and cross-device sync would need a new endpoint.

```ts
// src/lib/drafts.ts
export interface ThumbnailsDraftState {
  // Top-level page state
  description?: string;
  imageModel?: string;
  format?: 'free-form' | 'topic-card-grid' | 'n-levels';
  imageGenEnabled?: boolean;
  showImageSection?: boolean;
  showScript?: boolean;
  referenceImageUrl?: string;
  refPreviewUrl?: string;
  textOverlay?: TextOverlayConfig;
  pickedLabels?: string[];

  // N Levels editor snapshot (mid-flight, before image render)
  nLevels?: {
    count: number;
    showBottomTitle: boolean;
    showLevelLabels: boolean;
    titleTopic: string;
    titleTagline: string;
    taglineEnabled: boolean;
    formatMode: 'review' | 'pre-fill' | 'one-shot';
    prefilledLabels: string;
    imageModelId: string;
    levels: FormatLevel[] | null;
    refinedTopic: string;
    notesForImageModel?: string;
  };

  // Topic Card Grid editor snapshot
  topicCardGrid?: { /* mirror shape */ };
}
```

Title, niche, script, modelId continue to live on the top-level `WorkflowDraft` (existing fields).

### Auto-save mechanism

A new hook on the page: `useThumbnailsDraftAutosave({ activeDraftId, state })`.

- 500ms debounce on the full state snapshot.
- Calls `saveDraft({ id: activeDraftId, title, niche, step: 'thumbnails', thumbnailsState: snapshot, ... })`.
- Skip empty-state writes (don't create a draft for a page with zero input).
- Emits `[thumbnails draft] saved` log with summary keys (has_script, has_reference, n_levels_count, etc.) per rule 14.

### Hydration

On mount, if `getActiveDraft()` returns a draft with `thumbnailsState`, set every piece of state from it BEFORE the first user interaction.

- Already-restored top-level fields (title/niche/modelId) keep their existing hydration path.
- `nLevelsResult` and `formatResult` (the rendered-image results) are NOT in the draft — those go to history. If the user wants to bring back a rendered thumbnail, they restore from the history sidebar.

### New Session button

Placement: top-right of the page header, next to "Saved" indicator. Small button, neutral styling, not red (it's a normal everyday action, not a danger zone).

Behavior:

```ts
function startNewSession() {
  const dirty = !!(title || niche || script.trim() || description.trim() || referenceImageUrl ||
                   nLevelsResult || formatResult || result || levels);
  if (dirty && !confirm('Start a new session? This clears the current draft. Generated thumbnails stay in history.')) {
    return;
  }
  if (draftId) deleteDraft(draftId);
  setDraftId(null);
  setActiveDraftId(null);
  // Reset every piece of state...
  resetAllPageState();
  toast.success('New session started.');
}
```

The confirm is intentionally word-for-word about what's preserved (history) so the user is never afraid to click.

### Status indicator

Three states next to the New Session button:
- `Saved · 2s ago` (default, after successful save)
- `Saving…` (during debounce + write)
- `Draft restored` (on mount, fades to `Saved` after 2s)

Tiny text, muted color. Clickable to expand to show last-saved timestamp.

### Settings audit (rule 15)

No new settings layer. Auto-save is on by default and isn't optional. The confirm-before-clear is always on (no setting to disable it — destroying work without confirm fails the lazy-user bar).

A future "default to clearing without confirm" toggle could land in app settings, but premature for v1.

### Security (rule 13)

- No new endpoints. Rides on existing `/api/drafts` POST and DELETE.
- Reference image URLs are stored as strings, already validated server-side at fetch time.
- localStorage scope envelope (already in place via the drafts module) prevents cross-account leak on shared browsers.
- Keepalive size cap (~64KB): script + level list is well under. Will log a warning + truncate `script` to 50KB if ever needed (defensive; unlikely to hit).

### Observability (rule 14)

New log lines:
- `[thumbnails draft] hydrated` — on mount, with summary of restored fields.
- `[thumbnails draft] saved` — on each debounced write, with snapshot summary.
- `[thumbnails draft] save failed` — on save error.
- `[thumbnails new-session]` — when user clicks the button, with `was_dirty: bool`.

## Implementation order

1. Extend `WorkflowDraft` in `src/lib/drafts.ts` with `thumbnailsState` field + `ThumbnailsDraftState` interface.
2. Add `useThumbnailsDraftAutosave` hook (or inline `useEffect` with debounce) in the page.
3. Add mount-time hydration that reads `thumbnailsState` and populates all relevant React state.
4. Add the New Session button + status indicator in the page header.
5. Update `resumeDraft` (already exists) to also hydrate `thumbnailsState` so resuming from the cross-page Drafts banner works.
6. QA pass.

## QA plan

- Type a title + script + pick a format + click + color on a slice + lock it → refresh → everything is back including the lock state.
- Refresh mid-edit (after Step 1 level list but before render) → editable level list is restored verbatim.
- Click New Session with dirty form → confirm dialog appears → cancel keeps state intact.
- Click New Session with clean form → no dialog, instant reset.
- Click New Session → all fields cleared, draft deleted, `getActiveDraftId()` returns null.
- Resume a draft from the cross-page DraftsBanner → thumbnails-specific state hydrates too.
- Two browser tabs on /thumbnails → both write to the same draft; last-write-wins is fine for v1 (no collaborative editing).
- Open thumbnail history → restore an old entry → existing restore path still works (it should overwrite the draft state cleanly).

## Out of scope (intentionally)

- Multi-draft management UI on this page.
- Conflict resolution when two tabs save the same draft.
- Cloud-only mode (no localStorage fallback).
- Auto-save indicator with click-to-see-diff history.
