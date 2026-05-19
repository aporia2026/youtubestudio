# 2026-05-19 — Editor ↔ Production Doc parity via a unified payload

## Why this plan exists

The shot-graph editor at `/edit/[projectId]` was supposed to let creators
edit AI-generated videos with **every asset the production doc produced**
already wired in. In practice it ships a player that renders a black box,
a timeline whose tiles have no thumbnails, no voiceover, no B-roll, no
animations, no brand kit, no music, a disabled "Generate captions" button,
and a static help strip at the bottom that the user mistook for a broken
toolbar. The owner saw it for the first time on 2026-05-19 and said,
verbatim, "this is a joke. You have to correct this now, in a proper
robust way."

The root cause is not a single bug. It is a **broken data round-trip**
between the production-doc page (where assets are generated) and the
editor page (where they should be edited):

| Field in production-doc state              | Persisted to `user_history.payload`? | Read by editor? | Used correctly? |
|---|---|---|---|
| `doc` (rows, timing, text)                 | yes — at every autosave              | yes              | yes |
| `rowImages` (generated stills)             | yes — at every autosave (img-map)    | yes              | yes (but flaky on stale entries) |
| `rowOverlays` (overlay images + placement) | yes — at every autosave              | yes              | yes |
| `rowVideoClips` (B-roll animations)        | yes — at every autosave (id-map)     | **no**           | — |
| `voiceoverUrl` (narration)                 | **only at initial save**, never patched after | yes  | unusable: empty on every doc whose VO was added after generation |
| `voiceoverAlignment` (word-level timings)  | no                                   | no               | — |
| `captions` bundle                          | no (only if regenerated *inside* editor) | yes          | only if editor regenerates |
| `musicUrl`                                 | no                                   | no               | — |
| `brandKit` override / channel kit          | no (override field exists, never wired) | no            | — |
| `animateScenes` / `suppressLowerThirds` / `overlaysDisabled` flags | no | no | — |
| `rowLockedAsStill` per-row flags           | no                                   | no               | — |
| doc-level `text_overlays`                  | yes (part of `doc`)                  | yes              | yes |
| per-row free text (`script_text`, `visual_description`, `ai_image_prompt`, `on_screen_text`, `section_title`) | yes (part of `doc`) | yes (read) | partial (inspector edits some) |

Even fields that *should* round-trip do it through three different code
paths (initial `saveProductionDocEntry`, the autosave effect at
`production-doc/page.tsx:3683`, ad-hoc `updateProductionDocEntry` calls)
with no shared validator, no shared types, and no shared persistence
layer. The earlier shot-graph-editor plan
(`_plans/2026-05-18-shot-graph-editor.md`) said both surfaces would "read
and write the same row, single source of truth, optimistic updates,
last-write-wins with a version integer." That promise wasn't kept end to
end — only `doc` and `rowImages` got the full treatment.

## Goals

1. **Single canonical project payload** with one TypeScript type that
   both pages produce and consume.
2. **Every field the production doc generates flows through to the
   editor without a separate code path.** No more "save during generation
   includes X, autosave doesn't."
3. **The editor renders 100% of what the production doc renders** the
   first time the project opens — narration plays, thumbnails appear on
   timeline tiles, B-roll animates, overlays composite, captions burn
   in, brand kit applies.
4. **The editor is editable** — the inspector becomes a real shot editor
   with every per-shot field (script, visual description, AI prompt,
   image, video clip, overlay, on-screen text, section title, timing).
5. **The bottom help strip is replaced** with a contextual status bar.
6. **Last-write-wins versioning** with optimistic merges, the way the
   existing `/api/edit/[projectId]` route already does it.
7. **Observability from day one** (rule 14) on every read, write,
   merge, and render-config build.

## Non-goals (explicit, per the owner)

- Do not redesign the production-doc page UI. Only its data-persistence
  layer changes. The grid, the buttons, the chrome stay identical.
