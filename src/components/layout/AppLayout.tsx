'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { GlobalCommandPalette } from './GlobalCommandPalette';
import { AppTopBar, type AppTopBarUser } from './AppTopBar';
import type { ChannelOption } from './ChannelSwitcher';

export function AppLayout({
  children,
  user,
  channels,
  activeChannelId,
}: {
  children: React.ReactNode;
  user: AppTopBarUser;
  channels: ChannelOption[];
  activeChannelId: string | null;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Embed mode: hide the sidebar / top bar / command palette so the page
  // can be iframed by /team-hub (and any future surface) without the
  // chrome bleeding through.
  //
  // Two activation paths:
  //   1. `?team-hub-embed=1` URL param — explicit opt-in from the parent
  //      iframe-mounter. Reliable across navigations only as long as the
  //      param survives — internal links inside the iframed page would
  //      lose it on click.
  //   2. iframe detection (`window !== window.top`) — covers the case
  //      where the user clicks an internal link inside the iframe and
  //      loses the param. Computed in an effect because window is not
  //      available during SSR.
  const searchParams = useSearchParams();
  const embedFromParam = searchParams.get('team-hub-embed') === '1';
  const [embedFromIframe, setEmbedFromIframe] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        setEmbedFromIframe(window.top !== null && window.top !== window);
      } catch {
        // Cross-origin parent throws on `.top` access. Treat as iframe-mode
        // so the chrome stays hidden.
        setEmbedFromIframe(true);
      }
    }
  }, []);
  const embed = embedFromParam || embedFromIframe;

  if (embed) {
    return (
      <main className="h-screen overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
        {children}
      </main>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(p => !p)}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        <AppTopBar
          user={user}
          channels={channels}
          activeChannelId={activeChannelId}
        />
        <main className="flex-1 overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
          {children}
        </main>
      </div>
      <GlobalCommandPalette />
    </div>
  );
}
