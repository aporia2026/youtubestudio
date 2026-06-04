'use client';

/**
 * Static prototype of the redesigned Shorts editor — sticky-preview split
 * with a tabbed right rail. Mounts the REAL preview Player on the left so
 * the layout is judged against the user's actual Short, but the right
 * rail's content is descriptive placeholder copy: this prototype proves
 * the layout, not the controls.
 *
 * Plan: `_plans/2026-06-04-shorts-editor-redesign-split-tabs.md`.
 *
 * Layout (>= 1100px):
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Top bar  ·  Title  ·  saved-state  ·  [Render MP4 ▸]           │
 *   ├──────────────────────────┬─────────────────────────────────────┤
 *   │                          │ Script  Style  Captions  Voice  …   │
 *   │                          ├─────────────────────────────────────┤
 *   │   9:16 PREVIEW (sticky)  │                                     │
 *   │   ─ status chips ─       │   Active tab content (scrollable)   │
 *   │   ─ pipeline strip ─     │                                     │
 *   └──────────────────────────┴─────────────────────────────────────┘
 *
 * Below 1100px the layout stacks: preview sticks at the top with a
 * minimize toggle, tabs sit just below it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  SHORT_FPS,
  SHORT_HEIGHT,
  SHORT_WIDTH,
  type ShortVideoConfig,
} from '@/lib/shorts-render-types';
import type { ShortRow } from '@/lib/shorts-types';
import { buildShortVideoConfig } from '@/lib/shorts-render';
import { getStyleAssetStatus, styleAssetLabel } from '@/lib/shorts-asset-status';

const Player = dynamic(() => import('@remotion/player').then((m) => m.Player), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: '100%',
        aspectRatio: '9 / 16',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 12,
      }}
    />
  ),
}) as unknown as React.ComponentType<{
  component: unknown;
  inputProps: Record<string, unknown>;
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  durationInFrames: number;
  controls?: boolean;
  style?: React.CSSProperties;
}>;

const ShortVideo = dynamic(
  () => import('@/remotion/compositions/ShortVideo').then((m) => m.ShortVideo),
  { ssr: false },
);

// Tab whitelist — used by both the renderer and the URL-hash parser so
// a stray `#foo` falls back cleanly to Script.
const TAB_KEYS = ['script', 'style', 'captions', 'voice', 'render', 'seo'] as const;
type TabKey = (typeof TAB_KEYS)[number];

interface TabDef {
  key: TabKey;
  label: string;
  /** Descriptive copy for the prototype. Phase 2 swaps this for real JSX. */
  summary: string;
  /** Bullet list of controls / surfaces that move into this tab. */
  contents: string[];
}

const TABS: TabDef[] = [
  {
    key: 'script',
    label: 'Script',
    summary: 'Everything the voice will say + the creative brief that shapes the visuals.',
    contents: [
      'Title (saves on blur)',
      'Hook — the first 1–3 seconds',
      'Payoff — the closing line',
      'Full script — the spoken body, auto-chunked into captions at render time',
      'Asset context — extra direction for the AI when planning visuals (kid character, kitchen setting, things to avoid)',
    ],
  },
  {
    key: 'style',
    label: 'Style',
    summary: 'Pick the visual treatment and mint per-shot assets for Doodle / Paint.',
    contents: [
      'Style picker — Minimal · Doodle Explainer 2 · Paint Explainer V1',
      'Image-model picker (Atlas / Kie family) for Doodle and Paint',
      'Generate assets — base frame + N variants timed to caption chunks',
      'Shots panel — per-frame regen, prompt editing, 2×2 collage, image-to-video animation',
    ],
  },
  {
    key: 'captions',
    label: 'Captions',
    summary: 'Global caption styling + per-chunk overrides. Live on every style.',
    contents: [
      'Re-sync timing against the latest voiceover',
      'Global style — font · size · effect · background · transform · position · padding · outline · letter spacing · line height · color · highlight',
      'Per-chunk overrides — replace text, change timing, or hide a chunk without touching the script',
      'Reset all caption styling',
    ],
  },
  {
    key: 'voice',
    label: 'Voice',
    summary: 'ElevenLabs voiceover. Pick a voice, generate, re-run as needed.',
    contents: [
      'Voice picker — workspace voices + the multilingual_v2 default',
      'Generate voiceover (overwrites the existing audio)',
      'Inline audio player with the rendered mp3',
      'Re-sync timing against the new voiceover (also lives on Captions)',
    ],
  },
  {
    key: 'render',
    label: 'Render',
    summary: 'Compose the final 1080×1920 MP4 on Remotion Lambda.',
    contents: [
      'Render job status + progress',
      'Final mp4 player + download link',
      'Render history (the persistent CTA in the top bar fires the same job)',
    ],
  },
  {
    key: 'seo',
    label: 'SEO',
    summary: 'AI-graded title, description, and hashtag suggestions for this Short.',
    contents: [
      'AI model picker',
      'Generate graded suggestions',
      'Side-by-side comparison of options with rationale per pick',
    ],
  },
];

