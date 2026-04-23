import { ShareClient } from './ShareClient';

// Server component awaits the async params and passes the token as a plain prop.
// Splitting this way avoids needing a Suspense boundary around a client-side `use()` call.
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareClient token={token} />;
}
