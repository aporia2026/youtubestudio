import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { sql } from '@vercel/postgres';
import { getAssignment, getRealSectionsForAssignment } from '@/lib/narrator-db';
import { getNarrationDownloadUrl } from '@/lib/r2';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Stitch all approved takes into a single voiceover file.
 * Concatenates MP3 files in section order with a brief silence gap.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const assignment = await getAssignment(id);
    if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Real sections only — the synthetic section 0 is the holder for the
    // single-file full-audio upload; including it here would prepend the
    // entire narration to the stitched output, doubling the audio.
    const sections = await getRealSectionsForAssignment(id);

    // Collect audio URLs for approved/selected/latest take in each section.
    // For R2-backed takes we regenerate a fresh presigned URL from r2_key
    // (the stored audio_url may have expired).
    const audioUrls: string[] = [];
    for (const section of sections) {
      const takes = section.takes || [];
      type Take = { id: string; audio_url: string; r2_key?: string | null; is_selected: boolean };
      let take: Take | null = null;
      if (section.approved_take_id) {
        take = takes.find((t: Take) => t.id === section.approved_take_id) || null;
      }
      if (!take) take = takes.find((t: Take) => t.is_selected) || null;
      if (!take && takes.length > 0) take = takes[0]; // Latest (sorted desc)
      if (!take) continue;
      // Prefer regenerating from r2_key; fall back to the stored URL for legacy Vercel Blob takes.
      if (take.r2_key) {
        try {
          audioUrls.push(await getNarrationDownloadUrl(take.r2_key));
        } catch {
          if (take.audio_url) audioUrls.push(take.audio_url);
        }
      } else if (take.audio_url) {
        audioUrls.push(take.audio_url);
      }
    }

    if (audioUrls.length === 0) {
      return NextResponse.json({ error: 'No takes to stitch' }, { status: 400 });
    }

    // Download all audio files. Accept both Vercel Blob (legacy takes) and
    // Cloudflare R2 (new takes from the narration bucket).
    const ALLOWED_HOST_SUFFIXES = ['blob.vercel-storage.com', 'r2.cloudflarestorage.com', 'r2.dev'];
    const customR2Public = process.env.R2_NARRATION_PUBLIC_URL;
    if (customR2Public) {
      try { ALLOWED_HOST_SUFFIXES.push(new URL(customR2Public).hostname); } catch {}
    }
    const audioBuffers: ArrayBuffer[] = [];
    for (const url of audioUrls) {
      try {
        const parsed = new URL(url);
        if (!ALLOWED_HOST_SUFFIXES.some(h => parsed.hostname.endsWith(h))) {
          return NextResponse.json({ error: `Invalid audio source: ${parsed.hostname}` }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: 'Invalid audio URL' }, { status: 400 });
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch audio`);
      audioBuffers.push(await res.arrayBuffer());
    }

    // Simple binary concatenation for MP3 files
    // MP3 is frame-based so concatenation works without re-encoding
    const totalSize = audioBuffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const stitched = new Uint8Array(totalSize);
    let offset = 0;
    for (const buf of audioBuffers) {
      stitched.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    // Upload stitched file to Vercel Blob
    const pathname = `narrator-stitched/${assignment.project_id}/${Date.now()}-stitched.mp3`;
    const blob = await put(pathname, new Blob([stitched], { type: 'audio/mpeg' }), { access: 'public', contentType: 'audio/mpeg' });

    // Save as media_asset on the project. workspace_id is NOT NULL on
    // media_assets since migration 0013 — copy it from the parent project.
    await sql`
      INSERT INTO media_assets (project_id, type, source, name, url, blob_pathname, size_bytes, metadata, workspace_id)
      SELECT ${assignment.project_id}::uuid, 'voiceover', 'upload',
             ${`Narration — ${assignment.narrator_name}`},
             ${blob.url}, ${blob.pathname}, ${totalSize},
             ${JSON.stringify({ narrator_id: assignment.narrator_id, assignment_id: id, stitched: true, sections: audioUrls.length })}::jsonb,
             p.workspace_id
        FROM projects p WHERE p.id = ${assignment.project_id}::uuid
    `;

    // Update assignment status
    await sql`UPDATE narrator_assignments SET status = 'completed', updated_at = NOW() WHERE id = ${id}`;

    return NextResponse.json({ url: blob.url, size: totalSize, sections: audioUrls.length });
  } catch (err) {
    logger.error('stitch error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to stitch audio' }, { status: 500 });
  }
}
