import type { Metadata, Viewport } from 'next';
import { NarratorPwaBoot } from '@/components/narrator/NarratorPwaBoot';

/** PWA + iOS web-app meta tags. The narrator portal is the only surface
 *  in this app that's installable as a standalone PWA — meta lives on
 *  this layout (scoped to /narrator/[token]) rather than the root so we
 *  don't accidentally expose install prompts on /editor / etc. */
export const metadata: Metadata = {
  title: 'Narrator Dashboard',
  manifest: '/narrator-manifest.json',
  appleWebApp: {
    capable: true,
    title: 'Narrator',
    statusBarStyle: 'black-translucent',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

/** Force a sensible mobile viewport — without this iOS ignores
 *  display:standalone and the recording UI clips the safe-area inset. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0d0d12',
};

export default function NarratorDashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen"
      style={{
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        // Respect iOS safe-area insets when running standalone.
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      <NarratorPwaBoot />
      {children}
    </div>
  );
}
