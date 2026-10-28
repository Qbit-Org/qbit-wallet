import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '@qbit/wallet-shared';

import {
  buildQbitRecoveryErrorReport,
  formatQbitRecoveryErrorReport,
  qbitRecoveryErrorFingerprint,
  redactQbitRecoveryErrorMessage
} from './qbitRecoveryErrorReport';

const txidA = 'ab'.repeat(32);
const txidB = 'cd'.repeat(32);

describe('qbit recovery error report', () => {
  it('gives one failure the same fingerprint whatever identifiers it names', () => {
    expect(qbitRecoveryErrorFingerprint(`could not resolve outpoint ${txidA}:0`)).toBe(
      qbitRecoveryErrorFingerprint(`could not resolve outpoint ${txidB}:3`)
    );
    expect(qbitRecoveryErrorFingerprint('invalid qbit UTXO at index 0')).toBe(
      qbitRecoveryErrorFingerprint('invalid qbit UTXO at index 17')
    );
    expect(qbitRecoveryErrorFingerprint('P2MR PSBT input 2 is missing a witness UTXO')).toBe(
      qbitRecoveryErrorFingerprint('P2MR PSBT input 5 is missing a witness UTXO')
    );
    expect(qbitRecoveryErrorFingerprint('Fresh Qbit migration wallet is unavailable')).not.toBe(
      qbitRecoveryErrorFingerprint('Qbit recovery keyring is unavailable')
    );
  });

  it('keeps HTTP statuses and RPC error codes distinct', () => {
    expect(qbitRecoveryErrorFingerprint('Network request failed: 429 Too Many Requests')).not.toBe(
      qbitRecoveryErrorFingerprint('Network request failed: 500 Too Many Requests')
    );
    expect(qbitRecoveryErrorFingerprint('HTTP 429: rate limited')).not.toBe(
      qbitRecoveryErrorFingerprint('HTTP 500: rate limited')
    );
    expect(qbitRecoveryErrorFingerprint('HTTP 400: RPC error -26')).not.toBe(
      qbitRecoveryErrorFingerprint('HTTP 400: RPC error -25')
    );
  });

  it('shortens identifiers and leaves ordinary words alone', () => {
    expect(redactQbitRecoveryErrorMessage(`lookup returned an invalid transaction for ${txidA}`)).toBe(
      'lookup returned an invalid transaction for ababab…abab'
    );
    expect(redactQbitRecoveryErrorMessage('Unable to determine a valid fee rate.')).toBe(
      'Unable to determine a valid fee rate.'
    );
  });

  it('builds a step-prefixed code and keeps the wallet error code from port errors', () => {
    const report = buildQbitRecoveryErrorReport(
      'prepare',
      { message: 'Protected assets must be moved separately', code: ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS },
      { network: 'QBIT_TESTNET4', version: '1.2.3', now: new Date('2026-10-21T10:00:00Z') }
    );
    expect(report.code).toMatch(/^QRM-PREP-[0-9A-F]{8}$/);
    expect(formatQbitRecoveryErrorReport(report)).toBe(
      [
        `Qbit Wallet migration error ${report.code}`,
        'Step: prepare',
        'Message: Protected assets must be moved separately',
        `Wallet error code: ${ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS}`,
        'Network: QBIT_TESTNET4',
        'Version: 1.2.3',
        'Time: 2026-10-21T10:00:00.000Z'
      ].join('\n')
    );
  });

  it('still produces a report for errors without a message', () => {
    const report = buildQbitRecoveryErrorReport('advance', undefined);
    expect(report.message).toBe('undefined');
    expect(buildQbitRecoveryErrorReport('advance', {}).message).toBe('Unknown error');
    expect(report.code).toMatch(/^QRM-ADV-/);
  });
});
