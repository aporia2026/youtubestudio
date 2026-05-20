import { HubLanding } from '@/components/layout/HubLanding';
import { getHubByLabel } from '@/components/layout/nav-catalog';

export default function CreateHubPage() {
  return <HubLanding hub={getHubByLabel('Create')} />;
}
