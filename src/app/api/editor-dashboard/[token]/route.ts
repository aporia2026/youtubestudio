import { NextRequest, NextResponse } from 'next/server';
import { getEditorByPersonalToken } from '@/lib/team-db';
import { getEditorAssignmentsForEditor } from '@/lib/editor-db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const editor = await getEditorByPersonalToken(token);
    if (!editor) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const assignments = await getEditorAssignmentsForEditor(editor.id);

    return NextResponse.json({
      editor: {
        id: editor.id,
        name: editor.name,
        email: editor.email,
        color: editor.color,
      },
      assignments,
    });
  } catch (err) {
    console.error('GET editor dashboard error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
