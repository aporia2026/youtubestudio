'use client';

import { useState } from 'react';
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
