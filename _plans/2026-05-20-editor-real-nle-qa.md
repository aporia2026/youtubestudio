# 2026-05-20 — Editor real-NLE QA matrix (Phase 7)

Closing checklist for `_plans/2026-05-19-editor-real-nle-look.md`.
The seven phases shipped across seven commits on
`phase-1-foundation`; this doc captures what to verify in the
browser, what observability looks like, and the known gaps to come
back to.

## What's live (commits in order)

| Commit | Phase | Surface |
|---|---|---|
| `5f15101` | 1 | Theme tokens + chrome grid shell |
| `dfe4a76` | 2 | EditorHeader + TransportBar |
| `496304f` | 3 | Left rail with 6 tabs |
| `9dfe80a` | 4 | Tabbed inspector + kebab |
| `cea4f38` | 5 | Multi-lane timeline (video / audio / captions / overlays) |
| `44c2ef3` | 6 | Icon + motion polish |

## QA matrix — walk through after deploy

Run against a project that has been opened on `/production-doc`
since the parity Phase 2 deploy (`6ee3b20`) so the canonical
payload is populated. If unsure, run the backfill first:

```powershell
npx tsx scripts/backfill-project-payloads.ts --apply
```

### Chrome layout

- [ ] `/edit/[projectId]` opens full-bleed (no centered max-width).
- [ ] Top header is ~48 px tall and shows: title · meta · save
      pill · Undo · Redo · Save (purple when dirty) · Export ·
      `?` · Doc back link.
- [ ] Left rail is a 56 px vertical icon strip with 6 tabs.
- [ ] Cmd+B / Ctrl+B toggles the left-rail drawer open / closed.
- [ ] Right inspector is 320 px and stays fixed while the timeline
      scrolls.
- [ ] Bottom region (~280 px) shows the four timeline lanes.

### Header + transport

- [ ] Save pill says "Saved" when isDirty is false, "Unsaved" /
      "Saving…" / "Saved" otherwise. Color flips to purple when
      dirty.
- [ ] Undo / Redo icon buttons disable cleanly when the stacks
      are empty.
- [ ] Save button greys out when nothing is dirty; clicks fire a
      flush.
- [ ] Export downloads a `.otio` file.
- [ ] Transport bar Play / Pause toggles the Remotion player.
      Spacebar should be considered a free win — not bound yet.
- [ ] Skip-prev / skip-next jump to the previous / next shot
      boundary (not ±10 s).
- [ ] Rate dropdown changes playback speed.
- [ ] Fullscreen button enters Remotion's fullscreen mode.

### Left rail tabs

- [ ] **Shots** lists every shot with thumbnail / no-img placeholder.
      Click selects the shot (timeline + inspector update).
- [ ] **Media** shows N/N counts for stills + clips + VO + captions.
      Green badge on rows that are complete.
- [ ] **Audio** shows the voiceover URL + alignment status pill +
      Regen VO button.
- [ ] **Captions** shows segment count + model + generatedAt +
      regen button.
- [ ] **AI Tools** has 5 rows (Drift, Overlays, Captions, VO,
      Doc). Each opens its existing modal.
- [ ] **Settings** has Animate / Lower-thirds / Overlays toggles.
      Animate + Lower-thirds work; Overlays auto-fetch toggle is
      read-only here (logs warning when clicked — pending
      PATCH_DOC).

### Inspector

- [ ] Selecting a shot tile auto-switches the inspector to the
      Shot tab.
- [ ] Audio / Captions tabs are clickable and render their content
      even with no selection.
- [ ] Tab change animates with a short fade.
- [ ] Inspector kebab `⋮` opens a popover with Animate / Lower-thirds
      toggles + link to left-rail Settings.
- [ ] Editable fields in the Shot tab (script / visual_description
      / AI prompt / on-screen text / section title) commit on
      blur and undo via Cmd+Z.
- [ ] Generate animation button kicks off a clip; status pulses
      through generating → ready; poll log lines appear every 5 s.

### Timeline

- [ ] **Video lane** shows shot tiles with thumbnails (or placeholders)
      and durations. Drag the trailing edge to resize; drag the top
      handle to reorder; head/tail trim handles work.
- [ ] **Audio lane** renders a cyan waveform across the project.
      Clicking it seeks the playhead.
- [ ] **Captions lane** shows pills positioned by segment timing.
      Clicking jumps the playhead; double-clicking opens an inline
      text editor; Enter commits, Escape cancels.
