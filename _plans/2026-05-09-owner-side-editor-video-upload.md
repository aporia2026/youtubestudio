# Owner-side editor-video upload + harden the existing editor upload path

**Date:** 2026-05-09
**Branch:** phase-1-foundation
**Status:** Approved (user picked Option A + "new version, attributed to editor" + "same as editor flow" size policy)

## Goal

Let the project owner upload a finished video file received from an editor (e.g. via Upwork) directly from the project page, so:

1. The video lands in the same `review_versions` table the editor's own uploads use.
2. It appears in the editor's personal dashboard at `/editor/[token]/[projectId]`.
3. The owner can leave timestamped comments through the existing `/reviews/[reviewProjectId]` UI.
4. While we are in there: stop the editor's own upload from feeling like it "hangs" forever on bad files / first-upload-of-an-assignment.

## Non-goals

- No changes to the comment data model.
- No changes to the editor-facing UI flow except using the same hardened upload helper as the owner.
- Not auditing every unauthenticated review route — only `POST /api/review/projects` because we touch its only DB helper.

## Root causes of the editor "long wait, never uploaded"

These are all in the existing editor flow today; the owner-side upload would have inherited the same failure modes if we'd just copy-pasted.

1. **`createReviewProject` does not set `workspace_id`** — `src/lib/review-db.ts:104-112` issues `INSERT INTO review_projects (title, description) VALUES (...)`. After migration 0013 (`workspace_id` `NOT NULL` on every tenant-scoped table), this INSERT fails with a Postgres NOT NULL constraint violation. Hits on the editor's **first** upload for an assignment (when `editor_assignments.review_project_id` is still null). The route returns 500 — but only after the browser has already burned 1–5 minutes on compression + thumbnail probe, so it feels like a hang.
2. **`compressVideo` has no timeout / abort** — `src/lib/compress-video.ts:59-115`. WebCodecs `convertMedia` can stall on certain frames; the UI freezes on "0%" forever.
3. **Thumbnail probe has no timeout** — `src/app/editor/[token]/[projectId]/page.tsx:121-154`. Awaits `videoEl.onseeked`; for some MOV / MKV variants `onseeked` never fires, the upload sits there.
4. **XHR PUT to R2 has no timeout / no stall detection** — same file, lines 169-177. Standard `XMLHttpRequest` with default "wait forever" timeout. A dead TCP that doesn't RST = silent forever.
5. **R2 presigned PUT URLs expire in 1h** — `src/lib/r2.ts:36`. A 4 GB file on a 5 Mbps connection takes >1.5 h; the URL goes 403 mid-upload, the XHR sees it as a generic error after a long delay.

## Approach (chosen Option A)

### Backend

1. **Fix the `workspace_id` bug at the source.** Change `createProject(title, description?)` in `src/lib/review-db.ts` to `createProject({ title, description?, workspaceId })`. INSERT `... (title, description, workspace_id) VALUES (..., ${workspaceId})`. Update both call sites:
   - `POST /api/review/projects` — wrap in `apiRoute.authed`, pass `session.ws`.
   - `POST /api/editor/[token]/projects/[projectId]/upload-video` — pass `assignment.workspace_id`.

2. **Bump R2 presigned PUT TTL** from 3600s → 14400s (4 h). Owner-side and editor-side both go through `getUploadPresignedUrl`. Anything > 4 h is a "your connection is too slow" problem we can't paper over.

3. **New owner-side route** `POST /api/projects/[id]/editor-uploads` (and `PATCH` for metadata):
   - `apiRoute.authed`, verifies `projects.id = :id AND workspace_id = :session.ws`.
   - Looks up the project's editor assignment (the most recent one with status != completed), or scopes to `editor_id` from the request body when there is more than one editor on the project.
   - Same `createReviewProject` + `createVersion` orchestration as the editor route, but `uploaded_by = "<editor name> (uploaded by owner)"` so the dashboard is honest about who pressed the button. `metadata` (a new column? — no, we keep version table flat; the suffix on `uploaded_by` is the audit signal).
   - Returns `{ uploadUrl, versionId, versionNumber, reviewProjectId }`.
   - Sets `editor_assignments.status = 'submitted'` like the editor route does.

