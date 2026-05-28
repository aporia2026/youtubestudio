# Flex Icon Grid thumbnail template + existing-template polish

**Date:** 2026-05-28
**Status:** Draft — awaiting approval
**Scope:** Add a new third thumbnail format (`flex-icon-grid`) and enhance the two existing formats (`topic-card-grid`, `n-levels`).

---

## 1. Goals

1. Add a **third thumbnail format** that mirrors the bright-flat-icon-grid pattern proven to win on the reference channels (`The Paint Explainer`, `EverythingProfessor`, `The Evaluator`, `Byte Sized Explainer`).
2. Make that template **extremely flexible** so a single format covers everything from "5×3 circular icons on bright cells" to "2×2 hero-tile grid with uploaded photos."
3. **Brighten and simplify** the existing two formats so their default output stops looking dark, cinematic, and over-detailed — without breaking workflows for users who liked the old look.

## 2. Constraints & requirements

- **Repo:** `c:\youtubestudio-live`, Next.js App Router, Vercel deploy, Cloudflare R2 for uploads, Sharp for server compositing.
- **Existing system map:** templates live in [src/lib/thumbnail-formats/](src/lib/thumbnail-formats/), editor panels in [src/components/thumbnails/](src/components/thumbnails/), per-cell uploads via [/api/uploads/topic-card-grid-cell](src/app/api/uploads/topic-card-grid-cell/route.ts). Templates are discovered by file name and surfaced by hardcoded panels in [src/app/(app)/thumbnails/page.tsx](src/app/(app)/thumbnails/page.tsx).
- **Render mode for new template:** **Deterministic composition only** (SVG + Sharp, no AI image gen). Confirmed with user.
- **Enhancement strategy for existing templates:** **Prompt rewrite + new knobs** (defaults shift bright/clean, users can dial back). Confirmed with user.
- **Cost ceiling:** Phase 1 must not add per-render cost. Phase 2 may introduce AI stickers behind an opt-in toggle with cost displayed in the UI.
- **Browser support:** the editor UI must render the live preview in any modern browser. Mobile editor support is "later," not Phase 1.

## 3. Chosen approach

### 3.1 New template: `flex-icon-grid`

**Rendering pipeline (deterministic):**

```
User config in editor
        ↓
POST /api/thumbnails/format/flex-icon-grid/render
        ↓
flex-icon-grid-composer.ts
   ├── Build SVG (1280×720) — cells, shapes, rings, text, palette
   ├── Resolve per-cell content:
   │       ├── icon-library  → inline Lucide SVG path
   │       ├── emoji         → SVG <text> with emoji glyph
   │       ├── upload        → fetch from R2 → embed as base64 OR composite layer
   │       └── text-only     → SVG <text>
   ├── Sharp composite — base SVG + uploaded-image layers
   └── Output: 1280×720 PNG → upload to R2 → return URL
        ↓
Save to thumbnail history (existing pattern)
```

**Optional Step 1 LLM (auto-fill from script):**
A "Suggest cells from script" button that calls an LLM (Claude Haiku 4.5 — cheapest fit) which returns `{ cells: [{ label, suggested_icon, accent_color }, …] }`. User reviews and edits. This mirrors the existing two-step pattern but the LLM is optional, not required.

**Per-cell config shape:**

```ts
interface FlexIconCell {
  index: number;
  label?: string;

  shape?: 'circle' | 'square' | 'rounded-square' | 'hexagon' | 'pill';
  backgroundColor?: string;                            // overrides palette
  backgroundImage?: { url: string; fit: 'cover' | 'contain' };
  backgroundPattern?: 'dots' | 'stripes' | 'grid';     // Phase 2

  content:
    | { type: 'icon-library'; name: string }           // Lucide icon name
    | { type: 'emoji'; char: string }
    | { type: 'upload'; url: string }
    | { type: 'text-only' }
    | { type: 'ai-sticker'; url?: string; prompt?: string };  // Phase 2

  ring?: { color: string; thickness: number; style: 'solid' | 'dashed' } | false;
  labelStyle?: Partial<LabelStyle>;                    // overrides global
}
```

