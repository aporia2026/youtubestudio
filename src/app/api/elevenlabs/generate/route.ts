import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  buildElevenLabsVoiceoverKey,
  getNarrationDownloadUrl,
  mimeTypeToExt,
  uploadToBucket,
} from '@/lib/r2';
import { synthesize } from '@/lib/tts/dispatch';
import { TtsProviderError } from '@/lib/tts/types';

export const maxDuration = 800;

/**
 * POST /api/elevenlabs/generate
 *
 * Legacy endpoint — kept for backward compatibility. New callers
 * should target `/api/tts/generate` which carries the full dispatch-
 * aware request shape. This route accepts the original
 * `{ apiKey?, text, voiceId, voiceSettings?, modelId?, projectId? }`
 * body and internally dispatches through `src/lib/tts/dispatch.ts`
 * with a hard-coded `providerId: 'elevenlabs'`.
 *
 * The `apiKey` request field is now ignored — server-side
 * `ELEVENLABS_API_KEY` is the only source. The previous client-side
 * override path leaked the key into request payloads and never
 * matched the rest-of-app convention; removed during the dispatch
 * migration 2026-05-25.
 */
export async function POST(req: NextRequest) {
  try {
    const { text, voiceId, voiceSettings, modelId, projectId } = await req.json();
    if (!text || !voiceId) {
      return NextResponse.json({ error: 'text and voiceId required' }, { status: 400 });
    }

    const effectiveModelId =
      typeof modelId === 'string' && modelId ? modelId : 'eleven_multilingual_v2';
    const tier =
      effectiveModelId === 'eleven_turbo_v2_5'
        ? 'turbo-v2-5'
        : effectiveModelId === 'eleven_turbo_v2'
          ? 'turbo-v2'
          : effectiveModelId === 'eleven_monolingual_v1'
            ? 'monolingual-v1'
            : 'multilingual-v2';

    const settings = (voiceSettings && typeof voiceSettings === 'object'
      ? voiceSettings
      : {}) as Record<string, unknown>;

    const result = await synthesize(
      {
        voice: {
          providerId: 'elevenlabs',
          voiceId,
          languageCode: 'en-US',
          tier,
        },
        text,
        options: {
          providerId: 'elevenlabs',
          modelId: effectiveModelId,
          stability: typeof settings.stability === 'number' ? settings.stability : 0.5,
          similarity:
            typeof settings.similarity_boost === 'number' ? settings.similarity_boost : 0.75,
          style: typeof settings.style === 'number' ? settings.style : 0.5,
          useSpeakerBoost:
            typeof settings.use_speaker_boost === 'boolean' ? settings.use_speaker_boost : true,
        },
      },
      req.signal,
    );

    const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
    const ext = mimeTypeToExt(result.mimeType);
    const r2Key = buildElevenLabsVoiceoverKey(voiceId, ext);
    await uploadToBucket(
      narrationBucket,
      r2Key,
      Buffer.from(result.audioBytes),
      result.mimeType,
    );

    if (projectId) {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO media_assets (
          project_id, type, source, name, url,
          r2_bucket, r2_key, size_bytes, metadata, workspace_id
        )
        SELECT ${projectId}::uuid, 'voiceover', 'upload', ${`ElevenLabs - ${voiceId}`},
               ${''},
               ${narrationBucket}, ${r2Key}, ${result.audioBytes.byteLength},
               ${JSON.stringify({
                 provider: 'elevenlabs',
                 voiceId,
                 modelId: effectiveModelId,
                 tier,
                 languageCode: 'en-US',
                 charCount: result.charCount,
                 costUsd: result.costUsd,
                 generatedAt: new Date().toISOString(),
               })}::jsonb,
               p.workspace_id
          FROM projects p WHERE p.id = ${projectId}::uuid
        RETURNING id
      `;
      const mediaAssetId = rows[0]?.id;
      if (mediaAssetId) {
        const proxyUrl = `/api/voiceovers/${mediaAssetId}/audio`;
        await sql`UPDATE media_assets SET url = ${proxyUrl} WHERE id = ${mediaAssetId}::uuid`;
        return NextResponse.json({ url: proxyUrl, size: result.audioBytes.byteLength });
      }
    }

    const downloadUrl = await getNarrationDownloadUrl(r2Key);
    return NextResponse.json({ url: downloadUrl, size: result.audioBytes.byteLength });
  } catch (err: unknown) {
    if (err instanceof TtsProviderError) {
      const status =
        err.code === 'unauthorized'
          ? 503
          : err.code === 'rate_limited'
            ? 429
            : err.code === 'invalid_request'
              ? 400
              : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    logger.error('ElevenLabs generation error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 },
    );
  }
}
