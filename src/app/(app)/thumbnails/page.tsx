'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { DraftsBanner } from '@/components/ui/DraftsBanner';
import { getThumbnailHistory, saveThumbnailEntry, updateThumbnailEntry, deleteThumbnailEntry, clearThumbnailHistory, type ThumbnailHistoryEntry } from '@/lib/history';
import { saveDraft, getActiveDraft, type WorkflowDraft } from '@/lib/drafts';

interface TextOverlaySettings {
  enabled: boolean;
  text: string;
  mode: 'ai' | 'custom';
  primaryColor: string;
  accentColor: string;
  accentWords: string;
  stylePreset: string;
  customStyle: string;
}

const DEFAULT_TEXT_OVERLAY: TextOverlaySettings = {
  enabled: false, text: '', mode: 'ai', primaryColor: '#FFFFFF', accentColor: '#FF0000', accentWords: '', stylePreset: 'bold-impact', customStyle: '',
};

const STYLE_PRESETS = [
  { id: 'bold-impact', label: 'Bold Impact', font: 'Impact/Bebas Neue', desc: 'Thick bold uppercase, high contrast stroke' },
  { id: 'clean-modern', label: 'Clean Modern', font: 'Montserrat/Poppins', desc: 'Clean sans-serif, minimal, professional' },
  { id: 'neon-glow', label: 'Neon Glow', font: 'bold sans-serif with neon glow effect', desc: 'Glowing text on dark backgrounds' },
  { id: 'handwritten', label: 'Handwritten', font: 'handwritten/brush script style', desc: 'Casual, personal, authentic feel' },
  { id: 'retro-gaming', label: 'Retro/Gaming', font: 'pixel/blocky/retro game style', desc: 'High energy, gaming/tech aesthetic' },
  { id: 'cinematic', label: 'Cinematic', font: 'thin elegant serif/sans-serif', desc: 'Dramatic, movie-poster style' },
  { id: 'custom', label: 'Custom', font: '', desc: 'Describe your own style' },
];

const IMAGE_MODELS = [
  { value: 'grok-imagine-t2i', label: 'Grok Imagine (Text-to-Image)' },
  { value: 'flux2-pro-t2i', label: 'Flux2 Pro (Text-to-Image)' },
  { value: 'flux2-flex-t2i', label: 'Flux2 Flex (Text-to-Image)' },
  { value: 'nano-banana', label: 'NanoBanana (Text-to-Image)' },
  { value: 'nano-banana-2', label: 'NanoBanana 2 (Text-to-Image)' },
  { value: 'grok-imagine-i2i', label: 'Grok Imagine (Image-to-Image)' },
  { value: 'flux2-pro-i2i', label: 'Flux2 Pro (Image-to-Image)' },
  { value: 'flux2-flex-i2i', label: 'Flux2 Flex (Image-to-Image)' },
  { value: 'pro-i2i', label: 'Pro (Image-to-Image)' },
];

interface CtrBreakdownEntry {
  score: number;
  reason: string;
}

interface ThumbnailConcept {
  concept_name: string;
  creative_direction: string;
  emotional_trigger: string;
  composition: { layout: string; focal_point: string; background: string; subject_position: string };
  face_and_people: { included?: boolean; expression: string; positioning: string; eye_contact: string };
  text_overlay: { text: string; font_style: string; position: string; color: string; effect: string };
  color_palette: { primary: string; secondary: string; accent: string; psychology: string };
  ctr_prediction: {
    score: number;
    breakdown: {
      face_impact: CtrBreakdownEntry;
      contrast_and_visibility: CtrBreakdownEntry;
      text_readability: CtrBreakdownEntry;
      emotional_pull: CtrBreakdownEntry;
      title_synergy: CtrBreakdownEntry;
      niche_fit: CtrBreakdownEntry;
    };
  };
  why_it_works: string;
  mobile_test: string;
  image_generation_prompt: string;
}

interface GenerateResult {
  concepts: ThumbnailConcept[];
  niche_best_practices: string[];
  common_mistakes_to_avoid: string[];
  a_b_test_recommendation: string;
}

function ScoreRing({ score }: { score: number }) {
  const color = score < 50 ? '#ef4444' : score < 70 ? '#eab308' : '#22c55e';
  const circumference = 2 * Math.PI * 28;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative" style={{ width: 72, height: 72 }}>
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="6" />
        <circle cx="36" cy="36" r="28" fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 36 36)" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-sm font-bold" style={{ color }}>{score}</span>
      </div>
    </div>
  );
}

