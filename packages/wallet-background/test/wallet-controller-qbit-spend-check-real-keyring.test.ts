import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { init as initPqc } from '@qbit-oss/pqc'
import {
  P2MR_LEAF_VERSION_V1,
  PSBT_IN_SIGHASH_TYPE,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { CHAINS_MAP, type ToSignData } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// A website's PSBT and the check of the inputs a signing spends (#210), over
// the real background and memory storage: the keyring service and real Qbit
// HD wallets, the preferences, the send guard, a wallet's removal and the
// signing, the keyring's own key check and sighash rules included. Only the
// approval itself is not opened: each entry is prepared by
// prepareQbitProviderPsbt and admitted as the provider flow admits it when the
// approval is installed. The explorer is a fake served over fetch, which
// nothing here reads.
//
// - Keeping a website's approval across a wallet's removal relies on this: an
//   approval left open for bytes prepared for wallet A, and wallet A itself
//   removed. Its admission still lets the signing skip the check, and the
//   keyring refuses it by its key check, before any signature counter unit:
//   the keys it names are no key of the account the wallet now selects.
// - A website's PSBT that names a partial sighash type (#211) for the
//   account's input, beside a counterparty's input, signs under that type,
//   unchecked, while its approval is open, and is checked once it settles.

// The keyring service's storage.
class MemoryStorage {
  readonly values = new Map<string, unknown>()

  async get(key: string): Promise<unknown> {
    return this.values.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }
}

class JsonEncryptor {
  async encrypt(password: string, data: unknown): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<unknown> {
    const parsed = JSON.parse(encryptedData) as { password: string; data: unknown }
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }
}

// The preferences' storage, which keeps what was written as JSON.
class DiskAdapter {
  readonly disk = new Map<string, string>()

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    return { ...structuredClone(template), ...((await this.get(name)) as object | undefined) }
  }

  async get(key: string): Promise<unknown> {
    const raw = this.disk.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.disk.set(key, JSON.stringify(value))
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const PASSWORD = 'password'
const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const QBIT_PATH = "m/87'/0'/0'/0"

let wallet: WalletController
let explorer: FakeQbitExplorer

beforeAll(async () => {
  await initPqc()
})

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  await preferenceService.init({ storage: new DiskAdapter() as any, logger })
  await keyringService.init({
    storage: new MemoryStorage() as any,
    encryptor: new JsonEncryptor(),
    logger,
    t: (key: string) => key,
    eventBus: { emit: vi.fn() } as any,
  })
  await keyringService.boot(PASSWORD)
  qbitSendGuardService.init()
  explorer = new FakeQbitExplorer(CHAINS_MAP[ChainType.QBIT_MAINNET]!.qbitApiSurface)
  vi.stubGlobal('fetch', explorer.fetch)
  wallet = new WalletController()
})

afterEach(() => {
  clearTimeout((wallet as unknown as { timer: ReturnType<typeof setTimeout> }).timer)
  vi.unstubAllGlobals()
})

describe('a website approval left open for a wallet that is then removed (#210)', () => {
  it('is refused by the keyring’s key check, not signed, and not checked as a wallet send', async () => {
    // Wallet B, then wallet A, which is selected.
    await wallet.createKeyringWithMnemonics(OTHER_MNEMONIC, QBIT_PATH, '', AddressType.P2MR, 1)
    await wallet.createKeyringWithMnemonics(MNEMONIC, QBIT_PATH, '', AddressType.P2MR, 1)
    const accountA = preferenceService.getCurrentAccount()!
    const p2mrA = accountA.p2mr!
    const chain = wallet.getChainType()
    expect(chain).toBe(ChainType.QBIT_MAINNET)

    // A website's PSBT spending an output of A, prepared for A and admitted
    // as its approval opens.
    const leafScript = hexToBytes(p2mrA.leafScript)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: hexToBytes(fakeTxid(1, 55)).reverse(), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey: hexToBytes(p2mrA.scriptPubKey) },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 48_000n, scriptPubKey: hexToBytes(p2mrA.scriptPubKey) }],
    })
    const providerContext = {
      origin: 'https://dapp.example',
      account: accountA.address,
      chain,
      network: 'mainnet' as const,
    }
    const website = await wallet.prepareQbitProviderPsbt(bytesToHex(serializePsbt(psbt)), {
      chain,
    } as any)
    website.providerContext = providerContext as any
    wallet.admitQbitWebsitePsbts([website])

    // Wallet A itself is removed, and B, the one left, is selected.
    const walletA = (await wallet.getKeyrings()).find(each =>
      each.accounts.some(held => held.address === accountA.address)
    )!
    await wallet.removeKeyring(walletA)
    const accountB = preferenceService.getCurrentAccount()!
    expect(accountB.address).not.toBe(accountA.address)
    expect((await wallet.getKeyrings()).map(each => each.accounts[0]?.address)).toEqual([
      accountB.address,
    ])

    const counterBefore = await keyringService.getPqcSignatureCounter(accountB.pubkey)
    const signing = vi.spyOn(keyringService, 'signP2mrPsbtWithCounter')
    const units = vi.spyOn(keyringService as any, 'signPqcDigestWithCounterTargetUnlocked')
    const before = explorer.requests.length

    await expect(wallet.signPsbtV2({ ...website, providerContext } as ToSignData)).rejects.toThrow(
      'P2MR signing key does not match the selected account'
    )

    // The keyring refused it, for the account now selected, by its key check.
    expect(signing).toHaveBeenCalledTimes(1)
    expect(signing.mock.calls[0]![0]).toBe(accountB.address)
    await expect(signing.mock.results[0]!.value).rejects.toThrow(
      'P2MR signing key does not match the selected account'
    )
    // No unit taken, no signature made.
    expect(units).not.toHaveBeenCalled()
    expect(await keyringService.getPqcSignatureCounter(accountB.pubkey)).toBe(counterBefore)
    // Still admitted, it skipped the check, and the keyring's key check is
    // what refused it: the error above, and the keyring's one call. A check
    // would have read nothing here either (it refuses another account's
    // script before any read), but would have refused it itself, with its
    // own cause, and never called the keyring.
    expect(explorer.requests.slice(before)).toEqual([])
  }, 120_000)
})

