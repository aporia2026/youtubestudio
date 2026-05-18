---
title: Bridge Competitor Deep Intelligence → Channel Naming
date: 2026-05-18
status: proposed
owner: info@flexelent.com
related:
  - 2026-05-18-youtube-deep-analyzer.md
  - src/app/(app)/competitors/page.tsx
  - src/app/(app)/channel-naming/page.tsx
---

# Bridge: Competitor Deep Intelligence → Channel Naming

## Goal

After running Competitor Deep Intelligence on a channel (e.g. MapLore), the user should be able to generate "similar channel" naming candidates in one click, using the competitor's niche, top performers, visual identity, and analyzed positioning as the seed context for the existing Channel Naming generator.

Three integration surfaces (user picked all three):

- **A — CTA on the competitor page** (primary path): button in the Deep Analysis tab header that navigates to `/channel-naming?fromCompetitor=<id>` with the form prefilled.
- **B — Picker on the channel-naming page**: "Start from a competitor" dropdown at the top of `/channel-naming` that pulls the same context from any saved competitor.
- **C — Inline lightweight generator** inside the Deep Analysis tab: compact panel that generates the top N candidates inline and links out to the full naming workspace via the same handoff used by A.

## Why now

The user is doing competitor analysis specifically to spin up rival channels. Today they have to manually retype niche, find the competitor's top videos, paste URLs, and write a positioning summary — every time. One click does it.

## Requirements

1. The bridge must work both immediately after a Run Deep Analysis click (analysis still in client state) AND days later (cold load — analysis was never persisted before this feature).
2. Prefill payload must include: niche, top N reference video URLs, free-text style/format summary, channel avatar as reference image.
3. Names saved during a session that originated from a competitor must be linked back to that competitor for future "names you saved while studying X" surfacing.
4. The inline panel (C) must NOT duplicate the heavyweight naming UI (filters, advanced sort, save dialog). It runs generation and shows top results; deeper work happens in the full naming workspace.
5. Tenant scoping is enforced server-side on every new endpoint and on the new `source_competitor_id` link.
6. Graceful degrade: if no deep analysis exists yet for the competitor, the bridge still works using channel-level data + top videos, and surfaces a hint encouraging the user to run analysis for sharper results.

## What already exists (verified)

- **Competitor page** `src/app/(app)/competitors/page.tsx` — tabs: Videos, Analytics, Top, Bottom, Thumbnails, Video Forensics, Deep Analysis, Ideas.
- **Competitor analyze API** `src/app/api/competitors/[id]/analyze/route.ts` — runs deep analysis on demand. **Returns JSON in the response only — no persistence.** Output shape: `{ analysis, analytics }`.
- **DB tables**: `competitor_channels` (workspace-scoped), `competitor_videos` (FK competitor_id), `saved_channel_names` (workspace-scoped).
- **Channel Naming page** `src/app/(app)/channel-naming/page.tsx` — inputs: reference videos[], reference images[] (base64), niche, free text, count (10–40). Calls `/api/channel-naming/generate`. Already handles handle availability, scoring, save-to-DB, session result accumulation.
- **Naming generate API** `src/app/api/channel-naming/generate/route.ts` — already accepts the full payload the bridge needs.
- **Tech**: Next.js 16.2.2 App Router, Vercel Postgres, Vercel AI SDK via `generateText()`. AGENTS.md flags Next.js 16 is not what training data expects — consult `node_modules/next/dist/docs/` before touching routing or server components.

## Chosen approach

### Plan summary

1. **Persistence** (one-time small migration): add `latest_deep_analysis_jsonb` + `latest_deep_analysis_at TIMESTAMPTZ` to `competitor_channels`. The analyze route writes back the result on success. Lightweight; we only need the latest run, not history.
2. **Bridge endpoint** (single source of truth for A/B/C): `GET /api/competitors/:id/naming-context` — workspace-scoped read that returns `{ channel, topVideos, namingSeed }` where `namingSeed` is `{ niche, freeText, referenceImages }` built deterministically server-side from channel + latest analysis (if any).
3. **Surface A — CTA on competitor page**: button in Deep Analysis tab header (primary) + a small card in Ideas tab. Navigates to `/channel-naming?fromCompetitor=<id>`.
4. **Surface B — Picker on naming page**: a top-of-form "Start from a competitor" select that lists workspace competitors (reusing existing list API) and fetches naming-context on choose.
5. **Surface C — Inline panel** in Deep Analysis tab below the analysis: title "Generate similar channel names", count 5 (locked low for cost/latency), calls `/api/channel-naming/generate` directly with the bridge payload, displays compact candidate list with handle availability, footer link "Open full naming workspace →" routes via the same A handoff.
6. **Linkage**: add `source_competitor_id UUID NULL REFERENCES competitor_channels(id) ON DELETE SET NULL` to `saved_channel_names`. Naming generate API accepts optional `sourceCompetitorId`; naming save persists it. (Display of "names from this competitor" on the competitor page is a follow-up — not in this PR.)

