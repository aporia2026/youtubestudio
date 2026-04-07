'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, background: '#0a0a0f', color: '#e4e4e7' }}>
      <div style={{ maxWidth: 400, textAlign: 'center' }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Something went wrong</h2>
        <p style={{ fontSize: 14, color: '#a1a1aa', marginBottom: 16 }}>
          {error.message || 'An unexpected error occurred.'}
        </p>
        <button
          onClick={reset}
          style={{ padding: '8px 24px', borderRadius: 8, background: '#7c3aed', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14 }}
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
