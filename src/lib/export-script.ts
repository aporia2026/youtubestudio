// Generate a clean PDF/text document of the script for video editors
// Contains ONLY the spoken narration + timing — no visual cues, no design notes

import { cleanScriptForVoiceover } from './voiceover-presets';

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
  ].filter(Boolean).join('\n');

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

  // Header
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(opts.title, margin, y);
  y += 10;

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

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-').slice(0, 60).toLowerCase();
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
