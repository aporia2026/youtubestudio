'use client';

/**
 * Doodle Explainer thumbnail format panel.
 *
 * Two-step flow:
 *   1. User fills hook + expression + background, clicks "Generate".
 *   2. Panel calls /api/thumbnails/format/doodle-explainer/concepts to get
 *      N distinct concepts from the LLM, then /api/thumbnails/format/
 *      doodle-explainer/image to fan out N parallel image generations.
 *   3. VariantPicker shows the N variants; user picks one.
 *
 * Architecture parallel to TopicCardGridPanel + NLevelsPanel but
 * deliberately simpler — no free-form mode, no post-processing
 * pipeline, no reference image. The doodle style is fully baked into
 * the prompt suffix so the surface area stays minimal.
 *
 * Plan: _plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { downloadHref } from '@/lib/download-file';
import { VariantPicker } from '@/components/thumbnails/VariantPicker';
import {
  resolveThumbnailStyle,
  DEFAULT_THUMBNAIL_STYLE_ID,
  type ThumbnailStyle,
} from '@/lib/thumbnail-styles';
import {
  buildVariant,
  clampVariantCount,
  DEFAULT_VARIANT_COUNT,
  MAX_VARIANT_COUNT,
  MIN_VARIANT_COUNT,
  type ThumbnailVariant,
} from '@/lib/thumbnail-variants';
import {
  HOOK_TEXT_MAX_LENGTH as HOOK_MAX,
  CUSTOM_BACKGROUND_MAX_LENGTH as BG_MAX,
} from '@/lib/thumbnail-formats/doodle-explainer-prompts';

interface DoodleConceptFromApi {
  conceptLabel: string;
  compositionHint: string;
  variation_axes: {
    label_axis: string;
    palette_axis: string;
    composition_axis: string;
  };
}

export interface DoodleExplainerGenerationResult {
  hookText: string;
  characterExpression: string;
  backgroundScene: string;
  customBackground?: string;
  styleId: string;
  imageModel: string;
  concepts: DoodleConceptFromApi[];
  variants: ThumbnailVariant[];
  selectedVariantIndex: number;
}

/** Kie t2i image models supported by the format's image route. Keep
 *  in sync with `KIE_T2I_MODELS` in
 *  `src/app/api/thumbnails/format/doodle-explainer/image/route.ts`. */
const IMAGE_MODELS = [
  { value: 'gpt-image-2-t2i', label: 'Kie GPT Image 2 (recommended)' },
  { value: 'nano-banana', label: 'NanoBanana 2 (Gemini 3.1 Flash Image)' },
  { value: 'grok-imagine-t2i', label: 'Grok Imagine' },
  { value: 'flux2-pro-t2i', label: 'Flux2 Pro' },
  { value: 'flux2-flex-t2i', label: 'Flux2 Flex' },
  { value: 'ideogram-v3-quality-t2i', label: 'Ideogram v3 Quality (best text rendering)' },
  { value: 'ideogram-v3-balanced-t2i', label: 'Ideogram v3 Balanced' },
  { value: 'ideogram-v3-turbo-t2i', label: 'Ideogram v3 Turbo' },
];

/** Mid-edit form snapshot persisted into the workflow draft system,
 *  alongside the sibling formats' draft buckets. Lets a resume-from-
 *  drafts flow restore the panel's form inputs without re-typing.
 *  Phase 4 of the variants rollout (2026-06-10). */
export interface DoodleExplainerDraftState {
  hookText?: string;
  characterExpression?: string;
  backgroundScene?: string;
  customBackground?: string;
  imageModel?: string;
  variantCount?: number;
}

interface Props {
  /** LLM model id used for the concepts step. Reuses the page's `modelId`
   *  selector so the user picks one model for all panels. */
  modelId: string;
  /** Video title, niche, script, description — fed as `videoContext` to
   *  the LLM so concepts pick supporting props aligned with the video. */
  title: string;
  niche: string;
  script: string;
  description: string;
  /** Fires whenever the panel produces a new result OR the user
   *  selects a different variant. The page funnels this into the
   *  thumbnail history entry. */
  onResultChange: (result: DoodleExplainerGenerationResult | null) => void;
  /** When set, the panel restores its state from a prior history entry. */
  restoredResult?: DoodleExplainerGenerationResult | null;
  /** Fires whenever the panel's form state changes — fed into the
   *  workflow draft system so a refresh / draft resume restores the
   *  in-progress inputs. */
  onDraftStateChange?: (state: DoodleExplainerDraftState) => void;
  /** One-shot hydration payload from the workflow draft. Restores form
   *  inputs on mount. */
  restoredDraftState?: DoodleExplainerDraftState | null;
}

