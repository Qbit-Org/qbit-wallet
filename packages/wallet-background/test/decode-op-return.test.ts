import { transactionCore } from '@qbit/wallet-core'
import { describe, expect, it } from 'vitest'

import { decodeOpReturnScript } from '../src/utils/decode-op-return'

function compiledOpReturn(...chunks: Buffer[]): Buffer {
  return transactionCore.script.compile([transactionCore.opcodes.OP_RETURN, ...chunks])
}

describe('qbit OP_RETURN output decoding', () => {
  it('preserves the exact hello script, payload, boundaries, and safe preview', () => {
    const decoded = decodeOpReturnScript(Buffer.from('6a0568656c6c6f', 'hex'))

    expect(decoded).toEqual({
      scriptPubKeyHex: '6a0568656c6c6f',
      chunks: [
        {
          pushHeaderHex: '05',
          dataHex: '68656c6c6f',
          dataByteLength: 5,
          dataStartByte: 2,
          dataEndByte: 7,
          utf8Preview: 'hello',
        },
      ],
    })
  })

  it('keeps hex-looking ABCD as raw abcd bytes without a benign text preview', () => {
    const decoded = decodeOpReturnScript(Buffer.from('6a02abcd', 'hex'))

    expect(decoded?.scriptPubKeyHex).toBe('6a02abcd')
    expect(decoded?.chunks).toEqual([
      {
        pushHeaderHex: '02',
        dataHex: 'abcd',
        dataByteLength: 2,
        dataStartByte: 2,
        dataEndByte: 4,
      },
    ])
  })

  it('omits the preview when otherwise valid UTF-8 contains control bytes', () => {
    const decoded = decodeOpReturnScript(Buffer.from('6a03410a42', 'hex'))

    expect(decoded?.chunks[0]).toMatchObject({
      dataHex: '410a42',
      dataByteLength: 3,
    })
    expect(decoded?.chunks[0]!.utf8Preview).toBeUndefined()
  })

  it.each([
    { length: 75, pushHeaderHex: '4b', dataStartByte: 2 },
    { length: 76, pushHeaderHex: '4c4c', dataStartByte: 3 },
    { length: 80, pushHeaderHex: '4c50', dataStartByte: 3 },
  ])(
    'preserves a $length-byte payload across direct-push and PUSHDATA1 boundaries',
    ({ length, pushHeaderHex, dataStartByte }) => {
      const payload = Buffer.alloc(length, 0x80)
      const script = compiledOpReturn(payload)
      const decoded = decodeOpReturnScript(script)

      expect(decoded?.scriptPubKeyHex).toBe(script.toString('hex'))
      expect(decoded?.chunks).toEqual([
        {
          pushHeaderHex,
          dataHex: payload.toString('hex'),
          dataByteLength: length,
          dataStartByte,
          dataEndByte: dataStartByte + length,
        },
      ])
      expect(decoded?.decodeWarning).toBeUndefined()
    }
  )

  it('preserves multiple pushes as separate chunks in byte order', () => {
    const script = compiledOpReturn(Buffer.from('aa', 'hex'), Buffer.from('hello'))
    const decoded = decodeOpReturnScript(script)

    expect(decoded?.scriptPubKeyHex).toBe('6a01aa0568656c6c6f')
    expect(decoded?.chunks).toEqual([
      {
        pushHeaderHex: '01',
        dataHex: 'aa',
        dataByteLength: 1,
        dataStartByte: 2,
        dataEndByte: 3,
      },
      {
        pushHeaderHex: '05',
        dataHex: '68656c6c6f',
        dataByteLength: 5,
        dataStartByte: 4,
        dataEndByte: 9,
        utf8Preview: 'hello',
      },
    ])
  })

  it('keeps unusual non-push OP_RETURN raw and returns a visible warning state', () => {
    expect(decodeOpReturnScript(Buffer.from('6a51', 'hex'))).toEqual({
      scriptPubKeyHex: '6a51',
      chunks: [],
      decodeWarning: 'non-pushdata-opcode',
    })
  })

  it('keeps malformed PUSHDATA1 raw and returns a visible warning state', () => {
    expect(decodeOpReturnScript(Buffer.from('6a4c02aa', 'hex'))).toEqual({
      scriptPubKeyHex: '6a4c02aa',
      chunks: [],
      decodeWarning: 'malformed-pushdata',
    })
  })

  it('does not classify a normal output script as OP_RETURN', () => {
    expect(decodeOpReturnScript(Buffer.from(`5120${'11'.repeat(32)}`, 'hex'))).toBeUndefined()
  })
})
