// ElevenLabs Pro API integration

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  description?: string;
  preview_url?: string;
  labels: Record<string, string>;
  fine_tuning?: {
    language?: string;
    accent?: string;
    age?: string;
    gender?: string;
    use_case?: string;
  };
}

export interface VoiceSettings {
  stability: number;          // 0-1
  similarity_boost: number;   // 0-1
  style: number;              // 0-1
  use_speaker_boost: boolean;
}

export interface GenerateVoiceoverOptions {
  text: string;
  voiceId: string;
  voiceSettings?: Partial<VoiceSettings>;
  modelId?: string; // e.g. 'eleven_multilingual_v2', 'eleven_turbo_v2_5'
}

export const ELEVENLABS_MODELS = [
  { id: 'eleven_multilingual_v2', name: 'Multilingual v2', description: 'Best quality, 29 languages', latency: 'high' },
  { id: 'eleven_turbo_v2_5', name: 'Turbo v2.5', description: 'Fastest, great quality', latency: 'low' },
  { id: 'eleven_turbo_v2', name: 'Turbo v2', description: 'Fast, English only', latency: 'low' },
  { id: 'eleven_monolingual_v1', name: 'English v1', description: 'Classic English model', latency: 'medium' },
];

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.5,
  use_speaker_boost: true,
};

export async function getVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`ElevenLabs API error: ${res.status}`);
  const data = await res.json();
  return data.voices || [];
}

export async function generateVoiceover(
  apiKey: string,
  opts: GenerateVoiceoverOptions
): Promise<ArrayBuffer> {
  const settings: VoiceSettings = {
    ...DEFAULT_VOICE_SETTINGS,
    ...opts.voiceSettings,
  };

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${opts.voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: opts.text,
        model_id: opts.modelId || 'eleven_multilingual_v2',
        voice_settings: settings,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs generation failed: ${err}`);
  }

  return res.arrayBuffer();
}

export async function getVoicePreview(voiceId: string): Promise<string> {
  return `https://api.elevenlabs.io/v1/voices/${voiceId}/preview`;
}

export async function getUserSubscription(apiKey: string) {
  const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function getUserInfo(apiKey: string) {
  const res = await fetch('https://api.elevenlabs.io/v1/user', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) return null;
  return res.json();
}

// Forced alignment: given an audio file and the known script text, return
// per-word + per-character timing in seconds. Used by the Narration tab's
// synced player to highlight the active word during playback. Unlike pure
// ASR, this locks recognition to the supplied text — accuracy is much
// higher on proper nouns / brand names because the model isn't guessing
// what was said, only when.
//
// Endpoint: https://elevenlabs.io/docs/api-reference/forced-alignment/create
// Billed under the Scribe STT tier (~$0.22/hr as of May 2026).

export interface ForcedAlignmentWord {
  text: string;
  start: number;          // seconds from file start
  end: number;            // seconds from file start
  loss?: number;          // per-word confidence loss; higher = lower confidence
}

export interface ForcedAlignmentCharacter {
  text: string;
  start: number;
  end: number;
}

export interface ForcedAlignmentResponse {
  words: ForcedAlignmentWord[];
  characters?: ForcedAlignmentCharacter[];
  loss?: number;          // overall alignment loss score
}

export interface ForceAlignOptions {
  audioBlob: Blob;
  audioFilename?: string; // hint for ElevenLabs; defaults to 'audio.mp3'
  text: string;           // script text — production cues should be stripped before calling
}

export async function forceAlign(
  apiKey: string,
  opts: ForceAlignOptions,
): Promise<ForcedAlignmentResponse> {
  const form = new FormData();
  form.append('file', opts.audioBlob, opts.audioFilename || 'audio.mp3');
  form.append('text', opts.text);

  const res = await fetch('https://api.elevenlabs.io/v1/forced-alignment', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    // Read the body for a short reason but do not leak it raw — callers
    // should surface only a sanitised string to end users.
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs forced alignment failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  return res.json() as Promise<ForcedAlignmentResponse>;
}
