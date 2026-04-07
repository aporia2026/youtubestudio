'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Page error:', error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center p-8">
      <div className="glass rounded-xl p-8 max-w-md text-center space-y-4">
        <div className="w-12 h-12 mx-auto rounded-full flex items-center justify-center"
          style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          Something went wrong
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {error.message || 'An unexpected error occurred. Please try again.'}
        </p>
        <button
          onClick={reset}
          className="btn-primary px-6 py-2 mx-auto"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
