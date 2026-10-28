import assert from 'node:assert/strict'
import test from 'node:test'

import { redactSensitive } from './redact-sensitive.mjs'

test('redacts every supported private extended-key prefix', () => {
  for (const prefix of ['qprv', 'tqpv', 'qrpv', 'xprv', 'tprv']) {
    const descriptor = `mr(pk(pqc(${prefix}AbCdEf23456789/87h/0h/0h/0/*)))`
    assert.equal(redactSensitive(descriptor), 'mr(pk(pqc(<redacted-private-key>/87h/0h/0h/0/*)))')
  }
})

test('does not redact public extended-key prefixes', () => {
  for (const prefix of ['qpub', 'tqpb', 'qrpb', 'xpub', 'tpub']) {
    const descriptor = `mr(pk(pqc(${prefix}AbCdEf23456789/0/*)))`
    assert.equal(redactSensitive(descriptor), descriptor)
  }
})
