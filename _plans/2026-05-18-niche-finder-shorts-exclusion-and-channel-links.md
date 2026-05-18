# Niche-finder: default-exclude shorts + channel links

**Date:** 2026-05-18
**Status:** Approved (scope confirmed by operator)

## Goals

1. Stop YouTube Shorts (≤ 60s) from dominating niche-finder search results across every surface the niche-finder consumes (cluster harvest, outliers, trending, breakouts, favorites scan). The operator's focus is long-form video.
2. Wherever the niche-finder surfaces a channel (outlier card, deep-dive top-channels list, brief "competition" section), the channel name must be a clickable link to that channel on YouTube.

## Constraints

- Don't burn extra YouTube quota where it's avoidable. The 7-day youtube-fetch cache absorbs repeat hits.
- Don't break existing tests; update them where the default behavior changes.
- Don't backfill old briefs — only newly generated briefs get the structured channel block.
- Don't change the OutlierVideo / FetchedVideo DB shape.
- Match existing code style: same file structure, same imports order, same comment voice.

## Chosen approach

### 1. Shorts filter — post-fetch, default-on

Apply a `seconds > 60` filter after `fetchVideosBatch` returns, at every entry point that maps onto an `OutlierVideo[]`. The YouTube API has no "exclude Shorts" toggle (its `videoDuration` enum only has `short` / `medium` / `long`, and `medium` cuts at 4 minutes — too aggressive for our case), so the post-fetch filter is the only way to get the precise "anything-non-Short" set.

Affected entry points:

- [src/lib/niche-finder/youtube-fetch.ts](src/lib/niche-finder/youtube-fetch.ts) — `harvestClusterSample` gains an `excludeShorts?: boolean` option (default `true`). Filters the `videos` array on the way out and removes any channels that only had Shorts in the sample.
- [src/lib/niche-finder/outliers-general.ts](src/lib/niche-finder/outliers-general.ts) — `findYouTubeTrending` and `findMyChannelBreakouts` apply the same `≤60s` drop before handing to `buildOutliers`.
- [src/lib/niche-finder/outlier-filters.ts](src/lib/niche-finder/outlier-filters.ts) — `DEFAULT_FILTERS.formats` becomes `['normal', 'long']` so the UI's post-filter is consistent with the fetch-layer default. Operator can still click the "Shorts" chip to re-enable.

Tests:
- [tests/niche-finder-outlier-filters.test.ts](tests/niche-finder-outlier-filters.test.ts) — update the "no filters returns everything" expectation to account for the new default. Add a regression test for the new default excluding shorts.

### 2. Channel links

#### B1 — Outlier card

[src/components/niche-finder/OutlierCard.tsx](src/components/niche-finder/OutlierCard.tsx): wrap the `{video.channelTitle}` text in an `<a>` to `https://www.youtube.com/channel/{channelId}`. The outer card is already an `<a>` to the video; the inner channel link uses `e.stopPropagation()` and `role="link"` styling to avoid double-navigation. Open in new tab.

#### B2 — Deep-dive top channels

[src/app/(app)/insights/niches/[slug]/page.tsx](src/app/\(app\)/insights/niches/[slug]/page.tsx): wrap each `<li>` row in `topChannels.slice(0,5).map(...)` with an `<a>` to the channel URL.

#### B3 — Brief "competition" section

[src/lib/niche-finder/brief.ts](src/lib/niche-finder/brief.ts):
- Add a new optional structured field `competition_channels?: Array<{ name: string; channel_id?: string; handle?: string; subs?: number }>` alongside the existing prose `competition` string. The model emits both: free prose for context, structured list for clickable rendering.
- Update the system prompt to instruct the model to populate this array with the 3-5 channels it cites in the prose, including a YouTube channel handle (`@handle`) or channel ID where reasonable. Perplexity Sonar Deep Research has live web access and can pull these out.
- Bump the parsing logic in `parseBriefResponse` (or wherever the JSON is decoded) to accept the new field and pass it through; missing field stays optional for backward compat.

[src/components/niche-finder/NicheBriefCard.tsx](src/components/niche-finder/NicheBriefCard.tsx): render the structured channel list directly below the competition prose. Each channel becomes an `<a>` to `https://www.youtube.com/{handle or "channel/" + channel_id}`. Falls back to plain text when neither identifier is present.

[src/lib/niche-finder/brief-db.ts] (if it exists) — bump the stored JSON to include the new field. No migration needed since it's stored as JSONB and `null` is acceptable for old rows.

## Non-goals

- Don't add Shorts→Longform UI toggle in this PR; the chip filter already lets the user re-enable shorts. A persistent user preference can come later if asked.
- Don't change the OutlierVideo data shape stored in `niche_discoveries`.
- Don't retroactively re-render old briefs with channel links — old briefs simply lack the structured field and show as today.

## Rollout / verification

1. Type-check passes (`npx tsc --noEmit`).
2. Updated tests pass (`npx vitest run tests/niche-finder-outlier-filters.test.ts`).
3. Manual: open the niche-finder Outlier-videos tab on a niche known to have many Shorts (e.g. "history facts") and confirm the result list has zero ≤60s videos by default. Confirm clicking the channel name on a card opens the channel page in a new tab.
4. Manual: open a niche deep-dive page that has clusters with `topChannels` and confirm names are now clickable.
5. Manual: generate a new brief and confirm the competition section shows clickable channel names below the prose.

## Security review

- YouTube channel URLs are GET-only public; nothing sensitive in the request. No auth involvement.
- The new structured channel field on the brief comes from the AI model. Render `name` as text (no `dangerouslySetInnerHTML`), validate `channel_id` matches `/^UC[A-Za-z0-9_-]{22}$/` and `handle` matches `/^@[A-Za-z0-9._-]{3,30}$/` before composing the URL — otherwise fall back to a plain-text rendering. This is the existing pattern used for cluster channelIds, but the brief field passes through AI which means we must validate.
- No new logging of PII; channel IDs are public.

## Risks

- Some niches genuinely surface useful shorts (creator-side reference, hooks for longform). The shorts filter is recoverable via the existing "short" chip in the filter bar. Document this in the OutlierFilterBar tooltip.
- Post-fetch filtering wastes some YouTube `search.list` quota when a query happens to return mostly Shorts. The 7-day cache mitigates the cost on repeat queries.
- Brief prompt change is the largest piece — model may refuse or hallucinate channel handles for niches it doesn't actually know. The handle validation regex prevents bad links from rendering as URLs.
