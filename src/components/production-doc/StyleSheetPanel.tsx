'use client';

/**
 * Doc-level style-sheet control panel.
 *
 * Three visible states:
 *   - Empty   → "Generate style sheet" CTA + has-protagonist toggle.
 *   - Loading → progress message while the sheet generates.
 *   - Ready   → thumbnail preview + re-roll / clear / toggle controls.
 *
 * Re-rolling regenerates with the current `hasProtagonist` value. Toggling
 * the value mid-life leaves the existing sheet in place (the toggle only
 * takes effect on the next regen) — that matches the user's mental model:
 * the toggle is a setting; the button is the action.
 *
 * See `_plans/2026-05-21-phase-7-style-sheet.md`.
 */
import React from 'react';

interface StyleSheetPanelProps {
  /** R2-hosted URL of the existing sheet. `undefined` ⇒ empty state. */
  sheetUrl: string | undefined;
  /** Current value of the `has_protagonist` toggle. */
  hasProtagonist: boolean;
  /** Plain-English style description. Used as the diffusion prompt
   *  scaffold AND mirrored to `doc.style_sheet_description` so cloud-Kie
   *  generations can append it for prompt-only chaining. */
  styleDescription: string;
  /** Plain-English protagonist description ("a red-headed engineer in a
   *  green hoodie"). Only meaningful when hasProtagonist=true. */
  protagonistDescription: string;
  /** Which model produced the existing sheet (display only). */
  sheetModel?: 'flux-schnell-local' | 'qwen-image-local';
  /** Generate (or re-roll) the sheet with the current settings. */
  onGenerate: (opts: {
    hasProtagonist: boolean;
    styleDescription: string;
    protagonistDescription: string;
  }) => void;
  /** Toggle the has-protagonist setting. Doesn't trigger regen. */
  onChangeHasProtagonist: (next: boolean) => void;
  /** Persist the style description as the user types. */
  onChangeStyleDescription: (next: string) => void;
  /** Persist the protagonist description as the user types. */
  onChangeProtagonistDescription: (next: string) => void;
  /** Clear the existing sheet (back to empty state). */
  onClear: () => void;
  /** True while a generation is in flight. Disables the buttons + shows
   *  a progress message. */
  generating: boolean;
  /** Whether the local stack is reachable. When `false`, the panel shows
   *  a "local ComfyUI required" hint instead of the generate button. */
  localStudioEnabled: boolean;
}

export const StyleSheetPanel: React.FC<StyleSheetPanelProps> = ({
  sheetUrl,
  hasProtagonist,
  styleDescription,
  protagonistDescription,
  sheetModel,
  onGenerate,
  onChangeHasProtagonist,
  onChangeStyleDescription,
  onChangeProtagonistDescription,
  onClear,
  generating,
  localStudioEnabled,
}) => {
  const canGenerate =
    localStudioEnabled && !generating && styleDescription.trim().length > 0;
  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: 'var(--panel-bg)',
        border: '1px solid var(--border)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
            Style sheet
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            One reference image every shot chains against, so the protagonist
            and palette stay consistent across the whole video.
          </p>
        </div>
        {sheetUrl && !generating && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs px-2 py-1 rounded"
            style={{
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
            }}
            title="Forget the current sheet (per-row generations stop chaining)"
          >
            Clear
          </button>
        )}
      </div>

      {/* Style description — the prompt scaffold the diffusion model
          generates the sheet from, AND the textual hint we append to
          cloud-Kie prompts for prompt-only chaining. One field, two uses. */}
      <label className="mt-3 block text-xs" style={{ color: 'var(--text)' }}>
        <span className="block mb-1 font-medium">Visual style</span>
        <textarea
          value={styleDescription}
          onChange={(e) => onChangeStyleDescription(e.target.value)}
          disabled={generating}
          rows={2}
          placeholder="e.g. hand-drawn 2D animation, muted earth tones, thick black outlines, flat shading"
          className="w-full resize-y rounded border bg-zinc-900 px-2 py-1.5 text-xs placeholder:text-zinc-600 focus:outline-none"
          style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
        />
      </label>

      <label className="mt-3 flex items-center gap-2 text-xs" style={{ color: 'var(--text)' }}>
        <input
          type="checkbox"
          checked={hasProtagonist}
          onChange={(e) => onChangeHasProtagonist(e.target.checked)}
          disabled={generating}
        />
        <span>
          This video has a recurring protagonist (sheet shows 2×2 character poses + palette)
        </span>
      </label>

      {hasProtagonist && (
        <label className="mt-2 block text-xs" style={{ color: 'var(--text)' }}>
          <span className="block mb-1 font-medium">Protagonist description</span>
          <textarea
            value={protagonistDescription}
            onChange={(e) => onChangeProtagonistDescription(e.target.value)}
            disabled={generating}
            rows={2}
            placeholder="e.g. a red-headed engineer in their late 20s, green hoodie, round glasses, friendly expression"
            className="w-full resize-y rounded border bg-zinc-900 px-2 py-1.5 text-xs placeholder:text-zinc-600 focus:outline-none"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          />
        </label>
      )}

      <div className="mt-3 flex items-center gap-3">
        {sheetUrl ? (
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {/* Thumbnail */}
            <a
              href={sheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block flex-shrink-0 rounded overflow-hidden"
              style={{
                width: 96,
                height: 54,
                border: '1px solid var(--border)',
                background: '#0a0a0a',
              }}
              title="Open the full-size sheet in a new tab"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sheetUrl}
                alt="Style sheet"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </a>
            <div className="flex-1 min-w-0">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {sheetModel ? `Generated with ${sheetModel}` : 'Ready'}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs flex-1" style={{ color: 'var(--text-muted)' }}>
            No sheet yet — rows will generate independently with no
            character / palette continuity.
          </p>
        )}

        <button
          type="button"
          onClick={() =>
            onGenerate({
              hasProtagonist,
              styleDescription: styleDescription.trim(),
              protagonistDescription: protagonistDescription.trim(),
            })
          }
          disabled={!canGenerate}
          className="text-xs px-3 py-1.5 rounded font-medium"
          style={{
            background: canGenerate
              ? 'rgba(99, 102, 241, 0.20)'
              : 'transparent',
            color: canGenerate ? '#a5b4fc' : 'var(--text-muted)',
            border: canGenerate
              ? '1px solid rgba(99, 102, 241, 0.45)'
              : '1px solid var(--border)',
            cursor: canGenerate ? 'pointer' : 'not-allowed',
            opacity: generating ? 0.6 : 1,
          }}
          title={
            !localStudioEnabled
              ? 'Local ComfyUI required — set LOCAL_STUDIO=1 and run on dev'
              : styleDescription.trim().length === 0
              ? 'Add a visual style description above first'
              : sheetUrl
              ? 'Re-roll the sheet with a new seed'
              : 'Generate the style sheet now'
          }
        >
          {generating ? 'Generating…' : sheetUrl ? 'Re-roll' : 'Generate sheet'}
        </button>
      </div>
    </div>
  );
};
