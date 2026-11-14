/**
 * An explorer client for classification tests that records every
 * transaction read: how many are in flight at once (`peak`), which started,
 * which were cancelled. Each read answers a few microtasks after it starts,
 * so reads overlap as over a network, or waits at `gate` while one is set.
 * A read whose signal aborts rejects with its reason at once, as the wallet's
 * explorer clients do.
 */

import {
  addressToScriptPubKey,
  bytesToHex,
  hexToBytes,
  outputScriptToAddress,
} from '@qbit-oss/protocol'

export interface FakeListedOutput {
  txid: string
  vout: number
  value: number
  status: { confirmed: boolean; block_height?: number }
}

export const ACCOUNT_SCRIPT = `5220${'aa'.repeat(32)}`
export const FOREIGN_SCRIPT = `5220${'bb'.repeat(32)}`
export const OTHER_SCRIPT = `5220${'cc'.repeat(32)}`
/** The regtest addresses those scripts pay, as the explorer lists outputs by. */
export const ACCOUNT_ADDRESS = outputScriptToAddress(hexToBytes(ACCOUNT_SCRIPT), 'regtest')
export const OTHER_ADDRESS = outputScriptToAddress(hexToBytes(OTHER_SCRIPT), 'regtest')

/** The script `address` is paid with. */
export function scriptOf(address: string): string {
  return bytesToHex(addressToScriptPubKey(address))
}

/** A 64-hex txid unique to `index` and `salt`. */
export function testTxid(index: number, salt = 0): string {
  return (index * 7_919 + salt * 1_000_003 + 1).toString(16).padStart(64, '0')
}

export class ClassifyReadsExplorer {
  readonly txs = new Map<string, Record<string, unknown>>()
  readonly listings = new Map<string, FakeListedOutput[]>()
  readonly started: string[] = []
  readonly aborted: string[] = []
  /** Reads that fail, by txid, with the error they reject with. */
  readonly failures = new Map<string, unknown>()
  inFlight = 0
  peak = 0
  tipHeight = 2_000
  /** Tip reads made, and the error they reject with while set. */
  tipReads = 0
  tipFailure: unknown
  /** While set, every tip read waits for it, or for its signal to abort. */
  tipGate: Promise<void> | undefined
  private openTipGate: () => void = () => undefined

  holdTip(): void {
    this.tipGate = new Promise(resolve => (this.openTipGate = resolve))
  }

  releaseTip(): void {
    this.tipGate = undefined
    this.openTipGate()
  }
  /** While set, every read waits for it before it answers. */
  gate: Promise<void> | undefined
  private openGate: () => void = () => undefined
  /** Reads started and not yet settled, by txid: each rejects at once with `fail`. */
  private readonly unsettled = new Map<string, (error: unknown) => void>()

  hold(): void {
    this.gate = new Promise(resolve => (this.openGate = resolve))
  }

  release(): void {
    this.gate = undefined
    this.openGate()
  }

  readonly client = {
    // The total the listing holds, as the address statistics would give it.
    getAddressBalance: async (address: string) => {
      const total = (this.listings.get(address) ?? []).reduce((sum, utxo) => sum + utxo.value, 0)
      return { address, confirmedSats: total, mempoolSats: 0, totalSats: total }
    },
    getAddressUtxos: async (address: string) =>
      (this.listings.get(address) ?? []).map(utxo => ({ ...utxo, status: { ...utxo.status } })),
    getTipHeight: (options?: { signal?: AbortSignal }) => {
      this.tipReads += 1
      const answer = (): number => {
        if (this.tipFailure !== undefined) throw this.tipFailure
        return this.tipHeight
      }
      const gate = this.tipGate
      if (!gate) return Promise.resolve().then(answer)
      const signal = options?.signal
      return new Promise<number>((resolve, reject) => {
        const onAbort = (): void => reject(signal?.reason)
        signal?.addEventListener('abort', onAbort, { once: true })
        gate.then(() => {
          signal?.removeEventListener('abort', onAbort)
          try {
            resolve(answer())
          } catch (error) {
            reject(error)
          }
        })
      })
    },
    getTx: (txid: string, options?: { signal?: AbortSignal }) => this.read(txid, options?.signal),
  }

