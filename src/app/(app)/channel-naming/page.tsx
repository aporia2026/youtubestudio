'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';

interface Candidate {
  name: string;
  handle: string;
  seo_score: number;
  brand_score: number;
  memorability_score: number;
  pronounceability: string;
  reasoning: string;
  keyword_coverage: string[];
  risks: string;
  available: boolean;
  takenBy?: { id: string; title: string; thumbnail?: string };
  checkError?: string;
  availabilityNote?: string;
  combinedScore: number;
}

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 1s linear infinite' }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeLinecap="round" />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </svg>
  );
}

/**
 * Resize image client-side before base64-encoding to stay well under Vercel's
 * 4.5 MB body limit. Target: max 1024px on longest side, JPEG quality 0.82.
 * Typical 4 MB phone photo → ~250 KB output.
 */
async function resizeAndEncode(file: File, maxSide = 1024, quality = 0.82): Promise<{ base64: string; mimeType: string; previewUrl: string; bytes: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = URL.createObjectURL(file);
  });

  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unsupported');
  ctx.drawImage(img, 0, 0, w, h);

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', quality);
  });
  const buf = await blob.arrayBuffer();
  const bytes = buf.byteLength;
  let binary = '';
  const arr = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  const base64 = btoa(binary);

  // Free original object URL; caller gets a new preview URL for the resized blob
  URL.revokeObjectURL(img.src);
  const previewUrl = URL.createObjectURL(blob);
  return { base64, mimeType: 'image/jpeg', previewUrl, bytes };
}

