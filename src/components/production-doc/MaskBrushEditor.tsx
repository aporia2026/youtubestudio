"use client";

/**
 * Brush-paint mask editor for production-doc image cells.
 *
 * Renders a fullscreen modal with the source image displayed at fit-to-
 * viewport size. A second HTML5 canvas, sized to the source's *natural*
 * pixel dimensions, is overlaid at the same on-screen position so the
 * user can paint regions to edit. When the user clicks Apply:
 *
 *   1. The paint layer is converted to a strict black/white PNG matching
 *      the source's natural dimensions (Kie GPT-4o image-edit requires
 *      identical dimensions and a binary mask).
 *   2. The PNG is uploaded directly to R2 via a presigned PUT obtained
 *      from `/api/uploads/mask`.
 *   3. The mask URL + prompt + quality tier are handed back to the
 *      caller via `onApply` so it can fire the GPT-4o image-edit call.
 *
 * Black = regenerate, white = preserve. The renderer translates the red
 * brush strokes to black at export time so the on-screen feedback can
 * stay visible without affecting the mask.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

type Quality = 'low' | 'medium' | 'high';

const QUALITY_LABELS: Record<Quality, string> = {
  low: 'Low — $0.02',
  medium: 'Medium — $0.07',
  high: 'High — $0.19',
};

interface MaskBrushEditorProps {
  sourceImageUrl: string;
  defaultQuality?: Quality;
  onCancel: () => void;
  /** Called after the mask has been generated, uploaded, and the user
   *  has clicked Apply. The caller fires the GPT-4o edit call. */
  onApply: (args: { maskUrl: string; prompt: string; quality: Quality }) => void | Promise<void>;
}

