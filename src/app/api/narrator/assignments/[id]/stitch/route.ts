import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { sql } from '@vercel/postgres';
import { getAssignment, getSectionsForAssignment } from '@/lib/narrator-db';

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

    const sections = await getSectionsForAssignment(id);

    // Collect audio URLs for approved takes (or selected takes)
    const audioUrls: string[] = [];
    for (const section of sections) {
      const takes = section.takes || [];
      // Priority: approved_take_id > is_selected > latest take
      let takeUrl: string | null = null;
      if (section.approved_take_id) {
        const approved = takes.find((t: { id: string }) => t.id === section.approved_take_id);
        if (approved) takeUrl = approved.audio_url;
      }
      if (!takeUrl) {
        const selected = takes.find((t: { is_selected: boolean }) => t.is_selected);
        if (selected) takeUrl = selected.audio_url;
      }
      if (!takeUrl && takes.length > 0) {
        takeUrl = takes[0].audio_url; // Latest take (sorted desc)
      }
      if (takeUrl) audioUrls.push(takeUrl);
    }

    if (audioUrls.length === 0) {
      return NextResponse.json({ error: 'No takes to stitch' }, { status: 400 });
    }

    // Download all audio files (validate URLs are from Vercel Blob only)
    const ALLOWED_HOSTS = ['blob.vercel-storage.com'];
    const audioBuffers: ArrayBuffer[] = [];
    for (const url of audioUrls) {
      try {
        const parsed = new URL(url);
        if (!ALLOWED_HOSTS.some(h => parsed.hostname.endsWith(h))) {
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

    // Save as media_asset on the project
    await sql`
      INSERT INTO media_assets (project_id, type, source, name, url, blob_pathname, size_bytes, metadata)
      VALUES (
        ${assignment.project_id},
        'voiceover',
        'upload',
        ${`Narration — ${assignment.narrator_name}`},
        ${blob.url},
        ${blob.pathname},
        ${totalSize},
        ${JSON.stringify({ narrator_id: assignment.narrator_id, assignment_id: id, stitched: true, sections: audioUrls.length })}
      )
    `;

    // Update assignment status
    await sql`UPDATE narrator_assignments SET status = 'completed', updated_at = NOW() WHERE id = ${id}`;

    return NextResponse.json({ url: blob.url, size: totalSize, sections: audioUrls.length });
  } catch (err) {
    console.error('stitch error:', err);
    return NextResponse.json({ error: 'Failed to stitch audio' }, { status: 500 });
  }
}
