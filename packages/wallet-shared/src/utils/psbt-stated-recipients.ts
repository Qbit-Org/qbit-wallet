import { PsbtActionDetailType, type ToSignData } from '../types/sign-tx'

/**
 * The addresses a request names as its recipients. The wallet builds these
 * detail rows itself (a send, fee bump or migration); an output to any other
 * address that is not the wallet's own is flagged as unrecognised.
 */
export function statedPsbtRecipients(toSignData: ToSignData | undefined): string[] {
  return (toSignData?.action?.details ?? [])
    .filter(detail => detail.type === PsbtActionDetailType.ADDRESS)
    .map(detail => String(detail.value))
}
