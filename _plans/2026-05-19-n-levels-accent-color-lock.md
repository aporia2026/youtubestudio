# N Levels — per-slice accent color "lock" toggle

**Date:** 2026-05-19
**Format:** N Levels Explained

## Problem

In the N Levels Explained format, each slice has an optional accent color the user can pick with a color swatch in the Review panel. When the image renders, the colors come out dramatically darker and more desaturated than the swatches imply. A user picking saturated red / orange / yellow / lime / cyan / blue gets back muddy crimson / near-black / mustard / forest / navy.

Two prompt-side root causes:

1. `src/lib/thumbnail-formats/n-levels.ts:411` passes the color as `(accent hint: #XXXXXX)` after the illustration concept. "Hint" is soft language and there is no instruction telling the model *where* the color should appear (background? overlay? lighting?).
2. `src/lib/thumbnail-formats/n-levels.ts:441` actively encourages the model to pick its own "fitting" color for the slice based on content ("a 'passive reconnaissance' slice might be cool green"). For dark-themed niches like cyber security, "fitting" reads as cinematic and dark, so the model overrides the user's pick.

The UI implies the user is *setting* the slice color; the prompt treats it as a vibe nudge. The UI is right; the prompt is wrong.

## Goal

Give the user explicit control over how seriously the image model takes the accent color they picked, per slice.

## Chosen design

**Per-slice lock toggle**, with **locked as the default** when the user clicks "+ color".

Each slice gets three meaningful states:

| State | UI | Prompt behavior |
|-------|-----|---|
| No color | "+ color" button | No color language at all (current behavior) |
| Color + unlocked (hint) | `[swatch] 🔓 ×` | `(accent hint: #XXX)` — current soft suggestion |
| Color + locked | `[swatch] 🔒 ×` | Authoritative: "Slice background MUST be #XXX at full saturation; do NOT desaturate; LEVEL heading stays white." |

Locked-by-default reflects rule 10 (build for a lazy user): if the user bothered picking a color, they meant it. The hint state is preserved for the "I just want a nudge in this direction" case.

LLM-suggested colors (from Step 1) come in **unlocked** — the LLM is guessing; the user opts into locking by clicking the lock icon. This preserves existing behavior for unmodified LLM picks and avoids surprise.

## Alternatives rejected

- **One global toggle** ("Use my colors exactly"): simpler UI, but loses the ability to lock one slice and leave another loose. Real videos often have one "must-be-this-color" slice (a brand color, a story climax) and others where the model can interpret.
- **Global default + per-slice override**: most flexible, most UI surface. Worth it only if mixed lock states are an everyday thing. Not yet.

## Implementation

### Data model

- Add `accent_color_locked?: boolean` to `NLevel` (`src/lib/thumbnail-formats/n-levels.ts`).
- Add same to `FormatLevel` interface in `src/components/thumbnails/NLevelsPanel.tsx`.
- Add to the persisted level shape in `src/lib/history.ts`.
- Parser tolerance in `parseLevelListResult`: accept the field if present, default to `undefined`. Validator treats it as a passthrough.

### Image prompt

In `nLevelsImagePrompt` at line ~407–425:

```ts
if (l.accent_color && l.accent_color_locked) {
  accent = ` — SLICE COLOR LOCK: the slice background MUST be ${color} at full saturation. Do NOT darken, desaturate, or shift the hue. The LEVEL heading stays white over this background.`;
} else if (l.accent_color) {
  accent = ` (accent hint: ${color})`;
}
```

At line ~441 (the "each slice has its own background" paragraph), add a carve-out:

> *…UNLESS the slice has a locked accent color, in which case use that exact color as the slice's dominant background regardless of what would otherwise "fit" the content.*

### UI

In `NLevelsPanel.tsx` around line 793–821 (the color swatch block):

- Add a lock-toggle button between the swatch and the × clear button.
- When color present: render `[swatch] [🔒/🔓] ×`.
- `+ color` defaults `accent_color_locked: true`.
- Clearing the color also clears the lock flag (no zombie state).
- Tooltips: "Locked — model must use this exact color" / "Hint — model may interpret".

### API routes

- `/api/thumbnails/format/n-levels/levels` route — no changes needed; the LLM doesn't emit this field.
- `/api/thumbnails/format/n-levels/image` route — needs to accept `accent_color_locked` in each level. The Zod-shaped validation at the top of the file plus the call to `validateLevelList` should both tolerate the new optional field.

### Observability (rule 14)

In the image route, before calling the model, log:

```ts
logger.info('[thumb-format-n-levels image] color lock distribution', {
  total: levels.length,
  no_color: countNoColor,
  hint: countHint,
  locked: countLocked,
});
```

This makes it trivial to diagnose color-related complaints in future.

### Settings audit (rule 15)

No new global settings layer. The lock state is per-slice and lives in the slice itself. A future "default to locked / hint" global setting could be added if usage shows users always pick one way, but that's premature.

## Security & safety (rule 13)

No new attack surface. The lock flag is a boolean. The color value is already passed through `sanitizeForPrompt(_, 16)` which caps length and strips control chars. Image-model prompt injection via hex color string is not feasible at 16 chars.

## QA plan

- Golden path: pick a vivid color, click + color → defaults to locked → render → background is that color at full saturation.
- Mixed: lock some slices, unlock others, leave some with no color → each behaves per state.
- Round-trip: generate → render → reopen history → lock state preserved.
- Backwards compatibility: open a pre-existing N Levels result from history → colors render as hints (no lock flag in stored data → default behavior unchanged).
- Regression: render with no colors at all → no color language in prompt, no behavioral change.

## Out of scope

- Color presets / palette picker.
- Per-slice "intensity" slider (50% / 75% / 100% lock).
- Global "lock all" / "unlock all" buttons.
- Auto-deriving accent from the illustration concept.
