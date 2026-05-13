---
title: Niche Finder — Browse Categories v2 (extreme filters + hierarchical engine + sweet-spot scanner)
date: 2026-05-13
status: done — all three PRs landed on phase-1-foundation
delivered:
  - PR1 048e7a3 — extreme filters + presets + quadrant view (bundled with PR2)
  - PR2 048e7a3 — hierarchical AI taxonomy + provider-agnostic model picker
  - PR3 b430177 — saved searches + cross-category sweet-spot scanner + nightly sweep
shape: 3 staged PRs, lazy compute + nightly sweep, watchlist-extended saved searches
owner: info@flexelent.com
---

## 1. Goal

Turn the Niche Finder's "Browse categories" tab from a flat curated list of ~60 sub-niches into a tool that can reliably surface niches with **great audience demand and relatively low competition**, plus the monetization economics to make them worth pursuing.

The killer use case: "Show me niches where lots of people are searching, the top channels are not yet huge, and the per-1k-views payout is at least $10."

## 2. Why this matters now

- The data the user needs is already being computed by the v0.5 scoring engine ([scoring/](../src/lib/niche-finder/scoring/)): demand, crowdedness, monetization $/1k views, fit. The current UI just doesn't let you filter or sort on any of it.
- The hardcoded taxonomy ([categories.ts](../src/lib/niche-finder/categories.ts)) caps results at ~60 sub-niches. That is "browse a curated menu," not "discover untapped niches."
- The Outlier tab proved out the filter-bar + range-sliders + presets UX pattern ([OutlierFilterBar.tsx](../src/components/niche-finder/OutlierFilterBar.tsx)). Browse categories has nothing equivalent. Closing that gap is the highest-leverage UX move in the product right now.

## 3. Constraints

