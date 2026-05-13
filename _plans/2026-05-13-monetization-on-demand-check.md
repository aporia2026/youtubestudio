# Outlier card: on-demand monetization check

**Date:** 2026-05-13
**Status:** approved, ready to build
**Affects:** niche-finder mode D (outlier finder)
**Follows:** 2026-05-13-outlier-filter-range-sliders.md

## Goal

The YouTube Data API doesn't publish per-video monetization status
for channels we don't own. The "Likely monetized" filter chip is a
heuristic (≥1K subs + ≥8 min duration); it narrows the list but
doesn't confirm. Add a per-card "Check monetization" button that
fetches the public watch page, parses `ytInitialPlayerResponse`,
and returns a definitive answer for that one video.

## Why per-video, not bulk

Auto-checking every outlier search burns time + bandwidth + ToS
exposure for videos the user may never look at. Lazy on-demand
keeps cost at zero for 99% of cards and only scrapes the ones the
user actually researches.

## Constraints

- **No automatic bulk fetching.** The fetch only fires when the
  user clicks the button on a specific card.
- **Cache aggressively.** Reuse the existing `niche_finder_api_cache`
  table (7-day TTL) keyed on `monetization-check:<videoId>` so a
  second click on the same video is free.
- **ToS exposure.** Scraping youtube.com is a ToS-violation surface.
  Mitigations: (a) only fire on explicit user action, (b) realistic
  user-agent, (c) request-rate limited by virtue of being human-
  driven, (d) clearly comment the fragility in code so future-us
  knows where to look when YouTube changes the HTML.
- **Fragility.** YouTube changes the watch-page HTML structure
  every few months. The parser must degrade to `unknown` rather
  than throw when the expected fields are missing — losing
  monetization detection is acceptable; crashing the route is not.

## Design

### Status enum

Three states. Don't pretend a confident answer when the page
doesn't expose one.

```ts
type MonetizationStatus = 'monetized' | 'not-monetized' | 'unknown';
```

### Detection logic

Parse `ytInitialPlayerResponse` from the watch-page HTML, then:

1. **`playabilityStatus.status !== 'OK'`** (private, deleted, age-
   restricted, region-blocked) → `unknown`.
2. **`adPlacements` array non-empty** → `monetized`.
3. **`playerAds` array non-empty** → `monetized`.
4. **`videoDetails.isLiveContent === true`** → `unknown` (live ad
   model is different; the static page often lacks `adPlacements`
   even for monetized streams).
5. **Status `OK` + neither ad field populated** → `not-monetized`.
6. Anything else / parse failure → `unknown`.

Multiple positive signals reduce false negatives when YouTube
shuffles field names.

### API contract

```
POST /api/niche-finder/monetization-check
Body: { videoId: string }
Response: {
  videoId: string,
  status: 'monetized' | 'not-monetized' | 'unknown',
  reason: string,           // human-readable why (for the tooltip)
  checkedAt: string,        // ISO timestamp
  cached: boolean
}
```

Auth: same `apiRoute.authed` wrapper the other niche-finder routes
use. Workspace-scoped not strictly needed (data is public) but
the auth gate keeps anonymous traffic out.

### Cache key

`monetization-check:<videoId>` via `cacheKey({ method: 'GET',
url: 'https://www.youtube.com/watch?v=' + videoId })`. Reuses
the existing `niche_finder_api_cache` table — no schema change,
no migration. 7-day TTL matches the rest of the niche-finder
cache so we don't pile up two retention policies.

### UI

A small "Check monetization" button below the metadata line on
each `OutlierCard`. States:

- **Idle:** subtle "Check monetization" text-button.
- **Loading:** "Checking…" with disabled state.
- **Result:** Replaced with a status pill:
  - `Monetized` (green) with title `"adPlacements populated on watch page"`
  - `Not monetized` (grey) with title `"watch page returned no ad placements"`
  - `Unknown` (amber) with title containing the specific reason
    (private, age-restricted, live, parse-failed, etc).

The status pill stays after the result returns; clicking it
re-queries (force-refresh). The card-level state is component-
local — no global store needed.

## Implementation order

1. **Plan doc** (this file).
2. **`src/lib/niche-finder/monetization-scrape.ts`** — pure parser
   `detectMonetizationFromPlayerResponse(json)` and the network
   wrapper `checkVideoMonetization(videoId)` that does the fetch,
   parse, cache. Logger emits on fetch and on parse failure.
3. **Tests** at `tests/niche-finder-monetization-scrape.test.ts`
   covering: monetized fixture, not-monetized fixture, private/
   age-restricted/live → unknown, broken-JSON → unknown, missing
   fields → unknown. Pure-function only (no network).
4. **API route** at `src/app/api/niche-finder/monetization-check/
   route.ts`. `apiRoute.authed`, POST body validated, calls
   `checkVideoMonetization`, returns the response shape above.
5. **`OutlierCard`** wiring — useState for `{status, loading,
   reason}`, fetch on click, render the button/pill.
6. **QA** — golden + edges, typecheck, full niche-finder suite.

## Security / safety

- The route is authed; no anonymous traffic.
- Output of the scrape is sanitized to the enum + a static reason
  string set by us; we don't forward arbitrary YouTube content
  back to the client.
- We never log the full watch-page HTML (could contain PII in
  embedded comments / descriptions); only the videoId + status.
- The user-agent header is set to a realistic browser string.
  Not technically required, but reduces the chance YouTube serves
  a CAPTCHA challenge page.
- We do **not** retry failed fetches inline. The user re-clicks
  if they want another attempt.

## Open questions

- **Quota / IP-block risk at scale.** At single-user research
  speeds (clicking a few cards per session), this is not a
  concern. If we ever expand to bulk auto-check, we'd need
  residential proxies. Not in scope for v1.
- **Shorts behaviour.** Shorts ad model differs; the page may
  not populate `adPlacements` consistently. The fixture-driven
  tests will surface this if it's an issue; for v1 we accept
  that Shorts return `unknown` more often.

## Alternatives considered

- **Auto-check every card in the result set.** Rejected: ~150
  fetches per outlier search, takes 30+ seconds parallel, burns
  bandwidth + ToS exposure for cards the user never looks at.
- **Third-party paid service (Apify).** Rejected for v1: adds
  cost ($5–30/mo + per-video charges) and a vendor dependency
  for a feature that's free to implement ourselves. Keep as an
  upgrade path if our IPs get blocked.
- **Display result inline in the metadata line without a
  button.** Rejected: implies we already know the answer for
  every card; auto-fetching defeats the lazy design.
