import { describe, expect, it, vi } from 'vitest';

import type { QbitRecoveryRemovalReason } from '@qbit/wallet-shared';

import {
  RECOVERY_REMOVAL_RISK_KEYS,
  RECOVERY_RESET_RISK_KEYS,
  riskMessageKeys,
  type RecoveryRiskMessageKeys
} from './index';

vi.mock('@qbit/wallet-state', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// The real Input pulls in the whole component library, which needs the
// extension's browser APIs; these tests render nothing.
vi.mock('../Input', () => ({ Input: () => null }));

const reasons = (list: unknown[]) => list as QbitRecoveryRemovalReason[];

// The reasons of every risk, some twice over several networks, and one
// reason that carries no detail.
const everyRisk = reasons([
  { role: 'source', network: 'regtest', status: 'migrating' },
  { role: 'source', network: 'mainnet', status: 'migrating' },
  { role: 'source', network: 'testnet', status: 'migrated' },
  { role: 'destination', network: 'regtest', status: 'migrating', hasInflightPlans: true },
  { role: 'destination', network: 'mainnet', status: 'migrating', hasInflightPlans: true },
  null
]);
const inOrder = (keys: RecoveryRiskMessageKeys) => [
  keys.sourceMigrating,
  keys.sourceMigrated,
  keys.destination,
  keys.inflight,
  keys.unverified
];

describe('riskMessageKeys', () => {
  it('says the removal lines by default, each risk once', () => {
    expect(riskMessageKeys(everyRisk)).toEqual([
      'qbit_recovery_removal_source_migrating',
      'qbit_recovery_removal_source_migrated',
      'qbit_recovery_removal_destination',
      'qbit_recovery_removal_inflight',
      'qbit_recovery_removal_unverified'
    ]);
  });

  it('maps the same reasons onto the same risks in the words it is given', () => {
    expect(riskMessageKeys(everyRisk, RECOVERY_REMOVAL_RISK_KEYS)).toEqual(inOrder(RECOVERY_REMOVAL_RISK_KEYS));
    expect(riskMessageKeys(everyRisk, RECOVERY_RESET_RISK_KEYS)).toEqual([
      'reset_wallet_recovery_source_migrating',
      'reset_wallet_recovery_source_migrated',
      'reset_wallet_recovery_destination',
      'reset_wallet_recovery_inflight',
      'reset_wallet_recovery_unverified'
    ]);
  });

  it.each([
    ['no reason', reasons([])],
    ['only reasons without detail', reasons([null, 'source', 7])],
    ['a role it does not know', reasons([{ role: 'observer', network: 'regtest' }])]
  ])('shows the broadest risk, once, for %s', (_name, given) => {
    expect(riskMessageKeys(given, RECOVERY_RESET_RISK_KEYS)).toEqual(['reset_wallet_recovery_unverified']);
    expect(riskMessageKeys(given)).toEqual(['qbit_recovery_removal_unverified']);
  });
});
