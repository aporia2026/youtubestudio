'use client';

// Persistent banner shown at the top of any feature page that was opened with
// a `?scheduleItemId=…` URL parameter. Surfaces the linked item's title +
// channel + status so the user knows what they're working on, and exposes an
// "Unlink" escape hatch that strips the param without losing page state.

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import type { ScheduleItem } from '@/lib/schedule';
import { SCHEDULE_LINK_PARAM } from '@/lib/schedule-link';

type Props = {
  item: ScheduleItem;
  feature?: string;
};

export function ScheduleLinkBanner({ item, feature }: Props) {
  const router = useRouter();
  const search = useSearchParams();

  const unlink = useCallback(() => {
    const params = new URLSearchParams(search?.toString() ?? '');
    params.delete(SCHEDULE_LINK_PARAM);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false });
  }, [router, search]);

  const primaryChannel = item.channels?.[0];
  const accent = primaryChannel?.account_color ?? '#7c3aed';

  return (
    <div
      className="mb-4 flex items-center gap-3 px-4 py-2.5 rounded-lg"
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
        <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {item.title || 'Untitled video'}
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
      <a
        href={`/schedule?channel=${primaryChannel?.id ?? ''}`}
        onClick={e => { e.preventDefault(); window.open(`/schedule?channel=${primaryChannel?.id ?? ''}`, '_blank'); }}
        className="text-xs px-2 py-1 rounded"
        style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
        title="Open in schedule"
      >
        ↗
      </a>
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
