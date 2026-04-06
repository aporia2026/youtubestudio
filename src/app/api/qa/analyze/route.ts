import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { scriptQAPrompt } from '@/lib/prompts';
import { sql } from '@/lib/db';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { modelId, script, niche, aggressiveness, passNumber, previousFeedback, scriptId, projectId } = await req.json();

    if (!script || script.length < 50) {
      return NextResponse.json({ error: 'Script too short (min 50 chars)' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const { system, user } = scriptQAPrompt({
      script,
      niche: niche || 'General',
      passNumber: passNumber || 1,
      previousFeedback,
      aggressiveness: aggressiveness || 'brutal',
    });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 6000,
      temperature: 0.3,
    });

    // Extract JSON from response
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Failed to parse QA response' }, { status: 500 });
    }

    const result = JSON.parse(jsonMatch[1]);

    // Persist to DB if we have context
    try {
      if (projectId || scriptId) {
        await sql`
          INSERT INTO qa_sessions (script_id, project_id, pass_number, overall_score, feedback, issues, suggestions, ai_model)
          VALUES (
            ${scriptId || null},
            ${projectId || null},
            ${passNumber || 1},
            ${result.overall_score},
            ${JSON.stringify(result.categories)},
            ${JSON.stringify(result.critical_issues || [])},
            ${JSON.stringify(result.rewrite_suggestions || [])},
            ${modelId}
          )
        `;
      }
    } catch (dbErr) {
      console.warn('DB save error (non-fatal):', dbErr);
    }

    return NextResponse.json({ result });
  } catch (err: unknown) {
    console.error('QA analyze error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'QA analysis failed' },
      { status: 500 }
    );
  }
}
