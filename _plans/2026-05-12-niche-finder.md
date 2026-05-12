# Niche finder — concept-cluster engine with a niche-shaped UI

**Date:** 2026-05-12
**Branch:** to be cut from `phase-1-foundation`
**Status:** Approved (multi-phase plan covering v0.5 + v1 + productization). Council-revised: niche is the user-facing unit, concept clusters are the engine underneath. Falsification spike runs as commit 1 of v0.5.

## Goal

Help the operator find new niches for new YouTube channels with the rigor of vidIQ and the monetization slant of nexlev, **without paying for third-party data**. Ship a falsifiable scorer first; layer discovery and watchlist on top once the scorer survives the kill criterion.

The deeper goal is to turn the niche signal into the missing root node for the studio: discovery feeds idea generation feeds publishing feeds analytics feeds back into niche scoring. v1 ships the root node; the flywheel is sketched in Phase 2 of this plan but built later.

## Non-goals

- No third-party data sources in any phase of this plan. ViewStats, SocialBlade, channelcrawler, Glimpse, DataForSEO are explicitly out of scope. If the user later raises the data budget, that becomes a separate plan.
- No general-purpose keyword tool. We are not rebuilding vidIQ's full surface. The scope is "find me a channel to start," not "score every keyword I might use."
- No public productization in v0.5 or v1. Multi-tenant clean architecture is enforced, but the surface stays for the operator's workspace until the productization phase (Phase 3 of this plan) is greenlit.
- No standalone "search-volume" service. We use proxies and label them as proxies.
- No "global niche leaderboard" comparing channels across operators. That violates YouTube ToS at the derived-metric layer (see Security and ToS section).

## User-aligned decisions (locked before plan write)

1. **Audience:** "Me first, productize later." Architecture is multi-tenant from the start; UI and copy target the single operator. The Executor's 15% tenancy overhead is accepted.
2. **Scoring lens:** Hybrid SEO + monetization, weighted toward monetization.
3. **Third-party data budget:** $0. AI plus the YouTube Data API only.
4. **v1 scope:** Discovery + niche deep-dive report + saved-niche watchlist with weekly re-scoring.
5. **Council reframe:** Hybrid unit of analysis. **Niche** is the user-facing unit (familiar, brand-aligned with vidIQ / nexlev). **Concept cluster** is the engine underneath — a group of videos that share an audience and an advertiser pool. The user types or browses niches; under the hood, scoring samples real videos in the concept clusters that compose the niche and rolls up.
6. **Spike-first:** Skipped as a separate task; instead, the kill-criterion test runs as **commit 1 of v0.5** and gates every subsequent commit. The test is non-negotiable.
7. **Plan scope:** Full multi-phase plan including the path to productization.

## Council findings folded into the plan

The pre-plan council pass landed on five points that shape the design. They are baked in here, not left as commentary.

1. **Monetization without paid data is the load-bearing claim of the product.** RPM benchmark tables × mid-roll proxy × sponsorship regex is a credibility trap. The plan replaces this with **per-cluster sampled measurement**: pull 20–50 real videos in the cluster, observe ad-load class from `videos.list contentDetails`, measure sponsor mention density across all top videos (not one), and compute view-velocity decay curves directly from `videos.list statistics` over time. Static RPM tables only inform the *upper bound* of the band; the floor and the point estimate come from measurement.
2. **search.list ranks for end-user relevance, not breadth.** A naive "type niche, run search.list, count channels" approach returns the same 50 mega-channels for any niche. The plan biases discovery toward **deep sampling of identified clusters** rather than **shallow breadth across niches**. We spend our 100-unit search calls on cluster definition, not enumeration.
3. **YouTube ToS forbids derived metrics without an audited use case.** Any external publishing of derived monetization scores breaks the API ToS. The plan keeps all derived scoring **private to the operator's workspace** and surfaces "raw API data + presented to the operator" interpretation. The productization phase requires a YouTube API audit before opening to other workspaces. See Security and ToS section.
4. **The Outsider's plain-English labels win.** Replace DEMAND / SUPPLY / MONETIZATION / FIT with "How many people want this / How crowded it is / How much money it makes / How well it fits you." Replace "confidence band" with "rough guess" vs "pretty sure." Replace "$5-15 RPM (estimated from Finance category benchmark)" with "Channels like this usually earn $5-15 per 1,000 views."
5. **Kill-criterion gate.** v0.5 commit 1 hand-runs the scorer against five named niches with strong operator priors. If the rank order doesn't match the operator's gut, the feature is killed in branch. No code beyond the scorer ships until this gate passes.

