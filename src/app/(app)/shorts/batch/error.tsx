'use client';

/**
 * Route-level error boundary for /shorts/batch. Lets the user see
 * the actual error digest (which is opaque in the global Next.js
 * "Something went wrong" page) so we can correlate to the Vercel
 * function logs.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 */

import { useEffect } from 'react';

export default function BatchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the browser console so a power-user can paste it
    // back to debug. The digest is the only handle into the server
    // function logs.
    console.error('[shorts-batch route error]', {
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <div className="rounded-lg border border-red-300 bg-red-50 p-6 dark:border-red-700 dark:bg-red-900/20">
        <h1 className="text-xl font-semibold text-red-900 dark:text-red-200">
          Couldn't load the bulk-batch page
        </h1>
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error.message || 'Unknown error during server render.'}
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-red-700 dark:text-red-400">
            digest: {error.digest}
          </p>
        )}
        <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          The digest above maps to a single line in the Vercel function logs
          for this deployment — paste it into the dashboard's log search to
          find the underlying exception.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900"
          >
            Try again
          </button>
          <a
            href="/shorts"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            ← Back to Shorts
          </a>
        </div>
      </div>
    </div>
  );
}
