import { browserTabsCreate } from '@/background/webapi/browser';

export const QBIT_MINE_URL = 'https://qbit.org/mine?utm_source=qbit-wallet-extension';

type OpenTab = (params: { url: string; active: true }) => Promise<unknown>;

export async function openQbitMine(openTab: OpenTab = browserTabsCreate): Promise<unknown> {
  return openTab({ url: QBIT_MINE_URL, active: true });
}
