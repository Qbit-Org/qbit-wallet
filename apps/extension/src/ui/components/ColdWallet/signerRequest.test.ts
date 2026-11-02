import { describe, expect, it } from 'vitest';

import type { DecodedPsbt } from '@qbit/wallet-shared';

import { signerDecodedPsbt } from './signerRequest';

describe('signerDecodedPsbt', () => {
  const decoded = {
    inputInfos: [],
    outputInfos: [],
    feeRate: 2,
    fee: 7720,
    features: { rbf: false },
    risks: [],
    isScammer: false,
    recommendedFeeRate: 9,
    shouldWarnFeeRate: false,
    isCompleted: true,
    spendSummary: { account: 'qbrt1zaccount' },
    outputOwners: [],
    version: 2,
    locktime: 0
  } as unknown as DecodedPsbt;

  it('keeps only the fields a signer reads, in order', () => {
    expect(Object.keys(signerDecodedPsbt(decoded))).toEqual([
      'inputInfos',
      'outputInfos',
      'feeRate',
      'fee',
      'features',
      'risks',
      'isScammer',
      'recommendedFeeRate',
      'shouldWarnFeeRate',
      'isCompleted'
    ]);
  });

  it('leaves out a field a later review adds', () => {
    const later = { ...decoded, approvalOnlyDetail: 'x' } as DecodedPsbt;
    expect(signerDecodedPsbt(later)).not.toHaveProperty('approvalOnlyDetail');
  });

  it('adds no field the review did not return', () => {
    expect(signerDecodedPsbt({ risks: [] } as unknown as DecodedPsbt)).toEqual({ risks: [] });
  });
});
