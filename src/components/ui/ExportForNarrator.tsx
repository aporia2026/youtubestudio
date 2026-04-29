'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { exportNarratorPDF, exportNarratorText, type NarratorExportOptions } from '@/lib/export-script';

interface Props {
  title: string;
  script: string;
  niche?: string;
  duration?: string;
  /** Words-per-minute for duration estimation (defaults to 150). */
  wpm?: number;
  className?: string;
}

/**
 * Drop-in next to <ExportScript /> on the script generator. Produces a
 * narrator-friendly document (PDF or .txt) with visual cues stripped, pacing
 * and emphasis markers preserved, and the script auto-split into recording
 * sections with per-section word counts + estimated duration.
 */
export function ExportForNarrator({ title, script, niche, duration, wpm, className = '' }: Props) {
  const [open, setOpen] = useState(false);
  if (!script) return null;

  const opts: NarratorExportOptions = { title, script, niche, duration, wpm };

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => setOpen(!open)}
        className="btn-secondary text-sm cursor-pointer"
        title="Export a narrator-ready PDF or text file with pacing markers preserved and recording sections"
      >
        🎤 Export for Narrator
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute top-full mt-2 right-0 z-50 rounded-lg overflow-hidden"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-bright)', boxShadow: '0 10px 30px rgba(0,0,0,0.4)', minWidth: 260 }}
          >
            <button
              onClick={async () => {
                try { await exportNarratorPDF(opts); toast.success('Narrator PDF downloaded'); }
                catch (e) { console.error(e); toast.error('PDF export failed'); }
                setOpen(false);
              }}
              className="w-full text-left px-4 py-3 text-sm transition-colors flex items-center gap-2 cursor-pointer"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              📕 Download PDF
              <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>One section per page</span>
            </button>
            <button
              onClick={() => { exportNarratorText(opts); setOpen(false); toast.success('Narrator text downloaded'); }}
              className="w-full text-left px-4 py-3 text-sm transition-colors flex items-center gap-2 cursor-pointer"
              style={{ color: 'var(--text-primary)', borderTop: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              📝 Download .txt
              <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>Plain text</span>
            </button>
            <button
              onClick={async () => {
                try {
                  const { exportNarratorText: _ } = await import('@/lib/export-script');
                  // Build the same plain-text body as the .txt download but copy it
                  // to the clipboard instead of downloading. We construct it inline
                  // here so we don't trigger a file download.
                  const cleaned = script
                    .replace(/^\s*\*{0,2}\[(?:VISUAL CUE|VISUAL|B-ROLL|CUT TO|CUT|ON SCREEN|SCREEN|GRAPHIC|TITLE CARD|LOWER THIRD|TRANSITION|MUSIC|SFX|SOUND|FOOTAGE|OVERLAY|ANIMATION|INSERT|MONTAGE|SPLIT SCREEN|SHOT)[^\]]*\]\*{0,2}\s*$/gmi, '')
                    .replace(/\[(?:VISUAL CUE|VISUAL|B-ROLL|CUT TO|CUT|ON SCREEN|SCREEN|GRAPHIC|TITLE CARD|LOWER THIRD|TRANSITION|MUSIC|SFX|SOUND|FOOTAGE|OVERLAY|ANIMATION|INSERT|MONTAGE|SPLIT SCREEN|SHOT)[^\]]*\]/gi, '')
                    .replace(/^\s*Narrator\s*:\s*/gmi, '')
                    .replace(/\*\*([^*]+)\*\*/g, '$1')
                    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                  await navigator.clipboard.writeText(cleaned);
                  toast.success('Narrator-ready script copied');
                  void _;
                } catch { toast.error('Copy failed'); }
                setOpen(false);
              }}
              className="w-full text-left px-4 py-3 text-sm transition-colors flex items-center gap-2 cursor-pointer"
              style={{ color: 'var(--text-primary)', borderTop: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              📋 Copy clean script
              <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>For ElevenLabs / TTS</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
