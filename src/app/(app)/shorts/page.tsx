'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { TARGET_DURATION_SECONDS_DEFAULT, type ShortRow } from '@/lib/shorts-types';

interface ProjectListItem {
  id: string;
  title: string;
  niche: string | null;
}

interface ScriptListItem {
  id: string;
  version: number;
  word_count: number;
  is_active: boolean;
}

interface ElevenVoice {
  voice_id: string;
  name: string;
}

export default function ShortsPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [scripts, setScripts] = useState<ScriptListItem[]>([]);
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [shorts, setShorts] = useState<ShortRow[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [targetSeconds, setTargetSeconds] = useState(TARGET_DURATION_SECONDS_DEFAULT);
  const [tone, setTone] = useState('');

  const [extracting, setExtracting] = useState(false);
  const [voiceoverBusy, setVoiceoverBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Initial load — projects, voices, existing shorts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [projRes, voiceRes, shortsRes] = await Promise.all([
          fetch('/api/projects?limit=100'),
          fetch('/api/elevenlabs/voices'),
          fetch('/api/shorts?limit=50'),
        ]);
        if (cancelled) return;
        if (projRes.ok) setProjects((await projRes.json()).projects || []);
        if (voiceRes.ok) setVoices((await voiceRes.json()).voices || []);
        if (shortsRes.ok) setShorts((await shortsRes.json()).shorts || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Scripts when project changes.
  useEffect(() => {
    if (!selectedProjectId) {
      setScripts([]);
      setSelectedScriptId('');
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${selectedProjectId}/scripts`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (cancelled) return;
        const list: ScriptListItem[] = d.scripts || [];
        setScripts(list);
        const active = list.find(s => s.is_active) || list[0];
        if (active) setSelectedScriptId(active.id);
      })
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load scripts'));
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  async function refreshShorts() {
    try {
      const res = await fetch('/api/shorts?limit=50');
      if (res.ok) setShorts((await res.json()).shorts || []);
    } catch {
      /* ignore */
    }
  }

  async function extractShort() {
    if (!selectedScriptId) {
      setError('Pick a script first.');
      return;
    }
    setError(null);
    setExtracting(true);
    try {
      const res = await fetch(`/api/scripts/${selectedScriptId}/short`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetSeconds,
          tone: tone.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      await refreshShorts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Extraction failed');
    } finally {
      setExtracting(false);
    }
  }

  async function generateVoiceover(shortId: string, voiceId: string) {
    if (!voiceId) {
      setError('Pick a voice first.');
      return;
    }
    setError(null);
    setVoiceoverBusy(prev => new Set(prev).add(shortId));
    try {
      const res = await fetch(`/api/shorts/${shortId}/voiceover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      await refreshShorts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Voiceover failed');
    } finally {
      setVoiceoverBusy(prev => {
        const next = new Set(prev);
        next.delete(shortId);
        return next;
      });
    }
  }

  async function deleteShort(shortId: string) {
    if (!confirm('Delete this Short?')) return;
    setError(null);
    try {
      const res = await fetch(`/api/shorts/${shortId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshShorts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const selectedScript = scripts.find(s => s.id === selectedScriptId);
  const projectVoiceId = useMemo(() => voices[0]?.voice_id ?? '', [voices]);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold gradient-text">Shorts</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Extract a 30-90 second vertical Short from any long-form script. The AI picks the
          sharpest insight, formats it for the 9:16 algorithm, and gives you back a
          speakable script with [VISUAL] cues.
        </p>
      </div>

      {error && (
        <div
          className="text-sm px-4 py-3 rounded-lg mb-4"
          style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#ef4444',
          }}
        >
          {error}
        </div>
      )}

      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 18,
          marginBottom: 18,
        }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
          Extract a new Short
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Project">
            <select
              className="input-field"
              value={selectedProjectId}
              onChange={e => setSelectedProjectId(e.target.value)}
            >
              <option value="">Choose a project</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Script version">
            <select
              className="input-field"
              value={selectedScriptId}
              onChange={e => setSelectedScriptId(e.target.value)}
              disabled={!selectedProjectId}
            >
              <option value="">
                {selectedProjectId
                  ? scripts.length === 0
                    ? 'No scripts in this project'
                    : 'Choose a version'
                  : 'Pick a project first'}
              </option>
              {scripts.map(s => (
                <option key={s.id} value={s.id}>
                  v{s.version}
                  {s.is_active ? ' (active)' : ''} — {s.word_count.toLocaleString()} words
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16, marginTop: 14 }}>
          <Field label="Target duration (seconds)" hint="10–90s. The 2026 algorithm sweet spot is 30–60s.">
            <input
              type="number"
              min={10}
              max={90}
              className="input-field"
              value={targetSeconds}
              onChange={e => setTargetSeconds(Math.max(10, Math.min(90, Number(e.target.value) || 45)))}
            />
          </Field>
          <Field label="Tone override (optional)" hint={`Free-text: "irreverent expert", "calm explainer". Defaults to the project niche's default.`}>
            <input
              type="text"
              className="input-field"
              value={tone}
              onChange={e => setTone(e.target.value)}
              placeholder="(optional)"
            />
          </Field>
        </div>
        {selectedScript && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
            Source script: <strong>{selectedScript.word_count.toLocaleString()} words</strong>.
            Extracting ~{Math.round(targetSeconds * 2.33)} words for a {targetSeconds}-second Short.
          </p>
        )}
        <button
          type="button"
          onClick={extractShort}
          disabled={!selectedScriptId || extracting}
          className="btn-primary"
          style={{ marginTop: 14 }}
        >
          {extracting ? 'Extracting…' : '✂️ Extract Short'}
        </button>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 18,
        }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
          Your Shorts ({shorts.length})
        </h2>
        {shorts.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            No Shorts yet. Pick a script above and extract one.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {shorts.map(s => (
              <ShortCard
                key={s.id}
                short={s}
                voices={voices}
                defaultVoiceId={projectVoiceId}
                voiceoverBusy={voiceoverBusy.has(s.id)}
                onGenerateVoiceover={generateVoiceover}
                onDelete={deleteShort}
              />
            ))}
          </div>
        )}
      </motion.section>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 16 }}>
        Need a long script first?{' '}
        <Link href="/generator" className="hover:underline">
          Generate one
        </Link>
        .
      </p>
    </div>
  );
}

