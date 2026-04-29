// Client-side helpers for the series feature (DB-backed, cross-device).
// Keeps a short in-memory cache so back-to-back list reads don't re-round-trip.

export interface Series {
  id: string;
  title: string;
  niche?: string | null;
  description?: string | null;
  total_parts_planned?: number | null;
  channel_id?: string | null;
  created_at: string;
  updated_at: string;
  part_count?: number;
}

export interface SeriesPart {
  part_number: number | null;
  kind: 'full' | 'summary';
  body: string;
  source?: 'summary' | 'slice';
  truncated?: boolean;
}

let cache: { at: number; series: Series[] } | null = null;
const CACHE_TTL = 30_000;

export async function listSeries(opts?: { niche?: string; channelId?: string; force?: boolean }): Promise<Series[]> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL) {
    // Filter the cache locally if a constraint was passed
    return cache.series.filter(s =>
      (!opts?.niche || s.niche === opts.niche) &&
      (!opts?.channelId || s.channel_id === opts.channelId)
    );
  }
  const params = new URLSearchParams();
  if (opts?.niche) params.set('niche', opts.niche);
  if (opts?.channelId) params.set('channel_id', opts.channelId);
  const res = await fetch(`/api/series${params.toString() ? `?${params}` : ''}`);
  if (!res.ok) return [];
  const data = await res.json();
  const series = (data.series || []) as Series[];
  cache = { at: Date.now(), series };
  return series;
}

export async function createSeries(input: {
  title: string;
  niche?: string;
  description?: string;
  totalPartsPlanned?: number;
  channelId?: string;
}): Promise<Series | null> {
  const res = await fetch('/api/series', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    keepalive: true,
  });
  if (!res.ok) return null;
  const data = await res.json();
  cache = null; // invalidate
  return data.series as Series;
}

export async function updateSeries(id: string, patch: Partial<Series>): Promise<Series | null> {
  const res = await fetch(`/api/series/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    keepalive: true,
  });
  if (!res.ok) return null;
  const data = await res.json();
  cache = null;
  return data.series as Series;
}

export async function deleteSeries(id: string): Promise<boolean> {
  const res = await fetch(`/api/series/${id}`, { method: 'DELETE', keepalive: true });
  cache = null;
  return res.ok;
}

/** Fetch the budgeted prior-parts context for "about to generate Part N". */
export async function fetchPriorParts(
  seriesId: string,
  opts: { before: number; maxTokens?: number }
): Promise<SeriesPart[]> {
  const params = new URLSearchParams({ before: String(opts.before) });
  if (opts.maxTokens) params.set('maxTokens', String(opts.maxTokens));
  const res = await fetch(`/api/series/${seriesId}/parts?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.parts || []) as SeriesPart[];
}

/** Save a generated script as a new part of a series. keepalive so it
 *  survives an immediate navigation after generation completes.
 *  Invalidates the list cache so subsequent listSeries() calls reflect the
 *  bumped part_count. */
export async function saveSeriesPart(
  seriesId: string,
  input: { content: string; partNumber: number; modelId?: string; summary?: string; projectId?: string }
): Promise<{ id: string } | null> {
  const res = await fetch(`/api/series/${seriesId}/parts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    keepalive: true,
  });
  if (!res.ok) return null;
  const data = await res.json();
  cache = null;
  return data.script ? { id: data.script.id } : null;
}

/** Build the prompt-ready text block from a list of prior parts. The server
 *  already budgeted these, so we just stitch them together with clear
 *  section markers the model can anchor on. */
export function formatPriorPartsForPrompt(parts: SeriesPart[], seriesTitle: string, partNumber: number): string {
  if (parts.length === 0) return '';
  const sections = parts.map(p => {
    const header = p.kind === 'full'
      ? `### Part ${p.part_number ?? '?'} — FULL SCRIPT${p.truncated ? ' (middle truncated for length)' : ''}:`
      : `### Part ${p.part_number ?? '?'} — SUMMARY${p.source === 'slice' ? ' (auto-excerpted; no stored summary)' : ''}:`;
    return `${header}\n${p.body}`;
  }).join('\n\n');
  return `
SERIES CONTINUITY — THIS IS PART ${partNumber} OF "${seriesTitle}"
You are writing the next installment of an ongoing series. The prior parts are below.
When writing Part ${partNumber}:
  - Reference what happened previously (explicitly or implicitly) — do not pretend Part 1 never happened.
  - Do NOT repeat hooks, stories, or examples already used in earlier parts.
  - Advance the overarching narrative/theme.
  - Maintain consistent tone, voice, and any recurring phrases the series has established.
  - If the previous part ended on a cliffhanger or open question, address it in the hook.

${sections}
END OF SERIES CONTINUITY
`.trim();
}