- **YouTube Data API quota**: default 10,000 units/day; each leaf scoring costs ~100 units. A full 2,400-leaf scan = ~240,000 units. Mitigation: lazy compute, 7d cache, prioritized nightly sweep within quota, optional quota raise to 1,000,000 units/day.
- **AI cost (Sonnet)**: ~$0.10–0.30 per category for sub-niche brainstorm + ~$0.05–0.15 per sub-niche for micro-niche brainstorm. One-time per (node, lang, region), cached 7d. Full backfill ~$15–40. Verify live prices on [models.dev](https://models.dev/) and Anthropic pricing page before PR2 starts.
- **YouTube ToS / workspace scoping**: per Phase 3 audit, scoring stays workspace-scoped. Taxonomy structure (names, slugs, parent/child) can be global since it is editorial content the system generates, not derived YouTube data.
- **Next.js gotcha**: this fork has breaking changes vs upstream (per `AGENTS.md`). Before adding routes / server actions / params signatures, check `node_modules/next/dist/docs/` for the local conventions.
- **Lazy user lens (CLAUDE.md rule 10)**: filters must be obvious on first look, presets must do the heavy lifting, default sort must surface "great potential + low competition" without the user touching anything.

## 4. Chosen approach: 3 staged PRs

### PR1 — Extreme filters + sort + quadrant view on the existing curated tree

Ship the filter UI against the data we already have. Each curated sub-niche is already scored — surface that.

**UI: new `<BrowseFilterBar>` component**, modeled on [OutlierFilterBar.tsx](../src/components/niche-finder/OutlierFilterBar.tsx) but for sub-niche dimensions.

Filter dimensions (chip + range hybrid, same pattern as Outlier tab):

| Dimension | Chip presets | Range/value control |
|---|---|---|
| Demand | any / medium+ / high+ / very high only | — |
| Crowdedness | any / wide open / non-saturated (≤ crowded) / wide open + room to enter only | — |
| Monetization $/1k views | any / ≥$5 / ≥$10 / ≥$20 | dual-handle slider $0–$50 |
| Fit | any / could work+ / strong fit only | — |
| Format | any / long-form-friendly (≥8m mid-roll) / short-friendly / both | — |
| Language | en / es / pt / de / fr / hi / id / other | dropdown |
| Region | US / UK / CA / AU / IN / global | dropdown |
| Freshness of sample | any / scored in last 30d / 7d | — |

Sort:
- "Sweet spot score" (default) — see formula below
- Pure demand desc
- Pure crowdedness asc (least crowded first)
- Monetization $/1k high
- Fit strongest
- Combined score (existing rollup)

**Default "Sweet spot" sort formula** (computed client-side from existing scores):

```
sweetSpot = demand.rank * 0.40
          + (1 - supply.rank) * 0.35    // invert: less crowded = higher
          + monetizationFloorRank * 0.20
          + fit.rank * 0.05
```

where `*.rank` is the 0–1 normalized rank of the label (e.g. `wide open=1, room to enter=0.66, crowded=0.33, saturated=0`). The 40/35/20/5 weights are a starting point — make them tweakable in code via a single constants block.

**One-click presets (chip row above filters):**

- **Sweet spot** (default) — demand ≥ high, crowdedness ≤ room to enter, $/1k ≥ $10
- **Untapped gems** — demand ≥ medium, crowdedness = wide open
- **Premium RPM** — $/1k ≥ $20 (regardless of demand)
- **Beginner-friendly** — crowdedness = wide open, demand any, $/1k ≥ $5
- **My fit** — fit = strong fit only

**Quadrant view toggle** (chart icon top-right of the grid): scatter of demand (x) × inverted-crowdedness (y), bubble color = RPM band, bubble size = fit. Click a bubble → expands the card below. Library: use whatever charting lib already exists in the repo; if none, plain SVG (~50 lines). Confirm via grep before adding a dependency.

**State persistence**: encode filter state in the URL (`?demand=high+&supply=open&rpm=10&sort=sweet&preset=sweet-spot`), so a user can share a view. Use the same URL-state pattern the Outlier tab uses.

**No new API calls.** PR1 is pure UI over data already returned by `/api/niche-finder/discover/from-category`. Ships value in days.

**Files touched:**
- New: [src/components/niche-finder/BrowseFilterBar.tsx](../src/components/niche-finder/BrowseFilterBar.tsx) — chip + slider row
- New: [src/components/niche-finder/BrowseQuadrantView.tsx](../src/components/niche-finder/BrowseQuadrantView.tsx) — scatter chart
- New: [src/lib/niche-finder/browse-filters.ts](../src/lib/niche-finder/browse-filters.ts) — pure filter/sort functions + presets + sweet-spot scorer (mirror of [outlier-filters.ts](../src/lib/niche-finder/outlier-filters.ts))
- Edit: [src/app/(app)/insights/niches/page.tsx](../src/app/(app)/insights/niches/page.tsx) — wire filters into the Browse Categories tab section (lines ~314–399 + ResultsGrid ~569–593)
- Edit: [src/components/niche-finder/DiscoveryCard.tsx](../src/components/niche-finder/DiscoveryCard.tsx) — add a small "sweet-spot" badge when card matches the default sweet-spot preset

### PR2 — Hierarchical taxonomy: Category → Sub-niche → Micro-niche, lazy AI expansion

Real "more results" requires generating sub-niches and micro-niches programmatically.

**Schema**:

```
niche_taxonomy_nodes
├─ id            UUID PK
├─ parent_id     UUID nullable FK (categories have null)
├─ slug          TEXT (stable, kebab-case)
├─ name          TEXT
├─ level         TEXT CHECK IN ('category','subniche','microniche')
├─ source        TEXT CHECK IN ('curated','ai','harvested')
├─ language      TEXT (e.g. 'en')
├─ region        TEXT (e.g. 'US')
├─ created_at    TIMESTAMPTZ
├─ UNIQUE (parent_id, slug, language, region)

niche_taxonomy_scores
├─ node_id       UUID PK part, FK → niche_taxonomy_nodes
├─ workspace_id  UUID PK part, FK → workspaces  (scoring is workspace-scoped per ToS audit)
├─ scored_at     TIMESTAMPTZ
├─ scores        JSONB (NicheScores shape, same as niche_reports)
├─ sample_size   INTEGER
├─ source_url    TEXT nullable (for harvested nodes)
├─ UNIQUE (node_id, workspace_id)
```

Curated nodes seeded from existing [categories.ts](../src/lib/niche-finder/categories.ts) on migration; AI nodes get generated on first click.

**Lazy expand flow:**

```
GET  /api/niche-finder/taxonomy?parent=<id|null>&lang=&region=
  → returns child nodes from DB (regardless of whether they have scores yet)
  → if zero children and parent.level != 'microniche':
      → generate via Sonnet (constrained JSON), insert, return

POST /api/niche-finder/taxonomy/score
  body: { nodeIds: UUID[], lang, region }
  → for each nodeId: if no fresh score (< 7d) for (node, workspace), schedule scoring
  → returns { scored: [...], pending: [...] }
```

Frontend pattern:
1. Click a category → call `GET /taxonomy?parent=<categoryId>` → render sub-niche cards as **skeletons** if scores missing → fire `POST /taxonomy/score` for those node IDs → stream results in as they come back (Server-Sent Events or polling, decide during implementation; SSE preferred for lazy-user feel per rule 10).
2. Click a sub-niche → same pattern one level deeper for micro-niches.
3. Breadcrumb at top: `Finance › Real estate investing › [micro-niche grid]`.
4. "Brainstorm more" button at each level → calls a `?force=true` variant that asks Sonnet for additional nodes (capped at 50/parent/region to prevent abuse).

**AI prompt design** (locked to JSON schema, no free-form output):

```
System: You generate monetization-tilted YouTube niche taxonomies. Output strict
JSON: { "nodes": [{ "slug", "name", "rationale", "estimated_rpm_band": "low|mid|high" }] }.
Names must be searchable on YouTube (people would actually type this). Slugs must be
kebab-case, unique within the parent. Generate <count> nodes for parent: <parent_name>
in language <lang>, region <region>. No duplicates of existing children: <existing[]>.
```

Validate against a Zod schema server-side; reject + retry once if invalid.

**Files touched:**
- New: [src/lib/migrations/0061_create_niche_taxonomy.ts](../src/lib/migrations/0061_create_niche_taxonomy.ts)
- New: [src/lib/niche-finder/taxonomy-db.ts](../src/lib/niche-finder/taxonomy-db.ts) — CRUD for nodes and scores
- New: [src/lib/niche-finder/taxonomy-generate.ts](../src/lib/niche-finder/taxonomy-generate.ts) — Sonnet wrapper, prompt-cached, Zod-validated
- New: [src/app/api/niche-finder/taxonomy/route.ts](../src/app/api/niche-finder/taxonomy/route.ts) — GET (browse) / POST (force-expand)
- New: [src/app/api/niche-finder/taxonomy/score/route.ts](../src/app/api/niche-finder/taxonomy/score/route.ts) — POST (lazy score)
- Edit: [page.tsx](../src/app/(app)/insights/niches/page.tsx) — Browse Categories tab now uses taxonomy API instead of `/discover/from-category`. Old endpoint stays for migration window.
- Edit: [DiscoveryCard.tsx](../src/components/niche-finder/DiscoveryCard.tsx) — skeleton state + level-aware "Drill in →" button (replaces "Deep dive →" for non-leaf nodes)

**Cost flag (rule 8):** before PR2 lands, fetch live Sonnet and YouTube quota pricing via [models.dev](https://models.dev/) and confirm with user. Expected: ~$15–40 one-time backfill (cached 7d), ~$0.50–2/day steady-state.

### PR3 — Saved searches + cross-category sweet-spot scanner + nightly sweep

**Saved searches via watchlist extension:**

Extend [niche_watchlist](../src/lib/migrations/0059_create_niche_watchlist.ts):

```
ALTER TABLE niche_watchlist ADD COLUMN kind TEXT NOT NULL DEFAULT 'niche';
-- 'niche' (existing) or 'search'
ALTER TABLE niche_watchlist ADD COLUMN search_spec JSONB NULL;
-- For kind='search': stored filter spec (the URL params shape from PR1)
ALTER TABLE niche_watchlist ADD COLUMN search_label TEXT NULL;
ALTER TABLE niche_watchlist ADD COLUMN last_match_count INTEGER NULL;
```

UI: "Save this search" button in the filter bar. Saved searches show up in [/insights/niches/watchlist](../src/app/(app)/insights/niches/watchlist/page.tsx) under a new section with a "Run now" button. Running re-evaluates the filter against all currently-cached taxonomy scores and lists matches with one-click "Add to watchlist."

**Cross-category sweet-spot scanner:**

New entry point on the Browse Categories tab: a top-level "Find the sweet spot across all categories" button. Opens a modal that runs the user's filter against every cached leaf in the taxonomy (any level, any region matching the filter), returning the top N matches sorted by sweet-spot score. This is the "killer use case" surfaced as a one-click action.

Implementation: `GET /api/niche-finder/taxonomy/search?spec=<base64-json>&limit=50` — server-side scan over `niche_taxonomy_scores` joined with nodes, filtered by spec. Pure DB read, no YouTube/AI calls. Fast.

**Nightly sweep cron:**

New cron route + scheduled job to incrementally score the long tail.

Priority queue:
1. Nodes the user has clicked into during the last 7d (signaled via a lightweight click log table or by checking `niche_taxonomy_scores.workspace_id` recency).
2. Direct children of clicked nodes (anticipate the next click).
3. Long tail, breadth-first from root.

Rate limit: cap at 30% of daily quota (e.g. 3,000 units/day on default quota). Skip nodes already scored < 24h. Persist progress so next night picks up where it left off.

**Files touched:**
- New: [src/lib/migrations/0062_extend_watchlist_for_searches.ts](../src/lib/migrations/0062_extend_watchlist_for_searches.ts)
- New: [src/app/api/niche-finder/taxonomy/search/route.ts](../src/app/api/niche-finder/taxonomy/search/route.ts) — cross-cat scan
- New: [src/app/api/cron/niche-taxonomy-sweep/route.ts](../src/app/api/cron/niche-taxonomy-sweep/route.ts) — nightly worker
- Edit: [watchlist page](../src/app/(app)/insights/niches/watchlist/page.tsx) — new "Saved searches" section
- Edit: [BrowseFilterBar.tsx](../src/components/niche-finder/BrowseFilterBar.tsx) — "Save this search" + "Find sweet spot across all" buttons

## 5. Alternatives rejected

**A. "Filter-only on existing curated 60 sub-niches" (small ship).** Cheaper, faster (one PR), zero new API cost. Rejected because the user explicitly wants "much more results"; capping at 60 hardcoded sub-niches violates the spirit of the request even if the filter UX is great. Kept as the content of PR1 — we ship value early without locking out PR2/PR3.

**B. "AI-expand sub-niches per category, two-level taxonomy only" (medium ship).** One AI level (sub-niches), no micro-niches. Rejected because three levels (Category → Sub-niche → Micro-niche) is where the real "low competition" gold lives — micro-niches like "vintage Honda CB750 restoration" beat broad sub-niches like "motorcycle maintenance" for the user's stated goal.

**C. "Eager full backfill upfront."** Pre-compute the whole 2,400-leaf tree once. Rejected because (a) the cost is large and front-loaded with no proof of value, (b) much of the tree will never be looked at, (c) hybrid lazy + nightly converges to the same coverage in ~2 weeks at zero risk.

**D. "New `niche_saved_searches` table separate from watchlist."** Cleaner separation, more code. Rejected because the user's mental model is "stuff I'm watching" — saved searches that produce a list of matching niches are conceptually the same shelf. Extending the existing table is half the code and one fewer concept to learn.

**E. "Plug in a paid SaaS data source (vidIQ, SocialBlade, ViewStats)."** Would give us pre-computed RPM and competition signals out of the box. Rejected because (a) these APIs are expensive at scale, (b) most don't have official APIs and depend on scraping that breaks, (c) the existing in-house scoring engine is honest about confidence and avoids ToS risk, (d) blocks the project on a vendor decision.

## 6. Security & safety (rule 13)

- **AI prompt injection**: AI-generated taxonomy nodes go into a Zod-validated schema. Slugs are regex-checked (`^[a-z0-9-]+$`). Names sanitized for length and shell-unsafe chars before storage. No AI output is ever executed or interpreted as code.
- **Workspace isolation**: taxonomy *structure* is global (low-sensitivity editorial content); taxonomy *scores* are workspace-scoped (`niche_taxonomy_scores.workspace_id` is part of the PK). No score data leaks across workspaces. Enforced at the DB layer with RLS or explicit `WHERE workspace_id = ?` in the data-access layer (mirror the pattern already in [niche-finder/db.ts](../src/lib/niche-finder/db.ts)).
- **API auth**: all new routes go behind existing workspace-auth middleware. Cron route protected by a shared secret header (`x-cron-secret`) checked against env, never logged. No public endpoints.
- **Rate limiting**: per-workspace cap on `/taxonomy/score` POST (e.g. 20 nodes/minute) to prevent runaway quota burn from a misbehaving client.
- **Quota guard**: every YouTube API call goes through the existing quota tracker; cron sweep checks remaining quota before each batch and aborts if below the reserve threshold (so interactive users always get priority).
- **Input validation**: filter spec coming in via URL params or saved-search JSON validated against a Zod schema. Bounded ranges (RPM 0–500, demand label enum, etc) to prevent malformed queries.
- **No PII in AI prompts**: taxonomy generation prompts only contain category/sub-niche names — never user identity, workspace identifiers, or watch history.
- **Scraping fragility**: monetization-check scraper (existing) is unchanged. The new code paths do not add new scraping surfaces.
- **Logging**: log node generation events (node id, level, source, lang) for debugging, but **never** log raw AI prompt/response bodies — they may include category names that hint at user intent. Log token counts and model id only.
- **OWASP top-10 sanity check**: pre-merge for each PR, re-run [security-review](../README.md) skill on the diff.

## 7. Lazy-user lens (rule 10) — flow walk-through

A first-time user lands on the Browse Categories tab. What do they see, what do they try, what do they expect?

1. **First paint**: 12 category cards (instant, no API). Top of page: "Sweet spot" preset chip is **already selected**. A short helper line: "Showing high-demand, low-competition niches with $10+ RPM. Click a category to drill in, or scan all categories →."
2. **They click "Finance"**: sub-niche grid loads with skeleton cards (~1–2 seconds for first-time region, instant from cache). Cards stream in. The sweet-spot ones already have a small green badge.
3. **They want a wider sort**: they hit the sort dropdown, pick "Pure demand." Cards re-order client-side, instant.
4. **They tweak the RPM slider to $20+**: cards filter live. Numbers update.
5. **They click a sub-niche they like ("Real estate investing")**: drills one level deeper, micro-niches load with skeletons.
6. **They find a great micro-niche**: click "Deep dive →" → existing v0.5 flow takes over → full memo.
7. **They want to track it**: existing "Save to watchlist" button (rule: reuse, no new concept).
8. **They want to find more like this across the whole tool**: click "Find the sweet spot across all" → modal lists top 50 cross-category matches for the current filter spec → "Save this search" so they can re-run later.
9. **Mobile**: filter bar collapses into a single "Filters (3 active)" button that opens a sheet. Quadrant view hidden on narrow screens.
10. **Back / refresh / share**: filter state is in the URL. Refresh restores, share-link works.

Friction points to engineer out:
- Skeleton state must not blink (loading delay < 200ms = no skeleton).
- "Brainstorm more" button must not be required to find a sweet spot — defaults must do it.
- Numbers stay plain English ("high · pretty sure") not "0.72 / 100."
- The "Find sweet spot across all" button must be one click, not buried in a menu.

## 8. Open questions

1. **AI model choice for taxonomy generation**: Sonnet 4.6 vs Haiku 4.5 for this kind of structured JSON? Haiku is ~5x cheaper, fast enough for one-shot, and the task is well-bounded. Check [models.dev](https://models.dev/) before PR2; default to Haiku unless quality testing shows otherwise.
2. **Streaming vs polling** for the lazy-score endpoint: SSE feels right for the lazy-user UX, but adds infra complexity. If the median scoring time is < 3s we can probably just block the response. Decide during PR2 implementation.
3. **Click-log for prioritized sweep**: do we add a tiny `niche_taxonomy_clicks(workspace_id, node_id, clicked_at)` table, or just infer from `niche_taxonomy_scores.scored_at` recency? Decide during PR3 design.
4. **Quadrant view library**: check what chart lib (if any) the app already uses; if none, plain SVG is fine.
5. **i18n in node names**: AI generates English-first; do we localize names for non-en regions, or treat (lang, region) as separate taxonomies entirely? Spec says separate, but worth confirming during PR2.
6. **LLM Council pass (rule 11)**: `llm-council` skill is not currently exposed in this session's available skills. Options: (a) wait until it is set up and council the plan then, (b) approximate via parallel Agent subagents with distinct lenses (Contrarian, First Principles, Expansionist, Outsider, Executor), (c) skip the council for this plan. **User decision needed before any PR1 code is written.**

## 9. Out of scope (explicit non-goals)

- The other four tabs (Type / Interests / Channel / Outlier) are not touched. PR1 quadrant + filter patterns may later be reusable there, but not in this plan.
- The watchlist's existing weekly-rescoring infra ([niche_watchlist.weekly_history](../src/lib/migrations/0059_create_niche_watchlist.ts)) is not changed in PR3. Saved searches extend the table but don't change rescoring behavior.
- No new external paid data sources.
- No mobile-app changes; this is web-only.
- Onboarding tour / empty states / a11y polish are PR-by-PR, not a separate effort.

## 10. Definition of done (per PR)

**PR1 done when:**
- Filter bar renders in Browse Categories tab with all 8 dimensions.
- All 5 presets work; "Sweet spot" is the default selected on first load.
- Quadrant view toggle works on desktop, hidden on mobile.
- Filter state persists in URL and shareable links restore state.
- Sort works for all 6 sort options.
- QA (rule 6): golden path verified in browser, edge cases (zero results, slow network, large category) verified, no regressions in Outlier tab filter UX.
- Cost: zero new API spend.

**PR2 done when:**
- Migration applies cleanly on a fresh DB and an existing DB.
- Curated seeds migrate without data loss.
- Click-into-category loads sub-niches in < 3s for cached, < 15s for first-time.
- Click-into-sub-niche loads micro-niches in < 3s for cached, < 15s for first-time.
- "Brainstorm more" works; rate-limited at 50/parent/region.
- Quota guard prevents runaway API calls in a misbehaving session.
- Live AI pricing checked and approved.
- Security-review skill passes on the diff.

**PR3 done when:**
- Save / list / delete / rename saved searches works from the watchlist page.
- Cross-category sweet-spot scanner returns < 1s from cached scores.
- Nightly cron runs reliably and respects the quota reserve.
- Sweep prioritizes recently-clicked nodes first.
- Security-review skill passes on the diff.

## 11. Out

When the user approves this plan, start with PR1. Do not begin code until plan is explicitly approved (rule 3, rule 7).
