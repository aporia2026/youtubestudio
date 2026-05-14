# 2026-05-13 — Production-doc fonts (per-channel default + per-video override)

> **Shipped 2026-05-14.** As-built notes summarised at the bottom of this file under "As-built deltas". The phase content below is the plan as approved; the deltas section records where execution diverged and why.


## Goal

Make font choices visible, configurable, and consistent across every
video a channel renders. Today the brand kit ships a fallback string
(`'Inter, system-ui, sans-serif'`) and only Inter is actually loaded
via `@remotion/google-fonts`. So renders are at the mercy of whatever
system fonts a given machine has — Studio on Windows, Vercel on Linux,
and Lambda all produce subtly different text. After this: every
supported font is loaded via `@remotion/google-fonts`, every channel
sets its default, every video can override.

The trigger for this plan: confirmed user font is **Patrick Hand**
(Google Fonts, free) for whiteboard-explainer section titles like
"Reconnaissance". Other styles (e.g., the bold thumbnail title font
from the cybersecurity scams screenshot) will land as creators ask.

## In scope

- Curated set of preloaded Google Fonts covering the styles we
  actually use (whiteboard-explainer, bold-condensed, sans-serif, etc.)
- Per-channel default brand kit (visual) stored alongside the existing
  script-generation brand kit.
- Per-video override on the production-doc record.
- A small "Fonts" picker in the production-doc page that shows live
  previews and writes the override.
- Same loading mechanism we set up for Inter — `delayRender` gated on
  `waitUntilDone`, safe fallback to system fonts on load failure.

## Out of scope (v2+)

- Uploading custom (non-Google-Fonts) font files. Real value (channels
  with bespoke type), but introduces hosting + license-management
  scope. Defer.
- Variable-axis fonts with creator-controlled axes (weight slider,
  optical-size slider). Cool. Not load-bearing.
- Per-shot font override (one shot uses a different font than the rest
  of the video). Speculative; can be added later without DB change.
- An LLM-driven "suggest a font for this niche" feature. Speculative.

## Curated v1 font set

All Google Fonts, all loaded via `@remotion/google-fonts/<Family>`.

| Family | Use case |
|---|---|
| **Inter** | Default body + UI. Already loaded. |
| **Patrick Hand** | Hand-drawn / whiteboard section titles ("Reconnaissance"). User-confirmed. |
| **Anton** | Bold ultra-condensed for thumbnail-style titles. |
| **Bebas Neue** | Tall narrow caps, alternative bold title. |
| **Archivo Black** | Heavy sans-serif title for stat cards. |
| **Caveat** | Casual handwritten alternative to Patrick Hand. |
| **Source Serif 4** | Editorial body for documentary-style content. |
| **JetBrains Mono** | Code blocks, terminal-style on-screen text. |

Eight fonts is the right starting cap — small enough to load all up
front without a render-time delay, large enough to cover the styles
the existing production-doc-styles list implies (Cinematic, 2D
Animation, Documentary, Tech/SaaS, Whiteboard, Viral, Stock Photo,
Doodle Explainer per
[src/lib/production-doc-styles.ts](src/lib/production-doc-styles.ts)).

Each font loads `weights: ['400', '700']` minimum; bold-heavy families
(Anton, Bebas Neue) load `['400']` only because they ship single
weights. Subset is `['latin']` for all. Total preload bandwidth: ~600KB
gzipped. Acceptable for video render bundles; trivial for Studio.

## Data model

### Per-channel default (`channels.visual_brand_kit` JSONB column)

New JSONB column on `channels`, sibling to the existing `brand_kit`
column (which is for script generation guidance — different concept).
Separating the two avoids accidental cross-coupling — script
generation has no business knowing about font choices.

```ts
export interface ChannelVisualBrandKit {
  v: 1;
  fontFamily?: string;        // CSS family name, must be one of the curated set
  titleFontFamily?: string;
  primaryColor?: string;      // hex
  secondaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  titleColor?: string;
  logoUrl?: string;
  channelName?: string;
}
```

Resolves at render time as:

```
DEFAULT_BRAND_KIT  ←  channel.visual_brand_kit  ←  productionDoc.visual_brand_kit_override
                       (per-channel default)       (per-video override)
```

Each layer is `Partial<ChannelVisualBrandKit>`; merge runs left-to-right.

### Per-video override

A new optional field on the production-doc record:

```ts
production_doc.visual_brand_kit_override?: Partial<ChannelVisualBrandKit>;
```

Storage: a new key inside the existing
`pipeline_stage_artefacts.metadata_jsonb`. No new column needed.

## DB changes

Migration `0068_add_channel_visual_brand_kit.ts` (Lambda = 0066,
thumbnail = 0067, fonts = 0068):

```sql
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS visual_brand_kit JSONB NOT NULL DEFAULT '{}'::jsonb;
```

(Numbered 0068: Lambda render-jobs = 0066, thumbnail = 0067, this = 0068.)

## API changes

1. **`GET /api/channels/[id]/visual-brand-kit`** — returns the parsed
   kit. Workspace-scoped.
2. **`PATCH /api/channels/[id]/visual-brand-kit`** — partial update.
   Validates that `fontFamily` and `titleFontFamily` are in the curated
   set. Validates color formats. Workspace-scoped.
3. **`PATCH /api/production-doc/[id]/visual-brand-kit-override`** —
   writes the per-video override. Same validation. Workspace-scoped.

## Font loading

One file per family, each mirroring the existing
[src/remotion/fonts.ts](src/remotion/fonts.ts) pattern. Centralized
through a single barrel:

```ts
// src/remotion/fonts/index.ts
import { INTER_FAMILY } from './inter';
import { PATRICK_HAND_FAMILY } from './patrick-hand';
import { ANTON_FAMILY } from './anton';
// ... etc

export const FONT_REGISTRY = {
  Inter: INTER_FAMILY,
  'Patrick Hand': PATRICK_HAND_FAMILY,
  Anton: ANTON_FAMILY,
  // ...
};

export const ALLOWED_FONT_FAMILIES = Object.keys(FONT_REGISTRY);
```

Root.tsx swaps `import './fonts'` for `import './fonts/index'` — same
side-effect contract.

Each per-font file:

```ts
// src/remotion/fonts/patrick-hand.ts
import { delayRender, continueRender } from 'remotion';
import { loadFont } from '@remotion/google-fonts/PatrickHand';

const handle = delayRender('Loading Patrick Hand');
const { fontFamily, waitUntilDone } = loadFont('normal', {
  weights: ['400'],   // Patrick Hand ships only 400
  subsets: ['latin'],
});
waitUntilDone()
  .then(() => continueRender(handle))
  .catch((err) => {
    console.error('[remotion] Patrick Hand load failed:', err);
    continueRender(handle);
  });
export const PATRICK_HAND_FAMILY = fontFamily;
```

## UX

### On the channel settings page

A new "Visual brand kit" section, separate from the existing script
brand kit:

- **Font family** — dropdown listing the 8 curated families, each row
  showing a live preview ("The quick brown fox") in that family. Empty
  option = "Use default (Inter)".
- **Title font family** — same dropdown, separate setting.
- **Colors** — five color pickers (primary, secondary, background,
  text, title).
- **Logo upload** — single file dropzone, Vercel Blob upload, used by
  the outro scene.
- **Channel name** — single-line input, used by the outro scene.

Above the form, a small "Render a preview" button that fires a static
render of a sample title card using the current values. Cached for 5
minutes per kit hash so repeated clicks don't re-render.

### On the production-doc page

A small collapsible "Override visual brand kit (this video only)"
panel, default collapsed. Same form fields as the channel page, all
optional, each showing "(channel default: <value>)" as placeholder
text. Save writes the override to the production-doc record.

The "Render Video" button stays unchanged; the override flows through
`productionDocToVideoConfig` automatically.

## Render flow

