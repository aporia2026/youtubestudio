// Generate a clean PDF/text document of the script for video editors
// Contains ONLY the spoken narration + timing — no visual cues, no design notes

export interface ExportOptions {
  title: string;
  script: string;
  niche?: string;
  duration?: string;       // e.g. "7:20"
  voiceoverUrl?: string;
  date?: string;
}

/** Clean script for editor — removes visual cues but keeps section headers for reference */
function cleanForEditor(raw: string): string {
  return raw
    // Remove visual cue lines (all variants)
    .replace(/^\s*\*{0,2}\[(?:VISUAL CUE|B-ROLL|CUT TO|ON SCREEN|GRAPHIC|FOOTAGE|SHOT|TRANSITION|MUSIC|SFX|SOUND)[^\]]*\]\*{0,2}\s*$/gmi, '')
    .replace(/\*{0,2}\[(?:VISUAL CUE|B-ROLL|CUT TO|ON SCREEN|GRAPHIC|FOOTAGE|SHOT|TRANSITION|MUSIC|SFX|SOUND)[^\]]*\]\*{0,2}/gi, '')
    // Keep [PAUSE] as timing cue for the editor
    .replace(/\*{0,2}\[PAUSE\]\*{0,2}/g, '[PAUSE]')
    // Remove bold markdown
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove italic markdown
    .replace(/\*([^*]+)\*/g, '$1')
    // Clean section headers to plain text
    .replace(/^##\s+(.+)$/gm, '\n--- $1 ---\n')
    // Remove any remaining square bracket stage directions on their own line
    .replace(/^\s*\[(?!PAUSE).*\]\s*$/gm, '')
    // Clean excess whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Export as plain text file */
export function exportAsText(opts: ExportOptions): void {
  const clean = cleanForEditor(opts.script);
  const wordCount = clean.split(/\s+/).filter(Boolean).length;

  const content = [
    `SCRIPT: ${opts.title}`,
    `${'═'.repeat(60)}`,
    '',
    opts.niche ? `Niche: ${opts.niche}` : '',
    opts.duration ? `Duration: ${opts.duration}` : `Est. Duration: ~${Math.round(wordCount / 140)} minutes`,
    `Word Count: ${wordCount.toLocaleString()}`,
    `Date: ${opts.date || new Date().toLocaleDateString()}`,
    '',
    `${'═'.repeat(60)}`,
    '',
    clean,
    '',
    `${'═'.repeat(60)}`,
    `END OF SCRIPT`,
  ].join('\n');

  downloadFile(content, `${sanitizeFilename(opts.title)}-script.txt`, 'text/plain');
}

/** Export as PDF */
export async function exportAsPDF(opts: ExportOptions): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const clean = cleanForEditor(opts.script);
  const wordCount = clean.split(/\s+/).filter(Boolean).length;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  // Header — wrap long titles
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  const titleLines = doc.splitTextToSize(opts.title, contentWidth);
  for (const tl of titleLines) {
    doc.text(tl, margin, y);
    y += 8;
  }
  y += 2;

  // Meta
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120, 120, 120);
  const meta = [
    opts.niche ? `Niche: ${opts.niche}` : '',
    opts.duration ? `Duration: ${opts.duration}` : `Est. Duration: ~${Math.round(wordCount / 140)} min`,
    `Words: ${wordCount.toLocaleString()}`,
    `Date: ${opts.date || new Date().toLocaleDateString()}`,
  ].filter(Boolean).join('  |  ');
  doc.text(meta, margin, y);
  y += 8;

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  // Script body
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(30, 30, 30);

  const lines = doc.splitTextToSize(clean, contentWidth);
  const lineHeight = 5.5;

  for (const line of lines) {
    if (y + lineHeight > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }

    // Style section headers differently
    if (line.startsWith('---') && line.endsWith('---')) {
      y += 4;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.text(line.replace(/^-+\s*|\s*-+$/g, '').trim(), margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      y += lineHeight + 2;
    } else if (line.trim() === '[PAUSE]') {
      doc.setTextColor(150, 150, 150);
      doc.setFont('helvetica', 'italic');
      doc.text('[pause]', margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30, 30, 30);
      y += lineHeight;
    } else {
      doc.text(line, margin, y);
      y += lineHeight;
    }
  }

  doc.save(`${sanitizeFilename(opts.title)}-script.pdf`);
}

