# 2026-06-03 — Deterministic Title-Card Repair

## Problem

User reported: pre-flight title-review panel detected **7 titles**, but the
generated production doc only contained **5 Title Card rows**. The route's
existing post-validator at `src/app/api/generate/production-doc/route.ts:379-457`
flags the gap as a `generation_warnings` entry ("Missing title card(s)… Use
the row action to add them") but otherwise accepts the LLM's output.

That is a soft failure. The contract the pre-flight panel implies is
"every title you see here will be a Title Card row in the doc." We are
breaking it by deferring to the LLM and asking the user to clean up.

## Root cause

Two paths reach 5 emitted cards when 7 were detected:

1. **LLM dropped Title Cards entirely.** The prompt at `src/lib/prompts.ts:2313-2330`
   asks for one Title Card per sentinel. LLM compliance is unreliable on
   long scripts.
2. **LLM emitted with mangled text.** The strict allowlist at
   `route.ts:339-356` demotes Title Cards whose `script_text` doesn't
   normalize-match an extracted title. That demotion is necessary (it
   catches "[SFX:]" lines mistagged as Title Cards), but it also drops
   legitimate Title Cards when the LLM paraphrases the heading text past
   the punctuation-tolerant normalizer.

Both look identical from the validator's seat: `missing[]` is non-empty.

## Goals

- Every detected title (after user pre-flight review) ends up as a
  Title Card row in the saved doc. No exceptions.
- Repair is deterministic — no second LLM call, no probabilistic retries.
- Visible enough that the user knows when the LLM misbehaved.
- Auto-pipeline path: out of scope for this PR. Flag as follow-up.

## Constraints

- Synthetic Title Card rows must look identical to LLM-emitted ones so
  the renderer / editor treats them the same way.
- Insertion position must respect script order (a title for section 3
  must land between section 2 and section 3 rows).
- Existing `effectiveTitles` / `extracted` / `applyUserTitleOverrides`
  pipeline is the source of truth — no new title-detection logic.

## Approach (recommended)

**Server-side deterministic insertion.** After the strict allowlist
demotion runs and before the emission validator, walk the emitted rows
in script order, pairing each Title Card row with the next expected
title. When a Title Card for an expected title doesn't appear in time,
insert a synthetic Title Card row at that position.

### Algorithm

```
rowIdx = 0
out = []
for titleIdx in 0..expectedTitles.length:
  target = expectedTitles[titleIdx]
  matched = false
  while rowIdx < rows.length:
    r = rows[rowIdx]
    if r is Title Card and normalize(r.script_text) == normalize(target.text):
      out.push(r); rowIdx++; matched = true; break
    if r is Title Card and normalize differs:
      # out-of-order TC — leave it for a later iteration to pick up
      break
    out.push(r); rowIdx++
  if not matched:
    out.push(syntheticTitleCard(target.text, prevRowTimecode))
copy remaining rows[rowIdx..]
```

### Synthetic row shape

Matches the prompt's Title Card row contract (`prompts.ts:2319-2328`):

```ts
{
  timecode: previousRowTimecode || '00:00',
  script_text: titleText,
  visual_type: 'Title Card',
  visual_description: `Title card displaying "${titleText}"`,
  stock_search_terms: '',
  ai_image_prompt: '',          // suffix-attach pass leaves this empty for cards
  on_screen_text: titleText,
  notes: 'Title card scene — auto-inserted to match a detected `##` heading the model missed.',
  // when allowOverlay:
  overlay_stock_terms: '',
  overlay_zone: '',
  overlay_size: '',
}
```

`ai_image_prompt = ""` because Title Card rows render as typography only;
no image is needed. The route's existing `attachStyleSuffixToRows` skips
empty prompts, so the synthetic row is byte-identical to an LLM-emitted
one for the same title.

## Rejected alternative

**Targeted LLM retry.** When `missing.length > 0`, fire a second call
asking for just the missing Title Card rows, then merge them in by
position. Rejected because:

- One extra call per generation, ~$0.005, plus latency.
- Still probabilistic — the retry can fail or paraphrase again.
- Position-resolution logic ends up identical to the deterministic path.

The LLM doesn't add value here — the title text and position are
already known.

## Security

- Synthetic rows derive content only from `effectiveTitles[*].text`,
  which is user-authored / user-confirmed via the pre-flight panel.
  No new external input enters the row.
- No new code paths execute when `effectiveTitles` is empty (the loop
  doesn't run).

## Observability

- New log line: `[production-doc title-card-repair]` with
  `{ modelId, expected, emittedBefore, insertedCount, insertedTitles }`.
- New `generation_warnings` entry: "N title card(s) were auto-inserted
  because the model didn't emit one for: …" — phrased as a soft notice,
  not an error. The existing `[production-doc title-emit]` log fires
  after the repair, so post-repair `missing` should be 0.

## Settings

No new user-facing settings. The behavior is a correctness fix, not a
toggle — the contract "detected titles become cards" is invariant.

## Testing (vitest)

New file `tests/title-card-repair.test.ts`:

- all titles emitted in order → no insertions, rows unchanged
- 1 title missing in the middle → 1 inserted at correct position
- 1 title missing at the start → 1 inserted at index 0
- 1 title missing at the end → 1 inserted after the last row
- 2 missing consecutively → 2 inserted, both in script order
- empty expected titles → no insertions, no errors
- empty rows + non-empty titles → all titles inserted as rows in order
- punctuation-tolerant match: "Knight Capital." (LLM) vs "Knight Capital" (expected)
- whitespace-tolerant match: "  THE   END  " vs "The End"
- `allowOverlay=true` → overlay_* fields present and empty
- `allowOverlay=false` → overlay_* fields absent
- Title Card with mismatched text appears mid-stream → stays in place,
  expected title gets a synthetic before it

Run `npm test -- title-card-repair` and `npm test -- production-doc`
to confirm no regression in adjacent suites.

## Out of scope

- Auto-pipeline path (`src/lib/auto-pipeline/stages/generate-production-doc.ts`)
  has the same risk but no strict allowlist or validator today.
  Follow-up: wire `repairMissingTitleCards` in after `extractJson` so
  the pipeline-saved docs also satisfy the invariant.
- "Extra" Title Cards (LLM emitted a duplicate) — already warned by the
  validator. Not auto-removed in this PR.
