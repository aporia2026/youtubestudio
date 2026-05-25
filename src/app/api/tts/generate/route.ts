import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import { apiRoute } from '@/lib/route-helpers';
import {
  buildElevenLabsVoiceoverKey,
  getNarrationDownloadUrl,
  uploadToBucket,
} from '@/lib/r2';
import { synthesize } from '@/lib/tts/dispatch';
import {
  TtsProviderError,
  type ProviderSpecificSynthOptions,
  type SynthesizeRequest,
  type TtsProviderId,
  type VoiceRef,
  type VoiceTier,
} from '@/lib/tts/types';
import { getEffectiveTtsSettings } from '@/lib/tts/workspace-settings';

export const maxDuration = 300;

/**
 * POST /api/tts/generate
 *
 * Dispatch-aware synthesis endpoint. The successor to
 * `/api/elevenlabs/generate` — accepts a `voice: VoiceRef` (with its
 * `providerId`) and provider-specific `options`, routes through
 * `src/lib/tts/dispatch.ts`, persists the result to R2 + a
 * `media_assets` row whose JSONB metadata carries the full provider
 * trace (provider, voiceId, voiceVersion, tier, costUsd, languageCode)
 * so re-renders six weeks later use the exact same voice.
 *
 * The existing `/api/elevenlabs/generate` route continues to work for
 * backward compatibility and now also dispatches internally.
 *
 * Request shape:
 *   {
 *     voice: { providerId, voiceId, languageCode, tier, voiceVersion? },
 *     text: string,
 *     ssml?: string,
 *     options: ElevenLabsSynthOptions | GoogleSynthOptions,
 *     projectId?: string,
 *   }
 *
 * Response: same as the legacy route — `{ url, size }` for projectId
 * paths (proxy URL), `{ url, size }` for standalone paths (presigned R2 GET).
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseRequestBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { synthReq, projectId } = parsed;

  // Workspace-level guards: Studio tier opt-in + enabled-provider
  // allowlist. Reads stored settings from workspaces.tts_settings
  // (migration 0089). UI hides forbidden options but the server is
  // authoritative — a hand-crafted POST can't bypass.
  const workspaceSettings = await getEffectiveTtsSettings(session.ws);
  if (!workspaceSettings.enabledProviders.includes(synthReq.voice.providerId)) {
    return NextResponse.json(
      {
        error: `Provider '${synthReq.voice.providerId}' is disabled for this workspace.`,
        code: 'provider_disabled',
      },
      { status: 403 },
    );
  }
  if (synthReq.voice.tier === 'studio' && !workspaceSettings.allowStudioTier) {
    return NextResponse.json(
      {
        error:
          'Google Studio tier ($160/1M chars) is disabled for this workspace. ' +
          'Enable it in Settings → Voiceover if you intend to use it.',
        code: 'studio_tier_blocked',
      },
      { status: 403 },
    );
  }

  // If a projectId was supplied, verify it belongs to this workspace
  // before we let the synth write a media_assets row scoped to a
  // foreign project. Without this check, a hand-crafted POST could
  // insert a row anchored to someone else's project. The INSERT
  // below derives workspace_id from the project, so a cross-workspace
  // projectId would silently file the asset under the wrong tenant.
  if (projectId) {
    const ownerCheck = await sql<{ workspace_id: string }>`
      SELECT workspace_id FROM projects WHERE id = ${projectId}::uuid LIMIT 1
    `;
    const ownerWs = ownerCheck.rows[0]?.workspace_id;
    if (!ownerWs) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (ownerWs !== session.ws) {
      return NextResponse.json({ error: 'Project not in this workspace' }, { status: 403 });
    }
  }

  try {
    const result = await synthesize(synthReq);

    const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
    const r2Key = buildElevenLabsVoiceoverKey(synthReq.voice.voiceId);
    await uploadToBucket(
      narrationBucket,
      r2Key,
      Buffer.from(result.audioBytes),
      'audio/mpeg',
    );

    const metadata = {
      provider: synthReq.voice.providerId,
      voiceId: synthReq.voice.voiceId,
      voiceVersion: synthReq.voice.voiceVersion ?? null,
      languageCode: synthReq.voice.languageCode,
      tier: synthReq.voice.tier,
      charCount: result.charCount,
      costUsd: result.costUsd,
      providerOptions: synthReq.options,
      providerMetadata: result.providerMetadata,
      generatedAt: new Date().toISOString(),
    };

    if (projectId) {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO media_assets (
          project_id, type, source, name, url,
          r2_bucket, r2_key, size_bytes, metadata, workspace_id
        )
        SELECT ${projectId}::uuid, 'voiceover', 'upload',
               ${`${synthReq.voice.providerId} - ${synthReq.voice.voiceId}`},
               ${''},
               ${narrationBucket}, ${r2Key}, ${result.audioBytes.byteLength},
               ${JSON.stringify(metadata)}::jsonb,
               p.workspace_id
          FROM projects p WHERE p.id = ${projectId}::uuid
        RETURNING id
      `;
      const mediaAssetId = rows[0]?.id;
      if (mediaAssetId) {
        const proxyUrl = `/api/voiceovers/${mediaAssetId}/audio`;
        await sql`UPDATE media_assets SET url = ${proxyUrl} WHERE id = ${mediaAssetId}::uuid`;
        return NextResponse.json({
          url: proxyUrl,
          size: result.audioBytes.byteLength,
          costUsd: result.costUsd,
          provider: synthReq.voice.providerId,
        });
      }
    }

    const downloadUrl = await getNarrationDownloadUrl(r2Key);
    return NextResponse.json({
      url: downloadUrl,
      size: result.audioBytes.byteLength,
      costUsd: result.costUsd,
      provider: synthReq.voice.providerId,
    });
  } catch (err) {
    if (err instanceof TtsProviderError) {
      logger.warn('[tts api generate] provider error', {
        providerId: err.providerId,
        code: err.code,
        retryable: err.retryable,
      });
      const status =
        err.code === 'unauthorized'
          ? 503
          : err.code === 'rate_limited'
            ? 429
            : err.code === 'invalid_request'
              ? 400
              : 500;
      return NextResponse.json(
        {
          error: err.message,
          providerId: err.providerId,
          code: err.code,
          retryable: err.retryable,
        },
        { status },
      );
    }
    logger.error('[tts api generate] unexpected error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 },
    );
  }
});

// ─── Request parsing ─────────────────────────────────────────────────────────

const PROVIDER_IDS: ReadonlySet<TtsProviderId> = new Set(['elevenlabs', 'google']);
const VOICE_TIERS: ReadonlySet<VoiceTier> = new Set([
  'standard',
  'wavenet',
  'neural2',
  'polyglot',
  'chirp3-hd',
  'studio',
  'multilingual-v2',
  'turbo-v2-5',
  'turbo-v2',
  'monolingual-v1',
]);

function parseRequestBody(
  raw: unknown,
):
  | { synthReq: SynthesizeRequest; projectId: string | null }
  | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Body must be a JSON object.' };
  }
  const obj = raw as Record<string, unknown>;
  const text = typeof obj.text === 'string' ? obj.text : '';
  if (!text) return { error: 'text is required and must be a non-empty string.' };

  const ssml = typeof obj.ssml === 'string' ? obj.ssml : undefined;
  const projectId =
    typeof obj.projectId === 'string' && obj.projectId ? obj.projectId : null;

  const voiceRaw = obj.voice;
  if (!voiceRaw || typeof voiceRaw !== 'object') {
    return { error: 'voice is required.' };
  }
  const v = voiceRaw as Record<string, unknown>;
  const providerId = v.providerId;
  if (typeof providerId !== 'string' || !PROVIDER_IDS.has(providerId as TtsProviderId)) {
    return { error: `voice.providerId must be one of: ${[...PROVIDER_IDS].join(', ')}.` };
  }
  const voiceId = typeof v.voiceId === 'string' ? v.voiceId.trim() : '';
  if (!voiceId) return { error: 'voice.voiceId is required.' };
  const languageCode = typeof v.languageCode === 'string' ? v.languageCode : 'en-US';
  const tier = typeof v.tier === 'string' && VOICE_TIERS.has(v.tier as VoiceTier)
    ? (v.tier as VoiceTier)
    : null;
  if (!tier) {
    return { error: `voice.tier must be one of: ${[...VOICE_TIERS].join(', ')}.` };
  }
  const voiceVersion = typeof v.voiceVersion === 'string' ? v.voiceVersion : undefined;

  const voice: VoiceRef = {
    providerId: providerId as TtsProviderId,
    voiceId,
    languageCode,
    tier,
    voiceVersion,
  };

  const options = parseOptions(providerId as TtsProviderId, obj.options);
  if ('error' in options) return { error: options.error };

  return {
    synthReq: { voice, text, ssml, options: options.value },
    projectId,
  };
}

function parseOptions(
  providerId: TtsProviderId,
  raw: unknown,
): { value: ProviderSpecificSynthOptions } | { error: string } {
  const r = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};

  if (providerId === 'elevenlabs') {
    return {
      value: {
        providerId: 'elevenlabs',
        modelId: typeof r.modelId === 'string' && r.modelId ? r.modelId : 'eleven_multilingual_v2',
        stability: typeof r.stability === 'number' ? r.stability : 0.5,
        similarity: typeof r.similarity === 'number' ? r.similarity : 0.75,
        style: typeof r.style === 'number' ? r.style : 0.5,
        useSpeakerBoost: typeof r.useSpeakerBoost === 'boolean' ? r.useSpeakerBoost : true,
      },
    };
  }

  return {
    value: {
      providerId: 'google',
      pitchSemitones: typeof r.pitchSemitones === 'number' ? r.pitchSemitones : undefined,
      speakingRate: typeof r.speakingRate === 'number' ? r.speakingRate : undefined,
      audioProfile:
        typeof r.audioProfile === 'string'
          ? (r.audioProfile as GoogleAudioProfile)
          : undefined,
    },
  };
}

type GoogleAudioProfile = Extract<
  ProviderSpecificSynthOptions,
  { providerId: 'google' }
>['audioProfile'];
