# Prevent Production-Doc Silent Loss

**Date:** 2026-06-04
**Driven by:** real user data loss this morning — a 180-row CIA doc with 20 generated images, gone permanently. Recovery search found the script in `script_history` but no trace of the production doc in the server's `user_history` table or in any client cache. The doc had lived only in page-state memory until a navigation killed it.

## What happened (verified post-mortem)

1. User generated "The CIA Mind Control Iceberg Explained (Declassified)" — 180 rows, 09:53 narration, paint_explainer_v1.
2. `saveProductionDocEntry` called → `saveToServer('production_doc', ...)` in [src/lib/history.ts:767](src/lib/history.ts#L767).
3. The POST to `/api/history` failed silently. Most likely cause: `loadScope()` returned `null` (the auth/me probe failed) — see [src/lib/history.ts:401-429](src/lib/history.ts#L401-L429). When scope is null:
   - The fallback synthetic-id entry is **returned** to the caller
   - It is **not** added to the localStorage cache (`scope` guard)
   - It is **not** queued in `__history_pending__` (same guard)
   - The caller has no way to know any of this — the function returns a normal-looking `ProductionDocHistoryEntry`
4. Production-doc page accepted the synthetic id and called `setHistoryEntryId('1780576951572-jyli0zsqy5d')`.
5. From this point every save channel was broken:
   - `useProject('1780576951572-...')` → GET `/api/edit/1780576951572-...` → 400 (UUID regex)
   - `persistRowAsset` → POST `/api/edit/.../row-asset` → 400 (UUID regex)
   - The legacy `updateProductionDocEntry` (now `updateProductionDocEntryCacheOnly` per commit `83d7f96`) writes to cache, BUT only if the entry is already cached. No-op here.
6. User worked on the doc for hours. Page state had everything; nothing reached the server.
7. User clicked "Open in editor" → `/edit/1780576951572-jyli0zsqy5d` → page-route 404 (UUID regex).
8. User hit browser-back. Production-doc remounted. URL had no `?h=`. The cache had no entry. The page rendered blank.
9. **All work gone.**

## Why this happened (root causes)

The data loss surface was a **chain of three independent design defects**:

1. **`saveToServer` silently degrades a session-auth failure into an unrecoverable local-only state.** The synthetic-id fallback exists for genuine offline cases, but conflates "I am offline but logged in" (recoverable via `drainPending` on next list fetch) with "I am not authenticated" (UNrecoverable — nothing is ever queued).
2. **The production-doc page accepts a synthetic id as a valid `historyEntryId`.** Every downstream consumer assumes a UUID. Setting state on a non-UUID id is a permanent dead-end with no UI signal.
3. **The editor page-route returns a bare Next.js 404 for non-UUID ids.** It could detect the synthetic id, redirect to production-doc, and surface the recovery banner — instead it shows a black page with no path back. Even worse, the URL was indistinguishable to the user from a real 404.

A **fourth bug** made post-mortem recovery harder than it should have been: the history sidebar reads `entry.title` / `entry.shotCount`, but canonical save writes the title under `entry.doc.title` and rows under `entry.doc.rows`. Users see "Untitled project · undefined shots · undefined" for their real work and can't identify which entry is which.

## Goals

Make this class of loss **impossible**:

- A save failure surfaces a **persistent, dismiss-blocking** banner. No silent degradation.
- `historyEntryId` is **always** a real UUID OR `null`. Never a synthetic id.
- A non-UUID `/edit/[id]` URL renders a clear explanation page with a one-click "Return to production-doc to save" link. Not a bare 404.
- The sidebar shows accurate titles and shot counts for every cached doc, regardless of which save path wrote it.
- An automated test pins the contract — `saveToServer` must throw (not return a synthetic) when scope is unavailable.

## Constraints

- Cannot regress the **legitimate offline save** path. A network blip with an authenticated session should still queue + drain like before.
- Must work for users mid-session who already have a synthetic-id production-doc in memory — the recovery flow must give them a path to bind to a real UUID.
- Cannot break the existing sidebar's display of legacy entries that have top-level `title` / `shotCount`. Fall back, don't replace.
- 2-hour budget. Surgical fixes only; no rebuild of the save architecture.

## Changes (in order)

### PR1 — `saveToServer` refuses the silent fallback when no auth scope ([src/lib/history.ts](src/lib/history.ts))

Today: `loadScope() === null` → synthetic id returned, nothing queued, caller has no signal.

Change: when scope is null OR the POST returns 401/403, **throw** a typed `HistorySaveError` instead of returning a fake entry. Network errors and 5xx with a valid scope keep the current queue-and-fallback behavior (those are recoverable via `drainPending`).

```ts
export class HistorySaveError extends Error {
  constructor(
    message: string,
    public readonly kind: 'no_session' | 'unauthorized' | 'rejected',
    public readonly httpStatus?: number,
  ) { super(message); this.name = 'HistorySaveError'; }
}
```

Callers (`saveProductionDocEntry`, `saveThumbnailEntry`, etc.) propagate the error. Existing call sites that catch & ignore (`updateOnServer`'s `warn` pattern) keep working — the throw is only on the **initial save** path, not the update path.

### PR2 — Production-doc handles save failure loudly ([src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx#L8772))

At the `saveProductionDocEntry` call (~line 8772):

- Wrap in try/catch.
- On `HistorySaveError`:
  - Don't `setHistoryEntryId`. The page stays in "unsynced" mode.
  - Set a new `saveFailure` state: `{ kind, reason, retryCount }`.
  - Show a **persistent red banner** at the top of the page: "Couldn't save to server: <reason>. **[Retry]** — your work is safe in memory but not on the server."
  - Banner does NOT auto-dismiss. Banner blocks "Open in editor" (which already requires `historyEntryId`; the synthetic-id won't be set so the button stays disabled).
- On retry: re-invoke `saveProductionDocEntry` with the current doc state. If it succeeds, banner clears, `historyEntryId` is set, normal flow resumes. If it fails, banner stays.

Also: on page mount, drain `__history_pending__` for `production_doc` entries belonging to the **current page state** and bind `historyEntryId` to the first successful drain result. This recovers the legitimate-offline case automatically.

### PR3 — Editor route handles non-UUID gracefully ([src/app/(app)/edit/[projectId]/page.tsx](src/app/(app)/edit/[projectId]/page.tsx))

Today: `if (!/^[0-9a-f-]{36}$/i.test(projectId)) notFound();` — bare Next.js 404, no message, no path back.

Change: render a server component that shows:

> **This project isn't synced to the server.**
> The id `<projectId>` looks like a local-only draft id. Your work is probably still in the browser cache. Open Production Doc to recover and retry the save.
>
> **[Return to Production Doc →]**

That removes the most user-hostile UI in the flow and gives a clear next step. A real `loadProject` not_found (UUID-shaped but no row) keeps its existing 404 — that's a genuinely-missing project, different problem.

### PR4 — Sidebar reads canonical fields ([src/components/ui/HistoryPanel.tsx](src/components/ui/HistoryPanel.tsx) or wherever production-doc entries render)

Find where `entry.title` / `entry.shotCount` / `entry.niche` / `entry.totalDuration` are read for production_doc entries. Fall back in order:

- `entry.title || entry.doc?.title || '(no title)'`
- `entry.shotCount || entry.doc?.rows?.length || 0`
- `entry.niche || entry.doc?.niche || ''`
- `entry.totalDuration || entry.doc?.total_duration || ''`

Legacy entries keep rendering; canonical entries finally render correctly.

## Testing

- Unit test (`tests/history-save-fails-loud.test.ts`): mock `loadScope` to return null → `saveProductionDocEntry` throws `HistorySaveError(kind: 'no_session')`. Mock auth/me 200 + POST 503 → returns queued fallback as before (drainPending unchanged).
- Manual QA:
  - Force a 401 on `/api/auth/me` (temporarily clear cookie) → generate doc → banner appears, no synthetic id, Open in editor disabled.
  - Visit `/edit/not-a-uuid` directly → see explanation page with link, not Next.js 404.
  - Restore a legacy entry from `production_doc_history` cache → sidebar shows real title + row count, not "Untitled project · undefined shots".

## Out of scope (intentionally)

- Eliminating the synthetic-id fallback entirely. Genuine offline saves still need it; the bug was the silent failure mode, not the fallback existing.
- Rebuilding the dual storage model (`user_history` payload column vs. `project_assets` table). That's the 2026-05-24 refactor; finishing it is a separate plan.
- Auto-recovery of the lost CIA doc from `script_history`. Script is intact; user can regen the production doc from it. The image regen cost is the part we can't recover — separate "image cost insurance" plan if we ever want one.

## Observability

Every save and recovery path logs through `console.info('[doc-save ...]', { ... })`. Specifically:

- `[doc-save initial]` — start of `saveProductionDocEntry`
- `[doc-save initial] no session — throwing` — the new fail-loud branch
- `[doc-save initial] queued offline` — legitimate offline path
- `[doc-save initial] committed` — real UUID landed
- `[doc-save retry]` — user clicked Retry on the banner
- `[doc-save pending drain]` — page-mount automatic drain
- `[editor route] non-uuid id — rendering recovery page` — the new editor branch

## Settings audit (per rule 15)

No new user-facing knobs. The save-failure banner is a system message, not a preference. The "retry" cadence is hardcoded (immediate, user-driven) — no setting needed.

## Security (per rule 13)

- `HistorySaveError` carries no sensitive data — kind enum + message string, never the payload.
- The editor-route non-UUID page leaks no information about workspace / collaborator. It's a static explanation.
- The persistent banner shows the failure reason in user-friendly terms; the full HTTP status / response body is logged to console only.
