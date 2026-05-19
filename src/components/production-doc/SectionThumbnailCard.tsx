"use client";

/**
 * Card on the Production Doc page for the section-divider composite
 * thumbnail. Empty state = drop zone. Uploaded state = preview + dims
 * + Replace + (placeholder) Mark regions.
 *
 * The image lives in the R2 images bucket (uploaded via a presigned
 * PUT URL issued by /api/production-doc/thumbnail/upload). The
 * returned download URL + intrinsic dims are stored as
 * `ProductionDoc.thumbnail` and persist with the doc via the
 * existing history save/update flow. Region marking + per-row "Zoom
 * to" UI are wired up in a follow-up; this card is Phase 2 of
 * `_plans/2026-05-13-thumbnail-zoom-section-divider.md`.
 *
 * Migrated from Vercel Blob to R2 in 2026-05-14 so the upload works
 * on workspaces whose Blob store is private-access (Blob's
 * `access: 'public'` errors there). R2 has no public/private store
 * split — every workspace sees the same behaviour.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ThumbnailRegion, ThumbnailTransitionConfig, VideoThumbnail } from '@/remotion/types';
import { ThumbnailRegionEditor } from './ThumbnailRegionEditor';
import { TransitionDialog } from './TransitionDialog';
import { RegionJsonImportDialog } from './RegionJsonImportDialog';

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp';
const MAX_FILE_SIZE = 5 * 1024 * 1024;

interface SectionThumbnailCardProps {
  value?: VideoThumbnail;
  onChange: (next: VideoThumbnail | undefined) => void;
}

/**
 * Pure helper: load an image off a Blob URL, return its natural dims.
 * Browser-only — uses `new Image()`. Caller is responsible for revoking
 * any object URL it created.
 */
function readImageDimensions(objectUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not read image dimensions — file may be corrupted.'));
    img.src = objectUrl;
  });
}

