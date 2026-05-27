# 2026-05-27 — Voiceover picker upgrades + notes-while-watching feature

## Goals

1. Remove the round-trip pain in the production-doc voiceover picker. Today a creator has to leave the page (go to /projects/[id] → Media tab → Upload Audio File) to get a voiceover into the workspace library, which is the only place forced-alignment / scene-sync works from. We make the workflow inline.
2. Make the speed-adjustment work on /voiceover actually persist. Today the slider only changes client-side `playbackRate` and the "Download at Xx speed" button writes a WAV to disk — nothing is saved server-side, so a "1.3× version" never appears in the production-doc voiceover dropdown.
3. Add a notes-while-watching feature usable on both the /production-doc grid view AND the Editor view. Pause, jot a note, tag it (regen / timing / script / idea / polish / question), and second-pass through a Review queue. Goal is to make the "watch → spot a problem → fix it" loop tight enough that a solo creator can finalise a video in one sitting.

## Constraints

- This codebase is a forked-and-modified Next.js with breaking changes from the public release. Read `node_modules/next/dist/docs/` before any routing / streaming code.
- DB migrations auto-run on Vercel deploy via the `vercel-build` script. Migration files go in the existing migrations directory; no manual run needed.
- Storage is Cloudflare R2 with presigned uploads from the browser (the 4.5 MB Vercel function body limit forces this). Existing flow at /projects/[id] is the template.
- Voiceover providers: ElevenLabs + Gemini. Library lives in `media_assets`. History (NOT library) lives in `voiceover_history`.
- The picker's alignment gate (in `src/app/(app)/production-doc/page.tsx:7074-7077`) requires the URL match `/api/voiceovers/<uuid>/audio` — i.e. the asset MUST be a `media_assets` row. Everything in Phase 1 below exists to satisfy this gate without sending the user away from /production-doc.
- Solo user, desktop primary. No multi-user, no @mentions, no real-time sync.
- Must not regress existing voiceover flows.

## Requirements

- Intended user: a solo creator who works on a single production doc end-to-end, watches the preview many times during iteration, and wants the smallest possible delta between "I noticed a problem" and "the fix is queued."
- Notes persist across reloads and across browser sessions.
- Notes are scoped to one doc and one user (workspace member).
- Lazy-user bar: every new affordance must be discoverable on first look and operable with at most one keypress.

## In scope (v1)

**Voiceover**
- Inline "Upload from computer" item at the top of the picker dropdown.
- "Save to library" button on every history-only picker entry.
- "Save 1.3× version to library" button on /voiceover next to the existing "Download" button. The same code path also handles 0.5× / 0.8× / 1.0× / etc.
- New entries auto-select in the production-doc picker so the existing alignment job fires.

**Notes**
- `N` keypress while playing → pause + open note input docked under the player.
- Note auto-pins to (scene index, ms within scene).
- Tag types via one-letter keys: `R` regen, `T` timing, `S` script/VO, `I` idea, `P` polish, `Q` question.
- `Enter` saves + resumes; `Esc` cancels + resumes.
- Notes dock visible (collapsed strip) under the player at all times; expands to show notes for the current scene.
- `Shift+N` opens a Review queue: unresolved notes across the entire doc, grouped by section, click → seek to that note's scene + timestamp.
- Notes timeline strip (thin row above the player scrubber) shows colored ticks for each note.
- Markdown export from the Review queue ("copy" + "download .md").
- Same UI surface in /production-doc grid view and in the Editor view; shared state so a note added in one shows in the other instantly.

## Out of scope (v1 — possible v2)

- Voice notes via MediaRecorder.
- "Apply to similar" batch flagging.
- Threaded comments / @mentions / multi-user.
- Auto-trigger regeneration when the `R` flag is set (flag stays a flag; user explicitly clicks "Regenerate flagged" later).
- Notes search beyond tag-type filter.
- Cross-doc notes view.

## Chosen approach

### Phase 1 — Voiceover infra (smallest PR, unlocks scene-sync immediately)

API endpoints (all under `src/app/api/voiceovers/`):

