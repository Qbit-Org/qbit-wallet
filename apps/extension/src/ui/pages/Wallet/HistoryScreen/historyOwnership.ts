import type { TxHistoryItem } from '@qbit/wallet-shared';

export function isMixedFundingTransaction(transaction: TxHistoryItem): boolean {
  const relevantInputs = transaction.vin.filter((input) => !input.coinbase && !input.prevoutMissing);
  return relevantInputs.some((input) => input.owned) && relevantInputs.some((input) => !input.owned);
}
