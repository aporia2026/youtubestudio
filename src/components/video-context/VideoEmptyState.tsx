'use client';

/**
 * Lightweight "pick a video" hint shown at the top of a Create-hub tool page
 * when it was opened WITHOUT `?videoId=`. The page's existing UI renders
 * below it untouched — this is additive, not a replacement. Users who
 * intentionally work ad-hoc (a one-off QA pass on a pasted script, etc.)
 * still get the existing experience.
 *
 * Self-determining: reads pathname + searchParams from the router. Renders
 * null in every case except "on a known tool page AND no videoId in the
 * URL." That means it is safe to mount globally in AppLayout next to
 * VideoContextStrip — they are exclusive (videoId present → strip;
 * absent + on tool page → this; everywhere else → nothing).
 *
 * The tool path → label mapping reuses STAGE_CHAIN so adding a new stage
 * in src/lib/video-stages.ts automatically adds an empty-state phrasing
 * here.
 */

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { STAGE_CHAIN } from '@/lib/video-stages';

// Map of tool pathname → user-facing stage label. Built once from
// STAGE_CHAIN so a new stage propagates without a second edit.
// Some stages share a path ('scheduled' and 'published' both point at
// /schedule); the first match wins, which is the better phrasing for
// the empty state anyway.
//
// Ancillary tool paths (entries below STAGE_CHAIN) are pages that ALSO
// operate on a specific video but aren't a stage in the canonical
// 10-stage chain. They get the empty-state hint when no ?videoId= is
// present; the strip itself works on them automatically via the global
// AppLayout mount. Per-page prefill of the video context is per-page
// work (see _plans/2026-05-26-cross-feature-rollout.md).
const TOOL_PATH_TO_LABEL: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const stage of STAGE_CHAIN) {
    if (!map[stage.toolPath]) map[stage.toolPath] = stage.label;
  }
  // Ancillary tool pages — extend the strip's reach.
  const ancillary: Array<[string, string]> = [
    ['/critics', 'Critic panel'],
    ['/shorts', 'Shorts extract'],
    ['/dub', 'Auto-dub'],
    ['/retention', 'Retention predictor'],
    ['/ab-tests', 'A/B test'],
    ['/fix-the-dip', 'Retention dip fix'],
    ['/comments', 'Comment triage'],
    ['/cannibalization', 'Cannibalization check'],
  ];
  for (const [path, label] of ancillary) {
    if (!map[path]) map[path] = label;
  }
  return map;
})();

export function VideoEmptyState(): React.ReactElement | null {
  const search = useSearchParams();
  const pathname = usePathname();
  const hasVideoId = !!search?.get('videoId');
  if (hasVideoId) return null;
  if (!pathname) return null;
  const toolLabel = TOOL_PATH_TO_LABEL[pathname];
  if (!toolLabel) return null;

  const scheduleHref = `/schedule?return=${encodeURIComponent(pathname)}`;

  return (
    <div
      className="mx-4 my-3 px-4 py-2.5 rounded-lg flex items-center gap-3 text-sm flex-wrap"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        color: 'var(--text-primary)',
      }}
      data-testid="video-empty-state"
    >
      <span aria-hidden style={{ color: 'var(--accent-purple-bright)' }}>◷</span>
      <span className="flex-1">
        <span style={{ color: 'var(--text-muted)' }}>Working ad-hoc.</span>{' '}
        Pick a video to work on its <strong>{toolLabel}</strong> step with full context and prev / next stage navigation.
      </span>
      <Link
        href={scheduleHref}
        className="text-xs px-3 py-1 rounded font-medium"
        style={{
          background: 'var(--accent-purple)',
          color: 'white',
        }}
      >
        Pick from Schedule
      </Link>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        or keep working below
      </span>
    </div>
  );
}
