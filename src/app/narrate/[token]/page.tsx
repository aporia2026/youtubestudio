'use client';

import { use } from 'react';
import { NarratorPortal } from '@/components/narrator/NarratorPortal';

export default function NarrateTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <NarratorPortal token={token} />;
}
