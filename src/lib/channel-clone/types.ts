/**
 * Channel-clone shared types.
 *
 * The channel-clone pipeline turns a competitor YouTube URL into a
 * ready-to-render production-doc draft. Types here describe the
 * persisted state of a clone job, not the wire shapes — wire shapes
 * live next to the route handlers that emit them.
 *
 * See `_plans/2026-06-05-channel-clone-pipeline.md` for the full
 * workflow design and the eight LLM stages each `*_model_used`
 * field corresponds to.
 */

/** Discriminated kind of a validated YouTube URL. v1 supports
 *  channels (by @handle / channel id / legacy /c/ / legacy /user/)
 *  and videos (canonical /watch?v= and short youtu.be). Videos are
 *  accepted at intake so the user can paste any URL — the intake
 *  step resolves them to the parent channel via yt-dlp metadata. */
export type YoutubeUrlKind = 'channel' | 'video';

export type ChannelUrlIdentifierType = 'handle' | 'id' | 'custom' | 'user';

export interface ParsedYoutubeUrl {
  kind: YoutubeUrlKind;
  /** Canonical https://www.youtube.com/… form with no query/fragment
   *  beyond `?v=…` for videos. Always starts with `https://www.youtube.com`
   *  even when the input was `youtu.be/…` so downstream tools see one
   *  shape. */
  canonical: string;
  /** For channels: the @handle, channel id, /c/ name, or /user/ name.
   *  For videos: the 11-char video id. */
  identifier: string;
  /** For channels only — which channel-url shape we parsed. Undefined
   *  for videos. */
  identifierType?: ChannelUrlIdentifierType;
}

/** Single-line entry in a cleaned transcript. Each entry corresponds
 *  to a contiguous spoken segment in the original auto-captions; the
 *  cleaner collapses YouTube's rolling-duplicate caption blocks so
 *  each sentence appears exactly once. */
export interface TranscriptLine {
  /** Start offset within the video, in seconds, integer-truncated.
   *  Sufficient precision for prompting (we never use this to seek
   *  during render — that's the alignment helpers' job). */
  startSec: number;
  text: string;
}

export interface CleanedTranscript {
  /** Best-effort source format the cleaner detected. */
  sourceFormat: 'srt' | 'vtt';
  /** Total words in the cleaned transcript — feeds the per-channel
   *  Words-Per-Second estimate used by the script-generation stage. */
  wordCount: number;
  /** Best-effort total duration in seconds derived from the latest
   *  caption block's end time. */
  durationSec: number;
  lines: TranscriptLine[];
}

/** Per-video sample fetched during the intake stage. */
export interface ChannelCloneSampleVideo {
  videoUrl: string;
  videoId: string;
  title: string;
  durationSec: number;
  /** Local cache path under the per-job temp directory. Resolved at
   *  the time of intake; the analyze stage re-reads it via the path
   *  recorded here. */
  videoLocalPath: string;
  /** Frames extracted every N seconds (configurable per job). */
  frameLocalPaths: string[];
  transcript: CleanedTranscript | null;
}

export interface ChannelCloneIntakeResult {
  sourceChannelUrl: string;
  sourceChannelHandle: string | null;
  sourceChannelName: string | null;
  sampleVideos: ChannelCloneSampleVideo[];
  fetchedAt: string;
  /** Path to the per-job temp directory housing all downloaded
   *  assets. The job's cleanup hook removes this when the job is
   *  archived/deleted. */
  tempDirPath: string;
}

export interface ChannelCloneAnalysis {
  niche: string;
  subNiche: string;
  targetAudience: { demographics: string; psychographics: string };
  contentFormat: 'essay' | 'listicle' | 'story' | 'tutorial' | 'hybrid';
  hookArchitecture: string;
  scriptFlowBlueprint: string;
  wpsEstimate: number;
  avgVideoWordCount: number;
  signaturePhrases: string[];
  styleDna: {
    sentenceRhythm: string;
    tonalFingerprint: string;
    transitionMechanics: string;
    metaphorPatterns: string;
    openingPatterns: string;
    closingPatterns: string;
  };
  audiencePsychology: { painPoints: string[]; identityPromise: string; channelsEnemy: string };
  /** Whichever AI model id was actually used for this run (could
   *  differ from the feature default if the user overrode it in
   *  Settings → Model Defaults). */
  modelUsed: string;
  analyzedAt: string;
}

export interface ChannelCloneVisualProfile {
  artStyle: string;
  paletteHex: string[];
  lightingStyle: string;
  compositionPatterns: string;
  detailLevel: string;
  mood: string;
  /** Filled in by the rowify stage if the analyzer's visual profile
   *  maps cleanly onto an existing production-doc style preset;
   *  otherwise undefined and the rowify stage derives a new preset
   *  on the fly. */
  derivedStylePresetId?: string;
}

export type ChannelCloneJobStatus =
  // Active states (a route handler is currently making progress, or
  // the previous handler returned successfully and the next one is
  // waiting for the user to advance):
  | 'intake_pending'
  | 'intake_running'
  | 'intake_complete'
  | 'analyze_running'
  | 'analyze_complete'
  | 'topics_running'
  | 'topics_complete'
  | 'hooks_running'
  | 'hooks_complete'
  | 'script_running'
  | 'script_complete'
  | 'rowify_running'
  | 'rowify_complete'
  | 'publish_pack_running'
  | 'publish_pack_complete'
  // Terminal:
  | 'archived'
  // Failure (each carries a `lastError` on the job row):
  | 'intake_failed'
  | 'analyze_failed'
  | 'topics_failed'
  | 'hooks_failed'
  | 'script_failed'
  | 'rowify_failed'
  | 'publish_pack_failed';

/** Persisted shape of the JSONB blob on `channel_clone_jobs.state_jsonb`. */
export interface ChannelCloneJobState {
  intake?: ChannelCloneIntakeResult;
  analysis?: ChannelCloneAnalysis;
  visualProfile?: ChannelCloneVisualProfile;
  /** All currently-known topics (from the topic-generation stage). */
  topics?: { title: string; angle: string; hook: string; difficulty: number }[];
  /** Currently selected topic index (1-based to match the user-facing
   *  list). Undefined until the user picks one. */
  selectedTopicIndex?: number;
  /** The five hooks the hook-engineering stage produced for the
   *  selected topic. */
  hooks?: { archetype: string; text: string; wordCount: number; estimatedDurationSec: number }[];
  selectedHookIndex?: number;
  scriptDraft?: { text: string; wordCount: number; targetWordCount: number };
  auditHistory?: {
    iteration: number;
    score: number;
    breakdown: Record<string, number>;
    revisionApplied: string | null;
  }[];
  /** The audit-fix loop's final accepted script. Only set once the
   *  loop converged or the user accepted a sub-threshold draft. */
  approvedScript?: { text: string; wordCount: number; finalScore: number };
  publishPack?: {
    titles: string[];
    description: string;
    tags: string[];
    pinnedCommentOptions: string[];
    contentCalendar?: { day: number; topic: string; angle: string }[];
  };
}
