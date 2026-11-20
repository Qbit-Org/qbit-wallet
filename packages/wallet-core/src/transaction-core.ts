import * as transactionCore from 'bitcoinjs-lib'
import ECPairModule, { ECPairAPI } from 'ecpair'
import * as tinysecp256k1 from 'tiny-secp256k1'

export type { ECPairInterface } from 'ecpair'
export { transactionCore }

class ECCManager {
  private tinyEcc: any = tinysecp256k1
  // @ts-ignore
  private tinyEccPair: ECPairAPI

  constructor() {
    if (typeof tinysecp256k1.isPoint == 'function') {
      // @ts-ignore
      this.tinyEccPair = (ECPairModule.default ? ECPairModule.default : ECPairModule)(this.tinyEcc)
    }

    transactionCore.initEccLib(this.tinyEcc)
  }

  get ecc() {
    return this.tinyEcc
  }

  get eccPair() {
    return this.tinyEccPair
  }
}

export const eccManager = new ECCManager()
