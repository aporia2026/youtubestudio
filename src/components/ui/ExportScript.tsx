'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { exportAsText, exportAsPDF, type ExportOptions } from '@/lib/export-script';

interface ExportScriptProps {
  title: string;
  script: string;
  niche?: string;
  duration?: string;
  className?: string;
}

export function ExportScript({ title, script, niche, duration, className = '' }: ExportScriptProps) {
  const [open, setOpen] = useState(false);

  if (!script) return null;

  const opts: ExportOptions = { title, script, niche, duration };

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => setOpen(!open)}
        className="btn-secondary text-sm"
      >
        📄 Export for Editor
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full mt-2 right-0 z-50 rounded-lg overflow-hidden"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-bright)', boxShadow: '0 10px 30px rgba(0,0,0,0.4)', minWidth: 200 }}>
            <button
              onClick={async () => { try { await exportAsPDF(opts); toast.success('PDF downloaded'); } catch { toast.error('PDF export failed'); } setOpen(false); }}
              className="w-full text-left px-4 py-3 text-sm transition-colors flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              📕 Download PDF
              <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>Clean script only</span>
            </button>
            <button
              onClick={() => { exportAsText(opts); setOpen(false); toast.success('Text file downloaded'); }}
              className="w-full text-left px-4 py-3 text-sm transition-colors flex items-center gap-2"
              style={{ color: 'var(--text-primary)', borderTop: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              📝 Download .txt
              <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>Plain text</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
