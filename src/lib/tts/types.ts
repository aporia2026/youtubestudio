/**
 * TTS provider abstraction — contracts and shared shapes.
 *
 * Two separate contracts, not one fused `generate`:
 *   - Synthesizer: text → audio bytes
 *   - Aligner:     audio + script → word-level timings
 *
 * Providers register independently for each. ElevenLabs implements both
 * (`/v1/text-to-speech` + `/v1/forced-alignment`). Google ships them as
 * separate products (Cloud TTS + Cloud Speech-to-Text). Fusing the
 * contracts would lock the codebase out of cheap free aligners
 * (whisperX, MFA) we may swap in later, and would make the audio-format
 * mismatch bugs from feeding TTS output back through STT silently
 * worse. See _plans/2026-05-25-google-tts-voiceover-provider.md for the
 * full architecture writeup.
 *
 * Storage and persistence are NOT this layer's concern — the dispatcher
 * (`src/lib/tts/dispatch.ts`) returns raw bytes + metadata, and routes
 * are responsible for the R2 mirror + `media_assets` row. That keeps
 * providers pure (mockable, no DB), and lets routes choose their own
 * key prefix per surface (voiceover studio vs editor regen vs shorts).
 */

// ─── Provider identity ───────────────────────────────────────────────────────

export type TtsProviderId = 'elevenlabs' | 'google';

export type TtsAlignerId = 'elevenlabs' | 'google-stt';

/**
 * Google voice tier — leaks into the catalog UI as secondary metadata
 * (the picker primary axis is language → quality band). Source of truth
 * for prices lives in `src/lib/tts/cost.ts`; this enum is just the
 * stable set of identifiers the catalog + cost table both reference.
 */
export type GoogleVoiceTier =
  | 'standard'
  | 'wavenet'
  | 'neural2'
  | 'polyglot'
  | 'chirp3-hd'
  | 'studio'
  // Gemini-TTS models (added 2026-05-26). Reuse the Chirp voice names
  // (Charon, Aoede, etc.) but synthesize through Gemini's controllable
  // models — accepts a natural-language style prompt + inline audio
  // tags like [laughs], [whispering]. See
  // docs.cloud.google.com/text-to-speech/docs/gemini-tts. The catalog
  // generates synthetic entries per Chirp voice × Gemini model so the
  // unified picker shows each as its own card.
  | 'gemini-25-flash-tts'
  | 'gemini-31-flash-tts';

/**
 * ElevenLabs "tier" maps onto the model used (multilingual vs turbo).
 * Kept symmetrical with `GoogleVoiceTier` so the cost table can key
 * uniformly on `tier`.
 */
export type ElevenLabsVoiceTier =
  | 'multilingual-v2'
  | 'turbo-v2-5'
  | 'turbo-v2'
  | 'monolingual-v1';

export type VoiceTier = GoogleVoiceTier | ElevenLabsVoiceTier;

// ─── Voice identity ──────────────────────────────────────────────────────────

/**
 * A specific voice from a specific provider. `voiceVersion` exists so
 * a re-render six weeks later still uses the exact voice that was
 * picked when the project was created — Google has deprecated voices
 * before and ElevenLabs has too. Persist this alongside `voiceId` in
 * `media_assets.metadata` and the renderer fails loud (rather than
 * silently swapping) if the voice is gone.
 */
export interface VoiceRef {
  providerId: TtsProviderId;
  voiceId: string;
  /** BCP-47 language code (e.g. 'he-IL', 'en-US'). */
  languageCode: string;
  /** Provider-supplied version/etag if exposed; otherwise undefined. */
  voiceVersion?: string;
  /** Convenience copy of the tier so the cost table can be looked up
   *  without a round trip to the voice catalog. */
  tier: VoiceTier;
}

// ─── Provider-specific options (tagged union by providerId) ─────────────────

export interface ElevenLabsSynthOptions {
  providerId: 'elevenlabs';
  /** e.g. 'eleven_multilingual_v2', 'eleven_turbo_v2_5'. */
  modelId: string;
  stability: number;          // 0–1
  similarity: number;         // 0–1
  style: number;              // 0–1
  useSpeakerBoost: boolean;
}

export interface GoogleSynthOptions {
  providerId: 'google';
  /** -20.0 to +20.0 semitones. Chirp 3 HD ignores this — log a warning
   *  and proceed (do not throw). */
  pitchSemitones?: number;
  /** 0.25–4.0; 1.0 = normal. Chirp 3 HD ignores. */
  speakingRate?: number;
  /** Output audio target profile — Google applies a post-EQ filter.
   *  'small-bluetooth-speaker-class-device' is the closest match for
   *  YouTube playback on phones. Default 'medium-bluetooth-speaker-class-device'. */
  audioProfile?:
    | 'wearable-class-device'
    | 'handset-class-device'
    | 'headphone-class-device'
    | 'small-bluetooth-speaker-class-device'
    | 'medium-bluetooth-speaker-class-device'
    | 'large-home-entertainment-class-device'
    | 'large-automotive-class-device'
    | 'telephony-class-application';
  /** Gemini-TTS only: natural-language style instructions sent in the
   *  `input.prompt` field alongside `input.text`. Example:
   *  "Read this conspiratorially, building to an excited reveal at the
   *  end." Up to 4,000 bytes; combined with text must not exceed
   *  8,000 bytes. Ignored when the voice is not a Gemini-TTS variant. */
  stylePrompt?: string;
}