### Detailed mechanics

**Migration `0076_competitor_latest_analysis_and_name_link.ts`**
- ALTER `competitor_channels` ADD COLUMN `latest_deep_analysis_jsonb JSONB`, `latest_deep_analysis_at TIMESTAMPTZ`.
- ALTER `saved_channel_names` ADD COLUMN `source_competitor_id UUID NULL REFERENCES competitor_channels(id) ON DELETE SET NULL`.
- INDEX on `saved_channel_names(source_competitor_id)` for the future "names from this competitor" lookup.

**Analyze route update** `src/app/api/competitors/[id]/analyze/route.ts`
- On successful parse, before returning: `UPDATE competitor_channels SET latest_deep_analysis_jsonb = $1, latest_deep_analysis_at = NOW() WHERE id = $2 AND workspace_id = $3`.
- Same workspace scope guard already present, just extend it.

**New endpoint** `GET /api/competitors/[id]/naming-context/route.ts`
- Authed via `apiRoute.authed`. Validate `id` belongs to `session.ws`.
- Fetch: channel row (title, handle, thumbnail_url, subscriber_count, latest_deep_analysis_jsonb), top 5 videos by view_count desc.
- Build:
  - `niche`: from `latest_deep_analysis_jsonb.category` if present, else `competitor_channels.category` if set, else empty string.
  - `topVideoUrls`: top 5 `https://youtube.com/watch?v=<video_id>`.
  - `freeText`: short server-side templated paragraph using the analysis if present. Wrap competitor-derived strings with `<<COMPETITOR_INPUT>>...<<END>>` markers to defang any prompt-injection content in titles/comments (see Security).
  - `referenceImages`: `[{ url: channel.thumbnail_url }]` if non-null. (Naming page already accepts URL or base64.)
- Returns `{ channel: { id, title, handle, subs }, topVideoUrls, namingSeed: { niche, freeText, referenceImages }, hasAnalysis: boolean }`.

**Naming page update** `src/app/(app)/channel-naming/page.tsx`
- On mount, read `searchParams.get('fromCompetitor')`. If set, fetch naming-context, prefill state (niche, freeText, reference video URLs, reference images), and stash `sourceCompetitorId` in state.
- Add the "Start from a competitor" picker at top of form (surface B). On change, do the same fetch+prefill flow (and update the URL via `router.replace` so a refresh keeps the source).
- Pass `sourceCompetitorId` to the generate API; pass it through to the save API on user-save.
- Show a small "Seeded from <Channel Name>" chip next to the form header; clicking it offers "Clear" which resets sourceCompetitorId and the prefilled fields (but does NOT wipe accumulated session results — existing behavior).
- If `hasAnalysis === false`, show a one-line hint above the form: "Tip: run Deep Analysis on <Channel> for sharper suggestions" with a deep link.

**Naming generate API** `src/app/api/channel-naming/generate/route.ts`
- Accept optional `sourceCompetitorId` in body. Validate it belongs to `session.ws`. Forward it down to the persistence step on save.

**Naming saved API** `src/app/api/channel-naming/saved/route.ts`
- Accept and persist `source_competitor_id`. Tenant-validate the FK at write time.

**Surface A — competitor page**
- In Deep Analysis tab header: button "Generate similar channel names →". Link to `/channel-naming?fromCompetitor=<id>`. Disabled tooltip if no videos synced yet ("Sync the channel first").
- In Ideas tab: small companion card with the same CTA so users browsing ideas can also jump.

