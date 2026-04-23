'use client';

import type { ScheduleItem } from '@/lib/schedule';

type Props = {
  item: ScheduleItem;
  onPatch: (patch: Partial<ScheduleItem>) => void;
};

export function ThumbnailSlots({ item, onPatch }: Props) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
        Thumbnails (A/B)
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Slot
          label="Variant A"
          url={item.thumbnail_a_url ?? null}
          isWinner={item.thumbnail_winner === 'a'}
          onChange={url => onPatch({ thumbnail_a_url: url })}
          onPickWinner={() => onPatch({ thumbnail_winner: 'a' })}
        />
        <Slot
          label="Variant B"
          url={item.thumbnail_b_url ?? null}
          isWinner={item.thumbnail_winner === 'b'}
          onChange={url => onPatch({ thumbnail_b_url: url })}
          onPickWinner={() => onPatch({ thumbnail_winner: 'b' })}
        />
      </div>
      {item.thumbnail_winner && (
        <button onClick={() => onPatch({ thumbnail_winner: null })}
          className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          Clear winner
        </button>
      )}
    </div>
  );
}

function Slot({ label, url, isWinner, onChange, onPickWinner }: {
  label: string;
  url: string | null;
  isWinner: boolean;
  onChange: (url: string | null) => void;
  onPickWinner: () => void;
}) {
  return (
    <div className="rounded-lg p-2"
      style={{
        background: 'var(--bg-tertiary)',
        border: `2px solid ${isWinner ? '#10b981' : 'var(--border)'}`,
      }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold" style={{ color: isWinner ? '#10b981' : 'var(--text-secondary)' }}>
          {label}{isWinner && ' · Winner'}
        </span>
        {url && !isWinner && (
          <button onClick={onPickWinner}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
            Set winner
          </button>
        )}
      </div>
      <div className="aspect-video rounded overflow-hidden mb-2 flex items-center justify-center"
        style={{ background: 'var(--bg-secondary)', border: '1px dashed var(--border)' }}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="w-full h-full object-cover" />
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No image yet</div>
        )}
      </div>
      <input
        defaultValue={url ?? ''}
        onBlur={e => onChange(e.currentTarget.value.trim() || null)}
        placeholder="Paste image URL"
        className="w-full px-2 py-1 rounded text-xs"
        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
      />
    </div>
  );
}