- No mobile/responsive work. Desktop-first.
- Do not collapse the two routes into one (Option C from the alignment
  conversation). Stays for a later pass.

## Constraints

- **No new database schema** beyond JSONB shape evolution. The current
  `user_history.payload JSONB` column is the home for the canonical
  payload — same column, richer + stricter shape.
- **Backward-compatible reads**. Existing rows without the new fields
  must still load (defaults fill in the gaps).
- **No regression** in production-doc generation, render, or history
  sidebar restore. Every existing flow keeps working.
- **Stay under the 5 MB localStorage quota** the production-doc page
  already squeezed itself into — the saliency strip-out at
  `production-doc/page.tsx:3625` stays.
- Per CLAUDE.md rule 13 (security from day one) and rule 14
  (observability), both have dedicated sections in this plan.

## Out of scope (deferred to a follow-up)

- Real-time collab. Last-write-wins is the contract.
- Multi-track audio editing, ducking, waveform-level edits.
- Frame-accurate scrubbing inside a shot.
- Mobile editor.
- Editor-driven AI features the production-doc page doesn't already
  expose. The editor surfaces existing capabilities; it does not invent
  new ones in this pass.
- Replacing the production-doc page's UI.

## Approach (Option B — unified data model)

### Three rejected alternatives

- **Option A — Patch the three known gaps only** (rowVideoClips wiring,
  voiceoverUrl persistence, rowImages reliability). Rejected by the
  owner. Reason: it leaves the underlying mess (three save paths, no
  shared type, fields invented ad-hoc) intact, so the *next* missing
  field repeats the bug.
- **Option C — Collapse the two pages into one route with two views.**
  Rejected for this pass. Bigger surface, blocks production-doc feature
  work for weeks, and the owner explicitly asked to keep production-doc
  UI untouched.
- **Add a typed `video_configs` table promoted out of JSONB.** Rejected
  by the earlier shot-graph plan's open Q1 and reaffirmed here — the
  payload is editorial state, JSON shape evolves with the editor's
  surface, and a typed table forces a migration on every shape change.
  JSONB + a Zod validator at the boundary gives us the safety of types
  without the migration tax.

### The chosen shape

```
┌─────────────────────────────────────────────────────────────────┐
│ src/lib/project/payload.ts                                      │
│   • interface ProjectPayload (one canonical type)               │
│   • const PROJECT_PAYLOAD_VERSION = 1                           │
│   • function migratePayload(raw: unknown): ProjectPayload       │
│   • Zod-style runtime validator (no zod dep — manual)           │
└─────────────────────────────────────────────────────────────────┘
                            ↑                    ↑
                            │                    │
┌───────────────────────────┴───┐  ┌─────────────┴────────────────┐
│ src/lib/project/persist.ts    │  │ src/lib/project/use-project. │
│   • loadProject (server)      │  │  ts                          │
│   • saveProjectPatch (server) │  │   • useProject hook (client) │
│   • merge w/ field-level      │  │   • auto-save w/ debounce    │
│     edited_at (already exists │  │   • optimistic version check │
│     for some doc fields)      │  │   • conflict callback        │
└───────────────────────────────┘  └──────────────────────────────┘
        ↑                                       ↑
        │                                       │
        │   used by both routes:                │
        │   • /edit/[projectId]   (full UI)     │
        │   • /production-doc      (data only)  │
        │                                       │
```

`ProjectPayload` is the canonical shape:

```ts
interface ProjectPayload {
  version: 1;
  title: string;
  doc: ProductionDoc;                              // rows, timing, total
  rowImages: Record<number, string>;               // generated still URLs
  rowOverlays: Record<number, RowOverlayRenderState>;
  rowVideoClips: Record<number, RowVideoClipState>;// id + url + duration
  voiceoverUrl?: string;
  voiceoverAlignment?: ForcedAlignmentResponse;
  captions?: CaptionsBundle;
  musicUrl?: string;
  brandKitOverride?: Partial<BrandKit>;
  channelId?: string;                              // for resolving channel kit
  flags: {
    animateScenes: boolean;
    suppressLowerThirds: boolean;
    overlaysDisabled: boolean;
    rowLockedAsStill: Record<number, boolean>;
  };
}
```

