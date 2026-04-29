'use client';

import { use } from 'react';
import { ReviewPage } from '@/components/review/ReviewPage';

export default function ReviewTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <ReviewPage token={token} />;
}
