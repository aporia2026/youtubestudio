# Niche-finder: language + region picker (post-fetch filter + global picker)

**Date:** 2026-05-18
**Status:** Approved (scope confirmed by operator)

## Goals

1. When the niche-finder language is set to English, results must actually be in English — Bollywood / non-Latin-script content must not leak through. YouTube's `relevanceLanguage=en` is an advisory bias only; we need a real post-fetch filter.
2. Operator can change the language and region from inside the niche-finder, persistently, without going to a separate settings page. The setting applies to every tab + deep-dive.

## Constraints

- Don't burn extra YouTube quota for the filter (works on already-fetched data).
- Don't break the existing category-tab picker (which has its own per-tab selector).
- Don't add a language-detection library — heuristic only, since we're at the loose tier (Latin script + the video's own `defaultAudioLanguage` tag where YouTube provides it).
- User-settings field must follow the existing `default_broll_model_id` / `default_style_preset` pattern.
- The post-fetch filter must be opt-in via a `language` option, so callers can disable it for queries where filtering is wrong (e.g. multilingual cluster harvest on a non-English niche).

## Chosen approach

### A — Post-fetch language filter

[src/lib/niche-finder/youtube-fetch.ts](src/lib/niche-finder/youtube-fetch.ts):

- Add a pure helper `isLatinDominantTitle(title: string): boolean`. Returns `true` when ≥ 50% of the non-whitespace characters in the title are ASCII letters + Latin-Extended block. Empty / punctuation-only / digit-only titles return `true` (we don't drop them — they're ambiguous, not foreign-script).
- Extend the YouTube `videos.list` interface (`VideoListItem`) and the `FetchedVideo` shape to carry `defaultAudioLanguage` and `defaultLanguage` when YouTube returns them.
- Add a `language?: string` option to `harvestClusterSample`. When the requested language starts with `en` (case-insensitive), the post-fetch filter drops a video when:
  - The title fails the Latin-dominant check, AND
  - The video's `defaultAudioLanguage` or `defaultLanguage` (if YouTube provided one) doesn't start with `en`.

  Videos with no language tag and a Latin-dominant title pass through. Videos with `defaultAudioLanguage=en` and a non-Latin title also pass (a creator captioned in English with a Hindi-titled video gets the benefit of the doubt).

[src/lib/niche-finder/outliers-general.ts](src/lib/niche-finder/outliers-general.ts):

- Same post-fetch filter wired into `findYouTubeTrending` (the existing single-source path that builds `FetchedVideo[]` directly).
- `findOutliersAcrossFavorites` inherits via `findOutliers → harvestClusterSample`.
- `findMyChannelBreakouts` — apply with the operator's own setting; if they post Hindi content on their own channel, they can switch the locale.

[src/lib/niche-finder/outliers.ts](src/lib/niche-finder/outliers.ts):

- `findOutliers` passes its `args.language` through to `harvestClusterSample` (already does; the new option flows naturally).

### B — Per-user persistence

[src/lib/user-settings.ts](src/lib/user-settings.ts):

- Add `niche_finder_language?: string` and `niche_finder_region?: string` fields to `UserSettings`. Follow the same nullable-with-default pattern as `default_broll_model_id`.

New file [src/app/api/user/settings/niche-finder-locale/route.ts](src/app/api/user/settings/niche-finder-locale/route.ts):

- `GET` returns `{ language, region }` with the defaults `'en' / 'US'` applied when unset.
- `PUT` accepts `{ language?: string; region?: string }` — validates against an allow-list of ISO 639-1 codes (15-ish common languages) + ISO 3166-1 region codes (15-ish common regions). Persists via `updateUserSettings`.

### C — Global picker UI

New file [src/components/niche-finder/NicheFinderLocalePicker.tsx](src/components/niche-finder/NicheFinderLocalePicker.tsx):

- Two select dropdowns (Language, Region) + an info note explaining what they do.
- Loads current values from `/api/user/settings/niche-finder-locale` on mount.
- Writes back to the same endpoint on change, then calls a parent `onChange` callback so the page re-fetches in the new locale immediately.

[src/app/(app)/insights/niches/page.tsx](src/app/\(app\)/insights/niches/page.tsx):

- Add page-level `language` + `region` state, lifted from the picker.
- Picker rendered above the tab list, with a tooltip "Applies to every tab + deep-dive."
- Pass `language` / `region` down to each tab as props.
- Each tab includes the values in its API request body.

### D — Wire through every flow

- `TypeNicheTab` → `/api/niche-finder/deep-dive` body gains `language`/`region`.
- `InterestsTab` → `/api/niche-finder/discover/from-interests` already accepts them; just thread through.
- `ChannelTab` → `/api/niche-finder/discover/from-channel` already accepts them; just thread through.
- `CategoryTab` → already has its own picker; replace its local state with the global one so the two stay in sync.
- `OutliersTab` → `/api/niche-finder/outliers` 'niche' body gains `language`/`region`.

### E — Tests

[tests/niche-finder-ingest.test.ts](tests/niche-finder-ingest.test.ts):

- Pure helper coverage for `isLatinDominantTitle`. Cases: ASCII, accented Latin, mixed punctuation, Devanagari, CJK, Arabic, empty, whitespace-only, numeric-only.

## Non-goals

- No language-detection library (e.g. franc, cld3). Heuristic is intentional.
- No translation. We surface English content; non-English niches require the operator to pick the matching language.
- Don't backfill the new fields on existing user-settings rows — they stay undefined and use the default until the operator changes them.
- Don't add a strict English-only check (council-style stopword detector). User picked the loose tier.

## Rollout / verification

1. `npx tsc --noEmit` clean.
2. New + existing niche-finder tests pass.
3. Manual: deep-dive on "movies" with default 'en'/'US' → no Bollywood channels in the cluster top-channels list, no Devanagari titles in top-videos.
4. Manual: change the picker to 'hi'/'IN' → Bollywood content returns.
5. Manual: refresh the page → picker shows the saved selection.

## Security review

- New `language`/`region` API field validates against a fixed allow-list of ISO codes (no free-form input → no injection / XSS surface).
- The strings reach YouTube's API which is GET-only and tolerant.
- Encrypted user-settings blob inherits the existing AES-256-GCM at-rest encryption.
- No new logging of PII.

## Risks

- The Latin-dominant heuristic over-includes Spanish/French/German titles when the operator picks 'en'. Acknowledged in the loose-tier choice — user explicitly preferred over-inclusion to false negatives.
- The picker is per-user (not per-workspace) — a teammate on the same workspace can have a different locale. Matches the existing `default_broll_model_id` precedent.
- Adding the `language` filter doesn't fully fix the cluster harvest in `run-deep-dive.ts` because the **clustering** prompt is what produced the "movies" centroid — that's an AI step. The filter operates on the SAMPLED videos used to score each cluster, so the top-channels and top-videos lists will be cleaner, but the cluster names themselves are independent of this filter.
