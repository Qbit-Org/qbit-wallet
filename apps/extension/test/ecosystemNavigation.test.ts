import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/background/webapi/browser', () => ({
  browserTabsCreate: vi.fn().mockResolvedValue({ id: 42 })
}));

import { browserTabsCreate } from '@/background/webapi/browser';
import type { EcosystemEntryId } from '@qbit/wallet-shared';

import { openEcosystemEntry } from '../src/ui/pages/Main/ecosystemNavigation';

describe('openEcosystemEntry', () => {
  afterEach(() => {
    vi.mocked(browserTabsCreate).mockClear();
  });

  it.each<[EcosystemEntryId, string]>([
    ['qbit-testnet-faucet', 'https://qbit.robertclarke.com/'],
    ['prism-testnet-pool', 'https://qbit.org/pool?network=testnet4'],
    ['prism-pool', 'https://qbit.org/pool'],
    ['qbit-block-visualizer', 'https://qbit.miller.nz/'],
    ['qbit-testnet-faucet-mainnet', 'https://qbit.robertclarke.com/?network=testnet4'],
    ['qbit-rich-list', 'https://qbitinfo.org/']
  ])('opens %s exactly once in an active isolated tab', async (entryId, canonicalUrl) => {
    await openEcosystemEntry(entryId);

    expect(browserTabsCreate).toHaveBeenCalledTimes(1);
    expect(browserTabsCreate).toHaveBeenCalledWith({ url: canonicalUrl, active: true });
  });

  it('rejects a forged catalog ID before invoking the browser API', async () => {
    const forgedEntryId = 'https://attacker.invalid/' as EcosystemEntryId;

    await expect(openEcosystemEntry(forgedEntryId)).rejects.toThrow(
      'Unknown ecosystem entry: https://attacker.invalid/'
    );
    expect(browserTabsCreate).not.toHaveBeenCalled();
  });
});
