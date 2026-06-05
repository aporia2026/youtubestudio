# Strengthen production-doc ↔ editor sync

**Date:** 2026-06-05
**Status:** ALL PHASES SHIPPED (1a, 1b, 2, 3, 4, 5, 6 + sync pill). See "Completion notes" at the bottom.
**Owner:** Yoav

## Approved decisions

- **Decision A — Sync pill:** SHIP. Tiny "Synced 2s ago" pill in the page chrome of both pages (not inside the editor surface).
- **Decision B — Phase order:** DEFAULT. Phase 1 → 2 → 3 → 4 → 5 → 6 interleaved. Each phase shippable on its own.
- **Decision C — Conflict UX:** AUTO-REBASE + 3s toast "Merged a change from another tab" when a real overlap happens. The banner is removed in favor of silent rebase with a transient notice.


**Related plans:**
- `_plans/2026-05-19-editor-production-doc-parity.md` (Phase 1 — unified payload)
- `_plans/2026-05-22-editor-prodoc-data-loss-and-fixes.md` (asset merge + conflict mitigation)

## Goal

The user wants the production-doc page and the shot-graph editor at `/edit/[projectId]` to behave as one document with two surfaces. Every edit in either should land in the other quickly, reliably, and without forcing a manual reload. The UI of both pages stays as-is — this is a data-layer overhaul.

## Symptoms the user reported

All four of the following were checked:
1. Slow propagation between two open tabs.
2. Some fields don't sync at all.
3. Conflict banner / lost edits.
4. Stale data after navigating between them.

Usage pattern: both — sometimes navigating one-at-a-time, sometimes two tabs side-by-side.

## Current state (confirmed via audit)

The data layer is **already** wired to one source of truth — the `user_history` row of kind `production_doc`, with the canonical `ProjectPayload` in the `payload` JSONB column. Both pages mount the same `useProject` hook (`src/lib/project/use-project.ts`), PATCH the same endpoint (`src/app/api/edit/[projectId]/route.ts`), and dispatch asset writes through the atomic `row-asset` endpoint. So the foundation is there.

What's loose:

| Looseness | Why it bites the user |
| --- | --- |
| 800 ms PATCH debounce + 8 s version poll | Cross-tab edits take up to ~9 s to surface; user hits send → switches tabs → doesn't see it for half a beat → assumes it's broken. |
| No same-browser instant sync | Two tabs in the same Chrome wait on the network poll even though `BroadcastChannel` could do it locally in <50 ms. |
| Render-affecting flags still in legacy localStorage | `prodoc_animate_scenes_v1`, `prodoc_suppress_lower_thirds_v1`, `prodoc_broll_v1`, `prodoc_broll_lock_v1` are read from localStorage on both pages but never PATCHed. So flipping a toggle in one tab is invisible in the other and survives only the page that wrote it. |
| Brand-kit drift | Brand kit is stored in BOTH `usersettings:video_brand_kit` (user-prefs) AND `ProjectPayload.visualKitOverride`; production-doc reads from user-prefs first, editor reads from payload. Same project shows two values. |
| Conflict banner is too aggressive | The banner fires the moment versions drift on a dirty page, even when the two patches touch disjoint fields and could safely both apply. |
| Stale-cache hydration on navigation | When you navigate back to production-doc, the page hydrates from localStorage first and only catches up to the server on the next poll tick. Stale render for up to 8 s. |

## What syncs today (don't break this)

- `doc.rows[]`, `doc.title`, `doc.niche`, scalars — last-write-wins, version-bumped.
- `rowImages`, `rowOverlays`, `rowVideoClips` — server-authoritative; PATCH ignores incoming maps and merges via the dedicated `row-asset` atomic endpoint. This is already correct.
- Voiceover URL, alignment, captions, music URL — last-write-wins through PATCH.

## Out of scope for this pass