// ---------------------------------------------------------------------------
// Narrator-focused export
//
// Strips visual cues (B-ROLL, CUT TO, etc.) but PRESERVES performance markers
// the narrator should follow: [PAUSE], [LONG PAUSE], [excited], [whisper],
// CAPITALIZED EMPHASIS, *italic stress*. The output is auto-split into
// recording sections with per-section word counts + estimated duration so a
// narrator can pace themselves and bookmark where they are.
// ---------------------------------------------------------------------------

/** Visual/stage direction tags the narrator should NOT read aloud. */
const VISUAL_CUE_REGEX = /\[(?:VISUAL CUE|VISUAL|B-ROLL|CUT TO|CUT|ON SCREEN|SCREEN|GRAPHIC|TITLE CARD|LOWER THIRD|TRANSITION|MUSIC|SFX|SOUND|FOOTAGE|OVERLAY|ANIMATION|INSERT|MONTAGE|SPLIT SCREEN|SHOT)[^\]]*\]/gi;

function cleanForNarrator(raw: string): string {
  return raw
    // Strip whole lines that are JUST a visual cue
    .replace(/^\s*\*{0,2}\[(?:VISUAL CUE|VISUAL|B-ROLL|CUT TO|CUT|ON SCREEN|SCREEN|GRAPHIC|TITLE CARD|LOWER THIRD|TRANSITION|MUSIC|SFX|SOUND|FOOTAGE|OVERLAY|ANIMATION|INSERT|MONTAGE|SPLIT SCREEN|SHOT)[^\]]*\]\*{0,2}\s*$/gmi, '')
    // Strip inline visual cues
    .replace(VISUAL_CUE_REGEX, '')
    // Strip "Narrator:" prefix lines (the whole thing IS narration)
    .replace(/^\s*Narrator\s*:\s*/gmi, '')
    // Remove bold/italic markdown (preserve the words themselves)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    // Collapse 3+ blank lines down to one paragraph break
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface NarratorSection {
  label: string;
  text: string;
  wordCount: number;
  estSeconds: number;
}

/** Break a cleaned script into recording-friendly sections.
 *  Splits on `## Heading` markers when present; otherwise one section
 *  per natural double-newline paragraph group. */
