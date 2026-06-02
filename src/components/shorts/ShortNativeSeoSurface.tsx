'use client';

/**
 * ShortNativeSeoSurface — Phase 15.2.
 *
 * The /seo page renders this when `medium=short_native`. Lists the
 * workspace's `short_native` rows with a script body; running grades
 * SEO via `/api/shorts/[id]/seo-native` and shows 4 graded titles,
 * 3 descriptions, 2 hashtag sets, plus a one-line notes summary.
 *
 * Saved seo_result is persisted on the row so re-opening the surface
 * shows the prior grading without a fresh AI call.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ShortRow, ShortSeoResult } from '@/lib/shorts-types';

function scorePill(score: number): { color: string; bg: string } {
  if (score >= 70) return { color: '#86efac', bg: 'rgba(34,197,94,0.18)' };
  if (score >= 50) return { color: '#fde68a', bg: 'rgba(245,158,11,0.18)' };
  return { color: '#fca5a5', bg: 'rgba(239,68,68,0.18)' };
}

export function ShortNativeSeoSurface() {
  const [rows, setRows] = useState<ShortRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [result, setResult] = useState<ShortSeoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads short_native rows
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

  // When a row is selected, pre-fill `result` with its saved seo_result
  // (if any) so the user sees the prior grading without re-running AI.
  useEffect(() => {
    if (!selectedId) {
      setResult(null);
      return;
    }
    const row = rows.find((r) => r.id === selectedId);
    setResult(row?.seo_result ?? null);
  }, [selectedId, rows]);

  const grade = useCallback(async (id: string) => {
    setGrading(true);
    setError(null);
    try {
      const res = await fetch(`/api/shorts/${encodeURIComponent(id)}/seo-native`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data.seo as ShortSeoResult);
      toast.success('SEO graded + saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to grade');
      toast.error(e instanceof Error ? e.message : 'Failed to grade');
    } finally {
      setGrading(false);
    }
  }, []);

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Could not copy'),
    );
  }

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
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Shorts SEO</h2>
      <p style={{ marginTop: 6, marginBottom: 0, fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
        Native rules: under 60 chars in titles, 150-char descriptions, 3-5 hashtags, no <code>#Shorts</code>{' '}
        injection (auto-classified in 2026), no chapters.
      </p>

      {loading && <p style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>Loading…</p>}

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
          No Shorts to grade. Save a long-form script (auto-fan-out) or generate one via the Scripts page in Shorts mode.
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
              onChange={(e) => setSelectedId(e.target.value || null)}
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
            {grading ? 'Grading…' : 'Grade SEO'}
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', fontSize: 12, color: '#fca5a5' }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 18 }}>
          {result.primary_keyword && (
            <div style={{ marginBottom: 14, fontSize: 13 }}>
              <span style={{ color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>Primary keyword:</span>{' '}
              <strong>{result.primary_keyword}</strong>
            </div>
          )}

          <Section title="Titles">
            {result.titles.map((t, i) => {
              const pill = scorePill(t.score);
              return (
                <Row key={i} score={t.score} pill={pill} text={t.text} rationale={t.rationale} onCopy={() => copy(t.text)} />
              );
            })}
          </Section>

          <Section title="Descriptions">
            {result.descriptions.map((d, i) => {
              const pill = scorePill(d.score);
              return (
                <Row key={i} score={d.score} pill={pill} text={d.text} rationale={d.rationale} onCopy={() => copy(d.text)} />
              );
            })}
          </Section>

          <Section title="Hashtag sets">
            {result.hashtag_sets.map((h, i) => {
              const pill = scorePill(h.score);
              const tagText = h.tags.map((t) => `#${t}`).join(' ');
              return (
                <Row key={i} score={h.score} pill={pill} text={tagText} rationale={h.rationale} onCopy={() => copy(tagText)} />
              );
            })}
          </Section>

          {result.notes && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'rgba(124,58,237,0.06)', fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.8))' }}>
              <strong style={{ color: 'var(--text-primary)' }}>Notes:</strong> {result.notes}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0, marginBottom: 8, fontSize: 13, fontWeight: 600 }}>{title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function Row({
  score,
  pill,
  text,
  rationale,
  onCopy,
}: {
  score: number;
  pill: { color: string; bg: string };
  text: string;
  rationale: string;
  onCopy: () => void;
}) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, ...pill }}>{score}</span>
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1, lineHeight: 1.5 }}>{text}</span>
        <button
          type="button"
          onClick={onCopy}
          style={{
            padding: '4px 10px',
            borderRadius: 7,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          Copy
        </button>
      </div>
      {rationale && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
          {rationale}
        </div>
      )}
    </div>
  );
}
