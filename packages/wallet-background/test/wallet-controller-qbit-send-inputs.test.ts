import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  decodePsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { preferenceService } from '../src/services'

vi.mock('../src/services', () => ({
  keyringService: {
    keyrings: [],
    preflightP2mrPsbtSigning: vi.fn(async () => ({
      required: 1,
      cached: 0,
      remainingBefore: 1073741824,
      remainingAfter: 1073741823,
      limit: 1073741824,
    })),
  },
  preferenceService: {
    getCurrentAccount: vi.fn(),
    getAddressFlag: vi.fn(() => 0),
    getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
  },
  qbitSendGuardService: {
    getReservedOutpointKeys: vi.fn(async () => new Set()),
    takeRecentSpendersToProbe: vi.fn(async () => []),
    settleRecentSpendProbe: vi.fn(),
  },
  walletApiService: { transactionCore: { pushTx: vi.fn(), decodePsbt: vi.fn() } },
  sessionService: {},
  contactBookService: {},
  notificationService: {},
  permissionService: {},
}))

vi.mock('../src/services/approval', () => ({ default: {} }))

function p2mrAccount(pubkeyHex: string) {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const address = p2mrAddressFromPubkey(pubkey, 'regtest')
  return {
    type: KeyringType.QbitHdKeyring,
    pubkey: pubkeyHex,
    address,
    key: `account-${pubkeyHex.slice(0, 2)}`,
    flag: 0,
    index: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: `m/87'/1'/0'/0/0`,
      scriptPubKey: bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript))),
      leafScript: bytesToHex(leafScript),
      addresses: { regtest: address },
      hkdf: { account: 0, change: 0, index: 0 },
      signatureCounter: {
        count: 0,
        limit: 1073741824,
        remaining: 1073741824,
        state: 'normal',
        provenance: 'local',
      },
    },
  }
}

const account = p2mrAccount('11'.repeat(32))
const otherAccount = p2mrAccount('22'.repeat(32))
const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'regtest')

function output(
  owner: { pubkey: string; p2mr: { scriptPubKey: string } },
  txidByte: string,
  satoshis: number
) {
  return {
    txid: txidByte.repeat(32),
    vout: 0,
    satoshis,
    scriptPk: owner.p2mr.scriptPubKey,
    pubkey: owner.pubkey,
    addressType: AddressType.P2MR,
  }
}

function send(qbitUtxos: ReturnType<typeof output>[], qbitUtxoAddress?: string) {
  return new WalletController().createSendQbitPsbt({
    to: recipient,
    amount: 10_000,
    feeRate: 1,
    qbitUtxos,
    qbitUtxoChain: ChainType.QBIT_REGTEST,
    ...(qbitUtxoAddress === undefined ? {} : { qbitUtxoAddress }),
  })
}

function sendAll(qbitUtxos: ReturnType<typeof output>[], qbitUtxoAddress?: string) {
  return new WalletController().createSendAllQbitPsbt({
    to: recipient,
    feeRate: 1,
    qbitUtxos,
    qbitUtxoChain: ChainType.QBIT_REGTEST,
    ...(qbitUtxoAddress === undefined ? {} : { qbitUtxoAddress }),
  })
}

describe('createSendQbitPsbt spends only the selected account’s outputs', () => {
  beforeEach(() => {
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
  })

  it('builds from outputs read for the selected account', async () => {
    const toSignData = await send([output(account, 'aa', 50_000)], account.address)

    const inputs = decodePsbt(parsePsbt(hexToBytes(toSignData.psbtHex))).inputs
    expect(inputs).toHaveLength(1)
    expect(bytesToHex(inputs[0]!.witnessUtxo!.scriptPubKey)).toBe(account.p2mr.scriptPubKey)
  })

  it('refuses outputs read for another account', async () => {
    await expect(send([output(account, 'aa', 50_000)], otherAccount.address)).rejects.toThrow(
      'Qbit account changed since the inputs were loaded'
    )
  })

  it('refuses outputs that do not name the account they were read for', async () => {
    await expect(send([output(account, 'aa', 50_000)])).rejects.toThrow(
      'Qbit inputs must name the account they were read for'
    )
  })

  it('refuses, for send-all too, outputs read for another account or for none', async () => {
    await expect(
      sendAll([output(otherAccount, 'bb', 50_000)], otherAccount.address)
    ).rejects.toThrow('Qbit account changed since the inputs were loaded')
    await expect(sendAll([output(account, 'aa', 50_000)])).rejects.toThrow(
      'Qbit inputs must name the account they were read for'
    )

    const toSignData = await sendAll([output(account, 'aa', 50_000)], account.address)
    expect(decodePsbt(parsePsbt(hexToBytes(toSignData.psbtHex))).inputs).toHaveLength(1)
  })

  it('refuses, in both builders, an output of another script among those it reads itself', async () => {
    const wallet = new WalletController()
    vi.spyOn(wallet as any, 'qbitAccountUtxosOn').mockResolvedValue([
      output(account, 'aa', 50_000),
      output(otherAccount, 'bb', 50_000),
    ])

    await expect(
      wallet.createSendQbitPsbt({ to: recipient, amount: 10_000, feeRate: 1 })
    ).rejects.toThrow('Qbit inputs must belong to the selected account')
    await expect(wallet.createSendAllQbitPsbt({ to: recipient, feeRate: 1 })).rejects.toThrow(
      'Qbit inputs must belong to the selected account'
    )
  })

  it('refuses, for send-all too, an output of another script or with none, rather than skip or stamp it', async () => {
    await expect(
      sendAll([output(account, 'aa', 50_000), output(otherAccount, 'bb', 50_000)], account.address)
    ).rejects.toThrow('Qbit inputs must belong to the selected account')
    const unlabelled = { ...output(account, 'cc', 50_000), scriptPk: '' }
    await expect(
      sendAll([output(account, 'aa', 50_000), unlabelled], account.address)
    ).rejects.toThrow('Qbit inputs must carry their scriptPubKey')
  })

  it('refuses an output of another account among its own', async () => {
    await expect(
      send([output(account, 'aa', 50_000), output(otherAccount, 'bb', 50_000)], account.address)
    ).rejects.toThrow('Qbit inputs must belong to the selected account')
  })

  it('refuses an output without a scriptPubKey instead of taking it for its own', async () => {
    const unlabelled = { ...output(otherAccount, 'bb', 50_000), scriptPk: '' }

    await expect(send([unlabelled], account.address)).rejects.toThrow(
      'Qbit inputs must carry their scriptPubKey'
    )
  })
})
