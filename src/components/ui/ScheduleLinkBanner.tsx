'use client';

// Persistent banner shown at the top of any feature page that was opened with
// a `?scheduleItemId=…` URL parameter. Surfaces the linked item's title +
// channel + status, plus a Save button that pushes the page's artifact back
// onto the linked schedule item, and a follow-up "Mark complete" affordance
// once a save succeeds.
//
// Save / advance state lives in <ScheduleLinkProvider> (sibling file). The
// banner is purely a renderer — pages register their save behaviour via
// `useRegisterScheduleWriteBack`.

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ScheduleItem } from '@/lib/schedule';
import {
  SCHEDULE_LINK_PARAM,
  fetchScheduleItem,
} from '@/lib/schedule-link';
import { useScheduleLinkContext } from './ScheduleLinkContext';

type Props = {
  /** Optional fallback when not wrapped in a <ScheduleLinkProvider>. The
   *  Save button is hidden in that case (no saver to talk to). */
  item?: ScheduleItem;
  feature?: string;
};

export function ScheduleLinkBanner({ item: itemProp, feature }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const ctx = useScheduleLinkContext();

  // Prefer context-provided item (live, refreshes after saves) over the prop
  // fallback. The prop path is only used by callers that haven't migrated to
  // <ScheduleLinkProvider>.
  const itemFromCtx = ctx?.item ?? null;
  const initialItem = itemFromCtx ?? itemProp ?? null;
  const [legacyItem, setLegacyItem] = useState<ScheduleItem | null>(initialItem);

  // Refetch on tab focus when running in legacy (no-context) mode. The
  // provider already does this when present, so we skip it then.
  useEffect(() => {
    if (ctx) return; // provider owns refresh
    if (!itemProp) return;
    let cancelled = false;
    function refresh() {
      if (typeof document === 'undefined') return;
      if (document.visibilityState !== 'visible') return;
      fetchScheduleItem(itemProp!.id).then(fresh => {
        if (!cancelled && fresh) setLegacyItem(fresh);
      });
    }
    document.addEventListener('visibilitychange', refresh);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', refresh); };
  }, [ctx, itemProp]);

  const item = ctx ? itemFromCtx : legacyItem;

  const unlink = useCallback(() => {
    const params = new URLSearchParams(search?.toString() ?? '');
    params.delete(SCHEDULE_LINK_PARAM);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  }, [router, search]);

  if (!item) return null;

  const primaryChannel = item.channels?.[0];
  const accent = primaryChannel?.account_color ?? '#7c3aed';
  const scheduleHref = primaryChannel ? `/schedule?channel=${primaryChannel.id}` : '/schedule';

  const saver = ctx?.saver ?? null;
  const saving = ctx?.saving ?? false;
  const lastSavedAt = ctx?.lastSavedAt ?? null;
  const triggerSave = ctx?.triggerSave;
  const triggerAdvance = ctx?.triggerAdvance;

  // Status-already-at-target check: hide "Mark complete" if the item is
  // already at the saver's nextStatus key (or beyond, but we can't tell that
  // locally — the server enforces strict-ordering and will no-op anyway).
  const advanceVisible =
    !!saver?.nextStatus &&
    item.status !== saver.nextStatus.key &&
    !!triggerAdvance;

  const buttonReady = !!saver?.isReady;
  const buttonDirty = !!saver?.isDirty;
  const buttonLabel = saver ? `Save ${saver.artifactLabel}` : 'Save';
  const tooltip = !buttonReady
    ? (saver?.notReadyReason || 'Nothing to save yet')
    : buttonDirty
      ? `Push ${saver?.artifactLabel ?? 'artifact'} to the linked schedule item`
      : `Re-save ${saver?.artifactLabel ?? 'artifact'} to the linked schedule item`;

  return (
    <div
      className="mb-4 flex items-center gap-3 px-4 py-2.5 rounded-lg flex-wrap"
      style={{
        background: `linear-gradient(90deg, ${accent}14, transparent)`,
        border: `1px solid ${accent}55`,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" className="shrink-0">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: accent }}>
          {feature ? `${feature} · linked to schedule` : 'Linked to schedule'}
        </div>
        <div className="text-sm font-medium truncate flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <span className="truncate">{item.title || 'Untitled video'}</span>
          {/* Saved-at subtitle + advance follow-up. Rendered inline with the
              title so it reads as a single status line at a glance. */}
          {saver && lastSavedAt && (
            <span className="text-[11px] font-normal" style={{ color: 'var(--text-muted)' }}>
              · Saved {formatRelative(lastSavedAt)}
            </span>
          )}
          {advanceVisible && saver?.nextStatus && (
            <button
              type="button"
              onClick={() => triggerAdvance?.()}
              disabled={saving}
              className="text-[11px] font-semibold ml-1 hover:underline disabled:opacity-50"
              style={{ color: accent }}
              title={`Advance the linked schedule item to ${saver.nextStatus.label}`}
            >
              Mark as {saver.nextStatus.label} →
            </button>
          )}
        </div>
      </div>
      {primaryChannel && (
        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="w-2 h-2 rounded-full" style={{ background: primaryChannel.account_color || accent }} />
          {primaryChannel.name}
        </div>
      )}
      <span
        className="text-[10px] px-2 py-0.5 rounded-full uppercase font-semibold"
        style={{ background: `${accent}33`, color: accent }}
      >
        {item.status}
      </span>

      {/* Primary Save button. Only renders when a page has registered a saver
          (i.e., the page knows what its artifact is). Disabled with a useful
          tooltip when the artifact isn't ready yet. */}
      {saver && triggerSave && (
        <button
          type="button"
          onClick={() => triggerSave()}
          disabled={!buttonReady || saving}
          className="text-xs px-3 py-1 rounded-md font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          style={{
            background: buttonDirty && buttonReady ? accent : 'transparent',
            color: buttonDirty && buttonReady ? 'white' : accent,
            border: `1px solid ${accent}`,
          }}
          title={tooltip}
        >
          {/* Subtle dirty dot when there are unsaved changes since last save. */}
          {buttonDirty && buttonReady && (
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: 'white' }}
              aria-label="Unsaved changes"
            />
          )}
          {saving ? 'Saving…' : buttonLabel}
        </button>
      )}

      {/* Plain anchor — let the browser handle middle-click / Cmd-click
          natively. Forcing window.open used to double-open the tab. */}
      <Link
        href={scheduleHref}
        target="_blank"
        rel="noopener"
        className="text-xs px-2 py-1 rounded"
        style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
        title="Open in schedule"
      >
        ↗
      </Link>
      <button
        onClick={unlink}
        className="text-xs px-2 py-1 rounded"
        style={{ color: 'var(--text-muted)' }}
        title="Unlink — you'll keep this page's work but won't write back"
      >
        Unlink
      </button>
    </div>
  );
}

/** "just now" / "5m ago" / "2h ago" / "3d ago". Coarse on purpose so the
 *  banner doesn't churn every second. */
function formatRelative(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
