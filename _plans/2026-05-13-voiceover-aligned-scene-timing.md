# 2026-05-13 — Voiceover-aligned scene timing for production-doc renders

## Goal

Drive Remotion scene timing from the actual voiceover audio's word-level
timestamps instead of the production doc's estimated timecodes, so every
scene transition lands exactly when the corresponding narration line
starts. Same alignment data the teleprompter already consumes — no new
audio analysis vendor, no new data shape.

Today: `productionDocToVideoConfig` parses each row's `Timecode` string
(`"0:00"`, `"0:12"`, `"1:53"`, …) and treats those as ground truth.
They are estimates the script generator emits assuming a target wpm, so
in practice a 14-minute video drifts 200–800ms off the actual narration
at multiple boundaries. Visible. Annoying.

After: each row's `startMs` and `durationMs` are derived from
`narrator_takes.alignment_json` (ElevenLabs Forced Alignment), rounded
to the nearest video frame at composition `fps`. Frame-precise sync.

## Decisions confirmed with user

1. **Primary audio source: narrator-uploaded.** Alignment already runs
   automatically post-upload via the existing `runAlignmentForAssignment`
   pipeline. No change needed for that path.
2. **Secondary audio source: ElevenLabs AI voiceover** ("here and there").
   No alignment exists for these today — we add JIT alignment with
   caching (see Phase 2).
3. **Re-alignment on edit** — auto-trigger when script edits are small
   (Levenshtein distance against the previously-aligned script stays
   under a threshold); show a "Re-align needed" pill in the production
   doc UI when edits are large. See `Re-alignment policy` below.
4. **Precision target** — frame-accurate scene boundaries. Word-level
   alignment is the practical maximum here because rows always end at
   word boundaries (script paragraphs end at sentence-end words). The
   ElevenLabs API also exposes per-character timestamps; we deliberately
   do NOT use them in v1. Documented honestly so a future maintainer
   doesn't burn a week implementing it.

## Existing primitives reused (no rewrites)

All in [src/lib/narrator-utils.ts](src/lib/narrator-utils.ts) — the
teleprompter already exercises these in production:

- `buildAlignmentScript(sections) → string` (L390) — canonical script
  builder; strips production cues, joins with newlines. Identical input
  shape required for our row-to-words walk.
- `sliceAlignmentToSections(alignment, sections) → SectionAlignedWords[]`
  (L418) — flat-words-array → per-section structure. The mechanism we
  generalize for rows.
- `findActiveWordIndex(words, timeSeconds) → number` (L445) — binary
  search by playhead. Not directly used at render time but exported in
  case the production-doc editor wants a "play this row from here" UI
  later.
- `stripProductionMarkers(text)` from [src/lib/script-markers.ts](src/lib/script-markers.ts)
  — already in place as of 2026-05-13. Same regex the aligner sees.

