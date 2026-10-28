import {
  OP_2,
  P2MR_PROGRAM_BYTES,
  QbitProtocolError,
  bytesToHex,
  p2mrLeafHash,
  verifyControlBlock,
  type P2mrPsbtLeafScriptField,
  type PsbtInputSummary,
} from '@qbit-oss/protocol'
import { ErrorCodes, WalletError } from '@qbit/wallet-shared'

function controlBlockRoot(record: P2mrPsbtLeafScriptField): string | undefined {
  try {
    return bytesToHex(
      verifyControlBlock(
        record.controlBlock,
        p2mrLeafHash(record.leafVersion, record.script),
        record.leafVersion
      )
    )
  } catch (error) {
    if (!(error instanceof QbitProtocolError)) throw error
    return undefined
  }
}

/** The record, or why the input does not have exactly one that is safe to sign for. */
function signingLeafRecord(
  input: PsbtInputSummary,
  leafHash: string
): P2mrPsbtLeafScriptField | string {
  const records = input.leafScripts.filter(
    leaf => bytesToHex(p2mrLeafHash(leaf.leafVersion, leaf.script)) === leafHash
  )
  const [record] = records
  if (!record) return "PSBT has no leaf record for the account's P2MR leaf"
  if (records.length > 1) {
    return (
      "PSBT lists the account's P2MR leaf more than once; " +
      'give it one leaf record, with the control block that spends the input'
    )
  }
  // The output program finalize reads (requireP2mrInputRoot in @qbit-oss/protocol).
  const scriptPubKey = input.witnessUtxo?.scriptPubKey
  if (!scriptPubKey) return 'missing witness UTXO'
  if (
    scriptPubKey.length !== 2 + P2MR_PROGRAM_BYTES ||
    scriptPubKey[0] !== OP_2 ||
    scriptPubKey[1] !== P2MR_PROGRAM_BYTES
  ) {
    return 'witness UTXO is not a P2MR output'
  }
  const root = bytesToHex(scriptPubKey.subarray(2))
  if (input.merkleRoot && bytesToHex(input.merkleRoot) !== root) {
    return 'P2MR merkle root does not match the witness UTXO program'
  }
  if (controlBlockRoot(record) !== root) {
    return "the control block of the account's P2MR leaf does not commit to the witness UTXO program"
  }
  return record
}

/**
 * Refuse, with `-32602`, an input whose leaf record for the account's P2MR
 * leaf `leafHash` is ambiguous (#352). A website PSBT can list one leaf
 * several times, each with its own control block, some of which need not
 * commit to the spent output. `finalizeP2mrPsbt` skips those and reveals the
 * leaf's shortest control block that commits, so a check of the signed PSBT
 * against any other record fails after the signature counter has moved. The
 * wallet therefore signs a leaf only when the input lists it once, with a
 * control block that commits to the witness UTXO program: that record is the
 * one finalize puts in the witness. Run while the signing plan is prepared,
 * before any counter moves.
 */
export function assertQbitP2mrSigningLeafRecord(
  input: PsbtInputSummary,
  inputIndex: number,
  leafHash: string
): void {
  const record = signingLeafRecord(input, leafHash)
  if (typeof record === 'string') {
    throw new WalletError(ErrorCodes.INVALID_PARAMS, `input ${inputIndex}: ${record}`)
  }
}

/**
 * The leaf record a signed PSBT is checked against: the one the plan was
 * prepared for and finalize reveals, by the rule of
 * `assertQbitP2mrSigningLeafRecord`. The signature is already spent here, so
 * a failure is an internal error rather than a request the website can fix.
 */
export function qbitP2mrSigningLeafRecord(
  input: PsbtInputSummary,
  inputIndex: number,
  leafHash: string
): P2mrPsbtLeafScriptField {
  const record = signingLeafRecord(input, leafHash)
  if (typeof record === 'string') {
    throw new Error(`invalid Qbit signing plan: input ${inputIndex}: ${record}`)
  }
  return record
}
