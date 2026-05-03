import { NextRequest, NextResponse } from 'next/server';
import { generateVoiceover } from '@/lib/elevenlabs';
import { put } from '@vercel/blob';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

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

    // Upload to Vercel Blob
    const filename = `voiceover/${Date.now()}-${voiceId}.mp3`;
    const blob = await put(filename, audioBuffer, {
      access: 'public',
      contentType: 'audio/mpeg',
      addRandomSuffix: true,
    });

    // Save to project if provided. workspace_id is NOT NULL on media_assets
    // since migration 0013 — copy it from the parent project.
    if (projectId) {
      await sql`
        INSERT INTO media_assets (project_id, type, source, name, url, blob_pathname, size_bytes, metadata, workspace_id)
        SELECT ${projectId}::uuid, 'voiceover', 'upload', ${`ElevenLabs - ${voiceId}`},
               ${blob.url}, ${blob.pathname}, ${audioBuffer.byteLength},
               ${JSON.stringify({ voiceId, modelId, generatedAt: new Date().toISOString() })}::jsonb,
               p.workspace_id
          FROM projects p WHERE p.id = ${projectId}::uuid
      `;
    }

    return NextResponse.json({ url: blob.url, size: audioBuffer.byteLength });
  } catch (err: unknown) {
    logger.error('ElevenLabs generation error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 }
    );
  }
}
