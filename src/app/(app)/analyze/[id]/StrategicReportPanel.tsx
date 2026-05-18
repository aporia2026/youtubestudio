'use client';

/**
 * Strategic insights tab — the human-readable side of the analysis.
 *
 * Layout intent: this is the part the creator skims. Read it top to
 * bottom, copy a sentence here, save an idea there. Avoid showing too
 * many micro-fields side-by-side; lean into prose-shaped sections
 * with strong section headers so the page scans cleanly.
 */
import type { StrategicReport, TranscriptChapter } from '@/lib/analyzer/types';

interface Props {
  report: StrategicReport;
  chapters: TranscriptChapter[];
}

export function StrategicReportPanel({ report, chapters }: Props): React.ReactElement {
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Section title="Hook">
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-tertiary)',
            marginBottom: 6,
          }}
        >
          First {Math.round(report.hook.duration_seconds)}s
        </div>
        <p style={prose}>
          <strong style={{ color: 'var(--text-primary)' }}>What works:</strong> {report.hook.what_works}
        </p>
        <p style={prose}>
          <strong style={{ color: 'var(--text-primary)' }}>How to replicate:</strong> {report.hook.how_to_replicate}
        </p>
      </Section>

      <Section title="Structure">
        <p style={prose}>{report.structure}</p>
      </Section>

      <Section title="Pacing">
        <p style={prose}>{report.pacing_analysis}</p>
      </Section>

      <Section title="Standout techniques">
        <BulletList items={report.standout_techniques} />
      </Section>

      <Section title="Weaknesses">
        <BulletList items={report.weaknesses} tone="warn" />
      </Section>

      <Section title="Replication ideas" emphasized>
        <BulletList items={report.replication_ideas} numbered />
      </Section>

      {chapters.length > 0 && (
        <Section title={`Chapters (${chapters.length})`}>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            {chapters.map((c, idx) => (
              <li
                key={`${c.start}-${idx}`}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'baseline',
                  padding: '4px 0',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--border-bright)',
                  fontSize: 13,
                  color: 'var(--text-secondary)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    minWidth: 90,
                  }}
                >
                  {formatTime(c.start)}–{formatTime(c.end)}
                </span>
                <span>{c.title}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  emphasized,
  children,
}: {
  title: string;
  emphasized?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      style={{
        background: emphasized ? 'rgba(124,58,237,0.05)' : 'var(--bg-card)',
        border: `1px solid ${emphasized ? 'rgba(124,58,237,0.30)' : 'var(--border-bright)'}`,
        borderRadius: 12,
        padding: 20,
      }}
    >
      <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function BulletList({
  items,
  numbered,
  tone,
}: {
  items: string[];
  numbered?: boolean;
  tone?: 'warn';
}): React.ReactElement {
  if (items.length === 0) {
    return <p style={{ ...prose, fontStyle: 'italic', color: 'var(--text-tertiary)' }}>None identified.</p>;
  }
  const Tag = numbered ? 'ol' : 'ul';
  return (
    <Tag
      style={{
        margin: 0,
        paddingLeft: 22,
        display: 'grid',
        gap: 8,
        color: tone === 'warn' ? '#fbbf24' : 'var(--text-secondary)',
        fontSize: 14,
        lineHeight: 1.55,
      }}
    >
      {items.map((it, idx) => (
        <li key={idx}>{it}</li>
      ))}
    </Tag>
  );
}

const prose: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 14,
  lineHeight: 1.6,
  color: 'var(--text-secondary)',
};

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
