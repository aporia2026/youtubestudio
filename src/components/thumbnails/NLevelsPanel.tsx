'use client';

/**
 * N Levels Explained format — UI component for the /thumbnails page.
 *
 * Mirrors the architecture of TopicCardGridPanel: two-step flow with
 * mandatory user review by default, plus Pre-fill and One-shot shortcut
 * modes. State A is an editable level table; State B is the rendered image
 * with deterministic region overlay (one region per slice).
 *
 * See `_plans/2026-05-19-thumbnail-format-topic-card-grid.md` for the
 * shared pipeline contract (this file follows it).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { downloadHref } from '@/lib/download-file';
import type { ThumbnailRegion } from '@/remotion/types';

// ─── Types mirroring the API contract ───────────────────────────────────────

export interface FormatLevel {
  level: number;
  label: string;
  illustration_concept: string;
  accent_color?: string;
}

export interface NLevelsGenerationResult {
  imageUrl: string;
  regions: ThumbnailRegion[];
  levels: FormatLevel[];
  count: number;
  titleTopic: string;
  titleTagline: string;
  mode: 'review' | 'pre-fill' | 'one-shot';
  formatImageModel: string;
  referenceImageUrl?: string;
  outputWidth: number;
  outputHeight: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const COUNT_PRESETS = [3, 5, 7, 10];

const IMAGE_MODELS = [
  { value: 'gpt-image-2-i2i', label: 'GPT Image 2 via Kie (recommended)' },
  { value: 'gpt-image-2-openai-i2i', label: 'GPT Image 2 via OpenAI (faster, emergency)' },
  { value: 'grok-imagine-i2i', label: 'Grok Imagine (image-to-image)' },
  { value: 'flux2-pro-i2i', label: 'Flux2 Pro (image-to-image)' },
  { value: 'flux2-flex-i2i', label: 'Flux2 Flex (image-to-image)' },
];

const REGION_OVERLAY_PREF_KEY = 'n_levels_region_overlay';
const IMAGE_MODEL_PREF_KEY = 'n_levels_default_image_model';

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  title: string;
  niche: string;
  script: string;
  description: string;
  modelId: string;
  referenceImageUrl: string;
  onResultChange: (result: NLevelsGenerationResult | null) => void;
  restoredResult?: NLevelsGenerationResult | null;
  /** Titles the user picked from the script textarea (page-level picker).
   *  When the count matches the level count, the next Step 1 run uses
   *  these as pre-fill labels verbatim. Empty = picker unused. */
  pickedLabels?: string[];
}

