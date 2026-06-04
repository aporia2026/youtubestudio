# Background music for Shorts — open-source, commercial-rights libraries

Date captured: 2026-06-04
Status: planning. Not yet implemented.

## Goal

Let the creator pick background music for a Short. Mix it under the voiceover
during render. Must be:

- Free (no per-track fee).
- Commercial use allowed (YouTube monetization friendly).
- Ideally CC0 / no attribution (so the editor doesn't have to track + emit
  credits in the video description).

## Inventory (verified 2026-06-04)

### APIs with permissive licensing

| Source | License(s) | Commercial OK | API | Attribution |
|---|---|---|---|---|
| **Freesound** | CC0, CC-BY, CC-BY-NC | CC0 + CC-BY only | OAuth2 REST API at `/apiv2/` | CC0: no, CC-BY: yes |
| **CCMixter** | CC0, CC-BY, CC-BY-NC, CC-BY-SA | Filter CC0 only | Limited REST API | varies |
| **Jamendo** | Mixed | **Paid for commercial** | REST API | n/a — out of scope |

Freesound is mostly SFX but has a music section. Filterable by `tag:music` +
license `Creative Commons 0`. The OAuth2 download flow needs a small server
helper since the API tokens have a default 60-day expiry.

### Free libraries with NO API (browse-only)

| Source | License | Commercial OK | Attribution | Coverage |
|---|---|---|---|---|
| **YouTube Audio Library** | YouTube terms | Yes (on YouTube) | Sometimes | Huge — ~10k tracks |
| **Pixabay Music** | Pixabay Content License (≈CC0) | Yes | No | Large |
| **Mixkit** | Mixkit Free License | Yes (YouTube, web, social) | Optional | Curated, smaller |
| **Bensound** | CC-BY in free tier | Yes (with attribution) | Required | Curated |
| **Incompetech** | CC-BY (Kevin MacLeod) | Yes (with attribution) | Required | Huge — 2000+ tracks |

Mixkit has a TV/radio/games exclusion clause that doesn't affect YouTube Shorts.

## Two paths

### Path A — Curated R2 library (Recommended)

Hand-pick 15–25 tracks from Pixabay / Mixkit / YouTube Audio Library. Download
once, upload to R2 under a `shorts-music/` prefix, expose as a simple picker.

**Pros:**
- Zero dependency on external vendors at render time.
- No OAuth dance.
- All CC0 / Mixkit Free — no attribution complexity.
- Picker is a static list with previews — fast UX.
- Tracks already loop-friendly (we curate for that).

**Cons:**
- Initial curation effort (~30 min).
- Library is fixed unless we add tracks manually.
- R2 storage cost: ~$0.015/GB/mo × 100 MB = $0.0015/mo (negligible).

### Path B — Freesound API integration

Live search Freesound for `tag:music license:"Creative Commons 0"`. Stream
previews; on selection, download via OAuth2 to R2, then mix into the render.

**Pros:**
- Unbounded library; creator can find specific moods.
- No curation work upfront.

**Cons:**
- Freesound's music selection is sparse compared to dedicated music libraries.
  Lots of SFX, not many full tracks suitable for background.
- OAuth2 token management adds complexity (refresh, expiry, per-user vs
  app-level).
- API rate limits ~2000 req/day default — fine, but adds operational concern.
- Search UX needs to filter aggressively (tag:music, duration > 20s,
  license CC0).

### Path C — Hybrid (Recommended IF the curated set proves limiting)

Ship Path A first. If creators ask "I want more options," add a "Search
Freesound" tab to the music picker for power users.

## DB schema

New columns on `shorts` (migration 0119):

```
ALTER TABLE shorts
  ADD COLUMN IF NOT EXISTS music_url TEXT,
  ADD COLUMN IF NOT EXISTS music_volume_db DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS music_start_offset_seconds DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS music_title TEXT,
  ADD COLUMN IF NOT EXISTS music_attribution TEXT;
```

- `music_url`: R2 URL of the chosen track.
- `music_volume_db`: gain reduction relative to the voiceover. Default
  `-18 dB` (background level, voiceover stays clearly on top).
- `music_start_offset_seconds`: where in the track to start playback (so
  the creator can skip an intro). Default 0.
- `music_title`: display label in the editor.
- `music_attribution`: filled when the source needs credit; emitted into
  the YouTube description by the SEO generator. Null for CC0.

## Renderer

Add a `<Audio src={music_url} volume={...} startFrom={...}>` alongside the
existing voiceover Audio in `ShortVideo.tsx`. Volume is a 0..1 multiplier
in Remotion; map `db_to_linear(music_volume_db)` to get there.

Music plays for the full composition length. If the track is shorter than
the composition, Remotion's Audio loops by default — but for a Short
< 60s most tracks comfortably fit.

## Lambda render bundle

Per the user's memory ("Lambda render bundle is separate from Vercel
deploy"), this code change needs `npm run deploy:remotion` to take effect
on Lambda renders. The plan + ship checklist must call this out.

## UI

New section in the Voice tab (or its own "Music" tab if the Voice tab
gets crowded). Picker:

- Grid of curated tracks with title + 30s preview button + ~2-line tags.
- Selecting a track sets `music_url` + `music_title` on the row.
- A volume slider (-30 dB to 0 dB) calibrated so 0 = "as loud as the voice"
  and `-18 dB` is the default for clearly-background.
- A "None" tile to clear the selection.

Settings layer (rule 15): add `default_music_volume_db` to user settings
so a creator's preferred mix volume persists across Shorts.

## Testing

- Migration test (existing pattern).
- Unit test the `dbToLinear()` helper.
- The full mix is verified manually on a render — render a Short with
  + without music and confirm the voice stays intelligible.

## Open questions

- Should we also support **music ducking** (auto-lower music when the
  voiceover is speaking)? Out of scope for v1; the static -18 dB default
  is the bar to hit first.
- Should music loop or fade out at the end? v1: fade-out 1.5s before the
  composition ends so it doesn't cut off awkwardly.
