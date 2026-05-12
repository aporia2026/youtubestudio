'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { ReviewPage } from '@/components/review/ReviewPage';

export default function ReviewOwnerPlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const initialVersionId = searchParams.get('v') || undefined;
  // Deep link from the global comments inbox lands here with ?comment=<id>
  // so the matching comment can be scrolled/highlighted on mount.
  const initialCommentId = searchParams.get('comment') || undefined;

  return <ReviewPage ownerProjectId={id} initialVersionId={initialVersionId} initialCommentId={initialCommentId} />;
}