export function DoodleExplainerPanel({
  modelId,
  title,
  niche,
  script,
  description,
  onResultChange,
  restoredResult,
  onDraftStateChange,
  restoredDraftState,
}: Props) {
  const style = useMemo<ThumbnailStyle>(() => {
    const resolved = resolveThumbnailStyle(DEFAULT_THUMBNAIL_STYLE_ID);
    if (!resolved) {
      throw new Error(`Default thumbnail style "${DEFAULT_THUMBNAIL_STYLE_ID}" missing from registry`);
    }
    return resolved;
  }, []);

  const expressionOptions = style.supported_character_expressions ?? [];
  const backgroundOptions = style.supported_background_scenes ?? [];

  // Form state. Persisted to localStorage so a refresh mid-edit keeps
  // the user's in-progress hook + scene choices — same pattern as the
  // sibling panels' draft-snapshot persistence (lighter-weight here
  // because the form is tiny).
  const [hookText, setHookText] = useState<string>(() => loadPersisted('doodle_hook_text', ''));
  const [characterExpression, setCharacterExpression] = useState<string>(() =>
    loadPersisted('doodle_character_expression', expressionOptions[0] ?? 'worried')
  );
  const [backgroundScene, setBackgroundScene] = useState<string>(() =>
    loadPersisted('doodle_background_scene', backgroundOptions[0]?.id ?? 'plain-white')
  );
  const [customBackground, setCustomBackground] = useState<string>(() => loadPersisted('doodle_custom_background', ''));
  const [imageModel, setImageModel] = useState<string>(() => loadPersisted('doodle_image_model', style.preferred_image_model));
  const [variantCount, setVariantCount] = useState<number>(() => {
    const stored = loadPersisted('doodle_variant_count', '');
    const n = Number(stored);
    return Number.isFinite(n) && n > 0 ? clampVariantCount(n) : DEFAULT_VARIANT_COUNT;
  });

  useEffect(() => { persist('doodle_hook_text', hookText); }, [hookText]);
  useEffect(() => { persist('doodle_character_expression', characterExpression); }, [characterExpression]);
  useEffect(() => { persist('doodle_background_scene', backgroundScene); }, [backgroundScene]);
  useEffect(() => { persist('doodle_custom_background', customBackground); }, [customBackground]);
  useEffect(() => { persist('doodle_image_model', imageModel); }, [imageModel]);
  useEffect(() => { persist('doodle_variant_count', String(variantCount)); }, [variantCount]);

  // Restore form state from the workflow draft on mount. Runs after the
  // localStorage init above; draft values override when present so the
  // resume-from-draft flow wins over cross-tab localStorage.
  useEffect(() => {
    if (!restoredDraftState) return;
    if (typeof restoredDraftState.hookText === 'string') setHookText(restoredDraftState.hookText);
    if (typeof restoredDraftState.characterExpression === 'string') setCharacterExpression(restoredDraftState.characterExpression);
    if (typeof restoredDraftState.backgroundScene === 'string') setBackgroundScene(restoredDraftState.backgroundScene);
    if (typeof restoredDraftState.customBackground === 'string') setCustomBackground(restoredDraftState.customBackground);
    if (typeof restoredDraftState.imageModel === 'string') setImageModel(restoredDraftState.imageModel);
    if (typeof restoredDraftState.variantCount === 'number') setVariantCount(clampVariantCount(restoredDraftState.variantCount));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot hydration; ignore subsequent changes
  }, []);

  // Emit draft-state changes upstream so the page can fold them into
  // the workflow draft auto-save effect. Fires on every form-input
  // change; debounce is handled by the parent's setTimeout-based
  // saver.
  useEffect(() => {
    if (!onDraftStateChange) return;
    onDraftStateChange({
      hookText: hookText || undefined,
      characterExpression: characterExpression || undefined,
      backgroundScene: backgroundScene || undefined,
      customBackground: customBackground || undefined,
      imageModel: imageModel || undefined,
      variantCount,
    });
  }, [hookText, characterExpression, backgroundScene, customBackground, imageModel, variantCount, onDraftStateChange]);

  // Generation + result state.
  const [generatingStep, setGeneratingStep] = useState<'idle' | 'concepts' | 'images'>('idle');
  const [concepts, setConcepts] = useState<DoodleConceptFromApi[]>([]);
  const [variants, setVariants] = useState<ThumbnailVariant[]>([]);
  const [selectedVariantIndex, setSelectedVariantIndex] = useState(0);
  const [regeneratingSlotIndex, setRegeneratingSlotIndex] = useState<number | null>(null);

  // Restore from history when the page hands us a prior result.
  useEffect(() => {
    if (!restoredResult) return;
    setHookText(restoredResult.hookText);
    setCharacterExpression(restoredResult.characterExpression);
    setBackgroundScene(restoredResult.backgroundScene);
    setCustomBackground(restoredResult.customBackground ?? '');
    setImageModel(restoredResult.imageModel);
    setConcepts(restoredResult.concepts);
    setVariants(restoredResult.variants);
    setSelectedVariantIndex(restoredResult.selectedVariantIndex);
  }, [restoredResult]);

  // Whenever the user has a non-empty result, emit it upstream so the
  // page can persist to history and the schedule/post flow can read it.
  useEffect(() => {
    if (variants.length === 0) {
      onResultChange(null);
      return;
    }
    onResultChange({
      hookText,
      characterExpression,
      backgroundScene,
      customBackground: backgroundScene === 'custom' ? customBackground : undefined,
      styleId: style.id,
      imageModel,
      concepts,
      variants,
      selectedVariantIndex,
    });
    // We intentionally don't include the form fields in the deps — only
    // re-emit when the actual generated artefact changes. Editing the
    // form before regenerating shouldn't churn the upstream history
    // entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, selectedVariantIndex, concepts]);

  const canGenerate = hookText.trim().length > 0
    && hookText.trim().length <= HOOK_MAX
    && (backgroundScene !== 'custom' || customBackground.trim().length > 0)
    && generatingStep === 'idle';

  const buildVideoContext = () => {
    const parts = [title, niche, script, description]
      .map(s => (s || '').trim())
      .filter(s => s.length > 0);
    return parts.length ? parts.join('\n\n').slice(0, 2000) : undefined;
  };

  async function handleGenerate() {
    if (!canGenerate) return;
    const safeVariantCount = clampVariantCount(variantCount);
    setGeneratingStep('concepts');
    setConcepts([]);
    setVariants([]);
    console.info('[doodle-panel generate] start', {
      modelId, imageModel, variantCount: safeVariantCount, hookText: hookText.trim(), characterExpression, backgroundScene,
    });
    try {
      // Step 1 — concepts.
      const conceptsRes = await fetch('/api/thumbnails/format/doodle-explainer/concepts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          styleId: style.id,
          hookText: hookText.trim(),
          characterExpression,
          backgroundScene,
          customBackground: backgroundScene === 'custom' ? customBackground.trim() : undefined,
          videoContext: buildVideoContext(),
          variantCount: safeVariantCount,
        }),
      });
      if (!conceptsRes.ok) {
        const errBody = await conceptsRes.json().catch(() => ({ error: 'concepts call failed' }));
        throw new Error(errBody?.error || `concepts HTTP ${conceptsRes.status}`);
      }
      const conceptsData = await conceptsRes.json() as { concepts: DoodleConceptFromApi[] };
      setConcepts(conceptsData.concepts);
      console.info('[doodle-panel generate] concepts ok', {
        count: conceptsData.concepts.length,
        labels: conceptsData.concepts.map(c => c.conceptLabel),
      });

      // Step 2 — fan-out image generation.
      setGeneratingStep('images');
      const imageRes = await fetch('/api/thumbnails/format/doodle-explainer/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageModel,
          styleId: style.id,
          hookText: hookText.trim(),
          characterExpression,
          backgroundScene,
          customBackground: backgroundScene === 'custom' ? customBackground.trim() : undefined,
          concepts: conceptsData.concepts,
          variantCount: safeVariantCount,
        }),
      });
      if (!imageRes.ok) {
        const errBody = await imageRes.json().catch(() => ({ error: 'image call failed' }));
        throw new Error(errBody?.error || `image HTTP ${imageRes.status}`);
      }
      const imageData = await imageRes.json() as { variants: ThumbnailVariant[]; failedCount: number };
      setVariants(imageData.variants);
      const firstGood = imageData.variants.findIndex(v => v.imageUrl);
      setSelectedVariantIndex(firstGood >= 0 ? firstGood : 0);
      console.info('[doodle-panel generate] images ok', {
        count: imageData.variants.length, failedCount: imageData.failedCount,
      });
      if (imageData.failedCount > 0) {
        toast.warning(`${safeVariantCount - imageData.failedCount} of ${safeVariantCount} variants generated — retry the failed slot to fill in the third.`);
      } else {
        toast.success(`${safeVariantCount} doodle variants generated — pick one.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[doodle-panel generate] failed', { message });
      toast.error(`Generation failed: ${message}`);
    } finally {
      setGeneratingStep('idle');
    }
  }

  async function handleRegenerateSlot(variantIdx: number) {
    if (!concepts[variantIdx]) {
      toast.error('No concept available for this slot — regenerate the whole set first.');
      return;
    }
    setRegeneratingSlotIndex(variantIdx);
    console.info('[doodle-panel regenerate-slot] start', { variantIdx });
    try {
      // Re-fan-out a single variant by sending a 1-concept payload. The
      // image route's `concepts` validator requires concepts.length ===
      // variantCount, so we pass variantCount=1 alongside.
      const imageRes = await fetch('/api/thumbnails/format/doodle-explainer/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageModel,
          styleId: style.id,
          hookText: hookText.trim(),
          characterExpression,
          backgroundScene,
          customBackground: backgroundScene === 'custom' ? customBackground.trim() : undefined,
          concepts: [concepts[variantIdx]],
          variantCount: 1,
        }),
      });
      if (!imageRes.ok) {
        const errBody = await imageRes.json().catch(() => ({ error: 'image call failed' }));
        throw new Error(errBody?.error || `image HTTP ${imageRes.status}`);
      }
      const imageData = await imageRes.json() as { variants: ThumbnailVariant[] };
      const newVariant = imageData.variants[0];
      if (!newVariant?.imageUrl) {
        throw new Error('regenerated slot returned no image');
      }
      setVariants(prev => {
        const next = prev.slice();
        // Keep the original variant id so React keys stay stable.
        next[variantIdx] = buildVariant({
          index: variantIdx,
          imageUrl: newVariant.imageUrl,
          promptUsed: newVariant.promptUsed,
          conceptLabel: newVariant.conceptLabel,
        });
        return next;
      });
      // If the previously-selected slot had failed and the new one
      // succeeded, auto-select it.
      if (!variants[selectedVariantIndex]?.imageUrl) {
        setSelectedVariantIndex(variantIdx);
      }
      toast.success('Variant regenerated');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[doodle-panel regenerate-slot] failed', { message });
      toast.error(`Regeneration failed: ${message}`);
    } finally {
      setRegeneratingSlotIndex(null);
    }
  }

  function handleSelectVariant(idx: number) {
    if (!variants[idx]?.imageUrl) return;
    console.info('[doodle-panel select-variant]', { idx });
    setSelectedVariantIndex(idx);
  }

  const selectedVariant = variants[selectedVariantIndex];

  return (
    <div className="space-y-5">
      {/* Hook text */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Hook phrase
          <span className="ml-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {hookText.length}/{HOOK_MAX}
          </span>
        </label>
        <input
          className="input-field w-full text-sm"
          placeholder='e.g. "ROTTEN MEAT?" or "2 SLEEPS?" — the big yellow bold word'
          value={hookText}
          onChange={e => setHookText(e.target.value.slice(0, HOOK_MAX))}
          maxLength={HOOK_MAX}
        />
        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          This is the focal yellow phrase the image model renders verbatim. Short and provocative reads strongest at thumbnail size.
        </p>
      </div>

      {/* Character expression */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Character emotion
        </label>
        <div className="flex flex-wrap gap-1.5">
          {expressionOptions.map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => setCharacterExpression(opt)}
              className="text-[11px] px-2.5 py-1 rounded transition-all"
              style={{
                background: characterExpression === opt ? '#FBC02D' : 'transparent',
                color: characterExpression === opt ? '#000' : 'var(--text-secondary)',
                border: characterExpression === opt ? '1px solid #FBC02D' : '1px solid var(--border)',
                fontWeight: characterExpression === opt ? 600 : 400,
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      {/* Background scene */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Background scene
        </label>
        <div className="flex flex-wrap gap-1.5">
          {backgroundOptions.map(opt => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setBackgroundScene(opt.id)}
              className="text-[11px] px-2.5 py-1 rounded transition-all"
              style={{
                background: backgroundScene === opt.id ? '#FBC02D' : 'transparent',
                color: backgroundScene === opt.id ? '#000' : 'var(--text-secondary)',
                border: backgroundScene === opt.id ? '1px solid #FBC02D' : '1px solid var(--border)',
                fontWeight: backgroundScene === opt.id ? 600 : 400,
              }}
              title={opt.promptHint}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {backgroundScene === 'custom' && (
          <div className="mt-2">
            <textarea
              className="input-field w-full text-sm"
              rows={2}
              maxLength={BG_MAX}
              placeholder='e.g. "1980s arcade interior, neon glow on the walls"'
              value={customBackground}
              onChange={e => setCustomBackground(e.target.value.slice(0, BG_MAX))}
            />
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {customBackground.length}/{BG_MAX} chars. The doodle style is still enforced — this only sets the scene.
            </p>
          </div>
        )}
      </div>

      {/* Image model */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Image model
        </label>
        <select className="input-field w-full text-sm" value={imageModel} onChange={e => setImageModel(e.target.value)}>
          {IMAGE_MODELS.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Variant count */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Variants per generate
        </label>
        <div className="flex items-center gap-1.5">
          {Array.from({ length: MAX_VARIANT_COUNT - MIN_VARIANT_COUNT + 1 }, (_, i) => MIN_VARIANT_COUNT + i).map(n => (
            <button
              key={n}
              type="button"
              onClick={() => setVariantCount(n)}
              className="text-[11px] px-3 py-1 rounded transition-all"
              style={{
                background: variantCount === n ? '#FBC02D' : 'transparent',
                color: variantCount === n ? '#000' : 'var(--text-secondary)',
                border: variantCount === n ? '1px solid #FBC02D' : '1px solid var(--border)',
                fontWeight: variantCount === n ? 600 : 400,
              }}
            >
              {n}
            </button>
          ))}
          <span className="text-[10px] ml-2" style={{ color: 'var(--text-muted)' }}>
            {variantCount}× image cost per generate
          </span>
        </div>
      </div>

      {/* Generate button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-primary text-sm flex items-center gap-2"
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          {generatingStep === 'concepts' && (
            <>
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
              Generating concepts…
            </>
          )}
          {generatingStep === 'images' && (
            <>
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
              Rendering {variantCount} doodles…
            </>
          )}
          {generatingStep === 'idle' && `Generate ${clampVariantCount(variantCount)} doodle variants`}
        </button>
        {!hookText.trim() && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Type the hook phrase to enable.
          </span>
        )}
      </div>

      {/* Variants picker */}
      {variants.length > 0 && (
        <div className="pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          <VariantPicker
            variants={variants}
            selectedIndex={selectedVariantIndex}
            onSelect={handleSelectVariant}
            onRegenerate={handleRegenerateSlot}
            regeneratingIndex={regeneratingSlotIndex}
            heading="Pick your doodle thumbnail"
            subheading="Click a thumbnail to mark it as the one you want. Hover for the per-variant regenerate button."
          />
        </div>
      )}

      {/* Selected-variant actions (Copy URL, Download). "Set as YouTube
          Thumbnail" lives on the parent page where channel context is
          available. */}
      {selectedVariant?.imageUrl && (
        <div className="flex gap-2 flex-wrap pt-2" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => { navigator.clipboard.writeText(selectedVariant.imageUrl); toast.success('Image URL copied'); }}
            className="btn-secondary text-xs px-2 py-1"
          >
            Copy URL
          </button>
          <a
            href={downloadHref(selectedVariant.imageUrl, `doodle-thumbnail.png`)}
            download={`doodle-thumbnail.png`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-xs px-2 py-1 inline-flex items-center gap-1"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </a>
        </div>
      )}

      {/* Concept transparency — surfaces the variation_axes the LLM
          chose so the user understands why the 3 variants are
          different. Tucked behind a details/summary so it doesn't
          clutter the picker. */}
      {concepts.length > 0 && (
        <details>
          <summary className="text-[11px] cursor-pointer" style={{ color: 'var(--text-muted)' }}>
            See what made each variant different
          </summary>
          <div className="mt-2 space-y-2">
            {concepts.map((c, i) => (
              <div key={i} className="text-[10px] p-2 rounded" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>Variant {i + 1}: {c.conceptLabel}</div>
                <div style={{ color: 'var(--text-secondary)' }}>Label: {c.variation_axes.label_axis}</div>
                <div style={{ color: 'var(--text-secondary)' }}>Palette: {c.variation_axes.palette_axis}</div>
                <div style={{ color: 'var(--text-secondary)' }}>Composition: {c.variation_axes.composition_axis}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function loadPersisted(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// Re-exports for the page's history-restore code path.
export type { DoodleConceptFromApi };
