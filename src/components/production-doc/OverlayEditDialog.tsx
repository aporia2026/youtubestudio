"use client";

/**
 * AI-edit dialog for an overlay image — Phase 5 of
 * `_plans/2026-05-18-overlay-system-overhaul.md`.
 *
 * Two edit modes, selected by tab:
 *
 *   - Smart edit (default per council) — Nano Banana 2 via Kie. Prompt
 *     only, no mask. ~$0.034/edit batch. Best for "make it blue", "remove
 *     the tagline", "make it 3D". The 80% case.
 *
 *   - Brush mask — GPT-image-1.5 via Kie with paint mask. Opens the
 *     existing MaskBrushEditor as a sub-modal; on its onApply, fires
 *     the edit call against /api/overlay/edit?mode=brush. Best for
 *     "regenerate just this region" — the 20% case where prompt-only
 *     can't target precisely.
 *
 * Flow within the dialog:
 *   1. User picks a mode and submits.
 *   2. Loading spinner while /api/overlay/edit is in flight.
 *   3. Result returns → preview the new overlay alongside the original
 *      with Accept | Discard buttons.
 *   4. Accept → calls onAccept(newOverlayUrl) and closes.
 *   5. Discard → wipes the pending result and returns to step 1 so the
 *      user can iterate without losing the original.
 *
 * No edit history yet — the dialog is a one-shot apply surface. Phase 5.1
 * can add a per-overlay history array if users actually need to revert
 * past edits.
 *
 * Cost is surfaced inline so the user knows what each apply costs. The
 * brush-mask quality tier lives on the MaskBrushEditor itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MaskBrushEditor } from './MaskBrushEditor';
import { getEditOption, type EditOption } from '@/lib/image-edit-pricing';

interface OverlayEditDialogProps {
  /** Current overlay URL — used as the source for any edit. The
   *  dialog snapshots this value at mount; subsequent prop changes
   *  to the SAME mounted dialog (e.g. a parallel Replace updating
   *  the row's overlay state) DO NOT affect the in-flight edit's
   *  source, and the `replacedUrl` passed to `onAccept` is always
   *  the URL the user opened the dialog with. */
  overlayUrl: string;
  /** Terms label shown in the header so the user knows which overlay
   *  they're editing if several rows are open across the doc. */
  termsLabel: string;
  /** Called when the user clicks Accept on a pending edit result.
   *  `replacedUrl` is the snapshot of `overlayUrl` at dialog mount,
   *  passed back so the parent can push the CORRECT old URL onto the
   *  edit-history stack — even if a concurrent Replace mutated the
   *  row's overlay slot between dialog mount and accept. */
  onAccept: (newOverlayUrl: string, mode: 'smart' | 'brush', replacedUrl: string) => void;
  onClose: () => void;
}

type EditMode = 'smart' | 'brush';

/** The overlay edit route only knows the GPT-4o backend; the brush
 *  picker is restricted accordingly so the user can't pick an option
 *  the server can't handle. Hoisted out of the component so we don't
 *  recreate the array on every render (it's passed by reference to
 *  MaskBrushEditor). */
const OVERLAY_ALLOWED_OPTION_IDS = ['gpt-4o-low', 'gpt-4o-medium', 'gpt-4o-high'] as const;

