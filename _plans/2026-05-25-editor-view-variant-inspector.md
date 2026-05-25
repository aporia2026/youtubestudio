# Plan: Full variant controls in the new editor view's Inspector

**Date:** 2026-05-25
**Status:** Draft — pending approval
**Depends on:**
- `_plans/2026-05-25-near-static-variants.md` (Phase 3 main plan — schema, helpers, mixing rules, main-grid UI)
- The new editor view's foundation being committed (`src/components/production-doc/editor/` files are currently untracked; this plan assumes they land in git first)

## Why this exists

Phase 3.3 + 3.7a–c shipped the full variant management UX inside the main grid view at [src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx). The new multi-pane editor view at [src/components/production-doc/editor/](src/components/production-doc/editor/) only has the **visual indicator** (left-border + chip on `SectionCard`) — and even that was reverted at commit `e0ddd40` because the editor view's foundation isn't fully committed to git yet and one of my SectionCard edits depended on the untracked `./types` module, which broke the Vercel build.

So today a user working in the new editor view sees zero variant affordances: no Add, no Generate, no edit-prompt input, no Delete, no Move, no Stale banner. To manage variants they have to switch back to the old grid view. This plan brings full parity to the editor view's `Inspector`.

## Constraints

- **Don't fork the writer surface.** The mutators (`addVariantRow`, `generateVariantImage`, `deleteVariantRow`, `moveVariantRow`) already exist as `useCallback`s inside the main page component. The editor view must consume them via the existing `EditorWriters` bundle pattern ([src/components/production-doc/editor/types.ts:34](src/components/production-doc/editor/types.ts#L34)), not redefine them. One source of truth.
- **Don't break the read-only mode.** `Inspector` already supports a `writers === undefined` mode that renders read-only — adding variant controls must respect the same gate (the new controls are hidden when writers aren't passed).
- **Reuse existing primitives.** The `Inspector` is a Radix Accordion with three sections (B-roll & Image, Overlay, Section settings). Variants get a fourth accordion section so the layout stays consistent. No new modal surfaces, no novel UX vocabulary.
- **No new backend routes.** Editor view's variant Generate uses the same `/api/generate/production-doc/image/edit` route as the grid view, via the same `composeVariantEditRequest` helper.
- **Pre-req: editor view foundation lands in git first.** Today `SectionCard.tsx`, `SectionStrip.tsx`, `EditorView.tsx`, `Inspector.tsx`, `types.ts`, `hooks/` etc. are untracked. This plan assumes they're tracked before Phase 4 work begins. If they don't land cleanly, this plan stalls.

## Requirements

### Editor-side surface (new components / accordion section)

A fourth accordion key `'variants'` in `AccordionState` (already a discriminated string union in `useEditorUiState`). When the active section is part of a variant group OR can be promoted into one, the Variants accordion opens by default. When the active section is a standalone row with no special signal, the accordion collapses by default (the "Add variant" button is the only control shown inside).

Three states the accordion body must handle:

1. **Active row is standalone.** Body shows ONLY a dashed `+ Add variant` button (same wording as the grid view) and a one-line hint: *"Promote this row into a variant group so you can edit minor expression / pose changes against the same base."* No chip, no edit prompt, no list.
2. **Active row is the base** (`variant_index === 0`). Body shows:
   - Solid chip `⏺ base · N variant(s)`
   - A horizontal mini-strip listing the variants in the group (thumbnail + index), each clickable to jump the active section to that variant.
   - `+ Add variant` button (disabled at cap).
   - One-line hint: *"This row's image is the base. Variants below derive from it via Atlas Edit ($0.011 each)."*
3. **Active row is a variant** (`variant_index > 0`). Body shows:
   - Chip `⟜ variant N/M`
   - The variant's `variant_edit_prompt` as a `<textarea>` (autosaves on change via `updateRow`)
   - `✨ Generate variant (~$0.011)` button (disabled while loading or when prompt is empty)
   - `↑ Move up`, `↓ Move down`, `🗑 Delete` buttons (boundary-aware)
   - `⚠ Base changed — regenerate to match current base` banner when `variant_base_image_at_generation !== rowImages[baseIndex].imageUrl`
   - A small "Jump to base" link to quickly switch the active section back to the base for context

The mini-strip in state #2 is a thin reuse of `SectionCard` at a smaller scale, OR a new lightweight thumbnail row. Recommend reuse for consistency.

### `EditorWriters` extensions