export function SectionThumbnailCard({ value, onChange }: SectionThumbnailCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [defaultTransitionOpen, setDefaultTransitionOpen] = useState(false);
  // Phase D of plan 2026-05-20 — paste-JSON entry point on the card.
  // Lives next to "Mark / Edit regions" so creators who exported their
  // regions from the Thumbnails page can bring them in without first
  // opening the region editor.
  const [jsonImportOpen, setJsonImportOpen] = useState(false);

  const handleSaveRegions = useCallback((regions: ThumbnailRegion[]) => {
    if (!value) return;
    onChange({ ...value, regions });
    setEditorOpen(false);
  }, [onChange, value]);

  const handleSaveDefaultTransition = useCallback((t: ThumbnailTransitionConfig) => {
    if (!value) return;
    onChange({ ...value, defaultTransition: t });
    setDefaultTransitionOpen(false);
  }, [onChange, value]);

  const handleResetDefaultTransition = useCallback(() => {
    if (!value) return;
    onChange({ ...value, defaultTransition: undefined });
    setDefaultTransitionOpen(false);
  }, [onChange, value]);

  const handleStripeHeightChange = useCallback((next: number) => {
    if (!value) return;
    // Persist the slider as-is; the renderer clamps + falls back if invalid.
    onChange({ ...value, stripeHeightFraction: next });
  }, [onChange, value]);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type || !ACCEPTED_TYPES.includes(file.type)) {
      toast.error('Use a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.`);
      return;
    }

    setUploading(true);
    const objectUrl = URL.createObjectURL(file);
    try {
      const { width, height } = await readImageDimensions(objectUrl);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error('Image has invalid dimensions — try a different file.');
      }
      if (width > 8192 || height > 8192) {
        throw new Error(`Image too large (${width}×${height}). Max 8192px per side.`);
      }

      // Two-step presigned upload to R2:
      //   1. Ask the server for a presigned PUT URL keyed to this file.
      //   2. PUT the bytes directly to R2 from the browser, bypassing
      //      Vercel's ~4.5 MB request-body limit.
      const presignRes = await fetch('/api/production-doc/thumbnail/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
          width,
          height,
        }),
      });
      const presign = (await presignRes.json()) as {
        uploadUrl?: string;
        downloadUrl?: string;
        width?: number;
        height?: number;
        error?: string;
      };
      if (!presignRes.ok || !presign.uploadUrl || !presign.downloadUrl) {
        throw new Error(presign.error ?? `Upload presign failed (${presignRes.status})`);
      }

      const putRes = await fetch(presign.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!putRes.ok) {
        throw new Error(`R2 upload failed (${putRes.status} ${putRes.statusText})`);
      }

      onChange({
        imageUrl: presign.downloadUrl,
        width: presign.width ?? width,
        height: presign.height ?? height,
        // Preserve regions from a prior upload — useful when the user
        // replaces a thumbnail with a re-export of the same layout.
        regions: value?.regions ?? [],
        defaultTransition: value?.defaultTransition,
      });
      toast.success('Thumbnail uploaded.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      URL.revokeObjectURL(objectUrl);
      setUploading(false);
    }
  }, [onChange, value]);

  // Reset file input after each pick so re-picking the same filename re-fires onChange.
  useEffect(() => {
    if (!uploading && fileInputRef.current) fileInputRef.current.value = '';
  }, [uploading]);

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid rgba(255,255,255,${dragOver ? 0.35 : 0.10})`,
        borderRadius: 12,
        padding: 16,
        transition: 'border-color 120ms ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
            Section divider thumbnail
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Composite image used as the cold-open and section dividers.
          </div>
        </div>
        {value && (
          <button
            onClick={() => {
              if (confirm('Remove the thumbnail and any region marks? This cannot be undone.')) {
                onChange(undefined);
              }
            }}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.10)',
              cursor: 'pointer',
            }}
          >
            Remove
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />

      {value ? (
        // ─── Uploaded state ───────────────────────────────────────────────
        <div>
          <div
            style={{
              borderRadius: 8,
              overflow: 'hidden',
              background: 'rgba(0,0,0,0.30)',
              maxHeight: 320,
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            {/* Editor preview — `next/image` would force fixed dimensions
             *  + Blob domain config and gives no perf win for a one-off
             *  modal preview. Plain <img> is the right tool here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value.imageUrl}
              alt="Section divider thumbnail"
              style={{
                maxWidth: '100%',
                maxHeight: 320,
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {value.width} × {value.height} px
              {value.regions.length > 0 && (
                <span style={{ marginLeft: 12 }}>{value.regions.length} region{value.regions.length === 1 ? '' : 's'} marked</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  borderRadius: 6,
                  background: 'rgba(255,255,255,0.10)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.20)',
                  cursor: uploading ? 'wait' : 'pointer',
                }}
              >
                {uploading ? 'Uploading…' : 'Replace'}
              </button>
              <button
                onClick={() => setDefaultTransitionOpen(true)}
                title="Set the default zoom transition for every row in this doc. Rows can still override individually."
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  borderRadius: 6,
                  background: value.defaultTransition ? 'rgba(168,85,247,0.10)' : 'transparent',
                  color: value.defaultTransition ? '#c084fc' : 'var(--text-muted)',
                  border: `1px solid ${value.defaultTransition ? 'rgba(168,85,247,0.25)' : 'rgba(255,255,255,0.10)'}`,
                  cursor: 'pointer',
                }}
              >
                {value.defaultTransition ? '⚙ Default transition' : '⚙ Default transition…'}
              </button>
              <button
                onClick={() => setJsonImportOpen(true)}
                title="Paste regions JSON copied from the Thumbnails page (Topic Card Grid / N Levels)."
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid rgba(255,255,255,0.20)',
                  cursor: 'pointer',
                }}
              >
                📋 Paste JSON
              </button>
              <button
                onClick={() => setEditorOpen(true)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '6px 12px',
                  borderRadius: 6,
                  background: 'rgba(168,85,247,0.18)',
                  color: '#c084fc',
                  border: '1px solid rgba(168,85,247,0.35)',
                  cursor: 'pointer',
                }}
              >
                {value.regions.length > 0 ? 'Edit regions' : 'Mark regions'}
              </button>
            </div>
          </div>
          <StripeHeightControl
            value={value.stripeHeightFraction ?? 0.13}
            onChange={handleStripeHeightChange}
          />
        </div>
      ) : (
        // ─── Empty state ──────────────────────────────────────────────────
        <div
          onClick={() => !uploading && fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleFile(f);
          }}
          style={{
            border: `1.5px dashed rgba(255,255,255,${dragOver ? 0.45 : 0.20})`,
            borderRadius: 8,
            padding: '32px 16px',
            textAlign: 'center',
            cursor: uploading ? 'wait' : 'pointer',
            background: dragOver ? 'rgba(168,85,247,0.06)' : 'transparent',
            transition: 'background 120ms ease, border-color 120ms ease',
          }}
        >
          {uploading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <div className="spinner" style={{ width: 16, height: 16 }} />
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Uploading…</span>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 14, color: 'var(--text)', marginBottom: 4 }}>
                Drop a thumbnail here, or click to upload
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                JPEG, PNG, or WebP — up to 5 MB
              </div>
            </>
          )}
        </div>
      )}

      {editorOpen && value && (
        <ThumbnailRegionEditor
          thumbnail={value}
          onSave={handleSaveRegions}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {defaultTransitionOpen && value && (
        <TransitionDialog
          title="Default transition for this doc"
          description="Used by every row whose row override is unset. Rows can override per-shot."
          current={value.defaultTransition}
          resetLabel="Reset to built-in default"
          onSave={handleSaveDefaultTransition}
          onReset={handleResetDefaultTransition}
          onClose={() => setDefaultTransitionOpen(false)}
        />
      )}

      {jsonImportOpen && value && (
        <RegionJsonImportDialog
          imageWidth={value.width}
          imageHeight={value.height}
          existingRegionCount={value.regions.length}
          onImport={(imported) => onChange({ ...value, regions: imported })}
          onClose={() => setJsonImportOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Sub-component: stripe height slider ──────────────────────────────────────

interface StripeHeightControlProps {
  value: number;
  onChange: (next: number) => void;
}

/**
 * Slider for the section-title stripe height, expressed as a fraction
 * of frame height. Constrained at the UI level too so the persisted
 * value matches what the renderer will accept.
 *
 * A miniature inline preview at the right shows roughly how tall the
 * band looks against a 16:9 frame — purely visual, no live thumbnail.
 */
function StripeHeightControl({ value, onChange }: StripeHeightControlProps) {
  // Match the renderer's clamp range so the slider never produces a
  // value the renderer would override.
  const MIN = 0.06;
  const MAX = 0.22;
  const clamped = Math.max(MIN, Math.min(MAX, value));
  const pct = Math.round(clamped * 100);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginTop: 12,
        padding: '10px 12px',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div style={{ minWidth: 140 }}>
        <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>
          Title stripe height
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
          {pct}% of frame · ≈ {Math.round(clamped * 1080)}px at 1080p
        </div>
      </div>
      <input
        type="range"
        min={MIN}
        max={MAX}
        step={0.01}
        value={clamped}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, minWidth: 0 }}
        aria-label="Section title stripe height"
      />
      {/* Mini preview: a 16:9 frame with the proportional band on top. */}
      <div
        style={{
          width: 64,
          aspectRatio: '16 / 9',
          background: 'rgba(0,0,0,0.45)',
          borderRadius: 4,
          border: '1px solid rgba(255,255,255,0.08)',
          position: 'relative',
          overflow: 'hidden',
          flexShrink: 0,
        }}
        title="Preview"
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: `${clamped * 100}%`,
            background: '#FFFFFF',
          }}
        />
      </div>
    </div>
  );
}
