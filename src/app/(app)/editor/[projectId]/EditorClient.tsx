'use client';

/**
 * Shot-graph editor client — Phase 1 read-only preview.
 *
 * Wires the Remotion player to the persisted ProductionDoc and the
 * editor store. v1 renders a clean preview with no editing controls;
 * Phase 2 layers the timeline strip + toolbar on top of this without
 * changing the data flow.
 *
 * `inputProps` is memoized at primitive granularity so reference
 * equality propagates correctly into the Remotion composition
 * (verified via Context7 against Remotion docs — Player re-renders
 * on inputProps reference change but does NOT remount when the
 * reference is stable).
 */
import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { YouTubeVideo } from '@/remotion/compositions/YouTubeVideo';
import {
  productionDocToVideoConfig,
  type ProductionDoc,
  type RowImageState,
} from '@/remotion/utils';
import { initialEditorState } from '@/lib/editor/store';
import { useEditorStore } from '@/lib/editor/use-editor-store';

interface EditorClientProps {
  projectId: string;
  version: number;
  /** Raw `user_history.payload` JSONB. We parse defensively because
   *  the column is typed `JSONB` server-side; old rows from before
   *  recent doc-shape additions may be missing fields. */
  payload: unknown;
}

interface HistoryPayload {
  doc?: ProductionDoc;
  rowImages?: Record<number, string>;
  title?: string;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parsePayload(payload: unknown): HistoryPayload | null {
  if (!isPlainObject(payload)) return null;
  const doc = isPlainObject(payload.doc) ? (payload.doc as unknown as ProductionDoc) : undefined;
  if (!doc || !Array.isArray((doc as ProductionDoc).rows)) return null;
  const rowImages = isPlainObject(payload.rowImages)
    ? (payload.rowImages as Record<number, string>)
    : {};
  const title = typeof payload.title === 'string' ? payload.title : undefined;
  return { doc, rowImages, title };
}

export default function EditorClient({ projectId, version, payload }: EditorClientProps) {
  const parsed = useMemo(() => parsePayload(payload), [payload]);

  // Bail-out branches BEFORE hook ordering branches. The hooks below
  // run unconditionally; conditional rendering happens via early
  // return after the hooks declare their values.
  const doc = parsed?.doc;
  const rowImages = parsed?.rowImages ?? {};

  const { state, apply } = useEditorStore(
    initialEditorState({
      doc: doc ?? ({ rows: [], title: '', niche: '', total_duration: '0', total_words: 0, speaking_pace_wpm: 150 } as ProductionDoc),
      rowImages,
      version,
    }),
  );

  // Derive the VideoConfig the player will render. Memoized so the
  // Remotion player's inputProps reference is stable across renders
  // that don't touch the doc — keeps the player from re-rendering
  // its composition on every parent state tick.
  const videoConfig = useMemo(() => {
    if (!doc) return null;
    const rowImageArr: (RowImageState | null)[] = doc.rows.map((_, i) => {
      const url = rowImages[i];
      return url ? { status: 'ready', imageUrl: url } : null;
    });
    return productionDocToVideoConfig(doc, rowImageArr, {});
  }, [doc, rowImages]);

  const inputProps = useMemo(() => (videoConfig ? { config: videoConfig } : null), [videoConfig]);

  const totalFrames = useMemo(() => {
    if (!videoConfig) return 1;
    const totalMs = videoConfig.shots.reduce((acc, s) => acc + s.durationMs, 0);
    return Math.max(1, Math.round((totalMs / 1000) * videoConfig.fps));
  }, [videoConfig]);

  // Listen for player frame updates so the store's playhead reflects
  // the actual play position. Phase 2 uses this to drive timeline-
  // strip selection. Throttled by Remotion to ~60Hz; we additionally
  // skip the dispatch when the ms value rounds to the same integer
  // as the prior tick so React doesn't re-render the toolbar 60
  // times per second.
  const playerRef = useRef<PlayerRef>(null);
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !videoConfig) return;
    const fps = videoConfig.fps;
    let lastDispatchedMs = -1;
    const onFrameUpdate = (e: { detail: { frame: number } }): void => {
      const ms = Math.round((e.detail.frame / fps) * 1000);
      if (ms === lastDispatchedMs) return;
      lastDispatchedMs = ms;
      apply({ type: 'SET_PLAYHEAD', ms });
    };
    player.addEventListener('frameupdate', onFrameUpdate);
    return () => {
      player.removeEventListener('frameupdate', onFrameUpdate);
    };
  }, [videoConfig, apply]);

  if (!parsed || !doc || !inputProps || !videoConfig) {
    console.warn('[editor client] payload missing or unparseable', { projectId });
    return (
      <div className="p-8 max-w-2xl mx-auto space-y-3">
        <h1 className="text-xl font-semibold">Couldn&apos;t load this project</h1>
        <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
          The production-doc row this URL points at is missing its <code>doc</code> payload,
          or its shape is older than the editor expects.
        </p>
        <Link href="/production-doc" className="text-sm underline">
          ← Back to Production Doc
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{parsed.title || doc.title || 'Untitled project'}</h1>
          <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>
            {doc.rows.length} shots · {doc.total_duration} · version {state.version}
          </p>
        </div>
        <Link
          href="/production-doc"
          className="text-sm px-3 py-1.5 rounded border hover:bg-white/5 transition-colors"
          style={{ borderColor: 'var(--card-border)' }}
        >
          ← Back to Production Doc
        </Link>
      </header>

      <div
        className="rounded-lg overflow-hidden border"
        style={{ borderColor: 'var(--card-border)', background: '#000' }}
      >
        <Player
          ref={playerRef}
          component={YouTubeVideo}
          inputProps={inputProps}
          durationInFrames={totalFrames}
          compositionWidth={videoConfig.width}
          compositionHeight={videoConfig.height}
          fps={videoConfig.fps}
          controls
          style={{ width: '100%', aspectRatio: `${videoConfig.width} / ${videoConfig.height}` }}
          acknowledgeRemotionLicense
        />
      </div>

      <div
        className="p-3 rounded-lg border text-xs"
        style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
      >
        <strong style={{ color: 'var(--fg)' }}>Read-only preview.</strong> Editing controls land
        in Phase 2 of the shot-graph editor plan. For now, edits still happen on{' '}
        <Link href="/production-doc" className="underline">/production-doc</Link>; this view
        confirms the same render path round-trips through the new route.
      </div>
    </div>
  );
}
