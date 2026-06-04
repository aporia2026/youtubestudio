# Shorts: fix caption styling on Doodle/Paint + add asset-creation context field

Date: 2026-06-04
Owner: Yoav

## Goals

Two unrelated asks on the Shorts editor (`/shorts/[id]`):

1. **Fix caption position + style controls on Doodle/Paint shorts.** The
   Position chip row (Top/Center/Bottom) and every other Global style
   control (font, size, color, outline, transform, effect, background,
   letter spacing, line height, position fine-tune) currently do
   **nothing** on `doodle_explainer_2_short` / `paint_explainer_v1_short`
   previews — the renderer's `DoodleCaptionChunk` ignores the
   user-supplied style and hardcodes yellow/black/uppercase at
   `top: 55%`. The user reported the position problem; widening the fix
   to every other ignored control follows the "build for the lazy user"
   principle — once they see the controls, they expect them to work.
2. **Add an "Asset context" free-text field** in the Script section so
   the user can give the LLM planner extra context that should shape
   the base scene + every variant ("the character is a kid, not an
   adult", "set everything in a kitchen", etc.). Threads into both
   Doodle and Paint planner prompts.

## Constraints

- The doodle visual contract (yellow comic-bold, black outline,
  uppercase) is the default — anyone who doesn't touch the style
  controls keeps the current look.
- DB migration: additive, nullable, no backfill needed (existing rows
  read `assets_context = NULL`, which the planner treats as
  "no extra context").
- Vercel build runs `tsx scripts/migrate.ts up` automatically so the
  migration ships with the deploy.
- The caption style fix must keep working for the Minimal style (it
  already honors the controls), the Doodle short, and the Paint short.
- Don't break the existing `MinimalShortVideo` caption renderer.

## Approach

### Caption styling fix

Refactor the doodle caption renderer to derive style from
`config.captions_config?.style` with sensible doodle defaults when a
field is unset:

| field             | doodle default                       |
|-------------------|--------------------------------------|
| fontFamily        | none (system font)                   |
| fontWeight        | 900                                  |
| color             | `#facc15` (doodle yellow)            |
| outlineColor      | `#0f172a`                            |
| outlineWidth      | 6                                    |
| textTransform     | `uppercase`                          |
| letterSpacing     | -0.5                                 |
| lineHeight        | 1.05                                 |
| sizeScale         | 1                                    |
| positionY         | 0.55                                 |
| paddingX          | 64                                   |
| entryEffect       | `fade`                               |
| background        | `none`                               |

Doodle and Paint share the same renderer (`DoodleShortVideo`) per
existing code, so the fix lands once. Pass the resolved style through
to `DoodleCaptionChunk`.

Keep the existing 80ms fade-in/out per chunk plus add support for the
other `entryEffect` values (`none`, `pop`, `slide-up`) that the
minimal renderer already implements. Lift the entry-effect math into
a shared helper so both renderers stay in sync.

### Assets context field

Schema:

- New nullable column `assets_context TEXT` on `shorts` (migration
  `0117_add_shorts_assets_context.ts`). Drop in down migration.

Server:

- Extend `ShortRow` with `assets_context: string | null`.
- Extend every `SELECT … FROM shorts` in `src/lib/shorts.ts` (6 sites)
  + the `claimNextShort` / `claimSpecificShort` in
  `src/lib/shorts-asset-cron.ts` to include the new column.
- PATCH `/api/shorts/[id]` accepts `assets_context` as an optional
  trimmed string, 2000-char cap.
- `ClaimedShort` interface gets `assets_context` so the cron can pass
  it into `planInput`.
- `DoodleVariantInput` (in `shorts-doodle-prompt.ts`) +
  `PlanDoodleAssetsInput` + `PlanPaintAssetsInput` gain
  `assetsContext?: string`. When set + non-empty, the prompt builder
  injects a dedicated `Extra context from the creator:` block above
  the script so the model treats it as a hard constraint, not loose
  inspiration.

UI:

- New textarea in the Script section labeled
  "Asset context (optional)" with helper text describing how it
  affects scene planning. Saves on blur like the other fields.

### Observability

- Existing `[shorts doodle pipeline] planned` log already prints the
  base prompt length + variant count; no extra logs needed for that
  path.
- Add a `[shorts editor caption-style]` info log on the renderer's
  first frame when a non-default caption style is applied, gated by
  `process.env.NODE_ENV !== 'production'` to keep the Lambda log
  budget tight. Skipped — the renderer is pure-display, logs there
  fire 30× per second. Manual inspection via Player preview is the
  natural debug surface.

### Settings audit (rule 15)

- No new user setting: the controls already live in the captions
  panel — this work makes the existing controls take effect on
  Doodle/Paint. Asset context is per-Short, not workspace-wide, so
  it belongs on the row, not the workspace settings.

### Security (rule 13)

- `assets_context` is user-supplied free text fed to an LLM. Clamp
  length server-side (2000 chars). No SQL or template injection
  surface (parameterized queries, prompt string interpolation only).

### Testing (rule 18)

- `tests/shorts-doodle-prompt.test.ts`: a new `assetsContext` block
  proves the planner prompt embeds the context when present and omits
  the whole block when empty/undefined.
- `tests/shorts-render.test.ts` (or new
  `tests/shorts-doodle-caption-style.test.ts`): unit-test the
  doodle-caption-style resolver in isolation (pure helper) covering:
  default doodle look when style is undefined, full override when
  every field is set, and partial override (only color set).
- The position fix is exercised end-to-end via the existing manual QA
  loop; the unit tests guarantee the resolver math is right.

## Alternatives considered

- **(rejected) Position-only fix.** User asked for position
  specifically, but every other Global style control is similarly
  broken — fixing one and leaving twelve silently broken is a worse
  outcome than the user even knows to ask about.
- **(rejected) Per-style branching of the captions panel.** Showing
  different controls for Doodle vs Minimal would be cleaner UI in
  theory but a much bigger refactor; the user expects "the controls I
  see should work", not "the controls vary by style".
- **(rejected) Storing `assets_context` inside `captions_config` or
  `style_assets` JSONB.** It's not a caption setting and it's not an
  asset; it's a prompt input. Putting it in its own column makes it
  trivially queryable and avoids a JSON-shape land grab.

## Open questions

None — scope was confirmed with the user upfront.
