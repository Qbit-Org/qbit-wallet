import { PsbtActionDetailType, type ToSignData } from '../types/sign-tx'

/**
 * The addresses a request names as its recipients. The wallet builds these
 * detail rows itself (a send, fee bump or migration); an output to any other
 * address that is not the wallet's own is flagged as unrecognised. A row
 * flagged `warning` shows what a website supplied, such as the output a
 * partial signature locks in, and names no recipient.
 */
export function statedPsbtRecipients(toSignData: ToSignData | undefined): string[] {
  return (toSignData?.action?.details ?? [])
    .filter(detail => detail.type === PsbtActionDetailType.ADDRESS && !detail.warning)
    .map(detail => String(detail.value))
}
