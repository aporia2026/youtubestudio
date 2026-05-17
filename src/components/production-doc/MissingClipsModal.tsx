"use client";

/**
 * Pre-render verification modal. Shown by `startVideoRender` when the
 * page's `rowVideoClips` state is missing clips that EXIST in the
 * per-cell localStorage signature map (i.e. the user already paid for
 * the clips, but a state-loss event — quota-exceeded persist, history
 * sidebar restore, manual storage clear — left them unloaded).
 *
 * The modal has three exits:
 *   - "Reload missing clips" (primary) → fetches each `/api/broll/{id}`,
 *     propagates results into parent state, calls `onContinue` once the
 *     final missing list is empty.
 *   - "Render anyway" (destructive) → user explicitly accepts a render
 *     that won't include the missing animations. Calls `onRenderAnyway`.
 *   - "Cancel" → closes the modal, doesn't render.
 *
 * See `_plans/2026-05-17-render-state-hardening.md`.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MissingClip {
  rowIndex: number;
  clipId: string;
  signature: string;
}

interface MissingClipsModalProps {
  /** Clips known to exist (per the per-cell localStorage map) but
   *  missing from the page's render-state. */
  missing: MissingClip[];
  /** True while the reload pipeline is in flight. The modal swaps its
   *  primary button to a spinner and disables the destructive exit. */
  reloading: boolean;
  /** Fetches each missing clip + brings them into state. Returns the
   *  still-missing list (empty array on full success). */
  onReload: (missing: MissingClip[]) => Promise<MissingClip[]>;
  /** Called when reload succeeded (final missing list is empty) AND
   *  the modal should proceed with the render. */
  onContinue: () => void | Promise<void>;
  /** Called when the user explicitly accepts a render without the
   *  missing animations. The page logs `[render skipped-reload]`. */
  onRenderAnyway: () => void | Promise<void>;
  onClose: () => void;
  /** Setter for the modal state — the modal owns transitions of
   *  `reloading` and the post-reload `missing` list during its lifecycle. */
  onMissingChange: (next: MissingClip[]) => void;
  onReloadingChange: (next: boolean) => void;
}

export function MissingClipsModal({
  missing,
  reloading,
  onReload,
  onContinue,
  onRenderAnyway,
  onClose,
  onMissingChange,
  onReloadingChange,
}: MissingClipsModalProps) {
  const [confirmingRenderAnyway, setConfirmingRenderAnyway] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !reloading) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, reloading]);

  const handleReload = async () => {
    onReloadingChange(true);
    try {
      const stillMissing = await onReload(missing);
      onMissingChange(stillMissing);
      if (stillMissing.length === 0) {
        // Caller closes the modal before triggering the render so a
        // race between the modal unmount and the next render's state
        // update doesn't show a stale modal flash.
        await onContinue();
      }
    } finally {
      onReloadingChange(false);
    }
  };

  const handleRenderAnyway = async () => {
    if (!confirmingRenderAnyway) {
      setConfirmingRenderAnyway(true);
      return;
    }
    await onRenderAnyway();
  };

  const dialog = (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !reloading) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#0f1115',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.10)',
          width: 'min(560px, 95vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
            ⚠ Missing animations
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {missing.length} animation{missing.length === 1 ? '' : 's'} {missing.length === 1 ? 'was' : 'were'} generated for this doc but {missing.length === 1 ? "isn't" : "aren't"} loaded in this session. Rendering now would silently produce a stills-only video. <strong>You already paid for these.</strong>
          </div>
        </div>

        <div style={{ padding: '14px 18px', overflowY: 'auto', flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            Affected rows
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {missing.map(m => (
              <div
                key={m.signature}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'rgba(239,68,68,0.06)',
                  border: '1px solid rgba(239,68,68,0.20)',
                  fontSize: 12,
                }}
              >
                <span style={{ color: 'var(--text)' }}>Row {m.rowIndex + 1}</span>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 10 }}>
                  clip {m.clipId.slice(0, 8)}…
                </span>
              </div>
            ))}
          </div>
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 18px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          <button
            type="button"
            onClick={handleRenderAnyway}
            disabled={reloading}
            style={{
              fontSize: 12,
              padding: '6px 12px',
              borderRadius: 6,
              background: confirmingRenderAnyway ? 'rgba(239,68,68,0.15)' : 'transparent',
              color: confirmingRenderAnyway ? '#f87171' : 'var(--text-muted)',
              border: `1px solid ${confirmingRenderAnyway ? 'rgba(239,68,68,0.40)' : 'rgba(255,255,255,0.10)'}`,
              cursor: reloading ? 'not-allowed' : 'pointer',
              opacity: reloading ? 0.4 : 1,
            }}
          >
            {confirmingRenderAnyway ? 'Confirm: render without animations' : 'Render anyway'}
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={reloading}
              style={{
                fontSize: 12,
                padding: '6px 14px',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid rgba(255,255,255,0.10)',
                cursor: reloading ? 'not-allowed' : 'pointer',
                opacity: reloading ? 0.4 : 1,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleReload}
              disabled={reloading}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 16px',
                borderRadius: 6,
                background: '#22d3ee',
                color: '#0f1115',
                border: 'none',
                cursor: reloading ? 'wait' : 'pointer',
                minWidth: 160,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {reloading ? (
                <>
                  <span className="spinner" style={{ width: 12, height: 12 }} />
                  Reloading…
                </>
              ) : (
                `Reload ${missing.length} clip${missing.length === 1 ? '' : 's'}`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(dialog, document.body);
}