export default function ChannelNamingPage() {
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('channel-naming'));
  const [niche, setNiche] = useState('');
  const [freeText, setFreeText] = useState('');
  const [videoInput, setVideoInput] = useState('');
  const [refVideos, setRefVideos] = useState<string[]>([]);
  const [refImages, setRefImages] = useState<{ base64: string; mimeType: string; preview: string }[]>([]);
  const [count, setCount] = useState(20);
  const [generating, setGenerating] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [stats, setStats] = useState<{ allChecked: number; availableCount: number; refVideosUsed?: number; refVideosFailed?: string[]; availabilityCaveat?: string } | null>(null);

  function addVideo() {
    const url = videoInput.trim();
    if (!url) return;
    if (refVideos.includes(url)) return;
    if (refVideos.length >= 10) { toast.error('Max 10 reference videos'); return; }
    setRefVideos(prev => [...prev, url]);
    setVideoInput('');
  }

  function removeVideo(url: string) {
    setRefVideos(prev => prev.filter(v => v !== url));
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (refImages.length + files.length > 5) { toast.error('Max 5 images'); return; }
    for (const file of files) {
      // Reject only if the original is absurdly huge; otherwise resize aggressively.
      if (file.size > 25 * 1024 * 1024) { toast.error(`${file.name} is too large (max 25MB)`); continue; }
      try {
        const { base64, mimeType, previewUrl } = await resizeAndEncode(file);
        setRefImages(prev => [...prev, { base64, mimeType, preview: previewUrl }]);
      } catch { toast.error(`Failed to process ${file.name}`); }
    }
    e.target.value = '';
  }

  function removeImage(idx: number) {
    setRefImages(prev => {
      const removed = prev[idx];
      if (removed?.preview) { try { URL.revokeObjectURL(removed.preview); } catch {} }
      return prev.filter((_, i) => i !== idx);
    });
  }

  async function generate() {
    if (!niche.trim() && !freeText.trim() && refVideos.length === 0) {
      toast.error('Add at least some context — niche, description, or reference videos');
      return;
    }
    setGenerating(true);
    setCandidates([]);
    setStats(null);
    try {
      const res = await fetch('/api/channel-naming/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          niche,
          freeText,
          referenceVideoUrls: refVideos,
          referenceImages: refImages.map(i => ({ base64: i.base64, mimeType: i.mimeType })),
          count,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setCandidates(data.candidates || []);
      setStats({
        allChecked: data.allChecked,
        availableCount: data.availableCount,
        refVideosUsed: data.refVideosUsed,
        refVideosFailed: data.refVideosFailed,
        availabilityCaveat: data.availabilityCaveat,
      });
      if (data.refVideosFailed?.length) {
        toast.warning(`${data.refVideosFailed.length} reference video${data.refVideosFailed.length > 1 ? 's' : ''} could not be fetched — check URLs or quota`);
      }
      toast.success(`Got ${data.availableCount}/${data.allChecked} likely-available candidates`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally {
      setGenerating(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${label}`);
    } catch {
      toast.error('Copy failed');
    }
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.3), rgba(147,51,234,0.2))', border: '1px solid rgba(59,130,246,0.3)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#60a5fa' }}>
              <path d="M4 4h16v16H4z" /><path d="M4 9h16" /><path d="M9 4v16" />
            </svg>
          </div>
          <span className="badge badge-blue">Channel Naming</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Channel Naming</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Give some context, reference videos, and a visual direction. Get 10 brandable names + @handles that are actually available on YouTube.
        </p>
      </div>

      <div className="glass rounded-xl p-6 mb-6 space-y-5">
        <ModelSelector value={modelId} onChange={setModelId} />

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche</label>
          <input className="input-field" placeholder="e.g. Cybersecurity explainers, Home cooking, AI productivity..." value={niche} onChange={e => setNiche(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Channel context, voice, style (free text)</label>
          <textarea
            className="input-field"
            style={{ minHeight: 100 }}
            placeholder="e.g. I want to make 3-8 minute videos for developers who want to learn AI tools without hype. Conversational, slightly nerdy, respects the viewer's time. Inspired by Fireship but less frantic."
            value={freeText}
            onChange={e => setFreeText(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            Reference videos (up to 10 — optional, helps steer the style)
          </label>
          <div className="flex gap-2 mb-2">
            <input
              className="input-field flex-1"
              placeholder="Paste a YouTube URL..."
              value={videoInput}
              onChange={e => setVideoInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addVideo())}
            />
            <button className="btn-secondary whitespace-nowrap" onClick={addVideo} disabled={!videoInput.trim()}>+ Add</button>
          </div>
          {refVideos.length > 0 && (
            <div className="space-y-1">
              {refVideos.map(url => (
                <div key={url} className="flex items-center gap-2 text-xs px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{url}</span>
                  <button onClick={() => removeVideo(url)} style={{ color: '#ef4444' }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            Reference images (up to 5 — optional; informs visual brand tone). Images are auto-resized client-side to ~1024px to stay within request limits. Only the first image is sent to the model today; all help guide the aesthetic.
          </label>
          <input type="file" accept="image/*" multiple onChange={handleImageUpload} className="text-xs" style={{ color: 'var(--text-muted)' }} />
          {refImages.length > 0 && (
            <div className="flex gap-2 mt-2 flex-wrap">
              {refImages.map((img, i) => (
                <div key={i} className="relative">
                  <img src={img.preview} alt="" style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }} />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center text-xs"
                    style={{ background: '#ef4444', color: 'white' }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Candidates to generate</label>
            <input type="number" className="input-field" style={{ width: 100 }} min={10} max={40} value={count} onChange={e => setCount(Math.max(10, Math.min(40, parseInt(e.target.value) || 20)))} />
          </div>
          <button className="btn-primary flex items-center gap-2" onClick={generate} disabled={generating}>
            {generating ? <Spinner /> : '✨'} {generating ? 'Generating + checking handles...' : 'Generate names'}
          </button>
          <p className="text-xs flex-1 min-w-[200px]" style={{ color: 'var(--text-muted)' }}>
            We generate {count} candidates, then check each @handle against YouTube. Top 10 available are shown.
          </p>
        </div>
      </div>

      {stats && (
        <div className="mb-4 space-y-2">
          <div className="text-xs px-1" style={{ color: 'var(--text-muted)' }}>
            Checked {stats.allChecked} candidates · {stats.availableCount} available · {stats.allChecked - stats.availableCount} taken
            {typeof stats.refVideosUsed === 'number' && ` · ${stats.refVideosUsed} ref video${stats.refVideosUsed !== 1 ? 's' : ''} used`}
          </div>
          {stats.refVideosFailed && stats.refVideosFailed.length > 0 && (
            <div className="text-xs px-3 py-2 rounded" style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}>
              ⚠ Failed to fetch: {stats.refVideosFailed.join(', ')}
            </div>
          )}
          {stats.availabilityCaveat && (
            <div className="text-xs px-3 py-2 rounded" style={{ background: 'rgba(245,158,11,0.08)', color: '#fbbf24' }}>
              ℹ {stats.availabilityCaveat}
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {candidates.length > 0 && (
          <motion.div className="grid grid-cols-1 md:grid-cols-2 gap-4" initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: 0.05 } } }}>
            {candidates.map((c, i) => (
              <motion.div
                key={c.handle}
                variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
                className="glass rounded-xl p-5"
                style={{ borderLeft: `3px solid ${c.available ? '#10b981' : '#6b7280'}` }}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{c.name}</h3>
                      <span className="text-xs px-2 py-0.5 rounded" style={{
                        background: c.available ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.15)',
                        color: c.available ? '#10b981' : '#9ca3af',
                      }}>
                        {c.available ? '✓ Available' : c.checkError ? `⚠ ${c.checkError}` : '✗ Taken'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-sm font-mono" style={{ color: '#60a5fa' }}>@{c.handle}</code>
                      <button
                        onClick={() => copy(`@${c.handle}`, 'handle')}
                        className="text-xs px-2 py-0.5 rounded hover:bg-white/5"
                        style={{ color: 'var(--text-muted)' }}
                        title="Copy handle"
                      >📋</button>
                      {c.available && (
                        <a
                          href={`https://www.youtube.com/@${c.handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs px-2 py-0.5 rounded hover:bg-white/5"
                          style={{ color: 'var(--text-muted)' }}
                          title="Verify on YouTube"
                        >↗</a>
                      )}
                    </div>
                    {c.takenBy && (
                      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        Taken by: {c.takenBy.title}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-2xl font-bold" style={{ color: c.combinedScore >= 8 ? '#10b981' : c.combinedScore >= 6 ? '#f59e0b' : 'var(--text-secondary)' }}>
                      {c.combinedScore.toFixed(1)}
                    </div>
                    <div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>overall</div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center mb-3">
                  <Score label="SEO" value={c.seo_score} />
                  <Score label="Brand" value={c.brand_score} />
                  <Score label="Memorable" value={c.memorability_score} />
                </div>

                <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>{c.reasoning}</p>

                {c.keyword_coverage?.length ? (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {c.keyword_coverage.map((k, j) => (
                      <span key={j} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(59,130,246,0.1)', color: '#60a5fa' }}>{k}</span>
                    ))}
                  </div>
                ) : null}

                {c.risks && c.risks !== 'none' && (
                  <div className="text-[11px] mt-1" style={{ color: '#f59e0b' }}>⚠ {c.risks}</div>
                )}

                {c.available && c.availabilityNote && (
                  <div className="text-[10px] mt-1 italic" style={{ color: 'var(--text-muted)' }}>ℹ Verify at youtube.com/@{c.handle} before claiming</div>
                )}

                <div className="flex gap-2 mt-3 pt-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                  <button className="btn-secondary text-xs flex-1" onClick={() => copy(c.name, 'name')}>Copy name</button>
                  <button className="btn-secondary text-xs flex-1" onClick={() => copy(`${c.name} · @${c.handle}`, 'both')}>Copy both</button>
                  <span className="text-[10px] px-2 py-1 rounded" style={{ color: 'var(--text-muted)' }}>
                    {i + 1}
                  </span>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  const n = Number(value) || 0;
  const color = n >= 8 ? '#10b981' : n >= 6 ? '#f59e0b' : '#6b7280';
  return (
    <div className="rounded-lg py-1" style={{ background: 'rgba(255,255,255,0.03)' }}>
      <div className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-sm font-bold" style={{ color }}>{n}/10</div>
    </div>
  );
}
