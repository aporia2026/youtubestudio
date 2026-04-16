'use client';

import { useState } from 'react';
import { toast } from 'sonner';

/**
 * One-click button that reformats a narration script into ElevenLabs-ready
 * text (with v3 audio tags or v2 best-practice punctuation), preview-shows
 * the result in a modal so the user can edit before copying, then copies
 * to clipboard. Caches the formatted text per script+version so re-clicking
 * the same script doesn't re-bill the LLM.
 */

interface Props {
  script: string;
  version: 'v2' | 'v3';
  voiceContext?: string;
  buttonClassName?: string;
}

// In-memory cache so the same script + version doesn't re-call the LLM.
// Cleared on page reload — that's intentional, the cost saving is per-session.
const cache = new Map<string, string>();
const cacheKey = (script: string, version: string) => `${version}::${script.length}::${script.slice(0, 200)}::${script.slice(-200)}`;

export function CopyForElevenLabs({ script, version, voiceContext, buttonClassName }: Props) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const reformat = async () => {
    if (!script.trim()) { toast.error('No script to format'); return; }
    const key = cacheKey(script, version);
    if (cache.has(key)) {
      const cached = cache.get(key)!;
      setPreview(cached);
      return;
    }
    setBusy(true);
    const loading = toast.loading(`Formatting for ElevenLabs ${version}…`);
    try {
      const res = await fetch('/api/script/elevenlabs-format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script, versions: [version], voiceContext }),
      });
      const data = await res.json();
      toast.dismiss(loading);
      if (!res.ok) { toast.error(data.error || 'Format failed'); return; }
      const text = data.formatted?.[version] ?? '';
      if (!text) { toast.error('Empty result'); return; }
      cache.set(key, text);
      setPreview(text);
    } catch (err) {
      toast.dismiss(loading);
      toast.error(err instanceof Error ? err.message : 'Format failed');
    } finally {
      setBusy(false);
    }
  };

  const copyAndClose = () => {
    if (!preview) return;
    navigator.clipboard.writeText(preview);
    toast.success(`Copied ElevenLabs ${version} script — paste into the TTS box`);
    setPreview(null);
  };

  return (
    <>
      <button
        onClick={reformat}
        disabled={busy}
        className={buttonClassName ?? 'btn-secondary px-3 py-1.5 text-xs flex items-center gap-1'}
        title={`Reformat script for ElevenLabs ${version} (${version === 'v3' ? 'with audio tags' : 'best-practice punctuation'})`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
        {busy ? '…' : `EL ${version}`}
      </button>

      {preview !== null && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={(e) => { if (e.target === e.currentTarget) setPreview(null); }}
        >
          <div style={{ width: 'min(800px, 100%)', maxHeight: '80vh', background: '#0F0F12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, display: 'flex', flexDirection: 'column', color: '#EEE' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>ElevenLabs {version} script</div>
                <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                  {version === 'v3'
                    ? 'Inline audio tags ([excited], [whisper], etc.) inserted by AI. Edit below before copying.'
                    : 'Punctuation + paragraphs tuned for natural delivery. v2 has no audio tags.'}
                </div>
              </div>
              <button onClick={() => setPreview(null)} style={{ width: 28, height: 28, borderRadius: 4, background: 'transparent', border: 0, color: '#EEE', fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>
            <textarea
              value={preview}
              onChange={(e) => setPreview(e.target.value)}
              style={{ flex: 1, minHeight: 300, padding: 16, background: '#0A0A0D', border: 0, color: '#EEE', fontSize: 13, fontFamily: '"SF Mono", Consolas, monospace', resize: 'vertical' }}
            />
            <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setPreview(null)}
                style={{ padding: '6px 14px', background: 'rgba(255,255,255,0.1)', border: 0, borderRadius: 4, color: '#EEE', fontSize: 12, cursor: 'pointer' }}
              >Close</button>
              <button
                onClick={copyAndClose}
                style={{ padding: '6px 14px', background: '#A855F7', border: 0, borderRadius: 4, color: '#FFF', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >Copy & close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
