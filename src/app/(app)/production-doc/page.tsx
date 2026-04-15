'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';

interface ProductionRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  on_screen_text: string;
  notes: string;
}

interface ProductionDoc {
  title: string;
  niche: string;
  total_duration: string;
  total_words: number;
  speaking_pace_wpm: number;
  rows: ProductionRow[];
}

const VISUAL_TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  'Title Card':       { bg: 'rgba(124,58,237,0.15)', color: '#a78bfa' },
  'B-Roll':           { bg: 'rgba(6,182,212,0.12)',  color: '#22d3ee' },
  'Talking Head':     { bg: 'rgba(16,185,129,0.12)', color: '#34d399' },
  'Screen Recording': { bg: 'rgba(245,158,11,0.12)', color: '#fbbf24' },
  'Animation':        { bg: 'rgba(236,72,153,0.12)', color: '#f472b6' },
  'Lower Third':      { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
  'Statistics':       { bg: 'rgba(239,68,68,0.12)',  color: '#f87171' },
  'Cutaway':          { bg: 'rgba(107,114,128,0.12)',color: '#9ca3af' },
};

function escapeCsvCell(value: string): string {
  if (!value) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportToCsv(doc: ProductionDoc) {
  const headers = [
    'Timecode', 'Script Text', 'Visual Type', 'Visual Description',
    'Stock Search Terms', 'AI Image Prompt (kie.ai)', 'On-Screen Text', 'Notes',
  ];
  const rows = doc.rows.map(r => [
    r.timecode,
    r.script_text,
    r.visual_type,
    r.visual_description,
    r.stock_search_terms,
    r.ai_image_prompt,
    r.on_screen_text,
    r.notes,
  ].map(escapeCsvCell).join(','));

  const csv = [
    `# Production Document: ${doc.title}`,
    `# Niche: ${doc.niche} | Duration: ${doc.total_duration} | ${doc.total_words} words @ ${doc.speaking_pace_wpm} wpm`,
    '',
    headers.join(','),
    ...rows,
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `production-doc-${doc.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success('CSV exported — open in Excel or Google Sheets');
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-xs px-1.5 py-0.5 rounded transition-all"
      style={{
        background: copied ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.06)',
        color: copied ? '#34d399' : 'var(--text-muted)',
        border: '1px solid transparent',
      }}
      title="Copy to clipboard"
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

export default function ProductionDocPage() {
  const [script, setScript] = useState('');
  const [niche, setNiche] = useState('');
  const [topic, setTopic] = useState('');
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('script-generator'));
  const [speakingPace, setSpeakingPace] = useState(135);
  const [generating, setGenerating] = useState(false);
  const [doc, setDoc] = useState<ProductionDoc | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Load prefill from localStorage (set by generator/QA pages)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('prodoc_prefill');
      if (raw) {
        localStorage.removeItem('prodoc_prefill');
        const data = JSON.parse(raw);
        if (data.script) setScript(data.script);
        if (data.niche) setNiche(data.niche);
        if (data.topic) setTopic(data.topic);
      }
    } catch {}
  }, []);

  async function generate() {
    if (!script.trim() || !niche.trim()) {
      toast.error('Script and niche are required');
      return;
    }
    setGenerating(true);
    setDoc(null);
    try {
      const res = await fetch('/api/generate/production-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, script, niche, topic, speakingPaceWpm: speakingPace }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setDoc(data.result as ProductionDoc);
      toast.success(`Production doc ready — ${data.result.rows?.length} shots`);
      setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const estDuration = wordCount > 0
    ? `~${Math.floor((wordCount / speakingPace))}:${String(Math.round(((wordCount / speakingPace) % 1) * 60)).padStart(2, '0')}`
    : null;

  return (
    <div className="p-6 max-w-full">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Production Document</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Generate a shot-by-shot production breakdown with timecodes, visuals, stock terms, and AI image prompts for your editor
        </p>
      </div>

      {/* Input Panel */}
      <div className="glass rounded-xl p-5 mb-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 mb-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Niche *</label>
            <input
              value={niche}
              onChange={e => setNiche(e.target.value)}
              placeholder="e.g. Cybersecurity & Antivirus"
              className="input-field"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Video Topic</label>
            <input
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder="e.g. Top 5 Antivirus Mistakes"
              className="input-field"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Speaking Pace (wpm)
              {estDuration && <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>→ est. {estDuration} video</span>}
            </label>
            <select
              value={speakingPace}
              onChange={e => setSpeakingPace(Number(e.target.value))}
              className="input-field"
            >
              <option value={110}>Slow — 110 wpm</option>
              <option value={125}>Moderate — 125 wpm</option>
              <option value={135}>Standard — 135 wpm</option>
              <option value={150}>Fast — 150 wpm</option>
              <option value={165}>Very Fast — 165 wpm</option>
            </select>
          </div>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Script *</label>
            {wordCount > 0 && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {wordCount.toLocaleString()} words
              </span>
            )}
          </div>
          <textarea
            value={script}
            onChange={e => setScript(e.target.value)}
            placeholder="Paste your finished script here..."
            className="input-field font-mono text-xs leading-relaxed"
            style={{ minHeight: 200, resize: 'vertical' }}
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <ModelSelector value={modelId} onChange={setModelId} label="" />
          </div>
          <button
            onClick={generate}
            disabled={generating || !script.trim() || !niche.trim()}
            className="btn-primary px-6 shrink-0"
          >
            {generating ? (
              <><div className="spinner" style={{ width: 14, height: 14 }} /> Generating...</>
            ) : (
              '🎬 Generate Production Doc'
            )}
          </button>
        </div>

        {generating && (
          <div className="mt-3 p-3 rounded-lg text-xs" style={{ background: 'rgba(124,58,237,0.08)', color: 'var(--text-secondary)' }}>
            Breaking your script into shots and writing visual directions + AI prompts for every scene. This takes 20–40 seconds...
          </div>
        )}
      </div>

      {/* Results */}
      {doc && (
        <div ref={tableRef}>
          {/* Doc header + export */}
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{doc.title || topic || niche}</h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {doc.rows?.length} shots · {doc.total_duration} · {doc.total_words?.toLocaleString()} words · {doc.speaking_pace_wpm} wpm
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => exportToCsv(doc)}
                className="btn-primary text-sm px-4"
              >
                ⬇ Export CSV / Google Sheets
              </button>
              <button
                onClick={generate}
                className="btn-secondary text-sm px-4"
              >
                ↺ Regenerate
              </button>
            </div>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-2 mb-4">
            {Object.entries(VISUAL_TYPE_COLORS).map(([type, { bg, color }]) => (
              <span key={type} className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: bg, color }}>
                {type}
              </span>
            ))}
          </div>

          {/* Table */}
          <div className="glass rounded-xl overflow-hidden">
            {/* Desktop table */}
            <div className="overflow-x-auto hidden md:block">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
                    {['#', 'Time', 'Script Text', 'Visual Type', 'Visual Description', 'Stock Terms', 'AI Image Prompt', 'On-Screen Text', 'Notes'].map(h => (
                      <th key={h} style={{
                        padding: '10px 12px', textAlign: 'left', fontWeight: 600,
                        color: 'var(--text-secondary)', whiteSpace: 'nowrap',
                        borderRight: '1px solid var(--border)',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {doc.rows?.map((row, i) => {
                    const vt = VISUAL_TYPE_COLORS[row.visual_type] || VISUAL_TYPE_COLORS['B-Roll'];
                    return (
                      <tr key={i}
                        style={{
                          borderBottom: '1px solid var(--border)',
                          background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                        }}
                      >
                        {/* Row number */}
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', borderRight: '1px solid var(--border)' }}>
                          {i + 1}
                        </td>
                        {/* Timecode */}
                        <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: 'var(--accent-cyan-bright)', whiteSpace: 'nowrap', borderRight: '1px solid var(--border)', fontWeight: 600 }}>
                          {row.timecode}
                        </td>
                        {/* Script text */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: 220, borderRight: '1px solid var(--border)', lineHeight: 1.5 }}>
                          {row.script_text}
                        </td>
                        {/* Visual type badge */}
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', borderRight: '1px solid var(--border)' }}>
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium"
                            style={{ background: vt.bg, color: vt.color }}>
                            {row.visual_type}
                          </span>
                        </td>
                        {/* Visual description */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', maxWidth: 200, borderRight: '1px solid var(--border)', lineHeight: 1.5 }}>
                          {row.visual_description}
                        </td>
                        {/* Stock terms */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-muted)', maxWidth: 150, borderRight: '1px solid var(--border)' }}>
                          <div className="flex flex-wrap gap-1">
                            {row.stock_search_terms.split(',').map((t, ti) => (
                              <span key={ti} className="px-1.5 py-0.5 rounded text-xs"
                                style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                {t.trim()}
                              </span>
                            ))}
                          </div>
                        </td>
                        {/* AI image prompt */}
                        <td style={{ padding: '8px 12px', maxWidth: 260, borderRight: '1px solid var(--border)' }}>
                          <div className="flex items-start gap-1">
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', lineHeight: 1.5, flex: 1 }}>
                              {row.ai_image_prompt}
                            </span>
                            <CopyButton text={row.ai_image_prompt} />
                          </div>
                        </td>
                        {/* On-screen text */}
                        <td style={{ padding: '8px 12px', borderRight: '1px solid var(--border)' }}>
                          {row.on_screen_text ? (
                            <span className="px-1.5 py-0.5 rounded text-xs font-medium"
                              style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>
                              {row.on_screen_text}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>—</span>
                          )}
                        </td>
                        {/* Notes */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-muted)', maxWidth: 140, fontSize: '0.7rem', lineHeight: 1.5 }}>
                          {row.notes || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y" style={{ borderColor: 'var(--border)' }}>
              {doc.rows?.map((row, i) => {
                const vt = VISUAL_TYPE_COLORS[row.visual_type] || VISUAL_TYPE_COLORS['B-Roll'];
                const isOpen = expandedRow === i;
                return (
                  <div key={i} className="p-4">
                    <button
                      className="w-full flex items-center gap-3 text-left"
                      onClick={() => setExpandedRow(isOpen ? null : i)}
                    >
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', width: 16 }}>{i + 1}</span>
                      <span style={{ fontFamily: 'monospace', color: 'var(--accent-cyan-bright)', fontWeight: 700, fontSize: '0.8rem' }}>
                        {row.timecode}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-xs"
                        style={{ background: vt.bg, color: vt.color }}>
                        {row.visual_type}
                      </span>
                      <span className="flex-1 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                        {row.script_text}
                      </span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', color: 'var(--text-muted)', flexShrink: 0 }}>
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {isOpen && (
                      <div className="mt-3 space-y-2.5 pl-4">
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Script</p>
                          <p className="text-xs" style={{ color: 'var(--text-primary)' }}>{row.script_text}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Visual</p>
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.visual_description}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Stock Terms</p>
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.stock_search_terms}</p>
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-0.5">
                            <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>AI Image Prompt</p>
                            <CopyButton text={row.ai_image_prompt} />
                          </div>
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.ai_image_prompt}</p>
                        </div>
                        {row.on_screen_text && (
                          <div>
                            <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>On-Screen Text</p>
                            <p className="text-xs" style={{ color: '#fbbf24' }}>{row.on_screen_text}</p>
                          </div>
                        )}
                        {row.notes && (
                          <div>
                            <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Notes</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{row.notes}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bottom export */}
          <div className="mt-4 flex justify-end">
            <button onClick={() => exportToCsv(doc)} className="btn-primary text-sm px-6">
              ⬇ Export CSV / Google Sheets
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
