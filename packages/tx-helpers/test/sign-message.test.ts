import { SignMessageType } from '@qbit/wallet-shared'
import { AddressType, NetworkType } from '@qbit/wallet-types'
import { describe, expect, it, vi } from 'vitest'
import { EstimateWallet, LocalWallet } from '../src'

type RuntimeMessageSigner = (text: string, type: SignMessageType) => Promise<string>

async function expectP2mrRejected(wallet: LocalWallet | EstimateWallet) {
  const directKeyringSigner = vi.spyOn(wallet.keyring, 'signMessage')
  const signMessage = wallet.signMessage as RuntimeMessageSigner

  await expect(
    signMessage.call(wallet, 'P2MR must not use direct keyring signing', SignMessageType.P2MR)
  ).rejects.toThrow('P2MR message signing is not supported')
  expect(directKeyringSigner).not.toHaveBeenCalled()
}

describe('tx-helper message signing', () => {
  it('rejects P2MR in LocalWallet without invoking the direct keyring signer', async () => {
    const wallet = LocalWallet.fromRandom(AddressType.P2WPKH, NetworkType.MAINNET)

    await expectP2mrRejected(wallet)
  })

  it('rejects P2MR in EstimateWallet without invoking the direct keyring signer', async () => {
    const wallet = EstimateWallet.fromRandom(AddressType.P2WPKH, NetworkType.MAINNET)

    await expectP2mrRejected(wallet)
  })
})
