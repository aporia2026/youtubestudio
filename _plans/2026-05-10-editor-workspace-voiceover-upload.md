# 2026-05-10 — Voiceover upload in the Editor Workspace

## Goal

Owner can attach a voiceover to a project from inside the **Editor Workspace**
panel (the `EditorTab` rendered at `/projects/[id]` and inside the team-hub
right pane). Today the owner can only attach voiceovers from the project page's
own Voiceover tab; the Editor Workspace surface lists images, thumbnails,
production doc, and the editor's finished video — but no voiceover, so an
owner who lives inside this panel has no way to hand the voiceover to the
editor without leaving the panel.

## Out of scope

- Changes to the editor's own dashboard (the personal-token surface). The
  editor's dashboard already reads `media_assets` for the project, so any
  voiceover registered here surfaces there automatically — no extra wiring.
- Changes to the narrator approval flow.
- New API endpoints. Existing endpoints are reused as-is.
- AI voiceover generation entry point. The project page has a
  "Generate from script" CTA; we are not duplicating that into the editor
  workspace surface — owner can still use the project-page Voiceover tab
  for AI generation, and the result will appear in this list because both
  views read `media_assets` for the project.

## Constraints

- Must mirror the **Production Doc** section pattern in
  [src/components/editor/EditorTab.tsx](../src/components/editor/EditorTab.tsx)
  so the file stays "extremely clean, extremely ordered, and extremely
  organized" (CLAUDE.md rule 2).
- No new API endpoints; reuse:
  - `POST /api/projects/[id]/voiceover-upload` — presign R2 PUT
  - `POST /api/projects/[id]/media` — register row (`type='voiceover'`)
  - `GET  /api/projects/[id]/voiceover-library` — workspace picker
  - `DELETE /api/media/[id]` — detach
- Section placement: **after** the existing Production Doc section, **before**
  the Editor's finished video section. This matches the editor's natural flow
  (inputs → output upload).
- No "Google Sheet link" third lane (no analogue for audio).

## Approach

Add a new "Voiceover" section to `EditorTab.tsx` with three UI pieces:

1. **Upload** — file input accepting audio mime types
   (mp3/wav/m4a/aac/ogg/webm/flac), presign → R2 PUT → register via `/media`.
2. **Pick from library** — modal listing workspace voiceovers from other
   projects (same modal pattern as Production Doc library).
3. **Attached list** — rows showing each voiceover with: name, size, age,
   audio player (`<audio controls>`), Open ↗ link, Detach button.

`load()` already fetches `/media` for production docs — extend the same
response handler to also extract voiceovers (`type === 'voiceover'`).

## Rejected alternatives

- **Upload-only, no library picker.** Simpler but breaks the parity with
  Production Doc right above and loses cross-project reuse of
  narrator-approved voiceovers. Rejected.
- **Bottom of the panel (after the editor's finished video).** Keeps the
  existing sections untouched but groups voiceover with the "output" upload
  rather than the input assets. Rejected — placement was chosen by user.

## UX walkthrough (lazy-user lens — CLAUDE.md rule 10)

- Owner opens the editor workspace. Sees a "Voiceover" section between
  Production Doc and Editor's finished video. **One look = obvious.**
- Two equally weighted controls: "Upload" and "Browse library" (mirrors the
  Production Doc layout the owner has already used).
- Drops a file → progress in the button label → toast → row appears with an
  audio player so they can preview without leaving the panel.
- Already-attached voiceovers (narrator-approved, or uploaded from elsewhere)
  show up automatically — owner doesn't have to "import" them.
- Detach has a confirm. The R2 file is not deleted (matches Production Doc
  semantics), so a detach-then-reattach via library works.

## QA checklist

Golden path:
- Upload mp3 → row appears → audio player plays → toast success.
- Click "Browse library" → existing workspace voiceovers from other projects
  list → click Attach → row appears in this project.
- Existing narrator-approved voiceover on the project (e.g. created via
  `/api/narrator/assignments/{id}/approve-full`) already appears in the list
  on initial load.
- Detach → row disappears → toast success → R2 file still present in the
  bucket (verified by the fact that "Browse library" still shows it for
  reuse from another project).

Edge cases:
- Non-audio file selected (e.g. .png) → server rejects with
  `Unsupported audio type: image/png` → toast shows the error message.
- R2 not configured → presign returns 503 → user-friendly toast.
- Library is empty → empty state copy.
- Library item missing `r2_key` (external URL voiceover) → attach uses
  `source: 'url'` per the project-page contract.
- Two consecutive uploads → button disabled while busy, no double-fire.

Regressions:
- Existing Production Doc section still works (same `load()` is shared).
- Editor's finished video section still receives the right `assignments`
  prop (we don't touch that block).
- The editor's own dashboard surface (token URL) still reads voiceovers from
  `media_assets` — confirm by viewing a project where a voiceover was
  uploaded through this new UI.

## Risk / cost note (CLAUDE.md rule 8)

Zero new third-party calls. Same R2 bucket, same presign endpoint already in
use on the project page. No incremental cost.
