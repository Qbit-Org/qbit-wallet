import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QbitExternalSigningLock, QbitSendBroadcastClaim } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import {
  QBIT_RECENT_SPEND_GONE_GRACE_MS,
  QBIT_RECENT_SPEND_LIMIT,
  QBIT_RECENT_SPEND_PROBE_INTERVAL_MS,
  QBIT_RECENT_SPEND_PROBES_PER_READ,
  QBIT_RECENT_SPEND_TTL_MS,
  QBIT_WALLET_SEND_CLAIM_ORIGIN,
  QbitSendGuardService,
} from '../src/services/qbitSendGuards'

function broadcastClaim(overrides: Partial<QbitSendBroadcastClaim> = {}): QbitSendBroadcastClaim {
  return {
    chain: ChainType.QBIT_REGTEST,
    address: 'qbrt1zfunding',
    origin: 'https://otc.example',
    txid: '11'.repeat(32),
    outpoints: [{ txid: 'aa'.repeat(32), vout: 1 }],
    ...overrides,
  }
}

function externalSigningLockIdentity(
  purpose: QbitExternalSigningLock['purpose'],
  entries: QbitExternalSigningLock['entries'] = [
    { txid: broadcastClaim().txid, outpoints: broadcastClaim().outpoints },
  ]
) {
  return {
    purpose,
    chain: ChainType.QBIT_REGTEST,
    address: 'qbrt1zfunding',
    origin: 'https://otc.example',
    entries,
  }
}

