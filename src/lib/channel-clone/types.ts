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

/** Per-video sample fetched during the intake stage.
 *
 * The intake stage runs yt-dlp + ffmpeg inside a Vercel Sandbox
 * microVM. Files on the sandbox's disk are not accessible after the
 * sandbox stops, so we extract the analyze stage's minimum dependency
 * (one representative frame) into the doc and discard the rest:
 *
 *  - `frameCount` — how many frames were sampled (for UI display +
 *    sanity check on a "do we have a visual signal at all" question).
 *  - `representativeFrameBase64` — the middle frame of the video,
 *    base64-encoded, ready to feed the multimodal analyze model
 *    without another sandbox round-trip.
 *  - `representativeFrameMimeType` — `image/jpeg` for ffmpeg's
 *    default; preserved so the analyze stage can hand the model the
 *    right mime hint.
 *
 * Legacy jobs created before 2026-06-06 carry `frameLocalPaths` and
 * `videoLocalPath` instead. Both are now ignored — the analyze stage
 * falls back to text-only when no `representativeFrameBase64` is
 * present.
 */
export interface ChannelCloneSampleVideo {
  videoUrl: string;
  videoId: string;
  title: string;
  durationSec: number;
  /** Number of frames the ffmpeg step produced. Surfaced to the UI. */
  frameCount: number;
  /** R2 keys (relative paths inside the review bucket) for every
   *  frame extracted by ffmpeg, in playback order. Used by the
   *  rowify stage to feed the channel's actual visual DNA back to
   *  the image-gen pipeline as reference images — the missing
   *  feature that turns "categorise the style" into "clone the
   *  style". Empty array when frame extraction failed or the
   *  video was transcript-only. */
  frameR2Keys: string[];
  /** Middle frame of the video, base64-encoded. Null when frame
   *  extraction failed but the transcript still came through.
   *  Kept alongside frameR2Keys for the analyze stage which feeds
   *  one representative still to the multimodal LLM for keyword
   *  extraction. */
  representativeFrameBase64: string | null;
  /** Mime type of `representativeFrameBase64`. Always `image/jpeg`
   *  for ffmpeg's default output; surfaced so the analyze stage
   *  passes the right hint to the multimodal model. */
  representativeFrameMimeType: 'image/jpeg' | 'image/png' | null;
  transcript: CleanedTranscript | null;
}

export interface ChannelCloneIntakeResult {
  sourceChannelUrl: string;
  sourceChannelHandle: string | null;
  sourceChannelName: string | null;
  sampleVideos: ChannelCloneSampleVideo[];
  fetchedAt: string;
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
  | 'handoff_running'
  | 'handoff_complete'
  // Terminal:
  | 'archived'
  // User-cancelled mid-flight. The runner checks `cancelRequested`
  // between every step and bails into this state when it sees one.
  | 'cancelled'
  // Failure (each carries a `lastError` on the job row):
  | 'intake_failed'
  | 'analyze_failed'
  | 'topics_failed'
  | 'hooks_failed'
  | 'script_failed'
  | 'rowify_failed'
  | 'publish_pack_failed'
  | 'handoff_failed';

/** Single entry in the per-job live progress log. The intake +
 *  later stages append one of these on every meaningful step; the
 *  panel reads them off the polled job row and renders a scrolling
 *  console so the user sees what's happening live (rather than the
 *  job sitting silently in "intake_running" for 90s).
 *
 *  `step` is a short namespace ("sandbox", "yt-dlp", "ffmpeg",
 *  "intake", "analyze", etc.) — the UI uses it to colour-code rows.
 *
 *  `data` is structured detail (counts, durations, ids); rendered
 *  as a `key=value` tail on the message line. */
export interface ProgressLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  step: string;
  msg: string;
  data?: Record<string, unknown>;
}

