import type { DecodedPsbt } from '@qbit/wallet-shared';

/**
 * The decoded PSBT fields a cold signer's request carries, in the order a
 * review returns them. Anything else a review returns stays in the wallet:
 * the spend summary and the details only the approval shows.
 */
const SIGNER_DECODED_PSBT_FIELDS = [
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
] as const satisfies readonly (keyof DecodedPsbt)[];

export type SignerDecodedPsbt = Partial<Pick<DecodedPsbt, (typeof SIGNER_DECODED_PSBT_FIELDS)[number]>>;

/** The decoded PSBT for a cold signer's request: only the fields it reads, as the review returned them. */
export function signerDecodedPsbt(decodedPsbt: DecodedPsbt): SignerDecodedPsbt {
  return Object.fromEntries(
    SIGNER_DECODED_PSBT_FIELDS.filter((field) => field in decodedPsbt).map((field) => [field, decodedPsbt[field]])
  );
}
