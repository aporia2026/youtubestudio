'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/lib/dubbing-languages';
import { downloadHref } from '@/lib/download-file';

interface ProjectListItem {
  id: string;
  title: string;
  niche: string | null;
  updated_at: string;
}

interface ScriptListItem {
  id: string;
  version: number;
  word_count: number;
  estimated_duration_seconds: number;
  is_active: boolean;
  created_at: string;
}

interface ElevenVoice {
  voice_id: string;
  name: string;
  category: string;
  fine_tuning?: { language?: string };
}

interface DubRow {
  id: string;
  target_language: string;
  voice_id: string;
  audio_url: string | null;
  duration_seconds: number | null;
  char_count: number | null;
  status: 'translating' | 'generating' | 'ready' | 'failed';
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

const STATUS_LABEL: Record<DubRow['status'], { label: string; color: string }> = {
  translating: { label: 'Translating…', color: '#a78bfa' },
  generating: { label: 'Generating audio…', color: '#06b6d4' },
  ready: { label: 'Ready', color: '#10b981' },
  failed: { label: 'Failed', color: '#ef4444' },
};

export default function DubPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [scripts, setScripts] = useState<ScriptListItem[]>([]);
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [dubs, setDubs] = useState<DubRow[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedScriptId, setSelectedScriptId] = useState<string>('');
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [selectedLanguages, setSelectedLanguages] = useState<Set<SupportedLanguage>>(new Set());

  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingScripts, setLoadingScripts] = useState(false);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyLangs, setBusyLangs] = useState<Set<string>>(new Set());

  // Load projects and voices on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [projRes, voiceRes] = await Promise.all([
          fetch('/api/projects?limit=100'),
          fetch('/api/elevenlabs/voices'),
        ]);
        if (!cancelled) {
          if (projRes.ok) {
            const d = await projRes.json();
            setProjects(d.projects || []);
          }
          if (voiceRes.ok) {
            const d = await voiceRes.json();
            setVoices(d.voices || []);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) {
          setLoadingProjects(false);
          setLoadingVoices(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load scripts + dubs when project or script changes.
  useEffect(() => {
    if (!selectedProjectId) {
      setScripts([]);
      setSelectedScriptId('');
      return;
    }
    let cancelled = false;
    setLoadingScripts(true);
    fetch(`/api/projects/${selectedProjectId}/scripts`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (cancelled) return;
        const list: ScriptListItem[] = d.scripts || [];
        setScripts(list);
        // Auto-pick the active version, or the latest if none is marked active.
        const active = list.find(s => s.is_active) || list[0];
        if (active) setSelectedScriptId(active.id);
      })
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load scripts'))
      .finally(() => !cancelled && setLoadingScripts(false));
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  // Load existing dubs whenever the selected script changes.
  useEffect(() => {
    if (!selectedScriptId) {
      setDubs([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/scripts/${selectedScriptId}/dubs`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => !cancelled && setDubs(d.dubs || []))
      .catch(() => !cancelled && setDubs([]));
    return () => {
      cancelled = true;
    };
  }, [selectedScriptId]);

  function toggleLanguage(code: SupportedLanguage) {
    setSelectedLanguages(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  // Per-language dub action — runs in parallel for the chosen languages.
  // Each call hits the per-language endpoint so each one fits the 60s budget.
  async function startDubbing() {
    if (!selectedScriptId || !selectedVoiceId) {
      setError('Pick a script and a voice first.');
      return;
    }
    if (selectedLanguages.size === 0) {
      setError('Pick at least one target language.');
      return;
    }
    setError(null);
    const langs = [...selectedLanguages];
    setBusyLangs(new Set(langs));

    await Promise.all(
      langs.map(async lang => {
        try {
          const res = await fetch(`/api/scripts/${selectedScriptId}/dub`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetLanguage: lang, voiceId: selectedVoiceId }),
          });
          if (!res.ok && res.status !== 502) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || `HTTP ${res.status}`);
          }
        } catch (e) {
          // Individual language failure surfaces via the dub row's status.
          // We log to the console; the dub list polling will reflect it.
          console.error(`Dub failed for ${lang}:`, e);
        } finally {
          setBusyLangs(prev => {
            const next = new Set(prev);
            next.delete(lang);
            return next;
          });
        }
      }),
    );

    // Refresh the dubs list after all languages settle.
    try {
      const res = await fetch(`/api/scripts/${selectedScriptId}/dubs`);
      if (res.ok) {
        const d = await res.json();
        setDubs(d.dubs || []);
      }
    } catch {
      /* ignore */
    }
  }

  const selectedScript = scripts.find(s => s.id === selectedScriptId);
  // Estimate cost: ElevenLabs at ~$0.30 / 1k chars on the standard tier.
  // Word count is the script's; chars ≈ words * 5.5 (English avg).
  const estimatedChars = useMemo(() => {
    if (!selectedScript) return 0;
    return Math.round(selectedScript.word_count * 5.5);
  }, [selectedScript]);
  const estimatedCost = useMemo(() => {
    return ((estimatedChars / 1000) * 0.3 * selectedLanguages.size).toFixed(2);
  }, [estimatedChars, selectedLanguages]);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold gradient-text">Auto-dub a script</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Translate + voice your script in any of the 8 languages YouTube auto-dubbing serves.
          Per-language audio uploads to your CDN — paste the link into YouTube Studio's Audio
          Tracks tab to publish.
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

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <Section title="1. Pick a script">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Field label="Project">
              <select
                className="input-field"
                value={selectedProjectId}
                onChange={e => setSelectedProjectId(e.target.value)}
                disabled={loadingProjects}
              >
                <option value="">{loadingProjects ? 'Loading…' : 'Choose a project'}</option>
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
                disabled={!selectedProjectId || loadingScripts}
              >
                <option value="">
                  {!selectedProjectId
                    ? 'Pick a project first'
                    : loadingScripts
                      ? 'Loading…'
                      : scripts.length === 0
                        ? 'No scripts in this project'
                        : 'Choose a version'}
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
        </Section>

        <Section title="2. Pick a voice">
          <Field
            label="ElevenLabs voice"
            hint="Pick any multilingual-capable voice. multilingual_v2 supports all 8 languages with most voices."
          >
            <select
              className="input-field"
              value={selectedVoiceId}
              onChange={e => setSelectedVoiceId(e.target.value)}
              disabled={loadingVoices}
            >
              <option value="">{loadingVoices ? 'Loading…' : 'Choose a voice'}</option>
              {voices.map(v => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name} {v.fine_tuning?.language ? ` (${v.fine_tuning.language})` : ''}
                </option>
              ))}
            </select>
          </Field>
        </Section>

        <Section title="3. Pick target languages">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 8,
            }}
          >
            {SUPPORTED_LANGUAGES.map(l => {
              const checked = selectedLanguages.has(l.code);
              return (
                <label
                  key={l.code}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: checked ? 'rgba(124,58,237,0.12)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${checked ? 'rgba(124,58,237,0.45)' : 'rgba(255,255,255,0.08)'}`,
                    cursor: 'pointer',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: 'var(--text-primary)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleLanguage(l.code)}
                    style={{ accentColor: '#7c3aed' }}
                  />
                  <span>{l.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                    {l.code}
                  </span>
                </label>
              );
            })}
          </div>
          {selectedScript && selectedLanguages.size > 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
              Estimated cost (ElevenLabs standard tier): <strong>~${estimatedCost}</strong> for{' '}
              {selectedLanguages.size} {selectedLanguages.size === 1 ? 'language' : 'languages'} ·
              ~{estimatedChars.toLocaleString()} chars per language
            </p>
          )}
        </Section>

        <button
          type="button"
          onClick={startDubbing}
          disabled={
            !selectedScriptId ||
            !selectedVoiceId ||
            selectedLanguages.size === 0 ||
            busyLangs.size > 0
          }
          className="btn-primary"
          style={{ alignSelf: 'flex-start' }}
        >
          {busyLangs.size > 0 ? `Dubbing… (${busyLangs.size} in flight)` : '🎙️ Start dubbing'}
        </button>

        {selectedScriptId && (
          <Section title={`Dubs for the selected script (${dubs.length})`}>
            {dubs.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                No dubs yet for this script. Pick languages above and click <em>Start dubbing</em>.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {dubs.map(d => {
                  const meta = STATUS_LABEL[d.status];
                  const lang = SUPPORTED_LANGUAGES.find(l => l.code === d.target_language);
                  return (
                    <div
                      key={d.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '160px 130px 1fr auto',
                        gap: 16,
                        alignItems: 'center',
                        padding: '10px 14px',
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                        {lang?.label ?? d.target_language}
                      </div>
                      <span style={{ fontSize: 11, color: meta.color, fontWeight: 600 }}>
                        {meta.label}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        {d.status === 'ready' && d.audio_url && (
                          <audio
                            src={d.audio_url}
                            controls
                            preload="none"
                            style={{ width: '100%', height: 32 }}
                          />
                        )}
                        {d.status === 'failed' && (
                          <span style={{ fontSize: 12, color: '#ef4444' }}>
                            {d.error_message || 'Unknown error'}
                          </span>
                        )}
                        {(d.status === 'translating' || d.status === 'generating') && (
                          <div
                            style={{
                              height: 4,
                              background: 'rgba(255,255,255,0.06)',
                              borderRadius: 999,
                              overflow: 'hidden',
                              maxWidth: 240,
                            }}
                          >
                            <motion.div
                              style={{ height: '100%', background: meta.color, width: '40%' }}
                              animate={{ x: ['-40%', '240%'] }}
                              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                            />
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        {d.status === 'ready' && d.audio_url && (
                          <a
                            href={downloadHref(d.audio_url, `dub-${d.target_language || 'audio'}.mp3`)}
                            download
                            className="hover:underline"
                            style={{ fontSize: 12, color: 'var(--text-secondary)' }}
                          >
                            ↓ Download
                          </a>
                        )}
                        {d.duration_seconds !== null && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            ~{Math.floor(d.duration_seconds / 60)}:
                            {String(d.duration_seconds % 60).padStart(2, '0')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        )}

        <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
          Need a script first?{' '}
          <Link href="/generator" className="hover:underline">
            Generate one
          </Link>
          .
        </p>
      </motion.div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <motion.section
      variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: 18,
      }}
    >
      <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
        {title}
      </h2>
      {children}
    </motion.section>
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
