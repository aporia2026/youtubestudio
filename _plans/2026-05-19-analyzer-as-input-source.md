# 2026-05-19 — Analyzer as input source for the rest of the content suite

**Date:** 2026-05-19
**Status:** Draft — awaiting operator approval before any code lands
**Parent context:** [2026-05-18-youtube-deep-analyzer.md](2026-05-18-youtube-deep-analyzer.md) (analyzer feature itself, now shipping production-grade after `0fbb9ec`)

## What the operator actually asked for

Exact phrasing: *"I just want that the analyzer analysis will be used for the various features we have. That's it. It doesn't mean it must be the starting point of each project, but it can be."*

Translation: the analyzer is a **producer**. Existing features are **consumers**. Wherever it makes operational sense, a consumer should be able to use an analyzer's output as a richer input — but the analyzer is not the forced entry point. Operators can still use each feature standalone.

This is connective-tissue work, not new-feature work. 5 of the 7 features the operator listed already ship as standalone tools (confirmed via Explore recon, 2026-05-19); the work below wires the analyzer's output into them where the wire isn't already in place.

## Goals

1. After analyzing a video, the operator can use that analyzer output to drive **every existing content-creation feature** without copy-pasting fields by hand.
2. No feature LOSES its standalone path. Operator can still hit `/seo`, `/ideas`, etc. without going through the analyzer.
3. Each integration is **independently shippable** so a half-finished branch doesn't block the others.
4. No new vendor cost — every feature already uses Gemini / Claude / Kie infrastructure. This is data plumbing, not new AI calls.

## Constraints

