import { ReceivePage, RecoveryMigrationPage } from '../pages'
import { expect, test } from '../fixtures/test'
import {
  beginRegtestWalletRestoreThroughUi,
  FIXED_MNEMONIC,
  provisionDeterministicRegtestWallet,
  waitForAddressUsed,
} from '../support/wallet-setup'

const RECOVERY_PASSPHRASE = 'G3 recovery passphrase'
const SEPARATION_PASSPHRASE = 'G3 different passphrase'

interface AddressBalanceProbe {
  amount: string
  confirm_amount: string
  pending_amount: string
}

interface AccountProbe {
  address: string
  p2mr?: {
    hkdf: { index: number }
    signatureCounter: { provenance: string }
  }
}

interface KeyringProbe {
  index: number
  accounts: AccountProbe[]
}

interface RecoveryMigrationPlanProbe {
  amount: number
  fee: number
  status: 'prepared' | 'signed' | 'broadcast' | 'confirmed'
  txid?: string
  destinationAddress: string
  sourceIndex?: number
  destinationIndex?: number
}

interface RecoveryStateProbe {
  status: 'seed-only-restored' | 'migrating' | 'migrated'
  acknowledgement: 'required' | 'accepted'
  migration?: {
    destinationAddress: string
    plans: RecoveryMigrationPlanProbe[]
  }
  otherNetworksPendingRecovery?: boolean
}

function satsToAmount(satoshis: number): string {
  return (satoshis / 100_000_000).toFixed(8)
}

async function addressBalance(
  extension: Parameters<typeof provisionDeterministicRegtestWallet>[0],
  page: Parameters<typeof extension.requestWalletController>[0],
  address: string
): Promise<AddressBalanceProbe> {
  return extension.requestWalletController<AddressBalanceProbe>(page, 'getAddressBalance', [
    address,
  ])
}

async function waitForConfirmedBalance(
  extension: Parameters<typeof provisionDeterministicRegtestWallet>[0],
  page: Parameters<typeof extension.requestWalletController>[0],
  address: string,
  amount: string
): Promise<AddressBalanceProbe> {
  const expected = {
    amount,
    confirm_amount: amount,
    pending_amount: '0.00000000',
  }
  await expect
    .poll(() => addressBalance(extension, page, address), {
      timeout: 30_000,
      intervals: [250, 500, 1_000],
    })
    .toMatchObject(expected)
  return addressBalance(extension, page, address)
}