export type ProviderSpecificSynthOptions = ElevenLabsSynthOptions | GoogleSynthOptions;

// ─── Synthesizer contract ────────────────────────────────────────────────────

export interface SynthesizeRequest {
  voice: VoiceRef;
  /** When `ssml` is set it takes precedence over `text` (provider-
   *  permitting; Chirp 3 HD streams ignore SSML). The dispatcher
   *  normalizes between providers — callers always pass text + optional
   *  ssml, providers handle the rest. */
  text: string;
  ssml?: string;
  options: ProviderSpecificSynthOptions;
}

export interface SynthesizeResult {
  /** MP3 bytes. The pipeline always wants MP3; providers convert
   *  internally if their native format differs (Google can emit MP3
   *  directly via `audioEncoding: 'MP3'`). */
  audioBytes: Uint8Array;
  mimeType: 'audio/mpeg' | 'audio/wav';
  /** Spoken duration in seconds, parsed from the audio header on the
   *  server (not provider metadata) so the value is consistent across
   *  providers. */
  durationSeconds: number;
  /** Number of characters billed — usually `text.length`, but providers
   *  may count differently (Google counts the script post-SSML
   *  normalization). Provider returns its own count. */
  charCount: number;
  /** Estimated cost in USD, based on the provider's published per-tier
   *  rate. This is a DISPLAY estimate, not the bill of record — actual
   *  GCP/ElevenLabs invoices may differ slightly. */
  costUsd: number;
  /** Raw vendor response bits (request id, model used, audio
   *  metadata) kept for debugging. Routes can persist this into
   *  `media_assets.metadata.providerMetadata` if useful. */
  providerMetadata: Record<string, unknown>;
}

export interface VoiceCatalogEntry {
  voice: VoiceRef;
  /** Display name, e.g. 'Charon' or 'Rachel'. */
  displayName: string;
  /** Free-form description ('warm narrator', 'energetic'). May be empty. */
  description?: string;
  /** 'male' | 'female' | 'neutral' — best-effort, may be missing. */
  gender?: 'male' | 'female' | 'neutral';
  /** Public preview URL, if the provider exposes one. ElevenLabs does;
   *  Google does not (we synthesize a short sample on demand). */
  previewUrl?: string;
}

export interface ListVoicesFilter {
  /** BCP-47 prefix match — 'he' matches 'he-IL'. */
  languageCode?: string;
  tier?: VoiceTier;
}

export interface Synthesizer {
  readonly id: TtsProviderId;
  /** Returns true if the provider is configured (env vars present). The
   *  dispatcher hides un-configured providers from the picker UI. */
  isConfigured(): boolean;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
  listVoices(filter?: ListVoicesFilter): Promise<VoiceCatalogEntry[]>;
  /** Pre-flight cost estimate for the picker UI. Pure function — does
   *  not call the network. */
  estimateCost(req: Pick<SynthesizeRequest, 'voice' | 'text' | 'ssml'>): number;
}

// ─── Aligner contract ────────────────────────────────────────────────────────

export interface AlignRequest {
  /** Originating voice — the dispatcher selects the appropriate aligner
   *  by `voice.providerId` (ElevenLabs → ElevenLabs forced-alignment;
   *  Google → Google STT). */
  voice: VoiceRef;
  audio: Uint8Array;
  mimeType: 'audio/mpeg' | 'audio/wav';
  /** Known script text. Forced alignment locks recognition to this
   *  text — accuracy is much higher on proper nouns and brand names
   *  than free-form ASR. Strip production cues / stage directions
   *  before passing in. */
  text: string;
  /** BCP-47, e.g. 'he-IL'. Required even though `voice.languageCode`
   *  carries the same info — aligners may receive audio from a
   *  user-uploaded file with no voice metadata. */
  languageCode: string;
}

export interface AlignedWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface AlignResult {
  words: AlignedWord[];
  /** Total spoken duration in seconds (end of last word). */
  durationSec: number;
  /** Estimated alignment cost in USD. 0 when alignment came from a
   *  free local aligner (future: whisperX). */
  costUsd: number;
  alignerUsed: TtsAlignerId;
}

export interface Aligner {
  readonly id: TtsAlignerId;
  isConfigured(): boolean;
  supportsLanguage(code: string): boolean;
  align(req: AlignRequest): Promise<AlignResult>;
}

// ─── Error shape ─────────────────────────────────────────────────────────────

/**
 * Thrown by providers/aligners when a vendor call fails. The dispatcher
 * unwraps `code` + `retryable` to decide whether to surface a transient
 * error in the UI vs. a permanent one. `vendorMessage` is sanitised
 * before reaching the client — routes should never echo it verbatim.
 */
export class TtsProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: TtsProviderId | TtsAlignerId,
    public readonly code:
      | 'unauthorized'
      | 'rate_limited'
      | 'invalid_request'
      | 'vendor_5xx'
      | 'timeout'
      | 'unsupported_language'
      | 'unknown',
    public readonly retryable: boolean,
    public readonly vendorMessage?: string,
  ) {
    super(message);
    this.name = 'TtsProviderError';
  }
}
