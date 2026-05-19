'use client';

import { Suspense, useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, loadFullContextForItem } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { ScheduleLinkProvider, ScheduleSaverRegistration } from '@/components/ui/ScheduleLinkContext';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { DraftsBanner } from '@/components/ui/DraftsBanner';
import { getThumbnailHistory, getThumbnailHistoryCached, saveThumbnailEntry, updateThumbnailEntry, deleteThumbnailEntry, clearThumbnailHistory, type ThumbnailHistoryEntry } from '@/lib/history';
import { saveDraft, getActiveDraft, type WorkflowDraft } from '@/lib/drafts';
import { downloadHref } from '@/lib/download-file';
import { TopicCardGridPanel, type FormatGenerationResult } from '@/components/thumbnails/TopicCardGridPanel';
import { NLevelsPanel, type NLevelsGenerationResult } from '@/components/thumbnails/NLevelsPanel';

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
  { value: 'gpt-image-2-t2i', label: 'GPT Image 2 (Text-to-Image)' },
  { value: 'grok-imagine-i2i', label: 'Grok Imagine (Image-to-Image)' },
  { value: 'flux2-pro-i2i', label: 'Flux2 Pro (Image-to-Image)' },
  { value: 'flux2-flex-i2i', label: 'Flux2 Flex (Image-to-Image)' },
  { value: 'gpt-image-2-i2i', label: 'GPT Image 2 (Image-to-Image)' },
];

/**
 * Concept-generator vision-capable models. MUST stay in sync with the
 * `VISION_ALLOWED` set in src/app/api/thumbnails/generate/route.ts —
 * a mismatch here is harmless (server is source of truth) but causes
 * unhelpful "this model doesn't support images" round-trips. When you
 * add a model to the server allowlist, mirror it here so the client
 * can pre-warn the user.
 */
const CONCEPT_VISION_MODELS = new Set<string>([
  // Anthropic direct
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  // OpenAI direct (multimodal chat)
  'gpt-4o',
  'gpt-4o-mini',
  // Google direct (Gemini 2.x)
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  // Kie.ai — Gemini variants
  'kie-gemini-2.5-flash',
  'kie-gemini-2.5-pro',
  'kie-gemini-3-flash',
  'kie-gemini-3-pro',
  'kie-gemini-3.1-pro',
  // Kie.ai — Claude variants
  'kie-claude-opus-4-7',
  'kie-claude-opus-4-6',
  'kie-claude-sonnet-4-6',
  'kie-claude-sonnet-4-5',
  'kie-claude-opus-4-5',
  'kie-claude-haiku-4-5',
]);

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

export default function ThumbnailsPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <ThumbnailsPage />
    </Suspense>
  );
}

