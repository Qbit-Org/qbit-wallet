import { describe, expect, it } from 'vitest'

import { PsbtActionDetailType, type ToSignData } from '../src/types/sign-tx'
import { isWebsiteSuppliedPsbt, psbtReviewOptions } from '../src/utils/psbt-review-options'

const providerContext = {
  origin: 'https://dapp.example',
  account: 'qbit1account',
  chain: 'QBIT_REGTEST',
  network: 'regtest',
} as ToSignData['providerContext']

const signPsbt: ToSignData = { psbtHex: '00', toSignInputs: [], providerContext }
const sendQbit: ToSignData = {
  psbtHex: '00',
  toSignInputs: [],
  providerContext,
  qbitSendBroadcastClaim: {
    chain: 'QBIT_REGTEST',
    address: 'qbit1account',
    origin: 'https://dapp.example',
    txid: '11'.repeat(32),
    outpoints: [],
  } as unknown as ToSignData['qbitSendBroadcastClaim'],
}
const walletSend: ToSignData = {
  psbtHex: '00',
  toSignInputs: [],
  action: {
    details: [{ type: PsbtActionDetailType.ADDRESS, value: 'qbit1recipient' }],
  } as unknown as ToSignData['action'],
}

describe('the review a request gives its PSBT', () => {
  it('treats the bytes of a website signPsbt or signPsbts as supplied by the website', () => {
    expect(isWebsiteSuppliedPsbt(signPsbt)).toBe(true)
  })

  it("treats a website's sendQbit, which the wallet built, and the wallet's own sends as the wallet's", () => {
    expect(isWebsiteSuppliedPsbt(sendQbit)).toBe(false)
    expect(isWebsiteSuppliedPsbt(walletSend)).toBe(false)
    expect(isWebsiteSuppliedPsbt(undefined)).toBe(false)
  })

  it('carries the named recipients and who supplied the bytes', () => {
    expect(psbtReviewOptions(signPsbt)).toEqual({ statedRecipients: [], suppliedByWebsite: true })
    expect(psbtReviewOptions(sendQbit)).toEqual({ statedRecipients: [], suppliedByWebsite: false })
    expect(psbtReviewOptions(walletSend)).toEqual({
      statedRecipients: ['qbit1recipient'],
      suppliedByWebsite: false,
    })
  })
})
