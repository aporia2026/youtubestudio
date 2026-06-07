/**
 * Diagnostic spike: does kie-gemini-3-5-flash accept audio input
 * through Kie.ai's OpenAI-compatible alias, or only via the
 * Google-native :generateContent endpoint?
 *
 * Plan 1A defaults the voice-profile feature to kie-gemini-2.5-flash
 * because audio input is documented on Google's native multimodal
 * contract AND Kie's docs page for 2.5 Flash lists `inline_data` + a
 * `mime_type` field that we use successfully today. For 3.5 Flash,
 * Kie's docs page describes the same Google-native shape but
 * audio is not explicitly enumerated — and the OpenAI-compatible
 * alias `gemini-3-5-flash-openai` has no documented audio support
 * at all.
 *
 * This script fires three probe calls against a ~10-second test
 * audio clip and prints whether each variant returned a sensible
 * description. Run from the repo root:
 *
 *     tsx scripts/diag-kie-3-5-flash-audio.ts ./path/to/sample.mp3
 *
 * Expected outcomes:
 *   - Variant A (Google-native :generateContent, inline_data):
 *     should succeed today (Plan 1A uses this same shape on 2.5
 *     Flash). Confirms 3.5 Flash works on the native endpoint.
 *   - Variant B (OpenAI-compatible alias + image_url data URI):
 *     undocumented; either works (cool, would let us route the
 *     voice-profile call through ai.ts later) or 422s.
 *   - Variant C (OpenAI-compatible alias + input_audio parts):
 *     also undocumented; the OpenAI input_audio shape is a
 *     GPT-4o-audio-preview construct, so it probably 422s on Kie.
 *
 * If ANY variant works, flip the channel-clone-voice-profile feature
 * default in `src/lib/ai-models.ts` to `kie-gemini-3-5-flash` and
 * document the working shape in `voice-profile-runner.ts`.
 *
 * Plan 1: _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md
 */

import { readFile } from 'node:fs/promises';

const KIE_BASE = 'https://api.kie.ai';
const PROMPT =
  'Listen to the attached audio and describe the voice in one sentence (gender, pace, energy). Return plain text, no markdown.';

async function main() {
  const audioPath = process.argv[2];
  if (!audioPath) {
    console.error('usage: tsx scripts/diag-kie-3-5-flash-audio.ts <path-to-mp3>');
    process.exit(2);
  }
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    console.error('KIE_API_KEY env var not set.');
    process.exit(2);
  }
  const buf = await readFile(audioPath);
  const base64 = buf.toString('base64');
  console.log(`[diag-kie-3-5-flash-audio] sample: ${audioPath} (${buf.length} bytes, ${base64.length} base64 chars)`);

  await probe('A — native :generateContent + inline_data', async () => {
    const url = `${KIE_BASE}/gemini/v1/models/gemini-3-5-flash:generateContent`;
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: 'audio/mpeg', data: base64 } },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 128, temperature: 0.4 },
    };
    return fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  });

  await probe('B — OpenAI alias + image_url data URI', async () => {
    const url = `${KIE_BASE}/gemini-3-5-flash-openai/v1/chat/completions`;
    const body = {
      model: 'gemini-3-5-flash-openai',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            // Some OpenAI-compatible aliases accept audio via the
            // image_url block with a data: URI carrying the audio
            // mime — undocumented but worth a probe.
            { type: 'image_url', image_url: { url: `data:audio/mpeg;base64,${base64}` } },
          ],
        },
      ],
      max_tokens: 128,
      temperature: 0.4,
    };
    return fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  });

  await probe('C — OpenAI alias + input_audio content part', async () => {
    const url = `${KIE_BASE}/gemini-3-5-flash-openai/v1/chat/completions`;
    const body = {
      model: 'gemini-3-5-flash-openai',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            // Matches the OpenAI GPT-4o-audio-preview content shape.
            { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } },
          ],
        },
      ],
      max_tokens: 128,
      temperature: 0.4,
    };
    return fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  });

  console.log('\n[diag-kie-3-5-flash-audio] verdict — review the three variants above.');
  console.log('  Any 200 OK with a sensible description → flip the voice-profile default to kie-gemini-3-5-flash');
  console.log('  All 4xx/5xx → stay on kie-gemini-2.5-flash and file a Kie feature request.');
}

async function probe(label: string, send: () => Promise<Response>) {
  console.log(`\n--- ${label} ---`);
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await send();
  } catch (err) {
    console.log(`  ✗ network error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const ms = Date.now() - startedAt;
  const bodyText = await res.text().catch(() => '');
  if (res.ok) {
    console.log(`  ✓ ${res.status} OK (${ms} ms)`);
    // Try to extract a meaningful text fragment from either the
    // Gemini-native or OpenAI-compatible response shape.
    const preview = extractTextPreview(bodyText);
    console.log(`  preview: ${preview.slice(0, 200)}`);
  } else {
    console.log(`  ✗ ${res.status} (${ms} ms)`);
    console.log(`  body: ${bodyText.slice(0, 400)}`);
  }
}

function extractTextPreview(bodyText: string): string {
  try {
    const data = JSON.parse(bodyText) as Record<string, unknown>;
    // Gemini native: { candidates: [{ content: { parts: [{ text }] } }] }
    const candidates = data.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    const fromGemini = candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof fromGemini === 'string' && fromGemini.length > 0) return fromGemini;
    // OpenAI-compatible: { choices: [{ message: { content } }] }
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    const fromOpenAI = choices?.[0]?.message?.content;
    if (typeof fromOpenAI === 'string' && fromOpenAI.length > 0) return fromOpenAI;
    return '(no obvious text content)';
  } catch {
    return '(response was not JSON)';
  }
}

main().catch((err) => {
  console.error('spike failed unexpectedly:', err);
  process.exit(1);
});