Four new fields in [src/components/production-doc/editor/types.ts:34](src/components/production-doc/editor/types.ts#L34):

```ts
export interface EditorWriters {
  // ...existing fields...
  addVariantRow: (baseIndex: number) => void;
  generateVariantImage: (variantIndex: number) => Promise<void>;
  deleteVariantRow: (variantIndex: number) => void;
  moveVariantRow: (variantIndex: number, direction: 'up' | 'down') => void;
}
```

The page-level `EditorView` props builder ([likely at the bottom of page.tsx where the `<EditorView>` element is mounted]) wires these to the existing `useCallback`s I added in Phase 3.3 + 3.7. No new logic — just plumbing.

### `Inspector` accordion section

A new section after "Section settings":

```tsx
<Accordion.Item value="variants">
  <Accordion.Header>
    <Accordion.Trigger>
      🎬 Variants {variantInfo && (
        <span>({variantInfo.kind === 'base' ? `base + ${variantInfo.total - 1}` : `variant ${variantInfo.variantIndex}/${variantInfo.total - 1}`})</span>
      )}
    </Accordion.Trigger>
  </Accordion.Header>
  <Accordion.Content>
    <VariantPanel
      doc={doc}
      activeSection={activeSection}
      rowImages={rowImages}
      writers={writers}
      onJumpToSection={onSelectSection}
    />
  </Accordion.Content>
</Accordion.Item>
```

Where `<VariantPanel>` is a NEW component (`src/components/production-doc/editor/VariantPanel.tsx`) that owns the three state branches above.

### `EditorView` wiring

The component that owns `activeSection` ([src/components/production-doc/editor/EditorView.tsx]) must pass `onSelectSection` into `Inspector` so the "Jump to base" / "Jump to variant N" links can change active section without going through SectionStrip. This is already plumbed for SectionStrip; just add the same handler to the Inspector's props.

## Chosen approach (sub-phases)

### Phase A — types + writer plumbing

Extend `EditorWriters` interface. Update the page's `EditorView` mount site to pass the four new writers. Stub `<VariantPanel>` as a placeholder so the accordion compiles. Visible result: an empty Variants accordion section.

Files: `src/components/production-doc/editor/types.ts`, `src/app/(app)/production-doc/page.tsx` (writer mount), `src/components/production-doc/editor/Inspector.tsx`, new `src/components/production-doc/editor/VariantPanel.tsx`.

Risk: low. ~80 LOC.

### Phase B — VariantPanel body for standalone + base states

The three-state branch logic. Standalone shows `+ Add variant`. Base shows chip + mini-strip + Add button. Variant state is stubbed.

Files: `VariantPanel.tsx`, possibly a new small `<VariantThumbnail>` helper if `SectionCard` is too heavy for the inline strip.

Risk: low-medium. ~150 LOC.

### Phase C — VariantPanel body for variant state

Edit-prompt textarea, Generate button, Move up/down, Delete, Stale banner, Jump-to-base link. All controls invoke writers from the bundle. Same UX wording / colors as the grid view so users moving between surfaces feel at home.

Files: `VariantPanel.tsx` (extension).

Risk: medium. ~200 LOC. Mostly UI; logic already lives in the writers.

### Phase D — re-introduce the `SectionCard` variant indicator

This is the bit that was reverted at `e0ddd40`. Now safe to re-add because the editor view's foundation is in git (Phase A's pre-req).

Files: `SectionCard.tsx` (add `variantInfo` prop + chip + left-border), `SectionStrip.tsx` (compute `variantInfo` per row, pass to card).

Risk: low. ~50 LOC.

### Phase E — QA

- Open editor view on a doc that has variant groups.
- Click each card in the strip — Inspector reflects the right state for standalone / base / variant.
- Exercise all four writers from the Inspector. Confirm they fire the same autosave path as the grid view.
- Toggle between grid view and editor view on the same doc — both surfaces agree on group structure, variant numbering, stale state.
- Regression check: docs with no variant groups render identically to before.

## Alternatives rejected

1. **Duplicate the grid view's writers inside the editor view's state owner.** Rejected — two sources of truth for the same mutation invites drift. The writer bundle pattern was built for exactly this.
2. **Build a dedicated variant editor as a fullscreen modal.** Rejected — variants are a per-section concern. The Inspector accordion is the section-level surface; a modal hides the active section's context.
3. **Skip the mini-strip on the base row, just show "click Variants in the strip below".** Rejected — the strip is doc-wide; the Inspector is section-scoped. Showing the variants right under the base in the Inspector is the discoverability win.
4. **Lazy-load `<VariantPanel>`.** Rejected for v1 — total LOC is small (~400) and the accordion already lazy-mounts content via Radix.

## Open questions

1. **Mini-strip thumbnail size.** SectionCard is 152px wide. In the Inspector accordion (~360px max), three thumbnails at 152px wouldn't fit comfortably. Pick: scale down to ~80px each, OR build a stripped-down `<VariantThumbnail>` (smaller, no status dots, just thumbnail + index)? I'd recommend the latter — visual hierarchy is clearer when the SectionStrip's primary cards stay full-size and the Inspector's secondary thumbnails are explicitly smaller.
2. **What happens to the editor view's active-section state when a variant is deleted?** If the user is currently viewing a variant and deletes it, where does the active section move? Most natural: back to the base. Code change is one line in the writer to set activeSection after the delete completes.
3. **Should the editor view also surface the "+ Add variant" button on the SectionCard itself** (not just in the Inspector)? The grid view has the button right in the row. In the editor view, the Inspector is the natural home, but a hover-revealed `+` on the SectionCard would mirror the grid pattern. Out of scope for v1; revisit if user feedback wants it.

## Cost / risk

No new dependencies, no new routes, no migration. Atlas Edit cost ($0.011/call) is unchanged. Total scope: ~400 LOC across 4 files (3 modified, 1 new). Phasable in two commits (Phase A+B in one, Phase C+D in another) so each can be reverted cleanly if needed.

## QA checklist

- [ ] `tsc --noEmit` clean
- [ ] `EditorWriters` consumers in test fixtures (if any) still compile
- [ ] Standalone row in Inspector shows only Add button + hint
- [ ] Base row in Inspector shows chip + mini-strip + Add button
- [ ] Variant row in Inspector shows chip + edit prompt + Generate + Move + Delete + (when applicable) Stale banner + Jump-to-base
- [ ] Add variant fires `addVariantRow` and the new variant appears in SectionStrip
- [ ] Generate variant fires the Atlas Edit POST and the result lands in `rowImages`
- [ ] Delete + Move shift indices correctly
- [ ] Stale banner clears after a regenerate
- [ ] Grid view + editor view stay in sync on the same doc
- [ ] Non-variant docs render byte-identically
