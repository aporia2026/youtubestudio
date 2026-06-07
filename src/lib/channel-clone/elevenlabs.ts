/**
 * Thin ElevenLabs REST wrapper used by the channel-clone voice
 * cloning routes (Plan 1B).
 *
 * Three functions:
 *   - `cloneInstantVoice` — POST /v1/voices/add (multipart). Creates
 *     an Instant Voice Clone from an audio buffer the caller already
 *     has in memory. Returns `{ voice_id }`. Cloning is included on
 *     every paid tier from Starter ($6/mo) upward — verified live
 *     2026-06-07 on elevenlabs.io/pricing.
 *   - `deleteVoice`        — DELETE /v1/voices/{voice_id}. Lets the
 *     operator reclaim a voice slot on their account when they
 *     decide they don't want to keep the clone.
 *   - `getSubscriptionTier` — GET /v1/user/subscription. Surfaces
 *     the current plan name + characters-left counter so the panel
 *     can show "Pro plan · 84k credits left" alongside the clone
 *     button.
 *
 * Security:
 *   - ELEVENLABS_API_KEY env var is the single source of the credential
 *     (NEVER on the client, NEVER in logs). The routes in
 *     `src/app/api/channel-clone/voice/*` are the only callers.
 *   - 401/403 → "API key invalid / not authorised" (NEVER include the
 *     attempted key in the surfaced error).
 *   - 422 (voice-ownership attestation) → "ownership ack required";
 *     callers must surface ElevenLabs' voice-ownership ToS click
 *     before they let the operator press Clone.
 *
 * See _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md.
 */

import { logger } from '@/lib/logger';

const ELEVEN_BASE = 'https://api.elevenlabs.io';

export class ElevenLabsApiError extends Error {
  readonly status: number;
  /** "auth" / "quota" / "ownership" / "rate-limit" / "server" / "unknown" —
   *  drives the operator-visible error string in the panel. */
  readonly kind: ElevenLabsErrorKind;

  constructor(status: number, kind: ElevenLabsErrorKind, message: string) {
    super(message);
    this.name = 'ElevenLabsApiError';
    this.status = status;
    this.kind = kind;
  }
}

export type ElevenLabsErrorKind =
  | 'missing-key'
  | 'auth'
  | 'quota'
  | 'ownership'
  | 'rate-limit'
  | 'server'
  | 'unknown';

export interface CloneInstantVoiceInput {
  /** ElevenLabs ApiKey. Passed in explicitly so the function never
   *  reads `process.env` directly — makes the call testable with a
   *  mocked fetch. The routes resolve the key once and forward. */
  apiKey: string;
  /** Display name for the cloned voice. Shown in the operator's
   *  ElevenLabs dashboard. */
  name: string;
  /** Audio bytes — the channel-clone voice sample. ElevenLabs
   *  accepts MP3 + WAV at minimum. */
  mp3Buffer: Buffer;
  /** Operator-supplied description (also used in the
   *  ElevenLabs UI). Optional. */
  description?: string;
  /** Optional labels: language, accent, gender, age. Free-form
   *  string→string map per the docs. */
  labels?: Record<string, string>;
  /** Optional fetch override — wired in tests so we can mock the
   *  network without spinning up an http stub. */
  fetchImpl?: typeof fetch;
}

export interface CloneInstantVoiceResult {
  voiceId: string;
  /** ElevenLabs sets this when the source audio is not yet attested
   *  for voice ownership. v1 of this integration always sets the
   *  required ack BEFORE upload, so this stays false in normal use. */
  requiresVerification: boolean;
}

/** Upload an audio buffer to ElevenLabs as a new Instant Voice Clone.
 *  Returns the new voice_id. Throws `ElevenLabsApiError` on failure. */
