'use client';

/**
 * Per-row visibility into the auto-pipeline image-gen stage.
 *
 * Renders inside a video card when its stage is
 * `generating_production_doc_images`. Polls
 * `/api/auto-pipeline/videos/[id]/image-progress` every 8s and
 * shows:
 *
 *   - Counts strip: total / done / pending / retrying / exhausted.
 *   - A scrollable per-row grid with a thumbnail (when generated),
 *     status badge, attempt count, and the last error class +
 *     message when present.
 *   - A "Retry this row" button on each exhausted row that POSTs
 *     /image-progress/retry-row to clear the row's attempts +
 *     last_error so the next cron tick re-picks it.
 *
 * 2026-06-08 — closes the "no visibility / no control" gap.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

const POLL_INTERVAL_MS = 8_000;

type RowStatus =
  | 'done'
  | 'pending'
  | 'in_progress'
  | 'retrying'
  | 'exhausted'
  | 'skipped';

interface RowProgress {
  index: number;
  status: RowStatus;
  prompt_preview: string;
  visual_type: string | null;
  on_screen_text: string | null;
  thumbnail_url: string | null;
  attempts: number;
  last_error: { class: string; message: string; at: string } | null;
  retry_budget: number | null;
  group_id: string | null;
  variant_index: number;
  image_model_override: string | null;
}

interface AvailableModel {
  value: string;
  label: string;
  provider: string;
  hint: string | null;
}

interface ProgressPayload {
  stage: string;
  rows: RowProgress[];
  counts: {
    total: number;
    done: number;
    pending: number;
    retrying: number;
    exhausted: number;
    skipped: number;
  };
  cost_usd: number;
  style_preset?: string | null;
  message?: string;
  doc_image_model_override?: string | null;
  default_model?: string;
  available_models?: AvailableModel[];
}

export function ImageGenProgress({ videoId }: { videoId: string }) {
  const [data, setData] = useState<ProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [changingModel, setChangingModel] = useState<boolean>(false);
  const [rowModelOpen, setRowModelOpen] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/auto-pipeline/videos/${videoId}/image-progress`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(`Could not load image progress (${res.status}): ${text.slice(0, 200)}`);
        return;
      }
      const payload = (await res.json()) as ProgressPayload;
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [videoId]);

  useEffect(() => {
    void refresh();
    const handle = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [refresh]);

  const handleRetryRow = useCallback(
    async (rowIndex: number) => {
      if (retrying !== null) return;
      setRetrying(rowIndex);
      try {
        const res = await fetch(
          `/api/auto-pipeline/videos/${videoId}/image-progress/retry-row`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ row_index: rowIndex }),
          },
        );
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          alert(payload.error ?? `Retry failed (${res.status})`);
          return;
        }
        await refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setRetrying(null);
      }
    },
    [videoId, retrying, refresh],
  );

  const filteredRows = useMemo(() => {
    if (!data) return [] as RowProgress[];
    // Skip rows the stage doesn't generate (title cards etc.) so the
    // grid stays focused on actual image-gen work.
    return data.rows.filter((r) => r.status !== 'skipped');
  }, [data]);

  const handleChangeDocModel = useCallback(
    async (model: string | null, regenerate: 'failed' | 'all' | null) => {
      if (changingModel) return;
      setChangingModel(true);
      try {
        const res = await fetch(
          `/api/auto-pipeline/videos/${videoId}/image-progress/change-model`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scope: 'doc',
              model,
              regenerate: regenerate ?? undefined,
            }),
          },
        );
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          alert(payload.error ?? `Change failed (${res.status})`);
          return;
        }
        await refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setChangingModel(false);
      }
    },
    [videoId, changingModel, refresh],
  );

  const handleChangeRowModel = useCallback(
    async (rowIndex: number, model: string) => {
      try {
        const res = await fetch(
          `/api/auto-pipeline/videos/${videoId}/image-progress/change-model`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'row', model, row_index: rowIndex }),
          },
        );
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          alert(payload.error ?? `Change failed (${res.status})`);
          return;
        }
        setRowModelOpen(null);
        await refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    },
    [videoId, refresh],
  );

  if (error) {
    return (
      <div className="rounded border border-red-900 bg-red-950/40 p-3 text-xs text-red-300">
        {error}
      </div>
    );
  }
  if (!data) {
    return <p className="text-xs text-neutral-500">Loading image progress…</p>;
  }
  if (data.counts.total === 0) {
    return (
      <p className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-400">
        {data.message ?? 'No production_doc artefact yet.'}
      </p>
    );
  }

  const generatable = data.counts.total - data.counts.skipped;
  const progressPct = generatable === 0
    ? 0
    : Math.round((data.counts.done / generatable) * 100);

  return (
    <div className="space-y-3">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-3 text-xs">
          <h4 className="font-medium uppercase tracking-wide text-neutral-300">
            Image generation · {data.counts.done} of {generatable} done
          </h4>
          <span className="text-[10px] text-neutral-500">
            ${data.cost_usd.toFixed(2)} spent · auto-refresh every 8s
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-neutral-800">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-2 text-[10px]">
          <CountBadge label="done" count={data.counts.done} colour="emerald" />
          <CountBadge label="retrying" count={data.counts.retrying} colour="amber" />
          <CountBadge label="exhausted" count={data.counts.exhausted} colour="red" />
          <CountBadge label="pending" count={data.counts.pending} colour="neutral" />
          {data.counts.skipped > 0 && (
            <CountBadge label="skipped" count={data.counts.skipped} colour="neutral" />
          )}
        </div>
      </header>

      {data.available_models && data.available_models.length > 0 && (
        <DocModelPicker
          available={data.available_models}
          currentOverride={data.doc_image_model_override ?? null}
          defaultModel={data.default_model ?? null}
          busy={changingModel}
          onChange={handleChangeDocModel}
        />
      )}

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {filteredRows.map((row) => (
          <li
            key={row.index}
            className={`flex items-start gap-3 rounded border p-2 text-[11px] ${BORDER_BY_STATUS[row.status]}`}
          >
            <Thumbnail row={row} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] text-neutral-500">
                  #{row.index}
                  {row.variant_index > 0 && <span> · v{row.variant_index}</span>}
                </span>
                <StatusBadge status={row.status} />
              </div>
              <p className="line-clamp-2 text-neutral-300">{row.prompt_preview || row.visual_type || '(no prompt)'}</p>
              {row.on_screen_text && (
                <p className="text-[10px] text-amber-300/80">on-screen: {row.on_screen_text}</p>
              )}
              {row.last_error && (
                <div className="space-y-0.5 rounded bg-red-950/40 px-1.5 py-1 text-[10px] text-red-300">
                  <p>
                    <span className="font-semibold">{row.last_error.class}</span>
                    {' · '}
                    <span>
                      {row.attempts}/{row.retry_budget ?? '?'} attempts
                    </span>
                  </p>
                  <p className="line-clamp-2">{row.last_error.message}</p>
                </div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {row.status === 'exhausted' && (
                  <button
                    type="button"
                    onClick={() => void handleRetryRow(row.index)}
                    disabled={retrying === row.index}
                    className="rounded bg-amber-200 px-2 py-0.5 text-[10px] font-medium text-neutral-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
                  >
                    {retrying === row.index ? 'Retrying…' : '↻ Retry'}
                  </button>
                )}
                {data.available_models && data.available_models.length > 0 && (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setRowModelOpen((cur) => (cur === row.index ? null : row.index))}
                      className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
                      title={
                        row.image_model_override
                          ? `Per-row override: ${row.image_model_override}`
                          : 'Use a different model just for this row'
                      }
                    >
                      ⟲ Regen with model{row.image_model_override ? ' ✓' : ''}
                    </button>
                    {rowModelOpen === row.index && (
                      <div className="absolute left-0 z-10 mt-1 w-72 space-y-1 rounded border border-neutral-700 bg-neutral-900 p-2 shadow-xl">
                        <p className="text-[10px] text-neutral-400">
                          Picks the model + regenerates this row only.
                        </p>
                        <select
                          defaultValue={row.image_model_override ?? ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val) void handleChangeRowModel(row.index, val);
                          }}
                          className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[10px] text-neutral-100"
                        >
                          <option value="">— pick a model —</option>
                          {data.available_models!.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
                {row.image_model_override && (
                  <span
                    className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-300"
                    title={row.image_model_override}
                  >
                    model: {row.image_model_override.slice(0, 20)}
                    {row.image_model_override.length > 20 ? '…' : ''}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const BORDER_BY_STATUS: Record<RowStatus, string> = {
  done: 'border-emerald-900/60 bg-emerald-950/20',
  pending: 'border-neutral-800 bg-neutral-950',
  in_progress: 'border-amber-900/40 bg-amber-950/20',
  retrying: 'border-amber-900/60 bg-amber-950/30',
  exhausted: 'border-red-900/60 bg-red-950/30',
  skipped: 'border-neutral-900 bg-neutral-950',
};

function StatusBadge({ status }: { status: RowStatus }) {
  const map: Record<RowStatus, { label: string; class: string }> = {
    done: { label: '✓ done', class: 'bg-emerald-900/60 text-emerald-300' },
    pending: { label: 'pending', class: 'bg-neutral-800 text-neutral-400' },
    in_progress: { label: '… in flight', class: 'bg-amber-900/60 text-amber-300' },
    retrying: { label: '↻ retrying', class: 'bg-amber-900/60 text-amber-300' },
    exhausted: { label: '✗ exhausted', class: 'bg-red-900/60 text-red-300' },
    skipped: { label: '—', class: 'bg-neutral-900 text-neutral-500' },
  };
  const cfg = map[status];
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${cfg.class}`}>
      {cfg.label}
    </span>
  );
}

function CountBadge({
  label,
  count,
  colour,
}: {
  label: string;
  count: number;
  colour: 'emerald' | 'amber' | 'red' | 'neutral';
}) {
  const map: Record<typeof colour, string> = {
    emerald: 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300',
    amber: 'border-amber-900/60 bg-amber-950/30 text-amber-300',
    red: 'border-red-900/60 bg-red-950/30 text-red-300',
    neutral: 'border-neutral-800 bg-neutral-950 text-neutral-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${map[colour]}`}>
      <span className="font-semibold">{count}</span>
      <span>{label}</span>
    </span>
  );
}

function DocModelPicker({
  available,
  currentOverride,
  defaultModel,
  busy,
  onChange,
}: {
  available: AvailableModel[];
  currentOverride: string | null;
  defaultModel: string | null;
  busy: boolean;
  onChange: (model: string | null, regenerate: 'failed' | 'all' | null) => void;
}) {
  const [selected, setSelected] = useState<string>(currentOverride ?? defaultModel ?? '');
  const [regenerateMode, setRegenerateMode] = useState<'none' | 'failed' | 'all'>('none');

  const currentLabel = currentOverride
    ? available.find((m) => m.value === currentOverride)?.label ?? currentOverride
    : 'style preset default';

  return (
    <div className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-neutral-200">Image model</span>
        <span className="text-[10px] text-neutral-500">
          currently: <span className="text-neutral-300">{currentLabel}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={busy}
          className="flex-1 min-w-[180px] rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-100 disabled:opacity-60"
        >
          <option value="">— pick a model —</option>
          {available.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label} {m.hint ? `· ${m.hint.slice(0, 40)}${m.hint.length > 40 ? '…' : ''}` : ''}
            </option>
          ))}
        </select>
        <select
          value={regenerateMode}
          onChange={(e) => setRegenerateMode(e.target.value as 'none' | 'failed' | 'all')}
          disabled={busy}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-100 disabled:opacity-60"
          title="What to do with rows that already have images"
        >
          <option value="none">apply to future only</option>
          <option value="failed">also regen failed</option>
          <option value="all">also regen everything</option>
        </select>
        <button
          type="button"
          onClick={() => {
            if (!selected) {
              alert('Pick a model first.');
              return;
            }
            const verb = regenerateMode === 'all'
              ? 'switch the model AND regenerate EVERY row (including already-done ones)'
              : regenerateMode === 'failed'
              ? 'switch the model AND regenerate every failed row'
              : 'switch the default model (existing images stay, new rows use the new model)';
            if (!window.confirm(`${verb}?`)) return;
            onChange(selected, regenerateMode === 'none' ? null : regenerateMode);
          }}
          disabled={busy || !selected}
          className="rounded bg-neutral-200 px-3 py-1 text-[11px] font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
        {currentOverride && (
          <button
            type="button"
            onClick={() => {
              if (!window.confirm('Clear the override and fall back to the style preset default?')) return;
              onChange(null, null);
            }}
            disabled={busy}
            className="text-[10px] text-neutral-400 underline-offset-2 hover:underline disabled:opacity-50"
          >
            clear override
          </button>
        )}
      </div>
    </div>
  );
}

function Thumbnail({ row }: { row: RowProgress }) {
  if (row.thumbnail_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={row.thumbnail_url}
        alt={`Row ${row.index} preview`}
        className="h-14 w-14 shrink-0 rounded border border-neutral-800 object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded border border-dashed border-neutral-700 bg-neutral-950 text-[10px] text-neutral-500">
      {row.status === 'pending' ? '…' : row.status === 'exhausted' ? '✗' : '·'}
    </div>
  );
}
