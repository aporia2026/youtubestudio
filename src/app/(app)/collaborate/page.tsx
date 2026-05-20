import { HubLanding } from '@/components/layout/HubLanding';
import { getHubByLabel } from '@/components/layout/nav-catalog';

export default function CollaborateHubPage() {
  return <HubLanding hub={getHubByLabel('Collaborate')} />;
}
