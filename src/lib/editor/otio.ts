/**
 * OpenTimelineIO exporter — Phase 4 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Serializes a saved editor project (the `user_history.payload`
 * shape) into OpenTimelineIO JSON. OTIO is the modern Pixar-led
 * interchange format with importers in DaVinci Resolve, Premiere,
 * Final Cut, and (via otioconvert) most other NLEs.
 *
 * Spec: https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-spec.html
 *
 * Schema choices
 * ──────────────
 * - One Video track + one Audio track. Multi-track is a future need.
 * - RationalTime in `fps` (default 30). Frame-quantised durations
 *   come from each shot's `durationMs * fps / 1000`, rounded.
 * - Per-clip metadata captures editor-relevant provenance:
 *     ai_model, ai_prompt, model_used_for_video,
 *     edited_at (the structured shape from `RowEditedAt`),
 *     trim_start_ms / trim_end_ms,
 *     transition_in,
 *     muted, playback_rate.
 * - URLs (image / video / voiceover) are public Blob/R2 URLs
 *   already; OTIO references them directly. No EXIF / no PII / no
 *   workspace ids in the output.
 *
 * Provenance: every clip carries an `editor_metadata.source` field
 * naming this app + a timestamp, so a third-party reader knows
 * what generated the file.
 */
import type { ProductionDoc, RowEditedAt } from '@/remotion/utils';

const APP_NAME = 'youtubestudio-shot-graph-editor';

interface RationalTime {
  OTIO_SCHEMA: 'RationalTime.1';
  value: number;
  rate: number;
}

interface TimeRange {
  OTIO_SCHEMA: 'TimeRange.1';
  start_time: RationalTime;
  duration: RationalTime;
}

interface MediaRef {
  OTIO_SCHEMA: 'ExternalReference.1';
  target_url: string;
  available_range?: TimeRange;
}

interface OtioClip {
  OTIO_SCHEMA: 'Clip.1';
  name: string;
  source_range: TimeRange;
  media_reference: MediaRef | { OTIO_SCHEMA: 'MissingReference.1' };
  metadata?: Record<string, unknown>;
}

interface OtioGap {
  OTIO_SCHEMA: 'Gap.1';
  name?: string;
  source_range: TimeRange;
}

interface OtioTrack {
  OTIO_SCHEMA: 'Track.1';
  name: string;
  kind: 'Video' | 'Audio';
  children: Array<OtioClip | OtioGap>;
  metadata?: Record<string, unknown>;
}

interface OtioStack {
  OTIO_SCHEMA: 'Stack.1';
  name: string;
  children: OtioTrack[];
}

export interface OtioTimeline {
  OTIO_SCHEMA: 'Timeline.1';
  name: string;
  global_start_time: RationalTime | null;
  tracks: OtioStack;
  metadata?: Record<string, unknown>;
}

function rational(value: number, rate: number): RationalTime {
  return { OTIO_SCHEMA: 'RationalTime.1', value, rate };
}

function timeRange(startFrames: number, durFrames: number, rate: number): TimeRange {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rational(startFrames, rate),
    duration: rational(durFrames, rate),
  };
}

function naturalRowDurationMs(doc: ProductionDoc, index: number): number {
  // Same simple parse used elsewhere in the editor: read "M:SS" out
  // of the row's timecode field and subtract to compute the natural
  // (pre-editor) duration.
  const parse = (tc: string | undefined): number | null => {
    if (!tc) return null;
    const m = tc.trim().match(/^(\d{1,2}):(\d{1,2})/);
    if (!m) return null;
    return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
  };
  const start = parse(doc.rows[index]?.timecode);
  if (start === null) return 2000;
  const next = doc.rows[index + 1];
  if (!next) return 2000;
  const end = parse(next.timecode);
  if (end === null || end <= start) return 2000;
  return end - start;
}

interface BuildArgs {
  /** Project title used as the Timeline's `name`. */
  title: string;
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  voiceoverUrl?: string;
  /** Frame rate to quantise against. Defaults to 30. */
  fps?: number;
}

export function buildOtioTimeline(args: BuildArgs): OtioTimeline {
  const fps = args.fps ?? 30;
  const videoClips: Array<OtioClip | OtioGap> = [];
  let cursorFrames = 0;

  for (let i = 0; i < args.doc.rows.length; i++) {
    const row = args.doc.rows[i];
    const onScreenDurationMs =
      typeof row.duration_override_ms === 'number'
        ? row.duration_override_ms
        : naturalRowDurationMs(args.doc, i);
    const durationFrames = Math.max(1, Math.round((onScreenDurationMs / 1000) * fps));

    // Source URL preference: editor's video override > rowImages still
    // > none. A null media-ref still gives the importer a placeholder
    // clip at the right duration.
    const videoUrl =
      typeof row.video_url_override === 'string' && row.video_url_override
        ? row.video_url_override
        : undefined;
    const imageUrl = videoUrl ? undefined : args.rowImages[i];
    const sourceUrl = videoUrl ?? imageUrl;

    const trimStartFrames =
      typeof row.trim_start_ms === 'number' && row.trim_start_ms > 0
        ? Math.round((row.trim_start_ms / 1000) * fps)
        : 0;

    const sourceRange = timeRange(trimStartFrames, durationFrames, fps);
    const editedAt = (row.edited_at ?? null) as RowEditedAt | string | null;

    videoClips.push({
      OTIO_SCHEMA: 'Clip.1',
      name: row.section_title?.trim() || `Shot ${i + 1}`,
      source_range: sourceRange,
      media_reference: sourceUrl
        ? { OTIO_SCHEMA: 'ExternalReference.1', target_url: sourceUrl }
        : { OTIO_SCHEMA: 'MissingReference.1' },
      metadata: {
        editor_metadata: {
          source: APP_NAME,
          shot_index: i,
          timecode: row.timecode,
          scene_type: row.visual_type,
          on_screen_text: row.on_screen_text || undefined,
          ai_image_prompt: row.ai_image_prompt || undefined,
          visual_description: row.visual_description || undefined,
          script_text: row.script_text || undefined,
          trim_start_ms: row.trim_start_ms,
          trim_end_ms: row.trim_end_ms,
          transition_in: row.transition_in,
          muted: row.muted,
          playback_rate: row.playback_rate,
          duration_override_ms: row.duration_override_ms,
          edited_at: editedAt,
        },
      },
    });

    cursorFrames += durationFrames;
  }

  const totalDurationFrames = Math.max(1, cursorFrames);

  const videoTrack: OtioTrack = {
    OTIO_SCHEMA: 'Track.1',
    name: 'Video',
    kind: 'Video',
    children: videoClips,
    metadata: { editor_metadata: { source: APP_NAME } },
  };

  const audioTrack: OtioTrack = {
    OTIO_SCHEMA: 'Track.1',
    name: 'Voiceover',
    kind: 'Audio',
    children: args.voiceoverUrl
      ? [
          {
            OTIO_SCHEMA: 'Clip.1',
            name: 'Voiceover',
            source_range: timeRange(0, totalDurationFrames, fps),
            media_reference: {
              OTIO_SCHEMA: 'ExternalReference.1',
              target_url: args.voiceoverUrl,
            },
          },
        ]
      : [],
    metadata: { editor_metadata: { source: APP_NAME } },
  };

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: args.title || 'Untitled project',
    global_start_time: rational(0, fps),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [videoTrack, audioTrack],
    },
    metadata: {
      editor_metadata: {
        source: APP_NAME,
        exported_at: new Date().toISOString(),
        fps,
        shot_count: args.doc.rows.length,
      },
    },
  };
}
