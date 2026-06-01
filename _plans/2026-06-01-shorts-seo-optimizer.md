# Shorts SEO Optimizer for already-made Shorts

Date: 2026-06-01
Status: approved (decisions confirmed via clarifying questions)
Owner: aporia2026

## Goal

On the Shorts page, let the user enter the details of a Short they already made
— title, description, length, and (optionally) the source long-form video it was
cut from — and get back AI-improved SEO: a few title options, a few description
options, and a few hashtag sets, each with a grade (0-100). Results are saved so
they show up in the "Your Shorts" list and can be revisited.

This is a NEW flow, distinct from the existing extractor (which cuts a brand-new
Short out of a long script). The extractor is left untouched.

## Decisions (from the user)

1. Output: a few options for titles, descriptions, and hashtags, each graded.
2. Persistence: save to the Shorts list (new DB columns on `shorts`).
3. Source video: optional; when set, its title/niche/script feed the prompt as
   context so the Short's SEO aligns with the parent video.

## Why not reuse `/api/seo/optimize`

That endpoint is tuned for long-form: it returns 8 scored long-form titles, a tag
taxonomy, and chapters — none of which fit a Short (no chapters, hashtags carry
more weight, titles run shorter, the first line of the description IS the hook).
A Shorts-specific prompt produces cleaner, correct output. The new prompt mirrors
the structure and quality bar of `seoOptimizationPrompt` but is Shorts-native.

## Data model

Migration `0108_add_short_seo_columns` (auto-applies on Vercel deploy):

- `ALTER TABLE shorts ALTER COLUMN short_script DROP NOT NULL`
  (external-SEO rows have no script).
- `ADD COLUMN kind TEXT NOT NULL DEFAULT 'extracted'`
  with `CHECK (kind IN ('extracted','external_seo'))`.
- `ADD COLUMN source_title TEXT` — the title the user entered.
- `ADD COLUMN source_description TEXT` — the description the user entered.
- `ADD COLUMN seo_result JSONB` — the AI output (titles/descriptions/hashtags +
  analysis).

Reused columns: `title` (set to the entered title for the list label),
`estimated_duration_seconds` (the entered length), `project_id` (the source
video), `ai_model`, `generation_params`, `notes`.

`source_script_id` stays NULL for external rows; `project_id` carries the source
video link (already a FK to `projects`).

## Code

- `src/lib/ai-models.ts` — add feature `shorts-seo` (Create section,
  default `gpt-5.4-mini`, fallback chain `['gpt-5.4-mini','gpt-5.4']` mirroring
  `seo-optimizer`).
- `src/lib/shorts-types.ts` — extend `ShortRow` with `kind`, `source_title`,
  `source_description`, `seo_result`; add `ShortSeoResult` + sub-shapes.
- `src/lib/shorts-seo.ts` (new, server-only) — `buildShortSeoPrompt`,
  `parseShortSeoResult` (pure, tested), `optimizeAndSaveShortSeo` orchestrator.
- `src/app/api/shorts/seo/route.ts` (new) — `apiRoute.authed` POST. Validates
  inputs, verifies the source video belongs to the workspace, pulls its
  title/niche/active script as context, runs the optimizer, persists, returns
  `{ id, result }`. Rate-limited like `/api/seo/optimize`.
- `src/lib/shorts.ts` — add the new columns to the `listShortsForWorkspace` and
  `getShort` SELECTs.
- `src/app/(app)/shorts/page.tsx` — new section "Optimize an existing Short's
  SEO" (title, description, length, optional source-video picker reusing the
  already-loaded `projects`). `ShortCard` branches on `kind === 'external_seo'`
  to render the graded SEO options with copy buttons instead of the
  voiceover/render rows.

## Output JSON shape (`ShortSeoResult`)

```
{
  "primary_keyword": string,
  "titles":       [{ "text": string, "score": 0-100, "rationale": string }],
  "descriptions": [{ "text": string, "score": 0-100, "rationale": string }],
  "hashtag_sets": [{ "tags": string[], "score": 0-100, "rationale": string }],
  "notes": string
}
```

Word/char guidance baked into the prompt: titles <= ~60 chars with the hook
front-loaded; descriptions ~3-5 short lines with the payoff up top; 1-2 hashtag
sets of 3-8 tags, `#Shorts` plus niche/topic tags.

## Lazy-user UX walkthrough

- Section sits right under the extractor, same card styling. Four obvious fields,
  one button. Source video defaults to "(none)" so the user can run with just the
  three text fields.
- After "Optimize SEO", the new row appears at the top of "Your Shorts" with the
  graded options and one-tap Copy per title/description/hashtag set.
- Refresh / leave-and-return: the row is in the DB, so it persists. Re-running on
  the same Short just adds another row (cheap, and lets them compare).
- Errors surface in the existing red error banner.

## Security (rule 13)

- All reads/writes scoped to `session.ws` via `apiRoute.authed`.
- Source `project_id` verified to belong to the workspace before its script is
  used — never trust a client-supplied video id.
- Inputs length-capped (title 300, description 5000, length clamped 1-600s).
- Rate-limited per IP (10/min) like the SEO route.
- No secrets/PII logged; spend logged via existing `ai_spend_log` under
  feature_area `shorts_seo`.

## Cost (rule 8)

One LLM call per optimize, same provider/model already used across the app
(`gpt-5.4-mini` default). Marginal cost is the same as one `/seo` run — fractions
of a cent. No new paid service is introduced. Tracked in `ai_spend_log`.

## Rejected alternatives

- Reuse `/api/seo/optimize` as-is — produces long-form output (chapters, tag
  taxonomy, 8 titles) that is wrong for Shorts.
- Separate `short_seo` table + separate list section — cleaner isolation but the
  user explicitly wanted these in the existing Shorts list; a `kind` discriminator
  achieves that with less surface area.
- Ephemeral (no save) — rejected by the user; they want to revisit results.

## QA checklist

- `npm run lint` + `tsc` clean.
- Pure-helper test for `parseShortSeoResult` (fenced JSON, drift, garbage).
- Manual: optimize with and without a source video; verify row appears, grades
  render, copy buttons work, extractor flow still works, voiceover/render rows do
  NOT appear on external-SEO cards.
