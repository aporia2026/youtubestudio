'use client';

/**
 * Layout shell for the Shorts editor. Owns the split + tabs chrome: top
 * bar with persistent Render CTA, sticky 9:16 preview on the left rail
 * with status chips + asset-pipeline strip, tabbed right rail with the
 * active tab's content.
 *
 * Pure layout component — does not own data. The parent (`ShortEditor`)
 * passes the row, the active tab, and a map of tab-key → JSX. This keeps
 * all state ownership in the orchestrator and lets the existing in-file
 * sub-components (CaptionsEditorPanel, ShotsPanel, etc.) move into their
 * tab slots without prop-plumbing.
 *
 * Plan: `_plans/2026-06-04-shorts-editor-redesign-split-tabs.md`.
 *
 * Layout (>= 1100px):
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ ← Shorts  ·  Title  ·  saved-state  ·  [Render MP4 ▸]          │
 *   ├──────────────────────────┬─────────────────────────────────────┤
 *   │   9:16 PREVIEW (sticky)  │  Script  Style  Captions  Voice  …  │
 *   │   ─ status chips ─       ├─────────────────────────────────────┤
 *   │   ─ pipeline strip ─     │  Active tab content                 │
 *   └──────────────────────────┴─────────────────────────────────────┘
 *
 * Below 1100px: stacks vertically, preview pinned at the top with a
 * minimize toggle that collapses it to a thumbnail.
 */

import { useEffect, useState, type ReactNode, type Ref } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { PlayerRef } from '@remotion/player';
import {
  SHORT_FPS,
  SHORT_HEIGHT,
  SHORT_WIDTH,
  type ShortVideoConfig,
} from '@/lib/shorts-render-types';
import type { ShortRow } from '@/lib/shorts-types';
import {
  TABS,
  badgeFor,
  chipsFor,
  type ChipDatum,
  type RenderCtaState,
  type TabBadge,
  type TabKey,
} from './editor-tabs';

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
  ref?: Ref<PlayerRef>;
}>;

const ShortVideo = dynamic(
  () => import('@/remotion/compositions/ShortVideo').then((m) => m.ShortVideo),
  { ssr: false },
);

export interface EditorShellProps {
  row: ShortRow;
  /** Pre-built ShortVideoConfig for the Player. Null when prerequisites
   *  are missing (no voiceover, no assets); shell shows a placeholder. */
  previewConfig: ShortVideoConfig | null;
  /** Fallback message rendered in the preview box when previewConfig is
   *  null — e.g. "Generate the voiceover first." */
  previewMessage: string | null;
  /** Total composition length in frames, used by the Player. */
  previewDurationFrames: number;
  /** The active tab key. */
  activeTab: TabKey;
  onTabChange: (next: TabKey) => void;
  /** Render CTA state from `computeRenderCtaState(row)`. */
  renderCta: RenderCtaState;
  /** Fired when the user clicks the persistent Render button. The
   *  orchestrator decides whether this triggers the render directly,
   *  or switches to the Render tab and fires from there. */
  onRenderClick: () => void;
  /** Tab content by key. Each entry is the JSX rendered when its tab
   *  is active. The orchestrator owns all state + handlers in scope. */
  tabContent: Record<TabKey, ReactNode>;
  /** Optional ref to the Remotion Player so the orchestrator can drive
   *  it imperatively — seekTo / play / pause from controls outside the
   *  preview box (e.g. "Jump to frame" buttons in the Shots panel). */
  playerRef?: Ref<PlayerRef>;
}

export function EditorShell(props: EditorShellProps) {
  const [previewMinimized, setPreviewMinimized] = useState(false);
  const [viewportIsWide, setViewportIsWide] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const compute = () => setViewportIsWide(window.innerWidth >= 1100);
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);

  // Default to wide layout during SSR + first paint to avoid a flash of
  // the stacked layout. `viewportIsWide === false` is the only "go narrow"
  // state.
  const isNarrow = viewportIsWide === false;
  const chips = chipsFor(props.row);

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1280, margin: '0 auto' }}>
      <TopBar
        title={props.row.title || 'Untitled Short'}
        updatedAt={props.row.updated_at}
        renderCta={props.renderCta}
        onRenderClick={props.onRenderClick}
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
          previewConfig={props.previewConfig}
          previewMessage={props.previewMessage}
          previewDurationFrames={props.previewDurationFrames}
          chips={chips}
          isNarrow={isNarrow}
          previewMinimized={previewMinimized}
          onTogglePreview={() => setPreviewMinimized((v) => !v)}
          generationProgress={props.row.generation_progress}
          playerRef={props.playerRef}
        />

        <RightRail
          row={props.row}
          activeTab={props.activeTab}
          onTabChange={props.onTabChange}
          tabContent={props.tabContent}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components

function TopBar({
  title,
  updatedAt,
  renderCta,
  onRenderClick,
}: {
  title: string;
  updatedAt: string;
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
        {title}
      </h1>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        Saved {new Date(updatedAt).toLocaleString()}
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
  previewMessage,
  previewDurationFrames,
  chips,
  isNarrow,
  previewMinimized,
  onTogglePreview,
  generationProgress,
  playerRef,
}: {
  previewConfig: ShortVideoConfig | null;
  previewMessage: string | null;
  previewDurationFrames: number;
  chips: ChipDatum[];
  isNarrow: boolean;
  previewMinimized: boolean;
  onTogglePreview: () => void;
  generationProgress: ShortRow['generation_progress'];
  playerRef?: Ref<PlayerRef>;
}) {
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
              ref={playerRef}
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
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
                textAlign: 'center',
                color: 'var(--text-secondary, rgba(255,255,255,0.6))',
                fontSize: 12,
                lineHeight: 1.55,
              }}
            >
              <strong style={{ color: '#fde68a', fontSize: 13, marginBottom: 6 }}>
                Preview unavailable
              </strong>
              {previewMessage ?? 'Likely missing the voiceover or style assets.'}
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

        <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map((c) => (
            <Chip key={c.label} label={c.label} value={c.value} tone={c.tone} />
          ))}
        </div>

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
  tabContent,
}: {
  row: ShortRow;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  tabContent: Record<TabKey, ReactNode>;
}) {
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
        {tabContent[activeTab]}
      </div>
    </section>
  );
}

function BadgeDot({ tone }: { tone: Exclude<TabBadge, 'none'> }) {
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
