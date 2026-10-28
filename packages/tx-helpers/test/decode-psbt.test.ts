import { transactionCore } from '@qbit/wallet-core'
import { DummyTxType, RiskType } from '@qbit/wallet-shared'
import { AddressType, NetworkType } from '@qbit/wallet-types'
import { describe, expect, it } from 'vitest'
import { PsbtDecoder, createDummyTx } from '../src'
import { LocalWallet } from '../src/wallet/local-wallet'

async function decodeWithSighashType(sighashType: number) {
  const wallet = LocalWallet.fromRandom(AddressType.P2TR, NetworkType.MAINNET)
  const { psbt, toSignInputs } = createDummyTx({
    address: wallet.address,
    pubkey: wallet.pubkey,
    txType: DummyTxType.SEND_QBIT,
  })
  psbt.data.inputs[0]!.sighashType = sighashType

  const decoder = new PsbtDecoder({
    toSignData: {
      psbtHex: psbt.toHex(),
      toSignInputs,
    },
    networkType: NetworkType.MAINNET,
  })
  return decoder.decode()
}

describe('decode psbt sighash risk detection', () => {
  it('detects SIGHASH_NONE as dangerous', async () => {
    const dangerous = await decodeWithSighashType(transactionCore.Transaction.SIGHASH_NONE)
    expect(dangerous.risks.some(r => r.type === RiskType.SIGHASH_NONE)).toBe(true)
  })

  it('detects SIGHASH_NONE | ANYONECANPAY as dangerous', async () => {
    const dangerous = await decodeWithSighashType(
      transactionCore.Transaction.SIGHASH_NONE | transactionCore.Transaction.SIGHASH_ANYONECANPAY
    )
    expect(dangerous.risks.some(r => r.type === RiskType.SIGHASH_NONE)).toBe(true)
  })

  it('does not flag SIGHASH_SINGLE | ANYONECANPAY as dangerous', async () => {
    const safe = await decodeWithSighashType(
      transactionCore.Transaction.SIGHASH_SINGLE | transactionCore.Transaction.SIGHASH_ANYONECANPAY
    )
    expect(safe.risks.some(r => r.type === RiskType.SIGHASH_NONE)).toBe(false)
  })

  it('does not flag SIGHASH_ALL as dangerous', async () => {
    const safe = await decodeWithSighashType(transactionCore.Transaction.SIGHASH_ALL)
    expect(safe.risks.some(r => r.type === RiskType.SIGHASH_NONE)).toBe(false)
  })
})