1. **Backwards compatibility on every consumer endpoint.** Existing call shapes keep working; new inputs are additive optional fields.
2. **Workspace-scoped end-to-end.** A user in workspace A cannot reach into workspace B's analyzer rows. The route helpers (`apiRoute.authed` + `WHERE workspace_id = $session.ws`) already enforce this — every new path uses the same gate.
3. **Match existing patterns.** [/api/generate/production-doc](../src/app/api/generate/production-doc/route.ts) already takes a `stylePreset` UUID and resolves it via `resolveStyle`. Copy that pattern for script and thumbnail — don't invent a new one.
4. **No new tables.** All integration data already lives in `youtube_analyses` (the analyzer's row) and `production_doc_styles` (the curated preset table). New work flows through them.
5. **Settings audit** (rule 15): no new user-facing settings needed for this — every integration is an additive input on existing routes, the operator's existing model-selection + cap settings still govern.

## Inventory — what already ships vs what's missing

Confirmed via Explore recon 2026-05-19. **Bold = work this plan adds.**

| # | Feature | Existing endpoint | Existing analyzer link | Gap |
|---|---|---|---|---|
| 1 | Save style → preset | `POST /api/production-doc/styles` | `StylePackCard.tsx` "Save as preset" button | None. Already shipping. |
| 2 | Production doc generation | `POST /api/generate/production-doc` | Accepts `stylePreset` UUID; resolves via `resolveStyle` | None for the route. **UI bridge** missing on `/analyze/[id]` to deep-link with the saved preset. |
| 3 | **Script generation** | `POST /api/generate/script` | Takes free-text `style` only — no preset resolution | **Add `stylePreset` UUID param + resolve + inject suffix/mixing into prompt.** |
| 4 | **Thumbnail generation** | `POST /api/thumbnails/generate` | No style parameter at all | **Add `stylePreset` UUID param + resolve + inject suffix/mixing into prompt.** |
| 5 | Idea generation | `POST /api/generate/ideas` | Takes `niche` + free-text `referenceContext` | None for the route. **UI bridge** missing: a "use this analyzer's strategic report as referenceContext" deep-link. |
| 6 | SEO optimizer | `POST /api/seo/optimize` | Takes `topic`, `niche`, free-text `additionalContext` | None for the route. **UI bridge** missing: a "use this analyzer's transcript + hook as additionalContext" deep-link. |
| 7 | Find competitors | `POST /api/competitors` | Takes a channel URL | None for the route. **UI bridge** missing: a "track this channel as competitor" button on the analyzer page. |
| 8 | Find a niche (from channel) | `POST /api/niche-finder/discover/from-channel` | Takes `channelUrl` | None for the route. **UI bridge** missing: a "find niches for this channel" button on the analyzer page. |

Net: **two real route changes** (script, thumbnail) and **five UI deep-link bridges** (production-doc, ideas, SEO, competitor, niche-finder).

## Phased work

Four phases, each independently shippable. The numbering across the table above maps into phases by effort tier.

### Phase 0 — List management on /analyze (delete + search + filter)

**Added 2026-05-19 after operator screenshot showing the recent-analyses list.** The list at the bottom of [/analyze](../src/app/(app)/analyze/page.tsx) currently shows 25 rows reverse-chronological with no way to delete, search, or filter. With repeated test runs, the operator's view becomes a wall of "Make It Count" entries that's hard to navigate.

**0.1 DELETE endpoint.** New `DELETE /api/analyze/youtube-video/[id]` route (same path as the existing GET-by-id), workspace-scoped via `apiRoute.authed`. Returns 204 on success, 404 on cross-workspace or missing rows (matches the route's existing 404-not-403 pattern). New `deleteAnalysis` helper in [src/lib/analyzer/db.ts](../src/lib/analyzer/db.ts) — `DELETE FROM youtube_analyses WHERE id = $1 AND workspace_id = $2`. Logs at info with `[analyzer-list delete]` namespace per rule 14.

**0.2 Search + filter on the list endpoint.** Extend `GET /api/analyze/youtube-video` to accept optional `q` (substring search across `video_title` + `channel_title`, case-insensitive) and `stage` (one of `done` / `analyzing` / `failed`, validates against the existing `AnalysisStage` union). Both default to absent (current behavior). The `listRecentAnalyses` helper grows two optional parameters; SQL appends `AND (video_title ILIKE $q OR channel_title ILIKE $q)` and/or `AND stage = $stage` conditionally.

**0.3 UI: search input + stage dropdown + per-row delete button.** In [src/app/(app)/analyze/AnalyzeEntryClient.tsx](../src/app/(app)/analyze/AnalyzeEntryClient.tsx):
- A search input above the recent-analyses list, debounced ~250ms, that re-fetches the list with `?q=` when non-empty.
- A stage filter dropdown (All / Ready / Analyzing / Failed) next to the search input.
- A small `×` button on each row's right (after Re-analyze), with a confirm prompt before delete. On success, optimistically remove the row from local state; on failure, restore and toast the error.

Estimated 1.5-2 hours. No new tables, no new vendor cost, no breaking changes to existing list consumers (both new params are optional).

### Phase 1 — Close the style loop (2 small route changes)

### Phase 1 — Close the style loop (2 small route changes)

The biggest functional gap. After this phase, a saved style preset (from analyzer or elsewhere) drives every generation pipeline.

**1.1 Wire `stylePreset` into script generation.** In [src/app/api/generate/script/route.ts](../src/app/api/generate/script/route.ts):
- Accept optional `stylePreset?: string` in the POST body alongside the existing `style` free-text param.
- If `stylePreset` is present, call `resolveStyle(stylePreset, session.ws)` (same helper [/api/generate/production-doc](../src/app/api/generate/production-doc/route.ts) uses).
- Pass the resolved style's `ai_image_suffix` + `mixing_rules` + `overall_look` into the existing `scriptGenerationPrompt` builder. Add a new optional argument on the prompt builder for the resolved style; if absent, behavior is unchanged.
- Backwards compat: when only the free-text `style` is supplied, route behavior is identical to today.
- 1-2 hours including a small unit test on the prompt builder asserting the style suffix appears in the output prompt.

**1.2 Wire `stylePreset` into thumbnail generation.** In [src/app/api/thumbnails/generate/route.ts](../src/app/api/thumbnails/generate/route.ts):
- Accept optional `stylePreset?: string`. Resolve identically.
- Inject the resolved style's `ai_image_suffix` into `thumbnailConceptPrompt`. Mixing rules are less directly applicable for thumbnails (thumbnails are images themselves, not generation prompts that mix with stock); for v1 inject only the suffix and document the choice.
- Backwards compat: existing calls without `stylePreset` produce identical output.
- 1-2 hours.

### Phase 2 — Analyzer page deep-links (5 UI bridges, no route changes)

On [src/app/(app)/analyze/[id]/AnalyzeResultClient.tsx](../src/app/(app)/analyze/[id]/AnalyzeResultClient.tsx), add a "Use this analysis…" action row above the Style Packs / Strategic Insights tabs. The row contains six buttons:

| Button | Target | Pre-filled query string |
|---|---|---|
| Use style in production doc | `/production-doc/new` | `?stylePreset=<savedPresetId>` (only enabled after operator has saved the pack as a preset) |
| Generate script in this style | `/script/new` (or wherever the script-gen UI lives) | `?stylePreset=<savedPresetId>` |
| Generate thumbnail in this style | `/thumbnails/new` | `?stylePreset=<savedPresetId>` |
| Generate ideas inspired by this | `/ideas/new` | `?analysisId=<analysisId>` (the ideas page reads the analysis and uses `strategic_report.standout_techniques` + chapter titles as `referenceContext`) |
| SEO-optimize using this analysis | `/seo/new` | `?analysisId=<analysisId>` |
| Track channel as competitor | `/competitors/new` | `?channelTitle=<channelTitle>&channelUrl=<derived from videoId>` |
| Find niches for this channel | `/niche-finder/from-channel` | `?channelUrl=<derived from videoId>` |

(Targets that don't have a stable URL pattern today get verified in implementation — exact target paths are an implementation detail, not a plan decision.)

The two `analysisId=`-driven targets (ideas, SEO) require a small server-side read on the consuming page: load the analyzer row by id, scope to the operator's workspace via `getAnalysisById`, fail to a friendly empty state on 404 (handles the cross-workspace and not-found cases identically per the existing pattern). No new endpoints; the consumer pages just become "analyzer-aware."

A "use style in" button is only enabled after the operator has saved that pack as a preset (the StylePackCard already supports this; we surface the saved preset id on the analyzer page so the deep-link can carry it).

3-4 hours total for the row + the two analyzer-aware consumer pages.

### Phase 3 — Richer integrations (optional, defer if Phase 1 + 2 cover the felt need)

These add value but aren't blockers:

**3.1 `analysisId` as a first-class input on `/api/generate/ideas`.** Today the route accepts `referenceContext` as free text. Add an optional `analysisId` field that, when present, loads the analyzer row and constructs the referenceContext server-side from `transcript.chapters` + `strategic_report.standout_techniques` + `style_packs[].overall_look`. Less copy-paste than the Phase 2 deep-link approach.

**3.2 `analysisId` as input on `/api/seo/optimize`.** Same pattern. Pull `transcript.text` (first ~2000 chars) + `strategic_report.hook` + `strategic_report.standout_techniques` as the `additionalContext`.

**3.3 "Save script + thumbnail back to the analyzer page."** A small feedback loop: when a script or thumbnail is generated using an analyzer-driven style, surface a link to it on the analyzer page so the operator sees their own derivative work clustered. Requires either an `analysisId` foreign key on the script/thumbnail rows or a side-table; defer the schema choice to implementation time.

Phase 3 is ~3-4 hours total but adds polish, not core capability. Skip until Phase 1 + 2 have shipped and the operator says they want more.

## Security & safety (rule 13)

1. **Authn/authz unchanged.** Every new route input goes through the existing `apiRoute.authed` gate. The `resolveStyle(stylePresetId, workspaceId)` helper already enforces workspace scope and returns null on cross-workspace lookups. New `analysisId` reads go through `getAnalysisById({ workspaceId, analysisId })`, which is the same pattern.
2. **No new secrets, no new external services.** Every integration runs against AI vendors the codebase already uses.
3. **Cross-workspace leak surface stays at zero.** The audit done in Phase 8.1 of the parent roadmap closed all of these for the analyzer; this work doesn't open new ones.
4. **Untrusted analyzer content in prompts.** When the analyzer's `transcript.text` or `strategic_report.standout_techniques` is injected as `referenceContext` or `additionalContext` for downstream prompts, those fields are user-derived (the original YouTube creator wrote them, modulo Gemini's processing). The deep analyzer already wraps untrusted content in `<untrusted_data>` delimiters via [src/lib/analyzer/prompt.ts](../src/lib/analyzer/prompt.ts); the downstream consumers (`/api/generate/ideas`, `/api/seo/optimize`) need the same treatment IF they don't already wrap their context fields. Verify during implementation — if either consumer naively inlines the text into its prompt, wrap it.
5. **Rate-limit composition.** Each consumer endpoint has its own per-IP / per-user rate limit. Deep-linking from the analyzer doesn't bypass any of them — the operator still triggers one consumer call per click, throttled at the consumer's rate.

## Observability (rule 14)

Each integration must log a one-line `info` when the analyzer-side input is used, so we can see in Vercel logs how often the feature is actually leveraged vs people falling back to the free-text path. Concrete shape:

- `[analyzer-bridge script-gen]` info log when `/api/generate/script` is called with `stylePreset` set. Include `analysisId` if it can be inferred from the preset's `based_on_built_in` chain.
- `[analyzer-bridge thumbnail-gen]` info log on `/api/thumbnails/generate` with `stylePreset`.
- `[analyzer-bridge deep-link <target>]` console.info on the analyzer page when each deep-link button is clicked (client-side telemetry — useful for spotting which bridges are operationally used vs ignored).
- Existing `youtube-deep-analyze: meta overwrites applied` info logs stay in place — they're unaffected.

These logs are namespace-tagged per rule 14 so the operator can grep them later. The `[analyzer-bridge <feature>]` prefix is consistent across all six.

## Settings audit (rule 15)

No new operator-facing settings. The integration is a pure consumer-of-existing-data wire — there's nothing for a user to toggle. Existing settings that govern the consumer features (model selection per AppFeature, daily caps, rate limits) all still apply.

If at some point we ship Phase 3.3 (the back-link from generated artefacts to the analyzer they came from), THAT may warrant a "show analyzer provenance on derivative work?" toggle in the project settings panel. Flag for that phase.

## Alternatives rejected

1. **Build a "make me a video like this one" wizard that chains analyze → ideas → script → thumbnail → SEO into one flow.** Rejected — that's a forced linear pipeline. The operator explicitly said "It doesn't mean it must be the starting point of each project, but it can be." A wizard imposes the workflow; deep-links make the workflow optional. Revisit if Phase 2's deep-links get heavy use and the operator asks for a one-click chain.
2. **Make every consumer endpoint accept `analysisId` directly (skip the Phase 2 deep-link UI).** Rejected for Phase 1 — Phase 2 deep-links cost ~30 min each and give immediate operator value. Phase 3 still adds the direct `analysisId` inputs for ideas and SEO, but as polish on top of working UI, not as the primary mechanism.
3. **A new `analysis_to_artifact` join table tracking every script / thumbnail / etc. generated from an analyzer row.** Rejected for v1 — premature. Add when the operator asks for "show me everything I generated from this analysis" UX. Until then the analyzer is just an input source, not a tracked origin.
4. **Promote the analyzer output to be the DEFAULT input on every consumer page** (i.e., the consumer pages always show the analyzer dropdown first). Rejected — breaks the standalone workflow. Operators who walk in cold to `/seo` shouldn't see analyzer choices they have no opinion on.

## Open questions

1. **What's the exact URL pattern for the script-gen and thumbnail-gen pages?** Implementation will confirm. If those pages don't have a clean "new with prefilled params" URL today, the Phase 2 work expands slightly to add it. Estimated risk: low (most Next.js pages here already accept query-string prefill — `OutlierCard` already deep-links into `/analyze?videoId=…&autostart=1`).
2. **Should the "Use style in" buttons be disabled until the operator has saved the pack as a preset, or should they trigger the save modal as a side effect of clicking?** Operator preference; default proposal is "disabled until saved" because the save flow already exists and surfacing it inline could confuse intent. Revisit if it feels clunky in practice.
3. **Does anything currently prevent the operator from deep-linking into a consumer page on a different workspace?** Every consumer page already gates on `session.ws`; the URL params are just pre-fill hints. But verify during Phase 2 implementation — if any consumer page reads a URL-supplied id without scoping, that's a pre-existing bug worth filing separately.

## Sequencing recommendation

1. **Phase 0 first** (list management on the analyzer entry page). One commit. Highest immediate UX value — operator's list is unmanageable today with repeated test runs.
2. **Phase 1 second** (script + thumbnail route wires). One commit each. After this, the saved-preset → generation loop is complete.
3. **Phase 2 third** (the deep-link row). One commit. Tests the discovery surface — does the operator actually click these buttons in practice?
4. **Phase 3 only if asked** — when the deep-link row is in operator use, the data tells us whether richer integrations (3.1, 3.2, 3.3) are worth the effort.

If the operator wants to validate quickly before any code, the smallest possible first step is **0.1 only** — ship the DELETE endpoint + per-row delete button. ~30 min and immediately clears the noise from the recent-analyses list.
