'use client';

import { useState } from 'react';
import { Sidebar } from './Sidebar';
import { GlobalCommandPalette } from './GlobalCommandPalette';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(p => !p)}
      />
      <main className="flex-1 overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
        {children}
      </main>
      <GlobalCommandPalette />
    </div>
  );
}
