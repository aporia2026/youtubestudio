# 2026-05-23 — Editor parity finish: close the 10 control gaps + voiceover-sync surface

## Goals

The editor at `/edit/[projectId]` is ~85% feature-complete relative to
the production-doc page. The owner has been bouncing back and forth
between the two pages because some adjustments only exist on prod-doc,
and several "fixes" they reported (fade keeps returning, scenes drift
from voiceover) trace back to controls that are read-only in the editor
or simply missing.

This plan closes the 10 missing surfaces, in three shippable batches.

## Constraints

- **No new data shape.** Every field already exists in `ProductionDoc`
  and `ProjectPayload`. This is UI port work, not schema work.
- **Reuse, don't rewrite.** Where prod-doc has a working toggle / slider /
  badge, lift the JSX into a small reusable component (or just import the
  same source) — don't reinvent.
- **Asset-blind server stays asset-blind.** Doc-level field edits
  persist through the full-payload PATCH (which already covers them).
  No row-asset endpoint changes needed for this work.
- **Settings audit (rule 15)**: doc-level defaults are themselves
  settings the user wants exposed. No new project-level Settings.json
  knobs required; the controls land in the editor's inspector + header.

## Batches

### Batch 1 — high-impact, low effort

Ships first because (a) the doc-level fade toggle is the source of the
"fade keeps returning" loop the user reported, and (b) the sync badge
is the one the user just asked for by name.

**1.1 Doc-level `scene_fade_enabled` toggle**
- Port the prod-doc switch (`page.tsx:7231-7273`) into the editor's
  inspector or a small "Doc settings" disclosure in the header.
- Wire to a new editor command `SET_DOC_SCENE_FADE` that updates
  `state.doc.scene_fade_enabled` and dirties the state so the
  full-payload PATCH carries it.
- Recommended location: editor inspector → new "Doc settings" tab OR
  a small popover off the Doc header chip. Start with a popover off
  the existing version chip so we don't disturb tab layout.

**1.2 "Synced to voiceover" badge**
- Port `AlignmentPill` (`page.tsx:625-661`) verbatim into the editor.
- Editor's `videoConfig` already gets `alignment: state.voiceoverAlignment`
  passed through `productionDocToVideoConfig`, so realignment IS already
  happening. The badge is purely a visibility surface.
- Status derivation: `voiceoverAlignment` present + audio URL hashes
  match → `ready`; alignment running → `syncing`; failed → `failed`.
  Reuse the existing prod-doc derivation logic if possible (extract to
  `src/lib/editor/alignment-status.ts` if it lives inline today).
- Render in the editor's Audio tab + as a small chip in the header
  near the save indicator. Two surfaces — header for at-a-glance, tab
  for detail + "Re-align" action.

**1.3 `region_zoom_padding_pct` slider per shot**
- Reuse the prod-doc slider component from `SectionRowControls.tsx`.
  Surface it inside `ShotInspector`'s thumbnail-zoom block, right
  below the region picker. Persists to `state.doc.rows[i].region_zoom_padding_pct`.

### Batch 2 — doc-level defaults + per-row OST mode

**2.1 Doc-level defaults panel (Doc-settings popover/disclosure):**
- `section_title_layout_default` (overlay / letterbox)
- `pillarbox_color_default` (color picker)
- `scene_zoom_default` (slider 50-200%)
- `on_screen_text_mode_default` (overlay / bake / none)
- Lives in the same disclosure as 1.1's fade toggle.

**2.2 Per-row `on_screen_text_mode` toggle**
- Surface in `ShotInspector` near `on_screen_text`. Tri-state (overlay
  / bake / none) with "Default (uses doc setting)" radio option.

### Batch 3 — bigger features

**3.1 "Animation model for all shots" bulk picker**
- Port from `page.tsx:7275+`. Lives in the doc-settings disclosure.
- Writes `doc.broll_model_id_default` (or whatever field the prod-doc
  bulk picker uses — verify before porting).

**3.2 Per-row voiceover (re)generation**
- Port the per-row TTS regen control from prod-doc. Surfaces in
  `ShotInspector`'s Audio tab. Calls the same generation endpoint
  prod-doc uses; result feeds back through the row-asset endpoint
  (slot=image semantics may differ — verify endpoint shape supports a
  per-row voiceover slot OR add one).
- NOTE: this is the biggest item. If endpoint shape needs work, that's
  a separate plan; flag it before coding.

## Alternatives rejected

- **Single "Doc settings" modal** — too far from the user's mental
  model. They expect inline controls near where they affect things.
- **Sync the prod-doc as the canonical settings page** — that's the
  current state and it's why the user is unhappy. The editor needs
  its own surfaces.
- **Wait for the bigger refactor (atomic-write-everywhere)** — would
  block the user for too long. Ship batches incrementally; the
  asset-blind server change already lands the highest-value protection.

## Security & safety (rule 13)

- No new attack surface. All controls update existing `ProductionDoc`
  fields that the validator/migrator already handle.
- The badge is read-only; can't be abused.
- Per-row VO regen calls the same auth-gated endpoint prod-doc uses.

## Observability (rule 14)

Every new control emits a namespaced log on user interaction:
- `[editor doc-settings scene-fade] toggled`
- `[editor doc-settings text-mode-default] changed`
- `[editor alignment badge] status resolved`
- `[editor region-padding] changed`
- `[editor bulk-anim-model] changed`
- `[editor row-vo regen] started/completed/failed`

## QA plan (rule 6)

After each batch:
1. Open prod-doc, toggle the equivalent control there. Navigate to
   editor → control reflects the same state.
2. Editor → flip the control. Navigate to prod-doc → reflects.
3. Refresh editor → control survives.
4. Render preview → behavior matches the control (e.g. fade actually
   off when toggled off).
5. Two tabs open → conflict banner fires correctly when state diverges;
   no silent overwrite.

## Open questions to confirm during implementation

- For Batch 3.1: what's the exact field name the bulk picker writes?
  `broll_model_id_default`? Verify against the prod-doc code.
- For Batch 3.2: does the row-asset endpoint already support voiceover
  slots, or do per-row VO writes need a new slot type?
