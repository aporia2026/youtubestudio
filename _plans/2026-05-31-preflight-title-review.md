# Pre-flight Title Review for Production Doc

Date: 2026-05-31
Status: approved

## Goal

Before clicking Generate on the production-doc page, the user can see exactly which lines in their script were detected as Title Cards, correct the text, delete false positives, and add titles the detector missed. Only after they confirm does generation start. This closes the loop on the LLM mistag bug class — instead of relying on post-generation cleanup, the user owns the title list upfront.

## Why

Recent commits (`5e67016`, `5cbb32b`) added post-LLM filters that DEMOTE bad Title Card rows after the fact. That's reactive. The user kept asking "but why is the LLM mistagging in the first place?" — answer: the heuristic in `extractScriptTitles` sometimes catches a sentence ("He said yes") that *looks* title-shaped, then the prompt tells the LLM "emit a Title Card for sentinel N", and the LLM dutifully does. By giving the user a review step BEFORE the LLM runs, we:
- catch heuristic false positives (delete from the list)
- correct extraction casing/punctuation drift (edit)
- patch true negatives the heuristic missed (add)

This costs zero LLM tokens (the review is pure UI on already-extracted data) and removes the most common failure mode.

## Constraints

- Must be opt-in friction-free: if the user just clicks Generate without opening the review, behavior is identical to today.
- The detected list must mirror EXACTLY what generation will see — same SSML preprocessor, same extractor — otherwise the preview lies.
- Must work with the existing sentinel-based prompt (`<<TITLE_N>>` markers in the stripped script). No change to the prompt schema.
- No new LLM call.

## Architecture

### Data model

`ExtractedTitle` (in `src/lib/script-titles.ts`) gains one field:

```ts
interface ExtractedTitle {
  text: string;
  sentinel: string;
  originalLine: string;  // NEW — the line as it appeared before sentinel replacement
}
```

`originalLine` is needed so a deleted detected title can be restored to plain text in `stripped`. We keep the exact original characters (`## Heading` for explicit, plain prose for heuristic) so the LLM sees the script as it would without that title.

### New endpoint: `POST /api/generate/production-doc/detect-titles`

Body: `{ script: string }`
Returns: `{ titles: ExtractedTitle[], warnings: string[] }`

Calls `preprocessSsmlForProductionDoc` then `extractScriptTitles` — exactly the same pre-pass as the generation route. Light rate-limit (30/min). Logs `[production-doc detect-titles]` with input size and detected count.

### Generation route accepts overrides

`POST /api/generate/production-doc` body grows:

```ts
userTitles?: Array<{
  text: string;                  // final title text (post-edit)
  sourceSentinel?: string;       // present iff this title was detected
  insertAfterSentinel?: string | null;  // for ADDED titles: position. null = at start
  deleted?: boolean;             // for explicitly-removed detected titles
}>
```

When `userTitles` is present, a new helper `applyUserTitleOverrides(extracted, userTitles)` produces a new `{ stripped, titles, warnings }`:

- For each detected title (`sourceSentinel` matches): if `deleted` → replace sentinel in `stripped` with its `originalLine`, drop from `titles`. Else: keep sentinel, update text.
- For each user-added title (no `sourceSentinel`, has `insertAfterSentinel`): inject a new sentinel into `stripped` immediately after the position of the indicated sentinel (or at the start if `null`). Append to `titles` with a new sentinel string `<<TITLE_USER_N>>`.
- The downstream prompt + post-validation allowlist use this overridden output. The strict Title Card allowlist (from `5cbb32b`) is the enforcement layer — it accepts whatever the user supplied.

When `userTitles` is absent, behavior is unchanged.

### UI: TitleReviewPanel

Lives in `src/app/(app)/production-doc/page.tsx`, mounted between the script textarea and the existing `PaintExplainerV1SettingsPanel` / Generate button area.

States:
- collapsed (default): a single line — "Detect titles before generating" with a chevron.
- detecting: spinner.
- ready: list of editable title rows.
- stale: script changed since last detect; show "Re-detect" pill.

Row UI:
```
[ text input                              ] [↑] [↓] [×]
```

Footer:
```
[ + Add title ]
```

Add flow: clicking "+ Add title" opens an inline form: text input + position dropdown (`At start` / `After: <title-1-text>` / `After: <title-2-text>` / ...). On submit, the new title joins the list.

Generate button: when a detection has happened and there are no stale-script warnings, it passes the user-edited list as `userTitles`. Otherwise it omits the field (back-compat).

### Logging

- `[production-doc detect-titles]` — request/response.
- `[production-doc title-overrides]` — when a generation includes `userTitles`: counts of `edited`, `deleted`, `added`.
- Existing `[production-doc title-extract]` continues to fire on the raw extraction output before overrides; downstream `[production-doc title-emit]` continues to validate.

### Security

- Detect endpoint is `apiRoute.authed` + rate-limited.
- `applyUserTitleOverrides` validates `insertAfterSentinel` points at an existing sentinel; unknown sentinels are dropped with a warning rather than failing the request.
- No new data persisted — overrides are per-request.

### Settings

No new settings. The review is implicit and per-generation.

### Testing

- `tests/script-titles.test.ts` — extended for the new `originalLine` field.
- New `tests/apply-user-title-overrides.test.ts` — covers edit-only, delete-only, add-only, mixed, and edge cases (unknown sentinel, empty text, duplicate edited text).
- Existing tests stay green.

## Alternatives considered

- **Edit-only**: smaller surface, but misses the common false-positive case (heuristic detected the wrong line). User explicitly rejected.
- **Inline-in-script editing**: let the user just edit `##` markers in the script textarea. Functional, but unfriendly — they'd need to find the right line, the textarea is long, and detection feedback isn't visible. Worse UX.
- **Two-step generation**: first call returns titles only, user reviews, second call generates rows. Doubles round-trips + LLM cost. Rejected.

## Out of scope (v1)

- Reordering by drag-and-drop. Up/down arrow buttons cover this.
- Persisting the user's title overrides across reloads — they re-detect on next visit.
- Per-title metadata (e.g. preferred visual style). Title text is the only thing that flows to the LLM.
