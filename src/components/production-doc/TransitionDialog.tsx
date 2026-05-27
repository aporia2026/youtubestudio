"use client";

/**
 * Reusable transition-config editor dialog.
 *
 * Used in two places:
 *  - `SectionRowControls` — per-row override.
 *  - `SectionThumbnailCard` — doc-level default ("Default transition…").
 *
 * Owns its own working copy (kind / speed / easing). On Save, returns
 * the computed ThumbnailTransitionConfig. On Reset (when a current
 * value exists), returns undefined so the caller can clear the
 * override / default.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ThumbnailTransitionConfig,
  ThumbnailTransitionKind,
} from '@/remotion/types';

// ─── Defaults (the canonical "1.0x speed" base) ───────────────────────────────

const BASE: Required<Omit<ThumbnailTransitionConfig, 'kind' | 'easing'>> & {
  kind: ThumbnailTransitionKind; easing: 'spring-snappy' | 'spring-smooth' | 'spring-gentle';
} = {
  kind: 'hard-cut',
  holdAtFullMs: 250,
  zoomDurationMs: 650,
  holdAtTargetMs: 350,
  easing: 'spring-smooth',
};

const EASINGS = ['spring-snappy', 'spring-smooth', 'spring-gentle'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Reconstruct the speed multiplier from a stored config, relative to BASE. */
export function speedFromConfig(t: ThumbnailTransitionConfig | undefined): number {
  if (!t) return 1;
  const zoom = t.zoomDurationMs ?? BASE.zoomDurationMs;
  return zoom > 0 ? BASE.zoomDurationMs / zoom : 1;
}

/** Apply a speed multiplier to BASE durations, preserving kind + easing. */
export function configForSpeed(
  speed: number,
  kind: ThumbnailTransitionKind,
  easing: typeof BASE['easing'],
): ThumbnailTransitionConfig {
  const s = Math.max(0.1, speed);
  return {
    kind,
    holdAtFullMs: Math.round(BASE.holdAtFullMs / s),
    zoomDurationMs: Math.round(BASE.zoomDurationMs / s),
    holdAtTargetMs: Math.round(BASE.holdAtTargetMs / s),
    easing,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface TransitionDialogProps {
  /** Title shown at the top, e.g. "Section transition · shot 3" or "Default transition". */
  title: string;
  /** Helper text under the title. */
  description: string;
  /** Current persisted value (row override OR doc default). */
  current: ThumbnailTransitionConfig | undefined;
  /** For row dialogs: the doc-level default the row falls back to. */
  fallback?: ThumbnailTransitionConfig;
  /** Label on the destructive button. "Reset to default" for a row,
   *  "Reset to built-in default" for the doc-level default. */
  resetLabel: string;
  onSave: (t: ThumbnailTransitionConfig) => void;
  onReset: () => void;
  onClose: () => void;
}

export function TransitionDialog({
  title, description, current, fallback,
  resetLabel, onSave, onReset, onClose,
}: TransitionDialogProps) {
  const startingPoint = current ?? fallback;
  const [kind, setKind] = useState<ThumbnailTransitionKind>(startingPoint?.kind ?? BASE.kind);
  const [speed, setSpeed] = useState<number>(speedFromConfig(startingPoint));
  const [easing, setEasing] = useState<typeof BASE.easing>(startingPoint?.easing ?? BASE.easing);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const computed = configForSpeed(speed, kind, easing);

  const dialog = (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#0f1115', borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.10)',
          width: 'min(440px, 95vw)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {description}
          </div>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Kind toggle */}
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Style
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['hard-cut', 'smooth', 'none'] as ThumbnailTransitionKind[]).map(k => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  style={{
                    flex: 1,
                    fontSize: 12,
                    fontWeight: kind === k ? 600 : 400,
                    padding: '10px 12px',
                    borderRadius: 6,
                    background: kind === k ? 'rgba(168,85,247,0.18)' : 'rgba(255,255,255,0.04)',
                    color: kind === k ? '#c084fc' : 'var(--text)',
                    border: `1px solid ${kind === k ? 'rgba(168,85,247,0.40)' : 'rgba(255,255,255,0.10)'}`,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div>
                    {k === 'hard-cut' && 'Hard cut'}
                    {k === 'smooth' && 'Smooth zoom'}
                    {k === 'none' && 'None'}
                  </div>
                  <div style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--text-muted)', marginTop: 2 }}>
                    {k === 'hard-cut' && 'Cut between sections, fresh zoom-in each time.'}
                    {k === 'smooth' && 'Smoothly zoom out then in across sections.'}
                    {k === 'none' && 'No animation — land on the region instantly.'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Speed + Easing only apply when there's actual motion. Hidden
              for kind === 'none' so the dialog stays honest — the
              creator can't tweak a knob that has no effect. */}
          {kind !== 'none' && (
            <>
              {/* Speed slider */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Speed
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                    {speed.toFixed(2)}×
                  </div>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                  hold {computed.holdAtFullMs}ms · zoom {computed.zoomDurationMs}ms · settle {computed.holdAtTargetMs}ms
                </div>
              </div>

              {/* Easing */}
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Easing
                </div>
                <select
                  value={easing}
                  onChange={(e) => setEasing(e.target.value as typeof BASE.easing)}
                  style={{
                    width: '100%',
                    fontSize: 12,
                    padding: '8px 10px',
                    borderRadius: 6,
                    background: 'rgba(255,255,255,0.04)',
                    color: 'var(--text)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    cursor: 'pointer',
                  }}
                >
                  {EASINGS.map(e => (
                    <option key={e} value={e}>
                      {e === 'spring-snappy' && 'Snappy — tight, punchy'}
                      {e === 'spring-smooth' && 'Smooth — balanced (default)'}
                      {e === 'spring-gentle' && 'Gentle — slow, cinematic'}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <button
            onClick={onReset}
            disabled={!current}
            title={current ? resetLabel : 'No override set'}
            style={{
              fontSize: 12,
              padding: '6px 12px',
              borderRadius: 6,
              background: 'transparent',
              color: current ? 'var(--text-muted)' : 'rgba(255,255,255,0.25)',
              border: '1px solid rgba(255,255,255,0.10)',
              cursor: current ? 'pointer' : 'not-allowed',
            }}
          >
            {resetLabel}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                fontSize: 12,
                padding: '6px 14px',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid rgba(255,255,255,0.10)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(computed)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 16px',
                borderRadius: 6,
                background: '#8b5cf6',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(dialog, document.body);
}
