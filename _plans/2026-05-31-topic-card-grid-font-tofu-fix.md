# Topic Card Grid — fix font picker rendering tofu boxes instead of labels

**Date:** 2026-05-31
**Status:** Approved, implementing
**Owner:** Yoav

## Symptom

Every card in a rendered Topic Card Grid shows the label band filled with small
empty rectangles (the "tofu" / missing-glyph pattern) instead of the actual
English label text. Reproduces on every label, every font choice, every grid
size. Was working before commit `7bb12a4` (r2.6 — 22-font picker).

## Root cause

Commit `7bb12a4` introduced `scripts/download-thumbnail-fonts.ts`, which
downloaded all 22 curated Google Fonts as `.woff2` files into
`public/fonts/thumbnail-grid/`. The composite path in
`src/lib/thumbnail-formats/topic-card-grid-composite.ts` then passes those
WOFF2 file paths as the `fontfile` parameter to Sharp's text input.

Sharp on Linux (Vercel's production runtime) uses libvips' bundled Pango +
FreeType. **The prebuilt sharp binary does NOT include brotli support in
FreeType**, so Pango silently fails to decode the WOFF2 file. It falls back
to a system default font which has no glyph data for ASCII → tofu boxes.

The download script's own comment claims WOFF2 was *"verified locally"*. That
verification was on the developer's macOS box (Homebrew freetype is built with
brotli), so it appeared to work. The Vercel deploy never had the missing-glyph
behaviour caught because there were no integration tests that actually
rendered a label and read the resulting pixels.

Legacy `public/fonts/PatrickHand-Regular.ttf` (TTF, pre-picker) still exists
and is referenced by `LABEL_FONT_PATH` as a fallback default. Anything that
goes through the new picker resolves to the `.woff2` and breaks.

## Goals

1. Labels render correctly in every supported font on Vercel production.
2. Browser-side font preview in the picker keeps using WOFF2 (small payload).
3. No regression to existing tests / API contracts.
4. Idempotent re-run of the download script — devs can re-fetch on demand.

## Constraints

- Must work on Vercel's prebuilt sharp binary (no brotli/WOFF2 in Pango).
- Cannot increase the public bundle of the panel page significantly — keep
  browser font payload at WOFF2 sizing.
- Cannot change the public API of the font registry (id, name, family,
  category) — those round-trip through localStorage + saved presets.

## Approach

**Dual-format bundle.** Each font ships as BOTH a TTF (for server Pango) and
a WOFF2 (for browser `@font-face`). The registry gains a new `webFile` field
alongside the existing `file` field. Server callers (`fontFilePath`) keep
reading `file`; browser callers (`fontBrowserUrl`) switch to `webFile`.

This avoids three pitfalls of the alternatives:

- **TTF-only**: bloats the browser font payload ~5x (WOFF2 is brotli-compressed).
  For 22 fonts that's ~3 MB extra on the panel page load.
- **WOFF2-only with brotli polyfill**: would require shipping a custom sharp
  build or adding `@resvg/resvg-js` as an alternative renderer. High blast
  radius; the existing Sharp/Pango pipeline is the standard.
- **Convert WOFF2 → TTF at runtime**: viable but adds a dependency
  (`wawoff2` or similar) and runs decode CPU on every request. Storage is
  the cheaper trade.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Dual TTF + WOFF2 (this plan) | Each runtime gets its native format; trivial to roll back | +~5 MB committed in public/fonts; two filenames per entry | **Chosen** |
| TTF-only | Single source of truth | Panel preview slower; browser font cache larger | Rejected |
| Convert WOFF2 → TTF at runtime | No new committed binaries | Extra dependency + per-request CPU + risk of decode errors | Rejected |
| Inline base64 TTF in JS bundle | Zero filesystem reads | Massive JS payload | Rejected |

## Plan of work

### Step 1 — Update `scripts/download-thumbnail-fonts.ts`

- Fetch BOTH formats per family. WOFF2 via the existing CSS v2 endpoint with
  a modern UA; TTF via the CSS v1 endpoint (`/css?family=`) with EMPTY UA.
  Tested: empty UA + v1 endpoint returns TTF URLs in the response.
- Write `<File>-Regular.ttf` AND `<File>-Regular.woff2` to
  `public/fonts/thumbnail-grid/`.
- Keep the existing failure-counting / total-bytes summary, extended to
  cover both formats.

### Step 2 — Update `src/lib/thumbnail-formats/topic-card-grid-fonts.ts`

- Add `webFile: string` to `ThumbnailFont`.
- For each of the 22 entries, leave `file` set to `<File>-Regular.ttf` and
  add `webFile: '<File>-Regular.woff2'`.
- Update `fontBrowserUrl(font)` to return `/fonts/thumbnail-grid/${font.webFile}`.

### Step 3 — Run the download script

`npx tsx scripts/download-thumbnail-fonts.ts` produces both formats; commit
the resulting TTFs (the WOFF2s are already committed and stay unchanged).

### Step 4 — Update tests

`tests/topic-card-grid-fonts.test.ts` references `.woff2` filenames in its
"every entry has a bundled file" assertion. Update it to require BOTH
extensions and to assert the dual-format contract.

### Step 5 — Verification

- `npm test` passes.
- `npm run build` passes.
- Manual: open the production-doc page, render a Topic Card Grid with the
  default Patrick Hand font, confirm the label band shows actual text.
- Manual: switch to a non-default font (e.g. Bebas Neue), confirm same.
- Manual: open the panel's live preview and confirm the browser-side font
  still loads from the WOFF2 (DevTools Network tab → filter `woff2`).

## Observability

The existing `[topic-card-grid composite font]` log line already includes
`file_path`. After the fix, that line will show a `.ttf` path on every
non-fallback render — that's the diagnostic signal for verifying the fix is
live in production. No new log lines needed.

## Security

No new attack surface. The download script runs once at dev time and writes
to a bundled directory; the runtime read of those files happens via a
hardcoded path computed from `process.cwd()`. No user input touches the font
filesystem path.

## Settings

No new user-facing settings. The registry change is invisible to the picker
UI — same 22 fonts, same dropdown, same selection state.

## Testing

- Unit: `tests/topic-card-grid-fonts.test.ts` extended to assert both
  `file` and `webFile` are present and follow the `.ttf` / `.woff2`
  convention. Continues to enforce id uniqueness + category membership.
- Integration: no new test; the bug class (server-side font load failure)
  needs a real Sharp render in the Vercel-like environment to reproduce,
  which we don't run in CI today. Manual verification documented above.

## Rollback

Revert this commit. The previous behaviour (tofu boxes) returns; the
legacy `LABEL_FONT_PATH` Patrick Hand TTF fallback continues to work for
the bundled-default flow.
