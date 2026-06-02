'use client';

import React from 'react';
import * as Accordion from '@radix-ui/react-accordion';
import type { AccordionKey, AccordionState, StageTool } from './hooks/useEditorUiState';
import type { EditorViewProps, EditorWriters, EditorBrollContext } from './types';
import type { ProductionRow } from '@/remotion/utils';
import { ImageCell } from '@/app/(app)/production-doc/page';
// PR2 reliability (2026-06-03): same pipeline-failure chip as the
// grid view, so a row that the auto-pipeline gave up on surfaces a
// Retry affordance in the Inspector too. Pure helpers; safe client-side.
import { isExhausted } from '@/lib/auto-pipeline/image-gen-errors';
import { BrollCell } from '@/components/production-doc/BrollCell';
import { OverlayCell } from '@/components/production-doc/OverlayCell';
import { SectionRowControls } from '@/components/production-doc/SectionRowControls';
import { brollRowSignatureInput } from '@/lib/broll-types';
import { InlinePromptEditor } from './InlinePromptEditor';
import { VariantPanel } from './VariantPanel';
import { isVariantRow, getVariantGroup } from '@/remotion/utils';

interface InspectorProps {
  doc: EditorViewProps['doc'];
  rowImages: EditorViewProps['rowImages'];
  rowVideoClips: EditorViewProps['rowVideoClips'];
  rowOverlays: EditorViewProps['rowOverlays'];
  rowLockedAsStill: EditorViewProps['rowLockedAsStill'];
  rowLockSignatures: EditorViewProps['rowLockSignatures'];
  activeSection: number;
  accordion: AccordionState;
  onToggleAccordion: (key: AccordionKey) => void;
  writers?: EditorWriters;
  brollContext?: EditorBrollContext;
  animateScenes: boolean;
  /** Set a non-null value to take over the Stage area with the named
   *  tool. Currently only `'overlay-position'` is wired inline; mask
   *  and region editors still open as fullscreen modals. */
  onOpenStageTool?: (tool: StageTool) => void;
  /** Phase 3 (2026-05-25) — switch the editor's active section. Used
   *  by the Variants accordion's "jump to base" link and mini-strip
   *  thumbnails so the user can pivot context within the same
   *  Inspector without scrolling the SectionStrip. */
  onJumpToSection?: (rowIndex: number) => void;
}

/**
 * The editor's right-pane "Inspector". Three accordion sections for the
 * active section's media controls:
 *
 *   1. B-roll & Image  — ImageCell (still) + BrollCell (animation)
 *   2. Overlay         — OverlayCell + position-editor link
 *   3. Section settings — SectionRowControls (title, layout, color, zoom,
 *                         transition, fade — every per-row "look & motion"
 *                         setting in one place, mirroring the existing
 *                         component boundary)
 *
 * When `writers` is undefined the inspector renders the Phase 1 read-only
 * shape: data shown, no edit controls. When writers are passed the
 * inspector mounts the real per-row components with handlers wired in.
 * Every modal entry point (mask brush, region editor, transition dialog,
 * overlay position editor, edit panel) stays reachable — the editor is
 * a superset of the table view's affordances, never a subset.
 */