function parseTabHash(hash: string): TabKey {
  const stripped = hash.replace(/^#/, '').toLowerCase();
  return (TAB_KEYS as readonly string[]).includes(stripped) ? (stripped as TabKey) : 'script';
}

// ─────────────────────────────────────────────────────────────────────────
// Status-chip computation. Pure helpers so a future real refactor can
// reuse them verbatim.

function chipsFor(row: ShortRow): Array<{ label: string; value: string; tone: 'neutral' | 'good' | 'pending' }> {
  const assetStatus = getStyleAssetStatus(row);
  return [
    { label: 'Medium', value: row.medium, tone: 'neutral' },
    { label: 'Words', value: row.word_count ? String(row.word_count) : '—', tone: 'neutral' },
    {
      label: 'Length',
      value: row.estimated_duration_seconds ? `${row.estimated_duration_seconds}s` : '—',
      tone: 'neutral',
    },
    {
      label: 'Voiceover',
      value: row.voiceover_audio_url
        ? `${row.voiceover_duration_seconds ?? '?'}s`
        : 'not yet',
      tone: row.voiceover_audio_url ? 'good' : 'pending',
    },
    {
      label: 'Assets',
      value:
        assetStatus === 'ready'
          ? `${styleAssetLabel(row.style_id)} ready`
          : assetStatus === 'generating'
            ? 'generating…'
            : '—',
      tone: assetStatus === 'ready' ? 'good' : assetStatus === 'generating' ? 'pending' : 'neutral',
    },
    {
      label: 'MP4',
      value: row.rendered_video_url ? 'ready' : 'not yet',
      tone: row.rendered_video_url ? 'good' : 'pending',
    },
  ];
}

interface RenderCtaState {
  enabled: boolean;
  reason: string | null;
}

/** Decides whether the persistent Render button is enabled. Pure so the
 *  real refactor can wrap it in a test. */
function computeRenderCtaState(row: ShortRow): RenderCtaState {
  if (!row.voiceover_audio_url) {
    return { enabled: false, reason: 'Generate the voiceover first.' };
  }
  const styleId = row.style_id;
  if (styleId === 'doodle_explainer_2_short' || styleId === 'paint_explainer_v1_short') {
    const assetStatus = getStyleAssetStatus(row);
    if (assetStatus !== 'ready') {
      return { enabled: false, reason: 'Generate the style assets first.' };
    }
  }
  return { enabled: true, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────
// Tab indicator dots — small visual signal on the tab label.

type TabBadge = 'none' | 'good' | 'pending' | 'error';

function badgeFor(tabKey: TabKey, row: ShortRow): TabBadge {
  if (tabKey === 'style') {
    const phase = row.generation_progress?.phase;
    if (phase === 'error') return 'error';
    if (phase === 'queued' || phase === 'planning' || phase === 'base' || phase === 'variant') {
      return 'pending';
    }
    if (getStyleAssetStatus(row) === 'ready') return 'good';
  }
  if (tabKey === 'voice' && row.voiceover_audio_url) return 'good';
  if (tabKey === 'render' && row.rendered_video_url) return 'good';
  return 'none';
}

// ─────────────────────────────────────────────────────────────────────────
// Main component.

export function ShortEditorRedesignPreview({ shortId }: { shortId: string }) {
  const [row, setRow] = useState<ShortRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('script');
  const [previewMinimized, setPreviewMinimized] = useState(false);
  const [viewportIsWide, setViewportIsWide] = useState<boolean | null>(null);

  // ── load row ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads short row for the prototype layout
        const res = await fetch(`/api/shorts/${encodeURIComponent(shortId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setRow(data.short as ShortRow);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load Short');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shortId]);

  // ── URL-hash → activeTab + back/forward support ─────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setActiveTab(parseTabHash(window.location.hash));
    const onHash = () => setActiveTab(parseTabHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // ── viewport breakpoint (no SSR hydration mismatch — only flips on mount) ─
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const compute = () => setViewportIsWide(window.innerWidth >= 1100);
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);

  const setTab = useCallback((next: TabKey) => {
    setActiveTab(next);
    if (typeof window !== 'undefined') {
      // Use replaceState so tab switches don't pile up history entries.
      window.history.replaceState(null, '', `#${next}`);
    }
  }, []);

  // ── preview config ──────────────────────────────────────────────────
  const previewConfig = useMemo<ShortVideoConfig | null>(() => {
    if (!row) return null;
    try {
      return buildShortVideoConfig({
        short: row,
        background: undefined,
        accentColor: undefined,
        channelName: undefined,
      });
    } catch {
      return null;
    }
  }, [row]);

  const previewDurationFrames = previewConfig
    ? Math.max(1, Math.round((previewConfig.duration_ms / 1000) * previewConfig.fps))
    : 90;

  // ── render guards ───────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto', color: 'var(--text-muted)' }}>
        Loading Short…
      </div>
    );
  }
  if (error || !row) {
    return (
      <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>
        <Link href="/shorts" style={{ fontSize: 13 }}>
          ← Shorts
        </Link>
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 10,
            background: 'rgba(244,63,94,0.1)',
            border: '1px solid rgba(244,63,94,0.3)',
            color: '#fca5a5',
          }}
        >
          {error ?? 'Short not found.'}
        </div>
      </div>
    );
  }

  const chips = chipsFor(row);
  const renderCta = computeRenderCtaState(row);
  // Default to wide layout during SSR + first paint to avoid a flash of the
  // stacked layout. `viewportIsWide === false` is the only "go narrow" state.
  const isNarrow = viewportIsWide === false;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1280, margin: '0 auto' }}>
      <PrototypeBanner shortId={shortId} />

      <TopBar
        row={row}
        renderCta={renderCta}
        onRenderClick={() => setTab('render')}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isNarrow ? '1fr' : 'minmax(360px, 440px) 1fr',
          gap: 20,
          alignItems: 'flex-start',
        }}
      >
        <LeftRail
          previewConfig={previewConfig}
          previewDurationFrames={previewDurationFrames}
          chips={chips}
          isNarrow={isNarrow}
          previewMinimized={previewMinimized}
          onTogglePreview={() => setPreviewMinimized((v) => !v)}
          generationProgress={row.generation_progress}
        />

        <RightRail
          row={row}
          activeTab={activeTab}
          onTabChange={setTab}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components

