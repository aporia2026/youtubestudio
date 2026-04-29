import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Unsubscribe' };

export default function UnsubscribeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {children}
    </div>
  );
}
