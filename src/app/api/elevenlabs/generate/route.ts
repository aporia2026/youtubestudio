import { NextRequest, NextResponse } from 'next/server';
import { generateVoiceover } from '@/lib/elevenlabs';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  buildElevenLabsVoiceoverKey,
  getNarrationDownloadUrl,
  uploadToBucket,
} from '@/lib/r2';

export const maxDuration = 300;

/**
 * POST /api/elevenlabs/generate
 *
 * Generate a voiceover via ElevenLabs and persist the bytes to the R2
 * narration bucket. Returns a stable URL the caller can store in
 * voiceover history and play back later.
 *
 * Storage moved from Vercel Blob to R2 in 2026-05-14 to align with
 * every other audio + image path in the app, and so private-access
 * Blob stores don't break voiceover playback. The audio proxy
 * (`/api/voiceovers/[id]/audio`) keeps a Blob fallback so existing
 * voiceovers from before this migration still work.
 *
 * Two response paths:
 *   - With `projectId`: insert a `media_assets` row carrying the R2
 *     key, return the same-origin proxy URL the rest of the app uses.
 *   - Without `projectId`: return a 7-day presigned R2 GET URL so the
 *     standalone voiceover page can play back the result without a DB
 *     row to anchor the proxy URL on.
 */
export async function POST(req: NextRequest) {
  try {
    const { apiKey: clientKey, text, voiceId, voiceSettings, modelId, projectId } = await req.json();
    const apiKey = clientKey || process.env.ELEVENLABS_API_KEY || '';

    if (!apiKey) return NextResponse.json({ error: 'ElevenLabs API key required' }, { status: 400 });
    if (!text || !voiceId) return NextResponse.json({ error: 'text and voiceId required' }, { status: 400 });

    // Generate voiceover
    const audioBuffer = await generateVoiceover(apiKey, {
      text,
      voiceId,
      voiceSettings,
      modelId: modelId || 'eleven_multilingual_v2',
    });

    // Upload to R2 narration bucket. Bytes are already in memory from
    // the ElevenLabs response, so a direct server-side put is faster
    // and cheaper than presigned-URL + browser-relay.
    const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
    const r2Key = buildElevenLabsVoiceoverKey(voiceId);
    await uploadToBucket(narrationBucket, r2Key, Buffer.from(audioBuffer), 'audio/mpeg');

    // Save to project if provided. workspace_id is NOT NULL on media_assets
    // since migration 0013 — copy it from the parent project. The row
    // carries r2_bucket + r2_key so the audio proxy streams through R2,
    // and `url` is the same-origin proxy path the rest of the app reads.
    if (projectId) {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO media_assets (
          project_id, type, source, name, url,
          r2_bucket, r2_key, size_bytes, metadata, workspace_id
        )
        SELECT ${projectId}::uuid, 'voiceover', 'upload', ${`ElevenLabs - ${voiceId}`},
               ${''},
               ${narrationBucket}, ${r2Key}, ${audioBuffer.byteLength},
               ${JSON.stringify({ voiceId, modelId, generatedAt: new Date().toISOString() })}::jsonb,
               p.workspace_id
          FROM projects p WHERE p.id = ${projectId}::uuid
        RETURNING id
      `;
      const mediaAssetId = rows[0]?.id;
      if (mediaAssetId) {
        // Update the row's url to the proxy path now that we know the id.
        // Done as a follow-up UPDATE so the INSERT doesn't need a CTE.
        const proxyUrl = `/api/voiceovers/${mediaAssetId}/audio`;
        await sql`UPDATE media_assets SET url = ${proxyUrl} WHERE id = ${mediaAssetId}::uuid`;
        return NextResponse.json({ url: proxyUrl, size: audioBuffer.byteLength });
      }
    }

    // Standalone path — no project row, return a presigned R2 GET URL.
    // Lives for 7 days (the helper's default), enough for the
    // voiceover-history flow on the /voiceover page to find and replay
    // it on a return visit.
    const downloadUrl = await getNarrationDownloadUrl(r2Key);
    return NextResponse.json({ url: downloadUrl, size: audioBuffer.byteLength });
  } catch (err: unknown) {
    logger.error('ElevenLabs generation error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 }
    );
  }
}