  /** Fail the read of `txid` in flight now, whatever holds the others. */
  fail(txid: string, error: unknown): void {
    const fail = this.unsettled.get(txid)
    if (!fail) throw new Error(`no read of ${txid} in flight`)
    fail(error)
  }

  /** How many reads of `txid` started. */
  readsOf(txid: string): number {
    return this.started.filter(started => started === txid).length
  }

  /**
   * `count` confirmed outputs paying `address`, each its own transaction's
   * only output, the first `coinbaseCount` of them coinbase rewards.
   */
  fund(address: string, count: number, { salt = 0, coinbaseCount = 0 } = {}): void {
    const listing = this.listings.get(address) ?? []
    for (let index = 0; index < count; index += 1) {
      const txid = testTxid(index, salt)
      const coinbase = index < coinbaseCount
      this.addTx(txid, {
        vin: coinbase ? [{ is_coinbase: true }] : [this.input(testTxid(index, salt + 50), 0)],
        outputs: [{ script: scriptOf(address), value: 10_000 + index }],
        confirmed: true,
      })
      listing.push({
        txid,
        vout: 0,
        value: 10_000 + index,
        status: { confirmed: true, block_height: 100 + (index % 500) },
      })
    }
    this.listings.set(address, listing)
  }

  addTx(
    txid: string,
    {
      vin,
      outputs,
      confirmed,
      size = 3_860,
    }: {
      vin: Record<string, unknown>[]
      outputs: { script: string; value: number }[]
      confirmed: boolean
      size?: number
    }
  ): void {
    this.txs.set(txid, {
      txid,
      vin,
      vout: outputs.map(output => ({ scriptpubkey: output.script, value: output.value })),
      size,
      weight: size,
      status: confirmed ? { confirmed: true, block_height: 150 } : { confirmed: false },
    })
  }

  /** An input spending `txid:vout`, an output of the account's script. */
  input(txid: string, vout: number, value = 20_000): Record<string, unknown> {
    return {
      txid,
      vout,
      is_coinbase: false,
      prevout: { scriptpubkey: ACCOUNT_SCRIPT, value },
    }
  }

  list(address: string, output: FakeListedOutput): void {
    this.listings.set(address, [...(this.listings.get(address) ?? []), output])
  }

  private read(txid: string, signal: AbortSignal | undefined): Promise<unknown> {
    this.started.push(txid)
    this.inFlight += 1
    this.peak = Math.max(this.peak, this.inFlight)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (): boolean => {
        if (settled) return false
        settled = true
        this.inFlight -= 1
        this.unsettled.delete(txid)
        signal?.removeEventListener('abort', onAbort)
        return true
      }
      this.unsettled.set(txid, error => {
        if (finish()) reject(error)
      })
      const onAbort = (): void => {
        if (!finish()) return
        this.aborted.push(txid)
        reject(signal!.reason)
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const answer = (): void => {
        if (!finish()) return
        if (this.failures.has(txid)) {
          reject(this.failures.get(txid))
          return
        }
        const tx = this.txs.get(txid)
        if (!tx) {
          reject(new Error(`no transaction ${txid}`))
          return
        }
        resolve(JSON.parse(JSON.stringify(tx)))
      }
      const gate = this.gate
      Promise.resolve()
        .then(() => gate)
        .then(() => Promise.resolve())
        .then(answer)
    })
  }
}

/** Resolve once every microtask queued so far, and those they queue, have run. */
export async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve()
}

/** Collect the unhandled rejections raised while `run` runs and a turn after. */
export async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const onRejection = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', onRejection)
  try {
    await run()
    await new Promise(resolve => setTimeout(resolve, 0))
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  return seen
}
