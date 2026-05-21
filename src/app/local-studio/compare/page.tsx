'use client';

/**
 * /local-studio/compare — side-by-side comparison of the three local
 * image models (Flux schnell, Flux dev, Qwen-Image).
 *
 * Two comparison sets:
 *   1. "Doodle Explainer" — i2i with the doodle reference image at
 *      denoise 0.7, doodle_explainer style suffix appended to every
 *      prompt. This is the user's real production look — same setup as
 *      `scripts/style-spike.ts` (the cloud-Kie blind-rank spike), just
 *      with the local model set.
 *   2. "Unstyled" — raw t2i with no style suffix and no reference.
 *      Lets us see each model's baseline capability on generic
 *      YouTube-explainer prompts.
 *
 * Images are pre-rendered by the Python scripts in
 * `hiccup-analysis/compare_local_*.py` and copied into
 * `public/model-comparison/...` so Next can serve them statically. Manifest
 * + per-cell timings live in this file — re-running the smoke and copying
 * the new PNGs refreshes everything.
 */
import Link from 'next/link';
import { useState } from 'react';

interface PromptDef {
  slug: string;
  label: string;
  prompt: string;
}

interface ModelDef {
  id: 'flux-schnell' | 'flux-dev' | 'qwen-image' | 'hidream-i1';
  label: string;
  license: 'Apache 2.0' | 'Non-commercial' | 'Apache 2.0 (text encoder GGUF)' | 'MIT';
  hint: string;
}

interface CellTiming {
  /** Wall-clock seconds reported by the smoke runner. The first prompt
   *  per model includes the cold load + model swap and is always slow —
   *  surfaced separately so the user doesn't read it as a per-image cost. */
  seconds: number;
  cold: boolean;
}

interface ComparisonSet {
  id: 'doodle' | 'unstyled';
  label: string;
  description: string;
  pathPrefix: string;
  /** Reference image used during i2i chaining, when applicable. */
  referenceImage?: { src: string; label: string };
  /** Models surfaced as columns for this set. Doodle includes HiDream
   *  (verified working under i2i at denoise 0.7); unstyled doesn't —
   *  HiDream's t2i path is verified to hang on 16 GB. */
  models: ReadonlyArray<ModelDef>;
  prompts: ReadonlyArray<PromptDef>;
  timings: Readonly<Record<string, Record<string, CellTiming>>>;
}

const FLUX_SCHNELL: ModelDef = {
  id: 'flux-schnell',
  label: 'Flux schnell',
  license: 'Apache 2.0',
  hint: 'Speed king — 4 steps. Fastest by far.',
};
const FLUX_DEV: ModelDef = {
  id: 'flux-dev',
  label: 'Flux dev',
  license: 'Non-commercial',
  hint: 'Premium look. NC license — unsafe for monetized YouTube.',
};
const QWEN_IMAGE: ModelDef = {
  id: 'qwen-image',
  label: 'Qwen-Image',
  license: 'Apache 2.0 (text encoder GGUF)',
  hint: 'Best at typography + prompt-following under i2i chaining. Slowest.',
};
const HIDREAM_I1: ModelDef = {
  id: 'hidream-i1',
  label: 'HiDream-I1',
  license: 'MIT',
  hint: 'Premium 28 steps, MIT. i2i works on 16 GB (~75s warm); t2i still verified to hang.',
};

