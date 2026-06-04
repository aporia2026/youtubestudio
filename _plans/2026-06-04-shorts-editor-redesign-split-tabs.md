# Shorts editor redesign — sticky preview split + tabbed right rail

Date: 2026-06-04
Owner: Yoav

## Goals

The current `/shorts/[id]` page stacks the 9:16 preview at the top
followed by six tall sections (Script, Style, Captions, Voiceover,
Render, SEO). Editing any control deep in Captions or Shots pushes the
preview 1000–2000px off-screen, so every "did that work?" costs a
scroll up + scroll down. Replace the vertical stack with:

- A **sticky 9:16 preview rail** on the left, always in view.
- A **tabbed right rail** so only one section's controls show at a
  time. Tabs become the user's table of contents — no scroll-hunting.
- A **persistent Render CTA** in the top bar so the most common
  end-of-flow action is always one click away.
- A **thin asset-pipeline status strip** under the preview, visible
  from every tab so the user never loses sight of a running Doodle/
  Paint generation or its error state.

## Constraints

- Breakpoint: split layout fires at `>= 1100px` viewport. Below that,
  collapse to a single column with the preview pinned at the top
  (sticky on scroll) — same content density, just stacked.
- Default tab on load: **Script** (typing-first; matches what most
  visits do).
- Tab state persisted via URL hash (`#captions`, `#style`, …) so deep
  links + browser back work and a refresh keeps the same tab open.
- No behavior changes for any control — this is a re-parenting of
  existing JSX, not a redesign of the controls themselves. The user
  who already knows where the Position chip lives finds it in the
  same place inside its new home tab.
- The prototype phase ships behind a separate route
  (`/shorts/[id]/redesign`) so the working editor is untouched while
  the layout is reviewed.

## Approach

### Layout (≥ 1100px)

```
+----------------------------------------------------------------+
| ← Shorts  ·  Title (editable on dblclick)  ·  saved-state      |
|                                            [Render MP4 ▸]      |
+--------------------------+-------------------------------------+
|                          | Script  Style  Captions  Voice  …   |
|                          +-------------------------------------+
|   9:16 PREVIEW           |                                     |
|   (sticky, max ~720px)   |   Active tab content (scrolls       |
|                          |   independently of the preview)     |
|                          |                                     |
|   ── status chips ──     |                                     |
|   short_native · 100w    |                                     |
|   43s · Doodle ready ✓   |                                     |
|   · VO ✓                 |                                     |
|                          |                                     |
|   ── pipeline strip ──   |                                     |
|   (only when running)    |                                     |
+--------------------------+-------------------------------------+
```

- Left rail: ~440px wide (`360–480px clamp`) — enough for a 9:16
  preview at 405×720, the status chips below, and the pipeline strip
  when it appears. Right rail takes the rest.
- Sticky CSS: `position: sticky; top: 24px` on the left rail's inner
  container, so as the right rail scrolls the preview holds.
- Top bar height: ~56px. The "Render MP4" button sits on the right,
  disabled with a tooltip when prerequisites are unmet:
  - No voiceover → "Generate the voiceover first"
  - Doodle/Paint style without assets → "Generate the style assets first"
  - All good → enabled, primary purple.

### Layout (< 1100px)

- Single column.
- Preview pinned at the top via `position: sticky; top: 0`, shrinks
  to `max-height: 45vh` with a "minimize" toggle that collapses it to
  a 64×112 thumbnail so dense field editing isn't blocked.
- Tabs become a horizontally-scrollable strip just below the preview.

### Tab order + content mapping

| Tab       | Content (moved from current sections)                          |
|-----------|-----------------------------------------------------------------|
| Script    | Title, Hook, Payoff, Full script, Asset context                |
| Style     | Style picker, ShortImageModelControls, Generate-assets button, |
|           | Shots panel, per-frame variant editor + collage UI             |
| Captions  | Global style controls + per-chunk overrides                    |
| Voice     | Voice picker, Generate voiceover, audio player, re-sync timing |
| Render    | Render-job status, final mp4 player, history (button moved up) |
| SEO       | SEO generation surface                                         |

Tabs render a small status indicator next to the label when a
meaningful signal exists:

- Style:  `●` yellow (generating) / `●` red (error) / `✓` (assets ready)
- Voice:  `✓` when voiceover is generated
- Render: `✓` when a final mp4 exists