function ThumbnailsPage() {
  const search = useSearchParams();
  const scheduleItemId = getScheduleLinkId(search);
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);

  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('script-generator'));
  const [niche, setNiche] = useState('');
  const [niches, setNiches] = useState<{ id: string; name: string }[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [script, setScript] = useState('');
  const [showScript, setShowScript] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  // Initial state from localStorage cache so the panel paints instantly;
  // useEffect below pulls the canonical list from the server (migration 0049).
  const [historyItems, setHistoryItems] = useState<ThumbnailHistoryEntry[]>(() => getThumbnailHistoryCached());
  useEffect(() => { getThumbnailHistory().then(setHistoryItems).catch(() => {}); }, []);
  const [draftId, setDraftId] = useState<string | null>(() => getActiveDraft()?.id || null);
  // Track which history entry the current on-screen concepts belong to, so image
  // generations (which happen after the concept-save) can be patched back onto
  // the same entry instead of creating a new one or being lost on navigation.
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);
  // Tracks which thumbnail set (by runKey) was last explicitly saved via
  // the banner. Drives the dirty indicator.
  const [lastSavedThumbRunKey, setLastSavedThumbRunKey] = useState<string | null>(null);

  // Thumbnail format selector. 'free-form' = the original 5-concept flow.
  // 'topic-card-grid' = the new format that produces a single composite
  // thumbnail via Step 1 (LLM card list) + Step 2 (GPT Image 2). See
  // _plans/2026-05-19-thumbnail-format-topic-card-grid.md.
  const [format, setFormat] = useState<'free-form' | 'topic-card-grid' | 'n-levels'>('free-form');
  const [formatResult, setFormatResult] = useState<FormatGenerationResult | null>(null);
  const [nLevelsResult, setNLevelsResult] = useState<NLevelsGenerationResult | null>(null);
  // Titles the user "picked" from the script textarea (select text → click
  // "Add as title"). When the picked count matches the grid/level count,
  // the format panels treat these as pre-fill labels — exact text, no LLM
  // paraphrasing. Lives at the page level because the script textarea is
  // here while the format panels live to the right.
  const [pickedLabels, setPickedLabels] = useState<string[]>([]);
  const scriptRef = useRef<HTMLTextAreaElement>(null);
  // Tracks which format result has already been persisted to history so a
  // re-render or schedule-saver tick doesn't duplicate-save the same image.
  const [savedFormatImageUrl, setSavedFormatImageUrl] = useState<string | null>(null);
  const [savedNLevelsImageUrl, setSavedNLevelsImageUrl] = useState<string | null>(null);

  // Image generation
  const [imageGenEnabled, setImageGenEnabled] = useState(false);
  const [showImageSection, setShowImageSection] = useState(false);
  // Free-form image model — defaults to GPT Image 2 (text-to-image) but
  // auto-remembers the user's last choice in localStorage. Whatever they
  // pick once becomes their personal default on subsequent visits.
  const [imageModel, setImageModel] = useState<string>(() => {
    if (typeof window === 'undefined') return 'gpt-image-2-t2i';
    try {
      const stored = localStorage.getItem('thumb_default_image_model_free_form');
      if (stored && IMAGE_MODELS.some((m) => m.value === stored)) return stored;
    } catch {
      /* fall through */
    }
    return 'gpt-image-2-t2i';
  });
  useEffect(() => {
    try { localStorage.setItem('thumb_default_image_model_free_form', imageModel); } catch { /* ignore */ }
  }, [imageModel]);
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
      // Functional setter so a parallel schedule-link prefill that resolved
      // first isn't clobbered by the default-first-niche on slow networks.
      if (data.niches?.length) setNiche(curr => curr || data.niches[0].name);
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
        if (data.title) setTitle(curr => curr || data.title);
        if (data.niche) setNiche(curr => curr || data.niche);
        if (data.description) setDescription(curr => curr || data.description);
      }
    } catch {}
  }, []);

  // Schedule-link preload: title + niche from the item, description seeded
  // from any prior YouTube description, and the active script (if any) so the
  // concept generator has the full visual context on hand.
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
      if (ctx.topic) setTitle(curr => curr || ctx.topic);
      if (ctx.niche) setNiche(curr => curr || ctx.niche);
      if (ctx.prevDescription) setDescription(curr => curr || ctx.prevDescription);
      if (ctx.script) setScript(prev => prev || ctx.script!);
      toast.message(`Loaded context from "${item.title || 'schedule item'}"`);
    })();
    return () => { cancelled = true; };
  }, [scheduleItemId, schedulePrefilled]);

  async function generateConcepts() {
    if (!title.trim()) { toast.error('Please enter a video title'); return; }
    // Pre-check: if the user has uploaded a reference but their selected AI
    // model can't read images, block the call with a clear message. The
    // server enforces the same allowlist; this just saves a round-trip and
    // gives the user a single, actionable instruction instead of a 400 toast.
    const trimmedRefUrl = referenceImageUrl.trim();
    const hasReference = trimmedRefUrl.length > 0;
    if (hasReference && !CONCEPT_VISION_MODELS.has(modelId)) {
      toast.error('This AI Model can\'t read the reference image. Pick any Claude, Gemini, GPT-4o, or Kie Claude / Kie Gemini variant — or remove the reference.');
      return;
    }
    console.info('[thumbnails generate] sending', { hasReference, modelId });
    setGenerating(true);
    setResult(null);
    setGeneratedImages({});
    try {
      const res = await fetch('/api/thumbnails/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          title: title.trim(),
          niche,
          script: script.trim() || undefined,
          description: description.trim() || undefined,
          referenceImageUrl: hasReference ? trimmedRefUrl : undefined,
        }),
      });
      if (!res.ok) {
        // Surface the server's actionable message (e.g. "Switch your AI Model
        // to a Claude 4.x, GPT-4o, or Gemini 2.x model") instead of the
        // generic fallback — otherwise users get a useless toast on the
        // exact case the model-switch check is meant to communicate.
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Generation failed (${res.status})`);
      }
      const data = await res.json();
      setResult(data.result);
      const concepts = (data.result as { concepts?: Array<{ concept_name?: string; ctr_prediction?: { score?: number }; ctr_score?: number }> }).concepts || [];
      const best = [...concepts].sort((a, b) => ((b.ctr_prediction?.score || b.ctr_score || 0) - (a.ctr_prediction?.score || a.ctr_score || 0)))[0];
      // Save history with the full result so clicking an entry later brings back
      // the concept cards, CTR rings, and all the score breakdowns — not just
      // the title/best-concept metadata.
      const savedEntry = await saveThumbnailEntry({
        title, niche, modelId,
        conceptsCount: concepts.length,
        bestConceptName: best?.concept_name || 'Untitled',
        bestScore: best?.ctr_prediction?.score || best?.ctr_score || 0,
        result: data.result,
        script: script.trim() || undefined,
        description: description.trim() || undefined,
        imageModel,
        videoTitle: scheduleItem?.title?.trim() || title.trim() || undefined,
        scheduleItemId: scheduleItemId || undefined,
      });
      setHistoryEntryId(savedEntry.id);
      // Optimistic prepend — see voiceover/generator save handlers.
      setHistoryItems((prev) => [savedEntry, ...prev.filter((p) => p.id !== savedEntry.id)]);
      const draft = saveDraft({
        id: draftId || undefined, title, niche, step: 'thumbnails',
        topic: title, modelId, thumbnailConcept: best?.concept_name,
      });
      setDraftId(draft.id);
      toast.success('Thumbnail concepts generated!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate concepts. Please try again.');
    } finally {
      setGenerating(false);
    }
  }

  async function uploadReferenceImage(file: File) {
    if (!file.type.startsWith('image/')) { toast.error('Please select an image file'); return; }
    // Direct browser → R2 upload (presigned PUT) so we bypass Vercel's
    // ~4.5 MB API body cap. Mirrors the voiceover-upload flow in
    // projects/[id]/page.tsx. The 10 MB cap is enforced on both sides:
    // here for instant feedback, and in the presign route as the source
    // of truth.
    if (file.size > 10 * 1024 * 1024) { toast.error('Image must be under 10MB'); return; }
    setUploadingRef(true);
    try {
      const presignRes = await fetch('/api/uploads/thumbnail-reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!presignRes.ok) {
        const data = await presignRes.json().catch(() => ({}));
        throw new Error((data && data.error) ? data.error : `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl } = await presignRes.json();
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);
      setReferenceImageUrl(downloadUrl);
      setRefPreviewUrl(downloadUrl);
      toast.success('Reference image uploaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to upload reference image');
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
        // Fire-and-forget: updateThumbnailEntry mutates the localStorage cache
        // synchronously, then PATCHes the server in the background.
        if (historyEntryId) {
          updateThumbnailEntry(historyEntryId, { generatedImages: next }).catch(() => {});
          setHistoryItems(getThumbnailHistoryCached());
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

  // Persist a Topic Card Grid result to history once per unique image. The
  // payload mirrors `TopicCardGridHistoryPayload` so a restore can later
  // re-render Step 2 without re-asking the user for any input. We don't
  // restore from this entry in Phase 1 UI (that's a follow-up); the entry
  // exists so the user has a permanent record in the history sidebar.
  useEffect(() => {
    if (!formatResult) return;
    if (savedFormatImageUrl === formatResult.imageUrl) return;
    const safeTitle = title.trim() || 'Topic Card Grid';
    const safeNiche = niche || 'Unspecified';
    void saveThumbnailEntry({
      title: safeTitle,
      niche: safeNiche,
      modelId,
      conceptsCount: formatResult.cards.length,
      bestConceptName: 'Topic Card Grid',
      bestScore: 0,
      script: script.trim() || undefined,
      description: description.trim() || undefined,
      imageModel: formatResult.formatImageModel,
      videoTitle: scheduleItem?.title?.trim() || safeTitle,
      scheduleItemId: scheduleItemId || undefined,
      format: 'topic-card-grid',
      formatPayload: {
        gridRows: formatResult.gridRows,
        gridCols: formatResult.gridCols,
        gridMode: formatResult.gridMode,
        mode: formatResult.mode,
        cards: formatResult.cards.map((c) => ({
          index: c.index,
          label: c.label,
          icon_concept: c.icon_concept,
          accent_color: c.accent_color,
        })),
        globalPalette: formatResult.palette,
        imageUrl: formatResult.imageUrl,
        regions: formatResult.regions,
        referenceImageUrl: formatResult.referenceImageUrl,
        formatImageModel: formatResult.formatImageModel,
        outputWidth: formatResult.outputWidth,
        outputHeight: formatResult.outputHeight,
      },
    })
      .then((saved) => {
        setSavedFormatImageUrl(formatResult.imageUrl);
        setHistoryEntryId(saved.id);
        setHistoryItems((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
      })
      .catch(() => {
        // Non-fatal; user still has the image on screen.
      });
  }, [formatResult, savedFormatImageUrl, title, niche, modelId, script, description, scheduleItem, scheduleItemId]);

  // Same persistence pattern for N Levels Explained results.
  useEffect(() => {
    if (!nLevelsResult) return;
    if (savedNLevelsImageUrl === nLevelsResult.imageUrl) return;
    const safeTitle = title.trim() || 'N Levels Explained';
    const safeNiche = niche || 'Unspecified';
    void saveThumbnailEntry({
      title: safeTitle,
      niche: safeNiche,
      modelId,
      conceptsCount: nLevelsResult.levels.length,
      bestConceptName: `${nLevelsResult.count} Levels: ${nLevelsResult.titleTopic}`,
      bestScore: 0,
      script: script.trim() || undefined,
      description: description.trim() || undefined,
      imageModel: nLevelsResult.formatImageModel,
      videoTitle: scheduleItem?.title?.trim() || safeTitle,
      scheduleItemId: scheduleItemId || undefined,
      format: 'n-levels',
      formatPayload: {
        count: nLevelsResult.count,
        mode: nLevelsResult.mode,
        levels: nLevelsResult.levels.map((l) => ({
          level: l.level,
          label: l.label,
          illustration_concept: l.illustration_concept,
          accent_color: l.accent_color,
        })),
        titleTopic: nLevelsResult.titleTopic,
        titleTagline: nLevelsResult.titleTagline,
        imageUrl: nLevelsResult.imageUrl,
        regions: nLevelsResult.regions,
        referenceImageUrl: nLevelsResult.referenceImageUrl,
        formatImageModel: nLevelsResult.formatImageModel,
        outputWidth: nLevelsResult.outputWidth,
        outputHeight: nLevelsResult.outputHeight,
      },
    })
      .then((saved) => {
        setSavedNLevelsImageUrl(nLevelsResult.imageUrl);
        setHistoryEntryId(saved.id);
        setHistoryItems((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
      })
      .catch(() => {
        /* non-fatal */
      });
  }, [nLevelsResult, savedNLevelsImageUrl, title, niche, modelId, script, description, scheduleItem, scheduleItemId]);

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

  // Saver derived values. We push the first two generated images as
  // thumbnail_a_url / thumbnail_b_url. If only one is present, only A is
  // pushed and B is left untouched. Winner picking happens elsewhere
  // (the schedule item detail panel) — we never overwrite an existing
  // winner with null, so the page stays safe to re-save.
  //
  // For the Topic Card Grid format, `formatResult` carries a single composite
  // image PLUS deterministic region rectangles. We push the composite as
  // thumbnail_a_url and forward the regions so production-doc can use them
  // without an "Auto-detect regions" vision pass.
  const generatedImageEntries = Object.entries(generatedImages).sort(([a], [b]) => Number(a) - Number(b));
  const gridActive = format === 'topic-card-grid';
  const nLevelsActive = format === 'n-levels';
  const formatActive = gridActive || nLevelsActive;
  const activeFormatImageUrl = gridActive
    ? formatResult?.imageUrl ?? null
    : nLevelsActive
      ? nLevelsResult?.imageUrl ?? null
      : null;
  const activeFormatRegions = gridActive
    ? formatResult?.regions ?? null
    : nLevelsActive
      ? nLevelsResult?.regions ?? null
      : null;
  const activeFormatImageModel = gridActive
    ? formatResult?.formatImageModel
    : nLevelsActive
      ? nLevelsResult?.formatImageModel
      : undefined;
  const thumbAUrl = formatActive
    ? activeFormatImageUrl
    : generatedImageEntries[0]?.[1] ?? null;
  const thumbBUrl = formatActive
    ? null
    : generatedImageEntries[1]?.[1] ?? null;
  const thumbsReady = !!thumbAUrl;
  const thumbRunKey = thumbsReady
    ? `${thumbAUrl ?? ''}::${thumbBUrl ?? ''}`
    : null;

  return (
    <ScheduleLinkProvider item={scheduleItem}>
      <ScheduleSaverRegistration
        handle={{
          artifactLabel: 'thumbnails',
          isReady: thumbsReady,
          isDirty: thumbsReady && thumbRunKey !== lastSavedThumbRunKey,
          notReadyReason: 'Generate at least one thumbnail image first',
          // Thumbnail iteration spans multiple stages (A/B testing, post-
          // launch swaps). No automatic pipeline advance.
          buildPatch: () => {
            const patch: Record<string, unknown> = {};
            if (thumbAUrl) patch.thumbnail_a_url = thumbAUrl;
            if (thumbBUrl) patch.thumbnail_b_url = thumbBUrl;
            // Both Topic Card Grid and N Levels carry deterministic region
            // rectangles for the composite — pass them through so
            // production-doc picks them up without an "Auto-detect regions"
            // vision call.
            if (formatActive && activeFormatRegions) {
              patch.thumbnail_regions = activeFormatRegions;
            }
            return {
              patch,
              customFieldsMerge: {
                latest_thumbnails: {
                  history_entry_id: historyEntryId,
                  count: formatActive ? 1 : generatedImageEntries.length,
                  saved_at: new Date().toISOString(),
                  model_id: formatActive ? activeFormatImageModel : imageModel,
                  format: gridActive ? 'topic-card-grid' : nLevelsActive ? 'n-levels' : 'free-form',
                  regions_count: formatActive ? activeFormatRegions?.length ?? 0 : 0,
                },
              },
            };
          },
          describeSaved: () => {
            const n = generatedImageEntries.length;
            return `${n} image${n === 1 ? '' : 's'}`;
          },
          onSaved: () => setLastSavedThumbRunKey(thumbRunKey),
        }}
        autoStamp={{
          key: 'latest_thumbnails',
          value: () => thumbsReady ? {
            history_entry_id: historyEntryId,
            count: formatActive ? 1 : generatedImageEntries.length,
            generated_at: new Date().toISOString(),
            model_id: formatActive ? activeFormatImageModel : imageModel,
            format: gridActive ? 'topic-card-grid' : nLevelsActive ? 'n-levels' : 'free-form',
          } : null,
          runKey: thumbRunKey,
        }}
      />
    <div className="p-8 max-w-6xl mx-auto">
      {scheduleItem && <ScheduleLinkBanner item={scheduleItem} feature="Thumbnail Studio" />}
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
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Format</label>
              <select
                className="input-field w-full"
                value={format}
                onChange={(e) => {
                  const next = e.target.value as 'free-form' | 'topic-card-grid' | 'n-levels';
                  setFormat(next);
                  // Both formats require a reference image; auto-enable the
                  // image-generation section so the upload UI is visible
                  // without an extra click.
                  if (next === 'topic-card-grid' || next === 'n-levels') {
                    setImageGenEnabled(true);
                    setShowImageSection(true);
                  }
                }}
              >
                <option value="free-form">Free-form (5 concepts)</option>
                <option value="topic-card-grid">Topic Card Grid</option>
                <option value="n-levels">N Levels Explained</option>
              </select>
              {format === 'topic-card-grid' && (
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  Produces a single composite thumbnail as an N×M grid of titled cards. Requires a reference image — upload one in the Image Generation section below.
                </p>
              )}
              {format === 'n-levels' && (
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  Produces an &quot;N LEVELS OF [TOPIC]&quot; thumbnail with vertical slices and a grunge title bar. Requires a reference image.
                </p>
              )}
            </div>

            <ModelSelector
              value={modelId}
              onChange={setModelId}
              label="AI Model"
              allowedIds={CONCEPT_VISION_MODELS}
            />

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
                <textarea ref={scriptRef} className="input-field w-full mt-2" rows={4} placeholder="Paste your script to improve concept relevance..." value={script} onChange={e => setScript(e.target.value)} />
              )}
              {/* Title picker — only meaningful for the grid / n-levels formats.
                  Select text in the script above and click "Add as title" to
                  pull the exact wording into the card list. When the picked
                  count matches the grid/level count, the run uses Pre-fill
                  mode automatically — guarantees zero label paraphrasing. */}
              {showScript && (format === 'topic-card-grid' || format === 'n-levels') && (
                <div className="mt-3 p-2 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                      Pick titles from script
                    </label>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {pickedLabels.length} picked
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const ta = scriptRef.current;
                        if (!ta) return;
                        const start = ta.selectionStart;
                        const end = ta.selectionEnd;
                        if (start === end) {
                          toast.error('Select some text in the script first.');
                          return;
                        }
                        // Normalise: collapse whitespace, strip control chars,
                        // clip to 60 (matches the server-side label cap).
                        const raw = script.slice(start, end);
                        const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
                        if (!normalized) {
                          toast.error('Selection is empty after trimming.');
                          return;
                        }
                        setPickedLabels((prev) => [...prev, normalized]);
                      }}
                      className="text-[10px] px-2 py-1 rounded"
                      style={{ background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.4)', color: 'var(--accent-purple-bright)' }}
                    >
                      + Add selection as title
                    </button>
                    {pickedLabels.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setPickedLabels([])}
                        className="text-[10px] px-2 py-1 rounded"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                  {pickedLabels.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {pickedLabels.map((label, i) => (
                        <div key={i} className="flex items-center gap-1.5 px-1.5 py-1 rounded" style={{ background: 'var(--bg-card)' }}>
                          <span className="text-[10px] font-mono w-4 text-right" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                          <span className="text-[11px] flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{label}</span>
                          <button
                            type="button"
                            onClick={() => setPickedLabels((prev) => {
                              if (i === 0) return prev;
                              const next = [...prev];
                              [next[i - 1], next[i]] = [next[i], next[i - 1]];
                              return next;
                            })}
                            disabled={i === 0}
                            className="text-[10px] px-1 rounded"
                            style={{ background: 'var(--bg-secondary)', color: i === 0 ? 'var(--text-muted)' : 'var(--text-secondary)', opacity: i === 0 ? 0.4 : 1 }}
                            title="Move up"
                          >↑</button>
                          <button
                            type="button"
                            onClick={() => setPickedLabels((prev) => {
                              if (i === prev.length - 1) return prev;
                              const next = [...prev];
                              [next[i], next[i + 1]] = [next[i + 1], next[i]];
                              return next;
                            })}
                            disabled={i === pickedLabels.length - 1}
                            className="text-[10px] px-1 rounded"
                            style={{ background: 'var(--bg-secondary)', color: i === pickedLabels.length - 1 ? 'var(--text-muted)' : 'var(--text-secondary)', opacity: i === pickedLabels.length - 1 ? 0.4 : 1 }}
                            title="Move down"
                          >↓</button>
                          <button
                            type="button"
                            onClick={() => setPickedLabels((prev) => prev.filter((_, j) => j !== i))}
                            className="text-[10px] px-1 rounded"
                            style={{ background: 'var(--bg-secondary)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
                            title="Remove"
                          >×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[9px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                    When the picked count matches your grid/level count, the run uses Pre-fill mode automatically — labels are taken from this list verbatim.
                  </p>
                </div>
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

            {referenceImageUrl.trim() && !CONCEPT_VISION_MODELS.has(modelId) && (
              <div className="text-xs px-3 py-2 rounded-lg" style={{
                background: 'rgba(234,179,8,0.08)',
                border: '1px solid rgba(234,179,8,0.3)',
                color: 'var(--accent-yellow)',
              }}>
                Your AI Model can&apos;t see the reference image. Switch to a Claude 4.x, GPT-4o, or Gemini 2.x model so the concepts match your reference&apos;s style.
              </div>
            )}
            {referenceImageUrl.trim() && CONCEPT_VISION_MODELS.has(modelId) && (
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Reference image will guide the visual style of all 5 concepts.
              </p>
            )}

            {format === 'free-form' && (
              <button className="btn-primary w-full flex items-center justify-center gap-2" onClick={generateConcepts} disabled={generating || !title.trim()}>
                {generating ? (
                  <>
                    <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                    Generating...
                  </>
                ) : 'Generate Concepts'}
              </button>
            )}
            {(format === 'topic-card-grid' || format === 'n-levels') && (
              <p className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                Format-specific controls and the <strong>Generate thumbnail</strong> button are in the right panel.
              </p>
            )}
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="flex-1 min-w-0">
          {format === 'topic-card-grid' && (
            <TopicCardGridPanel
              title={title}
              niche={niche}
              script={script}
              description={description}
              modelId={modelId}
              referenceImageUrl={referenceImageUrl}
              onResultChange={setFormatResult}
              restoredResult={formatResult}
              pickedLabels={pickedLabels}
            />
          )}
          {format === 'n-levels' && (
            <NLevelsPanel
              title={title}
              niche={niche}
              script={script}
              description={description}
              modelId={modelId}
              referenceImageUrl={referenceImageUrl}
              onResultChange={setNLevelsResult}
              restoredResult={nLevelsResult}
              pickedLabels={pickedLabels}
            />
          )}
          {format === 'free-form' && (
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
                          <a href={downloadHref(generatedImages[idx], `thumbnail-${idx + 1}.png`)} download={`thumbnail-${idx + 1}.png`} target="_blank" rel="noopener noreferrer"
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
          )}
        </div>
      </div>

      <HistoryPanel
        title="Thumbnail History"
        icon="🎨"
        items={historyItems.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          label: e.videoTitle || e.title,
          sublabel: `${e.niche} · ${e.conceptsCount} concepts · Best: ${e.bestConceptName} (${e.bestScore}/100)`,
        }))}
        onRestore={(id) => {
          const entry = historyItems.find(e => e.id === id);
          if (!entry) return;
          if ((result || formatResult) && typeof window !== 'undefined' &&
              !confirm('Replace current thumbnail with this restored entry?')) {
            return;
          }
          setTitle(entry.title);
          setNiche(entry.niche);
          if (entry.modelId) setModelId(entry.modelId);
          if (entry.script !== undefined) { setScript(entry.script); setShowScript(Boolean(entry.script)); }
          if (entry.description !== undefined) setDescription(entry.description);
          if (entry.imageModel) setImageModel(entry.imageModel);
          // Format entries hydrate the new panel; free-form entries hydrate
          // the original 5-concept layout. The two paths don't share state.
          if (entry.format === 'topic-card-grid' && entry.formatPayload && 'gridRows' in entry.formatPayload) {
            const fp = entry.formatPayload;
            setFormat('topic-card-grid');
            setImageGenEnabled(true);
            setShowImageSection(true);
            setReferenceImageUrl(fp.referenceImageUrl || '');
            setRefPreviewUrl(fp.referenceImageUrl || '');
            setFormatResult({
              imageUrl: fp.imageUrl,
              regions: fp.regions,
              cards: fp.cards,
              palette: fp.globalPalette,
              gridRows: fp.gridRows,
              gridCols: fp.gridCols,
              gridMode: fp.gridMode,
              mode: fp.mode,
              formatImageModel: fp.formatImageModel,
              referenceImageUrl: fp.referenceImageUrl,
              outputWidth: fp.outputWidth,
              outputHeight: fp.outputHeight,
            });
            setNLevelsResult(null);
            setSavedFormatImageUrl(fp.imageUrl);
            setSavedNLevelsImageUrl(null);
            setHistoryEntryId(entry.id);
            setResult(null);
            setGeneratedImages({});
            toast.success(`Restored Topic Card Grid — ${fp.gridRows}×${fp.gridCols} (${fp.cards.length} cards).`);
            return;
          }
          if (entry.format === 'n-levels' && entry.formatPayload && 'count' in entry.formatPayload) {
            const fp = entry.formatPayload;
            setFormat('n-levels');
            setImageGenEnabled(true);
            setShowImageSection(true);
            setReferenceImageUrl(fp.referenceImageUrl || '');
            setRefPreviewUrl(fp.referenceImageUrl || '');
            setNLevelsResult({
              imageUrl: fp.imageUrl,
              regions: fp.regions,
              levels: fp.levels,
              count: fp.count,
              titleTopic: fp.titleTopic,
              titleTagline: fp.titleTagline,
              mode: fp.mode,
              formatImageModel: fp.formatImageModel,
              referenceImageUrl: fp.referenceImageUrl,
              outputWidth: fp.outputWidth,
              outputHeight: fp.outputHeight,
            });
            setFormatResult(null);
            setSavedNLevelsImageUrl(fp.imageUrl);
            setSavedFormatImageUrl(null);
            setHistoryEntryId(entry.id);
            setResult(null);
            setGeneratedImages({});
            toast.success(`Restored N Levels — ${fp.count} levels of ${fp.titleTopic}.`);
            return;
          }
          // Free-form path (existing behaviour).
          setFormat('free-form');
          setFormatResult(null);
          setNLevelsResult(null);
          setSavedFormatImageUrl(null);
          setSavedNLevelsImageUrl(null);
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
        onDelete={(id) => {
          setHistoryItems((prev) => prev.filter((e) => e.id !== id));
          deleteThumbnailEntry(id).catch(() => {});
        }}
        onClearAll={() => {
          setHistoryItems([]);
          clearThumbnailHistory().catch(() => {});
        }}
      />
    </div>
    </ScheduleLinkProvider>
  );
}