export const Inspector: React.FC<InspectorProps> = (props) => {
  const {
    doc,
    rowImages,
    rowVideoClips,
    rowOverlays,
    rowLockedAsStill,
    activeSection,
    accordion,
    onToggleAccordion,
    writers,
    brollContext,
    animateScenes,
    onOpenStageTool,
    onJumpToSection,
  } = props;
  const row: ProductionRow | undefined = doc.rows?.[activeSection];
  const totalSections = doc.rows?.length ?? 0;

  if (!row) {
    return (
      <div
        className="rounded-xl p-8 text-center text-sm"
        style={{
          background: 'rgba(255,255,255,0.03)',
          color: 'var(--text-muted)',
          border: '1px solid var(--border)',
        }}
      >
        No section selected.
      </div>
    );
  }

  const accordionValues = (Object.keys(accordion) as AccordionKey[]).filter((k) => accordion[k]);

  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="min-w-0">
          <div
            className="text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}
          >
            Section {activeSection + 1} of {totalSections}
          </div>
          <div
            className="text-sm font-semibold mt-0.5 truncate"
            style={{ color: 'var(--text-primary)' }}
            title={row.section_title || row.visual_description || 'Untitled'}
          >
            {row.section_title?.trim() ||
              row.visual_description?.trim().slice(0, 60) ||
              'Untitled section'}
          </div>
        </div>
        <div
          className="text-[10px] font-mono px-2 py-1 rounded shrink-0 ml-2"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
          title="Use ← → to move between sections, 1-3 to open inspector sections"
        >
          ← → · 1-3
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ maxHeight: '70vh' }}>
        <Accordion.Root
          type="multiple"
          value={accordionValues}
          onValueChange={(open) => {
            const next = new Set(open);
            (Object.keys(accordion) as AccordionKey[]).forEach((key) => {
              if (next.has(key) !== accordion[key]) onToggleAccordion(key);
            });
          }}
        >
          <BrollAccordionItem
            row={row}
            rowIndex={activeSection}
            image={rowImages[activeSection]}
            clip={rowVideoClips[activeSection]}
            locked={Boolean(rowLockedAsStill[activeSection])}
            writers={writers}
            brollContext={brollContext}
            animateScenes={animateScenes}
          />
          <OverlayAccordionItem
            row={row}
            rowIndex={activeSection}
            overlay={rowOverlays[activeSection]}
            writers={writers}
            onOpenStageTool={onOpenStageTool}
          />
          <SectionSettingsAccordionItem
            row={row}
            rowIndex={activeSection}
            doc={doc}
            writers={writers}
          />
          <VariantsAccordionItem
            doc={doc}
            row={row}
            activeSection={activeSection}
            rowImages={rowImages}
            writers={writers}
            onJumpToSection={onJumpToSection}
          />
        </Accordion.Root>
      </div>
    </div>
  );
};

// ─── Accordion shell ────────────────────────────────────────────────────────

interface ItemShellProps {
  value: AccordionKey;
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  summary?: string;
  children: React.ReactNode;
}

const ItemShell: React.FC<ItemShellProps> = ({ value, icon, label, shortcut, summary, children }) => (
  <Accordion.Item value={value} className="border-b last:border-b-0" style={{ borderColor: 'var(--border)' }}>
    <Accordion.Header asChild>
      <Accordion.Trigger
        className="group w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.025]"
        style={{ color: 'var(--text-primary)' }}
      >
        <span className="text-base leading-none" aria-hidden>{icon}</span>
        <span className="text-sm font-semibold flex-1">{label}</span>
        {summary && (
          <span
            className="text-xs truncate max-w-[14ch]"
            style={{ color: 'var(--text-muted)' }}
            title={summary}
          >
            {summary}
          </span>
        )}
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
          aria-hidden
        >
          {shortcut}
        </span>
        <Caret />
      </Accordion.Trigger>
    </Accordion.Header>
    <Accordion.Content
      className="overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up"
    >
      <div className="px-4 pb-4 pt-1">{children}</div>
    </Accordion.Content>
  </Accordion.Item>
);

const Caret: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    style={{ color: 'var(--text-muted)' }}
    className="transition-transform group-data-[state=open]:rotate-180"
    aria-hidden
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

// ─── Section 1: B-roll & Image ──────────────────────────────────────────────

interface BrollAccordionProps {
  row: ProductionRow;
  rowIndex: number;
  image: EditorViewProps['rowImages'][number] | undefined;
  clip: EditorViewProps['rowVideoClips'][number] | null | undefined;
  locked: boolean;
  writers: EditorWriters | undefined;
  brollContext: EditorBrollContext | undefined;
  animateScenes: boolean;
}

