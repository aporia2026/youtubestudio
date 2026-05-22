// Maps script tone/style parameters to optimal ElevenLabs voice settings

export interface VoicePreset {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  model_id: string;
  description: string;
}

// Tone → voice setting adjustments
const TONE_PRESETS: Record<string, Partial<VoicePreset>> = {
  'Engaging & Friendly': { stability: 0.45, similarity_boost: 0.75, style: 0.55, description: 'Warm & approachable — slightly expressive with natural variation' },
  'Authoritative & Expert': { stability: 0.7, similarity_boost: 0.8, style: 0.3, description: 'Confident & steady — high consistency with controlled delivery' },
  'Conversational': { stability: 0.35, similarity_boost: 0.7, style: 0.6, description: 'Natural & relaxed — like talking to a friend, more expression' },
  'Dramatic & Urgent': { stability: 0.25, similarity_boost: 0.75, style: 0.8, description: 'High energy — maximum expressiveness with dramatic emphasis' },
  'Humorous & Relaxed': { stability: 0.4, similarity_boost: 0.65, style: 0.65, description: 'Playful & loose — room for comedic timing and variation' },
  'Educational & Clear': { stability: 0.6, similarity_boost: 0.8, style: 0.35, description: 'Clear & measured — easy to follow with consistent pacing' },
};

// Style → additional fine-tuning
const STYLE_ADJUSTMENTS: Record<string, { stability_delta: number; style_delta: number }> = {
  'Explainer': { stability_delta: 0.05, style_delta: -0.05 },
  'Story-driven': { stability_delta: -0.1, style_delta: 0.1 },
  'Tutorial': { stability_delta: 0.1, style_delta: -0.1 },
  'Comparison': { stability_delta: 0, style_delta: 0 },
  'Opinion / Commentary': { stability_delta: -0.05, style_delta: 0.1 },
  'Top 10 List': { stability_delta: 0.05, style_delta: 0.05 },
  'Documentary': { stability_delta: 0.15, style_delta: -0.05 },
};

function clamp(val: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, val));
}

export function getVoicePreset(tone: string, style: string): VoicePreset {
  const tonePreset = TONE_PRESETS[tone] || TONE_PRESETS['Engaging & Friendly'];
  const styleAdj = STYLE_ADJUSTMENTS[style] || { stability_delta: 0, style_delta: 0 };

  return {
    stability: clamp((tonePreset.stability || 0.5) + styleAdj.stability_delta),
    similarity_boost: tonePreset.similarity_boost || 0.75,
    style: clamp((tonePreset.style || 0.5) + styleAdj.style_delta),
    use_speaker_boost: true,
    model_id: 'eleven_multilingual_v2',
    description: tonePreset.description || '',
  };
}

/** Split script into sections for section-by-section voiceover */
export function splitScriptSections(script: string): { name: string; content: string }[] {
  const lines = script.split('\n');
  const sections: { name: string; content: string }[] = [];
  let currentName = 'Full Script';
  let currentLines: string[] = [];

  for (const line of lines) {
    // Accept `##Title` and `## Title` both; skip h3+ via negative lookahead.
    const sectionMatch = line.match(/^##(?!#)\s*(.+)/);
    if (sectionMatch) {
      if (currentLines.length > 0) {
        const content = currentLines.join('\n').trim();
        if (content) sections.push({ name: currentName, content });
      }
      currentName = sectionMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    const content = currentLines.join('\n').trim();
    if (content) sections.push({ name: currentName, content });
  }

  return sections;
}

/** Strip visual cues, pauses, and markdown from script for clean voiceover text */
export function cleanScriptForVoiceover(text: string): string {
  return text
    // Remove visual cue lines — handles all variations:
    // [VISUAL CUE: ...], **[VISUAL CUE: ...]**, entire lines containing them
    .replace(/^\s*\*{0,2}\[VISUAL CUE:[^\]]*\]\*{0,2}\s*$/gm, '')
    // Remove inline visual cues that aren't on their own line
    .replace(/\*{0,2}\[VISUAL CUE:[^\]]*\]\*{0,2}/g, '')
    // Remove other common cue variants (B-ROLL, CUT TO, ON SCREEN, GRAPHIC, etc.)
    .replace(/\*{0,2}\[(?:B-ROLL|CUT TO|ON SCREEN|GRAPHIC|FOOTAGE|SHOT|TRANSITION|MUSIC|SFX|SOUND)[^\]]*\]\*{0,2}/gi, '')
    // Remove pause markers (replace with a brief ellipsis for natural pacing)
    .replace(/\*{0,2}\[PAUSE\]\*{0,2}/g, '...')
    // Remove section headers (`## Name` or `##Name`); skip h3+ via lookahead.
    .replace(/^##(?!#)\s*.+$/gm, '')
    // Remove bold markdown
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove italic markdown
    .replace(/\*([^*]+)\*/g, '$1')
    // Remove lines that are purely formatting/stage directions (anything in square brackets)
    .replace(/^\s*\[.*\]\s*$/gm, '')
    // Clean up excess whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
