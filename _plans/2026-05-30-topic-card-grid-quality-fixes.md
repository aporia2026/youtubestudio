# Topic Card Grid — quality fixes (no format changes)

Date: 2026-05-30
Status: approved, in progress

## Why

A real run ("Every Fake Antivirus Scam Explained", 2×3, cybersecurity) shipped a grid with four visible quality problems:

1. GPT-4o emitted multi-element UI mockups as `icon_concept` ("a browser window with… and a fake scan", "an email inbox with a highlighted message…", "an installer wizard with a tiny checkbox…") — exactly the failure mode the prompt at [topic-card-grid.ts:484-500](../src/lib/thumbnail-formats/topic-card-grid.ts#L484-L500) tells it to avoid.
2. Labels too long to fit one line in the 20%-height label band (e.g. "400 million dollars Every Year", "Phishing Emails and Tech Support Scams"). Wrap to two lines, look crowded, "Year" appears to bleed past the cell's bottom edge into the gutter.
3. "Fake Online Scanners" got a green accent. Green reads as safe/legit; the label says fake/malicious. No prompt or validator guidance against semantic color mismatches.
4. In pure-prompt mode (no uploads) the composite at [topic-card-grid-composite.ts:462-465](../src/lib/thumbnail-formats/topic-card-grid-composite.ts#L462-L465) only wipes the bottom 20% of each cell. Any AI-rendered label that overflowed into the row gutter survives.

User directive: **don't touch the format, just make it work.** No architecture changes. Tighten the existing pipeline.

## Goals

- Stop the LLM from emitting multi-element UI mockup `icon_concept`s. Use structural enforcement (length cap + regex banlist), not just prompt persuasion that GPT-4o demonstrably ignores.
- Stop labels from wrapping. Hard cap on label length so the band always holds one line at the deterministic font size.
- Stop AI label bleed in the row gutter even in pure-prompt mode.
- Add a thin guard against semantically wrong accent colors (green/blue on negative concepts) — bonus, no architecture risk.

## Non-goals

- No changes to the grid layout, card shape, label band ratio, composite step ordering, or any user-facing UI.
- No changes to the `flex-icon-grid` format, the `n-levels` format, or the production-doc thumbnail flow.
- No model swap. The user picked GPT-4o; we work around its tendency to ignore long anti-pattern lists.

## Approach (4 changes)

### 1. Prompt tightening — `src/lib/thumbnail-formats/topic-card-grid.ts`

- LLM prompt (Step 1, `topicCardGridLlmPrompt`):
  - Replace the soft "1-4 words ideally" with a hard "**≤ 22 characters, ≤ 3 words**" rule, restated twice (system + JSON schema comment).
  - Add an explicit "**`icon_concept` is ≤ 80 characters and describes ONE bold central symbol**" rule. Currently it's effectively unbounded — the sanitiser clips at 250 chars, which is large enough to fit a multi-element UI mockup.
  - Move the "no UI mockup" rule from "strongly prefer" to "**FORBIDDEN PATTERNS**" with a top-of-message banner listing the exact phrases the validator now rejects.
  - Add a one-liner about color semantics: "If the subject is a scam/attack/threat, do NOT pick green or pure-blue accent colors — those read as safe/trusted."
- Image prompt (Step 2, `topicCardGridImagePrompt`): mirror the new label/icon caps so the image model is told to render short labels (single line in the band).

### 2. Validator caps + banlist — `src/lib/thumbnail-formats/topic-card-grid.ts`

- `validateCardList`:
  - Add `label.length > 22` → reject.
  - Add `wordCount(label) > 3` → reject.
  - Add `icon_concept.length > 80` → reject.
  - Add accent_color semantic guard: if label matches a "negative concept" regex (fake/scam/phishing/malicious/ransomware/breach/attack/threat) AND accent_color is green-ish (`#0?[0-9a-f]{0,2}[bcdef][0-9a-f]{0,2}` family is fuzzy and risky — use a tight list instead: greens, teals, pure blues) → reject.
- `ICON_CONCEPT_BANLIST`: re-add narrow regexes for the dominant failure mode:
  - `/(browser|dialog) window with/i`
  - `/(email inbox|email client) with/i`
  - `/(installer|setup) wizard with/i`
  - `/scanner (results|ui|table)/i`
  - `/(showing|displaying|containing) ['"]/i` — catches "showing 'VIRUS ALERT!'" etc. (banned for category labels; specific named subjects don't typically embed text descriptions this way)
  - `/with (a|an|multiple|several) (button|checkbox|progress bar|tab|panel|field|menu)/i`
- All caps are also enforced post-validation in `sanitizeForPrompt` so a stale client or future bypass route can't smuggle long labels through.

### 3. Gutter wipe in pure-prompt mode — `src/lib/thumbnail-formats/topic-card-grid-composite.ts`

- In `applyCellUploads`'s pure-prompt branch (lines 462-465), extend the label-band overlay's wipe to include the row gutter beneath the cell (down to the next row's top edge, or canvas bottom for the last row). Implementation: extend `buildSquareLabelBandOverlay`'s `labelH` argument to include the gutter for non-last-row cells, OR add a separate sibling wipe rectangle. The latter is cleaner.
- Belt-and-braces: don't widen the wipe horizontally — that would erase the gutter between columns, which the AI may legitimately use to anchor borders. Keep the horizontal wipe at the cell's own width.

### 4. Tests — `tests/topic-card-grid.test.ts` + `tests/topic-card-grid-composite.test.ts`

- Existing tests must keep passing unchanged (refactor of validator must not break old shape-valid card lists).
- Add unit tests:
  - `validateCardList` rejects labels over 22 chars / 3 words.
  - `validateCardList` rejects icon_concepts over 80 chars.
  - `validateCardList` rejects each banlist phrase exactly.
  - `validateCardList` rejects green accent on a negative concept.
  - `validateCardList` accepts the curated set of legit cards (Sony, WannaCry, Microsoft Exchange, Bonzi Buddy) so the new rules don't false-positive specific-named-entity cases.
  - Composite: gutter-wipe rectangle is staged for non-last-row cells in pure-prompt mode.
- One bug-fix regression test per fix (rule 18): label "400 million dollars Every Year" with green accent on a "fake" label both fail validation today.

## Observability

Every fix path already has a namespaced log. The new validator rejections will surface through the existing `[thumb-format-grid cards] validation failed` log with the new `reason` string. The composite's new gutter wipe doesn't need its own log — it's part of the existing overlay batch.

## Security

No surface change. The new regex banlist runs on LLM output before interpolation into the image prompt, narrowing the prompt-injection surface slightly (longer descriptions had more room for hostile content).

## Settings

Nothing new to expose. The caps are quality floors, not preferences. If a future use case genuinely needs a longer label, we revisit then.

## Rejected alternatives

- **Switch model to Claude / Gemini.** Out of scope per user directive — the user picked GPT-4o in the UI for a reason and the format must work with it.
- **Add an LLM-based icon_concept validator pass.** Catches more failure modes but doubles the LLM cost and slows the route. Banlist is good enough for the dominant failure mode and free.
- **Redesign the format to put labels INSIDE the panel.** User said don't touch the format.

## Open questions

None for the four fixes above. Color-semantic regex is narrow on purpose; if it false-positives in practice, narrow further (specific palette only, not "green-ish").