describe('QbitSendGuardService', () => {
  let service: QbitSendGuardService

  beforeEach(() => {
    service = new QbitSendGuardService()
    service.init()
  })

  it('retains a normal-send broadcast claim after signing', async () => {
    await expect(
      service.runWithBroadcastClaim(broadcastClaim(), async () => 'signed')
    ).resolves.toBe('signed')

    await expect(
      service.getReservedOutpointKeys(ChainType.QBIT_REGTEST, 'qbrt1zfunding')
    ).resolves.toEqual(new Set([`${'aa'.repeat(32)}:1`]))
    await expect(
      service.assertNoOverlap(ChainType.QBIT_REGTEST, broadcastClaim().outpoints)
    ).rejects.toThrow('claimed by an approved send')
  })

  it('releases a normal-send broadcast claim when signing fails', async () => {
    const claim = broadcastClaim()
    const signingError = new Error('signing failed')

    await expect(
      service.runWithBroadcastClaim(claim, async () => {
        throw signingError
      })
    ).rejects.toBe(signingError)

    await expect(
      service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).resolves.toBeUndefined()
  })

  it('atomically acquires one transient external batch lock while allowing intra-batch overlap', async () => {
    const entries = [
      { txid: '11'.repeat(32), outpoints: broadcastClaim().outpoints },
      { txid: '22'.repeat(32), outpoints: broadcastClaim().outpoints },
    ]

    const lock = await service.acquireExternalSigningLock(
      externalSigningLockIdentity('sign', entries)
    )

    expect(lock).toMatchObject(externalSigningLockIdentity('sign', entries))
    await expect(
      service.getReservedOutpointKeys(ChainType.QBIT_REGTEST, 'qbrt1zfunding')
    ).resolves.toEqual(new Set([`${'aa'.repeat(32)}:1`]))
    await expect(
      service.acquireExternalSigningLock(externalSigningLockIdentity('sign', entries))
    ).rejects.toThrow('locked by an external signing approval')
    await expect(service.releaseExternalSigningLock({ ...lock, id: 'other-flow' })).resolves.toBe(
      false
    )
    await expect(
      service.assertNoOverlap(ChainType.QBIT_REGTEST, broadcastClaim().outpoints)
    ).rejects.toThrow('locked by an external signing approval')
    await expect(service.releaseExternalSigningLock(lock)).resolves.toBe(true)
  })

  it('atomically promotes an exact external send lock to its broadcast claim', async () => {
    const claim = broadcastClaim()
    const lock = await service.acquireExternalSigningLock(
      externalSigningLockIdentity('send', [{ txid: claim.txid, outpoints: claim.outpoints }])
    )

    await expect(
      service.promoteExternalSigningLockToBroadcastClaim(lock, {
        ...claim,
        origin: 'https://other.example',
      })
    ).rejects.toThrow('identity mismatch')
    await expect(service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)).rejects.toThrow(
      'locked by an external signing approval'
    )
    // The claim is filed under the provider request carrying it; with none
    // open, the lock stays as it is.
    await expect(service.promoteExternalSigningLockToBroadcastClaim(lock, claim)).rejects.toThrow(
      'provider send request is no longer pending'
    )
    await expect(service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)).rejects.toThrow(
      'locked by an external signing approval'
    )
    await service.openProviderSendRequest(claim)

    await service.promoteExternalSigningLockToBroadcastClaim(lock, claim)

    await expect(service.releaseExternalSigningLock(lock)).resolves.toBe(false)
    await expect(
      service.broadcastIfAllowed(
        ChainType.QBIT_REGTEST,
        claim.txid,
        claim.outpoints,
        async () => 'broadcasted',
        claim
      )
    ).resolves.toBe('broadcasted')
  })

  describe('provider send requests', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void
      const promise = new Promise<T>(res => {
        resolve = res
      })
      return { promise, resolve }
    }

    async function expectFree(claim: QbitSendBroadcastClaim) {
      await expect(
        service.getReservedOutpointKeys(ChainType.QBIT_REGTEST, claim.address)
      ).resolves.toEqual(new Set())
      await expect(
        service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
      ).resolves.toBeUndefined()
    }

    async function expectClaimed(claim: QbitSendBroadcastClaim) {
      await expect(
        service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
      ).rejects.toThrow('claimed by an approved send')
    }

    it('files a provider claim under its request and releases it when the request fails', async () => {
      const claim = broadcastClaim()
      const request = await service.openProviderSendRequest(claim)

      await expect(
        service.runWithProviderBroadcastClaim(claim, async () => 'signed')
      ).resolves.toBe('signed')
      await expectClaimed(claim)

      await service.settleProviderSendRequest(request, false)

      await expectFree(claim)
      // A signature arriving after the request settled registers nothing.
      const operation = vi.fn(async () => 'signed')
      await expect(service.runWithProviderBroadcastClaim(claim, operation)).rejects.toThrow(
        'provider send request is no longer pending'
      )
      expect(operation).not.toHaveBeenCalled()
      await expectFree(claim)
    })

    it('refuses a provider claim that no open request carries exactly', async () => {
      const claim = broadcastClaim()
      await service.openProviderSendRequest(claim)
      const operation = vi.fn(async () => 'signed')

      for (const other of [
        broadcastClaim({ txid: '22'.repeat(32) }),
        broadcastClaim({ address: 'qbrt1zother' }),
        broadcastClaim({ origin: 'https://other.example' }),
        broadcastClaim({ origin: QBIT_WALLET_SEND_CLAIM_ORIGIN }),
      ]) {
        await expect(service.runWithProviderBroadcastClaim(other, operation)).rejects.toThrow(
          'provider send request is no longer pending'
        )
      }
      expect(operation).not.toHaveBeenCalled()
      await expectFree(claim)
      // A wallet-owned claim never belongs to a provider request.
      await expect(
        service.openProviderSendRequest(broadcastClaim({ origin: QBIT_WALLET_SEND_CLAIM_ORIGIN }))
      ).rejects.toThrow('invalid Qbit send broadcast claim')
    })

    it('keeps the inputs reserved as recently spent when the request settles as spent', async () => {
      const claim = broadcastClaim()
      const request = await service.openProviderSendRequest(claim)
      await service.runWithProviderBroadcastClaim(claim, async () => 'signed')

      await service.settleProviderSendRequest(request, true)

      await expect(
        service.getReservedOutpointKeys(ChainType.QBIT_REGTEST, claim.address)
      ).resolves.toEqual(new Set([`${'aa'.repeat(32)}:1`]))
      // The claim is gone; the input is held as recently spent.
      await expect(
        service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
      ).rejects.toThrow('recent broadcast already spent')
    })

    it('settles a request after the signature it is waiting on lands', async () => {
      const claim = broadcastClaim()
      const request = await service.openProviderSendRequest(claim)
      const signature = deferred<string>()

      const signing = service.runWithProviderBroadcastClaim(claim, () => signature.promise)
      // The request settles (its approval window closed) while the signature
      // is still being made, and only then does the signature land.
      const settling = service.settleProviderSendRequest(request, false)
      signature.resolve('signed')

      await expect(signing).resolves.toBe('signed')
      await settling
      await expectFree(claim)
    })

    it('leaves a failed signing with nothing filed and lets the request sign again', async () => {
      const claim = broadcastClaim()
      const request = await service.openProviderSendRequest(claim)

      await expect(
        service.runWithProviderBroadcastClaim(claim, async () => {
          throw new Error('signing failed')
        })
      ).rejects.toThrow('signing failed')
      await expectFree(claim)

      await service.runWithProviderBroadcastClaim(claim, async () => 'signed')
      await expectClaimed(claim)
      await service.settleProviderSendRequest(request, false)
      await expectFree(claim)
    })

    it('never decides a claim filed under another request', async () => {
      const claim = broadcastClaim()
      const otherClaim = broadcastClaim({
        txid: '22'.repeat(32),
        outpoints: [{ txid: 'bb'.repeat(32), vout: 0 }],
      })
      const request = await service.openProviderSendRequest(claim)
      const otherRequest = await service.openProviderSendRequest(otherClaim)
      await service.runWithProviderBroadcastClaim(claim, async () => 'signed')

      // A second request for the same transaction is refused outright, so
      // whose settlement decides the claim is never in doubt.
      await expect(service.openProviderSendRequest(broadcastClaim())).rejects.toThrow(
        'already sending this transaction'
      )
      await service.settleProviderSendRequest(otherRequest, false)
      await service.settleProviderSendRequest(otherRequest, false)
      await service.settleProviderSendRequest('unknown-request', false)
      await expectClaimed(claim)

      await service.settleProviderSendRequest(request, false)
      await expectFree(claim)
      // A settled request no longer stands in the way of a new one.
      await expect(service.openProviderSendRequest(claim)).resolves.toEqual(expect.any(String))
    })

    it('leaves a claim its broadcast consumed to that broadcast', async () => {
      const claim = broadcastClaim()
      const request = await service.openProviderSendRequest(claim)
      await service.runWithProviderBroadcastClaim(claim, async () => 'signed')
      await service.broadcastIfAllowed(
        ChainType.QBIT_REGTEST,
        claim.txid,
        claim.outpoints,
        async () => 'broadcasted',
        claim
      )

      // A failure after the broadcast (a lost answer) settles as not spent,
      // but the inputs the broadcast spent stay reserved.
      await service.settleProviderSendRequest(request, false)

      await expect(
        service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
      ).rejects.toThrow('recent broadcast already spent')
    })
  })

  it('broadcasts only the exact claimed normal send and consumes its claim', async () => {
    const claim = broadcastClaim()
    await service.runWithBroadcastClaim(claim, async () => 'signed')
    const unclaimedBroadcast = vi.fn(async () => 'broadcasted')

    await expect(
      service.broadcastIfAllowed(
        ChainType.QBIT_REGTEST,
        claim.txid,
        claim.outpoints,
        unclaimedBroadcast
      )
    ).rejects.toThrow('claimed by an approved send')
    expect(unclaimedBroadcast).not.toHaveBeenCalled()

    await expect(
      service.broadcastIfAllowed(
        ChainType.QBIT_REGTEST,
        claim.txid,
        claim.outpoints,
        async () => 'broadcasted',
        claim
      )
    ).resolves.toBe('broadcasted')
    // The claim is gone, but its input stays reserved as recently spent.
    await expect(service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)).rejects.toThrow(
      'recent broadcast already spent'
    )
    await expect(
      service.getReservedOutpointKeys(ChainType.QBIT_REGTEST, 'qbrt1zfunding')
    ).resolves.toEqual(new Set([`${'aa'.repeat(32)}:1`]))
  })

  it('rejects a conflicting broadcast while a normal-send claim is active', async () => {
    const claim = broadcastClaim()
    await service.runWithBroadcastClaim(claim, async () => 'signed')
    const broadcast = vi.fn(async () => 'broadcasted')

    await expect(
      service.broadcastIfAllowed(
        ChainType.QBIT_REGTEST,
        '22'.repeat(32),
        claim.outpoints,
        broadcast
      )
    ).rejects.toThrow('claimed by an approved send')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('retains the normal-send claim when its broadcast rejects', async () => {
    const claim = broadcastClaim()
    await service.runWithBroadcastClaim(claim, async () => 'signed')
    const broadcastError = new Error('broadcast timed out')

    await expect(
      service.broadcastIfAllowed(
        ChainType.QBIT_REGTEST,
        claim.txid,
        claim.outpoints,
        async () => {
          throw broadcastError
        },
        claim
      )
    ).rejects.toBe(broadcastError)

    await expect(service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)).rejects.toThrow(
      'claimed by an approved send'
    )
  })

  it('releases only the exact normal-send claim', async () => {
    const claim = broadcastClaim()
    await service.runWithBroadcastClaim(claim, async () => 'signed')

    await expect(
      service.releaseBroadcastClaim({ ...claim, origin: 'https://other.example' })
    ).resolves.toBe(false)
    await expect(service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)).rejects.toThrow(
      'claimed by an approved send'
    )
    await expect(service.releaseBroadcastClaim(claim)).resolves.toBe(true)
    await expect(
      service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).resolves.toBeUndefined()
  })

  it('clears transient normal-send claims on reset and reinitialization', async () => {
    const claim = broadcastClaim()
    await service.runWithBroadcastClaim(claim, async () => 'signed')

    await service.resetAllData()
    await expect(
      service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).resolves.toBeUndefined()

    await service.runWithBroadcastClaim(claim, async () => 'signed-again')
    service.init()
    await expect(
      service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).resolves.toBeUndefined()
  })

  describe('claim ownership', () => {
    const walletClaim = (overrides: Partial<QbitSendBroadcastClaim> = {}) =>
      broadcastClaim({ origin: QBIT_WALLET_SEND_CLAIM_ORIGIN, ...overrides })
    const reserved = () =>
      service.getReservedOutpointKeys(ChainType.QBIT_REGTEST, 'qbrt1zfunding')
    const outpoint = `${'aa'.repeat(32)}:1`

    it('releases a wallet-owned claim whose owner disconnects before any broadcast', async () => {
      await service.runWithBroadcastClaim(walletClaim(), async () => 'signed', 'popup:1')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      // Another page closing changes nothing.
      await service.releaseClaimsOwnedBy('tab:2')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      // The page holding the signed bytes closes: nothing can retry them.
      await service.releaseClaimsOwnedBy('popup:1')
      await expect(reserved()).resolves.toEqual(new Set())
      await expect(service.releaseBroadcastClaim(walletClaim())).resolves.toBe(false)
    })

    it('never owns a provider claim, and owns nothing signed outside a UI port', async () => {
      await service.runWithBroadcastClaim(broadcastClaim(), async () => 'signed', 'notification:1')
      await service.runWithBroadcastClaim(
        walletClaim({ txid: '12'.repeat(32), outpoints: [{ txid: 'ab'.repeat(32), vout: 0 }] }),
        async () => 'signed'
      )

      await service.releaseClaimsOwnedBy('notification:1')
      await expect(reserved()).resolves.toEqual(
        new Set([outpoint, `${'ab'.repeat(32)}:0`])
      )
    })

    it('defers to an in-flight broadcast and then follows its verdict', async () => {
      const claim = walletClaim()
      await service.runWithBroadcastClaim(claim, async () => 'signed', 'popup:1')

      // The verdict decides: a refusal that never left the wallet says the
      // bytes are as unsent as before, so the orphaned claim goes.
      service.beginBroadcastAttempt(claim, 'popup:1')
      await service.releaseClaimsOwnedBy('popup:1')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.settleBroadcastAttempt(claim, 'refused')
      await expect(reserved()).resolves.toEqual(new Set())

      // A proven absence releases the same way.
      await service.runWithBroadcastClaim(claim, async () => 'signed', 'popup:2')
      service.beginBroadcastAttempt(claim, 'popup:2')
      await service.releaseClaimsOwnedBy('popup:2')
      await service.settleBroadcastAttempt(claim, 'proven_absent')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('keeps a claim whose last dispatched verdict was inconclusive, even after its owner is gone', async () => {
      const claim = walletClaim()
      await service.runWithBroadcastClaim(claim, async () => 'signed', 'popup:1')

      service.beginBroadcastAttempt(claim, 'popup:1')
      await service.settleBroadcastAttempt(claim, 'inconclusive')
      await service.releaseClaimsOwnedBy('popup:1')
      // The node may hold the transaction; only proof either way settles it.
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      // The same page, reconnected, retries. A refusal that never left the
      // wallet does not undo the inconclusive verdict, so the claim survives
      // that port going away as well.
      service.beginBroadcastAttempt(claim, 'popup:2')
      await service.settleBroadcastAttempt(claim, 'refused')
      await service.releaseClaimsOwnedBy('popup:2')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      // A dispatched rejection with absence proven does undo it; while the
      // page that got that verdict is open it may still retry or abandon,
      // and the claim goes with the page.
      service.beginBroadcastAttempt(claim, 'popup:3')
      await service.settleBroadcastAttempt(claim, 'proven_absent')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.releaseClaimsOwnedBy('popup:3')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('hands a claim to whichever UI port broadcasts it', async () => {
      const claim = walletClaim()
      await service.runWithBroadcastClaim(claim, async () => 'signed', 'popup:1')

      service.beginBroadcastAttempt(claim, 'tab:2')
      await service.settleBroadcastAttempt(claim, 'refused')
      await service.releaseClaimsOwnedBy('popup:1')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.releaseClaimsOwnedBy('tab:2')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('forgets ownership with the claim: a consumed or released claim is never re-released', async () => {
      const claim = walletClaim()
      await service.runWithBroadcastClaim(claim, async () => 'signed', 'popup:1')
      service.beginBroadcastAttempt(claim, 'popup:1')
      await service.broadcastIfAllowed(
        ChainType.QBIT_REGTEST,
        claim.txid,
        claim.outpoints,
        async () => 'accepted',
        claim
      )
      await service.settleBroadcastAttempt(claim, 'accepted')

      // A fee bump of that transaction is claimed over the now-spent inputs
      // by another page; the first page closing must not touch it.
      const next = walletClaim({ txid: '13'.repeat(32) })
      await service.runWithBroadcastClaim(next, async () => 'signed', 'tab:2', claim.txid)
      await service.releaseClaimsOwnedBy('popup:1')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await expect(service.releaseBroadcastClaim(next)).resolves.toBe(true)
    })
  })

  describe('claim restoration', () => {
    const walletClaim = (overrides: Partial<QbitSendBroadcastClaim> = {}) =>
      broadcastClaim({ origin: QBIT_WALLET_SEND_CLAIM_ORIGIN, ...overrides })
    const reserved = () => service.getReservedOutpointKeys(ChainType.QBIT_REGTEST, 'qbrt1zfunding')
    const outpoint = `${'aa'.repeat(32)}:1`
    const restore = (claim: QbitSendBroadcastClaim, owner?: string) =>
      service.restoreBroadcastClaim(claim, 'qbrt1zfunding', owner)

    it('restores a wallet-owned claim it has never seen, with its broadcast attempt already in flight', async () => {
      // A fresh instance, as after a background restart: the page presents
      // the claim a previous worker minted, and dispatches next.
      const claim = walletClaim()
      await expect(restore(claim, 'tab:1')).resolves.toBe('restored')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await expect(
        service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
      ).rejects.toThrow('claimed by an approved send')
      // Nothing to restore twice.
      await expect(restore(claim, 'tab:1')).resolves.toBe('refused')

      // The restoring page disconnects while its broadcast is still in
      // flight: the verdict decides, not the disconnect, and an inconclusive
      // verdict keeps the claim even though its owner is gone.
      await service.releaseClaimsOwnedBy('tab:1')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.settleBroadcastAttempt(claim, 'inconclusive')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      // A later attempt from another page proves absence: the claim then
      // goes with that page, exactly like a minted one.
      service.beginBroadcastAttempt(claim, 'tab:2')
      await service.settleBroadcastAttempt(claim, 'proven_absent')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.releaseClaimsOwnedBy('tab:2')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('lets the broadcast consume a restored claim, after which it is never restored again', async () => {
      const claim = walletClaim()
      await expect(restore(claim, 'tab:1')).resolves.toBe('restored')

      await expect(
        service.broadcastIfAllowed(
          ChainType.QBIT_REGTEST,
          claim.txid,
          claim.outpoints,
          async () => 'accepted',
          claim
        )
      ).resolves.toBe('accepted')
      await service.settleBroadcastAttempt(claim, 'accepted')
      // Consumed, yet its input stays reserved as recently spent.
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await expect(
        service.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
      ).rejects.toThrow('recent broadcast already spent')

      // The node holds these bytes now; a lookup miss must never put them
      // back on the wire.
      await expect(restore(claim, 'tab:1')).resolves.toBe('refused')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
    })

    it('never restores a claim it consumed, released, or dropped, until it is reinitialized', async () => {
      const consumed = walletClaim()
      await service.runWithBroadcastClaim(consumed, async () => 'signed', 'popup:1')
      await service.broadcastIfAllowed(
        ChainType.QBIT_REGTEST,
        consumed.txid,
        consumed.outpoints,
        async () => 'accepted',
        consumed
      )
      await expect(restore(consumed, 'popup:2')).resolves.toBe('refused')

      // The consumed claim's input stays recently spent, so the claims below
      // spend another one.
      const other = [{ txid: 'bb'.repeat(32), vout: 0 }]
      const abandoned = walletClaim({ txid: '12'.repeat(32), outpoints: other })
      await service.runWithBroadcastClaim(abandoned, async () => 'signed', 'popup:1')
      await expect(service.releaseBroadcastClaim(abandoned)).resolves.toBe(true)
      await expect(restore(abandoned, 'popup:2')).resolves.toBe('refused')

      const orphaned = walletClaim({ txid: '13'.repeat(32), outpoints: other })
      await service.runWithBroadcastClaim(orphaned, async () => 'signed', 'popup:1')
      await service.releaseClaimsOwnedBy('popup:1')
      await expect(restore(orphaned, 'popup:2')).resolves.toBe('refused')

      const dropped = walletClaim({ txid: '14'.repeat(32), outpoints: other })
      await expect(
        service.runWithBroadcastClaim(
          dropped,
          async () => {
            throw new Error('signing failed')
          },
          'popup:1'
        )
      ).rejects.toThrow('signing failed')
      await expect(restore(dropped, 'popup:2')).resolves.toBe('refused')

      const reset = walletClaim({ txid: '15'.repeat(32), outpoints: other })
      await service.runWithBroadcastClaim(reset, async () => 'signed', 'popup:1')
      await service.resetAllData()
      await expect(restore(reset, 'popup:2')).resolves.toBe('refused')
      await expect(reserved()).resolves.toEqual(new Set())

      // A restart forgets all of that: what the pages still hold is
      // restorable again.
      service.init()
      await expect(restore(consumed, 'popup:2')).resolves.toBe('restored')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
    })

    it('reports a claim filed under another address instead of restoring it, unless the guard already decided it', async () => {
      const claim = walletClaim()
      await expect(
        service.restoreBroadcastClaim(claim, 'qbrt1zanotheraccount', 'tab:1')
      ).resolves.toBe('address_mismatch')
      await expect(reserved()).resolves.toEqual(new Set())
      await expect(
        service.getReservedOutpointKeys(ChainType.QBIT_REGTEST, 'qbrt1zanotheraccount')
      ).resolves.toEqual(new Set())

      // The instance's own record comes first: a claim it released is
      // refused outright, whatever address the caller names.
      await service.runWithBroadcastClaim(claim, async () => 'signed', 'popup:1')
      await expect(service.releaseBroadcastClaim(claim)).resolves.toBe(true)
      await expect(
        service.restoreBroadcastClaim(claim, 'qbrt1zanotheraccount', 'tab:1')
      ).resolves.toBe('refused')
    })

    it('never restores a provider claim, a malformed one, or one over inputs reserved meanwhile', async () => {
      await expect(restore(broadcastClaim(), 'notification:1')).resolves.toBe('refused')
      await expect(restore(walletClaim({ outpoints: [] }), 'tab:1')).resolves.toBe('refused')
      await expect(reserved()).resolves.toEqual(new Set())

      // Another send was claimed over the same input while the worker was
      // down, or an external signing approval holds it.
      const other = walletClaim({ txid: '16'.repeat(32) })
      await service.runWithBroadcastClaim(other, async () => 'signed', 'tab:2')
      await expect(restore(walletClaim(), 'tab:1')).resolves.toBe('refused')
      await expect(service.releaseBroadcastClaim(other)).resolves.toBe(true)
      const lock = await service.acquireExternalSigningLock(externalSigningLockIdentity('sign'))
      await expect(restore(walletClaim(), 'tab:1')).resolves.toBe('refused')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await expect(service.releaseExternalSigningLock(lock)).resolves.toBe(true)

      // With the input free again, and this instance never having held the
      // claim itself, the restoration goes through.
      await expect(restore(walletClaim(), 'tab:1')).resolves.toBe('restored')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
    })
  })

  describe('recent spends', () => {
    const chain = ChainType.QBIT_REGTEST
    const address = 'qbrt1zfunding'
    const outpoint = `${'aa'.repeat(32)}:1`
    const walletClaim = (overrides: Partial<QbitSendBroadcastClaim> = {}) =>
      broadcastClaim({ origin: QBIT_WALLET_SEND_CLAIM_ORIGIN, ...overrides })
    const reserved = (forAddress = address) => service.getReservedOutpointKeys(chain, forAddress)
    const start = new Date('2026-10-23T12:00:00Z').getTime()
    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

    /** Claim, sign and broadcast `claim`, as the wallet's send path does. */
    async function sendAccepted(claim: QbitSendBroadcastClaim, replaces?: string) {
      await service.runWithBroadcastClaim(claim, async () => 'signed', undefined, replaces)
      await service.broadcastIfAllowed(
        chain,
        claim.txid,
        claim.outpoints,
        async () => claim.txid,
        claim
      )
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(start)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("keeps an accepted broadcast's inputs reserved and refuses every other spend of them", async () => {
      const claim = walletClaim()
      await sendAccepted(claim)

      // The claim is consumed, yet the input stays out of coin selection:
      // the explorer can keep listing it for a while after the node took
      // the spend, and a send built from that list could replace the
      // first payment.
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await expect(service.releaseBroadcastClaim(claim)).resolves.toBe(false)
      // Nor can any other transaction over it be signed: the bytes could be
      // broadcast outside the wallet. The same transaction can.
      await expect(service.assertNoOverlap(chain, claim.outpoints)).rejects.toThrow(
        'recent broadcast already spent'
      )
      await expect(
        service.runWithNoOverlap(chain, claim.outpoints, async () => 'resigned', claim.txid)
      ).resolves.toBe('resigned')
      await expect(
        service.acquireExternalSigningLock({
          purpose: 'sign',
          chain,
          address,
          origin: 'https://otc.example',
          entries: [{ txid: '22'.repeat(32), outpoints: claim.outpoints }],
        })
      ).rejects.toThrow('recent broadcast already spent')
      // The record is scoped to the account the claim was filed under.
      await expect(reserved('qbrt1zother')).resolves.toEqual(new Set())

      // Another transaction over it is refused before it is signed or sent.
      const conflict = walletClaim({ txid: '22'.repeat(32) })
      const sign = vi.fn(async () => 'signed')
      await expect(service.runWithBroadcastClaim(conflict, sign, 'popup:1')).rejects.toThrow(
        'recent broadcast already spent'
      )
      expect(sign).not.toHaveBeenCalled()
      const broadcast = vi.fn(async () => 'broadcasted')
      await expect(
        service.broadcastIfAllowed(chain, conflict.txid, conflict.outpoints, broadcast)
      ).rejects.toThrow('recent broadcast already spent')
      expect(broadcast).not.toHaveBeenCalled()
      await expect(service.restoreBroadcastClaim(conflict, address, 'tab:1')).resolves.toBe(
        'refused'
      )

      // The same transaction may still go out again: a rebroadcast of
      // identical bytes spends nothing new.
      await expect(
        service.broadcastIfAllowed(chain, claim.txid, claim.outpoints, async () => 'again')
      ).resolves.toBe('again')
    })

    it("keeps a claim-less broadcast's inputs reserved for every account", async () => {
      await service.broadcastIfAllowed(
        chain,
        '33'.repeat(32),
        broadcastClaim().outpoints,
        async () => 'pushed'
      )

      // Nothing names the account a provider pushTx spends from; an
      // outpoint names one output, so it is filtered wherever it shows up.
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await expect(reserved('qbrt1zother')).resolves.toEqual(new Set([outpoint]))
      await expect(
        service.runWithBroadcastClaim(walletClaim(), async () => 'signed')
      ).rejects.toThrow('recent broadcast already spent')
      // Another network's outputs are unaffected.
      await expect(
        service.getReservedOutpointKeys(ChainType.QBIT_TESTNET4, address)
      ).resolves.toEqual(new Set())
    })

    it('lets only a wallet-owned fee bump of the spender take its inputs over', async () => {
      const original = walletClaim()
      await sendAccepted(original)

      // A provider claim cannot claim to be a replacement.
      await expect(
        service.runWithBroadcastClaim(
          broadcastClaim({ txid: '22'.repeat(32) }),
          async () => 'signed',
          undefined,
          original.txid
        )
      ).rejects.toThrow('recent broadcast already spent')
      // Nor can a wallet claim naming some other transaction.
      await expect(
        service.runWithBroadcastClaim(
          walletClaim({ txid: '22'.repeat(32) }),
          async () => 'signed',
          undefined,
          '99'.repeat(32)
        )
      ).rejects.toThrow('recent broadcast already spent')

      const bump = walletClaim({ txid: '22'.repeat(32) })
      await sendAccepted(bump, original.txid)
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      // The bump now owns the inputs: a second bump of the stale original
      // is refused, and one of the bump itself is allowed.
      await expect(
        service.runWithBroadcastClaim(
          walletClaim({ txid: '23'.repeat(32) }),
          async () => 'signed',
          undefined,
          original.txid
        )
      ).rejects.toThrow('recent broadcast already spent')
      await expect(
        service.broadcastIfAllowed(chain, original.txid, original.outpoints, async () => 'stale')
      ).rejects.toThrow('recent broadcast already spent')
      await sendAccepted(walletClaim({ txid: '24'.repeat(32) }), bump.txid)
    })

    it('refuses a claimed replacement that does not spend every input of the transaction it names', async () => {
      const second = { txid: 'bb'.repeat(32), vout: 0 }
      const original = walletClaim({ outpoints: [broadcastClaim().outpoints[0]!, second] })
      await sendAccepted(original)

      // An ordinary send over one of the original's inputs cannot pass for a
      // fee bump by naming it: a bump is built from all of them.
      await expect(
        service.runWithBroadcastClaim(
          walletClaim({ txid: '22'.repeat(32), outpoints: [second] }),
          async () => 'signed',
          undefined,
          original.txid
        )
      ).rejects.toThrow('recent broadcast already spent')
      await sendAccepted(
        walletClaim({ txid: '22'.repeat(32), outpoints: original.outpoints }),
        original.txid
      )
    })

    describe('later spends of the transaction a fee bump replaces (#274)', () => {
      const dependentMessage = 'A later payment depends on the transaction this fee bump replaces'

      it('refuses to broadcast a signed fee bump once a later payment spends its original', async () => {
        const original = walletClaim()
        await sendAccepted(original)
        // The bump is assessed and signed while nothing spends the original.
        const bump = walletClaim({ txid: '22'.repeat(32) })
        await service.runWithBroadcastClaim(bump, async () => 'signed', undefined, original.txid)
        // A send then spends the original's change and goes out first.
        const later = walletClaim({
          txid: '33'.repeat(32),
          outpoints: [{ txid: original.txid, vout: 1 }],
        })
        await sendAccepted(later)

        // The bump would evict it, so it is not broadcast.
        const broadcast = vi.fn(async () => bump.txid)
        await expect(
          service.broadcastIfAllowed(chain, bump.txid, bump.outpoints, broadcast, bump)
        ).rejects.toThrow(dependentMessage)
        expect(broadcast).not.toHaveBeenCalled()
        await expect(service.hasDependentSpend(chain, original.txid)).resolves.toBe(true)
      })

      it('refuses to sign a fee bump while a claim of any account spends its original', async () => {
        const original = walletClaim()
        await sendAccepted(original)
        const later = walletClaim({
          txid: '33'.repeat(32),
          address: 'qbrt1zother',
          outpoints: [{ txid: original.txid, vout: 0 }],
        })
        await service.runWithBroadcastClaim(later, async () => 'signed')

        const sign = vi.fn(async () => 'signed')
        await expect(
          service.runWithBroadcastClaim(
            walletClaim({ txid: '22'.repeat(32) }),
            sign,
            undefined,
            original.txid
          )
        ).rejects.toThrow(dependentMessage)
        expect(sign).not.toHaveBeenCalled()
        // The refused bump left no claim behind.
        await expect(reserved()).resolves.toEqual(new Set([outpoint]))

        // Once the later payment's claim is released, the bump may go ahead.
        await service.releaseBroadcastClaim(later)
        await sendAccepted(walletClaim({ txid: '22'.repeat(32) }), original.txid)
      })

      it('counts an external signing lock over an output of the original', async () => {
        const original = walletClaim()
        await sendAccepted(original)
        await service.acquireExternalSigningLock(
          externalSigningLockIdentity('sign', [
            { txid: '33'.repeat(32), outpoints: [{ txid: original.txid, vout: 1 }] },
          ])
        )

        await expect(service.hasDependentSpend(chain, original.txid)).resolves.toBe(true)
        await expect(
          service.runWithBroadcastClaim(
            walletClaim({ txid: '22'.repeat(32) }),
            async () => 'signed',
            undefined,
            original.txid
          )
        ).rejects.toThrow(dependentMessage)
      })

      it('ignores spends on another network and of other transactions', async () => {
        const original = walletClaim()
        await sendAccepted(original)
        await service.runWithBroadcastClaim(
          walletClaim({
            chain: ChainType.QBIT_TESTNET4,
            txid: '33'.repeat(32),
            outpoints: [{ txid: original.txid, vout: 1 }],
          }),
          async () => 'signed'
        )

        // The record of the original's own inputs is not a later spend of it.
        await expect(service.hasDependentSpend(chain, original.txid)).resolves.toBe(false)
        await expect(
          service.hasDependentSpend(ChainType.QBIT_TESTNET4, original.txid.toUpperCase())
        ).resolves.toBe(true)
        await sendAccepted(walletClaim({ txid: '22'.repeat(32) }), original.txid)
      })
    })

    it('hands an input back to the original when its fee bump turns out absent or gone', async () => {
      const original = walletClaim()
      await sendAccepted(original)
      const bump = walletClaim({ txid: '22'.repeat(32) })
      await service.runWithBroadcastClaim(bump, async () => 'signed', undefined, original.txid)

      // The bump's broadcast is inconclusive, then proven absent: the
      // original may still be pending, so its input stays reserved.
      await service.recordInconclusiveBroadcast(chain, bump.txid, bump.outpoints, bump)
      await expect(service.releaseBroadcastClaim(bump)).resolves.toBe(true)
      await service.forgetAbsentBroadcast(chain, bump.txid)
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await expect(
        service.broadcastIfAllowed(chain, '23'.repeat(32), bump.outpoints, async () => 'x')
      ).rejects.toThrow('recent broadcast already spent')

      // An accepted bump found gone later hands the input back the same way,
      // and the original's own probe then settles it. The original was not
      // probed while hidden, so it gets a full grace period of its own.
      await sendAccepted(walletClaim({ txid: '24'.repeat(32) }), original.txid)
      advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      const [ofBump] = await service.takeRecentSpendersToProbe(chain, address)
      expect(ofBump!.txid).toBe('24'.repeat(32))
      await service.settleRecentSpendProbe(chain, ofBump!, 'gone')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      const [early] = await service.takeRecentSpendersToProbe(chain, address)
      expect(early!.txid).toBe(original.txid)
      await service.settleRecentSpendProbe(chain, early!, 'gone')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      const [ofOriginal] = await service.takeRecentSpendersToProbe(chain, address)
      await service.settleRecentSpendProbe(chain, ofOriginal!, 'gone')
      await expect(reserved()).resolves.toEqual(new Set())

      // A transaction recorded again over its own replacement supersedes its
      // older record, so once both are gone nothing stale comes back.
      const a = walletClaim({ txid: '27'.repeat(32) })
      const b = walletClaim({ txid: '28'.repeat(32) })
      await service.recordInconclusiveBroadcast(chain, a.txid, a.outpoints, a)
      await service.recordInconclusiveBroadcast(chain, b.txid, b.outpoints, b)
      await service.recordInconclusiveBroadcast(chain, a.txid, a.outpoints, a)
      await service.forgetAbsentBroadcast(chain, a.txid)
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.forgetAbsentBroadcast(chain, b.txid)
      await expect(reserved()).resolves.toEqual(new Set())

      // A spender proven absent behind a newer one never comes back either.
      const c = walletClaim({ txid: '29'.repeat(32) })
      const d = walletClaim({ txid: '2a'.repeat(32) })
      await service.recordInconclusiveBroadcast(chain, c.txid, c.outpoints, c)
      await service.recordInconclusiveBroadcast(chain, d.txid, d.outpoints, d)
      await service.forgetAbsentBroadcast(chain, c.txid)
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.forgetAbsentBroadcast(chain, d.txid)
      await expect(reserved()).resolves.toEqual(new Set())

      // A confirmed bump spent the input for good: nothing falls back.
      await sendAccepted(walletClaim({ txid: '25'.repeat(32) }))
      await sendAccepted(walletClaim({ txid: '26'.repeat(32) }), '25'.repeat(32))
      const ofConfirmed = { txid: '26'.repeat(32), probedAt: Date.now(), sequence: Infinity }
      await service.settleRecentSpendProbe(chain, ofConfirmed, 'confirmed')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('records an inconclusive retry of a claim it never saw, but not of one it already decided', async () => {
      // Released (the user abandoned a proven not_sent verdict): a stale
      // retry presenting the claim dispatched nothing and records nothing.
      const abandoned = walletClaim()
      await service.runWithBroadcastClaim(abandoned, async () => 'signed')
      await expect(service.releaseBroadcastClaim(abandoned)).resolves.toBe(true)
      await service.recordInconclusiveBroadcast(
        chain,
        abandoned.txid,
        abandoned.outpoints,
        abandoned,
        false
      )
      await expect(reserved()).resolves.toEqual(new Set())
      // A broadcast that did go out records its inputs whatever happened to
      // the claim meanwhile.
      await service.recordInconclusiveBroadcast(
        chain,
        abandoned.txid,
        abandoned.outpoints,
        abandoned
      )
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.forgetAbsentBroadcast(chain, abandoned.txid)

      // A claim this instance never saw is what a restart leaves behind: the
      // earlier broadcast may have gone out, so its inputs are recorded.
      const unseen = walletClaim({
        txid: '22'.repeat(32),
        outpoints: [{ txid: 'bb'.repeat(32), vout: 0 }],
      })
      await service.recordInconclusiveBroadcast(chain, unseen.txid, unseen.outpoints, unseen, false)
      await expect(reserved()).resolves.toEqual(new Set([`${'bb'.repeat(32)}:0`]))
      // Filed under the claim's account only.
      await expect(reserved('qbrt1zother')).resolves.toEqual(new Set())
    })

    it('never lets a retry that sent nothing hide the spender on record', async () => {
      // After a restart the user sends B over the input; an old page then
      // retries A, whose claim this instance never saw. Nothing was sent by
      // that retry, so B stays on record and A cannot be restored over it.
      const b = walletClaim({ txid: '22'.repeat(32) })
      await sendAccepted(b)
      const a = walletClaim()
      await service.recordInconclusiveBroadcast(chain, a.txid, a.outpoints, a, false)
      await expect(service.restoreBroadcastClaim(a, address, 'tab:1')).resolves.toBe('refused')
      await expect(
        service.broadcastIfAllowed(chain, a.txid, a.outpoints, async () => 'x')
      ).rejects.toThrow('recent broadcast already spent')
      // The record still names B: B confirmed frees the input.
      advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
      const [probe] = await service.takeRecentSpendersToProbe(chain, address)
      expect(probe!.txid).toBe(b.txid)
    })

    it('renews the records of a spender a status check finds pending, keeping the probe order', async () => {
      const claim = walletClaim()
      await sendAccepted(claim)
      advance(QBIT_RECENT_SPEND_TTL_MS - 1)
      const [probe] = await service.takeRecentSpendersToProbe(chain, address)

      await service.observePendingSpender(chain, claim.txid)
      advance(QBIT_RECENT_SPEND_TTL_MS - 1)
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      // A probe handed out before the renewal still settles the record.
      await service.settleRecentSpendProbe(chain, probe!, 'confirmed')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('hands out at most a few spenders per read, oldest first', async () => {
      const spenders = Array.from({ length: QBIT_RECENT_SPEND_PROBES_PER_READ + 2 }, (_, i) =>
        (i + 16).toString(16).repeat(32)
      )
      for (const [vout, txid] of spenders.entries()) {
        await service.recordInconclusiveBroadcast(chain, txid, [{ txid: 'cc'.repeat(32), vout }])
      }
      advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
      const first = await service.takeRecentSpendersToProbe(chain, address)
      expect(first.map(probe => probe.txid)).toEqual(
        spenders.slice(0, QBIT_RECENT_SPEND_PROBES_PER_READ)
      )
      const rest = await service.takeRecentSpendersToProbe(chain, address)
      expect(rest.map(probe => probe.txid)).toEqual(
        spenders.slice(QBIT_RECENT_SPEND_PROBES_PER_READ)
      )
    })

    it('frees the inputs once a probe finds the spender confirmed, and only then', async () => {
      const claim = walletClaim()
      await sendAccepted(claim)

      // Nothing is due right after the broadcast.
      await expect(service.takeRecentSpendersToProbe(chain, address)).resolves.toEqual([])
      advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
      const [probe] = await service.takeRecentSpendersToProbe(chain, address)
      expect(probe).toEqual({
        txid: claim.txid,
        probedAt: Date.now(),
        sequence: expect.any(Number),
      })
      // A spender handed out is not handed out again within the interval.
      await expect(service.takeRecentSpendersToProbe(chain, address)).resolves.toEqual([])

      await service.settleRecentSpendProbe(chain, probe!, 'pending')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      // A verdict about another transaction or network frees nothing.
      await service.settleRecentSpendProbe(chain, { ...probe!, txid: '22'.repeat(32) }, 'confirmed')
      await service.settleRecentSpendProbe(ChainType.QBIT_TESTNET4, probe!, 'confirmed')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      await service.settleRecentSpendProbe(chain, probe!, 'confirmed')
      await expect(reserved()).resolves.toEqual(new Set())
      await expect(
        service.runWithBroadcastClaim(walletClaim({ txid: '22'.repeat(32) }), async () => 'ok')
      ).resolves.toBe('ok')
    })

    it('believes a gone spender only once its spend is older than the grace period', async () => {
      const claim = walletClaim()
      await sendAccepted(claim)

      // Right after a broadcast the explorer's index can lag the node: a
      // lookup miss then says nothing about the mempool.
      advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
      const [early] = await service.takeRecentSpendersToProbe(chain, address)
      await service.settleRecentSpendProbe(chain, early!, 'gone')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      const [late] = await service.takeRecentSpendersToProbe(chain, address)
      await service.settleRecentSpendProbe(chain, late!, 'gone')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('runs the gone grace from the last time the spender was found pending', async () => {
      const claim = walletClaim()
      await sendAccepted(claim)
      advance(QBIT_RECENT_SPEND_GONE_GRACE_MS * 3)
      const [pending] = await service.takeRecentSpendersToProbe(chain, address)
      await service.settleRecentSpendProbe(chain, pending!, 'pending')

      // One miss right after a run of pending answers can be the explorer's.
      advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
      const [miss] = await service.takeRecentSpendersToProbe(chain, address)
      await service.settleRecentSpendProbe(chain, miss!, 'gone')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      const [gone] = await service.takeRecentSpendersToProbe(chain, address)
      await service.settleRecentSpendProbe(chain, gone!, 'gone')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('never records a retry that sent nothing over an input another claim holds', async () => {
      // After a restart the user approves C over the input; an old page then
      // retries A, whose claim this instance never saw.
      const c = walletClaim({ txid: '22'.repeat(32) })
      await service.runWithBroadcastClaim(c, async () => 'signed')
      const a = walletClaim()
      await service.recordInconclusiveBroadcast(chain, a.txid, a.outpoints, a, false)
      // C still goes out, and only C is on record afterwards.
      await expect(
        service.broadcastIfAllowed(chain, c.txid, c.outpoints, async () => 'sent', c)
      ).resolves.toBe('sent')
      advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
      await expect(service.takeRecentSpendersToProbe(chain, address)).resolves.toEqual([
        expect.objectContaining({ txid: c.txid }),
      ])
    })

    it('keeps a probe under way valid when an unknown outcome retires its claim', async () => {
      const claim = walletClaim()
      await service.runWithBroadcastClaim(claim, async () => 'signed')
      await service.recordInconclusiveBroadcast(chain, claim.txid, claim.outpoints, claim)
      advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      const [probe] = await service.takeRecentSpendersToProbe(chain, address)

      // Retiring the claim leaves the existing record as it is.
      await expect(service.consumeBroadcastClaim(claim)).resolves.toBe(true)
      await service.settleRecentSpendProbe(chain, probe!, 'gone')
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('never lets a probe that started before a newer record free it', async () => {
      const claim = walletClaim()
      await sendAccepted(claim)
      advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      const [stale] = await service.takeRecentSpendersToProbe(chain, address)

      // While that probe is in flight the same transaction is recorded
      // again (a claim-less rebroadcast ended inconclusively), within the
      // same millisecond the probe was handed out.
      await service.recordInconclusiveBroadcast(chain, claim.txid, claim.outpoints)
      await service.settleRecentSpendProbe(chain, stale!, 'gone')
      await service.settleRecentSpendProbe(chain, stale!, 'confirmed')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      // A fee bump takes the input over while a probe of the original runs:
      // the original turning up gone or confirmed frees nothing the bump spent.
      advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      const [ofOriginal] = await service.takeRecentSpendersToProbe(chain, address)
      expect(ofOriginal!.txid).toBe(claim.txid)
      await sendAccepted(walletClaim({ txid: '22'.repeat(32) }), claim.txid)
      await service.settleRecentSpendProbe(chain, ofOriginal!, 'gone')
      await service.settleRecentSpendProbe(chain, ofOriginal!, 'confirmed')
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
    })

    it('expires a recent spend a day after the last sign of its spender being pending', async () => {
      const claim = walletClaim()
      await sendAccepted(claim)

      // A spender found pending keeps its input for another day from then:
      // a low-fee payment can sit in the mempool far longer than a day.
      advance(QBIT_RECENT_SPEND_TTL_MS - 1)
      const [probe] = await service.takeRecentSpendersToProbe(chain, address)
      await service.settleRecentSpendProbe(chain, probe!, 'pending')
      advance(QBIT_RECENT_SPEND_TTL_MS - 1)
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      // Without one, it is a backstop for a spender nobody answers for.
      advance(1)
      await expect(reserved()).resolves.toEqual(new Set())
      await expect(
        service.broadcastIfAllowed(
          chain,
          '22'.repeat(32),
          broadcastClaim().outpoints,
          async () => 'late'
        )
      ).resolves.toBe('late')
    })

    it('keeps at most the limit of spent inputs, dropping the oldest first', async () => {
      const outpoints = Array.from({ length: QBIT_RECENT_SPEND_LIMIT + 1 }, (_, vout) => ({
        txid: 'cc'.repeat(32),
        vout,
      }))
      await service.recordInconclusiveBroadcast(chain, '44'.repeat(32), outpoints.slice(0, 1))
      advance(1)
      await service.recordInconclusiveBroadcast(chain, '45'.repeat(32), outpoints.slice(1))

      const kept = await reserved()
      expect(kept.size).toBe(QBIT_RECENT_SPEND_LIMIT)
      expect(kept.has(`${'cc'.repeat(32)}:0`)).toBe(false)
      expect(kept.has(`${'cc'.repeat(32)}:${QBIT_RECENT_SPEND_LIMIT}`)).toBe(true)
    })

    it("lets claim-less pushes crowd out each other, never the wallet's own sends", async () => {
      // The wallet's own send is the oldest record.
      await sendAccepted(walletClaim())
      advance(1)
      const pushed = Array.from({ length: QBIT_RECENT_SPEND_LIMIT }, (_, vout) => ({
        txid: 'cc'.repeat(32),
        vout,
      }))
      await service.broadcastIfAllowed(chain, '46'.repeat(32), pushed, async () => 'pushed')

      const kept = await reserved()
      expect(kept.size).toBe(QBIT_RECENT_SPEND_LIMIT)
      expect(kept.has(outpoint)).toBe(true)
      expect(kept.has(`${'cc'.repeat(32)}:0`)).toBe(false)
    })

    it('records an inconclusive broadcast and forgets it once absence is proven', async () => {
      const claim = walletClaim()
      await service.runWithBroadcastClaim(claim, async () => 'signed')
      await service.recordInconclusiveBroadcast(chain, claim.txid, claim.outpoints, claim)
      // The claim still holds the input; the record outlives its release.
      await expect(service.releaseBroadcastClaim(claim)).resolves.toBe(true)
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))

      await service.forgetAbsentBroadcast(chain, '22'.repeat(32))
      await expect(reserved()).resolves.toEqual(new Set([outpoint]))
      await service.forgetAbsentBroadcast(chain, claim.txid)
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('consumes a held claim into recent spends when a lookup proves acceptance', async () => {
      const claim = walletClaim()
      await service.runWithBroadcastClaim(claim, async () => 'signed')

      // A lookup for another transaction neither consumes nor records it.
      await service.recordAcceptedBroadcast(
        chain,
        '22'.repeat(32),
        [{ txid: 'dd'.repeat(32), vout: 0 }],
        claim
      )
      await expect(service.assertNoOverlap(chain, claim.outpoints)).rejects.toThrow(
        'claimed by an approved send'
      )

      await service.recordAcceptedBroadcast(chain, claim.txid, claim.outpoints, claim)
      await expect(service.assertNoOverlap(chain, claim.outpoints)).rejects.toThrow(
        'recent broadcast already spent'
      )
      await expect(reserved()).resolves.toEqual(new Set([outpoint, `${'dd'.repeat(32)}:0`]))

      // A status check only has the claim to go on: one the guard no longer
      // holds records nothing.
      const unheld = walletClaim({
        txid: '23'.repeat(32),
        outpoints: [{ txid: 'ee'.repeat(32), vout: 2 }],
      })
      await expect(service.consumeBroadcastClaim(unheld)).resolves.toBe(false)
      await expect(reserved()).resolves.not.toContain(`${'ee'.repeat(32)}:2`)
      await service.runWithBroadcastClaim(unheld, async () => 'signed')
      await expect(service.consumeBroadcastClaim(unheld)).resolves.toBe(true)
      await expect(service.assertNoOverlap(chain, unheld.outpoints)).rejects.toThrow(
        'recent broadcast already spent'
      )
      await expect(reserved()).resolves.toContain(`${'ee'.repeat(32)}:2`)
    })

    it('forgets recent spends on reset and reinitialization', async () => {
      await sendAccepted(walletClaim())
      await service.resetAllData()
      await expect(reserved()).resolves.toEqual(new Set())

      await sendAccepted(walletClaim({ txid: '22'.repeat(32) }))
      service.init()
      await expect(reserved()).resolves.toEqual(new Set())
    })
  })
})
