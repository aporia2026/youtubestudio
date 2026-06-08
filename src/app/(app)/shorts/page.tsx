'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  TARGET_DURATION_SECONDS_DEFAULT,
  type ShortRow,
  type ShortSeoResult,
} from '@/lib/shorts-types';
import { downloadHref } from '@/lib/download-file';
import { ShortsInboxPanel } from '@/components/shorts/ShortsInboxPanel';
import { ShortNativeIdeasSurface } from '@/components/shorts/ShortNativeIdeasSurface';

interface ProjectListItem {
  id: string;
  title: string;
  niche: string | null;
}

interface ScriptListItem {
  id: string;
  version: number;
  word_count: number;
  is_active: boolean;
}

interface ElevenVoice {
  voice_id: string;
  name: string;
}

/** Reads `?tab=` from the URL. Three tabs (Phase 15.5):
 *   - 'create'   — from-scratch idea-to-Short generator (Phase 15.5)
 *   - 'extract'  — long-form script → Short extractor (legacy default)
 *   - 'inbox'    — global pending-candidates inbox (Phase 15.1)
 *  Centralised so the tab strip + branches agree. */
type ShortsTab = 'create' | 'extract' | 'inbox';
function parseTab(raw: string | null | undefined): ShortsTab {
  if (raw === 'create') return 'create';
  if (raw === 'inbox') return 'inbox';
  return 'extract';
}

export default function ShortsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <ShortsPageInner />
    </Suspense>
  );
}