test('G3 recovery: wipes, proves passphrase separation, and restores funded floors', async ({
  extension,
  regtest,
}) => {
  test.setTimeout(15 * 60_000)

  const original = await provisionDeterministicRegtestWallet(extension, {
    words: FIXED_MNEMONIC,
    passphrase: RECOVERY_PASSPHRASE,
  })
  await original.home.openReceive()
  const originalReceive = new ReceivePage(original.page)
  const rotation = await originalReceive.rotateAddress()
  expect(rotation.previous).toBe(original.address)

  const firstFunding = await regtest.fund(rotation.previous, '0.005')
  await waitForAddressUsed(extension, original.page, rotation.previous)
  const secondFunding = await regtest.fund(rotation.current, '0.002')
  await waitForAddressUsed(extension, original.page, rotation.current)

  const expectedFirstBalance = await waitForConfirmedBalance(
    extension,
    original.page,
    rotation.previous,
    '0.00500000'
  )
  const expectedSecondBalance = await waitForConfirmedBalance(
    extension,
    original.page,
    rotation.current,
    '0.00200000'
  )
  regtest.trackTransaction(firstFunding)
  regtest.trackTransaction(secondFunding)

  await extension.wipeStorage(original.page)
  const separated = await provisionDeterministicRegtestWallet(extension, {
    words: FIXED_MNEMONIC,
    passphrase: SEPARATION_PASSPHRASE,
  })
  expect(separated.address).not.toBe(rotation.previous)
  expect(separated.address).not.toBe(rotation.current)
  expect(await addressBalance(extension, separated.page, separated.address)).toMatchObject({
    amount: '0.00000000',
    confirm_amount: '0.00000000',
    pending_amount: '0.00000000',
  })

  await extension.wipeStorage(separated.page)
  const restored = await beginRegtestWalletRestoreThroughUi(extension, {
    words: FIXED_MNEMONIC,
    passphrase: RECOVERY_PASSPHRASE,
  })
  expect(restored.reportSummary).toEqual({ accountsRestored: 2, network: 'Regtest' })
  expect(restored.restoreDurationMs).toBeGreaterThan(0)
  await restored.report.expectCounterMinimumWarning()
  await restored.report.expectNoConcurrentInstanceWarning()
  expect(await restored.report.isDiscoveryTruncated()).toBe(false)
  expect(await restored.report.hasNoActivityHint()).toBe(false)
  await restored.report.expectFloorsCompleted()
  await restored.report.continueToWallet()
  await restored.home.waitUntilReady()
  expect(await restored.home.networkLabel()).toContain('Regtest')

  const keyrings = await extension.requestWalletController<KeyringProbe[]>(
    restored.page,
    'getKeyrings'
  )
  const restoredKeyring = keyrings.find(keyring =>
    keyring.accounts.some(account => account.address === rotation.previous)
  )
  expect(restoredKeyring).toBeDefined()
  expect(restoredKeyring?.accounts.map(account => account.address)).toEqual([
    rotation.previous,
    rotation.current,
  ])
  expect(restoredKeyring?.accounts.map(account => account.p2mr?.hkdf.index)).toEqual([0, 1])
  expect(
    restoredKeyring?.accounts.map(account => account.p2mr?.signatureCounter.provenance)
  ).toEqual(['restored-floor', 'restored-floor'])

  expect(await addressBalance(extension, restored.page, rotation.previous)).toEqual(
    expectedFirstBalance
  )
  expect(await addressBalance(extension, restored.page, rotation.current)).toEqual(
    expectedSecondBalance
  )

  await restored.home.openReceive()
  const restoredReceive = new ReceivePage(restored.page)
  // Every restored index is already used, so opening receive derives a fresh
  // one, and on a mnemonic-restored keyring that re-arms and re-runs the full
  // on-chain floor scan before the address renders — the same work the
  // restore report waits minutes for.
  expect(await restoredReceive.previousAddresses(3 * 60_000)).toEqual(
    expect.arrayContaining([rotation.previous, rotation.current])
  )
  await restoredReceive.expectCounterProvenance('restored-floor')
  await restoredReceive.expectNoSafetyWarnings()

  await restored.page.goBack()
  await restored.home.waitUntilReady()
  await restored.home.expectSeedOnlyRecoveryWarning()
  const sourceKeyringIndex = restoredKeyring!.index
  const initialRecoveryState = await extension.requestWalletController<RecoveryStateProbe>(
    restored.page,
    'getQbitRecoveryState',
    [sourceKeyringIndex]
  )
  expect(initialRecoveryState).toMatchObject({
    status: 'seed-only-restored',
    acknowledgement: 'required',
  })

  await restored.home.acceptContinuedRecoveryUse()
  await expect
    .poll(
      () =>
        extension.requestWalletController<RecoveryStateProbe>(
          restored.page,
          'getQbitRecoveryState',
          [sourceKeyringIndex]
        ),
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toMatchObject({ status: 'seed-only-restored', acknowledgement: 'accepted' })

  await restored.home.openRecoveryMigration()
  const migration = new RecoveryMigrationPage(restored.page)
  const freshWords = await migration.createAndConfirmFreshSeed()
  expect(freshWords.length).toBe(24)
  expect(freshWords.join(' ') === FIXED_MNEMONIC.join(' ')).toBe(false)

  const review = await migration.review()
  const preparedState = await extension.requestWalletController<RecoveryStateProbe>(
    restored.page,
    'getQbitRecoveryState',
    [sourceKeyringIndex]
  )
  expect(preparedState.status).toBe('migrating')
  expect(preparedState.migration?.plans).toHaveLength(2)
  expect(preparedState.migration?.plans.every(plan => plan.status === 'prepared')).toBe(true)
  // Per-account sweep: each funded source pays its own contiguously allocated
  // destination account, so the two plans carry distinct destination
  // addresses and the review shows the exact mapping for each.
  const preparedPlans = preparedState.migration!.plans
  expect(preparedPlans.map(plan => plan.destinationIndex)).toEqual([0, 1])
  expect(preparedPlans.map(plan => plan.sourceIndex)).toEqual([0, 1])
  expect(new Set(preparedPlans.map(plan => plan.destinationAddress)).size).toBe(2)
  expect(review.destinations).toHaveLength(2)
  for (const [index, plan] of preparedPlans.entries()) {
    expect(review.destinations[index]).toContain(
      `${plan.destinationAddress.slice(0, 6)}...${plan.destinationAddress.slice(-6)}`
    )
    // The truncated line must still allow exact verification: the reveal
    // dialog shows the complete address before anything is signed.
    expect(await migration.revealDestination(index)).toBe(plan.destinationAddress)
    await migration.closeRevealedDestination()
  }
  // The recorded anchor is the destination wallet's first account.
  expect(preparedPlans[0]!.destinationAddress).toBe(preparedState.migration!.destinationAddress)
  expect(review.amount).toContain('QBT')
  expect(review.fee).toContain('QBT')
  expect(review.consequence).toContain('fresh destination')

  for (const plan of preparedPlans) {
    regtest.trackAccount(plan.destinationAddress)
  }
  await migration.confirmAndSign()
  await expect
    .poll(
      () =>
        extension.requestWalletController<RecoveryStateProbe>(
          restored.page,
          'getQbitRecoveryState',
          [sourceKeyringIndex]
        ),
      { timeout: 120_000, intervals: [250, 500, 1_000] }
    )
    .toMatchObject({
      status: 'migrating',
      migration: {
        plans: [
          { status: expect.stringMatching(/^(signed|broadcast)$/), txid: expect.any(String) },
          { status: expect.stringMatching(/^(signed|broadcast)$/), txid: expect.any(String) },
        ],
      },
    })

  const pendingState = await extension.requestWalletController<RecoveryStateProbe>(
    restored.page,
    'getQbitRecoveryState',
    [sourceKeyringIndex]
  )
  const migrationTxids = pendingState.migration!.plans.map(plan => plan.txid!)
  for (const txid of migrationTxids) {
    expect(txid).toMatch(/^[0-9a-f]{64}$/)
    await regtest.waitForMempoolTransaction(txid)
  }
  await regtest.mine(1)
  for (const txid of migrationTxids) {
    await expect
      .poll(
        () =>
          extension.requestWalletController<{ state: 'confirmed' | 'pending' | 'gone' }>(
            restored.page,
            'getQbitTxLifecycleStatus',
            [txid]
          ),
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toEqual({ state: 'confirmed' })
  }
  await migration.checkStatus()
  await migration.waitUntilComplete()

  const migratedState = await extension.requestWalletController<RecoveryStateProbe>(
    restored.page,
    'getQbitRecoveryState',
    [sourceKeyringIndex]
  )
  expect(migratedState.status).toBe('migrated')
  expect(migratedState.migration?.plans.every(plan => plan.status === 'confirmed')).toBe(true)
  // Other networks on this seed have not been migrated; the archived state
  // advertises them so the UI can point the user at the remaining sweeps.
  expect(migratedState.otherNetworksPendingRecovery).toBe(true)
  // Each sweep landed on its own destination account, preserving the source
  // account structure instead of consolidating into one address.
  for (const plan of migratedState.migration!.plans) {
    await expect
      .poll(() => addressBalance(extension, restored.page, plan.destinationAddress), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toMatchObject({
        amount: satsToAmount(plan.amount),
        confirm_amount: satsToAmount(plan.amount),
        pending_amount: '0.00000000',
      })
  }
  expect(await addressBalance(extension, restored.page, rotation.previous)).toMatchObject({
    amount: '0.00000000',
    confirm_amount: '0.00000000',
  })
  expect(await addressBalance(extension, restored.page, rotation.current)).toMatchObject({
    amount: '0.00000000',
    confirm_amount: '0.00000000',
  })

  await migration.returnHome()
  await restored.home.waitUntilReady()
  const finalKeyrings = await extension.requestWalletController<KeyringProbe[]>(
    restored.page,
    'getKeyrings'
  )
  const archivedSource = finalKeyrings.find(keyring => keyring.index === sourceKeyringIndex)
  expect(archivedSource).toBeDefined()
  await extension.requestWalletController<void>(restored.page, 'changeKeyring', [archivedSource, 0])
  await restored.page.reload({ waitUntil: 'domcontentloaded' })
  await restored.home.expectArchivedRecoveryWarning()
  // The archive is per network: this seed still holds unswept sibling
  // networks, and the archived card says so.
  await expect(restored.page.getByTestId('qbit-recovery-other-networks-hint')).toBeVisible()
})
