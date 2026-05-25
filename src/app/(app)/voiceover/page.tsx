'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, loadFullContextForItem } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { ScheduleLinkProvider, ScheduleSaverRegistration } from '@/components/ui/ScheduleLinkContext';
import { ELEVENLABS_MODELS } from '@/lib/elevenlabs';
import type { VoiceCatalogEntry, TtsProviderId } from '@/lib/tts/types';
import { UnifiedVoicePicker } from '@/components/voiceover/UnifiedVoicePicker';
import type { QualityBand } from '@/lib/tts/voice-bands';
import { bandForVoice } from '@/lib/tts/voice-bands';
import { synthCostUsd } from '@/lib/tts/cost';
import { cleanScriptForVoiceover } from '@/lib/voiceover-presets';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { SaveAsProject } from '@/components/ui/SaveAsProject';
import { CopyForElevenLabs } from '@/components/ui/CopyForElevenLabs';
import { getVoiceoverHistory, getVoiceoverHistoryCached, saveVoiceover, deleteVoiceoverEntry, clearVoiceoverHistory, type VoiceoverHistoryEntry } from '@/lib/history';
import { saveDraft, getActiveDraft } from '@/lib/drafts';

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
  const scheduleItemId = getScheduleLinkId(searchParams);
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState('');
  // Provider abstraction (added 2026-05-25). 'elevenlabs' preserves the
  // existing flow; 'google' switches to Google Cloud TTS via
  // /api/tts/generate. See _plans/2026-05-25-google-tts-voiceover-provider.md.
  const [provider, setProvider] = useState<TtsProviderId>('elevenlabs');
  const [googleVoices, setGoogleVoices] = useState<VoiceCatalogEntry[]>([]);
  const [selectedGoogleVoice, setSelectedGoogleVoice] = useState<VoiceCatalogEntry | null>(null);
  // Canonical selection in the unified picker — either provider lives
  // here. Generation logic still reads selectedVoice / selectedGoogleVoice
  // for backward compatibility; selecting an entry below mirrors into
  // both so existing call paths keep working.
  const [selectedEntry, setSelectedEntry] = useState<VoiceCatalogEntry | null>(null);
  const [activeBand, setActiveBand] = useState<QualityBand>('premium');
  const [pickerLanguage, setPickerLanguage] = useState('en-US');
  const [googleAvailable, setGoogleAvailable] = useState(false);
  // Cost safety gate: Studio tier is $160/1M chars (5× Chirp 3 HD). Hidden
  // by default so a slip in the dropdown can't trigger a runaway bill —
  // per the LLM Council's loudest concern in the 2026-05-25 plan. Persists
  // to localStorage so a power user opts in once and stays opted in.
  const [showExpensiveTiers, setShowExpensiveTiers] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('voiceover_show_expensive_tiers') === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      'voiceover_show_expensive_tiers',
      showExpensiveTiers ? '1' : '0',
    );
    // If the user toggles expensive tiers off while sitting on the
    // Top-tier band, bounce them back to Premium so the band tab strip
    // doesn't lose the active tab when it hides Top-tier.
    if (!showExpensiveTiers && activeBand === 'top-tier') {
      setActiveBand('premium');
    }
  }, [showExpensiveTiers, activeBand]);
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<VoiceoverSettings>({
    stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true,
    model_id: 'eleven_multilingual_v2',
  });
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [savedToProject, setSavedToProject] = useState(false);
  // Tracks which voiceover (by runKey) was last explicitly saved via the
  // banner. Drives the dirty indicator.
  const [lastSavedVoRunKey, setLastSavedVoRunKey] = useState<string | null>(null);
  // Snapshot of `text.length` at the moment the audio was generated.
  // Without this, post-generation textarea edits would skew the
  // `char_count` we stamp onto the schedule item — the audio still ties
  // to the *original* text, not whatever the user typed afterwards.
  const [audioTextCharCount, setAudioTextCharCount] = useState<number>(0);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [voiceCategory, setVoiceCategory] = useState('all');
  const [subscription, setSubscription] = useState<{ character_count: number; character_limit: number } | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const previewRef = useRef<HTMLAudioElement>(null);

  // History — instant paint from cache, then refresh from server (migration 0049).
  const [voHistoryItems, setVoHistoryItems] = useState<VoiceoverHistoryEntry[]>(() => getVoiceoverHistoryCached());
  useEffect(() => { getVoiceoverHistory().then(setVoHistoryItems).catch(() => {}); }, []);

  function restoreVoiceover(id: string) {
    const entry = voHistoryItems.find(e => e.id === id);
    if (!entry) return;
    if ((audioUrl || text) && typeof window !== 'undefined' &&
        !confirm('Replace the current voiceover state with this restored entry?')) {
      return;
    }
    setAudioUrl(entry.audioUrl);
    // Prefer full text when it was saved; fall back to the preview for legacy entries.
    setText(entry.text ?? entry.textPreview ?? '');
    // Restore the canonical char count for the audio (history snapshot wins
    // over current textarea contents — same reasoning as live generation).
    setAudioTextCharCount(entry.charCount ?? (entry.text?.length ?? 0));
    if (entry.voiceId) setSelectedVoice(entry.voiceId);
    if (entry.settings) setSettings(entry.settings);
    if (entry.text) {
      toast.success(`Voiceover restored — ${entry.charCount.toLocaleString()} chars, voice "${entry.voiceName}"`);
    } else {
      toast.info('Older entry — only preview was saved. Audio still plays; paste or re-enter the full text to regenerate.');
    }
  }

  useEffect(() => {
    // Check for prefill from QA page. Functional setter so a schedule-link
    // prefill that resolved first isn't clobbered by stale localStorage.
    try {
      const prefill = localStorage.getItem('voiceover_prefill');
      if (prefill) {
        localStorage.removeItem('voiceover_prefill');
        const data = JSON.parse(prefill);
        if (data.script) setText(curr => curr || cleanScriptForVoiceover(data.script));
      }
    } catch {}

    const saved = localStorage.getItem('elevenlabs_api_key');
    if (saved) { setApiKey(saved); loadVoices(saved); }
    else {
      // Try server-side env var
      fetch('/api/settings/key-status').then(r => r.json()).then(data => {
        if (data.elevenlabs) { setApiKey('__server__'); loadVoices(''); }
      }).catch(() => {});
    }
  }, []);

  // Schedule-link preload: pull the active script from the linked item's
  // project so the user doesn't have to paste it. Cleaned for voiceover (SSML
  // markers, stage directions stripped) before being placed in the textarea.
  useEffect(() => {
    if (!scheduleItemId || schedulePrefilled) return;
    let cancelled = false;
    (async () => {
      const item = await fetchScheduleItem(scheduleItemId);
      if (cancelled || !item) return;
      setScheduleItem(item);
      setSchedulePrefilled(true);
      const ctx = await loadFullContextForItem(item);
      if (cancelled) return;
      if (ctx.script) setText(curr => curr || cleanScriptForVoiceover(ctx.script!));
      toast.message(`Loaded context from "${item.title || 'schedule item'}"`);
    })();
    return () => { cancelled = true; };
  }, [scheduleItemId, schedulePrefilled]);

  // Probe whether the server has Google TTS credentials so the provider
  // tab strip can hide the Google tab entirely when it's not configured.
  // See _plans/2026-05-25-google-tts-voiceover-provider.md.
  useEffect(() => {
    fetch('/api/tts/voices?provider=google&languageCode=en-US')
      .then((r) => r.json())
      .then((data) => {
        const configured = Array.isArray(data.providers) && data.providers.includes('google');
        setGoogleAvailable(configured);
        if (configured && Array.isArray(data.voices) && data.voices.length > 0) {
          setGoogleVoices(data.voices);
          // Default to the first Chirp 3 HD voice we find (best quality
          // per dollar — see plan §"Voice catalog UX").
          const chirp = (data.voices as VoiceCatalogEntry[]).find(
            (v) => v.voice.tier === 'chirp3-hd',
          );
          if (chirp) setSelectedGoogleVoice(chirp);
        }
      })
      .catch(() => {});
  }, []);

  // Pull workspace TTS settings (migration 0089). Honors:
  //   - defaultLanguageCode → seeds the picker language
  //   - allowStudioTier=false → forces showExpensiveTiers off (overrides
  //     the per-user localStorage preference; the server is authoritative
  //     and would reject Studio requests anyway)
  //   - enabledProviders excluding google → hides the Google list entirely
  //   - defaultVoiceId + defaultVoiceProvider → pre-selects that voice
  //     in the picker (resolved against the loaded catalog, since voices
  //     may not be available yet when settings come back)
  const [pendingDefaultVoiceId, setPendingDefaultVoiceId] = useState<{
    provider: TtsProviderId;
    voiceId: string;
  } | null>(null);

  useEffect(() => {
    fetch('/api/workspace/tts-settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const eff = data?.effective;
        if (!eff) return;
        if (typeof eff.defaultLanguageCode === 'string') {
          setPickerLanguage(eff.defaultLanguageCode);
        }
        if (eff.allowStudioTier === false) {
          setShowExpensiveTiers(false);
        }
        if (Array.isArray(eff.enabledProviders) && !eff.enabledProviders.includes('google')) {
          setGoogleAvailable(false);
          setGoogleVoices([]);
          setSelectedGoogleVoice(null);
        }
        if (
          typeof eff.defaultVoiceId === 'string' &&
          (eff.defaultVoiceProvider === 'google' || eff.defaultVoiceProvider === 'elevenlabs')
        ) {
          setPendingDefaultVoiceId({
            provider: eff.defaultVoiceProvider,
            voiceId: eff.defaultVoiceId,
          });
        }
      })
      .catch(() => {});
  }, []);

  // Once the relevant catalog loads, resolve the pending default to an
  // actual VoiceCatalogEntry and select it (mirrors handleSelectEntry
  // so the band and provider mirror state stay consistent). For
  // ElevenLabs we search the raw `voices` array and synthesize an entry
  // shape — this avoids a hoisting dependency on elevenLabsEntries
  // which is declared further down the component.
  useEffect(() => {
    if (!pendingDefaultVoiceId) return;
    let match: VoiceCatalogEntry | undefined;
    if (pendingDefaultVoiceId.provider === 'google') {
      match = googleVoices.find((v) => v.voice.voiceId === pendingDefaultVoiceId.voiceId);
    } else {
      const raw = voices.find((v) => v.voice_id === pendingDefaultVoiceId.voiceId);
      if (raw) {
        match = {
          voice: {
            providerId: 'elevenlabs',
            voiceId: raw.voice_id,
            languageCode: 'en-US',
            tier: 'multilingual-v2',
          },
          displayName: raw.name,
          gender:
            raw.labels?.gender?.toLowerCase() === 'male'
              ? 'male'
              : raw.labels?.gender?.toLowerCase() === 'female'
                ? 'female'
                : undefined,
          previewUrl: raw.preview_url,
        };
      }
    }
    if (match) {
      handleSelectEntry(match);
      setPendingDefaultVoiceId(null);
    }
  // handleSelectEntry is recreated each render but idempotent on identical
  // input — omitting from deps prevents an infinite reapply loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDefaultVoiceId, googleVoices, voices]);

  async function loadGoogleVoicesForLanguage(languageCode: string) {
    try {
      const res = await fetch(`/api/tts/voices?provider=google&languageCode=${encodeURIComponent(languageCode)}`);
      if (!res.ok) return;
      const data = await res.json();
      const all = (data.voices as VoiceCatalogEntry[]) || [];
      setGoogleVoices(all);
    } catch {}
  }

  // Refetch Google voices when the picker language changes (Hebrew users
  // hit this — switching he-IL pulls the Chirp 3 HD Hebrew voices).
  useEffect(() => {
    if (!googleAvailable) return;
    loadGoogleVoicesForLanguage(pickerLanguage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerLanguage, googleAvailable]);

  /**
   * Adapter: turn raw ElevenLabs voices into VoiceCatalogEntry shape so
   * the unified picker can render them next to Google's catalog entries.
   * Tier defaults to multilingual-v2 (the band-grouper promotes
   * professional / cloned voices to Top-tier via the category map).
   */
  const elevenLabsEntries: VoiceCatalogEntry[] = useMemo(
    () =>
      voices.map((v) => ({
        voice: {
          providerId: 'elevenlabs' as const,
          voiceId: v.voice_id,
          languageCode: 'en-US',
          tier: 'multilingual-v2' as const,
        },
        displayName: v.name,
        gender:
          v.labels?.gender?.toLowerCase() === 'male'
            ? ('male' as const)
            : v.labels?.gender?.toLowerCase() === 'female'
              ? ('female' as const)
              : undefined,
        previewUrl: v.preview_url,
      })),
    [voices],
  );

  /** ElevenLabs category map → drives Pro/cloned promotion to Top-tier. */
  const elevenLabsCategoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of voices) m.set(v.voice_id, v.category);
    return m;
  }, [voices]);

  function handleSelectEntry(entry: VoiceCatalogEntry) {
    setSelectedEntry(entry);
    // Mirror into legacy state so generation logic keeps working
    // without a deeper refactor of generateVoiceover().
    if (entry.voice.providerId === 'elevenlabs') {
      setSelectedVoice(entry.voice.voiceId);
      setProvider('elevenlabs');
    } else {
      setSelectedGoogleVoice(entry);
      setProvider('google');
    }
    // Keep band state in sync when the user switches via the list
    // (e.g. they clicked a Top-tier voice while the Standard tab was
    // active in a previous render).
    const band = bandForVoice(entry, elevenLabsCategoryById.get(entry.voice.voiceId));
    setActiveBand(band);
  }

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
    if (provider === 'google') {
      if (!selectedGoogleVoice) { toast.error('Select a Google voice'); return; }
    } else {
      if (!selectedVoice) { toast.error('Select a voice'); return; }
      if (!apiKey) { toast.error('Connect your ElevenLabs API key first'); return; }
    }
    setGenerating(true);
    setAudioUrl('');
    setSavedToProject(false);
    try {
      let res: Response;
      if (provider === 'google' && selectedGoogleVoice) {
        // New dispatch-aware endpoint — accepts VoiceRef + provider options.
        res = await fetch('/api/tts/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            voice: selectedGoogleVoice.voice,
            text,
            options: { providerId: 'google' },
            projectId,
          }),
        });
      } else {
        // Legacy ElevenLabs endpoint — internally dispatches now but keeps
        // the same external shape for backward compatibility.
        res = await fetch('/api/elevenlabs/generate', {
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
      }
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Generation failed');
      }
      const data = await res.json();
      setAudioUrl(data.url);
      // Snapshot the text length the audio was generated from so the
      // schedule-side metadata stays consistent even if the user edits the
      // textarea afterwards.
      setAudioTextCharCount(text.length);
      // Save to history with the full text + settings so clicking a past entry
      // rehydrates everything (text, voice, sliders, model) — not just audio+preview.
      const voiceName =
        provider === 'google' && selectedGoogleVoice
          ? selectedGoogleVoice.displayName
          : voices.find(v => v.voice_id === selectedVoice)?.name || 'Unknown';
      const effectiveVoiceId =
        provider === 'google' && selectedGoogleVoice
          ? selectedGoogleVoice.voice.voiceId
          : selectedVoice;
      const savedVo = await saveVoiceover({
        voiceName,
        voiceId: effectiveVoiceId,
        modelId: settings.model_id,
        textPreview: text.slice(0, 300),
        charCount: text.length,
        audioUrl: data.url,
        tone: '',
        style: '',
        text,
        settings: { ...settings },
        videoTitle: scheduleItem?.title?.trim() || undefined,
        scheduleItemId: scheduleItemId || undefined,
      });
      // Optimistic prepend instead of refetching — a blind GET here
      // can hit a read replica before the INSERT propagates and
      // miss the new row.
      setVoHistoryItems((prev) => [savedVo, ...prev.filter((p) => p.id !== savedVo.id)]);
      // Save draft so leaving the page doesn't lose the voiceover.
      try {
        const active = getActiveDraft();
        saveDraft({
          id: active?.id,
          title: active?.title || voiceName || 'Voiceover',
          niche: active?.niche || '',
          step: 'voiceover',
          topic: active?.topic,
          modelId: settings.model_id,
          script: text,
          voiceoverUrl: data.url,
          voiceName,
        });
      } catch {}
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

  // Saver derived values. Voiceover artifact is a single audio URL +
  // associated metadata (voice, model, char count). Pushed under
  // `custom_fields_merge.latest_voiceover` since there's no dedicated
  // column on schedule_items. runKey is the audio URL alone — each
  // generation produces a new URL, so this is naturally unique per
  // artifact and stable against textarea edits.
  const voOutputReady = !!audioUrl;
  const voSelectedVoiceName = voices.find(v => v.voice_id === selectedVoice)?.name ?? null;
  const voRunKey = audioUrl || null;

  return (
    <ScheduleLinkProvider item={scheduleItem}>
      <ScheduleSaverRegistration
        handle={{
          artifactLabel: 'voiceover',
          isReady: voOutputReady,
          isDirty: voOutputReady && voRunKey !== lastSavedVoRunKey,
          notReadyReason: 'Generate a voiceover first',
          // Voiceover done → editing is the next pipeline step. Save itself
          // never advances; the banner offers "Mark as Editing" as a
          // follow-up action after the save lands.
          nextStatus: { key: 'editing', label: 'Editing' },
          buildPatch: () => ({
            patch: {},
            customFieldsMerge: {
              latest_voiceover: {
                audio_url: audioUrl,
                voice_id: selectedVoice,
                voice_name: voSelectedVoiceName,
                model_id: settings.model_id,
                char_count: audioTextCharCount,
                saved_at: new Date().toISOString(),
              },
            },
          }),
          describeSaved: () => voSelectedVoiceName
            ? `${voSelectedVoiceName} · ${audioTextCharCount.toLocaleString()} chars`
            : `${audioTextCharCount.toLocaleString()} chars`,
          onSaved: () => setLastSavedVoRunKey(voRunKey),
        }}
        autoStamp={{
          key: 'latest_voiceover',
          value: () => audioUrl ? {
            audio_url: audioUrl,
            voice_id: selectedVoice,
            voice_name: voSelectedVoiceName,
            model_id: settings.model_id,
            char_count: audioTextCharCount,
            generated_at: new Date().toISOString(),
          } : null,
          runKey: voRunKey,
        }}
      />
    <div className="p-8 max-w-7xl mx-auto">
      {scheduleItem && <ScheduleLinkBanner item={scheduleItem} feature="Voiceover Studio" />}
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(124,58,237,0.3), rgba(236,72,153,0.2))', border: '1px solid rgba(124,58,237,0.3)' }}>
            <span className="text-lg">🎙️</span>
          </div>
          <span className="badge badge-purple">
            {provider === 'google' ? 'Google Cloud TTS' : 'ElevenLabs Pro'}
          </span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Voiceover Studio</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          {provider === 'google'
            ? 'Generate AI voiceovers with Google Cloud — Chirp 3 HD for premium quality, WaveNet for budget'
            : 'Generate AI voiceovers with ElevenLabs Pro — choose voice, style, and preview before saving'}
        </p>
      </div>

      {/* Subscription char counter (ElevenLabs only) — small inline strip when connected */}
      {apiKey && subscription && (
        <div className="mb-3 flex items-center gap-3" style={{ maxWidth: 480 }}>
          <div className="flex-1">
            <div className="flex justify-between text-[11px] mb-0.5" style={{ color: 'var(--text-muted)' }}>
              <span>ElevenLabs characters used</span>
              <span>
                {subscription.character_count.toLocaleString()} /{' '}
                {subscription.character_limit.toLocaleString()}
              </span>
            </div>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${(subscription.character_count / subscription.character_limit) * 100}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Soft gate: only block when no provider is usable at all. Otherwise
         the unified picker handles Google immediately and surfaces an
         inline "Connect ElevenLabs" CTA inside the Premium / Top-tier
         bands when a key isn't connected. */}
      {!apiKey && !googleAvailable ? (
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
          {/* Unified voice picker — quality-band-grouped, provider-invisible. */}
          <UnifiedVoicePicker
            elevenLabsEntries={elevenLabsEntries}
            elevenLabsCategoryById={elevenLabsCategoryById}
            googleEntries={googleVoices}
            selectedEntry={selectedEntry}
            onSelect={handleSelectEntry}
            languageCode={pickerLanguage}
            onLanguageChange={setPickerLanguage}
            showExpensiveTiers={showExpensiveTiers}
            onToggleExpensiveTiers={setShowExpensiveTiers}
            activeBand={activeBand}
            onBandChange={setActiveBand}
            scriptCharCount={text.length}
            elevenLabsConnected={Boolean(apiKey)}
            googleAvailable={googleAvailable}
            onConnectElevenLabs={() => {
              const k = window.prompt('Paste your ElevenLabs API key (sk_…)');
              if (k && k.trim()) {
                const key = k.trim();
                localStorage.setItem('elevenlabs_api_key', key);
                setApiKey(key);
                loadVoices(key);
              }
            }}
            onDisconnectElevenLabs={() => {
              localStorage.removeItem('elevenlabs_api_key');
              setApiKey('');
              setVoices([]);
              setSubscription(null);
              // If the currently selected voice came from ElevenLabs,
              // clear the selection so the generate button doesn't try
              // to fire against a now-missing voice.
              if (selectedEntry?.voice.providerId === 'elevenlabs') {
                setSelectedEntry(null);
                setSelectedVoice('');
              }
            }}
            onPreview={(entry) => {
              const raw = voices.find((v) => v.voice_id === entry.voice.voiceId);
              if (raw) playPreview(raw);
            }}
            previewingVoiceId={previewPlaying}
          />

          {/* Generation panel */}
          <div className="space-y-4">
            {/* Text input */}
            <div className="glass rounded-xl p-5">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Script / Text</h2>
                <div className="flex items-center gap-2">
                  {text.trim().length > 0 && (
                    <>
                      <CopyForElevenLabs script={text} version="v2" />
                      <CopyForElevenLabs script={text} version="v3" />
                    </>
                  )}
                  <span className="text-xs" style={{ color: charCount > 5000 ? '#ef4444' : 'var(--text-muted)' }}>
                    {charCount.toLocaleString()} chars
                  </span>
                </div>
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
                  <div className="flex gap-2 mt-2">
                    <button onClick={generateVoiceover} className="btn-secondary flex-1 text-sm justify-center" style={{ justifyContent: 'center' }}>
                      🔄 Regenerate
                    </button>
                  </div>
                  {!projectId && (
                    <div className="mt-2">
                      <SaveAsProject
                        script={text}
                        niche={scheduleItem?.pillar ?? ''}
                        topic={scheduleItem?.title ?? ''}
                        variant="secondary"
                        className="w-full"
                        label="Save as New Project"
                      />
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}

      <audio ref={previewRef} className="hidden" />

      <HistoryPanel
        title="Voiceover History"
        icon="🎙️"
        accentColor="#ec4899"
        items={voHistoryItems.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: e.videoTitle || e.voiceName,
          sublabel: e.videoTitle
            ? `${e.voiceName} · ${e.charCount.toLocaleString()} chars`
            : `${e.charCount.toLocaleString()} chars · ${e.tone} · ${e.style}`,
          preview: e.textPreview,
        }))}
        onRestore={restoreVoiceover}
        onDelete={(id) => {
          setVoHistoryItems((prev) => prev.filter((e) => e.id !== id));
          deleteVoiceoverEntry(id).catch(() => {});
        }}
        onClearAll={() => {
          setVoHistoryItems([]);
          clearVoiceoverHistory().catch(() => {});
        }}
      />
    </div>
    </ScheduleLinkProvider>
  );
}

export default function VoiceoverPage() {
  return (
    <Suspense fallback={<div className="p-8"><div className="spinner mx-auto" /></div>}>
      <VoiceoverStudio />
    </Suspense>
  );
}