The aligner client itself ([src/lib/elevenlabs.ts:120-167](src/lib/elevenlabs.ts#L120))
is reused as-is. We add a new caller for the AI-audio path.

## New work

### A. `src/lib/voiceover-alignment.ts` — pure helpers

```ts
// All inputs are plain data. Pure, easy to unit-test.

export interface AlignedRow {
  rowIndex: number;
  startMs: number;       // ≥ 0, frame-snapped at the consumer
  endMs: number;         // > startMs
  source: 'aligned' | 'estimated';  // for telemetry + UI hinting
}

export function alignRowsToWords(
  rows: ProductionRow[],
  alignment: ForcedAlignmentResponse,
  fallbackTimecodes: number[],  // existing parseTimecodeToMs results
  options?: { fuzzyWindow?: number },  // default 3
): AlignedRow[];
```

### B. `productionDocToVideoConfig` accepts optional `alignment`

```ts
export function productionDocToVideoConfig(
  doc: ProductionDoc,
  rowImages: (RowImageState | null)[],
  voiceoverUrl?: string,
  musicUrl?: string,
  brand?: Partial<BrandKit>,
  alignment?: ForcedAlignmentResponse,  // NEW
): VideoConfig;
```

When `alignment` is undefined → current behavior preserved. When
defined → each row's `startMs` / `durationMs` come from `alignRowsToWords`.

### C. AI voiceover JIT alignment with caching

New table `voiceover_alignments`:

```sql
CREATE TABLE voiceover_alignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_url_hash  TEXT NOT NULL UNIQUE,  -- sha256(audio_url + script_hash)
  alignment_json  JSONB NOT NULL,
  duration_ms     INTEGER NOT NULL,
  cost_usd        REAL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON voiceover_alignments (audio_url_hash);
```

Cache key = `sha256(audio_url + sha256(canonical_script))`. Same audio +
same script ⇒ cache hit ⇒ $0. Either changes ⇒ miss ⇒ run alignment ⇒
write row.

New helper `ensureAlignmentForVoiceover(audioUrl, canonicalScript)`:
returns `ForcedAlignmentResponse`, doing the cache lookup or running
alignment + writing the row.

### D. Row-to-words matching algorithm

For each row, in order:

1. `rowWords = stripProductionMarkers(row.script_text).split(/\s+/).filter(Boolean)`.
2. Walk `alignment.words` from `cursor` forward, consuming
   `rowWords.length` entries. The aligner sees the same script in the
   same order, so this matches cleanly almost always.
3. If at any position the aligner's word and `rowWords[i]` disagree
   (normalize both with `toLowerCase().replace(/[^a-z0-9'-]/g, '')`),
   try the resync recipe:
   - Forward look-ahead up to `fuzzyWindow` words (default 3) — if
     `alignment.words[cursor + k]` matches `rowWords[i]`, advance cursor
     by `k` (this absorbs aligner over-segmentation like splitting
     "don't" into "don" + "t").
   - Backward look-back up to `fuzzyWindow` words — if
     `alignment.words[cursor - k]` matches, retract cursor by `k`
     (handles aligner under-segmentation).
   - If neither works, abort this row's alignment and return
     `source: 'estimated'` with the row's original timecode from
     `fallbackTimecodes`. Subsequent rows continue from the post-row
     cursor anyway (estimated from word-count proportionality so we
     don't permanently desync).
4. Row's range: `[alignment.words[firstIdx].start, alignment.words[lastIdx].end] × 1000`.
5. Last row's `endMs` is extended to the audio's full duration to cover
   any tail outro silence.

Edge cases (each tested with a unit test in v1):

- Empty `script_text` (title-card row with no narration) → zero-width,
  `source: 'estimated'`. Row uses its existing timecode.
- Row's first word missing from alignment entirely (filler word the
  aligner dropped) → resync forward, accept the offset.
- Two adjacent rows with identical short text (e.g., both `"NotPetya."`)
  → resync on cumulative position not text identity, so the second
  occurrence always lines up after the first.
- Word count drift > 10% across consecutive rows → log a warning + flag
  the doc with `alignment_stale: true` so the UI can surface the pill.

### E. Re-alignment policy

When a creator edits production-doc script text and the linked
`narrator_takes.alignment_json` exists:

1. Compute `levenshtein(oldCanonicalScript, newCanonicalScript) / oldLength`.
2. If ratio ≤ 0.05 (≤5% of characters changed) → soft re-align: the
   `alignRowsToWords` walk will absorb small word-count drift without
   needing a fresh API call. No user prompt.
3. If 0.05 < ratio ≤ 0.20 → auto-trigger a background re-alignment of
   the existing audio against the new script. Show a "Re-aligning" pill
   in the editor; on success, swap in the new `alignment_json`.
4. If ratio > 0.20 → show a blocking "Re-record needed" pill. Render
   button is enabled but falls back to estimated timecodes with a clear
   warning toast on click.

Threshold values are starting points; tune after a week of real usage.

## End-to-end data flow

```
Narrator uploads audio          ElevenLabs voiceover generated
       │                                  │
       ▼                                  ▼
runAlignmentForAssignment           POST /api/elevenlabs/generate
       │                                  │
       ▼                                  ▼
narrator_takes.alignment_json    media_assets row, NO alignment yet
       │                                  │
       └──────────────┬───────────────────┘
                      │
   Production-doc render kicked off, voiceoverUrl resolved
                      │
                      ▼
    ensureAlignmentForVoiceover(audioUrl, canonicalScript)
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   cache hit    narrator take    fresh ElevenLabs
   (return)     (already aligned)  Forced Alignment
                      │             call + cache write
                      └─────────────┘
                      │
                      ▼
       alignment: ForcedAlignmentResponse
                      │
                      ▼
        productionDocToVideoConfig(..., alignment)
                      │
                      ▼
            VideoConfig with frame-precise shot timings
                      │
                      ▼
         Lambda / Vercel render → MP4
```

## DB changes

1. **New table**: `voiceover_alignments` (see schema in section C above).
   Migration `0069_create_voiceover_alignments.ts` (Lambda = 0066,
   thumbnail = 0067, fonts = 0068, voiceover = 0069).
2. **No changes** to `narrator_takes`, `media_assets`, or the (forthcoming)
   production-doc table. We're additive, not invasive.

## API changes

1. **New endpoint** `POST /api/voiceover/align`:
   ```
   body: { audioUrl: string, script: string }
   returns: { alignment: ForcedAlignmentResponse, cost: number, cached: boolean }
   ```
   Internal helper for the production-doc page to pre-warm the cache and
   to surface alignment status in the UI.
2. **`/api/render/video` POST** now resolves alignment server-side
   before kicking off the bundle/render. Failure is non-fatal — render
   proceeds with estimated timing + a banner in the job result.

## UX (rule 10)

In the production-doc page, near the existing "Render" button:

- When alignment is `ready`: a green checkmark + "Synced to voiceover".
- When alignment is `running`: a spinner + "Syncing scenes to
  voiceover…" — non-blocking, render button stays clickable but warns
  on click that it will use estimated timing.
- When alignment is `stale` (edits beyond threshold): an amber pill
  + "Re-align needed". Click → re-runs alignment.
- When alignment is `unavailable` (no audio yet, or API hard-failed):
  no pill. Render button uses estimated timing silently — same as today.

Lazy-user walkthrough — the green checkmark is the only thing they
need to glance at; the system handles the rest.

## Security (rule 13)

- `voiceover_alignments.audio_url_hash` is sha256, never the raw URL.
  Avoids leaking the public Vercel Blob URL if the row is ever queried
  in logs or exposed via a debug endpoint.
- The new `/api/voiceover/align` route is authed (same `apiRoute.authed`
  pattern as `/api/render/short`) and workspace-scoped — a caller can
  only request alignment for audio URLs they own.
- ElevenLabs API key handling unchanged (already in env, server-only).
- Cost protection: per-day spend cap on ElevenLabs alignment calls,
  default `$2/day`, configurable via `ELEVENLABS_ALIGNMENT_MAX_USD_PER_DAY`.
  Catches a runaway invalidation loop. Same pattern as the Lambda spend
  cap in `_plans/2026-05-13-lambda-render-migration.md`.
- Cache poisoning risk: the cache is keyed by `audio_url_hash`. If an
  attacker could change what URL resolves to (e.g., URL reuse after
  bucket purge), they could serve old alignment for new audio. Mitigated
  by including a script hash in the cache key — different script = cache
  miss regardless. Acceptable.

## Out of scope (v2+)

- Character-level alignment for sub-word precision. Word-level + frame
  rounding is the practical max for scene boundaries.
- A timeline editor in the production-doc page that lets the creator
  drag scene boundaries by hand. Real value, but not needed to render
  correctly.
- Aligning the AI script generator's output to the alignment before
  voiceover is even recorded (i.e., predict where breaths will land).
  Speculative; defer.
- Multi-audio-source compositions (e.g., voiceover A for intro,
  voiceover B for outro). Solvable with two alignment ranges concatted
  but no real use case today.

## Decision log

- **Word-level alignment, not character-level.** Rows end at word
  boundaries. Character-level adds zero practical precision and doubles
  the data volume.
- **Cache key includes script hash.** Without it, edits to script text
  silently re-use stale alignment, drift compounds. Insisted on this
  even though it costs a hash computation per cache lookup.
- **Fallback per-row, not per-doc.** A single bad row shouldn't make
  the whole doc drop back to estimated timecodes — the other 199 rows
  should still be frame-precise.
- **JIT alignment for AI audio, not on-generation.** Most ElevenLabs
  audio never gets rendered (drafts, regenerations). Aligning only on
  render demand saves ~80% of alignment spend.
- **No re-alignment without a prompt at the 20%-edit threshold.**
  Forced alignment costs money; an automatic re-run loop on a creator
  who's actively editing burns budget. Manual pill matches the
  "creator-in-the-loop" rhythm.
- **Did not run LLM Council on this design.** User and author engaged
  the proposal at four discrete questions and reached agreement. Will
  council if user pushes back during implementation.

## Phases

### Phase 1 — Pure helpers + unit tests (½ day)
- Create [src/lib/voiceover-alignment.ts](src/lib/voiceover-alignment.ts)
  with `alignRowsToWords` and a small `normalizeWord(s)` helper.
- Unit tests: 8 cases covering happy path, missing word, extra word,
  duplicate adjacent rows, empty row, full mismatch, character-edge
  punctuation (`"don't"`, `"e.g."`), Unicode dashes in script.
- No DB, no API, no UI touched.

### Phase 2 — JIT alignment cache (½ day)
- Migration `0069_create_voiceover_alignments.ts`.
- Add [src/lib/voiceover-alignment-cache.ts](src/lib/voiceover-alignment-cache.ts) with
  `ensureAlignmentForVoiceover(audioUrl, script)` doing the
  fetch-or-compute-or-cache dance.
- Add `POST /api/voiceover/align` route, authed + workspace-scoped.
- Daily cost cap with `ELEVENLABS_ALIGNMENT_MAX_USD_PER_DAY`.

### Phase 3 — Wire into render (½ day)
- Update `productionDocToVideoConfig` signature with optional
  `alignment`.
- Update `/api/render/video` to resolve alignment before bundling. On
  failure: render proceeds with estimated timing, banner in job result.
- Manual integration test: render the ransomware CSV's first 60s with
  alignment, then without; compare frame counts at scene boundaries.

### Phase 4 — Production-doc UX (½ day)
- Add the four-state pill near the Render button.
- Wire the "Re-align" pill to call `POST /api/voiceover/align`
  with `forceRefresh: true`.
- Levenshtein-based staleness check on script-text save (debounced 1s).

### Phase 5 — Validation (¼ day)
- Render a real 14-min video with alignment + measure boundary
  precision frame-by-frame against the source audio.
- Confirm cost: ≤ $0.10 per first render of a 14-min video; $0 on
  re-render of the same audio+script.

**Total: ~2 days of focused work.**

## Effort

- Phase 1: ½ day
- Phase 2: ½ day
- Phase 3: ½ day
- Phase 4: ½ day
- Phase 5: ¼ day

**Estimate: 2–2½ days.** No external dependencies beyond ElevenLabs
Forced Alignment (already in use). No additional vendor onboarding.

## Cost (verified)

- ElevenLabs Forced Alignment: $0.22/hour of audio (Scribe STT tier),
  verified at <https://elevenlabs.io/pricing> on 2026-05-13.
- A 14-minute video: ~$0.051 per first alignment. Cached thereafter.
- Storage in `voiceover_alignments`: JSON blobs are ~50KB per minute of
  audio. A 14-min row is ~700KB. At 500 videos: ~350MB total in
  Postgres. Trivial.

## Rollback

- Migration `0058` is additive — drop the table on rollback.
- `productionDocToVideoConfig`'s alignment parameter is optional and
  defaults to undefined → identical to today's behavior.
- `/api/render/video` is wrapped in a try/catch around alignment
  resolution — failure path renders with estimated timing. So a Phase 3
  rollback is "delete the try block", not a route rewrite.