- `POST /api/voiceovers/save-from-history` — body: `{ historyId: string }`. Server reads the `voiceover_history` row, fetches the audio (must be from a whitelisted CDN host — SSRF guard), uploads to R2 under the caller's workspace prefix, inserts a `media_assets` row with `type='voiceover'` and `metadata` carrying the source provider + voice id. Returns the new `media_assets` row.
- `POST /api/voiceovers/upload-presign` — body: `{ filename, size, contentType }`. Returns `{ uploadUrl, mediaAssetId, finalKey }`. Same pattern as the existing `/api/projects/[id]/voiceover-upload`.
- `POST /api/voiceovers/upload-finalize` — body: `{ mediaAssetId }`. Verifies the R2 object exists, sniffs MIME from magic bytes, inserts the `media_assets` row.
- `POST /api/voiceovers/save-with-speed` — body: multipart with the time-stretched WAV blob + `{ baseHistoryId, speedRate, label }`. Same R2 + media_assets dance as the inline upload, but the label gets the speed suffix (e.g. "Enceladus (Gemini 2.5) — 1.3×").

UI changes:

- `src/components/voiceover/VoiceoverPicker.tsx`
  - New top item: "📁 Upload from computer" → opens hidden `<input type=file accept="audio/*">`. On change, calls upload-presign, PUTs to R2 with a progress bar, then upload-finalize, then auto-selects.
  - On each history-only entry (no `mediaAssetId`): small "Save to library →" button. On click, calls save-from-history, swaps the entry's identity to the new `media_assets` row, auto-re-runs the alignment effect.
- `src/app/(app)/voiceover/page.tsx`
  - Next to the existing "Download at Xx speed" button: a "Save Xx version to library" button. Reuses the existing `timeStretchAudioBuffer` to produce the WAV, then POSTs to save-with-speed.

### Phase 2 — Notes schema + read/write

Migration (new file in the migrations dir):

```sql
CREATE TABLE production_doc_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id       UUID NOT NULL REFERENCES user_history(id) ON DELETE CASCADE,
  row_index    INT  NOT NULL CHECK (row_index >= 0),
  scene_ts_ms  INT  NOT NULL DEFAULT 0 CHECK (scene_ts_ms >= 0),
  text         TEXT NOT NULL,
  tag          CHAR(1) CHECK (tag IS NULL OR tag IN ('R','T','S','I','P','Q')),
  resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pdn_doc        ON production_doc_notes (doc_id);
CREATE INDEX idx_pdn_doc_open   ON production_doc_notes (doc_id) WHERE resolved = FALSE;
CREATE INDEX idx_pdn_doc_row    ON production_doc_notes (doc_id, row_index);
```

(Exact FK target verified against the actual `user_history` / production-doc storage table before writing the migration.)

API endpoints (under `src/app/api/production-doc/notes/`):

- `GET /api/production-doc/notes?docId=...` → all notes for that doc, ordered by `(row_index, scene_ts_ms, created_at)`.
- `POST /api/production-doc/notes` → create.
- `PATCH /api/production-doc/notes/[id]` → update text / tag / resolved.
- `DELETE /api/production-doc/notes/[id]` → delete.

Access control: caller must own (or be a workspace member of) the doc. Enforced server-side via the same workspace-membership check the existing doc endpoints use.

### Phase 3 — Notes UI components (shared between grid and editor)

New directory `src/components/notes/`:

- `NotesDock.tsx` — collapsed strip under the player + expandable panel. Strip shows count + most-recent tag dots.
- `NoteInput.tsx` — the focused input pop, pre-tagged with `(scene N @ Xs)`.
- `ReviewQueue.tsx` — full-doc unresolved-notes panel.
- `NotesTimelineStrip.tsx` — colored ticks above the Remotion scrubber.
- `notesStore.ts` — small hook (`useNotes(docId)`) that wraps the REST endpoints. Uses optimistic updates. Single source of truth shared by grid + editor.
- `useNotesHotkeys.ts` — `N`, `Shift+N`, `R/T/S/I/P/Q`, `Enter`, `Esc` while the dock owns focus.

