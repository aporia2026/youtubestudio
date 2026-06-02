'use client';

/**
 * ShortNativeQaSurface — Phase 15.2.
 *
 * The /qa page renders this when `medium=short_native`. Lists the
 * workspace's `short_native` rows; clicking one runs lean QA and shows
 * per-criterion scores + 3 concrete fixes.
 *
 * Single AI call per grade (~$0.02). Hook strength is computed
 * deterministically (Phase 1) and merged server-side, so the panel
 * always renders a complete result.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ShortRow } from '@/lib/shorts-types';

interface CriterionScore {
  score: number;
  reason: string;
}

interface QaResult {
  composite: number;
  hookStrength: CriterionScore;
  threeSecondRule: CriterionScore;
  payoffClarity: CriterionScore;
  captionReadable: CriterionScore;
  loopPotential: CriterionScore;
  verticalSafeZone: CriterionScore;
  fixes: string[];
}

const CRITERIA: Array<{ key: keyof QaResult; label: string }> = [
  { key: 'hookStrength', label: 'Hook strength' },
  { key: 'threeSecondRule', label: '3-second rule' },
  { key: 'payoffClarity', label: 'Payoff clarity' },
  { key: 'captionReadable', label: 'Caption readability' },
  { key: 'loopPotential', label: 'Loop potential' },
  { key: 'verticalSafeZone', label: 'Vertical safe-zone' },
];

function scorePill(score: number): { color: string; bg: string } {
  if (score >= 0.7) return { color: '#86efac', bg: 'rgba(34,197,94,0.18)' };
  if (score >= 0.5) return { color: '#fde68a', bg: 'rgba(245,158,11,0.18)' };
  return { color: '#fca5a5', bg: 'rgba(239,68,68,0.18)' };
}

export function ShortNativeQaSurface() {
  const [rows, setRows] = useState<ShortRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [result, setResult] = useState<QaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, lists short_native rows
        const res = await fetch('/api/shorts?medium=short_native&limit=50');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const list: ShortRow[] = (data.shorts || []).filter((r: ShortRow) => r.short_script);
        setRows(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load Shorts');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const grade = useCallback(async (id: string) => {
    setGrading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/shorts/${encodeURIComponent(id)}/qa`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data.qa as QaResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to grade');
      toast.error(e instanceof Error ? e.message : 'Failed to grade');
    } finally {
      setGrading(false);
    }
  }, []);

  const selectedRow = rows.find((r) => r.id === selectedId);

  return (
    <section
      style={{
        marginTop: 16,
        padding: 20,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        maxWidth: 920,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Lean Shorts QA</h2>
      <p style={{ marginTop: 6, marginBottom: 0, fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
        Hook, 3-second rule, payoff, caption readability, loop potential, vertical safe-zone. One pass, one model call (~$0.02).
      </p>

      {loading && (
        <p style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>Loading…</p>
      )}

      {!loading && rows.length === 0 && (
        <div
          style={{
            marginTop: 16,
            padding: 18,
            borderRadius: 10,
            border: '1px dashed rgba(255,255,255,0.12)',
            fontSize: 13,
            color: 'var(--text-secondary, rgba(255,255,255,0.6))',
          }}
        >
          No Shorts yet. Save a long-form script to fan out candidates, or use the Scripts page's
          Shorts mode to generate a new Short from a channel-video moment.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ marginTop: 14, display: 'flex', gap: 12 }}>
          <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
              Pick a Short to grade
            </span>
            <select
              value={selectedId ?? ''}
              onChange={(e) => {
                setSelectedId(e.target.value || null);
                setResult(null);
              }}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(0,0,0,0.2)',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <option value="">Pick one…</option>
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {(r.title || r.hook || r.short_script || '').slice(0, 80)}…
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => selectedId && grade(selectedId)}
            disabled={!selectedId || grading}
            style={{
              alignSelf: 'flex-end',
              padding: '8px 16px',
              borderRadius: 8,
              border: 'none',
              cursor: !selectedId || grading ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: 13,
              background: grading ? 'rgba(124,58,237,0.5)' : 'rgba(124,58,237,0.95)',
              color: '#fff',
              opacity: !selectedId ? 0.6 : 1,
            }}
          >
            {grading ? 'Grading…' : 'Run QA'}
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            border: '1px solid rgba(239,68,68,0.3)',
            background: 'rgba(239,68,68,0.08)',
            fontSize: 12,
            color: '#fca5a5',
          }}
        >
          {error}
        </div>
      )}

      {selectedRow && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: 'rgba(0,0,0,0.18)', fontSize: 13, lineHeight: 1.55 }}>
          {selectedRow.hook && <div><strong style={{ color: '#fbbf24' }}>{selectedRow.hook}</strong></div>}
          <div style={{ marginTop: 6, color: 'var(--text-secondary, rgba(255,255,255,0.75))', whiteSpace: 'pre-wrap' }}>
            {selectedRow.short_script}
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>Composite</span>
            <span
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 700,
                ...scorePill(result.composite),
              }}
            >
              {(result.composite * 100).toFixed(0)}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
            {CRITERIA.map(({ key, label }) => {
              const c = result[key] as CriterionScore;
              if (!c || typeof c !== 'object' || !('score' in c)) return null;
              const pill = scorePill(c.score);
              return (
                <div
                  key={key}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    background: 'rgba(0,0,0,0.18)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        padding: '2px 8px',
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        ...pill,
                      }}
                    >
                      {(c.score * 100).toFixed(0)}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                    {c.reason}
                  </div>
                </div>
              );
            })}
          </div>

          {result.fixes.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Fixes</h3>
              <ol style={{ marginTop: 8, paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.8))', lineHeight: 1.6 }}>
                {result.fixes.map((fix, i) => (
                  <li key={i}>{fix}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
