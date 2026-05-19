"use client";

/**
 * Render-config diagnostics panel.
 *
 * Phase A of `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`.
 *
 * Surfaces the redacted `config_summary` that the server captured at
 * render time so the user can verify, AT A GLANCE, whether the
 * VideoConfig that hit Remotion matched their toggle state. This is the
 * fix-finding tool for the "rendered MP4 missing voiceover / motion /
 * suppressed text still showing" bug — instead of asking the user to
 * record their screen, we show them exactly what the server saw.
 *
 * Renders a single-line headline status row (counts + green/red
 * checks) with an expandable per-shot detail table. Hidden entirely
 * when there's no summary to show.
 */
import React, { useState } from 'react';
import type { RenderConfigSummary, ShotSummary } from '@/lib/render-config-summary';

interface Props {
  summary: unknown | null;
}

function isRenderConfigSummary(v: unknown): v is RenderConfigSummary {
  return (
    !!v &&
    typeof v === 'object' &&
    'shotCount' in v &&
    'voiceover' in v &&
    'shots' in v &&
    Array.isArray((v as { shots: unknown }).shots)
  );
}

export function RenderDiagnosticsPanel({ summary }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!isRenderConfigSummary(summary)) return null;

  const voiceoverOk = summary.voiceover.present;
  const motionOk = summary.animateScenesResolved;
  const shotsWithText = summary.shots.filter((s) => s.hasOnScreenText).length;

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 8,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        fontSize: 12,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide render diagnostics' : 'Show render diagnostics'}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'var(--text)',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          padding: 0,
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)' }}>Render diagnostics</span>
          <Pill ok={voiceoverOk} label={voiceoverOk ? 'voiceover ✓' : 'voiceover absent'} />
          <Pill ok={motionOk} label={motionOk ? 'motion ✓' : 'no animated clips'} />
          <Pill
            ok={summary.flags.suppressLowerThirds || shotsWithText === 0}
            label={
              summary.flags.suppressLowerThirds
                ? 'lower-thirds suppressed'
                : `${shotsWithText} shots have on-screen text`
            }
          />
          <span style={{ color: 'var(--text-muted)' }}>
            · {summary.shotCount} shots · {summary.fps}fps · {summary.width}×{summary.height}
          </span>
        </span>
        <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          <DetailHeader summary={summary} />
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 11,
                color: 'var(--text)',
              }}
            >
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={th}>#</th>
                  <th style={th}>scene</th>
                  <th style={th}>img</th>
                  <th style={th}>vid</th>
                  <th style={th}>ost</th>
                  <th style={th}>section</th>
                  <th style={th}>fade</th>
                  <th style={th}>zoomTo</th>
                  <th style={th}>pad%</th>
                  <th style={th}>overlay</th>
                </tr>
              </thead>
              <tbody>
                {summary.shots.map((s) => (
                  <ShotRow key={s.i} shot={s} />
                ))}
              </tbody>
            </table>
          </div>
          <p
            style={{
              marginTop: 8,
              color: 'var(--text-muted)',
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            Captured at {new Date(summary.capturedAt).toLocaleTimeString()}. Counts what the
            server actually fed to Remotion — if a toggle is on in the UI but absent here, the
            config never made it through.
          </p>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  fontWeight: 500,
};
const td: React.CSSProperties = {
  padding: '3px 8px',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};

function DetailHeader({ summary }: { summary: RenderConfigSummary }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        fontSize: 11,
        color: 'var(--text-muted)',
      }}
    >
      <span>
        voiceover:{' '}
        <strong style={{ color: 'var(--text)' }}>
          {summary.voiceover.present
            ? `present (${summary.voiceover.originHost ?? 'no origin'})`
            : 'ABSENT'}
        </strong>
      </span>
      <span>
        music:{' '}
        <strong style={{ color: 'var(--text)' }}>
          {summary.music.present ? 'present' : 'absent'}
        </strong>
      </span>
      <span>
        suppressLowerThirds:{' '}
        <strong style={{ color: 'var(--text)' }}>
          {String(summary.flags.suppressLowerThirds)}
        </strong>
      </span>
      <span>
        sceneFadeEnabled:{' '}
        <strong style={{ color: 'var(--text)' }}>
          {summary.flags.sceneFadeEnabled === null
            ? '(default)'
            : String(summary.flags.sceneFadeEnabled)}
        </strong>
      </span>
      <span>
        captions: <strong style={{ color: 'var(--text)' }}>{summary.captionsCount}</strong>
      </span>
      <span>
        textOverlays:{' '}
        <strong style={{ color: 'var(--text)' }}>{summary.textOverlaysCount}</strong>
      </span>
      <span>
        thumbnail:{' '}
        <strong style={{ color: 'var(--text)' }}>
          {summary.thumbnail.present
            ? `${summary.thumbnail.regionCount} regions`
            : 'absent'}
        </strong>
      </span>
    </div>
  );
}

function ShotRow({ shot }: { shot: ShotSummary }) {
  return (
    <tr>
      <td style={td}>{shot.i}</td>
      <td style={td}>{shot.sceneType}</td>
      <td style={td}>{check(shot.hasImageUrl)}</td>
      <td style={td}>{check(shot.hasVideoUrl)}</td>
      <td style={td}>{check(shot.hasOnScreenText)}</td>
      <td style={td}>
        {shot.hasSectionTitle ? shot.sectionTitleLayout ?? 'overlay' : '—'}
      </td>
      <td style={td}>
        {shot.sceneFade === null ? '—' : shot.sceneFade ? 'fade' : 'cut'}
      </td>
      <td style={td}>{shot.thumbnailZoomTo ? shot.thumbnailZoomTo.slice(0, 8) : '—'}</td>
      <td style={td}>{shot.regionZoomPaddingPct ?? '—'}</td>
      <td style={td}>{check(shot.hasOverlay)}</td>
    </tr>
  );
}

function check(v: boolean): string {
  return v ? '✓' : '·';
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: '2px 7px',
        borderRadius: 10,
        background: ok ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
        color: ok ? '#34d399' : '#f87171',
        border: `1px solid ${ok ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