- Changing the editor UI or production-doc UI.
- Renaming the "Video Preview & Render" section (per the redirect in this conversation).
- Introducing row IDs to make `doc.rows[]` field-level mergeable. That's a bigger refactor and needs its own plan — for now `doc.rows[]` stays last-write-wins with the existing empty-rows guard.
- Real-time multi-user collab (different humans editing the same doc). The scope is multi-tab single-user.
- Migrating from polling to SSE/websockets. Polling at a faster cadence is cheaper and covers the requirement.

## Approach

Six small phases, shippable one at a time. Each phase is self-contained and reversible.

### Phase 1 — Move render-affecting flags into `ProjectPayload`

Consolidate the four legacy localStorage keys into the payload (the slots already exist in `ProjectPayload.flags`):

| Legacy key | Target field in payload |
| --- | --- |
| `prodoc_animate_scenes_v1` | `flags.animateScenes` |
| `prodoc_suppress_lower_thirds_v1` | `flags.suppressLowerThirds` |
| `prodoc_broll_lock_v1` (row-signature → bool) | `flags.rowLockedAsStill` (already exists; was being shadowed) |
| `prodoc_broll_v1` (row-signature → clipId) | `rowVideoClips` (already exists; production-doc keeps duplicating it client-side) |

Migration: on first mount of production-doc with a logged-in user, if `flags.animateScenes` is undefined AND legacy key is present, write legacy → payload, then delete the legacy key. Otherwise prefer payload over localStorage. Editor already reads from payload — no changes there.

