import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { P2mrMessageProof } from '@qbit/wallet-shared'
import { QbitAPIMethods } from '../../../apps/extension/src/content-script/pageProvider/qbitAPI'

const PROOF = {
  type: 'p2mr-message',
  version: 1,
  address: 'qbrt1zproof',
  message_hash: '11'.repeat(32),
  datasig_hash: '22'.repeat(32),
  domain: 'QbitDataSigPQC',
  message_domain: 'QbitWalletSignedMessage',
  algorithm: 'SLH-DSA-SHA2-128s-bounded30',
  proof_mode: 'p2mr-pubkey',
  pubkey: '33'.repeat(32),
  signature: '44',
  leaf_version: 0xc0,
  leaf_script: '55',
  control_block: 'c1',
  p2mr_merkle_root: '66'.repeat(32),
} satisfies P2mrMessageProof

describe('QbitAPIMethods P2MR messages', () => {
  it('exposes one structured P2MR signMessage result type', () => {
    const api = null as unknown as QbitAPIMethods

    if (false) {
      expectTypeOf(api.signMessage('hello')).toEqualTypeOf<Promise<P2mrMessageProof>>()
      expectTypeOf(api.verifyMessage('qbrt1zproof', 'hello', PROOF)).toEqualTypeOf<
        Promise<boolean>
      >()
    }

    expect(true).toBe(true)
  })

  it('requests a structured P2MR message proof through the canonical method', async () => {
    const request = vi.fn().mockResolvedValue(PROOF)
    const api = new QbitAPIMethods(request)

    await expect(api.signMessage('hello')).resolves.toBe(PROOF)
    expect(request).toHaveBeenCalledWith({
      method: 'signMessage',
      params: { text: 'hello' },
    })
  })

  it('binds verification to the explicit address and exact text', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const api = new QbitAPIMethods(request)

    await expect(api.verifyMessage(PROOF.address, 'hello', PROOF)).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith({
      method: 'verifyMessage',
      params: { address: PROOF.address, text: 'hello', proof: PROOF },
    })
  })
})