function ShortCard({
  short,
  voices,
  defaultVoiceId,
  voiceoverBusy,
  onGenerateVoiceover,
  onDelete,
}: {
  short: ShortRow;
  voices: ElevenVoice[];
  defaultVoiceId: string;
  voiceoverBusy: boolean;
  onGenerateVoiceover: (id: string, voiceId: string) => void;
  onDelete: (id: string) => void;
}) {
  const [voiceId, setVoiceId] = useState(short.voiceover_voice_id || defaultVoiceId);

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
            {short.title || 'Untitled Short'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {short.word_count} words · ~{short.estimated_duration_seconds}s ·{' '}
            {new Date(short.created_at).toLocaleString()}
          </div>
        </div>
        <button
          onClick={() => onDelete(short.id)}
          className="text-xs"
          style={{
            color: '#ef4444',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Delete
        </button>
      </div>

      {short.hook && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-primary)',
            fontStyle: 'italic',
            padding: '8px 12px',
            background: 'rgba(124,58,237,0.06)',
            borderLeft: '2px solid #7c3aed',
            borderRadius: 4,
          }}
        >
          🎯 {short.hook}
        </div>
      )}

      <details>
        <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>
          Show full script
        </summary>
        <pre
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            background: 'rgba(0,0,0,0.2)',
            padding: 10,
            borderRadius: 6,
            marginTop: 6,
          }}
        >
          {short.short_script}
        </pre>
      </details>

      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          paddingTop: 8,
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {short.voiceover_audio_url ? (
          <>
            <audio
              src={short.voiceover_audio_url}
              controls
              preload="none"
              style={{ flex: 1, height: 32 }}
            />
            <a
              href={short.voiceover_audio_url}
              download
              className="hover:underline"
              style={{ fontSize: 12, color: 'var(--text-secondary)' }}
            >
              ↓ Download
            </a>
            <button
              onClick={() => onGenerateVoiceover(short.id, voiceId)}
              disabled={voiceoverBusy}
              className="btn-secondary text-xs"
            >
              {voiceoverBusy ? 'Regenerating…' : 'Regenerate'}
            </button>
          </>
        ) : (
          <>
            <select
              value={voiceId}
              onChange={e => setVoiceId(e.target.value)}
              className="input-field"
              style={{ flex: 1, fontSize: 13 }}
            >
              <option value="">Choose a voice</option>
              {voices.map(v => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => onGenerateVoiceover(short.id, voiceId)}
              disabled={voiceoverBusy || !voiceId}
              className="btn-primary text-xs"
            >
              {voiceoverBusy ? 'Generating…' : '🎙️ Generate voiceover'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
