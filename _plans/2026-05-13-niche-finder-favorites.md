---
title: Niche Finder — Favorites (star on every result, AI Niche Brief, beautiful CSV + Google Sheets export)
date: 2026-05-13
status: approved — building PR1
shape: 1 schema migration + 1 new tab + favorite button on all card types + background AI Niche Brief + dual export (CSV/Sheets)
owner: info@flexelent.com
default_model: Perplexity Sonar Deep Research (overridable per workspace via existing model picker)
verified_pricing_date: 2026-05-13
council_run: 2026-05-13 (5 advisors + 5 anonymized peer reviewers + synthesis)
---

## 1. Goal

Let the operator one-click "save" any niche or video they encounter anywhere in the Niche Finder — Browse / Interests / Channel / Category / Outliers — into a single **Favorites** tab. Each favorite niche carries an AI-written **Niche Brief** explaining whether **this operator** can win this niche, the videos saved under it as proof points, the operator's own verdict on the brief, eventual production outcome, and one-click export to a beautiful, shareable CSV or Google Sheet that anyone can read without context.

The bar: point a non-technical collaborator at the export and they understand, in 30 seconds, *which* niches we are evaluating, *why* each one is promising, *what* the competition looks like, *what* the top proof videos are, and (over time) *how* our past decisions actually played out.

## 2. Why this matters now

- The Niche Finder already surfaces strong candidates across five tabs but the operator has no place to **collect** the ones they like. Promising niches either get watchlisted (monitoring, not ideation) or lost.
- The watchlist ([watchlist.ts](../src/lib/niche-finder/watchlist.ts)) is the wrong primitive for this — it is built for periodic re-scoring and alarm thresholds. A favorite is an editorial signal ("we are considering this"). Conflating the two muddies both.
- The codebase already has every piece needed: the model picker ([NicheFinderModelPicker.tsx](../src/components/niche-finder/NicheFinderModelPicker.tsx)) with Sonar Deep Research in the catalog, a production-doc Google Sheets exporter ([google-sheets-schedule.ts](../src/lib/google-sheets-schedule.ts)), a CSV pattern ([schedule-export.ts](../src/lib/schedule-export.ts)), a cron pattern ([niche-taxonomy-sweep](../src/app/api/cron/niche-taxonomy-sweep/route.ts)), and a Postgres migration system. Mostly assembly, not invention.

## 3. Constraints

- **AI cost (verified live 2026-05-13 on docs.perplexity.ai/getting-started/pricing)**: Sonar Deep Research is $2/M input + $8/M output + $2/M citation tokens + $3/M reasoning tokens + $5/1k search queries + $8/1k requests at medium context. A typical Niche Brief lands at **~$0.05–0.08 per generation**. 200 favorites + a few regenerations = ~$15–20.
- **Workspace isolation** (rule 13): every table, every query, every export is workspace-scoped. We also add `created_by_user_id` per row for future multi-seat semantics.
- **Google Sheets OAuth scope** is already in place ([google-oauth.ts](../src/lib/google-oauth.ts)). No new consent flow.
- **Next.js gotcha** (AGENTS.md): this fork is not stock Next.js. Before using `after()` or any fire-and-forget pattern, **check `node_modules/next/dist/docs/` for the local convention**.
- **Lazy user lens** (rule 10): one-click favorite, background brief, no friction.
- **Falsification gate (added from council run)**: before PR2 ships, the operator runs 3-5 sample briefs by hand via the Perplexity UI on real niches and answers honestly: "would I bet $5k of production budget on this?" If 3 of 5 are usable, PR2 proceeds. If not, the brief gets prompt-engineered until it does or gets cut.

## 4. Decisions locked with the user

| # | Question | Answer |
|---|---|---|
| 1 | When favoriting a video, how does it map to a niche? | **Hybrid** — auto-attach when context is unambiguous, prompt picker otherwise. |
| 2 | When is the AI brief generated? | **Hybrid robust** — auto on first favorite, manual Regenerate, auto re-run on metric drift, stale-badge when scores have moved. |
| 3 | Export shape | **Both** — per-niche export button + top-level "Export all favorites" button. CSV + Sheets each. |
| 4 | Default model | **Perplexity Sonar Deep Research** (most advanced tier). User-overridable. |
| 5 | Memo language | **Always English** — maximum shareability with collaborators. |
| 6 | Cost visibility | **Monthly tally** — small caption in the Favorites tab header: "Spent this month on briefs: $X.XX". |
| 7 | Remove behavior | **Soft-delete + 30d restore window** — recoverable bin, then purged. |
| 8 | Compare view | **Ship in v1** — side-by-side 2-3 niches with their briefs and score deltas. |