### Shared client helper

4. **`src/lib/upload-video-client.ts`** — new module exporting `uploadReviewVideo(opts)`:
   - Inputs: `file`, `presignFn` (POST → returns presigned URL), `confirmFn` (PATCH → records metadata), progress callbacks for compression / probe / upload, an `AbortSignal`.
   - Compress branch: timeout (default 10 min) + stall detection (no fraction tick for 90 s → fail). On any failure, fall back to original file.
   - Thumbnail probe: 8 s hard timeout, all errors swallowed (thumbnail is best-effort).
   - XHR PUT: `xhr.timeout = 10 * 60 * 1000` (10 min from last byte tx), stall detection at 60 s with no `progress` event, abort wired to caller's AbortSignal, distinct error messages for: timeout, stall, 403 (URL expired), CORS, network.
   - Returns `{ versionId }` on success.

### UI

5. **`src/components/editor/EditorTab.tsx`** — new section *Editor's finished video* between *Production Doc* and the editors list (just below Thumbnails feels too far from the action; right under Production Doc keeps the file-upload widgets together):
   - Drop zone + click-to-pick.
   - Editor picker (only shown if the project has > 1 active editor assignment).
   - Optional note (passed through to the assignment / version metadata).
   - Compression toggle (defaults to on — same as the editor side).
   - Live progress bar with "Compressing… X%", "Uploading… X%", and **a cancel button** (the existing UI has none).
   - On success: list of uploaded versions with thumbnail + "Open review →" linking to `/reviews/[reviewProjectId]` (the owner-side review page that already exists).

6. **`src/app/editor/[token]/[projectId]/page.tsx`** — refactored to use `uploadReviewVideo` from the new helper. Cancel button visible during compression and upload. No behaviour change beyond timeouts + cancel.

### Roadmap

7. **`ROADMAP.md`** — add Phase 11 entry "Owner-side editor-video upload + upload-path hardening" so this work shows up in the canonical phase tracker.

## Test plan

Unit:
- Pure helpers in `upload-video-client.ts` (split out a `classifyXhrFailure` helper) — Jest test cases for timeout, stall, 403, network.

Integration / manual:
- **Golden path A (owner-side new project):** create a project, assign an editor, owner uploads a small mp4 (no compression). Verify version row exists, editor sees it on `/editor/[token]/[projectId]`, owner can comment from `/reviews/[reviewProjectId]`.
- **Golden path B (owner-side, second version):** repeat with a second video; both versions visible to both parties, version_number = 2.
- **First-upload-of-assignment (was broken):** assign a brand new editor, owner uploads first → verify `review_projects` row gets a workspace_id, no NOT NULL violation.
- **Compression edge case:** upload a 100 MB mp4 with WebCodecs disabled in the browser → falls back to original.
- **Stall simulation:** point R2 at a non-routable IP (in a dev override) → XHR aborts at 60 s with a clear error.
- **Cancel button:** click cancel mid-compression and mid-PUT — UI unwinds cleanly, no orphan version row.
- **Editor-side after refactor:** repeat Golden A but from the editor's dashboard; verify behaviour unchanged for the happy path, cancel works.

## Alternatives rejected

- **Option B (owner-only feature, leave editor flow alone)** — would have shipped the new feature in fewer files, but the editor's own "wait forever" stay broken. User explicitly asked us to investigate that hang, so deferring it is wrong.
- **Option C (store as media_assets, not review version)** — simplest backend, but lose the timestamped comment tool that the user explicitly wants to use. Dead-end for the use case.

## Open questions

None at plan-write time. User picked:
- "New version, attributed to editor" → `uploaded_by` = editor name + "(uploaded by owner)" suffix.
- "Same as editor flow" size policy → compress >= 5 MB, no hard cap.