export function MaskBrushEditor({
  sourceImageUrl,
  defaultQuality = 'medium',
  onCancel,
  onApply,
}: MaskBrushEditorProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<'brush' | 'erase'>('brush');
  const [brushSize, setBrushSize] = useState(60);
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState<Quality>(defaultQuality);
  const [hasPainted, setHasPainted] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Image natural size drives mask canvas resolution. Until the source
  // image has loaded, the canvas can't be sized.
  function handleImageLoad() {
    const img = imgRef.current;
    if (!img) return;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  // Initialise the canvas dimensions whenever naturalSize changes.
  // We set the internal resolution to the source's natural pixels;
  // CSS sizes it to fill the same on-screen rect as the displayed image.
  useEffect(() => {
    if (!naturalSize) return;
    const cv = maskCanvasRef.current;
    if (!cv) return;
    cv.width = naturalSize.w;
    cv.height = naturalSize.h;
    const ctx = cv.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
    setHasPainted(false);
  }, [naturalSize]);

  // ESC closes. We don't confirm on close — paint state is in-memory
  // only and the user can always re-open the editor; pestering with
  // a confirm dialog on every ESC is worse UX than the rare lost paint.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  /**
   * Translate a pointer event from CSS pixels (where the user clicks)
   * to natural pixels (the canvas's internal coordinate system). The
   * canvas is rendered at the displayed image's size, so the ratio
   * of natural-to-displayed gives the multiplier.
   */
  const pointerToCanvas = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget;
    const rect = cv.getBoundingClientRect();
    const xCss = e.clientX - rect.left;
    const yCss = e.clientY - rect.top;
    return {
      x: (xCss / rect.width) * cv.width,
      y: (yCss / rect.height) * cv.height,
      scale: cv.width / rect.width,
    };
  }, []);

  const drawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number; scale: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const cv = e.currentTarget;
    cv.setPointerCapture(e.pointerId);
    drawing.current = true;
    const pos = pointerToCanvas(e);
    lastPos.current = pos;
    drawSegment(pos, pos);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const pos = pointerToCanvas(e);
    if (lastPos.current) drawSegment(lastPos.current, pos);
    lastPos.current = pos;
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = false;
    lastPos.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch { /* already released */ }
  }

  function drawSegment(
    from: { x: number; y: number; scale: number },
    to: { x: number; y: number; scale: number },
  ) {
    const cv = maskCanvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    // Brush size is in CSS px on the slider; scale up to natural px so
    // the stroke covers the same area regardless of zoom level.
    const radius = (brushSize / 2) * to.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = radius * 2;
    if (tool === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(239,68,68,0.55)';
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    setHasPainted(true);
  }

  function clearMask() {
    const cv = maskCanvasRef.current;
    if (!cv) return;
    cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
    setHasPainted(false);
  }

  function invertMask() {
    const cv = maskCanvasRef.current;
    if (!cv || !naturalSize) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const data = ctx.getImageData(0, 0, cv.width, cv.height);
    // Flip alpha. For pixels currently transparent, paint red; for
    // painted pixels, clear them. Preserve the red color (250,68,68)
    // for newly-painted pixels so the visual stays consistent with
    // the brush.
    for (let i = 0; i < data.data.length; i += 4) {
      const wasPainted = data.data[i + 3] > 0;
      if (wasPainted) {
        data.data[i + 3] = 0;
      } else {
        data.data[i] = 239;
        data.data[i + 1] = 68;
        data.data[i + 2] = 68;
        data.data[i + 3] = 140;
      }
    }
    ctx.putImageData(data, 0, 0);
    setHasPainted(true);
  }

  /**
   * Build the export PNG: a fresh canvas filled white, then black where
   * the paint layer has any opaque pixels. We threshold strictly at
   * alpha > 0 — `source-over` with translucent red gives each painted
   * pixel a nonzero alpha, so the same threshold works for brush + the
   * inverted regions and there's no need to track a separate "user
   * painted here" bitmap.
   */
  async function buildMaskBlob(): Promise<Blob> {
    const src = maskCanvasRef.current;
    if (!src || !naturalSize) throw new Error('Mask canvas not ready');
    const out = document.createElement('canvas');
    out.width = naturalSize.w;
    out.height = naturalSize.h;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Failed to get export canvas context');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);

    const srcCtx = src.getContext('2d');
    if (!srcCtx) throw new Error('Failed to read paint canvas');
    const srcData = srcCtx.getImageData(0, 0, src.width, src.height);

    const outData = ctx.getImageData(0, 0, out.width, out.height);
    for (let i = 0; i < srcData.data.length; i += 4) {
      if (srcData.data[i + 3] > 0) {
        outData.data[i] = 0;
        outData.data[i + 1] = 0;
        outData.data[i + 2] = 0;
        outData.data[i + 3] = 255;
      }
    }
    ctx.putImageData(outData, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      out.toBlob(b => {
        if (!b) reject(new Error('Failed to export mask as PNG'));
        else resolve(b);
      }, 'image/png');
    });
  }

  async function apply() {
    if (!prompt.trim() || !hasPainted || isUploading) return;
    setError(null);
    setIsUploading(true);
    try {
      const blob = await buildMaskBlob();
      // Step 1: presigned PUT
      const presignRes = await fetch('/api/uploads/mask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: `mask-${Date.now()}.png`,
          contentType: 'image/png',
          fileSize: blob.size,
        }),
      });
      if (!presignRes.ok) {
        const errBody = await presignRes.json().catch(() => ({}));
        throw new Error((errBody as { error?: string }).error || `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl } = await presignRes.json();
      // Step 2: PUT the blob
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      });
      if (!putRes.ok) throw new Error(`Mask upload failed (${putRes.status})`);
      // Step 3: hand the URL + prompt + quality back to the caller
      await onApply({ maskUrl: downloadUrl, prompt: prompt.trim(), quality });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply mask');
      setIsUploading(false);
    }
  }

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.92)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated, #111)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 16,
          width: 'min(1100px, 96vw)',
          maxHeight: '94vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          color: 'var(--text-primary)',
        }}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Paint a region to edit</div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        <div
          ref={containerRef}
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignSelf: 'center',
            background: '#000',
            borderRadius: 6,
            overflow: 'hidden',
            maxWidth: '100%',
            maxHeight: '62vh',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={sourceImageUrl}
            alt="Source"
            onLoad={handleImageLoad}
            style={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: '62vh',
              objectFit: 'contain',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          />
          <canvas
            ref={maskCanvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              cursor: 'crosshair',
              touchAction: 'none',
            }}
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap text-xs">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setTool('brush')}
              className="px-2 py-1 rounded"
              style={{
                background: tool === 'brush' ? 'rgba(239,68,68,0.20)' : 'transparent',
                color: tool === 'brush' ? '#fca5a5' : 'var(--text-secondary)',
                border: `1px solid ${tool === 'brush' ? 'rgba(239,68,68,0.40)' : 'var(--border)'}`,
                cursor: 'pointer',
              }}
            >
              🖌 Brush
            </button>
            <button
              type="button"
              onClick={() => setTool('erase')}
              className="px-2 py-1 rounded"
              style={{
                background: tool === 'erase' ? 'rgba(120,120,120,0.20)' : 'transparent',
                color: 'var(--text-secondary)',
                border: `1px solid ${tool === 'erase' ? 'rgba(255,255,255,0.30)' : 'var(--border)'}`,
                cursor: 'pointer',
              }}
            >
              ⌫ Erase
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label style={{ color: 'var(--text-muted)' }}>Size</label>
            <input
              type="range"
              min={8}
              max={200}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              style={{ width: 120 }}
            />
            <span style={{ color: 'var(--text-muted)', minWidth: 30 }}>{brushSize}</span>
          </div>
          <button
            type="button"
            onClick={clearMask}
            className="px-2 py-1 rounded"
            style={{
              background: 'transparent',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={invertMask}
            disabled={!hasPainted}
            className="px-2 py-1 rounded"
            style={{
              background: 'transparent',
              color: hasPainted ? 'var(--text-secondary)' : 'var(--text-muted)',
              border: '1px solid var(--border)',
              cursor: hasPainted ? 'pointer' : 'not-allowed',
            }}
          >
            Invert
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              What should the painted area become?
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. a stormy sunset sky with orange clouds"
              rows={3}
              disabled={isUploading}
              maxLength={2000}
              style={{
                background: 'var(--bg-card, #0c0c0c)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: 8,
                fontSize: 13,
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Quality</label>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as Quality)}
              disabled={isUploading}
              style={{
                background: 'var(--bg-card, #0c0c0c)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '6px 8px',
                fontSize: 13,
              }}
            >
              <option value="low">{QUALITY_LABELS.low}</option>
              <option value="medium">{QUALITY_LABELS.medium}</option>
              <option value="high">{QUALITY_LABELS.high}</option>
            </select>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              GPT-4o image edit. Higher tiers spend more on each attempt.
            </div>
          </div>
        </div>

        {error && (
          <div className="text-xs" style={{ color: '#f87171' }} role="alert">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isUploading}
            className="text-xs px-3 py-1.5 rounded"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              cursor: isUploading ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!prompt.trim() || !hasPainted || isUploading}
            className="text-xs px-3 py-1.5 rounded"
            style={{
              background:
                !prompt.trim() || !hasPainted || isUploading
                  ? 'rgba(120,120,120,0.18)'
                  : 'rgba(168,85,247,0.20)',
              color:
                !prompt.trim() || !hasPainted || isUploading
                  ? 'var(--text-muted)'
                  : '#c084fc',
              border: '1px solid rgba(168,85,247,0.35)',
              cursor:
                !prompt.trim() || !hasPainted || isUploading ? 'not-allowed' : 'pointer',
            }}
          >
            {isUploading ? 'Uploading mask…' : `Apply (${QUALITY_LABELS[quality]})`}
          </button>
        </div>
      </div>
    </div>
  );
}