const BrollAccordionItem: React.FC<BrollAccordionProps> = ({
  row,
  rowIndex,
  image,
  clip,
  locked,
  writers,
  brollContext,
  animateScenes,
}) => {
  const summary = clip?.videoUrl
    ? 'Clip ready'
    : locked
    ? 'Locked as still'
    : image?.imageUrl
    ? 'Image only'
    : '—';

  const editable = Boolean(writers && brollContext);

  return (
    <ItemShell value="broll" icon="🎬" label="B-roll & Image" shortcut="1" summary={summary}>
      <div className="space-y-4">
        {/* Image actions — ImageCell handles generate / upload / URL / edit
            via the same callbacks the table view uses. */}
        <FieldGroup label="Image">
          {editable && writers ? (
            <ImageCell
              state={image ?? { status: 'idle' }}
              canGenerate={Boolean(row.ai_image_prompt?.trim())}
              onRetry={() => {
                if (row.ai_image_prompt?.trim()) {
                  writers.generateImageForRow(rowIndex, row.ai_image_prompt, {
                    onScreenText: row.on_screen_text,
                    sectionTitle: row.section_title,
                    overlayStockTerms: row.overlay_stock_terms,
                  });
                }
              }}
              onUpload={(file: File) => writers.uploadImageForRow(rowIndex, file)}
              onUrlImport={(url: string) => writers.importImageUrlForRow(rowIndex, url)}
              onEdit={() => writers.openEditPanelForRow(rowIndex)}
              pipelineError={row.last_error ?? null}
              pipelineErrorExhausted={Boolean(
                row.last_error && isExhausted(row.attempts, row.last_error.class),
              )}
              onPipelineErrorRetry={() => writers.updateRow(rowIndex, { attempts: 0, last_error: null })}
            />
          ) : (
            image?.imageUrl && image.status === 'done' ? (
              <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.imageUrl} alt="" className="w-full" style={{ display: 'block', aspectRatio: '16/9', objectFit: 'cover' }} />
              </div>
            ) : (
              <ReadOnlyEmpty label="No image yet" />
            )
          )}
        </FieldGroup>

        {/* AI prompt — inline editor when writers are available, plain
            read-only otherwise. The "Save & regenerate" path commits
            the prompt and immediately kicks off image regen with it. */}
        <FieldGroup label="AI prompt">
          {editable && writers ? (
            <InlinePromptEditor
              value={row.ai_image_prompt ?? ''}
              onSave={(next) => writers.updateRow(rowIndex, { ai_image_prompt: next })}
              onSaveAndRegenerate={(next) => {
                writers.updateRow(rowIndex, { ai_image_prompt: next });
                writers.generateImageForRow(rowIndex, next, {
                  onScreenText: row.on_screen_text,
                  sectionTitle: row.section_title,
                  overlayStockTerms: row.overlay_stock_terms,
                });
              }}
            />
          ) : row.ai_image_prompt ? (
            <ReadOnlyMultiline value={row.ai_image_prompt} />
          ) : (
            <ReadOnlyEmpty label="No prompt set for this section" />
          )}
        </FieldGroup>

        {/* B-roll animation — BrollCell when animations are on, else a
            hint that animation is disabled at the doc level. */}
        <FieldGroup label="Animation">
          {!animateScenes && (
            <ReadOnlyEmpty label="Animation is disabled for this doc — turn on “Animate scenes” to enable B-roll." />
          )}
          {animateScenes && editable && writers && brollContext && (() => {
            const sig = brollRowSignatureInput({
              timecode: row.timecode,
              visual_description: row.visual_description,
            });
            return (
              <BrollCell
                rowIndex={rowIndex}
                rowSignature={sig}
                productionDocId={brollContext.productionDocId}
                sceneDurationMs={writers.computeRowSceneDurationMs(rowIndex)}
                visualDescription={row.visual_description}
                aiImagePrompt={row.ai_image_prompt}
                styleHint={brollContext.stylePreset}
                stillImageUrl={image?.status === 'done' ? image.imageUrl : undefined}
                initialClip={brollContext.rowBatchStubs[rowIndex] ?? undefined}
                lockedAsStill={locked}
                onToggleLockedAsStill={(next) => writers.toggleRowLock(sig, next)}
                onClipChange={(c) =>
                  writers.handleBrollClipChange(
                    rowIndex,
                    c ? { status: c.status, video_url: c.video_url, duration_seconds: c.duration_seconds } : null,
                  )
                }
              />
            );
          })()}
          {animateScenes && !editable && (
            <ReadOnlyRow label="Status" value={clip?.videoUrl ? 'Clip ready' : clip?.status ?? '—'} />
          )}
        </FieldGroup>
      </div>
    </ItemShell>
  );
};

