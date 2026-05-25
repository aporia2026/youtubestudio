'use client';

import React, { useMemo } from 'react';
import { productionDocToVideoConfig } from '@/remotion/utils';
import { Stage } from './Stage';
import { Inspector } from './Inspector';
import { SectionStrip } from './SectionStrip';
import { CheatSheet } from './CheatSheet';
import { useEditorUiState } from './hooks/useEditorUiState';
import { useEditorUndoStack } from './hooks/useEditorUndoStack';
import { useSaveIndicator } from './hooks/useSaveIndicator';
import type { EditorViewProps } from './types';
import { OverlayPositionEditor } from '@/components/production-doc/OverlayPositionEditor';

/**
 * Top-level editor surface for `/production-doc`. Composes the three
 * panes — Stage (live preview), Inspector (accordion controls),
 * Section strip (horizontal nav). Doc state and writers stay in the
 * parent page; this component is a presentational shell with local UI
 * state (active section, accordion open/closed, stage takeover tool).
 *
 * When `writers` + `brollContext` props are passed the inspector
 * renders fully editable controls and the "Edit on stage" buttons
 * become live. Without them, the inspector falls back to read-only
 * labels (the Phase 1 shape).
 */
export const EditorView: React.FC<EditorViewProps> = (props) => {
  const {
    doc,
    rowImages,
    rowVideoClips,
    rowOverlays,
    rowLockedAsStill,
    rowLockSignatures,
    voiceoverUrl,
    voiceoverAlignment,
    brandKit,
    animateScenes,
    suppressLowerThirds,
    writers,
    brollContext,
  } = props;

  const totalSections = doc.rows?.length ?? 0;
  const ui = useEditorUiState(totalSections);
  // Wrap the writer's `updateRow` to record an undo entry for every
  // single-row edit. Bulk operations bypass the stack by design — see
  // useEditorUndoStack for rationale.
  const undoStack = useEditorUndoStack({
    writers,
    doc,
    setActiveSection: ui.setActiveSection,
  });
  const effectiveWriters = undoStack.writers ?? writers;
  // "Saved Xs ago" indicator — driven by doc reference changes (every
  // updateRow call returns a new doc reference from `setDoc`).
  const saveIndicator = useSaveIndicator(doc);

  // Same flattening + config build that VideoPlayerMemo does on the main
  // page — kept in sync intentionally. If the page's memoization shape
  // ever drifts, the comparable bits live here too.
  const config = useMemo(() => {
    const rowClipsArr = doc.rows.map((_, i) => rowVideoClips[i] ?? null);
    return productionDocToVideoConfig(doc, rowImages, {
      voiceoverUrl: voiceoverUrl || undefined,
      brand: brandKit,
      rowVideoClips: rowClipsArr,
      rowLockedAsStill,
      animateScenes,
      rowOverlays,
      suppressLowerThirds,
      alignment: voiceoverAlignment ?? undefined,
    });
  }, [
    doc,
    rowImages,
    rowVideoClips,
    rowOverlays,
    rowLockedAsStill,
    animateScenes,
    suppressLowerThirds,
    voiceoverUrl,
    voiceoverAlignment,
    brandKit,
  ]);

  // ─── Stage takeover ──────────────────────────────────────────────────────
  // When `ui.stageTool` is set, the Stage area swaps from the live preview
  // to the tool's inline canvas. Each tool is wired below; tools that
  // haven't been refactored to inline mode yet (mask, region) keep
  // opening as fullscreen modals via the writers' modal-trigger handlers
  // and never appear here.
  const activeRow = doc.rows?.[ui.activeSection];
  const activeOverlay = rowOverlays[ui.activeSection];
  const activeImage = rowImages[ui.activeSection];

  const takeover: React.ReactNode = (() => {
    if (!effectiveWriters || !activeRow) return null;
    if (
      ui.stageTool === 'overlay-position' &&
      activeOverlay?.status === 'done' &&
      activeOverlay.url
    ) {
      return (
        <OverlayPositionEditor
          stillImageUrl={activeImage?.status === 'done' ? activeImage.imageUrl : undefined}
          overlayUrl={activeOverlay.url}
          position={activeRow.overlay_position}
          sizePct={activeRow.overlay_size_pct}
          stretchedHeightPct={activeRow.overlay_stretched_height_pct}
          termsLabel={activeRow.overlay_stock_terms || ''}
          onSave={(pos, size) => {
            effectiveWriters.updateRow(ui.activeSection, {
              overlay_position: pos,
              overlay_size_pct: size,
            });
          }}
          onReset={() => {
            effectiveWriters.updateRow(ui.activeSection, {
              overlay_position: undefined,
              overlay_size_pct: undefined,
            });
          }}
          onClose={() => ui.setStageTool(null)}
        />
      );
    }
    return null;
  })();

  if (totalSections === 0) {
    return (
      <div
        className="rounded-xl p-10 text-center"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--border)',
          color: 'var(--text-muted)',
        }}
      >
        Generate a production doc first to open the editor.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <EditorTopBar
        onShowShortcuts={ui.toggleCheatSheet}
        onUndo={undoStack.undo}
        onRedo={undoStack.redo}
        canUndo={undoStack.canUndo}
        canRedo={undoStack.canRedo}
        saveLabel={saveIndicator.label}
      />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <div className="lg:col-span-7 xl:col-span-8">
          <Stage
            config={config}
            activeSection={ui.activeSection}
            takeover={takeover}
          />
          {ui.stageTool && (
            <div className="mt-2 flex items-center justify-between text-xs">
              <span style={{ color: 'var(--text-muted)' }}>
                {ui.stageTool === 'overlay-position' && 'Editing overlay position'}
                {ui.stageTool === 'mask' && 'Painting mask'}
                {ui.stageTool === 'region' && 'Editing thumbnail regions'}
              </span>
              <button
                type="button"
                onClick={() => ui.setStageTool(null)}
                className="px-2 py-0.5 rounded text-xs"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
                title="Return to preview (Esc)"
              >
                ← Back to preview · Esc
              </button>
            </div>
          )}
        </div>
        <div className="lg:col-span-5 xl:col-span-4">
          <Inspector
            doc={doc}
            rowImages={rowImages}
            rowVideoClips={rowVideoClips}
            rowOverlays={rowOverlays}
            rowLockedAsStill={rowLockedAsStill}
            rowLockSignatures={rowLockSignatures}
            activeSection={ui.activeSection}
            accordion={ui.accordion}
            onToggleAccordion={ui.toggleAccordion}
            writers={effectiveWriters}
            brollContext={brollContext}
            animateScenes={animateScenes}
            onOpenStageTool={ui.setStageTool}
          />
        </div>
      </div>

      <SectionStrip
        doc={doc}
        rowImages={rowImages}
        rowVideoClips={rowVideoClips}
        rowOverlays={rowOverlays}
        rowLockedAsStill={rowLockedAsStill}
        activeSection={ui.activeSection}
        onSelectSection={ui.setActiveSection}
      />

      <CheatSheet open={ui.cheatSheetOpen} onClose={() => ui.setCheatSheet(false)} />
    </div>
  );
};