## Approach

### The unit of analysis

A **concept cluster** is the engine primitive:

- Defined by a centroid keyword plus 5–15 related terms harvested from YouTube Suggest with an `hl` language tag.
- Populated by sampling the 20–50 most-viewed videos in the cluster from `search.list` (one call per cluster, 100 units), refined by `videos.list` and `channels.list` batch fetches (1 unit each per batch of 50).
- Scored from observed signals on the sampled videos themselves: median duration, mid-roll-eligible share, sponsor-mention density across descriptions (not one regex hit but a density score), view-velocity over the first 7 days, view-velocity decay over the first 90 days, channel age of the top performers, new-entrant break-in rate (how many channels under 12 months old appear in the top 50).
- RPM bands are an *input prior*, not the *output score*. The static category RPM table seeds a Bayesian prior; the per-cluster ad-load observations update it.

A **niche** is a user-facing rollup of 3–8 concept clusters. "Personal finance for software engineers" is a niche; "credit card churning for new grads in tech" is one cluster inside it; "401k rollover strategy for FAANG layoffs" is another. The operator interacts with niches because they are familiar; the model reasons over clusters because they are honest.

The mapping from niche to clusters is AI-assisted (one Sonnet call per discovery, prompt-cached system prompt, ~2k input + 1k output) and human-editable. The AI proposes clusters; the operator can reject, edit, or add.

### Scoring dimensions

Four scores. Surfaced to the operator with plain-English labels. Each is computed at the cluster level and rolled up to the niche.

1. **How many people want this** (demand). Inputs: total estimated annual views in the cluster (sum of view counts on top videos × decay function), YouTube Suggest term density (how many distinct suggested completions exist for the centroid), new-publish rate (count of cluster videos published in the last 90 days). Labeled as a proxy: "We can see how many videos exist and roughly how often people watch them; we cannot see the search volume YouTube hides." Output is `low / medium / high / very high` with the underlying numbers visible on hover.
2. **How crowded it is** (supply). Inputs: top-50 channel count, top-channel subscriber concentration (Gini-style coefficient over the top 10), median channel age of the top 50, break-in rate of channels under 12 months. Output: `wide open / room to enter / crowded / saturated`.
3. **How much money it makes** (monetization). Inputs: median duration of top videos, mid-roll-eligible share, sponsor-mention density score (computed across all 50 video descriptions, not regex hit/miss), category RPM prior from a static table, end-screen merch-link presence. Output: a per-1,000-views range like "Channels like this usually earn $5-15 per 1,000 views," sourced as "estimated from the videos we sampled in this cluster," shown alongside a "rough guess" vs "pretty sure" pill that summarizes the confidence.
4. **How well it fits you** (fit). Inputs: AI rating against the operator's stated interests, language, and time budget. Output: `not for you / could work / strong fit`.

A combined score is computed but de-emphasized in the UI; the four pillars are what the operator looks at. The combined score exists to drive sorting.

### Honest-labeling rules baked in

- Revenue is **always** expressed as a per-1,000-views range, never a monthly dollar figure, never a point estimate.
- Demand is **always** labeled as a proxy, with an info tooltip explaining what we can and cannot see.
- Confidence is **always** present, in plain English: "rough guess" / "fairly confident" / "pretty sure."
- "Channels like this" never names specific channels in revenue claims; it generalizes from the sample.

### Surfaces (in v1; v0.5 is narrower — see Phases)

