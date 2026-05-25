# Channel Description AI Generator

**Date:** 2026-05-25
**Status:** Approved — Alt C selected. No council pass requested.
**Author / collaborator:** Yoav (info@flexelent.com) with Claude

## Goal

Let users generate a YouTube channel "About" description by picking an AI model, writing a short brief, and choosing an output style. Works in two places using one shared component:

1. The **add-channel form** on `/channel` (so a description is ready at creation time).
2. A new sub-route **`/channel/[id]/description`** (so the description can be regenerated for any existing channel).

The brief that produced the description is stored on the channel so it can be reused / iterated on later.

## Constraints

- This codebase uses a custom Next.js (App Router) build with breaking changes; per `AGENTS.md`, conventions and APIs may differ from upstream. We mirror existing patterns in this repo rather than what generic Next.js would do.
- The `channels.description` column already exists (populated from YouTube's About on sync) but is invisible in the UI today. We introduce the editing surface in the same change.
- There is currently no PUT/PATCH endpoint for a single channel at `/api/channels/[id]`. We add one scoped to the description fields (not a generic patch — keeps the surface minimal).
- Add-channel POST already runs `fetchChannelData(url, …)` which writes the YouTube About text into `description`. We let the user override that with a generated value at creation time, but the YouTube-sourced fallback stays the default.
- Migrations run automatically on Vercel deploy (`vercel-build`), so the new column is live before the new code that depends on it can execute. Local dev runs `npm run db:migrate`.
- The user does not want anything removed from existing UI (per `feedback_never-remove-options.md`). This change is purely additive.

## Requirements

### Functional
- A "Generate with AI" button next to a Description textarea, available both in the add-channel form and in the new `/channel/[id]/description` sub-page.
- The button opens a modal with: free-form brief textarea, output-style picker (5 presets), `ModelSelector`, generate button, output preview, and a "Use this" action that copies the generated text into the description field.
- The generator prompt is fed by: free-form brief + channel name + niche + notes + brand-kit fields (voice, tone, vocabulary, sentence length, voice examples, banned phrases, required phrases, hook style) + selected output style.
- Style presets (initial set, easy to extend):
  - **Short bio** — 2-3 sentence elevator pitch
  - **SEO-heavy** — keyword-dense, structured for discovery
  - **With chapter timestamps** — sections like "What you'll find here / Upload schedule / Connect"
  - **Story-driven** — leads with the channel's why, first-person
  - **Authority** — credentials-first, expert framing
- On save, both `description` and `description_brief` persist.
- Defaults: model defaults to **Claude Haiku 4.5** via `getFeatureDefaultModelId('channel-description')`. User can swap.
- Existing brief (if any) prefills the modal so iteration is one click away.

### Non-functional
- One reusable modal component, two consumer pages.
- Mirrors the `/api/generate/ideas` route pattern (auth, rate limit, `getModelById`, `generateText`, `makeSpendContext`) — no new abstractions.
- All copy in the UI: plain language, no AI tells (no em dashes, no smart quotes, no "delve" / "leverage" / "seamless").
- Mobile: modal collapses to full-screen sheet on narrow viewports (existing modal pattern in the codebase).

## Chosen approach (Alt C)

A shared modal launched from two contexts:

```
┌─────────────────────────────────────────────────────────┐
│ Channel description                                     │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ <description textarea, prefilled if any>            │ │
│ └─────────────────────────────────────────────────────┘ │
│ [ ✨ Generate with AI ]   [ Save ]                      │
└─────────────────────────────────────────────────────────┘

  click "Generate with AI" →

┌─ Modal ────────────────────────────────────────────────┐
│ Brief (what should the description convey?)            │
│ ┌────────────────────────────────────────────────────┐ │
│ │ <free-form textarea, prefilled with stored brief>  │ │
│ └────────────────────────────────────────────────────┘ │
│ Output style: [Short bio ▾]                            │
│ AI model: [Claude Haiku 4.5 ▾]    (ModelSelector)      │
│ Channel signals it will use:                           │
│   • Name: "<name>"   • Niche: "<niche>"                │
│   • Notes ✓   • Brand-kit ✓ (3 fields set)             │
│                                                        │
│  [ Generate ]                                          │
│                                                        │
│ Output preview                                         │
│ ┌────────────────────────────────────────────────────┐ │
│ │ <generated description, editable>                  │ │
│ └────────────────────────────────────────────────────┘ │
│             [ Cancel ]   [ Use this ]                  │
└────────────────────────────────────────────────────────┘
```

## Alternatives considered and rejected

### Alt A — Inline generator on the channels page
Add the description field + collapsed generator panel directly into the add-channel form and into the brand-kit page. **Rejected** because (1) the add-channel form is already six inputs deep, adding a description + brief + model picker + style picker inline pushes everything below the fold; (2) description doesn't belong inside brand-kit semantically — they're sibling concerns.

### Alt B — Dedicated sub-route only, no reuse in add-channel
Build only `/channel/[id]/description` and skip the add-channel integration. **Rejected** because the moment you add a new channel you have to navigate away to generate the description — that's exactly the friction the "lazy user" rule (CLAUDE.md #10) says to design out.

## Implementation phases

### Phase 1 — Schema
- **New file:** `src/lib/migrations/0086_add_channel_description_brief.ts` — `ALTER TABLE channels ADD COLUMN description_brief TEXT`. Idempotent. Down drops the column.
- **Edit:** `src/lib/migrations/index.ts` — import migration0086, append to `allMigrations`.
- **Edit:** `src/lib/db.ts` `ensureChannelsSchema()` — add `ALTER TABLE channels ADD COLUMN IF NOT EXISTS description_brief TEXT` so hot deploys self-heal (mirrors how 0016 brand_kit was done).

### Phase 2 — Feature registry
- **Edit:** `src/lib/ai-models.ts` — add `'channel-description'` to the `AppFeature` union (Foundation section) and an entry in `APP_FEATURES` with `defaultModelId: HAIKU`.

### Phase 3 — Prompt builder
- **New file:** `src/lib/prompts/channel-description.ts` — pure function that takes `{ brief, name, niche, notes, brandKit, style }` and returns `{ system, user }`. Encodes the style preset rules + voice/tone weaving. Plain TS, no SDK imports — unit-testable.

### Phase 4 — Generation API
- **New file:** `src/app/api/generate/channel-description/route.ts` — `POST` handler mirroring `/api/generate/ideas`: rate-limit by IP, validate model, fetch channel by id (workspace-scoped), build prompt, call `generateText` with `spend: await makeSpendContext('channel_description', { channelDbId: id })`, return `{ description }`. `maxDuration = 60` (descriptions are short).

### Phase 5 — Save API
- **Edit:** `src/app/api/channels/[id]/route.ts` — add a `PATCH` handler that accepts `{ description?: string, descriptionBrief?: string }` and updates only those two columns, workspace-scoped. Returns the updated row. Validates: trims, caps description at 5000 chars (YouTube limit is 1000 but we don't enforce that here — the user might want longer drafts).
- **Edit:** `src/app/api/channels/route.ts` POST — accept optional `description` and `descriptionBrief` and pass them into the INSERT. When `description` is provided, it overrides `channelData.description` (the YouTube fallback). When `descriptionBrief` is provided, it gets stored.

### Phase 6 — Shared modal component
- **New file:** `src/components/channel/GenerateDescriptionModal.tsx` — `'use client'`. Props: `{ open, onClose, channelId?, initialBrief?, initialDescription?, channelName?, niche?, onApply: (description, brief) => void }`. Holds local state for brief, style, modelId, output. Calls `POST /api/generate/channel-description`. The component is "controlled" — it doesn't save itself; the parent decides what to do with the result.

  Two call modes:
  - **Existing channel** (`channelId` provided): the route fetches the channel server-side, so the modal only sends `{ channelId, brief, style, modelId }`.
  - **New channel** (no `channelId`): the modal sends `{ name, niche, notes, brandKit: null, brief, style, modelId }` and the route uses those instead of a DB fetch.

### Phase 7 — Add-channel form integration
- **Edit:** `src/app/(app)/channel/page.tsx` —
  - Add a `description` textarea + "Generate with AI" button to the add-channel form (kept compact, below niche).
  - Wire the modal in unconnected mode (no `channelId`).
  - On "Use this", populate the description textarea and store the brief in component state.
  - The POST to `/api/channels` now includes `description` and `descriptionBrief`.

### Phase 8 — Existing-channel page
- **New file:** `src/app/(app)/channel/[id]/description/page.tsx` — mirrors `brand-kit/page.tsx` structure: load channel + existing description + brief, render the description textarea + button, mount the modal in connected mode, save via `PATCH /api/channels/[id]`.

### Phase 9 — Navigation link
- **Edit:** `src/app/(app)/channel/page.tsx` channel card — add a "Description" link next to the existing "Brand kit" / "Visual brand kit" links.

### Phase 10 — QA pass
- Golden path: add a channel → click generate → pick style → click generate → "Use this" → save channel → reopen the channel's description page → brief is prefilled → regenerate.
- Edge cases: empty brief (modal rejects with inline error), brand-kit not set (banner says "no voice signals — output will be generic"), model selection cleared (falls back to default), network error during generate (error toast, modal stays open with brief retained).
- Error paths: 401 from API (redirect to login flow), 429 rate limit (toast with retry-in seconds), 400 invalid model (toast), 500 from `generateText` (toast with provider error).
- Regressions to watch: brand-kit page still works, channels list still loads, adding a channel without the new description still works (both new fields are optional).

## Security & safety

- All endpoints use `apiRoute.authed` so they require a session and inherit `session.ws` for workspace scoping.
- The `PATCH /api/channels/[id]` route confirms `channel_id = id AND workspace_id = session.ws` before updating — same pattern as DELETE.
- The generation route confirms channel ownership before pulling brand-kit fields into the prompt (no cross-tenant brand-kit leak).
- Rate limit: per-IP, 10 requests / 60s (matching `/api/generate/ideas`).
- Brief text is stored verbatim — no HTML rendering anywhere; React's default escaping in JSX is the boundary.
- `description` body capped at 5000 chars on save to prevent unbounded growth.
- No PII concerns: the brief and description are the user's own channel content.
- No secrets in code paths: model API keys come from env / cookie store as elsewhere.
- Spend tracking attached via `makeSpendContext('channel_description', { channelDbId })` — billable usage is attributable to the right channel + workspace.

## Cost (rule 8)

- Default model: **Claude Haiku 4.5** — $1/MTok input, $5/MTok output.
- Typical generation: ~600 input tokens (brief + channel context + brand-kit + style preset) + ~250 output tokens.
- Per generation: ~$0.0006 input + $0.00125 output ≈ **$0.002 / generation**.
- At 1,000 generations / month: ~**$2/month**.
- User-selectable upgrades: Sonnet 4.6 (~5×), Opus 4.7 (~30×), GPT-5.5 (~3×). All flow through existing per-workspace billing.
- No third-party services beyond the AI providers already wired into `ai.ts`.

## Open questions / deferred

- **Per-workspace model override**: the `workspace_model_defaults` table (migration 0034) supports per-feature overrides. The new `channel-description` feature key will be selectable in Settings without any extra work, but I haven't verified the Settings UI auto-discovers new `APP_FEATURES` entries. If it doesn't, that's a separate polish task — flag during QA, don't block this change on it.
- **Mobile sheet styling**: matching the rest of the app's modals is a polish concern; ship at parity with the brand-kit page and tune if it looks off.
- **Streaming output**: the route uses non-streaming `generateText` for simplicity (descriptions are short). If users want word-by-word reveal, switch to `generateTextStream` later — non-breaking.

## Definition of done

1. Plan file written (this file) — ✓
2. Migration 0086 applied locally and Vercel build passes.
3. Both entry points (add-channel form, `/channel/[id]/description`) generate and save descriptions.
4. Brief persists and prefills on re-open.
5. Model selector default is Haiku, user-changeable.
6. QA pass (Phase 10) executed; all golden-path and edge-case checks pass.
7. No regressions in brand-kit or visual-brand-kit pages.
8. Lint + typecheck clean (`npm run lint` / `tsc --noEmit` depending on project scripts).

## Files touched (summary)

**New:**
- `src/lib/migrations/0086_add_channel_description_brief.ts`
- `src/lib/prompts/channel-description.ts`
- `src/app/api/generate/channel-description/route.ts`
- `src/components/channel/GenerateDescriptionModal.tsx`
- `src/app/(app)/channel/[id]/description/page.tsx`

**Edited:**
- `src/lib/migrations/index.ts`
- `src/lib/db.ts`
- `src/lib/ai-models.ts`
- `src/app/api/channels/route.ts`
- `src/app/api/channels/[id]/route.ts`
- `src/app/(app)/channel/page.tsx`
