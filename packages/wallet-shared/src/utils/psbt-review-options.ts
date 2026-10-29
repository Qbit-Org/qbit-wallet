import type { DecodePsbtOptions } from '../types/decode-tx'
import type { ToSignData } from '../types/sign-tx'
import { statedPsbtRecipients } from './psbt-stated-recipients'

/**
 * Whether a website supplied this PSBT's bytes, as its signPsbt and signPsbts
 * requests do: the request carries the website's approval context and no send
 * claim. A website's sendQbit carries both, since the wallet built that PSBT
 * itself and reserved its inputs at approval; the wallet's own requests carry
 * neither.
 */
export function isWebsiteSuppliedPsbt(toSignData: ToSignData | undefined): boolean {
  return (
    toSignData?.providerContext !== undefined && toSignData.qbitSendBroadcastClaim === undefined
  )
}

/** How a request's PSBT is reviewed, whether alone or as one of a batch. */
export function psbtReviewOptions(toSignData: ToSignData | undefined): DecodePsbtOptions {
  return {
    statedRecipients: statedPsbtRecipients(toSignData),
    suppliedByWebsite: isWebsiteSuppliedPsbt(toSignData),
  }
}