- `/insights/niches` — the discovery surface. Three inputs: language, region, and three things the operator wants to talk about (free text, the Outsider's prompt). Output: ranked niches with the four scores in plain English.
- `/insights/niches/[slug]` — niche deep-dive. Shows the concept clusters that compose the niche, top channels in each cluster, top video patterns, content angles broken into 5–10 specific video ideas the operator could shoot, AI strategy memo, "what a 10-video bet looks like" projection.
- `/insights/niches/watchlist` — saved niches with weekly re-scoring, sparklines per score, and a "delta" column showing what moved since last week. Each watchlist row links into the deep-dive.

All three live under `/insights/` to match the menu-organization rule used by `/insights/digests` and `/insights/catalog`. No new top-level nav.

### Data ingest

- **YouTube Suggest** (free, no auth, undocumented): `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=<term>&hl=<lang>`. Server-side only (CORS blocks browser). Rate-limited by Google with no published numbers; we cap our own calls at one per second and exponential-back off on 429 or empty responses. Cache results for 7 days per `(term, lang)`. The fragility here is real: if Google changes the endpoint, the discovery surface degrades to "AI-only niche brainstorming" rather than failing hard. The brainstorm path stays implemented as a fallback.
- **YouTube Data API v3** (free, 10,000 units/day default):
  - `search.list` (100 units): one call per concept cluster centroid keyword. With 20 clusters per discovery, one discovery burns 2,000 units. The user can run roughly five discoveries per day on the default quota before exhausting it. We apply for a quota raise to 1,000,000 units/day for our project once v0.5 ships, using the [Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form?hl=en).
  - `channels.list` (1 unit): batch fetch for top 50 channels per cluster.
  - `videos.list` (1 unit): batch fetch for the top 50 videos per cluster, including `contentDetails` and `statistics`.
  - Cache every API response in Postgres for 7 days keyed by request URL hash; serve from cache on re-query.
- **Anthropic Sonnet 4.6** ($3 input / $15 output per million tokens, cache reads at 10%): one call per discovery to map operator interests + niche descriptors into concept clusters; one call per niche deep-dive to synthesize the strategy memo. Prompt-cached system prompts so re-runs hit the 10% cache-read rate.

### Scoring is pure-helper code

All scoring functions live in `src/lib/niche-finder/scoring/` and are pure: inputs in, score out, no I/O. They take the sampled videos and channels as already-fetched data. This keeps them testable, keeps the kill-criterion spike trivial to run, and keeps the scoring engine swappable if we later add paid data.

### AI synthesis is constrained to observed terms

The Executor's prod-failure flag is real: AI tends to hallucinate niche names that don't exist on YouTube. The synthesis prompt constrains the model to label clusters using only terms that appeared in the actual search results we fetched. The system prompt includes the harvested term list and requires the model to pick from it; free-form niche names are rejected at parse time.

## File-by-file plan

### Migration `0055_niche_finder.ts`

(Migration numbers 0053 and 0054 were taken by `pipeline_thumbnail_editor` and `pipeline_seo_step` before this plan landed. Bumping to 0055 / 0056 for this feature.)

Four tables. Workspace-scoped, all with `workspace_id NOT NULL` and `(workspace_id, ...)` composite indexes per the project's tenancy convention.

- `niche_seeds (id, workspace_id, language, region, interests_text, created_at)` — one row per discovery run. Idempotency via a hash column to support re-runs without duplicates.
- `niche_candidates (id, workspace_id, seed_id, niche_slug, niche_name, clusters_jsonb, scores_jsonb, raw_videos_sample_hash, discovered_at)` — one row per niche surfaced in a discovery.
- `niche_reports (id, workspace_id, niche_slug, payload_jsonb, generated_at, model_id, spend_usd_cents)` — AI-generated deep-dive memos, one per niche per generation.
- `niche_watchlist (id, workspace_id, niche_slug, weekly_history_jsonb, alarm_threshold_jsonb, created_at, last_rescored_at)` — saved tracking with weekly score history for sparklines and alarm thresholds for the niche-alarm flywheel hook in Phase 2.

Plus a separate API-cache table (or reuse of an existing cache if one exists) keyed by request-hash for the YouTube API response cache.

### Library

- `src/lib/niche-finder/types.ts` — `NicheSeed`, `ConceptCluster`, `NicheCandidate`, `NicheScores`, `ScoreLabel` (the plain-English union type), `NicheReport`, `WatchlistEntry`.
- `src/lib/niche-finder/youtube-suggest.ts` — server-side fetch of YouTube Suggest with per-second rate limit + 7-day cache. Fallback path returns `null` so the caller can degrade gracefully.
- `src/lib/niche-finder/youtube-fetch.ts` — wraps `search.list`, `channels.list`, `videos.list` with the existing OAuth + key infrastructure plus the 7-day cache. Records quota cost to a counter logged at request-end via the existing structured logger.
- `src/lib/niche-finder/clusters.ts` — given a niche descriptor and a suggested-term list, propose concept clusters. Two paths: (a) deterministic centroid clustering if we have an embeddings model available, (b) Sonnet-assisted partition with strict JSON output constrained to harvested terms. We start with (b) for simplicity; (a) is the cost-down once volume grows.
- `src/lib/niche-finder/scoring/demand.ts`, `supply.ts`, `monetization.ts`, `fit.ts`, `rollup.ts` — pure-function scoring, one file per dimension, plus the niche-level rollup. Every function takes already-fetched data and returns a struct with the numeric score, the plain-English label, the confidence label, and the inputs that drove it (so the UI can show the math on hover).
- `src/lib/niche-finder/rpm-priors.ts` — the static category RPM table that informs the monetization upper bound. Sourced from publicly-documented YouTube category benchmarks. Comments cite the source for every entry and the table is dated; we mark it stale-warn when the file's date is older than 12 months.
- `src/lib/niche-finder/synthesis.ts` — Sonnet call that generates the deep-dive memo. System prompt is byte-stable for prompt-cache hits. Output is strict JSON conforming to the `NicheReport.payload` schema.
- `src/lib/niche-finder/watchlist.ts` — pure helpers for the weekly history rollup, delta computation, and the alarm-threshold check (used by the Phase 2 niche-alarm trigger).

### Routes

All under `apiRoute.authed`, all workspace-scoped, all using the existing `domainErrorResponse` helper from Phase 6.2.

- `POST /api/niche-finder/discover` — kicks off a discovery; returns the seed id plus a server-sent-event stream of niches as they're scored, mirroring the live-critic-panel SSE pattern. Idempotent via the seed-hash column.
- `GET /api/niche-finder/seeds/[id]` — fetch a completed discovery's niches.
- `GET /api/niche-finder/niches/[slug]` — niche detail with the cached scores.
- `POST /api/niche-finder/niches/[slug]/report` — generate or fetch the AI deep-dive memo. Cached for 7 days unless the user requests a re-run.
- `POST /api/niche-finder/watchlist` — add / remove a niche from the watchlist.
- `GET /api/niche-finder/watchlist` — list the operator's watchlist with the latest deltas.
- `POST /api/cron/rescore-niche-watchlist` — weekly Sunday 04:00 UTC, gated by `CRON_SECRET`, drains the watchlist and refreshes scores. Drops the oldest score-history entries beyond a 26-week window.

### UI

- `src/app/(app)/insights/niches/page.tsx` — discovery form + ranked results. Form fields use the Outsider's plain-English prompts ("Tell me three things you'd enjoy talking about"). Results render as a card grid with the four scores as plain-English chips, not numbers. Sort by combined score by default; filter chips by language and region.
- `src/app/(app)/insights/niches/[slug]/page.tsx` — deep-dive. Top section is the four scores with hover-to-show-the-math. Below: cluster breakdown, top channels per cluster with thumbnails and one-line AI summaries, top video patterns, content-angle list, AI strategy memo, "what a 10-video bet looks like" projection.
- `src/app/(app)/insights/niches/watchlist/page.tsx` — table of saved niches with sparklines per score and a delta column. Row click → deep-dive.
- `src/components/insights/niches/` — `NicheScoreChip`, `ClusterBreakdown`, `ConfidencePill`, `RevenueRangeBadge`, `WatchlistSparkline`. Reuses the existing `<PageSkeleton>` for first-paint and `<ScoreRing>` where a numeric backstop is shown alongside the plain-English label.

### Tests

- 100% coverage on the pure scoring helpers (`demand.ts`, `supply.ts`, `monetization.ts`, `fit.ts`, `rollup.ts`).
- Kill-criterion test under `src/lib/niche-finder/__tests__/kill-criterion.test.ts` — five fixtures of real harvested YouTube data the operator names plus a manual rank order; the test asserts the scorer's rank correlates with the gut order at Spearman ρ ≥ 0.7. Failing this test fails the build.
- Auth-gate tests for every new route under `tests/auth-gates.test.ts` (the file from Phase 8.6.4).
- Migration up/down idempotency tests under `tests/migrations.test.ts`.
- Pure-function tests for `clusters.ts` JSON-parse-with-fallback against malformed AI output.

## Phases

This plan ships in three phases. Phases 1 and 2 land on `phase-1-foundation`; Phase 3 is the productization gate and is its own branch.

### Phase 1 — v0.5 (the falsifiable scorer plus deep-dive)

**Goal:** prove the scorer is real and ship the deep-dive on a user-typed niche.

**Scope:**

- Migration 0053 with only `niche_seeds`, `niche_candidates`, and `niche_reports` (no watchlist yet).
- The full scoring engine, kill-criterion test, and AI synthesis.
- One page at `/insights/niches/[slug]` that accepts a typed niche or pasted channel URL, runs the scorer, and renders the deep-dive.
- No discovery surface. No watchlist. No weekly cron.

**Commit 1 is non-negotiable:** the kill-criterion test with five operator-named niches. No subsequent commit lands until this test passes at Spearman ρ ≥ 0.7. If the test fails, we triage the scorer; if we can't get to ρ ≥ 0.7 inside one week, the feature is killed in branch.

**Ship criteria:** kill-criterion test green; the operator runs five real niche checks against current operating decisions and reports back whether the output is actionable.

### Phase 2 — v1 (discovery, watchlist, flywheel hooks)

**Goal:** add the discovery surfaces and weekly tracking, and wire the niche-alarm trigger into the existing workflow registry.

**Scope (revised 2026-05-13):** the operator asked for *all four* discovery modes that the council pass spelled out — they're additive, not alternatives. Each mode lands as its own sub-item.

- **13.2.B — Channel-paste discovery.** Paste a YouTube channel URL (or three video URLs) you admire. We pull the channel's recent uploads, cluster them by topic, score each cluster, and return the 3–5 concept clusters that channel is winning plus headroom for new entrants. This is the First Principles Thinker's v0.5 reframe, deferred from Phase 1 and surfaced here. No new scoring math — reuses the v0.5 pipeline.
- **13.2.A — Interest-based discovery.** Type three things you'd enjoy talking about + language + region. We AI-expand interests into 20–50 candidate niches, run a lightweight scoring pass on each, and return a ranked grid. Click any → full deep-dive (v0.5 flow).
- **13.2.C — Curated category browser.** Pre-built taxonomy (Finance / Tech / Gaming / Travel / History / etc.). Operator picks a category, we show ranked sub-niches inside it with the four-score chips. Click → deep-dive. Static taxonomy hand-curated; refreshable.
- **13.2.D — Outlier finder.** Type a niche, we surface specific *videos* that over-performed for their channel size (views ÷ subs ratio). Different problem shape from A/B/C — answers "what's working *right now* in a niche I'm already in" rather than "what niche should I enter."
- **Watchlist** (the original Phase 13.2 watchlist scope) is deferred to Phase 13.2.W, separate from this discovery push.
- **Flywheel hooks** (Expansionist's contribution) — deferred to Phase 13.2.F, separate.

Migration 0057 adds the single `niche_discoveries` table that caches A/B/C results per workspace + input hash (so re-running the same discovery within the cache window doesn't re-burn YouTube quota). D is fetch-on-demand, served from the existing `niche_finder_api_cache`.

**Ship criteria:** each discovery mode returns a non-degenerate ranking on a real test input; all four routes are `apiRoute.authed`, workspace-scoped, with auth-gate regression tests; the UI hub at `/insights/niches` has four tabs (Interests / Channel / Categories / Outliers) plus the v0.5 typed-input as the fifth fallback; full test suite stays green.

### Phase 3 — Productization (audit + multi-tenant gating)

**Goal:** open the feature to other workspaces without breaking YouTube ToS.

**Scope:**

- Apply for a YouTube API audit via the [Quota Extension and Audit form](https://support.google.com/youtube/contact/yt_api_form?hl=en). Apply for derived-metric permission under the analytics-use-case policy (effective June 1, 2026).
- Once audited and approved, remove the per-workspace gate that restricts the feature to the operator's workspace.
- Add billing-quota fairness: per-workspace daily caps on YouTube API quota consumption so one tenant can't drain the project-wide pool.
- Pricing decision: this is a high-value feature; productization probably means the multi-tenant version is a paid-tier-only add-on. Pricing is out of scope for this plan.

**Ship criteria:** audit approval letter from Google; per-workspace quota caps enforced; load test at 10 concurrent discoveries from different workspaces stays within the project's daily quota.

## Cost estimates (verified May 2026)

Sources cited at the end of this plan.

### Per-discovery cost (Phase 1 and 2)

A typical discovery samples 20 concept clusters across 3 niches.

| Item | Quantity | Unit cost | Cost |
|---|---|---|---|
| `search.list` | 20 calls | 100 units | 2,000 quota units (no $ cost) |
| `channels.list` | 1 batch of 50 | 1 unit | 1 quota unit |
| `videos.list` | 20 batches of 50 | 1 unit | 20 quota units |
| YouTube Suggest | ~30 calls | free | $0 |
| Sonnet 4.6 cluster mapping | ~3k in / 1.5k out | $3/$15 per M | ~$0.03 |
| Sonnet 4.6 deep-dive memos (3 niches) | ~10k in / 3k out each | $3/$15 per M, prompt cache after first | ~$0.05 first run, ~$0.02 cached re-runs |
| **Total per discovery** | | | **~$0.10 in AI, 2,021 YouTube quota units** |

On the default 10,000-unit YouTube quota, this is **~5 discoveries per day** before quota exhaustion. After requesting a quota raise (typical approval: 1,000,000 units/day for legitimate use cases), this becomes ~500 discoveries per day.

### Per-deep-dive-only cost (v0.5)

| Item | Quantity | Unit cost | Cost |
|---|---|---|---|
| `search.list` | 5 calls (one per cluster in the niche) | 100 units | 500 quota units |
| `channels.list` | 1 batch of 50 | 1 unit | 1 quota unit |
| `videos.list` | 5 batches of 50 | 1 unit | 5 quota units |
| YouTube Suggest | ~10 calls | free | $0 |
| Sonnet 4.6 memo | ~10k in / 3k out | cached after first | ~$0.05 first, ~$0.02 cached |
| **Total per deep-dive** | | | **~$0.05, 506 quota units** |

On the default quota, this is **~20 deep-dives per day** before quota exhaustion. More than enough for v0.5.

### Recurring cost (Phase 2 cron)

Weekly rescoring of a 20-niche watchlist:

- ~10,000 YouTube quota units (one per niche, 500 each)
- ~$0.40 in Sonnet calls
- One time per week. Negligible.

### Total expected monthly cost in Phase 1

Operator-only use, ~50 deep-dives + ~10 discoveries per month: **under $2 per month in AI spend**, well within the existing default YouTube quota. No new infrastructure costs (Postgres + Vercel are already provisioned).

## Security and ToS

Per rule 13, this section is mandatory and was load-bearing for the council verdict.

### Data sensitivity

- No user PII flows through the niche finder.
- Operator interests are stored in `niche_seeds.interests_text`. This is workspace-private and encrypted at rest under the existing `ENCRYPTION_KEY` infrastructure (Phase 8.3).
- YouTube API response cache contains public channel and video data. Not sensitive in isolation, but the **derivative scores are sensitive** under the YouTube API ToS and must not leak across workspaces.

### Attack surface

- The discovery route accepts free-text input from the operator, fed into a YouTube Suggest query and an AI prompt. Both are sanitized via the existing `sanitizeForPrompt` helper from Phase 9.8.1 plus a per-character allowlist before the Suggest call.
- YouTube Suggest is third-party untrusted output; we run it through the same sanitization before it enters an AI prompt.
- AI synthesis output is rendered to HTML in the deep-dive memo; we use the `markdownToBasicHtml` helper from Phase 9.8.1 which is the hardened version, not the original.

### YouTube API Terms of Service

**This is the critical finding from the council pass.** The YouTube API ToS as of April 28, 2026 says (verbatim from the Developer Policies):

> Your API Clients must not replace API Data with similar, independently calculated data, or access or use API Data to create new or derived data or metrics.

A new policy effective June 1, 2026 adds:

> These policies are only applicable to audited developers with analytics use cases that have explicitly applied for permission to create additional metrics and/or store statistical data through the standard quota extension request form.

Implications for this plan:

1. **Phase 1 (v0.5):** Single-operator use. The derived scores never leave the operator's workspace. This is a personal analytics use case and falls within the standard developer policy envelope. **Acceptable without an audit.**
2. **Phase 2 (v1):** Still single-workspace. Same as Phase 1. **Acceptable without an audit.**
3. **Phase 3 (productization):** Opening to other workspaces means we are offering a product that creates derived metrics from YouTube API data. **This requires an audit and explicit permission from Google before launch.** The plan gates productization on receipt of an approval letter.

### Other ToS guardrails baked in across all phases

- We do not replace YouTube data with our derived data; we present both. Every derived score in the UI has a hover-reveal showing the underlying API data that drove it.
- We do not store API data indefinitely. Cache TTL is 7 days; aged-out rows are deleted by a daily cleanup cron added under this plan.
- We honor user deletion requests within 30 days. The existing workspace-deletion flow already cascades; this plan adds the `niche_*` tables to the cascade list.
- YouTube Suggest is technically a Google product but undocumented and not covered by the YouTube API ToS. We treat it as a fragile public endpoint and have a fallback. We do **not** present its data as a derived YouTube metric.

### Operational safety

- All four new tables get the same RLS-style workspace gate that every other table in the app has.
- The cron is `CRON_SECRET`-gated like the others.
- API responses are cached with the request-hash as key; we never include user-controlled strings unhashed in cache keys.
- We log quota consumption per request and alert if a workspace burns more than 50% of the daily project pool in one hour.

## Lazy-user walkthrough (per rule 10)

The Outsider's pass is folded in here. Each screen described as a lazy operator would experience it.

### Phase 1 (v0.5) flow

1. Operator clicks "Find what to make videos about" in the Insights nav. Lands on `/insights/niches`. (No, the URL is `/insights/niches`; the link text is plain English.)
2. Single input on the page: "Type a niche you're considering, or paste a YouTube channel URL whose niche you want to study." Optional inputs underneath: language (defaults to the workspace's primary), region (defaults to the operator's).
3. Hits "Show me." Loading spinner with one-line copy: "Fetching the top videos in this niche, scoring them, and writing a strategy memo. This takes about 30 seconds."
4. Lands on `/insights/niches/[slug]`. Top of page: niche name + four big plain-English scores ("How many people want this: high · How crowded it is: room to enter · How much money it makes: $5-15 per 1,000 views · How well it fits you: strong fit"). Each score has a small "?" tooltip with the underlying numbers.
5. Below the scores: cluster breakdown. Three or four sub-niches inside the niche, each a card with its own four scores. The operator immediately sees which sub-niches are the wide-open ones.
6. Below that: top 10 channels in the niche with thumbnails. Each row shows subs, video count, average view count, a one-line AI take.
7. Below that: "What a 10-video bet looks like" — five concrete video ideas, each with a hook, a predicted retention curve placeholder (Phase 2 wires the real retention predictor in), and a "Send to Project" button that one-clicks the idea into a new project.
8. Below that: AI strategy memo, two paragraphs max, plain language, no LinkedIn voice.

Lazy-user checks:
- The operator gets a result from one click and never has to fill out a form with more than three fields.
- Every score is plain English; no number out of 100, no confidence band jargon.
- Every revenue claim is a range, no point estimate.
- The deep-dive ends with a button that turns the report into a project, not with a dead-end "Save report" link.

### Phase 2 flow additions

- The discovery surface adds two more fields above the niche input: "Tell me three things you'd enjoy talking about" (free text) and a single slider for "Do you care more about money or about views" (the Outsider's monetization-tilt fix).
- After a discovery, the operator can star niches into the watchlist. Starring is a single click; the niche appears on `/insights/niches/watchlist` immediately.
- The watchlist surface shows sparklines and a "what changed this week" headline at the top: "Niche X's monetization score went from $5-15 to $12-25 per 1,000 views — likely because three new high-CPM sponsors entered the niche." This is the only re-engagement hook; the council was right that an invisible watchlist dies, so the headline is the email-equivalent in-app.
- A "Send me an email when something interesting happens" toggle wires into the existing weekly digest infrastructure.

## Alternatives rejected

### A. Keep niches as the only unit (no concept clusters)

Rejected per the council. The First Principles Thinker's reframe is correct: scoring at niche granularity hides the long tail where the money is. Without sampling real videos in clusters, monetization scoring collapses into the RPM-table-times-regex theater the Contrarian called out. The plan adopts the hybrid: niche as UI, cluster as engine.

### B. Skip the kill-criterion test, ship discovery first

Rejected. The council unanimously identified the scorer as the load-bearing claim. Discovery surface on top of a broken scorer ships a polished-looking failure. The kill-criterion test is cheap (one fixture file, one Spearman correlation assertion) and saves us from weeks of UI work on a broken core. The user accepted this compromise after the rule-12 push-back: spike-as-commit-1, not spike-as-pre-PR.

### C. Pay for ViewStats or SocialBlade

Rejected because the user's budget is $0. Documented here so the trade-off is explicit: with $30-50/month in third-party data, the monetization score becomes a measurement, not a strong inference. Without it, the per-cluster sampling approach is the best honest path. If the user later opens the budget, replacing the prior in `rpm-priors.ts` with a real per-channel revenue source is a half-day swap.

### D. Build the full Expansionist flywheel in v1

Rejected. The flywheel hooks (auto-draft on score spike, A/B title pre-generation, retention-predictor wiring) are sketched in Phase 2 but most are deferred. Reason: the council convincingly argued that compounding a wrong signal is worse than no signal. Earn the flywheel by proving the scorer first.

### E. Make this a top-level nav entry

Rejected per the existing menu-organization rule (used by `/insights/digests`, `/insights/catalog`, `/insights/niches`). Insights is the right home; niche finding is one more insight surface, not a new product area.

## Open questions

1. Embeddings model for cluster centroiding (long-term, not Phase 1). The plan defaults to Sonnet-assisted clustering. If we want to drop AI cost in Phase 2, do we use OpenAI text-embedding-3-small ($0.02/M tokens) or Google text-embedding-005? Decision deferred to Phase 2 scoping.
2. Sparkline scale: should the watchlist sparkline normalize to the niche's own score range or to a global scale? Initial preference is per-niche normalization (each score's history scaled independently) so the operator sees movement, not absolute level.
3. Re-running deep-dive memos: should the cache TTL be 7 days, 30 days, or operator-triggered? Initial preference is 7 days with a manual "regenerate" button.
4. Phase 3 pricing: this is out of scope for this plan but flagged as a downstream dependency.

## Migration map

- Phase 1: migration `0055_niche_finder.ts` — three tables (`niche_seeds`, `niche_candidates`, `niche_reports`) plus the API cache (if not reusing existing infra).
- Phase 2: migration `0056_niche_watchlist.ts` — one table (`niche_watchlist`) plus index updates.
- Phase 3: no migration; configuration changes only.

## Sources (verified May 12, 2026)

- YouTube Data API quota: [Quota Calculator | YouTube Data API | Google for Developers](https://developers.google.com/youtube/v3/determine_quota_cost)
- YouTube Data API search.list cost: [Search: list | YouTube Data API | Google for Developers](https://developers.google.com/youtube/v3/docs/search/list)
- YouTube Data API getting started + 10K default quota: [YouTube Data API Overview | Google for Developers](https://developers.google.com/youtube/v3/getting-started)
- YouTube API Services Developer Policies (derived-data rules): [YouTube API Services - Developer Policies | Google for Developers](https://developers.google.com/youtube/terms/developer-policies)
- YouTube API Services Terms of Service: [YouTube API Services Terms of Service | Google for Developers](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- YouTube API Audit and Quota Extension form: [YouTube API Services - Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form?hl=en)
- Anthropic Sonnet 4.6 pricing ($3 input / $15 output per million tokens, 10% cache reads): [Pricing - Claude API Docs](https://platform.claude.com/docs/en/about-claude/pricing)
- YouTube Suggest endpoint (undocumented): [Hacking together your own Youtube Suggest API - DEV Community](https://dev.to/adrienshen/hacking-together-your-own-youtube-suggest-api-c0o), [Google Autocomplete / Google Suggest Unofficial Full Specification - Fullstackoptimization](https://www.fullstackoptimization.com/a/google-autocomplete-google-suggest-unofficial-full-specification)
