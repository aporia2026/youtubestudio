'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ELEVENLABS_MODELS } from '@/lib/elevenlabs';

interface ElevenVoice {
  voice_id: string;
  name: string;
  category: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

interface VoiceoverSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  model_id: string;
}

function VoiceoverStudio() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId');
  const [apiKey, setApiKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<VoiceoverSettings>({
    stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true,
    model_id: 'eleven_multilingual_v2',
  });
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [savedToProject, setSavedToProject] = useState(false);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [voiceCategory, setVoiceCategory] = useState('all');
  const [subscription, setSubscription] = useState<{ character_count: number; character_limit: number } | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const previewRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem('elevenlabs_api_key');
    if (saved) { setApiKey(saved); loadVoices(saved); }
  }, []);

  async function loadVoices(key: string) {
    try {
      const res = await fetch('/api/elevenlabs/voices', {
        headers: { 'x-eleven-api-key': key },
      });
      if (!res.ok) throw new Error('Invalid API key');
      const data = await res.json();
      setVoices(data.voices || []);
      if (data.voices?.length) setSelectedVoice(data.voices[0].voice_id);
      toast.success(`Loaded ${data.voices?.length} voices`);

      // Load subscription info
      const subRes = await fetch('/api/elevenlabs/subscription', { headers: { 'x-eleven-api-key': key } });
      if (subRes.ok) setSubscription(await subRes.json());
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load voices');
    }
  }

  async function connectKey() {
    if (!keyInput.trim()) return;
    const key = keyInput.trim();
    localStorage.setItem('elevenlabs_api_key', key);
    setApiKey(key);
    setKeyInput('');
    await loadVoices(key);
  }

  async function generateVoiceover() {
    if (!text.trim()) { toast.error('Enter text to convert'); return; }
    if (!selectedVoice) { toast.error('Select a voice'); return; }
    if (!apiKey) { toast.error('Connect your ElevenLabs API key first'); return; }
    setGenerating(true);
    setAudioUrl('');
    setSavedToProject(false);
    try {
      const res = await fetch('/api/elevenlabs/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          text,
          voiceId: selectedVoice,
          voiceSettings: settings,
          modelId: settings.model_id,
          projectId,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Generation failed');
      }
      const data = await res.json();
      setAudioUrl(data.url);
      toast.success('Voiceover generated!');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate voiceover');
    } finally {
      setGenerating(false);
    }
  }

  async function saveToProject() {
    if (!projectId || !audioUrl) return;
    try {
      await fetch(`/api/projects/${projectId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'url', type: 'voiceover',
          url: audioUrl, name: `Voiceover - ${voices.find(v => v.voice_id === selectedVoice)?.name || 'AI'}`,
        }),
      });
      setSavedToProject(true);
      toast.success('Saved to project!');
    } catch { toast.error('Save failed'); }
  }

  function playPreview(voice: ElevenVoice) {
    if (!voice.preview_url) return;
    if (previewPlaying === voice.voice_id) {
      previewRef.current?.pause();
      setPreviewPlaying(null);
      return;
    }
    if (previewRef.current) {
      previewRef.current.src = voice.preview_url;
      previewRef.current.play();
      setPreviewPlaying(voice.voice_id);
      previewRef.current.onended = () => setPreviewPlaying(null);
    }
  }

  const categories = ['all', ...Array.from(new Set(voices.map(v => v.category)))];
  const filteredVoices = voices.filter(v => {
    const matchSearch = !voiceSearch || v.name.toLowerCase().includes(voiceSearch.toLowerCase());
    const matchCat = voiceCategory === 'all' || v.category === voiceCategory;
    return matchSearch && matchCat;
  });

  const charCount = text.length;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(124,58,237,0.3), rgba(236,72,153,0.2))', border: '1px solid rgba(124,58,237,0.3)' }}>
            <span className="text-lg">🎙️</span>
          </div>
          <span className="badge badge-purple">ElevenLabs Pro</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Voiceover Studio</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Generate AI voiceovers with ElevenLabs Pro — choose voice, style, and preview before saving
        </p>
      </div>

      {/* API Key connection */}
      {!apiKey ? (
        <div className="glass rounded-xl p-8 max-w-lg mx-auto text-center">
          <div className="text-4xl mb-4">🔑</div>
          <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Connect ElevenLabs</h2>
          <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
            Enter your ElevenLabs API key to access your voices and generate voiceovers.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              placeholder="sk_..."
              className="input-field flex-1"
              onKeyDown={e => e.key === 'Enter' && connectKey()}
            />
            <button onClick={connectKey} disabled={!keyInput.trim()} className="btn-primary">
              Connect
            </button>
          </div>
          <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
            Your key is stored locally in your browser — never sent to our servers.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6">
          {/* Voice Browser */}
          <div className="glass rounded-xl overflow-hidden" style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="p-4" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Voice Library ({filteredVoices.length})
                </h2>
                <button
                  onClick={() => { localStorage.removeItem('elevenlabs_api_key'); setApiKey(''); setVoices([]); }}
                  className="text-xs" style={{ color: 'var(--text-muted)' }}
                >
                  Disconnect
                </button>
              </div>
              {subscription && (
                <div className="mb-3">
                  <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                    <span>Characters used</span>
                    <span>{subscription.character_count.toLocaleString()} / {subscription.character_limit.toLocaleString()}</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${(subscription.character_count / subscription.character_limit) * 100}%` }} />
                  </div>
                </div>
              )}
              <input
                value={voiceSearch}
                onChange={e => setVoiceSearch(e.target.value)}
                placeholder="Search voices..."
                className="input-field mb-2"
                style={{ padding: '8px 12px', fontSize: 13 }}
              />
              <div className="flex gap-1 flex-wrap">
                {categories.slice(0, 5).map(cat => (
                  <button key={cat} onClick={() => setVoiceCategory(cat)}
                    className="px-2 py-1 rounded text-xs capitalize transition-all"
                    style={{
                      background: voiceCategory === cat ? 'rgba(124,58,237,0.2)' : 'var(--bg-secondary)',
                      color: voiceCategory === cat ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                      border: `1px solid ${voiceCategory === cat ? 'rgba(124,58,237,0.3)' : 'transparent'}`,
                    }}>
                    {cat}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              {filteredVoices.map(voice => {
                const isSelected = selectedVoice === voice.voice_id;
                const isPreviewing = previewPlaying === voice.voice_id;
                return (
                  <div
                    key={voice.voice_id}
                    onClick={() => setSelectedVoice(voice.voice_id)}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-all"
                    style={{
                      background: isSelected ? 'rgba(124,58,237,0.15)' : 'transparent',
                      borderLeft: isSelected ? '2px solid var(--accent-purple)' : '2px solid transparent',
                    }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-card-hover)'; }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                  >
                    <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm"
                      style={{ background: isSelected ? 'rgba(124,58,237,0.3)' : 'var(--bg-secondary)' }}>
                      🎤
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                        {voice.name}
                      </p>
                      <p className="text-xs capitalize" style={{ color: 'var(--text-muted)' }}>
                        {voice.category}
                        {voice.labels?.gender ? ` · ${voice.labels.gender}` : ''}
                        {voice.labels?.age ? ` · ${voice.labels.age}` : ''}
                      </p>
                    </div>
                    {voice.preview_url && (
                      <button
                        onClick={e => { e.stopPropagation(); playPreview(voice); }}
                        className="p-1.5 rounded-lg shrink-0 transition-all"
                        style={{
                          background: isPreviewing ? 'rgba(124,58,237,0.2)' : 'var(--bg-secondary)',
                          color: isPreviewing ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                        }}
                      >
                        {isPreviewing ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Generation panel */}
          <div className="space-y-4">
            {/* Text input */}
            <div className="glass rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Script / Text</h2>
                <span className="text-xs" style={{ color: charCount > 5000 ? '#ef4444' : 'var(--text-muted)' }}>
                  {charCount.toLocaleString()} chars
                </span>
              </div>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="Paste your script here, or type text to convert to speech..."
                className="input-field"
                style={{ minHeight: 160 }}
              />
            </div>

            {/* Voice settings */}
            <div className="glass rounded-xl p-5">
              <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Voice Settings</h2>

              {/* Model */}
              <div className="mb-4">
                <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>Model</label>
                <div className="grid grid-cols-2 gap-2">
                  {ELEVENLABS_MODELS.map(m => (
                    <button key={m.id} onClick={() => setSettings(s => ({ ...s, model_id: m.id }))}
                      className="p-3 rounded-lg text-left transition-all"
                      style={{
                        background: settings.model_id === m.id ? 'rgba(124,58,237,0.15)' : 'var(--bg-secondary)',
                        border: `1px solid ${settings.model_id === m.id ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
                      }}>
                      <div className="text-xs font-semibold" style={{ color: settings.model_id === m.id ? 'var(--accent-purple-bright)' : 'var(--text-primary)' }}>{m.name}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{m.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Sliders */}
              {[
                { key: 'stability' as const, label: 'Stability', desc: 'Higher = more consistent, lower = more expressive' },
                { key: 'similarity_boost' as const, label: 'Clarity & Similarity', desc: 'How closely voice matches original' },
                { key: 'style' as const, label: 'Style Exaggeration', desc: 'Amplifies voice style — use sparingly' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="mb-4">
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</label>
                    <span className="text-xs font-bold" style={{ color: 'var(--accent-purple-bright)' }}>
                      {Math.round(settings[key] * 100)}%
                    </span>
                  </div>
                  <input
                    type="range" min={0} max={1} step={0.01}
                    value={settings[key]}
                    onChange={e => setSettings(s => ({ ...s, [key]: parseFloat(e.target.value) }))}
                    className="w-full"
                    style={{ accentColor: 'var(--accent-purple)' }}
                  />
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{desc}</p>
                </div>
              ))}

              {/* Speaker boost */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Speaker Boost</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Boosts similarity to original voice</p>
                </div>
                <button
                  onClick={() => setSettings(s => ({ ...s, use_speaker_boost: !s.use_speaker_boost }))}
                  className="relative w-12 h-6 rounded-full transition-all"
                  style={{ background: settings.use_speaker_boost ? 'var(--accent-purple)' : 'var(--bg-secondary)' }}
                >
                  <span className="absolute top-1 w-4 h-4 bg-white rounded-full transition-all"
                    style={{ left: settings.use_speaker_boost ? 28 : 4 }} />
                </button>
              </div>
            </div>

            {/* Generate button */}
            <button
              onClick={generateVoiceover}
              disabled={generating || !text.trim() || !selectedVoice}
              className="btn-primary w-full justify-center text-base py-3"
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {generating ? (
                <><div className="spinner" style={{ width: 18, height: 18 }} />Generating Voiceover...</>
              ) : (
                <>🎙️ Generate Voiceover</>
              )}
            </button>

            {/* Audio player */}
            <AnimatePresence>
              {audioUrl && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="glass rounded-xl p-5"
                  style={{ border: '1px solid rgba(124,58,237,0.3)' }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      🎵 Generated Voiceover
                    </h3>
                    <span className="badge badge-green text-xs">Ready</span>
                  </div>
                  <audio ref={audioRef} controls src={audioUrl} className="w-full mb-4" />
                  <div className="flex gap-3">
                    <a href={audioUrl} download="voiceover.mp3" className="btn-secondary text-sm flex-1 justify-center" style={{ justifyContent: 'center' }}>
                      ⬇️ Download MP3
                    </a>
                    {projectId && !savedToProject && (
                      <button onClick={saveToProject} className="btn-primary text-sm flex-1 justify-center" style={{ justifyContent: 'center' }}>
                        💾 Save to Project
                      </button>
                    )}
                    {savedToProject && (
                      <span className="btn-secondary text-sm flex-1 justify-center opacity-50" style={{ justifyContent: 'center', cursor: 'default' }}>
                        ✅ Saved
                      </span>
                    )}
                  </div>
                  <button onClick={generateVoiceover} className="mt-2 btn-secondary w-full text-sm justify-center" style={{ justifyContent: 'center' }}>
                    🔄 Regenerate
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}

      <audio ref={previewRef} className="hidden" />
    </div>
  );
}

export default function VoiceoverPage() {
  return (
    <Suspense fallback={<div className="p-8"><div className="spinner mx-auto" /></div>}>
      <VoiceoverStudio />
    </Suspense>
  );
}