```
productionDocToVideoConfig(doc, ..., brandOverride?)
        │
        ▼
1. Read channel.visual_brand_kit (workspace-scoped lookup using doc.channel_id).
2. Read doc.visual_brand_kit_override (a field inside metadata_jsonb).
3. Merge: DEFAULT_BRAND_KIT ◀ channel ◀ override.
4. Validate fontFamily / titleFontFamily are in ALLOWED_FONT_FAMILIES;
   anything else falls back to DEFAULT_BRAND_KIT's value.
5. Return VideoConfig with the merged brand kit.
```

The Remotion side is unchanged — components already read from
`brand.fontFamily` / `brand.titleFontFamily`. They just pick up the
new families because those families are now loaded.

## Security (rule 13)

- `fontFamily` and `titleFontFamily` allowlist-validated server-side.
  No arbitrary CSS injection through font-family.
- Color values regex-validated as `#[0-9A-Fa-f]{6}` only. Defends
  against CSS injection.
- `logoUrl` validated as a Vercel Blob URL (your own bucket). Prevents
  hot-linking an attacker-controlled image into renders.
- Channel ownership validated on every patch — a creator can only
  modify channels in their workspace.

## Decision log

- **Separate `visual_brand_kit` column** from the existing
  `brand_kit` column. The two are about different concerns (visual
  rendering vs script generation) and reading one as the other is a
  category mistake waiting to happen. Small storage cost for clear
  separation.
