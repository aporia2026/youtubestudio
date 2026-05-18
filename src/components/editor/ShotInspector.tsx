'use client';

/**
 * Shot inspector — the side panel for a selected shot.
 *
 * Phase 3 of `_plans/2026-05-18-shot-graph-editor.md`. Hosts the
 * editing surfaces that don't make sense on the timeline strip
 * itself: script text, visual description, AI image prompt, replace
 * media buttons, regenerate-shot, rewrite-script-with-AI.
 *
 * Phase 3 ships this file in passes — each follow-up commit adds
 * one capability:
 *   – Replace media popover
 *   – Re-pace voiceover (top-toolbar button, not in the inspector)
 *   – Rewrite script_text inline editor + AI rephrase
 *
 * Today the inspector renders the shot's content read-only. The
 * value of shipping it now: the user gets a visible "I've selected
 * this shot" affordance, the surface is laid out, and follow-up
 * commits become focused additions.
 */
import Link from 'next/link';
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
}

function fmt(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ShotInspector({
  shotIndex,
  shot,
  row,
  thumbnailUrl,
  totalShots,
  onClose,
}: ShotInspectorProps): React.ReactElement {
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

          {/* Trim summary — visible read-out of the trim_start_ms /
              trim_end_ms values the timeline handles modify. */}
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

          {/* Render path & model badges — the editor doesn't change
              these here, but the user reading the inspector wants to
              know "what kind of shot is this?" */}
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
        Replace media, regenerate, and rewrite-with-AI controls land in the
        Phase 3 follow-up commits. For now, edit a row&apos;s text on{' '}
        <Link href="/production-doc" className="underline">
          Production Doc
        </Link>{' '}
        and the changes round-trip through here.
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
