# Shot-number badges + narration strip script_text fallback

Small UX polish on the editor's left rail and preview area. Two
independent changes, bundled because they were requested together.

## Goals

1. Make each shot's index visually obvious in the SHOTS list. Today
   it renders as `1. 0:00` in 10px muted grey alongside the timecode,
   so the number reads as part of the timestamp.
2. Show the narrator's text under the preview during playback for
   every project, not only ones where `Generate captions` has been
   run. Today the `NarrationStrip` exists but stays hidden until
   `state.captions` is populated.

## Scope (in)

- `src/components/editor/leftrail/ShotsTab.tsx` — add a bold,
  tabular-nums number badge to the left of the thumbnail; drop the
  `{i + 1}.` prefix from the timecode row.
- `src/app/(app)/edit/[projectId]/EditorClient.tsx` — derive a
  fallback `CaptionsBundle` from `state.doc.rows[i].script_text` +
  `videoConfig.shots[i].startMs/durationMs`, and pass
  `state.captions ?? fallbackCaptions` to `<NarrationStrip>` when a
  voiceover is present.

## Scope (out)

- No new settings UI for the narration strip. `getShowNarrationStrip`
  / `getNarrationFontSize` already exist in localStorage; surfacing
  them in SettingsTab is a separate follow-up.
- No change to the `Generate captions` flow. The fallback is purely
  additive.
- No restyling of the shot tile beyond the number badge.

## Alternatives rejected

- **Make the number bold in place** (same row as timecode). Cheaper
  but the number still competes with the timecode for the user's
  eye. The badge separates the concepts entirely.
- **Always show fallback regardless of voiceover.** The user framed
  the request around "a video that has a voiceover" — for projects
  without VO, hiding the strip matches the current behavior and
  avoids dead vertical space.
- **Auto-generate real captions on first playback.** Heavier (paid
  API call, async wait), and the user already has a `Generate
  captions` button. The fallback is instant and free.

## Implementation notes

- The fallback uses `videoConfig.shots[i].startMs` (post-alignment,
  post-trim) rather than the editor-store `shotStartTimesMs`. When
  voiceover alignment retimes scenes the two diverge, and the
  renderer's start time is what the Player's playhead matches.
- Empty `script_text` rows are skipped so the strip falls back to
  the existing `— silence —` placeholder instead of rendering an
  empty line.
- The `CaptionsBundle` shape (`voiceoverUrlHash`, `modelId`,
  `generatedAt`, `segments`) is reused — fallback fills metadata
  with synthetic markers so any future code that distinguishes real
  vs fallback can do so cheaply.

## Observability

- `[editor narration-fallback] using script_text` info log on the
  first render where fallback kicks in, with `{ rowCount, voiceoverPresent }`.
- `[editor leftrail shots] select` already logs (existing).

## Settings audit

- No new user-facing settings introduced. The existing
  `editor.narration.showStrip` and `editor.narration.fontSize`
  localStorage keys still apply — the fallback respects them
  because it flows through the same `NarrationStrip` component.
- Follow-up (not in this change): wire those two keys into
  SettingsTab so users can hide the strip / adjust its font size
  without dev tools.

## Security

- No external calls, no user input parsed, no new persistence.
  Fallback is pure derivation from existing in-memory state.