### Render CTA

- Lives in the top bar as a persistent primary button.
- Click triggers the same render flow that the Render tab's button
  fires today — single code path, two entry points.
- On click, switches the right rail to the Render tab so the user
  lands on the progress + history view.

### Asset-pipeline status strip

- Reuses the existing `<GenerationProgressStrip />` component.
- Renders directly under the preview in the left rail, always
  rendered when `row.generation_progress.phase` is set; collapsed
  (zero height) when empty.

### Settings audit (rule 15)

- New user setting candidate: "Default editor tab" (Script / Style /
  resume from last). v1 ships without this and defaults to Script
  per the principle of "one obvious knob over three clever ones".
- Tab order is fixed in v1. If a future creator says "I always start
  in Style", that's the signal to add the setting.

### Observability (rule 14)

- One `[shorts editor layout]` info log on first mount per session
  reporting `{ viewportWidth, layoutMode: 'split' | 'stacked',
  defaultTab }`. Useful for diagnosing "I never see the split mode"
  reports from creators on smaller laptops.
- Tab switches log `[shorts editor tab] from=script to=captions` at
  `debug` level — off by default in prod, opt-in via a Settings
  toggle if it gets noisy.

### Security (rule 13)

- No new data surface. Tab labels are static. URL hash is parsed with
  a whitelist (`['script','style','captions','voice','render','seo']`)
  — anything else falls back to `script`. No DOM injection from hash.

### Testing (rule 18)

- Prototype phase: no automated tests (it's a placeholder shell).
- Build phase (after prototype approval):
  - Unit test for the URL-hash parser (whitelist, fallback).
  - Unit test for the Render-CTA disabled-state logic
    (`computeRenderCtaState(row)`) covering: no voiceover, no assets,
    all good, render already in flight.
  - Component smoke test: each tab renders its expected primary
    control without throwing.
- Manual QA: golden path (open Short → edit Title → see preview
  update → switch to Captions → tweak Position → see preview → click
  Render in top bar → lands on Render tab + job starts).

## Alternatives considered

- **Split + collapsible stacked sections.** Same sticky preview, but
  the right rail keeps the current 6 sections as collapsible
  accordions. Rejected: user picked Tabs after seeing the mockups —
  tabs give one screen one job, accordions still let two sections
  fight for the same screen.
- **Floating PiP preview.** Smallest change to current layout.
  Rejected: doesn't address the "controls are also too far apart"
  problem, only the "preview is too far up" symptom.
- **Inline switch on `activeTab` in the existing ShortEditor.tsx.**
  Faster to ship, file stays 3000+ lines. Rejected: extracting to
  per-tab files makes each tab unit-testable and the orchestrator
  becomes navigable — aligns with rule 2 (clean, ordered code).

## Phasing

### Phase 1 — clickable static prototype (THIS PR)

- New route `/shorts/[id]/redesign` that fetches the same row data
  but renders the new layout shell.
- Real preview Player mounts on the left rail so the user feels the
  layout against their actual Short.
- Tab content is descriptive copy — bullet lists of what each tab
  will hold and what controls move where — so the user can judge
  density and clearance without me having moved any real logic.
- Banner at the top of the route: "Prototype — layout review only.
  All controls and the Render button are non-functional here. The
  working editor lives at `/shorts/[id]`."

### Phase 2 — incremental refactor (NEXT PR, on approval)

- Extract each section into `src/components/shorts/editor/<Tab>.tsx`,
  preserving props + handler signatures so the diff is a move, not a
  rewrite.
- Update `ShortEditor.tsx` to orchestrate state + render the new
  layout.
- Delete the `/shorts/[id]/redesign` prototype route once the real
  page ships.
- Update any test that snapshots ShortEditor (currently none) and
  add the unit tests listed under Testing above.

## Open questions

These can be resolved after the user reviews the prototype:

- Should there be a "Compare to last render" affordance so the user
  can see the preview side-by-side with the previously rendered mp4?
  Useful for "is this iteration actually better?" but adds scope.
- On the < 1100px stacked layout, should the preview-minimize state
  persist across sessions (localStorage)?
- Tab order: Script → Style → Captions matches the natural flow but
  some creators may pick Style first. Empirical question; revisit
  once we have analytics.