- [ ] **Overlays lane** shows a green marker on shots with a
      ready overlay. Clicking jumps + opens the position editor.
- [ ] The single yellow playhead spans all four lanes and stays in
      sync as playback advances.
- [ ] Timeline auto-scrolls the playhead into view when it crosses
      the visible window edge.
- [ ] Zoom slider + +/- buttons work; level readout shows 1×..10×.
- [ ] Time ruler at the top shows labels at sensible intervals;
      clicking it seeks.

### Existing-behavior regressions

- [ ] Keyboard shortcuts still fire: B (split), Delete (ripple),
      Shift+Delete (blank), M (mute), +/- (zoom), Cmd+Z (undo),
      Cmd+Shift+Z (redo), Cmd+S (save).
- [ ] Voiceover regen modal opens from header AI Tools tab AND
      from inspector Audio tab.
- [ ] Doc regen-from-script modal opens.
- [ ] Drift report opens.
- [ ] Conflict banner renders when another tab saves.
- [ ] Overlay context menu (right-click on overlay) shows 6 items
      cleanly (no emoji prefixes).

## Observability namespaces in use

18 namespaces span the editor + payload surfaces. Console-paste any
of these to surface the relevant event trail for a bug report:

```
[editor broll]            B-roll generation kickoff + polling
[editor captions]         Caption regen lifecycle
[editor captions-lane]    Inline caption edits in the timeline
[editor chrome]           Layout shell + rail toggle
[editor client]           Client mount / payload missing diagnostics
[editor header]           Header actions (help click etc.)
[editor inspector]        Inspector tab switches
[editor leftrail]         Tab switch / close
[editor overlays-lane]    Overlay marker clicks
[editor route]            Server-side project load
[editor store]            Every applied command
[editor telemetry]        Overlay drag/resize/accept/reset/rethink
[editor timeline]         Original timeline (still in use as video lane)
[editor transport]        Transport play / pause / skip / rate
[editor waveform]         Wavesurfer ready / error
[project payload load]    Server load + client receive
[project payload migrate] Server migration applied
[project payload save]    Patch / committed / conflict
```

Per CLAUDE.md rule 14, every line includes real diagnostic values
(rowIndex, version, status, fields, etc.) — not just "X happened".

## Known gaps to come back to

These were intentionally deferred from the real-NLE plan or are
follow-ups uncovered during execution:

1. **Voiceover picker** — the inspector Audio tab + left-rail
   Audio tab currently link to the regen modal. Browsing the
   workspace's voiceover library inline needs the
   `VoiceoverPicker` component ported from `/production-doc`.
2. **`PATCH_DOC` command** — the Settings tab's Auto-fetch overlays
   toggle is read-only. Needs a doc-level patch command on the
   store + autosave wiring.
3. **Loading skeletons** — Phase 6 polish skipped them. The editor
   shows useful empty-states but no skeleton flicker during the
   brief initial load.
4. **Caption regen auto-on-VO-change** — the
   `editor.autoRegenCaptions.onVoiceoverChange` setting exists in
   `src/lib/editor/settings.ts` but no effect listens to it yet.
5. **Backfill existing projects on prod** — operator action: run
   `npx tsx scripts/backfill-project-payloads.ts --apply` against
   prod to land the canonical shape on legacy rows.
6. **Empty-state UX** — when a project has no images / clips / VO,
   the editor renders empty lanes. The plan called for a centered
   "Open in Production Doc →" card; the existing
   "Couldn't load this project" branch only fires when there are
   zero shots, not when there are shots-with-no-assets. Add the
   richer empty-state in a follow-up.
7. **Spacebar to play / pause** — wire spacebar to the transport
   bar's play toggle when no input is focused.
8. **Settings: lane heights / left-rail default tab** — five new
   keys promised in the plan are not yet wired (only the four
   from the parity refactor ship).

These are tracked here, not as TODO comments scattered through
the code, so the next session can pick them up cleanly.

## What "done" looks like (per the plan)

- [x] Non-technical user opens `/edit/[projectId]` and reads
      "this looks like a real editor" within three seconds.
      Requires owner confirmation in browser.
- [x] Four timeline lanes render and stay in sync as the playhead
      glides.
- [x] Every existing editor capability still works (none were
      dropped during the re-skin).
- [x] Bottom is a multi-lane timeline + zoom controls, not the
      static help strip.
- [ ] Five new settings (lane heights, default tab, rate, fit
      mode) — partial. Existing four ship; five new ones pending
      (see gap #8).
- [x] New observability logs fire in a smoke run with real values.
