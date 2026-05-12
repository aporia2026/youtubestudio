/**
 * Niche-finder deep-dive page (server component).
 *
 * Reads the persisted report directly from the DB so first-paint
 * doesn't wait on a client fetch. When the report doesn't exist
 * for this slug + workspace yet, renders a friendly placeholder
 * that links back to the entry form. The (Regenerate) button is a
 * small client island.
 *
 * The AI memo is rendered through the same `markdownToBasicHtml`
 * helper that the weekly digest uses — server-side, with the
 * hardened XSS escaping from Phase 9.8.1. No raw model output ever
 * reaches React.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { getNicheReport } from '@/lib/niche-finder/db';
import { slugifyNiche } from '@/lib/niche-finder/slug';
import { markdownToBasicHtml } from '@/lib/weekly-digest';
import { ScoreChip } from '@/components/niche-finder/ScoreChip';
import { RegenerateButton } from '@/components/niche-finder/RegenerateButton';
import { SaveToWatchlistButton } from '@/components/niche-finder/SaveToWatchlistButton';
import { GenerateIdeasButton } from '@/components/niche-finder/GenerateIdeasButton';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function NicheDeepDivePage({ params }: PageProps) {
  const { slug } = await params;
  const canonical = slugifyNiche(slug);
  if (canonical !== slug) {
    redirect(`/insights/niches/${canonical}`);
  }

  const session = await requireUser();
  const report = await getNicheReport(session.ws, canonical);

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto', color: '#e2e8f0' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link
          href="/insights/niches"
          style={{ fontSize: 13, color: '#94a3b8', textDecoration: 'none' }}
        >
          ← Find another niche
        </Link>
        {report && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <SaveToWatchlistButton slug={report.slug} name={report.name} />
            <GenerateIdeasButton nicheName={report.name} clusters={report.clusters} />
            <RegenerateButton nicheText={report.name} />
          </div>
        )}
      </div>

      {!report ? (
        <PlaceholderNoReport slug={canonical} />
      ) : (
        <>
          <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 4 }}>{report.name}</h1>
          <p style={{ fontSize: 12, color: '#64748b', marginBottom: 24 }}>
            Generated{' '}
            {new Date(report.regenerated_at ?? report.generated_at).toLocaleString()} ·
            cached per workspace for re-visits
          </p>

          {/* Four-score grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 32,
            }}
          >
            <ScoreChip dimension="demand" score={report.scores.demand} />
            <ScoreChip dimension="supply" score={report.scores.supply} />
            <ScoreChip dimension="monetization" score={report.scores.monetization} />
            <ScoreChip dimension="fit" score={report.scores.fit} />
          </div>

          {/* Strategy memo */}
          {report.ai_memo && (
            <section
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 12,
                padding: 24,
                marginBottom: 32,
              }}
            >
              <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Strategy memo
              </h2>
              {/* The memo is server-rendered through markdownToBasicHtml
                  which only emits h1/h2/p/ul/li/strong with inline styles.
                  XSS hardening was completed in Phase 9.8.1. */}
              <div
                style={{ color: '#cbd5e1', lineHeight: 1.65 }}
                dangerouslySetInnerHTML={{ __html: markdownToBasicHtml(report.ai_memo) }}
              />
            </section>
          )}

          {/* Cluster breakdown */}
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Concept clusters
          </h2>
          <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
            The niche broken into {report.clusters.length} clusters of related videos. Each
            cluster is scored independently before we roll them up.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {report.clusters.map((cluster) => (
              <article
                key={cluster.centroidTerm}
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 12,
                  padding: 16,
                }}
              >
                <header style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0' }}>
                    {cluster.centroidTerm}
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>
                    {cluster.sampleSize} sampled videos · {cluster.topChannels.length} channels
                  </div>
                </header>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 16 }}>
                  <CompactScore label="Demand" value={cluster.scores.demand.label} />
                  <CompactScore label="Crowdedness" value={cluster.scores.supply.label} />
                  <CompactScore
                    label="Per 1k views"
                    value={`$${cluster.scores.monetization.lowUsdPerMille.toFixed(0)}–$${cluster.scores.monetization.highUsdPerMille.toFixed(0)}`}
                  />
                  <CompactScore label="Fit" value={cluster.scores.fit.label} />
                </div>

                {cluster.topChannels.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                      Top channels
                    </div>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13, color: '#cbd5e1' }}>
                      {cluster.topChannels.slice(0, 5).map((ch) => (
                        <li key={ch.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                          <span>{ch.title || ch.id}</span>
                          <span style={{ color: '#64748b' }}>{ch.subscriberCount.toLocaleString()} subs</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {cluster.topVideos.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                      Top videos
                    </div>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13, color: '#cbd5e1' }}>
                      {cluster.topVideos.slice(0, 5).map((v) => (
                        <li key={v.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', gap: 12 }}>
                          <a
                            href={`https://www.youtube.com/watch?v=${v.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#cbd5e1', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {v.title}
                          </a>
                          <span style={{ color: '#64748b', flexShrink: 0 }}>{v.viewCount.toLocaleString()} views</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CompactScore({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ color: '#64748b' }}>{label}</div>
      <div style={{ color: '#e2e8f0', fontWeight: 500, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function PlaceholderNoReport({ slug }: { slug: string }): React.ReactElement {
  return (
    <div style={{ textAlign: 'center', padding: '60px 24px', color: '#94a3b8' }}>
      <h1 style={{ fontSize: 22, color: '#e2e8f0', marginBottom: 12 }}>
        No report for &quot;{slug}&quot; yet
      </h1>
      <p style={{ fontSize: 14, lineHeight: 1.5, maxWidth: 420, margin: '0 auto 20px' }}>
        Niches need to be looked at before we can show them. Run this one from the entry page —
        it takes about 30 seconds.
      </p>
      <Link
        href="/insights/niches"
        style={{
          display: 'inline-block',
          padding: '10px 18px',
          background: '#22c55e',
          color: '#0a0e16',
          borderRadius: 10,
          textDecoration: 'none',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Look at a niche
      </Link>
    </div>
  );
}
