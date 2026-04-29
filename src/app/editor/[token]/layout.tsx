import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Editor Dashboard' };

export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {children}
    </div>
  );
}
