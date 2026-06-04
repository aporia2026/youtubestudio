'use client';

import React, { useRef, useState } from 'react';
import type { ProductionRow } from '@/remotion/utils';
import type { RowImageStateView } from '@/components/production-doc/editor/types';
import { MotionCollageRowEditor } from '@/components/production-doc/MotionCollageRowEditor';

/**
 * StudioInspectorImage — Image tab body in the Studio inspector.
 * Phase R3 PR4 / PR4b of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * R3 PR4 shipped this read-only — status pill + source pill + 16:9
 * thumbnail + error box. R3 PR4b (this revision) adds the writer
 * callbacks. When provided, the cell renders the matching action
 * buttons:
 *
 *   onGenerate    — Generate (idle) / Re-generate (done)
 *   onUpload      — ⬆ Upload (file picker)
 *   onImportUrl   — 🔗 Import URL (inline input)
 *   onEdit        — ✎ Edit (opens today's EditPanel modal in page.tsx)
 *   onRetry       — Retry (error state only)
 *
 * Per rule 10, every button hides when its callback is undefined.
 * `canGenerate` mirrors the legacy `ImageCell` semantic: when the
 * row has no AI prompt to generate from, the Generate button is
 * disabled (not hidden — visible affordance with a clear reason).
 */
/** The writer bundle used to make the Image tab interactive. Upper
 *  layers (Shell / StudioMode / StudioInspector) pass this through
 *  without unpacking so adding a new action in the future doesn't
 *  ripple through every component signature. */
export interface StudioInspectorImageActions {
  onGenerate?: () => void;
  onUpload?: (file: File) => void;
  onImportUrl?: (url: string) => void;
  onEdit?: () => void;
  onRetry?: () => void;
  /** Default true. When false, the Generate / Re-generate button is
   *  rendered but disabled with an explanation tooltip. */
  canGenerate?: boolean;
  /** Whether this row is currently locked-as-still — meaning even if
   *  a B-roll clip exists it's ignored at render time and the still
   *  + Ken Burns path runs instead. Drives the lock toggle button. */
  lockedAsStill?: boolean;
  /** Toggle the lock-as-still state. Parent persists via the
   *  signature → bool map (`rowLockSignatures`). */
  onToggleLockedAsStill?: (next: boolean) => void;
  /** When provided and the row is a doodle_explainer_2 candidate,
   *  the inspector renders a "↯ Convert to motion collage" button
   *  that converts the row's shot_kind and seeds an empty grid. */
  onConvertToMotionCollage?: () => void;
  /** True when this row's `shot_kind === 'motion_collage'`. Used to
   *  hide the Convert button (already converted) and show the
   *  "Re-fill panels" hint instead. */
  isMotionCollage?: boolean;
  /** Revert a motion_collage row back to a regular Animation row.
   *  Clears motion_collage_* fields + image_url. Wired into the
   *  MotionCollageRowEditor's "Revert" button. */
  onRevertMotionCollageToRegular?: () => void;
  /** Auto-fill the empty panel prompts from the row's narration beat
   *  via the parent's LLM helper. Non-destructive — user-edited
   *  prompts are preserved. */
  onAutoFillMotionCollagePanels?: () => void;
}

export interface StudioInspectorImageProps extends StudioInspectorImageActions {
  state?: RowImageStateView | null;
  /** The row itself — needed for the MotionCollageRowEditor mount
   *  when `row.shot_kind === 'motion_collage'`. */
  row?: ProductionRow | null;
  /** Row-scoped updater (rowIndex is already bound at the call site). */
  onUpdateRow?: (patch: Partial<ProductionRow>) => void;
  /** Spinner flag for the motion-collage panel auto-fill flow. */
  isAutoFillingMotionCollage?: boolean;
  /** Per-row pipeline failure state from the auto-pipeline. When
   *  set + exhausted, renders the error chip + Rethink affordance. */
  pipelineError?: { class: string; message: string; at: string } | null;
  pipelineErrorExhausted?: boolean;
  onPipelineErrorRetry?: () => void;
}

const STATUS_LABEL: Record<RowImageStateView['status'], string> = {
  idle: 'No image yet',
  pending: 'Queued',
  loading: 'Generating…',
  uploading: 'Uploading…',
  editing: 'Editing…',
  done: 'Ready',
  error: 'Failed',
  search: 'Searching',
};

