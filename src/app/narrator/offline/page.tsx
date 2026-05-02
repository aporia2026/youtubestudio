/**
 * Offline fallback for the narrator PWA.
 *
 * The service worker serves this page (via cache) when both network +
 * cached HTML are unavailable. Intentionally no client-side JS — has to
 * render even when the SW has zero JS chunks cached.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Offline — Narrator' };

export default function NarratorOfflinePage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-primary, #0d0d12)',
        color: 'var(--text-primary, #f5f5f5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: 420 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
          You&apos;re offline
        </h1>
        <p style={{ fontSize: 14, color: 'var(--text-muted, #888)', lineHeight: 1.55, marginBottom: 16 }}>
          Reconnect to load this script. Already-opened scripts will still work in the
          installed app — open them from your home-screen icon.
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-muted, #666)' }}>
          (When you&apos;re back online, this page will refresh automatically the next
          time you tap a link.)
        </p>
      </div>
    </div>
  );
}
