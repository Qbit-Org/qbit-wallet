import type { P2mrMessageProof } from '@qbit-oss/protocol'
import type { QbitProviderApprovalContext, QbitSignatureBudgetImpact } from './qbit-provider'

export type { P2mrMessageProof } from '@qbit-oss/protocol'

export enum SignMessageType {
  ECDSA = 'ecdsa',
  BIP322_SIMPLE = 'bip322-simple',
  P2MR = 'p2mr',
}

export interface ToSignMessage {
  text: string
  type: SignMessageType
  /** Internal account binding for a preflighted P2MR approval. */
  p2mrAccountAddress?: string
  providerContext?: QbitProviderApprovalContext
  signatureBudget?: QbitSignatureBudgetImpact
}

export type SignedMessage =
  | { signature: string; proof?: never }
  | { signature?: never; proof: P2mrMessageProof }

export interface SignMessageParams {
  data: {
    toSignMessages: ToSignMessage[]
  }
}

export type SignMessageResult = SignedMessage[]
