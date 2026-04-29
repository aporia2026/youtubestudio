'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { ReviewPage } from '@/components/review/ReviewPage';

export default function ReviewOwnerPlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const initialVersionId = searchParams.get('v') || undefined;

  return <ReviewPage ownerProjectId={id} initialVersionId={initialVersionId} />;
}