**Global config shape:**

```ts
interface FlexIconGridConfig {
  gridRows: number;          // 2..6
  gridCols: number;          // 2..6
  cellGap: number;
  outerPadding: number;
  cornerRadius: number;
  background:
    | { type: 'solid'; color: string }
    | { type: 'gradient'; from: string; to: string; angle: number }
    | { type: 'image'; url: string };
  palette:
    | 'rainbow' | 'pastel' | 'neon' | 'monochrome'
    | { type: 'custom'; colors: string[] };
  defaultCellShape: CellShape;
  defaultRing: RingStyle;
  defaultLabel: LabelStyle;
  titleBar?: { text: string; position: 'top' | 'bottom'; style: TitleBarStyle };
  cells: FlexIconCell[];
}

interface LabelStyle {
  visible: boolean;
  position: 'below' | 'above' | 'overlay';
  font: 'anton' | 'bowlby-one' | 'archivo-black' | 'patrick-hand';
  case: 'upper' | 'title' | 'as-typed';
  color: string;
  stroke?: { color: string; thickness: number };
  maxLines: number;
}
```

**Palette rule (the engine that makes it "look like the reference channels"):**
The `rainbow` preset uses a curated 15-colour set, and the composer auto-assigns colours so no two adjacent cells (horizontally or vertically) land in the same hue family. Hue family map lives in `flex-icon-grid-palettes.ts`.

**Fonts:**
Bundle three free OFL fonts under `public/fonts/flex-icon-grid/`:
- **Anton** — tall condensed, primary default
- **Bowlby One** — chunky rounded, "fun" alternate
- **Archivo Black** — neutral heavy sans

Plus keep **Patrick Hand** (already in use) for the hand-drawn aesthetic.

**Icon source for Phase 1:**
**Lucide** (MIT, ~1,400 SVG icons, used by shadcn). Add `lucide-react` as a dependency *only for the icon name registry / SVG paths*; we won't render React components server-side, we'll pull raw SVG path data and inline it in our composed SVG. Per rule 9, **verify the Lucide API + Sharp SVG handling via Context7 before writing the composer code**.

**Editor UI (`FlexIconGridPanel.tsx`):**
Progressive disclosure to avoid the "30-knob panel" problem:

```
┌─ Basic ──────────────────────────────────────────┐
│ Grid size: [3 × 5 ▼]   Palette: [Rainbow ▼]      │
│ Default shape: ○ Circle  ▢ Square  ◇ Rounded     │
│                                                  │
│ Cells:                                           │
│   [grid preview, each cell clickable]            │
│                                                  │
│ Click a cell → side panel for that cell's        │
│ content + per-cell overrides.                    │
│                                                  │
│ ▸ Advanced (collapsed)                           │
└──────────────────────────────────────────────────┘
```

Advanced reveals: outer padding, cell gap, ring style, label font, title bar, background, custom palette editor.

Live preview renders client-side on every config change — composes the same SVG the server would, no API call for preview. Final "Render" button hits the server for the canonical PNG. **This is a hard rule for UX (rule 10/16):** preview must be instant or users will not iterate.

**State persistence:** save `FlexIconGridConfig` to `drafts.ts` (existing pattern). On render, write `ThumbnailHistoryEntry` with `format: 'flex-icon-grid'` and the full config in `regions` / format-specific fields.

### 3.2 Existing template polish