function ShortsPageInner() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = parseTab(search?.get('tab'));
  const setTab = (next: ShortsTab) => {
    const params = new URLSearchParams(search?.toString() ?? '');
    if (next === 'extract') params.delete('tab');
    else params.set('tab', next);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [scripts, setScripts] = useState<ScriptListItem[]>([]);
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [shorts, setShorts] = useState<ShortRow[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [targetSeconds, setTargetSeconds] = useState(TARGET_DURATION_SECONDS_DEFAULT);
  const [tone, setTone] = useState('');

  const [extracting, setExtracting] = useState(false);
  const [voiceoverBusy, setVoiceoverBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // "Optimize an existing Short's SEO" form — independent of the extractor
  // above. The source-video picker reuses the already-loaded `projects`.
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');
  const [seoLength, setSeoLength] = useState(45);
  const [seoSourceVideoId, setSeoSourceVideoId] = useState('');
  const [seoBusy, setSeoBusy] = useState(false);

  // Initial load — projects, voices, existing shorts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [projRes, voiceRes, shortsRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, loads projects
          fetch('/api/projects?limit=100'),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads ElevenLabs voices
          fetch('/api/elevenlabs/voices'),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads shorts
          fetch('/api/shorts?limit=50'),
        ]);
        if (cancelled) return;
        if (projRes.ok) setProjects((await projRes.json()).projects || []);
        if (voiceRes.ok) setVoices((await voiceRes.json()).voices || []);
        if (shortsRes.ok) setShorts((await shortsRes.json()).shorts || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Scripts when project changes.
  useEffect(() => {
    if (!selectedProjectId) {
      setScripts([]);
      setSelectedScriptId('');
      return;
    }
    let cancelled = false;
    // eslint-disable-next-line no-restricted-syntax -- GET .then, loads scripts
    fetch(`/api/projects/${selectedProjectId}/scripts`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (cancelled) return;
        const list: ScriptListItem[] = d.scripts || [];
        setScripts(list);
        const active = list.find(s => s.is_active) || list[0];
        if (active) setSelectedScriptId(active.id);
      })
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load scripts'));
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  async function refreshShorts() {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, reloads shorts list
      const res = await fetch('/api/shorts?limit=50');
      if (res.ok) setShorts((await res.json()).shorts || []);
    } catch {
      /* ignore */
    }
  }

  async function extractShort() {
    if (!selectedScriptId) {
      setError('Pick a script first.');
      return;
    }
    setError(null);
    setExtracting(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST that returns new short — RPC
      const res = await fetch(`/api/scripts/${selectedScriptId}/short`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetSeconds,
          tone: tone.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      await refreshShorts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Extraction failed');
    } finally {
      setExtracting(false);
    }
  }

  async function optimizeShortSeo() {
    if (!seoTitle.trim() || !seoDescription.trim()) {
      setError('Enter the title and description of your Short first.');
      return;
    }
    setError(null);
    setSeoBusy(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- shorts-seo RPC: awaits and uses response
      const res = await fetch('/api/shorts/seo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: seoTitle.trim(),
          description: seoDescription.trim(),
          lengthSeconds: seoLength,
          sourceVideoId: seoSourceVideoId || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      await refreshShorts();
      // The optimized Short is now at the top of "Your Shorts" with its
      // graded options. Clear the text fields so the form is ready for the
      // next one; keep length + source video as likely-reused defaults.
      setSeoTitle('');
      setSeoDescription('');
      toast.success('SEO options ready — see your Short below.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Optimization failed');
    } finally {
      setSeoBusy(false);
    }
  }

  async function generateVoiceover(shortId: string, voiceId: string) {
    if (!voiceId) {
      setError('Pick a voice first.');
      return;
    }
    setError(null);
    setVoiceoverBusy(prev => new Set(prev).add(shortId));
    try {
      // eslint-disable-next-line no-restricted-syntax -- voiceover-gen RPC: awaits and uses response
      const res = await fetch(`/api/shorts/${shortId}/voiceover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      await refreshShorts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Voiceover failed');
    } finally {
      setVoiceoverBusy(prev => {
        const next = new Set(prev);
        next.delete(shortId);
        return next;
      });
    }
  }

  async function deleteShort(shortId: string) {
    if (!confirm('Delete this Short?')) return;
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE for short — RPC
      const res = await fetch(`/api/shorts/${shortId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshShorts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const selectedScript = scripts.find(s => s.id === selectedScriptId);
  const projectVoiceId = useMemo(() => voices[0]?.voice_id ?? '', [voices]);

  // Shared tab strip — appears at the top of every tab so the user can
  // switch from anywhere. Pulled into a const so the extract + inbox
  // branches stay in sync. The "Bulk batch" link routes to
  // /shorts/batch — the multi-step generate-and-upload workflow added
  // by `_plans/2026-06-08-shorts-bulk-batch-youtube-upload.md`.
  const tabStrip = (
    <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <Link
        href="/shorts/batch"
        style={{
          padding: '6px 12px',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 500,
          background: 'rgba(16,185,129,0.15)',
          color: '#10b981',
          border: '1px solid rgba(16,185,129,0.4)',
          textDecoration: 'none',
        }}
      >
        Bulk batch →
      </Link>
      <div
        role="tablist"
        style={{
          display: 'inline-flex',
          gap: 4,
          padding: 4,
          borderRadius: 12,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {(['create', 'extract', 'inbox'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: 'none',
              cursor: tab === t ? 'default' : 'pointer',
              fontSize: 13,
              fontWeight: tab === t ? 600 : 500,
              background: tab === t ? 'rgba(124,58,237,0.9)' : 'transparent',
              color: tab === t ? '#fff' : 'var(--text-secondary, rgba(255,255,255,0.7))',
            }}
          >
            {t === 'create' ? 'Create' : t === 'extract' ? 'Extract' : 'Inbox'}
          </button>
        ))}
      </div>
    </div>
  );

  // Create early return — Phase 15.5 from-scratch Short generation.
  // Reuses the Ideas surface (niche → graded ideas → "Generate this
  // Short →" per card) so the entry point is identical to the one on
  // /ideas?medium=short_native; this tab is the lazy-user shortcut for
  // "I just want a Short, period."
  if (tab === 'create') {
    return (
      <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
        <div className="mb-6" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div>
            <h1 className="text-2xl font-bold gradient-text">Shorts</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Type a niche, get hook-first idea cards, click "Generate this Short" on the one you like.
              No video upload, no long-form script needed.
            </p>
          </div>
          {tabStrip}
        </div>
        <ShortNativeIdeasSurface />
      </div>
    );
  }

  // Inbox early return — keeps the existing extract UI below untouched.
  if (tab === 'inbox') {
    return (
      <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
        <div className="mb-6" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div>
            <h1 className="text-2xl font-bold gradient-text">Shorts</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Pending Short candidates across every project in this workspace.
            </p>
          </div>
          {tabStrip}
        </div>
        <ShortsInboxPanel mediumFilter="all" />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div className="mb-6" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div>
          <h1 className="text-2xl font-bold gradient-text">Shorts</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Extract a 30-90 second vertical Short from any long-form script. The AI picks the
            sharpest insight, formats it for the 9:16 algorithm, and gives you back a
            speakable script with [VISUAL] cues.
          </p>
        </div>
        {tabStrip}
      </div>

      {error && (
        <div
          className="text-sm px-4 py-3 rounded-lg mb-4"
          style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#ef4444',
          }}
        >
          {error}
        </div>
      )}

      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 18,
          marginBottom: 18,
        }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
          Extract a new Short
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Project">
            <select
              className="input-field"
              value={selectedProjectId}
              onChange={e => setSelectedProjectId(e.target.value)}
            >
              <option value="">Choose a project</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Script version">
            <select
              className="input-field"
              value={selectedScriptId}
              onChange={e => setSelectedScriptId(e.target.value)}
              disabled={!selectedProjectId}
            >
              <option value="">
                {selectedProjectId
                  ? scripts.length === 0
                    ? 'No scripts in this project'
                    : 'Choose a version'
                  : 'Pick a project first'}
              </option>
              {scripts.map(s => (
                <option key={s.id} value={s.id}>
                  v{s.version}
                  {s.is_active ? ' (active)' : ''} — {s.word_count.toLocaleString()} words
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16, marginTop: 14 }}>
          <Field label="Target duration (seconds)" hint="10–90s. The 2026 algorithm sweet spot is 30–60s.">
            <input
              type="number"
              min={10}
              max={90}
              className="input-field"
              value={targetSeconds}
              onChange={e => setTargetSeconds(Math.max(10, Math.min(90, Number(e.target.value) || 45)))}
            />
          </Field>
          <Field label="Tone override (optional)" hint={`Free-text: "irreverent expert", "calm explainer". Defaults to the project niche's default.`}>
            <input
              type="text"
              className="input-field"
              value={tone}
              onChange={e => setTone(e.target.value)}
              placeholder="(optional)"
            />
          </Field>
        </div>
        {selectedScript && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
            Source script: <strong>{selectedScript.word_count.toLocaleString()} words</strong>.
            Extracting ~{Math.round(targetSeconds * 2.33)} words for a {targetSeconds}-second Short.
          </p>
        )}
        <button
          type="button"
          onClick={extractShort}
          disabled={!selectedScriptId || extracting}
          className="btn-primary"
          style={{ marginTop: 14 }}
        >
          {extracting ? 'Extracting…' : '✂️ Extract Short'}
        </button>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.025 }}
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 18,
          marginBottom: 18,
        }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Optimize an existing Short&apos;s SEO
        </h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          Already made a Short? Paste its title, description, and length. The AI hands back a few
          graded options for a sharper title, description, and hashtags. Link the video it was cut
          from for keywords that match the parent.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
          <Field label="Short title">
            <input
              type="text"
              className="input-field"
              value={seoTitle}
              onChange={e => setSeoTitle(e.target.value)}
              placeholder="The title your Short currently has"
            />
          </Field>
          <Field label="Length (seconds)">
            <input
              type="number"
              min={1}
              max={600}
              className="input-field"
              value={seoLength}
              onChange={e => setSeoLength(Math.max(1, Math.min(600, Number(e.target.value) || 1)))}
            />
          </Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Field label="Short description">
            <textarea
              className="input-field"
              rows={3}
              value={seoDescription}
              onChange={e => setSeoDescription(e.target.value)}
              placeholder="The description your Short currently has"
            />
          </Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Field
            label="Source video (optional)"
            hint="The created video this Short was taken from — used as keyword context when set."
          >
            <select
              className="input-field"
              value={seoSourceVideoId}
              onChange={e => setSeoSourceVideoId(e.target.value)}
            >
              <option value="">No source video</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button
          type="button"
          onClick={optimizeShortSeo}
          disabled={seoBusy || !seoTitle.trim() || !seoDescription.trim()}
          className="btn-primary"
          style={{ marginTop: 14 }}
        >
          {seoBusy ? 'Optimizing…' : '✨ Optimize SEO'}
        </button>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 18,
        }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
          Your Shorts ({shorts.length})
        </h2>
        {shorts.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            No Shorts yet. Pick a script above and extract one.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {shorts.map(s =>
              s.kind === 'external_seo' ? (
                <ExternalSeoShortCard key={s.id} short={s} onDelete={deleteShort} />
              ) : (
                <ShortCard
                  key={s.id}
                  short={s}
                  voices={voices}
                  defaultVoiceId={projectVoiceId}
                  voiceoverBusy={voiceoverBusy.has(s.id)}
                  onGenerateVoiceover={generateVoiceover}
                  onDelete={deleteShort}
                />
              ),
            )}
          </div>
        )}
      </motion.section>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 16 }}>
        Need a long script first?{' '}
        <Link href="/generator" className="hover:underline">
          Generate one
        </Link>
        .
      </p>
    </div>
  );
}