export function OverlayEditDialog({
  overlayUrl,
  termsLabel,
  onAccept,
  onClose,
}: OverlayEditDialogProps) {
  const [mode, setMode] = useState<EditMode>('smart');
  const [smartPrompt, setSmartPrompt] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingResultUrl, setPendingResultUrl] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<EditMode | null>(null);
  const [brushOpen, setBrushOpen] = useState(false);
  /** When true, the route re-runs Bria RMBG on the edit output so any
   *  background the model accidentally introduced is removed before
   *  the result reaches preview. Default on — overlays are transparent
   *  PNGs by contract and Nano Banana / GPT-image sometimes inject a
   *  background even when prompted otherwise. Adds ~$0.018-0.058 per
   *  edit on top of the model cost. */
  const [autoRmbg, setAutoRmbg] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Snapshot of the overlay URL the user opened the dialog with.
   *  Stays stable for the dialog's lifetime even if the row's overlay
   *  state mutates underneath (e.g., concurrent Replace from the
   *  context menu). All in-flight edits source from this snapshot,
   *  and `replacedUrl` reported back to the parent on Accept reflects
   *  this value — so the parent's edit-history push uses the URL the
   *  user actually saw + edited, not whatever live state is now. */
  const sourceUrlRef = useRef(overlayUrl);
  const sourceUrl = sourceUrlRef.current;

  /** AbortController for the in-flight /api/overlay/edit call. The
   *  dialog blocks closing while pending, but a parent unmount (route
   *  change, user navigates away) would otherwise leave the fetch
   *  running + the resolved-state setters firing on an unmounted
   *  component (React warning). Cleanup aborts the pending request. */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  // Lock page scroll while the dialog is open — same pattern as the
  // position editor + transition dialog so this feels like part of
  // the same modal family.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc to close, but only when nothing's pending — a half-finished edit
  // shouldn't vanish on an accidental key press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pendingResultUrl && !isWorking && !brushOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingResultUrl, isWorking, brushOpen, onClose]);

  // Focus the textarea when smart mode opens so the user can just
  // start typing — saves a click on the common path.
  useEffect(() => {
    if (mode === 'smart' && !pendingResultUrl && !brushOpen) {
      textareaRef.current?.focus();
    }
  }, [mode, pendingResultUrl, brushOpen]);

  const applySmartEdit = useCallback(async () => {
    const promptTrimmed = smartPrompt.trim();
    if (!promptTrimmed) {
      setError('Type a prompt first — e.g. "make the logo blue" or "remove the tagline".');
      return;
    }
    setError(null);
    setIsWorking(true);
    console.info('[overlay edit] smart edit submit', {
      overlayUrl: sourceUrl,
      promptLength: promptTrimmed.length,
    });
    // Replace any prior controller (no concurrent requests via Apply
    // because the button disables on isWorking, but defensive).
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch('/api/overlay/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'smart',
          overlayUrl: sourceUrl,
          prompt: promptTrimmed,
          rerunRmbg: autoRmbg,
        }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        overlayUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.overlayUrl) {
        setError(data.error || `Edit failed (HTTP ${res.status})`);
        return;
      }
      setPendingResultUrl(data.overlayUrl);
      setPendingMode('smart');
      console.info('[overlay edit] smart edit result', { newUrl: data.overlayUrl });
    } catch (err) {
      // AbortError = parent unmounted us, don't show an alert.
      if (err instanceof Error && err.name === 'AbortError') {
        console.info('[overlay edit] smart edit aborted (dialog unmounted)');
        return;
      }
      setError(err instanceof Error ? err.message : 'Edit request failed');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsWorking(false);
    }
  }, [sourceUrl, smartPrompt, autoRmbg]);

  // `quality` field for the overlay edit route is derived from the
  // selected GPT-4o option below. Default tier = medium.
  const [brushOption, setBrushOption] = useState<EditOption>(
    () => getEditOption('gpt-4o-medium')!,
  );

  const applyBrushEdit = useCallback(
    async (args: { maskUrl: string; prompt: string; option: EditOption }) => {
      setBrushOpen(false);
      setError(null);
      setIsWorking(true);
      // The route only accepts GPT-4o, which the option picker is
      // restricted to via `allowedOptionIds`. The narrowing here is
      // defensive — if a stale option somehow slips through, fall
      // back to medium rather than send an invalid quality.
      const quality: 'low' | 'medium' | 'high' =
        args.option.backend.kind === 'kie-gpt4o' ? args.option.backend.quality : 'medium';
      console.info('[overlay edit] brush edit submit', {
        overlayUrl: sourceUrl,
        maskUrl: args.maskUrl,
        optionId: args.option.id,
        quality,
        promptLength: args.prompt.length,
      });
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch('/api/overlay/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'brush',
            overlayUrl: sourceUrl,
            prompt: args.prompt,
            mask: { url: args.maskUrl, quality },
            rerunRmbg: autoRmbg,
          }),
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => ({}))) as {
          overlayUrl?: string;
          error?: string;
        };
        if (!res.ok || !data.overlayUrl) {
          setError(data.error || `Edit failed (HTTP ${res.status})`);
          return;
        }
        setPendingResultUrl(data.overlayUrl);
        setPendingMode('brush');
        console.info('[overlay edit] brush edit result', { newUrl: data.overlayUrl });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          console.info('[overlay edit] brush edit aborted (dialog unmounted)');
          return;
        }
        setError(err instanceof Error ? err.message : 'Edit request failed');
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setIsWorking(false);
      }
    },
    [sourceUrl, autoRmbg],
  );

  const acceptPending = useCallback(() => {
    if (!pendingResultUrl || !pendingMode) return;
    console.info('[overlay edit] accept', {
      newUrl: pendingResultUrl,
      mode: pendingMode,
      replacedUrl: sourceUrl,
    });
    onAccept(pendingResultUrl, pendingMode, sourceUrl);
    onClose();
  }, [pendingResultUrl, pendingMode, onAccept, onClose, sourceUrl]);

  const discardPending = useCallback(() => {
    console.info('[overlay edit] discard pending result');
    setPendingResultUrl(null);
    setPendingMode(null);
    setError(null);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────

  const checkerBg =
    'repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 16px 16px';

  const dialog = (
    <>
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget && !pendingResultUrl && !isWorking && !brushOpen) {
            onClose();
          }
        }}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: 'rgba(0,0,0,0.78)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <div
          style={{
            background: '#0f1115',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.10)',
            width: 'min(720px, 95vw)',
            maxHeight: '90vh',
            overflow: 'auto',
            boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
              Edit overlay image
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {pendingResultUrl
                ? 'Review the result. Accept to replace the overlay, or Discard to try another edit.'
                : 'Smart edit handles the 80% case with a sentence. Brush mask is the precise escape hatch.'}
              <span style={{ color: '#fbbf24', marginLeft: 6 }}>✦ {termsLabel}</span>
            </div>
          </div>

          {/* Pending-result preview takes over the body — the user is
              deciding between Accept and Discard, no edit affordances. */}
          {pendingResultUrl ? (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Before
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sourceUrl}
                    alt="overlay before edit"
                    style={{ width: '100%', height: 240, objectFit: 'contain', background: checkerBg, borderRadius: 6 }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 10, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    After ({pendingMode === 'smart' ? 'smart edit' : 'brush mask'})
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={pendingResultUrl}
                    alt="overlay after edit"
                    style={{
                      width: '100%',
                      height: 240,
                      objectFit: 'contain',
                      background: checkerBg,
                      borderRadius: 6,
                      outline: '1px solid rgba(168,85,247,0.40)',
                    }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Mode tabs. Pinned-pill style so it's obvious which is
                  active — and the inactive tab still looks clickable so
                  the user knows they have a choice. */}
              <div style={{ display: 'flex', gap: 4, padding: 3, background: 'rgba(255,255,255,0.04)', borderRadius: 8, alignSelf: 'flex-start' }}>
                <button
                  type="button"
                  onClick={() => setMode('smart')}
                  disabled={isWorking}
                  style={{
                    fontSize: 12,
                    padding: '6px 14px',
                    borderRadius: 6,
                    background: mode === 'smart' ? 'rgba(168,85,247,0.20)' : 'transparent',
                    color: mode === 'smart' ? '#c084fc' : 'var(--text-muted)',
                    border: 'none',
                    cursor: isWorking ? 'not-allowed' : 'pointer',
                    fontWeight: mode === 'smart' ? 600 : 400,
                  }}
                >
                  Smart edit
                </button>
                <button
                  type="button"
                  onClick={() => setMode('brush')}
                  disabled={isWorking}
                  style={{
                    fontSize: 12,
                    padding: '6px 14px',
                    borderRadius: 6,
                    background: mode === 'brush' ? 'rgba(168,85,247,0.20)' : 'transparent',
                    color: mode === 'brush' ? '#c084fc' : 'var(--text-muted)',
                    border: 'none',
                    cursor: isWorking ? 'not-allowed' : 'pointer',
                    fontWeight: mode === 'brush' ? 600 : 400,
                  }}
                >
                  Brush mask
                </button>
              </div>

              {/* Source preview — small thumbnail so the user keeps the
                  reference visible while writing prompts. */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sourceUrl}
                  alt="overlay source"
                  style={{ width: 120, height: 120, objectFit: 'contain', background: checkerBg, borderRadius: 6, flexShrink: 0 }}
                />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  {mode === 'smart' ? (
                    <>
                      <label htmlFor="overlay-edit-prompt" style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        What to change
                      </label>
                      <textarea
                        id="overlay-edit-prompt"
                        ref={textareaRef}
                        value={smartPrompt}
                        onChange={(e) => setSmartPrompt(e.target.value)}
                        placeholder='e.g. "make the logo blue", "remove the tagline below"'
                        rows={4}
                        maxLength={2000}
                        disabled={isWorking}
                        style={{
                          fontSize: 13,
                          padding: '8px 10px',
                          borderRadius: 6,
                          background: 'rgba(255,255,255,0.04)',
                          color: 'var(--text)',
                          border: '1px solid rgba(255,255,255,0.10)',
                          resize: 'vertical',
                          fontFamily: 'inherit',
                          width: '100%',
                        }}
                      />
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        ~$0.02 per edit · Nano Banana (Gemini 2.5 Flash Image) segments the region the prompt describes.
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        Paint the region of the overlay you want to change, then type a prompt for the new content. GPT-image-1.5 regenerates only the painted pixels.
                      </div>
                      <button
                        type="button"
                        onClick={() => setBrushOpen(true)}
                        disabled={isWorking}
                        style={{
                          fontSize: 12,
                          padding: '8px 14px',
                          borderRadius: 6,
                          background: 'rgba(168,85,247,0.22)',
                          color: '#c084fc',
                          border: '1px solid rgba(168,85,247,0.45)',
                          cursor: isWorking ? 'not-allowed' : 'pointer',
                          alignSelf: 'flex-start',
                        }}
                      >
                        🖌 Open brush editor →
                      </button>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        $0.034 medium / $0.133 high · cost set in the brush editor.
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Auto-RMBG toggle. Default on — overlays are transparent
                  PNGs by contract, but the edit models sometimes inject
                  a background. The route re-runs Bria RMBG when this is
                  on, applying the Phase 4 gate so an over-aggressive
                  RMBG doesn't ship a blank PNG. Off = use the model's
                  raw output verbatim. */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  cursor: isWorking ? 'not-allowed' : 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={autoRmbg}
                  onChange={(e) => setAutoRmbg(e.target.checked)}
                  disabled={isWorking}
                  style={{ cursor: 'inherit' }}
                />
                <span>
                  Auto-remove background after edit
                  <span style={{ marginLeft: 4, opacity: 0.7 }}>
                    (+~$0.02; recommended — strips any backdrop the model adds)
                  </span>
                </span>
              </label>

              {error && (
                <div
                  role="alert"
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    padding: '6px 10px',
                    background: 'rgba(239,68,68,0.10)',
                    border: '1px solid rgba(239,68,68,0.30)',
                    borderRadius: 4,
                  }}
                >
                  {error}
                </div>
              )}
            </div>
          )}

          <div
            style={{
              padding: '12px 18px',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
            }}
          >
            {pendingResultUrl ? (
              <>
                <button
                  type="button"
                  onClick={discardPending}
                  style={{
                    fontSize: 12,
                    padding: '8px 14px',
                    borderRadius: 6,
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    cursor: 'pointer',
                  }}
                >
                  Discard, try again
                </button>
                <button
                  type="button"
                  onClick={acceptPending}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '8px 14px',
                    borderRadius: 6,
                    background: 'rgba(74,222,128,0.20)',
                    color: '#4ade80',
                    border: '1px solid rgba(74,222,128,0.45)',
                    cursor: 'pointer',
                  }}
                >
                  Accept — replace overlay
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isWorking}
                  style={{
                    fontSize: 12,
                    padding: '8px 14px',
                    borderRadius: 6,
                    background: 'transparent',
                    color: 'var(--text)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    cursor: isWorking ? 'not-allowed' : 'pointer',
                  }}
                >
                  Cancel
                </button>
                {mode === 'smart' && (
                  <button
                    type="button"
                    onClick={applySmartEdit}
                    disabled={isWorking || !smartPrompt.trim()}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '8px 14px',
                      borderRadius: 6,
                      background: 'rgba(168,85,247,0.22)',
                      color: '#c084fc',
                      border: '1px solid rgba(168,85,247,0.45)',
                      cursor: isWorking || !smartPrompt.trim() ? 'not-allowed' : 'pointer',
                      opacity: isWorking || !smartPrompt.trim() ? 0.6 : 1,
                    }}
                  >
                    {isWorking ? 'Editing…' : 'Apply smart edit'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Brush editor mounts on top of this dialog. On its onApply we
          fire the brush-mode call directly — the brush editor closes
          itself by calling its own onCancel before onApply resolves. */}
      {brushOpen && (
        <MaskBrushEditor
          sourceImageUrl={sourceUrl}
          option={brushOption}
          onOptionChange={setBrushOption}
          allowedOptionIds={OVERLAY_ALLOWED_OPTION_IDS}
          onCancel={() => setBrushOpen(false)}
          onApply={(args) => applyBrushEdit(args)}
        />
      )}
    </>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(dialog, document.body);
}