const STATUS_COLOR: Record<RowImageStateView['status'], { bg: string; fg: string }> = {
  idle:      { bg: 'rgba(255,255,255,0.04)', fg: 'var(--text-muted)' },
  pending:   { bg: 'rgba(124,58,237,0.15)',  fg: '#a78bfa' },
  loading:   { bg: 'rgba(124,58,237,0.15)',  fg: '#a78bfa' },
  uploading: { bg: 'rgba(124,58,237,0.15)',  fg: '#a78bfa' },
  editing:   { bg: 'rgba(245,158,11,0.15)',  fg: '#fbbf24' },
  done:      { bg: 'rgba(16,185,129,0.12)',  fg: '#34d399' },
  error:     { bg: 'rgba(239,68,68,0.15)',   fg: '#f87171' },
  search:    { bg: 'rgba(59,130,246,0.12)',  fg: '#60a5fa' },
};

const SOURCE_LABEL: Record<NonNullable<RowImageStateView['source']>, string> = {
  generated: 'AI generated',
  upload:    'Uploaded',
  url:       'Imported from URL',
  edit:      'Edited',
};

const ACTION_BUTTON_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  color: 'var(--text-secondary)',
  border: '1px solid rgba(255,255,255,0.10)',
  cursor: 'pointer',
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  background: 'var(--accent-purple-bright, #a78bfa)',
  color: '#0a0a0a',
  border: 'none',
  cursor: 'pointer',
  fontWeight: 600,
};