Both pages stop touching `user_history.payload` directly. Both call
`loadProject` / `saveProjectPatch` (server side, via routes) or the
`useProject` hook (client side). The hook handles:

- Initial load (calls the route, runs `migratePayload`, returns a typed
  payload + the version integer).
- Debounced autosave on any patch (300 ms, same cadence the editor uses
  today).
- Version-checked optimistic updates: each PATCH sends the version we
  loaded with, the server bumps + returns the new version, on `409 ` we
  surface a conflict callback the page handles (editor already has a
  reload banner for this; production-doc gets the same).
- Field-level `edited_at` merge for the fields that already track it
  (the regen-doc-from-script flow). Other fields are last-write-wins.

## What changes, file by file

### New files

- `src/lib/project/payload.ts` — the canonical type, version constant,
  `migratePayload` (fills defaults from old JSONB shapes), and a
  hand-written validator that throws with field paths on a malformed
  payload. No Zod runtime dep (saves bundle size; the shape is small
  enough to validate by hand).
- `src/lib/project/persist.ts` — `loadProject(id, session)` and
  `saveProjectPatch(id, patch, version, session)`. Server-only.
  Centralizes the `sql` calls that today live in three routes.
- `src/lib/project/use-project.ts` — `useProject(id)` client hook.
  Same surface as the editor's current `useEditorStore`, but generalized
  so production-doc can use it too without dragging in the editor's
  command/undo layer (the hook returns the payload + a `patch()` fn;
  the editor wraps it in its own command pattern, the production-doc
  page just calls `patch()` directly).
- `src/components/editor/StatusBar.tsx` — replaces the bottom help
  strip. Shows: playhead time, total duration, selected shot index
  + script preview, save status, render-readiness checklist (✓ doc,
  ✓ images, ✓ VO, ✓ captions, ✓ overlays where required), keyboard
  hint affordance on hover (so help is discoverable but not eating
  permanent screen real estate).
- `src/components/editor/TimelineThumbnail.tsx` — small composable that
  renders the per-shot thumbnail (still > clip first-frame > placeholder)
  on each timeline tile. Today's tiles only show text.

### Modified — `src/app/(app)/edit/[projectId]/page.tsx` + `EditorClient.tsx`