**Topic Card Grid (`topic-card-grid`):**
1. Rewrite [topicCardGridImagePrompt](src/lib/thumbnail-formats/topic-card-grid.ts) to require: *flat illustration, single iconic subject per cell, no scene, no fine detail, bold readable labels in chunky sans-serif, high cell-to-cell colour contrast, no photoreal rendering, no cinematic lighting.* Bake the "no AI tells" rules from rule 5 directly into the prompt.
2. Add two new knobs in [TopicCardGridPanel](src/components/thumbnails/TopicCardGridPanel.tsx):
   - **Brightness**: `bright` (default) / `mixed` / `moody` — appended to image prompt.
   - **Detail level**: `clean` (default) / `detailed` — appended to image prompt.
3. Persist both fields on the draft and history entry.

**N Levels Explained (`n-levels`):**
1. Rewrite [nLevelsImagePrompt](src/lib/thumbnail-formats/n-levels.ts) to forbid the dark-fade pattern. Instruct: *every level slice must stay equally bright; later levels should not get darker than earlier ones; use a vibrant palette across all slices.*
2. Add the same **Brightness** and **Detail level** knobs to [NLevelsPanel](src/components/thumbnails/NLevelsPanel.tsx).
3. Backfill default to `bright` + `clean` for new drafts.

### 3.3 File-level plan

```
NEW
  _plans/2026-05-28-flex-icon-grid-thumbnail-template.md   (this file)
  src/lib/thumbnail-formats/flex-icon-grid.ts              (types, geometry, palette, validators)
  src/lib/thumbnail-formats/flex-icon-grid-composer.ts     (SVG build + Sharp pipeline)
  src/lib/thumbnail-formats/flex-icon-grid-palettes.ts     (named palettes + hue-family logic)
  src/lib/thumbnail-formats/flex-icon-grid-icons.ts        (Lucide icon registry + path extraction)
  src/app/api/thumbnails/format/flex-icon-grid/render/route.ts
  src/app/api/thumbnails/format/flex-icon-grid/suggest-cells/route.ts   (optional LLM Step 1)
  src/app/api/uploads/flex-icon-grid-cell/route.ts                       (per-cell upload via R2)
  src/components/thumbnails/FlexIconGridPanel.tsx                        (editor UI)
  src/components/thumbnails/FlexIconGridLivePreview.tsx                  (client-side SVG preview)
  src/components/thumbnails/FlexIconGridCellEditor.tsx                   (per-cell side panel)
  public/fonts/flex-icon-grid/{Anton,BowlbyOne,ArchivoBlack}.ttf
  tests/flex-icon-grid.test.ts
  tests/flex-icon-grid-composer.test.ts

ENHANCED
  src/lib/thumbnail-formats/topic-card-grid.ts   (prompt rewrite + brightness/detail in prompt builder)
  src/lib/thumbnail-formats/n-levels.ts          (prompt rewrite + brightness/detail in prompt builder)
  src/components/thumbnails/TopicCardGridPanel.tsx  (add brightness/detail knobs)
  src/components/thumbnails/NLevelsPanel.tsx        (add brightness/detail knobs)
  src/lib/drafts.ts                               (add brightness/detail to draft schema)
  src/lib/history.ts                              (add brightness/detail + flex-icon-grid format)
  src/app/(app)/thumbnails/page.tsx               (register FlexIconGridPanel tab)
  src/lib/r2.ts                                   (add buildFlexIconGridCellUploadKey)
  scripts/migrate.ts → new migration              (if draft schema is in DB, add columns)
```

## 4. Rejected alternatives

| Option | Why rejected |
|---|---|
| **Single AI generation** of the whole grid (matches existing flow) | Loses every per-cell control we need. Text legibility fails. Cell colours wander. The reference channels' look is geometry — AI image-gen is the wrong tool. |
| **Per-cell AI sticker generation in Phase 1** | Cost surface (~$0.04–0.10 per cell × N cells per thumbnail) is too high to ship as default. Deferred to Phase 2 behind explicit opt-in with cost shown. |
| **Replace existing topic-card-grid** with the new format | Would break existing history and drafts. The two patterns serve different aesthetics — keep both. |
| **Add knobs only, keep current prompts** | Most users won't discover the new knobs. The current defaults are actively underperforming. Worth shifting defaults. |
| **Use Iconify aggregated icon sets** in Phase 1 | Larger surface area, more variability across icon styles, harder to render server-side consistently. Lucide alone is enough for Phase 1; Iconify is a Phase 2 candidate. |

