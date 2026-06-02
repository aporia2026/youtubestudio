'use client';

/**
 * Editor inspector branch for `shot_kind === 'motion_collage'` rows.
 *
 * Mounted by `ShotInspector` in place of the regular static-shot UI
 * (image replace, Kling animation, etc.) — those controls don't apply
 * to a motion collage. Surfaces every motion-collage editing
 * affordance the user needs without bouncing back to production-doc:
 *
 *   - Grid + panel-prompts editor (lifted from `MotionCollageRowEditor`)
 *   - "Auto-fill panels" — LLM fills blank panels from the row's
 *     narration beat (one cheap LLM call, no image gen)
 *   - "Generate all panels" — full motion-collage regen via
 *     `/api/generate/production-doc/motion-collage`
 *   - Per-panel "↻" regen — partial regen via the same endpoint with
 *     `panelIndices` populated; only the clicked panel is billed
 *   - "View collage" — opens `MotionCollageLightbox` (full-screen
 *     panel grid + per-panel zoom)
 *   - "Revert to regular row" — clears every motion_collage_* field
 *     and flips `shot_kind` back to undefined
 *
 * Wiring contract: every mutation flows through the parent's
 * `onUpdateRow` (which dispatches `PATCH_ROW` under the hood, so
 * undo / redo / auto-save all work for free). The two generation
 * endpoints are called directly from this component because the
 * lifecycle is local (loading state lives here, not in the editor
 * store) and matches production-doc's `generateMotionCollageForRow` +
 * `autoFillMotionCollagePanels` patterns.
 *
 * PR 3 of `_plans/2026-06-02-editor-motion-collage-support.md`.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { queueImageGen, reportUpstream429 } from '@/lib/image-gen-throttle';
import { MotionCollageRowEditor } from '@/components/production-doc/MotionCollageRowEditor';
import { MotionCollageLightbox } from '@/components/editor/MotionCollageLightbox';
import { MotionCollageThumb } from '@/components/editor/MotionCollageThumb';
import type { ProductionDoc } from '@/remotion/utils';

interface InspectorMotionCollagePanelProps {
  /** Row being edited. Required to read every motion_collage_* field. */
  row: ProductionDoc['rows'][number];
  /** Row index — surfaced in logs and toasts. */
  shotIndex: number;
  /** Active doc — read for the doc-level motion-collage settings and
   *  the character-bible the auto-fill / generate endpoints need to
   *  receive. */
  doc: ProductionDoc;
  /** Patch the row. Used for every mutation: grid changes, panel-prompt
   *  edits, post-generate URL writes, revert. */
  onUpdateRow: (patch: Partial<ProductionDoc['rows'][number]>) => void;
}

/** Local UI state for a single in-flight generation. */
type GenStatus =
  | { kind: 'idle' }
  | { kind: 'all' }
  | { kind: 'one'; panelIndex: number }
  | { kind: 'autofill' };