export async function cloneInstantVoice(
  input: CloneInstantVoiceInput,
): Promise<CloneInstantVoiceResult> {
  if (!input.apiKey) {
    throw new ElevenLabsApiError(0, 'missing-key', 'ELEVENLABS_API_KEY is not configured.');
  }
  if (!input.name.trim()) {
    throw new ElevenLabsApiError(0, 'unknown', 'Voice name is required.');
  }
  if (input.mp3Buffer.length === 0) {
    throw new ElevenLabsApiError(0, 'unknown', 'Audio buffer is empty — nothing to clone.');
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('name', input.name.trim());
  if (input.description) form.append('description', input.description.trim());
  if (input.labels && Object.keys(input.labels).length > 0) {
    form.append('labels', JSON.stringify(input.labels));
  }
  // Files MUST be appended with a filename; ElevenLabs uses the
  // filename in the file picker UI on their side.
  const blob = new Blob([new Uint8Array(input.mp3Buffer)], { type: 'audio/mpeg' });
  form.append('files', blob, 'narrator-sample.mp3');

  // NEVER log the api key — only the first two chars (defensive — the
  // logger.info call below is for diagnostics, not auth audit).
  logger.info('[channel-clone elevenlabs] clone start', {
    name: input.name,
    bytes: input.mp3Buffer.length,
    hasDescription: Boolean(input.description),
    labelKeys: Object.keys(input.labels ?? {}),
  });

  let res: Response;
  try {
    res = await fetchImpl(`${ELEVEN_BASE}/v1/voices/add`, {
      method: 'POST',
      headers: {
        'xi-api-key': input.apiKey,
        // Content-Type intentionally omitted — fetch sets it
        // including the multipart boundary when body is a FormData.
      },
      body: form,
    });
  } catch (err) {
    throw new ElevenLabsApiError(0, 'server', `Network error reaching ElevenLabs: ${errorMessage(err)}`);
  }

  if (!res.ok) {
    const detail = await safeReadText(res);
    throw classifyElevenLabsError(res.status, detail, 'clone');
  }

  let json: { voice_id?: string; requires_verification?: boolean };
  try {
    json = (await res.json()) as { voice_id?: string; requires_verification?: boolean };
  } catch (err) {
    throw new ElevenLabsApiError(res.status, 'unknown', `ElevenLabs returned non-JSON: ${errorMessage(err)}`);
  }
  if (!json.voice_id) {
    throw new ElevenLabsApiError(res.status, 'unknown', 'ElevenLabs response missing voice_id.');
  }
  logger.info('[channel-clone elevenlabs] clone done', { voiceId: json.voice_id });
  return {
    voiceId: json.voice_id,
    requiresVerification: Boolean(json.requires_verification),
  };
}

export interface DeleteVoiceInput {
  apiKey: string;
  voiceId: string;
  fetchImpl?: typeof fetch;
}

/** Remove a cloned voice from the ElevenLabs account. */
export async function deleteVoice(input: DeleteVoiceInput): Promise<void> {
  if (!input.apiKey) {
    throw new ElevenLabsApiError(0, 'missing-key', 'ELEVENLABS_API_KEY is not configured.');
  }
  if (!input.voiceId) {
    throw new ElevenLabsApiError(0, 'unknown', 'voiceId is required.');
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  logger.info('[channel-clone elevenlabs] delete start', { voiceId: input.voiceId });

  let res: Response;
  try {
    res = await fetchImpl(`${ELEVEN_BASE}/v1/voices/${encodeURIComponent(input.voiceId)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': input.apiKey },
    });
  } catch (err) {
    throw new ElevenLabsApiError(0, 'server', `Network error reaching ElevenLabs: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw classifyElevenLabsError(res.status, detail, 'delete');
  }
  logger.info('[channel-clone elevenlabs] delete done', { voiceId: input.voiceId });
}

export interface SubscriptionTierResult {
  /** "free" / "starter" / "creator" / "pro" / "scale" / "business",
   *  per ElevenLabs' tier slugs. Surfaced verbatim to the UI. */
  tier: string;
  /** Remaining character quota in the current billing period.
   *  Surfaced as "X credits left" on the panel. */
  charactersLeft: number;
}

export interface GetSubscriptionTierInput {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Pull the operator's current subscription tier + remaining
 *  characters. Cheap GET, no spend. */
export async function getSubscriptionTier(
  input: GetSubscriptionTierInput,
): Promise<SubscriptionTierResult> {
  if (!input.apiKey) {
    throw new ElevenLabsApiError(0, 'missing-key', 'ELEVENLABS_API_KEY is not configured.');
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${ELEVEN_BASE}/v1/user/subscription`, {
      method: 'GET',
      headers: { 'xi-api-key': input.apiKey },
    });
  } catch (err) {
    throw new ElevenLabsApiError(0, 'server', `Network error reaching ElevenLabs: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw classifyElevenLabsError(res.status, detail, 'subscription');
  }
  const json = (await res.json()) as {
    tier?: string;
    character_count?: number;
    character_limit?: number;
  };
  const tier = typeof json.tier === 'string' ? json.tier : 'unknown';
  const used = Number(json.character_count ?? 0);
  const limit = Number(json.character_limit ?? 0);
  const charactersLeft = Math.max(0, limit - used);
  return { tier, charactersLeft };
}

/** Translate an ElevenLabs HTTP error into one of our coarse kinds
 *  so the routes can map it to a human-readable line. */
export function classifyElevenLabsError(
  status: number,
  body: string,
  context: 'clone' | 'delete' | 'subscription',
): ElevenLabsApiError {
  // ElevenLabs' error JSON typically wraps the message in
  // `{ "detail": { "message": "...", "status": "..." } }`. We try
  // to parse it but fall back to the raw text so nothing is lost.
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { detail?: { message?: string; status?: string } | string };
    if (typeof parsed.detail === 'string') {
      detail = parsed.detail;
    } else if (parsed.detail && typeof parsed.detail.message === 'string') {
      detail = parsed.detail.message;
    }
  } catch {
    // Plain-text error body — keep as-is.
  }
  detail = detail.slice(0, 400);

  if (status === 401 || status === 403) {
    return new ElevenLabsApiError(status, 'auth', `ElevenLabs auth rejected: ${detail || 'API key invalid or unauthorised'}.`);
  }
  if (status === 429) {
    return new ElevenLabsApiError(status, 'rate-limit', `ElevenLabs rate-limited (429): ${detail}.`);
  }
  if (status === 402 || /quota|character_limit|insufficient/i.test(detail)) {
    return new ElevenLabsApiError(status, 'quota', `ElevenLabs plan quota exhausted: ${detail || 'no credits remaining'}.`);
  }
  if (status === 422 || /verification|ownership|consent/i.test(detail)) {
    return new ElevenLabsApiError(status, 'ownership', `ElevenLabs needs a voice-ownership attestation: ${detail}.`);
  }
  if (status >= 500) {
    return new ElevenLabsApiError(status, 'server', `ElevenLabs server error (${status}) on ${context}: ${detail}.`);
  }
  return new ElevenLabsApiError(status, 'unknown', `ElevenLabs ${context} failed (${status}): ${detail}.`);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