function splitForNarrator(cleaned: string, wpm: number): NarratorSection[] {
  // Try splitting on `## Heading` markers first
  const headingChunks = cleaned.split(/^##\s+/m);
  let chunks: { label: string; text: string }[];
  if (headingChunks.length > 1) {
    chunks = [];
    const preamble = headingChunks[0].trim();
    if (preamble) chunks.push({ label: 'Intro', text: preamble });
    for (let i = 1; i < headingChunks.length; i++) {
      const lines = headingChunks[i].split('\n');
      const label = lines[0].trim() || `Section ${chunks.length + 1}`;
      const body = lines.slice(1).join('\n').trim();
      if (body) chunks.push({ label, text: body });
    }
  } else {
    // No headings — group paragraphs into ~120-200 word recording chunks
    const paragraphs = cleaned.split(/\n\s*\n/).filter(p => p.trim());
    chunks = [];
    let buffer: string[] = [];
    let bufferWords = 0;
    for (const para of paragraphs) {
      const words = para.split(/\s+/).filter(Boolean).length;
      buffer.push(para);
      bufferWords += words;
      if (bufferWords >= 150) {
        chunks.push({ label: `Section ${chunks.length + 1}`, text: buffer.join('\n\n') });
        buffer = [];
        bufferWords = 0;
      }
    }
    if (buffer.length) chunks.push({ label: `Section ${chunks.length + 1}`, text: buffer.join('\n\n') });
  }

  return chunks.map(c => {
    const wordCount = c.text.split(/\s+/).filter(Boolean).length;
    const estSeconds = Math.max(1, Math.round((wordCount / wpm) * 60));
    return { label: c.label, text: c.text, wordCount, estSeconds };
  });
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${sec.toString().padStart(2, '0')}` : `${sec}s`;
}

export interface NarratorExportOptions extends ExportOptions {
  wpm?: number;
}

/** Plain-text narrator export — simple but readable; great for emailing. */
export function exportNarratorText(opts: NarratorExportOptions): void {
  const wpm = opts.wpm ?? 150;
  const cleaned = cleanForNarrator(opts.script);
  const sections = splitForNarrator(cleaned, wpm);
  const totalWords = sections.reduce((a, s) => a + s.wordCount, 0);
  const totalSeconds = sections.reduce((a, s) => a + s.estSeconds, 0);

  const lines: string[] = [];
  lines.push(`NARRATION SCRIPT — ${opts.title}`);
  lines.push('═'.repeat(60));
  if (opts.niche) lines.push(`Niche: ${opts.niche}`);
  lines.push(`Total words: ${totalWords.toLocaleString()}`);
  lines.push(`Estimated runtime: ${formatSeconds(totalSeconds)} at ${wpm} WPM`);
  lines.push(`Sections: ${sections.length}`);
  lines.push(`Date: ${opts.date || new Date().toLocaleDateString()}`);
  lines.push('═'.repeat(60));
  lines.push('');
  lines.push('LEGEND:');
  lines.push('  [pause] / [long pause]  — take a beat');
  lines.push('  [excited] / [whisper]   — performance direction');
  lines.push('  CAPITALS                — stress this word');
  lines.push('');
  lines.push('═'.repeat(60));
  lines.push('');

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    lines.push(`──── SECTION ${i + 1} of ${sections.length} ────`);
    lines.push(`  ${s.label}  ·  ${s.wordCount} words  ·  ~${formatSeconds(s.estSeconds)}`);
    lines.push('─'.repeat(60));
    lines.push('');
    lines.push(s.text);
    lines.push('');
    lines.push('');
  }

  lines.push('═'.repeat(60));
  lines.push('END OF NARRATION SCRIPT');

  downloadFile(lines.join('\n'), `${sanitizeFilename(opts.title)}-narration.txt`, 'text/plain');
}

/** PDF narrator export — large readable serif, section breaks, performance markers preserved. */
export async function exportNarratorPDF(opts: NarratorExportOptions): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const wpm = opts.wpm ?? 150;
  const cleaned = cleanForNarrator(opts.script);
  const sections = splitForNarrator(cleaned, wpm);
  const totalWords = sections.reduce((a, s) => a + s.wordCount, 0);
  const totalSeconds = sections.reduce((a, s) => a + s.estSeconds, 0);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  // ── Cover page ──────────────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(124, 58, 237);
  doc.text('NARRATION SCRIPT', margin, y);
  y += 8;

  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20, 20, 20);
  const titleLines = doc.splitTextToSize(opts.title, contentWidth);
  for (const tl of titleLines) {
    doc.text(tl, margin, y);
    y += 9;
  }
  y += 4;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(110, 110, 110);
  const meta = [
    opts.niche ? `Niche: ${opts.niche}` : '',
    `Total: ${totalWords.toLocaleString()} words · ~${formatSeconds(totalSeconds)} at ${wpm} WPM`,
    `Sections: ${sections.length}`,
    `Date: ${opts.date || new Date().toLocaleDateString()}`,
  ].filter(Boolean);
  for (const m of meta) {
    doc.text(m, margin, y);
    y += 5;
  }
  y += 6;

  // Legend
  doc.setDrawColor(220, 220, 220);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;
  doc.setFontSize(9);
  doc.setTextColor(140, 140, 140);
  doc.text('Legend:', margin, y); y += 5;
  doc.text('  [pause] / [long pause] — take a beat', margin, y); y += 4.5;
  doc.text('  [excited] / [whisper] / etc. — performance direction', margin, y); y += 4.5;
  doc.text('  CAPITALS — stress this word', margin, y); y += 6;

  // ── Sections ────────────────────────────────────────────────────────────
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];

    // Each section starts on a fresh page so the narrator can flip cleanly
    if (i > 0 || y > pageHeight - 80) {
      doc.addPage();
      y = margin;
    }

    // Section header
    doc.setFillColor(124, 58, 237);
    doc.rect(margin, y - 5, contentWidth, 14, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(`SECTION ${i + 1} of ${sections.length}  ·  ${s.label}`, margin + 3, y + 4);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const stat = `${s.wordCount} words  ·  ~${formatSeconds(s.estSeconds)}`;
    const statWidth = doc.getTextWidth(stat);
    doc.text(stat, pageWidth - margin - statWidth - 3, y + 4);
    y += 16;

    // Section body — slightly larger serif-ish font for readability
    doc.setFont('times', 'normal');
    doc.setFontSize(13);
    doc.setTextColor(15, 15, 15);

    const paragraphs = s.text.split(/\n\s*\n/);
    for (const para of paragraphs) {
      const lines = doc.splitTextToSize(para, contentWidth);
      const lineHeight = 6;
      for (const line of lines) {
        if (y + lineHeight > pageHeight - margin) {
          doc.addPage();
          y = margin;
        }
        doc.text(line, margin, y);
        y += lineHeight;
      }
      y += 4; // blank line between paragraphs
    }
  }

  doc.save(`${sanitizeFilename(opts.title)}-narration.pdf`);
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '-').slice(0, 60).toLowerCase();
  return cleaned || 'script';
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
