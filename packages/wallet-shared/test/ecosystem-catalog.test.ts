import { describe, expect, it } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

import {
  QBIT_ECOSYSTEM_CATALOG,
  getEcosystemEntriesForChain,
  getEcosystemNavigationUrl,
} from '../src/constants/ecosystem'

describe('Qbit ecosystem catalog', () => {
  it('contains exactly the release-pinned qbit.org entries', () => {
    expect(QBIT_ECOSYSTEM_CATALOG).toEqual([
      {
        id: 'qbit-testnet-faucet',
        title: 'Qbit Testnet Faucet',
        description:
          'A community-run faucet that dispenses QBT on the public testnet4 network for development and testing. Sends 1 QBT per request on a 24-hour cooldown, and lets you return unused coins so they recirculate to other builders.',
        canonicalUrl: 'https://qbit.robertclarke.com/',
        supportedChains: [ChainType.QBIT_TESTNET4],
        artwork: 'faucet',
        tags: ['Testnet4', 'Faucet'],
        operator: 'community',
        source: 'qbit.org/ecosystem',
      },
      {
        id: 'prism-testnet-pool',
        title: 'Qbit Testnet Pool',
        description:
          'A hosted Qbit mining pool for the public Qbit testnet, powered by the open-source PRISM software. It lets miners work on the permissionless lane and receive payouts on-chain.',
        canonicalUrl: 'https://qbit.org/pool?network=testnet4',
        supportedChains: [ChainType.QBIT_TESTNET4],
        artwork: 'mining-pool',
        tags: ['Testnet4', 'PRISM', 'Mining pool'],
        operator: 'community',
        source: 'qbit.org/ecosystem',
      },
      {
        id: 'prism-pool',
        title: 'Qbit Pool',
        description:
          'A hosted Qbit mining pool for Qbit Mainnet, powered by the open-source PRISM software. It lets miners work on the permissionless lane and receive payouts on-chain.',
        canonicalUrl: 'https://qbit.org/pool',
        supportedChains: [ChainType.QBIT_MAINNET],
        artwork: 'mining-pool',
        tags: ['Mainnet', 'PRISM', 'Mining pool'],
        operator: 'community',
        source: 'qbit.org/ecosystem',
      },
      {
        id: 'qbit-block-visualizer',
        title: 'Qbit Block Visualizer',
        description:
          'A live visualization of Qbit Mainnet and testnet blocks, permissionless and AuxPoW activity, reward-era progress, block subsidies, and upcoming subsidy reductions.',
        canonicalUrl: 'https://qbit.miller.nz/',
        supportedChains: [ChainType.QBIT_MAINNET],
        artwork: 'block-visualizer',
        tags: ['Mainnet', 'Visualizer'],
        operator: 'community',
        source: 'qbit.org/ecosystem',
      },
      {
        id: 'qbit-testnet-faucet-mainnet',
        title: 'Qbit Testnet Faucet',
        description:
          'A community-run faucet that dispenses QBT on the public testnet4 network for development and testing. Sends 1 QBT per request on a 24-hour cooldown, and lets you return unused coins so they recirculate to other builders.',
        canonicalUrl: 'https://qbit.robertclarke.com/?network=testnet4',
        supportedChains: [ChainType.QBIT_MAINNET],
        artwork: 'faucet',
        tags: ['Testnet4', 'Faucet'],
        operator: 'community',
        source: 'qbit.org/ecosystem',
      },
      {
        id: 'qbit-rich-list',
        title: 'Qbit Rich List',
        description:
          "A live QBT holder distribution and emission tracker, rebuilt from Qbit's full UTXO set and refreshed every minute, with address balances and supply concentration.",
        canonicalUrl: 'https://qbitinfo.org/',
        supportedChains: [ChainType.QBIT_MAINNET],
        artwork: 'rich-list',
        tags: ['Mainnet', 'Rich list'],
        operator: 'community',
        source: 'qbit.org/ecosystem',
      },
    ])
    expect(new Set(QBIT_ECOSYSTEM_CATALOG.map(entry => entry.id)).size).toBe(6)
  })

  it('shows the Testnet4 community tools on Testnet4', () => {
    expect(getEcosystemEntriesForChain(ChainType.QBIT_TESTNET4).map(entry => entry.id)).toEqual([
      'qbit-testnet-faucet',
      'prism-testnet-pool',
    ])
  })

  it('shows the Mainnet community tools on Mainnet in catalog order', () => {
    expect(getEcosystemEntriesForChain(ChainType.QBIT_MAINNET).map(entry => entry.id)).toEqual([
      'prism-pool',
      'qbit-block-visualizer',
      'qbit-testnet-faucet-mainnet',
      'qbit-rich-list',
    ])
  })

  it('shows no community tools on regtest', () => {
    expect(getEcosystemEntriesForChain(ChainType.QBIT_REGTEST)).toEqual([])
  })

  it('returns only exact canonical HTTPS URLs for known IDs', () => {
    expect(getEcosystemNavigationUrl('qbit-testnet-faucet')).toBe('https://qbit.robertclarke.com/')
    expect(getEcosystemNavigationUrl('prism-testnet-pool')).toBe('https://qbit.org/pool?network=testnet4')
    expect(getEcosystemNavigationUrl('prism-pool')).toBe('https://qbit.org/pool')
    expect(getEcosystemNavigationUrl('qbit-block-visualizer')).toBe('https://qbit.miller.nz/')
    expect(getEcosystemNavigationUrl('qbit-testnet-faucet-mainnet')).toBe(
      'https://qbit.robertclarke.com/?network=testnet4'
    )
    expect(getEcosystemNavigationUrl('qbit-rich-list')).toBe('https://qbitinfo.org/')
    expect(() => getEcosystemNavigationUrl('forged-entry' as never)).toThrow(
      'Unknown ecosystem entry'
    )
  })

  it('cannot be mutated at runtime', () => {
    expect(Object.isFrozen(QBIT_ECOSYSTEM_CATALOG)).toBe(true)
    for (const entry of QBIT_ECOSYSTEM_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.supportedChains)).toBe(true)
      expect(Object.isFrozen(entry.tags)).toBe(true)
    }
  })
})
