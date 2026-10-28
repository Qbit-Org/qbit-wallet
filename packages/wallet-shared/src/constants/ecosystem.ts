import { ChainType } from '@qbit/wallet-types'

export type EcosystemEntryId =
  | 'qbit-testnet-faucet'
  | 'prism-testnet-pool'
  | 'prism-pool'
  | 'qbit-block-visualizer'
  | 'qbit-testnet-faucet-mainnet'
  | 'qbit-rich-list'
export type EcosystemArtwork = 'faucet' | 'mining-pool' | 'block-visualizer' | 'rich-list'

export interface EcosystemCatalogEntry {
  readonly id: EcosystemEntryId
  readonly title: string
  readonly description: string
  readonly canonicalUrl: string
  readonly supportedChains: readonly ChainType[]
  readonly artwork: EcosystemArtwork
  readonly tags: readonly string[]
  readonly operator: 'community'
  readonly source: 'qbit.org/ecosystem'
}

const TESTNET4_ONLY = Object.freeze([ChainType.QBIT_TESTNET4] as const)
const MAINNET_ONLY = Object.freeze([ChainType.QBIT_MAINNET] as const)

export const QBIT_ECOSYSTEM_CATALOG: readonly EcosystemCatalogEntry[] = Object.freeze([
  Object.freeze({
    id: 'qbit-testnet-faucet',
    title: 'Qbit Testnet Faucet',
    description:
      'A community-run faucet that dispenses QBT on the public testnet4 network for development and testing. Sends 1 QBT per request on a 24-hour cooldown, and lets you return unused coins so they recirculate to other builders.',
    canonicalUrl: 'https://qbit.robertclarke.com/',
    supportedChains: TESTNET4_ONLY,
    artwork: 'faucet',
    tags: Object.freeze(['Testnet4', 'Faucet']),
    operator: 'community',
    source: 'qbit.org/ecosystem',
  }),
  Object.freeze({
    id: 'prism-testnet-pool',
    title: 'Qbit Testnet Pool',
    description:
      'A hosted Qbit mining pool for the public Qbit testnet, powered by the open-source PRISM software. It lets miners work on the permissionless lane and receive payouts on-chain.',
    canonicalUrl: 'https://qbit.org/pool?network=testnet4',
    supportedChains: TESTNET4_ONLY,
    artwork: 'mining-pool',
    tags: Object.freeze(['Testnet4', 'PRISM', 'Mining pool']),
    operator: 'community',
    source: 'qbit.org/ecosystem',
  }),
  Object.freeze({
    id: 'prism-pool',
    title: 'Qbit Pool',
    description:
      'A hosted Qbit mining pool for Qbit Mainnet, powered by the open-source PRISM software. It lets miners work on the permissionless lane and receive payouts on-chain.',
    canonicalUrl: 'https://qbit.org/pool',
    supportedChains: MAINNET_ONLY,
    artwork: 'mining-pool',
    tags: Object.freeze(['Mainnet', 'PRISM', 'Mining pool']),
    operator: 'community',
    source: 'qbit.org/ecosystem',
  }),
  Object.freeze({
    id: 'qbit-block-visualizer',
    title: 'Qbit Block Visualizer',
    description:
      'A live visualization of Qbit Mainnet and testnet blocks, permissionless and AuxPoW activity, reward-era progress, block subsidies, and upcoming subsidy reductions.',
    canonicalUrl: 'https://qbit.miller.nz/',
    supportedChains: MAINNET_ONLY,
    artwork: 'block-visualizer',
    tags: Object.freeze(['Mainnet', 'Visualizer']),
    operator: 'community',
    source: 'qbit.org/ecosystem',
  }),
  Object.freeze({
    id: 'qbit-testnet-faucet-mainnet',
    title: 'Qbit Testnet Faucet',
    description:
      'A community-run faucet that dispenses QBT on the public testnet4 network for development and testing. Sends 1 QBT per request on a 24-hour cooldown, and lets you return unused coins so they recirculate to other builders.',
    canonicalUrl: 'https://qbit.robertclarke.com/?network=testnet4',
    supportedChains: MAINNET_ONLY,
    artwork: 'faucet',
    tags: Object.freeze(['Testnet4', 'Faucet']),
    operator: 'community',
    source: 'qbit.org/ecosystem',
  }),
  Object.freeze({
    id: 'qbit-rich-list',
    title: 'Qbit Rich List',
    description:
      "A live QBT holder distribution and emission tracker, rebuilt from Qbit's full UTXO set and refreshed every minute, with address balances and supply concentration.",
    canonicalUrl: 'https://qbitinfo.org/',
    supportedChains: MAINNET_ONLY,
    artwork: 'rich-list',
    tags: Object.freeze(['Mainnet', 'Rich list']),
    operator: 'community',
    source: 'qbit.org/ecosystem',
  }),
])

export function getEcosystemEntriesForChain(
  chainType: ChainType
): readonly EcosystemCatalogEntry[] {
  return QBIT_ECOSYSTEM_CATALOG.filter(entry => entry.supportedChains.includes(chainType))
}

export function getEcosystemEntry(entryId: EcosystemEntryId): EcosystemCatalogEntry {
  const entry = QBIT_ECOSYSTEM_CATALOG.find(candidate => candidate.id === entryId)
  if (!entry) {
    throw new Error(`Unknown ecosystem entry: ${String(entryId)}`)
  }
  return entry
}

export function getEcosystemNavigationUrl(entryId: EcosystemEntryId): string {
  const entry = getEcosystemEntry(entryId)
  const url = new URL(entry.canonicalUrl)

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.href !== entry.canonicalUrl
  ) {
    throw new Error(`Unsafe ecosystem URL for ${entry.id}`)
  }

  return url.href
}