// ─── Top bar ────────────────────────────────────────────────────────────────

interface EditorTopBarProps {
  onShowShortcuts: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  saveLabel: string;
}

const EditorTopBar: React.FC<EditorTopBarProps> = ({
  onShowShortcuts,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  saveLabel,
}) => (
  <div
    className="flex items-center justify-between rounded-xl px-4 py-2 gap-3 flex-wrap"
    style={{
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid var(--border)',
    }}
  >
    <div className="flex items-center gap-3">
      <div
        className="text-xs uppercase tracking-wider font-semibold"
        style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}
      >
        Editor
      </div>
      {saveLabel && (
        <div
          className="text-xs inline-flex items-center gap-1.5"
          style={{ color: 'var(--text-muted)' }}
          title="Every edit autosaves through the same path as the table view."
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: '#34d399',
              boxShadow: '0 0 0 2px rgba(52,211,153,0.18)',
              display: 'inline-block',
            }}
          />
          {saveLabel}
        </div>
      )}
    </div>
    <div className="flex items-center gap-1.5">
      <TopBarButton
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo last field change (Cmd/Ctrl+Z)"
        ariaLabel="Undo"
      >
        ↶ Undo
      </TopBarButton>
      <TopBarButton
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Cmd/Ctrl+Shift+Z or Ctrl+Y)"
        ariaLabel="Redo"
      >
        ↷ Redo
      </TopBarButton>
      <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
      <TopBarButton
        onClick={onShowShortcuts}
        title="Keyboard shortcuts (press ?)"
        ariaLabel="Show keyboard shortcuts"
      >
        <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>?</span>
        <span style={{ marginLeft: 4 }}>Shortcuts</span>
      </TopBarButton>
    </div>
  </div>
);

const TopBarButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
}> = ({ onClick, disabled, title, ariaLabel, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={ariaLabel}
    className="text-xs px-2 py-1 rounded inline-flex items-center"
    style={{
      background: 'rgba(255,255,255,0.04)',
      color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
      border: '1px solid var(--border)',
      opacity: disabled ? 0.45 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
  >
    {children}
  </button>
);
