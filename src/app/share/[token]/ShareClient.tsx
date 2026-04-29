'use client';

import { useEffect, useState } from 'react';

type Channel = { name: string; account_color: string | null };
type Item = {
  id: string;
  title: string;
  scheduled_for: string | null;
  status: string;
  tags: string[];
  pillar: string | null;
  channels: Channel[];
};

export function ShareClient({ token }: { token: string }) {
  const [data, setData] = useState<{ label: string | null; channel: Channel | null; items: Item[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/public/schedule/${token}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'Could not load');
        return;
      }
      setData(await res.json());
    })();
  }, [token]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg-primary, #0f1115)' }}>
        <div className="text-center">
          <h1 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary, white)' }}>This link is not valid</h1>
          <p style={{ color: 'var(--text-muted, #aaa)' }}>{error}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return <div className="min-h-screen flex items-center justify-center" style={{ color: 'var(--text-muted, #aaa)' }}>Loading…</div>;
  }

  const groups = new Map<string, Item[]>();
  for (const it of data.items) {
    const b = it.scheduled_for ? new Date(it.scheduled_for).toLocaleDateString(undefined, { year: 'numeric', month: 'long' }) : 'Unscheduled';
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b)!.push(it);
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
            Shared schedule {data.label ? `· ${data.label}` : ''}
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {data.channel ? data.channel.name : 'All channels'}
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Read-only · {data.items.length} items</p>
        </div>

        {Array.from(groups.entries()).map(([bucket, list]) => (
          <div key={bucket} className="mb-6">
            <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>{bucket}</h3>
            <div className="space-y-1.5">
              {list.map(it => (
                <div key={it.id} className="px-3 py-2.5 rounded-lg"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{it.title || 'Untitled'}</div>
                  <div className="text-xs flex items-center gap-2 mt-1 flex-wrap" style={{ color: 'var(--text-muted)' }}>
                    <span className="uppercase tracking-wider">{it.status}</span>
                    {it.scheduled_for && <span>· {new Date(it.scheduled_for).toLocaleDateString()}</span>}
                    {it.pillar && <span>· pillar: {it.pillar}</span>}
                    {(it.tags ?? []).map((t, i) => <span key={i}>· #{t}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