**Surface C — inline panel**
- New component `CompetitorInlineNaming` rendered at the bottom of the Deep Analysis tab.
- Props: `competitorId`, `hasAnalysis`.
- One button "Generate 5 similar names". On click: POST `/api/channel-naming/generate` with `{ sourceCompetitorId, count: 5 }` — the API resolves the rest server-side via the bridge endpoint (have it internally call the same naming-context builder so the client doesn't shuffle the payload around).
- Result list: candidate name, handle (with availability badge), combined score, one-line reason. No filters, no sort, no save dialog.
- Footer: "Open full naming workspace →" link to `/channel-naming?fromCompetitor=<id>`.

**Important wiring decision**: have the naming generate API accept the lightweight `sourceCompetitorId`-only payload AND the existing fully-explicit payload. When only `sourceCompetitorId` is present, the API builds the payload via the shared bridge helper. This keeps C trivial and means the heavy lifting lives server-side once.

### Cost (rule 8)

- No new paid services. Reuses existing LLM wrappers (`generateText` via Vercel AI SDK; provider-agnostic).
- Per-click cost = one Channel Naming generation = same as today's `/channel-naming` page generations (vision-capable model, ~1 image, ~5 video URLs, ~300 token system + freeText). Default count 5 inline (C) vs 10–40 on the full page.
- Persisting analysis JSON adds Postgres storage (negligible) — one row update per Run Deep Analysis click.
- Bridge endpoint is read-only Postgres, no LLM call.

### Security (rule 13)

- **Tenant scoping**: every new endpoint (`naming-context`) validates `competitor_id` belongs to `session.ws`. `sourceCompetitorId` on save is tenant-validated server-side; never trust the client to pass a valid one.
- **Prompt injection from competitor data**: competitor-derived strings (titles, top comments, channel description) flow into the naming prompt via `freeText`. Wrap them in fenced markers (`<<COMPETITOR_INPUT>>...<<END>>`) and instruct the model to treat their contents as data, not instructions. Low blast radius (worst case is goofy names) but the practice is right.
- **URL param tampering**: `?fromCompetitor=<id>` is just a hint; the server fetch is what enforces access. A user passing another tenant's id gets a 404 from naming-context.
- **No new secrets, no new external surfaces, no PII**. Channel thumbnails are already public CDN URLs.
- **CSRF / rate limiting**: bridge endpoint inherits `apiRoute.authed` patterns; naming generate already has the rate-limit pattern used across the codebase. Confirm during implementation.

### QA checklist (rule 6)

Golden path:
- [ ] On competitor page with recent Deep Analysis, click "Generate similar channel names" → lands on naming page with niche, top videos, reference image, free text all filled.
- [ ] Hit Generate → candidates appear with handle availability.
- [ ] Save one → DB row has `source_competitor_id` populated.
- [ ] Refresh naming page (URL still has `?fromCompetitor=...`) → prefill restored, source chip still shown, prior generated results still in session.
- [ ] B picker: select a different competitor → form re-prefills, URL updates, source chip updates.
- [ ] C inline panel: click Generate → 5 candidates rendered with availability; "Open full workspace" link carries over the same context.

Edge cases:
- [ ] Competitor with no Deep Analysis yet → bridge returns `hasAnalysis: false`, prefill uses channel + top videos only, hint appears, generation still produces sensible names.
- [ ] Competitor with no videos synced → A button disabled with tooltip; C panel disabled; B picker still lists but selecting shows the same "sync first" message.
- [ ] Competitor thumbnail missing/null → reference image omitted, no error.
- [ ] User in workspace X passes `?fromCompetitor=<id from workspace Y>` → naming-context 404, form empty, no leak.
- [ ] Switching competitor in B picker while a generation is in-flight → cancel previous request or ignore late response.
- [ ] Naming page has accumulated session results, user clicks "Clear" on source chip → form clears, results preserved (matches existing pattern).
- [ ] Deep Analysis re-run → `latest_deep_analysis_jsonb` overwritten, future bridge calls use new content.
- [ ] Delete a competitor that has linked saved names → `source_competitor_id` SET NULL, names survive.
- [ ] Two browser tabs: tab 1 generates from competitor X, tab 2 generates from Y, both save → each row carries correct `source_competitor_id`.

Adjacent code regression:
- [ ] Existing standalone naming page flow (no `fromCompetitor` param, manual inputs) unchanged.
- [ ] Existing competitor Deep Analysis run flow unchanged (now also persists, but the response shape is identical).
- [ ] Existing `saved_channel_names` reads still work with the new nullable column.

### UX details (rule 10 — lazy user)

- The CTA button label is action-led and concrete: **"Generate similar channel names →"** (not "Channel Naming"). The user sees what will happen.
- The button placement in Deep Analysis tab is in the header, top-right — same eye-line as where the user just finished reading the analysis. Not buried in a sub-section.
- After click, the naming page loads with everything pre-filled. The Generate button at the bottom should be visually emphasized so the user knows there's still one click left (they have not generated yet).
- The seeded-from chip is dismissible so power users who want to tweak the niche aren't locked in.
- Handle availability shows inline next to each candidate — same pattern users already know from the naming page.
- One-page-feel: from running Deep Analysis to seeing first 5 naming candidates, target is two clicks (Run Deep Analysis → Generate similar names → inline results).

## Alternatives considered and rejected

- **Don't persist analysis; just pass it through client state / URL**. Rejected: breaks the cold-load case (rule 6 — the bridge must work days later, not just the same session). Also fragile: query strings get truncated, sessionStorage is per-origin-per-tab.
- **Persist analysis to its own new table** (history of runs). Rejected for now: we only need the latest for the bridge, and the existing Deep Analysis UX doesn't surface history. Column-on-channel is simpler. Easy to migrate to a history table later if the product needs it.
- **Run Deep Analysis on-demand inside the bridge if missing**. Rejected: a "Generate similar names" click is now a $-cost LLM call that the user didn't authorize for analysis. Better to surface the hint and let them choose.
- **Make C the full naming UI embedded inline**. Rejected: maintenance trap (two places to keep filters, sort, save, handle re-check in sync). C stays lightweight; full power lives in /channel-naming.
- **Generate a new prompt-builder specifically for "clone this channel" instead of reusing channel-naming**. Rejected: the existing naming generator already accepts the exact inputs we'd produce. Less code, fewer places to drift, same model, same scoring.

## Open questions — RESOLVED 2026-05-18

1. **Niche extraction precision** → **Resolved**: inspect the actual shape returned by `competitorDeepAnalysisPrompt` and build niche from the most specific field available (sub-niche / theme / dominant topic + format), not just the top-level category. If only a generic category exists, fall back to combining category + top 2 dominant title themes/tags.
2. **B picker scope** → **Resolved**: list ALL workspace competitors with a small "analyzed ✓" badge on those that have `latest_deep_analysis_jsonb` populated.
3. **CTA placement** → **Resolved**: Deep Analysis tab header (primary) + Ideas tab card + **Top tab card** (when looking at top performers, "make a channel like this" is a natural next thought).

## Out of scope (for follow-ups)

- History of deep analyses per competitor (currently we keep only the latest).
- Cross-tenant competitor sharing.

## Phase 2 — landed 2026-05-18

Followed up the same day to address the two honest flags from Phase 1 plus the reverse-panel follow-up.

### Security hardening (the flag)

The channel-naming routes had zero auth and `saved_channel_names` had no workspace scope — every workspace's saved names sat in one global pool. Locked down:

- **Migration 0077** `_plans/.../0077_saved_channel_names_workspace_scope.ts`:
  - Defensive `ADD COLUMN IF NOT EXISTS workspace_id` (covers deployments where 0011 missed the table because it was lazily created).
  - Backfills NULL rows to the bootstrap workspace.
  - Swaps the global `UNIQUE(handle)` for a composite `UNIQUE(workspace_id, handle)` — without this, the save route's `ON CONFLICT (handle) DO UPDATE` would silently overwrite another workspace's row when two workspaces picked the same handle (cross-tenant WRITE leak).
  - Adds composite index for the workspace-scoped GET path.
  - Mirrored in `ensureChannelNamesSchema()` for hot-deploy self-heal.
- **Auth wraps**: `apiRoute.authed` on all four channel-naming routes:
  - `generate` (POST) — was burning workspace LLM budget anonymously
  - `saved` (GET) — was exposing every workspace's saved pool
  - `saved` (POST) — now inserts `workspace_id = session.ws`
  - `saved/[id]` (DELETE) — was allowing any caller to delete any name by id-guess
  - `check-handle` (POST) — was burning workspace YouTube API quota anonymously
- **Save POST hardening for `sourceCompetitorId`** (folds three checks into one query):
  - UUID shape check (cheap reject)
  - Row exists (FK race guard — competitor deleted between page-load and save → set NULL instead of FK violation)
  - Row belongs to `session.ws` (cross-tenant guard — can't link to another workspace's competitor)
- **ON CONFLICT clause** updated to `(workspace_id, handle)` to match new composite UNIQUE.

### Reverse panel: "Names you saved while studying this competitor"

- **New endpoint** `GET /api/competitors/[id]/saved-names`:
  - `apiRoute.authed` + UUID validation
  - Validates the competitor belongs to `session.ws` before exposing any joined data
  - Returns saved names where `source_competitor_id = id AND workspace_id = session.ws`
- **UI** `SavedNamesFromCompetitor` rendered in the Deep Analysis tab below the inline naming panel:
  - Self-contained: owns its own fetch + delete state
  - Renders nothing while loading or when empty (it's a recall surface — empty card adds noise)
  - Compact rows with name, handle, availability badge, score, saved-at, copy/verify/delete actions
  - "Generate more →" footer link routes back through the bridge

### QA additions (Phase 2 specific)

- [ ] Auth: anonymous request to `/api/channel-naming/saved` returns 401 instead of leaking the pool
- [ ] Workspace scope: workspace A's GET does not see workspace B's saved names
- [ ] Cross-tenant write: workspace B saving handle "myname" (also held by workspace A) creates a new row, doesn't overwrite A's
- [ ] FK race: delete a competitor while a save with its id is in flight → save succeeds with `source_competitor_id = NULL`, no 500
- [ ] Cross-tenant source-link: workspace B saves with `sourceCompetitorId` = workspace A's competitor id → stored as NULL
- [ ] Reverse panel: only shows names whose `source_competitor_id` matches AND `workspace_id` matches
- [ ] Reverse panel delete: row disappears immediately, DB row gone
- [ ] Cold load (no analysis, no saved names from this competitor): reverse panel renders nothing, no broken empty state
