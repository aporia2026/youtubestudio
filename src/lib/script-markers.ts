/**
 * Strip production-document markers from a script so they don't end up
 * in burned-in captions, TTS output, or any consumer that wants the
 * spoken text only.
 *
 * Marker syntax matches what `src/lib/prompts.ts` instructs the script
 * generator to emit and what narrators / shorts / production-doc rows
 * carry through:
 *   - [VISUAL CUE: …]    visual direction
 *   - [VISUAL: …]         legacy / shorts variant
 *   - [PAUSE], [LONG PAUSE]
 *   - [SFX: …]            sound effects
 *   - [B-ROLL: …]         b-roll cues
 *   - [CUT TO: …]         edit direction
 *
 * Performance tags ([excited], [whisper], etc.) are deliberately NOT
 * stripped — the narrator UI dims them, and captions can carry them
 * harmlessly. Downstream consumers that want them gone too can chain
 * another pass.
 */
export function stripProductionMarkers(text: string): string {
  return text
    .replace(/\[(?:VISUAL|PAUSE|LONG PAUSE|SFX|B-ROLL|CUT TO)[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
