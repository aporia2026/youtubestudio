'use client';

/**
 * Inspector subpanel for multi-block on-screen text.
 *
 * PR 5 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 * Builds on PR 4's data shape (`on_screen_text_blocks: OnScreenTextBlock[]`)
 * by exposing every block-level field the user can edit:
 *
 *   - Add a new block (seeded with a sensible default position +
 *     variant inherited from the doc's style).
 *   - Edit per-block text inline.
 *   - 3×3 anchor preset grid for one-click placement.
 *   - Variant picker (default vs doodle-yellow).
 *   - Scale slider (multiplier on variant fontSize).
 *   - Rotation slider (-45° to +45°).
 *   - Delete a block.
 *
 * Drag-on-canvas placement and per-block renderer composition land in
 * PR 6. This panel persists the data; the editor's `productionDocToVideoConfig`
 * threads it through (PR 4); PR 6 wires the renderer to actually
 * paint each block at its own position.
 *
 * Wiring contract: every mutation flows through `onUpdateRow` which
 * dispatches `PATCH_ROW` in the editor store — auto-save, undo / redo
 * all work without this component knowing about the store. Same pattern
 * as `InspectorMotionCollagePanel`.
 */

import { useMemo } from 'react';
import {
  ON_SCREEN_TEXT_ANCHORS,
  ON_SCREEN_TEXT_VARIANTS,
  ON_SCREEN_TEXT_BLOCK_LIMITS,
  type OnScreenTextBlock,
  type OnScreenTextAnchor,
  type OnScreenTextVariant,
  type ProductionDoc,
} from '@/remotion/utils';

/** Default canvas position for a new block keyed on the anchor.
 *  Centered (x=50, y=50) for the center anchor; corner anchors land
 *  with 5% margin off the edge so the block isn't flush against the
 *  frame boundary. */
const ANCHOR_DEFAULT_POSITION: Record<OnScreenTextAnchor, { x_pct: number; y_pct: number }> = {
  'top-left': { x_pct: 8, y_pct: 8 },
  'top-center': { x_pct: 50, y_pct: 8 },
  'top-right': { x_pct: 92, y_pct: 8 },
  'center-left': { x_pct: 8, y_pct: 50 },
  'center': { x_pct: 50, y_pct: 50 },
  'center-right': { x_pct: 92, y_pct: 50 },
  'bottom-left': { x_pct: 8, y_pct: 92 },
  'bottom-center': { x_pct: 50, y_pct: 88 },
  'bottom-right': { x_pct: 92, y_pct: 92 },
};

interface InspectorTextBlocksPanelProps {
  row: ProductionDoc['rows'][number];
  shotIndex: number;
  doc: ProductionDoc;
  onUpdateRow: (patch: Partial<ProductionDoc['rows'][number]>) => void;
}

/** Generate a new opaque block id. crypto.randomUUID is available in
 *  every browser the editor supports + every Node test runner. */
