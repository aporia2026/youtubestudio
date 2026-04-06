'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ELEVENLABS_MODELS } from '@/lib/elevenlabs';
import {
  getVoicePreset,
  cleanScriptForVoiceover,
  splitScriptSections,
  type VoicePreset,
} from '@/lib/voiceover-presets';
import { countWords, estimateDuration, formatDuration } from '@/lib/utils';
import { saveVoiceover } from '@/lib/history';

interface ElevenVoice {
  voice_id: string;
  name: string;
  category: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

interface ScriptVoiceoverPanelProps {
  script: string;
  tone: string;
  style: string;
  targetDuration: number; // minutes
  projectId?: string;
}

type GenerationMode = 'full' | 'sections';

interface SectionAudio {
  name: string;
  url: string;
  duration: number;
}

export function ScriptVoiceoverPanel({ script, tone, style, targetDuration, projectId }: ScriptVoiceoverPanelProps) {
  // API key
  const [apiKey, setApiKey] = useState('');
  const [keyInput, setKeyInput] = useState('');

  // Voices
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [voiceSearch, setVoiceSearch] = useState('');
  const [showVoicePicker, setShowVoicePicker] = useState(false);

  // Settings (auto-populated from tone/style)
  const [preset, setPreset] = useState<VoicePreset>(() => getVoicePreset(tone, style));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Generation
  const [mode, setMode] = useState<GenerationMode>('full');
  const [generating, setGenerating] = useState(false);
  const [generatingSection, setGeneratingSection] = useState<number | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [sectionAudios, setSectionAudios] = useState<SectionAudio[]>([]);
  const [audioDuration, setAudioDuration] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const previewRef = useRef<HTMLAudioElement>(null);
  const voicePickerRef = useRef<HTMLDivElement>(null);

  // Computed — memoized to avoid reprocessing long scripts every render
  const cleanedScript = useMemo(() => cleanScriptForVoiceover(script), [script]);
  const sections = useMemo(() => splitScriptSections(script), [script]);
  const wordCount = useMemo(() => countWords(cleanedScript), [cleanedScript]);
  const estimatedSeconds = estimateDuration(wordCount);
  const targetSeconds = targetDuration * 60;
  const charCount = cleanedScript.length;

  // ElevenLabs limits: warn at 5000 chars (common plan limit per request)
  const CHAR_LIMIT = 5000;
  const overCharLimit = charCount > CHAR_LIMIT;

  // Load API key on mount
  useEffect(() => {
    const saved = localStorage.getItem('elevenlabs_api_key');
    if (saved) { setApiKey(saved); loadVoices(saved); }
  }, []);

  // Update preset when tone/style changes
  useEffect(() => {
    setPreset(getVoicePreset(tone, style));
  }, [tone, style]);

  // Reset generated audio when script content changes
  useEffect(() => {
    setAudioUrl('');
    setSectionAudios([]);
    setAudioDuration(0);
  }, [script]);

  // Get audio duration when loaded — handles both fresh load and already-cached audio
  useEffect(() => {
    if (audioRef.current && audioUrl) {
      const el = audioRef.current;
      const onLoaded = () => setAudioDuration(Math.round(el.duration));
      // If already loaded (cached), read immediately
      if (el.readyState >= 1 && !isNaN(el.duration)) {
        setAudioDuration(Math.round(el.duration));
      }
      el.addEventListener('loadedmetadata', onLoaded);
      return () => el.removeEventListener('loadedmetadata', onLoaded);
    }
  }, [audioUrl]);

  // Close voice picker on outside click
  useEffect(() => {
    if (!showVoicePicker) return;
    function handleClick(e: MouseEvent) {
      if (voicePickerRef.current && !voicePickerRef.current.contains(e.target as Node)) {
        setShowVoicePicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showVoicePicker]);

  async function loadVoices(key: string) {
    try {
      const res = await fetch('/api/elevenlabs/voices', { headers: { 'x-eleven-api-key': key } });
      if (!res.ok) throw new Error('Invalid API key');
      const data = await res.json();
      setVoices(data.voices || []);
      if (data.voices?.length) setSelectedVoice(data.voices[0].voice_id);
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

  async function generateFull() {
    if (!selectedVoice || !apiKey) return;
    setGenerating(true);
    setAudioUrl('');
    setSectionAudios([]);
    try {
      const res = await fetch('/api/elevenlabs/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          text: cleanedScript,
          voiceId: selectedVoice,
          voiceSettings: {
            stability: preset.stability,
            similarity_boost: preset.similarity_boost,
            style: preset.style,
            use_speaker_boost: preset.use_speaker_boost,
          },
          modelId: preset.model_id,
          projectId,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Generation failed');
      }
      const data = await res.json();
      setAudioUrl(data.url);
      // Auto-save to history
      saveVoiceover({
        voiceName: selectedVoiceData?.name || 'Unknown',
        voiceId: selectedVoice,
        modelId: preset.model_id,
        textPreview: cleanedScript.slice(0, 2000),
        charCount: cleanedScript.length,
        audioUrl: data.url,
        tone, style,
      });
      toast.success('Voiceover generated!');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Voiceover generation failed');
    } finally {
      setGenerating(false);
    }
  }

  async function generateSection(index: number) {
    if (!selectedVoice || !apiKey) return;
    const section = sections[index];
    if (!section) return;
    setGeneratingSection(index);
    try {
      const cleanText = cleanScriptForVoiceover(section.content);
      const res = await fetch('/api/elevenlabs/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          text: cleanText,
          voiceId: selectedVoice,
          voiceSettings: {
            stability: preset.stability,
            similarity_boost: preset.similarity_boost,
            style: preset.style,
            use_speaker_boost: preset.use_speaker_boost,
          },
          modelId: preset.model_id,
          projectId,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Generation failed');
      }
      const data = await res.json();
      setSectionAudios(prev => {
        const updated = [...prev];
        updated[index] = { name: section.name, url: data.url, duration: 0 };
        return updated;
      });
      toast.success(`"${section.name}" voiceover ready`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : `Failed to generate section`);
    } finally {
      setGeneratingSection(null);
    }
  }

  async function generateAllSections() {
    if (!selectedVoice || !apiKey) return;
    setGenerating(true);
    setSectionAudios([]);
    setAudioUrl('');
    for (let i = 0; i < sections.length; i++) {
      await generateSection(i);
    }
    setGenerating(false);
    toast.success('All sections generated!');
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

  const filteredVoices = voices.filter(v =>
    !voiceSearch || v.name.toLowerCase().includes(voiceSearch.toLowerCase())
  );

  const selectedVoiceData = voices.find(v => v.voice_id === selectedVoice);
  const durationDiff = audioDuration ? audioDuration - targetSeconds : 0;

  // --- If no API key, show connect prompt ---
  if (!apiKey) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass rounded-xl p-5"
        style={{ border: '1px solid rgba(236,72,153,0.2)' }}
      >
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">🎙️</span>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Generate Voiceover</h3>
        </div>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
          Connect your ElevenLabs API key to generate a voiceover matched to your script&apos;s tone and style.
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
          <button onClick={connectKey} disabled={!keyInput.trim()} className="btn-primary text-sm">
            Connect
          </button>
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          Stored locally in your browser only.
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-xl overflow-hidden"
      style={{ border: '1px solid rgba(236,72,153,0.2)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">🎙️</span>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Script Voiceover</h3>
          <span className="badge badge-purple text-xs">Auto-tuned</span>
        </div>
        <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{wordCount.toLocaleString()} words</span>
          <span>~{formatDuration(estimatedSeconds)} est.</span>
          <span>Target: {targetDuration}m</span>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* Smart preset info */}
        <div className="p-3 rounded-lg" style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.15)' }}>
          <div className="flex items-center gap-2 mb-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--accent-purple-bright)' }}>
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" /><path d="M12 16v-4M12 8h.01" />
            </svg>
            <span className="text-xs font-semibold" style={{ color: 'var(--accent-purple-bright)' }}>
              Smart Settings — {tone} + {style}
            </span>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{preset.description}</p>
        </div>

        {/* Voice selector */}
        <div ref={voicePickerRef}>
          <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>Voice</label>
          <button
            onClick={() => setShowVoicePicker(!showVoicePicker)}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-left transition-all"
            style={{
              background: 'var(--bg-secondary)',
              border: `1px solid ${showVoicePicker ? 'var(--accent-purple)' : 'var(--border)'}`,
            }}
          >
            <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'rgba(124,58,237,0.2)' }}>🎤</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {selectedVoiceData?.name || 'Select a voice'}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {selectedVoiceData ? `${selectedVoiceData.category}${selectedVoiceData.labels?.gender ? ` · ${selectedVoiceData.labels.gender}` : ''}` : `${voices.length} voices available`}
              </div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ color: 'var(--text-muted)', transform: showVoicePicker ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          <AnimatePresence>
            {showVoicePicker && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-2 rounded-lg overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-bright)' }}>
                  <div className="p-2">
                    <input
                      value={voiceSearch}
                      onChange={e => setVoiceSearch(e.target.value)}
                      placeholder="Search voices..."
                      className="input-field"
                      style={{ padding: '6px 10px', fontSize: 12 }}
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {filteredVoices.map(voice => {
                      const isSelected = selectedVoice === voice.voice_id;
                      return (
                        <div
                          key={voice.voice_id}
                          onClick={() => { setSelectedVoice(voice.voice_id); setShowVoicePicker(false); }}
                          className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
                          style={{ background: isSelected ? 'rgba(124,58,237,0.1)' : 'transparent' }}
                          onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-card-hover)'; }}
                          onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium" style={{ color: isSelected ? 'var(--accent-purple-bright)' : 'var(--text-primary)' }}>
                              {voice.name}
                            </span>
                            <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>
                              {voice.category}{voice.labels?.gender ? ` · ${voice.labels.gender}` : ''}
                            </span>
                          </div>
                          {voice.preview_url && (
                            <button
                              onClick={e => { e.stopPropagation(); playPreview(voice); }}
                              className="p-1 rounded shrink-0"
                              style={{ color: previewPlaying === voice.voice_id ? 'var(--accent-purple-bright)' : 'var(--text-muted)' }}
                            >
                              {previewPlaying === voice.voice_id ? (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                              ) : (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                              )}
                            </button>
                          )}
                          {isSelected && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: 'var(--accent-purple-bright)' }}>
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Mode selector — only show if script has multiple sections */}
        {sections.length > 1 && (
          <div>
            <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>Generation Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setMode('full')}
                className="p-3 rounded-lg text-left transition-all"
                style={{
                  background: mode === 'full' ? 'rgba(124,58,237,0.15)' : 'var(--bg-secondary)',
                  border: `1px solid ${mode === 'full' ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
                }}
              >
                <div className="text-xs font-semibold" style={{ color: mode === 'full' ? 'var(--accent-purple-bright)' : 'var(--text-primary)' }}>Full Script</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>One continuous voiceover</div>
              </button>
              <button
                onClick={() => setMode('sections')}
                className="p-3 rounded-lg text-left transition-all"
                style={{
                  background: mode === 'sections' ? 'rgba(124,58,237,0.15)' : 'var(--bg-secondary)',
                  border: `1px solid ${mode === 'sections' ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
                }}
              >
                <div className="text-xs font-semibold" style={{ color: mode === 'sections' ? 'var(--accent-purple-bright)' : 'var(--text-primary)' }}>By Section</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{sections.length} sections — generate individually</div>
              </button>
            </div>
          </div>
        )}

        {/* ElevenLabs model */}
        <div>
          <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>TTS Model</label>
          <div className="grid grid-cols-2 gap-2">
            {ELEVENLABS_MODELS.slice(0, 2).map(m => (
              <button key={m.id} onClick={() => setPreset(p => ({ ...p, model_id: m.id }))}
                className="p-2.5 rounded-lg text-left transition-all"
                style={{
                  background: preset.model_id === m.id ? 'rgba(124,58,237,0.15)' : 'var(--bg-secondary)',
                  border: `1px solid ${preset.model_id === m.id ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
                }}>
                <div className="text-xs font-semibold" style={{ color: preset.model_id === m.id ? 'var(--accent-purple-bright)' : 'var(--text-primary)' }}>{m.name}</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{m.description}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Advanced settings toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs"
          style={{ color: 'var(--text-muted)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
            <path d="M9 18l6-6-6-6" />
          </svg>
          Advanced voice settings
        </button>

        <AnimatePresence>
          {showAdvanced && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="space-y-3 overflow-hidden"
            >
              {[
                { key: 'stability' as const, label: 'Stability', desc: 'Higher = consistent, lower = expressive' },
                { key: 'similarity_boost' as const, label: 'Clarity & Similarity', desc: 'How closely voice matches original' },
                { key: 'style' as const, label: 'Style Exaggeration', desc: 'Amplifies voice style' },
              ].map(({ key, label, desc }) => (
                <div key={key}>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</label>
                    <span className="text-xs font-bold" style={{ color: 'var(--accent-purple-bright)' }}>
                      {Math.round(preset[key] * 100)}%
                    </span>
                  </div>
                  <input
                    type="range" min={0} max={1} step={0.01}
                    value={preset[key]}
                    onChange={e => setPreset(p => ({ ...p, [key]: parseFloat(e.target.value) }))}
                    className="w-full"
                    style={{ accentColor: 'var(--accent-purple)' }}
                  />
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{desc}</p>
                </div>
              ))}
              <button
                onClick={() => setPreset(getVoicePreset(tone, style))}
                className="text-xs underline"
                style={{ color: 'var(--accent-purple-bright)' }}
              >
                Reset to smart defaults
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Character limit warning */}
        {overCharLimit && mode === 'full' && (
          <div className="p-3 rounded-lg" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }}>
            <p className="text-xs font-medium" style={{ color: '#f59e0b' }}>
              ⚠️ Script is {charCount.toLocaleString()} characters ({CHAR_LIMIT.toLocaleString()} limit per request).
              Consider using "By Section" mode to generate in smaller chunks, or your ElevenLabs plan may reject the request.
            </p>
          </div>
        )}

        {/* Generate button */}
        {mode === 'full' ? (
          <button
            onClick={generateFull}
            disabled={generating || !selectedVoice}
            className="btn-primary w-full justify-center py-2.5"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {generating ? (
              <><div className="spinner" style={{ width: 16, height: 16 }} /> Generating Voiceover...</>
            ) : (
              <>🎙️ Generate Full Voiceover</>
            )}
          </button>
        ) : (
          <div className="space-y-2">
            <button
              onClick={generateAllSections}
              disabled={generating}
              className="btn-primary w-full justify-center py-2.5"
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {generating ? (
                <><div className="spinner" style={{ width: 16, height: 16 }} /> Generating All Sections...</>
              ) : (
                <>🎙️ Generate All Sections ({sections.length})</>
              )}
            </button>
            <div className="space-y-1.5">
              {sections.map((section, i) => {
                const sectionWords = countWords(cleanScriptForVoiceover(section.content));
                const sectionAudio = sectionAudios[i];
                const isGenerating = generatingSection === i;
                return (
                  <div key={i} className="flex items-center gap-2 p-2 rounded-lg"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{section.name}</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {sectionWords} words · ~{formatDuration(estimateDuration(sectionWords))}
                      </p>
                    </div>
                    {sectionAudio ? (
                      <div className="flex items-center gap-1.5">
                        <audio controls src={sectionAudio.url} className="h-8" style={{ width: 140 }} />
                        <button onClick={() => generateSection(i)} className="text-xs p-1 rounded" style={{ color: 'var(--text-muted)' }} title="Regenerate">
                          🔄
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => generateSection(i)}
                        disabled={isGenerating || generating}
                        className="btn-secondary text-xs px-2 py-1"
                      >
                        {isGenerating ? <div className="spinner" style={{ width: 12, height: 12 }} /> : 'Generate'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Audio result (full mode) */}
        <AnimatePresence>
          {audioUrl && mode === 'full' && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-3"
            >
              <div className="p-4 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(16,185,129,0.2)' }}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-green text-xs">Ready</span>
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {selectedVoiceData?.name}
                    </span>
                  </div>
                  {audioDuration > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <span style={{ color: 'var(--text-muted)' }}>
                        Actual: {formatDuration(audioDuration)}
                      </span>
                      <span style={{
                        color: Math.abs(durationDiff) < 30 ? 'var(--accent-green)' :
                               Math.abs(durationDiff) < 60 ? '#f59e0b' : '#ef4444',
                        fontWeight: 600,
                      }}>
                        {durationDiff === 0 ? 'Exact match!' : `${durationDiff > 0 ? '+' : '-'}${formatDuration(Math.abs(durationDiff))} ${durationDiff > 0 ? 'over' : 'under'}`}
                      </span>
                    </div>
                  )}
                </div>
                <audio ref={audioRef} controls src={audioUrl} className="w-full mb-3" />
                <div className="flex gap-2">
                  <a href={audioUrl} download="voiceover.mp3" className="btn-secondary text-xs flex-1 justify-center" style={{ justifyContent: 'center' }}>
                    ⬇️ Download
                  </a>
                  <button onClick={generateFull} className="btn-secondary text-xs flex-1 justify-center" style={{ justifyContent: 'center' }}>
                    🔄 Regenerate
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <audio ref={previewRef} className="hidden" />
    </motion.div>
  );
}