function PrototypeBanner({ shortId }: { shortId: string }) {
  return (
    <div
      style={{
        marginBottom: 16,
        padding: '10px 14px',
        borderRadius: 10,
        background: 'rgba(253,224,71,0.08)',
        border: '1px solid rgba(253,224,71,0.32)',
        color: '#fde68a',
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      <strong style={{ fontWeight: 700 }}>Layout prototype.</strong> The preview
      and status chips on the left are wired to your real Short. The right rail
      is descriptive copy — controls, buttons, and the Render trigger here are
      non-functional. The working editor is at{' '}
      <Link
        href={`/shorts/${encodeURIComponent(shortId)}`}
        style={{ color: '#fde68a', textDecoration: 'underline' }}
      >
        /shorts/{shortId.slice(0, 8)}…
      </Link>
      .
    </div>
  );
}

function TopBar({
  row,
  renderCta,
  onRenderClick,
}: {
  row: ShortRow;
  renderCta: RenderCtaState;
  onRenderClick: () => void;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        marginBottom: 18,
        paddingBottom: 14,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <Link
        href="/shorts"
        style={{
          fontSize: 13,
          color: 'var(--text-secondary, rgba(255,255,255,0.7))',
          textDecoration: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        ← Shorts
      </Link>
      <h1
        style={{
          margin: 0,
          fontSize: 20,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
          flex: 1,
        }}
      >
        {row.title || 'Untitled Short'}
      </h1>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        Saved {new Date(row.updated_at).toLocaleString()}
      </span>
      <button
        type="button"
        onClick={onRenderClick}
        disabled={!renderCta.enabled}
        title={renderCta.reason ?? 'Compose the final 1080×1920 MP4 on Remotion Lambda.'}
        style={{
          padding: '8px 16px',
          fontSize: 13,
          fontWeight: 600,
          color: renderCta.enabled ? '#fff' : 'rgba(255,255,255,0.4)',
          background: renderCta.enabled
            ? 'linear-gradient(180deg, #8b5cf6 0%, #7c3aed 100%)'
            : 'rgba(255,255,255,0.05)',
          border: renderCta.enabled
            ? '1px solid rgba(167,139,250,0.6)'
            : '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          cursor: renderCta.enabled ? 'pointer' : 'not-allowed',
          whiteSpace: 'nowrap',
        }}
      >
        Render MP4 ▸
      </button>
    </header>
  );
}

function LeftRail({
  previewConfig,
  previewDurationFrames,
  chips,
  isNarrow,
  previewMinimized,
  onTogglePreview,
  generationProgress,
}: {
  previewConfig: ShortVideoConfig | null;
  previewDurationFrames: number;
  chips: ReturnType<typeof chipsFor>;
  isNarrow: boolean;
  previewMinimized: boolean;
  onTogglePreview: () => void;
  generationProgress: ShortRow['generation_progress'];
}) {
  // Sticky on the wide layout; pinned at the top on narrow.
  const containerStyle: React.CSSProperties = isNarrow
    ? {
        position: 'sticky',
        top: 0,
        zIndex: 5,
        background: 'var(--background, #0a0a0f)',
        paddingTop: 4,
        paddingBottom: 12,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }
    : {
        position: 'sticky',
        top: 20,
        alignSelf: 'flex-start',
      };

  const previewBoxStyle: React.CSSProperties = isNarrow && previewMinimized
    ? {
        width: 96,
        height: 168,
        marginLeft: 'auto',
      }
    : {
        width: '100%',
        aspectRatio: '9 / 16',
      };

  return (
    <aside style={containerStyle}>
      <div
        style={{
          padding: 14,
          borderRadius: 14,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div
          style={{
            ...previewBoxStyle,
            background: '#000',
            borderRadius: 10,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {previewConfig ? (
            <Player
              component={ShortVideo}
              inputProps={{ config: previewConfig }}
              compositionWidth={SHORT_WIDTH}
              compositionHeight={SHORT_HEIGHT}
              fps={SHORT_FPS}
              durationInFrames={previewDurationFrames}
              controls
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                fontSize: 12,
                padding: 16,
                textAlign: 'center',
              }}
            >
              Preview unavailable. Likely missing the voiceover or style assets.
            </div>
          )}
        </div>

        {isNarrow && (
          <button
            type="button"
            onClick={onTogglePreview}
            style={{
              marginTop: 8,
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'transparent',
              color: 'var(--text-secondary, rgba(255,255,255,0.75))',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {previewMinimized ? 'Expand preview' : 'Minimize preview'}
          </button>
        )}

        {/* Status chips */}
        <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map((c) => (
            <Chip key={c.label} label={c.label} value={c.value} tone={c.tone} />
          ))}
        </div>

        {/* Asset-pipeline strip — only when a job is in flight or errored */}
        {generationProgress?.phase && (
          <div
            style={{
              marginTop: 14,
              padding: '10px 12px',
              borderRadius: 10,
              background:
                generationProgress.phase === 'error'
                  ? 'rgba(244,63,94,0.12)'
                  : 'rgba(167,139,250,0.10)',
              border:
                generationProgress.phase === 'error'
                  ? '1px solid rgba(244,63,94,0.35)'
                  : '1px solid rgba(167,139,250,0.32)',
              fontSize: 11,
              lineHeight: 1.5,
              color:
                generationProgress.phase === 'error' ? '#fca5a5' : '#c4b5fd',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {generationProgress.phase === 'error' ? 'Asset generation failed' : 'Generating assets…'}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.65)' }}>
              {generationProgress.label
                ?? generationProgress.error_message
                ?? `Phase: ${generationProgress.phase}`}
            </div>
            {generationProgress.total && (
              <div style={{ marginTop: 4, color: 'rgba(255,255,255,0.5)' }}>
                {generationProgress.current ?? 0} / {generationProgress.total}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'good' | 'pending';
}) {
  const accent =
    tone === 'good' ? '#34d399' : tone === 'pending' ? '#fde68a' : 'rgba(255,255,255,0.55)';
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 7,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.07)',
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: accent, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function RightRail({
  row,
  activeTab,
  onTabChange,
}: {
  row: ShortRow;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}) {
  const active = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  return (
    <section
      style={{
        borderRadius: 14,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}
    >
      <nav
        role="tablist"
        aria-label="Editor sections"
        style={{
          display: 'flex',
          gap: 2,
          padding: 6,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(0,0,0,0.18)',
          overflowX: 'auto',
        }}
      >
        {TABS.map((t) => {
          const isActive = t.key === activeTab;
          const badge = badgeFor(t.key, row);
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              type="button"
              onClick={() => onTabChange(t.key)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                borderRadius: 8,
                border: 'none',
                background: isActive ? 'rgba(124,58,237,0.18)' : 'transparent',
                color: isActive ? '#c4b5fd' : 'var(--text-secondary, rgba(255,255,255,0.72))',
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
              {badge !== 'none' && <BadgeDot tone={badge} />}
            </button>
          );
        })}
      </nav>

      <div style={{ padding: 22 }} role="tabpanel">
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{active.label}</h2>
        <p
          style={{
            margin: '6px 0 18px 0',
            fontSize: 13,
            color: 'var(--text-secondary, rgba(255,255,255,0.65))',
            lineHeight: 1.55,
          }}
        >
          {active.summary}
        </p>

        <PlaceholderSection title="What lives here" items={active.contents} />

        <PrototypeNote tabKey={active.key} />
      </div>
    </section>
  );
}

function BadgeDot({ tone }: { tone: 'good' | 'pending' | 'error' }) {
  const color = tone === 'good' ? '#34d399' : tone === 'pending' ? '#fde68a' : '#fca5a5';
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
      }}
    />
  );
}

function PlaceholderSection({ title, items }: { title: string; items: string[] }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        background: 'rgba(255,255,255,0.025)',
        border: '1px dashed rgba(255,255,255,0.12)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 1.7 }}>
        {items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function PrototypeNote({ tabKey }: { tabKey: TabKey }) {
  const notes: Record<TabKey, string> = {
    script:
      'Phase 2 will move the four text inputs + the asset-context textarea here. Save-on-blur unchanged.',
    style:
      'Phase 2 will move the style picker, image-model controls, generate-assets button, and the entire Shots panel here. Asset-pipeline progress stays in the left rail (visible from every tab).',
    captions:
      'Phase 2 will move the Global style chip rows, the numeric/colour controls, and the per-chunk override list here. Position controls move WITH the rest — no special-casing.',
    voice:
      'Phase 2 will move the voice picker + Generate voiceover + audio player here. The re-sync timing button shows up on both Voice and Captions (it belongs to both flows).',
    render:
      'Phase 2 will move render-job status, the final mp4 player, and download here. The Render CTA in the top bar fires the same code path — clicking it lands you on this tab.',
    seo:
      'Phase 2 will move the SEO suggestion surface here.',
  };
  return (
    <p
      style={{
        margin: '14px 0 0 0',
        fontSize: 11,
        color: 'var(--text-muted)',
        fontStyle: 'italic',
        lineHeight: 1.55,
      }}
    >
      {notes[tabKey]}
    </p>
  );
}