export function InspectorMotionCollagePanel({
  row,
  shotIndex,
  doc,
  onUpdateRow,
}: InspectorMotionCollagePanelProps): React.ReactElement {
  const [genStatus, setGenStatus] = useState<GenStatus>({ kind: 'idle' });
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [autoFillError, setAutoFillError] = useState<string | null>(null);
  // 2026-06-02: per-panel edit busy state, surfaced into the lightbox
  // so its action buttons show the working state on the right panel.
  const [perPanelBusyIdx, setPerPanelBusyIdx] = useState<number | null>(null);

  const grid = row.motion_collage_grid ?? { cols: 2, rows: 2 };
  const N = grid.cols * grid.rows;
  const panelPrompts: readonly string[] = Array.from(
    { length: N },
    (_, i) => row.motion_collage_panel_prompts?.[i] ?? '',
  );
  const panelUrls: readonly string[] = Array.from(
    { length: N },
    (_, i) => row.motion_collage_panel_urls?.[i] ?? '',
  );
  const anyPanelMissing = panelUrls.some((u) => !u);

  /** Grid- or panel-prompt change. Mirrors production-doc:
   *  any change clears existing panel URLs because they're stale. */
  function handleEditorChange(next: {
    grid: { cols: number; rows: number };
    panelPrompts: string[];
    reason: 'grid' | 'prompt';
  }): void {
    console.info('[editor motion-collage] row patched', {
      shotIndex,
      reason: next.reason,
      newGrid: `${next.grid.cols}x${next.grid.rows}`,
      panelCount: next.panelPrompts.length,
      clearedFields: ['image_url', 'motion_collage_panel_urls', 'motion_collage_image_url'],
    });
    onUpdateRow({
      motion_collage_grid: next.grid,
      motion_collage_panel_prompts: next.panelPrompts,
      image_url: undefined,
      motion_collage_image_url: undefined,
      motion_collage_panel_urls: undefined,
    });
  }

  function handleRevert(): void {
    console.info('[editor motion-collage] revert', {
      shotIndex,
      hadPanelUrls: (row.motion_collage_panel_urls?.length ?? 0) > 0,
    });
    onUpdateRow({
      shot_kind: undefined,
      motion_collage_grid: undefined,
      motion_collage_panel_prompts: undefined,
      motion_collage_image_url: undefined,
      motion_collage_panel_urls: undefined,
      image_url: undefined,
    });
  }

  async function handleAutoFill(): Promise<void> {
    setAutoFillError(null);
    const hasContent = [row.script_text, row.visual_description, row.ai_image_prompt]
      .some((s) => typeof s === 'string' && s.trim().length > 0);
    if (!hasContent) {
      toast.error('Add some narration or a visual description first.');
      return;
    }
    const blanks = panelPrompts.filter((p) => !p.trim()).length;
    if (blanks === 0) {
      toast('All panels are filled — clear one and re-run to regenerate it.');
      return;
    }
    setGenStatus({ kind: 'autofill' });
    console.info('[editor motion-collage autofill] start', {
      shotIndex,
      grid: `${grid.cols}x${grid.rows}`,
      blanks,
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- LLM RPC; awaits + reads response
      const res = await fetch('/api/generate/production-doc/motion-collage/panels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid,
          scriptText: row.script_text ?? '',
          visualDescription: row.visual_description,
          baseImagePrompt: row.ai_image_prompt,
          existingPanels: panelPrompts,
          stylePreset: doc.style_preset,
          characterDescriptions: doc.doodle_explainer_2_character_descriptions,
        }),
      });
      const data = (await res.json()) as { panelPrompts?: string[]; error?: string };
      if (!res.ok || !Array.isArray(data.panelPrompts)) {
        const msg = data.error ?? `Auto-fill failed (HTTP ${res.status})`;
        setAutoFillError(msg);
        toast.error(msg);
        console.warn('[editor motion-collage autofill] failed', { shotIndex, error: msg });
        return;
      }
      // Merge: keep existing non-empty panels, fill blanks from response.
      const merged = Array.from({ length: N }, (_, i) => {
        const cur = panelPrompts[i].trim();
        return cur || (data.panelPrompts![i] ?? '').trim();
      });
      onUpdateRow({
        motion_collage_panel_prompts: merged,
        image_url: undefined,
        motion_collage_image_url: undefined,
        motion_collage_panel_urls: undefined,
      });
      const filled = merged.filter((p) => p.trim()).length;
      console.info('[editor motion-collage autofill] success', {
        shotIndex,
        filled,
        total: N,
      });
      toast.success(`Filled ${filled} panel${filled === 1 ? '' : 's'} — edit before generating.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Auto-fill failed';
      setAutoFillError(msg);
      toast.error(msg);
    } finally {
      setGenStatus({ kind: 'idle' });
    }
  }

  async function callGenerateEndpoint(panelIndices?: number[]): Promise<void> {
    // Pre-flight: every prompt must be non-empty. The server validates
    // this too, but failing here gives a friendlier error.
    if (panelPrompts.some((p) => !p.trim())) {
      toast.error('Every panel needs a prompt — use ✨ Auto-fill or write them manually.');
      return;
    }
    if (panelIndices && panelIndices.length > 0 && anyPanelMissing) {
      toast.error('Partial regen needs every other panel rendered first — run Generate all once.');
      return;
    }
    const isPartial = !!panelIndices && panelIndices.length > 0;
    setGenStatus(isPartial ? { kind: 'one', panelIndex: panelIndices![0] } : { kind: 'all' });
    console.info('[editor motion-collage gen kickoff]', {
      shotIndex,
      mode: isPartial ? 'one' : 'all',
      panelIndices: panelIndices ?? null,
      grid: `${grid.cols}x${grid.rows}`,
    });
    try {
      const res = await queueImageGen('generate', 'motion-collage', () =>
        // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC; awaits + reads response
        fetch('/api/generate/production-doc/motion-collage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grid,
            panelPrompts,
            stylePreset: doc.style_preset,
            motionCollageSettings: doc.doodle_explainer_2_motion_collage_settings,
            characterDescriptions: doc.doodle_explainer_2_character_descriptions,
            ...(isPartial && {
              panelIndices,
              existingPanelUrls: panelUrls,
            }),
          }),
        }),
      );
      if (res.status === 429) reportUpstream429('generate', 'motion-collage');
      const data = (await res.json()) as {
        imageUrl?: string;
        panelUrls?: string[];
        collageImageUrl?: string;
        error?: string;
        costUsd?: number;
      };
      if (!res.ok || !data.imageUrl || !data.panelUrls?.length) {
        const msg = data.error ?? `Generate failed (HTTP ${res.status})`;
        toast.error(msg);
        console.warn('[editor motion-collage gen result]', {
          shotIndex,
          success: false,
          errorMessage: msg,
        });
        return;
      }
      onUpdateRow({
        image_url: data.imageUrl,
        motion_collage_image_url: data.collageImageUrl,
        motion_collage_panel_urls: data.panelUrls,
      });
      console.info('[editor motion-collage gen result]', {
        shotIndex,
        success: true,
        panelUrlCount: data.panelUrls.length,
        costUsd: data.costUsd,
        mode: isPartial ? 'one' : 'all',
      });
      toast.success(
        isPartial
          ? `Panel ${panelIndices![0] + 1} regenerated · $${data.costUsd?.toFixed(3) ?? '?'}`
          : `Collage rendered · ${data.panelUrls.length} panels · $${data.costUsd?.toFixed(3) ?? '?'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Generate failed';
      toast.error(msg);
      console.warn('[editor motion-collage gen result]', {
        shotIndex,
        success: false,
        errorMessage: msg,
      });
    } finally {
      setGenStatus({ kind: 'idle' });
    }
  }

  /** Helper: merge a new URL into the panel-URLs array at one index
   *  and dispatch the PATCH_ROW update. Used by both upload + edit
   *  flows so the array-merge logic lives in one place. */
  function patchPanelUrl(panelIndex: number, newUrl: string): void {
    const next = panelUrls.map((u, i) => (i === panelIndex ? newUrl : u));
    onUpdateRow({
      motion_collage_panel_urls: next as string[],
      image_url: panelIndex === 0 ? newUrl : row.image_url,
    });
    console.info('[editor motion-collage panel patched]', {
      shotIndex,
      panelIndex,
      newUrl,
    });
  }

  /** Upload a custom image for a single panel. Presigned PUT to R2
   *  same as the regular per-shot upload flow in ShotInspector. */
  async function handlePanelUpload(panelIndex: number, file: File): Promise<void> {
    setPerPanelBusyIdx(panelIndex);
    console.info('[editor motion-collage panel upload] start', {
      shotIndex,
      panelIndex,
      fileName: file.name,
      fileSize: file.size,
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- POST RPC; awaits + reads response
      const presignRes = await fetch('/api/uploads/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
        }),
      });
      if (!presignRes.ok) {
        const data = (await presignRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Presign failed: HTTP ${presignRes.status}`);
      }
      const { uploadUrl, downloadUrl } = (await presignRes.json()) as {
        uploadUrl: string;
        downloadUrl: string;
      };
      // eslint-disable-next-line no-restricted-syntax -- PUT RPC; awaits + reads response
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`Upload PUT failed: HTTP ${putRes.status}`);
      }
      patchPanelUrl(panelIndex, downloadUrl);
      toast.success(`Panel ${panelIndex + 1} replaced with uploaded image.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      toast.error(msg);
      console.warn('[editor motion-collage panel upload] failed', {
        shotIndex,
        panelIndex,
        error: msg,
      });
    } finally {
      setPerPanelBusyIdx(null);
    }
  }

  /** Edit a single panel via the /api/generate/production-doc/image/edit
   *  endpoint. Same backend used by the per-shot AI Replace / brush
   *  edit, but no mask — prompt-only rewrite scoped to ONE panel. */
  async function handlePanelEditWithPrompt(
    panelIndex: number,
    prompt: string,
  ): Promise<void> {
    if (!prompt.trim()) return;
    const sourceUrl = panelUrls[panelIndex];
    if (!sourceUrl) {
      toast.error('Generate the panel first before editing.');
      return;
    }
    setPerPanelBusyIdx(panelIndex);
    console.info('[editor motion-collage panel edit] start', {
      shotIndex,
      panelIndex,
      promptHead: prompt.slice(0, 60),
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC; awaits + reads response
      const res = await fetch('/api/generate/production-doc/image/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalImageUrl: sourceUrl,
          prompt,
          stylePreset: doc.style_preset,
        }),
      });
      const data = (await res.json()) as { newImageUrl?: string; error?: string };
      if (!res.ok || !data.newImageUrl) {
        const msg = data.error ?? `Edit failed (HTTP ${res.status})`;
        toast.error(msg);
        console.warn('[editor motion-collage panel edit] failed', {
          shotIndex,
          panelIndex,
          error: msg,
        });
        return;
      }
      patchPanelUrl(panelIndex, data.newImageUrl);
      toast.success(`Panel ${panelIndex + 1} edited.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Edit failed';
      toast.error(msg);
      console.warn('[editor motion-collage panel edit] threw', {
        shotIndex,
        panelIndex,
        error: msg,
      });
    } finally {
      setPerPanelBusyIdx(null);
    }
  }

  const generatingAll = genStatus.kind === 'all';
  const generatingPanelIdx =
    genStatus.kind === 'one' ? genStatus.panelIndex : null;
  const autoFilling = genStatus.kind === 'autofill';
  const anyGenInFlight = genStatus.kind !== 'idle';

  return (
    <div className="flex flex-col gap-3">
      {/* Generate / lightbox action row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => callGenerateEndpoint()}
          disabled={anyGenInFlight}
          className="text-[11px] px-2.5 py-1 rounded font-semibold"
          style={{
            background: anyGenInFlight ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.22)',
            color: '#a78bfa',
            border: '1px solid rgba(124,58,237,0.45)',
            cursor: anyGenInFlight ? 'wait' : 'pointer',
          }}
          title={`Generate all ${N} panels (chained Atlas Edit)`}
        >
          {generatingAll ? '↯ Generating…' : `↯ Generate all ${N} panels`}
        </button>
        {(row.motion_collage_panel_urls?.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            disabled={anyGenInFlight}
            className="text-[11px] px-2.5 py-1 rounded"
            style={{
              background: 'rgba(255,255,255,0.05)',
              color: 'var(--fg)',
              border: '1px solid var(--card-border)',
              cursor: anyGenInFlight ? 'not-allowed' : 'pointer',
            }}
            title="Open the full-screen lightbox with all panels"
          >
            ▦ View collage
          </button>
        )}
      </div>

      {/* Per-panel thumbnail strip — visible when any panel URL exists.
          Each cell shows the panel image + a per-panel regen button.
          Click the image to open the lightbox focused on that panel. */}
      {(row.motion_collage_panel_urls?.length ?? 0) > 0 && (
        <div>
          <div className="text-[10px] mb-1" style={{ color: 'var(--fg-muted)' }}>
            Panels — click ↻ to regenerate just one
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
              gap: 4,
            }}
          >
            {panelUrls.map((url, idx) => {
              const generatingThis = generatingPanelIdx === idx;
              return (
                <div
                  key={idx}
                  style={{
                    position: 'relative',
                    aspectRatio: '16 / 9',
                    overflow: 'hidden',
                    borderRadius: 4,
                    border: '1px solid var(--card-border)',
                    background: '#000',
                  }}
                >
                  {url ? (
                    <button
                      type="button"
                      onClick={() => setLightboxOpen(true)}
                      title={`Panel ${idx + 1} — click to open lightbox`}
                      style={{
                        padding: 0,
                        background: 'transparent',
                        border: 'none',
                        cursor: 'zoom-in',
                        width: '100%',
                        height: '100%',
                        display: 'block',
                      }}
                    >
                      <MotionCollageThumb
                        panelUrls={[url]}
                        fallbackImageUrl={undefined}
                        loading="lazy"
                      />
                    </button>
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 9,
                        color: 'var(--fg-muted)',
                        fontFamily: 'ui-monospace, monospace',
                      }}
                    >
                      empty
                    </div>
                  )}
                  {/* Per-panel ordinal badge */}
                  <span
                    style={{
                      position: 'absolute',
                      top: 2,
                      left: 2,
                      padding: '1px 4px',
                      fontSize: 9,
                      fontWeight: 600,
                      background: 'rgba(0,0,0,0.65)',
                      color: '#fff',
                      borderRadius: 2,
                      pointerEvents: 'none',
                    }}
                  >
                    {idx + 1}
                  </span>
                  {/* Per-panel regenerate (disabled while ANY gen is in flight) */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void callGenerateEndpoint([idx]);
                    }}
                    disabled={anyGenInFlight}
                    title={
                      anyGenInFlight
                        ? 'Generation already in flight'
                        : `Regenerate panel ${idx + 1} only (cheaper than re-running the full grid)`
                    }
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      width: 18,
                      height: 18,
                      padding: 0,
                      borderRadius: 3,
                      background: generatingThis
                        ? 'rgba(168,85,247,0.65)'
                        : 'rgba(0,0,0,0.65)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.20)',
                      fontSize: 10,
                      lineHeight: 1,
                      cursor: anyGenInFlight ? 'wait' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {generatingThis ? '…' : '↻'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Grid + panel-prompt editor — the canonical motion-collage UI.
          Same component production-doc uses, lifted via path import. */}
      <MotionCollageRowEditor
        grid={row.motion_collage_grid}
        panelPrompts={panelPrompts}
        onChange={handleEditorChange}
        onRevertToRegular={handleRevert}
        onAutoFill={() => void handleAutoFill()}
        autoFilling={autoFilling}
      />

      {autoFillError && (
        <div
          className="text-[10px] px-2 py-1 rounded"
          style={{
            background: 'rgba(239,68,68,0.10)',
            color: '#f87171',
            border: '1px solid rgba(239,68,68,0.30)',
          }}
        >
          {autoFillError}
        </div>
      )}

      {lightboxOpen && (row.motion_collage_panel_urls?.length ?? 0) > 0 && (
        <MotionCollageLightbox
          panelUrls={row.motion_collage_panel_urls!}
          grid={row.motion_collage_grid}
          shotIndex={shotIndex}
          onClose={() => setLightboxOpen(false)}
          busyPanelIndex={perPanelBusyIdx}
          onRegenPanel={(panelIndex) => {
            // Same callGenerateEndpoint path the per-panel grid buttons
            // use, scoped to one panel via panelIndices=[i].
            void callGenerateEndpoint([panelIndex]);
          }}
          onUploadPanel={(panelIndex, file) => void handlePanelUpload(panelIndex, file)}
          onEditPanelWithPrompt={(panelIndex, prompt) =>
            void handlePanelEditWithPrompt(panelIndex, prompt)
          }
        />
      )}
    </div>
  );
}
