'use client';

/**
 * Collage tester debug panel — production-doc page only, hidden
 * behind the `NEXT_PUBLIC_COLLAGE_TESTER` env flag. Backed by the
 * `/api/dev/collage-test` endpoint (also flag-gated).
 *
 * Four prompt fields in a 2×2 grid that matches the eventual output
 * layout, plus a model picker and a Run button. After Run, displays
 * the three pipeline stages stacked vertically:
 *
 *   1. Raw 1K collage from the model (single image)
 *   2. Upscaled collage (single image) + upscale telemetry
 *   3. The 4 sliced quadrants laid out in the same 2×2 as the inputs,
 *      with each prompt shown underneath its quadrant
 *
 * Purpose: validate end-to-end pipeline quality + tune detection
 * thresholds + sanity-check upscaler behaviour on real generations
 * without burning credits in the real flow.
 *
 * See `_plans/2026-05-24-system-upscale-and-collage.md`.
 */
import React, { useState } from 'react';
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL } from '@/lib/image-models';

interface QuadrantDiagnostic {
  valid: boolean;
  reason?: string;
  dominantBucketFraction: number;
  edgeDensity: number;
}

interface CollageTesterResponse {
  status: 'success';
  stages: {
    rawCollageUrl: string;
    upscaledCollageUrl: string;
    quadrantUrls: [string, string, string, string];
  };
  diagnostics: {
    rawMs: number;
    upscaleMs: number;
    upscaleReason: string;
    upscaleAttempts: number;
    sourceLongEdgePx?: number;
    sliceMs: number;
    sourceWidth: number;
    sourceHeight: number;
    quadrantWidth: number;
    quadrantHeight: number;
    detection: {
      allValid: boolean;
      malformedIndices: number[];
      quadrants: QuadrantDiagnostic[];
    } | null;
  };
}

interface ErrorResponse {
  error: string;
}

const LABELS = ['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right'] as const;

export function CollageTesterPanel() {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<string[]>(['', '', '', '']);
  const [model, setModel] = useState<string>(DEFAULT_IMAGE_MODEL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CollageTesterResponse | null>(null);

  // Only cloud (Kie) models can run through the collage path. Local
  // ComfyUI models don't upscale via Recraft so a 540×960 quadrant
  // would be unusable downstream.
  const cloudModels = IMAGE_MODELS.filter((m) => m.provider === 'kie');

  const canSubmit = prompts.every((p) => p.trim().length > 0 && p.trim().length <= 400) && !busy;

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/dev/collage-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts, model }),
      });
      const data = (await res.json()) as CollageTesterResponse | ErrorResponse;
      if (!res.ok || 'error' in data) {
        setError('error' in data ? data.error : `HTTP ${res.status}`);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-4 rounded text-xs"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2"
        style={{ color: 'var(--text-secondary)' }}
      >
        <span>Collage tester (debug)</span>
        <span style={{ color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="p-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          {/* 2×2 prompt grid — visual match for the output layout */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            {LABELS.map((label, i) => (
              <div key={label} className="flex flex-col gap-1">
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {label}
                </label>
                <textarea
                  value={prompts[i]}
                  onChange={(e) => {
                    const next = [...prompts];
                    next[i] = e.target.value;
                    setPrompts(next);
                  }}
                  rows={3}
                  maxLength={400}
                  className="w-full px-2 py-1 rounded resize-y"
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: 'var(--text-primary)',
                    fontSize: '11px',
                  }}
                  placeholder={`Scene description for ${label.toLowerCase()}…`}
                />
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {prompts[i].length}/400
                </span>
              </div>
            ))}
          </div>

          {/* Model picker + Run button */}
          <div className="flex items-center gap-2 mb-3">
            <label className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              Model:
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="text-xs px-2 py-1 rounded"
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--text-primary)',
              }}
            >
              {cloudModels.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={run}
              disabled={!canSubmit}
              className="text-xs px-3 py-1 rounded ml-auto"
              style={{
                background: canSubmit ? 'rgba(168,85,247,0.18)' : 'rgba(120,120,120,0.10)',
                color: canSubmit ? '#c084fc' : 'var(--text-muted)',
                border: '1px solid ' + (canSubmit ? 'rgba(168,85,247,0.45)' : 'transparent'),
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              {busy ? 'Running…' : 'Run pipeline'}
            </button>
          </div>

          {/* Error state */}
          {error && (
            <div
              className="px-2 py-1 rounded text-xs mb-3"
              style={{ background: 'rgba(239,68,68,0.10)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.40)' }}
            >
              {error}
            </div>
          )}

          {/* Result — three rows: raw, upscaled, sliced */}
          {result && (
            <div className="flex flex-col gap-4">
              {/* Row 1: raw 1K collage */}
              <div>
                <div className="text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
                  1. Raw 1K collage from {model} ({result.diagnostics.rawMs} ms)
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={result.stages.rawCollageUrl}
                  alt="raw collage"
                  className="w-full max-w-2xl rounded"
                  style={{ border: '1px solid rgba(255,255,255,0.10)' }}
                />
              </div>

              {/* Row 2: upscaled collage + telemetry */}
              <div>
                <div className="text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
                  2. Upscaled via Recraft ({result.diagnostics.upscaleMs} ms,
                  reason: {result.diagnostics.upscaleReason},
                  attempts: {result.diagnostics.upscaleAttempts},
                  source long edge: {result.diagnostics.sourceLongEdgePx ?? '?'} px →
                  upscaled: {result.diagnostics.sourceWidth}×{result.diagnostics.sourceHeight})
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={result.stages.upscaledCollageUrl}
                  alt="upscaled collage"
                  className="w-full max-w-2xl rounded"
                  style={{ border: '1px solid rgba(255,255,255,0.10)' }}
                />
                {result.diagnostics.detection && (
                  <div
                    className="mt-1 text-[10px] px-2 py-1 rounded"
                    style={{
                      background: result.diagnostics.detection.allValid
                        ? 'rgba(16,185,129,0.10)'
                        : 'rgba(239,68,68,0.10)',
                      color: result.diagnostics.detection.allValid ? '#6ee7b7' : '#fca5a5',
                    }}
                  >
                    Detection: {result.diagnostics.detection.allValid ? 'all 4 quadrants OK' : `malformed indices ${result.diagnostics.detection.malformedIndices.join(', ')}`}
                  </div>
                )}
              </div>

              {/* Row 3: sliced quadrants in 2×2 */}
              <div>
                <div className="text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
                  3. Cropped shots ({result.diagnostics.sliceMs} ms,
                  per-quadrant {result.diagnostics.quadrantWidth}×{result.diagnostics.quadrantHeight})
                </div>
                <div className="grid grid-cols-2 gap-2 max-w-2xl">
                  {result.stages.quadrantUrls.map((url, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={`quadrant ${i}`}
                        className="w-full rounded"
                        style={{ border: '1px solid rgba(255,255,255,0.10)' }}
                      />
                      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <strong>{LABELS[i]}:</strong> {prompts[i].slice(0, 120)}{prompts[i].length > 120 ? '…' : ''}
                      </div>
                      {result.diagnostics.detection && (
                        <div className="text-[10px]" style={{
                          color: result.diagnostics.detection.quadrants[i].valid ? '#6ee7b7' : '#fca5a5',
                        }}>
                          dom: {result.diagnostics.detection.quadrants[i].dominantBucketFraction.toFixed(3)} ·
                          edge: {result.diagnostics.detection.quadrants[i].edgeDensity.toFixed(1)}
                          {!result.diagnostics.detection.quadrants[i].valid && (
                            <span> · {result.diagnostics.detection.quadrants[i].reason}</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
