# 2026-05-27 — Voiceover upload when production doc isn't a saved project

## Goal

Enable the **Upload from computer** affordance inside the Video Preview & Render
section of `/production-doc` even when the doc hasn't been linked to a saved
`projects` row yet. Today the trigger is disabled with "Open this doc from a
project to upload voiceovers" because the picker requires a `projectId` for
both the presign call and the `media_assets` insert.

The user wants to drop in a voiceover, hear it in the Remotion preview, and
have it persist across reloads — without first jumping through a separate
"save project" step.

## Decision (selected interactively)

**Auto-create a draft project on first upload.** When the user clicks Upload
(or Save to library) and no `projectId` exists, the production-doc page silently
POSTs to `/api/projects` with a title fallback chain, then continues the upload
against the new id and updates the URL with `?projectId=…` so a reload keeps
the linkage.

## Rejected alternatives

- **Ephemeral upload (no DB row).** Simplest, but the voiceover is lost on
  reload, doesn't appear in the workspace library, and the alignment proxy
  (`/api/voiceovers/<uuid>/audio`) needs a `media_assets` row to work — so
  scene-aligned timing would be silently disabled. Rejected: violates rule 10
  (lazy user) because the user can't tell why alignment doesn't kick in.
- **Workspace-scoped media_asset (`project_id = NULL`).** Cleanest data model
  for an "orphan" upload but requires a migration to drop NOT NULL on
  `media_assets.project_id`, a new endpoint, picker library load adjustments,
  and alignment-proxy changes. Rejected: too big a change for the user's ask.

## Constraints

- **No new API endpoints.** Reuse `POST /api/projects`, the existing
  `/api/projects/[id]/voiceover-upload` presign, and `/api/projects/[id]/media`.
- **Match existing file structure.** `VoiceoverPicker.tsx` already has the
  upload + save-to-library handlers. Add a single optional prop —
  `onRequireProject?: () => Promise<string | null>` — and keep the disabled
  fallback for callers (the editor's Audio panel) that don't pass it.
- **URL must update** so a reload preserves the link — use `router.replace`
  (Next.js navigation) with the new `projectId`.
- **Don't surprise the user.** Toast something subtle on first auto-create so
  they know a project was made (e.g. `Created draft project for this doc`).

## Approach

### `src/components/voiceover/VoiceoverPicker.tsx`

1. Add prop `onRequireProject?: () => Promise<string | null>`.
2. Introduce a small helper inside the component:

   ```ts
   async function ensureProjectId(): Promise<string | null> {
     if (projectId) return projectId;
     if (!onRequireProject) return null;
     return onRequireProject();
   }
   ```

3. `handleUploadFromComputer` — replace the early-return on missing
   `projectId` with a call to `ensureProjectId()`. Use the resolved id (not
   the prop) for the rest of the function.
4. `handleSaveToLibrary` — same change.
5. Trigger button disabled / tooltip logic: enable the upload row whenever
   `onRequireProject` is supplied, even if `projectId` is currently null.
   Update the tooltip copy so the lazy user sees what will happen
   ("Upload a voiceover — we'll create a draft project for this doc on the
   fly"). Keep the existing disabled fallback for callers that pass neither
   `projectId` nor `onRequireProject`.

### `src/app/(app)/production-doc/page.tsx`

1. Add a callback near the other voiceover handlers:

   ```ts
   const ensureProjectForVoiceover = useCallback(async (): Promise<string | null> => {
     const existing = scheduleItem?.project_id ?? projectIdParam;
     if (existing) return existing;
     const title = (doc?.title || topic || niche || 'Untitled production doc').trim();
     const res = await fetch('/api/projects', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ title, niche, topic }),
     });
     if (!res.ok) {
       toast.error('Could not create a project for this voiceover');
       return null;
     }
     const { project } = await res.json();
     if (!project?.id) return null;
     // Update URL so reload keeps the linkage. router.replace preserves the
     // rest of the query so we don't drop scheduleLinkId / etc.
     const params = new URLSearchParams(search.toString());
     params.set('projectId', project.id);
     router.replace(`/production-doc?${params.toString()}`);
     toast.success('Created a draft project for this doc');
     return project.id as string;
   }, [scheduleItem?.project_id, projectIdParam, doc?.title, topic, niche, search, router]);
   ```

2. Pass `onRequireProject={ensureProjectForVoiceover}` into the
   `<VoiceoverPicker />` already mounted in the Video Preview & Render block.

### Title fallback rationale

The chain `doc?.title → topic → niche → 'Untitled production doc'` covers
every realistic state: a generated doc has `title`; an in-progress one has
`topic` and/or `niche`; a brand-new tab has nothing — and we still let the
upload proceed so the user gets unblocked.

## Security note (CLAUDE.md rule 13)

- `POST /api/projects` is `apiRoute.authed` — workspace_id is scoped to the
  caller's session, never trusted from the client. No change there.
- The new flow can only create projects in the caller's own workspace.
- No new attack surface — same endpoints, just called in a new order.

## UX walkthrough (CLAUDE.md rule 10 — lazy user)

1. User has a generated production doc but never saved it. Opens Video
   Preview & Render. Sees the voiceover picker.
2. Clicks the picker → popover opens → "Upload from computer" is now
   **enabled** with tooltip "Upload a voiceover — we'll create a draft
   project for this doc on the fly".
3. Picks a file → toast "Created a draft project for this doc" → upload
   progresses → "Uploaded <name>" → URL now has `?projectId=…` → picker
   auto-selects the new entry → Remotion player has audio.
4. Reload page → `projectId` query param survives → the doc is now a real
   project with the voiceover attached and alignment timing works.

## QA checklist (CLAUDE.md rule 6)

Golden path:
- Generate a fresh production doc (no schedule link, no projectId in URL).
  Click upload → file picker opens → pick mp3 → both toasts fire → picker
  shows the new voiceover selected → URL updated.
- Reload the page. `?projectId=` survives. Voiceover loads from library.
  Alignment status flips to syncing (not "Alignment unavailable").

Edge cases:
- Empty title/topic/niche → falls back to "Untitled production doc". Project
  is created, upload succeeds.
- `/api/projects` returns 500 → toast "Could not create a project for this
  voiceover" → upload aborts cleanly (no orphan R2 PUT).
- Upload starts but R2 PUT fails → the project still exists (acceptable; the
  user can retry the upload against it). Toast surfaces the R2 error.
- User already has `?projectId=` in URL → `ensureProjectForVoiceover` returns
  it immediately, no extra POST. (Existing behaviour preserved.)
- Save-to-library on a history entry when no project exists → same
  auto-create path runs.

Regressions:
- Editor's Audio panel (`EditorTab.tsx` uses `VoiceoverPicker` but does NOT
  pass `onRequireProject`). With `projectId` from the route, the picker
  behaves exactly as today; with `projectId` somehow missing, the disabled
  state and tooltip stay as before.
- `VoiceoverPicker` consumers that don't supply the prop see no behavioural
  change.

## Risk / cost note (CLAUDE.md rule 8)

Zero new third-party calls. Same R2 bucket, same endpoints, same DB writes.
No incremental cost.