function newBlockId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for any environment without crypto.randomUUID (very rare).
  return `block-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Resolve the doc's preferred block variant from `doc.style_preset`.
 *  Matches SceneRouter's mapping (YouTubeVideo.tsx:473-476): the two
 *  yellow-OST built-ins → 'doodle-yellow'; everything else → 'default'.
 *  Doc-derived styles (saved-style UUIDs) inherit from PR 1's
 *  effective-slug resolution — the editor parent could pass an
 *  effectiveStyleSlug in if more precision is needed, but this
 *  literal-slug check covers built-ins correctly today. */
function inheritedVariantForDoc(stylePreset: string | undefined): OnScreenTextVariant {
  if (stylePreset === 'doodle_explainer_2' || stylePreset === 'paint_explainer_v1') {
    return 'doodle-yellow';
  }
  return 'default';
}

export function InspectorTextBlocksPanel({
  row,
  shotIndex,
  doc,
  onUpdateRow,
}: InspectorTextBlocksPanelProps): React.ReactElement {
  const blocks = useMemo<OnScreenTextBlock[]>(
    () => (row.on_screen_text_blocks ?? []) as OnScreenTextBlock[],
    [row.on_screen_text_blocks],
  );
  const inheritedVariant = inheritedVariantForDoc(doc.style_preset);

  function patchBlocks(next: OnScreenTextBlock[]): void {
    onUpdateRow({ on_screen_text_blocks: next.length > 0 ? next : undefined });
  }

  function patchBlockAt(index: number, patch: Partial<OnScreenTextBlock>): void {
    const next = [...blocks];
    next[index] = { ...next[index], ...patch };
    patchBlocks(next);
    console.info('[editor text-overlay edit]', {
      shotIndex,
      blockId: next[index].id,
      fields: Object.keys(patch),
    });
  }

  function addBlock(): void {
    if (blocks.length >= ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot) {
      console.info('[editor text-overlay add] cap reached', {
        shotIndex,
        cap: ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot,
      });
      return;
    }
    const newBlock: OnScreenTextBlock = {
      id: newBlockId(),
      text: 'Text',
      x_pct: 50,
      y_pct: 50,
      scale: 1,
      anchor: 'center',
      variant: inheritedVariant,
    };
    patchBlocks([...blocks, newBlock]);
    console.info('[editor text-overlay add]', {
      shotIndex,
      newBlockId: newBlock.id,
      inheritedVariant,
    });
  }

  function removeBlockAt(index: number): void {
    const removed = blocks[index];
    const next = blocks.filter((_, i) => i !== index);
    patchBlocks(next);
    console.info('[editor text-overlay remove]', {
      shotIndex,
      blockId: removed?.id,
      hadText: Boolean(removed?.text),
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span
          className="text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--fg-muted)' }}
        >
          Text blocks
          {blocks.length > 0 && (
            <span style={{ marginLeft: 6, color: 'var(--fg-muted)' }}>· {blocks.length}</span>
          )}
        </span>
        <button
          type="button"
          onClick={addBlock}
          disabled={blocks.length >= ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot}
          className="text-[10px] px-2 py-0.5 rounded"
          style={{
            background: 'rgba(124,58,237,0.20)',
            color: '#a78bfa',
            border: '1px solid rgba(124,58,237,0.45)',
            cursor:
              blocks.length >= ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot
                ? 'not-allowed'
                : 'pointer',
            opacity:
              blocks.length >= ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot ? 0.5 : 1,
          }}
          title={
            blocks.length >= ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot
              ? `Block cap (${ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot}) reached`
              : 'Add a new text block at center'
          }
        >
          + Add block
        </button>
      </div>

      {blocks.length === 0 && (
        <div
          className="text-[10px] italic"
          style={{ color: 'var(--fg-muted)' }}
        >
          No text blocks yet. The legacy On-screen text above renders at
          the default lower-third position. Click + Add block to place
          additional text anywhere on the canvas.
        </div>
      )}

      {blocks.map((block, idx) => (
        <BlockEditor
          key={block.id}
          block={block}
          index={idx}
          onPatch={(patch) => patchBlockAt(idx, patch)}
          onRemove={() => removeBlockAt(idx)}
        />
      ))}
    </div>
  );
}

interface BlockEditorProps {
  block: OnScreenTextBlock;
  index: number;
  onPatch: (patch: Partial<OnScreenTextBlock>) => void;
  onRemove: () => void;
}

function BlockEditor({ block, index, onPatch, onRemove }: BlockEditorProps): React.ReactElement {
  return (
    <div
      style={{
        padding: 8,
        borderRadius: 6,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--card-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {/* Header row: ordinal + delete */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="text-[10px] font-semibold" style={{ color: 'var(--fg)' }}>
          Block {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Delete text block ${index + 1}`}
          title="Delete this block"
          className="text-[10px] px-1.5 py-0.5 rounded"
          style={{
            background: 'transparent',
            color: 'var(--fg-muted)',
            border: '1px solid var(--card-border)',
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* Text */}
      <textarea
        value={block.text}
        onChange={(e) =>
          onPatch({ text: e.target.value.slice(0, ON_SCREEN_TEXT_BLOCK_LIMITS.maxTextChars) })
        }
        rows={2}
        placeholder="Text…"
        style={{
          fontSize: 11,
          padding: '4px 6px',
          borderRadius: 4,
          background: 'rgba(0,0,0,0.25)',
          color: 'var(--fg)',
          border: '1px solid var(--card-border)',
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          lineHeight: 1.4,
          fontFamily: 'inherit',
        }}
      />

      {/* Anchor 3×3 grid */}
      <div>
        <div className="text-[9px] mb-1" style={{ color: 'var(--fg-muted)' }}>
          Anchor
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gridTemplateRows: 'repeat(3, 1fr)',
            gap: 2,
            width: 84,
            height: 60,
          }}
        >
          {ON_SCREEN_TEXT_ANCHORS.map((anchor) => {
            const active = block.anchor === anchor;
            return (
              <button
                key={anchor}
                type="button"
                onClick={() => {
                  const pos = ANCHOR_DEFAULT_POSITION[anchor];
                  onPatch({ anchor, x_pct: pos.x_pct, y_pct: pos.y_pct });
                }}
                title={anchor.replace('-', ' ')}
                aria-label={`Anchor to ${anchor}`}
                style={{
                  padding: 0,
                  background: active ? 'rgba(124,58,237,0.30)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${active ? 'rgba(124,58,237,0.55)' : 'var(--card-border)'}`,
                  borderRadius: 2,
                  cursor: 'pointer',
                  minWidth: 0,
                  minHeight: 0,
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Variant + scale + rotation inline */}
      <div style={{ display: 'flex', gap: 4 }}>
        {ON_SCREEN_TEXT_VARIANTS.map((variant) => {
          const active = (block.variant ?? 'default') === variant;
          return (
            <button
              key={variant}
              type="button"
              onClick={() => onPatch({ variant })}
              className="text-[9px] px-1.5 py-0.5 rounded flex-1"
              style={{
                background: active ? 'rgba(124,58,237,0.20)' : 'rgba(255,255,255,0.04)',
                color: active ? '#a78bfa' : 'var(--fg)',
                border: active ? '1px solid rgba(124,58,237,0.45)' : '1px solid var(--card-border)',
                cursor: 'pointer',
                fontWeight: active ? 600 : 400,
              }}
              title={`Variant: ${variant}`}
            >
              {variant === 'doodle-yellow' ? 'Yellow' : 'Default'}
            </button>
          );
        })}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--fg-muted)' }}>
        <span style={{ width: 50 }}>Scale</span>
        <input
          type="range"
          min={ON_SCREEN_TEXT_BLOCK_LIMITS.scaleMin}
          max={ON_SCREEN_TEXT_BLOCK_LIMITS.scaleMax}
          step={0.1}
          value={block.scale}
          onChange={(e) => onPatch({ scale: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
        <span style={{ width: 30, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
          {block.scale.toFixed(1)}×
        </span>
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--fg-muted)' }}>
        <span style={{ width: 50 }}>Rotate</span>
        <input
          type="range"
          min={ON_SCREEN_TEXT_BLOCK_LIMITS.rotationDegMin}
          max={ON_SCREEN_TEXT_BLOCK_LIMITS.rotationDegMax}
          step={1}
          value={block.rotation_deg ?? 0}
          onChange={(e) => onPatch({ rotation_deg: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
        <span style={{ width: 30, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
          {block.rotation_deg ?? 0}°
        </span>
      </label>
    </div>
  );
}
