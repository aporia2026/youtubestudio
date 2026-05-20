import { HubLanding } from '@/components/layout/HubLanding';
import { getHubByLabel } from '@/components/layout/nav-catalog';

export default function GrowHubPage() {
  return <HubLanding hub={getHubByLabel('Grow')} />;
}
