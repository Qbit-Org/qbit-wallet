import { DecodedOpReturn, DecodedOpReturnChunk } from '@qbit/wallet-shared'
import { transactionCore } from '@qbit/wallet-core'

const OP_0 = transactionCore.opcodes['OP_0']!
const OP_PUSHDATA1 = transactionCore.opcodes['OP_PUSHDATA1']!
const OP_PUSHDATA2 = transactionCore.opcodes['OP_PUSHDATA2']!
const OP_PUSHDATA4 = transactionCore.opcodes['OP_PUSHDATA4']!
const OP_RETURN = transactionCore.opcodes['OP_RETURN']!

function safeUtf8Preview(data: Buffer): string | undefined {
  if (data.length === 0) return undefined

  try {
    const preview = new TextDecoder('utf-8', { fatal: true }).decode(data)
    // Keep the preview deliberately conservative. Hex remains canonical, and
    // controls, invisible Unicode, bidi text, and confusable glyphs are omitted.
    if (!preview || !/^[\x20-\x7e]+$/.test(preview)) return undefined
    return preview
  } catch (e) {
    return undefined
  }
}

function readPushChunk(script: Buffer, offset: number): DecodedOpReturnChunk | undefined {
  const opcode = script[offset]
  if (opcode === undefined) return undefined

  let dataByteLength: number
  let dataStartByte: number

  if (opcode === OP_0) {
    dataByteLength = 0
    dataStartByte = offset + 1
  } else if (opcode >= 0x01 && opcode <= 0x4b) {
    dataByteLength = opcode
    dataStartByte = offset + 1
  } else if (opcode === OP_PUSHDATA1) {
    if (offset + 1 >= script.length) return undefined
    dataByteLength = script[offset + 1]!
    dataStartByte = offset + 2
  } else if (opcode === OP_PUSHDATA2) {
    if (offset + 2 >= script.length) return undefined
    dataByteLength = script.readUInt16LE(offset + 1)
    dataStartByte = offset + 3
  } else if (opcode === OP_PUSHDATA4) {
    if (offset + 4 >= script.length) return undefined
    dataByteLength = script.readUInt32LE(offset + 1)
    dataStartByte = offset + 5
  } else {
    return undefined
  }

  const dataEndByte = dataStartByte + dataByteLength
  if (dataEndByte > script.length) return undefined

  const data = script.subarray(dataStartByte, dataEndByte)
  const utf8Preview = safeUtf8Preview(data)
  return {
    pushHeaderHex: script.subarray(offset, dataStartByte).toString('hex'),
    dataHex: data.toString('hex'),
    dataByteLength,
    dataStartByte,
    dataEndByte,
    ...(utf8Preview === undefined ? {} : { utf8Preview }),
  }
}

/**
 * Decode an OP_RETURN script without reconstructing or normalizing any bytes.
 * The transaction library validates the complete script; the raw scanner only
 * records exact push headers and boundaries from that validated source buffer.
 */
export function decodeOpReturnScript(scriptBytes: Uint8Array): DecodedOpReturn | undefined {
  if (scriptBytes[0] !== OP_RETURN) return undefined

  const script = Buffer.from(scriptBytes)
  const scriptPubKeyHex = script.toString('hex')
  const decompiled = transactionCore.script.decompile(script)
  if (!decompiled || decompiled[0] !== OP_RETURN) {
    return {
      scriptPubKeyHex,
      chunks: [],
      decodeWarning: 'malformed-pushdata',
    }
  }

  const chunks: DecodedOpReturnChunk[] = []
  let offset = 1
  while (offset < script.length) {
    const chunk = readPushChunk(script, offset)
    if (!chunk) {
      const opcode = script[offset]
      const isPushOpcode =
        opcode === OP_0 || (opcode !== undefined && opcode >= 0x01 && opcode <= OP_PUSHDATA4)
      return {
        scriptPubKeyHex,
        chunks,
        decodeWarning: isPushOpcode ? 'malformed-pushdata' : 'non-pushdata-opcode',
      }
    }
    chunks.push(chunk)
    offset = chunk.dataEndByte
  }

  return {
    scriptPubKeyHex,
    chunks,
  }
}