- **8 curated fonts, all preloaded.** Trade some bundle size for
  near-zero risk of render-time font-load failures (font-loading is
  the #1 cause of Remotion `delayRender` timeouts per their docs).
- **Patrick Hand for whiteboard-style titles.** User-confirmed via the
  Reconnaissance screenshot. Standard choice in this space — common
  to see in Crash Course, Kurzgesagt-adjacent content, whiteboard
  explainer factory templates.
- **No font upload in v1.** Hosting custom fonts requires a CDN path,
  license verification, and a UI workflow that's all defensible-against
  -abuse. Defer until a real channel asks for it.
- **No LLM Council pass.** Standard product feature, well-trodden;
  council would not surface new risk.

## Phases

### Phase 1 — Font loading infrastructure (¼ day)
- Create `src/remotion/fonts/index.ts` + one file per family.
- Update Root.tsx import.
- Verify `npx remotion compositions` still bundles cleanly.

### Phase 2 — DB + API (½ day)
- Migration 0067.
- `src/lib/channel-visual-brand-kit.ts` mirroring the existing
  `channel-brand-kit.ts` pattern — pure parser + DB I/O helpers.
- Three API routes (GET / PATCH channel, PATCH doc override).

### Phase 3 — Channel-settings UI (½ day)
- New "Visual brand kit" panel on `/channel/[id]/settings` (or
  wherever channel settings live today — confirm during implementation).
- Live-preview dropdowns, color pickers, logo dropzone, channel-name
  input.
- "Render a preview" button hitting a tiny new still-render endpoint
  that returns a sample title card.

### Phase 4 — Production-doc override UI (¼ day)
- Collapsible "Override visual brand kit" panel on the production-doc
  page, default collapsed, same form fields.

### Phase 5 — Wire into `productionDocToVideoConfig` (¼ day)
- Add merging logic, validation, and the `brandOverride` parameter.
- Update both render routes to read the channel kit + doc override and
  pass through.

**Total: ~1¾ days.**

## Cost

- Curated fonts are all open-source Google Fonts. **Zero licensing
  cost.**
- ~600KB of font data preloaded into every Remotion bundle. **Trivial.**
- No external service calls at render time (fonts are bundled).

## Rollback

- Migration drops the column.
- All `brand` fields fall back to `DEFAULT_BRAND_KIT` if the channel
  or override lookups fail — no functional regression.

---

## As-built deltas (2026-05-14)

Where execution diverged from the plan and why:

- **Migration number is 0070, not 0068.** Slots 0067/0068/0069 were
  taken by voiceover_alignments / workspace_members reheal /
  review_player_timing_samples between the plan and the start of
  implementation. The actual DDL is identical to what the plan
  specified — `ALTER TABLE channels ADD COLUMN IF NOT EXISTS
  visual_brand_kit JSONB NOT NULL DEFAULT '{}'::jsonb`.
- **Channel-settings page route is `/channel/[id]/visual-brand-kit`**
  (not `/channels/[id]/settings`). The existing
  `/channel/[id]/brand-kit` page (script kit) was the model; the new
  visual kit sits as a sibling. Both routes are cross-linked, and the
  `/channel` list page got a 🎨 "Visual kit" button alongside the
  renamed 📝 "Script kit".
- **Fonts module is single-file, not a per-font barrel.** Eight font
  loads in one `src/remotion/fonts.ts` with a `FONT_REGISTRY` constant
  + `ALLOWED_FONT_FAMILIES` allowlist + `resolveFontStack` helper. Less
  churn than 9 files for ~10 lines of declarative code each;
  registering a new family is still a one-place change.
- **No dedicated PATCH route for the per-video override.** Production
  docs live in the `user_history` table (Phase 10), not a dedicated
  table — the override is a new `visualBrandKitOverride` field on
  `ProductionDocHistoryEntry` and flows through the existing
  `/api/history/[id]` PATCH path. One less route, no parity gap.
- **Logo upload route is `POST /api/channels/[id]/visual-brand-kit/logo`.**
  Mirrors the existing production-doc thumbnail upload pattern: returns
  a presigned R2 PUT URL + the public download URL. Channel ownership
  is verified before presign (404 cross-workspace, not 403, to avoid
  leaking channel existence). 2 MB / JPEG / PNG / WebP / SVG.
- **Total bundle weight ~1 MB, not ~600 KB.** Plan estimate was off by
  ~50% once every weight load was counted — still trivial. No noticed
  cold-start impact in Studio.
- **"Render a preview" button on the channel settings page was
  deferred.** The plan called for a button that fires a static render
  of a sample title card cached per kit hash. In-form previews (live
  font samples in the picker grid, color swatches synced to the hex
  inputs, logo dropzone preview, channel-name placeholder) cover 95%
  of the "see what it looks like" need without the still-render
  endpoint, the 5-minute cache, or the additional surface area.
  Reconsider after dogfood if users still ask.
- **Video-studio page font list aligned with the curated registry.**
  Out-of-plan find: the experimental `BrandTab` in `/video-studio`
  hard-coded Space Grotesk / Oswald / DM Sans, none of which are
  loaded via `@remotion/google-fonts` — they were silently rendering
  with the system fallback. Now reads from `FONT_REGISTRY` so the
  video-studio matches the production-doc renderer.
- **22 tests** in `tests/channel-visual-brand-kit.test.ts` cover the
  parser (font allowlist, hex regex, URL allowlist, version mismatch,
  unknown-key drop) and the resolver merge (channel + override +
  font-stack expansion).

### Files added / changed

- `src/remotion/fonts.ts` — expanded to 8 families + registry + helper.
- `src/lib/migrations/0070_add_channel_visual_brand_kit.ts` — new.
- `src/lib/channel-visual-brand-kit.ts` — new.
- `src/app/api/channels/[id]/visual-brand-kit/route.ts` — new (GET/PUT).
- `src/app/api/channels/[id]/visual-brand-kit/logo/route.ts` — new (POST presign).
- `src/app/(app)/channel/[id]/visual-brand-kit/page.tsx` — new.
- `src/components/visual-brand-kit/VisualBrandKitFields.tsx` — new (shared FontPicker / ColorField / LogoDropzone).
- `src/components/production-doc/VisualBrandKitOverridePanel.tsx` — new.
- `src/lib/history.ts` — extended `ProductionDocHistoryEntry` with
  `visualBrandKitOverride`.
- `src/app/(app)/production-doc/page.tsx` — added active-channel fetch,
  per-doc override panel, merged-kit wiring through `effectiveBrandKit`.
- `src/app/(app)/channel/page.tsx` — 🎨 Visual kit button + 📝 Script kit rename.
- `src/app/(app)/channel/[id]/brand-kit/page.tsx` — cross-link to visual kit + heading rename.
- `src/app/(app)/video-studio/page.tsx` — font list aligned with registry.
- `src/remotion/Root.tsx` — comment refresh.
- `tests/channel-visual-brand-kit.test.ts` — new (22 tests).
