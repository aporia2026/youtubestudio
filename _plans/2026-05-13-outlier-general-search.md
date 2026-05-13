---
title: Niche Finder — general outlier search (no niche text required)
date: 2026-05-13
status: in progress
shape: 3 new source-based chip buttons above the niche input + extended /outliers endpoint with `source` discriminator
owner: info@flexelent.com
---

## 1. Goal

Let the operator browse outliers without typing a niche term. Three
distinct sources, each surfacing a different signal:

| Source | What it shows | Latency | YouTube quota |
|---|---|---|---|
| **A. My channel breakouts** | Videos on the operator's own connected channels that the breakout detector recently fired on. | <1s (read from `video_breakout_fires`). | ~1 unit (to re-fetch current view counts for accurate outlier score). |
| **B. YouTube trending** | Globally trending videos via `videos.list?chart=mostPopular&regionCode=…`. | ~1s. | 1 unit per call. |
| **C. Across my favorited niches** | Top outliers from each niche the operator has favorited (non-placeholder scores). | 2-5s for ~5 niches. | ~100 units per niche (existing outlier orchestrator). Capped at 5 niches per call. |

All three return the same `OutlierVideo` shape so the existing
`OutlierCard` UI renders them with zero changes.

## 2. Why honest naming matters

The three sources answer different questions. If we lump them together
behind a single "General search" button, the operator can't tell what
they're looking at. Distinct chip labels keep the intent clear:

- A → "Breakouts on my channels"
- B → "YouTube trending"
- C → "From my favorites"

Each chip empties the niche text input, sets a `source` discriminator
on the next `/outliers` call, and triggers a fetch on click.

## 3. UI changes

Above the existing QUICK SEARCHES row, add a new compact row:
**GENERAL SEARCH** label + three chip buttons. Below the existing
niche input, change the helper copy to read "Type a niche above OR
click a general-search chip to browse without a niche term."

`OutliersTab` state gains an `activeSource: 'niche' | 'breakouts' |
'trending' | 'favorites'`. When the operator types into the niche
input or clicks the existing presets, `activeSource = 'niche'`. When
a chip is clicked, `activeSource` flips and the niche input is
cleared. The "Find outliers" button always respects the current
`activeSource`.

## 4. API changes

`POST /api/niche-finder/outliers` (existing endpoint) gains a body
shape with a discriminated union:

```ts
type Body =
  | { source: 'niche'; niche: string }
  | { source: 'breakouts' }
  | { source: 'trending'; regionCode?: string }
  | { source: 'favorites' };
```

Pre-existing callers send `{ niche }` without `source` → we treat
that as `{ source: 'niche', niche }` for backward-compat.

Output shape is **unchanged**: `{ niche, videos, fetchOk }`. For non-
niche sources, `niche` is a descriptive label ("My channel breakouts",
"YouTube trending — US", "Across 5 favorited niches").

## 5. Per-source backend

**A. My channel breakouts**
- Query `video_breakout_fires WHERE workspace_id = $ AND fired_at > NOW() - INTERVAL '90 days' ORDER BY fired_at DESC LIMIT 50`
- Re-fetch fresh video metadata (title, viewCount, thumbnail) via YouTube `videos.list` (1 batch call for up to 50 ids)
- Also re-fetch channel subscriber counts (already known via `channels` table — lookup by `channel_id` FK, no extra quota)
- Compute outlier score (views ÷ max(subs, 1000)) + classification with the existing `OUTLIER_SUB_FLOOR` helper
- Filter out videos the user no longer has channel access to (rare but possible)

**B. YouTube trending**
- Call `videos.list?part=snippet,statistics,contentDetails&chart=mostPopular&regionCode=…&maxResults=50`
- Region: workspace's primary channel region if available, else 'US'
- Compute outlier score against subscriber counts from each video's `snippet.channelId` — but trending videos are mostly mega-channels, so the score will mostly land in "normal" / "underperformer" buckets. That's honest; we don't fake the math.
- Sort by view count DESC by default

**C. Across my favorited niches**
- Query `niche_favorites` where `deleted_at IS NULL` AND scores are non-placeholder, ordered by `updated_at DESC`, capped at 5 niches
- For each: call the existing outlier orchestrator with the niche's `niche_name`
- Merge results, dedupe by `videoId`, sort by outlier score DESC, cap at 50
- Tag each video with its source niche so the UI can show "from <niche>"

## 6. Caching + rate limit

- A: cache per (workspace_id, hour) for 10 min. Recent breakouts don't churn that fast.
- B: cache globally per (regionCode, hour) for 15 min. Same trending list serves all workspaces in the same region — no privacy concern since this is YouTube's public chart.
- C: no extra cache layer. The underlying outlier orchestrator already uses YouTube-fetch's 7-day cache; rate-limited at the route level.

Rate limit: 30 calls/min per workspace IP across all sources combined (matches the existing outlier route's quota posture).

## 7. Out of scope (deferring)

- Combining all 3 sources into a single merged feed. Each source is its own click; merging confuses the meaning of "outlier score" across data shapes.
- Source-D / personalization tier (Expansionist council take). Defer until A+B+C are validated in production.
- Cross-workspace public trending. The YouTube trending cache could be shared across workspaces but adding that requires a new table; v1 stays per-call.

## 8. Phasing

Single PR (small): backend + UI + cache + helper text. All three sources at once because the UI shape is uniform — there's no value in shipping A without B and C.

Falsification gate (per CLAUDE.md rule 6): for each source, click the chip and verify (a) results render, (b) the niche label in the heading is descriptive, (c) the outlier score math makes sense for the source.

## 9. Files

- `src/lib/niche-finder/outliers-general.ts` — three source-specific fetchers + the dispatcher
- `src/app/api/niche-finder/outliers/route.ts` — extend body validation + dispatch on `source`
- `src/app/(app)/insights/niches/page.tsx` — new GENERAL SEARCH row in OutliersTab + activeSource state

---

Will revise the plan if the implementation surfaces something the plan didn't anticipate.
