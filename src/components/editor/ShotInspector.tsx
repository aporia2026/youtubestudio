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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import type { VideoShot } from '@/remotion/types';

/** A clip from /api/broll. Trimmed to the fields the picker needs. */
interface ProjectClip {
  id: string;
  video_url: string | null;
  duration_seconds: number | null;
  prompt: string;
  model_id: string;
  aspect_ratio: string;
  status: string;
  row_index: number | null;
}

interface ShotInspectorProps {
  shotIndex: number;
  shot: VideoShot;
  row: ProductionDoc['rows'][number];
  /** rowImages[shotIndex] — first-frame thumbnail URL when present. */
  thumbnailUrl: string | null;
  totalShots: number;
  /** The user_history.id this project is keyed by. Used to scope
   *  the broll_clips list to clips from this doc. */
  projectId: string;
  onClose: () => void;
  /** Called with the new R2 URL after a successful upload. The
   *  caller dispatches SET_ROW_IMAGE. */
  onUploadImage?: (url: string) => void;
  /** Called when the user picks a clip from the project's broll
   *  library. The caller dispatches SET_ROW_VIDEO. Pass `null` for
   *  videoUrl to clear an existing pick. */
  onPickProjectClip?: (videoUrl: string | null, durationSeconds: number | null) => void;
  /** Called when the user edits the row's voiceover script (inline
   *  textarea OR via the AI rephrase button). Dispatches
   *  SET_ROW_SCRIPT. */
  onUpdateScript?: (text: string) => void;
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
  projectId,
  onClose,
  onUploadImage,
  onPickProjectClip,
  onUpdateScript,
}: ShotInspectorProps): React.ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading'; fileName: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const [regenState, setRegenState] = useState<
    | { kind: 'idle' }
    | { kind: 'generating' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const handleRegenerate = useCallback(async () => {
    if (!onUploadImage) return;
    const prompt = row.ai_image_prompt?.trim() || row.visual_description?.trim();
    if (!prompt) {
      setRegenState({
        kind: 'error',
        message: 'No prompt to regenerate from. Edit the row’s prompt first.',
      });
      return;
    }
    setRegenState({ kind: 'generating' });
    try {
      const res = await fetch('/api/generate/production-doc/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          onScreenText: row.on_screen_text ?? '',
          sectionTitle: row.section_title ?? '',
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Generate failed: HTTP ${res.status}`);
      }
      const data = (await res.json()) as { imageUrl?: string };
      if (typeof data.imageUrl !== 'string') {
        throw new Error('Server response missing imageUrl');
      }
      console.info('[editor inspector] regenerate complete', {
        shotIndex,
        imageUrl: data.imageUrl,
      });
      onUploadImage(data.imageUrl);
      setRegenState({ kind: 'idle' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[editor inspector] regenerate failed', { detail: message });
      setRegenState({ kind: 'error', message });
    }
  }, [onUploadImage, row.ai_image_prompt, row.visual_description, row.on_screen_text, row.section_title, shotIndex]);

  // Inline-edit + Rephrase state for the voiceover script field.
  // The textarea is a controlled mirror of `row.script_text`; we
  // commit on blur so the doc isn't rewritten on every keystroke.
  const [scriptDraft, setScriptDraft] = useState<string>(row.script_text ?? '');
  // Sync the draft when the row changes (e.g. user selects a
  // different shot). Compared by index to avoid clobbering an
  // in-progress edit when something else dirties the doc.
  const scriptSyncedFor = useRef<number>(shotIndex);
  if (scriptSyncedFor.current !== shotIndex) {
    scriptSyncedFor.current = shotIndex;
    // Mid-render setState would loop — schedule via microtask so
    // the next render uses the fresh draft.
    queueMicrotask(() => setScriptDraft(row.script_text ?? ''));
  }

  const commitScriptDraft = useCallback(() => {
    if (!onUpdateScript) return;
    const next = scriptDraft;
    const prev = row.script_text ?? '';
    if (next === prev) return;
    onUpdateScript(next);
  }, [onUpdateScript, row.script_text, scriptDraft]);

  const [rephraseState, setRephraseState] = useState<
    | { kind: 'idle' }
    | { kind: 'rephrasing'; style: 'same' | 'shorter' | 'longer' | 'simpler' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const handleRephrase = useCallback(
    async (style: 'same' | 'shorter' | 'longer' | 'simpler') => {
      if (!onUpdateScript) return;
      // Use the live draft if the user typed since the last commit;
      // otherwise the row's text. Either way we send the latest
      // value to the model.
      const text = (scriptDraft || row.script_text || '').trim();
      if (!text) {
        setRephraseState({ kind: 'error', message: 'No script text to rephrase.' });
        return;
      }
      setRephraseState({ kind: 'rephrasing', style });
      try {
        const res = await fetch('/api/edit/rephrase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, style }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Rephrase failed: HTTP ${res.status}`);
        }
        const data = (await res.json()) as { text?: string };
        const rephrased = typeof data.text === 'string' ? data.text.trim() : '';
        if (!rephrased) {
          throw new Error('Empty rephrase output');
        }
        setScriptDraft(rephrased);
        onUpdateScript(rephrased);
        setRephraseState({ kind: 'idle' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[editor inspector] rephrase failed', { detail: message });
        setRephraseState({ kind: 'error', message });
      }
    },
    [onUpdateScript, row.script_text, scriptDraft],
  );

  const [projectClips, setProjectClips] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'loaded'; clips: ProjectClip[] }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // Lazy-load the project's broll clips when the user expands the
  // picker. Avoids the per-shot mount cost when most users never
  // open it. Re-fetches on inspector mount if the projectId changes.
  const [showPicker, setShowPicker] = useState(false);
  useEffect(() => {
    if (!showPicker || projectClips.kind !== 'idle') return;
    let cancelled = false;
    setProjectClips({ kind: 'loading' });
    (async () => {
      try {
        const res = await fetch(`/api/broll?productionDocId=${encodeURIComponent(projectId)}&limit=200`);
        if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
        const data = (await res.json()) as { clips?: unknown };
        const raw = Array.isArray(data.clips) ? data.clips : [];
        const clips: ProjectClip[] = raw
          .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
          .map((c) => ({
            id: typeof c.id === 'string' ? c.id : '',
            video_url: typeof c.video_url === 'string' ? c.video_url : null,
            duration_seconds:
              typeof c.duration_seconds === 'number' ? c.duration_seconds : null,
            prompt: typeof c.prompt === 'string' ? c.prompt : '',
            model_id: typeof c.model_id === 'string' ? c.model_id : '',
            aspect_ratio: typeof c.aspect_ratio === 'string' ? c.aspect_ratio : '',
            status: typeof c.status === 'string' ? c.status : '',
            row_index: typeof c.row_index === 'number' ? c.row_index : null,
          }))
          // Only show clips that have a usable URL — pending / failed
          // rows are noise here. Keep the row-index ordering from the
          // server response.
          .filter((c) => c.id && c.status === 'ready' && c.video_url);
        if (!cancelled) {
          setProjectClips({ kind: 'loaded', clips });
        }
      } catch (err) {
        if (!cancelled) {
          setProjectClips({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showPicker, projectClips.kind, projectId]);

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

            {/* Regenerate from this row's current prompt. Calls the
                existing /api/generate/production-doc/image route so
                pricing + rate-limit + R2 mirroring behave identically
                to a Production-Doc-page regenerate. */}
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={regenState.kind === 'generating'}
              className="w-full text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
              style={{ borderColor: 'var(--card-border)' }}
              title="Re-run the image generator on this row's current prompt"
            >
              {regenState.kind === 'generating'
                ? 'Regenerating…'
                : 'Regenerate from prompt'}
            </button>
            {regenState.kind === 'error' && (
              <div className="text-[10px]" style={{ color: '#f87171' }}>
                {regenState.message}
              </div>
            )}
          </div>
        )}

        {/* Pick from project — lists clips that were already
            generated for this production-doc, so the user can swap
            a row's source clip without spending another LLM call. */}
        {onPickProjectClip && (
          <div
            className="p-3 border-b space-y-2"
            style={{ borderColor: 'var(--card-border)' }}
          >
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
                Pick a clip from this project
              </div>
              <button
                type="button"
                onClick={() => setShowPicker((v) => !v)}
                className="text-[10px] underline"
                style={{ color: 'var(--fg-muted)' }}
              >
                {showPicker ? 'Hide' : 'Show'}
              </button>
            </div>

            {showPicker && (
              <>
                {projectClips.kind === 'loading' && (
                  <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                    Loading clips…
                  </div>
                )}
                {projectClips.kind === 'error' && (
                  <div className="text-[10px]" style={{ color: '#f87171' }}>
                    {projectClips.message}
                  </div>
                )}
                {projectClips.kind === 'loaded' && projectClips.clips.length === 0 && (
                  <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                    No animated clips for this project yet. Generate one on the
                    Production Doc page first.
                  </div>
                )}
                {projectClips.kind === 'loaded' && projectClips.clips.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {projectClips.clips.map((clip) => {
                      const isSelected = row.video_url_override === clip.video_url;
                      return (
                        <button
                          key={clip.id}
                          type="button"
                          onClick={() =>
                            onPickProjectClip(
                              clip.video_url as string,
                              clip.duration_seconds,
                            )
                          }
                          className="relative rounded border overflow-hidden hover:opacity-90 transition-opacity"
                          style={{
                            borderColor: isSelected
                              ? 'var(--accent-purple-bright, #a78bfa)'
                              : 'var(--card-border)',
                            background: '#000',
                            aspectRatio: '16 / 9',
                          }}
                          title={clip.prompt.slice(0, 200)}
                        >
                          <video
                            src={clip.video_url ?? undefined}
                            className="absolute inset-0 w-full h-full object-cover"
                            muted
                            preload="metadata"
                            playsInline
                          />
                          <div
                            className="absolute bottom-0 left-0 right-0 p-1"
                            style={{
                              background:
                                'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
                            }}
                          >
                            <div
                              className="text-[9px] tabular-nums"
                              style={{ color: 'rgba(255,255,255,0.85)' }}
                            >
                              {clip.duration_seconds ? `${clip.duration_seconds}s · ` : ''}
                              {clip.model_id}
                              {clip.row_index !== null ? ` · row ${clip.row_index + 1}` : ''}
                            </div>
                          </div>
                          {isSelected && (
                            <div
                              className="absolute top-1 right-1 rounded px-1 py-0.5 text-[9px]"
                              style={{
                                background: 'var(--accent-purple-bright, #a78bfa)',
                                color: '#000',
                              }}
                            >
                              picked
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Clear button surfaces when this row has a picked clip,
                    so undoing-via-undo isn't the only path back. */}
                {row.video_url_override && (
                  <button
                    type="button"
                    onClick={() => onPickProjectClip(null, null)}
                    className="w-full text-[10px] px-2 py-1 rounded border hover:bg-white/5 transition-colors"
                    style={{ borderColor: 'var(--card-border)' }}
                  >
                    Clear picked clip
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <div className="p-4 space-y-4 text-xs">
          {/* Visual_description — the prompt the doc generator wrote
              to drive image / video generation. Read-only in this
              commit; the rewrite-with-AI commit makes it editable. */}
          <Field label="Visual description" value={row.visual_description || '—'} />
          <Field label="AI image prompt" value={row.ai_image_prompt || '—'} mono />
          {/* Voiceover script — editable inline. Commits on blur
              (or on AI rephrase). Cmd/Ctrl+Z still walks the undo
              stack through SET_ROW_SCRIPT commands. */}
          <div className="space-y-1">
            <div className="font-medium" style={{ color: 'var(--fg)' }}>
              Voiceover script
              {row.muted && (
                <span className="ml-1" style={{ color: '#f87171' }}>
                  (muted)
                </span>
              )}
            </div>
            {onUpdateScript ? (
              <>
                <textarea
                  value={scriptDraft}
                  onChange={(e) => setScriptDraft(e.target.value)}
                  onBlur={commitScriptDraft}
                  className="w-full text-xs rounded border p-2 resize-y min-h-[80px]"
                  style={{
                    borderColor: 'var(--card-border)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                  }}
                  placeholder="—"
                  spellCheck
                />
                <div className="flex flex-wrap gap-1">
                  {(['same', 'shorter', 'longer', 'simpler'] as const).map((style) => (
                    <button
                      key={style}
                      type="button"
                      onClick={() => { void handleRephrase(style); }}
                      disabled={rephraseState.kind === 'rephrasing'}
                      className="text-[10px] px-2 py-0.5 rounded border transition-colors disabled:opacity-50 hover:bg-white/5"
                      style={{ borderColor: 'var(--card-border)' }}
                      title={`Rephrase with AI (${style})`}
                    >
                      {rephraseState.kind === 'rephrasing' && rephraseState.style === style
                        ? 'Rephrasing…'
                        : `Rephrase: ${style}`}
                    </button>
                  ))}
                </div>
                {rephraseState.kind === 'error' && (
                  <div className="text-[10px]" style={{ color: '#f87171' }}>
                    {rephraseState.message}
                  </div>
                )}
              </>
            ) : (
              <div className="whitespace-pre-wrap break-words" style={{ color: 'var(--fg-muted)' }}>
                {row.script_text || '—'}
              </div>
            )}
          </div>

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
        For doc-wide edits, head back to{' '}
        <Link href="/production-doc" className="underline">
          Production Doc
        </Link>
        . All edits here round-trip through the same save endpoint.
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
