import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { countWords, estimateDuration } from '@/lib/utils';
import { splitScriptIntoSections } from '@/lib/narrator-utils';
import { createSection } from '@/lib/narrator-db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await sql`
      SELECT * FROM scripts WHERE project_id = ${id} ORDER BY version DESC
    `;
    return NextResponse.json({ scripts: result.rows });
  } catch {
    return NextResponse.json({ scripts: [] });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { content, modelId } = await req.json();

  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });

  try {
    // Get next version number
    const versionResult = await sql`
      SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM scripts WHERE project_id = ${id}
    `;
    const nextVersion = versionResult.rows[0].next_version;

    // Deactivate previous scripts
    await sql`UPDATE scripts SET is_active = false WHERE project_id = ${id}`;

    const words = countWords(content);
    const duration = estimateDuration(words);

    const result = await sql`
      INSERT INTO scripts (project_id, version, content, word_count, estimated_duration_seconds, ai_model, is_active)
      VALUES (${id}, ${nextVersion}, ${content}, ${words}, ${duration}, ${modelId || null}, true)
      RETURNING *
    `;

    await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${id}`;

    // Re-sync narrator assignments for this project so the narrator's
    // teleprompter / sections reflect the edited script. Only safe to
    // rebuild sections that have NO uploaded takes — otherwise blowing
    // them away would orphan the audio. Assignments past 'recording'
    // are left alone so we don't yank the floor out from under work in
    // progress; the owner can manually re-assign if they really want
    // the new script applied.
    try {
      const newScript = result.rows[0];
      const { rows: resyncable } = await sql`
        SELECT a.id, a.wpm
        FROM narrator_assignments a
        WHERE a.project_id = ${id}
          AND a.status IN ('assigned', 'received', 'recording')
          AND NOT EXISTS (
            SELECT 1 FROM narrator_sections s
            JOIN narrator_takes t ON t.section_id = s.id
            WHERE s.assignment_id = a.id
          )
      `;
      for (const a of resyncable) {
        // Split per-assignment so each narrator's wpm is reflected in the
        // estimated_duration_seconds. Section boundaries themselves don't
        // depend on wpm — only the per-section timing does.
        const sections = splitScriptIntoSections(content, a.wpm || 150);
        sections.forEach((s, i) => {
          if (!s.label) s.label = i === 0 ? 'Hook' : i === sections.length - 1 ? 'Outro' : `Section ${i + 1}`;
        });
        await sql`DELETE FROM narrator_sections WHERE assignment_id = ${a.id}`;
        await sql`
          UPDATE narrator_assignments
          SET script_id = ${newScript.id}, script_version = ${nextVersion}, updated_at = NOW()
          WHERE id = ${a.id}
        `;
        for (let i = 0; i < sections.length; i++) {
          const s = sections[i];
          await createSection({
            assignment_id: a.id,
            section_number: i + 1,
            label: s.label,
            script_text: s.script_text,
            emphasis_markers: s.emphasis_markers,
            estimated_duration_seconds: s.estimated_duration_seconds,
          });
        }
      }
    } catch (e) {
      // Resync is a nice-to-have; never block the script save itself.
      console.warn('narrator section resync on script save failed:', e);
    }

    return NextResponse.json({ script: result.rows[0] });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
