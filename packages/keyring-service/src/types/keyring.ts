export { ADDRESS_TYPES, KeyringType } from '@qbit/wallet-shared'

// ToSignInput interface defined here to avoid circular imports
export interface ToSignInput {
  index: number
  publicKey: string
  useTweakedSigner?: boolean
  disableTweakSigner?: boolean
  tapLeafHashToSign?: Buffer | string
  sighashTypes?: number[] | undefined
}

export interface Keyring {
  type: string
  mfp?: string
  accounts?: string[]
  /** Restored Qbit keyrings refuse to sign until floor reconstruction completes. */
  pqcFloorsPending?: boolean
  /** Latched when a floor scan detected activity beyond known indexes (two-live-wallets hazard). */
  pqcConcurrentInstanceHint?: boolean
  /** True for every keyring created from user-entered mnemonic recovery. */
  pqcRestoredFromMnemonic?: boolean
  qbitReceiveStates?: Record<string, any>

  serialize(): Promise<any>
  deserialize(opts: any): Promise<void>
  /** Roll a serialize() snapshot back onto this live instance without replacing it. */
  restoreAccountSnapshot?(snapshot: any): void
  addAccounts(n: number): Promise<string[]>
  getAccounts(): Promise<string[]>
  signTransaction(psbt: any, inputs: ToSignInput[]): Promise<any>
  signMessage(address: string, message: string): Promise<string>
  verifyMessage(address: string, message: string, sig: string): Promise<boolean>
  exportAccount(address: string): Promise<string>
  removeAccount(address: string): void

  // Optional methods for different keyring types
  unlock?(): Promise<void>
  getFirstPage?(): Promise<{ address: string; index: number }[]>
  getNextPage?(): Promise<{ address: string; index: number }[]>
  getPreviousPage?(): Promise<{ address: string; index: number }[]>
  getAddresses?(start: number, end: number): { address: string; index: number }[]
  getIndexByAddress?(address: string): number | null

  getAccountsWithBrand?(): { address: string; index: number }[]
  activeAccounts?(indexes: number[]): string[]
  prepareForMnemonicRestore?(
    indexes: number[],
    addressDiscoveryComplete?: boolean,
    network?: string
  ): void
  rearmPqcRestoreFloors?(): boolean

  changeHdPath?(hdPath: string): void
  getAccountByHdPath?(hdPath: string, index: number): string
  exportP2mrDescriptors?(network?: string): Promise<any>
  getPqcSignatureCounter?(address: string): Promise<number>
  getPqcSignatureCounterPubkey?(address: string): Promise<string>
  getPqcSignatureCounterMetadata?(address: string): Promise<any>
  assertPqcSignatureCounterAvailable?(address: string, count?: number): Promise<void>
  reservePqcSignatureCounter?(address: string, count?: number): Promise<any>
  rollbackPqcSignatureCounterReservation?(address: string, reservation: any): Promise<void>
  applyPqcSignatureCounterFloor?(
    address: string,
    observedCounter: number,
    provenance?: any
  ): Promise<any>
  scanPqcSignatureCounterFloors?(observe: any, options?: { lookahead?: number }): Promise<any>
  getQbitReceiveState?(network: string): any
  getQbitReceiveAccount?(index: number): Promise<any>
  replaceQbitReceiveState?(network: string, state: any, activeIndexes?: number[]): void
  setQbitReceiveIntent?(network: string, index: number): Promise<any>
  recordQbitReceiveActivity?(network: string, indexes: readonly number[]): boolean
  markQbitReceiveIndexesIssued?(network: string, indexes: readonly number[]): boolean
  getPqcSignatureCacheEntry?(address: string, cacheKey: string): Promise<any>
  estimatePqcSignatureCacheMisses?(
    address: string,
    orderedCacheKeys: readonly string[]
  ): Promise<number>
  cachePqcSignature?(
    address: string,
    cacheKey: string,
    signatureHex: string,
    counter: number,
    createdAt?: number
  ): Promise<any>
  signPqcDigest?(address: string, digest: Uint8Array): Promise<Uint8Array>
  getQbitRecoveryState?(): any
  effectiveQbitRecoveryStatus?(network?: string): string
  restoreQbitRecoveryState?(state: any): void
  acknowledgeQbitRecoveryRisk?(): any
  dismissQbitRecoveryWarning?(): any
  beginQbitRecoveryMigration?(network: string, migration: any): any
  replaceQbitRecoveryMigrationPlans?(network: string, plans: any[]): any
  updateQbitRecoveryMigrationPlan?(network: string, planId: string, update: any): any
  markQbitRecoveryMigrated?(
    network: string,
    options?: { allowIncompletePlanRecord?: boolean }
  ): any
  completeQbitRecoveryAddressDiscovery?(network: string): any
  reopenQbitRecoveryMigration?(network: string, planIds: readonly string[]): any
  deriveContextHash?(
    publicKey: string,
    appName: string,
    canonicalNetworkName: string,
    context: string,
  ): Promise<string>
}

export type KeyringClass = (new (opts?: unknown) => Keyring) & { type: string }