## 5. Council-driven tweaks absorbed (the softer ones)

The LLM Council pressure-tested the original architecture. Most of its big swings (rename to Shortlist, force decision clock, kill the memo, downgrade to Sonar Pro) were rejected as overreach. These 7 lower-cost, higher-value tweaks were absorbed:

1. **Pipe operator context into the AI prompt** — workspace interest tags + connected channel description + niches we've already produced in. Without this, "Operator Fit" is hallucinated.
2. **Verdict + Outcome fields** on each favorite as first-class data — `verdict ∈ {accept, override, reject}`, `outcome ∈ {producing, produced, parked, killed}` with optional reason + produced-video link. Enables month-3 retrospective: "did the briefs predict actual production winners?"
3. **Confidence + source-quality labels** in each brief section ("Confidence: low/medium/high" + Perplexity citations flagged by domain quality: YouTube / Reddit / news / SEO blog). Combats the "credible-looking citations on synthesized analysis" risk.
4. **Ghost-reference guard** — on Favorites tab open, revalidate each saved video via cheap YouTube API HEAD check (cached 24h). Dead videos get a "removed" badge and are excluded from exports.
5. **Glossary footer in the Sheets export** — a "Read me first" block at the top explaining Niche / Outlier / Niche Brief / Promise score, so the export is self-explanatory.
6. **Renamed "Promise Memo" → "Niche Brief"** in UI, export, and code. Less legalistic, instantly readable.
7. **`created_by_user_id` column** on every favorite row — multi-seat forward-compat at zero current-day cost.

## 6. Branch points — alternatives weighed (recap)

Per CLAUDE.md rule 4, the decision points that had real options:

### 6A. Data model — chosen: separate `niche_favorites` + child tables

Three tables (favorites + videos + versioned briefs) over extending the watchlist or denormalizing into jsonb. Clean separation of concerns, supports brief versioning, plays well with watchlist as a parallel primitive.

### 6B. AI orchestration — chosen: hybrid (instant + inline async + cron safety net + manual + drift-triggered)

Sync-on-click rejected (slow click), pure cron-only rejected (5-min latency to first brief). Hybrid gives instant favorite, brief appears within ~10s of inline kickoff, cron retries any that drop, operator can regenerate at will.

### 6C. Default model — chosen: Sonar Deep Research