/** Green ≥ 75, yellow ≥ 50, else red — mirrors the SEO Optimizer scale. */
function gradeColor(score: number): string {
  if (score >= 75) return 'var(--accent-green)';
  if (score >= 50) return 'var(--accent-yellow)';
  return '#ef4444';
}

function gradeBg(score: number): string {
  if (score >= 75) return 'rgba(16,185,129,0.15)';
  if (score >= 50) return 'rgba(245,158,11,0.15)';
  return 'rgba(239,68,68,0.15)';
}

function copyToClipboard(text: string, label: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(label))
    .catch(() => toast.error('Copy failed'));
}

/**
 * Card for an `external_seo` Short — one the user already made and ran
 * through the SEO optimizer. Shows the original details they entered plus
 * the AI's graded title / description / hashtag options, each copyable.
 * Deliberately omits the voiceover + render rows: there's no script to
 * speak or render for an externally-made Short.
 */
function ExternalSeoShortCard({
  short,
  onDelete,
}: {
  short: ShortRow;
  onDelete: (id: string) => void;
}) {
  const seo: ShortSeoResult | null = short.seo_result;
  const cardBorder = '1px solid rgba(255,255,255,0.08)';

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: cardBorder,
        borderRadius: 8,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="badge badge-purple text-xs">SEO</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {short.source_title || short.title || 'Untitled Short'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            ~{short.estimated_duration_seconds}s · {new Date(short.created_at).toLocaleString()}
          </div>
        </div>
        <button
          onClick={() => onDelete(short.id)}
          className="text-xs"
          style={{ color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          Delete
        </button>
      </div>

      {short.source_description && (
        <details>
          <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>
            Show the description you entered
          </summary>
          <pre
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
              fontFamily: 'inherit',
              background: 'rgba(0,0,0,0.2)',
              padding: 10,
              borderRadius: 6,
              marginTop: 6,
            }}
          >
            {short.source_description}
          </pre>
        </details>
      )}

      {!seo ? (
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No optimization saved for this Short.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {seo.primary_keyword && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Primary keyword:{' '}
              <strong style={{ color: 'var(--accent-purple-bright)' }}>{seo.primary_keyword}</strong>
            </div>
          )}

          <SeoOptionGroup
            heading="Title options"
            options={seo.titles}
            onCopy={text => copyToClipboard(text, 'Title copied')}
          />

          {seo.descriptions.length > 0 && (
            <SeoOptionGroup
              heading="Description options"
              options={seo.descriptions}
              onCopy={text => copyToClipboard(text, 'Description copied')}
              multiline
            />
          )}

          {seo.hashtag_sets.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Hashtag sets
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {seo.hashtag_sets.map((set, i) => {
                  const joined = set.tags.map(t => `#${t}`).join(' ');
                  return (
                    <div
                      key={i}
                      style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: '8px 10px' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span
                          className="text-xs font-semibold"
                          style={{
                            color: gradeColor(set.score),
                            background: gradeBg(set.score),
                            padding: '1px 8px',
                            borderRadius: 999,
                          }}
                        >
                          {set.score}/100
                        </span>
                        <button
                          onClick={() => copyToClipboard(joined, 'Hashtags copied')}
                          className="btn-secondary text-xs"
                          style={{ marginLeft: 'auto' }}
                        >
                          Copy
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {set.tags.map((t, j) => (
                          <span key={j} className="badge badge-purple text-xs">
                            #{t}
                          </span>
                        ))}
                      </div>
                      {set.rationale && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                          {set.rationale}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {seo.notes && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                borderLeft: '2px solid var(--accent-purple-bright)',
                paddingLeft: 10,
              }}
            >
              {seo.notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A graded list of title or description options with per-option copy. */
function SeoOptionGroup({
  heading,
  options,
  onCopy,
  multiline = false,
}: {
  heading: string;
  options: { text: string; score: number; rationale: string }[];
  onCopy: (text: string) => void;
  multiline?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
        {heading}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {options.map((opt, i) => (
          <div
            key={i}
            style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: '8px 10px' }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span
                className="text-xs font-semibold"
                style={{
                  color: gradeColor(opt.score),
                  background: gradeBg(opt.score),
                  padding: '1px 8px',
                  borderRadius: 999,
                  flexShrink: 0,
                }}
              >
                {opt.score}/100
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: 13,
                  color: 'var(--text-primary)',
                  whiteSpace: multiline ? 'pre-wrap' : 'normal',
                }}
              >
                {opt.text}
              </span>
              <button
                onClick={() => onCopy(opt.text)}
                className="btn-secondary text-xs"
                style={{ flexShrink: 0 }}
              >
                Copy
              </button>
            </div>
            {opt.rationale && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                {opt.rationale}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ShortCard({
  short,
  voices,
  defaultVoiceId,
  voiceoverBusy,
  onGenerateVoiceover,
  onDelete,
}: {
  short: ShortRow;
  voices: ElevenVoice[];
  defaultVoiceId: string;
  voiceoverBusy: boolean;
  onGenerateVoiceover: (id: string, voiceId: string) => void;
  onDelete: (id: string) => void;
}) {
  const [voiceId, setVoiceId] = useState(short.voiceover_voice_id || defaultVoiceId);

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
            {short.title || 'Untitled Short'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {short.word_count} words · ~{short.estimated_duration_seconds}s ·{' '}
            {new Date(short.created_at).toLocaleString()}
          </div>
        </div>
        <button
          onClick={() => onDelete(short.id)}
          className="text-xs"
          style={{
            color: '#ef4444',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Delete
        </button>
      </div>

      {short.hook && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-primary)',
            fontStyle: 'italic',
            padding: '8px 12px',
            background: 'rgba(124,58,237,0.06)',
            borderLeft: '2px solid #7c3aed',
            borderRadius: 4,
          }}
        >
          🎯 {short.hook}
        </div>
      )}

      <details>
        <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>
          Show full script
        </summary>
        <pre
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            background: 'rgba(0,0,0,0.2)',
            padding: 10,
            borderRadius: 6,
            marginTop: 6,
          }}
        >
          {short.short_script}
        </pre>
      </details>

      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          paddingTop: 8,
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {short.voiceover_audio_url ? (
          <>
            <audio
              src={short.voiceover_audio_url}
              controls
              preload="none"
              style={{ flex: 1, height: 32 }}
            />
            <a
              href={downloadHref(short.voiceover_audio_url, `short-${short.id.slice(0, 8)}-voiceover`)}
              download
              className="hover:underline"
              style={{ fontSize: 12, color: 'var(--text-secondary)' }}
            >
              ↓ Download
            </a>
            <button
              onClick={() => onGenerateVoiceover(short.id, voiceId)}
              disabled={voiceoverBusy}
              className="btn-secondary text-xs"
            >
              {voiceoverBusy ? 'Regenerating…' : 'Regenerate'}
            </button>
          </>
        ) : (
          <>
            <select
              value={voiceId}
              onChange={e => setVoiceId(e.target.value)}
              className="input-field"
              style={{ flex: 1, fontSize: 13 }}
            >
              <option value="">Choose a voice</option>
              {voices.map(v => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => onGenerateVoiceover(short.id, voiceId)}
              disabled={voiceoverBusy || !voiceId}
              className="btn-primary text-xs"
            >
              {voiceoverBusy ? 'Generating…' : '🎙️ Generate voiceover'}
            </button>
          </>
        )}
      </div>
      <ShortRenderRow short={short} />
    </div>
  );
}

/**
 * Self-contained render-MP4 row. Idle → POST /api/render/short → poll
 * GET until status flips. On success the rendered_video_url already
 * sits on the shorts row server-side, so a refresh of the parent list
 * is enough to persist; for now we render the player inline so the
 * user doesn't have to refresh.
 */
function ShortRenderRow({ short }: { short: ShortRow }) {
  const [renderId, setRenderId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>(
    short.rendered_video_url ? 'done' : 'idle',
  );
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(short.rendered_video_url);
  // Server-minted presigned R2 URL with `response-content-disposition`
  // baked in. Only set for renders that completed during THIS session
  // (the poll response carries it). Already-rendered shorts loaded from
  // `short.rendered_video_url` at mount fall through to the proxy path
  // below — fine because shorts are small enough that the 300s function
  // cap doesn't bite.
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll while rendering.
  useEffect(() => {
    if (status !== 'rendering' || !renderId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, polls render status
        const res = await fetch(`/api/render/short?renderId=${renderId}`, { cache: 'no-store' });
        if (!res.ok) {
          if (cancelled) return;
          window.setTimeout(tick, 4000);
          return;
        }
        const data = (await res.json()) as { status: string; progress: number; output_url: string | null; download_url: string | null; error: string | null };
        if (cancelled) return;
        setProgress(data.progress);
        if (data.status === 'done') {
          setStatus('done');
          setOutputUrl(data.output_url);
          setDownloadUrl(data.download_url);
        } else if (data.status === 'error') {
          setStatus('error');
          setError(data.error || 'Render failed');
        } else {
          window.setTimeout(tick, 4000);
        }
      } catch {
        if (cancelled) return;
        window.setTimeout(tick, 6000);
      }
    };
    window.setTimeout(tick, 2500);
    return () => {
      cancelled = true;
    };
  }, [status, renderId]);

  async function startRender() {
    setStatus('rendering');
    setProgress(0);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- render RPC: awaits and uses response (render id)
      const res = await fetch('/api/render/short', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortId: short.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setRenderId(data.renderId as string);
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to start render');
    }
  }

  if (!short.voiceover_audio_url) {
    return (
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        Generate a voiceover above to enable MP4 rendering.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      {status === 'done' && outputUrl ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <video src={outputUrl} controls style={{ width: 80, height: 142, borderRadius: 6, background: '#000' }} />
          <div style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
            <div>1080×1920 MP4 ready.</div>
            {downloadUrl ? (
              <a
                href={downloadUrl}
                rel="noopener"
                className="hover:underline"
                style={{ color: 'var(--text-primary)', fontSize: 11 }}
              >
                ↓ Download
              </a>
            ) : (
              <a
                href={downloadHref(outputUrl, `short-${short.id.slice(0, 8)}.mp4`)}
                download={`short-${short.id.slice(0, 8)}.mp4`}
                className="hover:underline"
                style={{ color: 'var(--text-primary)', fontSize: 11 }}
              >
                ↓ Download
              </a>
            )}
            <button
              type="button"
              onClick={startRender}
              className="ml-2 text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              ↻ Re-render
            </button>
          </div>
        </div>
      ) : status === 'rendering' ? (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            Rendering MP4… {Math.round(progress * 100)}%
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${progress * 100}%`, height: '100%', background: '#a78bfa', transition: 'width 0.3s' }} />
          </div>
        </div>
      ) : status === 'error' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#f87171', fontSize: 12 }}>⚠ {error}</span>
          <button onClick={startRender} className="btn-secondary text-xs">Retry</button>
        </div>
      ) : (
        <button
          onClick={startRender}
          className="btn-secondary text-xs"
          style={{ width: '100%' }}
          title="Render a 1080×1920 vertical MP4 with burned-in captions + your voiceover audio"
        >
          🎬 Render MP4 (1080×1920)
        </button>
      )}
    </div>
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
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
