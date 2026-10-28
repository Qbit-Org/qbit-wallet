export interface BundledPhishingPolicyMetadata {
  readonly policyVersion: string
  readonly reviewedAt: string
  readonly sourceRepository: string
  readonly sourceRevision: string
  readonly sourceBlob: string
  readonly sourcePath: string
  readonly sourceLicense: string
}

/**
 * Qbit-owned release policy seeded from a pinned, reviewed source snapshot.
 *
 * The source contained 30 entries. Two path-bearing entries were normalized to
 * hostnames and one duplicate was removed, producing 29 unique domains. Qbit
 * matches only exact hostnames and their subdomains; source fuzzy and
 * whitelist data are intentionally excluded.
 */
export const BUNDLED_PHISHING_POLICY_METADATA: BundledPhishingPolicyMetadata =
  Object.freeze({
    policyVersion: 'qbit-static-v1',
    reviewedAt: '2026-07-21',
    sourceRepository: 'https://github.com/unisat-wallet/phishing-detect',
    sourceRevision: '62078d24175a1af12715e5acaa2b8cbf77abda03',
    sourceBlob: '0f2812cb5f7c5ae1b188daa7ba7660b9ffd860fb',
    sourcePath: 'phishing_sites.json',
    sourceLicense: 'MIT with reserved UniSat brand name and logo',
  })

export const BUNDLED_PHISHING_DENYLIST: readonly string[] = Object.freeze([
  'unisat.be',
  'unissat.io',
  'unisast.io',
  'unilsat.io',
  'unisatwallets.io',
  'unisat-wallets.io',
  'unisat.fi',
  'unisatnode.io',
  'web3resp.com',
  'unisatswallet.io',
  'node.unisatio.network',
  'unisat-node.pages.dev',
  'unisat-mainnet.pages.dev',
  'unisat.live',
  'unisat-io.vercel.app',
  'unisatmint.io',
  'unisatrpc.io',
  'api.network-fixtool.org',
  'unisatwallet.com',
  'unisatweb.pages.dev',
  'dashboardprotocol.com',
  'defidapponline.com',
  'ordinalpunks.pro',
  'fractalbitcoin.net',
  'pizzaswap.app',
  'ghaeapost-gh.ink',
  'app.fractalbrc.store',
  'unisat.repaironchain.com',
  'unisatos.com',
])