## 5. UX considerations (rule 10 + rule 16)

- **Lazy-user golden path:** open template → pick grid size → pick palette → grid auto-fills with placeholder icons → click cell to swap icon → render. ≤4 clicks to a useful thumbnail.
- **Live preview is non-negotiable.** Edits must reflect instantly. No "Render preview" button required for visual feedback.
- **Empty state:** new draft opens with a 3×5 grid pre-filled with reasonable placeholder icons + the rainbow palette. User can immediately see the design they're going to get.
- **Cell editor affordance:** clicking a cell highlights it and slides in a side panel with that cell's content + overrides. Tapping outside the cell closes the panel. Mobile-friendly even though mobile is not Phase 1.
- **Error states:** if an uploaded image fails to fetch at render time, the cell falls back to the placeholder icon and a non-blocking warning shows next to the cell. The render still succeeds.
- **No AI tells in the panel itself.** Plain language labels, no "leverage your content with AI-powered creativity," etc.

## 6. Settings audit (rule 15)

**New controls exposed in template UI** (per-thumbnail, not workspace):
- Grid size, palette, default cell shape, default ring, default label style — all editable per thumbnail.
- Per-cell content type, shape, background, ring, label overrides.

**Workspace-level settings (Phase 2 candidate, NOT Phase 1):**
- Default font choice for new Flex Icon Grid drafts.
- Saved palette presets (reusable across thumbnails).
- Saved "starting layout" templates (e.g. "my channel's standard 3×5 layout").

Phase 1 explicitly does not introduce a workspace settings surface — that's Phase 2 work tied to the existing `thumbnail_template_presets` table.

## 7. Security (rule 13)

- **Per-cell upload:** reuse the existing R2 presigned-PUT pattern. New key builder `buildFlexIconGridCellUploadKey(workspaceId, draftId, cellIndex)` keeps uploads namespaced per workspace.
- **Upload validation:** MIME allowlist (PNG, JPG, WebP), max 8 MB matching topic-card-grid.
- **SVG injection prevention:** every user-provided string rendered into the SVG (labels, title bar, cell text) **must** be escaped for `<`, `>`, `&`, `"`, `'`. Implement once in `escapeSvgText()` in `flex-icon-grid.ts`. Never `dangerouslySetInnerHTML` user content.
- **Image URLs in cells:** only accept URLs from the workspace's R2 bucket or known-safe domains. Reject arbitrary remote URLs to prevent SSRF and unmoderated content.
- **LLM Step 1 prompt injection:** if the optional script-suggest LLM is enabled, treat the user script as untrusted input — pass it to the LLM but never echo unvalidated LLM output directly into rendered SVG without re-escaping.
- **Lucide icon data:** static, MIT, no remote fetch at render time. Bundle paths at build time.

## 8. Observability (rule 14)

All logs use the `console.info` / `console.warn` / `console.error` pattern with bracketed namespaces.

New log channels:
- `[flex-icon-grid composer]` — composition lifecycle, per-cell render outcomes, timing, image-fetch failures
- `[flex-icon-grid upload]` — presign issuance, upload completion, validation failures
- `[flex-icon-grid api]` — request/response with config summary (cells count, palette, grid size)
- `[flex-icon-grid llm]` — only if Step 1 LLM is enabled: model, token usage, suggestion count

Enhanced log channels:
- `[topic-card-grid prompt]` — prompt variant chosen + brightness/detail values
- `[n-levels prompt]` — same

**Diagnostic rule (rule 14):** every per-cell render outcome logged with the cell index, content type, and shape — so if a single cell goes wrong in production we can paste the lines and pinpoint which cell + why.

