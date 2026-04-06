import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET() {
  try {
    const [projects, scripts, ideas, qaRuns] = await Promise.all([
      sql`SELECT COUNT(*) as count FROM projects`,
      sql`SELECT COUNT(*) as count FROM scripts`,
      sql`SELECT COUNT(*) as count FROM video_ideas WHERE is_saved = true`,
      sql`SELECT COUNT(*) as count FROM qa_sessions`,
    ]);

    return NextResponse.json({
      projects: parseInt(projects.rows[0]?.count || '0'),
      scripts: parseInt(scripts.rows[0]?.count || '0'),
      ideas: parseInt(ideas.rows[0]?.count || '0'),
      qaRuns: parseInt(qaRuns.rows[0]?.count || '0'),
    });
  } catch {
    return NextResponse.json({ projects: 0, scripts: 0, ideas: 0, qaRuns: 0 });
  }
}
