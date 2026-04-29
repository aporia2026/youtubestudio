import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getVersion } from '@/lib/review-db';
import { deleteR2Object } from '@/lib/r2';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  try {
    const { id: projectId, versionId } = await params;

    // Verify the version belongs to this project (defense in depth)
    const version = await getVersion(versionId);
    if (!version) return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    if (version.project_id !== projectId) {
      return NextResponse.json({ error: 'Version does not belong to this project' }, { status: 403 });
    }

    // Delete the R2 object first; if R2 cleanup fails, we still continue with DB cleanup
    // so the UI doesn't show ghost rows. R2 errors are logged for manual cleanup.
    if (version.r2_key) {
      try {
        await deleteR2Object(version.r2_key);
      } catch (e) {
        console.error('R2 delete failed for', version.r2_key, e);
      }
    }

    // Delete the row (cascades to review_comments via FK ON DELETE CASCADE)
    await sql`DELETE FROM review_versions WHERE id = ${versionId}`;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE version error:', err);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to delete version: ${msg}` }, { status: 500 });
  }
}