const DOODLE_SET: ComparisonSet = {
  id: 'doodle',
  label: 'Doodle Explainer style',
  description:
    'i2i with the doodle reference image at denoise 0.7, doodle_explainer ai_image_suffix appended. ' +
    'This mirrors the cloud blind-rank spike (see scripts/style-spike.ts) but on the free local stack.',
  pathPrefix: '/model-comparison/doodle',
  referenceImage: {
    src: '/style-refs/Doodle-explainer/stick-figure-magnifying-glass-phone.png',
    label: 'i2i reference (denoise 0.7)',
  },
  models: [FLUX_SCHNELL, FLUX_DEV, QWEN_IMAGE, HIDREAM_I1],
  prompts: [
    {
      slug: 'p01-character-emotion',
      label: 'Character study, emotion',
      prompt:
        'Close-up of a stick figure with a curious face gently pressing a small button labeled TEST, followed by a huge red warning burst exploding outward; figure leans back in alarm.',
    },
    {
      slug: 'p03-two-figures',
      label: 'Two figures, manipulation',
      prompt:
        "Two stick figures: one in a sneaky pose handing a fake paper message to the other who sits at an old computer; arrows lead from the message to the second figure's head.",
    },
    {
      slug: 'p04-wide-chaos',
      label: 'Wide chaos infographic',
      prompt:
        'Wide scene: a row of computer terminals bent over with smoke puffs and red overload symbols; a giant "$10 MILLION" cleanup bill rising in the center; an alarm bell ringing above a sleeping internet globe just waking up with wide eyes.',
    },
    {
      slug: 'p06-industrial',
      label: 'Industrial scene + cartoon worm',
      prompt:
        'A stick figure engineer in a hard hat watches industrial machines spin wildly out of control; a cartoon worm with a smug face slithers between them leaving sparkles; warning triangles everywhere; the lone engineer holds a tiny clipboard looking puzzled.',
    },
  ],
  // HiDream timings landed in a separate smoke run on 2026-05-22 — all 4
  // prompts completed cleanly (zero hangs), 65–85s warm. None marked cold
  // because HiDream wasn't part of the first sweep's first-prompt
  // chain-of-cold-loads; its first prompt here was warm-from-cache after
  // the doodle sequence above. See
  // `hiccup-analysis/compare_local_doodle_hidream.py`.
  timings: {
    'p01-character-emotion': {
      'flux-schnell': { seconds: 162, cold: true },
      'flux-dev':     { seconds: 222, cold: true },
      'qwen-image':   { seconds: 478, cold: true },
      'hidream-i1':   { seconds: 80,  cold: false },
    },
    'p03-two-figures': {
      'flux-schnell': { seconds: 15,  cold: false },
      'flux-dev':     { seconds: 45,  cold: false },
      'qwen-image':   { seconds: 174, cold: false },
      'hidream-i1':   { seconds: 70,  cold: false },
    },
    'p04-wide-chaos': {
      'flux-schnell': { seconds: 15,  cold: false },
      'flux-dev':     { seconds: 45,  cold: false },
      'qwen-image':   { seconds: 174, cold: false },
      'hidream-i1':   { seconds: 65,  cold: false },
    },
    'p06-industrial': {
      'flux-schnell': { seconds: 15,  cold: false },
      'flux-dev':     { seconds: 45,  cold: false },
      'qwen-image':   { seconds: 174, cold: false },
      'hidream-i1':   { seconds: 85,  cold: false },
    },
  },
};

const UNSTYLED_SET: ComparisonSet = {
  id: 'unstyled',
  label: 'Unstyled (raw model capability)',
  description:
    't2i with no style suffix or reference. Useful for judging each model on its own terms before any chaining.',
  pathPrefix: '/model-comparison',
  // HiDream omitted here — its t2i path is verified to hang at KSampler
  // on 16 GB (see hiccup-analysis/hidream_q5_0004.log). The i2i path
  // works fine on the same hardware; included in the doodle set above.
  models: [FLUX_SCHNELL, FLUX_DEV, QWEN_IMAGE],
  prompts: [
    {
      slug: 'person-explainer',
      label: 'Person explainer',
      prompt: 'a young woman in a turtleneck explaining something to camera, neutral background, soft lighting, medium close-up',
    },
    {
      slug: 'cityscape',
      label: 'Tokyo cityscape',
      prompt: 'aerial wide shot of Tokyo at dusk, neon reflections on wet pavement, atmospheric',
    },
    {
      slug: 'object-concept',
      label: 'Vintage typewriter',
      prompt: 'a vintage typewriter on a wooden desk surrounded by crumpled paper, dramatic side light, shallow depth of field',
    },
    {
      slug: 'in-image-text',
      label: 'In-image text',
      prompt: 'a vintage poster that says BREAKING NEWS in bold block letters, mid-century print style, faded paper texture',
    },
  ],
  timings: {
    'person-explainer': {
      'flux-schnell': { seconds: 162, cold: true },
      'flux-dev':     { seconds: 225, cold: true },
      'qwen-image':   { seconds: 475, cold: true },
    },
    cityscape: {
      'flux-schnell': { seconds: 21,  cold: false },
      'flux-dev':     { seconds: 99,  cold: false },
      'qwen-image':   { seconds: 174, cold: false },
    },
    'object-concept': {
      'flux-schnell': { seconds: 21,  cold: false },
      'flux-dev':     { seconds: 45,  cold: false },
      'qwen-image':   { seconds: 174, cold: false },
    },
    'in-image-text': {
      'flux-schnell': { seconds: 18,  cold: false },
      'flux-dev':     { seconds: 45,  cold: false },
      'qwen-image':   { seconds: 174, cold: false },
    },
  },
};

