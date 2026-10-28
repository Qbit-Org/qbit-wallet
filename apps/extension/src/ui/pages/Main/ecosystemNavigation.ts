import { browserTabsCreate } from '@/background/webapi/browser';
import { EcosystemEntryId, getEcosystemNavigationUrl } from '@qbit/wallet-shared';

type OpenTab = (params: { url: string; active: true }) => Promise<unknown>;

export async function openEcosystemEntry(
  entryId: EcosystemEntryId,
  openTab: OpenTab = browserTabsCreate
): Promise<unknown> {
  const url = getEcosystemNavigationUrl(entryId);
  return openTab({ url, active: true });
}