Council Contrarian argued Deep Research will scrape SEO listicles. Mitigated by: (a) piping operator context into the prompt (tweak #1), (b) confidence + source-quality labels (tweak #3), (c) falsification gate before PR2 ships, and (d) operator can switch to Sonar Pro or Anthropic any time via the picker.

## 7. Data model

```
niche_favorites
  workspace_id           text          PK part 1
  niche_slug             text          PK part 2
  niche_name             text          NOT NULL
  source_tab             text          NOT NULL    -- 'type'|'interests'|'channel'|'category'|'outliers'|'manual'
  scores                 jsonb         NOT NULL    -- snapshot of NicheScores at save time
  notes                  text          NULL        -- operator's free-text
  status                 text          DEFAULT 'considering'  -- 'considering'|'committed'|'parked'|'passed'
  verdict                text          NULL        -- 'accept'|'override'|'reject' — operator's reaction to the brief
  verdict_reason         text          NULL
  outcome                text          NULL        -- 'producing'|'produced'|'parked'|'killed'
  outcome_video_id       text          NULL        -- if produced, the video we made
  outcome_reason         text          NULL
  created_by_user_id     text          NOT NULL    -- forward-compat for multi-seat
  created_at             timestamptz   DEFAULT now()
  updated_at             timestamptz   DEFAULT now()
  deleted_at             timestamptz   NULL        -- soft delete; cleanup cron purges after 30d

niche_favorite_videos
  id                     uuid          PK
  workspace_id           text          NOT NULL
  niche_slug             text          NOT NULL
  video_id               text          NOT NULL
  channel_id             text          NOT NULL
  title                  text          NOT NULL
  thumbnail_url          text          NULL
  view_count             bigint        NULL
  published_at           timestamptz   NULL
  outlier_score          numeric       NULL
  classification         text          NULL
  duration_iso           text          NULL
  channel_title          text          NULL
  subscriber_count       bigint        NULL
  is_removed_upstream    boolean       DEFAULT false   -- set by ghost-reference guard
  last_validated_at      timestamptz   NULL
  added_at               timestamptz   DEFAULT now()
  added_by_user_id       text          NOT NULL
  FOREIGN KEY (workspace_id, niche_slug) REFERENCES niche_favorites
  UNIQUE        (workspace_id, niche_slug, video_id)

niche_favorite_briefs
  id                     uuid          PK
  workspace_id           text          NOT NULL
  niche_slug             text          NOT NULL
  model_id               text          NOT NULL
  sections               jsonb         NOT NULL   -- structured by section (see §8)
  promise_score          int           NOT NULL   -- 0-100
  section_confidences    jsonb         NOT NULL   -- {market_demand: 'high', competition: 'medium', ...}
  citations              jsonb         NULL       -- [{url, title, domain, domain_quality: 'high'|'medium'|'low'}]
  operator_context       jsonb         NOT NULL   -- snapshot of what we fed in (interest tags, channel desc, produced-niches)
  scores_snapshot        jsonb         NOT NULL
  prompt_tokens          int           NULL
  completion_tokens      int           NULL
  cost_usd               numeric(10,4) NULL
  status                 text          NOT NULL   -- 'pending'|'running'|'ready'|'failed'
  attempts               int           DEFAULT 0
  error_message          text          NULL
  generated_at           timestamptz   DEFAULT now()
  FOREIGN KEY (workspace_id, niche_slug) REFERENCES niche_favorites
```

Indexes: `niche_favorites(workspace_id, status, updated_at DESC)`, `niche_favorite_briefs(workspace_id, niche_slug, generated_at DESC)`, partial index for `WHERE status IN ('pending','running','failed')` to support the cron retry.

## 8. The Niche Brief — what the AI produces

Structured JSON output rendered as a card in UI and a section in the export. Sections, length budgets, and confidence labeling:

| Section | Contents | Length | Confidence label |
|---|---|---|---|
| `headline` | One-sentence verdict. | ~25 words | overall |
| `promise_score` | 0–100 integer + word label (Strong / Solid / Marginal / Weak). | — | overall |
| `market_demand` | Why the audience is real, how big, trend direction. | ~80 words | per-section |
| `competition` | Top channels in the niche, gaps, references actual saved videos. | ~80 words | per-section |
| `monetization` | RPM range, ad-friendliness, sponsorship + affiliate angles. | ~80 words | per-section |
| `operator_fit` | **Grounded in operator data**: interest tags + channel description + niches operator has already produced in. The "why us?" line with real input, not hallucinated. | ~60 words | per-section |
| `risks` | Saturation, demonetization, COPPA/kids, copyright, audience age, platform dependence. | ~80 words | per-section |
| `recommended_angle` | Single creative direction to win this niche given the above. | ~50 words | per-section |
| `next_steps` | 3 concrete things the operator could do this week. | bullets | — |
| `citations` | Perplexity-returned URLs **tagged by domain quality** (`youtube`, `reddit`, `news`, `seo_blog`, `other`). | list | — |

**Prompt construction** (tweak #1):
- Niche name, slug, current scores
- Top-N favorited videos with channel sizes + outlier classifications
- Operator's interest tags from workspace settings
- Operator's connected channel description (if any)
- List of niches the operator has already produced content in (read from the production pipeline)
- Explicit instruction: "Confidence labels must reflect source quality and reasoning chain strength. Use 'low' freely when sources are weak."

JSON-mode output. Per Executor's warning ("Sonar Deep Research JSON mode unreliable on long output"): use prompt-structured output + JSON.parse + one retry, not strict provider-side JSON mode.

## 9. UI/UX walkthrough — lazy user, every realistic scenario

### 9.1 Favorite button on every card

Heart icon (not a star — avoids "rate this" misread) top-right of every result card. Filled red when favorited, hollow gray otherwise. Hover tooltip: "Save to favorites".

- **DiscoveryCard** ([DiscoveryCard.tsx](../src/components/niche-finder/DiscoveryCard.tsx))
- **OutlierCard** ([OutlierCard.tsx](../src/components/niche-finder/OutlierCard.tsx))
- **Taxonomy drill-down rows** on the Category tab

### 9.2 The Favorites tab

Sixth tab `♥ Favorites` between Outliers and the model picker pill in the right side of the header bar.

Per-niche panel contains:
- **Title bar**: niche name · score badge · status pill (Considering / Committed / Parked / Passed, editable) · Promise Score color band (red→amber→green by 0-100) · ghost-reference summary ("12 videos · 1 removed upstream") if any.
- **Niche Brief card**: structured sections, each with a confidence pill (low=gray, medium=amber, high=green). Headline at top + Promise Score gauge. Sections collapsible. Citation list at bottom with domain-quality badges. "Generated 2 min ago with Sonar Deep Research · $0.06" stamp + ⋯ menu (Regenerate / Switch model & regenerate / Version history / Copy as Markdown).
- **Verdict row**: dropdown — Accept brief / Override / Reject — plus optional reason field. (Tweak #2)
- **Outcome row** (appears once verdict set): Producing / Produced (+ video link) / Parked / Killed (+ reason). (Tweak #2)
- **Proof videos strip**: horizontal thumbnails of saved videos. Removed-upstream videos are dimmed with a "video unavailable" overlay (tweak #4).
- **Notes**: free-text, autosaved.
- **Actions row**: `Export this niche (CSV)` · `Export this niche (Sheets)` · `Add to Compare` · `Remove favorite`.

### 9.3 Top-bar controls

- Search input (filter by niche name)
- Status filter chips: All / Considering / Committed / Parked / Passed
- Sort: Most recent / Highest promise score / Most videos saved / Alphabetical
- `Compare selected (N/3)` button — disabled until 2-3 favorites are selected
- `Export all favorites (CSV)` · `Export all favorites (Sheets)`
- `Model: Sonar Deep Research ▾` pill (reusing the picker with feature id `niche-favorite-brief`)
- **Cost tally caption (tweak): "Spent this month on briefs: $X.XX"** (small gray text, right-aligned)

### 9.4 Compare view

Click "Add to Compare" on 2-3 favorite panels, then "Compare selected (N/3)" opens a side-by-side overlay:
- Each column = one favorite
- Rows align by section: Promise score, Demand, Competition, Monetization, Operator Fit, Risks, Recommended angle
- Score deltas highlighted (the highest cell in each row gets a green outline; lowest gets faded)
- "Export comparison" button generates a single-sheet Google Sheet comparing the selected.

### 9.5 Lazy-user verification — every scenario

| Scenario | What happens |
|---|---|
| First time, no favorites | Empty state defines "Niche" + "Outlier" inline. Button "See top outliers". |
| Heart a niche on Interests tab | Toast: *"'Investing for Gen Z' added to favorites. Writing brief…"* Favorites tab badge increments. |
| Heart a video on Outliers tab with niche=X selected | Toast: *"Saved under 'X' favorites · Undo · Change niche."* If X wasn't a favorite, becomes one + brief generates. |
| Heart a video on Channel tab (no niche context) | Modal: "Save '<title>' under which niche?" picker + "+ New favorite niche from this video". |
| Open Favorites while brief is generating | Shimmer skeleton + "Writing brief with Sonar Deep Research…" caption. Polls only the niche currently visible (Executor's quota concern). |
| Regenerate a brief | Prior version preserved in `niche_favorite_briefs`, accessible via Version history. |
| Operator sets verdict=Reject on a brief | Saved. Used in retrospective; brief still visible. |
| Operator sets outcome=Produced + pastes a video URL | Saved. Future retrospective ties brief → real performance. |
| A saved video gets deleted on YouTube | Ghost-reference guard finds it on next tab open, marks `is_removed_upstream=true`. Card shows badge. Export excludes it. |
| Operator on mobile | Same heart buttons, modals go full-screen. Sheets export still works (returns a URL). |
| Remove favorite | Confirm dialog "Type the niche name to delete". Soft-deletes (sets `deleted_at`). Tab "Recently removed" link at bottom shows last 30d for restore. |
| Cron sweep | Daily cron purges rows with `deleted_at < now() - 30 days`. |

## 10. Export — beautiful, colored, instantly readable

### 10.1 Google Sheets export

New `/src/lib/google-sheets-favorites.ts`, modeled on [google-sheets-schedule.ts](../src/lib/google-sheets-schedule.ts).

**Two-sheet workbook**:

**Sheet 1 — "Summary"** (one row per favorite niche):

| Column | Content | Visual |
|---|---|---|
| Niche | Name + status pill | Status-colored bg |
| Promise score | 0-100 | Heat band: red <40 → amber 40-69 → green ≥70 |
| Verdict | Operator's reaction | — |
| Outcome | Producing/Produced/Parked/Killed | — |
| Headline | Brief verdict line | — |
| Demand | Score label | Colored chip |
| Competition | Score label | Colored chip |
| Monetization $/1k | "$12-$18" range | — |
| Fit | Score label | Colored chip |
| Brief confidence | Avg of section confidences | Color: low=gray, med=amber, high=green |
| # Videos saved | Integer | — |
| Top proof video | Thumbnail via `=IMAGE("https://i.ytimg.com/vi/{id}/mqdefault.jpg")` | Inline image |
| Recommended angle | Brief text | Wrapped |
| Brief updated | Relative time | — |

Title bar across all columns (dark purple bg, light purple text, matches schedule export). Meta row beneath with model + total cost. Frozen header. Basic filter enabled.

**Sheet 2 — "Briefs"**: one section per niche. Section header colored by Promise score band. Each section's content in label/value pairs: Market Demand / Competition / Monetization / Fit / Risks / Recommended angle / Next steps / Citations. Confidence pill next to each section header. Citations are clickable hyperlinks via `=HYPERLINK()` with domain-quality emoji prefix.

**Glossary footer at top of Sheet 1 (tweak #5)**: collapsed cell block titled "Read me first" defining: Niche, Outlier, Niche Brief, Promise score scale, Confidence labels, Source quality labels. So a non-technical viewer is never lost.

**Per-niche export** uses the same template but with one niche's data. For compare view: a single-sheet export with niches as columns.

### 10.2 CSV export

Flat CSV per the schedule export pattern. One row per niche with the columns: niche, status, promise_score, verdict, outcome, headline, demand_label, competition_label, monetization_range, fit_label, num_videos, brief_updated, recommended_angle, notes. Second CSV `<name>-videos.csv` for the proof videos when exporting all favorites.

### 10.3 File naming

- All: `niche-favorites-<workspace-slug>-<YYYY-MM-DD>.{csv,xlsx-url}`
- Per niche: `niche-favorite-<niche-slug>-<YYYY-MM-DD>.{csv,xlsx-url}`
- Compare: `niche-favorites-compare-<YYYY-MM-DD>.xlsx-url`

## 11. Security & safety (rule 13)

| Surface | Risk | Mitigation |
|---|---|---|
| Cross-workspace leak | Read another workspace's favorites or briefs. | Every query joins on `workspace_id` from session. Favorite ID never used as sole auth key. |
| Perplexity API key | Client-side leak. | Server-only env. All AI calls through `/api/niche-finder/favorites/[slug]/brief`. |
| Prompt injection via video titles / niche names | Untrusted YouTube content coerces the model. | Operator-untrusted strings wrapped in delimited blocks `<niche_name>{escaped}</niche_name>`. Control chars stripped. Output sanitized before render — no raw HTML. |
| Sheets OAuth | Token theft or scope creep. | Reuse [google-oauth.ts](../src/lib/google-oauth.ts) flow + existing scope set. No new scopes. |
| Regenerate abuse | Operator or XSRF spams Deep Research at $0.06/call. | Per-user rate limit: max 1 regen/niche/30s, 30 regens/workspace/hour, 20 auto-regens/workspace/day. |
| Memo cost logs | API keys leaking into audit logs. | Standard practice — no keys in logs. |
| CSRF on mutate endpoints | Standard XSRF. | Reuse project's existing CSRF/origin defenses. |
| Destructive remove | Operator loses a brief by accident. | Soft-delete + 30d restore window (tweak). |
| Webhook storm from spike auto-regen | Many niches spike at once. | Hard cap 20 auto-regens/workspace/day. Queue, don't burst. |
| Ghost references | Saved video deleted upstream, citations point at dead URLs. | Ghost-reference guard validates on tab open, flags + excludes from exports (tweak #4). |
| YouTube ToS for persisted derived data | Persisting + exporting YouTube-derived data is different posture than ephemeral display. | Read current YouTube API ToS before PR1 ships. Confirm derived-metrics retention is allowed; export contains only the operator's own annotations + small derived snippets + thumbnails via canonical `i.ytimg.com` URLs (no rehost). |

Per rule 13, I will pull current OWASP prompt-injection guidance and YouTube API ToS before PR2 ships — not relying on training data.

## 12. Phasing — three PRs

**PR1 — Foundation (data model + favorite buttons + minimal Favorites tab + CSV export)**

- Migration `0063_niche_favorites.ts` creates the three tables in §7.
- `src/lib/niche-finder/favorites.ts` with CRUD, all workspace-scoped + user-stamped.
- API routes: `GET/POST /api/niche-finder/favorites`, `DELETE/PATCH /api/niche-finder/favorites/[slug]`, `POST/DELETE /api/niche-finder/favorites/[slug]/videos`.
- Heart button component reused on DiscoveryCard, OutlierCard, taxonomy rows. Hybrid niche assignment (auto + modal).
- Favorites tab with list view, status pipeline, verdict/outcome fields, soft-delete + 30d restore.
- CSV export for all + per-niche.
- No AI yet.

Ship value: operator collects niches and videos. Exportable today.

**PR2 — Niche Brief AI generation**

- **Falsification gate first**: operator hand-runs 3-5 sample briefs via the Perplexity UI on real niches. Iterate prompt until 3 of 5 are usable. Then code.
- Migration `0064_niche_favorite_briefs.ts` if not folded into PR1.
- `src/lib/niche-finder/brief.ts` — prompt builder, operator-context fetcher (interest tags + channel desc + produced niches), JSON parser with retry.
- `POST /api/niche-finder/favorites/[slug]/brief` endpoint.
- Hybrid orchestration: inline kickoff (Next.js fork convention verified in node_modules first) + cron retry route + manual regenerate.
- New cron `GET /api/cron/niche-finder-favorites-enrich` every 5 min.
- New `AppFeature` `niche-favorite-brief` registered in `src/lib/ai-models.ts`. Default model: `perplexity-sonar-deep-research`.
- Model picker pill in Favorites tab header.
- Brief card UI with Promise Score gauge, section confidences, domain-quality citation badges.
- Monthly cost tally caption.

Ship value: AI Niche Briefs grounded in operator context.

**PR3 — Sheets export + Compare view + ghost-reference guard + auto-rerun + IMAGE() thumbnails**

- `src/lib/google-sheets-favorites.ts` (two-sheet workbook with glossary footer).
- Endpoints: `POST /api/niche-finder/favorites/export-sheet` + `[slug]` variant + `/export-compare-sheet`.
- Compare overlay UI + selection state.
- Ghost-reference guard: cron `niche-finder-favorites-validate-videos` (cheap HEAD requests, batched, 24h cache) + UI badges.
- Auto-rerun hook in existing `rescore-niche-watchlist` cron when a favorited niche spikes.
- Daily soft-delete purge cron.

Ship value: shareable, beautiful exports + comparative decision-making.

## 13. Open questions resolved + post-v1 backlog

All Q1-Q8 are answered (§4). Council-recommended ideas explicitly deferred to post-v1:

- Downstream propagation: Niche Brief's `recommended_angle` auto-seeding the Idea stage; `next_steps` pre-populating script briefs. (Expansionist's vision; great unlock once core is validated.)
- Per-user (not just per-workspace) visibility filters once we go multi-seat.
- Aggregated anonymized "what niches are operators betting on" leaderboard.
- Decision-clock forcing function (per First Principles) — only if operators actually hoard without deciding.

## 14. What I will verify before writing code

Per rule 1 + rule 9:

- The exact Next.js convention in this fork for fire-and-forget background work — `node_modules/next/dist/docs/`.
- Current Google Sheets API request shape for `IMAGE()` cell content with `valueInputOption=USER_ENTERED` — Context7 or live docs.
- Current Perplexity API shape for Sonar Deep Research + JSON output + citations — Context7 or live docs.
- The `AppFeature` registration pattern in `src/lib/ai-models.ts`.
- YouTube API ToS for persisting + exporting derived data.
- OWASP current guidance on prompt injection for the brief generation pipeline.

## 15. Why I am NOT doing certain things (yet)

- Not adding comment threading on favorites — export is the share primitive for v1.
- Not building an in-app Kanban — status + verdict + outcome fields are enough.
- Not auto-favoriting based on score thresholds — favoriting is editorial intent.
- Not piping briefs into Idea / Script stages yet — wait for v1 validation.
- Not renaming Favorites → Shortlist or adding a forced decision clock — council overreach, you've decided.

---

Approved. Building PR1 next.
