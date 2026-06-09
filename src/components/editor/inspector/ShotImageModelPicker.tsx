'use client';

/**
 * Per-row image (still) model picker.
 *
 * Controls which model `/api/generate/production-doc/image` and the
 * motion-collage generate endpoints get called with when the user clicks
 * Regenerate (or "Generate all panels" on a motion_collage row).
 *
 * Resolution tier (server-side):
 *   1. row.image_model     (this picker writes here)
 *   2. doc.image_model_default
 *   3. server DEFAULT_IMAGE_MODEL
 *
 * "Default" sets `row.image_model` to undefined so the doc-level default
 * (set in the editor's doc-defaults panel, stamped on fresh docs by the
 * production-doc page) takes over.
 *
 * Lifted out of ShotInspector.tsx 2026-06-09 so InspectorMotionCollagePanel
 * can use the same picker without duplicating the local-studio gate,
 * label fallback resolution, and styling. Single source of truth for the
 * picker UI.
 */
import { useMemo } from 'react';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, getImageModelSpec } from '@/lib/image-models';
import { useLocalStudioEnabled } from '@/lib/local-studio-enabled';

interface ShotImageModelPickerProps {
  rowModelId: string | undefined;
  docModelId: string | undefined;
  onChange: (next: string | undefined) => void;
  /** 2026-06-09 — promote the row's current pick to the doc-level
   *  default. Surfaces a "Save as default for this doc" button under
   *  the dropdown when a row pick exists AND it differs from the doc
   *  default. Clicking it writes the row's pick to `doc.image_model_default`
   *  and clears `row.image_model` so the row falls through cleanly to
   *  the new default. Optional — when omitted (e.g. the inspector has
   *  no doc-update access), the button is hidden.
   *
   *  Why this lives on the per-row picker: the user reported they
   *  didn't know the doc-defaults sidebar panel existed. Putting a
   *  one-click promote next to the choice they just made closes the
   *  loop without making them hunt for a second panel. */
  onSaveAsDefault?: (modelId: string) => void;
}

export function ShotImageModelPicker({
  rowModelId,
  docModelId,
  onChange,
  onSaveAsDefault,
}: ShotImageModelPickerProps): React.ReactElement {
  const localStudioEnabled = useLocalStudioEnabled();
  const models = useMemo(
    () =>
      IMAGE_MODELS.filter(
        (m) => localStudioEnabled || m.provider !== 'comfyui-local',
      ),
    [localStudioEnabled],
  );
  // Resolve what "Default" means right now so the label is honest.
  // Doc-level pick wins; otherwise the server's hardcoded default.
  const fallbackId = docModelId ?? DEFAULT_IMAGE_MODEL;
  const fallback = getImageModelSpec(fallbackId);
  const defaultLabel = fallback
    ? `Default — ${fallback.label}${docModelId ? ' (doc setting)' : ''}`
    : 'Default';
  return (
    <div className="space-y-1">
      <div
        className="text-[11px] font-semibold"
        style={{ color: 'var(--fg)' }}
      >
        Image model
      </div>
      <select
        value={rowModelId ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="w-full text-xs rounded border px-2 py-1.5"
        style={{
          borderColor: 'var(--card-border)',
          background: 'var(--bg)',
          color: 'var(--fg)',
        }}
        aria-label="Image model for this shot's Regenerate"
      >
        <option value="">{defaultLabel}</option>
        {models.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
            {m.hint ? ` — ${m.hint}` : ''}
          </option>
        ))}
      </select>
      {/* "Save as default" — visible when the user picked a per-row
          override that differs from the current doc default. One click
          promotes the pick to `doc.image_model_default` AND clears
          `row.image_model` so the row falls through cleanly to the new
          default. Every other row in this doc inherits the new default
          on its next Regenerate (and the motion-collage inspector reads
          the same field). */}
      {onSaveAsDefault
        && rowModelId
        && rowModelId !== docModelId
        && (
          <button
            type="button"
            onClick={() => {
              onSaveAsDefault(rowModelId);
              onChange(undefined);
            }}
            className="text-[10px] px-1.5 py-0.5 rounded mt-1"
            style={{
              background: 'rgba(124,58,237,0.10)',
              color: '#a78bfa',
              border: '1px solid rgba(124,58,237,0.35)',
              cursor: 'pointer',
            }}
            title="Make this the doc-level default. Applies to every shot's Regenerate (including motion collages) unless the shot has its own override."
          >
            ↑ Save as default for this doc
          </button>
        )}
    </div>
  );
}
