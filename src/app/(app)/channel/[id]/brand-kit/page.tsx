'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ChannelBrandKit } from '@/lib/channel-brand-kit';

const VOCABS: Array<{ value: '' | 'casual' | 'conversational' | 'professional' | 'technical'; label: string }> = [
  { value: '', label: '— unset —' },
  { value: 'casual', label: 'casual' },
  { value: 'conversational', label: 'conversational' },
  { value: 'professional', label: 'professional' },
  { value: 'technical', label: 'technical' },
];

const SENTENCE_LENGTHS: Array<{ value: '' | 'short' | 'medium' | 'long' | 'mixed'; label: string }> = [
  { value: '', label: '— unset —' },
  { value: 'short', label: 'short — punchy, mostly under 12 words' },
  { value: 'medium', label: 'medium — average 12–20 words' },
  { value: 'long', label: 'long — rolling, deliberate momentum' },
  { value: 'mixed', label: 'mixed — alternate short and long' },
];

export default function ChannelBrandKitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [channelName, setChannelName] = useState<string>('');

  // Form state — every field is a string for trivial form-handling. Arrays
  // are stored as newline-separated text and parsed on save.
  const [tone, setTone] = useState('');
  const [vocab, setVocab] = useState<'' | 'casual' | 'conversational' | 'professional' | 'technical'>('');
  const [sentenceLength, setSentenceLength] = useState<'' | 'short' | 'medium' | 'long' | 'mixed'>('');
  const [voiceExamples, setVoiceExamples] = useState('');
  const [bannedPhrases, setBannedPhrases] = useState('');
  const [requiredPhrases, setRequiredPhrases] = useState('');
  const [hookStyle, setHookStyle] = useState('');
  const [introTemplate, setIntroTemplate] = useState('');
  const [ctaTemplate, setCtaTemplate] = useState('');
  const [outroTemplate, setOutroTemplate] = useState('');
  const [topicsAvoid, setTopicsAvoid] = useState('');
  const [topicsEmphasize, setTopicsEmphasize] = useState('');
  const [brandKeywords, setBrandKeywords] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Fetch the channel name + the kit in parallel.
        const [chanRes, kitRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, read
          fetch('/api/channels'),
          // eslint-disable-next-line no-restricted-syntax -- GET, read
          fetch(`/api/channels/${id}/brand-kit`),
        ]);
        if (!cancelled) {
          if (chanRes.ok) {
            const data = await chanRes.json();
            const ch = (data.channels || []).find((c: { id: string }) => c.id === id);
            if (ch) setChannelName(ch.name);
          }
          if (!kitRes.ok) {
            const d = await kitRes.json().catch(() => ({}));
            throw new Error(d.error || 'Failed to load brand kit');
          }
          const { brand_kit } = (await kitRes.json()) as { brand_kit: ChannelBrandKit };
          setTone(brand_kit.tone ?? '');
          setVocab((brand_kit.vocabulary_level ?? '') as typeof vocab);
          setSentenceLength((brand_kit.sentence_length ?? '') as typeof sentenceLength);
          setVoiceExamples((brand_kit.voice_examples ?? []).join('\n'));
          setBannedPhrases((brand_kit.banned_phrases ?? []).join('\n'));
          setRequiredPhrases((brand_kit.required_phrases ?? []).join('\n'));
          setHookStyle(brand_kit.hook_style ?? '');
          setIntroTemplate(brand_kit.intro_template ?? '');
          setCtaTemplate(brand_kit.cta_template ?? '');
          setOutroTemplate(brand_kit.outro_template ?? '');
          setTopicsAvoid((brand_kit.topics_to_avoid ?? []).join('\n'));
          setTopicsEmphasize((brand_kit.topics_to_emphasize ?? []).join('\n'));
          setBrandKeywords((brand_kit.brand_keywords ?? []).join(', '));
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function splitLines(s: string): string[] {
    return s
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean);
  }
  function splitCommas(s: string): string[] {
    return s
      .split(/[,\n]+/)
      .map(line => line.trim())
      .filter(Boolean);
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Partial<ChannelBrandKit> = {
        v: 1,
        tone: tone.trim() || undefined,
        vocabulary_level: vocab || undefined,
        sentence_length: sentenceLength || undefined,
        voice_examples: splitLines(voiceExamples),
        banned_phrases: splitLines(bannedPhrases),
        required_phrases: splitLines(requiredPhrases),
        hook_style: hookStyle.trim() || undefined,
        intro_template: introTemplate.trim() || undefined,
        cta_template: ctaTemplate.trim() || undefined,
        outro_template: outroTemplate.trim() || undefined,
        topics_to_avoid: splitLines(topicsAvoid),
        topics_to_emphasize: splitLines(topicsEmphasize),
        brand_keywords: splitCommas(brandKeywords),
      };
      // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
      const res = await fetch(`/api/channels/${id}/brand-kit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Save failed');
      }
      setSavedAt(Date.now());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded && !error) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 920, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <Link
          href="/channel"
          style={{ fontSize: 13, color: 'var(--text-muted)', textDecoration: 'none' }}
          className="hover:underline"
        >
          ← All channels
        </Link>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', marginTop: 6 }}>
          Script brand kit{channelName ? ` — ${channelName}` : ''}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
          Voice, tone, and phrase guidance that auto-pipes into every script generation and QA pass when this channel is active.
        </p>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          Looking for fonts, colors, and logo? See the{' '}
          <Link href={`/channel/${id}/visual-brand-kit`} className="hover:underline" style={{ color: 'var(--text-secondary)' }}>
            visual brand kit
          </Link>{' '}
          (separate setting).
        </div>
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#ef4444',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={onSave} className="space-y-5">
        <Section title="Voice & tone">
          <Field
            label="Tone"
            hint='Free-text descriptor: "warm authority", "irreverent expert", "calm explainer"'
          >
            <input
              className="input-field"
              value={tone}
              onChange={e => setTone(e.target.value)}
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Field label="Vocabulary level">
              <select
                className="input-field"
                value={vocab}
                onChange={e => setVocab(e.target.value as typeof vocab)}
              >
                {VOCABS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sentence length">
              <select
                className="input-field"
                value={sentenceLength}
                onChange={e => setSentenceLength(e.target.value as typeof sentenceLength)}
              >
                {SENTENCE_LENGTHS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="Voice examples"
            hint="One per line. Sample sentences pulled from your strongest scripts. The AI will write IN this voice."
          >
            <textarea
              className="input-field"
              rows={5}
              value={voiceExamples}
              onChange={e => setVoiceExamples(e.target.value)}
            />
          </Field>
        </Section>

        <Section title="Phrases & topics">
          <Field
            label="Banned phrases"
            hint='One per line. Augments the global AI-cliché blocklist with phrases YOU want to avoid (e.g. "dive in", "buckle up").'
          >
            <textarea
              className="input-field"
              rows={4}
              value={bannedPhrases}
              onChange={e => setBannedPhrases(e.target.value)}
            />
          </Field>
          <Field
            label="Required phrases / callbacks"
            hint="One per line. Channel slogans, recurring catchphrases the AI should work in naturally."
          >
            <textarea
              className="input-field"
              rows={3}
              value={requiredPhrases}
              onChange={e => setRequiredPhrases(e.target.value)}
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Field label="Topics to avoid" hint="One per line.">
              <textarea
                className="input-field"
                rows={4}
                value={topicsAvoid}
                onChange={e => setTopicsAvoid(e.target.value)}
              />
            </Field>
            <Field label="Topics to emphasize" hint="One per line.">
              <textarea
                className="input-field"
                rows={4}
                value={topicsEmphasize}
                onChange={e => setTopicsEmphasize(e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Structure">
          <Field
            label="Hook recipe"
            hint='Free-text: "data-driven cold open with a surprising stat", "open mid-action".'
          >
            <input
              className="input-field"
              value={hookStyle}
              onChange={e => setHookStyle(e.target.value)}
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Field label="Intro pattern">
              <textarea
                className="input-field"
                rows={3}
                value={introTemplate}
                onChange={e => setIntroTemplate(e.target.value)}
              />
            </Field>
            <Field label="Outro pattern">
              <textarea
                className="input-field"
                rows={3}
                value={outroTemplate}
                onChange={e => setOutroTemplate(e.target.value)}
              />
            </Field>
          </div>
          <Field label="CTA pattern" hint='Free-text: "subscribe + comment", "newsletter sign-up only".'>
            <textarea
              className="input-field"
              rows={2}
              value={ctaTemplate}
              onChange={e => setCtaTemplate(e.target.value)}
            />
          </Field>
        </Section>

        <Section title="SEO seeds">
          <Field
            label="Brand keywords"
            hint="Comma- or newline-separated. The AI works these in naturally — does not stuff."
          >
            <textarea
              className="input-field"
              rows={3}
              value={brandKeywords}
              onChange={e => setBrandKeywords(e.target.value)}
            />
          </Field>
        </Section>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 24 }}>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : 'Save brand kit'}
          </button>
          {savedAt && Date.now() - savedAt < 3000 && (
            <span style={{ fontSize: 13, color: '#10b981' }}>Saved ✓</span>
          )}
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: 20,
      }}
      className="space-y-4"
    >
      <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</h2>
      {children}
    </section>
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
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {hint && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 6,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