- `page.tsx` calls `loadProject` instead of its inline `sql` block.
- `EditorClient.tsx`:
  - Drops the local `parsePayload` in favor of the typed payload it
    receives.
  - Adds the missing fields to the local store: `rowVideoClips`,
    `voiceoverAlignment`, `musicUrl`, `brandKitOverride`, `channelId`,
    `flags`.
  - Threads them into `productionDocToVideoConfig` (the renderer
    already accepts all of these; the editor was just not passing
    them).
  - Inspector (`ShotInspector`) gains: script_text textarea (already
    there), visual_description, ai_image_prompt, on_screen_text,
    section_title, image preview + regen + replace, clip preview +
    regen + replace, overlay panel (already there), timing readout.
    Every field flows through `apply({ type: 'PATCH_ROW', ... })`
    so undo/redo + auto-save Just Work.
  - Toolbar adds: brand kit indicator (read-only badge → click opens
    the production-doc's existing BrandBar dialog in a portal),
    music picker (small file picker that calls existing
    `/api/upload`), animateScenes toggle, suppressLowerThirds toggle.
  - Replace the bottom help strip with `<StatusBar />`.
  - Timeline tiles render `<TimelineThumbnail />`.

### Modified — `src/app/(app)/production-doc/page.tsx` (data only, UI untouched)

- Replace the bespoke autosave effect at lines 3613–3733 with
  `useProject(id).patch(diff)` calls. Every place the page currently
  mutates state, the patch flows through the unified hook.
- Replace `saveProductionDocEntry` initial-save path with a
  `saveProjectPatch` that creates the row (same endpoint, different
  payload shape).
- `setVoiceoverUrl` now patches `voiceoverUrl` into the project
  payload. Same for `setVoiceoverAlignment`, `setMusicUrl`, brand kit,
  flags.
- `updateProductionDocEntry` calls collapse into the single hook.
- No visual changes to the page.

### Modified — `src/lib/history.ts`

- `ProductionDocHistoryEntry` becomes a *view* over `ProjectPayload` —
  the sidebar reads the canonical payload, projects out the fields it
  shows (title, niche, shot count, duration, thumbnail). The sidebar
  itself doesn't change.
- Helpers `saveProductionDocEntry` + `updateProductionDocEntry` are
  kept as thin wrappers around the new unified persist layer, so any
  third caller (there shouldn't be any, but defensively) continues to
  work.

### Modified — `src/app/api/history/[id]/route.ts` (or equivalent)

- The PATCH handler stops accepting an arbitrary `payload: unknown` and
  starts validating via `migratePayload` + the new validator. Rejects
  with 400 + field path on malformed input.
- Optimistic version check: caller sends `If-Match-Version`, server
  rejects with 409 if stale. (The editor's `/api/edit/[projectId]`
  route already does this; we generalize.)

### Modified — `src/remotion/utils.ts`

- `productionDocToVideoConfig` already accepts every field we need. No
  changes. (Verified at lines 442–470.)

## UX walk-through after this lands

1. Owner generates a doc on `/production-doc`, generates images, picks a
   voiceover, generates B-roll for a few rows, sets a brand kit. Every
   one of those actions patches the canonical payload server-side. The
   sidebar entry shows the same data it does today.
2. Owner clicks "Open in Editor" (or navigates to `/edit/{id}` directly).
3. The editor loads. The player shows the first shot's generated still,
   audio plays the assigned voiceover, captions display if a bundle is
   present, B-roll animates on the shots that have clips, overlays
   composite, brand kit applies to the lower-third.
4. The timeline shows each tile with a thumbnail (the row image, or
   the clip's first frame, or a placeholder for a never-generated
   shot) plus the shot's script_text caption underneath.
5. The owner clicks a tile. The inspector opens with every field that
   matters: script, visuals, prompts, image, clip, overlay, on-screen
   text, section title, timing. Each field edits live, auto-saves,
   undo/redo works.
6. The bottom of the screen is a status bar, not a help strip. It
   shows live playhead time, total duration, the selected shot's
   info, save status, and a "ready-to-render" checklist. Keyboard
   shortcuts hide behind a `?` icon — discoverable, not permanent.

## Settings audit (rule 15)

Three new settings exposed under the existing **Editor** group (creating
the group if missing) so the editor's choices aren't hardcoded:

- `editor.timeline.defaultZoomLevel` — int 1..10, default 5. Replaces
  the hardcoded `ZOOM_DEFAULT_LEVEL` constant.
- `editor.timeline.showThumbnails` — bool, default true. If a user has
  a slow machine and wants the tile rendering off.
- `editor.statusBar.showShortcutHints` — bool, default true. The help
  strip becomes opt-in info instead of permanent furniture.
- `editor.autoRegenCaptions.onVoiceoverChange` — bool, default false.
  When true, swapping the voiceover triggers a caption regen
  automatically (otherwise the existing "Generate captions" button is
  the trigger).

All four read from the existing per-user settings layer; no new
storage primitive.

## Security & safety (rule 13)

- **Workspace + collaborator scoping on every load and save.** Already
  the contract on `/api/edit/[projectId]` and `/api/history/[id]` —
  the unified `loadProject` keeps it: only the row whose
  `workspace_id` + `collaborator_id` match the session is returned.
  Defense-in-depth — `notFound()` for mismatches, not `403`, so row
  existence doesn't leak.
- **Server-side payload validation.** Every PATCH passes through the
  validator. Field type mismatches return 400 with the field path,
  never silently coerce. Prevents a malicious client from writing
  arbitrary JSON into the JSONB column.
- **No secrets in payloads.** Voiceover URLs are proxy paths
  (`/api/voiceover/...`), not signed S3 URLs with embedded keys. The
  validator rejects external `http://` URLs in `voiceoverUrl` unless
  they match the configured Blob hosts.
- **Logging hygiene.** All log lines that include URLs strip query
  strings (which is where ElevenLabs / Blob signatures live). The
  logger's redaction list grows by one regex.
- **Optimistic concurrency.** Version-check rejects stale writes — a
  user with two tabs open can't silently clobber the other tab's
  edits. The losing tab gets a "Reload from server" banner (already
  implemented in the editor; mirrored to production-doc).
- **Quota guardrails.** The autosave already falls back gracefully on
  localStorage quota; we keep that. Server-side, we cap payload size
  at 5 MB at the route boundary (413 if exceeded) so a runaway client
  can't fill the JSONB column.
- **No client trust.** `migratePayload` is a *defensive* migrator —
  unknown fields get dropped, not preserved, so older clients or
  hand-crafted requests can't sneak data through.

## Observability (rule 14)

Namespaced logs at every meaningful step. All log values are real
booleans/integers/strings, not "X happened" with nothing diagnostic:

- `[project payload load] start { id, ws }` → `… loaded { id, version,
  hasVO, hasCaptions, imageCount, clipCount, overlayCount }`.
- `[project payload save] patch { id, version, fields: [keys of patch] }`
  → `… committed { id, newVersion }` or `… conflict { id, expected,
  actual }`.
- `[project payload migrate] applied { id, from, to, dropped: [fields] }`
  (one line per shape change so we can see which old payloads needed
  upgrading).
- `[editor data flow] load complete { id, missingFields: [...],
  derivedConfigShotCount }` — the smoking-gun line when a user reports
  "nothing rendered." If `missingFields` is non-empty we know exactly
  what didn't round-trip.
- `[editor inspector] field edit { rowIndex, field, prevLen, newLen }`
  — prevents "no event fired on Save" guesswork.
- `[editor timeline] thumbnail source { rowIndex, source }` where
  source is one of `image | clipFrame | placeholder`. Tells us how
  often tiles fall back.
- Server side, mirror `[project payload save]` with a structured
  logger.info call so the Vercel logs show the same shape on both
  sides.

Plans (rule 14) require parity in the production-doc page's data
flow too: every `useProject.patch` call carries a `[prodoc data flow]
patch { id, fields }` line so we can confirm a user's "I clicked
generate VO but the editor still has none" claim by reading the trail.

## Phases

### Phase 1 — Foundations (the data layer)

1. Write `src/lib/project/payload.ts` with the canonical type,
   `PROJECT_PAYLOAD_VERSION = 1`, `migratePayload`, and validator.
   Unit tests for migrate (covering each old shape we've seen) and
   validator (every required + optional field, every rejection path).
2. Write `src/lib/project/persist.ts`: `loadProject`,
   `saveProjectPatch`. Move the `sql` calls out of
   `/api/edit/[projectId]` and `/api/history/[id]` into this module;
   the routes become thin adapters.
3. Write `src/lib/project/use-project.ts`: the client hook. Cover with
   tests on auto-save debouncing, version conflict, and abort.
4. Wire the new validator + version check into the existing PATCH
   routes. Backward-compatible: the routes still accept the old
   `payload` shape, run `migratePayload` server-side, and persist the
   migrated shape. Old clients can keep PATCHing during the rollout.

### Phase 2 — Production-doc page (data only)

1. Replace the bespoke autosave at `production-doc/page.tsx:3613–3733`
   with `useProject(id).patch(diff)` calls.
2. Replace `saveProductionDocEntry` initial-save with the new flow.
3. Patch `voiceoverUrl`, `voiceoverAlignment`, `musicUrl`,
   `brandKitOverride`, `channelId`, and every flag through the hook on
   change.
4. Manual QA: open every existing doc in the sidebar, confirm none of
   the page's visible behavior changed.

### Phase 3 — Editor page surfaces the full payload

1. Editor's `parsePayload` deleted; it consumes the typed payload
   directly.
2. Store gains `rowVideoClips`, `voiceoverAlignment`, `musicUrl`,
   `brandKitOverride`, `channelId`, `flags` slots.
3. `productionDocToVideoConfig` call updated to pass everything
   through.
4. Timeline tiles render `<TimelineThumbnail />`.
5. Inspector becomes the full shot editor (every per-row field).
6. Toolbar gains brand kit, music, animate, lower-thirds controls.
7. Bottom help strip replaced with `<StatusBar />`.

### Phase 4 — Polish + QA

1. Manual QA matrix:
   - Brand-new doc → open editor → every asset visible.
   - Old doc from before this change → open editor → still works
     (defaults fill in missing fields, no crashes).
   - Edit a shot's script in editor → confirm it saves, undo works,
     production-doc page sees the change on next load.
   - Generate VO on production-doc → open editor → narration plays.
   - Two tabs open → edit in tab A → tab B shows conflict banner.
2. Settings audit lands — the four new keys ship in the same commit
   as the editor changes that read them.
3. Observability check: open DevTools console on each surface, do a
   smoke run, confirm every namespaced log line appears with real
   values (not undefined).

## Open questions — resolved 2026-05-19

- **B-roll generation from the editor inspector?** → **Both.** Editor's
  shot inspector gets the same B-roll generator the production-doc page
  exposes (pick-from-existing AND generate-new), routed through the
  unified payload so a clip generated from the editor appears in the
  production-doc page on next load.
- **Captions on VO change — automatic or manual?** Default manual (the
  settings audit ships the toggle; default off so we don't surprise the
  user with a 30 s caption job).
- **Migration of in-flight localStorage bundles?** → **Both.** Both
  pages run the migration on load. The production-doc page consumes its
  own bundle key, the editor checks the same key (read-only) and merges
  fields the server payload is missing. Either page clears the bundle
  after a successful merge.
- **Editor lock policy?** → **Same as today.** Last-write-wins with
  version-checked conflict banner. No soft locks in this pass.

## Risk register

- **The production-doc page's 77-`useState` problem.** Refactoring its
  save path without touching its UI is the riskiest part. Mitigation:
  keep every existing state hook, only replace the *side-effects* that
  call out to history/server. Run the existing manual QA matrix
  before merging.
- **JSONB shape mismatch with the migration**: a payload from an old
  shape that the migrator doesn't anticipate could silently lose
  fields. Mitigation: the migrator logs everything it drops with
  `[project payload migrate]`, and the test suite covers every shape
  we have entries for in the current DB.
- **Performance regression on the editor load.** Adding rowVideoClips,
  alignment, and per-tile thumbnails increases initial payload size
  and render cost. Mitigation: thumbnails lazy-load below the fold;
  the alignment payload is fetched only when captions are visible.

## What "done" looks like

- A creator opens any project (new or old) at `/edit/[projectId]` and
  sees their generated content render correctly the first time, with
  audio, animations, thumbnails, captions, overlays, brand kit.
- Editing any per-shot field in the inspector saves, undoes, and is
  reflected on the production-doc page after a reload.
- No production-doc page UI change is visible.
- `[project payload …]` logs trace every read/write so the next
  "where's my X" bug is debuggable from a console paste.
- The bottom help strip is gone, replaced with a contextual status
  bar.
- All four new settings are exposed and respected.
