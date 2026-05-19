/**
 * Forensic summary of a `VideoConfig` for the render-jobs diagnostics
 * column. Phase A of
 * `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`.
 *
 * The render-config-drop bug (rendered MP4 missing voiceover, motion,
 * or showing suppressed text) has multiple plausible drop points. This
 * summary captures the EXACT shape of the config that hit Remotion so
 * we can diff intended vs rendered without re-running the case.
 *
 * Redaction rules:
 *   - `voiceoverUrl` reduced to presence + origin host. Never the full
 *     path, never a presigned signature.
 *   - Per-shot URLs reduced to booleans. Never the URL string itself.
 *   - Brand kit reduced to a one-line digest (colors only).
 *   - Captions / textOverlays reduced to counts.
 *
 * Shape is JSON-stable so it can sit inside a Postgres JSONB column and
 * be queried with `->`/`->>` operators if the bug recurs after the
 * first fix.
 */
import type { VideoConfig } from '@/remotion/types';

export interface ShotSummary {
  i: number;
  sceneType: string;
  startMs: number;
  durationMs: number;
  hasImageUrl: boolean;
  hasVideoUrl: boolean;
  videoDurationSeconds: number | null;
  hasOnScreenText: boolean;
  hasSectionTitle: boolean;
  sectionTitleLayout: 'overlay' | 'letterbox' | null;
  pillarboxColor: string | null;
  sceneFade: boolean | null;
  transitionInId: 'cross-fade' | null;
  thumbnailZoomTo: string | null;
  regionZoomPaddingPct: number | null;
  hasOverlay: boolean;
  trimStartMs: number | null;
  trimEndMs: number | null;
  muted: boolean | null;
  playbackRate: number | null;
}

export interface RenderConfigSummary {
  /** ISO timestamp of summary creation — useful when diffing two runs. */
  capturedAt: string;
  fps: number;
  width: number;
  height: number;
  shotCount: number;
  voiceover: { present: boolean; originHost: string | null };
  music: { present: boolean; originHost: string | null };
  brand: { primary: string; background: string; text: string; title: string };
  flags: {
    suppressLowerThirds: boolean;
    sceneFadeEnabled: boolean | null;
    showCaptions: boolean | null;
  };
  timing: {
    minSceneMs: number | null;
    tailBufferMs: number | null;
  };
  thumbnail: {
    present: boolean;
    regionCount: number;
    width: number | null;
    height: number | null;
  };
  captionsCount: number;
  textOverlaysCount: number;
  /** Derived: any shot ended up with a videoUrl. Lets us infer whether
   *  `animateScenes` was effectively ON across the run without trusting
   *  a flag that never makes it onto the config. */
  animateScenesResolved: boolean;
  /** Derived: any shot ended up with `regionZoomPaddingPct` set. */
  zoomPaddingApplied: boolean;
  shots: ShotSummary[];
}

/** Pull the host from a URL string. Returns null when input isn't a
 *  parseable absolute URL — relative paths come back null because they
 *  carry no origin information by definition. */
function safeOriginHost(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function buildRenderConfigSummary(config: VideoConfig): RenderConfigSummary {
  const shots: ShotSummary[] = config.shots.map((s, i) => ({
    i,
    sceneType: s.sceneType,
    startMs: s.startMs,
    durationMs: s.durationMs,
    hasImageUrl: Boolean(s.imageUrl),
    hasVideoUrl: Boolean(s.videoUrl),
    videoDurationSeconds:
      typeof s.videoDurationSeconds === 'number' ? s.videoDurationSeconds : null,
    hasOnScreenText: Boolean(s.onScreenText),
    hasSectionTitle: Boolean(s.sectionTitle),
    sectionTitleLayout: s.sectionTitleLayout ?? null,
    pillarboxColor: s.pillarboxColor ?? null,
    sceneFade: typeof s.sceneFade === 'boolean' ? s.sceneFade : null,
    transitionInId: s.transitionInId ?? null,
    thumbnailZoomTo: s.thumbnailZoomTo ?? null,
    regionZoomPaddingPct:
      typeof s.regionZoomPaddingPct === 'number' ? s.regionZoomPaddingPct : null,
    hasOverlay: Boolean(s.overlay?.url),
    trimStartMs: typeof s.trimStartMs === 'number' ? s.trimStartMs : null,
    trimEndMs: typeof s.trimEndMs === 'number' ? s.trimEndMs : null,
    muted: typeof s.muted === 'boolean' ? s.muted : null,
    playbackRate: typeof s.playbackRate === 'number' ? s.playbackRate : null,
  }));

  const animateScenesResolved = shots.some((s) => s.hasVideoUrl);
  const zoomPaddingApplied = shots.some((s) => s.regionZoomPaddingPct !== null);

  return {
    capturedAt: new Date().toISOString(),
    fps: config.fps,
    width: config.width,
    height: config.height,
    shotCount: config.shots.length,
    voiceover: {
      present: Boolean(config.voiceoverUrl),
      originHost: safeOriginHost(config.voiceoverUrl),
    },
    music: {
      present: Boolean(config.musicUrl),
      originHost: safeOriginHost(config.musicUrl),
    },
    brand: {
      primary: config.brand.primaryColor,
      background: config.brand.backgroundColor,
      text: config.brand.textColor,
      title: config.brand.titleColor,
    },
    flags: {
      suppressLowerThirds: config.suppressLowerThirds === true,
      sceneFadeEnabled:
        typeof config.sceneFadeEnabled === 'boolean' ? config.sceneFadeEnabled : null,
      showCaptions: typeof config.showCaptions === 'boolean' ? config.showCaptions : null,
    },
    timing: {
      minSceneMs: typeof config.minSceneMs === 'number' ? config.minSceneMs : null,
      tailBufferMs: typeof config.tailBufferMs === 'number' ? config.tailBufferMs : null,
    },
    thumbnail: {
      present: Boolean(config.thumbnail),
      regionCount: config.thumbnail?.regions?.length ?? 0,
      width: config.thumbnail?.width ?? null,
      height: config.thumbnail?.height ?? null,
    },
    captionsCount: config.captions?.length ?? 0,
    textOverlaysCount: config.textOverlays?.length ?? 0,
    animateScenesResolved,
    zoomPaddingApplied,
    shots,
  };
}
