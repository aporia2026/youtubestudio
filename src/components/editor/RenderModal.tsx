'use client';

/**
 * Editor render-to-MP4 modal — Batch E of
 * `_plans/2026-05-20-editor-prod-doc-parity-batches.md`.
 *
 * Visible while the editor is rendering the project to MP4 via the
 * existing `/api/render/video` pipeline (same Lambda the production-
 * doc page uses). Four discrete UI states driven by `status`:
 *
 *   - `rendering` — progress bar + percent + cancel-to-background
 *     option (close button stays).
 *   - `done`      — download CTA + dismiss.
 *   - `error`     — message + retry CTA + dismiss.
 *
 * Stateless wrt the actual render: all state lives in EditorClient
 * (renderStatus / renderProgress / renderDownloadUrl / renderError).
 * The component only renders + invokes the callbacks.
 *
 * Risks: rendering bugs now have TWO surfaces (this + production-doc).
 * Mitigation: both pages call the same POST and the same poll loop;
 * the only divergence is the UI chrome. The config builder lives in
 * `productionDocToVideoConfig` — there's no duplicated pipeline logic.
 */

import { CheckCircle2, Download, Loader2, X, XCircle } from 'lucide-react';

export type RenderState =
  | { status: 'rendering'; progress: number; renderId: string | null }
  | { status: 'done'; downloadUrl: string | null; renderId: string | null }
  | { status: 'error'; message: string };

interface RenderModalProps {
  state: RenderState;
  onClose: () => void;
  onRetry: () => void;
}

export function RenderModal({ state, onClose, onRetry }: RenderModalProps): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={(e) => {
        // Click-outside dismisses ONLY when the render is in a terminal
        // state. Mid-render we don't want a stray click to lose the
        // user's only progress indicator (the job keeps running
        // server-side either way, but the UX is confusing without it).
        if (state.status === 'rendering') return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="editor-panel max-w-md w-full p-6"
        style={{
          background: 'var(--editor-panel)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="render-modal-title"
      >
        {state.status === 'rendering' && <RenderingBody state={state} onClose={onClose} />}
        {state.status === 'done' && <DoneBody state={state} onClose={onClose} />}
        {state.status === 'error' && (
          <ErrorBody state={state} onClose={onClose} onRetry={onRetry} />
        )}
      </div>
    </div>
  );
}

function RenderingBody({
  state,
  onClose,
}: {
  state: Extract<RenderState, { status: 'rendering' }>;
  onClose: () => void;
}): React.ReactElement {
  const pct = Math.max(0, Math.min(100, Math.round((state.progress ?? 0) * 100)));
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <Loader2 size={18} strokeWidth={2} className="animate-spin" style={{ color: 'var(--editor-accent)' }} />
          <h2 id="render-modal-title" className="text-base font-semibold" style={{ color: 'var(--fg)' }}>
            Rendering your video
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="editor-icon-btn"
          title="Hide this dialog — render keeps running server-side"
          aria-label="Hide"
          style={{ width: 28, height: 28 }}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <p className="text-xs mb-3" style={{ color: 'var(--fg-muted)' }}>
        Frame-by-frame render on Lambda. Typical runtime is 30s–2min depending on
        shot count and clip durations. You can close this dialog and keep
        editing — we'll surface the result when it's ready.
      </p>

      <div
        className="rounded-md overflow-hidden"
        style={{ background: 'var(--editor-panel-hover)', height: 8 }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'var(--editor-accent)',
            transition: 'width 200ms ease-out',
          }}
        />
      </div>
      <div className="flex items-center justify-between mt-2">
        <span className="text-[10px] tabular-nums ed-mono" style={{ color: 'var(--fg-muted)' }}>
          {pct}%
        </span>
        {state.renderId && (
          <span className="text-[10px] ed-mono" style={{ color: 'var(--fg-muted)' }}>
            ID: {state.renderId.slice(0, 8)}…
          </span>
        )}
      </div>
    </>
  );
}

function DoneBody({
  state,
  onClose,
}: {
  state: Extract<RenderState, { status: 'done' }>;
  onClose: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <CheckCircle2 size={20} strokeWidth={2} style={{ color: '#22c55e' }} />
          <h2 id="render-modal-title" className="text-base font-semibold" style={{ color: 'var(--fg)' }}>
            Render complete
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="editor-icon-btn"
          aria-label="Close"
          style={{ width: 28, height: 28 }}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--fg-muted)' }}>
        Your MP4 is ready. The download link streams direct from R2 — no Vercel
        function involved, so multi-GB files don't time out.
      </p>
      {state.downloadUrl ? (
        <a
          href={state.downloadUrl}
          className="editor-btn editor-btn-primary justify-center"
          style={{ width: '100%' }}
          target="_blank"
          rel="noreferrer"
        >
          <Download size={14} strokeWidth={2} />
          <span>Download MP4</span>
        </a>
      ) : (
        <div className="text-xs" style={{ color: 'var(--fg-muted)' }}>
          Server didn't return a download URL — open Production Doc to fetch.
        </div>
      )}
    </>
  );
}

function ErrorBody({
  state,
  onClose,
  onRetry,
}: {
  state: Extract<RenderState, { status: 'error' }>;
  onClose: () => void;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <XCircle size={20} strokeWidth={2} style={{ color: '#ef4444' }} />
          <h2 id="render-modal-title" className="text-base font-semibold" style={{ color: 'var(--fg)' }}>
            Render failed
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="editor-icon-btn"
          aria-label="Close"
          style={{ width: 28, height: 28 }}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <p className="text-xs mb-2" style={{ color: 'var(--fg-muted)' }}>
        Something went wrong server-side. Common causes:
      </p>
      <ul
        className="text-[11px] mb-3 ml-4 list-disc space-y-0.5"
        style={{ color: 'var(--fg-muted)' }}
      >
        <li>One of the per-shot media URLs returned 403 / timed out.</li>
        <li>Voiceover MP3 was rotated mid-render (the proxy URL no longer resolves).</li>
        <li>Lambda concurrency limit — retry in a few seconds.</li>
      </ul>
      {state.message && (
        <div
          className="text-[11px] rounded p-2 mb-3 ed-mono break-words"
          style={{ background: 'rgba(239,68,68,0.12)', color: '#fca5a5' }}
        >
          {state.message}
        </div>
      )}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onClose}
          className="editor-btn"
          style={{ flex: 1, justifyContent: 'center' }}
        >
          <span>Dismiss</span>
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="editor-btn editor-btn-primary"
          style={{ flex: 1, justifyContent: 'center' }}
        >
          <span>Retry render</span>
        </button>
      </div>
    </>
  );
}
