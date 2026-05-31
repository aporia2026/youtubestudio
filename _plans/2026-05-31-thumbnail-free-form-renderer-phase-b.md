# Free-form mode + full client-side renderer — Phase B plan

**Date:** 2026-05-31
**Status:** Draft, awaiting user approval to execute
**Owner:** Yoav

## What landed in Phase A (commits 7589640, fd7a24c, c02d5c8, today)

Server pipeline (`shared-overlay-pipeline.ts`) gained 7 finishing
overlays ported from Flex Icon Grid:

- **Tint** with split-tone shadows / highlights
- **Light leak** with 8 anchor positions
- **Inner glow** centred radial lift
- **Dust & scratches** turbulence-based specks
- **Halftone** uniform dot pattern with rotation
- **Letterbox** 4-sided bars
- **Frame** solid / double / dashed stroke

Both `TopicCardGridPanel` and `NLevelsPanel` got the matching UI:
~40 state fields per panel, coerce + payload builder, OverlayCard
sections, and a row of finishing presets (Off / Vintage film /
Cinematic 2.39 / Editorial clean / Newsprint).

Plus a new `/api/thumbnails/post-process-preview` endpoint and
debounced wiring in both panels so post-process + title-bar tweaks
re-render in ~500 ms without a new AI call (live-ish preview).

## What's still missing — and what this plan covers

Phase A's preview is server-roundtripped (~500 ms per tweak).
Flex Icon Grid's preview is CLIENT-SIDE (~10 ms per tweak), built
on top of an SVG/Canvas renderer in `FlexIconGridLivePreview.tsx`.

To match that for TCG + N Levels requires building a similar
client-side renderer that mimics what `applySharedOverlays` does
server-side, plus a "Free-form mode" toggle that bypasses the AI
entirely (so the renderer is the authoritative source, not a
post-process layer on top of an AI image).

## Goals

1. **Live preview** — every slider / colour-picker / toggle change
   reflects in the on-screen thumbnail within one frame (~16 ms),
   not 500 ms.
2. **Free-form mode toggle** — user picks "AI mode" (today) or
   "Free-form" (deterministic, no AI). Free-form lets the user place
   illustrations from a curated icon library / emoji / uploads /
   AI-stickers per cell.
3. **Pixel parity** — the client-side preview must look *close enough*
   to the server render that the user can trust it. Doesn't have to
   be pixel-perfect (Sharp's Pango vs the browser's font hinting will
   always disagree slightly) but layout + colours match.
4. **No backend changes** for live preview — the renderer is pure
   client. The server pipeline stays as the authoritative path for
   the final render the user downloads.

## Constraints

- The renderer must work in a React component without a build-step
  dependency on Canvas (some Vercel sandbox previews block Canvas).
  → Use SVG primitives where possible; Canvas only when necessary
  (grain / dust noise generation).
- Font rendering is the highest-risk parity point — browsers and
  Pango disagree on metrics. Use `<text>` with the same WOFF2 the
  panel already loads via `@font-face`; accept ~5% drift on
  positioning.
- Bundle size: the renderer adds ~15-30 KB of JSX. Acceptable; we're
  already loading the panel which is bigger.

## Approach

**Build one shared `<ThumbnailRenderer>` component** that takes a
config object + per-cell content and renders the entire thumbnail
client-side as SVG. Two panels consume it, passing different config
shapes that both reduce to the same internal renderer-state.

### Component breakdown

```
<ThumbnailRenderer config={…} content={…} width={…} height={…} />
├── <CellsLayer />               # grid layout, base illustrations
├── <FilterLayer />              # CSS filter on the cells layer
├── <PostProcessLayer>           # SVG overlays applied in pipeline order
│   ├── <VignetteSvg />
│   ├── <TintSvg />              # base wash + split-tone shadows/highlights
│   ├── <LightLeakSvg />
│   ├── <InnerGlowSvg />
│   ├── <DustSvg />              # feTurbulence
│   ├── <HalftoneSvg />          # SVG pattern
│   ├── <GrainSvg />             # feTurbulence + feComponentTransfer
│   ├── <LetterboxRects />
│   ├── <FrameRect />
└── <TitleBarSvg />              # text + subtitle + shadow
```

Each sub-component is a pure function of its config slice — render
zero output when the slice is undefined or its intensity is zero.

### Renderer-state shape

```ts
interface RendererState {
  canvas: { width: number; height: number };
  cells: Array<{
    bounds: { x: number; y: number; w: number; h: number };
    illustration: { kind: 'url' | 'icon' | 'emoji' | 'text'; payload: string };
    label?: { text: string; font: string };
  }>;
  postProcess: PostProcessConfig;  // shared with the server
  titleBar?: TitleBarConfig;
}
```