The Remotion `Player` exposes `getCurrentFrame()` + `pause()` + `seekTo()` via the `PlayerRef` — same one the Stage already uses. NoteInput grabs the frame at the moment `N` is pressed, converts to `(rowIndex, msWithinScene)` using the same shot-timeline math we already use in `Stage.sectionStartFrame`, and uses that as the note's pin.

### Phase 4 — Integration into both surfaces

- `/production-doc` grid view: mount `<NotesDock docId={doc.id} playerRef={…} config={…} />` under `VideoPlayerMemo`. Per-row tag badges on `SectionCard` reading from `useNotes(doc.id)`. Pass `playerRef` down from `VideoPlayerMemo` (small refactor — currently the ref is private inside `VideoPlayer.tsx`).
- Editor view: mount `<NotesDock>` under `Stage`. Reuse the same `playerRef` already in `Stage`. Add a "Review queue" button to `EditorTopBar`.
- Both surfaces share `useNotes(docId)`, so a note added in one surface appears in the other on next focus / on socket-less polling (5s interval is plenty for a single-user workflow).

### Phase 5 — Markdown export

- "Export notes (.md)" button in the Review queue.
- Output format: grouped by section, each note as `- [TAG] (scene N @ Xs) text…`. Resolved notes go in a collapsed `<details>` block at the end.
- Triggers a browser download (no server round-trip needed).

## Alternatives rejected

- **Notes stored as JSONB on the production_docs row.** Rejected: every note write would re-serialise the whole row; concurrent writes (e.g. grid + editor open in two tabs) would clobber each other; per-note indexing (e.g. "all unresolved across all docs in workspace") would require JSON path queries. A separate table is the standard answer.
- **Notes panel on the right sidebar.** Rejected per the user's explicit pick: docked under the player is more discoverable and doesn't compete with the Inspector for editor real estate.
- **Notes modal triggered only by hotkey.** Rejected: out-of-sight is out-of-mind; the dock strip serves as a passive reminder that notes exist.
- **Auto-trigger regeneration on the `R` flag.** Rejected: the per-image-regen cost is non-trivial (and the user has principle 8 — never silently spend on a paid API). Flag-then-bulk-action keeps the spend explicit.
- **"Nested speed variants" in the picker.** Rejected per the user's explicit pick: each speed = its own library row is simpler all the way down (schema, alignment cache, picker UI).
- **Server-side ffmpeg time-stretch.** Rejected for v1: the browser already does this perfectly via `timeStretchAudioBuffer`. Adding a server-side ffmpeg path would mean a Vercel-function timeout risk on long voiceovers, plus an extra build dependency. The browser path scales fine for single-user.
- **Inline regeneration of voice notes (MediaRecorder).** Deferred to v2: microphone permissions, browser-specific encoder quirks, and storage for binary blobs are enough surface to justify deferring.
- **WebSocket sync for notes between tabs.** Rejected: 5s polling is plenty for single-user workflows and avoids a whole layer of infra.

## Security & safety (per principle 13)

- **Notes content** is private creative material. RLS enforces "only the doc owner / workspace member can read or write notes for that doc." No public endpoints, no shared links in v1.
- **Voiceover upload** (`/upload-presign` + `/upload-finalize`):
  - Allow-list of MIME types: `audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/aac`, `audio/ogg`, `audio/webm`.
  - Hard size cap at 50 MB (rough upper bound for a 20-minute voiceover at typical bitrates).
  - Server-side magic-byte sniff on finalize. Don't trust client-set Content-Type.
  - R2 keys are random UUIDs under a workspace-scoped prefix; never user-supplied.
- **save-from-history**: server fetches the source URL with a per-host allow-list (ElevenLabs CDN, Gemini TTS endpoints, R2 bucket). SSRF defence — won't follow redirects to internal IPs (`localhost`, `169.254.169.254`, RFC1918). Timeout 30s, max body 50 MB, fail-closed on non-audio Content-Type.
- **Logging**: never log note bodies, audio file contents, or full voiceover text. OK to log: counts, sizes (KB), durations, error codes, host of source URL.
- **CSRF**: notes + voiceover endpoints sit behind the existing same-origin + auth-cookie check the rest of `/api` uses. No special handling needed.
- **Authorisation** on every endpoint: caller's workspace membership is verified before reading or writing. Notes API additionally verifies the note's `doc_id` belongs to the caller's workspace.

