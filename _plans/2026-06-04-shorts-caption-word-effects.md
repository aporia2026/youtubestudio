# Caption effects: per-word highlighting + more entry effects

Date captured: 2026-06-04
Status: planning. Not yet implemented.

## Goal

The current caption renderer fades / pops / slides each chunk in as a
whole. The creator asked for:

1. **Current-word highlighting** — as the audio plays, the word that's
   actively being spoken gets a distinct style (color, scale, background).
   Karaoke / TikTok-style.
2. **More entry effects** — more visual variety beyond the existing
   fade / pop / slide-up / none.

The codebase already has everything needed for #1: ElevenLabs Scribe
forced-alignment runs after every voiceover (`words[].start`,
`words[].end` in seconds). The renderer just hasn't been wired to use it
at word granularity.

## Approach

### Pipe word-level timing through `buildShortVideoConfig`

Today's `ShortCaptionChunk` is `{ text, start_ms, end_ms }` — one
timestamp pair per chunk. Extend to include a `words` array:

```ts
interface ShortCaptionChunk {
  text: string;
  start_ms: number;
  end_ms: number;
  words?: Array<{ text: string; start_ms: number; end_ms: number }>;
}
```

In `buildShortVideoConfig`, when alignment is present, walk the chunk's
text against the alignment word stream and attach the per-word timings.
When alignment is missing, leave `words` undefined and the renderer falls
back to chunk-level styling (existing behavior).

The text-walk is straightforward because we already do it in
`splitScriptIntoCaptions` to assemble chunks from words.

### Renderer: read `useCurrentFrame()` and decide which word is active

In `DoodleCaptionChunk` (already refactored to take a resolved style via
`resolveDoodleCaptionStyle`):

```tsx
const elapsedMs = (frame / fps) * 1000;
const activeIndex = caption.words?.findIndex(
  (w) => elapsedMs >= w.start_ms && elapsedMs < w.end_ms,
);
```

Then render each word with conditional style based on whether
`index === activeIndex` / `index < activeIndex` (past) / `> activeIndex`
(future). For minimal-style captions, do the same in `MinimalShortVideo`.

### New style fields

Extend `ShortsCaptionsStyle`:

```ts
interface ShortsCaptionsStyle {
  // ... existing ...
  /** Highlight strategy for the currently-spoken word. 'none' renders
   *  every word identically (current behavior). */
  wordHighlight?: 'none' | 'color' | 'scale' | 'background' | 'karaoke';
  /** Color the active word gets when `wordHighlight` is 'color' or
   *  'karaoke'. Defaults to `highlightColor`. */
  activeWordColor?: string;
  /** For 'karaoke' style: color past words get (already spoken). */
  spokenWordColor?: string;
}
```

Five strategies:
- `'none'` — chunk style applies to all words (current).
- `'color'` — current word switches to `activeWordColor`.
- `'scale'` — current word scales 1.15× briefly.
- `'background'` — current word gets a colored background pill.
- `'karaoke'` — past words dim, current word in accent color, future
  words in body color. The classic TikTok look.

### New entry effects

Add to the existing `'none' | 'fade' | 'pop' | 'slide-up'`:

- `'word-by-word'` — words appear one at a time with their `start_ms`.
  Each word fades in 80ms before its own start.
- `'typewriter'` — characters appear linearly across the chunk's
  duration. Uses alignment characters when present; falls back to even
  spacing.

Six entry effects total once shipped.

### UI

Captions tab gains:

- New chip row: "Word highlight" with Auto / None / Color / Scale /
  Background / Karaoke.
- Extended "Effect" chip row with the new word-by-word + typewriter
  options.
- Color picker for `activeWordColor` (defaults to existing highlight).
- Color picker for `spokenWordColor` (karaoke past-word color).

### Per-style defaults

Doodle defaults gain `wordHighlight: 'karaoke'` because the doodle
visual contract (one chunk on screen at a time, yellow on black outline)
is exactly the kind of caption that benefits most from a karaoke look.
Minimal defaults stay `wordHighlight: 'none'` for back-compat.

## Observability

`[shorts caption-words]` info log on the first frame of each chunk:
`{ chunkIndex, wordsAttached, highlightStrategy }`. Off by default in
prod; opt-in via a debug flag.

## Testing

- Pure helper: `findActiveWordIndex(words, elapsedMs)` — covers
  before-first, in-window, between-words (silent gap), past-last.
- Pure helper: `attachWordTimingsToChunks(chunks, alignment)` — covers
  perfect match, words-missing-from-alignment, alignment-words-extra,
  empty alignment.
- Unit-test the `wordHighlight` toggle on the resolver — every new style
  field round-trips with sensible defaults.

## Open questions

- For long chunks (8+ words), the karaoke effect can feel rushed. Add a
  per-chunk minimum word-display time (e.g. words always visible for at
  least 120ms even if alignment says 80ms)?
- Should we also support a "current word kicks the camera" effect on
  doodle (scale the entire frame by 1.02× on word onset)? Bonus polish;
  out of scope for v1.
