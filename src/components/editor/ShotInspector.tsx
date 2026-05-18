'use client';

/**
 * Shot inspector — the side panel for a selected shot.
 *
 * Phase 3 of `_plans/2026-05-18-shot-graph-editor.md`. Hosts the
 * editing surfaces that don't make sense on the timeline strip
 * itself: script text, visual description, AI image prompt, replace
 * media buttons, regenerate-shot, rewrite-script-with-AI.
 *
 * Each Phase 3 follow-up commit lands one capability here:
 *
 *   ✓ Upload an image           — this commit
 *     · Pick a clip from project  (next)
 *     · Regenerate from prompt    (after that)
 *     · Rewrite script-with-AI    (final Phase 3 commit)
 */
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import type { VideoShot } from '@/remotion/types';

interface ShotInspectorProps {
  shotIndex: number;
  shot: VideoShot;
  row: ProductionDoc['rows'][number];
  /** rowImages[shotIndex] — first-frame thumbnail URL when present. */
  thumbnailUrl: string | null;
  totalShots: number;
  onClose: () => void;
  /** Called with the new R2 URL after a successful upload. The
   *  caller dispatches SET_ROW_IMAGE. */
  onUploadImage?: (url: string) => void;
}

function fmt(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

const ACCEPT_IMAGE_TYPES = 'image/jpeg,image/png,image/webp,image/gif';

export function ShotInspector({
  shotIndex,
  shot,
  row,
  thumbnailUrl,
  totalShots,
  onClose,
  onUploadImage,
}: ShotInspectorProps): React.ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading'; fileName: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting the same file
      if (!file || !onUploadImage) return;

      setUploadState({ kind: 'uploading', fileName: file.name });
      try {
        // 1. Mint a presigned PUT URL.
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
          throw new Error(data.error || `Presign failed: HTTP ${presignRes.status}`);
        }
        const { uploadUrl, downloadUrl } = (await presignRes.json()) as {
          uploadUrl: string;
          downloadUrl: string;
        };

        // 2. PUT the file directly to R2 (bypassing Vercel's body cap).
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        if (!putRes.ok) {
          throw new Error(`Upload failed: HTTP ${putRes.status}`);
        }

        // 3. Hand the new URL to the editor — the store dispatches
        //    SET_ROW_IMAGE and the player + thumbnail update on the
        //    next render.
        console.info('[editor inspector] upload complete', {
          shotIndex,
          downloadUrl,
        });
        onUploadImage(downloadUrl);
        setUploadState({ kind: 'idle' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[editor inspector] upload failed', { detail: message });
        setUploadState({ kind: 'error', message });
      }
    },
    [onUploadImage, shotIndex],
  );

  return (
    <aside
      className="rounded-lg border overflow-hidden flex flex-col"
      style={{
        borderColor: 'var(--card-border)',
        background: 'var(--card-bg)',
        width: 380,
        maxWidth: '100%',
      }}
      aria-label="Selected shot inspector"
    >
      <header
        className="px-4 py-3 flex items-center justify-between border-b"
        style={{ borderColor: 'var(--card-border)' }}
      >
        <div>
          <div className="text-sm font-semibold">
            Shot {shotIndex + 1} <span style={{ color: 'var(--fg-muted)' }}>of {totalShots}</span>
          </div>
          <div className="text-[11px] tabular-nums" style={{ color: 'var(--fg-muted)' }}>
            {row.timecode || '—'} · {fmt(shot.durationMs)}
            {typeof row.duration_override_ms === 'number' && (
              <span style={{ color: 'var(--accent-purple-bright, #a78bfa)' }}> · edited</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2 py-1 rounded border hover:bg-white/5 transition-colors"
          style={{ borderColor: 'var(--card-border)' }}
          title="Close inspector"
        >
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {thumbnailUrl && (
          <div
            className="aspect-video relative"
            style={{ background: '#000' }}
          >
            <img
              src={thumbnailUrl}
              alt={`Shot ${shotIndex + 1} thumbnail`}
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
          </div>
        )}

        {/* Replace media — upload only in this commit. The
            from-project picker + regenerate-from-prompt land in
            follow-up commits next to this section. */}
        {onUploadImage && (
          <div
            className="p-3 border-b space-y-2"
            style={{ borderColor: 'var(--card-border)' }}
          >
            <div className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
              Replace image
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_IMAGE_TYPES}
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={handleUploadClick}
              disabled={uploadState.kind === 'uploading'}
              className="w-full text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
              style={{ borderColor: 'var(--card-border)' }}
            >
              {uploadState.kind === 'uploading'
                ? `Uploading ${uploadState.fileName}…`
                : 'Upload from disk'}
            </button>
            {uploadState.kind === 'error' && (
              <div className="text-[10px]" style={{ color: '#f87171' }}>
                {uploadState.message}
              </div>
            )}
            <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
              JPG, PNG, WebP, or GIF · max 10 MB. The new still replaces this shot
              immediately; Cmd/Ctrl+Z undoes.
            </div>
          </div>
        )}

        <div className="p-4 space-y-4 text-xs">
          {/* Visual_description — the prompt the doc generator wrote
              to drive image / video generation. Read-only in this
              commit; the rewrite-with-AI commit makes it editable. */}
          <Field label="Visual description" value={row.visual_description || '—'} />
          <Field label="AI image prompt" value={row.ai_image_prompt || '—'} mono />
          <Field
            label="Voiceover script"
            value={row.script_text || '—'}
            highlight={typeof row.muted === 'boolean' && row.muted ? 'muted' : null}
          />
          {row.on_screen_text && (
            <Field label="On-screen text" value={row.on_screen_text} />
          )}

          {(typeof row.trim_start_ms === 'number' || typeof row.trim_end_ms === 'number') && (
            <div
              className="p-2 rounded border space-y-1"
              style={{ borderColor: 'var(--card-border)' }}
            >
              <div className="font-medium" style={{ color: 'var(--fg)' }}>
                Trim
              </div>
              <div className="tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                Head: {fmt(row.trim_start_ms)} · Tail: {fmt(row.trim_end_ms)}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-1 text-[10px]">
            <Badge label={shot.sceneType} />
            {shot.videoUrl ? (
              <Badge label="animated" tone="purple" />
            ) : shot.imageUrl ? (
              <Badge label="still + Ken Burns" tone="default" />
            ) : (
              <Badge label="text card" tone="default" />
            )}
            {shot.muted && <Badge label="muted" tone="red" />}
          </div>
        </div>
      </div>

      <footer
        className="p-3 border-t text-[11px]"
        style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
      >
        Pick-from-project, regenerate, and rewrite-with-AI land in the next
        Phase 3 commits. For doc-wide edits, head back to{' '}
        <Link href="/production-doc" className="underline">
          Production Doc
        </Link>
        .
      </footer>
    </aside>
  );
}

interface FieldProps {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: 'muted' | null;
}

function Field({ label, value, mono = false, highlight = null }: FieldProps): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="font-medium" style={{ color: 'var(--fg)' }}>
        {label}
        {highlight === 'muted' && (
          <span className="ml-1" style={{ color: '#f87171' }}>
            (muted)
          </span>
        )}
      </div>
      <div
        className={mono ? 'font-mono whitespace-pre-wrap break-words' : 'whitespace-pre-wrap break-words'}
        style={{ color: 'var(--fg-muted)' }}
      >
        {value}
      </div>
    </div>
  );
}

interface BadgeProps {
  label: string;
  tone?: 'default' | 'purple' | 'red';
}

function Badge({ label, tone = 'default' }: BadgeProps): React.ReactElement {
  const palette = {
    default: { bg: 'rgba(255,255,255,0.08)', fg: 'var(--fg-muted)' },
    purple: { bg: 'rgba(167,139,250,0.18)', fg: 'var(--accent-purple-bright, #a78bfa)' },
    red: { bg: 'rgba(248,113,113,0.18)', fg: '#fca5a5' },
  }[tone];
  return (
    <span
      className="rounded px-1.5 py-0.5"
      style={{ background: palette.bg, color: palette.fg }}
    >
      {label}
    </span>
  );
}