## 9. Cost (rule 8)

**Phase 1:**
- New `flex-icon-grid` template renders: **$0 incremental** per thumbnail. Deterministic composition only.
- Existing templates: no new per-render cost. Same image-gen calls as today, just with rewritten prompts.
- Optional Step 1 LLM (script-suggest): Claude Haiku 4.5 at current per-token pricing — **verify on platform.claude.com/docs before shipping**. Expected per-call: well under $0.01.

**Phase 2 (deferred):**
- AI stickers per cell — N image-gen calls per render. Re-verify Flux/Replicate/OpenAI pricing live before scoping Phase 2.
- Workspace-level saved presets — no per-render cost, just DB rows.

## 10. Phasing

### Phase 1 (this PR / this commit batch)

**Deliverables:**
1. `flex-icon-grid` format types, composer, palettes, icon registry.
2. Render API route + per-cell upload route.
3. Editor panel with progressive disclosure + live preview.
4. Cell shapes: **circle, square, rounded-square**. (Hexagon, pill deferred.)
5. Content types: **icon-library (Lucide), emoji, upload, text-only**. (AI sticker deferred.)
6. Palettes: **rainbow, pastel, neon, monochrome, custom**.
7. Backgrounds: **solid, gradient**. (Image/pattern deferred.)
8. Title bar overlay (optional, top/bottom).
9. Topic Card Grid prompt rewrite + brightness/detail knobs.
10. N Levels prompt rewrite + brightness/detail knobs.
11. Tests for composer geometry, palette adjacency rule, SVG escaping.
12. Logs at every step per rule 14.

### Phase 2 (separate plan)

- Cell shapes: hexagon, pill, capsule.
- **AI stickers per cell — must use collage-mode generation** (same pattern as the existing image flow's "Generate 4 shots at once (collage mode), ~75% cheaper, per-cell text baking matches single-shot" toggle). One image-gen call returns a 2×2 / 3×3 collage of stickers; the composer crops them per cell. Do NOT issue N separate per-cell calls.
- Gradient + pattern + image backgrounds per cell.
- Cell-merge (hero + smaller cells).
- Workspace-level saved palettes and starting layouts.
- Iconify icon source expansion.
- Mobile editor support.

## 11. Open questions

- **Live preview tech:** render the SVG client-side (zero round-trip) vs render server-side per keystroke (consistent with the canonical output). Recommendation: client-side preview, server-side canonical render on "Save / Export." Worth confirming during implementation.
- **Cell auto-fill UX:** when user picks a 3×5 grid, do we pre-fill 15 placeholder labels and rainbow colours, or leave cells empty? Recommendation: pre-fill (rule 10, lazy user gets instant visual feedback).
- **Font licensing audit:** confirm Anton, Bowlby One, Archivo Black are all SIL OFL or equivalent, bundle the license files alongside the TTFs.
- **Library verification (rule 9):** before writing the composer, query Context7 for current Lucide raw-SVG export patterns and Sharp's SVG-to-PNG behaviour around embedded base64 images.

## 12. Definition of done (Phase 1)

- New "Flex Icon Grid" tab appears in the thumbnails editor.
- User can render a thumbnail end-to-end with all four content types, three cell shapes, four named palettes, two background types.
- Existing topic-card-grid and n-levels templates render with the new prompts by default and expose brightness/detail knobs.
- All new code paths emit logs per section 8.
- Tests cover: palette adjacency rule, SVG escaping, composer geometry (cell positions, ring positions, label positions for each shape × grid-size combo), and rendered PNG dimensions.
- QA pass per rule 6: golden path + edge cases (empty labels, very long labels, 2×2 grid, 6×4 grid, every shape × every content type, every palette, gradient backgrounds, label-hidden mode, upload failure mid-render, oversized upload rejected, SVG-injection attempt in label).
