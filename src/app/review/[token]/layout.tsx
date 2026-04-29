import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Video Review',
};

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {children}
    </div>
  );
}
