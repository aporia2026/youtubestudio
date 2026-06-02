'use client';

/**
 * ShortNativeIdeasSurface — Phase 15.2 + 15.5.
 *
 * Hook-first idea generation tuned for the 60-second algorithm — each
 * idea opens with the literal hook line, not a topic title. Mounted in
 * two places:
 *   - /ideas?medium=short_native            (Ideas section, Shorts mode)
 *   - /shorts?tab=create                    (Create-from-scratch tab)
 *
 * Each idea card carries a "Generate this Short" button (Phase 15.5)
 * that takes the idea's hook + title + payoff + thesis and writes a
 * real `short_native` row via /api/shorts/generate-from-idea. The row
 * plugs into the voiceover + render pipeline unchanged. Optional style
 * picker (Minimal + Doodle) fires the same /generate-style-assets path
 * Mode C uses, so a from-scratch Short can ship a Doodle render on the
 * same click.
 */

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { ShortStylePicker } from '@/components/shorts/ShortStylePicker';
import { DEFAULT_SHORT_STYLE_ID, type ShortStyleId } from '@/lib/short-styles';

interface ShortIdea {
  hook: string;
  title: string;
  payoff: string;
  thesis: string;
  shotConcept: string;
  confidence: number;
}

export function ShortNativeIdeasSurface() {
  const [niche, setNiche] = useState('');
  const [context, setContext] = useState('');
  const [count, setCount] = useState(8);
  const [busy, setBusy] = useState(false);
  const [ideas, setIdeas] = useState<ShortIdea[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Phase 15.5 — per-idea Generate state + style picker.
  const [styleId, setStyleId] = useState<ShortStyleId>(DEFAULT_SHORT_STYLE_ID);
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);

  const generate = useCallback(async () => {
    if (!niche.trim()) {
      setError('Pick a niche first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/shorts/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: niche.trim(),
          context: context.trim() || undefined,
          count,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setIdeas(data.ideas || []);
      if ((data.ideas || []).length === 0) toast.info('Got an empty response — try again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate Shorts ideas');
    } finally {
      setBusy(false);
    }
  }, [niche, context, count]);

  function copyAll(idea: ShortIdea) {
    const text = `Hook: ${idea.hook}\nTitle: ${idea.title}\nPayoff: ${idea.payoff}\n\nThesis: ${idea.thesis}\nShot: ${idea.shotConcept}`;
    navigator.clipboard.writeText(text).then(
      () => toast.success('Idea copied'),
      () => toast.error('Could not copy'),
    );
  }

  /** Phase 15.5 — write the idea into a real short_native row, then
   *  (if a non-minimal style was picked) fire the style asset pipeline. */
  const generateShort = useCallback(
    async (idea: ShortIdea, idx: number) => {
      const key = `${idx}-${idea.hook.slice(0, 30)}`;
      setGeneratingKey(key);
      try {
        const res = await fetch('/api/shorts/generate-from-idea', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            niche: niche.trim(),
            hook: idea.hook,
            payoff: idea.payoff,
            ideaTitle: idea.title,
            thesis: idea.thesis || undefined,
            shotConcept: idea.shotConcept || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const newShortId = data.id as string | undefined;
        if (!newShortId) {
          toast.success('Short generated — open the inbox to voice it.');
          return;
        }
        if (styleId === 'minimal_gradient_v1') {
          toast.success('Short generated — open the inbox to voice it.');
          return;
        }
        // Non-minimal style: kick off the asset pipeline. ~30-120s.
        try {
          const styleRes = await fetch(
            `/api/shorts/${encodeURIComponent(newShortId)}/generate-style-assets`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                style_id: styleId,
                niche: niche.trim(),
              }),
            },
          );
          const styleData = await styleRes.json();
          if (!styleRes.ok) {
            toast.warning(
              `Short generated, but style assets failed: ${styleData.error ?? 'unknown'}. Retry from the inbox.`,
            );
          } else {
            const cost = styleData.estimated_cost_usd as number | undefined;
            toast.success(
              `Short generated + ${styleId} assets ready${typeof cost === 'number' ? ` (~$${cost.toFixed(2)})` : ''}. Voice it from the inbox.`,
            );
          }
        } catch (styleErr) {
          toast.warning(
            `Short generated, but style asset call failed: ${styleErr instanceof Error ? styleErr.message : 'unknown'}. Retry from the inbox.`,
          );
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to generate the Short');
      } finally {
        setGeneratingKey(null);
      }
    },
    [niche, styleId],
  );

  return (
    <section
      style={{
        marginTop: 16,
        padding: 20,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        maxWidth: 920,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
        Hook-first Shorts ideas
      </h2>
      <p style={{ marginTop: 6, marginBottom: 0, fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
        Every idea opens with the literal first-3-seconds line — what you would actually say,
        not a topic title.
      </p>

      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>Niche</span>
          <input
            type="text"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="e.g. AI tools for solopreneurs"
            className="input-field"
            style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.2)', color: 'inherit', border: '1px solid rgba(255,255,255,0.1)' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>How many</span>
          <input
            type="number"
            min={3}
            max={15}
            value={count}
            onChange={(e) => setCount(Math.max(3, Math.min(15, Number(e.target.value) || 8)))}
            className="input-field"
            style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.2)', color: 'inherit', border: '1px solid rgba(255,255,255,0.1)' }}
          />
        </label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>Context (optional)</span>
        <textarea
          rows={2}
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Voice notes, recent themes, audience tone…"
          style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.2)', color: 'inherit', border: '1px solid rgba(255,255,255,0.1)', resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }}
        />
      </label>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={generate}
          disabled={busy || !niche.trim()}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            cursor: busy ? 'wait' : !niche.trim() ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            fontSize: 13,
            background: busy ? 'rgba(124,58,237,0.5)' : 'rgba(124,58,237,0.95)',
            color: '#fff',
            opacity: !niche.trim() ? 0.6 : 1,
          }}
        >
          {busy ? 'Generating…' : 'Generate ideas'}
        </button>
        {error && (
          <span style={{ fontSize: 12, color: '#fca5a5' }}>{error}</span>
        )}
      </div>

      {ideas.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))', marginBottom: 6 }}>
            Style for the Shorts you generate below. Doodle adds ~30-90s of Atlas time per Short.
          </div>
          <ShortStylePicker
            value={styleId}
            onChange={setStyleId}
            disabled={generatingKey !== null}
          />
        </div>
      )}

      {ideas.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {ideas.map((idea, idx) => (
            <article
              key={idx}
              style={{
                padding: 14,
                borderRadius: 12,
                background: 'rgba(0,0,0,0.18)',
                border: '1px solid rgba(255,255,255,0.08)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <header style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'rgba(124,58,237,0.18)',
                    color: '#c4b5fd',
                    fontWeight: 600,
                  }}
                >
                  #{idx + 1} • {(idea.confidence * 100).toFixed(0)} conf
                </span>
                <span style={{ marginLeft: 'auto', fontWeight: 500, color: 'var(--text-primary, #fff)' }}>
                  {idea.title}
                </span>
              </header>
              <div style={{ fontSize: 14, lineHeight: 1.5 }}>
                <strong style={{ color: '#fbbf24' }}>{idea.hook}</strong>
                <div style={{ marginTop: 6, color: 'var(--text-secondary, rgba(255,255,255,0.75))' }}>
                  {idea.payoff}
                </div>
              </div>
              {(idea.thesis || idea.shotConcept) && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.55))', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {idea.thesis && <div><em>Proves:</em> {idea.thesis}</div>}
                  {idea.shotConcept && <div><em>Shot:</em> {idea.shotConcept}</div>}
                </div>
              )}
              <footer style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => copyAll(idea)}
                  style={{
                    padding: '5px 11px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: 'transparent',
                    color: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Copy idea
                </button>
                <button
                  type="button"
                  onClick={() => generateShort(idea, idx)}
                  disabled={generatingKey !== null}
                  style={{
                    padding: '5px 11px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'rgba(124,58,237,0.95)',
                    color: '#fff',
                    cursor: generatingKey !== null ? 'wait' : 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {generatingKey === `${idx}-${idea.hook.slice(0, 30)}`
                    ? 'Generating…'
                    : 'Generate this Short →'}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
