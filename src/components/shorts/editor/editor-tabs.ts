/**
 * Pure helpers for the Shorts editor's split + tabs layout. Kept apart
 * from the React shell so the URL-hash parser and the Render CTA gating
 * are unit-testable without mounting Remotion.
 *
 * Plan: `_plans/2026-06-04-shorts-editor-redesign-split-tabs.md`.
 */

import type { ShortRow } from '@/lib/shorts-types';
import { getStyleAssetStatus } from '@/lib/shorts-asset-status';

/** Whitelist of tab keys. Anything outside this set falls back to Script
 *  per the URL-hash parser — keeps hostile `#javascript:…` etc. out of
 *  the render loop. */
export const TAB_KEYS = ['script', 'style', 'captions', 'voice', 'render', 'seo', 'qa'] as const;
export type TabKey = (typeof TAB_KEYS)[number];

export interface TabDef {
  key: TabKey;
  label: string;
}

export const TABS: readonly TabDef[] = Object.freeze([
  { key: 'script', label: 'Script' },
  { key: 'style', label: 'Style' },
  { key: 'captions', label: 'Captions' },
  { key: 'voice', label: 'Voice' },
  { key: 'render', label: 'Render' },
  { key: 'seo', label: 'SEO' },
  { key: 'qa', label: 'QA' },
]);

/** Parse a `window.location.hash` string into a valid TabKey, falling
 *  back to 'script' for anything unknown or empty. */
export function parseTabHash(hash: string): TabKey {
  const stripped = hash.replace(/^#/, '').toLowerCase();
  return (TAB_KEYS as readonly string[]).includes(stripped) ? (stripped as TabKey) : 'script';
}

/** Per-tab status badge — yellow (pending), green (ready), red (error),
 *  or none. Used by the tab strip to surface meaningful per-tab signals
 *  without making the user click into each one. */
export type TabBadge = 'none' | 'good' | 'pending' | 'error';

export function badgeFor(tabKey: TabKey, row: ShortRow): TabBadge {
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
  if (tabKey === 'qa' && row.qa_score !== null && row.qa_score !== undefined) {
    // The composite threshold is a user-tunable Setting; the editor
    // tabs file is pure (no DB / no settings load), so we use the
    // documented default constant. If the user lowers the threshold
    // via Settings the badge will lag by one re-run — acceptable.
    const threshold = 80;
    return row.qa_score >= threshold ? 'good' : 'error';
  }
  return 'none';
}

/** Decides whether the persistent Render button is enabled, and the
 *  tooltip when it isn't. Pure so a unit test can lock the rules. */
export interface RenderCtaState {
  enabled: boolean;
  reason: string | null;
}

export function computeRenderCtaState(row: ShortRow): RenderCtaState {
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

/** Status-chip data for the left rail. Order matches what most creators
 *  look at first: identity → cost → progress markers. */
export interface ChipDatum {
  label: string;
  value: string;
  tone: 'neutral' | 'good' | 'pending';
}

export function chipsFor(row: ShortRow): ChipDatum[] {
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
          ? 'ready'
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