const SETS: ReadonlyArray<ComparisonSet> = [DOODLE_SET, UNSTYLED_SET];

function imagePath(set: ComparisonSet, promptSlug: string, modelId: string): string {
  return `${set.pathPrefix}/${promptSlug}__${modelId}.png`;
}

export default function ModelComparePage() {
  const [activeSetId, setActiveSetId] = useState<ComparisonSet['id']>('doodle');
  // Focused image overlay — clicking any thumbnail pops the full-size
  // version. ESC / backdrop click closes. Cheap modal pattern — no
  // headless-ui dep required.
  const [focused, setFocused] = useState<{ src: string; caption: string } | null>(null);

  const activeSet = SETS.find(s => s.id === activeSetId) ?? DOODLE_SET;

  return (
    <div className="min-h-screen p-6" style={{ background: 'var(--background, #0a0a0a)', color: 'var(--text, #e5e5e5)' }}>
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <Link href="/local-studio" className="text-sm" style={{ color: 'var(--text-muted, #9ca3af)' }}>
            ← Local Studio
          </Link>
        </div>
        <h1 className="mt-1 text-2xl font-semibold">Model comparison</h1>
        <p className="mt-1 max-w-2xl text-sm" style={{ color: 'var(--text-muted, #9ca3af)' }}>
          Side-by-side outputs from the three local image models. Generated at 1920×1080 on 16 GB VRAM.
          Click any thumbnail to view full size.
        </p>
      </header>

      <div className="mb-4 flex items-center gap-1 rounded-lg p-1" style={{ background: 'rgba(255,255,255,0.04)', width: 'fit-content' }}>
        {SETS.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => setActiveSetId(s.id)}
            className="px-3 py-1.5 rounded text-sm font-medium transition-colors"
            style={{
              background: activeSetId === s.id ? 'rgba(99,102,241,0.20)' : 'transparent',
              color: activeSetId === s.id ? '#a5b4fc' : 'var(--text-muted, #9ca3af)',
              border: activeSetId === s.id ? '1px solid rgba(99,102,241,0.45)' : '1px solid transparent',
              cursor: 'pointer',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="mb-4 max-w-2xl text-xs" style={{ color: 'var(--text-muted, #9ca3af)' }}>
        {activeSet.description}
      </p>

      {activeSet.referenceImage && (
        <section className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted, #9ca3af)' }}>
            {activeSet.referenceImage.label}
          </h2>
          <button
            type="button"
            onClick={() => setFocused({ src: activeSet.referenceImage!.src, caption: activeSet.referenceImage!.label })}
            className="block overflow-hidden rounded"
            style={{
              maxWidth: 240,
              background: '#fff',
              border: '1px solid var(--border, rgba(255,255,255,0.10))',
              cursor: 'zoom-in',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeSet.referenceImage.src}
              alt={activeSet.referenceImage.label}
              style={{ display: 'block', width: '100%', height: 'auto' }}
            />
          </button>
        </section>
      )}

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted, #9ca3af)' }}>
          Outputs
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full border-separate" style={{ borderSpacing: '0 8px' }}>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="text-left text-xs font-medium uppercase tracking-wide pr-3 py-2 align-bottom"
                  style={{ color: 'var(--text-muted, #9ca3af)', width: 220 }}
                >
                  Prompt
                </th>
                {activeSet.models.map(m => (
                  <th
                    key={m.id}
                    scope="col"
                    className="text-left text-xs font-medium uppercase tracking-wide px-2 py-2 align-bottom"
                    style={{ color: 'var(--text-muted, #9ca3af)' }}
                  >
                    <div className="font-semibold" style={{ color: 'var(--text, #e5e5e5)' }}>
                      {m.label}
                    </div>
                    <div className="mt-0.5 normal-case">
                      <span title={m.hint}>{m.license}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeSet.prompts.map(p => (
                <tr key={p.slug}>
                  <th
                    scope="row"
                    className="text-left align-top pr-3 py-2"
                    style={{ verticalAlign: 'top' }}
                  >
                    <div className="font-medium text-sm">{p.label}</div>
                    <div className="mt-1 text-xs" style={{ color: 'var(--text-muted, #9ca3af)' }}>
                      {p.prompt}
                    </div>
                  </th>
                  {activeSet.models.map(m => {
                    const timing = activeSet.timings[p.slug]?.[m.id];
                    const src = imagePath(activeSet, p.slug, m.id);
                    return (
                      <td key={m.id} className="align-top px-2 py-2" style={{ verticalAlign: 'top' }}>
                        <button
                          type="button"
                          onClick={() => setFocused({ src, caption: `${m.label} — ${p.label}` })}
                          className="block w-full overflow-hidden rounded"
                          style={{
                            background: '#0a0a0a',
                            border: '1px solid var(--border, rgba(255,255,255,0.10))',
                            cursor: 'zoom-in',
                          }}
                          title="Click to view full size"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={src}
                            alt={`${m.label} — ${p.label}`}
                            style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '16 / 9', objectFit: 'cover' }}
                            loading="lazy"
                          />
                        </button>
                        {timing && (
                          <div className="mt-1 text-[0.65rem]" style={{ color: 'var(--text-muted, #9ca3af)' }}>
                            {timing.seconds}s {timing.cold ? '(cold load)' : '(warm)'}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 rounded-lg p-4" style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.30)' }}>
        <h3 className="text-sm font-semibold mb-2">Recommended default for batch generation</h3>
        <ul className="list-disc pl-5 text-sm space-y-1">
          <li>
            <strong>For doodle / styled docs:</strong> Qwen-Image stays the safest default — at denoise 0.7
            it consistently follows the scene prompt (TEST button, alarm signals, prompt-specific details)
            while keeping the doodle style. Flux schnell + Flux dev anchor too hard to the reference and
            barely respond to the prompt.
          </li>
          <li>
            <strong>HiDream-I1 is now a real option for styled docs.</strong> Earlier verdict was wrong —
            i2i at denoise 0.7 works cleanly on 16 GB (~75s warm, faster than Qwen). Its outputs are more
            sketched / hand-drawn than Qwen&apos;s — closer to the actual reference style, less digital.
            Trade-off: less prompt-following than Qwen, garbles in-image text. Pick HiDream for pure
            visual feel; pick Qwen when the prompt has specific scene elements that must land.
          </li>
          <li>
            <strong>For unstyled / fast iteration:</strong> Flux schnell. Quality is good enough for
            most non-text scenes, and ~20 s warm vs 174 s warm matters at batch scale. HiDream isn&apos;t
            usable here — its t2i path still hangs at KSampler on 16 GB.
          </li>
          <li>
            <strong>Auto-override on baked-text rows:</strong> when{' '}
            <code>on_screen_text_mode === &apos;bake&apos;</code> AND the OST is non-empty, switch to
            Qwen-Image regardless of the doc default. Flux schnell + HiDream both garble glyphs.
          </li>
          <li>
            <strong>Per-row override:</strong> the existing model picker in production-doc rows still wins
            for power-user cases.
          </li>
          <li>
            <strong>Skip Flux dev as default</strong> — non-commercial license infects every chained shot
            for monetized YouTube.
          </li>
        </ul>
        <p className="mt-3 text-xs" style={{ color: 'var(--text-muted, #9ca3af)' }}>
          Re-run the comparisons via{' '}
          <code>python hiccup-analysis/compare_local_doodle_style.py</code>,{' '}
          <code>python hiccup-analysis/compare_local_doodle_hidream.py</code>, or{' '}
          <code>python hiccup-analysis/compare_local_image_models.py</code>, then the new PNGs land
          under <code>public/model-comparison/...</code> automatically.
        </p>
      </section>

      {focused && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Full-size comparison image"
          onClick={() => setFocused(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setFocused(null); }}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.85)', cursor: 'zoom-out' }}
        >
          <div
            className="max-h-full max-w-full"
            onClick={(e) => e.stopPropagation()}
            style={{ cursor: 'default' }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={focused.src}
              alt="Full size"
              style={{ display: 'block', maxHeight: '85vh', maxWidth: '95vw', objectFit: 'contain' }}
            />
            <div className="mt-2 text-center text-xs" style={{ color: 'var(--text-muted, #9ca3af)' }}>
              {focused.caption}
              {' · '}
              <button
                type="button"
                onClick={() => setFocused(null)}
                className="underline"
                style={{ color: 'var(--text-muted, #9ca3af)' }}
              >
                close (Esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
