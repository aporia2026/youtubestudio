# Model Defaults — search

Settings → Model Defaults grew to ~21 scopes (workspace + 4 sections + 16+ features) and ~50 models. Two pain points emerged:

1. **Finding the right scope to change is slow.** The page is a long stack of pickers; if you want to set the model for "Script Generator", you scroll.
2. **The per-picker search is plain substring.** Typing "opus 4.6" doesn't match "Claude Opus 4.6" because the substring isn't contiguous. Typing "gemini pro" produces noisy ordering.

User chose option 4 from the alternatives: scope search **and** picker upgrade.

## Goals

- Filter the page to the scopes that match a query — by scope name OR by the model currently assigned to them.
- Improve the in-picker matching so multi-token queries work and matches are ranked, not just listed.
- Zero new dependencies. Hand-rolled matcher in a tiny pure-function module.

## Out of scope

- Command palette (rejected option 2).
- "Recently used" models — defer until users ask. Adds storage + cleanup complexity.
- Fuzzy match in the Levenshtein / FZF sense — overkill for short labels and worse UX (false positives confuse users).

## Approach

### 1. Shared matcher: `src/lib/model-search.ts`

Pure functions, no React. Easy to read, easy to test later.

```ts
// Tokenise: lowercase, split on whitespace, drop empties.
tokens(query: string): string[]

// Multi-token AND. Every token must appear somewhere in haystack.
matches(query: string, haystack: string): boolean

// Rank a single record. Higher is better. Used to sort.
// Heuristic:
//   +100 exact name match (case-insensitive)
//   +50  name starts with first token
//   +20  every token starts a word in the name (token-start)
//   +10  every token appears in the name
//   +3   every token appears in id
//   +1   every token appears in description
//   0    no match → caller filters out
rankModel(query: string, model: AIModel): number

// Highlight: split a string into [match, plain, match, ...] segments
// for the matched tokens. Used to bold the matched chars in the UI.
highlight(query: string, text: string): Array<{ text: string; match: boolean }>
```

### 2. Page-wide scope search — `ModelDefaultsPanel`

- Sticky search bar at the top of the panel (above card 1).
- Filters scopes by: scope label, scope description, resolved model name, resolved model id, provider.
- When a query is active:
  - Workspace card hides if it doesn't match.
  - Section card filters its rows.
  - Per-feature card auto-expands every section that has a match, and filters rows inside.
- Result count: "Showing X of 21 scopes".
- Empty state: "No scopes match 'opus 4.6'. Clear search to see everything."
- Esc inside the input clears the query.

### 3. In-picker upgrade — `ModelSelector`

- Replace `String.includes` filter with `rankModel`.
- When the query is non-empty:
  - Sort the flat list by rank desc.
  - Drop the provider grouping (ranking is meaningless across providers when the user is actively searching). Headers reappear when the query is empty.
- Bold the matched substrings in the model name using the highlight helper.
- Keep all the existing chrome (provider tabs, tier filters, keyboard nav, count badge).

## Lazy-user checklist (rule 10)

- Search is the first thing in the panel. No hunting.
- Clear button + Esc + visible result count — three ways to recover.
- Typing "opus" should both filter scopes using Opus **and** filter models named Opus inside any open picker. Same mental model, two surfaces.
- Empty state explains what to do next, not just "no results".

## UI/UX (rules 5, 16)

- No glassmorphism gradient, no AI-ish flourishes. Plain rounded input that matches the existing settings inputs.
- Sticky position only sticks while the panel scrolls, not the whole page.
- Highlight is `font-weight: 600` on matched chars, no background pill — keeps the list scannable.

## Observability (rule 14)

- One `console.info('[settings model-defaults] panel ready', { scopes, models })` on mount.
- Skip per-keystroke logs — would flood the console with no diagnostic value.

## Settings audit (rule 15)

- Nothing to expose. Search is a navigation aid, not a configurable feature.

## Files touched

- new — `src/lib/model-search.ts`
- edit — `src/components/settings/ModelDefaultsPanel.tsx`
- edit — `src/components/ui/ModelSelector.tsx`