For AI mode: `cells[i].illustration` is `{ kind: 'url', payload: <AI image URL> }`.
For Free-form mode: `illustration` can be any of the four kinds.

### Free-form mode toggle

Add a new top-level switch in each panel:

```
[ AI mode ▾ ] [ ⚙️ Free-form ]
```

When the user clicks Free-form:
- The AI rendering UI greys out.
- A new "Cell editor" panel appears with per-cell content picker.
- The render button changes to "Save as PNG" (calls a server route
  that runs the same renderer pipeline through Sharp for a high-res
  output).

### Per-cell content options (Free-form mode)

- **Icon library** — 200+ Lucide icons (already bundled).
- **Emoji picker** — system emoji.
- **Upload** — image upload via existing presign route.
- **Text** — fill the cell with bold text in a chosen font.
- **AI sticker** — single-cell AI generation (smaller, faster than
  the full grid AI render).

Per-cell knobs: rotation (-180..180), flip X/Y, content offset
(±50%), image filter (grayscale / sepia / etc.).

### Phasing within Phase B

| Sub-phase | Scope | Estimated effort |
|---|---|---|
| B1 | `<ThumbnailRenderer>` skeleton + AI-mode pass-through | 4-6h |
| B2 | All 7 r2.8 overlays in SVG | 4-6h |
| B3 | Title bar SVG + font loading | 2-3h |
| B4 | Free-form mode toggle + per-cell content picker | 6-8h |
| B5 | Per-cell tweaks (rotation/flip/offset/filter) | 3-4h |
| B6 | Save-as-PNG server route (mirror renderer in Sharp) | 4-6h |
| B7 | Visual QA + drift fixes | 2-4h |

**Total: 25-37 hours** of focused engineering. Realistic span: 5-7
working days (with testing + iteration on visual parity).

## Risks

1. **Font metrics drift** — biggest risk. Browser vs Pango disagree.
   Mitigation: scope drift to ~5% positioning; pin to the bundled
   WOFF2 + use `font-display: block`.
2. **Grain / dust performance** — feTurbulence repaints on every
   slider change. Mitigation: debounce noisy parameters (seed,
   density) at 50 ms; instantaneous for the cheap ones (intensity).
3. **State sprawl** — Free-form mode adds ~50 new state fields per
   panel. Mitigation: extract to a shared `useFreeFormState` hook
   instead of inlining.
4. **Pixel parity on save** — if the server's Sharp output differs
   from the on-screen SVG, the user is surprised. Mitigation: write
   a snapshot test that renders both and compares; iterate until
   diff is < 2%.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| This plan (SVG renderer + free-form toggle) | Pixel-close, matches Flex Icon Grid | 25-37h effort | Chosen for parity with Flex Icon Grid |
| Skip free-form mode, just keep post-process preview from Phase A | Already shipped | Doesn't match "free-form" promise | Rejected — user explicitly asked for parity |
| Server-side fast preview (cache base + diff overlays only) | Backend-only, low client risk | Still 200-500ms round-trip; not "live" | Rejected — server roundtrip is the bottleneck we want to remove |
| Replace TCG / NLevels with Flex Icon Grid wrappers | Code reuse | Loses TCG / NLevels's AI-driven illustration value | Rejected — these formats EXIST to provide AI illustrations |

## Settings

New top-level setting per format: `mode: 'ai' | 'free-form'`. Default
`ai` (existing behaviour). Persisted to localStorage so the user's
last choice survives reload.

Per-cell settings live in a new `freeForm` object inside each
panel's draft state. Schema-versioned so older drafts coerce
cleanly.

## Observability

Two new log namespaces:
- `[thumbnail-renderer state]` — final renderer state per render, with
  cell count, overlay flags, free-form mode.
- `[thumbnail-renderer save]` — server save-as-PNG calls, with the
  same shape as the existing format image routes.

## Security

No new attack surface for the client-side renderer (it operates on
already-loaded data). The save-as-PNG server route reuses the same
SSRF guards + size caps as the existing image routes.

## Testing

- Unit: every SVG sub-component gets a test that renders its config
  and checks the resulting SVG markup contains expected elements.
- Integration: snapshot diff between the SVG renderer and the Sharp
  pipeline at standard canvas sizes. Failing diffs > 2% block merge.
- Manual: render the same Topic Card Grid in both AI and Free-form
  modes, verify the user can land the same look in either path.

## Rollback

Revert the Phase B commits. Phase A's server overlays + post-process
preview stay live; the free-form mode toggle disappears and the
client-side renderer is no longer mounted.
