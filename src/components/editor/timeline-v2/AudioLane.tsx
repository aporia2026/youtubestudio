'use client';

/**
 * Audio lane — Phase 5 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Renders the project's voiceover as a single continuous waveform
 * across the timeline, sized to match the video lane's pixel width.
 * Built on wavesurfer.js (already in package.json) configured for
 * pre-rendered waveforms — we feed it the MP3 URL once on mount and
 * let it own the canvas redraws.
 *
 * Click on the lane seeks the playhead. The lane is otherwise
 * read-only — gain / ducking / fades stay out of scope per the
 * plan's non-goals.
 *
 * Empty state (no voiceover URL) renders a thin "no audio" placeholder
 * so the lane row still occupies its space.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';

interface AudioLaneProps {
  voiceoverUrl?: string;
  totalDurationMs: number;
  pixelsPerSecond: number;
  height: number;
  onSeek: (ms: number) => void;
}

export function AudioLane({
  voiceoverUrl,
  totalDurationMs,
  pixelsPerSecond,
  height,
  onSeek,
}: AudioLaneProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const widthPx = useMemo(
    () => Math.max(100, Math.round((totalDurationMs / 1000) * pixelsPerSecond)),
    [totalDurationMs, pixelsPerSecond],
  );

  useEffect(() => {
    if (!containerRef.current || !voiceoverUrl) return;
    setError(null);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: voiceoverUrl,
      height,
      // Cool cyan tint for the waveform so the audio lane reads
      // visually distinct from the purple-accent video tiles.
      waveColor: 'rgba(34, 211, 238, 0.55)',
      progressColor: 'rgba(34, 211, 238, 0.95)',
      cursorColor: 'transparent', // playhead is drawn by TimelineV2
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      interact: false, // seeks come from the container's onClick — we
      // disable wavesurfer's built-in seek so it doesn't fight the
      // shared timeline scroll.
      normalize: true,
      // Match the pre-computed pixel-width so the waveform aligns
      // with the rest of the timeline. wavesurfer fills its
      // container; we set the container's width to widthPx below.
    });

    ws.on('ready', () => {
      console.info('[editor waveform] ready', {
        sourceUrl: voiceoverUrl.split('?')[0],
        durationMs: Math.round((ws.getDuration() ?? 0) * 1000),
      });
    });
    ws.on('error', (e) => {
      const detail = e instanceof Error ? e.message : String(e);
      console.warn('[editor waveform] error', { detail });
      setError(detail);
    });

    wavesurferRef.current = ws;
    return () => {
      ws.destroy();
      wavesurferRef.current = null;
    };
    // Recreate when the source URL changes; ignore other deps to
    // avoid re-fetching the audio every zoom tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceoverUrl, height]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ms = Math.max(0, Math.round((x / pixelsPerSecond) * 1000));
    onSeek(Math.min(ms, totalDurationMs));
  };

  if (!voiceoverUrl) {
    return (
      <div
        className="flex items-center px-3"
        style={{
          height,
          background: 'var(--editor-lane-audio)',
          color: 'var(--fg-muted)',
          fontSize: 10,
          minWidth: widthPx,
        }}
      >
        No voiceover attached
      </div>
    );
  }

  return (
    <div
      className="relative cursor-pointer"
      onClick={handleClick}
      style={{
        height,
        background: 'var(--editor-lane-audio)',
        minWidth: widthPx,
        width: widthPx,
      }}
      title={error ? `Waveform error: ${error}` : 'Click to seek'}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {error && (
        <div
          className="absolute inset-0 flex items-center justify-center text-[10px] px-3"
          style={{ color: '#f87171' }}
        >
          Waveform: {error.slice(0, 60)}
        </div>
      )}
    </div>
  );
}