/** Persisted shape of the JSONB blob on `channel_clone_jobs.state_jsonb`. */
export interface ChannelCloneJobState {
  intake?: ChannelCloneIntakeResult;
  /** Live-progress log appended by the runner on every key step.
   *  Unbounded for now — a 5-video intake produces ~30 entries; even
   *  a chatty full pipeline tops out around 200. */
  progressLog?: ProgressLogEntry[];
  /** Set to `true` by POST /api/channel-clone/jobs/[id]/cancel. The
   *  active stage's runner polls this between steps and, when it
   *  sees true, logs a cancel line, transitions the status to
   *  `cancelled`, and bails — the finally block tears down any
   *  sandbox in flight. Stays true after cancellation so a refresh
   *  doesn't accidentally resume work. */
  cancelRequested?: boolean;
  analysis?: ChannelCloneAnalysis;
  visualProfile?: ChannelCloneVisualProfile;
  /** Audio sample extracted from one reference video during intake.
   *  Feeds the voice-profile LLM stage and the optional ElevenLabs
   *  Instant Voice Cloning button. Absent when extraction failed
   *  (e.g. all reference videos were silent — a rare edge case for
   *  long-form YouTube narration). Plan 1:
   *  _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md */
  voiceSample?: {
    /** R2 key of the 30-60s audio sample (mono 16kHz MP3). */
    r2Key: string;
    /** Source video id this came from (matches sampleVideos[].videoId). */
    sourceVideoId: string;
    /** Start offset within the source video, in seconds. */
    startSec: number;
    durationSec: number;
    bytes: number;
    extractedAt: string;
  };
  /** Structured narrator-voice description + paste-ready ElevenLabs
   *  Voice Design prompt produced by the voice-profile LLM stage.
   *  Best-effort: absent when the model output was unusable or the
   *  audio sample was missing. */
  voiceProfile?: {
    gender: 'male' | 'female' | 'androgynous';
    ageBracket: 'young-adult' | 'adult' | 'middle-aged' | 'senior';
    pace: 'slow' | 'moderate' | 'fast' | 'variable';
    /** "warm baritone", "bright tenor", "raspy alto", … */
    timbre: string;
    /** "general american", "rp british", "australian", … */
    accent: string;
    energy: 'low' | 'measured' | 'high';
    /** "wry, knowing, slightly detached", … */
    emotionalRegister: string;
    /** Recurring delivery moves: pauses, terminals, emphasis. */
    signatureMoves: string[];
    /** Paste-ready ElevenLabs Voice Design prompt. */
    voiceDesignPrompt: string;
    /** Whichever model id actually serviced this run (per the user's
     *  per-feature picker). */
    modelUsed: string;
    analyzedAt: string;
  };
  /** ElevenLabs Instant Voice Clone result. Set when the operator
   *  pressed "Clone this voice" in the panel and the upload succeeded.
   *  Plan 1B wires the routes that populate this. */
  clonedVoice?: {
    /** ElevenLabs voice_id returned by /v1/voices/add. */
    voiceId: string;
    name: string;
    /** Subscription tier in effect at clone time (Starter, Creator,
     *  …) — surfaced so the operator can see capability headroom. */
    subscriptionTier: string;
    clonedAt: string;
    clonedBy: string;
  };
  /** All currently-known topics (from the topic-generation stage). */
  topics?: { title: string; angle: string; hook: string; difficulty: number }[];
  /** Currently selected topic index (1-based to match the user-facing
   *  list). Undefined until the user picks one. */
  selectedTopicIndex?: number;
  /** The five hook archetypes the hook-engineering stage produced
   *  for the selected topic. */
  hooks?: {
    archetype: 'Contrarian' | 'Story' | 'Stat' | 'Challenge' | 'Mystery';
    text: string;
    wordCount: number;
    estimatedDurationSec: number;
  }[];
  selectedHookIndex?: number;
  scriptDraft?: { text: string; wordCount: number; targetWordCount: number };
  /** One entry per audit→revise iteration of the script fix-loop.
   *  `overall` is the model's 0-10 self-score; the breakdown carries
   *  the individual dimension scores so the UI can plot convergence
   *  across iterations. `verdict` is the audit's 1-3 sentence
   *  explanation. */
  auditHistory?: {
    iteration: number;
    scriptWordCount: number;
    overall: number;
    breakdown: {
      styleDnaMatch: number;
      hookStrength: number;
      pacingAccuracy: number;
      emotionalFlowMatch: number;
      retentionTechniques: number;
      wordCountAccuracyPct: number;
      originality: number;
      audiencePsychologyAlignment: number;
      ctaMatch: number;
      productionReadiness: number;
    };
    verdict: string;
  }[];
  /** The audit-fix loop's final accepted script. Only set once the
   *  loop converged or the user accepted a sub-threshold draft. */
  approvedScript?: { text: string; wordCount: number; finalScore: number };
  /** Style preset id chosen for rowification (either user-picked or
   *  auto-matched from the visual profile). Stored as a plain string
   *  so the value tolerates the registry growing — the rowify runner
   *  guards with isCandidateStylePresetId on read. */
  chosenStylePresetId?: string;
  /** Per-job custom style derived from the visual profile + intake
   *  frames. Set by the rowify runner when the operator picks "use
   *  channel visual DNA" (default). The handoff stage threads this
   *  into the production-doc so the image-gen pipeline uses the
   *  channel's actual frames as Atlas i2i references instead of a
   *  built-in preset's bundled refs.
   *
   *  When both `chosenStylePresetId` and `channelStyle` are set,
   *  `channelStyle` wins — the preset id stays around for telemetry
   *  + fallback when the doc needs a base style to extend. */
  channelStyle?: {
    /** Style suffix appended to every ai_image_prompt — derived
     *  from the visual profile's artStyle / palette / lighting /
     *  composition / mood / detail fields. */
    aiImageSuffix: string;
    /** R2 keys of the representative frames chosen as Atlas i2i
     *  reference images. The image-gen pipeline mints presigned
     *  GET URLs from these on demand. */
    refR2Keys: string[];
    /** Human-readable derivation summary for logs + the UI. */
    reason: string;
    /** ISO timestamp the channelStyle was derived at. */
    derivedAt: string;
  };
  /** Result of the optional handoff to the auto-pipeline. Set when
   *  the user pushed the rowified doc into the production pipeline
   *  via POST /api/channel-clone/handoff. Once set, the existing
   *  cron picks up `pipelineRunVideoId` at stage
   *  `generating_production_doc_images` and runs image generation. */
  handoff?: {
    pipelineRunId: string;
    pipelineRunVideoId: string;
    projectId: string;
    scriptId: string;
    ideaId: string;
    /** Whichever pipeline_preset_id the handoff picked (first in
     *  workspace by default). Surfaced so the user can switch later
     *  by re-handing-off after editing the doc. */
    presetId: string;
    handedOffAt: string;
  };
  /** Previous handoff records, accumulated as the user re-hands the
   *  same job off under different presets. The most-recent is on
   *  `handoff`; older ones land here in chronological order. Each
   *  pipeline_run_video stays alive on its own — re-handing-off
   *  doesn't kill the old one, it just retargets the job's pointer. */
  handoffHistory?: {
    pipelineRunId: string;
    pipelineRunVideoId: string;
    projectId: string;
    scriptId: string;
    ideaId: string;
    presetId: string;
    handedOffAt: string;
  }[];
  /** Per-row breakdown produced by the rowify stage. This is a
   *  channel-clone-local shape, not the full ProductionRow union —
   *  the existing image-gen pipeline reads these fields directly and
   *  fills in image_url, image_saliency, etc. after generation. */
  productionRows?: {
    /** "0:00-0:03" — covers ~3-5s of the script. */
    timecode: string;
    /** The narration excerpt for this row. */
    script_text: string;
    /** What category of visual this row uses. */
    visual_type: 'ai_image' | 'stock' | 'overlay';
    visual_description: string;
    /** Empty string when visual_type !== 'stock'. */
    stock_search_terms: string;
    /** Full standalone image prompt — per V2.0 STATE 14's
     *  STANDALONE RULE: never references previous prompts. */
    ai_image_prompt: string;
    /** On-screen text overlay (yellow bold word per the V2.0
     *  visual style). Empty string when none. */
    on_screen_text: string;
    /** Free-form notes — usually the LLM explaining its rationale. */
    notes: string;
  }[];
  /** Full publish-pack output from STATEs 18 (thumbnails) + 19 (SEO)
   *  + 21 (30-day calendar). Generated in a single LLM call so the
   *  same context informs each piece — keeps the calendar and the
   *  thumbnail concepts coherent with the just-approved script. */
  publishPack?: {
    /** 5 candidate titles ranked by predicted CTR. */
    titles: { text: string; ctrReasoning: string }[];
    description: string;
    /** ~30 SEO tags/keywords. */
    tags: string[];
    /** 3 candidate pinned comments that align with the channel's
     *  voice (engagement bait the audience expects). */
    pinnedCommentOptions: string[];
    categoryRecommendation: string;
    /** When the audience is most active — a free-form time-of-week
     *  string from the model rather than a structured schedule. */
    optimalUploadTime: string;
    /** 8 channel-name candidates that the LLM thinks land in the
     *  same niche / target audience / stylistic neighbourhood as the
     *  cloned source. Surfaced so the operator can find peers to
     *  study or to seed handle ideas for a brand-new channel that
     *  competes in this space. Each entry includes a short
     *  `reasoning` so the operator can see WHY the model thinks the
     *  name fits — channel discovery + transparency in one shot. */
    similarChannelNames: {
      name: string;
      reasoning: string;
    }[];
    /** 5 thumbnail design concepts. The fullImagePrompt is meant to
     *  be passed verbatim to an image generator; styleMatched=true
     *  means the prompt already incorporates the chosen style preset's
     *  ai_image_suffix. */
    thumbnailConcepts: {
      visualConcept: string;
      textOverlay: string;
      emotionTrigger: string;
      colorContrastStrategy: string;
      fullImagePrompt: string;
      ctrReasoning: string;
    }[];
    /** 30 days of follow-up video ideas keeping the channel on its
     *  WPS / hook / niche track. */
    contentCalendar: {
      day: number;
      title: string;
      angle: string;
      difficulty: number;
      bestUploadTime: string;
      contentPillar: string;
    }[];
    /** Whichever model the LLM call ran on (per the user's per-stage
     *  picker). */
    modelUsed: string;
    generatedAt: string;
  };
}