// ─── Section 2: Overlay ─────────────────────────────────────────────────────

interface OverlayAccordionProps {
  row: ProductionRow;
  rowIndex: number;
  overlay: EditorViewProps['rowOverlays'][number] | undefined;
  writers: EditorWriters | undefined;
  onOpenStageTool?: (tool: StageTool) => void;
}

const OverlayAccordionItem: React.FC<OverlayAccordionProps> = ({
  row,
  rowIndex,
  overlay,
  writers,
  onOpenStageTool,
}) => {
  const hasOverlay = Boolean(row.overlay_stock_terms?.trim());
  const overlayReady = overlay?.status === 'done' && Boolean(overlay.url);
  const summary = !hasOverlay
    ? 'Not configured'
    : overlay?.status === 'done'
    ? 'Ready'
    : overlay?.status === 'loading'
    ? 'Loading…'
    : overlay?.status === 'error'
    ? 'Error'
    : 'Idle';

  return (
    <ItemShell value="overlay" icon="🖼" label="Overlay" shortcut="2" summary={summary}>
      {!hasOverlay ? (
        <ReadOnlyEmpty label="No overlay configured for this section. Add overlay stock terms in the script generator to enable a real-image overlay." />
      ) : (
        <div className="space-y-3">
          {writers ? (
            <>
              <OverlayCell
                terms={row.overlay_stock_terms ?? ''}
                zone={row.overlay_zone}
                size={row.overlay_size}
                state={overlay ?? { status: 'idle' }}
                onRetry={() => writers.fetchOverlayForRow(rowIndex, (row.overlay_stock_terms ?? '').trim())}
                onOpenPositionEditor={() => {
                  // Default behaviour in the editor view: take over the
                  // stage instead of opening the fullscreen modal. The
                  // modal is still reachable via the secondary link below.
                  if (overlayReady && onOpenStageTool) {
                    onOpenStageTool('overlay-position');
                  } else {
                    writers.openOverlayPositionEditorForRow(rowIndex);
                  }
                }}
                hasManualPosition={Boolean(row.overlay_position)}
              />
              {overlayReady && (
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => writers.openOverlayPositionEditorForRow(rowIndex)}
                    className="text-[11px] underline"
                    style={{ color: 'var(--text-muted)' }}
                    title="Opens the position editor as a fullscreen dialog instead of taking over the stage."
                  >
                    Open in full window…
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {overlay?.url && (
                <div className="rounded-lg overflow-hidden border p-3 flex items-center justify-center" style={{ borderColor: 'var(--border)', background: 'rgba(0,0,0,0.3)' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={overlay.url} alt="" style={{ maxHeight: 140, maxWidth: '100%', objectFit: 'contain' }} />
                </div>
              )}
              <ReadOnlyRow label="Terms" value={row.overlay_stock_terms ?? '—'} />
              <ReadOnlyRow label="Zone" value={row.overlay_zone ?? 'auto'} />
              <ReadOnlyRow label="Size" value={row.overlay_size ?? 'auto'} />
            </>
          )}
        </div>
      )}
    </ItemShell>
  );
};

// ─── Section 3: Section settings ────────────────────────────────────────────

interface SectionSettingsAccordionProps {
  row: ProductionRow;
  rowIndex: number;
  doc: EditorViewProps['doc'];
  writers: EditorWriters | undefined;
}

const SectionSettingsAccordionItem: React.FC<SectionSettingsAccordionProps> = ({ row, rowIndex, doc, writers }) => {
  const summary = row.section_title?.trim()
    ? row.section_title.trim().slice(0, 18)
    : (row.thumbnail_transition?.kind ?? doc.thumbnail?.defaultTransition?.kind ?? 'default');

  return (
    <ItemShell value="sectionSettings" icon="⚙" label="Section settings" shortcut="3" summary={summary}>
      {writers ? (
        <div
          className="rounded-lg"
          style={{
            background: 'rgba(0,0,0,0.15)',
            border: '1px solid var(--border)',
            padding: 12,
          }}
        >
          <SectionRowControls
            rowIndex={rowIndex}
            totalRows={doc.rows.length}
            thumbnail={doc.thumbnail}
            zoomTo={row.thumbnail_zoom_to}
            sectionTitle={row.section_title}
            sectionTitleLayout={row.section_title_layout}
            sectionTitleLayoutDefault={doc.section_title_layout_default}
            pillarboxColor={row.pillarbox_color}
            pillarboxColorDefault={doc.pillarbox_color_default}
            sceneZoom={row.scene_zoom}
            sceneZoomDefault={doc.scene_zoom_default}
            regionZoomPaddingPct={row.region_zoom_padding_pct}
            regionZoomPaddingDefaultPct={doc.region_zoom_padding_default_pct}
            transition={row.thumbnail_transition}
            defaultTransition={doc.thumbnail?.defaultTransition}
            sceneFade={row.scene_fade}
            sceneFadeDefault={doc.scene_fade_enabled}
            onChangeZoomTo={(id) => writers.updateRow(rowIndex, { thumbnail_zoom_to: id })}
            onChangeSectionTitle={(t) => writers.updateRow(rowIndex, { section_title: t })}
            onChangeSectionTitleLayout={(l) => writers.updateRow(rowIndex, { section_title_layout: l })}
            onChangePillarboxColor={(c) => writers.updateRow(rowIndex, { pillarbox_color: c })}
            onChangeTransition={(t) => writers.updateRow(rowIndex, { thumbnail_transition: t })}
            onChangeSceneFade={(next) => writers.updateRow(rowIndex, { scene_fade: next })}
            onApplyTitleToRange={writers.applyTitleToRange}
            onApplyPillarboxColorToAll={writers.applyPillarboxColorToAll}
            onClearPillarboxOverrides={writers.clearPillarboxOverrides}
            onApplyStripeLayoutToAll={writers.applyStripeLayoutToAll}
            onClearStripeLayoutOverrides={writers.clearStripeLayoutOverrides}
            onChangeSceneZoom={(z) => writers.updateRow(rowIndex, { scene_zoom: z })}
            onApplySceneZoomToAll={writers.applySceneZoomToAll}
            onClearSceneZoomOverrides={writers.clearSceneZoomOverrides}
            onChangeRegionZoomPadding={(p) => writers.updateRow(rowIndex, { region_zoom_padding_pct: p })}
            onApplyRegionZoomPaddingToAll={writers.applyRegionZoomPaddingToAll}
            visualType={row.visual_type}
            titleCardSourceText={(row.on_screen_text || row.script_text || '').trim()}
            onApplyTitleCardAsSectionTitle={() => writers.applyTitleCardAsSectionTitle(rowIndex)}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <ReadOnlyRow label="Title" value={row.section_title?.trim() || '—'} />
          <ReadOnlyRow
            label="Layout"
            value={row.section_title_layout ?? doc.section_title_layout_default ?? 'letterbox'}
          />
          <ReadOnlyRow label="Zoom to" value={row.thumbnail_zoom_to || '—'} />
          <ReadOnlyRow
            label="Transition"
            value={row.thumbnail_transition?.kind ?? doc.thumbnail?.defaultTransition?.kind ?? '—'}
          />
          <ReadOnlyRow
            label="Scene fade"
            value={(row.scene_fade ?? doc.scene_fade_enabled ?? true) ? 'On' : 'Hard cut'}
          />
          <ReadOnlyRow label="Scene zoom" value={`${row.scene_zoom ?? doc.scene_zoom_default ?? 100}%`} />
        </div>
      )}
    </ItemShell>
  );
};

// ─── Variants accordion (Phase 3 of Doodle Explainer 2) ─────────────
//
// Surfaces the variant-group management UI the main grid view ships:
// promote a standalone row, add variants to a base, edit + generate +
// move + delete variant rows, see the stale-on-base-change banner.
// Single source of truth for mutations is the EditorWriters bundle —
// this accordion is presentation only, delegating to <VariantPanel>.
// See `_plans/2026-05-25-editor-view-variant-inspector.md`.

interface VariantsAccordionItemProps {
  doc: InspectorProps['doc'];
  row: ProductionRow;
  activeSection: number;
  rowImages: InspectorProps['rowImages'];
  writers?: EditorWriters;
  onJumpToSection?: (rowIndex: number) => void;
}

const VariantsAccordionItem: React.FC<VariantsAccordionItemProps> = ({
  doc,
  row,
  activeSection,
  rowImages,
  writers,
  onJumpToSection,
}) => {
  // Build a short summary line so the collapsed accordion header
  // surfaces the row's group status without forcing the user to open
  // it — same UX as the other sections (which preview the title /
  // transition kind / etc.).
  let summary: string | undefined;
  if (isVariantRow(row) && row.group_id) {
    const group = getVariantGroup(doc, row.group_id);
    const variantIdx = row.variant_index ?? 0;
    summary = variantIdx === 0
      ? `base · ${group.length - 1}v`
      : `v${variantIdx}/${group.length - 1}`;
  } else {
    summary = 'standalone';
  }

  return (
    <ItemShell value="variants" icon="🎬" label="Variants" shortcut="4" summary={summary}>
      <VariantPanel
        doc={doc}
        activeSection={activeSection}
        rowImages={rowImages}
        writers={writers}
        onJumpToSection={onJumpToSection}
      />
    </ItemShell>
  );
};

// ─── Read-only field primitives ─────────────────────────────────────────────

const FieldGroup: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="space-y-1.5">
    <div
      className="text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: 'var(--text-muted)', letterSpacing: '0.06em' }}
    >
      {label}
    </div>
    {children}
  </div>
);

const ReadOnlyRow: React.FC<{ label: string; value: string; swatch?: string }> = ({ label, value, swatch }) => (
  <div className="flex items-start gap-3 text-xs">
    <div className="w-28 shrink-0 pt-0.5" style={{ color: 'var(--text-muted)' }}>{label}</div>
    <div className="flex-1 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
      {swatch && (
        <span
          className="inline-block rounded"
          style={{ width: 12, height: 12, background: swatch, border: '1px solid var(--border)' }}
        />
      )}
      <span className="truncate" title={value}>{value || '—'}</span>
    </div>
  </div>
);

const ReadOnlyMultiline: React.FC<{ value: string }> = ({ value }) => (
  <div
    className="text-xs rounded px-2 py-2 whitespace-pre-wrap"
    style={{
      background: 'rgba(0,0,0,0.3)',
      color: 'var(--text-secondary)',
      border: '1px solid var(--border)',
    }}
  >
    {value}
  </div>
);

const ReadOnlyEmpty: React.FC<{ label: string }> = ({ label }) => (
  <div
    className="text-xs italic px-3 py-4 rounded text-center"
    style={{
      color: 'var(--text-muted)',
      background: 'rgba(0,0,0,0.2)',
      border: '1px dashed var(--border)',
    }}
  >
    {label}
  </div>
);
