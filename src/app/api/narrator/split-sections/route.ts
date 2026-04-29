import { NextRequest, NextResponse } from 'next/server';
import { splitScriptIntoSections, buildLabelPrompt } from '@/lib/narrator-utils';
import { generateText } from '@/lib/ai';

export async function POST(req: NextRequest) {
  try {
    const { script_text, wpm, modelId, autoLabel } = await req.json();
    if (!script_text?.trim()) return NextResponse.json({ error: 'script_text required' }, { status: 400 });

    const sections = splitScriptIntoSections(script_text, wpm || 150);

    // Optionally label sections with AI
    if (autoLabel && modelId) {
      try {
        const prompt = buildLabelPrompt(sections);
        const result = await generateText({ modelId, prompt, systemPrompt: 'You are a script structure analyst. Return only valid JSON.', maxTokens: 2000, temperature: 0 });
        const labels: string[] = JSON.parse(result);
        for (let i = 0; i < Math.min(labels.length, sections.length); i++) {
          sections[i].label = labels[i];
        }
      } catch {
        // Fallback: auto-label by position
        sections.forEach((s, i) => {
          if (!s.label) s.label = i === 0 ? 'Hook' : i === sections.length - 1 ? 'Outro' : `Section ${i + 1}`;
        });
      }
    } else {
      sections.forEach((s, i) => {
        if (!s.label) s.label = i === 0 ? 'Hook' : i === sections.length - 1 ? 'Outro' : `Section ${i + 1}`;
      });
    }

    return NextResponse.json(sections);
  } catch (err) {
    console.error('split-sections error:', err);
    return NextResponse.json({ error: 'Failed to split sections' }, { status: 500 });
  }
}