describe('a website PSBT whose account input names a partial sighash type (#211)', () => {
  const SINGLE_ANYONECANPAY = 0x83

  /** `psbtHex` with `PSBT_IN_SIGHASH_TYPE` set on input `inputIndex`, as a website names it. */
  function withSighashType(psbtHex: string, inputIndex: number, hashType: number): string {
    const psbt = parsePsbt(hexToBytes(psbtHex))
    const value = new Uint8Array(4)
    new DataView(value.buffer).setUint32(0, hashType, true)
    psbt.inputs[inputIndex]!.push({ key: Uint8Array.of(PSBT_IN_SIGHASH_TYPE), value })
    return bytesToHex(serializePsbt(psbt))
  }

  it('signs under that type, unchecked, while its approval is open, the counterparty’s input with it, and checks the same bytes once it settles', async () => {
    await wallet.createKeyringWithMnemonics(MNEMONIC, QBIT_PATH, '', AddressType.P2MR, 1)
    const account = preferenceService.getCurrentAccount()!
    const p2mr = account.p2mr!
    const chain = wallet.getChainType()
    const leafScript = hexToBytes(p2mr.leafScript)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const counterpartyLeaf = singleKeyLeafScript(hexToBytes('33'.repeat(32)))
    const counterpartyLeafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, counterpartyLeaf)
    const counterpartyScript = p2mrScriptPubKey(counterpartyLeafHash)
    // A listing: the account's output, signed under SIGHASH_SINGLE |
    // ANYONECANPAY for the payment back to it at the same index; the
    // counterparty's input pays the rest.
    const listing = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: hexToBytes(fakeTxid(1, 57)).reverse(), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey: hexToBytes(p2mr.scriptPubKey) },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
        {
          prevout: { txid: hexToBytes(fakeTxid(2, 57)).reverse(), vout: 0 },
          witnessUtxo: { value: 40_000n, scriptPubKey: counterpartyScript },
          leafScript: counterpartyLeaf,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: counterpartyLeafHash,
        },
      ],
      outputs: [
        { value: 60_000n, scriptPubKey: hexToBytes(p2mr.scriptPubKey) },
        { value: 28_000n, scriptPubKey: counterpartyScript },
      ],
    })
    const psbtHex = withSighashType(bytesToHex(serializePsbt(listing)), 0, SINGLE_ANYONECANPAY)
    const providerContext = {
      origin: 'https://dapp.example',
      account: account.address,
      chain,
      network: 'mainnet' as const,
    }
    const website = await wallet.prepareQbitProviderPsbt(psbtHex, { chain } as any)
    expect(website.qbitP2mrSigningKeys).toEqual([
      expect.objectContaining({ inputIndex: 0, hashType: SINGLE_ANYONECANPAY }),
    ])
    website.providerContext = providerContext as any
    const release = wallet.admitQbitWebsitePsbts([website])
    const counterBefore = await keyringService.getPqcSignatureCounter(account.pubkey)
    const before = explorer.requests.length

    const signed = await wallet.signPsbtV2({ ...website, providerContext } as ToSignData)

    // Signed under the type the website named, with no lookup: one unit.
    const [own, theirs] = decodePsbt(parsePsbt(hexToBytes(signed.psbtHex))).inputs
    expect(own!.scriptSigs.map(sig => sig.signature.hashType)).toEqual([SINGLE_ANYONECANPAY])
    expect(theirs!.scriptSigs).toEqual([])
    expect(explorer.requests.slice(before)).toEqual([])
    expect(await keyringService.getPqcSignatureCounter(account.pubkey)).toBe(counterBefore + 1)

    // Its approval settled: the same bytes are checked, and the
    // counterparty's input, no output of the account, is refused before any
    // read or unit.
    release()
    await expect(wallet.signPsbtV2({ ...website, providerContext } as ToSignData)).rejects.toThrow(
      'send_input_check_mismatch'
    )
    expect(explorer.requests.slice(before)).toEqual([])
    expect(await keyringService.getPqcSignatureCounter(account.pubkey)).toBe(counterBefore + 1)
  }, 120_000)
})