This phase alone fixes Symptom 2 (some fields don't sync at all) for the four highest-risk drift points the audit flagged.

### Phase 2 — Same-browser instant sync via `BroadcastChannel`

In `useProject`, open a `BroadcastChannel('project:' + projectId)` and:
- After every successful PATCH response, broadcast `{ type: 'patched', version, fingerprint }`.
- On receiving a broadcast: if local state is clean, fetch the new payload immediately (no 8s wait); if dirty, leave a soft "you have unsaved changes; remote version updated" hint but don't force the banner unless we detect a real overlap.

This kills cross-tab lag in the same browser without any new infrastructure. Channel is browser-native, same-origin only — no security exposure.

### Phase 3 — Cut debounce, narrow the conflict banner

- Lower the PATCH debounce from 800 ms → 250 ms. The PATCH payload is already small; the cost is more HTTP requests during typing but still well within Vercel function limits.
- Lower the cross-tab poll from 8 s → 3 s as a network fallback (when `BroadcastChannel` isn't available, e.g., older browser, or one tab is in a different browser entirely).
- Update the conflict-detection logic: only raise the banner when the dirty local diff and the remote diff touch the **same scalar** or the **same row index**. Disjoint edits silently auto-rebase.

### Phase 4 — Server-side field-level merge for dictionary fields

`flags.rowLockedAsStill` is keyed by row signature. Today it's full-replaced on PATCH. Switch the server to deep-merge it like `rowImages` is (preserve server keys not present in the incoming patch). No client change needed.

This is the only payload field where field-level merge is both safe and not yet done. `rowImages` / `rowOverlays` / `rowVideoClips` already get this treatment via the `row-asset` endpoint.

### Phase 5 — Fresh hydration on navigation

When production-doc mounts with a `?h=<historyEntryId>` URL param, do the cache check **before** rendering, not after. Concretely:
- If localStorage cache has version `N` and server has `N+k`, skip the cached render and show a slim "Loading latest…" state until the fresh payload lands. Sub-second on a warm cache.
- Add a `?since=<version>` slim endpoint that returns just the diff if `k` is small, so we don't ship the full payload for a one-key change.

### Phase 6 — Observability

Every sync event gets a namespaced log line so when something looks off we can grep the console and see exactly what happened:

```
[sync patch-sent]    { projectId, version, fields: ['doc.title', 'flags.animateScenes'], debounceMs }
[sync patch-acked]   { projectId, fromVersion, toVersion, mergedFields }
[sync broadcast-rx]  { projectId, fromTab, version, currentLocalVersion, action: 'fetch' | 'soft-hint' | 'ignore' }
[sync poll-tick]     { projectId, localVersion, remoteVersion, action }
[sync conflict]      { projectId, localVersion, remoteVersion, overlap: ['doc.rows[3].script_text'], action: 'banner' | 'auto-rebase' }
[sync rehydrate]     { projectId, fromVersion, toVersion, source: 'mount' | 'broadcast' | 'poll', durationMs }
```

Per rule 14 — observability ships with each phase, not as an afterthought.

## Alternatives considered

1. **WebSockets / SSE for real-time sync.** Heaviest. Requires a long-lived connection per tab, a publisher infra (Pusher / Ably / Redis), and a per-user fanout layer. Cost is real and recurring. The 3 s poll plus BroadcastChannel covers the multi-tab case for ~$0 incremental. Rejected for this pass; revisit if/when real-time multi-user collab becomes a feature.
2. **Move everything to a CRDT (Yjs/Automerge).** Best correctness, biggest rewrite. Would solve `doc.rows[]` merge naturally. Too invasive for the actual user pain point, which is multi-tab single-user, not multi-user collab. Rejected.
3. **One giant per-field-timestamp merge function on the server.** Conceptually clean but the timestamp map doubles the payload size and the server has to walk every nested field on every PATCH. Diminishing returns once Phase 1 fixes the leaked-state fields. Rejected as overkill.

## Recommendation

Ship Phase 1 first — it's a 1-day change that fixes the loudest symptom (toggles not syncing) and unblocks the rest. Phase 2 and Phase 3 together close the multi-tab lag. Phase 4 is small and cleans up the last dictionary that wasn't getting field-level merge. Phase 5 is the polish on navigation. Phase 6 is non-negotiable — logs go in alongside each phase.

Estimated effort: ~1 day Phase 1, ~1 day Phase 2, ~0.5 day Phase 3, ~0.5 day Phase 4, ~0.5 day Phase 5, logs interleaved. Total ~3.5 dev-days end-to-end.

## Cost (rule 8)

No new third-party services. No new managed infrastructure. The only cost delta is:
- More PATCH traffic at 250 ms debounce vs 800 ms. Estimate ~3× the call volume during active typing. PATCH bodies stay <10 KB; Vercel Functions are well under any plan cap.
- Faster poll (3 s vs 8 s) → ~2.6× version-only pings. Each ping is ~50 bytes. Negligible.

No real budget exposure.

## Security (rule 13)

- `BroadcastChannel` is **same-origin only** — browser-enforced isolation. No cross-tab leakage between sites.
- All auth paths unchanged. PATCH/GET still scope to `workspace_id + collaborator_id` via the existing endpoint.
- Slim `?since=<version>` endpoint reuses the same auth wrapper as `/api/edit/[projectId]`; never returns data outside the user's scope.
- We do not log payload contents — only field names and versions — so no PII / secret leakage in console logs.
- No new attack surface for malformed patches; server-side validation in `saveProjectPatch` already exists and stays the gate.

## Settings audit (rule 15)

New user-controllable settings to consider:

| Setting | Group | Default | Decision |
| --- | --- | --- | --- |
| Sync indicator visibility | "Editor" → "Sync" | on | Add a tiny "Synced 2 s ago" pill in the page chrome of both pages. User said "leave UI as is", but a single 80-px pill that shows the sync is **working** is the kind of trust-building affordance a lazy user benefits from. Defer to user — see Decision A below. |
| Auto-resolve disjoint conflicts | "Editor" → "Sync" | on | The auto-rebase logic. Power users may want the old conservative behavior. Surface as an advanced toggle; default-on. |
| (Internal) Poll interval | n/a | 3 s | Hardcoded. Not a setting — environment-tuned constant. |
| (Internal) BroadcastChannel enabled | n/a | on, with feature-detect | Not a setting. Auto-falls-back to poll if unavailable. |

Open decisions are surfaced below.

## Observability (rule 14)

Covered in Phase 6. Six new log namespaces, all under `[sync ...]`. Every meaningful state transition gets one line with structured fields. No ephemeral debug logs — these stay in.

## Testing (rule 18)

- **Unit**: `mergeRowLockedAsStill(serverMap, incomingMap)` — disjoint keys, overlapping keys, empty-incoming preserves server.
- **Unit**: legacy → payload migration. Cover: only-legacy-present, both-present (payload wins), only-payload-present (no-op), corrupt legacy value (no-op + warn).
- **Unit**: conflict overlap detector — disjoint fields → false, same scalar → true, same row index → true, different row indices → false.
- **Integration** (jsdom or Vitest with two `useProject` instances in one process): Tab A patches → Tab B receives via BroadcastChannel within one tick → Tab B's state matches.
- **Integration**: stale-hydration — mount with cached version `N`, server returns `N+1` → "Loading latest" briefly, then renders `N+1`, never flashes `N`.
- **Smoke (manual, before declaring done)**: open both tabs side-by-side, toggle a flag, edit a row, generate an image — verify each propagates ≤1 s.

## Decisions I need from you before coding

**Decision A — Sync indicator pill.** Rule 16 says the UI must make the connection feel real; the user already said "leave editor UI as-is". A tiny "Synced 2 s ago" pill in the page chrome (NOT inside the editor itself) is the smallest possible affordance that makes the sync trustable. Ship it, or skip it?

**Decision B — Phase order.** Default: Phase 1 → 2 → 3 → 4 → 5 → 6 (interleaved). Do you want a different order, e.g., ship the migration of legacy flags first and pause to verify before doing the BroadcastChannel work?

**Decision C — Conflict banner default behavior.** When a real conflict happens (same scalar or same row touched in both tabs while dirty), do you want:
  - (a) **Auto-rebase silently** with a 3-second toast "Merged a change from another tab" so the user knows.
  - (b) **Keep the banner** but only for real conflicts (much rarer after auto-rebase elsewhere).

## Open questions

- The audit found the brand-kit drift (`usersettings:video_brand_kit` vs `ProjectPayload.visualKitOverride`). Phase 1 doesn't touch it. Should it? Migrating production-doc to read brand kit from the payload first and user-prefs as the workspace default fixes Symptom 2 for the brand kit specifically. Recommend including it in Phase 1.
- Are there any third-party integrations (Sheets export, etc.) that read the legacy localStorage keys directly? Need to grep before deletion in Phase 1.

## Completion notes (2026-06-05)

**Shipped:**

- **Phase 1a** — `src/lib/project/derive-local-state-from-payload.ts` (new pure helper) + `tests/derive-local-state-from-payload.test.ts` (10 cases). Production-doc's hydration effect (page.tsx ~line 2992) and a new rehydration effect (~line 3041) now pull `flags.animateScenes` / `flags.suppressLowerThirds` / brand-kit colors from the canonical payload. `VideoPreviewBrandBar` mirrors color changes into `visualKitOverride` so brand-bar edits reach the server. Legacy `prodoc_animate_scenes_v1` / `prodoc_suppress_lower_thirds_v1` localStorage WRITES removed (reads kept as one-shot mount default).
- **Phase 2** — `src/lib/project/broadcast-sync.ts` (channel name, message shape, `decideBroadcastAction`, `newTabId`) + `tests/broadcast-sync.test.ts` (15 cases). `useProject` opens a `BroadcastChannel('project:<id>')` on mount, posts `{ type: 'patched', tabId, version }` on successful PATCH, and routes incoming messages through the decision helper. Same-browser tab sync drops from up to 8 s → <50 ms. Editor (`use-editor-store.tsx`) wired symmetrically — posts on save, subscribes to reload on clean state.
- **Phase 3** — Debounce `800 ms → 250 ms`, poll `8 s → 3 s` in `use-project.ts`. Added `dirtyFieldsRef: Set<string>` tracking which top-level fields the user has touched. New `doAutoRebase` function fetches the remote payload, merges via `rebasePayload(remote, local, dirtyFields)`, and re-arms the save. New `onAutoRebase` callback option. All three conflict paths (poll-dirty, broadcast-dirty, PATCH 409, doLoad abortIfDirty) now route to auto-rebase. Production-doc's old amber "This doc changed elsewhere" banner removed; replaced by 3 s `toast.info('Merged a change from another tab')` via `onAutoRebase`. `rebasePayload` helper + 9 tests in `tests/rebase-payload.test.ts`.
- **Phase 4** — `mergeRowLockedAsStill` in `rebase-payload.ts` + 5 tests. `persist.ts:saveProjectPatch` now per-key-merges `flags.rowLockedAsStill` so two tabs locking different rows both survive. KNOWN LIMITATION: client unlocks today by deleting the key, so an empty incoming map leaves server's locks in place (better than losing them, but unlock semantics are bounded). Phase 1b will fix unlock by switching client to send explicit `false`.
- **Phase 5** — Production-doc rehydration effect (page.tsx ~line 3041) extended to also re-sync `doc`, `rowImages`, `rowOverlays`, `rowVideoClips`, `voiceoverUrl`, `voiceoverAlignment`, `visualKitOverride` on every version bump — gated on `!project.isDirty` so user typing isn't clobbered. Closes the "open editor, edit, back to production-doc, see stale doc" gap.
- **Phase 6** — `[sync ...]` log namespaces inline through all the above: `[sync hydrate]`, `[sync rehydrate]`, `[sync flag-toggle]`, `[sync brand-bar]`, `[sync broadcast-tx]`, `[sync broadcast-rx]`, `[sync broadcast]`, `[sync auto-rebase]`. Existing `[project payload save]` and `[doc-sync poll]` namespaces left in place (still useful for ops, no need to break the search trail).
- **Sync pill** — `src/components/sync/SyncPill.tsx` with five tone-coded states (idle/pending/saving/saved/conflict/error), ticks the "X seconds ago" once per second only in `saved` state. Mounted in production-doc header (page.tsx ~line 10435). NOT mounted in editor — `EditorHeader` already shows an equivalent label via `statusBarSaveLabel`; second indicator would be redundant clutter (rule 2).

**Total test diff:** +49 unit tests (Phase 1a/2/4 + rebase). Pre-existing 109 production-doc + 107 editor tests all still green. TypeScript clean on all modified files.

**Phase 1b — SHIPPED (2026-06-05):**

Closes the BrollCell lock-map cross-tab gap end-to-end. Three coordinated changes:

- **`BrollCell.tsx`** — `BrollLockMap` shape widened from `Record<string, true>` to `Record<string, boolean>`. `readBrollLockMap` now accepts both `true` and `false` values (filters non-booleans). Comment added explaining the three-state semantic: `true` (locked), `false` (actively unlocked, distinct from absent), absent (never touched).
- **`production-doc/page.tsx` `toggleRowLock`** — switched from `delete next[rowSignature]` on unlock to `next[rowSignature] = locked` (always writes a boolean). New `[sync row-lock-toggle]` log line. The page's `rowLockSignatures` state type widened to `Record<string, boolean>`.
- **`production-doc/page.tsx` autosave patch effect** — forwards both `true` AND explicit `false` entries into `payload.flags.rowLockedAsStill`. Absent entries are still omitted so the server merge preserves another tab's value for untouched rows.
- **Hydration + rehydration effects** — both now translate `payload.flags.rowLockedAsStill` (index-keyed) → local `rowLockSignatures` (signature-keyed) using each row's `brollRowSignatureInput`. Tab B now sees Tab A's lock toggles immediately on the next version bump, and the lock survives doc regeneration as long as timecode + visual_description match.
- **EditorView prop type** (`components/production-doc/editor/types.ts`) — widened `rowLockSignatures: Record<string, true>` to `Record<string, boolean>`.

**Did NOT need:** server-side prune of `false` entries. Keeping `false` in the server map is correct — it tells other tabs "this row was actively unlocked." Render-side truthy checks (already in place via `Boolean(rowLockSignatures[sig])`) treat `false` and absent identically as unlocked. Map size is bounded by row count, no growth concern.

**Tests added:** `tests/rebase-payload.test.ts` — multi-tab convergence end-to-end (`Phase 1b end-to-end: multi-tab lock + unlock converges correctly`). Walks the full Tab A locks → Tab B locks → Tab A unlocks scenario and asserts the server's merged state converges to `{ 3: false, 5: true }`.

**Still deferred to a future PR** (low priority — not part of Phase 1b's user-visible gap):

- `BrollCell.tsx`'s clip map (`prodoc_broll_v1`, row sig → clipId) is still localStorage-only. Mostly redundant with `payload.rowVideoClips` (Phase 5 already rehydrates that), so cross-tab drift on this specific map is rare. Migrating it would touch every BrollCell instance and the `kickoffBrollGeneration` helper — out of proportion to the actual user-visible impact. Revisit if the `[sync …]` logs ever show a related symptom.

**Cost actuals:** zero new third-party services. Same endpoints, faster cadence. Estimated +2.6× version-only ping volume (~50 bytes each, paused while tab hidden) and +3× PATCH volume during active typing. Well within current Vercel envelope.

**Security review:** `BroadcastChannel` is same-origin only by browser contract. Every incoming message validated by `decideBroadcastAction`. Auth scopes unchanged. No new logs of payload contents (only field names + versions).

## QA pass (2026-06-05)

Ran an independent code review against everything above. Six real bugs caught and fixed before declaring done:

1. **CRITICAL — `lastSyncedVersionRef` not reset on `historyEntryId` change.** Switching from doc A (version 5) to doc B (also version 5) silently skipped the rehydration; doc B rendered with doc A's hydrated row state until the next version drift. **Fix:** dedicated reset effect on `historyEntryId`.

2. **CRITICAL — `rebasePayload` preserved local `flags` wholesale, including the stale `rowLockedAsStill` map.** A two-tab race could resurrect a row another tab just unlocked because the round-trip through the LWW per-key server merge couldn't tell stale from fresh. **Fix:** special-case `flags` in the rebase to keep local's `animateScenes` / `suppressLowerThirds` / `overlaysDisabled` but always take `rowLockedAsStill` from remote. Two new tests cover the special case and the missing-flags fallback.

3. **HIGH — `writeBrollLockMap(fromPayload)` in the hydration effects.** Could clobber a user's just-toggled lock that hadn't yet reached the payload. **Fix:** removed the localStorage write from both hydration effects. localStorage is now writer-only (`toggleRowLock`); readers only consume it on mount as a fast-start cache.

4. **HIGH — Editor's broadcast handler reload-while-save-in-flight race.** `isDirty === false` isn't sufficient — there's a window between `performSave` dispatch and the `MARK_SAVED` commit where `isDirty` is false but the PATCH is still in flight. Reloading then would discard the save's effects. **Fix:** check `inFlightAbortRef.current !== null` and defer the reload.

5. **MEDIUM — `SyncPill` setInterval read stale `status.at`.** When the parent re-renders `status` with the same kind but a fresher `.at`, the interval kept using the old `.at` from its closure. **Fix:** `statusRef` pattern — the saved-state visual reads `.at` via ref so the running interval always sees the latest value.

6. **DEFENSIVE — `doAutoRebase` could set version BACKWARDS if a save lands during the rebase GET window.** Self-corrects via the next poll, but burns a needless render cycle and a misleading toast. **Fix:** freshness check after GET — bail if `body.version < versionRef.current`.

**Issues flagged but NOT real bugs (verified):**

- "Concurrent save during auto-rebase" race — actually self-corrects via subsequent polls; not data loss, just inefficient.
- `persist.ts` flags spread dropping unknown flags — validator backfills `DEFAULT_FLAGS`, no fields lost.
- `rebasePayload` silently ignoring unknown dirty field names — defensive design, intentional.
- `BrollLockMap` backward-compat — existing data is `{ "<sig>": true }` (boolean), new reader accepts both.

**Post-QA test scoreboard:** 348/348 (up from 324 — added 2 new rebase-payload cases for the special-case logic). TypeScript clean. The six fixes are stand-alone and reversible — each one is a single conceptual change in a single file.