function MiniBar({ label, value }: { label: string; value: number }) {
  const color = value < 50 ? '#ef4444' : value < 70 ? '#eab308' : '#22c55e';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <div className="flex-1 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
        <div className="h-2 rounded-full transition-all" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="w-8 text-right font-mono" style={{ color: 'var(--text-muted)' }}>{value}</span>
    </div>
  );
}

export default function ThumbnailsPage() {
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('script-generator'));
  const [niche, setNiche] = useState('');
  const [niches, setNiches] = useState<{ id: string; name: string }[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [script, setScript] = useState('');
  const [showScript, setShowScript] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [historyItems, setHistoryItems] = useState<ThumbnailHistoryEntry[]>(() => getThumbnailHistory());
  const [draftId, setDraftId] = useState<string | null>(() => getActiveDraft()?.id || null);
  // Track which history entry the current on-screen concepts belong to, so image
  // generations (which happen after the concept-save) can be patched back onto
  // the same entry instead of creating a new one or being lost on navigation.
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);

  // Image generation
  const [imageGenEnabled, setImageGenEnabled] = useState(false);
  const [showImageSection, setShowImageSection] = useState(false);
  const [imageModel, setImageModel] = useState(IMAGE_MODELS[0].value);
  const [referenceImageUrl, setReferenceImageUrl] = useState('');
  const [generatingImages, setGeneratingImages] = useState<Record<number, boolean>>({});
  const [generatedImages, setGeneratedImages] = useState<Record<number, string>>({});
  const [uploadingRef, setUploadingRef] = useState(false);
  const [refPreviewUrl, setRefPreviewUrl] = useState('');

  // Text overlay & style — loaded from localStorage after mount to avoid SSR hydration mismatch
  const [textOverlay, setTextOverlay] = useState<TextOverlaySettings>(DEFAULT_TEXT_OVERLAY);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    try {
      const s = localStorage.getItem('thumb_style_prefs');
      if (s) {
        const parsed = JSON.parse(s);
        // Validate critical fields
        const validated: TextOverlaySettings = {
          ...DEFAULT_TEXT_OVERLAY,
          enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : false,
          text: typeof parsed.text === 'string' ? parsed.text.slice(0, 50) : '',
          mode: parsed.mode === 'custom' ? 'custom' : 'ai',
          primaryColor: /^#[0-9a-fA-F]{6}$/.test(parsed.primaryColor) ? parsed.primaryColor : '#FFFFFF',
          accentColor: /^#[0-9a-fA-F]{6}$/.test(parsed.accentColor) ? parsed.accentColor : '#FF0000',
          accentWords: typeof parsed.accentWords === 'string' ? parsed.accentWords.slice(0, 100) : '',
          stylePreset: STYLE_PRESETS.some(p => p.id === parsed.stylePreset) ? parsed.stylePreset : 'bold-impact',
          customStyle: typeof parsed.customStyle === 'string' ? parsed.customStyle.slice(0, 200) : '',
        };
        setTextOverlay(validated);
      }
    } catch {}
  }, []);

  function updateTextOverlay(updates: Partial<TextOverlaySettings>) {
    setTextOverlay((prev: TextOverlaySettings) => {
      const next = { ...prev, ...updates };
      // Debounce localStorage write to avoid lag on every keystroke
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        try { localStorage.setItem('thumb_style_prefs', JSON.stringify(next)); }
        catch { toast.error('Could not save style preferences — storage may be full'); }
      }, 500);
      return next;
    });
  }

  function resetTextOverlay() {
    setTextOverlay(DEFAULT_TEXT_OVERLAY);
    try { localStorage.removeItem('thumb_style_prefs'); } catch {}
    toast.success('Style preferences reset to defaults');
  }

  // YouTube channel videos for thumbnail attachment
  const [channels, setChannels] = useState<Array<{ id: string; name: string; channel_id: string }>>([]);
  const [channelVideos, setChannelVideos] = useState<Array<{ id: string; title: string; thumbnailUrl: string }>>([]);
  const [showAttachDialog, setShowAttachDialog] = useState<number | null>(null);
  const [loadingVideos, setLoadingVideos] = useState(false);

  const isI2I = imageModel.endsWith('-i2i');

  useEffect(() => {
    fetch('/api/niches').then(r => r.json()).then(data => {
      setNiches(data.niches || []);
      if (data.niches?.length) setNiche(data.niches[0].name);
    }).catch(() => {});
    // Load channels for "attach to video" feature
    fetch('/api/channels').then(r => r.json()).then(data => {
      setChannels((data.channels || []).map((c: { id: string; name: string; channel_id: string }) => ({ id: c.id, name: c.name, channel_id: c.channel_id })));
    }).catch(() => {});
    try {
      const prefill = localStorage.getItem('thumbnails_prefill');
      if (prefill) {
        localStorage.removeItem('thumbnails_prefill');
        const data = JSON.parse(prefill);
        if (data.title) setTitle(data.title);
        if (data.niche) setNiche(data.niche);
        if (data.description) setDescription(data.description);
      }
    } catch {}
  }, []);

  async function generateConcepts() {
    if (!title.trim()) { toast.error('Please enter a video title'); return; }
    setGenerating(true);
    setResult(null);
    setGeneratedImages({});
    try {
      const res = await fetch('/api/thumbnails/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, title: title.trim(), niche, script: script.trim() || undefined, description: description.trim() || undefined }),
      });
      if (!res.ok) throw new Error('Generation failed');
      const data = await res.json();
      setResult(data.result);
      const concepts = (data.result as { concepts?: Array<{ concept_name?: string; ctr_prediction?: { score?: number }; ctr_score?: number }> }).concepts || [];
      const best = [...concepts].sort((a, b) => ((b.ctr_prediction?.score || b.ctr_score || 0) - (a.ctr_prediction?.score || a.ctr_score || 0)))[0];
      // Save history with the full result so clicking an entry later brings back
      // the concept cards, CTR rings, and all the score breakdowns — not just
      // the title/best-concept metadata.
      const savedEntry = saveThumbnailEntry({
        title, niche, modelId,
        conceptsCount: concepts.length,
        bestConceptName: best?.concept_name || 'Untitled',
        bestScore: best?.ctr_prediction?.score || best?.ctr_score || 0,
        result: data.result,
        script: script.trim() || undefined,
        description: description.trim() || undefined,
        imageModel,
      });
      setHistoryEntryId(savedEntry.id);
      setHistoryItems(getThumbnailHistory());
      const draft = saveDraft({
        id: draftId || undefined, title, niche, step: 'thumbnails',
        topic: title, modelId, thumbnailConcept: best?.concept_name,
      });
      setDraftId(draft.id);
      toast.success('Thumbnail concepts generated!');
    } catch {
      toast.error('Failed to generate concepts. Please try again.');
    } finally {
      setGenerating(false);
    }
  }

  async function uploadReferenceImage(file: File) {
    if (!file.type.startsWith('image/')) { toast.error('Please select an image file'); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error('Image must be under 10MB'); return; }
    setUploadingRef(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'image');
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      setReferenceImageUrl(data.url);
      setRefPreviewUrl(data.url);
      toast.success('Reference image uploaded');
    } catch {
      toast.error('Failed to upload reference image');
    } finally {
      setUploadingRef(false);
    }
  }

  async function loadChannelVideos(channelId: string) {
    setLoadingVideos(true);
    try {
      const res = await fetch(`/api/channels/${channelId}`);
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setChannelVideos((data.videos || []).slice(0, 30).map((v: { video_id: string; title: string; thumbnail_url: string }) => ({
        id: v.video_id, title: v.title, thumbnailUrl: v.thumbnail_url,
      })));
    } catch {
      toast.error('Failed to load channel videos');
    } finally {
      setLoadingVideos(false);
    }
  }

  function sanitizePromptText(text: string): string {
    // Strip anything that looks like prompt injection
    return text.replace(/ignore.*instructions/gi, '').replace(/system.*prompt/gi, '').replace(/\n/g, ' ').trim().slice(0, 100);
  }

  function buildImagePrompt(basePrompt: string): string {
    let p = basePrompt;
    if (textOverlay.enabled) {
      const preset = STYLE_PRESETS.find(s => s.id === textOverlay.stylePreset);
      const fontDesc = textOverlay.stylePreset === 'custom'
        ? (sanitizePromptText(textOverlay.customStyle) || 'bold, clean style')
        : preset?.font || 'bold sans-serif';
      const textContent = textOverlay.mode === 'custom' && textOverlay.text.trim()
        ? sanitizePromptText(textOverlay.text)
        : '(choose the most impactful 2-4 words from the concept)';

      p += `\n\nIMPORTANT TEXT OVERLAY INSTRUCTIONS: Include large, prominent text on the thumbnail reading: "${textContent}". `;
      p += `Font style: ${fontDesc}. `;
      p += `Primary text color: ${textOverlay.primaryColor}. `;

      if (textOverlay.accentWords.trim()) {
        const accentSafe = sanitizePromptText(textOverlay.accentWords);
        p += `The following words must be in accent color ${textOverlay.accentColor}: "${accentSafe}". All other words in ${textOverlay.primaryColor}. `;
        p += `This creates a two-tone text effect for emphasis. `;
      }
      p += `The text must be clearly readable, high contrast against the background, and positioned prominently. `;
      if (preset?.desc) p += `Style: ${preset.desc}. `;
    }
    // Ensure prompt doesn't exceed Kie.ai limit (5000 chars)
    if (p.length > 4800) p = p.slice(0, 4800);
    return p;
  }

  async function generateImage(idx: number, prompt: string) {
    setGeneratingImages(prev => ({ ...prev, [idx]: true }));
    try {
      const finalPrompt = buildImagePrompt(prompt);
      const body: Record<string, string> = { model: imageModel, prompt: finalPrompt };
      if (referenceImageUrl.trim()) body.referenceImageUrl = referenceImageUrl.trim();
      const res = await fetch('/api/thumbnails/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Image generation failed');
      const data = await res.json();
      setGeneratedImages(prev => {
        const next = { ...prev, [idx]: data.imageUrl };
        // Patch the image URL back onto the history entry so it's there on restore.
        if (historyEntryId) {
          updateThumbnailEntry(historyEntryId, { generatedImages: next });
          setHistoryItems(getThumbnailHistory());
        }
        return next;
      });
      toast.success('Image generated!');
    } catch {
      toast.error('Image generation failed. The API may not be available yet.');
    } finally {
      setGeneratingImages(prev => ({ ...prev, [idx]: false }));
    }
  }

  function resumeDraft(draft: WorkflowDraft) {
    if (draft.topic) setTitle(draft.topic);
    if (draft.niche) setNiche(draft.niche);
    if (draft.modelId) setModelId(draft.modelId);
    setDraftId(draft.id);
    toast.success('Draft resumed');
  }

  function copyPrompt(prompt: string) {
    navigator.clipboard.writeText(prompt).then(() => toast.success('Prompt copied to clipboard'));
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, rgba(236,72,153,0.3), rgba(124,58,237,0.2))', border: '1px solid rgba(236,72,153,0.3)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(236,72,153,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
          <span className="badge badge-pink">AI Thumbnails</span>
        </div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Thumbnail Concept Generator</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>Generate click-optimized thumbnail concepts with CTR prediction scoring</p>
      </div>

      <DraftsBanner currentStep="thumbnails" onResume={resumeDraft} />

      <div className="flex gap-6" style={{ alignItems: 'flex-start' }}>
        {/* LEFT PANEL */}
        <div className="shrink-0" style={{ width: 380 }}>
          <div className="glass p-5 space-y-4" style={{ borderColor: 'rgba(236,72,153,0.15)' }}>
            <ModelSelector value={modelId} onChange={setModelId} label="AI Model" />

            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Niche</label>
              <select className="input-field w-full" value={niche} onChange={e => setNiche(e.target.value)}>
                {niches.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Video Title *</label>
              <input className="input-field w-full" placeholder="Enter your video title..." value={title} onChange={e => setTitle(e.target.value)} />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Description (optional)</label>
              <textarea className="input-field w-full" rows={2} placeholder="Brief video description..." value={description} onChange={e => setDescription(e.target.value)} />
            </div>

            <div>
              <button className="flex items-center gap-2 text-xs font-medium cursor-pointer" style={{ color: 'var(--text-muted)' }}
                onClick={() => setShowScript(!showScript)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: showScript ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                Script (optional)
              </button>
              {showScript && (
                <textarea className="input-field w-full mt-2" rows={4} placeholder="Paste your script to improve concept relevance..." value={script} onChange={e => setScript(e.target.value)} />
              )}
            </div>

            {/* Image Generation Section */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <button className="flex items-center gap-2 text-xs font-medium cursor-pointer w-full" style={{ color: 'var(--text-muted)' }}
                onClick={() => setShowImageSection(!showImageSection)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: showImageSection ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                Image Generation
              </button>
              {showImageSection && (
                <div className="mt-3 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={imageGenEnabled} onChange={e => setImageGenEnabled(e.target.checked)}
                      style={{ accentColor: 'var(--accent-pink)' }} />
                    Enable image generation
                  </label>
                  {imageGenEnabled && (
                    <>
                      <div>
                        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Image Model</label>
                        <select className="input-field w-full text-sm" value={imageModel} onChange={e => setImageModel(e.target.value)}>
                          {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                      </div>
                      {isI2I && (
                        <div className="space-y-2">
                          <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Reference Image</label>
                          {/* Upload file */}
                          <label className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all text-xs"
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            {uploadingRef ? 'Uploading...' : 'Upload reference image'}
                            <input type="file" accept="image/*" className="hidden" disabled={uploadingRef}
                              onChange={e => { const f = e.target.files?.[0]; if (f) uploadReferenceImage(f); e.target.value = ''; }} />
                          </label>
                          {/* Or paste URL */}
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>or URL:</span>
                            <input className="input-field flex-1 text-xs" placeholder="https://example.com/image.jpg"
                              value={referenceImageUrl} onChange={e => { setReferenceImageUrl(e.target.value); setRefPreviewUrl(e.target.value); }} />
                          </div>
                          {/* Preview */}
                          {refPreviewUrl && (
                            <div className="relative">
                              <img src={refPreviewUrl} alt="Reference" className="w-full h-24 object-cover rounded-lg" style={{ border: '1px solid var(--border)' }}
                                onError={() => setRefPreviewUrl('')} />
                              <button onClick={() => { setReferenceImageUrl(''); setRefPreviewUrl(''); }}
                                className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-xs"
                                style={{ background: 'rgba(0,0,0,0.7)', color: '#ef4444' }}>×</button>
                            </div>
                          )}
                        </div>
                      )}
                      {/* Reference image for text-to-image (optional style reference) */}
                      {!isI2I && (
                        <details>
                          <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>Add style reference image (optional)</summary>
                          <div className="mt-2 space-y-2">
                            <label className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all text-xs"
                              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                              </svg>
                              {uploadingRef ? 'Uploading...' : 'Upload image'}
                              <input type="file" accept="image/*" className="hidden" disabled={uploadingRef}
                                onChange={e => { const f = e.target.files?.[0]; if (f) uploadReferenceImage(f); e.target.value = ''; }} />
                            </label>
                            <input className="input-field w-full text-xs" placeholder="Or paste image URL..."
                              value={referenceImageUrl} onChange={e => { setReferenceImageUrl(e.target.value); setRefPreviewUrl(e.target.value); }} />
                            {refPreviewUrl && (
                              <img src={refPreviewUrl} alt="Reference" className="w-full h-20 object-cover rounded-lg" style={{ border: '1px solid var(--border)' }}
                                onError={() => setRefPreviewUrl('')} />
                            )}
                          </div>
                        </details>
                      )}
                      {/* Text Overlay & Style */}
                      <div className="p-3 rounded-lg space-y-2.5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                        <label className="flex items-center gap-2 cursor-pointer text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                          <input type="checkbox" checked={textOverlay.enabled} onChange={e => updateTextOverlay({ enabled: e.target.checked })}
                            style={{ accentColor: 'var(--accent-pink)' }} />
                          Text on thumbnail
                        </label>
                        {textOverlay.enabled && (
                          <div className="space-y-2.5">
                            {/* Style preset */}
                            <div>
                              <label className="block text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Style Preset</label>
                              <div className="flex flex-wrap gap-1">
                                {STYLE_PRESETS.map(s => (
                                  <button key={s.id} onClick={() => updateTextOverlay({ stylePreset: s.id })}
                                    className="text-[10px] px-2 py-1 rounded transition-all"
                                    title={s.desc}
                                    style={{
                                      background: textOverlay.stylePreset === s.id ? 'rgba(236,72,153,0.2)' : 'var(--bg-card)',
                                      border: `1px solid ${textOverlay.stylePreset === s.id ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
                                      color: textOverlay.stylePreset === s.id ? 'var(--accent-pink)' : 'var(--text-muted)',
                                    }}>
                                    {s.label}
                                  </button>
                                ))}
                              </div>
                              {textOverlay.stylePreset === 'custom' && (
                                <input className="input-field w-full text-xs mt-1" placeholder="Describe your font/style..."
                                  value={textOverlay.customStyle} onChange={e => updateTextOverlay({ customStyle: e.target.value })} />
                              )}
                              <div className="flex items-center justify-between mt-0.5">
                                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                  Saved for consistency across all thumbnails
                                </p>
                                <button onClick={resetTextOverlay} className="text-[9px] underline" style={{ color: 'var(--text-muted)' }}>Reset</button>
                              </div>
                            </div>

                            {/* Text content */}
                            <div>
                              <label className="block text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Text Content</label>
                              <div className="flex gap-2 mb-1">
                                <button onClick={() => updateTextOverlay({ mode: 'ai' })}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{ background: textOverlay.mode === 'ai' ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)', border: `1px solid ${textOverlay.mode === 'ai' ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`, color: textOverlay.mode === 'ai' ? 'var(--accent-purple-bright)' : 'var(--text-muted)' }}>
                                  AI decides
                                </button>
                                <button onClick={() => updateTextOverlay({ mode: 'custom' })}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{ background: textOverlay.mode === 'custom' ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)', border: `1px solid ${textOverlay.mode === 'custom' ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`, color: textOverlay.mode === 'custom' ? 'var(--accent-purple-bright)' : 'var(--text-muted)' }}>
                                  Custom text
                                </button>
                              </div>
                              {textOverlay.mode === 'custom' && (
                                <input className="input-field w-full text-xs" placeholder="YOUR TEXT HERE (2-5 words max)"
                                  value={textOverlay.text} onChange={e => updateTextOverlay({ text: e.target.value })} maxLength={50} />
                              )}
                            </div>

                            {/* Colors */}
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Primary Color</label>
                                <div className="flex items-center gap-2">
                                  <input type="color" value={textOverlay.primaryColor} onChange={e => updateTextOverlay({ primaryColor: e.target.value })}
                                    className="w-7 h-7 rounded cursor-pointer" style={{ border: '2px solid var(--border)', background: 'none' }} />
                                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{textOverlay.primaryColor}</span>
                                </div>
                              </div>
                              <div>
                                <label className="block text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Accent Color</label>
                                <div className="flex items-center gap-2">
                                  <input type="color" value={textOverlay.accentColor} onChange={e => updateTextOverlay({ accentColor: e.target.value })}
                                    className="w-7 h-7 rounded cursor-pointer" style={{ border: '2px solid var(--border)', background: 'none' }} />
                                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{textOverlay.accentColor}</span>
                                </div>
                              </div>
                            </div>

                            {/* Accent words */}
                            <div>
                              <label className="block text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
                                Accent words <span style={{ color: 'var(--text-muted)' }}>(these words get the accent color)</span>
                              </label>
                              <input className="input-field w-full text-xs" placeholder="e.g. DANGEROUS, NEVER"
                                value={textOverlay.accentWords} onChange={e => updateTextOverlay({ accentWords: e.target.value })} />
                              <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                Creates multi-color text — e.g. &quot;<span style={{ color: textOverlay.primaryColor }}>you won&apos;t believe</span> <span style={{ color: textOverlay.accentColor }}>WHAT THEY SAY</span>&quot;
                              </p>
                            </div>
                          </div>
                        )}
                      </div>

                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Images generated via Kie.ai API — costs may apply</p>
                    </>
                  )}
                </div>
              )}
            </div>

            <button className="btn-primary w-full flex items-center justify-center gap-2" onClick={generateConcepts} disabled={generating || !title.trim()}>
              {generating ? (
                <>
                  <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                  Generating...
                </>
              ) : 'Generate Concepts'}
            </button>
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="flex-1 min-w-0">
          <AnimatePresence mode="wait">
            {generating && !result && (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="glass p-12 text-center">
                <svg className="animate-spin mx-auto mb-4" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-pink)" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
                <p style={{ color: 'var(--text-secondary)' }}>Generating thumbnail concepts...</p>
              </motion.div>
            )}

            {result && (
              <motion.div key="results" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="space-y-4">
                {result.concepts.map((concept, idx) => (
                  <div key={idx} className="glass p-5" style={{ borderColor: 'rgba(236,72,153,0.15)' }}>
                    {/* Top section */}
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <div className="flex-1">
                        <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{concept.concept_name}</h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{concept.creative_direction}</p>
                        <span className="badge badge-pink mt-2 inline-block">{concept.emotional_trigger}</span>
                      </div>
                      <ScoreRing score={concept.ctr_prediction?.score ?? 0} />
                    </div>

                    {/* Expandable sections */}
                    <div className="space-y-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <details>
                        <summary className="cursor-pointer font-medium py-1.5" style={{ color: 'var(--text-primary)' }}>Composition</summary>
                        <div className="pl-4 pb-2 space-y-1 text-xs">
                          <p><strong>Layout:</strong> {concept.composition.layout}</p>
                          <p><strong>Focal Point:</strong> {concept.composition.focal_point}</p>
                          <p><strong>Background:</strong> {concept.composition.background}</p>
                          <p><strong>Subject Position:</strong> {concept.composition.subject_position}</p>
                        </div>
                      </details>
                      <details>
                        <summary className="cursor-pointer font-medium py-1.5" style={{ color: 'var(--text-primary)' }}>Face & People</summary>
                        <div className="pl-4 pb-2 space-y-1 text-xs">
                          <p><strong>Expression:</strong> {concept.face_and_people.expression}</p>
                          <p><strong>Positioning:</strong> {concept.face_and_people.positioning}</p>
                          <p><strong>Eye Contact:</strong> {concept.face_and_people.eye_contact}</p>
                        </div>
                      </details>
                      <details>
                        <summary className="cursor-pointer font-medium py-1.5" style={{ color: 'var(--text-primary)' }}>Text Overlay</summary>
                        <div className="pl-4 pb-2 space-y-1 text-xs">
                          <p><strong>Text:</strong> {concept.text_overlay.text}</p>
                          <p><strong>Font Style:</strong> {concept.text_overlay.font_style}</p>
                          <p><strong>Position:</strong> {concept.text_overlay.position}</p>
                          <p><strong>Color:</strong> {concept.text_overlay.color}</p>
                          <p><strong>Effect:</strong> {concept.text_overlay.effect}</p>
                        </div>
                      </details>
                      <details>
                        <summary className="cursor-pointer font-medium py-1.5" style={{ color: 'var(--text-primary)' }}>Color Palette</summary>
                        <div className="pl-4 pb-2 flex gap-3 items-center">
                          {['primary', 'secondary', 'accent'].map((key) => {
                            const hex = String((concept.color_palette as Record<string, string>)?.[key] || '#888');
                            return (
                              <div key={key} className="flex items-center gap-1.5">
                                <div style={{ background: hex.startsWith('#') ? hex : '#888', width: 24, height: 24, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.15)' }} />
                                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{key}: {hex}</span>
                              </div>
                            );
                          })}
                          {concept.color_palette?.psychology && (
                            <p className="text-xs mt-1 w-full" style={{ color: 'var(--text-muted)' }}>{concept.color_palette.psychology}</p>
                          )}
                        </div>
                      </details>
                      <details>
                        <summary className="cursor-pointer font-medium py-1.5" style={{ color: 'var(--text-primary)' }}>CTR Breakdown</summary>
                        <div className="pl-4 pb-2 space-y-1.5">
                          {concept.ctr_prediction?.breakdown && Object.entries(concept.ctr_prediction.breakdown).map(([key, entry]) => (
                            <MiniBar key={key} label={key.replace(/_/g, ' ')} value={typeof entry === 'object' && entry !== null ? (entry as CtrBreakdownEntry).score : (typeof entry === 'number' ? entry : 0)} />
                          ))}
                        </div>
                      </details>
                      <details>
                        <summary className="cursor-pointer font-medium py-1.5" style={{ color: 'var(--text-primary)' }}>Why It Works</summary>
                        <p className="pl-4 pb-2 text-xs">{concept.why_it_works}</p>
                      </details>
                      <details>
                        <summary className="cursor-pointer font-medium py-1.5" style={{ color: 'var(--text-primary)' }}>Mobile Test</summary>
                        <p className="pl-4 pb-2 text-xs">{concept.mobile_test}</p>
                      </details>
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-2 mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                      <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => copyPrompt(concept.image_generation_prompt)}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                        Copy Prompt
                      </button>
                      {imageGenEnabled && (
                        <div className="flex items-center gap-2">
                          <button className="btn-primary text-xs flex items-center gap-1.5" disabled={generatingImages[idx]}
                            onClick={() => generateImage(idx, concept.image_generation_prompt)}>
                            {generatingImages[idx] ? (
                              <>
                                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                                Generating...
                              </>
                            ) : 'Generate Image'}
                          </button>
                          {textOverlay.enabled && (
                            <span className="text-[9px]" style={{ color: 'var(--accent-yellow)' }} title="AI image models may render text imperfectly. For pixel-perfect text, add it in post-processing.">
                              Text is best-effort
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Generated image with actions */}
                    {generatedImages[idx] && (
                      <div className="mt-3 space-y-2">
                        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                          <img src={generatedImages[idx]} alt={concept.concept_name} className="w-full" style={{ maxHeight: 320, objectFit: 'cover' }} />
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <button onClick={() => { navigator.clipboard.writeText(generatedImages[idx]); toast.success('Image URL copied'); }}
                            className="btn-secondary text-xs px-2 py-1">
                            Copy URL
                          </button>
                          <a href={generatedImages[idx]} download={`thumbnail-${idx + 1}.png`} target="_blank" rel="noopener noreferrer"
                            className="btn-secondary text-xs px-2 py-1 inline-flex items-center gap-1">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                            Download
                          </a>
                          {channels.length > 0 && (
                            <button onClick={() => { setShowAttachDialog(idx); setChannelVideos([]); }}
                              className="btn-secondary text-xs px-2 py-1 flex items-center gap-1"
                              style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" />
                              </svg>
                              Set as YouTube Thumbnail
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Attach to YouTube dialog */}
                    {showAttachDialog === idx && generatedImages[idx] && (
                      <div className="mt-2 p-3 rounded-lg space-y-2" style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(239,68,68,0.3)' }}>
                        <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Select channel to load videos:</p>
                        <div className="flex gap-2 flex-wrap">
                          {channels.map(ch => (
                            <button key={ch.id} onClick={() => loadChannelVideos(ch.id)}
                              className="btn-secondary text-xs px-2 py-1">{ch.name}</button>
                          ))}
                        </div>
                        {loadingVideos && <p className="text-xs animate-pulse" style={{ color: 'var(--text-muted)' }}>Loading videos...</p>}
                        {channelVideos.length > 0 && (
                          <div className="space-y-1 max-h-48 overflow-y-auto">
                            <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Select video to set thumbnail:</p>
                            {channelVideos.map(v => (
                              <button key={v.id} onClick={() => {
                                // YouTube thumbnail set requires OAuth 2.0 — for now download + manual upload
                                toast.info('Thumbnail downloaded. YouTube thumbnail upload requires OAuth — upload manually via YouTube Studio.');
                                window.open(generatedImages[idx], '_blank');
                                setShowAttachDialog(null);
                              }}
                                className="flex items-center gap-2 w-full p-2 rounded text-left transition-all hover:opacity-80"
                                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                                {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="w-16 h-9 rounded object-cover shrink-0" />}
                                <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{v.title}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        <button onClick={() => setShowAttachDialog(null)}
                          className="text-xs" style={{ color: 'var(--text-muted)' }}>Cancel</button>
                      </div>
                    )}
                  </div>
                ))}

                {/* Bottom insights */}
                <div className="glass p-5 space-y-5" style={{ borderColor: 'rgba(236,72,153,0.15)' }}>
                  {result.niche_best_practices?.length > 0 && (
                    <div>
                      <h4 className="font-bold text-sm mb-2" style={{ color: 'var(--accent-pink)' }}>Niche Best Practices</h4>
                      <ul className="list-disc pl-5 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {result.niche_best_practices.map((p, i) => <li key={i}>{p}</li>)}
                      </ul>
                    </div>
                  )}
                  {result.common_mistakes_to_avoid?.length > 0 && (
                    <div>
                      <h4 className="font-bold text-sm mb-2" style={{ color: 'var(--accent-yellow)' }}>Common Mistakes to Avoid</h4>
                      <ul className="list-disc pl-5 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {result.common_mistakes_to_avoid.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    </div>
                  )}
                  {result.a_b_test_recommendation && (
                    <div>
                      <h4 className="font-bold text-sm mb-2" style={{ color: 'var(--accent-cyan-bright)' }}>A/B Test Recommendation</h4>
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{result.a_b_test_recommendation}</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {result && (
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => {
                    localStorage.setItem('voiceover_prefill', JSON.stringify({ script: description || title, niche }));
                    window.location.href = '/voiceover?from=thumbnails';
                  }}
                  className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center" style={{ justifyContent: 'center' }}
                >
                  🎙️ Generate Voiceover
                </button>
              </div>
            )}

            {!generating && !result && (
              <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="glass p-12 text-center">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-pink)" strokeWidth="1.5" className="mx-auto mb-4" opacity="0.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                </svg>
                <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>Enter a video title and generate thumbnail concepts</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>AI will create 5 optimized concepts with CTR predictions</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <HistoryPanel
        title="Thumbnail History"
        icon="🎨"
        items={historyItems.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: e.title,
          sublabel: `${e.niche} · ${e.conceptsCount} concepts · Best: ${e.bestConceptName} (${e.bestScore}/100)`,
        }))}
        onRestore={(id) => {
          const entry = historyItems.find(e => e.id === id);
          if (!entry) return;
          if (result && typeof window !== 'undefined' &&
              !confirm('Replace current thumbnail concepts with this restored entry?')) {
            return;
          }
          setTitle(entry.title);
          setNiche(entry.niche);
          if (entry.modelId) setModelId(entry.modelId);
          if (entry.script !== undefined) { setScript(entry.script); setShowScript(Boolean(entry.script)); }
          if (entry.description !== undefined) setDescription(entry.description);
          if (entry.imageModel) setImageModel(entry.imageModel);
          setGeneratedImages(entry.generatedImages || {});
          if (entry.result) {
            setResult(entry.result as GenerateResult);
            setHistoryEntryId(entry.id); // future image generations patch this entry
            toast.success(`Restored — ${entry.conceptsCount} concepts, best ${entry.bestScore}/100`);
          } else {
            setResult(null);
            setHistoryEntryId(null);
            toast.info('Older entry — only metadata was saved. Click Generate to produce the concepts again.');
          }
        }}
        onDelete={(id) => { deleteThumbnailEntry(id); setHistoryItems(getThumbnailHistory()); }}
        onClearAll={() => { clearThumbnailHistory(); setHistoryItems([]); }}
      />
    </div>
  );
}
