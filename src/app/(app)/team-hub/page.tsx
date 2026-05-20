'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * /team-hub — legacy URL, now a permanent client-side redirect to
 * /team?view=board. Any existing query params (`?person`, `?tab`,
 * `?surface`) are forwarded so deep-linked bookmarks keep working.
 *
 * Keeping this file as a redirect (rather than deleting the directory)
 * means bookmarks, Slack links, and the iframed embed mode that
 * `AppLayout` recognises by the URL fragment still resolve.
 */
export default function TeamHubRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', 'board');
    router.replace(`/team?${params.toString()}`);
  }, [router, searchParams]);

  return null;
}