export function NLevelsPanel({
  title,
  niche,
  script,
  description,
  modelId,
  referenceImageUrl,
  onResultChange,
  restoredResult,
  pickedLabels = [],
}: Props) {
  // Level count
  const [count, setCount] = useState(7);
  const [titleTopic, setTitleTopic] = useState('');
  const [titleTagline, setTitleTagline] = useState('EXPLAINED');
  const [taglineEnabled, setTaglineEnabled] = useState(true);

  // Format mode
  const [formatMode, setFormatMode] = useState<'review' | 'pre-fill' | 'one-shot'>('review');
  const [prefilledLabels, setPrefilledLabels] = useState('');

  // Image model — defaults to gpt-image-2-i2i but auto-remembers the user's
  // last choice in localStorage so their personal default sticks.
  const [imageModelId, setImageModelId] = useState<string>(() => {
    if (typeof window === 'undefined') return 'gpt-image-2-i2i';
    try {
      const stored = localStorage.getItem(IMAGE_MODEL_PREF_KEY);
      if (stored && IMAGE_MODELS.some((m) => m.value === stored)) return stored;
    } catch {
      /* fall through */
    }
    return 'gpt-image-2-i2i';
  });
  useEffect(() => {
    try { localStorage.setItem(IMAGE_MODEL_PREF_KEY, imageModelId); } catch { /* ignore */ }
  }, [imageModelId]);

  // Flow state
  const [busyStep, setBusyStep] = useState<'idle' | 'list' | 'image'>('idle');
  const [levels, setLevels] = useState<FormatLevel[] | null>(null);
  const [refinedTopic, setRefinedTopic] = useState('');
  const [notesForImageModel, setNotesForImageModel] = useState<string | undefined>();
  const [result, setResult] = useState<NLevelsGenerationResult | null>(null);

  // Hydrate from history-restored result.
  useEffect(() => {
    if (!restoredResult) return;
    setCount(restoredResult.count);
    setTitleTopic(restoredResult.titleTopic);
    setTitleTagline(restoredResult.titleTagline);
    setTaglineEnabled(restoredResult.titleTagline.length > 0);
    setFormatMode(restoredResult.mode);
    setImageModelId(restoredResult.formatImageModel);
    setLevels(restoredResult.levels);
    setRefinedTopic(restoredResult.titleTopic);
    setResult(restoredResult);
  }, [restoredResult]);

  // Region overlay preference
  const [regionOverlayOn, setRegionOverlayOn] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(REGION_OVERLAY_PREF_KEY);
      if (stored === 'off') setRegionOverlayOn(false);
    } catch {
      /* default ON */
    }
  }, []);
  function toggleRegionOverlay() {
    const next = !regionOverlayOn;
    setRegionOverlayOn(next);
    try {
      localStorage.setItem(REGION_OVERLAY_PREF_KEY, next ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }

  // Pre-fill validation
  const prefilledLabelsList = prefilledLabels
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const canGenerateList =
    !!title.trim() &&
    !!niche.trim() &&
    !!titleTopic.trim() &&
    !!referenceImageUrl.trim() &&
    count >= 2 &&
    (formatMode !== 'pre-fill' || prefilledLabelsList.length === count);

  const levelListMismatch = levels && levels.length !== count;
  const canRenderImage = !!levels && !levelListMismatch && levels.every((l) => l.label.trim() && l.illustration_concept.trim());

  // ─── Actions ──────────────────────────────────────────────────────────────

  async function runStep1() {
    if (!canGenerateList) {
      if (!referenceImageUrl.trim()) {
        toast.error('Upload a reference image first — it locks the title typography for this format.');
      } else if (!titleTopic.trim()) {
        toast.error('Enter a title topic (the words after "[N] LEVELS OF") before generating.');
      } else if (formatMode === 'pre-fill' && prefilledLabelsList.length !== count) {
        toast.error(`Pre-fill mode needs exactly ${count} labels (one per line). You have ${prefilledLabelsList.length}.`);
      } else {
        toast.error('Title, niche, topic, and a reference image are required.');
      }
      return;
    }
    // Picked labels override the formatMode chip when their count matches
    // the level count — guarantees zero label paraphrasing.
    const usePicked = pickedLabels.length === count;
    const effectiveMode = usePicked ? 'pre-fill' : formatMode;
    const effectivePrefill = usePicked
      ? pickedLabels
      : (formatMode === 'pre-fill' ? prefilledLabelsList : undefined);

    console.info('[thumbnails format-n-levels list] requesting', {
      count, modelId, mode: effectiveMode, usingPickedLabels: usePicked,
    });
    setBusyStep('list');
    try {
      const res = await fetch('/api/thumbnails/format/n-levels/levels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          title: title.trim(),
          niche,
          script: script.trim() || undefined,
          description: description.trim() || undefined,
          count,
          titleTopic: titleTopic.trim(),
          titleTagline: taglineEnabled ? titleTagline.trim() : '',
          mode: effectiveMode,
          prefilledLabels: effectivePrefill,
          referenceImageUrl: referenceImageUrl.trim(),
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Level list generation failed (${res.status})`);
      }
      const data: { result: { levels: FormatLevel[]; title_topic: string; title_tagline: string; notes_for_image_model?: string } } = await res.json();
      console.info('[thumbnails format-n-levels list] received', { levelsCount: data.result.levels.length, refinedTopic: data.result.title_topic });
      setLevels(data.result.levels);
      setRefinedTopic(data.result.title_topic);
      setNotesForImageModel(data.result.notes_for_image_model);
      if (formatMode === 'one-shot') {
        await runStep2(data.result.levels, data.result.title_topic, data.result.title_tagline, data.result.notes_for_image_model);
        return;
      }
      toast.success(`Generated ${data.result.levels.length} level${data.result.levels.length === 1 ? '' : 's'} — review and edit before rendering.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Level list generation failed.');
    } finally {
      setBusyStep('idle');
    }
  }

  async function runStep2(
    levelsToUse: FormatLevel[] | null = levels,
    topicToUse: string = refinedTopic || titleTopic,
    taglineToUse: string = taglineEnabled ? titleTagline : '',
    notesToUse: string | undefined = notesForImageModel,
  ) {
    if (!levelsToUse) {
      toast.error('Generate the level list first.');
      return;
    }
    if (levelsToUse.length !== count) {
      toast.error(`Level count (${levelsToUse.length}) does not match (${count}). Adjust before rendering.`);
      return;
    }
    console.info('[thumbnails format-n-levels image] requesting', {
      count: levelsToUse.length,
      imageModelId,
    });
    setBusyStep('image');
    try {
      const res = await fetch('/api/thumbnails/format/n-levels/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageModelId,
          levels: levelsToUse,
          count,
          titleTopic: topicToUse,
          titleTagline: taglineToUse,
          notesForImageModel: notesToUse,
          referenceImageUrl: referenceImageUrl.trim(),
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Image generation failed (${res.status})`);
      }
      const data: {
        imageUrl: string;
        regions: ThumbnailRegion[];
        layout: { width: number; height: number };
      } = await res.json();
      console.info('[thumbnails format-n-levels image] received', {
        imageUrl: data.imageUrl,
        regionsCount: data.regions.length,
      });
      const generation: NLevelsGenerationResult = {
        imageUrl: data.imageUrl,
        regions: data.regions,
        levels: levelsToUse,
        count,
        titleTopic: topicToUse,
        titleTagline: taglineToUse,
        mode: formatMode,
        formatImageModel: imageModelId,
        referenceImageUrl: referenceImageUrl.trim() || undefined,
        outputWidth: data.layout.width,
        outputHeight: data.layout.height,
      };
      setResult(generation);
      onResultChange(generation);
      toast.success('Thumbnail generated!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Image generation failed.');
    } finally {
      setBusyStep('idle');
    }
  }

  function updateLevel(idx: number, patch: Partial<FormatLevel>) {
    setLevels((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function moveLevel(idx: number, dir: -1 | 1) {
    setLevels((prev) => {
      if (!prev) return prev;
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next.map((l, i) => ({ ...l, level: i + 1 }));
    });
  }

  function clearList() {
    if (levels && !confirm('Discard the current level list and regenerate?')) return;
    setLevels(null);
    setRefinedTopic('');
    setNotesForImageModel(undefined);
    setResult(null);
    onResultChange(null);
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-6" style={{ alignItems: 'flex-start' }}>
      {/* LEFT PANEL — format controls */}
      <div className="shrink-0" style={{ width: 380 }}>
        <div className="glass p-5 space-y-4" style={{ borderColor: 'rgba(124,58,237,0.2)' }}>
          {/* Count */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Number of levels
            </label>
            <div className="flex items-center gap-1.5">
              {COUNT_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className="text-[11px] px-2.5 py-1 rounded transition-all"
                  style={{
                    background: count === n ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                    border: `1px solid ${count === n ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
                    color: count === n ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                  }}
                >
                  {n}
                </button>
              ))}
              <input
                type="number"
                min={2}
                value={count}
                onChange={(e) => setCount(Math.max(2, Number(e.target.value) || 2))}
                className="input-field w-16 text-xs"
              />
            </div>
            {count > 10 && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--accent-yellow)' }}>
                Above 10 slices, each slice gets too thin to read clearly.
              </p>
            )}
          </div>

          {/* Title topic */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Title topic <span style={{ color: 'var(--text-muted)' }}>(the bit after &quot;{count} LEVELS OF&quot;)</span>
            </label>
            <input
              className="input-field w-full text-sm"
              placeholder="CYBER SECURITY BREACHES"
              value={titleTopic}
              onChange={(e) => setTitleTopic(e.target.value)}
              maxLength={60}
            />
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Bottom bar will read &quot;{count} LEVELS OF {titleTopic || '...'}{taglineEnabled && titleTagline ? ` [${titleTagline}]` : ''}&quot;.
            </p>
          </div>

          {/* Tagline */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={taglineEnabled}
                onChange={(e) => setTaglineEnabled(e.target.checked)}
                style={{ accentColor: 'var(--accent-pink)' }}
              />
              Tagline (red box below the topic)
            </label>
            {taglineEnabled && (
              <input
                className="input-field w-full text-xs mt-2"
                placeholder="EXPLAINED"
                value={titleTagline}
                onChange={(e) => setTitleTagline(e.target.value)}
                maxLength={30}
              />
            )}
          </div>

          {/* Image model */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Image Model
            </label>
            <select
              className="input-field w-full text-sm"
              value={imageModelId}
              onChange={(e) => setImageModelId(e.target.value)}
            >
              {IMAGE_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {imageModelId === 'gpt-image-2-openai-i2i' && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                OpenAI direct — synchronous, ~20–60s, no polling timeouts. Same GPT Image 2 model as the Kie path, different route.
              </p>
            )}
            {imageModelId !== 'gpt-image-2-i2i' && imageModelId !== 'gpt-image-2-openai-i2i' && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--accent-yellow)' }}>
                This format is calibrated for GPT Image 2. Other models will produce a different style and likely mangle the grunge typography.
              </p>
            )}
          </div>

          {/* Mode chips */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Flow
            </label>
            <div className="flex gap-1.5">
              {(['review', 'pre-fill', 'one-shot'] as const).map((m) => {
                const active = formatMode === m;
                const labelText = m === 'review' ? 'Review levels' : m === 'pre-fill' ? 'Pre-fill labels' : 'One-shot';
                return (
                  <button
                    key={m}
                    onClick={() => setFormatMode(m)}
                    className="text-[11px] px-2.5 py-1 rounded transition-all"
                    style={{
                      background: active ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                      border: `1px solid ${active ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`,
                      color: active ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                    }}
                  >
                    {labelText}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {formatMode === 'review' && 'Generate level list → review and edit → render image. Default.'}
              {formatMode === 'pre-fill' && 'You type the labels below; the LLM only fills in illustrations.'}
              {formatMode === 'one-shot' && 'Generate level list and image back-to-back without a review step.'}
            </p>
            {formatMode === 'review' && script.trim() && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Tip: if the LLM picks labels that paraphrase your script, switch to <strong>Pre-fill labels</strong> and type the exact stage names — the model will only fill in illustrations and leave your wording intact.
              </p>
            )}
          </div>

          {formatMode === 'pre-fill' && (
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Level labels — one per line, exactly {count}
              </label>
              <textarea
                className="input-field w-full text-xs"
                rows={Math.min(10, Math.max(4, count))}
                value={prefilledLabels}
                onChange={(e) => setPrefilledLabels(e.target.value)}
                placeholder={'PASSIVE RECONNAISSANCE\nACTIVE PROBING\nTHE FOOTHOLD\n…'}
              />
              <p className="text-[10px] mt-0.5" style={{ color: prefilledLabelsList.length === count ? 'var(--text-muted)' : 'var(--accent-yellow)' }}>
                {prefilledLabelsList.length} / {count} labels
              </p>
            </div>
          )}

          {/* Reference image requirement notice */}
          {!referenceImageUrl.trim() && (
            <div className="text-xs px-3 py-2 rounded-lg" style={{
              background: 'rgba(234,179,8,0.08)',
              border: '1px solid rgba(234,179,8,0.3)',
              color: 'var(--accent-yellow)',
            }}>
              A reference image is required — it locks the grunge title typography. Upload one above (in the Image Generation section).
            </div>
          )}
          {referenceImageUrl.trim() && (
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Reference image guides the slice layout, level typography, and grunge title styling.
            </p>
          )}

          {/* Primary CTA */}
          <button
            className="btn-primary w-full flex items-center justify-center gap-2"
            onClick={runStep1}
            disabled={!canGenerateList || busyStep !== 'idle'}
          >
            {busyStep === 'list' && (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Generating level list…
              </>
            )}
            {busyStep === 'image' && (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Rendering image…
              </>
            )}
            {busyStep === 'idle' && 'Generate thumbnail'}
          </button>
          {levels && (
            <button
              onClick={clearList}
              className="text-[11px] underline w-full text-center"
              style={{ color: 'var(--text-muted)' }}
            >
              Discard current level list
            </button>
          )}
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            ≈ $0.05–$0.11 per generation. Step 1 (level list) is &lt; $0.01; Step 2 (image) is the bulk.
          </p>
        </div>
      </div>

      {/* RIGHT PANEL — State A (editable levels) OR State B (result) */}
      <div className="flex-1 min-w-0">
        {!levels && !result && (
          <div className="glass p-12 text-center">
            <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              N Levels Explained
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Upload a reference image, set the level count and topic, and click <strong>Generate thumbnail</strong>.
            </p>
          </div>
        )}

        {levels && !result && (
          <LevelTableState
            levels={levels}
            totalCount={count}
            refinedTopic={refinedTopic}
            onTopicEdit={setRefinedTopic}
            mismatch={levelListMismatch ?? false}
            canRender={canRenderImage}
            busy={busyStep === 'image'}
            onUpdate={updateLevel}
            onMove={moveLevel}
            onRender={() => runStep2(levels, refinedTopic, taglineEnabled ? titleTagline : '')}
            onRegenerate={() => { setLevels(null); runStep1(); }}
          />
        )}

        {result && (
          <ResultState
            result={result}
            regionOverlayOn={regionOverlayOn}
            onToggleOverlay={toggleRegionOverlay}
            onEditList={() => setResult(null)}
            onRegenerateImage={() => runStep2()}
            busy={busyStep === 'image'}
          />
        )}
      </div>
    </div>
  );
}

// ─── State A subcomponent — editable level table ────────────────────────────

interface LevelTableProps {
  levels: FormatLevel[];
  totalCount: number;
  refinedTopic: string;
  onTopicEdit: (next: string) => void;
  mismatch: boolean;
  canRender: boolean;
  busy: boolean;
  onUpdate: (idx: number, patch: Partial<FormatLevel>) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onRender: () => void;
  onRegenerate: () => void;
}

function LevelTableState(props: LevelTableProps) {
  const { levels, totalCount, refinedTopic, onTopicEdit, mismatch, canRender, busy } = props;
  return (
    <div className="glass p-5 space-y-3" style={{ borderColor: 'rgba(124,58,237,0.2)' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
          Review levels
        </h3>
        <span
          className="text-xs px-2 py-0.5 rounded"
          style={{
            background: mismatch ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
            color: mismatch ? '#ef4444' : '#22c55e',
          }}
        >
          {levels.length} / {totalCount} levels
        </span>
      </div>

      {/* Refined topic editor */}
      <div>
        <label className="block text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
          Title topic (model refined; you can edit)
        </label>
        <input
          className="input-field w-full text-sm"
          value={refinedTopic}
          onChange={(e) => onTopicEdit(e.target.value)}
          maxLength={60}
        />
      </div>

      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {levels.map((level, i) => (
          <div
            key={i}
            className="p-2 rounded-lg space-y-1.5"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono w-8 text-right" style={{ color: 'var(--text-muted)' }}>
                L{level.level}
              </span>
              <input
                className="input-field flex-1 text-xs font-medium uppercase"
                placeholder="LEVEL LABEL"
                value={level.label}
                onChange={(e) => props.onUpdate(i, { label: e.target.value })}
                maxLength={60}
              />
              {level.accent_color ? (
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={level.accent_color}
                    onChange={(e) => props.onUpdate(i, { accent_color: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer"
                    style={{ border: '1px solid var(--border)', background: 'none' }}
                    title="Accent color"
                  />
                  <button
                    onClick={() => props.onUpdate(i, { accent_color: undefined })}
                    className="text-[9px] px-1 rounded"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                    title="Clear accent"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => props.onUpdate(i, { accent_color: '#7c3aed' })}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px dashed var(--border)' }}
                  title="Add an accent color hint for this slice"
                >
                  + color
                </button>
              )}
              <button
                onClick={() => props.onMove(i, -1)}
                disabled={i === 0}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: i === 0 ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid var(--border)', opacity: i === 0 ? 0.4 : 1 }}
                title="Move up (earlier level)"
              >
                ↑
              </button>
              <button
                onClick={() => props.onMove(i, 1)}
                disabled={i === levels.length - 1}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: i === levels.length - 1 ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid var(--border)', opacity: i === levels.length - 1 ? 0.4 : 1 }}
                title="Move down (later level)"
              >
                ↓
              </button>
            </div>
            <input
              className="input-field w-full text-xs"
              placeholder="Illustration concept — what does this slice show?"
              value={level.illustration_concept}
              onChange={(e) => props.onUpdate(i, { illustration_concept: e.target.value })}
              maxLength={250}
            />
          </div>
        ))}
      </div>

      {mismatch && (
        <div
          className="text-xs px-3 py-2 rounded-lg"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}
        >
          Level count ({levels.length}) does not match ({totalCount}). Adjust the count selector or regenerate.
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={props.onRender}
          disabled={!canRender || busy}
          className="btn-primary text-xs flex-1 flex items-center justify-center gap-1.5"
        >
          {busy ? (
            <>
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
              Rendering…
            </>
          ) : (
            'Render image'
          )}
        </button>
        <button
          onClick={props.onRegenerate}
          className="btn-secondary text-xs"
        >
          Regenerate list
        </button>
      </div>
    </div>
  );
}

// ─── State B subcomponent — result with region overlay ──────────────────────

interface ResultProps {
  result: NLevelsGenerationResult;
  regionOverlayOn: boolean;
  onToggleOverlay: () => void;
  onEditList: () => void;
  onRegenerateImage: () => void;
  busy: boolean;
}

function ResultState({ result, regionOverlayOn, onToggleOverlay, onEditList, onRegenerateImage, busy }: ResultProps) {
  return (
    <div className="glass p-5 space-y-3" style={{ borderColor: 'rgba(34,197,94,0.2)' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
          Generated thumbnail
        </h3>
        <label className="flex items-center gap-2 cursor-pointer text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={regionOverlayOn}
            onChange={onToggleOverlay}
            style={{ accentColor: 'var(--accent-purple-bright)' }}
          />
          Region overlay
        </label>
      </div>

      <div
        className="relative w-full rounded-lg overflow-hidden"
        style={{ border: '1px solid var(--border)', aspectRatio: `${result.outputWidth} / ${result.outputHeight}` }}
      >
        <img
          src={result.imageUrl}
          alt="Generated thumbnail"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        {regionOverlayOn && (
          <svg
            viewBox={`0 0 ${result.outputWidth} ${result.outputHeight}`}
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            {result.regions.map((r, i) => (
              <g key={r.id}>
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill="none"
                  stroke="rgba(124,58,237,0.85)"
                  strokeWidth={Math.max(2, result.outputWidth * 0.003)}
                  strokeDasharray={`${Math.max(6, result.outputWidth * 0.01)} ${Math.max(4, result.outputWidth * 0.006)}`}
                />
                <text
                  x={r.x + 8}
                  y={r.y + Math.max(20, result.outputWidth * 0.025)}
                  fill="rgba(124,58,237,1)"
                  fontSize={Math.max(14, result.outputWidth * 0.018)}
                  fontFamily="ui-monospace, monospace"
                >
                  L{i + 1}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {result.outputWidth}×{result.outputHeight} · {result.regions.length} slice region{result.regions.length === 1 ? '' : 's'} ready for production-doc · Title: &quot;{result.count} LEVELS OF {result.titleTopic}{result.titleTagline ? ` [${result.titleTagline}]` : ''}&quot;
      </p>

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { navigator.clipboard.writeText(result.imageUrl); toast.success('Image URL copied'); }}
          className="btn-secondary text-xs px-2 py-1"
        >
          Copy URL
        </button>
        <a
          href={downloadHref(result.imageUrl, `thumbnail-levels.png`)}
          download="thumbnail-levels.png"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary text-xs px-2 py-1 inline-flex items-center gap-1"
        >
          Download
        </a>
        <button
          onClick={() => {
            navigator.clipboard.writeText(JSON.stringify(result.regions, null, 2));
            toast.success('Regions JSON copied');
          }}
          className="btn-secondary text-xs px-2 py-1"
        >
          Copy regions JSON
        </button>
        <button onClick={onEditList} className="btn-secondary text-xs px-2 py-1">
          Edit levels
        </button>
        <button onClick={onRegenerateImage} disabled={busy} className="btn-secondary text-xs px-2 py-1">
          Regenerate image
        </button>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>
          Levels rendered ({result.levels.length})
        </summary>
        <div className="mt-2 space-y-1">
          {result.levels.map((l) => (
            <div key={l.level} className="flex gap-2" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-mono w-8 text-right" style={{ color: 'var(--text-muted)' }}>L{l.level}</span>
              <span className="font-medium uppercase">{l.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>— {l.illustration_concept}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