export const StudioInspectorImage: React.FC<StudioInspectorImageProps> = ({
  state = null,
  onGenerate,
  onUpload,
  onImportUrl,
  onEdit,
  onRetry,
  canGenerate = true,
  lockedAsStill = false,
  onToggleLockedAsStill,
  onConvertToMotionCollage,
  isMotionCollage = false,
  onRevertMotionCollageToRegular,
  onAutoFillMotionCollagePanels,
  row = null,
  onUpdateRow,
  isAutoFillingMotionCollage = false,
  pipelineError = null,
  pipelineErrorExhausted = false,
  onPipelineErrorRetry,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');

  const triggerFilePicker = () => fileInputRef.current?.click();
  const commitUrl = () => {
    const trimmed = urlDraft.trim();
    if (!trimmed || !onImportUrl) return;
    onImportUrl(trimmed);
    setUrlDraft('');
    setUrlInputOpen(false);
  };

  const status = state?.status ?? null;
  const statusLabel = status ? STATUS_LABEL[status] : null;
  const statusColor = status ? STATUS_COLOR[status] : null;
  const sourceLabel = state?.source ? SOURCE_LABEL[state.source] : null;
  const hasImage = !!state?.imageUrl;
  const isBusy =
    status === 'pending' ||
    status === 'loading' ||
    status === 'uploading' ||
    status === 'editing' ||
    status === 'search';

  // The hidden file input is always mounted (when an upload callback
  // exists) so the button can trigger it without an extra render.
  const fileInput = onUpload ? (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      style={{ display: 'none' }}
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onUpload(file);
        // Reset so picking the same file twice in a row re-fires.
        e.target.value = '';
      }}
    />
  ) : null;

  // No state at all — there's no image and no writers wired (or the
  // row is brand-new). Show the same prompt the empty inspector does.
  if (!state && !onGenerate && !onUpload && !onImportUrl) {
    return (
      <p
        className="text-xs leading-relaxed"
        style={{ color: 'var(--text-muted)' }}
      >
        No image has been generated for this row yet.
      </p>
    );
  }

  const motionCollageGrid = row?.motion_collage_grid ?? undefined;
  const motionCollagePanelPrompts = row?.motion_collage_panel_prompts ?? undefined;

  return (
    <div className="space-y-3">
      {fileInput}

      {pipelineError && pipelineErrorExhausted && (
        <div
          role="alert"
          className="text-[11px] leading-relaxed px-2.5 py-2 rounded space-y-1.5"
          style={{
            background: 'rgba(239,68,68,0.08)',
            color: '#f87171',
            border: '1px solid rgba(239,68,68,0.25)',
          }}
        >
          <div className="font-semibold">Pipeline gave up after retries</div>
          <div style={{ opacity: 0.9 }}>
            <span style={{ fontFamily: 'monospace' }}>{pipelineError.class}</span>
            {pipelineError.message ? ` · ${pipelineError.message}` : ''}
          </div>
          {onPipelineErrorRetry && (
            <button
              type="button"
              onClick={onPipelineErrorRetry}
              className="text-[11px] px-2 py-0.5 rounded"
              style={{
                background: 'rgba(239,68,68,0.15)',
                color: '#fca5a5',
                border: '1px solid rgba(239,68,68,0.35)',
                cursor: 'pointer',
              }}
              title="Reset this row's attempt counter so the pipeline picks it up again on the next tick."
            >
              ↻ Rethink
            </button>
          )}
        </div>
      )}

      {row?.shot_kind === 'motion_collage' && onUpdateRow && (
        <div
          className="px-2 py-2 rounded"
          style={{
            background: 'rgba(124,58,237,0.06)',
            border: '1px solid rgba(124,58,237,0.20)',
          }}
        >
          <div
            className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
            style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}
          >
            Motion-collage panels{isAutoFillingMotionCollage ? ' · auto-filling…' : ''}
          </div>
          <MotionCollageRowEditor
            grid={motionCollageGrid}
            panelPrompts={motionCollagePanelPrompts ?? []}
            onChange={(next) => {
              onUpdateRow({
                motion_collage_grid: next.grid,
                motion_collage_panel_prompts: next.panelPrompts,
                // Any grid/prompt change invalidates the existing
                // rendered panels — clear urls so the next generate
                // triggers a fresh collage run.
                image_url: undefined,
                motion_collage_image_url: undefined,
                motion_collage_panel_urls: undefined,
              });
            }}
            onRevertToRegular={
              onRevertMotionCollageToRegular ??
              (() => {
                onUpdateRow({
                  shot_kind: undefined,
                  motion_collage_grid: undefined,
                  motion_collage_panel_prompts: undefined,
                  motion_collage_image_url: undefined,
                  motion_collage_panel_urls: undefined,
                  image_url: undefined,
                });
              })
            }
            onAutoFill={onAutoFillMotionCollagePanels ?? (() => {})}
            autoFilling={isAutoFillingMotionCollage}
          />
        </div>
      )}

      {statusLabel && statusColor && (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={{ background: statusColor.bg, color: statusColor.fg }}
          >
            {statusLabel}
          </span>
          {sourceLabel && (
            <span
              className="text-[11px] px-2 py-0.5 rounded-full"
              style={{
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--text-muted)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {sourceLabel}
            </span>
          )}
        </div>
      )}

      {hasImage && state?.imageUrl && (
        <div
          className="rounded overflow-hidden"
          style={{
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.06)',
            aspectRatio: '16 / 9',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.imageUrl}
            alt="Generated still for the selected row"
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}

      {status === 'error' && state?.error && (
        <div
          className="text-xs px-2.5 py-2 rounded leading-relaxed"
          style={{
            background: 'rgba(239,68,68,0.08)',
            color: '#f87171',
            border: '1px solid rgba(239,68,68,0.2)',
          }}
        >
          {state.error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {onGenerate && !isBusy && (
          <button
            type="button"
            onClick={onGenerate}
            disabled={!canGenerate}
            className="text-xs px-3 py-1.5 rounded"
            style={{
              ...(hasImage ? ACTION_BUTTON_STYLE : PRIMARY_BUTTON_STYLE),
              cursor: canGenerate ? 'pointer' : 'not-allowed',
              opacity: canGenerate ? 1 : 0.5,
            }}
            title={
              canGenerate
                ? hasImage
                  ? 'Generate a fresh image using the row\'s AI prompt'
                  : 'Generate an image using the row\'s AI prompt'
                : 'This row has no AI prompt — fill it in on the Content tab first'
            }
          >
            {hasImage ? '↻ Re-generate' : 'Generate'}
          </button>
        )}
        {onRetry && status === 'error' && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs px-3 py-1.5 rounded"
            style={PRIMARY_BUTTON_STYLE}
          >
            Retry
          </button>
        )}
        {onUpload && !isBusy && (
          <button
            type="button"
            onClick={triggerFilePicker}
            className="text-xs px-3 py-1.5 rounded"
            style={ACTION_BUTTON_STYLE}
            title="Upload a local image file"
          >
            ⬆ Upload
          </button>
        )}
        {onImportUrl && !isBusy && !urlInputOpen && (
          <button
            type="button"
            onClick={() => setUrlInputOpen(true)}
            className="text-xs px-3 py-1.5 rounded"
            style={ACTION_BUTTON_STYLE}
            title="Mirror an external HTTPS image URL into this row"
          >
            🔗 Import URL
          </button>
        )}
        {onEdit && hasImage && !isBusy && (
          <button
            type="button"
            onClick={onEdit}
            className="text-xs px-3 py-1.5 rounded"
            style={ACTION_BUTTON_STYLE}
            title="Open the smart edit panel (prompt or brush mask)"
          >
            ✎ Edit
          </button>
        )}
        {onConvertToMotionCollage && !isMotionCollage && !isBusy && (
          <button
            type="button"
            onClick={onConvertToMotionCollage}
            className="text-xs px-3 py-1.5 rounded"
            style={{
              background: 'rgba(124,58,237,0.12)',
              color: 'var(--accent-purple-bright, #a78bfa)',
              border: '1px solid rgba(124,58,237,0.35)',
              cursor: 'pointer',
            }}
            title="Convert this row to a motion collage: one image with N keyframes that play hard-cut over the row's duration. Best for real motion (running, falling, transforming)."
          >
            ↯ Convert to motion collage
          </button>
        )}
        {isMotionCollage && (
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(124,58,237,0.12)',
              color: 'var(--accent-purple-bright, #a78bfa)',
              border: '1px solid rgba(124,58,237,0.35)',
            }}
            title="This row renders as a motion collage. Edit panels via the legacy grid; full panel editor moves to a follow-up PR."
          >
            Motion collage
          </span>
        )}
        {onToggleLockedAsStill && (
          <button
            type="button"
            onClick={() => onToggleLockedAsStill(!lockedAsStill)}
            aria-pressed={lockedAsStill}
            className="text-xs px-3 py-1.5 rounded ms-auto"
            style={{
              background: lockedAsStill
                ? 'rgba(124,58,237,0.18)'
                : 'rgba(255,255,255,0.04)',
              color: lockedAsStill
                ? 'var(--accent-purple-bright, #a78bfa)'
                : 'var(--text-secondary)',
              border: lockedAsStill
                ? '1px solid rgba(124,58,237,0.35)'
                : '1px solid rgba(255,255,255,0.10)',
              cursor: 'pointer',
            }}
            title={
              lockedAsStill
                ? 'Row is locked as a still — the renderer ignores any B-roll clip and uses the still + Ken Burns. Click to unlock.'
                : 'Lock this row as a still — render uses the image + Ken Burns even if a B-roll clip exists. Click to lock.'
            }
          >
            {lockedAsStill ? '🔒 Locked as still' : '🔓 Lock as still'}
          </button>
        )}
      </div>

      {urlInputOpen && onImportUrl && (
        <div className="flex items-center gap-2">
          <input
            type="url"
            placeholder="https://…"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitUrl();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setUrlDraft('');
                setUrlInputOpen(false);
              }
            }}
            className="flex-1 text-xs rounded px-2 py-1"
            style={{
              background: 'rgba(0,0,0,0.25)',
              color: 'var(--text-primary)',
              border: '1px solid rgba(255,255,255,0.10)',
            }}
            aria-label="Image URL to import"
          />
          <button
            type="button"
            onClick={commitUrl}
            disabled={!urlDraft.trim()}
            className="text-xs px-2 py-1 rounded"
            style={{
              ...PRIMARY_BUTTON_STYLE,
              opacity: urlDraft.trim() ? 1 : 0.5,
              cursor: urlDraft.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Import
          </button>
          <button
            type="button"
            onClick={() => {
              setUrlDraft('');
              setUrlInputOpen(false);
            }}
            className="text-xs px-2 py-1 rounded"
            style={ACTION_BUTTON_STYLE}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};
