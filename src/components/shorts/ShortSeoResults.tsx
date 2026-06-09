'use client';

/**
 * Shared renderer for a `ShortSeoResult` — graded titles, descriptions, and
 * hashtag sets with score pills + copy buttons, plus the primary keyword and
 * notes. Used by both the standalone `/seo` surface (ShortNativeSeoSurface)
 * and the inline SEO section in the Short editor, so the two never drift.
 */

import { toast } from 'sonner';
import type { ShortSeoResult } from '@/lib/shorts-types';
import { combinedYoutubeTagsLength } from '@/lib/shorts-seo-tags';

function scorePill(score: number): { color: string; bg: string } {
  if (score >= 70) return { color: '#86efac', bg: 'rgba(34,197,94,0.18)' };
  if (score >= 50) return { color: '#fde68a', bg: 'rgba(245,158,11,0.18)' };
  return { color: '#fca5a5', bg: 'rgba(239,68,68,0.18)' };
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Copied'),
    () => toast.error('Could not copy'),
  );
}

export function ShortSeoResults({ result }: { result: ShortSeoResult }) {
  return (
    <div>
      {result.primary_keyword && (
        <div style={{ marginBottom: 14, fontSize: 13 }}>
          <span style={{ color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>Primary keyword:</span>{' '}
          <strong>{result.primary_keyword}</strong>
        </div>
      )}

      <Section title="Titles">
        {result.titles.map((t, i) => (
          <Row key={i} score={t.score} pill={scorePill(t.score)} text={t.text} rationale={t.rationale} onCopy={() => copy(t.text)} />
        ))}
      </Section>

      <Section title="Descriptions">
        {result.descriptions.map((d, i) => (
          <Row key={i} score={d.score} pill={scorePill(d.score)} text={d.text} rationale={d.rationale} onCopy={() => copy(d.text)} />
        ))}
      </Section>

      <Section title="Hashtag sets (visible in description)">
        {result.hashtag_sets.map((h, i) => {
          const tagText = h.tags.map((t) => `#${t}`).join(' ');
          return (
            <Row key={i} score={h.score} pill={scorePill(h.score)} text={tagText} rationale={h.rationale} onCopy={() => copy(tagText)} />
          );
        })}
      </Section>

      {result.tags && result.tags.length > 0 && (
        <Section title={`YouTube tags (invisible metadata · ${result.tags.length} of 30)`}>
          <div style={{ padding: 12, borderRadius: 10, background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.25)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {result.tags.map((t) => (
                <span
                  key={t}
                  style={{
                    fontSize: 12,
                    padding: '3px 9px',
                    borderRadius: 999,
                    background: 'rgba(124,58,237,0.16)',
                    color: 'var(--text-secondary, rgba(255,255,255,0.85))',
                    border: '1px solid rgba(124,58,237,0.35)',
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
              <span>
                {combinedYoutubeTagsLength(result.tags)} / 500 chars used (incl. separators + quotes)
              </span>
              <button
                type="button"
                onClick={() => copy((result.tags ?? []).join(', '))}
                style={{
                  fontSize: 11,
                  padding: '3px 10px',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--text-secondary, rgba(255,255,255,0.7))',
                  border: '1px solid rgba(255,255,255,0.15)',
                  cursor: 'pointer',
                }}
              >
                Copy comma-list
              </button>
            </div>
          </div>
        </Section>
      )}

      {result.notes && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'rgba(124,58,237,0.06)', fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.8))' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Notes:</strong> {result.notes}
        </div>
      )}
    </div>
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