## Cost (per principle 8)

- R2 storage: a speed-variant save adds ~2–5 MB. Even with 100 variants across all docs, ~500 MB is effectively free at R2's $0.015 / GB / month.
- R2 egress: notes are tiny text; voiceover serving via proxy is the same egress profile as today.
- No new third-party APIs. No incremental AI calls in v1 (regeneration is user-triggered via the existing image-regen flow).
- **Net impact**: a few cents per month, dominated by R2 storage.

## Lazy-user walkthroughs (per principle 10)

### "I want to take a note about a clunky scene"
1. Watching at /production-doc.
2. See scene 7 cuts too early.
3. Press `N`.
4. Player pauses, focus lands in a note input under the player, pre-tagged "scene 7 @ 4.2s".
5. Type "cut feels rushed", press `T` (tag = Timing), press Enter.
6. Player resumes, note saved, a yellow tick appears at the 4.2s mark on the timeline strip.
7. Later: `Shift+N` opens the Review queue, click the note, player seeks back to that exact frame.

### "I want to flag a scene for regeneration"
1. Press `N` mid-watch.
2. Type "image doesn't match script", press `R`, press Enter.
3. A red dot appears on scene 4's section card.
4. Later, open the Review queue → "Regenerate flagged images" → existing image-regen flow fires for each.

### "I want to upload a custom voiceover I recorded myself"
1. /production-doc, open the voiceover dropdown.
2. Top item: "📁 Upload from computer". Click → file picker → choose narration.mp3.
3. Inline progress bar in the dropdown, presigned R2 PUT.
4. On finish, the new entry auto-selects. "Alignment unavailable" flips to "syncing" then to a per-scene-aligned badge.

### "I want my 1.3× sped-up take to be usable in production-doc"
1. /voiceover, generate the take, drag speed slider to 1.3×.
2. Click the new "Save 1.3× version to library" button.
3. Toast confirms save.
4. Hop to /production-doc, open picker → see "Enceladus (Gemini 2.5) — 1.3×" alongside the 1.0× original.
5. Pick it; scene sync runs normally on the time-stretched audio.

## Open questions

- **Save-from-history audio fetch**: copy the audio to R2 or just register a URL link? **Decision: copy to R2.** Reason: ElevenLabs URLs can expire (their CDN issues new URLs on regeneration); a R2 copy makes the asset durable, and the cost is negligible.
- **Hotkey collisions**: `N`, `Shift+N`, `R/T/S/I/P/Q` need an audit against existing keybindings on both surfaces (the Editor view has its own keymap in `useEditorUiState`). Likely-safe but verify before coding Phase 3.
- **Per-row notes badge in the grid table**: the grid view already has dense per-row controls. Whether to add a badge inline or as a hover-tooltip is a v1 polish call I'll make in Phase 4 with screenshots.
- **Workspace-level "Bulk regenerate" entry point**: the Review queue's "Regenerate flagged images" button is convenient. Bigger question: should there also be one in the grid table header? Probably yes but minor.

## Phasing / order of work

| Phase | Scope                                       | Independently shippable? |
|------:|---------------------------------------------|--------------------------|
| 1     | Voiceover infra (3–4 endpoints, picker UI)  | Yes — solves the user's immediate complaint on its own |
| 2     | Notes schema + 4 REST endpoints             | Yes — no UI yet, but enables backend work |
| 3     | Shared notes UI components                  | No — needs Phase 4 to be visible |
| 4     | Integration into both surfaces              | Yes |
| 5     | Markdown export                             | Yes — small, can roll into Phase 4 |

Each phase = its own PR. Phase 1 alone removes the "Alignment unavailable" pain the user is stuck on today.
